import assert from "node:assert/strict";
import test from "node:test";
import { folderOf, matchSidecars, parseSidecar, sidecarsIn } from "../media/catalog-sidecar.ts";

const MOVIE_NFO = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>机动战士高达0079 剧场版三部曲 &amp; 更&es;多</title>
  <originaltitle>Mobile Suit Gundam</originaltitle>
  <sorttitle>Mobile Suit Gundam 0080</sorttitle>
  <year>1988</year>
  <plot><![CDATA[  口袋里的战争  ]]></plot>
  <uniqueid type="tmdb" default="true">12345</uniqueid>
  <uniqueid type="imdb">tt0100151</uniqueid>
  <set><name>Gundam 0079 Films</name></set>
  <poster>poster.jpg</poster>
</movie>`;

const EPISODE_NFO = `<episode>
  <title>第 4 话</title><showtitle>Yuru Camp△</showtitle>
  <season>2</season><episode>4</episode>
  <uniqueid type="tvdb">999</uniqueid>
  <premiered>2021-01-14</premiered>
</episode>`;

const JELLYFIN_JSON = JSON.stringify({
  Type: "Movie",
  Name: "魔法坏女巫",
  OriginalTitle: "Wicked",
  ProductionYear: 2024,
  Overview: "两个女巫",
  ProviderIds: { Tmdb: "664767", Imdb: "tt11397978", Bangumi: "123456" },
});

test("movie.nfo：标题、实体、CDATA、uniqueid 与 set 都读得出", () => {
  const meta = parseSidecar("movie.nfo", MOVIE_NFO, "/Film");
  assert.equal(meta.kind, "movie");
  assert.equal(meta.title, "机动战士高达0079 剧场版三部曲 & 更&es;多");
  assert.equal(meta.originalTitle, "Mobile Suit Gundam");
  assert.equal(meta.year, 1988);
  assert.equal(meta.overview, "口袋里的战争");
  assert.deepEqual(meta.ids, { tmdb: "12345", imdb: "tt0100151", tvdb: null, bangumi: null });
  assert.equal(meta.set, "Gundam 0079 Films");
  assert.deepEqual(meta.warnings, []);
});

test("episode.nfo：靠 showtitle 认类型，季/集与 premiered 年份都读", () => {
  const meta = parseSidecar("S02E04.nfo", EPISODE_NFO, "/Anime/Yuru Camp S2");
  assert.equal(meta.kind, "episode");
  assert.equal(meta.season, 2);
  assert.equal(meta.episode, 4);
  assert.equal(meta.year, 2021);
  assert.equal(meta.ids.tvdb, "999");
});

test("Emby/Jellyfin 的 .json：大小写两种字段名都吃", () => {
  const meta = parseSidecar("movie.json", JELLYFIN_JSON, "/Film/Wicked");
  assert.equal(meta.kind, "movie");
  assert.equal(meta.title, "魔法坏女巫");
  assert.equal(meta.year, 2024);
  assert.deepEqual(meta.ids, { tmdb: "664767", imdb: "tt11397978", tvdb: null, bangumi: "123456" });
});

test("坏输入不抛错：报 warning，字段留空", () => {
  const truncated = parseSidecar("movie.nfo", "<movie><title>没有闭合", "/Film");
  assert.equal(truncated.title, null);
  assert.deepEqual(truncated.warnings, []);
  const brokenJson = parseSidecar("movie.json", "{ not json", "/Film");
  assert.deepEqual(brokenJson.warnings, ["invalid-json"]);
  assert.equal(parseSidecar("notes.txt", "hi", "/Film").warnings[0], "unsupported-extension");
});

test("sidecar 挑选：fanart/clearart 这类装饰文件不算元数据", () => {
  assert.deepEqual(
    sidecarsIn(["movie.nfo", "fanart.jpg", "fanart.nfo", "clearart.png", "tvshow.nfo", "extrafanart.nfo", "movie.json", "poster.jpg"]).sort(),
    ["movie.json", "movie.nfo", "tvshow.nfo"],
  );
});

test("匹配按目录（文件集合的代理）优先，外部 ID 只作辅助；撞车就报冲突", () => {
  const cards = [
    { itemKey: "/Film/Wicked", title: "Wicked", externalDb: "tmdb", externalId: "664767", folders: ["/Film/Wicked"] },
    { itemKey: "/Other/Wicked", title: "Wicked 副本", externalDb: null, externalId: null, folders: ["/Other/Wicked"] },
    { itemKey: "/Anime/Yuru", title: "摇曳露营", externalDb: "bangumi", externalId: "999", folders: ["/Anime/Yuru Camp S2"] },
  ];
  const sidecars = [
    { folder: "/Film/Wicked", title: "魔法坏女巫", year: 2024, ids: { tmdb: "664767", imdb: null, tvdb: null, bangumi: null }, sourceFile: "movie.nfo", kind: "movie" as const },
    { folder: "/Anime/Yuru Camp S2", title: null, year: null, ids: { tmdb: null, imdb: null, tvdb: "999", bangumi: null }, sourceFile: "tvshow.nfo", kind: "tvshow" as const },
    { folder: "/Nowhere", title: "无主", year: null, ids: { tmdb: "777", imdb: null, tvdb: null, bangumi: null }, sourceFile: "movie.nfo", kind: "movie" as const },
  ];
  const result = matchSidecars(sidecars, cards);
  assert.deepEqual(result.matched.map((entry) => [entry.sidecar.folder, entry.card.itemKey, entry.how]), [
    ["/Film/Wicked", "/Film/Wicked", "folder"],
    ["/Anime/Yuru Camp S2", "/Anime/Yuru", "folder"],
  ]);
  assert.deepEqual(result.unmatched.map((entry) => entry.folder), ["/Nowhere"], "认不出就报未匹配，不自动新建卡");
  assert.equal(folderOf("/Film/Wicked/movie.mkv"), "/Film/Wicked");
});

test("两张卡都声称同一个目录 ⇒ 冲突，不猜", () => {
  const cards = [
    { itemKey: "/A", title: "A", externalDb: null, externalId: null, folders: ["/X"] },
    { itemKey: "/B", title: "B", externalDb: null, externalId: null, folders: ["/X"] },
  ];
  const result = matchSidecars([{ folder: "/X", title: "x", year: null, ids: { tmdb: null, imdb: null, tvdb: null, bangumi: null }, sourceFile: "movie.nfo", kind: "movie" }], cards);
  assert.equal(result.matched.length, 0);
  assert.equal(result.ambiguous[0]?.cards.length, 2);
});
