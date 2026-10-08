import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig, type AppConfig } from "../config.ts";
import type { OpenlistClient } from "../media/openlist.ts";
import type { StoredSource } from "../media/library-store.ts";
import type { SubtitleTrack } from "../media/watchparty-media.ts";

/**
 * 字幕上传（媒体级持久）的服务端验收面：契约见
 * temp-html/subtitle-upload-contract-2026-10-08.md §4。
 */

const backends: Backend[] = [];
const tempDirs: string[] = [];
const FILM = "/media/openlist-bdyun/Multimedia/Film";
const SRT = "1\n00:00:01,000 --> 00:00:02,000\n你好\n";

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
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

/** 一个视频旁边挂着 `Same.chs.ass`，就是"无字幕片源 + 旁挂一条"的典型形态。 */
function fakeClient(source: StoredSource): OpenlistClient {
  const host = new URL(source.internalBaseUrl).host;
  return {
    async list() {
      return {
        code: 200,
        data: {
          content: [
            { name: "Same.chs.ass", is_dir: false, size: 40, path: `${FILM}/Same.chs.ass` },
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

async function boot(options: { subtitleDbPath?: string } = {}): Promise<Backend> {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    libraryDbPath: ":memory:",
    catalogDbPath: ":memory:",
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

/** 另一个成员（不是房主）：删除权限要落在他身上被拒。 */
async function joinRoom(backend: Backend, roomId: string): Promise<string> {
  const response = await fetch(`${origin(backend)}/api/rooms/${roomId}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), nickname: "Member" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function videoId(backend: Backend, room: { roomId: string; accessToken: string }): Promise<string> {
  const response = await fetch(`${origin(backend)}/api/media/list?libraryId=lib_film&path=/`, {
    headers: { "x-watchparty-room": room.roomId, "x-watchparty-token": room.accessToken },
  });
  assert.equal(response.status, 200);
  const page = await response.json() as { items: Array<{ name: string; id: string }> };
  const id = page.items.find((item) => item.name === "Same.mp4")?.id;
  assert.ok(id);
  return id;
}

function headers(token: string, json = false): Record<string, string> {
  return { "x-watchparty-token": token, ...(json ? { "content-type": "application/json" } : {}) };
}

const list = (backend: Backend, roomId: string, token: string, mediaId: string) =>
  fetch(`${origin(backend)}/api/rooms/${roomId}/media/subtitles?mediaId=${encodeURIComponent(mediaId)}`, {
    headers: headers(token),
  });

const upload = (backend: Backend, roomId: string, token: string, payload: unknown) =>
  fetch(`${origin(backend)}/api/rooms/${roomId}/media/subtitles`, {
    method: "POST",
    headers: headers(token, true),
    body: JSON.stringify(payload),
  });

const content = (backend: Backend, roomId: string, token: string, subtitleId: string) =>
  fetch(`${origin(backend)}/api/rooms/${roomId}/media/subtitles/${subtitleId}/content`, { headers: headers(token) });

const remove = (backend: Backend, roomId: string, token: string, subtitleId: string) =>
  fetch(`${origin(backend)}/api/rooms/${roomId}/media/subtitles/${subtitleId}`, {
    method: "DELETE",
    headers: headers(token),
  });

test("sidecar list now labels its source, uploads hang behind it", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);
  const before = await (await list(backend, room.roomId, room.accessToken, mediaId)).json() as SubtitleTrack[];
  // 旁挂条目的既有字段一个不动，只多一个 source（前端对缺省也按 sidecar 处理）。
  assert.equal(before.length, 1);
  assert.equal(before[0]?.label, "Same.chs.ass");
  assert.equal(before[0]?.format, "ass");
  assert.equal(before[0]?.language, "zh-Hans");
  assert.equal(before[0]?.source, "sidecar");
  // 旁挂条目的 id 仍是它自己的字幕路径令牌，取内容走既有 /media/subtitle?mediaId=。
  assert.equal(before[0]?.mediaId, before[0]?.id);
  assert.ok(before[0]?.id);

  const created = await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT, language: "zh",
  });
  assert.equal(created.status, 200);
  const track = await created.json() as SubtitleTrack & { id: string };
  assert.equal(track.label, "movie.zh.srt");
  assert.equal(track.format, "srt");
  assert.equal(track.mediaId, mediaId);
  assert.equal(track.language, "zh");
  assert.equal(track.source, "upload");
  // 契约 §1：偏移仍是本机偏好，服务端不回传。
  assert.equal("offsetSeconds" in track, false);

  const after = await (await list(backend, room.roomId, room.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.deepEqual(after.map((item) => [item.label, item.source]), [
    ["Same.chs.ass", "sidecar"],
    ["movie.zh.srt", "upload"],
  ]);
});

test("uploaded text round-trips byte for byte as plain text", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);
  const track = await (await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT,
  })).json() as { id: string };
  const response = await content(backend, room.roomId, room.accessToken, track.id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(response.headers.get("content-type") ?? "", /charset=utf-8/i);
  assert.equal(await response.text(), SRT);
});

test("uploads belong to the media, not the room", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wp-subtitles-"));
  const dbPath = path.join(directory, "watchparty-subtitles.sqlite");
  const first = await boot({ subtitleDbPath: dbPath });
  const room = await createRoom(first);
  const mediaId = await videoId(first, room);
  const track = await (await upload(first, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT,
  })).json() as { id: string };

  // 另一个房间（不同房主）看同一文件：同一条字幕必须在。
  const other = await createRoom(first);
  const listed = await (await list(first, other.roomId, other.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.deepEqual(listed.filter((item) => item.source === "upload").map((item) => item.label), ["movie.zh.srt"]);
  assert.equal((await content(first, other.roomId, other.accessToken, track.id)).status, 200);
  await first.close();
  backends.splice(backends.indexOf(first), 1);

  // 服务重开（新进程、同一个库文件）：字幕还在，id 也没变。
  const again = await boot({ subtitleDbPath: dbPath });
  const roomAgain = await createRoom(again);
  const afterRestart = await (await list(again, roomAgain.roomId, roomAgain.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.deepEqual(afterRestart.filter((item) => item.source === "upload").map((item) => [item.label, item.id]), [["movie.zh.srt", track.id]]);
  assert.equal(await (await content(again, roomAgain.roomId, roomAgain.accessToken, track.id)).text(), SRT);
  tempDirs.push(directory);
});

test("same name overwrites instead of stacking duplicates", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);
  const first = await (await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT,
  })).json() as { id: string };
  const second = await (await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: "1\n00:00:01,000 --> 00:00:03,000\n改过\n",
  })).json() as { id: string };
  // id 保持稳定：播放器可能正拿着按旧 id 取来的内容。
  assert.equal(second.id, first.id);
  const tracks = await (await list(backend, room.roomId, room.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.equal(tracks.filter((item) => item.source === "upload").length, 1);
  assert.equal(await (await content(backend, room.roomId, room.accessToken, first.id)).text(), "1\n00:00:01,000 --> 00:00:03,000\n改过\n");
});

test("only the room owner can delete", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const member = await joinRoom(backend, room.roomId);
  const mediaId = await videoId(backend, room);
  const track = await (await upload(backend, room.roomId, member, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT,
  })).json() as { id: string };
  // 成员能传（契约 §1 S2-a），但删不掉别人的字幕。
  const denied = await remove(backend, room.roomId, member, track.id);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { code: string }).code, "SUBTITLE_OWNER_ONLY");
  assert.equal((await list(backend, room.roomId, member, mediaId)).status, 200);

  const owner = await remove(backend, room.roomId, room.accessToken, track.id);
  assert.equal(owner.status, 200);
  assert.deepEqual(await owner.json(), { removed: true });
  const tracks = await (await list(backend, room.roomId, room.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.equal(tracks.filter((item) => item.source === "upload").length, 0);
  // 删干净之后再动作：内容取不到、再删也是 404，不是 500。
  assert.equal((await content(backend, room.roomId, room.accessToken, track.id)).status, 404);
  const again = await remove(backend, room.roomId, room.accessToken, track.id);
  assert.equal(again.status, 404);
  assert.equal((await again.json() as { code: string }).code, "SUBTITLE_NOT_FOUND");
});

test("oversized, unsupported and empty uploads are refused with their own codes", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);

  // 600KB 正文：必须穿过专用 body 解析器再到这里，否则全局 100KB 会先把请求掐了。
  const large = await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "big.srt", format: "srt", content: "x".repeat(600 * 1024),
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json() as { code: string }).code, "SUBTITLE_TOO_LARGE");

  const unsupported = await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.lrc", format: "lrc", content: SRT,
  });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json() as { code: string }).code, "SUBTITLE_FORMAT_UNSUPPORTED");

  for (const payload of [
    { mediaId, name: "movie.srt", format: "srt", content: "" },
    { mediaId, name: "  ", format: "srt", content: SRT },
    { name: "movie.srt", format: "srt", content: SRT },
    { mediaId, name: "带\t制表符.srt", format: "srt", content: SRT },
    { mediaId, name: `超长名字`.padEnd(300, "字"), format: "srt", content: SRT },
    { mediaId, name: "movie.srt", format: "srt", content: SRT, language: "这个语言标签长得超过十六个字符的上限" },
    { mediaId, format: "srt", content: SRT },
  ]) {
    const rejected = await upload(backend, room.roomId, room.accessToken, payload);
    assert.equal(rejected.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal((await rejected.json() as { code: string }).code, "INVALID_REQUEST");
  }

  // 认不出这个 mediaId 就不落库：库里不能躺谁也列不到的 512KB。
  const stranger = await upload(backend, room.roomId, room.accessToken, {
    mediaId: "v2.bmF1Z2h0L21l.bm90ZGVjb2RlYWJsZQ", name: "movie.zh.srt", format: "srt", content: SRT,
  });
  assert.equal(stranger.status, 404);
  assert.equal((await stranger.json() as { code: string }).code, "MEDIA_NOT_FOUND");
  const tracks = await (await list(backend, room.roomId, room.accessToken, mediaId)).json() as SubtitleTrack[];
  assert.deepEqual(tracks.map((item) => item.source), ["sidecar"]);
});

test("every subtitle write is a room action", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);
  const track = await (await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "movie.zh.srt", format: "srt", content: SRT,
  })).json() as { id: string };
  const base = origin(backend);

  const anonymous = await upload(backend, room.roomId, "", { mediaId, name: "x.srt", format: "srt", content: SRT });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { code: string }).code, "ACCESS_TOKEN_INVALID");
  const wrongRoom = await fetch(`${base}/api/rooms/room-0000000000000000/media/subtitles/${track.id}/content`, {
    headers: headers(room.accessToken),
  });
  assert.equal(wrongRoom.status, 404);
  assert.equal((await wrongRoom.json() as { code: string }).code, "ROOM_NOT_FOUND");
  // 游客凭据只能只读浏览媒体库，字幕读写都是房内动作。
  const guest = ((await (await fetch(`${base}/api/media/guest-session`, { method: "POST" })).json()) as { token: string }).token;
  const asGuest = await fetch(`${base}/api/rooms/${room.roomId}/media/subtitles/${track.id}`, {
    method: "DELETE",
    headers: { "x-watchparty-guest": guest },
  });
  assert.equal(asGuest.status, 403);
  assert.equal((await asGuest.json() as { code: string }).code, "GUEST_FORBIDDEN");
});

test("one media caps at 32 uploads, overwriting an existing name still works", async () => {
  const backend = await boot();
  const room = await createRoom(backend);
  const mediaId = await videoId(backend, room);
  for (let index = 0; index < 32; index += 1) {
    const response = await upload(backend, room.roomId, room.accessToken, {
      mediaId, name: `track-${String(index).padStart(2, "0")}.srt`, format: "srt", content: SRT,
    });
    assert.equal(response.status, 200, `track ${index}`);
  }
  const overflow = await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "one-too-many.srt", format: "srt", content: SRT,
  });
  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json() as { code: string }).code, "SUBTITLE_TRACKS_FULL");
  // 同名覆盖不占新位，改字幕不该被上限挡住。
  const revise = await upload(backend, room.roomId, room.accessToken, {
    mediaId, name: "track-00.srt", format: "srt", content: "1\n00:00:00,000 --> 00:00:01,000\n改\n",
  });
  assert.equal(revise.status, 200);
});
