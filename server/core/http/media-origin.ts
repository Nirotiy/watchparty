import type { Request } from "express";
import { isLoopbackAddress } from "../../media/library-service.ts";

/** Only a local proxy and an explicitly configured origin may select a media entry point. */
export function mediaForRequest<T extends { url?: string; fallbackUrl?: string }>(
  req: Request, resolved: T, allowedOrigins: readonly string[],
): T {
  const selected = req.headers["x-watchparty-media-origin"];
  if (!isLoopbackAddress(req.socket.remoteAddress) || typeof selected !== "string" || !allowedOrigins.includes(selected)) return resolved;
  const rewrite = (address: string | undefined) => {
    if (!address) return address;
    const original = new URL(address);
    if (!original.pathname.startsWith("/p/") || !allowedOrigins.includes(original.origin)) return address;
    const target = new URL(selected);
    original.protocol = target.protocol;
    original.host = target.host;
    return original.href;
  };
  return {
    ...resolved,
    ...(resolved.url ? { url: rewrite(resolved.url) } : {}),
    ...(resolved.fallbackUrl ? { fallbackUrl: rewrite(resolved.fallbackUrl) } : {}),
  };
}
