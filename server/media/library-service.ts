import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
import { openCatalogStore, type CatalogCard, type CatalogDraftCard, type CatalogDraftDiff, type CatalogDraftRow, type CatalogDetail, type ManualBinding } from "./catalog-store.ts";
import { createCatalogWorker } from "./catalog-worker.ts";
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
  };
  catalogList(libraryId: string, cursor?: string, query?: string): { items: CatalogCard[]; hasMore: boolean; nextCursor?: string };
  catalogDetail(id: string): CatalogDetail;
  catalogConfirm(id: string, body: unknown): Promise<CatalogDetail>;
  catalogReject(id: string, body: unknown): CatalogDetail;
  catalogUnconfirm(id: string): CatalogDetail;
  catalogRebind(id: string, body: unknown): Promise<CatalogDetail>;
  catalogMerge(body: unknown): CatalogDetail;
  catalogSplit(id: string, body: unknown): CatalogDetail[];
  /** 人工挑条目用的vendor搜索（卡片改绑时先搜后绑）。 */
  vendorSearch(body: unknown): Promise<Array<{ externalDb: string; externalId: string; title: string; originalTitle: string | null; year: number | null; episodes: number | null; imageUrl: string | null }>>;
  catalogScan(id: string): { files: number; enumeratedAt: string | null };
  /** 只枚举并刷新快照，不分组、不刮削、不动任何卡。 */
  catalogRefreshScan(id: string): Promise<{ files: number; enumeratedAt: string | null }>;
  /** 枚举（快照为空时）+ 分类。结果只进 catalog_draft，正式卡一行不动。 */
  catalogClassify(id: string): Promise<{ libraryId: string; files: number; cards: number; rev: number; diff: CatalogDraftDiff }>;
  /** 对草稿逐条查条目打分，结论只写草稿；maxLookups 限制本次处理几张（Bangumi 匿名限速）。 */
  catalogJudge(id: string, maxLookups?: number): Promise<{ libraryId: string; kind: LibraryKind; judged: number; confirmed: number; pending: number; items: string[]; diff: CatalogDraftDiff }>;
  /** 把草稿变成正式卡。rev 与当前快照不一致就 409，绝不拿过期结果盖库。 */
  catalogApply(id: string, force?: boolean): Promise<{ libraryId: string; cards: number; created: number; updated: number; skipped: number; deferred: number; posters: number; diff: CatalogDraftDiff }>;
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
const SEEDED_SOURCE_ID = "src_default";

export function createLibraryService(options: {
  cfg: AppConfig;
  dbPath?: string;
  clientFactory?: LibraryClientFactory;
  trustLoopback?: boolean;
  adminToken?: string;
  catalogDbPath?: string;
  posterDir?: string;
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
  const bangumiSearcher = options.bangumi ?? createBangumiClient();
  const worker = createCatalogWorker({
    catalog,
    bangumi: bangumiSearcher,
    tmdb: options.tmdb ?? createTmdbClient(),
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

  /** 枚举（快照为空或已过期时）+ 分类，结果只进草稿表。 */
  async function classifyLibrary(library: StoredLibrary): Promise<{ libraryId: string; files: number; cards: number; rev: number; diff: CatalogDraftDiff }> {
    const id = library.id;
    const current = catalog.scanInfo(id).rev;
    let files = current > 0 ? catalog.readScan(id) : [];
    if (files.length === 0) {
      files = library.kind === "other" ? [] : await collectLibraryFiles(library);
      catalog.writeScan(id, files);
    }
    const groups = groupScanFiles(files, catalog.protectedKeys(id)).filter((group) => group.query);
    const cards = catalog.writeDraft(id, groups);
    return { libraryId: id, files: files.length, cards, rev: catalog.scanInfo(id).rev, diff: catalog.draftDiff(id) };
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
          else if (isVideoFileName(item.name)) files.push({ relativePath: item.relativePath, name: item.name, mediaId: item.id });
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
      return { libraries: true, artwork: true, catalog: true, mediaAdmin: admin };
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
    catalogDetail(id) {
      const detail = catalog.getDetail(id);
      if (!detail) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      return detail;
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
      return catalog.scanInfo(id);
    },
    async catalogRefreshScan(id) {
      const library = store.getLibrary(id);
      if (!library) throw new LibraryRequestError(404, "MEDIA_NOT_FOUND");
      const files = library.kind === "other" ? [] : await collectLibraryFiles(library);
      catalog.writeScan(id, files);
      return catalog.scanInfo(id);
    },
    async catalogClassify(id) {
      const { library } = requireLibrary(id);
      return classifyLibrary(library);
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
    async catalogApply(id, force) {
      const { library } = requireLibrary(id);
      const info = catalog.draftInfo(id);
      if (info.cards === 0) throw new LibraryRequestError(409, "CATALOG_DRAFT_EMPTY", { draftCards: 0 });
      if (info.rev !== catalog.scanInfo(id).rev) throw new LibraryRequestError(409, "CATALOG_STALE_SCAN", { draftRev: info.rev, scanRev: catalog.scanInfo(id).rev, draftCards: info.cards });
      // 没判完就应用：未确认的卡会被结构对齐重置成"未匹配"，候选列表也一起丢。
      // 绑定不会丢（未判定的草稿跳过），但界面会看起来"掉了一截"，所以默认拒绝。
      if (info.pending > 0 && !force) throw new LibraryRequestError(409, "CATALOG_DRAFT_INCOMPLETE", { pending: info.pending, draftCards: info.cards });
      const groups = catalog.readDraft(id).map((card) => ({
        itemKey: card.itemKey,
        query: card.query,
        queries: [card.query],
        rawName: card.rawName,
        files: card.children,
      }));
      const before = new Set(catalog.cardIds(id));
      // 结构交给 upsertScan：身份认别、人工保护、孤儿行清理都在那边，一行都不重写。
      catalog.upsertScan(id, library.kind, groups, false);
      const applied = catalog.applyDraftDecisions(id);
      const created = catalog.cardIds(id).filter((cardId) => !before.has(cardId)).length;
      for (const poster of applied.posters) await worker.cachePoster(poster.itemId, poster.url);
      return {
        libraryId: id,
        cards: groups.length,
        created,
        updated: applied.updated,
        skipped: applied.skipped,
        deferred: applied.deferred,
        posters: applied.posters.length,
        diff: catalog.draftDiff(id),
      };
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
        scan: catalog.scanInfo(id),
        thresholds: judgeThresholds,
        // 列表投影：children 不在这里，展开某一张时走 catalogDraftCard。
        draft: catalog.draftList(id),
        diff: catalog.draftDiff(id),
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
