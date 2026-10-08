/**
 * 媒体读取凭据（客户端侧）：房内＝房间身份；房外＝游客凭据（只读、一次性签发）。
 * 服务端契约草案见 temp-html/guest-read-contract-request-2026-10-08.md；
 * 未落地前房外请求回落到 ROOM_ACCESS_REQUIRED（与旧行为同文案），落地即通。
 */

const GUEST_SESSION_PATH = "/api/media/guest-session";
const GUEST_HEADER = "X-WatchParty-Guest";
const GUEST_RENEW_MARGIN_MS = 5_000;
const GUEST_FALLBACK_TTL_MS = 10 * 60_000;

interface GuestCredential {
  token: string;
  expiresAt: number;
}

let guestCredential: GuestCredential | null = null;
let guestPending: Promise<GuestCredential> | null = null;

/** 房间上下文下的读取头（页面在 /room/<id> 且本机有 token）；不在房内返回 null。 */
export function roomMediaHeaders(): Record<string, string> | null {
  const match = typeof window !== "undefined" ? window.location.pathname.match(/^\/room\/([^/]+)\/?$/) : null;
  const roomId = match ? decodeURIComponent(match[1]) : undefined;
  const token = roomId ? localStorage.getItem(`token_${roomId}`) : null;
  if (!roomId || !token) return null;
  return { "X-WatchParty-Room": roomId, "X-WatchParty-Token": token };
}

function roomAccessError(): Error {
  return Object.assign(new Error("请先加入房间再浏览媒体库"), { code: "ROOM_ACCESS_REQUIRED" });
}

function guestUnavailableError(): Error {
  return Object.assign(new Error("暂时无法读取媒体库"), { code: "GUEST_READ_UNAVAILABLE" });
}

async function issueGuestCredential(): Promise<GuestCredential> {
  let response: Response;
  try {
    response = await fetch(GUEST_SESSION_PATH, { method: "POST" });
  } catch {
    throw guestUnavailableError();
  }
  // 404/405：服务端尚未启用游客凭据（契约未落地）→ 保持旧文案与旧语义。
  if (response.status === 404 || response.status === 405) throw roomAccessError();
  if (!response.ok) throw guestUnavailableError();
  const body = await response.json() as { token?: unknown; expiresAt?: unknown };
  if (typeof body.token !== "string" || !body.token) throw guestUnavailableError();
  return {
    token: body.token,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now() + GUEST_FALLBACK_TTL_MS,
  };
}

/** 媒体只读请求头：房内 → 房间头；房外 → 游客凭据（懒签发、内存缓存、并发去重、到期重签）。 */
export async function mediaReadHeaders(): Promise<Record<string, string>> {
  const room = roomMediaHeaders();
  if (room) return room;
  const now = Date.now();
  if (!guestCredential || guestCredential.expiresAt <= now + GUEST_RENEW_MARGIN_MS) {
    guestPending ??= issueGuestCredential().finally(() => {
      guestPending = null;
    });
    guestCredential = await guestPending;
  }
  return { [GUEST_HEADER]: guestCredential.token };
}

/** 收到 401 后作废游客凭据，让下一次请求重签；房间头不受影响。 */
export function invalidateGuestCredential() {
  guestCredential = null;
}
