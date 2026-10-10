import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig, type AppConfig } from "../config.ts";
import { OpenlistServiceError, type OpenlistClient } from "../media/openlist.ts";
import type { StoredSource } from "../media/library-store.ts";
import { YOUTUBE_PLAYBACK_CAPABILITIES } from "../core/protocol.ts";

const backends: Backend[] = [];
const FILM = "/media/openlist-bdyun/Multimedia/Film";

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

function origin(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

function config(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    WATCHPARTY_CATALOG_APPROVAL_SECRET: "",
    OPENLIST_URL: "http://primary.example",
    OPENLIST_USERNAME: "admin",
    OPENLIST_PASSWORD: "seed-secret",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
    ...extra,
  });
}

function fakeClient(source: StoredSource, behavior: { shallowCode?: number; auth?: boolean } = {}): OpenlistClient {
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
      if (behavior.auth) throw new OpenlistServiceError("OPENLIST_AUTH_FAILED", "denied", 502);
      return { code: behavior.shallowCode ?? 200, data: { content: [] } };
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
  cfg?: AppConfig;
  factoryBehavior?: { shallowCode?: number; auth?: boolean };
  trustLoopback?: boolean;
  adminToken?: string;
} = {}): Promise<Backend> {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    config: options.cfg ?? config(),
    libraryClientFactory: (source) => fakeClient(source, options.factoryBehavior),
    bangumi: { async search() { return []; } },
    ...(options.trustLoopback === undefined ? {} : { trustLibraryAdminLoopback: options.trustLoopback }),
    ...(options.adminToken ? { libraryAdminToken: options.adminToken } : {}),
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

const secondBody = {
  name: "Second",
  internalBaseUrl: "http://second.example",
  username: "alice",
  password: "sekret-value",
  libraries: [{ name: "Film", kind: "movie", path: FILM }],
};

test("Next MKV list and resolve keep room authentication and desktop compatibility", async () => {
  const backend = createBackend({
    host: "127.0.0.1", port: 0, pruneIntervalMs: 0, config: config(),
    libraryClientFactory: (source) => ({
      ...fakeClient(source),
      async list() { return { code: 200, data: { content: [
        { name: "Movie.mkv", is_dir: false, size: 42, path: `${FILM}/Movie.mkv` },
      ] } }; },
      async getDownloadInfo() { return { url: "https://cdn.example/Movie.mkv", size: 42 }; },
    }),
  });
  await backend.start();
  backends.push(backend);
  const base = origin(backend);
  const room = await createRoom(backend);
  const page = await (await fetch(`${base}/api/media/list?libraryId=lib_film`, {
    headers: { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken },
  })).json() as { items: Array<{ id: string; compatibility: { browser: string; desktop: string } }> };
  const item = page.items[0]!;
  assert.equal(item.compatibility.browser, "maybe");
  assert.equal(item.compatibility.desktop, "supported");
  const resolve = (mediaId: string, token?: string) => fetch(`${base}/api/rooms/${room.roomId}/media/resolve`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-watchparty-token": token } : {}) },
    body: JSON.stringify({ mediaId }),
  });
  assert.equal((await resolve(item.id)).status, 401);
  assert.equal((await resolve(`${item.id}forged`, room.accessToken)).status, 404);
  const response = await resolve(item.id, room.accessToken);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://cdn.example/Movie.mkv", size: 42, mime: "video/x-matroska", requiresCustomHeaders: false,
  });
});

test("seeded libraries stay free of secrets and absolute browse paths", async () => {
  const backend = await boot();
  const base = origin(backend);
  const room = await createRoom(backend);
  const roomHeaders = { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken };
  const capabilities = await (await fetch(`${base}/api/media/capabilities`)).json() as { libraries: boolean; artwork: boolean; catalog: boolean; mediaAdmin: boolean; catalogApproval: string };
  // catalogApproval 如实报边界强度：没配第二把密钥就是 loopback-admin（软边界）。
  assert.deepEqual(capabilities, { libraries: true, artwork: true, catalog: true, mediaAdmin: true, catalogApproval: "loopback-admin", platforms: { youtube: YOUTUBE_PLAYBACK_CAPABILITIES } });
  const listed = await (await fetch(`${base}/api/media/libraries`, { headers: roomHeaders })).json() as { libraries: Array<{ id: string; name: string; kind: string; sourceId: string; health: string }> };
  assert.deepEqual(listed.libraries.map((library) => [library.id, library.name, library.kind, library.sourceId, library.health]), [
    ["lib_anime", "Anime", "anime", "src_default", "ok"],
    ["lib_film", "Film", "movie", "src_default", "ok"],
    ["lib_tv", "TV Shows", "tv", "src_default", "ok"],
  ]);
  assert.equal(JSON.stringify(listed).includes("openlist-bdyun"), false);
  assert.equal(JSON.stringify(listed).includes("seed-secret"), false);
  const admin = await (await fetch(`${base}/api/admin/media-sources`)).json() as { sources: Array<{ id: string; passwordSet: boolean; libraries: unknown[] }> };
  assert.equal(admin.sources.length, 1);
  assert.equal(admin.sources[0]?.id, "src_default");
  assert.equal(admin.sources[0]?.passwordSet, true);
  assert.equal(JSON.stringify(admin).includes("seed-secret"), false);
  const page = await (await fetch(`${base}/api/media/list?libraryId=lib_film`, { headers: roomHeaders })).json() as { libraryId: string; items: Array<{ name: string; id: string; relativePath: string; isDirectory: boolean }> };
  const video = page.items.find((item) => item.name === "Same.mp4");
  assert.ok(video);
  assert.equal(video.relativePath, "/Same.mp4");
  assert.equal(video.isDirectory, false);
  assert.equal(video.id.startsWith("v2."), true);
  assert.equal(JSON.stringify(page).includes("openlist-bdyun"), false);
  assert.equal(JSON.stringify(page).includes("seed-secret"), false);
});

test("two sources with the same path mint different ids and resolve to their own host", async () => {
  const backend = await boot();
  const base = origin(backend);
  const created = await fetch(`${base}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(created.status, 201);
  const source = await created.json() as { id: string; passwordSet: boolean; libraries: Array<{ id: string }> };
  assert.equal(source.passwordSet, true);
  assert.equal(JSON.stringify(source).includes("sekret-value"), false);
  const secondLibrary = source.libraries[0]?.id;
  assert.ok(secondLibrary);
  const room = await createRoom(backend);
  const roomHeaders = { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken };
  const primary = await (await fetch(`${base}/api/media/list?libraryId=lib_film`, { headers: roomHeaders })).json() as { items: Array<{ name: string; id: string }> };
  const secondary = await (await fetch(`${base}/api/media/list?libraryId=${secondLibrary}`, { headers: roomHeaders })).json() as { items: Array<{ name: string; id: string }> };
  const primaryId = primary.items.find((item) => item.name === "Same.mp4")?.id;
  const secondaryId = secondary.items.find((item) => item.name === "Same.mp4")?.id;
  assert.ok(primaryId && secondaryId);
  assert.notEqual(primaryId, secondaryId);
  const resolve = async (mediaId: string) => {
    const response = await fetch(`${base}/api/rooms/${room.roomId}/media/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.accessToken}` },
      body: JSON.stringify({ mediaId }),
    });
    assert.equal(response.status, 200);
    return await response.json() as { url: string };
  };
  assert.equal((await resolve(primaryId)).url.startsWith("http://primary.example/"), true);
  assert.equal((await resolve(secondaryId)).url.startsWith("http://second.example/"), true);
  const tracks = await fetch(`${base}/api/rooms/${room.roomId}/media/subtitles?mediaId=${encodeURIComponent(primaryId)}`, {
    headers: { authorization: `Bearer ${room.accessToken}` },
  });
  assert.equal(tracks.status, 200);
  const subtitles = await tracks.json() as Array<{ label: string; language?: string; format: string }>;
  assert.equal(subtitles.length, 1);
  assert.equal(subtitles[0]?.label, "Same.chs.ass");
  assert.equal(subtitles[0]?.language, "zh-Hans");
  assert.equal(subtitles[0]?.format, "ass");
  const payload = Buffer.from(`${FILM}/Same.mp4`).toString("base64url");
  const legacyId = `${payload}.${createHmac("sha256", "test-key").update(payload).digest("base64url")}`;
  const rejected = await fetch(`${base}/api/rooms/${room.roomId}/media/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${room.accessToken}` },
    body: JSON.stringify({ mediaId: legacyId }),
  });
  assert.equal(rejected.status, 404);
  assert.equal((await rejected.json() as { code: string }).code, "MEDIA_NOT_FOUND");
  const removed = await fetch(`${base}/api/admin/media-sources/src_default`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  const stillRejected = await fetch(`${base}/api/rooms/${room.roomId}/media/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${room.accessToken}` },
    body: JSON.stringify({ mediaId: legacyId }),
  });
  assert.equal(stillRejected.status, 404);
});

test("a failed shallow probe writes nothing", async () => {
  const backend = await boot({ factoryBehavior: { shallowCode: 500 } });
  const base = origin(backend);
  const response = await fetch(`${base}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "LIBRARY_ROOT_NOT_FOUND");
  const admin = await (await fetch(`${base}/api/admin/media-sources`)).json() as { sources: Array<{ name: string }> };
  assert.deepEqual(admin.sources.map((source) => source.name), ["Primary"]);
});

test("auth failure is reported and writes nothing", async () => {
  const backend = await boot({ factoryBehavior: { auth: true } });
  const response = await fetch(`${origin(backend)}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { code: string }).code, "SOURCE_AUTH_FAILED");
  const admin = await (await fetch(`${origin(backend)}/api/admin/media-sources`)).json() as { sources: unknown[] };
  assert.equal(admin.sources.length, 1);
});

test("ephemeral media id key refuses a source save in production", async () => {
  const cfg = config({ WATCHPARTY_MEDIA_ID_KEY: "" });
  const backend = await boot({
    cfg: {
      ...cfg,
      nodeEnv: "production",
      configStatus: { ...cfg.configStatus, mediaIdKey: { mode: "ephemeral" } },
    },
  });
  const response = await fetch(`${origin(backend)}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "MEDIA_ID_KEY_EPHEMERAL");
  const admin = await (await fetch(`${origin(backend)}/api/admin/media-sources`)).json() as { sources: unknown[] };
  assert.equal(admin.sources.length, 1);
});

test("admin routes reject non-loopback callers unless the admin token matches", async () => {
  const denied = await boot({ trustLoopback: false });
  const blocked = await fetch(`${origin(denied)}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json() as { code: string }).code, "ADMIN_FORBIDDEN");
  const capabilities = await (await fetch(`${origin(denied)}/api/media/capabilities`)).json() as { mediaAdmin: boolean };
  assert.equal(capabilities.mediaAdmin, false);
  const allowed = await boot({ trustLoopback: false, adminToken: "adm-token" });
  const response = await fetch(`${origin(allowed)}/api/admin/media-sources`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-watchparty-admin": "adm-token" },
    body: JSON.stringify(secondBody),
  });
  assert.equal(response.status, 201);
});

test("loopback proxies do not grant remote clients admin access or trust spoofed client IPs", async () => {
  const backend = await boot({ adminToken: "adm-token" });
  const base = origin(backend);
  const route = "/api/admin/media-sources";
  assert.equal((await fetch(`${base}${route}`)).status, 200);
  for (const forwarded of ["203.0.113.7", "127.0.0.1, 203.0.113.7", "127.0.0.1, 203.0.113.7, ::1"]) {
    const headers = { "x-forwarded-for": forwarded };
    const blocked = await fetch(`${base}${route}`, { headers });
    assert.equal(blocked.status, 403, forwarded);
    const capabilities = await (await fetch(`${base}/api/media/capabilities`, { headers })).json();
    assert.equal(capabilities.mediaAdmin, false, forwarded);
    const write = await fetch(`${base}/api/media/catalog/missing/confirm`, { method: "POST", headers });
    assert.equal(write.status, 403, forwarded);
    const allowed = await fetch(`${base}${route}`, { headers: { ...headers, "x-watchparty-admin": "adm-token" } });
    assert.equal(allowed.status, 200, forwarded);
  }
});

test("media reads reject anonymous and mismatched identities, including legacy roots and images", async () => {
  const backend = await boot();
  const base = origin(backend);
  const room = await createRoom(backend);
  const otherRoom = await createRoom(backend);
  const guestResponse = await fetch(`${base}/api/rooms/${room.roomId}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), nickname: "Guest" }),
  });
  assert.equal(guestResponse.status, 200);
  const guest = await guestResponse.json() as { accessToken: string };
  const headers = { "x-watchparty-room": room.roomId, "x-watchparty-token": guest.accessToken };
  const paths = [
    "/api/media/roots", "/api/media/libraries",
    "/api/media/list?root=Anime", "/api/media/search?q=show&root=Anime",
    "/api/media/list?libraryId=lib_film", "/api/media/search?q=show&libraryId=lib_film",
    "/api/media/catalog?libraryId=lib_film", "/api/media/catalog/missing",
    "/api/media/artwork/missing", "/api/media/posters/missing", "/api/media/bangumi/search?q=Medalist",
  ];
  for (const pathname of paths) {
    const anonymous = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(anonymous.status, 401, pathname);
    const mismatch = await fetch(`${base}${pathname}`, {
      headers: { ...headers, "x-watchparty-room": otherRoom.roomId },
    });
    assert.equal(mismatch.status, 401, pathname);
  }
  for (const pathname of ["/api/media/roots", "/api/media/libraries", "/api/media/list?libraryId=lib_film", "/api/media/search?q=show&libraryId=lib_film", "/api/media/catalog?libraryId=lib_film", "/api/media/bangumi/search?q=Medalist"]) {
    assert.equal((await fetch(`${base}${pathname}`, { headers })).status, 200, pathname);
  }
  for (const invalid of [
    { ...headers, "x-watchparty-room": "" },
    { ...headers, "x-watchparty-room": `${room.roomId}, ${otherRoom.roomId}` },
    { ...headers, "x-watchparty-token": "", authorization: `Bearer ${guest.accessToken}` },
  ]) {
    assert.equal((await fetch(`${base}/api/media/libraries`, { headers: invalid })).status, 401);
  }
  const legacy = await fetch(`${base}/api/media/libraries`, {
    headers: { "x-watchparty-room": room.roomId, authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(legacy.status, 200);
});

test("catalog edits require admin even for room members; admin tools do not require a room", async () => {
  const backend = await boot({ trustLoopback: false, adminToken: "adm-token" });
  const base = origin(backend);
  const room = await createRoom(backend);
  const roomHeaders = { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken };
  const writes = [
    "/api/media/catalog/missing/confirm", "/api/media/catalog/missing/reject",
    "/api/media/catalog/missing/unconfirm", "/api/media/catalog/missing/rebind",
    "/api/media/catalog/merge", "/api/media/catalog/missing/split",
    "/api/admin/media-libraries/lib_film/scan", "/api/admin/media-libraries/lib_film/scrape",
    "/api/admin/media-libraries/lib_film/classify", "/api/admin/media-libraries/lib_film/judge",
    "/api/admin/media-libraries/lib_film/prepare", "/api/admin/media-libraries/lib_film/draft/edit",
    "/api/admin/media-libraries/lib_film/import/export", "/api/admin/media-libraries/lib_film/approval",
    "/api/admin/media-libraries/lib_film/apply", "/api/admin/media-libraries/lib_film/apply-approved",
    "/api/admin/media-libraries/lib_film/rollback",
  ];
  const identities: Record<string, string>[] = [{}, roomHeaders, { "x-watchparty-admin": "wrong-token" }];
  for (const pathname of writes) {
    for (const headers of identities) {
      const response = await fetch(`${base}${pathname}`, { method: "POST", headers });
      assert.equal(response.status, 403, pathname);
      assert.equal((await response.json() as { code: string }).code, "ADMIN_FORBIDDEN");
    }
  }
  assert.equal((await fetch(`${base}/api/admin/media-catalog?libraryId=lib_film`, { headers: roomHeaders })).status, 403);
  const admin = { "x-watchparty-admin": "adm-token" };
  assert.equal((await fetch(`${base}/api/admin/media-catalog?libraryId=lib_film`, { headers: admin })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/media-catalog/missing`, { headers: admin })).status, 404);
  assert.equal((await fetch(`${base}/api/media/catalog?libraryId=lib_film`, { headers: admin })).status, 401);
  const invalidWrite = await fetch(`${base}/api/media/catalog/missing/unconfirm`, { method: "POST", headers: admin });
  assert.equal(invalidWrite.status, 404);
  const loopback = await boot();
  assert.equal((await fetch(`${origin(loopback)}/api/admin/media-catalog?libraryId=lib_film`)).status, 200);
});
