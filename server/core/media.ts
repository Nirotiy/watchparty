import { isValidUUID, type MediaSource } from "./protocol.ts";

const HTTPS = /^https:\/\//i;
const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;
const CONTAINERS = new Set(["mp4", "webm", "mkv", "mov", "m4v", "ogv", "m3u8"]);

export function validateMediaSource(value: unknown): MediaSource | undefined {
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
  if (media.kind === "youtube" && typeof media.videoId === "string" && YOUTUBE_ID.test(media.videoId)) {
    return {
      kind: "youtube",
      videoId: media.videoId,
      ...(typeof media.title === "string" ? { title: media.title.slice(0, 500) } : {}),
    };
  }
  return undefined;
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
