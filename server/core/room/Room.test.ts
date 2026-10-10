import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./Room.ts";

const rooms: Room[] = [];
const owner = "11111111-1111-4111-8111-111111111111";
const guest = "22222222-2222-4222-8222-222222222222";
const media = { kind: "http" as const, url: "https://example.com/a.mp4" };

function createRoom() {
  let now = 1_000_000;
  const room = new Room("abc123", owner, { now: () => now });
  rooms.push(room);
  return {
    room,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  while (rooms.length) rooms.pop()?.destroy();
});

test("new rooms are locked and use an authoritative snapshot", () => {
  const { room } = createRoom();
  const snapshot = room.snapshot();
  assert.equal(snapshot.locked, true);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.ownerClientId, owner);
  assert.equal(snapshot.source, null);
  assert.equal(snapshot.serverTimeMs, 1_000_000);
});

test("shared playback advances from the server clock", () => {
  const { room, advance } = createRoom();
  room.join(owner, "Owner");
  assert.equal(
    room.execute(owner, { type: "mediaSet", media }, 0, true).ok,
    true,
  );
  assert.equal(room.execute(owner, { type: "play" }, 1, true).ok, true);
  advance(2_000);
  assert.equal(room.snapshot().positionSeconds, 2);
  assert.equal(room.execute(owner, { type: "pause" }, 2, true).ok, true);
  advance(2_000);
  assert.equal(room.snapshot().positionSeconds, 2);
});

test("media commands store normalized YouTube sources only", () => {
  const { room } = createRoom();
  const source = {
    kind: "youtube" as const,
    url: "https://youtu.be/dQw4w9WgXcQ?si=tracking",
    title: "Video",
    cookie: "must-not-survive",
  } as unknown as { kind: "youtube"; videoId: string; title?: string };
  const result = room.execute(owner, { type: "mediaSet", media: source }, 0, true);
  assert.equal(result.ok, true);
  assert.deepEqual(room.snapshot().source, { kind: "youtube", videoId: "dQw4w9WgXcQ", title: "Video" });
  assert.equal(room.execute(owner, { type: "playlistAdd", media: source }, 1, true).ok, true);
  assert.deepEqual(room.snapshot().playlist[0]?.media, room.snapshot().source);
});

test("initial YouTube source drops fields outside the media contract", () => {
  const initialMedia = { kind: "youtube" as const, videoId: "dQw4w9WgXcQ", cookie: "synthetic", manifest: "synthetic" };
  const room = new Room("initial-room", owner, { initialMedia });
  rooms.push(room);
  assert.deepEqual(room.snapshot().source, { kind: "youtube", videoId: "dQw4w9WgXcQ" });
});

test("guests can use shared controls while owner-only commands stay protected", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  room.join(guest, "Guest");
  assert.equal(room.execute(guest, { type: "play" }, 0, false).ok, true);
  assert.equal(room.execute(guest, { type: "pause" }, 1, false).ok, true);
  assert.equal(room.execute(guest, { type: "playlistAdd", media }, 2, false).ok, true);
  const item = room.snapshot().playlist[0];
  assert.ok(item);
  assert.equal(room.execute(guest, { type: "playlistMove", itemId: item.id, targetIndex: 0 }, 3, false).ok, true);
  assert.equal(room.execute(guest, { type: "playlistRemove", itemId: item.id }, 4, false).ok, true);
  const forbidden = [
    { type: "mediaSet", media },
    { type: "seek", positionSeconds: 1 },
    { type: "rate", rate: 1.25 },
    { type: "loop", loop: true },
    { type: "playlistNext" },
    { type: "playlistAutoNext" },
  ] as const;
  for (const command of forbidden) {
    const result = room.execute(guest, command, 5, false);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "FORBIDDEN");
  }
});

test("automatic playlist advancement is owner-only and guards stale entries", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  room.execute(owner, { type: "playlistAdd", media }, 0, true);
  room.execute(owner, { type: "playlistAdd", media }, 1, true);
  const [first, second] = room.snapshot().playlist;
  room.execute(owner, { type: "playlistPlay", itemId: first.id }, 2, true);
  const manual = room.execute(guest, { type: "playlistNext", expectedCurrentPlaylistItemId: first.id }, 3, false);
  assert.equal(manual.ok, false);
  assert.equal(manual.error?.code, "FORBIDDEN");
  const automaticByGuest = room.execute(guest, { type: "playlistAutoNext", expectedCurrentPlaylistItemId: first.id }, 3, false);
  assert.equal(automaticByGuest.ok, false);
  assert.equal(automaticByGuest.error?.code, "FORBIDDEN");
  const automatic = room.execute(owner, { type: "playlistAutoNext", expectedCurrentPlaylistItemId: first.id }, 3, true);
  assert.equal(automatic.ok, true);
  assert.equal(room.snapshot().currentPlaylistItemId, second.id);
});

test("playlist entries have stable ids and a hard limit", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  assert.equal(
    room.execute(owner, { type: "lock", locked: false }, 0, true).ok,
    true,
  );
  const first = room.execute(owner, { type: "playlistAdd", media }, 1, true);
  assert.equal(first.ok, true);
  const item = room.snapshot().playlist[0];
  assert.ok(item?.id);
  assert.equal(item?.media.kind, "http");
  assert.equal(
    room.execute(
      owner,
      { type: "playlistMove", itemId: "missing", targetIndex: 0 },
      2,
      true,
    ).ok,
    false,
  );
});

test("playlistNext guards against stale clients via expectedCurrentPlaylistItemId", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  room.execute(owner, { type: "lock", locked: false }, 0, true);
  room.execute(owner, { type: "playlistAdd", media }, 1, true);
  room.execute(owner, { type: "playlistAdd", media }, 2, true);
  const [first, second] = room.snapshot().playlist;
  room.execute(owner, { type: "playlistPlay", itemId: first.id }, 3, true);

  // A stale end-file (still pointing at another entry) must not advance.
  const stale = room.execute(
    owner,
    { type: "playlistNext", expectedCurrentPlaylistItemId: second.id },
    4,
    true,
  );
  assert.equal(stale.ok, false);
  assert.equal(room.snapshot().currentPlaylistItemId, first.id);
  assert.equal(room.snapshot().revision, 4);

  // Matching entry advances normally.
  const ack = room.execute(
    owner,
    { type: "playlistNext", expectedCurrentPlaylistItemId: first.id },
    4,
    true,
  );
  assert.equal(ack.ok, true);
  assert.equal(room.snapshot().currentPlaylistItemId, second.id);
});

test("playlist end semantics follow the loop flag", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  room.execute(owner, { type: "lock", locked: false }, 0, true);
  room.execute(owner, { type: "playlistAdd", media }, 1, true);
  room.execute(owner, { type: "playlistAdd", media }, 2, true);
  const [first, second] = room.snapshot().playlist;
  room.execute(owner, { type: "playlistPlay", itemId: second.id }, 3, true);

  // loop=false: the end of the list is a no-op with a stable revision.
  const revision = room.snapshot().revision;
  assert.equal(
    room.execute(owner, { type: "playlistNext" }, revision, true).ok,
    true,
  );
  assert.equal(room.snapshot().currentPlaylistItemId, second.id);
  assert.equal(room.snapshot().revision, revision);

  // loop=true: wrap back to the first item. (No-op next left the revision unchanged.)
  room.execute(owner, { type: "loop", loop: true }, revision, true);
  assert.equal(
    room.execute(owner, { type: "playlistNext" }, revision + 1, true).ok,
    true,
  );
  assert.equal(room.snapshot().currentPlaylistItemId, first.id);
});

test("playlist playback keeps the room loop preference across play and next", () => {
  const { room } = createRoom();
  room.join(owner, "Owner");
  room.execute(owner, { type: "lock", locked: false }, 0, true);
  room.execute(owner, { type: "playlistAdd", media }, 1, true);
  room.execute(owner, { type: "playlistAdd", media }, 2, true);
  const [first, second] = room.snapshot().playlist;

  room.execute(owner, { type: "loop", loop: true }, 3, true);
  room.execute(owner, { type: "playlistPlay", itemId: second.id }, 4, true);
  assert.equal(room.snapshot().loop, true);

  const ack = room.execute(
    owner,
    { type: "playlistNext", expectedCurrentPlaylistItemId: second.id },
    5,
    true,
  );
  assert.equal(ack.ok, true);
  assert.equal(room.snapshot().currentPlaylistItemId, first.id);
  assert.equal(room.snapshot().loop, true);
});
