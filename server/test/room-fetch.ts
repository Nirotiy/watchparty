import { randomUUID } from "node:crypto";
import type { Backend } from "../app.ts";

const credentials = new WeakMap<Backend, Record<string, string>>();

/** Authenticate fixture media reads as a room member. */
export function roomFetch(backend: Backend, url: string, options: RequestInit = {}): Promise<Response> {
  let headers = credentials.get(backend);
  if (!headers) {
    const created = backend.registry.create({ clientId: randomUUID(), nickname: "Reader" });
    headers = {
      "X-WatchParty-Room": created.room.id,
      "X-WatchParty-Token": created.accessToken,
    };
    credentials.set(backend, headers);
  }
  const requestHeaders = new Headers(options.headers);
  for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
  return fetch(url, { ...options, headers: requestHeaders });
}
