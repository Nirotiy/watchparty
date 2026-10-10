/**
 * YouTube 契约（后端 protocol.ts YOUTUBE_PLAYBACK_CAPABILITIES 的浏览器侧镜像）。
 * 消息逐字对齐契约；IFrame 错误无法可靠区分地区限制或网络故障，未知码一律 UNKNOWN。
 */

export type YouTubeErrorCode =
  | "YOUTUBE_INVALID_VIDEO"
  | "YOUTUBE_PLAYBACK_FAILED"
  | "YOUTUBE_VIDEO_UNAVAILABLE"
  | "YOUTUBE_EMBED_FORBIDDEN"
  | "YOUTUBE_CLIENT_IDENTITY_REQUIRED"
  | "YOUTUBE_API_UNAVAILABLE"
  | "YOUTUBE_CONTROL_UNAVAILABLE"
  | "YOUTUBE_UNKNOWN_ERROR";

export const YOUTUBE_ERROR_MESSAGES: Record<YouTubeErrorCode, string> = {
  YOUTUBE_INVALID_VIDEO: "YouTube 视频标识无效",
  YOUTUBE_PLAYBACK_FAILED: "YouTube 播放失败",
  YOUTUBE_VIDEO_UNAVAILABLE: "YouTube 视频不存在、已移除或为私密视频",
  YOUTUBE_EMBED_FORBIDDEN: "该 YouTube 视频不允许嵌入播放",
  YOUTUBE_CLIENT_IDENTITY_REQUIRED: "YouTube 无法确认嵌入客户端身份",
  YOUTUBE_API_UNAVAILABLE: "YouTube 播放器接口加载失败，请检查浏览器网络或代理",
  YOUTUBE_CONTROL_UNAVAILABLE: "YouTube 播放器控制暂不可用",
  YOUTUBE_UNKNOWN_ERROR: "YouTube 播放器发生未知错误",
};

/** IFrame 错误码 → 契约错误码（2/5/100/101/150/153；其他一律 UNKNOWN，不臆断原因）。 */
export function youtubeErrorCode(data: unknown): YouTubeErrorCode {
  const code = typeof data === "number" && Number.isFinite(data) ? data : undefined;
  if (code === 2) return "YOUTUBE_INVALID_VIDEO";
  if (code === 5) return "YOUTUBE_PLAYBACK_FAILED";
  if (code === 100) return "YOUTUBE_VIDEO_UNAVAILABLE";
  if (code === 101 || code === 150) return "YOUTUBE_EMBED_FORBIDDEN";
  if (code === 153) return "YOUTUBE_CLIENT_IDENTITY_REQUIRED";
  return "YOUTUBE_UNKNOWN_ERROR";
}

export function youtubeErrorMessage(code: YouTubeErrorCode): string {
  return YOUTUBE_ERROR_MESSAGES[code];
}

const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

export type YouTubeInput =
  | { kind: "video"; videoId: string }
  /** youtube 域名但没有可播放的单视频标识：shorts/embed/playlist/channel 等后端已拒绝的形态。 */
  | { kind: "unsupported"; reason: string };

/**
 * 浏览器侧输入分类，规则镜像后端 media.ts normalizeYouTubeSource：
 * 裸 11 位 ID、https watch?v=、https youtu.be 单视频；shorts/embed/playlist/channel 与
 * 非 https 链接判为 unsupported；非 youtube 输入返回 null（交给直链/HLS 识别）。
 */
export function classifyYouTubeInput(raw: string): YouTubeInput | null {
  const candidate = raw.trim();
  if (!candidate) return null;
  if (YOUTUBE_ID.test(candidate)) return { kind: "video", videoId: candidate };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "youtu.be" && !YOUTUBE_HOSTS.has(host)) return null;
  if (url.protocol !== "https:" || url.username || url.password) {
    return { kind: "unsupported", reason: "仅支持 https 链接" };
  }
  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 && YOUTUBE_ID.test(parts[0]!)
      ? { kind: "video", videoId: parts[0]! }
      : { kind: "unsupported", reason: "仅支持单个视频的分享短链（youtu.be/<ID>）" };
  }
  const path = url.pathname;
  if (path === "/watch") {
    const videoId = url.searchParams.get("v");
    return videoId && YOUTUBE_ID.test(videoId)
      ? { kind: "video", videoId }
      : { kind: "unsupported", reason: "缺少有效的 11 位视频标识（v=…）" };
  }
  if (path.startsWith("/shorts/")) return { kind: "unsupported", reason: "暂不支持 Shorts 链接" };
  if (path.startsWith("/embed/")) return { kind: "unsupported", reason: "暂不支持 embed 链接" };
  if (path.startsWith("/playlist")) return { kind: "unsupported", reason: "暂不支持播放列表链接" };
  if (path.startsWith("/channel") || path.startsWith("/c/") || path.startsWith("/@")) {
    return { kind: "unsupported", reason: "暂不支持频道链接" };
  }
  return { kind: "unsupported", reason: "仅支持单个视频链接（watch?v=… 或 youtu.be）" };
}
