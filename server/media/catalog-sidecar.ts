import path from "node:path";

/**
 * 本地 sidecar（Kodi/Emby/Jellyfin 生态的 `.nfo` 与 `.json`）→ 规范化元数据。
 *
 * 为什么手写抽取而不是拉一个 XML 依赖：NFO 是扁平文档，而且现实中大量文件是
 * 截断的、带非法实体、混着 CDATA 的（Kodi 自己也是宽松读）。真正要防的是
 * "解析器严格 ⇒ 一半文件读不出"，所以这里按标签取值、不做文档校验。
 * 依赖只有 `sax`/`xml2js` 这类**未声明**的传递依赖，不能借。
 */

export type SidecarIds = { tmdb: string | null; imdb: string | null; tvdb: string | null; bangumi: string | null };

export type SidecarMetadata = {
  kind: "movie" | "tvshow" | "season" | "episode" | "unknown";
  folder: string;
  sourceFile: string;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  ids: SidecarIds;
  season: number | null;
  episode: number | null;
  set: string | null;
  posterUrl: string | null;
  /** 解析中丢掉了什么：预览里必须露出来，不能静默降级成"没有这个字段"。 */
  warnings: string[];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_all, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_all, name: string) => ENTITIES[name] ?? "&");
}

/**
 * 取 <tag> 的文本值。两条规则缺一不可：
 * - 只吃"里面不再套标签"的那一层（`[^<]*`），否则 `<episode>4</episode>` 嵌在同名根
 *   元素里时会匹配到根元素、把整段文档当成值；
 * - CDATA 单独一条分支，因为 `<![CDATA[…]]>` 本身以 `<` 开头。
 */
function values(source: string, name: string): string[] {
  const out: string[] = [];
  const cdata = new RegExp(`<${name}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${name}\\s*>`, "gi");
  const plain = new RegExp(`<${name}[^>]*>([^<]*)</${name}\\s*>`, "gi");
  for (const pattern of [cdata, plain]) {
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const value = match[1].trim();
      if (value) out.push(decode(value));
    }
  }
  return out;
}

function tag(source: string, name: string): string | null {
  return values(source, name)[0] ?? null;
}

/** 连属性一起返回（`uniqueid type="tmdb"` 要靠属性分派）。 */
function tagged(source: string, name: string): Array<{ attrs: string; value: string }> {
  const pattern = new RegExp(`<${name}((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)</${name}\\s*>`, "gi");
  const out: Array<{ attrs: string; value: string }> = [];
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const value = String(match[2] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/<[^>]*>/g, "").trim();
    out.push({ attrs: String(match[1] ?? ""), value: decode(value) });
  }
  return out;
}

function yearOf(value: string | null): number | null {
  if (!value) return null;
  const digits = /(\d{4})/.exec(value);
  if (!digits) return null;
  const year = Number(digits[1]);
  return year >= 1870 && year <= 2100 ? year : null;
}

function numberOrNull(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** `uniqueid type="tmdb"` 是新格式，`imdbnumber`/`id` 是老格式；都读，新格式优先。 */
function idsOf(source: string): SidecarIds {
  const ids: SidecarIds = { tmdb: null, imdb: null, tvdb: null, bangumi: null };
  for (const entry of tagged(source, "uniqueid")) {
    const kind = (/type\s*=\s*["']?([a-zA-Z]+)/i.exec(entry.attrs)?.[1] ?? "").toLowerCase();
    if (!entry.value) continue;
    if (kind in ids) ids[kind as keyof SidecarIds] = entry.value;
  }
  const legacyImdb = tag(source, "imdbnumber");
  if (legacyImdb && !ids.imdb) ids.imdb = legacyImdb;
  return ids;
}

function kindOf(fileName: string, source: string): SidecarMetadata["kind"] {
  const base = fileName.toLowerCase();
  if (base === "movie.nfo") return "movie";
  if (base === "tvshow.nfo") return "tvshow";
  if (base === "season.nfo") return "season";
  if (tag(source, "episode") !== null && tag(source, "season") !== null) return "episode";
  if (tag(source, "showtitle") !== null) return "episode";
  if (tag(source, "set") !== null || tag(source, "tagline") !== null) return "movie";
  return "unknown";
}

export function parseNfo(fileName: string, content: string, folder = ""): SidecarMetadata {
  const warnings: string[] = [];
  if (!content.trim()) warnings.push("empty");
  else if (!/<[a-z]/i.test(content)) warnings.push("no-tags");
  const title = tag(content, "title");
  return {
    kind: kindOf(fileName, content),
    folder,
    sourceFile: fileName,
    title,
    originalTitle: tag(content, "originaltitle") ?? tag(content, "sorttitle"),
    year: yearOf(tag(content, "premiered") ?? tag(content, "firstaired") ?? tag(content, "year")),
    overview: tag(content, "plot") ?? tag(content, "overview") ?? tag(content, "tagline"),
    ids: idsOf(content),
    season: numberOrNull(tag(content, "season")),
    episode: numberOrNull(tag(content, "episode")),
    set: tag(content, "set") ?? tag(content, "name"),
    posterUrl: tag(content, "poster"),
    warnings,
  };
}

function pick(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Emby/Jellyfin 导出的 `.json`（字段名大小写不一，两种都吃）。 */
export function parseSidecarJson(fileName: string, content: string, folder = ""): SidecarMetadata {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...emptySidecar(fileName, folder), warnings: ["invalid-json"] };
  }
  const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!record || typeof record !== "object") return { ...emptySidecar(fileName, folder), warnings: ["not-an-object"] };
  const providers = (record.ProviderIds ?? record.providerIds ?? {}) as Record<string, unknown>;
  const year = yearOf(pick(record, "ProductionYear", "productionYear", "Year", "year"));
  const genre = record.Genres;
  return {
    kind: /movie/i.test(String(record.Type ?? record.type ?? "")) ? "movie" : /episode|season|series/i.test(String(record.Type ?? record.type ?? "")) ? "episode" : "unknown",
    folder,
    sourceFile: fileName,
    title: pick(record, "Name", "name", "Title", "title"),
    originalTitle: pick(record, "OriginalTitle", "originalTitle", "OriginalName"),
    year,
    overview: pick(record, "Overview", "overview", "Plot", "plot"),
    ids: {
      tmdb: pick(providers, "Tmdb", "tmdb"),
      imdb: pick(providers, "Imdb", "imdb"),
      tvdb: pick(providers, "Tvdb", "tvdb"),
      bangumi: pick(providers, "Bangumi", "bangumi"),
    },
    season: numberOrNull(pick(record, "ParentIndexNumber", "SeasonNumber", "season")),
    episode: numberOrNull(pick(record, "IndexNumber", "EpisodeNumber", "episode")),
    set: Array.isArray(genre) && genre.length > 0 ? null : pick(record, "Set", "HomeBoxId"),
    posterUrl: pick(record, "PrimaryImageTag") ? null : null,
    warnings,
  };
}

function emptySidecar(fileName: string, folder: string): SidecarMetadata {
  return {
    kind: "unknown",
    folder,
    sourceFile: fileName,
    title: null,
    originalTitle: null,
    year: null,
    overview: null,
    ids: { tmdb: null, imdb: null, tvdb: null, bangumi: null },
    season: null,
    episode: null,
    set: null,
    posterUrl: null,
    warnings: [],
  };
}

export function parseSidecar(fileName: string, content: string, folder = ""): SidecarMetadata {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".nfo")) return parseNfo(fileName, content, folder);
  if (lower.endsWith(".json")) return parseSidecarJson(fileName, content, folder);
  return { ...emptySidecar(fileName, folder), warnings: ["unsupported-extension"] };
}

/** 一个目录里可能同时有 movie.nfo / 同名 nfo / fanart 的 json：只取能代表媒体的那些。 */
export function sidecarsIn(entries: string[]): string[] {
  return entries.filter((name) => {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".nfo") && !lower.endsWith(".json")) return false;
    if (/(fanart|clearart|banner|thumb|extrafanart|extrathumbs|discart|logo|cdart)/.test(lower)) return false;
    return true;
  });
}

export type SidecarTarget = { folder: string; title: string | null; year: number | null; ids: SidecarIds; sourceFile: string; kind: SidecarMetadata["kind"] };

/**
 * 按**文件集合**把 sidecar 落到已有作品卡上：`itemKey` 与外部 ID 只是辅助证据。
 * 这条与草稿层同源 —— 卡片身份本来就是文件集合，路径会因合并/拆分而变。
 */
export function matchSidecars(
  sidecars: SidecarTarget[],
  cards: Array<{ itemKey: string; title: string | null; externalDb: string | null; externalId: string | null; folders: string[] }>,
): { matched: Array<{ sidecar: SidecarTarget; card: (typeof cards)[number]; how: string }>; ambiguous: Array<{ sidecar: SidecarTarget; cards: typeof cards }>; unmatched: SidecarTarget[] } {
  const matched: Array<{ sidecar: SidecarTarget; card: (typeof cards)[number]; how: string }> = [];
  const ambiguous: Array<{ sidecar: SidecarTarget; cards: typeof cards }> = [];
  const unmatched: SidecarTarget[] = [];
  for (const sidecar of sidecars) {
    const byFolder = cards.filter((card) => card.folders.includes(sidecar.folder));
    // 两边都得真的有 id：否则"没有外部 ID"会和"没有外部 ID"互相匹配上。
    const known = [sidecar.ids.tmdb, sidecar.ids.imdb].filter((value): value is string => Boolean(value));
    const byId = known.length > 0 ? cards.filter((card) => card.externalId && known.includes(card.externalId)) : [];
    const candidates = byFolder.length > 0 ? byFolder : byId;
    if (candidates.length === 1) {
      matched.push({ sidecar, card: candidates[0]!, how: byFolder.length > 0 ? "folder" : "external-id" });
    } else if (candidates.length > 1) {
      ambiguous.push({ sidecar, cards: candidates });
    } else {
      unmatched.push(sidecar);
    }
  }
  return { matched, ambiguous, unmatched };
}

export function folderOf(relativePath: string): string {
  return path.posix.dirname(relativePath) || "/";
}
