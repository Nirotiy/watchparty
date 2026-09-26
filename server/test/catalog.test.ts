import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { cleanTitle, episodeSubtitle, groupScanFiles, scoreTitles } from "../media/catalog-names.ts";
import { chooseMatch, createBangumiClient, rankHits, type MetadataHit, type MetadataSearcher } from "../media/catalog-metadata.ts";
import { openCatalogStore } from "../media/catalog-store.ts";
import { createCatalogWorker } from "../media/catalog-worker.ts";
import type { StoredLibrary } from "../media/library-store.ts";
import type { OpenlistClient } from "../media/openlist.ts";
import { WATCHPARTY_ROOTS } from "../media/watchparty-media.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0xd9]);

test("release-group titles collapse to the searchable name", () => {
  assert.equal(cleanTitle("[LoliHouse] Medalist S1 Full"), "Medalist");
  assert.equal(
    cleanTitle("[DBD-Raws][侍战队真剑者][01-49TV全集+导演剪辑版+美版+特别篇+特典映像][1080P][BDRip][HEVC-10bit][FLAC][MKV]"),
    "侍战队真剑者",
  );
  assert.equal(
    cleanTitle("[Dynamis One] Fuuto Tantei Movie Kamen Rider Skull no Shouzou (CR 1920x1080 AVC AAC MKV) [C8329ACF].mkv"),
    "Fuuto Tantei Movie Kamen Rider Skull no Shouzou",
  );
});

test("season folders roll up to one series and episodes stay ordered", () => {
  const groups = groupScanFiles([
    { relativePath: "/Show/S01E02.mkv", name: "Show S01E02.mkv", mediaId: "b" },
    { relativePath: "/Show/Season 01/Show S01E01.mkv", name: "Show S01E01.mkv", mediaId: "a" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.itemKey, "/Show");
  assert.equal(groups[0]?.query, "Show");
  assert.deepEqual(
    groups[0]?.files.map((file) => file.episode),
    [1, 2],
  );
});

test("episodeSubtitle emits a zh-CN display string with the contract's shape", () => {
  const files = (count: number, season: number | null) =>
    Array.from({ length: count }, (_unused, index) => ({
      mediaId: `m${index}`,
      name: `Show S01E${index + 1}.mkv`,
      season,
      episode: index + 1,
    }));

  assert.equal(episodeSubtitle([]), null);
  assert.equal(episodeSubtitle(files(1, 1)), null);
  assert.equal(episodeSubtitle(files(12, 1)), "S1 · 12 集");
  assert.equal(episodeSubtitle(files(24, null)), "24 集");
  assert.equal(episodeSubtitle([...files(12, 1), ...files(12, 2)]), "24 集");

  // Frozen client contract: optional `S<n> · ` prefix then the count, nothing
  // else, and short enough for the poster card's ~20-char sub-line.
  assert.match(episodeSubtitle(files(12, 1)) ?? "", /^S\d+ · \d+ 集$/);
  assert.match(episodeSubtitle(files(24, null)) ?? "", /^\d+ 集$/);
  for (const value of [episodeSubtitle(files(12, 1)), episodeSubtitle(files(120, null))]) {
    assert.ok((value ?? "").length <= 20, `subtitle overflows the card sub-line: ${value}`);
  }
});

test("a tie stays a candidate and a weak overlap is not confirmed", () => {
  const exact = hit("bangumi", "1", "Medalist");
  const tied = chooseMatch(rankHits("Medalist", [exact, hit("bangumi", "2", "Medalist")], null));
  assert.equal(tied.status, "candidate");
  const partial = chooseMatch(rankHits("ghost shell", [hit("tmdb", "9", "The Ghost in the Shell")], null));
  assert.equal(partial.status, "candidate");
  assert.ok((partial.candidates[0]?.score ?? 0) < 0.86);
  const miss = chooseMatch(rankHits("Medalist", [hit("bangumi", "3", "Completely Different")], null));
  assert.equal(miss.status, "candidate");
  assert.ok((miss.candidates[0]?.score ?? 1) < 0.86);
  const short = chooseMatch(rankHits("PV", [hit("bangumi", "4", "青空之刃")], null));
  assert.equal(short.status, "unmatched");
});

test("a single leftover kanji cannot confirm a different series", () => {
  assert.ok(scoreTitles("侍战队真剑者", "侍ジャイアンツ") < 0.5);
  const ranked = rankHits("侍战队真剑者", [hit("bangumi", "1", "魔投手", null)], null);
  const choice = chooseMatch(ranked.map((hit) => ({ ...hit, originalTitle: "侍ジャイアンツ" })));
  assert.notEqual(choice.status, "confirmed");
});

test("bangumi keeps anime hits and appends tokusatsu", async () => {
  const seen: number[] = [];
  const client = createBangumiClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { filter: { type: number[] } };
    const type = body.filter.type[0] ?? 0;
    seen.push(type);
    const data = type === 2
      ? [{ id: 1, name: "メダリスト", name_cn: "金牌得主", date: "2025-01-04" }]
      : [{ id: 2, name: "侍戦隊シンケンジャー", name_cn: "侍战队真剑者", date: "2009-02-15" }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  const hits = await client.search("侍战队真剑者", "anime");
  assert.deepEqual(seen, [2, 6]);
  assert.deepEqual(hits.map((hit) => hit.title), ["金牌得主", "侍战队真剑者"]);
});

test("ten local episodes prefer the 2026 series over the 2017 film", () => {
  const hits = [
    { ...hit("bangumi", "2017", "攻壳机动队"), originalTitle: "Ghost in the Shell", year: 2017, episodes: 1 },
    { ...hit("bangumi", "2026", "攻壳机动队 THE GHOST IN THE SHELL"), originalTitle: "攻殻機動隊 THE GHOST IN THE SHELL", year: 2026, episodes: 10 },
    { ...hit("bangumi", "1995", "攻壳机动队"), originalTitle: "GHOST IN THE SHELL / 攻殻機動隊", year: 1995, episodes: 1 },
  ];
  const choice = chooseMatch(rankHits("The Ghost in the Shell", hits, null, 10));
  assert.equal(choice.status, "confirmed");
  assert.equal(choice.chosen?.externalId, "2026");
  assert.equal(choice.chosen?.year, 2026);
});

test("bonus folders are not separate series", () => {
  const groups = groupScanFiles([
    { relativePath: "/Show/S01E01.mkv", name: "Show S01E01.mkv", mediaId: "a" },
    { relativePath: "/Show/PV/promo.mkv", name: "promo.mkv", mediaId: "b" },
    { relativePath: "/Show/特典映像/extra.mkv", name: "extra.mkv", mediaId: "c" },
    { relativePath: "/Show/NCOP&NCED/op.mkv", name: "op.mkv", mediaId: "d" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.files.length, 1);
});

test("anime lookups use Bangumi and movie lookups use TMDB", async () => {
  const calls: string[] = [];
  const { catalog, worker, close } = openWorker({
    libraries: [library("lib_anime", "anime"), library("lib_film", "movie")],
    files: {
      lib_anime: [{ relativePath: "/Medalist.mkv", name: "Medalist.mkv", mediaId: "a" }],
      lib_film: [{ relativePath: "/Inception.mkv", name: "Inception.mkv", mediaId: "m" }],
    },
    bangumi: searcher("bangumi", calls, (query) => [hit("bangumi", "430699", query, "https://lain.bgm.tv/pic/a.jpg")]),
    tmdb: searcher("tmdb", calls, (query) => [hit("tmdb", "27205", query, "https://image.tmdb.org/t/p/w342/a.jpg")]),
  });
  try {
    const anime = await worker.start("lib_anime");
    const film = await worker.start("lib_film");
    assert.equal(anime?.status, "done");
    assert.equal(film?.matched, 1);
    assert.deepEqual(calls, ["bangumi:Medalist", "tmdb:Inception"]);
    assert.equal(catalog.listCards("lib_anime", undefined, undefined).items[0]?.posterUrl?.startsWith("/api/media/posters/"), true);
  } finally {
    close();
  }
});

test("a low-confidence hit stays a candidate until confirm", async () => {
  const { catalog, worker, close } = openWorker({
    libraries: [library("lib_anime", "anime")],
    files: { lib_anime: [{ relativePath: "/ghost shell.mkv", name: "ghost shell.mkv", mediaId: "g" }] },
    bangumi: searcher("bangumi", [], () => [hit("bangumi", "7", "The Ghost in the Shell", "https://lain.bgm.tv/pic/g.jpg")]),
    tmdb: searcher("tmdb", [], () => []),
  });
  try {
    await worker.start("lib_anime");
    const card = catalog.listCards("lib_anime", undefined, undefined).items[0];
    assert.equal(card?.status, "candidate");
    assert.equal(card?.posterUrl, null);
    const detail = catalog.getDetail(card?.id ?? "");
    const candidateId = detail?.candidates[0]?.id ?? "";
    const saved = catalog.confirm(card?.id ?? "", candidateId);
    assert.equal(saved?.imageUrl, "https://lain.bgm.tv/pic/g.jpg");
    assert.equal(catalog.getDetail(card?.id ?? "")?.status, "confirmed");
  } finally {
    close();
  }
});

test("a restarted job continues pending items and does not repeat lookups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-cat-"));
  const dbPath = path.join(dir, "catalog.sqlite");
  const calls: string[] = [];
  const files = ["One.mkv", "Two.mkv", "Three.mkv"].map((name) => ({ relativePath: `/${name}`, name, mediaId: name }));
  const first = openWorker({
    dbPath,
    posterDir: dir,
    maxLookups: 1,
    libraries: [library("lib_anime", "anime")],
    files: { lib_anime: files },
    bangumi: searcher("bangumi", calls, (query) => [hit("bangumi", query, query)]),
    tmdb: searcher("tmdb", calls, () => []),
  });
  const paused = await first.worker.start("lib_anime");
  assert.equal(paused?.status, "running");
  assert.equal(paused?.scanned, 1);
  first.close();
  const second = openWorker({
    dbPath,
    posterDir: dir,
    libraries: [library("lib_anime", "anime")],
    files: { lib_anime: files },
    bangumi: searcher("bangumi", calls, (query) => [hit("bangumi", query, query)]),
    tmdb: searcher("tmdb", calls, () => []),
  });
  try {
    const done = await second.worker.continue("lib_anime");
    assert.equal(done?.status, "done");
    assert.equal(done?.scanned, 3);
    assert.equal(calls.length, 3);
  } finally {
    second.close();
  }
});

test("a rejected pair is not proposed again on the next scan", async () => {
  const calls: string[] = [];
  const both = (query: string): MetadataHit[] => [hit("bangumi", "keep", query), hit("bangumi", "drop", query)];
  const opened = openWorker({
    libraries: [library("lib_anime", "anime")],
    files: { lib_anime: [{ relativePath: "/Medalist.mkv", name: "Medalist.mkv", mediaId: "a" }] },
    bangumi: searcher("bangumi", calls, both),
    tmdb: searcher("tmdb", calls, () => []),
  });
  try {
    await opened.worker.start("lib_anime");
    const detail = opened.catalog.getDetail(opened.catalog.listCards("lib_anime", undefined, undefined).items[0]?.id ?? "");
    const drop = detail?.candidates.find((candidate) => candidate.title === "Medalist");
    assert.equal(detail?.status, "candidate");
    assert.equal(detail?.candidates.length, 2);
    assert.equal(opened.catalog.reject(detail?.id ?? "", drop?.id ?? ""), true);
    await opened.worker.start("lib_anime");
    const again = opened.catalog.getDetail(detail?.id ?? "");
    assert.equal(again?.status, "confirmed");
    assert.equal(again?.candidates.some((candidate) => candidate.id === drop?.id), false);
    assert.equal(calls.filter((call) => call.startsWith("bangumi:")).length, 2);
  } finally {
    opened.close();
  }
});

test("listing a library does not scrape, and a scrape serves the cached poster", async () => {
  const calls = { bangumi: 0, tmdb: 0 };
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "secret-value" }),
    catalogInline: true,
    catalogDelayMs: 0,
    libraryClientFactory: () => fakeLibrary(WATCHPARTY_ROOTS.Anime),
    bangumi: {
      async search(query) {
        calls.bangumi += 1;
        return [hit("bangumi", "430699", query, "https://lain.bgm.tv/pic/a.jpg")];
      },
    },
    tmdb: {
      async search() {
        calls.tmdb += 1;
        return [];
      },
    },
    fetchPoster: async (url) => {
      assert.equal(new URL(url).hostname, "lain.bgm.tv");
      return { contentType: "image/jpeg", bytes: JPEG };
    },
  });
  await backend.start();
  try {
    const listed = await fetch(`${baseUrl(backend)}/api/media/list?libraryId=lib_anime`);
    assert.equal(listed.status, 200);
    assert.equal(calls.bangumi, 0);
    const scrape = await fetch(`${baseUrl(backend)}/api/admin/media-libraries/lib_anime/scrape`, { method: "POST" });
    assert.equal(scrape.status, 200);
    const job = (await scrape.json()) as { status: string; matched: number; lastError: string | null };
    assert.equal(job.status, "done");
    assert.equal(job.matched, 1);
    assert.equal(job.lastError, null);
    assert.equal(calls.tmdb, 0);
    const catalog = (await (await fetch(`${baseUrl(backend)}/api/media/catalog?libraryId=lib_anime`)).json()) as {
      items: Array<{ title: string; status: string; posterUrl: string | null }>;
    };
    assert.equal(catalog.items[0]?.title, "Medalist");
    assert.equal(catalog.items[0]?.status, "confirmed");
    const posterUrl = catalog.items[0]?.posterUrl ?? "";
    const poster = await fetch(`${baseUrl(backend)}${posterUrl}`);
    assert.equal(poster.status, 200);
    assert.equal(poster.headers.get("content-type"), "image/jpeg");
    assert.equal(Buffer.compare(Buffer.from(await poster.arrayBuffer()), JPEG), 0);
    const body = JSON.stringify(catalog);
    assert.equal(body.includes("lain.bgm.tv"), false);
    assert.equal(body.includes("secret-value"), false);
    assert.equal(body.includes("/media/openlist"), false);
  } finally {
    await backend.close();
  }
});

function library(id: string, kind: StoredLibrary["kind"]): StoredLibrary {
  return { id, sourceId: "src", name: id, kind, absolutePath: `/media/${id}` };
}

function hit(externalDb: "bangumi" | "tmdb", externalId: string, title: string, imageUrl: string | null = null): MetadataHit {
  return { externalDb, externalId, title, originalTitle: null, year: null, overview: "plot", imageUrl, episodes: null };
}

function searcher(db: "bangumi" | "tmdb", calls: string[], hitsFor: (query: string) => MetadataHit[]): MetadataSearcher {
  return {
    async search(query) {
      calls.push(`${db}:${query}`);
      return hitsFor(query);
    },
  };
}

function openWorker(options: {
  libraries: StoredLibrary[];
  files: Record<string, Array<{ relativePath: string; name: string; mediaId: string }>>;
  bangumi: MetadataSearcher;
  tmdb: MetadataSearcher;
  dbPath?: string;
  posterDir?: string;
  maxLookups?: number;
}) {
  const posterDir = options.posterDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "wp-posters-"));
  const catalog = openCatalogStore(options.dbPath ?? ":memory:", posterDir);
  const byId = new Map(options.libraries.map((library) => [library.id, library]));
  const worker = createCatalogWorker({
    catalog,
    bangumi: options.bangumi,
    tmdb: options.tmdb,
    fetchPoster: async (url) => (new URL(url).hostname === "lain.bgm.tv" || new URL(url).hostname === "image.tmdb.org" ? { contentType: "image/jpeg", bytes: JPEG } : undefined),
    listFiles: async (library) => options.files[library.id] ?? [],
    getLibrary: (id) => byId.get(id),
    delayMs: 0,
    inline: true,
    ...(options.maxLookups !== undefined ? { maxLookupsPerRun: options.maxLookups } : {}),
  });
  return { catalog, worker, close: () => catalog.close() };
}

function fakeLibrary(root: string): OpenlistClient {
  return {
    async list(dir) {
      if (dir !== root) return { code: 200, data: { content: [] } };
      return { code: 200, data: { content: [{ name: "Medalist.mkv", is_dir: false, size: 10, path: `${root}/Medalist.mkv` }] } };
    },
    async listShallow() {
      return { code: 200, data: { content: [] } };
    },
    async search() {
      return { code: 200, data: { content: [] } };
    },
    async getDownloadInfo() {
      throw new Error("list must not fetch artwork");
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
}

function baseUrl(backend: Backend): string {
  return `http://127.0.0.1:${backend.port}`;
}
