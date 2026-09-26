import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  OpenlistServiceError,
  type OpenlistClient,
  type OpenlistErrorCode,
} from "./openlist.ts";

export const WATCHPARTY_ROOTS = {
  Anime: "/media/openlist-bdyun/Multimedia/Anime",
  Film: "/media/openlist-bdyun/Multimedia/Film",
  "TV Shows": "/media/openlist-bdyun/Multimedia/TV Shows",
} as const;

export type WatchpartyRoot = keyof typeof WATCHPARTY_ROOTS;

type OpenlistEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  path: string;
};

const PAGE_SIZE = 100;
/**
 * Hard cap on entries materialized from a single directory listing or search.
 * OpenList returns the full set (per_page: 0); sorting/paging happens here, so
 * unbounded directories would grow memory per page request.
 */
const MAX_DIRECTORY_ENTRIES = 2000;
const SUBTITLE_CAP_BYTES = 5 * 1024 * 1024;
const SUBTITLE_EXTENSIONS = new Set(["ass", "ssa", "srt", "vtt"]);
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "m3u8",
  "mov",
  "m4v",
  "ogv",
]);
const MAYBE_VIDEO_EXTENSIONS = new Set(["avi", "flv", "ts", "mpeg", "mpg"]);

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

export type CompatibilityStatus = "supported" | "maybe" | "unsupported";

export type MediaCompatibility = {
  browser: CompatibilityStatus;
  desktop: CompatibilityStatus;
  browserReason?: string;
  desktopReason?: string;
};

export type MediaItem = {
  id: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  extension?: string;
  compatibility: MediaCompatibility;
  displayPath?: string;
};

export type DirectoryResult = {
  root?: WatchpartyRoot;
  currentPath: string;
  breadcrumbs: string[];
  hasMore: boolean;
  nextCursor?: string;
  items: MediaItem[];
};

export type ResolvedMedia = {
  url: string;
  size?: number;
  mime?: string;
  requiresCustomHeaders: boolean;
};

/**
 * Dual-link resolve for MPV clients (spec 9.3): directUrl comes from the admin
 * fs/link API; headers contains only whitelisted entries (User-Agent). If the
 * upstream direct link requires headers outside the whitelist, directUrl is
 * omitted and the client must use fallbackUrl (the /p/ proxy).
 */
export type ResolvedMpvMedia = {
  directUrl?: string;
  headers: Record<string, string>;
  fallbackUrl: string;
};

export type SubtitleTrack = {
  id: string;
  mediaId: string;
  label: string;
  format: "ass" | "ssa" | "srt" | "vtt";
  language?: string;
};

export type MediaHealthCode =
  | "OPENLIST_OK"
  | "OPENLIST_UNREACHABLE"
  | "OPENLIST_TIMEOUT"
  | "OPENLIST_AUTH_FAILED"
  | "OPENLIST_BAD_RESPONSE";

export type MediaRootProbe = {
  name: WatchpartyRoot;
  ok: boolean;
  code: "MEDIA_ROOT_OK" | "MEDIA_ROOT_NOT_FOUND";
};

export type MediaHealth =
  | { ok: true; latencyMs: number; roots: MediaRootProbe[] }
  | {
      ok: false;
      code: MediaHealthCode;
      detail?: string;
      latencyMs: number;
    };

/**
 * Transport-level OpenList codes -> stable readiness health codes.
 * OPENLIST_UNAVAILABLE means the request never produced a usable answer;
 * the setup guide renders it as "media source unreachable".
 */
const HEALTH_CODE_BY_OPENLIST_ERROR: Record<
  OpenlistErrorCode,
  MediaHealthCode
> = {
  OPENLIST_AUTH_FAILED: "OPENLIST_AUTH_FAILED",
  OPENLIST_UNAVAILABLE: "OPENLIST_UNREACHABLE",
  OPENLIST_TIMEOUT: "OPENLIST_TIMEOUT",
  OPENLIST_BAD_RESPONSE: "OPENLIST_BAD_RESPONSE",
};

export type WatchpartyMedia = {
  rootNames(): WatchpartyRoot[];
  isRoot(value: unknown): value is WatchpartyRoot;
  list(
    root: WatchpartyRoot,
    relativePath: string,
    cursor?: string,
  ): Promise<DirectoryResult>;
  search(
    query: string,
    root?: WatchpartyRoot,
    cursor?: string,
  ): Promise<DirectoryResult>;
  /** null = unsupported/not playable, undefined = invalid or forged mediaId. */
  resolve(mediaId: string): Promise<ResolvedMedia | null | undefined>;
  /** Same semantics as resolve, but returns the dual-link MPV shape. */
  resolveMpv(mediaId: string): Promise<ResolvedMpvMedia | null | undefined>;
  /** undefined = invalid or forged mediaId; empty array = no matching subtitles. */
  discoverSubtitles(mediaId: string): Promise<SubtitleTrack[] | undefined>;
    loadSubtitle(mediaId: string): Promise<string | undefined>;
  /** Lightweight health check for readiness probes (ping + root visibility). */
  checkHealth(): Promise<MediaHealth>;
};

export type WatchpartyMediaOptions = {
  mediaIdKey: string;
  /** Origin the backend itself uses to reach OpenList. */
  internalBaseUrl: string;
  /** Origin browsers use to reach OpenList (differs on VPS deployments). */
  publicBaseUrl: string;
};

/**
 * WatchParty's OpenList media adapter. mediaId values are HMAC-signed opaque
 * tokens; every use re-validates the decoded path against the allowed roots.
 * Video bytes are never proxied through this process: resolve returns the
 * OpenList proxy URL rewritten to the browser-facing origin.
 */
export function createWatchpartyMedia(
  client: OpenlistClient,
  options: WatchpartyMediaOptions,
): WatchpartyMedia {
  const { mediaIdKey, internalBaseUrl, publicBaseUrl } = options;

  function rewriteToPublicBase(url: string): string | null {
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
    if (parsed.origin === internal.origin) {
      return `${target.origin}${parsed.pathname}${parsed.search}`;
    }
    return parsed.protocol === "https:" ? url : null;
  }

  function sign(payload: string): string {
    return createHmac("sha256", mediaIdKey).update(payload).digest("base64url");
  }

  function encodeMediaId(mediaPath: string): string {
    const payload = Buffer.from(mediaPath).toString("base64url");
    return `${payload}.${sign(payload)}`;
  }

  function decodeMediaId(mediaId: string): string | undefined {
    const [payload, signature, extra] = mediaId.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !safeSignatureEquals(signature, sign(payload))
    )
      return undefined;
    try {
      const mediaPath = Buffer.from(payload, "base64url").toString("utf8");
      return mediaPath.startsWith("/") && mediaPath.length <= 4096
        ? mediaPath
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function listOpenlist(directoryPath: string): Promise<OpenlistEntry[]> {
    const response = await client.list(directoryPath);
    if (!response || response.code !== 200) {
      throw new OpenlistServiceError(
        "OPENLIST_UNAVAILABLE",
        "OpenList directory request failed",
        502,
      );
    }
    return toEntries(response.data?.content, directoryPath)
      .filter((entry) => isDirectChild(directoryPath, entry.path))
      .slice(0, MAX_DIRECTORY_ENTRIES);
  }

  async function list(
    root: WatchpartyRoot,
    relativePath: string,
    cursor?: string,
  ): Promise<DirectoryResult> {
    const directoryPath = toAbsolutePath(root, relativePath);
    const content = (await listOpenlist(directoryPath)).sort((left, right) =>
      naturalCompare(left.name, right.name),
    );
    const page = pageItems(content, cursor);
    const currentRelative = fromAbsolutePath(root, directoryPath);
    return {
      root,
      currentPath: currentRelative,
      breadcrumbs: breadcrumbsOf(currentRelative),
      hasMore: page.end < content.length,
      ...(page.end < content.length ? { nextCursor: String(page.end) } : {}),
      items: page.items.map((entry) => toMediaItem(entry, encodeMediaId)),
    };
  }

  async function search(
    query: string,
    root?: WatchpartyRoot,
    cursor?: string,
  ): Promise<DirectoryResult> {
    const response = await client.search(
      query,
      root ? WATCHPARTY_ROOTS[root] : undefined,
    );
    if (!response || response.code !== 200) {
      // Surface upstream failures (e.g. search index unavailable) instead of
      // silently mapping them to an empty result.
      throw new OpenlistServiceError(
        "OPENLIST_UNAVAILABLE",
        `OpenList search failed: ${response?.message ?? "no response"}`,
        502,
      );
    }
    const rawContent: unknown = response.data?.content;
    const entries = toEntries(
      Array.isArray(rawContent) ? rawContent.map(joinSearchPath) : rawContent,
    )
      .filter((entry) => isAllowedPath(entry.path))
      .slice(0, MAX_DIRECTORY_ENTRIES);
    const page = pageItems(
      entries.sort((a, b) => naturalCompare(a.name, b.name)),
      cursor,
    );
    return {
      ...(root ? { root } : {}),
      currentPath: "/",
      breadcrumbs: [],
      hasMore: page.end < entries.length,
      ...(page.end < entries.length ? { nextCursor: String(page.end) } : {}),
      items: page.items.map((entry) => toMediaItem(entry, encodeMediaId)),
    };
  }

  async function resolve(
    mediaId: string,
  ): Promise<ResolvedMedia | null | undefined> {
    const mediaPath = decodeMediaId(mediaId);
    if (!mediaPath || !isAllowedPath(mediaPath)) return undefined;
    const extension = extensionOf(mediaPath);
    if (
      !SUPPORTED_VIDEO_EXTENSIONS.has(extension) &&
      !MAYBE_VIDEO_EXTENSIONS.has(extension)
    )
      return null;
    const info = await client.getDownloadInfo(mediaPath);
    if (!info?.url) return null;
    const url = rewriteToPublicBase(info.url);
    if (!url) return null;
    return {
      url,
      ...(info.size === null ? {} : { size: info.size }),
      mime: mimeTypeFor(mediaPath),
      requiresCustomHeaders: false,
    };
  }

  async function resolveMpv(
    mediaId: string,
  ): Promise<ResolvedMpvMedia | null | undefined> {
    const mediaPath = decodeMediaId(mediaId);
    if (!mediaPath || !isAllowedPath(mediaPath)) return undefined;
    const extension = extensionOf(mediaPath);
    if (
      !SUPPORTED_VIDEO_EXTENSIONS.has(extension) &&
      !MAYBE_VIDEO_EXTENSIONS.has(extension) &&
      extension !== "mkv"
    )
      return null;

    const info = await client.getDownloadInfo(mediaPath);
    if (!info?.url) return null;
    const fallbackUrl = rewriteToPublicBase(info.url);
    if (!fallbackUrl) return null;

    const fallback: ResolvedMedia = {
      url: fallbackUrl,
      ...(info.size === null ? {} : { size: info.size }),
      mime: mimeTypeFor(mediaPath),
      requiresCustomHeaders: false,
    };
    const link = await client.getLinkInfo(mediaPath);
    const filtered = filterLinkHeaders(link?.header);
    if (!link?.url || filtered.blocked) {
      return { headers: {}, fallbackUrl: fallback.url };
    }
    return {
      directUrl: link.url,
      headers: filtered.userAgent ? { "User-Agent": filtered.userAgent } : {},
      fallbackUrl: fallback.url,
    };
  }

  /**
   * Subtitle discovery: same directory, normalized same primary filename
   * (language suffixes like "Episode 2.chs.ass" match). Token comparison —
   * not prefix matching — prevents "Episode 2" from matching "Episode 20".
   */
  async function discoverSubtitles(
    mediaId: string,
  ): Promise<SubtitleTrack[] | undefined> {
    const videoPath = decodeMediaId(mediaId);
    if (!videoPath || !isAllowedPath(videoPath)) return undefined;
    const videoTokens = stemTokens(stemOf(videoPath));
    const tracks = (await listOpenlist(path.posix.dirname(videoPath)))
      .filter((entry) => !entry.isDir && isSubtitlePath(entry.path))
      .filter((entry) => subtitleMatchesVideo(videoTokens, entry.path))
      .sort((left, right) => naturalCompare(left.name, right.name))
      .map(toSubtitleTrack);
    return tracks;
  }

  async function loadSubtitle(mediaId: string): Promise<string | undefined> {
    const mediaPath = decodeMediaId(mediaId);
    if (!mediaPath || !isAllowedPath(mediaPath) || !isSubtitlePath(mediaPath))
      return undefined;
    const info = await client.getDownloadInfo(mediaPath);
    if (!info?.url || (info.size !== null && info.size > SUBTITLE_CAP_BYTES))
      return undefined;
    const fetched = await client.fetchOriginText(info.url, SUBTITLE_CAP_BYTES);
    if (!fetched || fetched.status < 200 || fetched.status >= 300)
      return undefined;
    return fetched.text;
  }

  function toSubtitleTrack(entry: OpenlistEntry): SubtitleTrack {
    const subtitleId = encodeMediaId(entry.path);
    return {
      id: subtitleId,
      mediaId: subtitleId,
      label: entry.name,
      format: extensionOf(entry.path) as SubtitleTrack["format"],
      ...languageOf(stemOf(entry.name)),
    };
  }

  async function checkHealth(): Promise<MediaHealth> {
    const startedAt = performance.now();
    const fail = (code: MediaHealthCode, detail?: string): MediaHealth => ({
      ok: false,
      code,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(detail ? { detail } : {}),
    });
    const result = await client.ping();
    // Map transport codes onto the stable readiness health codes.
    const code: MediaHealthCode =
      result.error !== undefined
        ? HEALTH_CODE_BY_OPENLIST_ERROR[result.error]
        : "OPENLIST_BAD_RESPONSE";
    if (!result.ok) {
      return fail(code, result.detail);
    }
    if (result.error !== undefined || result.detail !== undefined) {
      return fail(code, result.detail);
    }
    // Ping passed: check each configured media root with one shallow request.
    const roots: MediaRootProbe[] = [];
    for (const [name, absolutePath] of Object.entries(WATCHPARTY_ROOTS)) {
      try {
        const response = await client.listShallow(absolutePath);
        roots.push({
          name: name as WatchpartyRoot,
          ok: response.code === 200,
          code: response.code === 200 ? "MEDIA_ROOT_OK" : "MEDIA_ROOT_NOT_FOUND",
        });
      } catch {
        // Ping already proved reachability; a throwing root is a path/mount problem.
        roots.push({ name: name as WatchpartyRoot, ok: false, code: "MEDIA_ROOT_NOT_FOUND" });
      }
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      roots,
    };
  }

  return {
    rootNames: () => Object.keys(WATCHPARTY_ROOTS) as WatchpartyRoot[],
    isRoot: (value): value is WatchpartyRoot =>
      typeof value === "string" && value in WATCHPARTY_ROOTS,
    list,
    search,
    resolve,
    resolveMpv,
    discoverSubtitles,
    loadSubtitle,
    checkHealth,
  };
}

/**
 * Spec 9.3 whitelist: from the upstream-required headers only User-Agent may
 * pass through to MPV. Any other non-empty required header (Cookie,
 * Authorization, Referer, ...) makes the direct link unusable.
 */
function filterLinkHeaders(header: Record<string, string> | undefined): {
  userAgent?: string;
  blocked: boolean;
} {
  if (!header) return { blocked: false };
  let userAgent: string | undefined;
  let blocked = false;
  for (const [key, value] of Object.entries(header)) {
    if (!value) continue;
    if (key.toLowerCase() === "user-agent") {
      userAgent = value;
    } else {
      blocked = true;
    }
  }
  return { ...(userAgent !== undefined ? { userAgent } : {}), blocked };
}

function safeSignatureEquals(left: string, right: string): boolean {
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * fs/search returns { parent, name } entries without a path field, unlike
 * fs/list; rebuild path so toEntries can process them. Unknown shapes pass
 * through unchanged and are dropped by toEntries.
 */
function joinSearchPath(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const item = entry as Record<string, unknown>;
  if (typeof item.path === "string" || typeof item.parent !== "string")
    return item;
  return {
    ...item,
    path: path.posix.join(
      item.parent,
      typeof item.name === "string" ? item.name : "",
    ),
  };
}

function toEntries(content: unknown, parentPath?: string): OpenlistEntry[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    const itemPath =
      typeof item.path === "string"
        ? item.path
        : parentPath
          ? path.posix.join(parentPath, name)
          : "";
    if (!name || !itemPath || name.includes("/") || name.includes("\\"))
      return [];
    const rawSize = item.size;
    const size =
      typeof rawSize === "number" &&
      Number.isSafeInteger(rawSize) &&
      rawSize >= 0
        ? rawSize
        : undefined;
    return [
      {
        name,
        path: itemPath,
        isDir: item.is_dir === true,
        ...(size === undefined ? {} : { size }),
      },
    ];
  });
}

function toAbsolutePath(root: WatchpartyRoot, relativePath: string): string {
  const base = WATCHPARTY_ROOTS[root];
  const relative = relativePath.replace(/^\/+/, "");
  if (!relative) return base;
  const segments = relative.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\"),
    )
  ) {
    throw new Error("Invalid media path");
  }
  const resolved = path.posix.join(base, ...segments);
  if (!isPathUnder(base, resolved))
    throw new Error("Media path is outside allowed root");
  return resolved;
}

function fromAbsolutePath(root: WatchpartyRoot, absolutePath: string): string {
  const relative = path.posix.relative(WATCHPARTY_ROOTS[root], absolutePath);
  return relative ? `/${relative}` : "/";
}

function isAllowedPath(mediaPath: string): boolean {
  if (!mediaPath.startsWith("/") || mediaPath.includes("\\")) return false;
  const normalized = path.posix.normalize(mediaPath);
  if (normalized !== mediaPath) return false;
  return Object.values(WATCHPARTY_ROOTS).some((root) =>
    isPathUnder(root, normalized),
  );
}

function isPathUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isDirectChild(directoryPath: string, candidate: string): boolean {
  return path.posix.dirname(candidate) === directoryPath;
}

function toMediaItem(
  entry: OpenlistEntry,
  encodeMediaId: (mediaPath: string) => string,
): MediaItem {
  const extension = extensionOf(entry.name);
  const compatibility = compatibilityOf(entry.isDir, extension);
  return {
    id: encodeMediaId(entry.path),
    name: entry.name,
    type: entry.isDir ? "dir" : "file",
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(extension ? { extension } : {}),
    compatibility,
    ...(entry.isDir ? {} : { displayPath: entry.path }),
  };
}

function compatibilityOf(isDir: boolean, extension: string): MediaCompatibility {
  if (isDir) {
    return { browser: "supported", desktop: "supported" };
  }
  if (SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    return { browser: "supported", desktop: "supported" };
  }
  if (extension === "mkv") {
    return {
      browser: "unsupported",
      desktop: "supported",
      browserReason: "浏览器不承担 MKV 播放，请使用 MPV 或 WatchParty 桌面客户端",
    };
  }
  if (MAYBE_VIDEO_EXTENSIONS.has(extension)) {
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

function pageItems<T>(items: T[], cursor: string | undefined) {
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > items.length)
    throw new Error("Invalid cursor");
  const end = Math.min(start + PAGE_SIZE, items.length);
  return { items: items.slice(start, end), end };
}

function breadcrumbsOf(relativePath: string): string[] {
  if (relativePath === "/") return [];
  return relativePath.slice(1).split("/");
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

function isSubtitlePath(mediaPath: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extensionOf(mediaPath));
}

function stemOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function stemTokens(stem: string): string[] {
  return stem
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function subtitleMatchesVideo(
  videoTokens: string[],
  subtitlePath: string,
): boolean {
  if (videoTokens.length === 0) return false;
  const subtitleTokens = stemTokens(stemOf(subtitlePath));
  if (subtitleTokens.length < videoTokens.length) return false;
  if (!videoTokens.every((token, index) => subtitleTokens[index] === token))
    return false;
  return subtitleTokens
    .slice(videoTokens.length)
    .every((token) => token in LANGUAGE_TOKENS);
}

function languageOf(
  stem: string,
): { language: string } | Record<string, never> {
  const token = stemTokens(stem)
    .reverse()
    .find((candidate) => candidate in LANGUAGE_TOKENS);
  return token ? { language: LANGUAGE_TOKENS[token] } : {};
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
