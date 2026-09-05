import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { io as clientIo, type Socket } from "socket.io-client";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { ClientToServerEvents, RoomSnapshot, ServerToClientEvents } from "../core/protocol.ts";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type DesktopIdentity = { roomId: string; clientId: string; accessToken: string; generation: number };

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
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false, config });
  await backend.start();
  backends.push(backend);
  return backend;
}

function url(backend: Backend, path: string): string {
  return `http://127.0.0.1:${backend.port}${path}`;
}

function origin(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

async function createBrowserRoom(backend: Backend) {
  const clientId = randomUUID();
  const response = await fetch(url(backend, "/api/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, nickname: "BrowserOwner" }),
  });
  assert.equal(response.status, 200);
  return { clientId, ...(await response.json() as { roomId: string; accessToken: string; ownerToken: string }) };
}

function connect(backend: Backend, roomId: string, clientId: string, accessToken: string, ownerToken?: string): TestSocket {
  const socket = clientIo(origin(backend), {
    transports: ["websocket"],
    auth: { roomId, clientId, accessToken, clientProtocol: 2, ...(ownerToken ? { ownerToken } : {}) },
  }) as TestSocket;
  sockets.push(socket);
  return socket;
}

function connected(socket: TestSocket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });
}

function nextEvent<K extends keyof ServerToClientEvents>(socket: TestSocket, event: K): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  const rawSocket = socket as unknown as { once: (name: string, listener: (payload: unknown) => void) => void };
  return new Promise((resolve) => rawSocket.once(String(event), (payload) => resolve(payload as Parameters<ServerToClientEvents[K]>[0])));
}

function socketCommand<K extends keyof ClientToServerEvents>(
  socket: TestSocket,
  event: K,
  payload: Parameters<ClientToServerEvents[K]>[0],
): Promise<{ ok: boolean; revision?: number; error?: { code: string } }> {
  const rawSocket = socket as unknown as { emit: (name: string, payload: unknown, ack: (result: { ok: boolean; revision?: number; error?: { code: string } }) => void) => void };
  return new Promise((resolve) => rawSocket.emit(String(event), payload, resolve));
}

async function joinDesktop(backend: Backend, roomId: string, nickname: string): Promise<DesktopIdentity> {
  const clientId = randomUUID();
  const access = await fetch(url(backend, `/api/desktop/rooms/${roomId}/access`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-watchparty-protocol": "2", "x-watchparty-client-type": "desktop" },
    body: JSON.stringify({ clientId, nickname }),
  });
  assert.equal(access.status, 200);
  const { accessToken } = await access.json() as { accessToken: string };
  const claim = await fetch(url(backend, `/api/rooms/${roomId}/desktop/session`), {
    method: "POST",
    headers: { "x-watchparty-protocol": "2", "x-watchparty-client-type": "desktop", "x-watchparty-token": accessToken },
  });
  assert.equal(claim.status, 200);
  const { sessionGeneration } = await claim.json() as { sessionGeneration: number };
  return { roomId, clientId, accessToken, generation: sessionGeneration };
}

async function desktopSnapshot(backend: Backend, identity: DesktopIdentity): Promise<RoomSnapshot> {
  const response = await fetch(url(backend, `/api/rooms/${identity.roomId}/desktop/snapshot`), {
    headers: {
      authorization: `Bearer ${identity.accessToken}`,
      "x-watchparty-protocol": "2",
      "x-watchparty-client-type": "desktop",
      "x-watchparty-session-generation": String(identity.generation),
    },
  });
  assert.equal(response.status, 200);
  return await response.json() as RoomSnapshot;
}

async function desktopCommand(
  backend: Backend,
  identity: DesktopIdentity,
  body: Record<string, unknown>,
  ownerToken?: string,
): Promise<{ status: number; ack: { ok: boolean; error?: { code: string }; revision?: number } }> {
  const response = await fetch(url(backend, `/api/rooms/${identity.roomId}/desktop/command`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${identity.accessToken}`,
      "x-watchparty-protocol": "2",
      "x-watchparty-client-type": "desktop",
      "x-watchparty-session-generation": String(identity.generation),
      ...(ownerToken ? { "x-watchparty-owner-token": ownerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, ack: await response.json() as { ok: boolean; error?: { code: string }; revision?: number } };
}

async function claimGrant(backend: Backend, identity: DesktopIdentity): Promise<{ status: number; ownerToken?: string }> {
  const response = await fetch(url(backend, `/api/rooms/${identity.roomId}/desktop/owner-grant/claim`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${identity.accessToken}`,
      "x-watchparty-protocol": "2",
      "x-watchparty-client-type": "desktop",
      "x-watchparty-session-generation": String(identity.generation),
    },
  });
  if (response.status === 204) return { status: 204 };
  assert.equal(response.status, 200);
  return { status: 200, ...(await response.json() as { ownerToken: string }) };
}

test("desktop creator locks the room through the owner token header and guests are forbidden", async () => {
  const backend = await boot();
  const clientId = randomUUID();
  const created = await fetch(url(backend, "/api/desktop/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-watchparty-protocol": "2", "x-watchparty-client-type": "desktop" },
    body: JSON.stringify({ clientId, nickname: "NativeOwner" }),
  });
  assert.equal(created.status, 200);
  const room = await created.json() as { roomId: string; accessToken: string; ownerToken: string };
  const owner: DesktopIdentity = { roomId: room.roomId, clientId, accessToken: room.accessToken, generation: 1 };
  const guest = await joinDesktop(backend, room.roomId, "Guest");

  const locked = await desktopCommand(backend, owner, { type: "lock", locked: true, expectedRevision: 0 }, room.ownerToken);
  assert.equal(locked.status, 200);
  assert.ok(locked.ack.ok);

  // A room created from scratch starts locked at revision 0; after the lock
  // command (already locked) the revision moved to 1.
  const snapshot = await desktopSnapshot(backend, owner);
  assert.equal(snapshot.locked, true);

  const guestPlay = await desktopCommand(backend, guest, { type: "pause", expectedRevision: snapshot.revision });
  assert.equal(guestPlay.status, 403);
  assert.equal(guestPlay.ack.error?.code, "FORBIDDEN");

  // Owner commands without the header never reach Room.execute as owner.
  const noHeader = await desktopCommand(backend, owner, { type: "lock", locked: false, expectedRevision: snapshot.revision });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.ack.error?.code, "FORBIDDEN");

  const ownerUnlock = await desktopCommand(backend, owner, { type: "lock", locked: false, expectedRevision: snapshot.revision }, room.ownerToken);
  assert.equal(ownerUnlock.status, 200);
  assert.ok(ownerUnlock.ack.ok);
});

test("browser owner transfers to a desktop member through a one-time grant claim", async () => {
  const backend = await boot();
  const browser = await createBrowserRoom(backend);
  const browserSocket = connect(backend, browser.roomId, browser.clientId, browser.accessToken, browser.ownerToken);
  await connected(browserSocket);

  const desktop = await joinDesktop(backend, browser.roomId, "DesktopMember");

  const transferred = await socketCommand(browserSocket, "CMD:transferOwner", {
    expectedRevision: 0,
    targetClientId: desktop.clientId,
  });
  assert.ok(transferred.ok);

  // The grant is claimable exactly once.
  const firstClaim = await claimGrant(backend, desktop);
  assert.equal(firstClaim.status, 200);
  assert.ok(firstClaim.ownerToken);
  const secondClaim = await claimGrant(backend, desktop);
  assert.equal(secondClaim.status, 204);

  // The new desktop owner can lock the room with the claimed token.
  const snapshot = await desktopSnapshot(backend, desktop);
  const locked = await desktopCommand(
    backend,
    desktop,
    { type: "lock", locked: true, expectedRevision: snapshot.revision },
    firstClaim.ownerToken,
  );
  assert.equal(locked.status, 200);
  assert.ok(locked.ack.ok);

  // The former browser owner lost its privilege with the old token.
  const oldOwnerLock = await socketCommand(browserSocket, "CMD:lock", { expectedRevision: snapshot.revision + 1, locked: false });
  assert.equal(oldOwnerLock.ok, false);
  assert.ok(["FORBIDDEN", "OWNER_TOKEN_INVALID"].includes(oldOwnerLock.error?.code ?? ""));
});

test("desktop owner transfers back to a browser member over HTTP and the old token dies", async () => {
  const backend = await boot();
  const browser = await createBrowserRoom(backend);
  const browserSocket = connect(backend, browser.roomId, browser.clientId, browser.accessToken, browser.ownerToken);
  await connected(browserSocket);
  const ownerTokenPromise = nextEvent(browserSocket, "REC:ownerToken");

  const desktop = await joinDesktop(backend, browser.roomId, "DesktopOwner");
  const granted = await (async () => {
  const transferred = await socketCommand(browserSocket, "CMD:transferOwner", {
      expectedRevision: 0,
      targetClientId: desktop.clientId,
    });
    assert.ok(transferred.ok);
    const claim = await claimGrant(backend, desktop);
    assert.equal(claim.status, 200);
    return claim.ownerToken!;
  })();

  const snapshot = await desktopSnapshot(backend, desktop);
  const transferBack = await desktopCommand(
    backend,
    desktop,
    { type: "transferOwner", targetClientId: browser.clientId, expectedRevision: snapshot.revision },
    granted,
  );
  assert.equal(transferBack.status, 200);
  assert.ok(transferBack.ack.ok);

  // The browser receives the new owner token over its socket.
  const newBrowserToken = await ownerTokenPromise;
  assert.ok(newBrowserToken);

  // The desktop's previous token is dead: locking now fails.
  const staleLock = await desktopCommand(
    backend,
    desktop,
    { type: "lock", locked: false, expectedRevision: snapshot.revision + 1 },
    granted,
  );
  assert.equal(staleLock.status, 403);

  // The browser owner can control again with the rotated token.
  const unlock = await socketCommand(browserSocket, "CMD:lock", {
    expectedRevision: transferBack.ack.revision ?? snapshot.revision + 1,
    locked: false,
  });
  assert.ok(unlock.ok);
});

test("desktop members rename themselves through the native command route", async () => {
  const backend = await boot();
  const browser = await createBrowserRoom(backend);
  const desktop = await joinDesktop(backend, browser.roomId, "OldName");
  const snapshot = await desktopSnapshot(backend, desktop);

  const renamed = await desktopCommand(backend, desktop, { type: "name", name: "  新名字  ", expectedRevision: snapshot.revision });
  assert.equal(renamed.status, 200);
  assert.ok(renamed.ack.ok);

  const members = await (await fetch(url(backend, `/api/rooms/${desktop.roomId}/desktop/members`), {
    headers: {
      authorization: `Bearer ${desktop.accessToken}`,
      "x-watchparty-protocol": "2",
      "x-watchparty-client-type": "desktop",
      "x-watchparty-session-generation": String(desktop.generation),
    },
  })).json() as Array<{ clientId: string; name: string }>;
  assert.equal(members.find((member) => member.clientId === desktop.clientId)?.name, "新名字");

  const invalid = await desktopCommand(backend, desktop, { type: "name", name: "", expectedRevision: snapshot.revision + 1 });
  assert.equal(invalid.status, 400);
});

test("desktop owner manages media and playlist over the native command route", async () => {
  const backend = await boot();
  const created = await createBrowserRoom(backend);
  const browserSocket = connect(backend, created.roomId, created.clientId, created.accessToken, created.ownerToken);
  await connected(browserSocket);

  const desktop = await joinDesktop(backend, created.roomId, "MediaOwner");
  const transferred = await socketCommand(browserSocket, "CMD:transferOwner", {
    expectedRevision: 0,
    targetClientId: desktop.clientId,
  });
  assert.ok(transferred.ok);
  const grant = await claimGrant(backend, desktop);
  assert.equal(grant.status, 200);
  const ownerToken = grant.ownerToken!;

  const media = {
    kind: "openlist",
    mediaId: "media-1",
    title: "Episode 1.mkv",
    container: "mkv",
  };

  // mediaSet requires the owner header.
  const noHeader = await desktopCommand(backend, desktop, { type: "mediaSet", media, expectedRevision: 1 });
  assert.equal(noHeader.status, 403);
  const mediaSet = await desktopCommand(backend, desktop, { type: "mediaSet", media, expectedRevision: 1 }, ownerToken);
  assert.equal(mediaSet.status, 200);
  assert.ok(mediaSet.ack.ok);

  // playlistAdd appends; playlistMove reorders; playlistRemove drops.
  const add = await desktopCommand(backend, desktop, { type: "playlistAdd", media, expectedRevision: 2 }, ownerToken);
  assert.equal(add.status, 200);
  const move = await desktopCommand(
    backend,
    desktop,
    { type: "playlistMove", itemId: (await desktopSnapshot(backend, desktop)).playlist[0]!.id, targetIndex: 0, expectedRevision: 3 },
    ownerToken,
  );
  assert.equal(move.status, 200);
  const itemId = (await desktopSnapshot(backend, desktop)).playlist[0]!.id;
  const remove = await desktopCommand(backend, desktop, { type: "playlistRemove", itemId, expectedRevision: 4 }, ownerToken);
  assert.equal(remove.status, 200);
  assert.ok(remove.ack.ok);

  // Invalid media shapes never reach Room.execute.
  const invalid = await desktopCommand(
    backend,
    desktop,
    { type: "playlistAdd", media: { kind: "openlist", mediaId: "a/b", title: "x", container: "mp4" }, expectedRevision: 5 },
    ownerToken,
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.ack.error?.code, "INVALID_REQUEST");
});
