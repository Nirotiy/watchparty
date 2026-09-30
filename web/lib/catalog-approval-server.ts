import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import path from "node:path";

interface ApprovalConfig {
  backendOrigin: string;
  frontendOrigin: string;
  username: string;
  passwordHash: string;
  secret: string;
  adminToken?: string;
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && /^[\x21-\x7e]{1,4096}$/.test(secret);
}

function configPath(): string {
  // Only the file path may be set in the environment. Secret values stay in the server file.
  return process.env.WATCHPARTY_APPROVAL_CONFIG_FILE ?? path.join(process.cwd(), "data", "catalog-approval.json");
}

async function loadConfig(): Promise<ApprovalConfig> {
  const value: unknown = JSON.parse(await readFile(configPath(), "utf8"));
  if (typeof value !== "object" || value === null || !("backendOrigin" in value) || typeof value.backendOrigin !== "string"
    || !("frontendOrigin" in value) || typeof value.frontendOrigin !== "string"
    || !("username" in value) || typeof value.username !== "string" || !value.username || value.username.includes(":")
    || !("passwordHash" in value) || typeof value.passwordHash !== "string" || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(value.passwordHash)
    || !("secret" in value) || (value.secret !== "" && !validSecret(value.secret))
    || ("adminToken" in value && !validSecret(value.adminToken))) throw new Error("invalid approval configuration");
  for (const address of [value.backendOrigin, value.frontendOrigin]) {
    const origin = new URL(address);
    if (origin.username || origin.password || origin.origin !== address
      || !(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) {
      throw new Error("invalid approval origin");
    }
  }
  return value as ApprovalConfig;
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, "hex"), 64, (error, key) => error ? reject(error) : resolve(key)));
}

function failure(code: string, status: number, challenge = false): Response {
  return Response.json({ code }, { status, headers: {
    "Cache-Control": "no-store",
    ...(challenge ? { "WWW-Authenticate": 'Basic realm="WatchParty Catalog Approval", charset="UTF-8"' } : {}),
  } });
}

/** Independent human authentication. Backend admin tokens and MCP tool access cannot sign approvals here. */
async function authorize(request: Request): Promise<ApprovalConfig | Response> {
  let config: ApprovalConfig;
  try { config = await loadConfig(); } catch { return failure("APPROVAL_CONFIG_UNAVAILABLE", 503); }
  const header = request.headers.get("authorization") ?? "";
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header) || header.length > 8192) return failure("APPROVAL_ADMIN_REQUIRED", 401, true);
  const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  if (separator < 1) return failure("APPROVAL_ADMIN_REQUIRED", 401, true);
  const [salt, expected] = config.passwordHash.split(":");
  const actual = await derive(credentials.slice(separator + 1), salt);
  if (!timingSafeEqual(actual, Buffer.from(expected, "hex")) || credentials.slice(0, separator) !== config.username) {
    return failure("APPROVAL_ADMIN_REQUIRED", 401, true);
  }
  if (request.method !== "GET" && request.headers.get("origin") !== config.frontendOrigin) {
    return failure("APPROVAL_ORIGIN_DENIED", 403);
  }
  return config;
}

function status(config: ApprovalConfig): Response {
  return Response.json({ configured: config.secret !== "", mask: config.secret ? "••••••••" : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function approvalSettings(request: Request): Promise<Response> {
  try {
    const config = await authorize(request);
    if (config instanceof Response) return config;
    if (request.method === "GET") return status(config);
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", 405);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return failure("APPROVAL_INPUT_INVALID", 400);
    const input: unknown = await request.json().catch(() => null);
    if (typeof input !== "object" || input === null || Object.keys(input).length !== 1 || !("secret" in input) || !validSecret(input.secret)) {
      return failure("APPROVAL_INPUT_INVALID", 400);
    }
    const updated = { ...config, secret: input.secret };
    const target = configPath();
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(updated), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
    return status(updated);
  } catch { return failure("APPROVAL_SETTINGS_FAILED", 500); }
}

export async function issueApproval(request: Request, libraryId: string): Promise<Response> {
  try {
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", 405);
    const config = await authorize(request);
    if (config instanceof Response) return config;
    if (!config.secret) return failure("APPROVAL_SECRET_MISSING", 503);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(libraryId) || !request.headers.get("content-type")?.startsWith("application/json")) {
      return failure("APPROVAL_INPUT_INVALID", 400);
    }
    const input: unknown = await request.json().catch(() => null);
    if (typeof input !== "object" || input === null || Array.isArray(input)
      || Object.keys(input).some(key => !["approvedBy", "rollbackOf"].includes(key))
      || ("rollbackOf" in input && (typeof input.rollbackOf !== "string" || input.rollbackOf.length > 200))) {
      return failure("APPROVAL_INPUT_INVALID", 400);
    }
    const response = await fetch(`${config.backendOrigin}/api/admin/media-libraries/${encodeURIComponent(libraryId)}/approval`, {
      method: "POST", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "x-watchparty-approval": config.secret,
        ...(config.adminToken ? { "x-watchparty-admin": config.adminToken } : {}) },
      body: JSON.stringify({ ...( "rollbackOf" in input ? { rollbackOf: input.rollbackOf } : {}), approvedBy: "网页" }),
    });
    if (response.status >= 300 && response.status < 400) return failure("APPROVAL_UPSTREAM_REDIRECT", 502);
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch { return failure("APPROVAL_UPSTREAM_UNAVAILABLE", 502); }
}
