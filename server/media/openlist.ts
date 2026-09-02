import type { AppConfig } from "../config.ts";

export type OpenlistErrorCode = "OPENLIST_AUTH_FAILED" | "OPENLIST_UNAVAILABLE" | "OPENLIST_BAD_RESPONSE";

export class OpenlistServiceError extends Error {
  readonly code: OpenlistErrorCode;
  readonly status: 502 | 503;

  constructor(code: OpenlistErrorCode, message: string, status: 502 | 503) {
    super(message);
    this.name = "OpenlistServiceError";
    this.code = code;
    this.status = status;
  }
}

export type OpenlistResponse = { code: number; message?: string; data?: Record<string, unknown> };
export type OpenlistDownloadInfo = { url: string; size: number | null };

export type OpenlistClient = {
  list(path: string): Promise<OpenlistResponse>;
  search(keywords: string, parent?: string): Promise<OpenlistResponse>;
  getDownloadInfo(path: string): Promise<OpenlistDownloadInfo | null>;
  /**
   * Fetch text from a URL hosted on the configured OpenList origin only
   * (SSRF guard), aborting once the body exceeds capBytes. Returns undefined
   * when the body exceeds the cap.
   */
  fetchOriginText(url: string, capBytes: number): Promise<{ status: number; text: string } | undefined>;
};

/**
 * Upper bound on entries fetched per directory/search request. Matches
 * MAX_DIRECTORY_ENTRIES in watchparty-media.ts: the response body (and its
 * memory footprint) is bounded before WatchParty sorts or pages it.
 */
const OPENLIST_PAGE_SIZE = 2000;

/**
 * Minimal OpenList HTTP client over native fetch: login-once session with a
 * single transparent refresh when OpenList reports an expired token.
 */
export function createOpenlistClient(cfg: AppConfig): OpenlistClient {
  const baseUrl = cfg.openlistUrl.replace(/\/+$/, "");
  let token = "";
  let loginPromise: Promise<string> | null = null;

  async function authenticate(): Promise<string> {
    const data = await postJson("/api/auth/login", {
      username: cfg.openlistUsername,
      password: cfg.openlistPassword,
    }, false);
    const issued = data.data?.token;
    if (data.code !== 200 || typeof issued !== "string" || !issued) {
      throw new OpenlistServiceError("OPENLIST_AUTH_FAILED", "Openlist authentication failed", 502);
    }
    return issued;
  }

  async function ensureToken(): Promise<string> {
    if (token) return token;
    loginPromise ??= authenticate().finally(() => {
      loginPromise = null;
    });
    token = await loginPromise;
    return token;
  }

  async function postJson(apiPath: string, body: unknown, authenticated: boolean): Promise<OpenlistResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authenticated) headers.authorization = await ensureToken();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${apiPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.openlistRequestTimeoutMs),
      });
    } catch {
      throw new OpenlistServiceError("OPENLIST_UNAVAILABLE", "Openlist request failed", 503);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new OpenlistServiceError("OPENLIST_BAD_RESPONSE", "Openlist returned a non-JSON response", 502);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined;
    if (!record || typeof record.code !== "number") {
      throw new OpenlistServiceError("OPENLIST_BAD_RESPONSE", "Openlist returned an invalid payload", 502);
    }
    return {
      code: record.code,
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? { data: record.data as Record<string, unknown> }
        : {}),
    };
  }

  function isExpired(data: OpenlistResponse): boolean {
    return data.code === 401 || data.message?.trim().toLowerCase() === "token is expired";
  }

  async function request(apiPath: string, body: unknown): Promise<OpenlistResponse> {
    let data = await postJson(apiPath, body, true);
    if (!isExpired(data)) return data;
    token = "";
    data = await postJson(apiPath, body, true);
    if (isExpired(data)) {
      throw new OpenlistServiceError("OPENLIST_AUTH_FAILED", "Openlist authentication expired after refresh", 502);
    }
    return data;
  }

  return {
    list: (mediaPath) => request("/api/fs/list", {
      path: mediaPath,
      password: "",
      page: 1,
      per_page: OPENLIST_PAGE_SIZE,
      refresh: false,
    }),
    search: (keywords, parent) => request("/api/fs/search", {
      keywords,
      parent: parent || "/",
      scope: parent || "/",
      page: 1,
      per_page: OPENLIST_PAGE_SIZE,
    }),
    getDownloadInfo: async (mediaPath) => {
      const data = await request("/api/fs/get", { path: mediaPath, password: "" });
      if (data.code !== 200) return null;
      const rawUrl = data.data?.raw_url;
      const rawSize = data.data?.size;
      const size = typeof rawSize === "number"
        ? rawSize
        : typeof rawSize === "string" ? Number(rawSize) : Number.NaN;
      return typeof rawUrl === "string"
        ? { url: rawUrl, size: Number.isSafeInteger(size) && size >= 0 ? size : null }
        : null;
    },
    fetchOriginText: async (url, capBytes) => {
      let target: URL;
      let origin: URL;
      try {
        target = new URL(url);
        origin = new URL(baseUrl);
      } catch {
        throw new OpenlistServiceError("OPENLIST_BAD_RESPONSE", "Openlist returned an invalid media URL", 502);
      }
      if (target.origin !== origin.origin) {
        throw new OpenlistServiceError("OPENLIST_BAD_RESPONSE", "Media URL is outside the OpenList origin", 502);
      }
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(cfg.openlistRequestTimeoutMs) });
      } catch {
        throw new OpenlistServiceError("OPENLIST_UNAVAILABLE", "Openlist media request failed", 503);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > capBytes) return undefined;
      if (!response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > capBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, text: new TextDecoder().decode(merged) };
    },
  };
}
