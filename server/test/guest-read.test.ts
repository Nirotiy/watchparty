import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig, type AppConfig } from "../config.ts";
import { type OpenlistClient } from "../media/openlist.ts";
import type { StoredSource } from "../media/library-store.ts";

/**
 * 未入房只读浏览（游客凭据）的服务端验收面：变更单 §4。
 * 房内路径的回归面在 library-sources.test.ts，这里只补游客侧与"两者共存"的边界。
 */

const backends: Backend[] = [];
const FILM = "/media/openlist-bdyun/Multimedia/Film";

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

function origin(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

function config(): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    WATCHPARTY_CATALOG_APPROVAL_SECRET: "",
    OPENLIST_URL: "http://primary.example",
    OPENLIST_USERNAME: "admin",
    OPENLIST_PASSWORD: "seed-secret",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
}

function fakeClient(source: StoredSource): OpenlistClient {
  const host = new URL(source.internalBaseUrl).host;
  return {
    async list() {
      return {
        code: 200,
        data: {
          content: [
            { name: "Same.chs.ass", is_dir: false, size: 4, path: `${FILM}/Same.chs.ass` },
            { name: "Same.mp4", is_dir: false, size: 10, path: `${FILM}/Same.mp4` },
          ],
        },
      };
    },
    async listShallow() {
      return { code: 200, data: { content: [] } };
    },
    async search() {
      return { code: 200, data: { content: [] } };
    },
    async getDownloadInfo() {
      return { url: `http://${host}/p/Same.mp4?sign=1`, size: 10 };
    },
    async getLinkInfo() {
      return null;
    },
    async fetchOriginText() {
      return { status: 200, text: "Dialogue" };
    },
    async ping() {
      return { ok: true };
    },
  };
}

async function boot(options: {
  guestReadTtlMs?: number;
  guestIssueLimitPerMinute?: number;
} = {}): Promise<Backend> {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    config: config(),
    libraryClientFactory: (source) => fakeClient(source),
    bangumi: { async search() { return []; } },
    ...options,
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

async function createRoom(backend: Backend): Promise<{ roomId: string; accessToken: string }> {
  const response = await fetch(`${origin(backend)}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), nickname: "Owner" }),
  });
  assert.equal(response.status, 200);
  return await response.json() as { roomId: string; accessToken: string };
}

async function issue(backend: Backend): Promise<{ token: string; expiresAt: number }> {
  const response = await fetch(`${origin(backend)}/api/media/guest-session`, { method: "POST" });
  assert.equal(response.status, 200);
  return await response.json() as { token: string; expiresAt: number };
}

function guestHeaders(token: string): Record<string, string> {
  return { "x-watchparty-guest": token };
}

const READ_WHITELIST = [
  "/api/media/capabilities",
  "/api/media/libraries",
  "/api/media/list?libraryId=lib_film",
  "/api/media/list?libraryId=lib_film&path=/",
  "/api/media/search?q=show&libraryId=lib_film",
  "/api/media/catalog?libraryId=lib_film",
  "/api/media/catalog/missing",
  "/api/media/posters/missing",
  "/api/media/artwork/missing",
];

const DENIED_FOR_GUEST = [
  // 写路由
  ["POST", "/api/media/catalog/missing/confirm"],
  ["POST", "/api/media/catalog/missing/reject"],
  ["POST", "/api/media/catalog/merge"],
  ["POST", "/api/admin/media-libraries/lib_film/draft/edit"],
  ["POST", "/api/admin/media-libraries/lib_film/apply"],
  ["GET", "/api/admin/media-libraries/lib_film/exclusions"],
  ["POST", "/api/rooms"],
  ["POST", "/api/rooms/room-0000000000000000/handoff"],
  // 播放相关：字节解析与字幕都要房间身份
  ["POST", "/api/rooms/room-0000000000000000/media/resolve"],
  ["GET", "/api/rooms/room-0000000000000000/media/subtitle?mediaId=x"],
  ["GET", "/api/rooms/room-0000000000000000/media/subtitles?mediaId=x"],
  // 管理面与 legacy 单源浏览器（roots 未开，root= 列表同理）
  ["GET", "/api/admin/media-sources"],
  ["GET", "/api/media/roots"],
  ["GET", "/api/media/list?root=Anime"],
  ["GET", "/api/media/search?q=show&root=Anime"],
  ["GET", "/api/media/bangumi/search?q=Medalist"],
];

test("guest session signs a short-lived read credential", async () => {
  const backend = await boot({ guestReadTtlMs: 60_000 });
  const issued = await issue(backend);
  assert.equal(typeof issued.token, "string");
  assert.ok(issued.token.length >= 32);
  assert.equal(typeof issued.expiresAt, "number");
  const left = issued.expiresAt - Date.now();
  assert.ok(left > 0 && left <= 60_000, `ttl out of range: ${left}`);
  // 并发/重复签发允许，每次都是新凭据。
  const second = await issue(backend);
  assert.notEqual(second.token, issued.token);
});

test("guest credential opens every whitelisted read with room parity", async () => {
  const backend = await boot();
  const base = origin(backend);
  const room = await createRoom(backend);
  const roomHeaders = { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken };
  const token = (await issue(backend)).token;
  for (const pathname of READ_WHITELIST) {
    const guest = await fetch(`${base}${pathname}`, { headers: guestHeaders(token) });
    const member = await fetch(`${base}${pathname}`, { headers: roomHeaders });
    assert.equal(guest.status, member.status, pathname);
    assert.ok(guest.status !== 401 && guest.status !== 403, `${pathname} -> ${guest.status}`);
    assert.deepEqual(await guest.json(), await member.json(), pathname);
  }
  for (const pathname of ["/api/media/libraries", "/api/media/list?libraryId=lib_film", "/api/media/search?q=show&libraryId=lib_film", "/api/media/catalog?libraryId=lib_film"]) {
    assert.equal((await fetch(`${base}${pathname}`, { headers: guestHeaders(token) })).status, 200, pathname);
  }
  // 分页 cursor 与排序是同一套处理器，游客拿到的一模一样。
  const page = await (await fetch(`${base}/api/media/list?libraryId=lib_film`, { headers: guestHeaders(token) })).json() as { items: Array<{ name: string }> };
  assert.deepEqual(page.items.map((item) => item.name), ["Same.chs.ass", "Same.mp4"]);
});

test("whitelisted guest reads never redirect", async () => {
  const backend = await boot();
  const token = (await issue(backend)).token;
  // 客户端把媒体读取设成 redirect:"error"，任何 3xx 都会变成抛错。
  for (const pathname of ["/api/media/libraries", "/api/media/list?libraryId=lib_film", "/api/media/posters/missing"]) {
    const response = await fetch(`${origin(backend)}${pathname}`, {
      headers: guestHeaders(token),
      redirect: "error",
    });
    assert.equal(response.status, pathname === "/api/media/posters/missing" ? 404 : 200, pathname);
  }
});

test("guest credential is refused on write, playback and admin routes", async () => {
  const backend = await boot();
  const base = origin(backend);
  const token = (await issue(backend)).token;
  for (const [method, pathname] of DENIED_FOR_GUEST) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...guestHeaders(token), ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 403, `${method} ${pathname} -> ${response.status} ${body.code}`);
    assert.equal(body.code, "GUEST_FORBIDDEN", `${method} ${pathname}`);
  }
});

test("missing, malformed and unknown credentials stay fail-closed", async () => {
  const backend = await boot();
  const base = origin(backend);
  const token = (await issue(backend)).token;
  // 无凭据：现状不变（不是 403，也不给游客放行）。
  const anonymous = await fetch(`${base}/api/media/libraries`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { code: string }).code, "ACCESS_TOKEN_INVALID");
  const forged = await fetch(`${base}/api/media/libraries`, { headers: guestHeaders("never-issued") });
  assert.equal(forged.status, 401);
  assert.equal((await forged.json() as { code: string }).code, "GUEST_TOKEN_INVALID");
  for (const value of ["", "   ", `${token}, ${token}`, "a,b"]) {
    const bad = await fetch(`${base}/api/media/libraries`, { headers: guestHeaders(value) });
    assert.equal(bad.status, 401, JSON.stringify(value));
    assert.equal((await bad.json() as { code: string }).code, "GUEST_TOKEN_INVALID", JSON.stringify(value));
  }
  // 游客头不能用作房间凭据。
  const playback = await fetch(`${base}/api/rooms/x/media/resolve`, {
    method: "POST",
    headers: { ...guestHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ mediaId: "v2.x" }),
  });
  assert.equal(playback.status, 403);
});

test("expired guest credential returns 401 so the client can re-sign", async () => {
  const backend = await boot({ guestReadTtlMs: 250 });
  const base = origin(backend);
  const token = (await issue(backend)).token;
  assert.equal((await fetch(`${base}/api/media/libraries`, { headers: guestHeaders(token) })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const expired = await fetch(`${base}/api/media/libraries`, { headers: guestHeaders(token) });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json() as { code: string }).code, "GUEST_TOKEN_EXPIRED");
  // 过期只影响旧凭据：重签后照样能读。
  assert.equal((await fetch(`${base}/api/media/libraries`, { headers: guestHeaders((await issue(backend)).token) })).status, 200);
});

test("guest signing is rate limited per caller", async () => {
  const backend = await boot({ guestIssueLimitPerMinute: 3 });
  const base = origin(backend);
  const held = await issue(backend);
  assert.equal((await fetch(`${base}/api/media/guest-session`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/api/media/guest-session`, { method: "POST" })).status, 200);
  const limited = await fetch(`${base}/api/media/guest-session`, { method: "POST" });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "GUEST_RATE_LIMITED");
  // 限速只掐签发口；已经到手的凭据不受影响。
  assert.equal((await fetch(`${base}/api/media/libraries`, { headers: guestHeaders(held.token) })).status, 200);
});

test("room identity wins when both credentials are presented", async () => {
  const backend = await boot();
  const base = origin(backend);
  const room = await createRoom(backend);
  const roomHeaders = { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken };
  const token = (await issue(backend)).token;
  // 房内读取带着有效房间凭据：游客头是噪声，行为逐字节不变。
  const withGuest = await fetch(`${base}/api/media/libraries`, { headers: { ...roomHeaders, ...guestHeaders("junk") } });
  assert.equal(withGuest.status, 200);
  assert.deepEqual(await withGuest.json(), await (await fetch(`${base}/api/media/libraries`, { headers: roomHeaders })).json());
  // 房间凭据坏了不会悄悄降级成游客只读。
  const brokenRoom = await fetch(`${base}/api/media/libraries`, {
    headers: { "x-watchparty-room": room.roomId, "x-watchparty-token": "wrong", ...guestHeaders(token) },
  });
  assert.equal(brokenRoom.status, 401);
  assert.equal((await brokenRoom.json() as { code: string }).code, "ACCESS_TOKEN_INVALID");
  // 房内路径（读、写、播放）带不带游客头都必须逐字节一致 —— 这是"零改动"的正面断言。
  const roomRoutes: Array<[string, string, string | undefined]> = [
    ["GET", "/api/media/libraries", undefined],
    ["POST", "/api/media/catalog/missing/confirm", JSON.stringify({ candidateId: "c" })],
    ["POST", `/api/rooms/${room.roomId}/media/resolve`, JSON.stringify({ mediaId: "v2.missing" })],
    ["GET", `/api/rooms/${room.roomId}/media/subtitles?mediaId=v2.missing`, undefined],
  ];
  for (const [method, pathname, body] of roomRoutes) {
    const headers = { ...roomHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const plain = await fetch(`${base}${pathname}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const mixed = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...headers, ...guestHeaders(token) },
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(mixed.status, plain.status, `${method} ${pathname}`);
    assert.deepEqual(await mixed.json(), await plain.json(), `${method} ${pathname}`);
  }
});
