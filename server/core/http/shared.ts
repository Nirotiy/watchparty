import type { Request, Response } from "express";
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

export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function bearerToken(req: Request): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== "string") return undefined;
  const [scheme, token] = value.split(" ");
  return scheme === "Bearer" && token ? token : undefined;
}
