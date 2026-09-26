import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  OpenlistServiceError,
  type OpenlistClient,
  type OpenlistLinkInfo,
} from "./openlist.ts";
import type { StoredLibrary } from "./library-store.ts";
import type {
  MediaCompatibility,
  ResolvedMedia,
  ResolvedMpvMedia,
  SubtitleTrack,
} from "./watchparty-media.ts";

const PAGE_SIZE = 100;
const MAX_DIRECTORY_ENTRIES = 2000;
const SUBTITLE_CAP_BYTES = 5 * 1024 * 1024;
const SUBTITLE_EXTENSIONS = new Set(["ass", "ssa", "srt", "vtt"]);
const NATIVE_VIDEO_EXTENSIONS = new Set(["mp4", "webm", "m3u8", "mov", "m4v", "ogv"]);
const TRANSCODE_VIDEO_EXTENSIONS = new Set(["avi", "flv", "ts", "mpeg", "mpg"]);
const LANGUAGE_TOKENS: Record<string, string> = {
  chs: "zh-Hans",
  sc: "zh-Hans",
  gb: "zh-Hans",
  cht: "zh-Hant",
  tc: "zh-Hant",
  big5: "zh-Hant",
  zh: "zh",
  cn: "zh",
  jp: "ja",
  jpn: "ja",
  en: "en",
  eng: "en",
  kor: "ko",
  rus: "ru",
};

export type LibraryItem = {
  id: string;
  name: string;
  isDirectory: boolean;
  /** Path relative to the library root. Never an absolute storage path. */
  relativePath: string;
  type: "file" | "dir";
  size?: number;
  extension?: string;
  mime?: string;
  compatibility: MediaCompatibility;
  /** Sibling poster in this folder. Absent when the folder has no accepted image. */
  posterId?: string;
};

export type LibraryPage = {
  libraryId: string;
  currentPath: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  hasMore: boolean;
  nextCursor?: string;
  /** Poster for the directory being listed, not for child directories. */
  posterId?: string;
  items: LibraryItem[];
};

type OpenlistEntry = { name: string; isDir: boolean; path: string; size?: number };

export type LibraryBrowser = {
  list(library: StoredLibrary, relativePath: string, cursor?: string): Promise<LibraryPage>;
  search(library: StoredLibrary, query: string, cursor?: string): Promise<LibraryPage>;
  resolve(mediaId: string): Promise<ResolvedMedia | null | undefined>;
  resolveMpv(mediaId: string): Promise<ResolvedMpvMedia | null | undefined>;
  discoverSubtitles(mediaId: string): Promise<SubtitleTrack[] | undefined>;
  loadSubtitle(mediaId: string): Promise<string | undefined>;
  loadArtwork(mediaId: string): Promise<LibraryArtwork | undefined>;
};

export function encodeLibraryMediaId(sourceId: string, mediaPath: string, key: string): string {
  const payload = Buffer.from(`${sourceId}\n${mediaPath}`, "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `v2.${payload}.${signature}`;
}

export function decodeLibraryMediaId(
  token: string,
  key: string,
): { sourceId: string; path: string } | undefined {
  if (!token.startsWith("v2.")) return undefined;
  const [, payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", key).update(payload).digest("base64url");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const splitAt = decoded.indexOf("\n");
  if (splitAt <= 0) return undefined;
  const sourceId = decoded.slice(0, splitAt);
  const mediaPath = decoded.slice(splitAt + 1);
  if (!sourceId || !mediaPath.startsWith("/") || mediaPath.length > 4096 || mediaPath.includes("\\")) {
    return undefined;
  }
  if (path.posix.normalize(mediaPath) !== mediaPath) return undefined;
  return { sourceId, path: mediaPath };
}

export function createLibraryBrowser(
  client: OpenlistClient,
  options: {
    sourceId: string;
    mediaIdKey: string;
    internalBaseUrl: string;
    publicBaseUrl: string;
    libraries: StoredLibrary[];
    requestTimeoutMs?: number;
  },
): LibraryBrowser {
  const { sourceId, mediaIdKey, internalBaseUrl, publicBaseUrl, libraries } = options;

  function encode(mediaPath: string): string {
    return encodeLibraryMediaId(sourceId, mediaPath, mediaIdKey);
  }

  function ownedPath(mediaId: string): string | undefined {
    const decoded = decodeLibraryMediaId(mediaId, mediaIdKey);
    if (!decoded || decoded.sourceId !== sourceId) return undefined;
    return libraries.some((library) => isPathUnder(library.absolutePath, decoded.path))
      ? decoded.path
      : undefined;
  }

  function libraryFor(mediaPath: string): StoredLibrary | undefined {
    return libraries.find((library) => isPathUnder(library.absolutePath, mediaPath));
  }

  async function list(library: StoredLibrary, relativePath: string, cursor?: string): Promise<LibraryPage> {
    const directoryPath = toAbsolutePath(library.absolutePath, relativePath);
    const response = await client.list(directoryPath);
    if (!response || response.code !== 200) {
      throw new OpenlistServiceError("OPENLIST_UNAVAILABLE", "OpenList directory request failed", 502);
    }
    const content = toEntries(response.data?.content, directoryPath)
      .filter((entry) => isDirectChild(directoryPath, entry.path) && isPathUnder(library.absolutePath, entry.path))
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .sort((left, right) => naturalCompare(left.name, right.name));
    const page = pageItems(content, cursor);
    const currentPath = relativeToLibrary(library.absolutePath, directoryPath);
    const poster = await selectPoster(content, (mediaPath) => readArtworkFile(mediaPath, true));
    const posterId = poster ? encode(poster.path) : undefined;
    return {
      libraryId: library.id,
      currentPath,
      breadcrumbs: breadcrumbsOf(library.name, currentPath),
      hasMore: page.end < content.length,
      ...(page.end < content.length ? { nextCursor: String(page.end) } : {}),
      ...(posterId ? { posterId } : {}),
      items: page.items.map((entry) => {
        const item = toItem(library, entry, encode);
        if (posterId && !entry.isDir && isVideoPath(entry.path)) return { ...item, posterId };
        return item;
      }),
    };
  }

  async function search(library: StoredLibrary, query: string, cursor?: string): Promise<LibraryPage> {
    const response = await client.search(query, library.absolutePath);
    if (!response || response.code !== 200) {
      throw new OpenlistServiceError(
        "OPENLIST_UNAVAILABLE",
        `OpenList search failed: ${response?.message ?? "no response"}`,
        502,
      );
    }
    const rawContent: unknown = response.data?.content;
    const entries = toEntries(Array.isArray(rawContent) ? rawContent.map(joinSearchPath) : rawContent)
      .filter((entry) => isPathUnder(library.absolutePath, entry.path))
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .sort((left, right) => naturalCompare(left.name, right.name));
    const page = pageItems(entries, cursor);
    return {
      libraryId: library.id,
      currentPath: "/",
      breadcrumbs: breadcrumbsOf(library.name, "/"),
      hasMore: page.end < entries.length,
      ...(page.end < entries.length ? { nextCursor: String(page.end) } : {}),
      items: page.items.map((entry) => toItem(library, entry, encode)),
    };
  }

  async function resolve(mediaId: string): Promise<ResolvedMedia | null | undefined> {
    const mediaPath = ownedPath(mediaId);
    if (!mediaPath || !isVideoPath(mediaPath)) return undefined;
    const download = await client.getDownloadInfo(mediaPath);
    if (!download?.url) return null;
    const url = rewriteToPublicBase(download.url, internalBaseUrl, publicBaseUrl);
    if (!url) return null;
    const mime = mimeTypeFor(mediaPath);
    return {
      url,
      ...(mime ? { mime } : {}),
      ...(download.size !== null ? { size: download.size } : {}),
      requiresCustomHeaders: false,
    };
  }

  async function resolveMpv(mediaId: string): Promise<ResolvedMpvMedia | null | undefined> {
    const mediaPath = ownedPath(mediaId);
    if (!mediaPath || !isVideoPath(mediaPath)) return undefined;
    const download = await client.getDownloadInfo(mediaPath);
    const fallback = download?.url ? rewriteToPublicBase(download.url, internalBaseUrl, publicBaseUrl) : null;
    if (!fallback) return null;
    let link: OpenlistLinkInfo | null = null;
    try {
      link = await client.getLinkInfo(mediaPath);
    } catch (error) {
      if (!(error instanceof OpenlistServiceError)) throw error;
    }
    const filtered = filterLinkHeaders(link?.header);
    const direct = link?.url && !filtered.blocked ? link.url : undefined;
    return {
      ...(direct ? { directUrl: direct } : {}),
      headers: filtered.userAgent ? { "user-agent": filtered.userAgent } : {},
      fallbackUrl: fallback,
    };
  }

  async function discoverSubtitles(mediaId: string): Promise<SubtitleTrack[] | undefined> {
    const mediaPath = ownedPath(mediaId);
    if (!mediaPath || !isVideoPath(mediaPath)) return undefined;
    const directory = path.posix.dirname(mediaPath);
    const response = await client.list(directory);
    if (!response || response.code !== 200) {
      throw new OpenlistServiceError("OPENLIST_UNAVAILABLE", "OpenList directory request failed", 502);
    }
    const videoTokens = stemTokens(stemOf(mediaPath));
    return toEntries(response.data?.content, directory)
      .filter((entry) => !entry.isDir && isSubtitlePath(entry.path) && subtitleMatchesVideo(videoTokens, entry.path))
      .sort((left, right) => naturalCompare(left.name, right.name))
      .map((entry) => {
        const id = encode(entry.path);
        const format = subtitleFormat(entry.name);
        const language = languageOf(stemOf(entry.path));
        return {
          id,
          mediaId: id,
          label: entry.name,
          format,
          ...(language ? { language } : {}),
        };
      });
  }

  async function loadSubtitle(mediaId: string): Promise<string | undefined> {
    const mediaPath = ownedPath(mediaId);
    if (!mediaPath || !isSubtitlePath(mediaPath) || !libraryFor(mediaPath)) return undefined;
    const download = await client.getDownloadInfo(mediaPath);
    if (!download?.url) return undefined;
    const fetched = await client.fetchOriginText(download.url, SUBTITLE_CAP_BYTES);
    if (!fetched || fetched.status !== 200 || !fetched.text) return undefined;
    return fetched.text;
  }

  async function readArtworkFile(
    mediaPath: string,
    swallowTransport: boolean,
  ): Promise<LibraryArtwork | undefined> {
    const name = mediaPath.slice(mediaPath.lastIndexOf("/") + 1);
    if (!isPosterFileName(name)) return undefined;
    let download: { url: string; size: number | null } | null;
    try {
      download = await client.getDownloadInfo(mediaPath);
    } catch (error) {
      if (swallowTransport && error instanceof OpenlistServiceError) return undefined;
      throw error;
    }
    if (!download?.url) return undefined;
    if (download.size !== null && download.size > ARTWORK_CAP_BYTES) return undefined;
    return fetchArtworkBytes(download.url, internalBaseUrl, options.requestTimeoutMs ?? 10_000);
  }

  async function loadArtwork(mediaId: string): Promise<LibraryArtwork | undefined> {
    const mediaPath = ownedPath(mediaId);
    if (!mediaPath || !libraryFor(mediaPath)) return undefined;
    return readArtworkFile(mediaPath, false);
  }

  return { list, search, resolve, resolveMpv, discoverSubtitles, loadSubtitle, loadArtwork };
}

const ARTWORK_CAP_BYTES = 2 * 1024 * 1024;

export type LibraryArtwork = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
};

function isPosterFileName(name: string): boolean {
  return /^(poster|folder|cover)\.(jpe?g|png|webp)$/i.test(name);
}

function posterRank(name: string): number {
  const match = /^(poster|folder|cover)\.(jpe?g|png|webp)$/i.exec(name);
  if (!match) return 99;
  const kind = match[1]!.toLowerCase();
  const ext = match[2]!.toLowerCase();
  const kindRank = kind === "poster" ? 0 : kind === "folder" ? 1 : 2;
  const extRank = ext === "jpg" || ext === "jpeg" ? 0 : ext === "png" ? 1 : 2;
  return kindRank * 10 + extRank;
}

async function selectPoster(
  entries: OpenlistEntry[],
  read: (mediaPath: string) => Promise<LibraryArtwork | undefined>,
): Promise<OpenlistEntry | undefined> {
  const candidates = entries
    .filter((entry) => !entry.isDir && isPosterFileName(entry.name) && (entry.size === undefined || entry.size <= ARTWORK_CAP_BYTES))
    .sort((left, right) => posterRank(left.name) - posterRank(right.name) || naturalCompare(left.name, right.name));
  for (const candidate of candidates) {
    if (await read(candidate.path)) return candidate;
  }
  return undefined;
}

async function fetchArtworkBytes(url: string, internalBaseUrl: string, timeoutMs: number): Promise<LibraryArtwork | undefined> {
  let target: URL;
  let origin: URL;
  try {
    target = new URL(url);
    origin = new URL(internalBaseUrl);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (target.origin !== origin.origin || target.username || target.password) return undefined;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return undefined;
  }
  if (response.status !== 200) return undefined;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ARTWORK_CAP_BYTES) return undefined;
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > ARTWORK_CAP_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks);
  const contentType = sniffImage(bytes);
  if (!contentType) return undefined;
  return { contentType, bytes };
}

function sniffImage(bytes: Buffer): LibraryArtwork["contentType"] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function rewriteToPublicBase(url: string, internalBaseUrl: string, publicBaseUrl: string): string | null {
  let parsed: URL;
  let internal: URL;
  let target: URL;
  try {
    parsed = new URL(url);
    internal = new URL(internalBaseUrl);
    target = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (parsed.origin === internal.origin) return `${target.origin}${parsed.pathname}${parsed.search}`;
  return parsed.protocol === "https:" ? url : null;
}

function filterLinkHeaders(header: Record<string, string> | undefined): { userAgent?: string; blocked: boolean } {
  if (!header) return { blocked: false };
  let userAgent: string | undefined;
  let blocked = false;
  for (const [key, value] of Object.entries(header)) {
    if (!value) continue;
    if (key.toLowerCase() === "user-agent") userAgent = value;
    else blocked = true;
  }
  return { ...(userAgent !== undefined ? { userAgent } : {}), blocked };
}

function joinSearchPath(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const item = entry as Record<string, unknown>;
  if (typeof item.path === "string" || typeof item.parent !== "string") return item;
  return { ...item, path: path.posix.join(item.parent, typeof item.name === "string" ? item.name : "") };
}

function toEntries(content: unknown, parentPath?: string): OpenlistEntry[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    const itemPath = typeof item.path === "string" ? item.path : parentPath ? path.posix.join(parentPath, name) : "";
    if (!name || !itemPath || name.includes("/") || name.includes("\\")) return [];
    const rawSize = item.size;
    const size = typeof rawSize === "number" && Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : undefined;
    return [{ name, path: itemPath, isDir: item.is_dir === true, ...(size === undefined ? {} : { size }) }];
  });
}

function toAbsolutePath(libraryPath: string, relativePath: string): string {
  const relative = relativePath.replace(/^\/+/, "");
  if (!relative) return libraryPath;
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error("Invalid media path");
  }
  const resolved = path.posix.join(libraryPath, ...segments);
  if (!isPathUnder(libraryPath, resolved)) throw new Error("Invalid media path");
  return resolved;
}

function relativeToLibrary(libraryPath: string, absolutePath: string): string {
  const relative = path.posix.relative(libraryPath, absolutePath);
  return relative ? `/${relative}` : "/";
}

function isPathUnder(root: string, candidate: string): boolean {
  if (!candidate.startsWith("/") || candidate.includes("\\")) return false;
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isDirectChild(directoryPath: string, candidate: string): boolean {
  return path.posix.dirname(candidate) === directoryPath;
}

function toItem(library: StoredLibrary, entry: OpenlistEntry, encode: (mediaPath: string) => string): LibraryItem {
  const extension = extensionOf(entry.name);
  return {
    id: encode(entry.path),
    name: entry.name,
    isDirectory: entry.isDir,
    relativePath: relativeToLibrary(library.absolutePath, entry.path),
    type: entry.isDir ? "dir" : "file",
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(extension ? { extension } : {}),
    ...(entry.isDir ? {} : mimeTypeFor(entry.name) ? { mime: mimeTypeFor(entry.name) } : {}),
    compatibility: compatibilityOf(entry.isDir, extension),
  };
}

function compatibilityOf(isDir: boolean, extension: string): MediaCompatibility {
  if (isDir || NATIVE_VIDEO_EXTENSIONS.has(extension)) return { browser: "supported", desktop: "supported" };
  if (extension === "mkv") {
    return {
      browser: "unsupported",
      desktop: "supported",
      browserReason: "浏览器不承担 MKV 播放，请使用 MPV 或 WatchParty 桌面客户端",
    };
  }
  if (TRANSCODE_VIDEO_EXTENSIONS.has(extension)) {
    return {
      browser: "maybe",
      desktop: "maybe",
      browserReason: "浏览器是否支持此封装取决于编码",
      desktopReason: "MPV 通常支持，但需以实际解码器和硬件能力为准",
    };
  }
  return {
    browser: "unsupported",
    desktop: "unsupported",
    browserReason: "不是浏览器可播放的视频文件",
    desktopReason: "不是当前媒体扫描器识别的视频文件",
  };
}

function pageItems<T>(items: T[], cursor: string | undefined): { items: T[]; end: number } {
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > items.length) throw new Error("Invalid cursor");
  const end = Math.min(start + PAGE_SIZE, items.length);
  return { items: items.slice(start, end), end };
}

function breadcrumbsOf(libraryName: string, relativePath: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: libraryName, path: "/" }];
  if (relativePath === "/") return crumbs;
  const parts = relativePath.slice(1).split("/");
  let walked = "";
  for (const part of parts) {
    walked += `/${part}`;
    crumbs.push({ name: part, path: walked });
  }
  return crumbs;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

function mimeTypeFor(name: string): string | undefined {
  return {
    mp4: "video/mp4",
    webm: "video/webm",
    m3u8: "application/vnd.apple.mpegurl",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    ogv: "video/ogg",
  }[extensionOf(name)];
}

function isVideoPath(mediaPath: string): boolean {
  const extension = extensionOf(mediaPath);
  return NATIVE_VIDEO_EXTENSIONS.has(extension) || extension === "mkv" || TRANSCODE_VIDEO_EXTENSIONS.has(extension);
}

function isSubtitlePath(mediaPath: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extensionOf(mediaPath));
}

function subtitleFormat(name: string): "ass" | "ssa" | "srt" | "vtt" {
  const extension = extensionOf(name);
  if (extension === "ass" || extension === "ssa" || extension === "srt" || extension === "vtt") return extension;
  return "srt";
}

function stemOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function stemTokens(stem: string): string[] {
  return stem.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function subtitleMatchesVideo(videoTokens: string[], subtitlePath: string): boolean {
  if (videoTokens.length === 0) return false;
  const subtitleTokens = stemTokens(stemOf(subtitlePath));
  if (subtitleTokens.length < videoTokens.length) return false;
  if (!videoTokens.every((token, index) => subtitleTokens[index] === token)) return false;
  return subtitleTokens.slice(videoTokens.length).every((token) => token in LANGUAGE_TOKENS);
}

function languageOf(stem: string): string | undefined {
  const token = stemTokens(stem).reverse().find((candidate) => candidate in LANGUAGE_TOKENS);
  return token ? LANGUAGE_TOKENS[token] : undefined;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
