import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compatibilityOf,
  createLibraryBrowser,
  encodeLibraryMediaId,
  parseStrmTarget,
} from "../media/library-browser.ts";
import { episodeSubtitle, groupScanFiles, isVideoFileName } from "../media/catalog-names.ts";
import { validateMediaSource } from "../core/media.ts";
import type { OpenlistClient } from "../media/openlist.ts";
import type { StoredLibrary } from "../media/library-store.ts";

const KEY = "test-media-id-key";
const SOURCE_ID = "src_strm";
const ROOT = "/media/STRM";
const LIBRARY: StoredLibrary = {
  id: "lib_strm",
  sourceId: SOURCE_ID,
  name: "STRM",
  kind: "tv",
  absolutePath: ROOT,
};

/**
 * Stands in for an OpenList mount holding a generated `.strm` tree. `calls` records
 * every URL the browser asked the origin for, which is how the tests prove the
 * pointer's *target* is never dereferenced server-side.
 */
function fakeStrmClient(pointers: Record<string, string>) {
  const calls: string[] = [];
  const entries: Array<{ name: string; is_dir: boolean; size: number; path: string }> = [
    { name: "Show - 01.strm", is_dir: false, size: 64, path: `${ROOT}/Show/Show - 01.strm` },
    { name: "Show - 02.strm", is_dir: false, size: 64, path: `${ROOT}/Show/Show - 02.strm` },
    { name: "Show - 03.strm", is_dir: false, size: 64, path: `${ROOT}/Show/Show - 03.strm` },
    { name: "Show - 04.strm", is_dir: false, size: 64, path: `${ROOT}/Show/Show - 04.strm` },
    { name: "Local - 01.strm", is_dir: false, size: 40, path: `${ROOT}/Show/Local - 01.strm` },
    { name: "poster.jpg", is_dir: false, size: 10, path: `${ROOT}/Show/poster.jpg` },
    { name: "Show - 01.ass", is_dir: false, size: 10, path: `${ROOT}/Show/Show - 01.ass` },
  ];
  const client: OpenlistClient = {
    async list(dir) {
      return { code: 200, data: { content: entries.filter((entry) => entry.path.startsWith(`${dir}/`)) } };
    },
    async listShallow() {
      return { code: 200, data: { content: [] } };
    },
    async search() {
      return { code: 200, data: { content: [] } };
    },
    async getDownloadInfo(mediaPath) {
      calls.push(mediaPath);
      if (!(mediaPath in pointers)) return null;
      return { url: `http://openlist.local/d${mediaPath}`, size: pointers[mediaPath].length };
    },
    async getLinkInfo(mediaPath) {
      calls.push(`link:${mediaPath}`);
      return null;
    },
    async fetchOriginText(url) {
      calls.push(url);
      const mediaPath = url.replace(/^http:\/\/openlist\.local\/d/, "");
      const text = pointers[mediaPath];
      return text === undefined ? undefined : { status: 200, text };
    },
    async ping() {
      return { ok: true };
    },
  };
  const browser = createLibraryBrowser(client, {
    sourceId: SOURCE_ID,
    mediaIdKey: KEY,
    internalBaseUrl: "http://openlist.local",
    publicBaseUrl: "http://openlist.local",
    libraries: [LIBRARY],
  });
  return { browser, calls, idOf: (mediaPath: string) => encodeLibraryMediaId(SOURCE_ID, mediaPath, KEY) };
}

const HTTP_POINTER = `${ROOT}/Show/Show - 01.strm`;
const UNC_POINTER = `${ROOT}/Show/Local - 01.strm`;
const POINTERS: Record<string, string> = {
  [HTTP_POINTER]: "https://cdn.example/a/seg.m3u8?token=abc\r\n",
  [UNC_POINTER]: "F:\\Media\\Show\\01.mkv\n",
};

test("parseStrmTarget accepts only http(s) targets", () => {
  assert.deepEqual(parseStrmTarget("https://cdn.example/a.mp4"), { url: "https://cdn.example/a.mp4" });
  assert.deepEqual(parseStrmTarget("  http://192.168.1.5:8080/x.mkv  "), { url: "http://192.168.1.5:8080/x.mkv" });
  assert.deepEqual(parseStrmTarget("\r\n#EXTM3U\r\nhttps://cdn.example/a.m3u8\r\n"), { url: "https://cdn.example/a.m3u8" });
});

test("parseStrmTarget rejects local paths and other schemes", () => {
  assert.deepEqual(parseStrmTarget("F:\\Media\\01.mkv"), { unsupported: "F:\\Media\\01.mkv" });
  assert.deepEqual(parseStrmTarget("\\\\NAS\\Media\\01.mkv"), { unsupported: "\\\\NAS\\Media\\01.mkv" });
  assert.deepEqual(parseStrmTarget("/mnt/media/01.mkv"), { unsupported: "/mnt/media/01.mkv" });
  assert.deepEqual(parseStrmTarget("ftp://cdn.example/a.mp4"), { unsupported: "ftp://cdn.example/a.mp4" });
  assert.equal(parseStrmTarget(""), null);
  assert.equal(parseStrmTarget("   \n\n"), null);
});

test("strm files count as media for listing, grouping and compatibility", () => {
  assert.equal(isVideoFileName("Show - 01.strm"), true);
  const compat = compatibilityOf(false, "strm");
  assert.equal(compat.browser, "unsupported");
  assert.equal(compat.desktop, "supported");
  assert.ok(compat.browserReason);
});

test("resolve reads the pointer through the origin and hands back its URL untouched", async () => {
  const { browser, calls, idOf } = fakeStrmClient(POINTERS);
  const resolved = await browser.resolve(idOf(HTTP_POINTER));
  assert.deepEqual(resolved, {
    url: "https://cdn.example/a/seg.m3u8?token=abc",
    mime: "application/vnd.apple.mpegurl",
    requiresCustomHeaders: false,
  });
  assert.ok(!calls.some((call) => call.includes("cdn.example")), "target URL must never be fetched server-side");
});

test("resolveMpv gives MPV the pointer target as both direct and fallback", async () => {
  const { browser, calls, idOf } = fakeStrmClient(POINTERS);
  const resolved = await browser.resolveMpv(idOf(HTTP_POINTER));
  assert.deepEqual(resolved, {
    directUrl: "https://cdn.example/a/seg.m3u8?token=abc",
    fallbackUrl: "https://cdn.example/a/seg.m3u8?token=abc",
    headers: {},
  });
  assert.ok(!calls.some((call) => call.startsWith("link:")), "no netdisk link lookup for a pointer file");
});

test("a pointer to a local path resolves to nothing instead of being fetched", async () => {
  const { browser, calls, idOf } = fakeStrmClient(POINTERS);
  assert.equal(await browser.resolve(idOf(UNC_POINTER)), null);
  assert.equal(await browser.resolveMpv(idOf(UNC_POINTER)), null);
  assert.ok(calls.every((call) => !call.includes("F:") && !call.includes("cdn.example")));
});

test("a missing or unreadable pointer behaves like any other unresolvable file", async () => {
  const { browser, idOf } = fakeStrmClient({});
  assert.equal(await browser.resolve(idOf(HTTP_POINTER)), null);
  assert.equal(await browser.resolveMpv(idOf(HTTP_POINTER)), null);
});

test("listing exposes strm items as media files of the pointer extension", async () => {
  const { browser } = fakeStrmClient(POINTERS);
  const page = await browser.list(LIBRARY, "/Show");
  const item = page.items.find((entry) => entry.name === "Show - 01.strm");
  assert.ok(item);
  assert.equal(item.extension, "strm");
  assert.equal(item.type, "file");
  assert.equal(item.isDirectory, false);
  assert.equal(item.compatibility.browser, "unsupported");
  assert.equal(item.compatibility.desktop, "supported");
});

test("subtitles sitting next to a pointer still attach to it", async () => {
  const { browser, idOf } = fakeStrmClient(POINTERS);
  const tracks = await browser.discoverSubtitles(idOf(HTTP_POINTER));
  assert.deepEqual(tracks?.map((track) => track.label), ["Show - 01.ass"]);
});

test("an strm tree groups like the media it points at", () => {
  const files = [1, 2, 3, 4].map((n) => ({
    relativePath: `${ROOT}/Show/Season 01/Show S01E${String(n).padStart(2, "0")}.strm`,
    name: `Show S01E${String(n).padStart(2, "0")}.strm`,
    mediaId: `m${n}`,
  }));
  const groups = groupScanFiles(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.files.length, 4);
  assert.equal(episodeSubtitle(groups[0]?.files ?? [], `${ROOT}/Show/Season 01`), "S1 · 4 集");
  assert.deepEqual(groups[0]?.files.map((file) => file.episode), [1, 2, 3, 4]);
});

test("a season folder carries files whose names hold no episode pattern", () => {
  const files = [1, 2, 3].map((n) => ({
    relativePath: `${ROOT}/Show/Season 02/Show - ${String(n).padStart(2, "0")}.strm`,
    name: `Show - ${String(n).padStart(2, "0")}.strm`,
    mediaId: `s${n}`,
  }));
  const groups = groupScanFiles(files);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.files.map((file) => file.season), [2, 2, 2]);
  assert.equal(episodeSubtitle(groups[0]?.files ?? [], `${ROOT}/Show/Season 02`), "S2 · 3 集");
});

test("the room protocol carries a pointer as an openlist source", () => {
  const mediaId = encodeLibraryMediaId(SOURCE_ID, HTTP_POINTER, KEY);
  const source = validateMediaSource({
    kind: "openlist",
    mediaId,
    title: "Show 01",
    container: "strm",
  });
  assert.ok(source && source.kind === "openlist");
  assert.equal(source.container, "strm");
  assert.equal(validateMediaSource({ kind: "openlist", mediaId, title: "x", container: "exe" }), undefined);
});
