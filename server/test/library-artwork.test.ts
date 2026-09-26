import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { encodeLibraryMediaId } from "../media/library-browser.ts";
import type { OpenlistClient } from "../media/openlist.ts";
import type { StoredSource } from "../media/library-store.ts";

const backends: Backend[] = [];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const HTML = Buffer.from("<html>not-an-image</html>");
const OVERSIZE = 2 * 1024 * 1024 + 1;

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

function originOf(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}

async function boot(imageOrigin: string, hits: { count: number }): Promise<Backend> {
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: "http://primary.example",
    OPENLIST_USERNAME: "admin",
    OPENLIST_PASSWORD: "seed-secret",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config: cfg,
    libraryClientFactory: (source) => fakeClient(source, imageOrigin, hits),
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

function fakeClient(source: StoredSource, imageOrigin: string, hits: { count: number }): OpenlistClient {
  const root = "/media/Movies";
  return {
    async list(dir) {
      return { code: 200, data: { content: entries(dir, root) } };
    },
    async listShallow() {
      return { code: 200, data: { content: [] } };
    },
    async search() {
      return { code: 200, data: { content: [] } };
    },
    async getDownloadInfo(mediaPath) {
      if (mediaPath.endsWith("/Foreign/poster.jpg")) return { url: "https://evil.example/poster.jpg", size: 20 };
      if (mediaPath.endsWith("/Fake/poster.jpg")) return { url: `${imageOrigin}/html`, size: HTML.length };
      if (mediaPath.endsWith("/Huge/cover.jpg")) return { url: `${imageOrigin}/jpeg`, size: OVERSIZE };
      return { url: `${imageOrigin}/jpeg`, size: JPEG.length };
    },
    async getLinkInfo() {
      return null;
    },
    async fetchOriginText() {
      return undefined;
    },
    async ping() {
      return { ok: true };
    },
  };
  function entries(dir: string, libraryRoot: string) {
    if (source.internalBaseUrl !== imageOrigin) return [];
    if (dir === libraryRoot) {
      return [
        { name: "poster.jpg", is_dir: false, size: JPEG.length, path: `${libraryRoot}/poster.jpg` },
        { name: "poster.gif", is_dir: false, size: 10, path: `${libraryRoot}/poster.gif` },
        { name: "Movie.mp4", is_dir: false, size: 10, path: `${libraryRoot}/Movie.mp4` },
        { name: "Extra", is_dir: true, size: 0, path: `${libraryRoot}/Extra` },
      ];
    }
    if (dir === `${libraryRoot}/Fake`) {
      return [
        { name: "poster.jpg", is_dir: false, size: HTML.length, path: `${dir}/poster.jpg` },
        { name: "Movie.mp4", is_dir: false, size: 10, path: `${dir}/Movie.mp4` },
      ];
    }
    if (dir === `${libraryRoot}/Huge`) {
      return [
        { name: "cover.jpg", is_dir: false, size: OVERSIZE, path: `${dir}/cover.jpg` },
        { name: "Movie.mp4", is_dir: false, size: 10, path: `${dir}/Movie.mp4` },
      ];
    }
    if (dir === `${libraryRoot}/Foreign`) {
      return [
        { name: "poster.jpg", is_dir: false, size: 20, path: `${dir}/poster.jpg` },
        { name: "Movie.mp4", is_dir: false, size: 10, path: `${dir}/Movie.mp4` },
      ];
    }
    return [];
  }
}

test("local poster.jpg is exposed and served, but a non-image, an oversize image, and a foreign URL are not", async () => {
  const hits = { count: 0 };
  const imageServer = createServer((request, response) => {
    hits.count += 1;
    const path = request.url ?? "";
    if (path === "/jpeg") {
      response.setHeader("content-type", "image/jpeg");
      response.end(JPEG);
      return;
    }
    if (path === "/html") {
      response.setHeader("content-type", "text/html");
      response.end(HTML);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", () => resolve()));
  const address = imageServer.address();
  if (!address || typeof address === "string") throw new Error("image server did not bind");
  const imageOrigin = `http://127.0.0.1:${address.port}`;
  try {
    const backend = await boot(imageOrigin, hits);
    const base = originOf(backend);
    const created = await fetch(`${base}/api/admin/media-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Posters",
        internalBaseUrl: imageOrigin,
        username: "admin",
        password: "sekret-value",
        libraries: [{ name: "Movies", kind: "movie", path: "/media/Movies" }],
      }),
    });
    assert.equal(created.status, 201);
    const source = await created.json() as { id: string; libraries: Array<{ id: string }> };
    const libraryId = source.libraries[0]?.id;
    assert.ok(libraryId);
    const before = hits.count;
    const page = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}`)).json() as {
      posterId?: string;
      items: Array<{ name: string; posterId?: string; isDirectory: boolean }>;
    };
    assert.ok(page.posterId);
    assert.equal(page.items.find((item) => item.name === "Movie.mp4")?.posterId, page.posterId);
    assert.equal(page.items.find((item) => item.name === "Extra")?.posterId, undefined);
    assert.equal(page.items.find((item) => item.name === "poster.gif")?.posterId, undefined);
    assert.equal(JSON.stringify(page).includes("/media/Movies"), false);
    assert.equal(JSON.stringify(page).includes("sekret-value"), false);
    assert.ok(hits.count > before);

    const artwork = await fetch(`${base}/api/media/artwork/${encodeURIComponent(page.posterId)}`);
    assert.equal(artwork.status, 200);
    assert.equal(artwork.headers.get("content-type"), "image/jpeg");
    const body = Buffer.from(await artwork.arrayBuffer());
    assert.deepEqual(body.subarray(0, 3), JPEG.subarray(0, 3));

    const huge = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}&path=/Huge`)).json() as { posterId?: string; items: Array<{ posterId?: string }> };
    assert.equal(huge.posterId, undefined);
    assert.equal(huge.items.some((item) => item.posterId), false);
    const hugeId = encodeLibraryMediaId(source.id, "/media/Movies/Huge/cover.jpg", "test-key");
    const hugeHits = hits.count;
    const hugeArtwork = await fetch(`${base}/api/media/artwork/${encodeURIComponent(hugeId)}`);
    assert.equal(hugeArtwork.status, 404);
    assert.equal(hits.count, hugeHits);

    const fake = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}&path=/Fake`)).json() as { posterId?: string };
    assert.equal(fake.posterId, undefined);
    const fakeId = encodeLibraryMediaId(source.id, "/media/Movies/Fake/poster.jpg", "test-key");
    assert.equal((await fetch(`${base}/api/media/artwork/${encodeURIComponent(fakeId)}`)).status, 404);

    const foreignHits = hits.count;
    const foreign = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}&path=/Foreign`)).json() as { posterId?: string };
    assert.equal(foreign.posterId, undefined);
    assert.equal(hits.count, foreignHits);
    const foreignId = encodeLibraryMediaId(source.id, "/media/Movies/Foreign/poster.jpg", "test-key");
    assert.equal((await fetch(`${base}/api/media/artwork/${encodeURIComponent(foreignId)}`)).status, 404);
    assert.equal(hits.count, foreignHits);

    const videoId = encodeLibraryMediaId(source.id, "/media/Movies/Movie.mp4", "test-key");
    assert.equal((await fetch(`${base}/api/media/artwork/${encodeURIComponent(videoId)}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => imageServer.close((error) => error ? reject(error) : resolve()));
  }
});
