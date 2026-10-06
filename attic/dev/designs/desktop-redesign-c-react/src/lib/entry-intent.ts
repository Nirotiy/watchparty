/**
 * 首页统一入口 · 意图识别（纯函数，无 React 依赖，便于单测）
 *
 * 识别规则（设计稿 dev/desktop-redesign-c.html 首页帧）：
 * - watchparty://<roomId> 或 room-xxxx 裸房号 → 加入房间
 * - http(s):// 直链 → http 源；.m3u8 → hls 源；YouTube 链接 → youtube 源（链接开播）
 * - 其余（空串、无法识别文本）→ null（按钮保持默认「加入房间」且禁用）
 */

export type MediaSourceInput =
  | { kind: "http"; url: string }
  | { kind: "hls"; url: string }
  | { kind: "youtube"; videoId: string; url: string }

export type EntryIntent =
  | { kind: "room"; roomId: string }
  | { kind: "media"; source: MediaSourceInput }
  | null

const ROOM_ID_PATTERN = /^room-[a-z0-9-]+$/i
const WATCHPARTY_SCHEME = /^watchparty:\/\//i
const M3U8_PATTERN = /\.m3u8(\?|#|$)/i
const YOUTUBE_PATTERN = /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i

export function classifyEntry(raw: string): EntryIntent {
  const value = raw.trim()
  if (!value) return null

  if (WATCHPARTY_SCHEME.test(value)) {
    const roomId = value.replace(WATCHPARTY_SCHEME, "").replace(/\/+$/, "")
    return roomId ? { kind: "room", roomId } : null
  }

  if (ROOM_ID_PATTERN.test(value)) {
    return { kind: "room", roomId: value.toLowerCase() }
  }

  if (/^https?:\/\//i.test(value)) {
    if (M3U8_PATTERN.test(value)) {
      return { kind: "media", source: { kind: "hls", url: value } }
    }
    const youtube = value.match(YOUTUBE_PATTERN)
    if (youtube?.[1]) {
      return { kind: "media", source: { kind: "youtube", videoId: youtube[1], url: value } }
    }
    return { kind: "media", source: { kind: "http", url: value } }
  }

  return null
}
