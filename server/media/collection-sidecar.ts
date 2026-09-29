import fs from "node:fs";
import path from "node:path";
import type { ScanFile } from "./catalog-names.ts";

/**
 * WatchParty 自有 collection sidecar（`.watchparty.collection.json`）。
 *
 * 为什么不复用 Kodi/Emby 的 NFO：那边一个目录只能表达一个作品，而我们的卡片身份是
 * **文件集合**（合并/拆分后一个目录可以住好几张卡，一张卡也可以跨目录）。sidecar 要能
 * 原样写出这两种形状，否则导出→导入一轮就把结构压回去了。
 *
 * `mediaId` 故意不进 schema：它由 `WATCHPARTY_MEDIA_ID_KEY` HMAC 得出，密钥没钉时每进程
 * 都不一样，跨进程文件就成了另一个作品。定位一律走库内相对路径 + 文件集合。
 */

export const COLLECTION_SCHEMA_VERSION = 1;
/** 目录里唯一一份时文件名是 `.watchparty.collection.json`（前面只剩点）。 */
export const COLLECTION_SUFFIX = "watchparty.collection.json";

export type CollectionRole = "episode" | "bonus" | "other";

export type CollectionMember = {
  /** 相对 `basePath` 的路径；跨目录的作品写库内完整相对路径（以 `/` 开头）。 */
  path: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  role: CollectionRole;
  /** 导出那一刻库里报的字节数；null = 谁都不知道（旧快照没存 size 就是这个）。 */
  size: number | null;
};

export type CollectionSidecar = {
  schemaVersion: number;
  collectionId: string;
  libraryId: string | null;
  /** 库的展示名，只给人看；匹配不用它（见 `resolveMemberPaths`）。 */
  root: string | null;
  /** 集合所在目录的库内相对路径，`/` 开头；跨目录集合取公共前缀。 */
  basePath: string;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  poster: string | null;
  externalDb: string | null;
  externalId: string | null;
  members: CollectionMember[];
  /** sidecar 文件在 sidecar 根下的位置，用于报错与对账清单。 */
  sourceFile: string;
};

export type SidecarErrorCode =
  | "invalid-json"
  | "not-an-object"
  | "schema-version"
  | "members-required"
  | "member-path-required"
  | "member-path-unsafe"
  | "member-path-duplicate"
  | "base-path-unsafe"
  | "external-pair"
  | "bad-year"
  | "bad-role";

export type SidecarError = { code: SidecarErrorCode; message: string };

export type CollectionParse = {
  sourceFile: string;
  sidecar: CollectionSidecar | null;
  errors: SidecarError[];
  warnings: string[];
};

const EXTERNAL_DBS = new Set(["bangumi", "tmdb", "imdb", "tvdb"]);
const ROLES = new Set<CollectionRole>(["episode", "bonus", "other"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

function optionalYear(value: unknown): { year: number | null; error: SidecarError | null } {
  if (value === undefined || value === null || value === "") return { year: null, error: null };
  const n = intOrNull(value);
  if (Number.isNaN(n) || n === null || n < 1870 || n > 2100) return { year: null, error: { code: "bad-year", message: `year 不是 1870-2100 的整数：${JSON.stringify(value)}` } };
  return { year: n, error: null };
}

/**
 * 把 `basePath` + 成员路径拼成库内相对路径（与 `catalog_scan.rel_path` 同形：`/` 开头、无
 * `.`/`..`、无重复斜杠）。`..` 直接判非法：sidecar 是外部输入，不能让它指到库外去。
 */
export function collectionPath(basePath: string, raw: string): string | null {
  const trimmed = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  const joined = trimmed.startsWith("/") ? trimmed : `${basePath}/${trimmed}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? `/${segments.join("/")}` : null;
}

/** 去掉库内路径开头那一层（`root` 只是展示名，有些工具会把它写进路径里）。 */
function withoutLeadingSegment(relPath: string): string | null {
  const index = relPath.indexOf("/", 1);
  return index <= 1 ? null : relPath.slice(index);
}

export function collectionFileId(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || "collection";
}

/** 一个目录里的段名清洗：数据库里的 itemKey 来自网盘列表，不能直接当本地路径用。 */
export function safeSegments(relPath: string): string[] {
  return String(relPath ?? "")
    .split("/")
    .filter((raw) => raw !== "" && raw !== ".")
    .map((segment) => collectionFileId(segment))
    .filter((segment) => segment !== "..");
}

export function parseCollection(sourceFile: string, content: string): CollectionParse {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { sourceFile, sidecar: null, errors: [{ code: "invalid-json", message: "不是合法 JSON" }], warnings };
  }
  const record = asRecord(parsed);
  if (!record) return { sourceFile, sidecar: null, errors: [{ code: "not-an-object", message: "顶层必须是对象" }], warnings };
  const errors: SidecarError[] = [];
  const version = intOrNull(record.schemaVersion);
  if (version !== COLLECTION_SCHEMA_VERSION) {
    errors.push({ code: "schema-version", message: `schemaVersion 只支持 ${COLLECTION_SCHEMA_VERSION}，读到 ${JSON.stringify(record.schemaVersion)}` });
  }
  const rawMembers = Array.isArray(record.members) ? record.members : null;
  if (!rawMembers) errors.push({ code: "members-required", message: "members 必须是非空数组" });

  const basePathValue = str(record.basePath, 800) ?? "/";
  // 库根本身是合法的 basePath，但它规范化后是空串，所以先放行。
  const resolvedBase = basePathValue === "/" ? "/" : collectionPath("/", basePathValue);
  if (!resolvedBase) errors.push({ code: "base-path-unsafe", message: `basePath 无法落在库内：${basePathValue}` });
  const basePath = resolvedBase ?? "/";
  const seen = new Set<string>();
  const members: CollectionMember[] = [];
  for (const entry of rawMembers ?? []) {
    const item = asRecord(entry);
    const rawPath = item ? str(item.path, 900) : null;
    if (!rawPath) {
      errors.push({ code: "member-path-required", message: "members[].path 必填" });
      continue;
    }
    const relPath = collectionPath(basePath, rawPath);
    if (!relPath) {
      errors.push({ code: "member-path-unsafe", message: `members[].path 无法落在库内：${rawPath}` });
      continue;
    }
    if (seen.has(relPath)) {
      errors.push({ code: "member-path-duplicate", message: `同一个文件被列了两次：${relPath}` });
      continue;
    }
    seen.add(relPath);
    const rawRole = item ? str(item.role, 16)?.toLowerCase() : null;
    let role: CollectionRole = "other";
    if (rawRole) {
      if (ROLES.has(rawRole as CollectionRole)) role = rawRole as CollectionRole;
      else errors.push({ code: "bad-role", message: `role 只认 episode/bonus/other，读到 ${rawRole}` });
    }
    const season = item ? intOrNull(item.season) : null;
    const episode = item ? intOrNull(item.episode) : null;
    const declared = item ? intOrNull(item.size) : null;
    if (item?.size !== undefined && item?.size !== null && (declared === null || Number.isNaN(declared) || declared < 0)) warnings.push(`bad-size:${rawPath}`);
    if (item?.season !== undefined && item?.season !== null && Number.isNaN(season)) warnings.push(`bad-season:${rawPath}`);
    if (item?.episode !== undefined && item?.episode !== null && Number.isNaN(episode)) warnings.push(`bad-episode:${rawPath}`);
    members.push({
      path: rawPath,
      season: Number.isNaN(season) ? null : season,
      episode: Number.isNaN(episode) ? null : episode,
      title: item ? str(item.title, 200) : null,
      role,
      size: declared !== null && !Number.isNaN(declared) && declared >= 0 ? declared : null,
    });
  }
  if (rawMembers && members.length === 0) errors.push({ code: "members-required", message: "没有一条 members 可用" });

  const external = asRecord(record.external);
  let externalDb = str(external?.db, 24)?.toLowerCase() ?? null;
  let externalId = str(external?.id, 32) ?? null;
  if (externalDb && !EXTERNAL_DBS.has(externalDb)) externalDb = null;
  if (Boolean(externalDb) !== Boolean(externalId)) {
    errors.push({ code: "external-pair", message: "external.db 与 external.id 必须同时给出" });
    externalDb = null;
    externalId = null;
  }
  const year = optionalYear(record.year);
  if (year.error) errors.push(year.error);
  const collectionId = str(record.collectionId, 80) ?? collectionFileId(path.posix.basename(basePath));
  return {
    sourceFile,
    sidecar: {
      schemaVersion: COLLECTION_SCHEMA_VERSION,
      collectionId,
      libraryId: str(record.libraryId, 80),
      root: str(record.root, 120),
      basePath,
      title: str(record.title, 160),
      originalTitle: str(record.originalTitle, 160),
      year: year.year,
      overview: str(record.overview, 4000),
      poster: str(record.poster, 1000),
      externalDb,
      externalId,
      members,
      sourceFile,
    },
    errors,
    warnings,
  };
}

/** 成员解析成库内相对路径；顺序即文件集合的顺序（去重后）。 */
export function resolveMemberPaths(sidecar: CollectionSidecar): { paths: string[]; unsafe: string[] } {
  const paths: string[] = [];
  const unsafe: string[] = [];
  const seen = new Set<string>();
  for (const member of sidecar.members) {
    const relPath = collectionPath(sidecar.basePath, member.path);
    if (!relPath) {
      unsafe.push(member.path);
      continue;
    }
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    paths.push(relPath);
  }
  return { paths, unsafe };
}

export type SizeMismatch = { relPath: string; declared: number; actual: number };

export type CollectionShape = {
  sourceFile: string;
  sidecar: CollectionSidecar;
  paths: string[];
  missing: string[];
  unsafe: string[];
  /** 同名同路径但字节数对不上：内容已经不是导出时那份了。 */
  sizeMismatch: SizeMismatch[];
  /** 有多少个成员根本没法比（sidecar 没写 size，或快照那侧没存 size）。 */
  sizeUnchecked: number;
};

export type ReconcileResult = {
  shapes: CollectionShape[];
  /** 同一个库内文件被两个集合认领：谁都不许动，等人裁决。 */
  ambiguous: Array<{ relPath: string; sourceFiles: string[] }>;
  /** sidecar 目录下没被任何集合认领的快照文件（说明这套 sidecar 不完整）。 */
  unlisted: Array<{ relPath: string; under: string }>;
  /** size 校验的整体状况：比过几处、几处对不上、几处没法比。 */
  sizeChecks: { compared: number; mismatched: number; unchecked: number };
  errors: Array<{ sourceFile: string; errors: SidecarError[]; warnings: string[] }>;
  scannedFiles: number;
};

/**
 * sidecar ↔ 快照对账。四分类 matched / missing / unlisted / ambiguous 就是这里的
 * `shapes[].paths` / `missing` / `unlisted` / `ambiguous`。
 */
export function reconcileCollections(collections: CollectionSidecar[], scan: ScanFile[]): ReconcileResult {
  const index = new Map<string, ScanFile>();
  for (const file of scan) index.set(file.relativePath, file);
  const shapes: CollectionShape[] = [];
  const errors: Array<{ sourceFile: string; errors: SidecarError[]; warnings: string[] }> = [];
  const claims = new Map<string, string[]>();
  const touchedDirs = new Set<string>();
  for (const sidecar of collections) {
    if (sidecar.libraryId && !sidecar.libraryId.startsWith("lib_")) errors.push({ sourceFile: sidecar.sourceFile, errors: [], warnings: ["library-id-shape"] });
    const { paths, unsafe } = resolveMemberPaths(sidecar);
    const kept: string[] = [];
    const missing: string[] = [];
    const sizeMismatch: SizeMismatch[] = [];
    let sizeUnchecked = 0;
    for (const relPath of paths) {
      // 带 root 前缀的写法（`/Anime/作品/x.mkv`）在快照里对不上时，去掉那一层再试一次。
      if (index.has(relPath)) kept.push(relPath);
      else {
        const stripped = withoutLeadingSegment(relPath);
        if (stripped && index.has(stripped)) kept.push(stripped);
        else missing.push(relPath);
      }
    }
    const declaredByPath = new Map(sidecar.members.map((member) => [collectionPath(sidecar.basePath, member.path), member.size]));
    for (const relPath of kept) {
      claims.set(relPath, [...(claims.get(relPath) ?? []), sidecar.sourceFile]);
      touchedDirs.add(path.posix.dirname(relPath));
      const declaredSize = declaredByPath.get(relPath) ?? null;
      const actual = index.get(relPath)?.size;
      if (declaredSize === null || actual === undefined || actual === null) {
        sizeUnchecked += 1;
        continue;
      }
      if (declaredSize !== actual) sizeMismatch.push({ relPath, declared: declaredSize, actual });
    }
    touchedDirs.add(sidecar.basePath);
    shapes.push({ sourceFile: sidecar.sourceFile, sidecar, paths: kept, missing, unsafe, sizeMismatch, sizeUnchecked });
  }
  const ambiguous: Array<{ relPath: string; sourceFiles: string[] }> = [];
  for (const [relPath, sourceFiles] of claims) {
    if (sourceFiles.length > 1) ambiguous.push({ relPath, sourceFiles });
  }
  ambiguous.sort((left, right) => left.relPath.localeCompare(right.relPath));
  const unlisted: Array<{ relPath: string; under: string }> = [];
  for (const file of scan) {
    if (claims.has(file.relativePath)) continue;
    for (const dir of touchedDirs) {
      if (dir === "/" || file.relativePath.startsWith(`${dir}/`)) {
        unlisted.push({ relPath: file.relativePath, under: dir });
        break;
      }
    }
  }
  unlisted.sort((left, right) => left.relPath.localeCompare(right.relPath));
  const sizeChecks = shapes.reduce(
    (total, shape) => ({
      compared: total.compared + shape.paths.length - shape.sizeUnchecked,
      mismatched: total.mismatched + shape.sizeMismatch.length,
      unchecked: total.unchecked + shape.sizeUnchecked,
    }),
    { compared: 0, mismatched: 0, unchecked: 0 },
  );
  return { shapes, ambiguous, unlisted, errors, sizeChecks, scannedFiles: scan.length };
}

/** 草稿卡的文件集合形状（路径身份），用来判断一个集合落在哪张卡上。 */
export type DraftShape = { itemKey: string; paths: string[]; confirmedBy: string | null };

export type Placement =
  /** 与某张草稿卡的文件集合完全一致：只写元数据。 */
  | { kind: "metadata"; sourceFile: string; itemKey: string }
  /** 集合是某张卡的**真子集**：多出来的文件要拆走（`draftSplit` 的入参在这里给全）。 */
  | { kind: "split"; sourceFile: string; itemKey: string; extraPaths: string[] }
  /** 集合横跨多张卡：先合（`draftMerge`）。 */
  | { kind: "merge"; sourceFile: string; itemKey: string; dropKeys: string[] }
  /** 一张卡都没沾上：是新作品，建卡属结构变更。 */
  | { kind: "new"; sourceFile: string }
  /** 对不上或对不清：只报冲突，不动草稿。 */
  | { kind: "conflict"; sourceFile: string; reason: string; paths?: string[] };

/**
 * 集合 → 草稿卡的落点。归属靠**文件集合**，不靠 itemKey 或外部 ID：那两个都会因合并/
 * 拆分而变，而 sidecar 表达的正是"这一堆文件是一部作品"。
 */
export function classifyPlacements(shapes: CollectionShape[], cards: DraftShape[]): Placement[] {
  const owner = new Map<string, string[]>();
  for (const card of cards) for (const relPath of card.paths) owner.set(relPath, [...(owner.get(relPath) ?? []), card.itemKey]);
  const out: Placement[] = [];
  for (const shape of shapes) {
    if (shape.unsafe.length > 0) {
      out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: "unsafe-path", paths: shape.unsafe });
      continue;
    }
    if (shape.paths.length === 0) {
      out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: shape.missing.length > 0 ? "all-missing" : "no-members", paths: shape.missing });
      continue;
    }
    if (shape.missing.length > 0) {
      out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: "missing-files", paths: shape.missing });
      continue;
    }
    // 字节数对不上 = 内容已经换了一份，谁旧谁新判不出来：不写，交人看。
    // 反过来，两边都没 size 时不算不符（只算没查），这点必须分清楚。
    if (shape.sizeMismatch.length > 0) {
      out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: "size-mismatch", paths: shape.sizeMismatch.map((row) => row.relPath) });
      continue;
    }
    const members = shape.paths;
    const hitKeys = [...new Set(members.flatMap((relPath) => owner.get(relPath) ?? []))];
    const contained = cards.filter((card) => card.paths.length === members.length && card.paths.every((relPath) => members.includes(relPath)));
    if (contained.length === 1) {
      out.push({ kind: "metadata", sourceFile: shape.sourceFile, itemKey: contained[0]!.itemKey });
      continue;
    }
    if (contained.length > 1) {
      out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: "duplicate-cards", paths: contained.map((card) => card.itemKey) });
      continue;
    }
    if (hitKeys.length === 0) {
      out.push({ kind: "new", sourceFile: shape.sourceFile });
      continue;
    }
    if (hitKeys.length === 1) {
      const card = cards.find((entry) => entry.itemKey === hitKeys[0])!;
      const keep = new Set(members);
      const extra = card.paths.filter((relPath) => !keep.has(relPath));
      if (extra.length === 0) {
        out.push({ kind: "conflict", sourceFile: shape.sourceFile, reason: "unknown-cards", paths: hitKeys });
        continue;
      }
      out.push({ kind: "split", sourceFile: shape.sourceFile, itemKey: card.itemKey, extraPaths: extra });
      continue;
    }
    // 横跨多张卡时，保住文件最多的那张当 keepKey：它最可能是人已经在看的那张。
    const ranked = hitKeys
      .map((key) => ({ key, count: cards.find((card) => card.itemKey === key)?.paths.filter((relPath) => members.includes(relPath)).length ?? 0 }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
    out.push({ kind: "merge", sourceFile: shape.sourceFile, itemKey: ranked[0]!.key, dropKeys: ranked.slice(1).map((entry) => entry.key) });
  }
  return out;
}

export type CollectionSource = {
  itemKey: string;
  /** 库内相对路径 → 当前快照报的字节数，导出时按这个填 `members[].size`。 */
  sizeByPath?: Map<string, number | null>;
  children: Array<{ relativePath?: string; name: string; season: number | null; episode: number | null; bonus?: boolean; mediaId?: string }>;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalDb: string | null;
  externalId: string | null;
};

function commonDir(paths: string[]): string {
  if (paths.length === 0) return "/";
  const segments = paths.map((relPath) => relPath.split("/"));
  const first = segments[0]!;
  const shared: string[] = [];
  for (let depth = 0; depth < first.length - 1; depth += 1) {
    const segment = first[depth];
    if (segments.every((entry) => entry[depth] === segment)) shared.push(String(segment));
    else break;
  }
  return shared.length > 0 ? shared.join("/") : "/";
}

/** 从一张草稿卡（或正式卡）导出一份 sidecar。 */
export function buildCollection(libraryId: string, root: string | null, source: CollectionSource): CollectionSidecar {
  const real = source.children.map((child) => child.relativePath).filter((value): value is string => Boolean(value));
  const basePath = commonDir(real);
  const members: CollectionMember[] = source.children.map((child) => {
    const relPath = child.relativePath ?? `id:${child.mediaId ?? child.name}`;
    const underBase = basePath !== "/" && relPath.startsWith(`${basePath}/`);
    return {
      // 同目录只写文件名，跨目录写完整库内相对路径（文档 §3.4）。
      path: underBase ? relPath.slice(basePath.length + 1) : relPath,
      season: child.season,
      episode: child.episode,
      title: null,
      role: child.bonus ? "bonus" : child.season !== null && child.episode !== null ? "episode" : "other",
      size: source.sizeByPath?.get(relPath) ?? null,
    };
  });
  return {
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    collectionId: collectionFileId(basePath === "/" ? source.itemKey : path.posix.basename(basePath)),
    libraryId,
    root,
    basePath,
    title: source.title ?? null,
    originalTitle: source.originalTitle ?? null,
    year: source.year,
    overview: source.overview,
    poster: source.posterUrl,
    externalDb: source.externalDb,
    externalId: source.externalId,
    members,
    sourceFile: "",
  };
}

/** 键序固定，导出文件才可以直接 diff。 */
export function collectionJson(sidecar: CollectionSidecar): string {
  return `${JSON.stringify(
    {
      schemaVersion: sidecar.schemaVersion,
      collectionId: sidecar.collectionId,
      libraryId: sidecar.libraryId,
      root: sidecar.root,
      basePath: sidecar.basePath,
      title: sidecar.title,
      originalTitle: sidecar.originalTitle,
      year: sidecar.year,
      overview: sidecar.overview,
      poster: sidecar.poster,
      external: { db: sidecar.externalDb, id: sidecar.externalId },
      members: sidecar.members.map((member) => ({
        path: member.path,
        ...(member.season === null ? {} : { season: member.season }),
        ...(member.episode === null ? {} : { episode: member.episode }),
        ...(member.title === null ? {} : { title: member.title }),
        ...(member.size === null ? {} : { size: member.size }),
        role: member.role,
      })),
    },
    null,
    2,
  )}\n`;
}

/** sidecar 文件在磁盘上的位置：`<root>/<libraryId>/<basePath>/<name>.watchparty.collection.json`。 */
export function collectionFileName(sidecarsInDir: number, index: number, collectionId: string): string {
  return sidecarsInDir === 1 ? `.${COLLECTION_SUFFIX}` : `${collectionFileId(collectionId)}-${index + 1}.${COLLECTION_SUFFIX}`;
}

export function collectionDiskPath(sidecarRoot: string, libraryId: string, sidecar: CollectionSidecar, fileName: string): string {
  const segments = safeSegments(sidecar.basePath);
  return path.join(sidecarRoot, safeSegments(libraryId).join("/"), ...segments, fileName);
}

/** 读一个 sidecar 根目录（`data/catalog-sidecars/<libraryId>`）。目录不存在 = 还没有输入。 */
export type CollectionRead = {
  collections: CollectionSidecar[];
  errors: Array<{ sourceFile: string; errors: SidecarError[]; warnings: string[] }>;
  files: number;
};

/** 读一个目录树：`prefix` 只用来在报错里说清这份文件是从哪一根读的。 */
export function readCollectionDir(dir: string, prefix = ""): CollectionRead {
  const collections: CollectionSidecar[] = [];
  const errors: CollectionRead["errors"] = [];
  const found = fs.existsSync(dir) ? walk(dir) : [];
  for (const filePath of found.sort()) {
    const relative = `${prefix}${path.relative(dir, filePath).split(path.sep).join("/")}`;
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      errors.push({ sourceFile: relative, errors: [{ code: "invalid-json", message: "读不到文件" }], warnings: [] });
      continue;
    }
    const parsed = parseCollection(relative, content);
    if (parsed.sidecar && parsed.errors.length === 0) collections.push(parsed.sidecar);
    else errors.push({ sourceFile: relative, errors: parsed.errors, warnings: parsed.warnings });
  }
  return { collections, errors, files: found.length };
}

/** 规范来源：服务端本地根目录，按库分一层。导出只往这里写。 */
export function collectionRootFor(sidecarRoot: string, libraryId: string): string {
  return path.join(sidecarRoot, ...safeSegments(libraryId));
}

export function readCollectionRoot(sidecarRoot: string, libraryId: string): CollectionRead {
  return readCollectionDir(collectionRootFor(sidecarRoot, libraryId));
}

/**
 * 开发期的旁挂来源：镜像目录里那一层就是库内相对路径（`<mirror>/<作品名>/.watchparty.collection.json`），
 * 所以整棵树不加库 id 子目录。只读 —— 导出一律落服务端根目录，绝不往镜像里写。
 */
export function readCollectionMirror(mirrorRoot: string, libraryId: string): CollectionRead & { root: string } {
  const dir = path.join(mirrorRoot, ...safeSegments(libraryId));
  return { ...readCollectionDir(dir, "旁挂:"), root: dir };
}

const MAX_SIDECAR_BYTES = 256 * 1024;

function walk(dir: string, depth = 0): string[] {
  if (depth > 12) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(COLLECTION_SUFFIX)) {
      if (fs.statSync(full).size <= MAX_SIDECAR_BYTES) out.push(full);
    }
  }
  return out;
}

/** 写出一批 sidecar，返回落盘的相对路径清单。目录里只有一份时用点文件名。 */
export function writeCollectionRoot(sidecarRoot: string, libraryId: string, sidecars: CollectionSidecar[]): string[] {
  const byDir = new Map<string, CollectionSidecar[]>();
  for (const sidecar of sidecars) byDir.set(sidecar.basePath, [...(byDir.get(sidecar.basePath) ?? []), sidecar]);
  const written: string[] = [];
  const root = path.join(sidecarRoot, ...safeSegments(libraryId));
  for (const [basePath, group] of byDir) {
    const used = new Set<string>();
    group.forEach((sidecar, index) => {
      let fileName = collectionFileName(group.length, index, sidecar.collectionId);
      while (used.has(fileName)) fileName = `${sidecar.collectionId}-${index + 1}-${used.size}.${COLLECTION_SUFFIX}`;
      used.add(fileName);
      const target = collectionDiskPath(sidecarRoot, libraryId, sidecar, fileName);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`sidecar 路径逃出根目录：${target}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, collectionJson({ ...sidecar, sourceFile: relative }), "utf8");
      written.push(relative);
    });
  }
  return written.sort();
}
