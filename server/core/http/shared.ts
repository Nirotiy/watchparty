import type { Request, Response } from "express";
import type { RoomRegistry } from "../room/registry.ts";
import { ERROR_MESSAGES } from "../protocol.ts";

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
