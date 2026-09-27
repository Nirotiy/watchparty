import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { cleanTitle, episodeSubtitle, groupScanFiles, scoreTitles, titleCandidateDetails, titleCandidates, yearFrom } from "../media/catalog-names.ts";
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

test("the subtitle group is never the search query", () => {
  const names = [
    "[TxxZ&POPGO&MGRT][Cowboy_Bebop][01][1080p][x264_ac3].mkv",
    "[TxxZ&POPGO&MGRT][Cowboy_Bebop][02][1080p][x264_ac3].mkv",
    "[TxxZ&POPGO&MGRT][Cowboy_Bebop][03][1080p][x264_ac3].mkv",
  ];
  assert.deepEqual(titleCandidates(names, "[TxxZ&POPGO&MGRT][Cowboy_Bebop][BDRip][1080p]").slice(0, 1), [
    "Cowboy Bebop",
  ]);
  // The group name still has to stay reachable as a last resort, but behind the title.
  assert.equal(titleCandidates(["[Airota][Made in Abyss][01][1080p].mkv", "[Airota][Made in Abyss][02][1080p].mkv"], "[Airota][Made in Abyss][BDRip]")[0], "Made in Abyss");
});

test("a title containing & is not mistaken for a group collab", () => {
  // `&` alone used to mean "collab", which threw away the only chunk that named
  // this show: the folder is an episode-name directory (`爆炸`) and every one of
  // its files carries the work title in the second bracket.
  const names = [
    "[DBD-Raws][Panty & Stocking with Garterbelt][Explosion][01][1080P][BDRip][HEVC-10bit][FLAC].mkv",
    "[DBD-Raws][Panty & Stocking with Garterbelt][Explosion][02][1080P][BDRip][HEVC-10bit][FLAC].mkv",
  ];
  assert.equal(titleCandidates(names, "爆炸")[0], "Panty & Stocking with Garterbelt");
  // Collabs of handles still read as groups.
  assert.equal(titleCandidates(["[Nekomoe keitai&VCB-Studio] ODDTAXI [01][Ma10p_1080p].mkv"], "[Nekomoe keitai&VCB-Studio] ODDTAXI [Ma10p_1080p]")[0], "ODDTAXI");
});

test("encode and subtitle-config tags are dropped from candidates", () => {
  const names = [
    "[云光字幕组]摇曳露营△ 第三季 Yuru Camp Season 3 [01][简体双语][1080p]招募翻译.mp4",
    "[云光字幕组]摇曳露营△ 第三季 Yuru Camp Season 3 [02][简体双语][1080p]招募翻译.mp4",
  ];
  const [first] = titleCandidates(names, "[云光字幕组]摇曳露营△ 第三季 Yuru Camp Season 3 [合集][简体双语][1080p]招募翻译");
  assert.ok(first.includes("摇曳露营"), `expected the work title, got "${first}"`);
  assert.ok(!/简体|招募|1080|合集/.test(first), `tags leaked into the query: "${first}"`);
  // Composite tags survive a whole-chunk test but not a per-token one.
  assert.deepEqual(titleCandidates(["[POPGO][Ghost in the Shell][01][1080P][x264_FLACx2_AC3x1][chs_jpn][D4C0C6B6].mkv"], "[POPGO][Ghost_in_the_Shell][BDRIP][1080P]")[0], "Ghost in the Shell");
});

test("per-file episode titles do not outrank the folder title", () => {
  const names = ["FLCL 01 Fooly Cooly.mkv", "FLCL 02 Fire Starter.mkv", "FLCL 03 Marquis de Carabas.mkv"];
  assert.equal(titleCandidates(names, "特别的她 FLCL(2000)[BDrip][1920x1080][OVA6]加刘景长压制")[0], "特别的她 FLCL");
});

test("dot-separated names lose their release bookkeeping, keep the season", () => {
  const names = [
    "01 昭和元禄落语心中 第一季.EP01.1080p.BluRay.x264.FLAC.CHS-LxyLab.mkv",
    "02 昭和元禄落语心中 第一季.EP02.1080p.BluRay.x264.FLAC.CHS-LxyLab.mkv",
  ];
  const [first] = titleCandidates(names, "昭和元禄落语心中.2016.全两季.1080p.BluRay.x264.FLAC.CHS-LxyLab");
  assert.ok(first.startsWith("昭和元禄落语心中 第一季"), `got "${first}"`);
  assert.ok(!/EP0|1080|BluRay|2016/.test(first), `tags leaked into the query: "${first}"`);
});

test("specials roll up into the work instead of becoming a second item", () => {
  const groups = groupScanFiles([
    { relativePath: "/[VCB-Studio] MAWARU PENGUINDRUM [Ma10p_1080p]/[VCB-Studio] MAWARU PENGUINDRUM [01][Ma10p_1080p].mkv", name: "[VCB-Studio] MAWARU PENGUINDRUM [01][Ma10p_1080p].mkv", mediaId: "a" },
    { relativePath: "/[VCB-Studio] MAWARU PENGUINDRUM [Ma10p_1080p]/SPs/[VCB-Studio] MAWARU PENGUINDRUM [SP01][Ma10p_1080p].mkv", name: "[VCB-Studio] MAWARU PENGUINDRUM [SP01][Ma10p_1080p].mkv", mediaId: "b" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.itemKey, "/[VCB-Studio] MAWARU PENGUINDRUM [Ma10p_1080p]");
  assert.equal(groups[0]?.query, "MAWARU PENGUINDRUM");
  assert.equal(groups[0]?.files.length, 2, "the special must stay attached to the series");
});

test("a nested work directory stays its own item", () => {
  // 《第三飞行少女队》 is a separate Bangumi subject filed inside the SHIROBAKO
  // tree, so upward merging may never be unconditional.
  const groups = groupScanFiles([
    { relativePath: "/[VCB-Studio] SHIROBAKO [Ma10p_1080p]/[VCB-Studio] SHIROBAKO [01][Ma10p_1080p].mkv", name: "[VCB-Studio] SHIROBAKO [01][Ma10p_1080p].mkv", mediaId: "a" },
    { relativePath: "/[VCB-Studio] SHIROBAKO [Ma10p_1080p]/[VCB-Studio] Daisan Hikou Shoujotai [Ma10p_1080p]/[VCB-Studio] Daisan Hikou Shoujotai [Ma10p_1080p].mkv", name: "[VCB-Studio] Daisan Hikou Shoujotai [Ma10p_1080p].mkv", mediaId: "b" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.query).sort(), ["Daisan Hikou Shoujotai", "SHIROBAKO"]);
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

test("a dot-separated movie release name reduces to the title", () => {
  // The Films wall was empty because a scene name has no spaces, so the
  // "single token with a hyphen" group shape classified the whole string as a
  // subtitle group and dropped every candidate (frontend title-cleaning ask).
  const raw = "Wicked.2024.Hybrid.2160p.WEB-DL.DV.HDR.DDP5.1.H265-AOC.mkv";
  assert.deepEqual(titleCandidates([raw], raw.slice(0, -4)), ["Wicked"]);
  assert.equal(yearFrom(raw), 2024);
});

test("catalog detail children carry the same compatibility verdict as the browser listing", () => {
  const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-posters-"));
  const store = openCatalogStore(":memory:", posterDir);
  try {
    store.upsertScan("lib_anime", "tv", [
      {
        itemKey: "/Show",
        query: "Show",
        queries: ["Show"],
        rawName: "Show",
        files: [
          { mediaId: "v2.a", name: "Show 01.mkv", season: null, episode: 1 },
          { mediaId: "v2.b", name: "Show 02.mp4", season: null, episode: 2 },
        ],
      },
    ]);
    const [pending] = store.listPending("lib_anime");
    assert.ok(pending);
    const detail = store.getDetail(pending.id)!;
    const [mkv, mp4] = detail.children;
    assert.equal(mkv.compatibility.browser, "unsupported");
    assert.equal(mkv.compatibility.desktop, "supported");
    assert.ok(mkv.compatibility.browserReason, "MKV must say why the browser refuses it");
    assert.deepEqual(
      [mp4.compatibility.browser, mp4.compatibility.desktop],
      ["supported", "supported"],
    );
  } finally {
    store.close();
  }
});

test("rolled-up bonus files stay on the card but are not counted as episodes", () => {
  // Frontend decision B (2026-09-27): `12 集` plus a `SPs` folder of 67 CM/Audio
  // Drama clips must not announce itself as 79 集, while the clips stay playable.
  const groups = groupScanFiles([
    ...[1, 2, 3, 4].map((n) => ({
      relativePath: `/[VCB] Revue Starlight/Revue Starlight [0${n}][Ma10p].mkv`,
      name: `Revue Starlight [0${n}][Ma10p].mkv`,
      mediaId: `ep${n}`,
    })),
    { relativePath: "/[VCB] Revue Starlight/SPs/Revue Starlight [CM01][Ma10p].mkv", name: "Revue Starlight [CM01][Ma10p].mkv", mediaId: "cm1" },
    { relativePath: "/[VCB] Revue Starlight/SPs/Revue Starlight [Audio Drama 01.3][Ma10p].mkv", name: "Revue Starlight [Audio Drama 01.3][Ma10p].mkv", mediaId: "ad1" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.files.length, 6, "the bonus files stay attached to the card");
  assert.equal(episodeSubtitle(groups[0]?.files ?? []), "4 集");
});

test("a film with only bonus extras shows no count instead of a wrong one", () => {
  const groups = groupScanFiles([
    { relativePath: "/Gekijouban SHIROBAKO/Gekijouban SHIROBAKO [Ma10p].mkv", name: "Gekijouban SHIROBAKO [Ma10p].mkv", mediaId: "movie" },
    { relativePath: "/Gekijouban SHIROBAKO/SPs/SHIROBAKO [Cast Commentary 01].mkv", name: "SHIROBAKO [Cast Commentary 01].mkv", mediaId: "cc1" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.files.length, 2);
  assert.equal(episodeSubtitle(groups[0]?.files ?? []), null, "sub-line must disappear, not read 0 集 or 2 集");
});

test("episode-name folders roll up and still count as episodes", () => {
  const groups = groupScanFiles([
    { relativePath: "/作品/第01话/作品 - 01.mkv", name: "作品 - 01.mkv", mediaId: "a" },
    { relativePath: "/作品/第02话/作品 - 02.mkv", name: "作品 - 02.mkv", mediaId: "b" },
    { relativePath: "/作品/第03话/作品 - 03.mkv", name: "作品 - 03.mkv", mediaId: "c" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.itemKey, "/作品");
  assert.equal(episodeSubtitle(groups[0]?.files ?? []), "3 集");
});

test("a season folder carrying a trailing note still rolls up into the work", () => {
  // `第三季 包含字幕和弹幕文件` escaped the old exact-match season rule, so each
  // season became its own card and the work name never entered the candidates.
  const groups = groupScanFiles([
    { relativePath: "/克拉克森的农场/第三季 包含字幕和弹幕文件/S03E01 荒原.mp4", name: "S03E01 荒原.mp4", mediaId: "a" },
    { relativePath: "/克拉克森的农场/第三季 包含字幕和弹幕文件/S03E02 围栏.mp4", name: "S03E02 围栏.mp4", mediaId: "b" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.itemKey, "/克拉克森的农场");
  assert.equal(groups[0]?.query, "克拉克森的农场");
  assert.equal(episodeSubtitle(groups[0]?.files ?? []), "S3 · 2 集");
});

test("a title only one file carries is not an authoritative guess", () => {
  const details = titleCandidateDetails(["S03E01 荒原.mp4", "S03E02 围栏.mp4"], "克拉克森的农场");
  assert.equal(details[0]?.query, "克拉克森的农场");
  assert.equal(details[0]?.authoritative, true, "the directory names the work, so files may disagree");
  assert.equal(details.some((entry) => entry.query === "荒原" && entry.authoritative), false);
});

test("an episode title that is also another show's name cannot auto-confirm the card", async () => {
  // This is how `/克拉克森的农场/第三季 …` got bound to 荒原 (tmdb:47450): the
  // folder gave up no title, so a single file's episode name was searched verbatim.
  const calls: string[] = [];
  const { catalog, worker, close } = openWorker({
    libraries: [library("lib_tv", "tv")],
    files: {
      lib_tv: [
        { relativePath: "/Show/Season3 notes/S03E01 荒原.mp4", name: "S03E01 荒原.mp4", mediaId: "a" },
        { relativePath: "/Show/Season3 notes/S03E02 围栏.mp4", name: "S03E02 围栏.mp4", mediaId: "b" },
      ],
    },
    bangumi: searcher("bangumi", calls, () => []),
    tmdb: searcher("tmdb", calls, (query) => (query === "荒原" ? [hit("tmdb", "47450", "荒原")] : [])),
  });
  try {
    await worker.start("lib_tv");
    const cards = catalog.listCards("lib_tv", undefined, undefined).items;
    assert.equal(cards[0]?.status, "candidate", "an episode-name match must stay reviewable");
    assert.equal(calls.some((call) => call.endsWith("荒原")), true, "the guess should still have been searched");
  } finally {
    close();
  }
});

test("a subfolder whose files name the parent work folds into that card", () => {
  const files = [
    ...[1, 2, 3].map((n) => `/[DBD][泽塔奥特曼][01-25TV]` + `/[DBD-Raws][泽塔奥特曼][${String(n).padStart(2, "0")}][1080P].mkv`),
    ...[1, 2].map((n) => `/[DBD][泽塔奥特曼][01-25TV]/人物访谈/[DBD-Raws][泽塔奥特曼][人物访谈][${n}][1080P].mkv`),
    ...[1, 2].map((n) => `/[DBD][泽塔奥特曼][01-25TV]/遥辉的奥特导航/[DBD-Raws][泽塔奥特曼][遥辉的奥特导航][${n}][1080P].mkv`),
  ].map((relativePath) => ({ relativePath, name: relativePath.split("/").pop() ?? relativePath, mediaId: relativePath }));
  const groups = groupScanFiles(files);
  assert.equal(groups.length, 1, "访谈与奥特导航不是两部作品");
  assert.equal(groups[0]?.files.length, 7);
  assert.equal(episodeSubtitle(groups[0]?.files ?? [], groups[0]?.itemKey), "3 集", "集数只数与卡同层的文件");
});

test("a different work filed inside another tree is not folded away", () => {
  const paths = [
    "/[VCB-Studio] SHIROBAKO/[VCB-Studio] SHIROBAKO [01][Ma10p].mkv",
    "/[VCB-Studio] SHIROBAKO/[VCB-Studio] SHIROBAKO [02][Ma10p].mkv",
    "/[VCB-Studio] SHIROBAKO/[VCB-Studio] Daisan Hikou Shoujotai [Ma10p]/[VCB-Studio] Daisan Hikou Shoujotai [Ma10p].mkv",
    "/[VCB-Studio] SHIROBAKO/[VCB-Studio] Exodus! [Ma10p_1080p]/[VCB-Studio] Exodus! [01][Ma10p].mkv",
  ];
  const groups = groupScanFiles(paths.map((relativePath) => ({ relativePath, name: relativePath.split("/").pop() ?? relativePath, mediaId: relativePath })));
  const keys = groups.map((group) => group.query).sort();
  assert.deepEqual(keys, ["Daisan Hikou Shoujotai", "Exodus!", "SHIROBAKO"], "第三飞行少女队与 Exodus 都是独立条目");
});

test("season folders folded into one card still count every episode", () => {
  const paths = [
    "/克拉克森的农场/第一季 包含字幕和弹幕文件/S01E01 拖拉机.mp4",
    "/克拉克森的农场/第一季 包含字幕和弹幕文件/S01E02 围栏.mp4",
    "/克拉克森的农场/第三季 包含字幕和弹幕文件/S03E01 荒原.mp4",
    "/克拉克森的农场/第三季 包含字幕和弹幕文件/S03E02 牛棚.mp4",
  ];
  const groups = groupScanFiles(paths.map((relativePath) => ({ relativePath, name: relativePath.split("/").pop() ?? relativePath, mediaId: relativePath })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.query, "克拉克森的农场");
  assert.equal(episodeSubtitle(groups[0]?.files ?? [], groups[0]?.itemKey), "4 集");
});
