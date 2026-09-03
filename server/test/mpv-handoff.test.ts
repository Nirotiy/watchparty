import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { io as clientIo, type Socket } from "socket.io-client";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import type {
  ClientToServerEvents,
  CommandAck,
  RoomMember,
  RoomSnapshot,
  ServerToClientEvents,
} from "../core/protocol.ts";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const backends: Backend[] = [];
const sockets: TestSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const backend of backends.splice(0)) await backend.close();
});

async function boot(): Promise<Backend> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: "http://127.0.0.1:1",
    OPENLIST_USERNAME: "",
    OPENLIST_PASSWORD: "",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config,
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

function origin(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

async function createRoom(backend: Backend) {
  const clientId = randomUUID();
  const response = await fetch(`${origin(backend)}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, nickname: "Owner" }),
  });
  assert.equal(response.status, 200);
  return {
    clientId,
    ...((await response.json()) as {
      roomId: string;
      accessToken: string;
      ownerToken: string;
    }),
  };
}

function post(
  backend: Backend,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin(backend)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function mpvHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "x-watchparty-client-type": "mpv",
    "x-watchparty-protocol": "2",
  };
}

function errorCode(ack: unknown): string | undefined {
  return (ack as { error?: { code?: string } }).error?.code;
}

async function issueTicket(
  backend: Backend,
  roomId: string,
  accessToken: string,
) {
  const response = await post(
    backend,
    `/api/rooms/${roomId}/handoff`,
    {},
    { authorization: `Bearer ${accessToken}` },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as { ticket: string; ticketExpiresAt: number };
}

type RedeemResult = {
  protocolVersion: number;
  roomId: string;
  clientId: string;
  accessToken: string;
  nickname: string;
  onlineCount: number;
  snapshot: RoomSnapshot;
};

async function redeem(
  backend: Backend,
  ticket: string,
): Promise<{ status: number; body: unknown }> {
  const response = await post(backend, "/api/mpv/handoff", { ticket });
  const body =
    response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

function connectBrowser(
  backend: Backend,
  roomId: string,
  clientId: string,
  accessToken: string,
  ownerToken?: string,
): TestSocket {
  const socket = clientIo(origin(backend), {
    transports: ["websocket"],
    auth: {
      roomId,
      clientId,
      accessToken,
      clientProtocol: 2,
      ...(ownerToken ? { ownerToken } : {}),
    },
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

function nextMembers(socket: TestSocket): Promise<RoomMember[]> {
  return new Promise((resolve) => socket.once("REC:members", resolve));
}

/** Member broadcasts fire on every join; keep reading until the target appears. */
async function membersContaining(
  socket: TestSocket,
  name: string,
): Promise<RoomMember[]> {
  for (;;) {
    const members = await nextMembers(socket);
    if (members.some((member) => member.name === name)) return members;
  }
}

test("handoff → mpv identity → snapshot polling → command ack full chain", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const { roomId, accessToken } = created;

  // 1. Browser issues a one-time ticket.
  const ticket = await issueTicket(backend, roomId, accessToken);
  assert.ok(ticket.ticket.length >= 32);
  assert.ok(ticket.ticketExpiresAt > Date.now());

  // 2. MPV redeems it: fresh identity, mpv token, protocol version, snapshot.
  const redeemed = await redeem(backend, ticket.ticket);
  assert.equal(redeemed.status, 200);
  const mpv = redeemed.body as RedeemResult;
  assert.equal(mpv.protocolVersion, 2);
  assert.equal(mpv.roomId, roomId);
  assert.equal(mpv.nickname, "MPV");
  assert.notEqual(mpv.clientId, "");
  assert.notEqual(mpv.accessToken, accessToken);
  assert.equal(mpv.snapshot.revision, 0);

  // 3. Snapshot polling: full snapshot when behind, 204 when up to date.
  const snapshotResponse = await fetch(
    `${origin(backend)}/api/rooms/${roomId}/mpv/snapshot`,
    { headers: mpvHeaders(mpv.accessToken) },
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = (await snapshotResponse.json()) as RoomSnapshot;
  assert.equal(snapshot.revision, 0);
  const upToDate = await fetch(
    `${origin(backend)}/api/rooms/${roomId}/mpv/snapshot?since=${snapshot.revision}`,
    { headers: mpvHeaders(mpv.accessToken) },
  );
  assert.equal(upToDate.status, 204);

  // 4. Command via HTTP behaves like CMD:* (locked room → FORBIDDEN 403).
  const locked = await post(
    backend,
    `/api/rooms/${roomId}/mpv/command`,
    { type: "play", expectedRevision: 0 },
    mpvHeaders(mpv.accessToken),
  );
  assert.equal(locked.status, 403);
  assert.equal(errorCode(await locked.json()), "FORBIDDEN");
});

test("browser owner unlock lets MPV run commands and both sides see the same state", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const socket = connectBrowser(
    backend,
    created.roomId,
    created.clientId,
    created.accessToken,
    created.ownerToken,
  );
  await connected(socket);
  const unlocked = new Promise<CommandAck>((resolve) =>
    socket.emit("CMD:lock", { locked: false, expectedRevision: 0 }, resolve),
  );
  assert.equal((await unlocked).ok, true);

  // The REC:members broadcast fires during redemption, so listen first.
  const membersPromise = membersContaining(socket, "MPV");
  const ticket = await issueTicket(
    backend,
    created.roomId,
    created.accessToken,
  );
  const mpv = (await redeem(backend, ticket.ticket)).body as RedeemResult;
  const headers = mpvHeaders(mpv.accessToken);

  // MPV seek via HTTP is accepted and visible in a fresh snapshot.
  const response = await post(
    backend,
    `/api/rooms/${created.roomId}/mpv/command`,
    { type: "seek", positionSeconds: 42, expectedRevision: 1 },
    headers,
  );
  assert.equal(response.status, 200);
  const ack = (await response.json()) as CommandAck;
  assert.equal(ack.ok, true);
  assert.equal(ack.revision, 2);

  const snapshot = await fetch(
    `${origin(backend)}/api/rooms/${created.roomId}/mpv/snapshot`,
    { headers },
  );
  assert.equal(((await snapshot.json()) as RoomSnapshot).positionSeconds, 42);

  // Stale expectedRevision conflicts exactly like the socket path.
  const conflict = await post(
    backend,
    `/api/rooms/${created.roomId}/mpv/command`,
    { type: "pause", expectedRevision: 1 },
    headers,
  );
  assert.equal(errorCode(await conflict.json()), "REVISION_CONFLICT");

  // Owner-only commands are not in the MPV whitelist.
  const lock = await post(
    backend,
    `/api/rooms/${created.roomId}/mpv/command`,
    { type: "lock", locked: false, expectedRevision: 2 },
    headers,
  );
  assert.equal(errorCode(await lock.json()), "INVALID_REQUEST");

  // MPV redemption joined the room: browser members see "MPV".
  const members = await membersPromise;
  assert.ok(members.some((member) => member.name === "MPV" && !member.isOwner));
});

test("handoff tickets are one-time, unknown tickets are rejected", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const ticket = await issueTicket(
    backend,
    created.roomId,
    created.accessToken,
  );

  const first = await redeem(backend, ticket.ticket);
  assert.equal(first.status, 200);
  const second = await redeem(backend, ticket.ticket);
  assert.equal(second.status, 401);
  assert.equal(
    (second.body as { code: string }).code,
    "HANDOFF_TICKET_INVALID",
  );

  const garbage = await redeem(backend, "definitely-not-a-ticket");
  assert.equal(garbage.status, 401);
  assert.equal(
    (garbage.body as { code: string }).code,
    "HANDOFF_TICKET_INVALID",
  );
});

test("mpv endpoints reject browser tokens, missing tickets and wrong protocol headers", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const ticket = await issueTicket(
    backend,
    created.roomId,
    created.accessToken,
  );
  const mpv = (await redeem(backend, ticket.ticket)).body as RedeemResult;
  const base = `${origin(backend)}/api/rooms/${created.roomId}/mpv/snapshot`;

  // No protocol header → hard 426 before any auth check.
  assert.equal((await fetch(base)).status, 426);
  // Missing token (protocol ok) → 401; garbage token → 401.
  assert.equal(
    (await fetch(base, { headers: { "x-watchparty-protocol": "2" } })).status,
    401,
  );
  assert.equal(
    (await fetch(base, { headers: mpvHeaders("bogus") })).status,
    401,
  );

  // Browser token with full MPV headers → 403 (clientType isolation).
  assert.equal(
    (
      await fetch(base, {
        headers: {
          ...mpvHeaders(created.accessToken),
          authorization: `Bearer ${created.accessToken}`,
        },
      })
    ).status,
    403,
  );

  // Protocol header missing or wrong → hard 426.
  const noProtocol = await fetch(base, {
    headers: { authorization: `Bearer ${mpv.accessToken}` },
  });
  assert.equal(noProtocol.status, 426);
  assert.equal(
    ((await noProtocol.json()) as { code: string }).code,
    "PROTOCOL_VERSION_MISMATCH",
  );
  const oldProtocol = await fetch(base, {
    headers: { ...mpvHeaders(mpv.accessToken), "x-watchparty-protocol": "1" },
  });
  assert.equal(oldProtocol.status, 426);

  // MPV token cannot issue handoff tickets either (browser-only).
  const mpvTicket = await post(
    backend,
    `/api/rooms/${created.roomId}/handoff`,
    {},
    { authorization: `Bearer ${mpv.accessToken}` },
  );
  assert.equal(mpvTicket.status, 403);

  // Unknown room → 404.
  assert.equal(
    (
      await fetch(
        `${origin(backend)}/api/rooms/room-doesnotexist/mpv/snapshot`,
        { headers: mpvHeaders(mpv.accessToken) },
      )
    ).status,
    404,
  );
});

test("socket handshake enforces the protocol version", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const mismatch = clientIo(origin(backend), {
    transports: ["websocket"],
    auth: {
      roomId: created.roomId,
      clientId: randomUUID(),
      accessToken: created.accessToken,
      clientProtocol: 1,
    },
  }) as TestSocket;
  sockets.push(mismatch);
  const error = await new Promise<Error & { data?: { code: string } }>(
    (resolve, reject) => {
      mismatch.once("connect", () =>
        reject(new Error("connect should have failed")),
      );
      mismatch.once("connect_error", resolve);
    },
  );
  assert.equal(error.data?.code, "PROTOCOL_VERSION_MISMATCH");
});

test("resolve-mpv rejects forged media ids and surfaces OpenList failures", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const ticket = await issueTicket(
    backend,
    created.roomId,
    created.accessToken,
  );
  const mpv = (await redeem(backend, ticket.ticket)).body as RedeemResult;
  const headers = mpvHeaders(mpv.accessToken);

  // Forged / unsigned mediaId → MEDIA_NOT_FOUND.
  const forged = await post(
    backend,
    `/api/rooms/${created.roomId}/media/resolve-mpv`,
    { mediaId: "forged-id" },
    headers,
  );
  assert.equal(forged.status, 404);
  assert.equal(
    ((await forged.json()) as { code: string }).code,
    "MEDIA_NOT_FOUND",
  );

  // Valid mediaId but unreachable OpenList → OPENLIST_UNAVAILABLE.
  const payload = Buffer.from(
    "/media/openlist-bdyun/Multimedia/Anime/a.mp4",
  ).toString("base64url");
  const mediaId = `${payload}.${createHmac("sha256", "test-key").update(payload).digest("base64url")}`;
  const unavailable = await post(
    backend,
    `/api/rooms/${created.roomId}/media/resolve-mpv`,
    { mediaId },
    headers,
  );
  assert.equal(unavailable.status, 502);
  assert.equal(
    ((await unavailable.json()) as { code: string }).code,
    "OPENLIST_UNAVAILABLE",
  );
});

test("stale-pruned MPV with a valid token rejoins as a visible member on its next request", async () => {
  // Virtual clock: silence beyond MPV_STALE_MS (120s) triggers the stale prune.
  let now = 1_000_000;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: "http://127.0.0.1:1",
    OPENLIST_USERNAME: "",
    OPENLIST_PASSWORD: "",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config,
    now: () => now,
  });
  await backend.start();
  backends.push(backend);

  const created = await createRoom(backend);
  const ticket = await issueTicket(
    backend,
    created.roomId,
    created.accessToken,
  );
  const mpv = (await redeem(backend, ticket.ticket)).body as RedeemResult;
  const headers = mpvHeaders(mpv.accessToken);
  const room = backend.registry.get(created.roomId);
  assert.ok(room);
  assert.equal(room.isOnline(mpv.clientId), true);

  // First poll establishes the MPV heartbeat (redeem no longer touches it).
  const first = await fetch(
    `${origin(backend)}/api/rooms/${created.roomId}/mpv/snapshot`,
    { headers },
  );
  assert.equal(first.status, 200);

  // Silence beyond the stale window drops the member, but the token stays valid.
  now += 121_000;
  backend.registry.pruneIdle();
  assert.equal(room.isOnline(mpv.clientId), false);

  // The next authenticated request restores membership instead of letting
  // the token act as an invisible ghost controller.
  const snapshot = await fetch(
    `${origin(backend)}/api/rooms/${created.roomId}/mpv/snapshot`,
    { headers },
  );
  assert.equal(snapshot.status, 200);
  assert.equal(room.isOnline(mpv.clientId), true);

  // Stale expectedRevision → REVISION_CONFLICT with the spec status code 409.
  const conflict = await post(
    backend,
    `/api/rooms/${created.roomId}/mpv/command`,
    { type: "seek", positionSeconds: 6, expectedRevision: 99 },
    headers,
  );
  assert.equal(conflict.status, 409);
  assert.equal(errorCode(await conflict.json()), "REVISION_CONFLICT");

  // New rooms start locked; unlock as the owner so the member command is legal.
  const unlock = room.execute(
    created.clientId,
    { type: "lock", locked: false },
    room.snapshot().revision,
    true,
  );
  assert.ok(unlock.ok);

  // And a valid command from the returning member is accepted as a member.
  const ok = await post(
    backend,
    `/api/rooms/${created.roomId}/mpv/command`,
    {
      type: "seek",
      positionSeconds: 5,
      expectedRevision: unlock.ok ? unlock.revision : 0,
    },
    headers,
  );
  assert.equal(ok.status, 200);
});
