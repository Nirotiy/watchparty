import path from "node:path";

export type ScanFile = {
  relativePath: string;
  name: string;
  mediaId: string;
};

export type CatalogGroupFile = {
  mediaId: string;
  name: string;
  season: number | null;
  episode: number | null;
};

export type CatalogGroup = {
  itemKey: string;
  query: string;
  rawName: string;
  files: CatalogGroupFile[];
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "m4v", "mov", "avi", "ts", "m2ts", "flv", "wmv"]);
const TECHNICAL = /1080|720|2160|4k|bdrip|web-?dl|bluray|hevc|x26[45]|aac|flac|\bmkv\b|avc|10bit|8bit|全集|特典|特别篇|导演/i;

export function isVideoFileName(name: string): boolean {
  const index = name.lastIndexOf(".");
  if (index <= 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

export function cleanTitle(name: string): string {
  const withoutExt = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  const chunks: string[] = [];
  const remainder = withoutExt
    .replace(/\[([^\]]*)\]/g, (_all, inner: string) => {
      chunks.push(inner);
      return " ";
    })
    .replace(/\(([^)]*)\)/g, (_all, inner: string) => {
      chunks.push(inner);
      return " ";
    });
  const title = stripReleaseTags(remainder);
  if (title) return title;
  const picked = chunks.find((chunk) => !isJunkChunk(chunk));
  return picked ? stripReleaseTags(picked) : "";
}

export function yearFrom(name: string): number | null {
  const match = name.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function parseEpisode(name: string): { season: number | null; episode: number | null } {
  const match = name.match(/S(\d{1,2})E(\d{1,3})/i);
  if (!match?.[1] || !match[2]) return { season: null, episode: null };
  return { season: Number(match[1]), episode: Number(match[2]) };
}

export function seasonFromName(name: string): number | null {
  const match = name.match(/^(?:season\s*|s)(\d{1,2})$/i);
  return match?.[1] ? Number(match[1]) : null;
}

export function scoreTitles(query: string, title: string): number {
  const left = normalizeTitle(query);
  const right = normalizeTitle(title);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if ((left.includes(right) || right.includes(left)) && shorter >= 4 && shorter / longer >= 0.45) return 0.9;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

export function groupScanFiles(files: ScanFile[]): CatalogGroup[] {
  const byDir = new Map<string, ScanFile[]>();
  for (const file of files) {
    const dir = parentOf(file.relativePath);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const rolled = new Map<string, Array<CatalogGroupFile & { relativePath: string }>>();
  for (const [dir, list] of byDir) {
    const base = dir === "/" ? "" : path.posix.basename(dir);
    if (base && isExtraDirectory(base)) continue;
    const seasonFolder = base ? seasonFromName(base) : null;
    const key = seasonFolder !== null && dir !== "/" ? parentOf(dir) : dir;
    const bucket = rolled.get(key) ?? [];
    for (const file of list) {
      const parsed = parseEpisode(file.name);
      bucket.push({
        relativePath: file.relativePath,
        mediaId: file.mediaId,
        name: file.name,
        season: parsed.season ?? seasonFolder,
        episode: parsed.episode,
      });
    }
    rolled.set(key, bucket);
  }
  const groups: CatalogGroup[] = [];
  for (const [key, bucket] of rolled) {
    const filesInOrder = [...bucket].sort(compareFiles);
    if (key === "/") {
      for (const file of filesInOrder) {
        groups.push({
          itemKey: file.relativePath,
          query: cleanTitle(file.name),
          rawName: file.name,
          files: [{ mediaId: file.mediaId, name: file.name, season: file.season, episode: file.episode }],
        });
      }
      continue;
    }
    const rawName = path.posix.basename(key);
    groups.push({
      itemKey: key,
      query: cleanTitle(rawName),
      rawName,
      files: filesInOrder,
    });
  }
  return groups.sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

/**
 * zh-CN display string, served verbatim: clients are forbidden by the frozen
 * contract from parsing this text, so the wording belongs to the backend.
 * Shape is load-bearing (optional `S<n> · ` prefix, then a count) — the card
 * sub-line truncates near 20 characters.
 */
export function episodeSubtitle(files: CatalogGroupFile[]): string | null {
  if (files.length <= 1) return null;
  const seasons = new Set(files.map((file) => file.season).filter((season): season is number => season !== null));
  const prefix = seasons.size === 1 ? `S${[...seasons][0]} · ` : "";
  return `${prefix}${files.length} 集`;
}

function parentOf(relativePath: string): string {
  const normalized = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "/" : parent;
}

function compareFiles(left: CatalogGroupFile, right: CatalogGroupFile): number {
  const season = (left.season ?? 0) - (right.season ?? 0);
  if (season !== 0) return season;
  const episode = (left.episode ?? 0) - (right.episode ?? 0);
  if (episode !== 0) return episode;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function stripReleaseTags(value: string): string {
  return value
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, " ")
    .replace(/\b(?:S\d{1,2}|Season\s*\d+|Full)\b/gi, " ")
    .replace(/\b(?:1080p|720p|2160p|4k|bdrip|web-?dl|bluray|hevc|x264|x265|aac|flac|avc|10bit)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkChunk(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (!trimmed) return true;
  if (TECHNICAL.test(trimmed)) return true;
  if (/^[0-9A-F]{6,}$/i.test(trimmed)) return true;
  if (/raws?$/i.test(trimmed) || /lolihouse|dynamis/i.test(trimmed)) return true;
  return false;
}

function isExtraDirectory(name: string): boolean {
  return /^(?:pv|pvs|ncop(?:\s*[&＆+]\s*nced)?|nced|menu|menus|extras?|bonus(?:es)?|specials|sp|scans|booklet|特典映像|特典|特别篇|特別篇|映像特典)$/i.test(name.trim());
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
