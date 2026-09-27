import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { episodeSubtitle, groupScanFiles, type CatalogGroup } from "../media/catalog-names.ts";
import { openCatalogStore } from "../media/catalog-store.ts";
import { WATCHPARTY_ROOTS } from "../media/watchparty-media.ts";
import type { OpenlistClient } from "../media/openlist.ts";

/**
 * The card list is derived from folder paths, but a path is only a coincidence:
 * one folder can hold three films and one film can sit in four folders. Once a
 * person corrects that, the correction has to survive the next scan - which is
 * what these tests pin (identity by file set), alongside the snapshot that lets
 * grouping be re-run offline instead of by re-scraping the network.
 */

/** `dirs` says where the files really sit, which can differ from the card's key after a roll-up. */
function group(itemKey: string, query: string, mediaIds: string[], dirs?: Record<string, string>): CatalogGroup {
  return {
    itemKey,
    query,
    queries: [query],
    rawName: itemKey.split("/").filter(Boolean).pop() ?? itemKey,
    files: mediaIds.map((mediaId) => {
      const dir = dirs?.[mediaId] ?? itemKey;
      return { mediaId, name: `${mediaId}.mkv`, season: null, episode: null, relativePath: `${dir}/${mediaId}.mkv` };
    }),
  };
}

function openStore() {
  const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-edit-posters-"));
  const store = openCatalogStore(":memory:", posterDir);
  return { store, posterDir };
}

test("the scan snapshot keeps the enumeration so grouping can be re-run offline", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/Show", "Show", ["m1", "m2"])]);
    const files = [
      { relativePath: "/Show/Show - 01.mkv", name: "Show - 01.mkv", mediaId: "m1" },
      { relativePath: "/Show/Show - 02.mkv", name: "Show - 02.mkv", mediaId: "m2" },
      { relativePath: "/Loose.mkv", name: "Loose.mkv", mediaId: "m3" },
    ];
    assert.equal(store.writeScan("lib_anime", files), 3);
    assert.deepEqual(store.readScan("lib_anime").map((file) => file.relativePath), ["/Loose.mkv", "/Show/Show - 01.mkv", "/Show/Show - 02.mkv"]);
    // A re-enumeration replaces the whole list rather than appending to it.
    store.writeScan("lib_anime", files.slice(0, 1));
    assert.equal(store.scanInfo("lib_anime").files, 1);
    assert.match(store.scanInfo("lib_anime").enumeratedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.scanInfo("lib_tv").enumeratedAt, null);
  } finally {
    store.close();
  }
});

test("unconfirm puts a card back into the pipeline, keeping its files", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/Show", "Show", ["m1", "m2"])]);
    const [pending] = store.listPending("lib_anime");
    assert.ok(pending);
    store.applyMatch(pending, "confirmed", { externalDb: "bangumi", externalId: "1", title: "確認済み", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 1 }, []);
    const confirmed = store.getDetail(pending.id);
    assert.equal(confirmed?.status, "confirmed");
    assert.equal(confirmed?.title, "確認済み");

    const back = store.unconfirm(pending.id);
    assert.equal(back?.status, "unmatched");
    assert.equal(back?.externalId ?? null, null);
    assert.equal(back?.title, "Show", "the parsed name comes back, not the vendor title");
    assert.equal(back?.children.length, 2, "unconfirming must not lose the files");
    assert.equal(store.listPending("lib_anime").length, 1, "it is queued for lookup again");
  } finally {
    store.close();
  }
});

test("rebind accepts a hand-picked subject that the scrape never proposed", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/机动战士高达0079剧场版三部曲合集", "机动战士高达0079剧场版三部曲合集", ["m1", "m2", "m3"])]);
    const [pending] = store.listPending("lib_anime");
    assert.ok(pending);
    store.applyMatch(pending, "candidate", null, []);
    const saved = store.rebind(pending.id, { externalDb: "bangumi", externalId: "26851", title: "机动战士高达 剧场版Ⅰ", year: 1981, overview: null, imageUrl: null });
    assert.deepEqual(saved, { imageUrl: null });
    const detail = store.getDetail(pending.id);
    assert.equal(detail?.status, "confirmed");
    assert.equal(detail?.title, "机动战士高达 剧场版Ⅰ");
    assert.equal(store.listPending("lib_anime").length, 0, "a hand-bound card is done");
  } finally {
    store.close();
  }
});

test("merge moves files onto the kept card and carries the confirmation with them", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/Uha/SPs", "Oddtaxi SPs", ["s1", "s2"]), group("/Uha", "ODDTAXI", ["o1", "o2"])]);
    // 合并后这张卡有 4 个文件，但其中两个来自 SPs 目录 ⇒ 集数仍是 2
    const [showCard, spCard] = store.listPending("lib_anime"); // listPending 按 item_key 升序：/Uha 在前
    assert.ok(spCard && showCard);
    // The confirmed card is the one being swallowed, so the binding must travel.
    store.applyMatch(spCard, "confirmed", { externalDb: "bangumi", externalId: "268510", title: "奇巧计程车", originalTitle: null, year: 2021, overview: null, imageUrl: null, episodes: null, score: 1 }, []);
    store.applyMatch(showCard, "candidate", null, []);
    const merged = store.mergeItems(showCard.id, [spCard.id]);
    assert.equal(merged?.status, "confirmed", "merging into an unconfirmed card must not drop the confirmation");
    assert.equal(merged?.title, "奇巧计程车");
    assert.deepEqual(merged?.children.map((child) => child.mediaId).sort(), ["o1", "o2", "s1", "s2"]);
    assert.equal(merged?.subtitle, "2 集", "the SPs files stay playable from the card but are not episodes");
    assert.equal(store.getDetail(spCard.id), undefined, "the swallowed card is gone, not left as a husk");
  } finally {
    store.close();
  }
});

test("split hands each group its own card and only the new ones wait for lookup", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_film", "movie", [
      {
        itemKey: "/Gundam0079",
        query: "机动战士高达0079剧场版三部曲合集",
        queries: ["机动战士高达0079剧场版三部曲合集"],
        rawName: "Gundam0079",
        files: ["I", "II", "III"].map((part) => ({ mediaId: `m${part}`, name: `Mobile Suit Gundam The Movie ${part}.mkv`, season: null, episode: null })),
      },
    ]);
    const [trilogy] = store.listPending("lib_film");
    assert.ok(trilogy);
    store.applyMatch(trilogy, "candidate", null, []);
    const parts = store.splitItem(trilogy.id, [["mI"], ["mII", "mIII"]]);
    assert.equal(parts?.length, 2);
    const [kept, ...created] = parts ?? [];
    assert.equal(kept?.id, trilogy.id);
    assert.equal(kept?.children.map((child) => child.mediaId).join(), "mI");
    assert.equal(created[0]?.children.length, 2);
    assert.match(created[0]?.title ?? "", /Mobile Suit Gundam/, "each new card gets a guess from its own file names");
    assert.equal(created.every((card) => card.status === "unmatched"), true);
    assert.equal(store.listPending("lib_film").length, 1, "only the new card waits for lookup");
  } finally {
    store.close();
  }
});

test("a scan finds a corrected card by its files, not by the folder it came from", () => {
  const { store } = openStore();
  try {
    const inSeason = (mediaId: string, season: number) => ({ [mediaId]: `/Clarks/Season ${season}` });
    store.upsertScan("lib_tv", "tv", [
      group("/Clarks/Season 3", "荒原", ["c1", "c2"]),
      group("/Clarks/Season 1", "Clarks Farm S1", ["c3", "c4"]),
    ]);
    const cards = store.listPending("lib_tv");
    const merged = store.mergeItems(cards[1].id, [cards[0].id]);
    assert.equal(merged?.children.length, 4);

    // Next scan: the grouper produces its own keys again. The merged card must be
    // recognised by its file set instead of being deleted and re-created as two.
    // 下一次扫描把四季归并到作品目录：分组键变了，文件路径没变
    store.upsertScan("lib_tv", "tv", [group("/Clarks", "克拉克森的农场", ["c1", "c2", "c3", "c4"], { c1: "/Clarks/Season 3", c2: "/Clarks/Season 3", c3: "/Clarks/Season 1", c4: "/Clarks/Season 1" })]);
    const after = store.listCards("lib_tv", undefined, undefined).items;
    assert.equal(after.length, 1, "one card, not three");
    assert.equal(after[0]?.id, merged?.id, "same card identity: the human's work survived");
    assert.equal(after[0]?.title, "克拉克森的农场");
  } finally {
    store.close();
  }
});

function fakeTree(): OpenlistClient {
  const entries = (dir: string, names: Array<[string, boolean]>) => ({
    code: 200,
    data: { content: names.map(([name, isDir]) => ({ name, is_dir: isDir, size: 10, path: `${dir}/${name}` })) },
  });
  return {
    async list(dir) {
      const root = WATCHPARTY_ROOTS.Anime;
      if (dir === root) return entries(root, [["Medalist", true]]);
      if (dir === `${root}/Medalist`)
        return entries(`${root}/Medalist`, [
          ["[VCB-Studio] Medalist [01][Ma10p_1080p].mkv", false],
          ["[VCB-Studio] Medalist [02][Ma10p_1080p].mkv", false],
        ]);
      return { code: 200, data: { content: [] } };
    },
    async listShallow() {
      return { code: 200, data: { content: [] } };
    },
    async search() {
      return { code: 200, data: { content: [] } };
    },
    async getDownloadInfo() {
      throw new Error("scrape must not resolve download links");
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

async function started(options: Parameters<typeof createBackend>[0]): Promise<Backend> {
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "secret-value" }),
    catalogInline: true,
    catalogDelayMs: 0,
    libraryClientFactory: () => fakeTree(),
    bangumi: {
      async search(query) {
        return [
          {
            externalDb: "bangumi" as const,
            externalId: "430699",
            title: query,
            originalTitle: null,
            year: 2025,
            overview: null,
            imageUrl: null,
            episodes: 2,
          },
        ];
      },
    },
    tmdb: { async search() { return []; } },
    fetchPoster: async () => undefined,
    ...options,
  });
  await backend.start();
  return backend;
}

const base = (backend: Backend) => `http://127.0.0.1:${backend.port}`;
const json = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) });

test("the editing endpoints answer, and the snapshot reports what enumeration stored", async () => {
  const backend = await started({});
  try {
    const scrape = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/scrape`, { method: "POST" }));
    assert.equal(scrape.status, 200);
    const cards = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    const cardId = (cards.body as { items: Array<{ id: string; status: string }> }).items[0].id;

    const scan = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/scan`));
    assert.equal(scan.status, 200);
    assert.equal((scan.body as { files: number }).files, 2, "both files of the tree are snapshotted");
    assert.ok((scan.body as { enumeratedAt: string | null }).enumeratedAt);

    const searched = await json(await fetch(`${base(backend)}/api/media/bangumi/search?q=Medalist`));
    assert.equal(searched.status, 200);
    assert.equal((searched.body as { items: Array<{ title: string }> }).items[0]?.title, "Medalist");

    const rebound = await json(
      await fetch(`${base(backend)}/api/media/catalog/${cardId}/rebind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalDb: "bangumi", externalId: "500001", title: "金牌得主" }),
      }),
    );
    assert.equal(rebound.status, 200);
    assert.equal((rebound.body as { title: string; status: string }).title, "金牌得主");
    assert.equal((rebound.body as { status: string }).status, "confirmed");

    const unconfirmed = await json(await fetch(`${base(backend)}/api/media/catalog/${cardId}/unconfirm`, { method: "POST" }));
    assert.equal(unconfirmed.status, 200);
    assert.equal((unconfirmed.body as { status: string }).status, "unmatched");
    assert.equal((unconfirmed.body as { externalId?: string }).externalId ?? null, null);

    const detail = await json(await fetch(`${base(backend)}/api/media/catalog/${cardId}`));
    const mediaIds = (detail.body as { children: Array<{ mediaId: string }> }).children.map((child) => child.mediaId);
    const split = await json(
      await fetch(`${base(backend)}/api/media/catalog/${cardId}/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: [[mediaIds[0]], [mediaIds[1]]] }),
      }),
    );
    assert.equal(split.status, 200);
    assert.equal((split.body as unknown[]).length, 2);
    const mergedBack = await json(
      await fetch(`${base(backend)}/api/media/catalog/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: cardId, dropIds: [(split.body as Array<{ id: string }>)[1].id] }),
      }),
    );
    assert.equal(mergedBack.status, 200);
    assert.equal((mergedBack.body as { children: unknown[] }).children.length, 2, "merge restores the original file set");
  } finally {
    await backend.close();
  }
});

test("the editing endpoints refuse malformed input without touching the card", async () => {
  const backend = await started({});
  try {
    const scrape = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/scrape`, { method: "POST" }));
    assert.equal(scrape.status, 200);
    const cards = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    const card = (cards.body as { items: Array<{ id: string; title: string }> }).items[0];

    const badId = await json(
      await fetch(`${base(backend)}/api/media/catalog/${card.id}/rebind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalDb: "bangumi", externalId: "../../etc/passwd", title: "x" }),
      }),
    );
    assert.equal(badId.status, 400);

    const badVendor = await json(
      await fetch(`${base(backend)}/api/media/catalog/${card.id}/rebind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalDb: "douban", externalId: "1", title: "x" }),
      }),
    );
    assert.equal(badVendor.status, 400);

    const shortQuery = await json(await fetch(`${base(backend)}/api/media/bangumi/search?q=a`));
    assert.equal(shortQuery.status, 400);

    const emptyMerge = await json(
      await fetch(`${base(backend)}/api/media/catalog/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: card.id, dropIds: [] }),
      }),
    );
    assert.equal(emptyMerge.status, 400);

    const badSplit = await json(
      await fetch(`${base(backend)}/api/media/catalog/${card.id}/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: [["v2.1"]] }),
      }),
    );
    assert.equal(badSplit.status, 400);

    const after = await json(await fetch(`${base(backend)}/api/media/catalog/${card.id}`));
    assert.equal((after.body as { title: string }).title, card.title, "rejected writes must leave the card alone");
  } finally {
    await backend.close();
  }
});

test("a re-scan never rewrites a confirmed binding, even when its file set grows", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [
      {
        itemKey: "/Show",
        query: "Show",
        queries: ["Show"],
        rawName: "Show",
        files: [{ mediaId: "e1", name: "Show - 01.mkv", season: null, episode: 1, relativePath: "/Show/Show - 01.mkv" }],
      },
      {
        itemKey: "/Show/SPs",
        query: "Show SPs",
        queries: ["Show SPs"],
        rawName: "SPs",
        files: [{ mediaId: "s1", name: "Show [SP01].mkv", season: null, episode: null, relativePath: "/Show/SPs/Show [SP01].mkv" }],
      },
    ]);
    const cards = store.listPending("lib_anime");
    const show = cards.find((card) => card.itemKey === "/Show");
    const sps = cards.find((card) => card.itemKey === "/Show/SPs");
    assert.ok(show && sps);
    store.applyMatch(show, "confirmed", { externalDb: "bangumi", externalId: "411187", title: "电台节目", originalTitle: null, year: 2021, overview: null, imageUrl: null, episodes: null, score: 1 }, []);

    // Second scan with a different grouper: /Show now swallows the SPs folder, and
    // /Show/SPs is gone. The confirmation must survive untouched.
    store.upsertScan("lib_anime", "tv", [
      {
        itemKey: "/Show",
        query: "ODDTAXI",
        queries: ["ODDTAXI"],
        rawName: "Show",
        files: [
          { mediaId: "e1", name: "Show - 01.mkv", season: null, episode: 1, relativePath: "/Show/Show - 01.mkv" },
          { mediaId: "s1", name: "Show [SP01].mkv", season: null, episode: null, relativePath: "/Show/SPs/Show [SP01].mkv" },
        ],
      },
    ]);
    const after = store.getDetail(show.id);
    assert.equal(after?.status, "confirmed", "a scan must not demote a human answer");
    assert.equal(after?.externalId, "411187", "nor re-point it at another subject");
    assert.equal(after?.title, "电台节目");
    assert.equal(after?.children.length, 2, "the files still merge onto the card");
    assert.equal(store.getDetail(sps.id), undefined, "the swallowed card is cleaned up");
    assert.deepEqual(store.listPending("lib_anime"), [], "and nothing re-enters the queue");
  } finally {
    store.close();
  }
});

test("confirmed_by records who decided, and only the machine's own answers are re-clusterable", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/A", "Show A", ["a1"]), group("/B", "Show B", ["b1"])]);
    const cards = store.listPending("lib_anime");
    const hit = (id: string) => ({ externalDb: "bangumi" as const, externalId: id, title: "X", originalTitle: null, year: null, overview: null, imageUrl: null, episodes: null, score: 1 });
    store.applyMatch(cards[0], "confirmed", hit("777"), []);
    assert.equal(store.getDetail(cards[0].id)?.confirmedBy, "auto");
    store.applyMatch(cards[1], "candidate", null, [hit("777")]);
    store.confirm(cards[1].id, store.getDetail(cards[1].id)!.candidates[0].id);
    assert.equal(store.getDetail(cards[1].id)?.confirmedBy, "manual");
    store.rebind(cards[1].id, { externalDb: "bangumi", externalId: "777", title: "X" });
    assert.equal(store.getDetail(cards[1].id)?.confirmedBy, "rebind");
    store.unconfirm(cards[1].id);
    assert.equal(store.getDetail(cards[1].id)?.confirmedBy, null);
  } finally {
    store.close();
  }
});

test("two cards the scrape confirmed onto one subject become one card again", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_tv", "tv", [group("/Zeta", "泽塔奥特曼", ["t1", "t2", "t3"]), group("/Zeta/SPs", "泽塔奥特曼 访谈", ["i1", "i2"])]);
    const cards = store.listPending("lib_tv");
    const hit = (title: string) => ({ externalDb: "tmdb" as const, externalId: "101005", title, originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 1 });
    store.applyMatch(cards[0], "confirmed", hit("泽塔奥特曼"), []);
    store.applyMatch(cards[1], "confirmed", hit("泽塔奥特曼"), []);
    assert.equal(store.reclusterBySubject("lib_tv").merged, 1);
    const kept = store.getDetail(cards[0].id);
    assert.equal(kept?.children.length, 5, "the fullest card survives and holds every file");
    assert.equal(kept?.subtitle, "3 集", "bonus folders merged in still do not count as episodes");
    assert.equal(kept?.confirmedBy, "auto");
    assert.equal(store.getDetail(cards[1].id), undefined);
    assert.deepEqual(store.listPending("lib_tv"), []);
  } finally {
    store.close();
  }
});

test("a group containing one human decision is left exactly as it was", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_tv", "tv", [group("/Zeta", "泽塔奥特曼", ["t1"]), group("/Zeta/人物访谈", "访谈", ["i1"]), group("/Zeta/广播剧", "广播剧", ["r1"])]);
    const cards = store.listPending("lib_tv");
    const hit = { externalDb: "tmdb" as const, externalId: "101005", title: "泽塔奥特曼", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 1 };
    for (const card of cards) store.applyMatch(card, "confirmed", hit, [hit]);
    // The user picks the radio card by hand: that answer is now protected.
    store.confirm(cards[2].id, store.getDetail(cards[2].id)!.candidates[0].id);
    const result = store.reclusterBySubject("lib_tv");
    assert.equal(result.merged, 0);
    assert.equal(result.protectedGroups, 1);
    for (const card of cards) assert.ok(store.getDetail(card.id), `card ${card.itemKey} must still exist`);
  } finally {
    store.close();
  }
});

test("children say which subfolder they came from, so seasons survive in one card", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_tv", "tv", [
      {
        itemKey: "/Clarksons Farm",
        query: "克拉克森的农场",
        queries: ["克拉克森的农场"],
        rawName: "Clarksons Farm",
        files: [
          { mediaId: "s1", name: "S01E01 拖拉机.mp4", season: 1, episode: 1, relativePath: "/Clarksons Farm/第一季 包含字幕和弹幕文件/S01E01 拖拉机.mp4" },
          { mediaId: "s3", name: "S03E01 荒原.mp4", season: 3, episode: 1, relativePath: "/Clarksons Farm/第三季 包含字幕和弹幕文件/S03E01 荒原.mp4" },
        ],
      },
    ]);
    const detail = store.getDetail(store.listPending("lib_tv")[0].id)!;
    assert.equal(detail.children[0]?.relDir, "/Clarksons Farm/第一季 包含字幕和弹幕文件");
    assert.notEqual(detail.children[0]?.relDir, detail.children[1]?.relDir, "the two seasons stay tellable apart without guessing episode numbers");
  } finally {
    store.close();
  }
});

test("folding a bonus subfolder respects who confirmed what", () => {
  const tree = [
    { relativePath: "/Box/t1.mkv", name: "[DBD-Raws][泽塔奥特曼][01][1080P][BDRip].mkv", mediaId: "t1" },
    { relativePath: "/Box/t2.mkv", name: "[DBD-Raws][泽塔奥特曼][02][1080P][BDRip].mkv", mediaId: "t2" },
    { relativePath: "/Box/人物访谈/i1.mkv", name: "[DBD-Raws][泽塔奥特曼][人物访谈][01][1080P][BDRip].mkv", mediaId: "i1" },
  ];
  const folded = groupScanFiles(tree);
  assert.equal(folded.length, 1, "访谈那段属于同一个 release，折进作品卡");
  assert.equal(episodeSubtitle(folded[0].files, folded[0].itemKey), "2 集");

  const kept = groupScanFiles(tree, new Set(["/Box/人物访谈"]));
  assert.equal(kept.length, 2, "人确认过的目录不折：既不删他的卡，也不让同一个文件出现在两张卡上");
  const ids = kept.map((group) => group.files.map((file) => file.mediaId).sort().join("+")).sort();
  assert.deepEqual(ids, ["i1", "t1+t2"]);
});

test("an auto-confirmed card whose folder disappeared is dropped; a human one is kept", () => {
  const run = (as: "auto" | "manual") => {
    const { store } = openStore();
    try {
      store.upsertScan("lib_tv", "tv", [group("/Box", "泽塔奥特曼", ["t1", "t2"]), group("/Box/人物访谈", "泽塔奥特曼 访谈", ["i1"])]);
      const child = store.listPending("lib_tv").find((card) => card.itemKey === "/Box/人物访谈")!;
      const chosen = { externalDb: "tmdb" as const, externalId: "101005", title: "泽塔奥特曼", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 1 };
      store.applyMatch(child, "confirmed", chosen, [chosen]);
      if (as === "manual") store.confirm(child.id, store.getDetail(child.id)!.candidates[0].id);
      assert.deepEqual([...store.protectedKeys("lib_tv")], as === "manual" ? ["/Box/人物访谈"] : []);

      store.upsertScan("lib_tv", "tv", [group("/Box", "泽塔奥特曼", ["t1", "t2", "i1"])]);
      const cards = store.listCards("lib_tv", undefined, undefined).items;
      assert.equal(cards.length, as === "auto" ? 1 : 2, "机器的孤儿行删掉，人工的行留着");
      assert.equal(store.getDetail(child.id) !== undefined, as === "manual");
    } finally {
      store.close();
    }
  };
  run("auto");
  run("manual");
});


test("merging never launders a human answer into an automatable one", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_tv", "tv", [group("/Clarks/S1", "克拉克森 S1", ["a1", "a2"]), group("/Clarks/S2", "克拉克森 S2", ["b1"])]);
    const [bigger, smaller] = store.listPending("lib_tv");
    const chosen = { externalDb: "tmdb" as const, externalId: "117648", title: "克拉克森的农场", originalTitle: null, year: 2021, overview: null, imageUrl: null, episodes: null, score: 1 };
    store.applyMatch(bigger, "confirmed", chosen, [chosen]); // 机器挑的（文件多，当载体）
    store.applyMatch(smaller, "confirmed", chosen, [chosen]);
    store.confirm(smaller.id, store.getDetail(smaller.id)!.candidates[0].id); // 这张是人点的

    const merged = store.mergeItems(bigger.id, [smaller.id]);
    assert.equal(merged?.confirmedBy, "manual", "载体是 auto、被并的是人工 ⇒ 结果必须仍是人工");
    assert.deepEqual(store.listPending("lib_tv"), []);
  } finally {
    store.close();
  }
});
