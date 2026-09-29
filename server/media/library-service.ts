import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { createOpenlistClient, OpenlistServiceError, type OpenlistClient } from "./openlist.ts";
import { WATCHPARTY_ROOTS, type WatchpartyMedia, type ResolvedMedia, type ResolvedMpvMedia, type SubtitleTrack } from "./watchparty-media.ts";
import {
  createLibraryBrowser,
  decodeLibraryMediaId,
  type LibraryArtwork,
  type LibraryPage,
} from "./library-browser.ts";
import { groupScanFiles, isVideoFileName, type CatalogGroupFile, type ScanFile } from "./catalog-names.ts";
import { createBangumiClient, createTmdbClient, fetchPosterBytes, judgeThresholds, type MetadataSearcher, type RankedHit } from "./catalog-metadata.ts";
import {
  approvalDigest,
  diffSnapshots,
  openCatalogStore,
  rollbackDigest,
  structuralChanges,
  structuralCount,
  type CatalogCard,
  type CatalogDraftCard,
  type CatalogDraftDiff,
  type CatalogDraftRow,
  type CatalogDetail,
  type DraftPatch,
  type ManualBinding,
  type StructuralChanges,
} from "./catalog-store.ts";
import {
  buildCollection,
  classifyPlacements,
  collectionRootFor,
  readCollectionMirror,
  readCollectionRoot,
  reconcileCollections,
  resolveMemberPaths,
  safeSegments,
  writeCollectionRoot,
  type DraftShape,
  type Placement,
} from "./collection-sidecar.ts";
import { createCatalogWorker } from "./catalog-worker.ts";
import type { DuplicateGroup } from "./catalog-duplicates.ts";
import {
  isLibraryKind,
  openLibraryStore,
  type LibraryKind,
  type LibraryStore,
  type StoredLibrary,
  type StoredSource,
} from "./library-store.ts";

export type LibraryHealth = "ok" | "root_missing" | "auth_failed" | "unreachable" | "not_configured";

export type PublicLibrary = {
  id: string;
  name: string;
  kind: LibraryKind;
  path: string;
};

export type PublicSource = {
  id: string;
  name: string;
  internalBaseUrl: string;
  publicBaseUrl: string;
  username: string;
  passwordSet: boolean;
  libraries: PublicLibrary[];
};

export type LibraryClientFactory = (source: StoredSource) => OpenlistClient;

export class LibraryRequestError extends Error {
  readonly code: string;
  readonly status: number;
  /** 给界面的结构化补充（例如"还剩几张没判定"）；没有就只回 code。 */
  readonly detail?: Record<string, unknown>;

  constructor(status: number, code: string, detail?: Record<string, unknown>) {
    super(code);
    this.name = "LibraryRequestError";
    this.status = status;
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** 六个草稿编辑接口共同的返回：改完直接给新摘要，界面不必自己算 diff。 */
export type DraftEditResult = {
  libraryId: string;
  card: CatalogDraftRow | null;
  cards: number;
  files: number;
  pending: number;
  diff: CatalogDraftDiff;
};

/** 每次 sidecar 导入的回执：写了什么、为什么没写、结构提案、以及现在长什么样的 diff。 */
export type ImportPreviewResult = {
  libraryId: string;
  root: string;
  libraryName: string;
  sidecarFiles: number;
  /** 这次从哪几根目录读的：规范来源是服务端根，旁挂镜像只读且永不写回。 */
  sources: Array<{ kind: "server" | "mirror"; root: string; files: number; collections: number }>;
  collections: number;
  scannedFiles: number;
  scanRev: number;
  draftRev: number;
  draftCards: number;
  written: Array<{ sourceFile: string; itemKey: string; fields: string[] }>;
  /** 人工决定优先：这些卡的文件集合对上了，但 `confirmed_by` 是人的，一行都没改。 */
  protectedCards: Array<{ sourceFile: string; itemKey: string; reason: "human-confirmed" }>;
  proposals: Array<Exclude<Placement, { kind: "metadata" }>>;
  conflicts: Array<{ sourceFile: string; reason: string; paths?: string[] }>;
  ambiguous: Array<{ relPath: string; sourceFiles: string[] }>;
  unlisted: Array<{ relPath: string; under: string }>;
  /**
   * size 校验的覆盖面。`unchecked` 不是失败：sidecar 没写或快照那侧没存 size 就没法比，
   * 但必须说出来 —— 一个在旧快照上静默什么都不查的检查，比没有检查更糟。
   */
  sizeChecks: { compared: number; mismatched: number; unchecked: number };
  errors: Array<{ sourceFile: string; errors: Array<{ code: string; message: string }>; warnings: string[] }>;
  /** 明确写着别的库的 sidecar：不参与匹配，只报出来。 */
  foreign: Array<{ sourceFile: string; libraryId: string }>;
  /** 只有 import/structure 会填：每条提案的执行结果。 */
  applied: Array<{ sourceFile: string; kind: string; result: string; detail?: string }>;
  diff: CatalogDraftDiff;
};

/** 一次结构应用的结果，含"这次是否留下了可回滚的记录"。 */
export type ApplyOutcome = {
  libraryId: string;
  cards: number;
  created: number;
  updated: number;
  skipped: number;
  deferred: number;
  posters: number;
  structural: StructuralChanges;
  /** 带凭证应用时是那张批准记录；没有它就是 null（纯元数据应用不进回滚台账）。 */
  approvalId: string | null;
  rollbackAvailable: boolean;
  diff: CatalogDraftDiff;
};

/** 一次结构应用留下的反向操作摘要（回滚批准与执行都回这个形状）。 */
export type RollbackPlanSummary = { approvalId: string; keys: string[]; counts: { created: number; removed: number; changed: number } };

export type ApprovalIssue = {
  libraryId: string;
  approvalId: string;
  approvalToken: string;
  expiresAt: string;
  approvedBy: string;
  /** 这次签发顺手回收了几条过了撤回窗口的 undo。 */
  pruned: number;
  structural?: StructuralChanges;
  rollback?: RollbackPlanSummary;
};

/**
 * `POST .../scan` 的回执。`accepted` = 超过同步宽限期还在跑（服务端继续跑完），调用方去轮询
 * `GET .../scan` 直到 `running:false`。`done` 的字段与改成异步之前完全一样，老调用方不用动。
 */
export type CatalogScanOutcome =
  | { status: "done"; libraryId: string; running: false; files: number; enumeratedAt: string | null; rev: number }
  | { status: "accepted"; libraryId: string; running: true };
/** `POST .../classify` 的回执，同上；`accepted` 时轮询 `GET .../classify`。 */
export type CatalogClassifyOutcome =
  | { status: "done"; libraryId: string; running: false; files: number; cards: number; rev: number; diff: CatalogDraftDiff }
  | { status: "accepted"; libraryId: string; running: true };

export type LibraryService = {
  close(): void;
  sourceCount(): number;
  /** v1 ids stay on the process env client, and only while the seeded source is the only source. */
  legacyV1Enabled(): boolean;
  allowsAdmin(ip: string | undefined, adminHeader: string | undefined): boolean;
  capabilities(admin: boolean): {
    libraries: true;
    artwork: true;
    catalog: true;
    mediaAdmin: boolean;
    /** secret = 批准结构变更要第二把密钥；loopback-admin = 只靠本机 admin 权限（软边界）。 */
    catalogApproval: "secret" | "loopback-admin";
  };
  catalogList(libraryId: string, cursor?: string, query?: string): { items: CatalogCard[]; hasMore: boolean; nextCursor?: string };
  catalogDetail(id: string, includeEpisodeTitles?: boolean): Promise<CatalogDetail>;
  catalogConfirm(id: string, body: unknown): Promise<CatalogDetail>;
  catalogReject(id: string, body: unknown): CatalogDetail;
  catalogUnconfirm(id: string): CatalogDetail;
  catalogRebind(id: string, body: unknown): Promise<CatalogDetail>;
  catalogMerge(body: unknown): CatalogDetail;
  catalogSplit(id: string, body: unknown): CatalogDetail[];
  /** 人工挑条目用的vendor搜索（卡片改绑时先搜后绑）。 */
  vendorSearch(body: unknown): Promise<Array<{ externalDb: string; externalId: string; title: string; originalTitle: string | null; year: number | null; episodes: number | null; imageUrl: string | null }>>;
  catalogScan(id: string): { files: number; enumeratedAt: string | null; rev: number; running: boolean };
  /**
   * 只枚举并刷新快照，不分组、不刮削、不动任何卡。
   * `status:"accepted"` 表示超过宽限期还没跑完 —— 调用方去轮询 `GET .../scan` 直到 `running` 为假。
   */
  catalogRefreshScan(id: string): Promise<CatalogScanOutcome>;
  /** 枚举（快照为空时）+ 分类。结果只进 catalog_draft，正式卡一行不动。超过宽限期同样回 accepted。 */
  catalogClassify(id: string): Promise<CatalogClassifyOutcome>;
  /** 对草稿逐条查条目打分，结论只写草稿；maxLookups 限制本次处理几张（Bangumi 匿名限速）。 */
  catalogJudge(id: string, maxLookups?: number): Promise<{ libraryId: string; kind: LibraryKind; judged: number; confirmed: number; pending: number; items: string[]; diff: CatalogDraftDiff }>;
  /** 把草稿变成正式卡。rev 与当前快照不一致就 409，绝不拿过期结果盖库。
   *  带结构变更（建卡/删卡/移动文件）时必须给人工签发的一次性 `approvalToken`。 */
  catalogApply(id: string, force?: boolean, approvalToken?: string): Promise<ApplyOutcome>;
  /** 网页批准当前草稿的结构变更，签发一次性凭证（48h）。明文只在这里回一次。
   *  配了 WATCHPARTY_CATALOG_APPROVAL_SECRET 时，调用方必须出示它 —— 这才是"人是人、
   *  Agent 是 Agent"的分界；没配就是软边界，任何 admin 权限都能批（capability 会如实报）。
   *  body 带 `rollbackOf` 时批准的是"把那次应用撤回去"，返回 `rollback` 而不是 `structural`。 */
  catalogApprove(id: string, body: unknown, approvalSecret?: string): ApprovalIssue;
  catalogRevoke(id: string, body: unknown): { libraryId: string; revoked: true };
  /** 带着回滚凭证还原那次结构应用。当前值与当时写入的不一致就整批不动，只报冲突。 */
  catalogRollback(id: string, body: unknown): Promise<{ libraryId: string; rollbackOf: string; restored: number; removed: number; keys: string[]; diff: CatalogDraftDiff }>;
  /** 带着凭证应用：`/apply` 遇到结构变更会 409，这里才是那条路。 */
  catalogApplyApproved(id: string, body: unknown): Promise<ApplyOutcome>;
  /** 一条命令跑完"分类 + 判定"（只到草稿）：缺多少判多少，不擦上一轮的结果。 */
  catalogPrepare(id: string, maxLookups?: number): Promise<{
    libraryId: string;
    files: number;
    cards: number;
    rev: number;
    judged: number;
    confirmed: number;
    pending: number;
    items: string[];
    diff: CatalogDraftDiff;
  }>;
  /** 以下六个都只写草稿：正式卡要等 apply；任何编辑都记成人工决定（confirmed_by=manual），
   *  下一轮判定不会盖掉；重新 classify 会整体丢掉这些编辑。 */
  draftEdit(id: string, body: unknown): DraftEditResult;
  draftConfirm(id: string, body: unknown): DraftEditResult;
  draftUnconfirm(id: string, body: unknown): DraftEditResult;
  draftMerge(id: string, body: unknown): DraftEditResult;
  draftSplit(id: string, body: unknown): DraftEditResult & { createdKeys: string[] };
  draftKeepBinding(id: string, body: unknown): DraftEditResult;
  /** 把当前草稿导出成 WatchParty collection sidecar（只写服务端本地根目录，绝不回写网盘）。 */
  importExport(id: string): { libraryId: string; root: string; cards: number; written: string[] };
  /** 读 sidecar 根目录 → 与快照对账 → 落点分类 → 把元数据写进草稿。结构变更只出提案。 */
  importPreview(id: string): ImportPreviewResult;
  /** 把 sidecar 的结构提案落到草稿（复用现有 draft merge/split），仍然只写草稿。 */
  importStructure(id: string, body: unknown): ImportPreviewResult;
  /** 回滚台账：谁批的、动了哪些键位、用过没有、能不能撤。绝不返回 token 或其哈希。 */
  catalogApprovals(id: string): {
    libraryId: string;
    items: Array<{
      approvalId: string;
      kind: "apply" | "rollback";
      approvedBy: string;
      createdAt: string;
      expiresAt: string;
      usedAt: string | null;
      revokedAt: string | null;
      appliedAt: string | null;
      rolledBackAt: string | null;
      targets: string | null;
      keys?: string[];
      counts?: { created: number; removed: number; changed: number };
      rollbackAvailable: boolean;
      /** 撤回窗口就是凭证有效期；过期后只清 undo，审计行永远还读得到。 */
      windowClosed: boolean;
    }>;
  };
  /** 墙上的疑似同作（OVA/季度/SP 那类）。只读：不改卡、不合并、也不建任何待办。 */
  catalogDuplicates(id: string): {
    libraryId: string;
    kind: LibraryKind;
    readOnly: true;
    autoMerge: false;
    /** 墙上的卡数；`groupedCards` 是进了疑似组的卡数，两者别混成一个字段。 */
    cards: number;
    groupedCards: number;
    groups: number;
    scan: { files: number; rev: number };
    items: DuplicateGroup[];
  };
  /** 读回草稿与它同正式卡的差异。 */
  catalogDraft(id: string): {
    libraryId: string;
    cards: number;
    files: number;
    pending: number;
    classifiedAt: string | null;
    scan: { files: number; enumeratedAt: string | null };
    draft: CatalogDraftRow[];
    diff: CatalogDraftDiff;
    thresholds: typeof judgeThresholds;
  };
  /** 展开某一张草稿卡时才取它的文件列表。 */
  catalogDraftCard(id: string, itemKey: string): { libraryId: string; card: CatalogDraftRow; children: CatalogGroupFile[]; candidates: RankedHit[] };
  catalogPoster(id: string): { contentType: string; bytes: Buffer } | undefined;
  adminScrape(libraryId: string): Promise<{ libraryId: string; status: string; total: number; scanned: number; matched: number; lastError: string | null }>;
  adminScrapeStatus(libraryId: string): { libraryId: string; status: string; total: number; scanned: number; matched: number; lastError: string | null };
  libraries(): Promise<Array<{
    id: string;
    name: string;
    kind: LibraryKind;
    sourceId: string;
    sourceName: string;
    health: LibraryHealth;
  }>>;
  list(libraryId: string, relativePath: string, cursor?: string): Promise<LibraryPage>;
  search(libraryId: string, query: string, cursor?: string): Promise<LibraryPage>;
  resolve(mediaId: string): Promise<ResolvedMedia | null | undefined>;
  resolveMpv(mediaId: string): Promise<ResolvedMpvMedia | null | undefined>;
  discoverSubtitles(mediaId: string): Promise<SubtitleTrack[] | undefined>;
  loadSubtitle(mediaId: string): Promise<string | undefined>;
  loadArtwork(mediaId: string): Promise<LibraryArtwork | undefined>;
  adminList(): PublicSource[];
  adminCreate(body: unknown): Promise<PublicSource>;
  adminUpdate(id: string, body: unknown): Promise<PublicSource>;
  adminDelete(id: string): boolean;
};

const HEALTH_TTL_MS = 5000;
/** 人工批准的结构变更凭证有效期（文档 §8：created_at + 48h）。 */
/** 撤回窗口就是凭证有效期：过期只清 undo，审计行留着。默认 48 小时。 */
const DEFAULT_APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;
const SEEDED_SOURCE_ID = "src_default";

export function createLibraryService(options: {
  cfg: AppConfig;
  dbPath?: string;
  clientFactory?: LibraryClientFactory;
  trustLoopback?: boolean;
  adminToken?: string;
  catalogDbPath?: string;
  posterDir?: string;
  /** collection sidecar 的根目录（默认 `data/catalog-sidecars`）。 */
  catalogSidecarDir?: string;
  /** 开发期旁挂 sidecar 的镜像根，只读；默认取 `WATCHPARTY_CATALOG_MIRROR_ROOT`。 */
  catalogMirrorDir?: string;
  /** 批准结构变更的第二把密钥；默认取 `WATCHPARTY_CATALOG_APPROVAL_SECRET`。 */
  approvalSecret?: string;
  /** 凭证有效期 = 可撤回窗口（毫秒）；默认取 `WATCHPARTY_CATALOG_APPROVAL_TTL_MS`（48h）。 */
  approvalTtlMs?: number;
  /** 管理动作（scan/classify）同步等待的宽限期；超过就发 202 让调用方轮询。默认 8s。 */
  syncGraceMs?: number;
  bangumi?: MetadataSearcher;
  tmdb?: MetadataSearcher;
  fetchPoster?: (url: string) => Promise<{ contentType: string; bytes: Buffer } | undefined>;
  catalogDelayMs?: number;
  catalogMaxLookups?: number;
  catalogInline?: boolean;
}): LibraryService {
  const { cfg } = options;
  const trustLoopback = options.trustLoopback !== false;
  const adminToken = options.adminToken ?? "";
  const store = openLibraryStore(options.dbPath ?? defaultDbPath(cfg));
  const clients = new Map<string, OpenlistClient>();
  const healthCache = new Map<string, { at: number; health: LibraryHealth }>();
  seedIfEmpty(store, cfg);

  function openClient(source: StoredSource): OpenlistClient {
    if (options.clientFactory) return options.clientFactory(source);
    return createOpenlistClient({
      ...cfg,
      openlistUrl: source.internalBaseUrl,
      openlistPublicUrl: source.publicBaseUrl,
      openlistUsername: source.username,
      openlistPassword: source.password,
    });
  }

  function clientFor(source: StoredSource): OpenlistClient {
    const cached = clients.get(source.id);
    if (cached) return cached;
    const client = openClient(source);
    clients.set(source.id, client);
    return client;
  }

  function browserFor(source: StoredSource) {
    return createLibraryBrowser(clientFor(source), {
      sourceId: source.id,
      mediaIdKey: cfg.watchPartyMediaIdKey,
      internalBaseUrl: source.internalBaseUrl,
      publicBaseUrl: source.publicBaseUrl || source.internalBaseUrl,
      libraries: store.librariesFor(source.id),
      requestTimeoutMs: cfg.openlistRequestTimeoutMs,
    });
  }

  function requireLibrary(libraryId: string): { library: StoredLibrary; source: StoredSource } {
    const library = store.getLibrary(libraryId);
    const source = library ? store.getSource(library.sourceId) : undefined;
    if (!library || !source) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
    return { library, source };
  }

  const catalog = openCatalogStore(options.catalogDbPath ?? defaultCatalogDbPath(cfg), options.posterDir ?? defaultPosterDir(cfg));

  /**
   * 同一个库的枚举/分类只跑一次：并发进来的请求并入正在跑的那一次，而不是各走一遍网盘。
   * 真库实测两条并发 scan 互相拖到 46.5s / 31.1s，而桌面客户端的总预算是 15s —— 对这种
   * 请求做重试不会更快，只会多一次遍历。快照写入本身是事务（后写的整份覆盖），所以并入
   * 同一次不改变"谁赢"，只是不再白跑。
   */
  const inFlight = new Map<string, Promise<unknown>>();
  function oncePerLibrary<T>(key: string, task: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key);
    if (running) return running as Promise<T>;
    const promise = task().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  /**
   * 管理动作（枚举 / 分类）的"等到宽限期就回"：跑完了给完整结果，还在跑就让调用方去轮询读接口。
   * 冷态一次 scan 要 30–46s，而桌面客户端的总预算是 15s —— 同步等下去必然红。宽限期取 8s 是
   * 因为热态 2.1–5.5s 能在里面跑完（保持今天 200 + 完整结果的形状），冷态则改发 202。
   * 注意：宽限期之后这条 promise 没人 await 了，失败必须留一行可 grep 的日志，而且绝不能变成
   * unhandled rejection（那会把整个进程带走）。
   */
  const syncGraceMs = options.syncGraceMs ?? 8_000;
  function withGrace<T>(kind: "scan" | "classify", libraryId: string, task: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    const started = Date.now();
    const running = task();
    running.catch((error) => {
      console.error(`ASYNC_${kind.toUpperCase()}_FAILED ${libraryId} ${Math.round((Date.now() - started) / 1000)}s ${error instanceof Error ? error.message : String(error)}`);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<{ done: false }>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), syncGraceMs);
    });
    return Promise.race([
      running.then((value) => {
        if (Date.now() - started > syncGraceMs) console.log(`ASYNC_${kind.toUpperCase()}_DONE ${libraryId} ${Math.round((Date.now() - started) / 1000)}s`);
        return { done: true as const, value };
      }),
      grace,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  const sidecarRoot = options.catalogSidecarDir ?? defaultSidecarDir(cfg);
  const mirrorRoot = options.catalogMirrorDir ?? cfg.catalogMirrorRoot;
  const approvalSecret = options.approvalSecret ?? cfg.catalogApprovalSecret;
  const approvalTtlMs = options.approvalTtlMs ?? (cfg.catalogApprovalTtlMs > 0 ? cfg.catalogApprovalTtlMs : DEFAULT_APPROVAL_TTL_MS);
  const secretMatches = (provided: string | undefined, expected: string) => {
    if (typeof provided !== "string") return false;
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const bangumiSearcher = options.bangumi ?? createBangumiClient(fetch, cfg.bangumiToken);
  const episodeCache = new Map<string, Promise<Map<number, string>>>();
  const worker = createCatalogWorker({
    catalog,
    bangumi: bangumiSearcher,
    tmdb: options.tmdb ?? createTmdbClient(),
    // 注入的口子只给测试用：生产走 fetchPosterBytes，那里已经带 BEST_EFFORT_TIMEOUT_MS 的上限。
    // 自己传一个进来的话，超时归你负责 —— 海报抓取是 await 在 confirm/rebind 请求里的。
    fetchPoster: options.fetchPoster ?? ((url) => fetchPosterBytes(url)),
    listFiles: (library) => collectLibraryFiles(library),
    getLibrary: (id) => store.getLibrary(id),
    delayMs: options.catalogDelayMs ?? 250,
    ...(options.catalogMaxLookups !== undefined ? { maxLookupsPerRun: options.catalogMaxLookups } : {}),
    inline: options.catalogInline === true,
  });

  const draftError = (code: string, status: number, detail?: Record<string, unknown>) => new LibraryRequestError(status, code, detail);
  const draftInvalid = () => draftError("DRAFT_EDIT_INVALID", 400);
  const draftNotFound = () => draftError("DRAFT_CARD_NOT_FOUND", 404);

  function draftString(body: unknown, key: string, max: number): string {
    const value = (body as Record<string, unknown> | undefined)?.[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw draftInvalid();
    return value;
  }

  function draftYear(body: unknown): { year?: number | null } {
    const value = (body as Record<string, unknown> | undefined)?.year;
    if (value === undefined) return {};
    if (value === null) return { year: null };
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1900 && value <= 2100) return { year: value };
    throw draftInvalid();
  }

  /** 条目对：要么给全（且合法），要么显式 null 解绑，要么不传保持原样。 */
  function draftBinding(body: unknown): { externalDb?: string | null; externalId?: string | null } {
    const record = body as Record<string, unknown> | undefined;
    const db = record?.externalDb;
    const id = record?.externalId;
    if (db === undefined && id === undefined) return {};
    if (db === null && id === null) return { externalDb: null, externalId: null };
    if (typeof db !== "string" || !["bangumi", "tmdb"].includes(db) || typeof id !== "string" || !/^\d{1,12}$/.test(id)) throw draftInvalid();
    return { externalDb: db, externalId: id };
  }

  /** 凭证绑定"当前这份草稿的当前这套结构变更"：任一输入变了就对不上。 */
  function approvalTarget(libraryId: string) {
    const structural = structuralChanges(catalog.draftDiff(libraryId));
    const draftRevision = catalog.draftInfo(libraryId).rev;
    const scanRevision = catalog.scanInfo(libraryId).rev;
    return { structural, digest: approvalDigest({ libraryId, structural, scanRevision, draftRevision }), scanRevision, draftRevision, detail: { structural } };
  }

  const tokenHashOf = (token: string) => createHash("sha256").update(token).digest("hex");

  /**
   * 校验并当场消费凭证：宁可"失败即作废"也不留下可重放的窗口（所以是先消费、后执行）。
   * 指纹、两个 revision、过期、撤销、已用逐项都对得上才放行。
   */
  function consumeApproval(libraryId: string, token: string, expected: { digest: string; scanRevision: number; draftRevision: number; detail: Record<string, unknown> }): string {
    const tokenHash = tokenHashOf(token);
    const record = catalog.findApproval(tokenHash);
    const reason =
      !record || record.libraryId !== libraryId
        ? "unknown"
        : record.revokedAt
          ? "revoked"
          : record.usedAt
            ? "used"
            : new Date(record.expiresAt).getTime() <= Date.now()
              ? "expired"
              : record.scanRevision !== expected.scanRevision
                ? "scan-revision"
                : record.draftRevision !== expected.draftRevision
                  ? "draft-revision"
                  : record.operationHash !== expected.digest
                    ? "operations-changed"
                    : !catalog.useApproval(tokenHash)
                      ? "used"
                      : null;
    if (reason || !record) throw new LibraryRequestError(409, "CATALOG_APPROVAL_INVALID", { reason: reason ?? "unknown", ...expected.detail });
    return record.id;
  }

  /** 一次结构 apply 留下的反向操作，连同它现在的形状 —— 回滚批准与回滚执行都从这里取。 */
  function rollbackPlan(libraryId: string, approvalId: string, pruned = 0) {
    const record = catalog.findApprovalById(approvalId);
    if (!record || record.libraryId !== libraryId) throw new LibraryRequestError(404, "CATALOG_ROLLBACK_TARGET_NOT_FOUND");
    if (record.kind !== "apply") throw new LibraryRequestError(409, "CATALOG_ROLLBACK_TARGET_NOT_APPLY");
    if (record.rolledBackAt) throw new LibraryRequestError(409, "CATALOG_ROLLBACK_ALREADY_DONE", { approvalId, rolledBackAt: record.rolledBackAt });
    // 窗口判据必须排在读 undo 之前：签发这一刻会先回收过期的 undo，若先读就会报成
    // "那次应用没留台账"，把"窗口过了"这个真原因说丢了。
    if (new Date(record.expiresAt).getTime() <= Date.now()) throw new LibraryRequestError(409, "CATALOG_ROLLBACK_WINDOW_CLOSED", { approvalId, expiresAt: record.expiresAt, pruned });
    const undo = catalog.readUndo(approvalId);
    if (!undo) throw new LibraryRequestError(409, "CATALOG_ROLLBACK_NOT_RECORDED", { approvalId, pruned });
    return {
      undo,
      digest: rollbackDigest({ libraryId, approvalId, keys: undo.keys }),
      scanRevision: catalog.scanInfo(libraryId).rev,
      draftRevision: catalog.draftInfo(libraryId).rev,
      detail: { rollback: { approvalId, keys: undo.keys, counts: undo.counts } },
    };
  }

  function approvalTokenOf(body: unknown): string {
    const value = (body as Record<string, unknown> | undefined)?.approvalToken;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new LibraryRequestError(401, "CATALOG_APPROVAL_REQUIRED");
    return value;
  }

  /** 每次编辑都回同样的摘要：界面不必再猜 diff 变了什么。 */
  function draftSummary(id: string, itemKey?: string) {
    const info = catalog.draftInfo(id);
    return {
      libraryId: id,
      card: itemKey === undefined ? null : (catalog.draftList(id).find((entry) => entry.itemKey === itemKey) ?? null),
      cards: info.cards,
      files: info.files,
      pending: info.pending,
      diff: catalog.draftDiff(id),
    };
  }

  /**
   * sidecar → 草稿的唯一一条写入路径。`sourceFiles` 给了就把这些集合的结构提案也落到
   * 草稿（走现有 draft merge/split），否则只写元数据、结构只出提案。两种模式都碰不到
   * 正式卡：那是 apply 的事，而带结构的 apply 要人工签发的一次性凭证。
   */
  function importCollections(libraryId: string, structure: string[] | "all" | null): ImportPreviewResult {
    const { library } = requireLibrary(libraryId);
    const scan = catalog.readScan(libraryId);
    if (scan.length === 0) throw new LibraryRequestError(409, "CATALOG_SCAN_EMPTY");
    const root = collectionRootFor(sidecarRoot, libraryId);
    const serverRead = readCollectionRoot(sidecarRoot, libraryId);
    // 旁挂只读：镜像树里那一层就是库内相对路径。两处都有同一份时会被算成 claimed-by-two，
    // 这是有意的 —— 一份输入只能有一个来源。
    const mirrorRead = mirrorRoot ? readCollectionMirror(mirrorRoot, libraryId) : { collections: [], errors: [], files: 0, root: "" };
    const read = {
      collections: [...serverRead.collections, ...mirrorRead.collections],
      errors: [...serverRead.errors, ...mirrorRead.errors],
      files: serverRead.files + mirrorRead.files,
    };
    const foreign = read.collections.filter((entry) => entry.libraryId && entry.libraryId !== libraryId);
    const mine = read.collections.filter((entry) => !entry.libraryId || entry.libraryId === libraryId);
    if (mine.length === 0) throw new LibraryRequestError(409, "SIDECAR_EMPTY", { root, files: read.files });
    if (catalog.readDraft(libraryId).length === 0) throw new LibraryRequestError(409, "CATALOG_DRAFT_EMPTY", { draftCards: 0 });
    const bySource = new Map(mine.map((entry) => [entry.sourceFile, entry]));
    const draftShapes = (): DraftShape[] =>
      catalog.readDraft(libraryId).map((card) => ({
        itemKey: card.itemKey,
        paths: card.children.map((file) => file.relativePath ?? `id:${file.mediaId}`),
        confirmedBy: card.confirmedBy,
      }));
    /** 每轮都按当前草稿重算：上一条结构操作会改变后面每条的落点。 */
    const current = () => {
      const reconciled = reconcileCollections(mine, scan);
      const claimed = new Set(reconciled.ambiguous.flatMap((entry) => entry.sourceFiles));
      return classifyPlacements(reconciled.shapes, draftShapes()).map((placement) =>
        placement.kind !== "conflict" && claimed.has(placement.sourceFile)
          ? { kind: "conflict" as const, sourceFile: placement.sourceFile, reason: "claimed-by-two", paths: reconciled.ambiguous.filter((entry) => entry.sourceFiles.includes(placement.sourceFile)).map((entry) => entry.relPath) }
          : placement,
      );
    };
    const applied: ImportPreviewResult["applied"] = [];
    if (structure) {
      let list = current();
      const targets = structure === "all" ? list.filter((entry) => entry.kind === "split" || entry.kind === "merge").map((entry) => entry.sourceFile) : structure;
      for (const sourceFile of targets) {
        const placement = list.find((entry) => entry.sourceFile === sourceFile);
        if (!placement) continue;
        if (placement.kind !== "merge" && placement.kind !== "split") {
          applied.push({ sourceFile, kind: placement.kind, result: "skipped" });
          continue;
        }
        // 落点算出来的卡可能已经被上一条操作并走了：那是重算的事，不是错误。
        if (!draftShapes().some((shape) => shape.itemKey === placement.itemKey)) {
          applied.push({ sourceFile, kind: placement.kind, result: "skipped" });
          continue;
        }
        if (placement.kind === "merge") {
          const outcome = catalog.draftMerge(libraryId, placement.itemKey, placement.dropKeys);
          applied.push({ sourceFile, kind: placement.kind, result: outcome.error ? `rejected:${outcome.error}` : "ok" });
          list = current();
          continue;
        }
        const collection = bySource.get(sourceFile);
        const keep = new Set(collection ? resolveMemberPaths(collection).paths : []);
        const children = catalog.draftChildren(libraryId, placement.itemKey) ?? [];
        const keepIds = children.filter((file) => keep.has(file.relativePath ?? `id:${file.mediaId}`)).map((file) => file.mediaId);
        const outcome = catalog.draftSplit(libraryId, placement.itemKey, keepIds);
        applied.push({ sourceFile, kind: placement.kind, result: outcome.error ? `rejected:${outcome.error}` : "ok", detail: outcome.created?.join(", ") });
        list = current();
      }
    }
    const list = current();
    const written: ImportPreviewResult["written"] = [];
    const protectedCards: ImportPreviewResult["protectedCards"] = [];
    const conflicts: ImportPreviewResult["conflicts"] = [];
    for (const placement of list) {
      const sidecar = bySource.get(placement.sourceFile);
      if (!sidecar) continue;
      if (placement.kind === "conflict") {
        conflicts.push({ sourceFile: placement.sourceFile, reason: placement.reason, paths: placement.paths });
        continue;
      }
      if (placement.kind !== "metadata") continue;
      const patch: DraftPatch = {
        ...(sidecar.title ? { title: sidecar.title } : {}),
        ...(sidecar.originalTitle ? { originalTitle: sidecar.originalTitle } : {}),
        ...(sidecar.year !== null ? { year: sidecar.year } : {}),
        ...(sidecar.overview ? { overview: sidecar.overview } : {}),
        ...(sidecar.poster ? { posterUrl: sidecar.poster } : {}),
        ...(sidecar.externalId ? { externalDb: sidecar.externalDb, externalId: sidecar.externalId } : {}),
      };
      if (Object.keys(patch).length === 0) continue;
      const outcome = catalog.draftImport(libraryId, placement.itemKey, patch);
      if (outcome === "protected") {
        protectedCards.push({ sourceFile: placement.sourceFile, itemKey: placement.itemKey, reason: "human-confirmed" });
        continue;
      }
      if (outcome === "missing") {
        conflicts.push({ sourceFile: placement.sourceFile, reason: "draft-card-missing", paths: [placement.itemKey] });
        continue;
      }
      written.push({ sourceFile: placement.sourceFile, itemKey: placement.itemKey, fields: Object.keys(patch).sort() });
    }
    const info = catalog.draftInfo(libraryId);
    const snapshot = catalog.scanInfo(libraryId);
    const reconciled = reconcileCollections(mine, scan);
    return {
      libraryId,
      root,
      libraryName: library.name,
      sidecarFiles: read.files,
      sources: [
        { kind: "server" as const, root, files: serverRead.files, collections: serverRead.collections.length },
        ...(mirrorRoot ? [{ kind: "mirror" as const, root: mirrorRead.root, files: mirrorRead.files, collections: mirrorRead.collections.length }] : []),
      ],
      collections: mine.length,
      scannedFiles: scan.length,
      scanRev: snapshot.rev,
      draftRev: info.rev,
      draftCards: info.cards,
      written,
      protectedCards,
      proposals: list
        .filter((placement): placement is Exclude<Placement, { kind: "metadata" }> => placement.kind !== "metadata")
        .map((placement) => ({ ...placement })),
      conflicts,
      ambiguous: reconciled.ambiguous,
      unlisted: reconciled.unlisted,
      sizeChecks: reconciled.sizeChecks,
      errors: read.errors,
      foreign: foreign.map((entry) => ({ sourceFile: entry.sourceFile, libraryId: String(entry.libraryId) })),
      applied,
      diff: catalog.draftDiff(libraryId),
    };
  }

  /** 枚举（快照为空或已过期时）+ 分类，结果只进草稿表。 */
  async function classifyLibrary(library: StoredLibrary): Promise<{ libraryId: string; files: number; cards: number; rev: number; diff: CatalogDraftDiff }> {
    const id = library.id;
    const current = catalog.scanInfo(id).rev;
    let files = current > 0 ? catalog.readScan(id) : [];
    if (files.length === 0) {
      files = library.kind === "other" ? [] : await collectLibraryFiles(library);
      if (stillThere(id, "scan")) catalog.writeScan(id, files);
    }
    const groups = groupScanFiles(files, catalog.protectedKeys(id)).filter((group) => group.query);
    const cards = stillThere(id, "draft") ? catalog.writeDraft(id, groups) : 0;
    return { libraryId: id, files: files.length, cards, rev: catalog.scanInfo(id).rev, diff: catalog.draftDiff(id) };
  }

  /**
   * 枚举/分类是"客户端放弃后服务端还在跑"的长动作。源或库在这期间被删掉时，跑完不能再把
   * 结果写回去 —— 那会留下界面上永远看不见的孤儿行（真库上已经因此攒了 9 个库、10008 行快照）。
   */
  function stillThere(libraryId: string, what: "scan" | "draft"): boolean {
    if (store.getLibrary(libraryId)) return true;
    console.log(`ASYNC_WRITE_DROPPED ${libraryId} ${what} 库已被删除，结果不落盘`);
    return false;
  }

  async function collectLibraryFiles(library: StoredLibrary): Promise<ScanFile[]> {
    const source = store.getSource(library.sourceId);
    if (!source) return [];
    const files: ScanFile[] = [];
    const queue = ["/"];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const relative = queue.shift() ?? "/";
      if (seen.has(relative)) continue;
      seen.add(relative);
      if (relative.split("/").filter(Boolean).length > 4) continue;
      let cursor: string | undefined;
      do {
        const page = await browserFor(source).list(library, relative, cursor);
        for (const item of page.items) {
          if (item.type === "dir") queue.push(item.relativePath);
          else if (isVideoFileName(item.name)) files.push({ relativePath: item.relativePath, name: item.name, mediaId: item.id, size: item.size ?? null });
        }
        cursor = page.hasMore ? page.nextCursor : undefined;
      } while (cursor);
    }
    return files;
  }

  async function probe(client: OpenlistClient, absolutePath: string, configured: boolean): Promise<LibraryHealth> {
    if (!configured) return "not_configured";
    try {
      const response = await client.listShallow(absolutePath);
      return response.code === 200 ? "ok" : "root_missing";
    } catch (error) {
      if (error instanceof OpenlistServiceError && error.code === "OPENLIST_AUTH_FAILED") return "auth_failed";
      return "unreachable";
    }
  }

  function healthError(health: LibraryHealth): LibraryRequestError | undefined {
    if (health === "ok") return undefined;
    if (health === "root_missing") return new LibraryRequestError(400, "LIBRARY_ROOT_NOT_FOUND");
    if (health === "auth_failed") return new LibraryRequestError(502, "SOURCE_AUTH_FAILED");
    if (health === "not_configured") return new LibraryRequestError(400, "INVALID_REQUEST");
    return new LibraryRequestError(502, "SOURCE_UNREACHABLE");
  }

  async function assertProbe(source: StoredSource, libraries: Array<{ path: string }>): Promise<void> {
    const client = openClient(source);
    for (const library of libraries) {
      const failure = healthError(await probe(client, library.path, source.internalBaseUrl.length > 0));
      if (failure) throw failure;
    }
  }

  function publish(source: StoredSource): PublicSource {
    return {
      id: source.id,
      name: source.name,
      internalBaseUrl: source.internalBaseUrl,
      publicBaseUrl: source.publicBaseUrl,
      username: source.username,
      passwordSet: source.password.length > 0,
      libraries: store.librariesFor(source.id).map((library) => ({
        id: library.id,
        name: library.name,
        kind: library.kind,
        path: library.absolutePath,
      })),
    };
  }

  const service: LibraryService = {
    close() {
      clients.clear();
      healthCache.clear();
      catalog.close();
      store.close();
    },
    sourceCount() {
      return store.sourceCount();
    },
    legacyV1Enabled() {
      return store.sourceCount() === 1 && store.getSource(SEEDED_SOURCE_ID) !== undefined;
    },
    allowsAdmin(ip, adminHeader) {
      if (adminToken && adminHeader === adminToken) return true;
      return trustLoopback && isLoopbackAddress(ip);
    },
    capabilities(admin) {
      return { libraries: true, artwork: true, catalog: true, mediaAdmin: admin, catalogApproval: approvalSecret ? "secret" : "loopback-admin" };
    },
    async libraries() {
      const sources = new Map(store.listSources().map((source) => [source.id, source]));
      const result = [];
      for (const library of store.listLibraries()) {
        const source = sources.get(library.sourceId);
        if (!source) continue;
        const cached = healthCache.get(library.id);
        let health = cached && Date.now() - cached.at < HEALTH_TTL_MS ? cached.health : undefined;
        if (!health) {
          health = await probe(clientFor(source), library.absolutePath, source.internalBaseUrl.length > 0);
          healthCache.set(library.id, { at: Date.now(), health });
        }
        result.push({
          id: library.id,
          name: library.name,
          kind: library.kind,
          sourceId: source.id,
          sourceName: source.name,
          health,
        });
      }
      return result;
    },
    async list(libraryId, relativePath, cursor) {
      const { library, source } = requireLibrary(libraryId);
      return browserFor(source).list(library, relativePath, cursor);
    },
    async search(libraryId, query, cursor) {
      const trimmed = query.trim();
      if (!trimmed || trimmed.length > 200) throw new LibraryRequestError(400, "INVALID_REQUEST");
      const { library, source } = requireLibrary(libraryId);
      return browserFor(source).search(library, trimmed, cursor);
    },
    async resolve(mediaId) {
      const source = sourceForToken(store, cfg.watchPartyMediaIdKey, mediaId);
      if (!source) return undefined;
      return browserFor(source).resolve(mediaId);
    },
    async resolveMpv(mediaId) {
      const source = sourceForToken(store, cfg.watchPartyMediaIdKey, mediaId);
      if (!source) return undefined;
      return browserFor(source).resolveMpv(mediaId);
    },
    async discoverSubtitles(mediaId) {
      const source = sourceForToken(store, cfg.watchPartyMediaIdKey, mediaId);
      if (!source) return undefined;
      return browserFor(source).discoverSubtitles(mediaId);
    },
    async loadSubtitle(mediaId) {
      const source = sourceForToken(store, cfg.watchPartyMediaIdKey, mediaId);
      if (!source) return undefined;
      return browserFor(source).loadSubtitle(mediaId);
    },
    async loadArtwork(mediaId) {
      const source = sourceForToken(store, cfg.watchPartyMediaIdKey, mediaId);
      if (!source) return undefined;
      return browserFor(source).loadArtwork(mediaId);
    },
    adminList() {
      return store.listSources().map(publish);
    },
    async adminCreate(body) {
      refuseEphemeralProduction(cfg);
      const draft = parseCreate(body);
      const source: StoredSource = {
        id: `src_${randomBytes(9).toString("base64url")}`,
        name: draft.name,
        internalBaseUrl: draft.internalBaseUrl,
        publicBaseUrl: draft.publicBaseUrl,
        username: draft.username,
        password: draft.password,
        createdAt: new Date().toISOString(),
      };
      await assertProbe(source, draft.libraries);
      const libraries = draft.libraries.map((library) => ({
        id: `lib_${randomBytes(9).toString("base64url")}`,
        sourceId: source.id,
        name: library.name,
        kind: library.kind,
        absolutePath: library.path,
      }));
      store.insertSource(source, libraries);
      healthCache.clear();
      return publish(source);
    },
    async adminUpdate(id, body) {
      const existing = store.getSource(id);
      if (!existing) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const patch = parsePatch(body);
      const next: StoredSource = {
        ...existing,
        name: patch.name ?? existing.name,
        internalBaseUrl: patch.internalBaseUrl ?? existing.internalBaseUrl,
        publicBaseUrl: patch.publicBaseUrl ?? existing.publicBaseUrl,
        username: patch.username ?? existing.username,
        password: patch.password ?? existing.password,
      };
      const libraries = patch.libraries?.map((library) => ({
        id: `lib_${randomBytes(9).toString("base64url")}`,
        sourceId: id,
        name: library.name,
        kind: library.kind,
        absolutePath: library.path,
      }));
      const connectionChanged =
        next.internalBaseUrl !== existing.internalBaseUrl ||
        next.publicBaseUrl !== existing.publicBaseUrl ||
        next.username !== existing.username ||
        next.password !== existing.password ||
        libraries !== undefined;
      if (connectionChanged) {
        refuseEphemeralProduction(cfg);
        const probeTargets = (libraries ?? store.librariesFor(id)).map((library) => ({ path: library.absolutePath }));
        await assertProbe(next, probeTargets);
      }
      // 快照与草稿按 library_id 存，外键管不到它们：库被删掉时必须一起清，
      // 否则界面上早就不见的库会一直留着一堆孤儿草稿和快照行。
      const before = new Set(store.librariesFor(id).map((library) => library.id));
      store.replaceSource(next, libraries);
      for (const libraryId of before) {
        if (!store.getLibrary(libraryId)) catalog.forgetLibrary(libraryId);
      }
      clients.delete(id);
      healthCache.clear();
      return publish(next);
    },
    adminDelete(id) {
      const orphaned = store.librariesFor(id).map((library) => library.id);
      const removed = store.deleteSource(id);
      if (removed) {
        for (const libraryId of orphaned) catalog.forgetLibrary(libraryId);
        clients.delete(id);
        healthCache.clear();
      }
      return removed;
    },
    catalogList(libraryId, cursor, query) {
      if (!store.getLibrary(libraryId)) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      try {
        return catalog.listCards(libraryId, cursor, query);
      } catch {
        throw new LibraryRequestError(400, "INVALID_REQUEST");
      }
    },
    async catalogDetail(id, includeEpisodeTitles = true) {
      const detail = catalog.getDetail(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      if (!includeEpisodeTitles) return detail;
      if (detail.status !== "confirmed" || detail.externalDb !== "bangumi" || !detail.externalId || !bangumiSearcher.episodeTitles) return detail;
      const subjectId = detail.externalId;
      let request = episodeCache.get(subjectId);
      if (!request) {
        request = bangumiSearcher.episodeTitles(subjectId);
        episodeCache.set(subjectId, request);
      }
      let titles: Map<number, string>;
      try {
        titles = await request;
      } catch {
        episodeCache.delete(subjectId);
        return detail;
      }
      return {
        ...detail,
        children: detail.children.map((child) => ({
          ...child,
          episodeTitle: child.episode === null ? null : titles.get(child.episode) ?? null,
        })),
      };
    },
    async catalogConfirm(id, body) {
      const candidateId = candidateIdFrom(body);
      const saved = catalog.confirm(id, candidateId);
      if (!saved) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      if (saved.imageUrl) await worker.cachePoster(id, saved.imageUrl);
      const detail = catalog.getDetail(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
    },
    catalogReject(id, body) {
      const candidateId = candidateIdFrom(body);
      if (!catalog.reject(id, candidateId)) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const detail = catalog.getDetail(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
    },
    catalogUnconfirm(id) {
      const detail = catalog.unconfirm(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
    },
    async catalogRebind(id, body) {
      const choice = manualBindingFrom(body);
      const saved = catalog.rebind(id, choice);
      if (!saved) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      if (saved.imageUrl) await worker.cachePoster(id, saved.imageUrl);
      const detail = catalog.getDetail(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
    },
    catalogMerge(body) {
      const record = asRecord(body);
      const keepId = typeof record?.keepId === "string" ? record.keepId : "";
      const dropIds = Array.isArray(record?.dropIds) ? record.dropIds.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
      if (!keepId || dropIds.length === 0) throw new LibraryRequestError(400, "INVALID_REQUEST");
      const detail = catalog.mergeItems(keepId, dropIds.filter((id) => id !== keepId).slice(0, 20));
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
    },
    catalogSplit(id, body) {
      const record = asRecord(body);
      const raw = record?.groups;
      if (!Array.isArray(raw) || raw.length < 2 || raw.length > 24) throw new LibraryRequestError(400, "INVALID_REQUEST");
      const groups = raw.map((group) => {
        if (!Array.isArray(group) || group.length === 0) throw new LibraryRequestError(400, "INVALID_REQUEST");
        return group.filter((mediaId): mediaId is string => typeof mediaId === "string" && Boolean(mediaId)).slice(0, 500);
      });
      const details = catalog.splitItem(id, groups);
      if (!details) throw new LibraryRequestError(400, "INVALID_REQUEST");
      return details;
    },
    async vendorSearch(body) {
      const record = asRecord(body);
      const query = typeof record?.q === "string" ? record.q.trim() : "";
      if (query.length < 2 || query.length > 80) throw new LibraryRequestError(400, "INVALID_REQUEST");
      const hits = await bangumiSearcher.search(query, "anime");
      return hits.slice(0, 12).map((hit) => ({
        externalDb: hit.externalDb,
        externalId: hit.externalId,
        title: hit.title,
        originalTitle: hit.originalTitle,
        year: hit.year,
        episodes: hit.episodes,
        imageUrl: hit.imageUrl,
      }));
    },
    catalogScan(id) {
      // 库不存在就 404：以前这里回 200 加一串 0，读的人会以为"这个库是空的"，
      // 而真相是 id 写错了或者库被删了。对 agent 尤其重要 —— 猜不出来的错不该伪装成空。
      const { library } = requireLibrary(id);
      // running 只说一件事：这个库现在有没有在枚举。上次扫过什么、成功还是失败，
      // 是别的字段的事，混进来界面就会拿它当那个用。
      return { ...catalog.scanInfo(library.id), running: inFlight.has(`scan:${library.id}`) };
    },
    async catalogRefreshScan(id) {
      const library = store.getLibrary(id);
      if (!library) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const settled = await withGrace("scan", id, () =>
        oncePerLibrary(`scan:${id}`, async () => {
          const files = library.kind === "other" ? [] : await collectLibraryFiles(library);
          if (stillThere(id, "scan")) catalog.writeScan(id, files);
          return catalog.scanInfo(id);
        }),
      );
      if (!settled.done) return { status: "accepted" as const, libraryId: id, running: true as const };
      return { status: "done" as const, libraryId: id, running: false as const, ...settled.value };
    },
    async catalogClassify(id) {
      const { library } = requireLibrary(id);
      const settled = await withGrace("classify", id, () => oncePerLibrary(`classify:${id}`, () => classifyLibrary(library)));
      if (!settled.done) return { status: "accepted", libraryId: id, running: true as const };
      return { status: "done" as const, ...settled.value, running: false as const };
    },
    async catalogPrepare(id, maxLookups) {
      const { library } = requireLibrary(id);
      const info = catalog.draftInfo(id);
      const scan = catalog.scanInfo(id);
      // 只在没有草稿或草稿过期时重新分类：分类是整批替换，每次进来就重做会把上一轮
      // 判定好的草稿擦掉，那样分批跑（Bangumi 匿名限速）永远凑不完。
      const classified =
        info.cards === 0 || info.rev !== scan.rev
          ? await classifyLibrary(library)
          : { files: scan.files, cards: info.cards, rev: scan.rev };
      const report = await worker.judgeDrafts(id, maxLookups);
      if (!report) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return {
        libraryId: id,
        files: classified.files,
        cards: classified.cards,
        rev: classified.rev,
        ...report,
        diff: catalog.draftDiff(id),
      };
    },
    async catalogApply(id, force, approvalToken) {
      const { library } = requireLibrary(id);
      const info = catalog.draftInfo(id);
      if (info.cards === 0) throw new LibraryRequestError(409, "CATALOG_DRAFT_EMPTY", { draftCards: 0 });
      if (info.rev !== catalog.scanInfo(id).rev) throw new LibraryRequestError(409, "CATALOG_STALE_SCAN", { draftRev: info.rev, scanRev: catalog.scanInfo(id).rev, draftCards: info.cards });
      // 没判完就应用：未确认的卡会被结构对齐重置成"未匹配"，候选列表也一起丢。
      // 绑定不会丢（未判定的草稿跳过），但界面会看起来"掉了一截"，所以默认拒绝。
      if (info.pending > 0 && !force) throw new LibraryRequestError(409, "CATALOG_DRAFT_INCOMPLETE", { pending: info.pending, draftCards: info.cards });
      // 元数据可以直写；建卡/删卡/换文件必须带网页刚签发的那一次性凭证。
      const target = approvalTarget(id);
      let approvalId: string | null = null;
      if (approvalToken === undefined) {
        if (structuralCount(target.structural) > 0) throw new LibraryRequestError(409, "CATALOG_APPROVAL_REQUIRED", { structural: target.structural, draftCards: info.cards });
      } else {
        approvalId = consumeApproval(id, approvalToken, target);
      }
      const groups = catalog.readDraft(id).map((card) => ({
        itemKey: card.itemKey,
        query: card.query,
        queries: [card.query],
        rawName: card.rawName,
        files: card.children,
      }));
      const before = new Set(catalog.cardIds(id));
      // 反向操作只在真的带了凭证的这次应用里记录：结构变更必须由那次批准可撤销。
      const snapshotBefore = approvalId ? catalog.snapshotLibrary(id) : [];
      const postersBefore = approvalId ? catalog.posterRows(id) : [];
      // 结构交给 upsertScan：身份认别、人工保护、孤儿行清理都在那边，一行都不重写。
      catalog.upsertScan(id, library.kind, groups, false);
      const applied = catalog.applyDraftDecisions(id);
      const created = catalog.cardIds(id).filter((cardId) => !before.has(cardId)).length;
      if (approvalId) {
        const undo = diffSnapshots(id, snapshotBefore, catalog.snapshotLibrary(id));
        if (undo) {
          // 海报行必须在 apply 之前抄：卡被删时那一行是级联删的，事后查不到。
          const touched = new Set([...undo.before, ...undo.after].map((card) => card.id));
          catalog.setApprovalOutcome(approvalId, { ...undo, posters: postersBefore.filter((row) => touched.has(row.itemId)) });
        }
      }
      for (const poster of applied.posters) await worker.cachePoster(poster.itemId, poster.url);
      return {
        libraryId: id,
        cards: groups.length,
        created,
        updated: applied.updated,
        skipped: applied.skipped,
        deferred: applied.deferred,
        posters: applied.posters.length,
        structural: target.structural,
        approvalId,
        rollbackAvailable: Boolean(approvalId) && Boolean(approvalId ? catalog.readUndo(approvalId) : undefined),
        diff: catalog.draftDiff(id),
      };
    },
    catalogApprove(id, body, approvalSecretHeader) {
      requireLibrary(id);
      // 顺手回收过了撤回窗口的 undo。放在签发这一刻（一次写）而不是读接口里，免得 GET 改数据；
      // 窗口本身在 rollbackPlan 里也单独判，不依赖这次清理跑没跑过。
      const pruned = catalog.pruneExpiredUndo(new Date().toISOString());
      if (approvalSecret && !secretMatches(approvalSecretHeader, approvalSecret)) throw new LibraryRequestError(401, "CATALOG_APPROVAL_SECRET_REQUIRED");
      const record = (body ?? {}) as Record<string, unknown>;
      const approvedBy = typeof record.approvedBy === "string" && record.approvedBy.trim() ? record.approvedBy.trim().slice(0, 80) : "web";
      const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
      const token = randomBytes(24).toString("base64url");
      // 回滚也要人再点一次：批准的是"把那次应用撤回去"这个动作，不是又一次盖库。
      if (typeof record.rollbackOf === "string" && record.rollbackOf) {
        const plan = rollbackPlan(id, record.rollbackOf, pruned);
        const approvalId = catalog.createApproval({
          tokenHash: tokenHashOf(token),
          libraryId: id,
          draftRevision: plan.draftRevision,
          scanRevision: plan.scanRevision,
          operationHash: plan.digest,
          approvedBy,
          expiresAt,
          kind: "rollback",
          targets: plan.undo ? record.rollbackOf : null,
        });
        return { libraryId: id, approvalId, approvalToken: token, expiresAt, approvedBy, pruned, rollback: plan.detail.rollback };
      }
      const target = approvalTarget(id);
      if (structuralCount(target.structural) === 0) {
        throw new LibraryRequestError(409, "CATALOG_NOTHING_TO_APPROVE", { draftCards: catalog.draftInfo(id).cards, pruned });
      }
      const approvalId = catalog.createApproval({
        tokenHash: tokenHashOf(token),
        libraryId: id,
        draftRevision: target.draftRevision,
        scanRevision: target.scanRevision,
        operationHash: target.digest,
        approvedBy,
        expiresAt,
      });
      return { libraryId: id, approvalId, approvalToken: token, expiresAt, approvedBy, pruned, structural: target.structural };
    },
    async catalogRollback(id, body) {
      requireLibrary(id);
      const record = (body ?? {}) as Record<string, unknown>;
      const targetId = typeof record.rollbackOf === "string" ? record.rollbackOf : "";
      if (!targetId) throw draftInvalid();
      const plan = rollbackPlan(id, targetId);
      consumeApproval(id, approvalTokenOf(body), plan);
      const outcome = catalog.restoreApplyUndo(plan.undo);
      if ("conflict" in outcome) throw new LibraryRequestError(409, "CATALOG_ROLLBACK_CONFLICT", { rollbackOf: targetId, keys: outcome.conflict });
      catalog.markRolledBack(targetId);
      return {
        libraryId: id,
        rollbackOf: targetId,
        restored: plan.undo.before.length,
        removed: plan.undo.counts.created,
        keys: plan.undo.keys,
        diff: catalog.draftDiff(id),
      };
    },
    catalogRevoke(id, body) {
      requireLibrary(id);
      if (!catalog.revokeApproval(tokenHashOf(approvalTokenOf(body)))) throw new LibraryRequestError(409, "CATALOG_APPROVAL_INVALID", { reason: "not-revocable" });
      return { libraryId: id, revoked: true as const };
    },
    async catalogApplyApproved(id, body) {
      requireLibrary(id);
      const token = approvalTokenOf(body);
      const force = /^(1|true|yes)$/i.test(String((body as Record<string, unknown> | undefined)?.force ?? ""));
      return service.catalogApply(id, force, token);
    },
    async catalogJudge(id, maxLookups) {
      const { library } = requireLibrary(id);
      if (catalog.draftInfo(id).cards === 0 || catalog.draftInfo(id).rev !== catalog.scanInfo(id).rev) await classifyLibrary(library);
      const report = await worker.judgeDrafts(id, maxLookups);
      if (!report) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return { libraryId: id, kind: library.kind, ...report, diff: catalog.draftDiff(id) };
    },
    catalogDraft(id) {
      if (!store.getLibrary(id)) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const info = catalog.draftInfo(id);
      return {
        libraryId: id,
        cards: info.cards,
        files: info.files,
        pending: info.pending,
        classifiedAt: info.classifiedAt,
        // 只说"这个库现在有没有在分类"，供 POST .../classify 收到 202 后轮询用。
        running: inFlight.has(`classify:${id}`),
        scan: catalog.scanInfo(id),
        thresholds: judgeThresholds,
        // 列表投影：children 不在这里，展开某一张时走 catalogDraftCard。
        draft: catalog.draftList(id),
        diff: catalog.draftDiff(id),
      };
    },
    catalogApprovals(id) {
      requireLibrary(id);
      return {
        libraryId: id,
        items: catalog.listApprovals(id).map((record) => {
          const expired = new Date(record.expiresAt).getTime() <= Date.now();
          const found = record.kind === "apply" && record.usedAt && !record.rolledBackAt ? catalog.readUndo(record.id) : undefined;
          const undo = expired ? undefined : found;
          return {
            approvalId: record.id,
            kind: record.kind,
            approvedBy: record.approvedBy,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            usedAt: record.usedAt,
            revokedAt: record.revokedAt,
            appliedAt: record.appliedAt,
            rolledBackAt: record.rolledBackAt,
            targets: record.targets,
            ...(undo ? { keys: undo.keys, counts: undo.counts } : {}),
            rollbackAvailable: Boolean(undo),
            /** 用过、没撤过，但撤回窗口已经过了（凭证过期或 undo 已被回收）。 */
            windowClosed: Boolean(record.usedAt) && record.kind === "apply" && !record.rolledBackAt && !undo,
          };
        }),
      };
    },
    catalogDuplicates(id) {
      const { library } = requireLibrary(id);
      const items = catalog.duplicateGroups(id);
      const scan = catalog.scanInfo(id);
      return {
        libraryId: id,
        kind: library.kind,
        readOnly: true as const,
        autoMerge: false as const,
        cards: catalog.cardIds(id).length,
        groupedCards: items.reduce((total, group) => total + group.cards.length, 0),
        groups: items.length,
        scan: { files: scan.files, rev: scan.rev },
        items,
      };
    },
    catalogDraftCard(id, itemKey) {
      if (!store.getLibrary(id)) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const children = catalog.draftChildren(id, itemKey);
      const candidates = catalog.draftCandidates(id, itemKey);
      const card = catalog.draftList(id).find((entry) => entry.itemKey === itemKey);
      if (!children || !candidates || !card) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return { libraryId: id, card, children, candidates };
    },
    draftEdit(id, body) {
      requireLibrary(id);
      const itemKey = draftString(body, "itemKey", 1000);
      const patch = {
        ...(typeof (body as Record<string, unknown>)?.title === "string" ? { title: draftString(body, "title", 160) } : {}),
        ...(typeof (body as Record<string, unknown>)?.originalTitle === "string" ? { originalTitle: draftString(body, "originalTitle", 160) } : {}),
        ...(typeof (body as Record<string, unknown>)?.overview === "string" ? { overview: draftString(body, "overview", 4000) } : {}),
        ...(typeof (body as Record<string, unknown>)?.posterUrl === "string" ? { posterUrl: draftString(body, "posterUrl", 1000) } : {}),
        ...draftYear(body),
        ...draftBinding(body),
      };
      if (Object.keys(patch).length === 0) throw draftInvalid();
      if (!catalog.draftEdit(id, itemKey, patch)) throw draftNotFound();
      return draftSummary(id, itemKey);
    },
    draftConfirm(id, body) {
      requireLibrary(id);
      const itemKey = draftString(body, "itemKey", 1000);
      const binding = draftBinding(body);
      const result = catalog.draftConfirm(id, itemKey, binding.externalDb && binding.externalId ? { externalDb: binding.externalDb, externalId: binding.externalId } : undefined);
      if (result === "missing") throw draftNotFound();
      if (result === "no-candidate") throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "no-candidate" });
      if (result === "unknown-candidate") throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "unknown-candidate" });
      return draftSummary(id, itemKey);
    },
    draftUnconfirm(id, body) {
      requireLibrary(id);
      const itemKey = draftString(body, "itemKey", 1000);
      if (!catalog.draftUnconfirm(id, itemKey)) throw draftNotFound();
      return draftSummary(id, itemKey);
    },
    draftMerge(id, body) {
      requireLibrary(id);
      const keepKey = draftString(body, "keepKey", 1000);
      const raw = (body as Record<string, unknown>)?.dropKeys;
      if (!Array.isArray(raw) || raw.length === 0 || raw.some((key) => typeof key !== "string" || !key || key.length > 1000)) throw draftInvalid();
      const dropKeys = raw as string[];
      const merged = catalog.draftMerge(id, keepKey, dropKeys);
      if (merged.error === "missing") throw draftNotFound();
      if (merged.error === "conflict") throw new LibraryRequestError(400, "DRAFT_EDIT_CONFLICT", { keys: merged.keys ?? [] });
      return draftSummary(id, keepKey);
    },
    draftSplit(id, body) {
      requireLibrary(id);
      const itemKey = draftString(body, "itemKey", 1000);
      // mediaId 是路径 HMAC，实测 307-349 字：只校验类型与个数，归属交给 store 判。
      const raw = (body as Record<string, unknown>)?.keep;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5000 || raw.some((mediaId) => typeof mediaId !== "string" || !mediaId || mediaId.length > 1024)) {
        throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "bad-keep-list" });
      }
      const result = catalog.draftSplit(id, itemKey, raw as string[]);
      if (result.error === "missing") throw draftNotFound();
      if (result.error === "unknown-media") throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "unknown-media", keys: result.unknown ?? [] });
      if (result.error === "invalid") throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "nothing-to-split" });
      return { ...draftSummary(id, itemKey), createdKeys: result.created ?? [] };
    },
    draftKeepBinding(id, body) {
      requireLibrary(id);
      const itemKey = draftString(body, "itemKey", 1000);
      const keepsBindingOnKey = draftString(body, "keepsBindingOnKey", 1000);
      // itemKey === keepsBindingOnKey 是"不搬/复位"，不是非法：下拉的默认项要走得通。
      if (!catalog.draftCarryBinding(id, itemKey, keepsBindingOnKey)) throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "bad-carrier" });
      return draftSummary(id, itemKey);
    },
    importExport(id) {
      const { library } = requireLibrary(id);
      const cards = catalog.readDraft(id);
      if (cards.length === 0) throw new LibraryRequestError(409, "CATALOG_DRAFT_EMPTY", { draftCards: 0 });
      // size 来自快照，也就是列目录那一次请求已经拿到的东西；导出不额外打请求。
      const sizeByPath = new Map(catalog.readScan(id).map((file) => [file.relativePath, file.size ?? null]));
      const sidecars = cards.map((card) =>
        buildCollection(id, library.name, {
          itemKey: card.itemKey,
          children: card.children,
          sizeByPath,
          title: card.title ?? card.query,
          originalTitle: card.originalTitle,
          year: card.year,
          overview: card.overview,
          posterUrl: card.posterUrl,
          externalDb: card.externalDb,
          externalId: card.externalId,
        }),
      );
      return { libraryId: id, root: path.join(sidecarRoot, ...safeSegments(id)), cards: sidecars.length, written: writeCollectionRoot(sidecarRoot, id, sidecars) };
    },
    importPreview(id) {
      return importCollections(id, null);
    },
    importStructure(id, body) {
      requireLibrary(id);
      const raw = (body as Record<string, unknown> | undefined)?.sourceFiles;
      if (raw === undefined) return importCollections(id, "all");
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || !entry || entry.length > 600)) {
        throw draftError("DRAFT_EDIT_INVALID", 400, { reason: "bad-source-files" });
      }
      return importCollections(id, raw as string[]);
    },
    catalogPoster(id) {
      return catalog.readPoster(id);
    },
    async adminScrape(libraryId) {
      const job = await worker.start(libraryId);
      if (!job) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return publicJob(job);
    },
    adminScrapeStatus(libraryId) {
      if (!store.getLibrary(libraryId)) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const job = catalog.getJob(libraryId);
      if (!job) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return publicJob(job);
    },
  };
  worker.resumeIncomplete();
  return service;
}

export function routeLibraryMedia(media: WatchpartyMedia, library: LibraryService): WatchpartyMedia {
  const legacy = (id: string) => !id.startsWith("v2.") && library.legacyV1Enabled();
  return {
    ...media,
    resolve: (id) => (id.startsWith("v2.") ? library.resolve(id) : legacy(id) ? media.resolve(id) : Promise.resolve(undefined)),
    resolveMpv: (id) => (id.startsWith("v2.") ? library.resolveMpv(id) : legacy(id) ? media.resolveMpv(id) : Promise.resolve(undefined)),
    discoverSubtitles: (id) =>
      id.startsWith("v2.") ? library.discoverSubtitles(id) : legacy(id) ? media.discoverSubtitles(id) : Promise.resolve(undefined),
    loadSubtitle: (id) =>
      id.startsWith("v2.") ? library.loadSubtitle(id) : legacy(id) ? media.loadSubtitle(id) : Promise.resolve(undefined),
  };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return host === "127.0.0.1" || host === "::1";
}

function defaultDbPath(cfg: AppConfig): string {
  if (cfg.nodeEnv === "test") return ":memory:";
  return path.join(process.cwd(), "data", "watchparty-library.sqlite");
}

function defaultCatalogDbPath(cfg: AppConfig): string {
  if (cfg.nodeEnv === "test") return ":memory:";
  return path.join(process.cwd(), "data", "watchparty-catalog.sqlite");
}

function defaultPosterDir(cfg: AppConfig): string {
  if (cfg.nodeEnv === "test") return fs.mkdtempSync(path.join(os.tmpdir(), "wp-posters-"));
  return path.join(process.cwd(), "data", "poster-cache");
}

/** sidecar 的规范来源永远在服务端本地，不回写 OpenList 目录。 */
function defaultSidecarDir(cfg: AppConfig): string {
  if (cfg.nodeEnv === "test") return fs.mkdtempSync(path.join(os.tmpdir(), "wp-sidecars-"));
  return path.join(process.cwd(), "data", "catalog-sidecars");
}

function publicJob(job: { libraryId: string; status: string; total: number; scanned: number; matched: number; lastError: string | null }) {
  return {
    libraryId: job.libraryId,
    status: job.status,
    total: job.total,
    scanned: job.scanned,
    matched: job.matched,
    lastError: job.lastError,
  };
}

function candidateIdFrom(body: unknown): string {
  const record = asRecord(body);
  const candidateId = record?.candidateId;
  if (typeof candidateId !== "string" || !candidateId) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return candidateId;
}

/**
 * A binding a person typed/picked by hand. The vendor id is the only thing that
 * has to be trustworthy, so it is constrained to digits even though the column is
 * free text; `title` is what the card will show verbatim.
 */
function manualBindingFrom(body: unknown): ManualBinding {
  const record = asRecord(body);
  const externalDb = record?.externalDb;
  const externalId = typeof record?.externalId === "string" ? record.externalId.trim() : "";
  const title = typeof record?.title === "string" ? record.title.trim() : "";
  if (externalDb !== "bangumi" && externalDb !== "tmdb") throw new LibraryRequestError(400, "INVALID_REQUEST");
  if (!/^\d{1,12}$/.test(externalId)) throw new LibraryRequestError(400, "INVALID_REQUEST");
  if (!title || title.length > 160) throw new LibraryRequestError(400, "INVALID_REQUEST");
  const year = typeof record?.year === "number" && record.year >= 1900 && record.year <= 2100 ? Math.trunc(record.year) : null;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  return {
    externalDb,
    externalId,
    title,
    originalTitle: text(record?.originalTitle, 160),
    year,
    overview: text(record?.overview, 2000),
    imageUrl: text(record?.imageUrl, 500),
  };
}

function seedIfEmpty(store: LibraryStore, cfg: AppConfig): void {
  if (store.sourceCount() > 0) return;
  const source: StoredSource = {
    id: SEEDED_SOURCE_ID,
    name: "Primary",
    internalBaseUrl: trimBase(cfg.openlistUrl),
    publicBaseUrl: trimBase(cfg.openlistPublicUrl || cfg.openlistUrl),
    username: cfg.openlistUsername,
    password: cfg.openlistPassword,
    createdAt: new Date(0).toISOString(),
  };
  store.insertSource(source, [
    { id: "lib_anime", sourceId: source.id, name: "Anime", kind: "anime", absolutePath: WATCHPARTY_ROOTS.Anime },
    { id: "lib_film", sourceId: source.id, name: "Film", kind: "movie", absolutePath: WATCHPARTY_ROOTS.Film },
    { id: "lib_tv", sourceId: source.id, name: "TV Shows", kind: "tv", absolutePath: WATCHPARTY_ROOTS["TV Shows"] },
  ]);
}

function sourceForToken(store: LibraryStore, key: string, mediaId: string): StoredSource | undefined {
  const decoded = decodeLibraryMediaId(mediaId, key);
  if (!decoded) return undefined;
  return store.getSource(decoded.sourceId);
}

function refuseEphemeralProduction(cfg: AppConfig): void {
  if (cfg.nodeEnv === "production" && cfg.configStatus.mediaIdKey.mode === "ephemeral") {
    throw new LibraryRequestError(409, "MEDIA_ID_KEY_EPHEMERAL");
  }
}

type LibraryDraft = { name: string; kind: LibraryKind; path: string };
type SourceDraft = {
  name: string;
  internalBaseUrl: string;
  publicBaseUrl: string;
  username: string;
  password: string;
  libraries: LibraryDraft[];
};

function parseCreate(body: unknown): SourceDraft {
  const record = asRecord(body);
  if (!record) throw new LibraryRequestError(400, "INVALID_REQUEST");
  const name = requiredName(record.name);
  const internalBaseUrl = requiredBaseUrl(record.internalBaseUrl);
  const publicBaseUrl = record.publicBaseUrl === undefined ? internalBaseUrl : requiredBaseUrl(record.publicBaseUrl);
  const username = record.username === undefined ? "" : requiredPlain(record.username, 200);
  const password = record.password === undefined ? "" : requiredPlain(record.password, 4096);
  const libraries = requiredLibraries(record.libraries);
  return { name, internalBaseUrl, publicBaseUrl, username, password, libraries };
}

function parsePatch(body: unknown): {
  name?: string;
  internalBaseUrl?: string;
  publicBaseUrl?: string;
  username?: string;
  password?: string;
  libraries?: LibraryDraft[];
} {
  const record = asRecord(body);
  if (!record) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return {
    ...(record.name !== undefined ? { name: requiredName(record.name) } : {}),
    ...(record.internalBaseUrl !== undefined ? { internalBaseUrl: requiredBaseUrl(record.internalBaseUrl) } : {}),
    ...(record.publicBaseUrl !== undefined ? { publicBaseUrl: requiredBaseUrl(record.publicBaseUrl) } : {}),
    ...(record.username !== undefined ? { username: requiredPlain(record.username, 200) } : {}),
    ...(record.password !== undefined ? { password: requiredPlain(record.password, 4096) } : {}),
    ...(record.libraries !== undefined ? { libraries: requiredLibraries(record.libraries) } : {}),
  };
}

function requiredLibraries(value: unknown): LibraryDraft[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new LibraryRequestError(400, "INVALID_REQUEST");
    const kind = record.kind;
    if (typeof kind !== "string" || !isLibraryKind(kind)) throw new LibraryRequestError(400, "INVALID_REQUEST");
    return { name: requiredName(record.name), kind, path: requiredLibraryPath(record.path) };
  });
}

function requiredName(value: unknown): string {
  const name = requiredPlain(value, 200);
  if (!name) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return name;
}

function requiredPlain(value: unknown, max: number): string {
  if (typeof value !== "string") throw new LibraryRequestError(400, "INVALID_REQUEST");
  const trimmed = value.trim();
  if (value !== trimmed || trimmed.length > max) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return trimmed;
}

function requiredBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new LibraryRequestError(400, "INVALID_REQUEST");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LibraryRequestError(400, "INVALID_REQUEST");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new LibraryRequestError(400, "INVALID_REQUEST");
  }
  return trimBase(value);
}

function requiredLibraryPath(value: unknown): string {
  if (typeof value !== "string") throw new LibraryRequestError(400, "INVALID_REQUEST");
  const trimmed = value.trim();
  if (trimmed !== value || !trimmed.startsWith("/") || trimmed.length > 4096 || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new LibraryRequestError(400, "INVALID_REQUEST");
  }
  const stripped = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  const parts = stripped.split("/");
  if (parts.some((part) => part === "." || part === "..")) throw new LibraryRequestError(400, "INVALID_REQUEST");
  if (path.posix.normalize(stripped) !== stripped) throw new LibraryRequestError(400, "INVALID_REQUEST");
  return stripped;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function trimBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
