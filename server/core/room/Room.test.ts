import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./Room.ts";
import { CORE_REC } from "../protocol.ts";
import type { RoomEvent } from "../protocol.ts";

const rooms: Room[] = [];

function createRoom(id = "/test"): {
  room: Room;
  events: RoomEvent[];
} {
  let now = 1_000_000;
  const room = new Room(id, { now: () => now });
  rooms.push(room);
  const events: RoomEvent[] = [];
  room.onEvent((event) => events.push(event));
  return {
    room: Object.assign(room, {
      advanceClock(ms: number) {
        now += ms;
      },
    }) as Room & { advanceClock(ms: number): void },
    events,
  };
}

function clockOf(room: Room): (ms: number) => void {
  return (ms: number) => {
    (room as Room & { advanceClock(ms: number): void }).advanceClock(ms);
  };
}

afterEach(() => {
  while (rooms.length) {
    rooms.pop()?.destroy();
  }
});

test("create room snapshot is empty host state", () => {
  const { room } = createRoom("/alpha");
  const snap = room.snapshot();
  assert.equal(room.id, "/alpha");
  assert.equal(snap.video, "");
  assert.equal(snap.paused, false);
  assert.equal(snap.videoTS, 0);
  assert.equal(snap.loop, false);
  assert.equal(snap.playbackRate, 1);
  assert.equal("isVBrowserLarge" in snap, false);
  assert.equal(snap.controller, undefined);
  assert.equal(snap.isLocked, false);
  assert.deepEqual(snap.chat, []);
  assert.deepEqual(snap.playlist, []);
  assert.deepEqual(snap.roster, []);
});

test("host URL sets video and emits REC:host", () => {
  const { room, events } = createRoom();
  room.apply("c1", { type: "host", url: "https://example.com/a.mp4" });
  const snap = room.snapshot();
  assert.equal(snap.video, "https://example.com/a.mp4");
  assert.equal(snap.paused, false);
  assert.equal(snap.videoTS, 0);
  assert.ok(events.some((e) => e.event === CORE_REC.host));
  assert.equal(snap.chat[0]?.cmd, "host");
});

test("play pause seek update state and exclude the commander", () => {
  const { room, events } = createRoom();
  room.apply("c1", { type: "host", url: "https://example.com/a.mp4" });
  room.apply("c1", { type: "pause" });
  assert.equal(room.snapshot().paused, true);
  assert.ok(
    events.some((e) => e.event === CORE_REC.pause && e.target?.except === "c1"),
  );
  room.apply("c1", { type: "play" });
  assert.equal(room.snapshot().paused, false);
  assert.ok(
    events.some((e) => e.event === CORE_REC.play && e.target?.except === "c1"),
  );
  room.apply("c1", { type: "seek", t: 42 });
  assert.equal(room.snapshot().videoTS, 42);
  assert.ok(
    events.some(
      (e) =>
        e.event === CORE_REC.seek &&
        e.payload === 42 &&
        e.target?.except === "c1",
    ),
  );
});

test("only the controller can lock and locked playback rejects guests", () => {
  const { room, events } = createRoom();
  room.join("host");
  room.join("guest");
  room.apply("guest", { type: "lock", locked: true });
  assert.equal(room.snapshot().isLocked, false);

  room.apply("host", { type: "lock", locked: true });
  assert.equal(room.snapshot().isLocked, true);
  room.apply("guest", { type: "pause" });
  assert.equal(room.snapshot().paused, false);
  room.apply("host", { type: "pause" });
  assert.equal(room.snapshot().paused, true);
  assert.ok(
    events.some(
      (event) => event.event === CORE_REC.lock && event.payload === true,
    ),
  );

  room.leave("host");
  assert.equal(room.snapshot().controller, "guest");
});

test("non-finite seek is ignored", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "host", url: "https://example.com/a.mp4" });
  room.apply("c1", { type: "seek", t: Number.NaN });
  assert.equal(room.snapshot().videoTS, 0);
  room.apply("c1", { type: "seek", t: Infinity });
  assert.equal(room.snapshot().videoTS, 0);
});

test("ts only advances after host ignore window, live offset may go negative", () => {
  const created = createRoom();
  const room = created.room;
  const advance = clockOf(room);
  room.apply("c1", { type: "host", url: "https://example.com/a.mp4" });
  room.apply("c1", { type: "ts", t: 9 });
  assert.equal(room.snapshot().videoTS, 0, "ts ignored immediately after host");
  advance(2000);
  room.apply("c1", { type: "ts", t: 9 });
  assert.equal(room.snapshot().videoTS, 9);
  room.apply("c1", { type: "ts", t: 4 });
  assert.equal(room.snapshot().videoTS, 9, "lagging ts does not rewind");
  room.apply("c1", { type: "ts", t: 15 });
  assert.equal(room.snapshot().videoTS, 15);
  room.apply("c1", { type: "ts", t: -1 });
  assert.equal(room.snapshot().videoTS, -1);
});

test("chat rejects over-length messages and caps history at 100", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "chat", msg: "x".repeat(10001) });
  assert.equal(room.snapshot().chat.length, 0);
  room.apply("c1", { type: "chat", msg: "ok" });
  assert.equal(room.snapshot().chat.length, 1);
  for (let i = 0; i < 105; i += 1) {
    room.apply("c1", { type: "chat", msg: String(i) });
  }
  const chat = room.snapshot().chat;
  assert.equal(chat.length, 100);
  assert.equal(chat[0]?.msg, "5");
  assert.equal(chat[99]?.msg, "104");
});

test("chat reply copies target text; one-sided reply fields are ignored", () => {
  const { room } = createRoom();
  room.apply("a", { type: "chat", msg: "hello" });
  const first = room.snapshot().chat[0];
  assert.ok(first);
  room.apply("b", {
    type: "chat",
    msg: "re",
    replyToId: first.id,
    replyToTimestamp: first.timestamp,
  });
  const reply = room.snapshot().chat[1];
  assert.equal(reply?.msg, "re");
  assert.equal(reply?.replyToMsg, "hello");
  room.apply("b", { type: "chat", msg: "partial", replyToId: first.id });
  assert.equal(room.snapshot().chat.length, 2);
});

test("duplicate reaction does not emit twice", () => {
  const { room, events } = createRoom();
  room.apply("c1", { type: "chat", msg: "hi" });
  const msg = room.snapshot().chat[0];
  assert.ok(msg);
  const reaction = {
    value: "👍",
    msgId: msg.id,
    msgTimestamp: msg.timestamp,
  };
  room.addReaction("c1", reaction);
  room.addReaction("c1", reaction);
  assert.equal(
    events.filter((e) => e.event === CORE_REC.addReaction).length,
    1,
  );
});

test("playlist add auto-plays when idle, next advances", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/a.mp4" });
  assert.equal(room.snapshot().video, "https://example.com/a.mp4");
  assert.equal(room.snapshot().playlist.length, 0);
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/b.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/c.mp4" });
  room.apply("c1", { type: "playlistNext" });
  assert.equal(room.snapshot().video, "https://example.com/b.mp4");
  room.apply("c1", { type: "host", url: "" });
  assert.equal(room.snapshot().video, "https://example.com/c.mp4");
  assert.equal(room.snapshot().playlist.length, 0);
});

test("empty playlist url and out-of-range indexes are ignored", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "host", url: "https://example.com/now.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "" });
  assert.equal(room.snapshot().playlist.length, 0);
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/1.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/2.mp4" });
  const before = room.snapshot().playlist.map((item) => item.url);
  room.apply("c1", { type: "playlistDelete", index: -1 });
  room.apply("c1", { type: "playlistDelete", index: 9 });
  room.apply("c1", { type: "playlistMove", index: -1, toIndex: 0 });
  room.apply("c1", { type: "playlistMove", index: 0, toIndex: -2 });
  room.apply("c1", { type: "playlistMove", index: 0, toIndex: 2 });
  assert.deepEqual(
    room.snapshot().playlist.map((item) => item.url),
    before,
  );
});

test("playlist move and delete reorder the queue", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "host", url: "https://example.com/now.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/1.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/2.mp4" });
  room.apply("c1", { type: "playlistAdd", url: "https://example.com/3.mp4" });
  room.apply("c1", { type: "playlistMove", index: 2, toIndex: 0 });
  assert.deepEqual(
    room.snapshot().playlist.map((item) => item.url),
    [
      "https://example.com/3.mp4",
      "https://example.com/1.mp4",
      "https://example.com/2.mp4",
    ],
  );
  room.apply("c1", { type: "playlistDelete", index: 1 });
  assert.deepEqual(
    room.snapshot().playlist.map((item) => item.url),
    ["https://example.com/3.mp4", "https://example.com/2.mp4"],
  );
});

test("name is stored in nameMap; over-length names are ignored", () => {
  const { room } = createRoom();
  room.apply("c1", { type: "name", name: "Ada" });
  assert.equal(room.snapshot().nameMap.c1, "Ada");
  room.apply("c1", { type: "name", name: "x".repeat(51) });
  assert.equal(room.snapshot().nameMap.c1, "Ada");
});

test("loop and playbackRate emit to everyone", () => {
  const { room, events } = createRoom();
  room.apply("c1", { type: "playbackRate", rate: 1.5 });
  assert.equal(room.snapshot().playbackRate, 1.5);
  room.apply("c1", { type: "loop", on: true });
  assert.equal(room.snapshot().loop, true);
  assert.equal(
    events.find((e) => e.event === CORE_REC.playbackRate)?.target,
    undefined,
  );
  assert.equal(
    events.find((e) => e.event === CORE_REC.loop)?.target,
    undefined,
  );
});
