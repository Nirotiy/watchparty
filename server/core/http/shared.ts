import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { RoomRegistry } from "../room/registry.ts";
import {
  GuestAccessStore,
  isGuestReadRoute,
} from "../guest-access.ts";
import { ERROR_MESSAGES } from "../protocol.ts";

/** 游客凭据的签发端点与承载头；契约常量与 `web/lib/media-room-access.ts` 对齐。 */
export const GUEST_SESSION_PATH = "/api/media/guest-session";
export const GUEST_HEADER = "x-watchparty-guest";

/** Send the standard error envelope used by every WatchParty HTTP endpoint. */
export function sendError(
  res: Response,
  status: number,
  code: keyof typeof ERROR_MESSAGES,
  detail?: string,
): void {
  res.status(status).json({
    code,
    message: detail
      ? `${ERROR_MESSAGES[code]}: ${detail}`
      : ERROR_MESSAGES[code],
  });
}

/** Media reads carry the room ID and access token in separate headers. */
export function requireRoomAccess(
  req: Request,
  res: Response,
  registry: RoomRegistry,
): boolean {
  const header = req.headers["x-watchparty-room"];
  const roomId = typeof header === "string" && !header.includes(",") ? header.trim() : "";
  if (!roomId) {
    sendError(res, 401, "ACCESS_TOKEN_INVALID");
    return false;
  }
  if (!registry.get(roomId)) {
    sendError(res, 404, "ROOM_NOT_FOUND");
    return false;
  }
  if (!registry.authenticateToken(roomId, bearerToken(req))) {
    sendError(res, 401, "ACCESS_TOKEN_INVALID");
    return false;
  }
  return true;
}

export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * 游客凭据在本次请求上的判定结果。
 * - `none`：游客通道对它没有意见 —— 没有游客头、签发端点本身，或带着房间头
 *   （房间身份优先，既有房内行为逐字节不变，也不会因房间头写错而悄悄降级成游客只读）。
 * - `granted`：凭据有效且落在只读白名单内。
 * - `forbidden`：凭据有效，但要去的不是只读浏览路由。
 * - `malformed` / `unknown` / `expired`：凭据本身不可用，一律 401 让客户端重签。
 */
export type GuestReadOutcome =
  | "none"
  | "granted"
  | "forbidden"
  | "malformed"
  | "unknown"
  | "expired";

export function resolveGuestRead(
  req: Request,
  guests: GuestAccessStore,
): GuestReadOutcome {
  if (req.headers["x-watchparty-room"] !== undefined) return "none";
  // 签发口自己不设防（只有 IP 限速）。否则客户端带着刚过期的头来换新凭据，
  // 会被旧凭据的 401 挡在门外，再也翻不出来。
  if (req.path === GUEST_SESSION_PATH) return "none";
  const header = req.headers[GUEST_HEADER];
  if (header === undefined) return "none";
  // 与 bearerToken 同口径失败关闭：重复头、逗号合并头、空值都不猜。
  if (Array.isArray(header)) return "malformed";
  const token = header.trim();
  if (token === "" || token.includes(",")) return "malformed";
  const state = guests.verify(token);
  if (state !== "valid") return state;
  return isGuestReadRoute(
    req.method,
    req.path,
    typeof req.query.libraryId === "string" && req.query.libraryId !== "",
  )
    ? "granted"
    : "forbidden";
}

function sendGuestFailure(res: Response, outcome: GuestReadOutcome): void {
  if (outcome === "forbidden") {
    sendError(res, 403, "GUEST_FORBIDDEN");
    return;
  }
  sendError(res, 401, outcome === "expired" ? "GUEST_TOKEN_EXPIRED" : "GUEST_TOKEN_INVALID");
}

/**
 * 挂在所有路由之前：带游客凭据的请求只能去只读白名单，其余（写路由、播放路由、
 * 管理路由）在鉴权之前就以 403 拒绝，不会漏进后面的处理器。
 */
export function guestReadGuard(guests: GuestAccessStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const outcome = resolveGuestRead(req, guests);
    if (outcome === "none" || outcome === "granted") {
      next();
      return;
    }
    sendGuestFailure(res, outcome);
  };
}

/**
 * 媒体只读门禁：房内凭据或有效游客凭据都放行。游客侧已由 `guestReadGuard`
 * 校验过，这里再认一次是为了即使漏挂守卫也不会放行（失败关闭）。
 */
export function requireMediaRead(
  req: Request,
  res: Response,
  registry: RoomRegistry,
  guests: GuestAccessStore,
): boolean {
  if (resolveGuestRead(req, guests) === "granted") return true;
  return requireRoomAccess(req, res, registry);
}

/**
 * Room access token extraction with fail-closed precedence.
 *
 * In production the site-level Caddy Basic Auth consumes `Authorization`, so
 * the room token travels in `X-WatchParty-Token`:
 * - When the custom header is present it is used exclusively — an invalid,
 *   empty, duplicated or comma-merged value must never fall through to the
 *   legacy header (fail closed).
 * - The legacy `Authorization: Bearer` path only applies when the custom
 *   header is entirely absent (local / LAN deployments without Caddy).
 */
export function bearerToken(req: Request): string | undefined {
  const siteToken = req.headers["x-watchparty-token"];
  if (siteToken !== undefined) {
    // Repeated headers arrive as an array or a comma-merged string.
    if (Array.isArray(siteToken)) return undefined;
    const value = siteToken.trim();
    if (value === "" || value.includes(",")) return undefined;
    return value;
  }
  const legacy = req.headers.authorization;
  if (typeof legacy !== "string") return undefined;
  const [scheme, token] = legacy.split(" ");
  return scheme === "Bearer" && token ? token : undefined;
}
