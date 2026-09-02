import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { io as clientIo, type Socket } from "socket.io-client";
import { createBackend, type Backend } from "../app.ts";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  WireHostState,
} from "../core/protocol.ts";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type TestEventTarget = {
  once<K extends keyof ServerToClientEvents>(
    event: K,
    listener: ServerToClientEvents[K],
  ): void;
  on<K extends keyof ServerToClientEvents>(
    event: K,
    listener: ServerToClientEvents[K],
  ): void;
  off<K extends keyof ServerToClientEvents>(
    event: K,
    listener: ServerToClientEvents[K],
  ): void;
};

const backends: Backend[] = [];
const sockets: TestSocket[] = [];

afterEach(async () => {
  while (sockets.length) {
    const socket = sockets.pop();
    socket?.removeAllListeners();
    socket?.disconnect();
  }
  while (backends.length) {
    await backends.pop()?.close();
  }
});

async function boot(): Promise<Backend> {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

function origin(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

function connect(
  backend: Backend,
  roomName: string,
  clientId: string,
  roomToken?: string,
): TestSocket {
  const socket = clientIo(origin(backend) + roomName, {
    transports: ["websocket"],
    query: { clientId, roomId: roomName.slice(1) },
    auth: { sessionId: crypto.randomUUID(), roomToken },
    autoConnect: true,
  }) as TestSocket;
  sockets.push(socket);
  return socket;
}

function onceEvent<K extends keyof ServerToClientEvents>(
  socket: TestSocket,
  event: K,
  ms = 3000,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  const events = socket as unknown as TestEventTarget;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${String(event)}`));
    }, ms);
    const listener = (...args: Parameters<ServerToClientEvents[K]>) => {
      clearTimeout(timer);
      resolve(args[0]);
    };
    events.once(event, listener as ServerToClientEvents[K]);
  });
}

function waitForConnect(socket: TestSocket): Promise<void> {
  if (socket.connected) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

function waitForEvent<K extends keyof ServerToClientEvents>(
  socket: TestSocket,
  event: K,
  predicate: (payload: Parameters<ServerToClientEvents[K]>[0]) => boolean,
  ms = 3000,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  const events = socket as unknown as TestEventTarget;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.off(event, listener as ServerToClientEvents[K]);
      reject(new Error(`timeout waiting for matching ${String(event)}`));
    }, ms);
    const listener = (...args: Parameters<ServerToClientEvents[K]>) => {
      const payload = args[0];
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      events.off(event, listener as ServerToClientEvents[K]);
      resolve(payload);
    };
    events.on(event, listener as ServerToClientEvents[K]);
  });
}

async function createRoom(
  backend: Backend,
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await fetch(origin(backend) + "/createRoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true);
  const data = (await response.json()) as { name: string };
  assert.equal(typeof data.name, "string");
  assert.match(data.name, /^\//);
  return data.name;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("importing createBackend does not listen", () => {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
  });
  backends.push(backend);
  assert.equal(backend.httpServer.listening, false);
});

test("ping and createRoom work; uid is ignored", async () => {
  const backend = await boot();
  const ping = await fetch(origin(backend) + "/ping");
  assert.equal(await ping.json(), "pong");
  const name = await createRoom(backend, {
    uid: "should-be-ignored",
    token: "nope",
    video: "https://example.com/pre.mp4",
  });
  const room = backend.registry.get(name);
  assert.ok(room);
  assert.equal(room.snapshot().video, "https://example.com/pre.mp4");
  assert.equal(room.snapshot().paused, true);
});

test("protected room exposes info, verifies PIN, and gates socket access", async () => {
  const backend = await boot();
  const created = await fetch(origin(backend) + "/createRoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "8024" }),
  });
  assert.equal(created.status, 200);
  const creation = (await created.json()) as {
    name: string;
    isProtected: boolean;
  };
  assert.equal(creation.isProtected, true);

  const roomId = creation.name.slice(1);
  const info = await fetch(origin(backend) + `/roomInfo/${roomId}`);
  assert.deepEqual(await info.json(), {
    roomId,
    exists: true,
    isProtected: true,
    onlineCount: 0,
  });

  const rejected = connect(backend, creation.name, crypto.randomUUID());
  const rejection = await new Promise<Error>((resolve) => {
    rejected.once("connect_error", resolve);
  });
  assert.match(rejection.message, /authentication required/i);

  const invalidPin = await fetch(origin(backend) + "/verifyRoomPin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, pin: "0000" }),
  });
  assert.equal(invalidPin.status, 401);

  const validPin = await fetch(origin(backend) + "/verifyRoomPin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, pin: "8024" }),
  });
  const verification = (await validPin.json()) as {
    valid: boolean;
    token: string;
  };
  assert.equal(verification.valid, true);
  assert.ok(verification.token);

  const accepted = connect(
    backend,
    creation.name,
    crypto.randomUUID(),
    verification.token,
  );
  await waitForConnect(accepted);
});

test("createRoom rejects passwords that are not four digit PINs", async () => {
  const backend = await boot();
  const response = await fetch(origin(backend) + "/createRoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "abc" }),
  });
  assert.equal(response.status, 400);
});

test("legacy SaaS routes are 404; resolveShard is empty", async () => {
  const backend = await boot();
  for (const path of [
    "/stats",
    "/metadata",
    "/checkoutSub",
    "/listRooms",
    "/proxy/foo",
    "/downloadSubtitles",
  ]) {
    const response = await fetch(origin(backend) + path);
    assert.equal(response.status, 404, path);
  }
  const shard = await fetch(origin(backend) + "/resolveShard/some-room");
  assert.equal(await shard.text(), "");
});

test("two clients receive the initial snapshot", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend);
  const aId = crypto.randomUUID();
  const bId = crypto.randomUUID();
  const a = connect(backend, roomName, aId);
  const hostA = onceEvent(a, "REC:host");
  const chatA = onceEvent(a, "chatinit");
  const playlistA = onceEvent(a, "playlist");
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      a.once("connect", () => resolve());
      a.once("connect_error", reject);
    }),
    hostA,
    chatA,
    playlistA,
  ]);
  const host = await hostA;
  assert.equal(host.video, "");
  assert.equal(host.isVBrowserLarge, false);
  assert.equal(host.controller, aId);
  assert.equal(host.isLocked, false);
  const b = connect(backend, roomName, bId);
  const roster = await onceEvent(b, "roster");
  assert.ok(roster.some((user) => user.id === aId));
  assert.ok(roster.some((user) => user.id === bId));
});

test("play pause seek are not echoed to the sender", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend, {
    video: "https://example.com/a.mp4",
  });
  const a = connect(backend, roomName, crypto.randomUUID());
  const b = connect(backend, roomName, crypto.randomUUID());
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      a.once("connect", () => resolve());
      a.once("connect_error", reject);
    }),
    new Promise<void>((resolve, reject) => {
      b.once("connect", () => resolve());
      b.once("connect_error", reject);
    }),
  ]);
  const playsA: unknown[] = [];
  const playsB: unknown[] = [];
  const pausesA: unknown[] = [];
  const pausesB: unknown[] = [];
  const seeksA: number[] = [];
  const seeksB: number[] = [];
  a.on("REC:play", (payload) => playsA.push(payload));
  b.on("REC:play", (payload) => playsB.push(payload));
  a.on("REC:pause", () => pausesA.push(true));
  b.on("REC:pause", () => pausesB.push(true));
  a.on("REC:seek", (t) => seeksA.push(t));
  b.on("REC:seek", (t) => seeksB.push(t));
  a.emit("CMD:play");
  await delay(80);
  assert.equal(playsA.length, 0);
  assert.equal(playsB.length, 1);
  a.emit("CMD:pause");
  await delay(80);
  assert.equal(pausesA.length, 0);
  assert.equal(pausesB.length, 1);
  a.emit("CMD:seek", 42);
  await delay(80);
  assert.deepEqual(seeksA, []);
  assert.deepEqual(seeksB, [42]);
});

test("only the host can lock playback controls", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend);
  const host = connect(backend, roomName, crypto.randomUUID());
  await waitForConnect(host);
  const guest = connect(backend, roomName, crypto.randomUUID());
  await waitForConnect(guest);

  const lockedForGuest = onceEvent(guest, "REC:lock");
  host.emit("CMD:lock", true);
  assert.equal(await lockedForGuest, true);

  guest.emit("CMD:pause");
  await delay(50);
  assert.equal(backend.registry.get(roomName)?.snapshot().paused, false);

  host.emit("CMD:pause");
  await delay(50);
  assert.equal(backend.registry.get(roomName)?.snapshot().paused, true);
});

test("rate loop and timestamps are synchronized", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend, {
    video: "https://example.com/a.mp4",
  });
  const aId = crypto.randomUUID();
  const a = connect(backend, roomName, aId);
  const b = connect(backend, roomName, crypto.randomUUID());
  await Promise.all([waitForConnect(a), waitForConnect(b)]);

  const ratesA = onceEvent(a, "REC:playbackRate");
  const ratesB = onceEvent(b, "REC:playbackRate");
  a.emit("CMD:playbackRate", 1.5);
  assert.deepEqual(await Promise.all([ratesA, ratesB]), [1.5, 1.5]);

  const loopsA = onceEvent(a, "REC:loop");
  const loopsB = onceEvent(b, "REC:loop");
  a.emit("CMD:loop", true);
  assert.deepEqual(await Promise.all([loopsA, loopsB]), [true, true]);

  await delay(1100);
  const timestamp = waitForEvent(
    b,
    "REC:tsMap",
    (tsMap) => typeof tsMap[aId] === "number",
  );
  a.emit("CMD:ts", 12);
  const tsMap = await timestamp;
  assert.equal(typeof tsMap[aId], "number");
});

test("chat replies reactions and playlist mutations reach both clients", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend, {
    video: "https://example.com/current.mp4",
  });
  const a = connect(backend, roomName, crypto.randomUUID());
  const b = connect(backend, roomName, crypto.randomUUID());
  await Promise.all([waitForConnect(a), waitForConnect(b)]);

  const firstA = onceEvent(a, "REC:chat");
  const firstB = onceEvent(b, "REC:chat");
  a.emit("CMD:chat", "hello");
  const [messageA, messageB] = await Promise.all([firstA, firstB]);
  assert.equal(messageA.msg, "hello");
  assert.equal(messageB.timestamp, messageA.timestamp);

  const replyA = onceEvent(a, "REC:chat");
  const replyB = onceEvent(b, "REC:chat");
  b.emit("CMD:chatV2", {
    msg: "reply",
    replyToId: messageA.id,
    replyToTimestamp: messageA.timestamp,
  });
  const [reply] = await Promise.all([replyA, replyB]);
  assert.equal(reply.replyToMsg, "hello");

  const reaction = {
    value: "👍",
    msgId: messageA.id,
    msgTimestamp: messageA.timestamp,
  };
  const addedA = onceEvent(a, "REC:addReaction");
  const addedB = onceEvent(b, "REC:addReaction");
  b.emit("CMD:addReaction", reaction);
  const [added] = await Promise.all([addedA, addedB]);
  assert.equal(added.value, "👍");

  const removedA = onceEvent(a, "REC:removeReaction");
  const removedB = onceEvent(b, "REC:removeReaction");
  b.emit("CMD:removeReaction", reaction);
  await Promise.all([removedA, removedB]);

  const firstPlaylist = onceEvent(b, "playlist");
  a.emit("CMD:playlistAdd", "https://example.com/one.mp4");
  assert.equal((await firstPlaylist)[0]?.url, "https://example.com/one.mp4");
  const secondPlaylist = onceEvent(b, "playlist");
  a.emit("CMD:playlistAdd", "https://example.com/two.mp4");
  await secondPlaylist;
  const movedPlaylist = onceEvent(b, "playlist");
  a.emit("CMD:playlistMove", { index: 1, toIndex: 0 });
  assert.equal((await movedPlaylist)[0]?.url, "https://example.com/two.mp4");
  const deletedPlaylist = onceEvent(b, "playlist");
  a.emit("CMD:playlistDelete", 1);
  assert.equal((await deletedPlaylist).length, 1);
});

test("host goes to everyone; askHost is requester-only", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend);
  const a = connect(backend, roomName, crypto.randomUUID());
  const b = connect(backend, roomName, crypto.randomUUID());
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      a.once("connect", () => resolve());
      a.once("connect_error", reject);
    }),
    new Promise<void>((resolve, reject) => {
      b.once("connect", () => resolve());
      b.once("connect_error", reject);
    }),
  ]);
  const hostsB: WireHostState[] = [];
  b.on("REC:host", (state) => hostsB.push(state));
  const hostsA: WireHostState[] = [];
  a.on("REC:host", (state) => hostsA.push(state));
  a.emit("CMD:host", "https://example.com/movie.mp4");
  await delay(80);
  assert.equal(hostsA.length, 1);
  assert.equal(hostsB.length, 1);
  assert.equal(hostsA[0]?.video, "https://example.com/movie.mp4");
  assert.equal(hostsA[0]?.isVBrowserLarge, false);
  a.emit("CMD:askHost");
  await delay(80);
  assert.equal(hostsA.length, 2);
  assert.equal(hostsB.length, 1);
});

test("unknown legacy CMD is ignored", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend, {
    video: "https://example.com/a.mp4",
  });
  const a = connect(backend, roomName, crypto.randomUUID());
  await new Promise<void>((resolve, reject) => {
    a.once("connect", () => resolve());
    a.once("connect_error", reject);
  });
  const video = backend.registry.get(roomName)?.snapshot().video;
  (a as Socket).emit("CMD:uid", { uid: "x", token: "y" });
  (a as Socket).emit("CMD:lock", { locked: true });
  (a as Socket).emit("CMD:startVBrowser", {});
  await delay(80);
  assert.equal(backend.registry.get(roomName)?.snapshot().video, video);
});

test("invalid IDs are rejected; reconnect preserves in-memory state", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend, {
    video: "https://example.com/reconnect.mp4",
  });
  const invalid = connect(backend, roomName, "not-a-uuid");
  const error = await new Promise<Error>((resolve) => {
    invalid.once("connect_error", resolve);
  });
  assert.match(error.message, /Invalid clientId format/);

  const clientId = crypto.randomUUID();
  const first = connect(backend, roomName, clientId);
  await waitForConnect(first);
  const chat = onceEvent(first, "REC:chat");
  first.emit("CMD:chat", "persist in memory");
  await chat;
  first.disconnect();
  await delay(50);

  const reconnected = connect(backend, roomName, clientId);
  const host = onceEvent(reconnected, "REC:host");
  const history = onceEvent(reconnected, "chatinit");
  await waitForConnect(reconnected);
  assert.equal((await host).video, "https://example.com/reconnect.mp4");
  assert.ok(
    (await history).some((message) => message.msg === "persist in memory"),
  );
});

test("a duplicate client ID disconnects the older socket", async () => {
  const backend = await boot();
  const roomName = await createRoom(backend);
  const clientId = crypto.randomUUID();
  const first = connect(backend, roomName, clientId);
  await waitForConnect(first);
  const disconnected = new Promise<string>((resolve) => {
    first.once("disconnect", resolve);
  });
  const replacement = connect(backend, roomName, clientId);
  await waitForConnect(replacement);
  assert.equal(await disconnected, "io server disconnect");
  assert.equal(backend.registry.get(roomName)?.roster.length, 1);
});

test("close releases the port", async () => {
  const backend = await boot();
  const port = backend.port;
  assert.equal(backend.httpServer.listening, true);
  await backend.close();
  backends.length = 0;
  const again = createBackend({
    host: "127.0.0.1",
    port,
    pruneIntervalMs: 0,
    serveStatic: false,
  });
  await again.start();
  backends.push(again);
  assert.equal(again.port, port);
});
