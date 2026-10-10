import { isValidUUID, type MediaSource } from "./protocol.ts";

const HTTPS = /^https:\/\//i;
const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
// `strm` is a one-line pointer, not a container: the peer resolves it server-side and
// plays whatever URL comes back, so the id still identifies the library file.
const CONTAINERS = new Set(["mp4", "webm", "mkv", "mov", "m4v", "ogv", "m3u8", "strm"]);

export function validateMediaSource(value: unknown): MediaSource | undefined {
  if (typeof value === "string") return normalizeYouTubeSource(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const media = value as Record<string, unknown>;
  if (media.kind === "openlist") {
    if (
      typeof media.mediaId !== "string" ||
      !media.mediaId ||
      media.mediaId.includes("/") ||
      media.mediaId.includes("\\") ||
      typeof media.title !== "string" ||
      !media.title ||
      typeof media.container !== "string" ||
      !CONTAINERS.has(media.container.toLowerCase())
    ) return undefined;
    return {
      kind: "openlist",
      mediaId: media.mediaId,
      title: media.title.slice(0, 500),
      container: media.container.toLowerCase(),
      ...(typeof media.displayPath === "string" ? { displayPath: media.displayPath.slice(0, 1000) } : {}),
    };
  }
  if (media.kind === "http" || media.kind === "hls") {
    if (typeof media.url !== "string" || media.url.length > 4000 || !HTTPS.test(media.url)) return undefined;
    try {
      const url = new URL(media.url);
      if (url.username || url.password) return undefined;
      if (media.kind === "hls" && !url.pathname.toLowerCase().endsWith(".m3u8")) return undefined;
    } catch {
      return undefined;
    }
    return {
      kind: media.kind,
      url: media.url.slice(0, 4000),
      ...(typeof media.title === "string" ? { title: media.title.slice(0, 500) } : {}),
    };
  }
  if (media.kind === "youtube") return normalizeYouTubeSource(media);
  return undefined;
}

/** Normalize a browser-facing YouTube source without retaining URL credentials or query data. */
export function normalizeYouTubeSource(value: unknown): MediaSource | undefined {
  if (typeof value === "string") return youtubeSourceFromIdOrUrl(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const raw = typeof source.videoId === "string"
    ? source.videoId
    : typeof source.url === "string" ? source.url : undefined;
  const videoId = raw === undefined ? undefined : youtubeVideoId(raw);
  if (!videoId) return undefined;
  return {
    kind: "youtube",
    videoId,
    ...(typeof source.title === "string" && source.title.length > 0
      ? { title: source.title.slice(0, 500) }
      : {}),
  };
}

function youtubeSourceFromIdOrUrl(value: string): MediaSource | undefined {
  const videoId = youtubeVideoId(value);
  return videoId ? { kind: "youtube", videoId } : undefined;
}

function youtubeVideoId(value: string): string | undefined {
  const candidate = value.trim();
  if (YOUTUBE_ID.test(candidate)) return candidate;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 && YOUTUBE_ID.test(parts[0]!) ? parts[0] : undefined;
  }
  if (!YOUTUBE_HOSTS.has(host) || url.pathname !== "/watch") return undefined;
  const videoId = url.searchParams.get("v");
  return videoId && YOUTUBE_ID.test(videoId) ? videoId : undefined;
}

export function validateNickname(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 24;
}

export function validateRoomId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{2,80}$/i.test(value);
}

export function validateRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPlayableContainer(container: string): boolean {
  return ["mp4", "webm", "mov", "m4v", "ogv"].includes(container.toLowerCase());
}

export { isValidUUID };
