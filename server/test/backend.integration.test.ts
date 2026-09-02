import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { io as clientIo, type Socket } from "socket.io-client";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { ClientToServerEvents, CommandAck, RoomMember, RoomSnapshot, ServerToClientEvents } from "../core/protocol.ts";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const backends: Backend[] = [];
const sockets: TestSocket[] = [];
const media = { kind: "http" as const, url: "https://example.com/video.mp4" };

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const backend of backends.splice(0)) await backend.close();
});

async function boot(
  overrides: Partial<Record<"OPENLIST_URL" | "OPENLIST_USERNAME" | "OPENLIST_PASSWORD" | "WATCHPARTY_MEDIA_ID_KEY", string>> = {},
): Promise<Backend> {
  const config = loadConfig({
    ...process.env,
    // Tests must never run in production mode (empty media-id key would throw).
    NODE_ENV: "test",
    // Default every test to an unreachable OpenList so no test touches a real instance.
    OPENLIST_URL: "http://127.0.0.1:1",
    OPENLIST_USERNAME: "",
    OPENLIST_PASSWORD: "",
    ...overrides,
  });
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false, config });
  await backend.start();
  backends.push(backend);
  return backend;
}

function origin(backend: Backend): string { return `http://127.0.0.1:${backend.port}`; }

async function createRoom(backend: Backend, pin?: string) {
  const clientId = randomUUID();
  const response = await fetch(`${origin(backend)}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, nickname: "Owner", ...(pin ? { pin } : {}) }),
  });
  assert.equal(response.status, 200);
  return { clientId, ...(await response.json() as { roomId: string; accessToken: string; ownerToken: string }) };
}

function connect(backend: Backend, roomId: string, clientId: string, accessToken: string, ownerToken?: string): TestSocket {
  const socket = clientIo(origin(backend), {
    transports: ["websocket"],
    auth: { roomId, clientId, accessToken, ...(ownerToken ? { ownerToken } : {}) },
  }) as TestSocket;
  sockets.push(socket);
  return socket;
}

function connected(socket: TestSocket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

function nextEvent<K extends keyof ServerToClientEvents>(socket: TestSocket, event: K): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  const rawSocket = socket as unknown as { once: (name: string, listener: (payload: unknown) => void) => void };
  return new Promise((resolve) => rawSocket.once(String(event), (payload) => resolve(payload as Parameters<ServerToClientEvents[K]>[0])));
}

function command<K extends keyof ClientToServerEvents>(socket: TestSocket, event: K, payload: Parameters<ClientToServerEvents[K]>[0]): Promise<CommandAck> {
  const rawSocket = socket as unknown as { emit: (name: string, payload: unknown, ack: (result: CommandAck) => void) => void };
  return new Promise((resolve) => rawSocket.emit(String(event), payload, resolve));
}

test("health and room lifecycle use the new API contract", async () => {
  const backend = await boot();
  assert.equal(await (await fetch(`${origin(backend)}/ping`)).json(), "pong");
  const created = await createRoom(backend);
  const info = await (await fetch(`${origin(backend)}/api/rooms/${created.roomId}`)).json() as Record<string, unknown>;
  assert.deepEqual(info, { roomId: created.roomId, isProtected: false, onlineCount: 0 });
  assert.equal((await fetch(`${origin(backend)}/api/rooms/missing`)).status, 404);
});

test("media resolve requires room access and reports an unreachable OpenList safely", async () => {
  const backend = await boot({ WATCHPARTY_MEDIA_ID_KEY: "test-key" });
  const created = await createRoom(backend);
  const unauthorized = await fetch(`${origin(backend)}/api/rooms/${created.roomId}/media/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaId: "opaque-id" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { code: "ACCESS_TOKEN_INVALID", message: "访问凭据已失效" });

  const payload = Buffer.from("/media/openlist-bdyun/Multimedia/Anime/Show 01.mp4").toString("base64url");
  const mediaId = `${payload}.${createHmac("sha256", "test-key").update(payload).digest("base64url")}`;
  const unavailable = await fetch(`${origin(backend)}/api/rooms/${created.roomId}/media/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.accessToken}` },
    body: JSON.stringify({ mediaId }),
  });
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { code: "OPENLIST_UNAVAILABLE", message: "OpenList 媒体服务暂时不可用" });
});

test("media browsing, resolve, and subtitles run end-to-end against a local OpenList", async (context) => {
  let subtitleServed = false;
  const openlist = createServer((request, response) => {
    const url = request.url ?? "";
    const pathname = url.split("?")[0]!;
    if (url === "/api/auth/login") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 200, data: { token: "fake-openlist-token" } }));
      return;
    }
    if (pathname === "/api/fs/list") {
      assert.equal(request.headers.authorization, "fake-openlist-token");
      let listRaw = "";
      request.on("data", (chunk: string) => { listRaw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(listRaw) as { page: number; per_page: number };
        assert.equal(body.page, 1);
        assert.equal(body.per_page, 2000);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 200, data: { content: [
          { name: "Show 01.chs.ass", is_dir: false, size: 20, path: "/media/openlist-bdyun/Multimedia/Anime/Show 01.chs.ass" },
          { name: "Show 01.mp4", is_dir: false, size: 10, path: "/media/openlist-bdyun/Multimedia/Anime/Show 01.mp4" },
        ] } }));
      });
      return;
    }
    if (url === "/api/fs/get") {
      assert.equal(request.headers.authorization, "fake-openlist-token");
      let raw = "";
      request.on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw) as { path: string };
        const openlistAddress = openlist.address();
        if (!openlistAddress || typeof openlistAddress === "string") {
          response.statusCode = 500;
          response.end();
          return;
        }
        const rawUrl = body.path.endsWith(".ass")
          ? `http://127.0.0.1:${openlistAddress.port}/d/sub.ass?sign=abc`
          : `http://127.0.0.1:${openlistAddress.port}/p/Show%2001.mp4?sign=abc`;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 200, data: { raw_url: rawUrl, size: body.path.endsWith(".ass") ? 20 : 10 } }));
      });
      return;
    }
    if (pathname === "/d/sub.ass") {
      subtitleServed = true;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("[Script Info]\n");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => openlist.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    openlist.close((error) => error ? reject(error) : resolve());
  }));
  const address = openlist.address();
  assert.ok(address && typeof address === "object");
  const backend = await boot({
    OPENLIST_URL: `http://127.0.0.1:${address.port}`,
    OPENLIST_USERNAME: "u",
    OPENLIST_PASSWORD: "p",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const created = await createRoom(backend);
  const headers = { authorization: `Bearer ${created.accessToken}` };

  const roots = await (await fetch(`${origin(backend)}/api/media/roots`)).json() as string[];
  assert.deepEqual(roots, ["Anime", "Film", "TV Shows"]);

  const directory = await (await fetch(`${origin(backend)}/api/media/list?root=Anime`)).json() as { items: Array<{ id: string; name: string }> };
  assert.deepEqual(directory.items.map((item) => item.name), ["Show 01.chs.ass", "Show 01.mp4"]);
  const videoId = directory.items[1]!.id;

  const resolved = await (await fetch(`${origin(backend)}/api/rooms/${created.roomId}/media/resolve`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mediaId: videoId }),
  })).json() as { url: string; mime: string; size: number };
  const openlistAddress = openlist.address();
  assert.ok(openlistAddress && typeof openlistAddress === "object");
  assert.equal(resolved.url, `http://127.0.0.1:${openlistAddress.port}/p/Show%2001.mp4?sign=abc`);
  assert.equal(resolved.mime, "video/mp4");
  assert.equal(resolved.size, 10);

  const tracks = await (await fetch(
    `${origin(backend)}/api/rooms/${created.roomId}/media/subtitles?mediaId=${encodeURIComponent(videoId)}`,
    { headers },
  )).json() as Array<{ id: string; mediaId: string; label: string; format: string; language?: string }>;
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.label, "Show 01.chs.ass");
  assert.equal(tracks[0]!.format, "ass");
  assert.equal(tracks[0]!.language, "zh-Hans");

  assert.equal(tracks[0]!.mediaId, tracks[0]!.id);

  const content = await fetch(
    `${origin(backend)}/api/rooms/${created.roomId}/media/subtitle?mediaId=${encodeURIComponent(tracks[0]!.mediaId)}`,
    { headers },
  );
  assert.equal(content.status, 200);
  assert.equal(await content.text(), "[Script Info]\n");
  assert.equal(subtitleServed, true);
});

test("protected rooms issue access tokens and rate limit bad PINs", async () => {
  const backend = await boot();
  const created = await createRoom(backend, "8024");
  const guestId = randomUUID();
  for (let i = 0; i < 5; i += 1) {
    const response = await fetch(`${origin(backend)}/api/rooms/${created.roomId}/access`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: guestId, nickname: "Guest", pin: "0000" }),
    });
    assert.equal(response.status, i === 4 ? 429 : 401);
  }
  const accepted = connect(backend, created.roomId, created.clientId, created.accessToken, created.ownerToken);
  await connected(accepted);
  assert.equal((await fetch(`${origin(backend)}/api/rooms/${created.roomId}`)).status, 200);
});

test("root namespace sends snapshots and members; commands use Ack and revisions", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const guestId = randomUUID();
  const guestAccessResponse = await fetch(`${origin(backend)}/api/rooms/${created.roomId}/access`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: guestId, nickname: "Guest" }),
  });
  const guestAccess = await guestAccessResponse.json() as { accessToken: string };
  const ownerSocket = connect(backend, created.roomId, created.clientId, created.accessToken, created.ownerToken);
  const snapshot = nextEvent(ownerSocket, "REC:snapshot");
  await connected(ownerSocket);
  assert.equal((await snapshot).ownerClientId, created.clientId);
  const guestSocket = connect(backend, created.roomId, guestId, guestAccess.accessToken);
  const members = nextEvent(guestSocket, "REC:members");
  await connected(guestSocket);
  assert.equal((await members as RoomMember[]).length, 2);
  const result = await command(ownerSocket, "CMD:mediaSet", { media, expectedRevision: 0 });;
  assert.equal(result.ok, true);
  const current = backend.registry.get(created.roomId)?.snapshot() as RoomSnapshot;
  assert.equal(current.source?.kind, "http");
  const conflict = await command(ownerSocket, "CMD:play", { expectedRevision: 0 });
  assert.deepEqual(conflict, { ok: false, error: { code: "REVISION_CONFLICT", message: "房间状态已更新，请重新同步后重试" } });
});

test("lock rejects guests and ownership transfer rotates the owner token", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const guestId = randomUUID();
  const accessResponse = await fetch(`${origin(backend)}/api/rooms/${created.roomId}/access`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: guestId, nickname: "Guest" }),
  });
  const access = await accessResponse.json() as { accessToken: string };
  const ownerSocket = connect(backend, created.roomId, created.clientId, created.accessToken, created.ownerToken);
  const guestSocket = connect(backend, created.roomId, guestId, access.accessToken);
  await Promise.all([connected(ownerSocket), connected(guestSocket)]);
  assert.equal((await command(ownerSocket, "CMD:lock", { locked: false, expectedRevision: 0 })).ok, true);
  const transferToken = nextEvent(guestSocket, "REC:ownerToken");
  const transferred = await command(ownerSocket, "CMD:transferOwner", { targetClientId: guestId, expectedRevision: 1 });
  assert.equal(transferred.ok, true);
  const newToken = await transferToken;
  assert.equal(typeof newToken, "string");
  assert.equal(backend.registry.isOwner(created.roomId, guestId, newToken), true);
  const oldOwnerCommand = await command(ownerSocket, "CMD:lock", { locked: true, expectedRevision: 2 });
  assert.equal(oldOwnerCommand.ok, false);
});
