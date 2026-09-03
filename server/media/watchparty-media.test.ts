import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { OpenlistClient } from "./openlist.ts";
import {
  createWatchpartyMedia,
  type WatchpartyMedia,
} from "./watchparty-media.ts";
import { OpenlistServiceError } from "./openlist.ts";

const KEY = "test-media-id-key";
const ANIME = "/media/openlist-bdyun/Multimedia/Anime";

function fakeClient(overrides: Partial<OpenlistClient> = {}): OpenlistClient {
  return {
    list: async () => ({ code: 200, data: { content: [] } }),
    search: async () => ({ code: 200, data: { content: [] } }),
    getDownloadInfo: async () => null,
    getLinkInfo: async () => null,
    fetchOriginText: async () => undefined,
    ...overrides,
  };
}

function media(client: OpenlistClient = fakeClient()): WatchpartyMedia {
  return createWatchpartyMedia(client, {
    mediaIdKey: KEY,
    internalBaseUrl: "http://127.0.0.1:5244",
    publicBaseUrl: "http://127.0.0.1:5244",
  });
}

function signedId(mediaPath: string, key = KEY): string {
  const payload = Buffer.from(mediaPath).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

test("media ids are opaque and every use re-validates signature and path", async () => {
  const client = fakeClient({
    list: async () => ({
      code: 200,
      data: {
        content: [
          {
            name: "Episode 2.mp4",
            is_dir: false,
            size: 42,
            path: `${ANIME}/Episode 2.mp4`,
          },
        ],
      },
    }),
    getDownloadInfo: async () => ({
      url: "https://cdn.example/video.mp4",
      size: 42,
    }),
  });
  const watchparty = media(client);
  const result = await watchparty.list("Anime", "/");
  const videoId = result.items[0]!.id;
  assert.notEqual(videoId, `${ANIME}/Episode 2.mp4`);

  assert.equal(
    (await watchparty.resolve(videoId))?.url,
    "https://cdn.example/video.mp4",
  );
  assert.equal(await watchparty.resolve(`${videoId}x`), undefined);
  assert.equal(
    await watchparty.resolve(signedId(`${ANIME}/Episode 2.mp4`, "wrong-key")),
    undefined,
  );
  assert.equal(
    await watchparty.resolve(signedId(`${ANIME}/../Film/movie.mp4`)),
    undefined,
  );
  assert.equal(await watchparty.resolve(signedId("/etc/passwd")), undefined);
  assert.equal(await watchparty.resolve("garbage"), undefined);
});

test("directory results are naturally sorted and expose compatibility metadata", async () => {
  const watchparty = media(
    fakeClient({
      list: async () => ({
        code: 200,
        data: {
          content: [
            {
              name: "Episode 10.mkv",
              is_dir: false,
              size: 10,
              path: `${ANIME}/Episode 10.mkv`,
            },
            {
              name: "Episode 2.mp4",
              is_dir: false,
              size: 20,
              path: `${ANIME}/Episode 2.mp4`,
            },
            { name: "Trailers", is_dir: true, path: `${ANIME}/Trailers` },
          ],
        },
      }),
    }),
  );
  const result = await watchparty.list("Anime", "/");
  assert.deepEqual(
    result.items.map((item) => item.name),
    ["Episode 2.mp4", "Episode 10.mkv", "Trailers"],
  );
  assert.equal(result.items[0]!.compatibility, "supported");
  assert.equal(result.items[1]!.compatibility, "unsupported");
  assert.equal(result.items[1]!.compatibilityReason, "浏览器不支持 MKV 封装");
  assert.equal(result.items[2]!.type, "dir");
  assert.equal(result.items[2]!.displayPath, undefined);
});

test("subtitle discovery matches same-stem files with language suffixes but not other episodes", async () => {
  const watchparty = media(
    fakeClient({
      list: async () => ({
        code: 200,
        data: {
          content: [
            {
              name: "Episode 2.mp4",
              is_dir: false,
              size: 1,
              path: `${ANIME}/Episode 2.mp4`,
            },
            {
              name: "Episode 2.ass",
              is_dir: false,
              size: 2,
              path: `${ANIME}/Episode 2.ass`,
            },
            {
              name: "Episode 2.chs.ass",
              is_dir: false,
              size: 3,
              path: `${ANIME}/Episode 2.chs.ass`,
            },
            {
              name: "Episode 20.srt",
              is_dir: false,
              size: 4,
              path: `${ANIME}/Episode 20.srt`,
            },
            {
              name: "Other.srt",
              is_dir: false,
              size: 5,
              path: `${ANIME}/Other.srt`,
            },
            { name: "Subs", is_dir: true, path: `${ANIME}/Subs` },
          ],
        },
      }),
    }),
  );
  const directory = await watchparty.list("Anime", "/");
  const videoId = directory.items.find(
    (item) => item.name === "Episode 2.mp4",
  )!.id;
  const tracks = await watchparty.discoverSubtitles(videoId);
  assert.deepEqual(
    tracks?.map((track) => track.label),
    ["Episode 2.ass", "Episode 2.chs.ass"],
  );
  assert.equal(tracks?.[0]!.format, "ass");
  assert.equal(tracks?.[0]!.language, undefined);
  assert.equal(tracks?.[1]!.language, "zh-Hans");
  assert.equal(tracks?.[0]!.id, tracks?.[0]!.mediaId);
  assert.equal(await watchparty.discoverSubtitles("garbage"), undefined);
});

test("resolve accepts direct https links and rejects unsupported files", async () => {
  const watchparty = media(
    fakeClient({
      getDownloadInfo: async (mediaPath) =>
        mediaPath.endsWith(".mkv")
          ? { url: "https://cdn.example/movie.mkv", size: 7 }
          : { url: "https://cdn.example/video.mp4", size: 42 },
    }),
  );
  assert.deepEqual(await watchparty.resolve(signedId(`${ANIME}/video.mp4`)), {
    url: "https://cdn.example/video.mp4",
    size: 42,
    mime: "video/mp4",
    requiresCustomHeaders: false,
  });
  assert.equal(await watchparty.resolve(signedId(`${ANIME}/movie.mkv`)), null);

  const externalHttp = media(
    fakeClient({
      getDownloadInfo: async () => ({
        url: "http://cdn.example/video.mp4",
        size: 42,
      }),
    }),
  );
  assert.equal(
    await externalHttp.resolve(signedId(`${ANIME}/video.mp4`)),
    null,
  );
});

test("resolve rewrites OpenList proxy URLs to the browser-facing origin", async () => {
  const watchparty = media(
    fakeClient({
      getDownloadInfo: async () => ({
        url: "http://127.0.0.1:5244/p/video.mp4?sign=abc",
        size: 42,
      }),
    }),
  );
  assert.deepEqual(await watchparty.resolve(signedId(`${ANIME}/video.mp4`)), {
    url: "http://127.0.0.1:5244/p/video.mp4?sign=abc",
    size: 42,
    mime: "video/mp4",
    requiresCustomHeaders: false,
  });

  const publicBase = createWatchpartyMedia(
    fakeClient({
      getDownloadInfo: async () => ({
        url: "http://127.0.0.1:5244/p/video.mp4?sign=abc",
        size: 42,
      }),
    }),
    {
      mediaIdKey: KEY,
      internalBaseUrl: "http://127.0.0.1:5244",
      publicBaseUrl: "https://openlist.example.test",
    },
  );
  assert.equal(
    (await publicBase.resolve(signedId(`${ANIME}/video.mp4`)))?.url,
    "https://openlist.example.test/p/video.mp4?sign=abc",
  );
});

test("subtitle loading enforces the size guard and only serves OpenList-provided content", async () => {
  const watchparty = media(
    fakeClient({
      getDownloadInfo: async (mediaPath) =>
        mediaPath.endsWith(".big.ass")
          ? { url: "http://127.0.0.1:5244/d/sub.ass", size: 6 * 1024 * 1024 }
          : { url: "https://evil.example/sub.ass", size: 10 },
      // The OpenList client itself refuses off-origin URLs; mimic that here.
      fetchOriginText: async (url) =>
        url.startsWith("http://127.0.0.1:5244")
          ? { status: 200, text: "WEBVTT" }
          : undefined,
    }),
  );
  assert.equal(
    await watchparty.loadSubtitle(signedId(`${ANIME}/sub.ass`)),
    undefined,
  );
  assert.equal(
    await watchparty.loadSubtitle(signedId(`${ANIME}/sub.big.ass`)),
    undefined,
  );
  assert.equal(
    await watchparty.loadSubtitle(signedId(`${ANIME}/video.mp4`)),
    undefined,
  );

  const local = media(
    fakeClient({
      getDownloadInfo: async () => ({
        url: "http://127.0.0.1:5244/d/sub.ass",
        size: 6,
      }),
      fetchOriginText: async () => ({ status: 200, text: "WEBVTT" }),
    }),
  );
  assert.equal(
    await local.loadSubtitle(signedId(`${ANIME}/sub.ass`)),
    "WEBVTT",
  );
});

test("search maps OpenList results into directory items", async () => {
  const watchparty = media(
    fakeClient({
      search: async () => ({
        code: 200,
        data: {
          content: [
            // fs/search returns parent+name without a path field.
            { name: "Show 02.mp4", parent: ANIME, is_dir: false, size: 10 },
          ],
        },
      }),
    }),
  );
  const result = await watchparty.search("show", "Anime");
  assert.deepEqual(
    result.items.map((item) => item.name),
    ["Show 02.mp4"],
  );
});

test("search failure surfaces OPENLIST_UNAVAILABLE instead of an empty result", async () => {
  const watchparty = media(
    fakeClient({
      search: async () => ({
        code: 400,
        message: "handles.SearchReq.SearchReq: Scope: readUint64",
      }),
    }),
  );
  await assert.rejects(
    watchparty.search("show"),
    (error: unknown) =>
      error instanceof OpenlistServiceError &&
      error.code === "OPENLIST_UNAVAILABLE" &&
      error.message.includes("Scope: readUint64"),
  );
});

test("resolveMpv passes the direct link through with User-Agent only", async () => {
  const mediaPath = `${ANIME}/Show/a.mp4`;
  const directUrl = "https://direct.example.com/file.mkv";
  const proxyUrl = "http://127.0.0.1:5244/p/file.mp4?sign=abc";
  const client = fakeClient({
    getDownloadInfo: async () => ({ url: proxyUrl, size: 10 }),
    getLinkInfo: async () => ({
      url: directUrl,
      header: { "User-Agent": "pan.baidu.com" },
    }),
  });
  const resolved = await media(client).resolveMpv(signedId(mediaPath));
  assert.deepEqual(resolved, {
    directUrl,
    headers: { "User-Agent": "pan.baidu.com" },
    fallbackUrl: proxyUrl,
  });
});

test("resolveMpv drops the direct link when upstream requires non-whitelisted headers", async () => {
  const mediaPath = `${ANIME}/Show/a.mp4`;
  const proxyUrl = "http://127.0.0.1:5244/p/file.mp4?sign=abc";
  for (const header of [
    { "User-Agent": "pan.baidu.com", Cookie: "SESS=x" },
    { Referer: "https://x" },
  ] as Array<Record<string, string>>) {
    const client = fakeClient({
      getDownloadInfo: async () => ({ url: proxyUrl, size: 10 }),
      getLinkInfo: async () => ({
        url: "https://direct.example.com/f",
        header,
      }),
    });
    const resolved = await media(client).resolveMpv(signedId(mediaPath));
    assert.deepEqual(resolved, { headers: {}, fallbackUrl: proxyUrl });
  }
});

test("resolveMpv falls back cleanly when fs/link is unavailable or empty", async () => {
  const mediaPath = `${ANIME}/Show/a.mp4`;
  const proxyUrl = "http://127.0.0.1:5244/p/file.mp4?sign=abc";
  for (const getLinkInfo of [
    async () => null,
    async () => ({ url: "", header: {} }),
  ]) {
    const client = fakeClient({
      getDownloadInfo: async () => ({ url: proxyUrl, size: 10 }),
      getLinkInfo,
    });
    const resolved = await media(client).resolveMpv(signedId(mediaPath));
    assert.deepEqual(resolved, { headers: {}, fallbackUrl: proxyUrl });
  }
});
