import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCollection,
  classifyPlacements,
  collectionDiskPath,
  collectionJson,
  collectionPath,
  parseCollection,
  readCollectionRoot,
  reconcileCollections,
  resolveMemberPaths,
  safeSegments,
  writeCollectionRoot,
  type CollectionSidecar,
} from "../media/collection-sidecar.ts";

const VALID = JSON.stringify({
  schemaVersion: 1,
  collectionId: "ova-main",
  libraryId: "lib_anime",
  root: "Anime",
  basePath: "牧場日記",
  title: "牧場日記 OVA",
  originalTitle: "Bokurano OVA",
  year: 2020,
  overview: "简介",
  poster: "https://example/poster.jpg",
  external: { db: "bangumi", id: "123456" },
  members: [
    { path: "OVA 01.mkv", season: 1, episode: 1, title: "第一话", role: "episode" },
    { path: "/牧場日記/SPs/SP 01.mkv", role: "bonus" },
  ],
});

function sidecarOf(sourceFile: string, value: unknown): CollectionSidecar {
  const parsed = parseCollection(sourceFile, typeof value === "string" ? value : JSON.stringify(value));
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.sidecar);
  return parsed.sidecar;
}

test("collection sidecar：合法文件读出全部字段，member 顺序即文件集合顺序", () => {
  const parsed = parseCollection("作品/.watchparty.collection.json", VALID);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  const sidecar = parsed.sidecar!;
  assert.equal(sidecar.collectionId, "ova-main");
  assert.equal(sidecar.libraryId, "lib_anime");
  assert.equal(sidecar.basePath, "/牧場日記");
  assert.equal(sidecar.year, 2020);
  assert.equal(sidecar.poster, "https://example/poster.jpg");
  assert.deepEqual([sidecar.externalDb, sidecar.externalId], ["bangumi", "123456"]);
  assert.equal(sidecar.members.length, 2);
  assert.equal(sidecar.members[0]!.title, "第一话");
  assert.equal(sidecar.members[1]!.role, "bonus");
});

test("解析错误是结构化清单，不是异常：一个坏字段不会让整份文件读不出来", () => {
  const codes = (value: unknown) => parseCollection("x.json", typeof value === "string" ? value : JSON.stringify(value)).errors.map((error) => error.code);
  assert.deepEqual(codes("{"), ["invalid-json"]);
  assert.deepEqual(codes([]), ["not-an-object"]);
  assert.deepEqual(codes({ schemaVersion: 2, basePath: "/", members: [{ path: "a.mkv" }] }), ["schema-version"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/" }), ["members-required"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{}] }), ["member-path-required", "members-required"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{ path: "../../etc/passwd" }] }), ["member-path-unsafe", "members-required"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{ path: "a.mkv" }, { path: "./a.mkv" }] }), ["member-path-duplicate"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{ path: "a.mkv" }], external: { db: "bangumi" } }), ["external-pair"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{ path: "a.mkv" }], year: "2020-ab" }), ["bad-year"]);
  assert.deepEqual(codes({ schemaVersion: 1, basePath: "/", members: [{ path: "a.mkv", role: "opening" }] }), ["bad-role"]);
  // external-pair 之后绑定被判废：不能让只写了 db 的文件带着半截绑定进草稿。
  const half = parseCollection("x.json", JSON.stringify({ schemaVersion: 1, basePath: "/", members: [{ path: "a.mkv" }], external: { db: "bangumi" } })).sidecar!;
  assert.deepEqual([half.externalDb, half.externalId], [null, null]);
});

test("collectionPath：库内相对路径的规范化与越界拒绝", () => {
  assert.equal(collectionPath("/A/B", "C.mkv"), "/A/B/C.mkv");
  assert.equal(collectionPath("/A/B", "/A/C.mkv"), "/A/C.mkv");
  assert.equal(collectionPath("/", "/A/C.mkv"), "/A/C.mkv");
  assert.equal(collectionPath("/A//B/", "./C.mkv"), "/A/B/C.mkv");
  assert.equal(collectionPath("/A", "B\\C.mkv"), "/A/B/C.mkv");
  assert.equal(collectionPath("/A/B", "../C.mkv"), null);
  assert.equal(collectionPath("/A", ""), null);
  assert.equal(collectionPath("/A", "/"), null);
});

test("member 路径解析后能直接和 catalog_scan.rel_path 对齐", () => {
  const sidecar = sidecarOf("s", VALID);
  assert.deepEqual(resolveMemberPaths(sidecar), {
    paths: ["/牧場日記/OVA 01.mkv", "/牧場日記/SPs/SP 01.mkv"],
    unsafe: [],
  });
});

test("导出器：同目录只写文件名，跨目录写完整库内路径，basePath 取公共目录", () => {
  const sidecar = buildCollection("lib_anime", "动画", {
    itemKey: "/ Anime / 作品名 ",
    children: [
      { relativePath: "/Anime/作品名/S01E01.mkv", name: "S01E01.mkv", season: 1, episode: 1 },
      { relativePath: "/Anime/作品名/S01E02.mkv", name: "S01E02.mkv", season: 1, episode: 2 },
      { relativePath: "/Anime/作品名/SPs/SP01.mkv", name: "SP01.mkv", season: null, episode: 1, bonus: true },
    ],
    title: "作品名",
    originalTitle: null,
    year: 2001,
    overview: null,
    posterUrl: null,
    externalDb: "tmdb",
    externalId: "42",
  });
  assert.equal(sidecar.basePath, "/Anime/作品名");
  assert.deepEqual(sidecar.members.map((member) => member.path), ["S01E01.mkv", "S01E02.mkv", "SPs/SP01.mkv"]);
  assert.deepEqual(sidecar.members.map((member) => member.role), ["episode", "episode", "bonus"]);
  assert.equal(sidecar.collectionId, "作品名");
  // 导出文件再读回来必须得到同一个文件集合，否则导一次就丢结构。
  const round = sidecarOf("round", collectionJson(sidecar));
  assert.deepEqual(resolveMemberPaths(round).paths, resolveMemberPaths(sidecar).paths);
  assert.equal(round.year, 2001);
  assert.deepEqual([round.externalDb, round.externalId], ["tmdb", "42"]);
});

test("导出器：没有 relativePath 的子文件走显式标记，不静默退成文件名", () => {
  const sidecar = buildCollection("lib_tv", null, {
    itemKey: "/Show",
    children: [{ mediaId: "m1", name: "E01.mkv", season: 1, episode: 1 }],
    title: "Show",
    originalTitle: null,
    year: null,
    overview: null,
    posterUrl: null,
    externalDb: null,
    externalId: null,
  });
  assert.deepEqual(sidecar.members[0]!.path, "id:m1");
  assert.equal(sidecar.basePath, "/");
});

test("对账：matched / missing / unlisted / ambiguous 四分类", () => {
  const scan = [
    { relativePath: "/A/one.mkv", name: "one.mkv", mediaId: "1" },
    { relativePath: "/A/two.mkv", name: "two.mkv", mediaId: "2" },
    { relativePath: "/A/three.mkv", name: "three.mkv", mediaId: "3" },
  ];
  const good = sidecarOf("a/good", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }, { path: "two.mkv" }] });
  const missing = sidecarOf("a/missing", { schemaVersion: 1, basePath: "A", root: "Root", members: [{ path: "gone.mkv" }] });
  const withRoot = sidecarOf("a/with-root", { schemaVersion: 1, root: "A", basePath: "/", members: [{ path: "/A/three.mkv" }] });
  const overlap = sidecarOf("a/overlap", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }] });
  const result = reconcileCollections([good, missing, withRoot, overlap], scan);
  assert.deepEqual(result.shapes.map((shape) => [shape.sourceFile, shape.paths.length, shape.missing]), [
    ["a/good", 2, []],
    ["a/missing", 0, ["/A/gone.mkv"]],
    ["a/with-root", 1, []],
    ["a/overlap", 1, []],
  ]);
  assert.deepEqual(result.ambiguous, [{ relPath: "/A/one.mkv", sourceFiles: ["a/good", "a/overlap"] }]);
  // 带 root 前缀的写法去层后命中，所以 three.mkv 不算 unlisted。
  assert.deepEqual(result.unlisted, []);
  assert.equal(result.scannedFiles, 3);
  const lonely = reconcileCollections([good], scan);
  assert.deepEqual(lonely.unlisted, [{ relPath: "/A/three.mkv", under: "/A" }]);
});

test("落点：文件集合等于/包含/横跨/无关，各自给出可执行的那一步", () => {
  const scan = [
    { relativePath: "/A/one.mkv", name: "one.mkv", mediaId: "1" },
    { relativePath: "/A/two.mkv", name: "two.mkv", mediaId: "2" },
    { relativePath: "/A/three.mkv", name: "three.mkv", mediaId: "3" },
    { relativePath: "/B/four.mkv", name: "four.mkv", mediaId: "4" },
    // 库里有、草稿里还没有：这才是"新作品"，需要建卡（结构变更）。
    { relativePath: "/C/new.mkv", name: "new.mkv", mediaId: "5" },
  ];
  const cards = [
    { itemKey: "/A", paths: ["/A/one.mkv", "/A/two.mkv", "/A/three.mkv"], confirmedBy: null },
    { itemKey: "/B", paths: ["/B/four.mkv"], confirmedBy: "manual" },
  ];
  const equal = sidecarOf("c-equal", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }, { path: "two.mkv" }, { path: "three.mkv" }] });
  const subset = sidecarOf("c-subset", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }] });
  const span = sidecarOf("c-span", { schemaVersion: 1, basePath: "/", members: [{ path: "/A/one.mkv" }, { path: "/B/four.mkv" }] });
  const fresh = sidecarOf("c-fresh", { schemaVersion: 1, basePath: "/C", members: [{ path: "new.mkv" }] });
  const broken = sidecarOf("c-broken", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }, { path: "nope.mkv" }] });
  const shapes = reconcileCollections([equal, subset, span, fresh, broken], scan).shapes;
  const placements = classifyPlacements(shapes, cards);
  assert.deepEqual(placements.map((placement) => [placement.sourceFile, placement.kind]), [
    ["c-equal", "metadata"],
    ["c-subset", "split"],
    ["c-span", "merge"],
    ["c-fresh", "new"],
    ["c-broken", "conflict"],
  ]);
  const split = placements[1] as { kind: "split"; itemKey: string; extraPaths: string[] };
  assert.equal(split.itemKey, "/A");
  assert.deepEqual(split.extraPaths, ["/A/two.mkv", "/A/three.mkv"]);
  const merge = placements[2] as { kind: "merge"; itemKey: string; dropKeys: string[] };
  // keepKey 取重合文件最多的那张：它最可能是人正在看的那张。
  assert.equal(merge.itemKey, "/A");
  assert.deepEqual(merge.dropKeys, ["/B"]);
  assert.equal((placements[4] as { reason: string }).reason, "missing-files");
});

test("落点：两张卡的文件集合完全相同时无解，只能报冲突", () => {
  const scan = [{ relativePath: "/A/one.mkv", name: "one.mkv", mediaId: "1" }];
  const sidecar = sidecarOf("d", { schemaVersion: 1, basePath: "/A", members: [{ path: "one.mkv" }] });
  const placements = classifyPlacements(reconcileCollections([sidecar], scan).shapes, [
    { itemKey: "/A", paths: ["/A/one.mkv"], confirmedBy: null },
    { itemKey: "#split/cat1", paths: ["/A/one.mkv"], confirmedBy: null },
  ]);
  assert.deepEqual(placements.map((placement) => [placement.kind, (placement as { reason?: string }).reason]), [["conflict", "duplicate-cards"]]);
});

test("磁盘往返：一份时是点文件，同目录多份时带 collectionId 前缀", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wpcoll-"));
  try {
    const single = sidecarOf("s1", { schemaVersion: 1, libraryId: "lib_anime", basePath: "/作品名", members: [{ path: "a.mkv" }] });
    const written = writeCollectionRoot(root, "lib_anime", [single]);
    assert.deepEqual(written, ["作品名/.watchparty.collection.json"]);
    const pair = [
      sidecarOf("p1", { schemaVersion: 1, collectionId: "ova", basePath: "/两部", members: [{ path: "a.mkv" }] }),
      sidecarOf("p2", { schemaVersion: 1, collectionId: "sp", basePath: "/两部", members: [{ path: "b.mkv" }] }),
    ];
    assert.deepEqual(writeCollectionRoot(root, "lib_anime", pair), ["两部/ova-1.watchparty.collection.json", "两部/sp-2.watchparty.collection.json"]);
    const readBack = readCollectionRoot(root, "lib_anime");
    assert.equal(readBack.files, 3);
    assert.deepEqual(readBack.errors, []);
    assert.deepEqual(
      readBack.collections.map((entry) => entry.collectionId).sort(),
      ["作品名", "ova", "sp"].sort(),
    );
    // 只扫本库目录：另一个库的 sidecar 不会串味。
    assert.equal(readCollectionRoot(root, "lib_tv").files, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("磁盘路径清洗：越界段和非法字符不会写到 sidecar 根外面", () => {
  assert.deepEqual(safeSegments("/../../Windows/system32"), ["Windows", "system32"]);
  assert.deepEqual(safeSegments("a\\b:c*d?.txt"), ["a b c d .txt"]);
  assert.deepEqual(safeSegments("/"), []);
  // 读入侧：basePath 指到库外是错误，不是"悄悄挪到根目录"。
  const escaped = parseCollection("e", JSON.stringify({ schemaVersion: 1, basePath: "/../../Abs/C", members: [{ path: "x.mkv" }] }));
  assert.deepEqual(escaped.errors.map((error) => error.code), ["base-path-unsafe"]);
  assert.equal(escaped.sidecar!.basePath, "/");
  // 写出侧：库里存了脏 itemKey 时也只能落在根目录内。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wpcoll-"));
  try {
    const dirty = { ...sidecarOf("d", { schemaVersion: 1, basePath: "/Abs/C", members: [{ path: "x.mkv" }] }) };
    const target = collectionDiskPath(root, "lib/../evil", { ...dirty, basePath: "/../../Windows/A/C" }, ".watchparty.collection.json");
    const relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `逃出了根目录：${relative}`);
    assert.deepEqual(relative.split(path.sep), ["lib", "evil", "Windows", "A", "C", ".watchparty.collection.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
