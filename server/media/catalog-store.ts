import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cleanTitle, episodeSubtitle, isVideoFileName, parseEpisode, titleCandidates, type CatalogGroup, type CatalogGroupFile, type ScanFile } from "./catalog-names.ts";
import { compatibilityOf, extensionOf } from "./library-browser.ts";
import type { MediaCompatibility } from "./watchparty-media.ts";
import type { MetadataDb, RankedHit } from "./catalog-metadata.ts";
import type { LibraryKind } from "./library-store.ts";

export type CatalogStatus = "unmatched" | "candidate" | "confirmed" | "rejected";

export type ScrapeJob = {
  libraryId: string;
  status: "running" | "done" | "failed";
  total: number;
  scanned: number;
  matched: number;
  enumerated: boolean;
  lastError: string | null;
};

export type PendingItem = {
  id: string;
  libraryId: string;
  itemKey: string;
  kind: LibraryKind;
  query: string;
  rawName: string;
  subtitle: string | null;
  fileCount: number;
  /**
   * File names under this item, used to rebuild the title candidates at lookup
   * time. Persisting `queries` instead would need a column; the children already
   * carry the names, so a re-scan can never leave a stale candidate list behind.
   */
  fileNames: string[];
};

export type CatalogCard = {
  id: string;
  title: string;
  year: number | null;
  kind: LibraryKind;
  status: CatalogStatus;
  posterUrl: string | null;
  subtitle: string | null;
};

/** `auto` = 刮削自己确认的；其余都是人的决定，自动流程一律不许改。 */
export type ConfirmedBy = "auto" | "manual" | "rebind" | "unknown";

/**
 * 分类结果：卡片"应该是这样"的陈述，正式表一行都不动。身份仍是文件集合
 * （`signature`），所以人改过路径的卡不会因为换目录而被当成新片。
 */
export type CatalogDraftCard = {
  itemKey: string;
  query: string;
  rawName: string;
  subtitle: string | null;
  files: number;
  children: CatalogGroupFile[];
  rev: number;
  status: CatalogStatus;
  lookupState: "pending" | "done";
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  externalDb: string | null;
  externalId: string | null;
  confirmedBy: ConfirmedBy | null;
  posterUrl: string | null;
  /** 这行承接了哪张正式卡的绑定（null = 默认，不搬）。界面下拉的当前值就取这里。 */
  carriesKey: string | null;
  candidates: RankedHit[];
};

/** 列表投影：不含 children 与候选列表，只带表格要排序/筛选的两个扁平数字。 */
export type CatalogDraftRow = Omit<CatalogDraftCard, "children" | "candidates"> & {
  topScore: number | null;
  candidateCount: number;
};

/** 人工改草稿能改的字段；`undefined` = 保持原样。 */
export type DraftPatch = {
  title?: string;
  originalTitle?: string | null;
  year?: number | null;
  overview?: string | null;
  externalDb?: string | null;
  externalId?: string | null;
  posterUrl?: string | null;
};

/** 判定阶段要处理的草稿行：只给得出查询需要的字段，kind 由调用方（库）提供。 */
export type DraftSubject = {
  itemKey: string;
  query: string;
  rawName: string;
  fileNames: string[];
  fileCount: number;
};

/** 判定的产物。写草稿用，不落正式表；应用时才变成卡上的绑定。 */
export type DraftJudgment = {
  status: CatalogStatus;
  candidates: RankedHit[];
  chosen?: RankedHit | null;
  posterUrl?: string | null;
};

/** 草稿与库里的正式卡对照出来的差异，就是"应用这一步会发生什么"。 */
export type CatalogDraftDiff = {
  /** 新卡从哪张正式卡接走文件（文件级证据）：`fromFiles` 是接走的个数。 */
  added: Array<{ itemKey: string; query: string; files: number; splitFromKey: string | null; fromFiles: number }>;
  dropped: Array<{ id: string; itemKey: string; title: string; files: number }>;
  moved: Array<{ id: string; itemKey: string; fromKey: string; files: number }>;
  /** 同一张卡、文案（标题或集数行）会被改写：两个值都给出，看不出改的是哪一项不算差异。 */
  changed: Array<{ id: string; itemKey: string; from: { title: string; subtitle: string | null }; to: { title: string; subtitle: string | null }; splitIntoKeys: string[]; keepsBindingOnKey: string }>;
  /**
   * 已确认的卡：标题与绑定动不了（`confirmed_by` 的保护规则），应用时只会刷子文件和
   * 集数行——所以这里只报那两样，报标题漂移是噪音（人挑的中文名本来就 ≠ 罗马字猜测）。
   */
  /** `keepsBindingOnKey`：应用后这张卡的绑定跟着哪一份草稿走。劈卡时这是关键 ——
   *  人合并过的卡重新分类会分成两半，绑定只会留在其中一半上（另一半变新卡）。 */
  confirmedDrift: Array<{ id: string; itemKey: string; title: string; subtitle: { from: string | null; to: string | null }; files: { from: number; to: number }; splitIntoKeys: string[]; keepsBindingOnKey: string }>;
  unchanged: number;
  /** 应用后会自动确认的张数（草稿里 status=confirmed 且 confirmed_by=auto）。 */
  autoConfirmed: number;
  draftCards: number;
  formalCards: number;
};

export type CatalogDetail = CatalogCard & {
  /** 卡片对应的分组键。界面要靠它把正式卡和草稿行对上（草稿的身份就是 itemKey）。 */
  itemKey: string;
  confirmedBy: ConfirmedBy | null;
  originalTitle: string | null;
  overview: string | null;
  /**
   * Which subject the card is bound to. The list payload stays lean and omits it,
   * but a person correcting a binding has to be able to see what is bound now -
   * `rebind` takes the same pair, so the round trip is symmetric.
   */
  externalDb: string | null;
  externalId: string | null;
  candidates: Array<{ id: string; title: string; year: number | null; score: number }>;
  children: Array<{
    mediaId: string;
    name: string;
    season: number | null;
    episode: number | null;
    episodeTitle?: string | null;
    /** Library-relative folder the file actually sits in (`第二季`, `SPs`, `爆炸`). */
    relDir: string | null;
    /**
     * Computed from the file name, same rule the browser listing uses, so a
     * catalog card can tell "this episode needs MPV" without a second request.
     */
    compatibility: MediaCompatibility;
  }>;
};

/**
 * A human's answer for one card: the subject they picked themselves, after
 * searching the vendor by hand. `confirm` only accepts a stored candidate, which
 * is dead-ended whenever the scrape never proposed the right one (a trilogy box
 * set, a same-title ambiguity with no year in the folder).
 */
export type ManualBinding = {
  externalDb: MetadataDb;
  externalId: string;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  overview?: string | null;
  imageUrl?: string | null;
};

export type CatalogStore = {
  close(): void;
  getJob(libraryId: string): ScrapeJob | undefined;
  listRunningJobs(): ScrapeJob[];
  markRunning(libraryId: string, reset: boolean): void;
  /** `touchJob=false`：只对齐卡与文件，不碰 scrape_jobs（应用草稿时用它）。 */
  upsertScan(libraryId: string, kind: LibraryKind, groups: CatalogGroup[], touchJob?: boolean): void;
  listPending(libraryId: string): PendingItem[];
  rejectionKeys(libraryId: string, itemKey: string): Set<string>;
  applyMatch(item: PendingItem, status: CatalogStatus, chosen: RankedHit | null, candidates: RankedHit[]): void;
  bumpJob(libraryId: string, matched: boolean): void;
  finishJob(libraryId: string): void;
  failJob(libraryId: string, code: string): void;
  listCards(libraryId: string, cursor: string | undefined, query: string | undefined): { items: CatalogCard[]; hasMore: boolean; nextCursor?: string };
  getDetail(id: string): CatalogDetail | undefined;
  confirm(itemId: string, candidateId: string): { imageUrl: string | null } | undefined;
  reject(itemId: string, candidateId: string): boolean;
  /** 撤销一次确认：卡片退回待判定，绑定清空，文件留在原处。 */
  unconfirm(itemId: string): CatalogDetail | undefined;
  /** 人工直填条目（配合 `/api/media/bangumi/search`），不要求它是刮出来的候选。 */
  rebind(itemId: string, choice: ManualBinding): { imageUrl: string | null } | undefined;
  /** 多张卡并成一张：文件与人工绑定合到 keepId，其余行删除。 */
  mergeItems(keepId: string, dropIds: string[]): CatalogDetail | undefined;
  /** 一张卡按文件拆成多张：首组留在原卡，其余新建待判定卡。 */
  splitItem(itemId: string, groups: string[][]): CatalogDetail[] | undefined;
  /** 只合并「全部由刮削自行确认」的同条目卡；含人工决定的一组整组跳过。 */
  reclusterBySubject(libraryId: string): { merged: number; protectedGroups: number };
  /** 快照：一次枚举的完整文件列表，供离线分类反复跑。 */
  writeScan(libraryId: string, files: ScanFile[]): number;
  /** 人工决定过的目录：分组时不许折叠或删除它们。 */
  protectedKeys(libraryId: string): Set<string>;
  readScan(libraryId: string): ScanFile[];
  scanInfo(libraryId: string): { files: number; enumeratedAt: string | null; rev: number };
  /** 分类落草稿：只读快照、只写 catalog_draft，正式表一行都不动。 */
  writeDraft(libraryId: string, groups: CatalogGroup[]): number;
  readDraft(libraryId: string): CatalogDraftCard[];
  /** 列表投影：与 readDraft 同样的行，但不带 children 与候选（审阅页首屏用）。 */
  draftList(libraryId: string): CatalogDraftRow[];
  /** 展开某一张时才给候选列表。 */
  draftCandidates(libraryId: string, itemKey: string): RankedHit[] | undefined;
  /** 展开某一张草稿卡时才取它的文件。 */
  draftChildren(libraryId: string, itemKey: string): CatalogGroupFile[] | undefined;
  draftInfo(libraryId: string): { cards: number; files: number; classifiedAt: string | null; rev: number; pending: number };
  /** 还没判定过的草稿（判定阶段逐条查条目）。 */
  listPendingDrafts(libraryId: string): DraftSubject[];
  /** 一次判定的结果写回草稿；不碰正式表，也不动 job 计数。 */
  writeDraftJudgment(libraryId: string, itemKey: string, judgment: DraftJudgment): void;
  /** 草稿 vs 正式卡（按文件集合认身份）：应用一步会新增/换绑/改名/删除什么。 */
  draftDiff(libraryId: string): CatalogDraftDiff;
  /** 以下六个只改草稿：正式卡要等 apply，判定不会盖掉人工编辑（confirmed_by=manual）。 */
  draftEdit(libraryId: string, itemKey: string, patch: DraftPatch): boolean;
  /**
   * sidecar / MCP 的元数据写入：字段可覆盖，但人工决定过的行返回 `protected` 不动，
   * 且不会把 `confirmed_by` 冒充成 `manual`。
   */
  draftImport(libraryId: string, itemKey: string, patch: DraftPatch): "ok" | "missing" | "protected";
  draftConfirm(libraryId: string, itemKey: string, choice?: { externalDb: string; externalId: string }): "ok" | "missing" | "no-candidate" | "unknown-candidate";
  draftUnconfirm(libraryId: string, itemKey: string): boolean;
  draftMerge(libraryId: string, keepKey: string, dropKeys: string[]): { error: "missing" | "conflict" | null; keys?: string[] };
  draftSplit(libraryId: string, itemKey: string, keepMediaIds: string[]): { error: "missing" | "invalid" | "unknown-media" | null; created?: string[]; unknown?: string[] };
  /** `fromKey === targetKey` = 复位（不搬），下拉的默认项必须能选回去。 */
  draftCarryBinding(libraryId: string, targetKey: string, fromKey: string): boolean;
  cardIds(libraryId: string): string[];
  /**
   * 把草稿里的判定结论（条目、候选、状态）写到正式卡上。结构对齐由 upsertScan 做完
   * 再调它：身份、保护规则、孤儿行都归那边管，这里只写"这张卡绑哪个条目"。
   * 人已确认过的卡整张跳过。海报不在这里抓，只回列表给调用方。
   */
  applyDraftDecisions(libraryId: string): { updated: number; skipped: number; deferred: number; transferred: number; posters: Array<{ itemId: string; url: string }> };
  /** 库被删掉时清掉它的快照与草稿：这两张表按 library_id 存，外键管不到它们。 */
  forgetLibrary(libraryId: string): { scan: number; draft: number };
  writePoster(itemId: string, contentType: string, bytes: Buffer): void;
  readPoster(itemId: string): { contentType: string; bytes: Buffer } | undefined;
};

const PAGE_SIZE = 100;

export function openCatalogStore(dbPath: string, posterDir: string): CatalogStore {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.mkdirSync(posterDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      query TEXT NOT NULL,
      raw_name TEXT NOT NULL,
      title TEXT NOT NULL,
      original_title TEXT,
      year INTEGER,
      overview TEXT,
      external_db TEXT,
      external_id TEXT,
      status TEXT NOT NULL,
      lookup_state TEXT NOT NULL,
      subtitle TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (library_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS catalog_children (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL,
      name TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      sort_index INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_candidates (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      external_db TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      score REAL NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (item_id, external_db, external_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_rejections (
      library_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      external_db TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (library_id, item_key, external_db, external_id)
    );
    CREATE TABLE IF NOT EXISTS poster_files (
      item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      cache_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      library_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      total INTEGER NOT NULL,
      scanned INTEGER NOT NULL,
      matched INTEGER NOT NULL,
      enumerated INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_scan (
      library_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      media_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enumerated_at TEXT NOT NULL,
      PRIMARY KEY (library_id, rel_path)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_draft (
      library_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      signature TEXT NOT NULL,
      query TEXT NOT NULL,
      raw_name TEXT NOT NULL,
      subtitle TEXT,
      files INTEGER NOT NULL,
      children TEXT NOT NULL,
      enumerated_at TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unmatched',
      lookup_state TEXT NOT NULL DEFAULT 'pending',
      title TEXT,
      original_title TEXT,
      year INTEGER,
      overview TEXT,
      external_db TEXT,
      external_id TEXT,
      confirmed_by TEXT,
      candidates TEXT NOT NULL DEFAULT '[]',
      poster_url TEXT,
      carries_key TEXT,
      PRIMARY KEY (library_id, item_key)
    );
  `);

  const jobStmt = db.prepare("SELECT * FROM scrape_jobs WHERE library_id = ?");
  const runningStmt = db.prepare("SELECT * FROM scrape_jobs WHERE status = 'running' ORDER BY library_id");
  const itemByKey = db.prepare("SELECT * FROM catalog_items WHERE library_id = ? AND item_key = ?");
  const itemsForLibrary = db.prepare("SELECT * FROM catalog_items WHERE library_id = ?");
  const pendingStmt = db.prepare("SELECT * FROM catalog_items WHERE library_id = ? AND lookup_state = 'pending' ORDER BY item_key");
  const itemById = db.prepare("SELECT * FROM catalog_items WHERE id = ?");
  const childrenStmt = db.prepare("SELECT * FROM catalog_children WHERE item_id = ? ORDER BY sort_index");
  const candidatesStmt = db.prepare("SELECT * FROM catalog_candidates WHERE item_id = ? ORDER BY score DESC, title");
  const candidateById = db.prepare("SELECT * FROM catalog_candidates WHERE id = ?");
  const rejectionsStmt = db.prepare("SELECT external_db, external_id FROM catalog_rejections WHERE library_id = ? AND item_key = ?");
  const posterStmt = db.prepare("SELECT * FROM poster_files WHERE item_id = ?");

  function nid(prefix: string): string {
    return `${prefix}_${randomBytes(9).toString("base64url")}`;
  }

  /**
   * `catalog_children.rel_path` on a database that predates it: the item key is
   * the folder the files were grouped from, so key + name rebuilds the path. Rows
   * for loose root files already store the file path as their key. Without this,
   * the first scan after the column exists would find no identity for the cards
   * people had already confirmed and duplicate them.
   */
  function columnExists(table: string, column: string): boolean {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).some((row) => text(row, "name") === column);
  }

  function ensureChildPathsColumn(): void {
    if (columnExists("catalog_children", "rel_path")) return;
    db.exec("ALTER TABLE catalog_children ADD COLUMN rel_path TEXT");
    const rows = db.prepare("SELECT c.id AS id, c.name AS name, i.item_key AS key FROM catalog_children c JOIN catalog_items i ON i.id = c.item_id WHERE c.rel_path IS NULL").all() as Array<Record<string, unknown>>;
    const update = db.prepare("UPDATE catalog_children SET rel_path = ? WHERE id = ?");
    for (const row of rows) {
      const key = text(row, "key");
      const isLooseFile = isVideoFileName(key);
      update.run(isLooseFile ? key : `${key}/${text(row, "name")}`, text(row, "id"));
    }
  }

  ensureChildPathsColumn();

  /**
   * Who decided a binding. Without this the wall cannot tell its own guesses from
   * the user's answers, and one wrong auto-confirm is then indistinguishable from a
   * deliberate pick - which is exactly how a re-scan could legitimately replace
   * three cards that looked hand-made. Existing confirmed rows get `unknown`
   * rather than a flattering guess: unknown is protected like `manual`.
   */
  if (!columnExists("catalog_items", "confirmed_by")) {
    db.exec("ALTER TABLE catalog_items ADD COLUMN confirmed_by TEXT");
    db.exec("UPDATE catalog_items SET confirmed_by = 'unknown' WHERE status = 'confirmed'");
  }

  /**
   * 快照修订号：本地处理（分类 + 判定）可能跑很久，期间网盘可能变。草稿带着它来自
   * 哪一版快照，应用时不匹配就拒——否则上周的分类结果会盖到今天的库上。
   */
  if (!columnExists("catalog_scan", "rev")) {
    db.exec("ALTER TABLE catalog_scan ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
  }
  /**
   * 一张卡一个键位。历史上 upsertScan 的改名会让两张卡写到同一个 item_key（表现为后一个
   * 分组覆盖前一个分组的子文件，静默丢文件），唯一索引让这种写入当场失败。
   * 已有重复键位的旧库跳过：一次数据卫生检查不该把整个应用挡住。
   */
  if (!db.prepare("SELECT 1 hit FROM sqlite_master WHERE type='index' AND name='catalog_items_key_unique'").get()) {
    try {
      db.exec("CREATE UNIQUE INDEX catalog_items_key_unique ON catalog_items (library_id, item_key)");
    } catch {
      /* 库里已有重复键位，留给人工处理 */
    }
  }

  for (const [column, ddl] of [
    ["rev", "rev INTEGER NOT NULL DEFAULT 0"],
    ["status", "status TEXT NOT NULL DEFAULT 'unmatched'"],
    ["lookup_state", "lookup_state TEXT NOT NULL DEFAULT 'pending'"],
    ["title", "title TEXT"],
    ["original_title", "original_title TEXT"],
    ["year", "year INTEGER"],
    ["overview", "overview TEXT"],
    ["external_db", "external_db TEXT"],
    ["external_id", "external_id TEXT"],
    ["confirmed_by", "confirmed_by TEXT"],
    ["candidates", "candidates TEXT NOT NULL DEFAULT '[]'"],
    ["poster_url", "poster_url TEXT"],
    ["carries_key", "carries_key TEXT"],
  ] as const) {
    if (!columnExists("catalog_draft", column)) db.exec(`ALTER TABLE catalog_draft ADD COLUMN ${ddl}`);
  }

  function now(): string {
    return new Date().toISOString();
  }

  function mapJob(row: Record<string, unknown> | undefined): ScrapeJob | undefined {
    if (!row) return undefined;
    const status = text(row, "status");
    return {
      libraryId: text(row, "library_id"),
      status: status === "done" || status === "failed" ? status : "running",
      total: num(row, "total"),
      scanned: num(row, "scanned"),
      matched: num(row, "matched"),
      enumerated: num(row, "enumerated") === 1,
      lastError: text(row, "last_error") || null,
    };
  }

  function replaceChildren(itemId: string, files: CatalogGroupFile[]): void {
    db.prepare("DELETE FROM catalog_children WHERE item_id = ?").run(itemId);
    const insert = db.prepare(
      "INSERT INTO catalog_children (id, item_id, media_id, name, season, episode, sort_index, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    files.forEach((file, index) => {
      insert.run(nid("ch"), itemId, file.mediaId, file.name, file.season, file.episode, index, file.relativePath ?? null);
    });
  }

  /**
   * The card list is keyed by path, but a path is a coincidence of how somebody
   * put files on a drive: one folder can hold three films, and one film can be
   * split across four folders. Once a human has corrected the grouping, the next
   * scan must find that card again by *what it contains*, not by where it was.
   */
  function signatureOf(files: Array<{ mediaId: string; relativePath?: string }>): string {
    return [...new Set(files.map((file) => file.relativePath ?? `id:${file.mediaId}`))].sort().join("|");
  }

  type DraftRecord = {
    itemKey: string;
    query: string;
    rawName: string;
    title: string | null;
    originalTitle: string | null;
    year: number | null;
    overview: string | null;
    externalDb: string | null;
    externalId: string | null;
    posterUrl: string | null;
    confirmedBy: string | null;
    status: string;
    lookupState: string;
    subtitle: string | null;
    files: number;
    rev: number;
    enumeratedAt: string;
    carriesKey: string | null;
    children: CatalogGroupFile[];
    candidates: RankedHit[];
  };

  function readDraftRow(libraryId: string, itemKey: string): DraftRecord | undefined {
    const row = db.prepare("SELECT * FROM catalog_draft WHERE library_id = ? AND item_key = ?").get(libraryId, itemKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      itemKey,
      query: text(row, "query"),
      rawName: text(row, "raw_name"),
      title: typeof row.title === "string" ? row.title : null,
      originalTitle: typeof row.original_title === "string" ? row.original_title : null,
      year: intOrNull(row, "year"),
      overview: typeof row.overview === "string" ? row.overview : null,
      externalDb: typeof row.external_db === "string" ? row.external_db : null,
      externalId: typeof row.external_id === "string" ? row.external_id : null,
      posterUrl: typeof row.poster_url === "string" ? row.poster_url : null,
      confirmedBy: typeof row.confirmed_by === "string" ? row.confirmed_by : null,
      status: text(row, "status") || "unmatched",
      lookupState: typeof row.lookup_state === "string" ? row.lookup_state : "pending",
      subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
      files: Number(row.files),
      rev: Number(row.rev ?? 0),
      enumeratedAt: text(row, "enumerated_at"),
      carriesKey: typeof row.carries_key === "string" ? row.carries_key : null,
      children: JSON.parse(String(row.children ?? "[]")) as CatalogGroupFile[],
      candidates: JSON.parse(String(row.candidates ?? "[]")) as RankedHit[],
    };
  }

  /** 文件集合变了就要重算这三样：它们决定这张卡在扫描后还能不能被认回来。 */
  function writeDraftShape(libraryId: string, itemKey: string, children: CatalogGroupFile[], candidates?: RankedHit[]): void {
    db.prepare("UPDATE catalog_draft SET children = ?, files = ?, signature = ?, subtitle = ?, candidates = ? WHERE library_id = ? AND item_key = ?").run(
      JSON.stringify(children),
      children.length,
      signatureOf(children),
      episodeSubtitle(children, itemKey),
      JSON.stringify(candidates ?? readDraftRow(libraryId, itemKey)?.candidates ?? []),
      libraryId,
      itemKey,
    );
  }

  function dedupeCandidates(candidates: RankedHit[]): RankedHit[] {
    const best = new Map<string, RankedHit>();
    for (const candidate of candidates) {
      const key = `${candidate.externalDb}:${candidate.externalId}`;
      const prior = best.get(key);
      if (!prior || candidate.score > prior.score) best.set(key, candidate);
    }
    return [...best.values()].sort((left, right) => right.score - left.score).slice(0, 5);
  }

  function childrenOf(itemId: string): Array<CatalogGroupFile & { mediaId: string }> {
    // Named columns, prepared per call: a reused `SELECT *` statement was observed to
    // hand back `rel_path` as null on its first read after the rows were written, which
    // silently degraded a card's identity from its paths to its media ids.
    const rows = db
      .prepare("SELECT media_id, name, season, episode, rel_path FROM catalog_children WHERE item_id = ? ORDER BY sort_index")
      .all(itemId) as Array<Record<string, unknown>>;
    return rows.map((child) => ({
      mediaId: text(child, "media_id"),
      name: text(child, "name"),
      season: intOrNull(child, "season"),
      episode: intOrNull(child, "episode"),
      relativePath: text(child, "rel_path") || undefined,
    }));
  }

  /** Renumber, then recompute the sub-line: `rel_path` records which folder each
   * file came from, so the bonus-vs-episode distinction survives a merge or split. */
  function resequence(itemId: string): void {
    const workDir = text((itemById.get(itemId) ?? {}) as Record<string, unknown>, "item_key");
    const ids = (db.prepare("SELECT id FROM catalog_children WHERE item_id = ? ORDER BY sort_index, name").all(itemId) as Array<Record<string, unknown>>).map((row) => text(row, "id"));
    const update = db.prepare("UPDATE catalog_children SET sort_index = ? WHERE id = ?");
    ids.forEach((id, index) => update.run(index, id));
    db.prepare("UPDATE catalog_items SET subtitle = ?, updated_at = ? WHERE id = ?").run(episodeSubtitle(childrenOf(itemId), workDir), now(), itemId);
  }

  /** Shared by the read path and by every mutating endpoint's response. */
  function readDetail(id: string): CatalogDetail | undefined {
    const row = itemById.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const candidates = (candidatesStmt.all(id) as Array<Record<string, unknown>>).map((candidate) => ({
      id: text(candidate, "id"),
      title: text(candidate, "title"),
      year: intOrNull(candidate, "year"),
      score: num(candidate, "score"),
    }));
    const children = childrenOf(id).map((child) => ({
      mediaId: child.mediaId,
      name: child.name,
      season: child.season ?? parseEpisode(child.name).season,
      episode: child.episode ?? parseEpisode(child.name).episode,
      // The folder the file really sits in. Seasons of one show often arrive as
      // sibling folders with no SxxEyy in the names, so this - not a guessed
      // episode number - is what lets the right-hand column say 第二季 vs SPs.
      relDir: child.relativePath ? child.relativePath.replace(/\/[^/]*$/, "") : null,
      compatibility: compatibilityOf(false, extensionOf(child.name)),
    }));
    return {
      ...cardOf(row),
      itemKey: text(row, "item_key"),
      confirmedBy: (text(row, "confirmed_by") || null) as ConfirmedBy | null,
      originalTitle: text(row, "original_title") || null,
      overview: text(row, "overview") || null,
      externalDb: text(row, "external_db") || null,
      externalId: text(row, "external_id") || null,
      candidates,
      children,
    };
  }

  function cardOf(row: Record<string, unknown>): CatalogCard {
    const id = text(row, "id");
    const poster = posterStmt.get(id) as Record<string, unknown> | undefined;
    const status = text(row, "status");
    return {
      id,
      title: text(row, "title"),
      year: intOrNull(row, "year"),
      kind: kindOf(text(row, "kind")),
      status: status === "candidate" || status === "confirmed" || status === "rejected" ? status : "unmatched",
      posterUrl: poster ? `/api/media/posters/${id}` : null,
      subtitle: text(row, "subtitle") || null,
    };
  }

  function mergeInto(keepId: string, dropIds: string[]): CatalogDetail | undefined {
      const keep = itemById.get(keepId) as Record<string, unknown> | undefined;
      if (!keep) return undefined;
      const libraryId = text(keep, "library_id");
      const keepKey = text(keep, "item_key");
      const drops = dropIds
        .filter((id) => id && id !== keepId)
        .map((id) => itemById.get(id) as Record<string, unknown> | undefined)
        .filter((row): row is Record<string, unknown> => Boolean(row) && text(row as Record<string, unknown>, "library_id") === libraryId);
      if (drops.length === 0) return readDetail(keepId);
      db.exec("BEGIN");
      try {
        const keepConfirmed = text(keep, "status") === "confirmed";
        let keepSource = text(keep, "confirmed_by") || null;
        const keepPoster = db.prepare("SELECT cache_path FROM poster_files WHERE item_id = ?").get(keepId) as { cache_path?: string } | undefined;
        let posterTaken = Boolean(keepPoster);
        for (const drop of drops) {
          const dropId = text(drop, "id");
          // A human merging an unconfirmed card onto a confirmed one must not lose
          // the confirmation, whichever card they clicked from.
          if (!keepConfirmed && text(drop, "status") === "confirmed") {
            db.prepare(
              `UPDATE catalog_items
               SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
                   status = 'confirmed', lookup_state = 'done', confirmed_by = ?
               WHERE id = ?`,
            ).run(text(drop, "title"), text(drop, "original_title") || null, intOrNull(drop, "year"), text(drop, "overview") || null, text(drop, "external_db"), text(drop, "external_id"), text(drop, "confirmed_by") || "unknown", keepId);
          }
          db.prepare("UPDATE catalog_children SET item_id = ? WHERE item_id = ?").run(keepId, dropId);
          const carried = db.prepare("SELECT external_db, external_id FROM catalog_candidates WHERE item_id = ?").all(dropId) as Array<Record<string, unknown>>;
          const clash = db.prepare("SELECT 1 hit FROM catalog_candidates WHERE item_id = ? AND external_db = ? AND external_id = ?");
          const adopt = db.prepare("UPDATE catalog_candidates SET item_id = ? WHERE item_id = ? AND external_db = ? AND external_id = ?");
          for (const candidate of carried) {
            if (!clash.get(keepId, text(candidate, "external_db"), text(candidate, "external_id"))) {
              adopt.run(keepId, dropId, text(candidate, "external_db"), text(candidate, "external_id"));
            }
          }
          db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(dropId);
          const dropPoster = db.prepare("SELECT cache_path FROM poster_files WHERE item_id = ?").get(dropId) as { cache_path?: string } | undefined;
          if (dropPoster) {
            if (!posterTaken) {
              db.prepare("UPDATE poster_files SET item_id = ? WHERE item_id = ?").run(keepId, dropId);
              posterTaken = true;
            } else {
              db.prepare("DELETE FROM poster_files WHERE item_id = ?").run(dropId);
              if (dropPoster.cache_path && dropPoster.cache_path !== keepPoster?.cache_path) fs.rmSync(dropPoster.cache_path, { force: true });
            }
          }
          db.prepare(
            `INSERT OR IGNORE INTO catalog_rejections (library_id, item_key, external_db, external_id)
             SELECT ?, ?, external_db, external_id FROM catalog_rejections WHERE library_id = ? AND item_key = ?`,
          ).run(libraryId, keepKey, libraryId, text(drop, "item_key"));
          db.prepare("DELETE FROM catalog_rejections WHERE library_id = ? AND item_key = ?").run(libraryId, text(drop, "item_key"));
          // Merging must not launder a human answer into an automatable one:
          // `auto` is the only source the re-scan and re-cluster may rewrite.
          const dropSource = text(drop, "confirmed_by") || "unknown";
          if (text(drop, "status") === "confirmed" && keepSource === "auto" && dropSource !== "auto") keepSource = dropSource;
          db.prepare("DELETE FROM catalog_items WHERE id = ?").run(dropId);
        }
        if (keepSource && keepSource !== (text(keep, "confirmed_by") || null)) {
          db.prepare("UPDATE catalog_items SET confirmed_by = ? WHERE id = ?").run(keepSource, keepId);
        }
        db.prepare("UPDATE catalog_items SET updated_at = ? WHERE id = ?").run(now(), keepId);
        resequence(keepId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return readDetail(keepId);
  }

  return {
    close() {
      db.close();
    },
    getJob(libraryId) {
      return mapJob(jobStmt.get(libraryId) as Record<string, unknown> | undefined);
    },
    listRunningJobs() {
      return (runningStmt.all() as Array<Record<string, unknown>>).flatMap((row) => {
        const job = mapJob(row);
        return job ? [job] : [];
      });
    },
    markRunning(libraryId, reset) {
      const existing = jobStmt.get(libraryId) as Record<string, unknown> | undefined;
      if (!existing) {
        db.prepare(
          "INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at) VALUES (?, 'running', 0, 0, 0, 0, NULL, ?)",
        ).run(libraryId, now());
        return;
      }
      if (reset) {
        db.prepare(
          "UPDATE scrape_jobs SET status = 'running', total = 0, scanned = 0, matched = 0, enumerated = 0, last_error = NULL, updated_at = ? WHERE library_id = ?",
        ).run(now(), libraryId);
        return;
      }
      db.prepare("UPDATE scrape_jobs SET status = 'running', last_error = NULL, updated_at = ? WHERE library_id = ?").run(now(), libraryId);
    },
    upsertScan(libraryId, kind, groups, touchJob = true) {
      const existing = itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>;
      const byKey = new Map(existing.map((row) => [text(row, "item_key"), row]));
      // Second chance at identity: a card the human merged or split no longer sits
      // at the folder path the grouper would produce, but the set of files in it is
      // still unique. Match on that before creating a new card, or every re-scan
      // would undo the correction.
      const bySignature = new Map<string, Record<string, unknown>>();
      for (const row of existing) {
        const signature = signatureOf(childrenOf(text(row, "id")));
        if (signature) bySignature.set(signature, row);
      }
      const seen = new Set<string>();
      const kept = new Set<string>();
      db.exec("BEGIN");
      try {
        for (const group of groups) {
          seen.add(group.itemKey);
          const subtitle = episodeSubtitle(group.files, group.itemKey);
          const signature = signatureOf(group.files);
          // A card already claimed by an earlier group is off the table: after a rename
          // the map still holds its *old* key, and claiming it twice makes the second
          // group overwrite the first one's children - which silently deletes a file.
          let row = byKey.get(group.itemKey);
          if (row && kept.has(text(row, "id"))) row = undefined;
          row ??= bySignature.get(signature);
          if (row) {
            const id = text(row, "id");
            kept.add(id);
            bySignature.delete(signature);
            if (text(row, "item_key") !== group.itemKey) {
              const previousKey = text(row, "item_key");
              db.prepare("UPDATE catalog_items SET item_key = ? WHERE id = ?").run(group.itemKey, id);
              byKey.delete(previousKey);
              row = { ...row, item_key: group.itemKey };
              byKey.set(group.itemKey, row);
            }
          }
          if (row && text(row, "status") === "confirmed") {
            replaceChildren(text(row, "id"), group.files);
            // A confirmed row keeps its title and binding - but `subtitle` is derived
            // from the files, and the files just changed (fold, bonus folder). Not
            // refreshing it leaves a card saying "58 集" for a 28-episode show.
            db.prepare("UPDATE catalog_items SET subtitle = ?, updated_at = ? WHERE id = ?").run(subtitle, now(), text(row, "id"));
            continue;
          }
          const id = row ? text(row, "id") : nid("cat");
          if (!row) {
            db.prepare(
              `INSERT INTO catalog_items (
                id, library_id, item_key, kind, query, raw_name, title, original_title, year, overview,
                external_db, external_id, status, lookup_state, subtitle, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'unmatched', 'pending', ?, ?)`,
            ).run(id, libraryId, group.itemKey, kind, group.query, group.rawName, group.query, subtitle, now());
          } else {
            db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(id);
            db.prepare("DELETE FROM poster_files WHERE item_id = ?").run(id);
            db.prepare(
              `UPDATE catalog_items
               SET kind = ?, query = ?, raw_name = ?, title = ?, original_title = NULL, year = NULL, overview = NULL,
                   external_db = NULL, external_id = NULL, status = 'unmatched', lookup_state = 'pending', subtitle = ?, updated_at = ?
               WHERE id = ?`,
            ).run(kind, group.query, group.rawName, group.query, subtitle, now(), id);
          }
          replaceChildren(id, group.files);
        }
        for (const row of existing) {
          const id = text(row, "id");
          // `kept` matters: a card reused under a new key still holds its old
          // `item_key` in this pre-update snapshot, so the key test alone would
          // delete the very card we just moved.
          if (kept.has(id) || seen.has(text(row, "item_key"))) continue;
          if (text(row, "status") !== "confirmed") {
            db.prepare("DELETE FROM catalog_items WHERE id = ?").run(id);
            continue;
          }
          // A confirmed card whose folder no longer groups on its own (a bonus
          // subfolder folded into the work card) would otherwise linger as an orphan
          // holding files that now live elsewhere. Only the machine's own answers
          // may be dropped this way; anything a person touched stays.
          if (text(row, "confirmed_by") === "auto") db.prepare("DELETE FROM catalog_items WHERE id = ?").run(id);
        }
        const confirmed = (itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>).filter((row) => text(row, "status") === "confirmed").length;
        if (touchJob) {
          db.prepare(
            `INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at)
             VALUES (?, 'running', ?, ?, ?, 1, NULL, ?)
             ON CONFLICT(library_id) DO UPDATE SET
               status = 'running', total = excluded.total, scanned = excluded.scanned, matched = excluded.matched,
               enumerated = 1, last_error = NULL, updated_at = excluded.updated_at`,
          ).run(libraryId, groups.length, confirmed, confirmed, now());
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listPending(libraryId) {
      return (pendingStmt.all(libraryId) as Array<Record<string, unknown>>).map((row) => {
        const children = childrenStmt.all(text(row, "id")) as Array<Record<string, unknown>>;
        return {
          id: text(row, "id"),
          libraryId: text(row, "library_id"),
          itemKey: text(row, "item_key"),
          kind: kindOf(text(row, "kind")),
          query: text(row, "query"),
          rawName: text(row, "raw_name"),
          subtitle: text(row, "subtitle") || null,
          fileCount: children.length,
          fileNames: children.map((child) => text(child, "name")),
        };
      });
    },
    rejectionKeys(libraryId, itemKey) {
      const rows = rejectionsStmt.all(libraryId, itemKey) as Array<Record<string, unknown>>;
      return new Set(rows.map((row) => `${text(row, "external_db")}:${text(row, "external_id")}`));
    },
    applyMatch(item, status, chosen, candidates) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(item.id);
        const insert = db.prepare(
          "INSERT INTO catalog_candidates (id, item_id, external_db, external_id, title, year, score, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const candidate of candidates) {
          insert.run(
            nid("cand"),
            item.id,
            candidate.externalDb,
            candidate.externalId,
            candidate.title,
            candidate.year,
            candidate.score,
            JSON.stringify({
              imageUrl: candidate.imageUrl,
              overview: candidate.overview,
              originalTitle: candidate.originalTitle,
            }),
          );
        }
        const picked = status === "confirmed" ? chosen : null;
        db.prepare(
          `UPDATE catalog_items
           SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
               status = ?, lookup_state = 'done', confirmed_by = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          picked?.title ?? item.query,
          picked?.originalTitle ?? null,
          picked?.year ?? null,
          picked?.overview ?? null,
          picked?.externalDb ?? null,
          picked?.externalId ?? null,
          status,
          picked ? "auto" : null,
          now(),
          item.id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    bumpJob(libraryId, matched) {
      db.prepare(
        "UPDATE scrape_jobs SET scanned = scanned + 1, matched = matched + ?, updated_at = ? WHERE library_id = ?",
      ).run(matched ? 1 : 0, now(), libraryId);
    },
    finishJob(libraryId) {
      // Recompute from the rows instead of trusting the increments: a recluster
      // after the lookups merges cards away, and a drifting counter on the wall is
      // worse than a slightly later one.
      const rows = itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>;
      const confirmed = rows.filter((row) => text(row, "status") === "confirmed").length;
      db.prepare(
        "UPDATE scrape_jobs SET status = 'done', total = ?, scanned = ?, matched = ?, enumerated = 1, last_error = NULL, updated_at = ? WHERE library_id = ?",
      ).run(rows.length, rows.length, confirmed, now(), libraryId);
    },
    failJob(libraryId, code) {
      const existing = jobStmt.get(libraryId) as Record<string, unknown> | undefined;
      if (!existing) {
        db.prepare(
          "INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at) VALUES (?, 'failed', 0, 0, 0, 0, ?, ?)",
        ).run(libraryId, code, now());
        return;
      }
      db.prepare("UPDATE scrape_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE library_id = ?").run(code, now(), libraryId);
    },
    listCards(libraryId, cursor, query) {
      const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const like = query?.trim() ? `%${query.trim().replace(/[\\%_]/g, "")}%` : null;
      const rows = (
        like
          ? db.prepare(
              "SELECT * FROM catalog_items WHERE library_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY title, id",
            ).all(libraryId, like)
          : db.prepare("SELECT * FROM catalog_items WHERE library_id = ? ORDER BY title, id").all(libraryId)
      ) as Array<Record<string, unknown>>;
      if (!Number.isSafeInteger(start) || start < 0 || start > rows.length) {
        throw new Error("Invalid cursor");
      }
      const slice = rows.slice(start, start + PAGE_SIZE);
      const end = start + slice.length;
      return {
        items: slice.map(cardOf),
        hasMore: end < rows.length,
        ...(end < rows.length ? { nextCursor: String(end) } : {}),
      };
    },
    getDetail(id) {
      return readDetail(id);
    },
    confirm(itemId, candidateId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      const candidate = candidateById.get(candidateId) as Record<string, unknown> | undefined;
      if (!item || !candidate || text(candidate, "item_id") !== itemId) return undefined;
      const payload = parsePayload(text(candidate, "payload"));
      db.prepare(
        `UPDATE catalog_items
         SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
             status = 'confirmed', lookup_state = 'done', confirmed_by = 'manual', updated_at = ?
         WHERE id = ?`,
      ).run(
        text(candidate, "title"),
        payload.originalTitle,
        intOrNull(candidate, "year"),
        payload.overview,
        text(candidate, "external_db"),
        text(candidate, "external_id"),
        now(),
        itemId,
      );
      return { imageUrl: payload.imageUrl };
    },
    reject(itemId, candidateId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      const candidate = candidateById.get(candidateId) as Record<string, unknown> | undefined;
      if (!item || !candidate || text(candidate, "item_id") !== itemId) return false;
      db.prepare(
        "INSERT OR IGNORE INTO catalog_rejections (library_id, item_key, external_db, external_id) VALUES (?, ?, ?, ?)",
      ).run(text(item, "library_id"), text(item, "item_key"), text(candidate, "external_db"), text(candidate, "external_id"));
      db.prepare("DELETE FROM catalog_candidates WHERE id = ?").run(candidateId);
      const remaining = (candidatesStmt.all(itemId) as unknown[]).length;
      const rejectedThis =
        text(item, "external_db") === text(candidate, "external_db") && text(item, "external_id") === text(candidate, "external_id");
      if (rejectedThis || text(item, "status") === "confirmed") {
        db.prepare(
          `UPDATE catalog_items
           SET status = ?, external_db = NULL, external_id = NULL, original_title = NULL, overview = NULL, year = NULL,
               title = query, lookup_state = 'done', updated_at = ?
           WHERE id = ?`,
        ).run(remaining > 0 ? "candidate" : "unmatched", now(), itemId);
      } else if (remaining === 0) {
        db.prepare("UPDATE catalog_items SET status = 'unmatched', updated_at = ? WHERE id = ?").run(now(), itemId);
      }
      return true;
    },
    unconfirm(itemId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      db.prepare(
        `UPDATE catalog_items
         SET status = 'unmatched', external_db = NULL, external_id = NULL, original_title = NULL, year = NULL,
             overview = NULL, title = query, lookup_state = 'pending', confirmed_by = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now(), itemId);
      return readDetail(itemId);
    },
    rebind(itemId, choice) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      db.prepare(
        `UPDATE catalog_items
         SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
             status = 'confirmed', lookup_state = 'done', confirmed_by = 'rebind', updated_at = ?
         WHERE id = ?`,
      ).run(
        choice.title,
        choice.originalTitle ?? null,
        choice.year ?? null,
        choice.overview ?? null,
        choice.externalDb,
        choice.externalId,
        now(),
        itemId,
      );
      return { imageUrl: choice.imageUrl ?? null };
    },
    mergeItems(keepId, dropIds) {
      return mergeInto(keepId, dropIds);
    },
    splitItem(itemId, groups) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      const libraryId = text(item, "library_id");
      const mine = childrenOf(itemId);
      const known = new Map(mine.map((file) => [file.mediaId, file]));
      const cleaned = groups
        .map((group) => [...new Set(group)].filter((mediaId) => known.has(mediaId)))
        .filter((group) => group.length > 0);
      if (cleaned.length < 2) return undefined;
      const claimed = new Set(cleaned.flat());
      const leftover = mine.map((file) => file.mediaId).filter((mediaId) => !claimed.has(mediaId));
      const batches = leftover.length > 0 ? [cleaned[0], leftover, ...cleaned.slice(1)] : [cleaned[0], ...cleaned.slice(1)];
      const created: string[] = [];
      db.exec("BEGIN");
      try {
        const insertItem = db.prepare(
          `INSERT INTO catalog_items (
             id, library_id, item_key, kind, query, raw_name, title, original_title, year, overview,
             external_db, external_id, status, lookup_state, subtitle, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'unmatched', 'pending', NULL, ?)`,
        );
        const move = db.prepare("UPDATE catalog_children SET item_id = ? WHERE item_id = ? AND media_id = ?");
        for (const batch of batches.slice(1)) {
          const id = nid("cat");
          const names = batch.map((mediaId) => known.get(mediaId)?.name ?? "");
          const query = titleCandidates(names, "")[0] ?? text(item, "query");
          // A split card has no folder of its own any more, so its key is synthetic;
          // the scan finds it again by media set, not by path.
          insertItem.run(id, libraryId, `#split/${id}`, text(item, "kind"), query, names[0] ?? "", query, now());
          for (const mediaId of batch) move.run(id, itemId, mediaId);
          created.push(id);
        }
        resequence(itemId);
        for (const id of created) resequence(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [readDetail(itemId), ...created.map(readDetail)].filter((detail): detail is CatalogDetail => Boolean(detail));
    },
    writeScan(libraryId, files) {
      db.exec("BEGIN");
      try {
        const next = ((db.prepare("SELECT COALESCE(MAX(rev), 0) rev FROM catalog_scan WHERE library_id = ?").get(libraryId) as { rev: number }).rev ?? 0) + 1;
        db.prepare("DELETE FROM catalog_scan WHERE library_id = ?").run(libraryId);
        const insert = db.prepare("INSERT OR IGNORE INTO catalog_scan (library_id, rel_path, media_id, name, enumerated_at, rev) VALUES (?, ?, ?, ?, ?, ?)");
        const stamp = now();
        for (const file of files) insert.run(libraryId, file.relativePath, file.mediaId, file.name, stamp, next);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return (db.prepare("SELECT COUNT(*) n FROM catalog_scan WHERE library_id = ?").get(libraryId) as { n: number }).n;
    },
    protectedKeys(libraryId) {
      const rows = db
        .prepare("SELECT item_key FROM catalog_items WHERE library_id = ? AND status = 'confirmed' AND COALESCE(confirmed_by, 'unknown') <> 'auto'")
        .all(libraryId) as Array<Record<string, unknown>>;
      return new Set(rows.map((row) => text(row, "item_key")));
    },
    readScan(libraryId) {
      return (db.prepare("SELECT rel_path, name, media_id FROM catalog_scan WHERE library_id = ? ORDER BY rel_path").all(libraryId) as Array<Record<string, unknown>>).map((row) => ({
        relativePath: text(row, "rel_path"),
        name: text(row, "name"),
        mediaId: text(row, "media_id"),
      }));
    },
    scanInfo(libraryId) {
      const row = db.prepare("SELECT COUNT(*) files, MAX(enumerated_at) at, MAX(rev) rev FROM catalog_scan WHERE library_id = ?").get(libraryId) as { files: number; at: string | null; rev: number | null };
      return { files: row.files, enumeratedAt: row.at ?? null, rev: row.rev ?? 0 };
    },
    writeDraft(libraryId, groups) {
      const stamp = now();
      const scan = db.prepare("SELECT MAX(enumerated_at) at, MAX(rev) rev FROM catalog_scan WHERE library_id = ?").get(libraryId) as { at: string | null; rev: number | null };
      const enumerated = scan.at ?? stamp;
      const rev = scan.rev ?? 0;
      db.exec("BEGIN");
      try {
        // Drafts are disposable by definition: replace the whole set, never merge into
        // it, or a folder that disappeared would keep proposing a card forever.
        db.prepare("DELETE FROM catalog_draft WHERE library_id = ?").run(libraryId);
        const insert = db.prepare(
          "INSERT INTO catalog_draft (library_id, item_key, signature, query, raw_name, subtitle, files, children, enumerated_at, classified_at, rev, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const group of groups) {
          insert.run(
            libraryId,
            group.itemKey,
            signatureOf(group.files),
            group.query,
            group.rawName,
            episodeSubtitle(group.files, group.itemKey),
            group.files.length,
            JSON.stringify(group.files),
            enumerated,
            stamp,
            rev,
            group.query,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return (db.prepare("SELECT COUNT(*) n FROM catalog_draft WHERE library_id = ?").get(libraryId) as { n: number }).n;
    },
    draftList(libraryId) {
      // Same rows as readDraft without `children` *or* `candidates`: a wall of 64 cards
      // is 700 KB with paths and 88 KB with candidate lists, and the list view needs
      // neither - only the two numbers it sorts and filters by.
      return (db.prepare("SELECT item_key, query, raw_name, subtitle, files, rev, status, lookup_state, title, original_title, year, overview, external_db, external_id, confirmed_by, poster_url, carries_key, candidates FROM catalog_draft WHERE library_id = ? ORDER BY files DESC, item_key").all(libraryId) as Array<Record<string, unknown>>).map((row) => {
        const candidates = JSON.parse(String(row.candidates ?? "[]")) as RankedHit[];
        return {
          itemKey: text(row, "item_key"),
          query: text(row, "query"),
          rawName: text(row, "raw_name"),
          subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
          files: Number(row.files),
          rev: Number(row.rev ?? 0),
          status: (text(row, "status") || "unmatched") as CatalogStatus,
          lookupState: (text(row, "lookup_state") === "done" ? "done" : "pending") as "pending" | "done",
          title: typeof row.title === "string" ? row.title : null,
          originalTitle: typeof row.original_title === "string" ? row.original_title : null,
          year: intOrNull(row, "year"),
          overview: typeof row.overview === "string" ? row.overview : null,
          externalDb: typeof row.external_db === "string" ? row.external_db : null,
          externalId: typeof row.external_id === "string" ? row.external_id : null,
          confirmedBy: (typeof row.confirmed_by === "string" ? row.confirmed_by : null) as ConfirmedBy | null,
          posterUrl: typeof row.poster_url === "string" ? row.poster_url : null,
          carriesKey: typeof row.carries_key === "string" ? row.carries_key : null,
          topScore: candidates.length > 0 ? Math.max(...candidates.map((candidate) => candidate.score)) : null,
          candidateCount: candidates.length,
        };
      });
    },
    draftCandidates(libraryId, itemKey) {
      const row = db.prepare("SELECT candidates FROM catalog_draft WHERE library_id = ? AND item_key = ?").get(libraryId, itemKey) as Record<string, unknown> | undefined;
      return row ? (JSON.parse(String(row.candidates ?? "[]")) as RankedHit[]) : undefined;
    },
    draftChildren(libraryId, itemKey) {
      const row = db.prepare("SELECT children FROM catalog_draft WHERE library_id = ? AND item_key = ?").get(libraryId, itemKey) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return JSON.parse(String(row.children ?? "[]")) as CatalogGroupFile[];
    },
    readDraft(libraryId) {
      return (db.prepare("SELECT * FROM catalog_draft WHERE library_id = ? ORDER BY item_key").all(libraryId) as Array<Record<string, unknown>>).map((row) => ({
        itemKey: text(row, "item_key"),
        query: text(row, "query"),
        rawName: text(row, "raw_name"),
        subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
        files: Number(row.files),
        children: JSON.parse(String(row.children)) as CatalogGroupFile[],
        rev: Number(row.rev ?? 0),
        status: (text(row, "status") || "unmatched") as CatalogStatus,
        lookupState: (text(row, "lookup_state") === "done" ? "done" : "pending") as "pending" | "done",
        title: typeof row.title === "string" ? row.title : null,
        originalTitle: typeof row.original_title === "string" ? row.original_title : null,
        year: intOrNull(row, "year"),
        overview: typeof row.overview === "string" ? row.overview : null,
        externalDb: typeof row.external_db === "string" ? row.external_db : null,
        externalId: typeof row.external_id === "string" ? row.external_id : null,
        confirmedBy: (typeof row.confirmed_by === "string" ? row.confirmed_by : null) as ConfirmedBy | null,
        posterUrl: typeof row.poster_url === "string" ? row.poster_url : null,
        carriesKey: typeof row.carries_key === "string" ? row.carries_key : null,
        candidates: JSON.parse(String(row.candidates ?? "[]")) as RankedHit[],
      }));
    },
    draftInfo(libraryId) {
      const row = db
        .prepare("SELECT COUNT(*) cards, COALESCE(SUM(files), 0) files, MAX(classified_at) at, MAX(rev) rev, SUM(lookup_state = 'pending') pending FROM catalog_draft WHERE library_id = ?")
        .get(libraryId) as { cards: number; files: number; at: string | null; rev: number | null; pending: number | null };
      return { cards: row.cards, files: row.files, classifiedAt: row.at ?? null, rev: row.rev ?? 0, pending: row.pending ?? 0 };
    },
    listPendingDrafts(libraryId) {
      return (db.prepare("SELECT item_key, query, raw_name, children FROM catalog_draft WHERE library_id = ? AND lookup_state = 'pending' ORDER BY files DESC, item_key").all(libraryId) as Array<
        Record<string, unknown>
      >).map((row) => {
        const children = JSON.parse(String(row.children ?? "[]")) as CatalogGroupFile[];
        return {
          itemKey: text(row, "item_key"),
          query: text(row, "query"),
          rawName: text(row, "raw_name"),
          fileNames: children.map((child) => child.name),
          fileCount: children.length,
        };
      });
    },
    writeDraftJudgment(libraryId, itemKey, judgment) {
      const chosen = judgment.chosen ?? null;
      db.prepare(
        `UPDATE catalog_draft
         SET status = ?, lookup_state = 'done', candidates = ?,
             title = COALESCE(?, title), original_title = ?, year = ?, overview = ?,
             external_db = ?, external_id = ?, confirmed_by = ?, poster_url = ?
         WHERE library_id = ? AND item_key = ?`,
      ).run(
        judgment.status,
        JSON.stringify(judgment.candidates),
        chosen?.title ?? null,
        chosen?.originalTitle ?? null,
        chosen?.year ?? null,
        chosen?.overview ?? null,
        chosen?.externalDb ?? null,
        chosen?.externalId ?? null,
        chosen ? "auto" : null,
        judgment.posterUrl ?? chosen?.imageUrl ?? null,
        libraryId,
        itemKey,
      );
    },
    draftDiff(libraryId) {
      const drafts = (db.prepare("SELECT item_key, signature, query, title, subtitle, files, status, confirmed_by, carries_key, children FROM catalog_draft WHERE library_id = ? ORDER BY item_key").all(libraryId) as Array<Record<string, unknown>>).map(
        (row) => ({
          itemKey: text(row, "item_key"),
          signature: text(row, "signature"),
          query: text(row, "query"),
          // 判定过后草稿的"标题"是条目名，没判定过才用查询词。
          title: typeof row.title === "string" ? row.title : text(row, "query"),
          subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
          files: Number(row.files),
          paths: (JSON.parse(String(row.children ?? "[]")) as CatalogGroupFile[]).map((file) => file.relativePath ?? `id:${file.mediaId}`),
          carriesKey: typeof row.carries_key === "string" ? row.carries_key : null,
          autoConfirmed: text(row, "status") === "confirmed" && text(row, "confirmed_by") === "auto",
        }),
      );
      const formal = itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>;
      const draftByKey = new Map(drafts.map((draft) => [draft.itemKey, draft]));
      const draftBySignature = new Map(drafts.map((draft) => [draft.signature, draft]));
      // 权威配对：一个文件今天在哪张卡上，就说明"新卡是从那张卡劈出来的"。
      // 让前端靠"文件数相同 / 标题互为包含"去猜，猜错比不提示更糟。
      const owner = new Map<string, string>();
      const childrenByCard = new Map<string, Array<CatalogGroupFile & { mediaId: string }>>();
      for (const row of formal) {
        const children = childrenOf(text(row, "id"));
        childrenByCard.set(text(row, "id"), children);
        for (const child of children) {
          const filePath = child.relativePath ?? `id:${child.mediaId}`;
          if (!owner.has(filePath)) owner.set(filePath, text(row, "item_key"));
        }
      }
      const ownerCounts = new Map<string, Array<[string, number]>>();
      for (const draft of drafts) {
        const counts = new Map<string, number>();
        for (const filePath of draft.paths) {
          const holder = owner.get(filePath);
          if (holder) counts.set(holder, (counts.get(holder) ?? 0) + 1);
        }
        ownerCounts.set(draft.itemKey, [...counts.entries()].sort((a, b) => b[1] - a[1]));
      }
      const diff: CatalogDraftDiff = { added: [], dropped: [], moved: [], changed: [], confirmedDrift: [], unchanged: 0, autoConfirmed: 0, draftCards: drafts.length, formalCards: formal.length };
      const matchedDrafts = new Set<string>();
      for (const row of formal) {
        const id = text(row, "id");
        const itemKey = text(row, "item_key");
        const title = text(row, "title");
        const subtitle = typeof row.subtitle === "string" ? row.subtitle : null;
        const confirmed = text(row, "status") === "confirmed";
        const children = childrenByCard.get(id) ?? [];
        const signature = signatureOf(children);
        const draft = (signature ? draftBySignature.get(signature) : undefined) ?? draftByKey.get(itemKey);
        if (!draft) {
          diff.dropped.push({ id, itemKey, title, files: children.length });
          continue;
        }
        matchedDrafts.add(draft.itemKey);
        if (draft.autoConfirmed) diff.autoConfirmed += 1;
        if (draft.itemKey !== itemKey) {
          diff.moved.push({ id, itemKey: draft.itemKey, fromKey: itemKey, files: draft.files });
        }
        // 这张卡的文件被别的草稿卡接走了多少 ⇒ 应用后它会"变小/被劈开"。
        const cardPaths = new Set(children.map((child) => child.relativePath ?? `id:${child.mediaId}`));
        const splitIntoKeys = drafts.filter((other) => other.itemKey !== draft.itemKey && other.paths.some((filePath) => cardPaths.has(filePath))).map((other) => other.itemKey);
        // 人可以为某张正式卡指定"绑定跟着哪一份草稿走"（劈卡时两半都想留住名字）。
        const carrier = drafts.find((other) => other.carriesKey === itemKey);
        const keepsBindingOnKey = carrier?.itemKey ?? draft.itemKey;
        if (confirmed) {
          if (draft.subtitle === subtitle && draft.files === children.length) {
            diff.unchanged += 1;
            continue;
          }
          diff.confirmedDrift.push({ id, itemKey, title, subtitle: { from: subtitle, to: draft.subtitle }, files: { from: children.length, to: draft.files }, splitIntoKeys, keepsBindingOnKey });
          continue;
        }
        if (draft.title === title && draft.subtitle === subtitle) {
          diff.unchanged += 1;
          continue;
        }
        diff.changed.push({ id, itemKey: draft.itemKey, from: { title, subtitle }, to: { title: draft.title, subtitle: draft.subtitle }, splitIntoKeys, keepsBindingOnKey });
      }
      for (const draft of drafts) {
        if (!matchedDrafts.has(draft.itemKey)) {
          if (draft.autoConfirmed) diff.autoConfirmed += 1;
          const sources = ownerCounts.get(draft.itemKey) ?? [];
          diff.added.push({ itemKey: draft.itemKey, query: draft.title, files: draft.files, splitFromKey: sources[0]?.[0] ?? null, fromFiles: sources[0]?.[1] ?? 0 });
        }
      }
      return diff;
    },
    forgetLibrary(libraryId) {
      db.exec("BEGIN");
      try {
        const scan = db.prepare("DELETE FROM catalog_scan WHERE library_id = ?").run(libraryId) as { changes?: number };
        const draft = db.prepare("DELETE FROM catalog_draft WHERE library_id = ?").run(libraryId) as { changes?: number };
        db.exec("COMMIT");
        return { scan: Number(scan.changes ?? 0), draft: Number(draft.changes ?? 0) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    cardIds(libraryId) {
      return (itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>).map((row) => text(row, "id"));
    },
    draftEdit(libraryId, itemKey, patch) {
      const row = readDraftRow(libraryId, itemKey);
      if (!row) return false;
      const externalDb = patch.externalDb === undefined ? row.externalDb : patch.externalDb;
      const externalId = patch.externalId === undefined ? row.externalId : patch.externalId;
      db.prepare(
        `UPDATE catalog_draft
         SET title = ?, original_title = COALESCE(?, original_title), year = COALESCE(?, year),
             overview = COALESCE(?, overview), poster_url = COALESCE(?, poster_url),
             external_db = ?, external_id = ?, status = ?, confirmed_by = 'manual', lookup_state = 'done'
         WHERE library_id = ? AND item_key = ?`,
      ).run(
        patch.title ?? row.title ?? row.query,
        patch.originalTitle ?? null,
        patch.year ?? null,
        patch.overview ?? null,
        patch.posterUrl ?? null,
        externalDb,
        externalId,
        externalId ? "confirmed" : "candidate",
        libraryId,
        itemKey,
      );
      return true;
    },
    draftImport(libraryId, itemKey, patch) {
      const row = readDraftRow(libraryId, itemKey);
      if (!row) return "missing" as const;
      if (row.confirmedBy === "manual" || row.confirmedBy === "rebind" || row.confirmedBy === "unknown") return "protected" as const;
      const externalDb = patch.externalDb === undefined ? row.externalDb : patch.externalDb;
      const externalId = patch.externalId === undefined ? row.externalId : patch.externalId;
      const bound = Boolean(externalId);
      // 导入不是人的决定：confirmed_by 保持原样（null/auto），否则下一次重扫就再也
      // 改不动这行，界面也会把它显示成"人工已确认"。
      db.prepare(
        `UPDATE catalog_draft
         SET title = ?, original_title = COALESCE(?, original_title), year = COALESCE(?, year),
             overview = COALESCE(?, overview), poster_url = COALESCE(?, poster_url),
             external_db = ?, external_id = ?, status = ?, lookup_state = ?
         WHERE library_id = ? AND item_key = ?`,
      ).run(
        patch.title ?? row.title ?? row.query,
        patch.originalTitle ?? null,
        patch.year ?? null,
        patch.overview ?? null,
        patch.posterUrl ?? null,
        externalDb,
        externalId,
        bound ? "confirmed" : row.status,
        bound ? "done" : row.lookupState,
        libraryId,
        itemKey,
      );
      return "ok" as const;
    },
    draftConfirm(libraryId, itemKey, choice) {
      const row = readDraftRow(libraryId, itemKey);
      if (!row) return "missing" as const;
      const hit = choice
        ? row.candidates.find((candidate) => candidate.externalDb === choice.externalDb && candidate.externalId === choice.externalId)
        : row.candidates[0];
      if (!hit) return row.candidates.length > 0 ? ("unknown-candidate" as const) : ("no-candidate" as const);
      db.prepare(
        `UPDATE catalog_draft
         SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
             poster_url = ?, status = 'confirmed', confirmed_by = 'manual', lookup_state = 'done'
         WHERE library_id = ? AND item_key = ?`,
      ).run(hit.title, hit.originalTitle, hit.year, hit.overview, hit.externalDb, hit.externalId, hit.imageUrl ?? null, libraryId, itemKey);
      return "ok" as const;
    },
    draftUnconfirm(libraryId, itemKey) {
      const row = readDraftRow(libraryId, itemKey);
      if (!row) return false;
      // 只撤"人确认过"这件事：条目和名字留着，重新确认是一键的事。正式卡的 unconfirm
      // 会把绑定清空打回 unmatched，草稿不该那样。
      db.prepare("UPDATE catalog_draft SET status = ?, confirmed_by = NULL, lookup_state = 'done' WHERE library_id = ? AND item_key = ?").run(
        row.candidates.length > 0 ? "candidate" : "unmatched",
        libraryId,
        itemKey,
      );
      return true;
    },
    draftMerge(libraryId, keepKey, dropKeys) {
      const keep = readDraftRow(libraryId, keepKey);
      if (!keep) return { error: "missing" as const };
      const drops = dropKeys.map((key) => readDraftRow(libraryId, key));
      if (drops.some((row) => !row)) return { error: "missing" as const };
      const conflicts = dropKeys.filter((key, index) => {
        const by = drops[index]?.confirmedBy;
        return by === "manual" || by === "rebind" || by === "unknown";
      });
      if (conflicts.length > 0) return { error: "conflict" as const, keys: conflicts };
      db.exec("BEGIN");
      try {
        const seen = new Set(keep.children.map((file) => file.relativePath ?? `id:${file.mediaId}`));
        const children = [...keep.children];
        for (const drop of drops) for (const file of drop?.children ?? []) {
          const key = file.relativePath ?? `id:${file.mediaId}`;
          if (!seen.has(key)) {
            seen.add(key);
            children.push(file);
          }
        }
        children.sort((left, right) => String(left.relativePath ?? left.mediaId).localeCompare(String(right.relativePath ?? right.mediaId), undefined, { numeric: true }));
        const candidates = dedupeCandidates([...keep.candidates, ...drops.flatMap((drop) => drop?.candidates ?? [])]);
        writeDraftShape(libraryId, keepKey, children, candidates);
        for (const key of dropKeys) db.prepare("DELETE FROM catalog_draft WHERE library_id = ? AND item_key = ?").run(libraryId, key);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { error: null };
    },
    draftSplit(libraryId, itemKey, keepMediaIds) {
      const row = readDraftRow(libraryId, itemKey);
      if (!row) return { error: "missing" as const };
      const wanted = new Set(keepMediaIds);
      const owned = new Set(row.children.map((file) => file.mediaId));
      const unknown = keepMediaIds.filter((mediaId) => !owned.has(mediaId));
      if (unknown.length > 0) return { error: "unknown-media" as const, unknown };
      const kept = row.children.filter((file) => wanted.has(file.mediaId));
      const rest = row.children.filter((file) => !wanted.has(file.mediaId));
      if (kept.length === 0 || rest.length === 0) return { error: "invalid" as const };
      const created: string[] = [];
      db.exec("BEGIN");
      try {
        writeDraftShape(libraryId, itemKey, kept, row.candidates);
        const byFolder = new Map<string, CatalogGroupFile[]>();
        for (const file of rest) {
          const dir = path.posix.dirname(String(file.relativePath ?? "/"));
          byFolder.set(dir, [...(byFolder.get(dir) ?? []), file]);
        }
        for (const [dir, files] of byFolder) {
          // 拆出来的这批可能还住在同一个目录里，那时目录名会撞回原键位 —— 用与正式卡
          // 拆分相同的 `#split/` 合成键，扫描时靠文件集合把它认回来。
          const newKey = dir === itemKey ? `#split/${nid("cat")}` : dir;
          const names = files.map((file) => file.name);
          const query = titleCandidates(names, path.posix.basename(newKey))[0] ?? cleanTitle(names[0] ?? newKey);
          db.prepare(
            `INSERT INTO catalog_draft (library_id, item_key, signature, query, raw_name, subtitle, files, children,
                                        enumerated_at, classified_at, rev, title, status, lookup_state, candidates)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', 'pending', '[]')`,
          ).run(
            libraryId,
            newKey,
            signatureOf(files),
            query,
            path.posix.basename(newKey),
            episodeSubtitle(files, newKey),
            files.length,
            JSON.stringify(files),
            row.enumeratedAt,
            now(),
            row.rev,
            query,
          );
          created.push(newKey);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { error: null, created };
    },
    draftCarryBinding(libraryId, targetKey, fromKey) {
      const target = readDraftRow(libraryId, targetKey);
      if (!target) return false;
      db.exec("BEGIN");
      try {
        // 复位：选回自己 = 不搬。之前这里当非法处理，导致下拉的默认项点不动。
        if (targetKey === fromKey) {
          db.prepare("UPDATE catalog_draft SET carries_key = NULL WHERE library_id = ? AND item_key = ?").run(libraryId, targetKey);
          db.exec("COMMIT");
          return true;
        }
        const source = readDraftRow(libraryId, fromKey);
        if (!source) return false;
        // 反向已经指过来时先清掉，否则两行互指成环，apply 时谁也不动。
        if (source.carriesKey === targetKey) {
          db.prepare("UPDATE catalog_draft SET carries_key = NULL WHERE library_id = ? AND item_key = ?").run(libraryId, fromKey);
        }
        db.prepare("UPDATE catalog_draft SET carries_key = NULL WHERE library_id = ? AND carries_key = ?").run(libraryId, fromKey);
        db.prepare("UPDATE catalog_draft SET carries_key = ?, confirmed_by = 'manual', lookup_state = 'done' WHERE library_id = ? AND item_key = ?").run(fromKey, libraryId, targetKey);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return true;
    },
    applyDraftDecisions(libraryId) {
      const rows = db
        .prepare(
          `SELECT item_key, query, title, original_title, year, overview, external_db, external_id,
                  status, lookup_state, candidates, poster_url, carries_key
           FROM catalog_draft WHERE library_id = ? ORDER BY item_key`,
        )
        .all(libraryId) as Array<Record<string, unknown>>;
      let updated = 0;
      let skipped = 0;
      let deferred = 0;
      let transferred = 0;
      const posters: Array<{ itemId: string; url: string }> = [];
      db.exec("BEGIN");
      try {
        for (const draft of rows) {
          const card = itemByKey.get(libraryId, text(draft, "item_key")) as Record<string, unknown> | undefined;
          if (!card) continue;
          const id = text(card, "id");
          // 没判定过的草稿不是"判过且不匹配"：它只参与结构对齐，绑定留给卡上现有的值。
          // 少了这一条，分批跑（Bangumi 匿名限速）会把上一轮已确认的卡打回未匹配。
          if (text(draft, "lookup_state") !== "done") {
            deferred += 1;
            continue;
          }
          // 人的答案优先，整张跳过：绑定、候选列表都不动。
          if (text(card, "status") === "confirmed" && (text(card, "confirmed_by") || "unknown") !== "auto") {
            skipped += 1;
            continue;
          }
          const candidates = JSON.parse(String(draft.candidates ?? "[]")) as RankedHit[];
          const confirmed = text(draft, "status") === "confirmed" && Boolean(text(draft, "external_id"));
          db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(id);
          const insert = db.prepare(
            "INSERT INTO catalog_candidates (id, item_id, external_db, external_id, title, year, score, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const candidate of candidates) {
            insert.run(
              nid("cand"),
              id,
              candidate.externalDb,
              candidate.externalId,
              candidate.title,
              candidate.year,
              candidate.score,
              JSON.stringify({ imageUrl: candidate.imageUrl, overview: candidate.overview, originalTitle: candidate.originalTitle }),
            );
          }
          db.prepare(
            `UPDATE catalog_items
             SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
                 status = ?, lookup_state = 'done', confirmed_by = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            confirmed ? text(draft, "title") || text(draft, "query") : text(draft, "query"),
            confirmed ? (typeof draft.original_title === "string" ? draft.original_title : null) : null,
            confirmed ? intOrNull(draft, "year") : null,
            confirmed ? (typeof draft.overview === "string" ? draft.overview : null) : null,
            confirmed ? text(draft, "external_db") : null,
            confirmed ? text(draft, "external_id") : null,
            confirmed ? "confirmed" : text(draft, "status") === "candidate" ? "candidate" : "unmatched",
            confirmed ? "auto" : null,
            now(),
            id,
          );
          updated += 1;
          const posterUrl = typeof draft.poster_url === "string" ? draft.poster_url : "";
          if (confirmed && posterUrl && !posterStmt.get(id)) posters.push({ itemId: id, url: posterUrl });
        }
        // 绑定承接：人指定"这张正式卡的绑定改由另一份草稿承接"（劈卡时选跟哪一半）。
        // 结构对齐与判定都已经落定，这里只搬绑定，且绝不覆盖目标上的人工答案。
        for (const draft of rows) {
          const fromKey = typeof draft.carries_key === "string" ? draft.carries_key : "";
          if (!fromKey || fromKey === text(draft, "item_key")) continue;
          const target = itemByKey.get(libraryId, text(draft, "item_key")) as Record<string, unknown> | undefined;
          const source = itemByKey.get(libraryId, fromKey) as Record<string, unknown> | undefined;
          if (!target || !source || text(source, "status") !== "confirmed") continue;
          if (["manual", "rebind", "unknown"].includes(text(target, "confirmed_by"))) continue;
          db.prepare(
            `UPDATE catalog_items
             SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
                 status = 'confirmed', lookup_state = 'done', confirmed_by = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            text(source, "title"),
            typeof source.original_title === "string" ? source.original_title : null,
            intOrNull(source, "year"),
            typeof source.overview === "string" ? source.overview : null,
            typeof source.external_db === "string" ? source.external_db : null,
            typeof source.external_id === "string" ? source.external_id : null,
            text(source, "confirmed_by") || "unknown",
            now(),
            text(target, "id"),
          );
          db.prepare(
            `UPDATE catalog_items
             SET title = query, original_title = NULL, year = NULL, overview = NULL, external_db = NULL, external_id = NULL,
                 status = 'unmatched', lookup_state = 'done', confirmed_by = NULL, updated_at = ?
             WHERE id = ?`,
          ).run(now(), text(source, "id"));
          transferred += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { updated, skipped, deferred, transferred, posters };
    },
    reclusterBySubject(libraryId) {
      const bound = db
        .prepare(
          `SELECT id, external_db, external_id, confirmed_by,
                  (SELECT COUNT(*) FROM catalog_children c WHERE c.item_id = i.id) files
           FROM catalog_items i
           WHERE library_id = ? AND status = 'confirmed' AND external_id IS NOT NULL
           ORDER BY files DESC`,
        )
        .all(libraryId) as Array<Record<string, unknown>>;
      const bySubject = new Map<string, string[]>();
      const sources = new Map<string, string>();
      for (const row of bound) {
        const subject = `${text(row, "external_db")}:${text(row, "external_id")}`;
        bySubject.set(subject, [...(bySubject.get(subject) ?? []), text(row, "id")]);
        sources.set(text(row, "id"), text(row, "confirmed_by") || "unknown");
      }
      let merged = 0;
      let protectedGroups = 0;
      for (const [, ids] of bySubject) {
        if (ids.length < 2) continue;
        // One human decision in the group is enough to stop: the folders may be
        // separate on purpose, and the wall must not second-guess a person.
        if (ids.some((id) => sources.get(id) !== "auto")) {
          protectedGroups += 1;
          continue;
        }
        // `files DESC` above makes the first id the fullest card, so the card that
        // survives is the one with the most episodes on it.
        if (mergeInto(ids[0], ids.slice(1))) merged += 1;
      }
      return { merged, protectedGroups };
    },
    writePoster(itemId, contentType, bytes) {
      const cachePath = path.join(posterDir, itemId);
      fs.writeFileSync(cachePath, bytes);
      db.prepare(
        `INSERT INTO poster_files (item_id, content_type, cache_path, byte_size) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET content_type = excluded.content_type, cache_path = excluded.cache_path, byte_size = excluded.byte_size`,
      ).run(itemId, contentType, cachePath, bytes.length);
    },
    readPoster(itemId) {
      const row = posterStmt.get(itemId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const cachePath = text(row, "cache_path");
      const root = path.resolve(posterDir);
      const resolved = path.resolve(cachePath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
      if (!fs.existsSync(resolved)) return undefined;
      return { contentType: text(row, "content_type"), bytes: fs.readFileSync(resolved) };
    },
  };
}

function parsePayload(value: string): { imageUrl: string | null; overview: string | null; originalTitle: string | null } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl : null,
      overview: typeof parsed.overview === "string" ? parsed.overview : null,
      originalTitle: typeof parsed.originalTitle === "string" ? parsed.originalTitle : null,
    };
  } catch {
    return { imageUrl: null, overview: null, originalTitle: null };
  }
}

function kindOf(value: string): LibraryKind {
  if (value === "anime" || value === "movie" || value === "tv" || value === "other") return value;
  return "other";
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

function intOrNull(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}
