import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { episodeSubtitle, groupScanFiles, type CatalogGroup } from "../media/catalog-names.ts";
import { diffSnapshots, openCatalogStore, structuralChanges, structuralCount } from "../media/catalog-store.ts";
import { MetadataUnavailable } from "../media/catalog-metadata.ts";
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
function group(itemKey: string, query: string, mediaIds: string[], dirs?: Record<string, string>, episodes?: Record<string, number>): CatalogGroup {
  return {
    itemKey,
    query,
    queries: [query],
    rawName: itemKey.split("/").filter(Boolean).pop() ?? itemKey,
    files: mediaIds.map((mediaId) => {
      const dir = dirs?.[mediaId] ?? itemKey;
      return { mediaId, name: `${mediaId}.mkv`, season: null, episode: episodes?.[mediaId] ?? null, relativePath: `${dir}/${mediaId}.mkv` };
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

test("枚举超过宽限期回 202 并让调用方轮询；跑完的照旧 200 + 完整结果", async () => {
  const boot = async (graceMs: number, delayMs: number, fail = false) =>
    started({
      syncGraceMs: graceMs,
      libraryClientFactory: () => {
        const client = fakeTree();
        return {
          ...client,
          list: async (dir: string) => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (fail) throw new Error("OPENLIST 挂了");
            return client.list(dir);
          },
        };
      },
    });
  const pollScan = async (url: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const body = (await json(await fetch(url))).body as { running: boolean; rev: number };
      if (!body.running) return body;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("轮询 1.8s 还在 running");
  };

  // 热态：宽限期内跑完 ⇒ 状态码与字段都和改异步之前一样
  const fast = await boot(5_000, 0);
  try {
    const done = await json(await fetch(`${base(fast)}/api/admin/media-libraries/lib_anime/scan`, { method: "POST" }));
    assert.equal(done.status, 200, "跑完了就该是 200，老调用方不用改");
    assert.equal((done.body as { status: string }).status, "done");
    assert.equal((done.body as { running: boolean }).running, false);
    assert.equal((done.body as { files: number }).files, 2);
    assert.equal((done.body as { rev: number }).rev, 1);
  } finally {
    await fast.close();
  }

  // 冷态：超过宽限期 ⇒ 202 + 轮询，服务端继续跑完
  const cold = await boot(60, 250);
  const scanUrl = `${base(cold)}/api/admin/media-libraries/lib_anime/scan`;
  try {
    const accepted = await json(await fetch(scanUrl, { method: "POST" }));
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { status: "accepted", libraryId: "lib_anime", running: true });
    const mid = (await json(await fetch(scanUrl))).body as { running: boolean; rev: number };
    assert.equal(mid.running, true, "还在枚举时 GET 要报 running:true");
    assert.equal(mid.rev, 0, "没落地前 rev 不动 —— 这就是界面判断\"还没好\"的依据");
    const landed = await pollScan(scanUrl);
    assert.equal(landed.running, false);
    assert.equal(landed.rev, 1, "后台跑完了，轮询看得到");
  } finally {
    await cold.close();
  }

  // 后台失败：不能变成 unhandled rejection（那会带走进程），也只能靠"rev 不前进"看出来
  const broken = await boot(60, 250, true);
  const brokenUrl = `${base(broken)}/api/admin/media-libraries/lib_anime/scan`;
  try {
    const accepted = await json(await fetch(brokenUrl, { method: "POST" }));
    assert.equal(accepted.status, 202);
    const settled = await pollScan(brokenUrl);
    assert.equal(settled.running, false, "失败也要收摊，不能让 running 永远挂着");
    assert.equal(settled.rev, 0, "没写进快照 ⇒ 调用方据此知道这次没成");
  } finally {
    await broken.close();
  }
});

test("并发 scan 并入同一次枚举；GET 报 running，库不存在是 404 不是空库", async () => {
  let listings = 0;
  const backend = await started({
    libraryClientFactory: () => {
      const client = fakeTree();
      return {
        ...client,
        list: async (dir: string) => {
          listings += 1;
          await new Promise((resolve) => setTimeout(resolve, 60)); // 拖住第一条，保证第二条真的撞进在跑的那次
          return client.list(dir);
        },
      };
    },
  });
  try {
    const scanUrl = `${base(backend)}/api/admin/media-libraries/lib_anime/scan`;
    const firstPost = fetch(scanUrl, { method: "POST" });
    const secondPost = fetch(scanUrl, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mid = await json(await fetch(scanUrl));
    const [first, second] = await Promise.all([firstPost, secondPost]);
    const a = await json(first);
    const b = await json(second);
    const after = await json(await fetch(scanUrl));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(listings, 2, "根目录 + 作品目录各一次；两条并发请求不该把它变成 4 次");
    assert.deepEqual(b.body, a.body, "两条拿到同一份快照结果（rev 只 +1，不是各写一次）");
    assert.equal((mid.body as { running: boolean }).running, true, "枚举在跑的时候 GET 要报 running:true");
    assert.equal((after.body as { running: boolean }).running, false, "落地之后回到 false");
    const missing = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_gone/scan`));
    assert.equal(missing.status, 404, "库不存在要 404 —— 回 200 加一串 0 会让人以为库是空的");
  } finally {
    await backend.close();
  }
});

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

/**
 * 分类层：把「枚举 + 分组」的结果当成数据存下来，正式表一行都不动。
 * 身份仍按文件集合认，所以差异报告里"换目录"是 moved，不是删一张再加一张。
 */
const snapshotThree = [
  { relativePath: "/Show/m1.mkv", name: "m1.mkv", mediaId: "m1" },
  { relativePath: "/Show/m2.mkv", name: "m2.mkv", mediaId: "m2" },
  { relativePath: "/Other/m3.mkv", name: "m3.mkv", mediaId: "m3" },
];

test("分类只落草稿：正式卡一张都不生成，重跑是整批替换", () => {
  const { store } = openStore();
  try {
    store.writeScan("lib_anime", snapshotThree);
    const groups = [group("/Show", "Show", ["m1", "m2"]), group("/Other", "Other", ["m3"])];
    assert.equal(store.writeDraft("lib_anime", groups), 2);
    assert.deepEqual(store.listCards("lib_anime", undefined, undefined).items, [], "正式表必须还是空的");
    assert.equal(store.getJob("lib_anime"), undefined, "也不碰刮削作业行");
    assert.equal(store.scanInfo("lib_anime").files, 3, "快照不被分类改写");

    const [other, show] = store.readDraft("lib_anime");
    assert.equal(show.subtitle, "2 集", "集数在分类时就定下来，与正式卡同一口径");
    assert.equal(other.subtitle, null, "单文件不写 0 集也不写 1 集");
    assert.deepEqual(show.children.map((file) => file.mediaId), ["m1", "m2"]);
    assert.equal(show.title, "Show", "没判定过之前草稿标题就是查询词");
    assert.equal(show.lookupState, "pending");
    assert.deepEqual(store.draftInfo("lib_anime"), { cards: 2, files: 3, classifiedAt: store.draftInfo("lib_anime").classifiedAt, rev: 1, pending: 2 });

    // 修订号：每次枚举 +1，草稿记住自己来自哪一版，应用时才能拒掉过期结果。
    store.writeScan("lib_anime", snapshotThree.slice(0, 2));
    assert.equal(store.scanInfo("lib_anime").rev, 2);
    assert.equal(store.draftInfo("lib_anime").rev, 1, "旧草稿仍标着旧修订");
    store.writeDraft("lib_anime", [group("/Show", "Show", ["m1", "m2"])]);
    assert.deepEqual(store.draftInfo("lib_anime"), { cards: 1, files: 2, classifiedAt: store.draftInfo("lib_anime").classifiedAt, rev: 2, pending: 1 }, "整批替换而不是追加");
  } finally {
    store.close();
  }
});

test("草稿差异按文件集合认身份：换 key 是 moved", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "anime", [group("/Old", "Show", ["m1", "m2"])]);
    store.writeDraft("lib_anime", [group("/New", "Show", ["m1", "m2"], { m1: "/Old", m2: "/Old" })]);
    const diff = store.draftDiff("lib_anime");
    assert.equal(diff.moved.length, 1, "同文件集合、不同 key ⇒ 认成同一张卡");
    assert.equal(diff.moved[0].fromKey, "/Old");
    assert.equal(diff.moved[0].itemKey, "/New");
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.dropped, []);
    assert.equal(diff.unchanged, 0);
    assert.equal(diff.changed.length, 1, "顺带报出文案差异");
    assert.deepEqual(diff.changed[0].from, { title: "Show", subtitle: "2 集" });
  } finally {
    store.close();
  }
});

test("集号覆盖变了不再报一致：进 changed / 漂移，但不算结构变更（不触批准门）", () => {
  const { store } = openStore();
  try {
    // 卡上的孩子行带着集号，重算后的草稿丢了集号：文件集合、标题、集数行全一样。
    // 以前这种"卡片静默落后"在 diff 里是"一致"，谁也不会去跑那次 apply。
    store.upsertScan("lib_anime", "anime", [
      group("/Show", "Show", ["s1", "s2"], undefined, { s1: 1, s2: 2 }),
      group("/Human", "人挑的", ["h1", "h2"], undefined, { h1: 3, h2: 4 }),
    ]);
    const human = store.listPending("lib_anime").find((item) => item.itemKey === "/Human");
    assert.ok(human);
    store.rebind(human.id, { externalDb: "bangumi", externalId: "9", title: "人挑的", originalTitle: null, year: null });
    store.writeDraft("lib_anime", [group("/Show", "Show", ["s1", "s2"]), group("/Human", "人挑的", ["h1", "h2"])]);

    const diff = store.draftDiff("lib_anime");
    assert.equal(diff.unchanged, 0, "只有集号覆盖变了，也不许报一致");
    const shown = diff.changed.find((row) => row.itemKey === "/Show");
    assert.deepEqual(shown?.episodes, { from: 2, to: 0 });
    assert.equal(shown?.from.subtitle, shown?.to.subtitle, "差异只该来自集号，不是文案");
    assert.equal(shown?.from.title ?? shown?.to.title, "Show", "也不是标题");
    assert.deepEqual(diff.confirmedDrift.find((row) => row.itemKey === "/Human")?.episodes, { from: 2, to: 0 }, "人已确认的卡走漂移桶");

    const structural = structuralChanges(diff);
    assert.equal(structuralCount(structural), 0, "集号变化不是结构变更，不该逼人多批一次");
    assert.deepEqual(structural.drift, [], "文件数没动的漂移行不进批准清单");
  } finally {
    store.close();
  }
});

test("草稿差异分桶：新增、消失、改名、人工漂移各归各的", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "anime", [
      group("/Kept", "Kept", ["k1", "k2"]),
      group("/Renamed", "旧的猜测", ["r1"]),
      group("/Vanishing", "Vanishing", ["v1"]),
      group("/Human", "人挑的", ["h1", "h2"]),
    ]);
    const human = store.listPending("lib_anime").find((item) => item.itemKey === "/Human");
    assert.ok(human);
    store.rebind(human.id, { externalDb: "bangumi", externalId: "1", title: "人挑的", originalTitle: null, year: null });

    store.writeDraft("lib_anime", [
      group("/Kept", "Kept", ["k1", "k2"]),
      group("/Renamed", "新的猜测", ["r1"]),
      group("/Brand", "Brand", ["b1"]),
      group("/Human", "机器想改的名", ["h1"]),
    ]);
    const diff = store.draftDiff("lib_anime");
    assert.deepEqual(diff.added, [{ itemKey: "/Brand", query: "Brand", files: 1, splitFromKey: null, fromFiles: 0 }]);
    assert.equal(diff.dropped.length, 1);
    assert.equal(diff.dropped[0].itemKey, "/Vanishing");
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].itemKey, "/Renamed");
    assert.deepEqual(diff.changed[0].from, { title: "旧的猜测", subtitle: null });
    assert.deepEqual(diff.changed[0].to, { title: "新的猜测", subtitle: null });
    assert.equal(diff.confirmedDrift.length, 1, "人已确认的那张不进可改名桶");
    assert.deepEqual(
      { itemKey: diff.confirmedDrift[0].itemKey, subtitle: diff.confirmedDrift[0].subtitle, files: diff.confirmedDrift[0].files },
      { itemKey: "/Human", subtitle: { from: "2 集", to: null }, files: { from: 2, to: 1 } },
    );
    assert.equal(diff.unchanged, 1);
    assert.equal(store.listCards("lib_anime", undefined, undefined).items.length, 4, "读差异不写任何东西");
  } finally {
    store.close();
  }
});

test("classify 端点只产生草稿与差异，卡片要等 scrape", async () => {
  const backend = await started({});
  try {
    const classified = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify`, { method: "POST" }));
    assert.equal(classified.status, 200);
    assert.equal((classified.body as { files: number }).files, 2);
    assert.equal((classified.body as { cards: number }).cards, 1);
    assert.equal((classified.body as { diff: { added: unknown[] } }).diff.added.length, 1);

    const empty = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    assert.deepEqual((empty.body as { items: unknown[] }).items, [], "分类不建卡");

    const draft = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify`));
    assert.equal((draft.body as { cards: number }).cards, 1);
    const card = (draft.body as { draft: Array<{ itemKey: string; subtitle: string | null; files: number }> }).draft[0];
    assert.equal(card.files, 2);
    assert.equal(card.subtitle, "2 集");

    await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/scrape`, { method: "POST" });
    const afterScrape = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify`));
    assert.equal((afterScrape.body as { diff: { added: unknown[] } }).diff.added.length, 0, "scrape 顺手把草稿也刷新了");
    assert.ok((afterScrape.body as { diff: { unchanged: number } }).diff.unchanged >= 1);

    const missing = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_nope/classify`, { method: "POST" }));
    assert.equal(missing.status, 404);
  } finally {
    await backend.close();
  }
});

test("judge 只写草稿：候选与自动确认都留在草稿里，正式表和作业都不动", async () => {
  const backend = await started({});
  try {
    const judged = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/judge`, { method: "POST" }));
    assert.equal(judged.status, 200);
    const body = judged.body as { judged: number; confirmed: number; pending: number; diff: { autoConfirmed: number; formalCards: number } };
    assert.equal(body.judged, 1, "两集同一作品 ⇒ 一条草稿");
    assert.equal(body.pending, 0);
    assert.ok(body.confirmed >= 1, "假条目库回的就是同名条目，应当自动确认");
    assert.equal(body.diff.formalCards, 0, "判定不建卡");

    const draft = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify`));
    const card = (draft.body as { draft: Array<Record<string, unknown>> }).draft[0];
    assert.equal(card.status, "confirmed");
    assert.equal(card.confirmedBy, "auto");
    assert.equal(card.externalId, "430699");
    assert.equal(card.lookupState, "done");
    assert.equal("candidates" in card, false, "候选不在列表里");
    assert.ok((card.candidateCount as number) >= 1, "但列表留了扁平计数");
    assert.equal(typeof card.topScore, "number");
    const expanded = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify?item=${encodeURIComponent(card.itemKey as string)}`));
    assert.ok(((expanded.body as { candidates: unknown[] }).candidates ?? []).length >= 1, "展开时才给候选");
    assert.equal(((expanded.body as { children: unknown[] }).children ?? []).length, 2);

    const cards = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    assert.deepEqual((cards.body as { items: unknown[] }).items, []);
    const scraped = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/scrape`, { method: "POST" }));
    assert.equal(scraped.status, 200, "旧扫描路径照旧可用");
    const afterScrape = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    assert.ok((afterScrape.body as { items: unknown[] }).items.length >= 1, "卡是 scrape 建的，不是 judge 建的");

    const bad = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/judge?max=abc`, { method: "POST" }));
    assert.equal(bad.status, 400);
  } finally {
    await backend.close();
  }
});

/**
 * 应用一步：草稿变成卡。结构对齐复用 upsertScan（身份、保护、孤儿行都在那边），
 * 判定结论单独落，所以这里钉的是"复用没走样"：幂等、过期拒绝、人工答案不动。
 */
async function draftToCards(backend: Backend): Promise<string> {
  const id = "lib_anime";
  await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
  await fetch(`${base(backend)}/api/admin/media-libraries/${id}/judge`, { method: "POST" });
  const applied = await applyWithApproval(backend, id);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return id;
}

/** 建卡/删卡/换文件都要人工凭证：测试里的"应用"= 先批准，再带凭证应用。 */
async function applyWithApproval(backend: Backend, id: string, force = false) {
  const direct = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply${force ? "?force=1" : ""}`, { method: "POST" }));
  if ((direct.body as { code?: string } | null)?.code !== "CATALOG_APPROVAL_REQUIRED") return direct;
  const approval = await json(
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  );
  assert.equal(approval.status, 200);
  return json(
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply-approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: (approval.body as { approvalToken: string }).approvalToken, ...(force ? { force: 1 } : {}) }),
    }),
  );
}

test("apply 把草稿变成已确认的卡，再跑一遍不多一张", async () => {
  const backend = await started({});
  try {
    const id = await draftToCards(backend);
    const first = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`));
    const items = (first.body as { items: Array<{ id: string; status: string; title: string }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "confirmed", "草稿里已经判定过，应用后直接是确认态");
    const detail = await json(await fetch(`${base(backend)}/api/media/catalog/${items[0].id}`));
    assert.equal((detail.body as { externalId: string }).externalId, "430699");
    assert.equal((detail.body as { confirmedBy: string }).confirmedBy, "auto");
    assert.equal((detail.body as { children: unknown[] }).children.length, 2);

    const again = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply`, { method: "POST" }));
    assert.equal((again.body as { created: number }).created, 0, "同一份草稿重复应用不建重卡");
    const second = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`));
    assert.equal((second.body as { items: unknown[] }).items.length, 1);
    assert.equal((again.body as { diff: { added: unknown[] } }).diff.added.length, 0, "应用后差异收敛");
  } finally {
    await backend.close();
  }
});

test("apply 拒绝过期草稿，也不碰刮削作业行", async () => {
  const backend = await started({});
  try {
    const id = await draftToCards(backend);
    const jobs = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/scrape`));
    assert.equal(jobs.status, 404, "整条草稿链路不建作业行：作业只属于扫描");

    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/scan`, { method: "POST" });
    const stale = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply`, { method: "POST" }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { code: string }).code, "CATALOG_STALE_SCAN");
    const cards = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`));
    assert.equal((cards.body as { items: unknown[] }).items.length, 1, "被拒绝的应用什么都没改");

    // 重新分类到当前修订后就能应用了。
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    const fresh = await applyWithApproval(backend, id, true);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal((fresh.body as { created: number }).created, 0);
  } finally {
    await backend.close();
  }
});

test("apply 不动人已确认的绑定", async () => {
  const backend = await started({});
  try {
    const id = await draftToCards(backend);
    const cards = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`));
    const cardId = (cards.body as { items: Array<{ id: string }> }).items[0].id;
    await fetch(`${base(backend)}/api/media/catalog/${cardId}/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalDb: "bangumi", externalId: "777777", title: "人工挑的条目" }),
    });

    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/judge`, { method: "POST" });
    const applied = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply`, { method: "POST" }));
    assert.equal((applied.body as { skipped: number }).skipped, 1);
    const detail = await json(await fetch(`${base(backend)}/api/media/catalog/${cardId}`));
    assert.equal((detail.body as { externalId: string }).externalId, "777777", "机器重新确认也不能盖掉人的选择");
    assert.equal((detail.body as { confirmedBy: string }).confirmedBy, "rebind");
  } finally {
    await backend.close();
  }
});

test("prepare 一次跑完分类+判定，再跑不擦上一轮的结果", async () => {
  const backend = await started({});
  try {
    const id = "lib_anime";
    const first = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/prepare?max=1`, { method: "POST" }));
    assert.equal(first.status, 200);
    const a = first.body as { judged: number; pending: number; cards: number; rev: number; diff: { autoConfirmed: number } };
    assert.equal(a.judged, 1);
    assert.equal(a.pending, 0);
    assert.ok(a.diff.autoConfirmed >= 1);

    const second = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/prepare`, { method: "POST" }));
    const b = second.body as { judged: number; pending: number; diff: { autoConfirmed: number } };
    assert.equal(b.judged, 0, "没有待判定的了就不该重跑");
    assert.equal(b.pending, 0);
    assert.ok(b.diff.autoConfirmed >= 1, "上一轮的判定还在：prepare 不整批重做");
  } finally {
    await backend.close();
  }
});

test("条目站不可达时报 503 CATALOG_UNAVAILABLE，不是 500", async () => {
  const backend = await started({
    bangumi: {
      async search() {
        throw new MetadataUnavailable();
      },
    },
  });
  try {
    const response = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/prepare`, { method: "POST" }));
    assert.equal(response.status, 503);
    assert.equal((response.body as { code: string }).code, "CATALOG_UNAVAILABLE");
  } finally {
    await backend.close();
  }
});

test("没判定过的草稿不许把已确认的卡打回未匹配（分批跑的前提）", async () => {
  const backend = await started({});
  try {
    const id = await draftToCards(backend);
    const before = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`));
    const cardId = (before.body as { items: Array<{ id: string }> }).items[0].id;

    // 只重新分类（草稿全部回到 pending），不判定，然后应用：绑定必须原样保留。
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    const blocked = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply`, { method: "POST" }));
    assert.equal(blocked.status, 409, "没判完默认不给应用");
    assert.equal((blocked.body as { code: string }).code, "CATALOG_DRAFT_INCOMPLETE");
    const applied = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" }));
    assert.equal((applied.body as { deferred: number }).deferred, 1);
    assert.equal((applied.body as { updated: number }).updated, 0);
    const detail = await json(await fetch(`${base(backend)}/api/media/catalog/${cardId}`));
    assert.equal((detail.body as { status: string }).status, "confirmed");
    assert.equal((detail.body as { externalId: string }).externalId, "430699");
  } finally {
    await backend.close();
  }
});

test("草稿列表不下发 children，展开某一张时才给（前端回执 §4.1）", async () => {
  const backend = await started({});
  try {
    const id = "lib_anime";
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    const list = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`));
    const body = list.body as {
      draft: Array<{ itemKey: string; files: number; children?: unknown }>;
      thresholds: Record<string, number>;
    };
    assert.equal("children" in body.draft[0], false, "列表项不该带 children");
    assert.equal(body.draft[0].files, 2, "但文件数还在");
    assert.equal(body.thresholds.autoScore, 0.86, "阈值下发，别让客户端硬编码");

    const one = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify?item=${encodeURIComponent(body.draft[0].itemKey)}`));
    const card = one.body as { card: { itemKey: string }; children: Array<{ relativePath: string }> };
    assert.equal(card.card.itemKey, body.draft[0].itemKey);
    assert.equal(card.children.length, 2);

    const missing = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify?item=%2FNope`));
    assert.equal(missing.status, 404);
  } finally {
    await backend.close();
  }
});

test("judge 有单轮上限并回本批 itemKey；没判完的 409 带数量", async () => {
  const backend = await started({});
  try {
    const id = "lib_anime";
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    const judged = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/judge?max=1`, { method: "POST" }));
    const body = judged.body as { judged: number; items: string[] };
    assert.equal(body.judged, 1);
    assert.equal(body.items.length, 1, "表格只刷新这几行");

    assert.equal((await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/judge?max=21`, { method: "POST" }))).status, 400);

    // 一张都没判就去应用 → 409，且带上还剩几张。
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });
    const blocked = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply`, { method: "POST" }));
    assert.equal(blocked.status, 409);
    const err = blocked.body as { code: string; pending?: number; draftCards?: number };
    assert.equal(err.code, "CATALOG_DRAFT_INCOMPLETE");
    assert.equal(err.pending, 1);
    assert.equal(err.draftCards, 1);
  } finally {
    await backend.close();
  }
});

test("新卡带权威来源：文件是从哪张卡接走的，前端不用猜（回执 §6 要的字段）", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "anime", [group("/Show", "Show", ["s1", "s2", "s3", "s4"])]);
    // 劈卡时文件不动，动的只有"哪张卡认领它们"——所以配对只能按文件路径认，不能按目录名猜。
    store.writeDraft("lib_anime", [
      group("/Show", "Show", ["s1", "s2"]),
      group("/Bonus", "Bonus", ["s3", "s4"], { s3: "/Show", s4: "/Show" }),
    ]);
    const diff = store.draftDiff("lib_anime");
    const added = diff.added.find((entry) => entry.itemKey === "/Bonus");
    assert.deepEqual({ splitFromKey: added?.splitFromKey, fromFiles: added?.fromFiles }, { splitFromKey: "/Show", fromFiles: 2 }, "文案能写 4 → 2 + 2");
    assert.equal(diff.changed.length, 1);
    assert.deepEqual(diff.changed[0].splitIntoKeys, ["/Bonus"], "反向也给出：这张卡被谁接走了文件");
    assert.deepEqual(diff.changed[0].from, { title: "Show", subtitle: "4 集" });
    assert.deepEqual(diff.changed[0].to, { title: "Show", subtitle: "2 集" });
  } finally {
    store.close();
  }
});

test("autoConfirmed 数的是整份草稿里机器确认的张数（含已存在的卡，不只新卡）", () => {
  const { store } = openStore();
  try {
    const hit = { externalDb: "bangumi" as const, externalId: "1", title: "确认过的条目", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 0.9 };
    store.upsertScan("lib_anime", "anime", [group("/A", "A", ["a1", "a2"])]);
    store.writeDraft("lib_anime", [group("/A", "A", ["a1", "a2"]), group("/New", "New", ["n1"])]);
    store.writeDraftJudgment("lib_anime", "/A", { status: "confirmed", candidates: [hit], chosen: hit });
    store.writeDraftJudgment("lib_anime", "/New", { status: "confirmed", candidates: [hit], chosen: hit });
    const diff = store.draftDiff("lib_anime");
    assert.equal(diff.autoConfirmed, 2, "一张对上已有卡、一张是新卡，两边都要数进来");
    assert.equal(diff.added.length, 1);
  } finally {
    store.close();
  }
});

test("forgetLibrary 清掉这个库的快照与草稿（删库不留孤儿行）", () => {
  const { store } = openStore();
  try {
    store.writeScan("lib_anime", snapshotThree);
    store.writeDraft("lib_anime", [group("/Show", "Show", ["m1", "m2"])]);
    store.writeScan("lib_tv", [{ relativePath: "/Other/x.mkv", name: "x.mkv", mediaId: "x" }]);
    assert.deepEqual(store.forgetLibrary("lib_anime"), { scan: 3, draft: 1 }, "返回的是删掉的行数");
    assert.deepEqual(store.scanInfo("lib_anime"), { files: 0, enumeratedAt: null, rev: 0 });
    assert.equal(store.draftInfo("lib_anime").cards, 0);
    assert.equal(store.scanInfo("lib_tv").files, 1, "别的库不受影响");
  } finally {
    store.close();
  }
});

/** 六个草稿编辑接口：只写草稿、人工决定不被下一轮判定盖掉。 */
function draftStore() {
  const { store } = openStore();
  store.writeScan("lib_anime", [
    { relativePath: "/W/1.mkv", name: "W 1.mkv", mediaId: "a1" },
    { relativePath: "/W/2.mkv", name: "W 2.mkv", mediaId: "a2" },
    { relativePath: "/W/3.mkv", name: "W 3.mkv", mediaId: "a3" },
    { relativePath: "/Other/4.mkv", name: "Other 4.mkv", mediaId: "a4" },
  ]);
  store.writeDraft("lib_anime", [group("/W", "W", ["a1", "a2", "a3"]), group("/Other", "Other", ["a4"])]);
  return store;
}

const draftCandidate = { externalDb: "bangumi" as const, externalId: "4242", title: "候选条目", originalTitle: "原名", year: 2021, overview: "简介", imageUrl: "https://x/p.jpg", episodes: 3, score: 0.7 };

test("草稿编辑：改标题/换条目都记成人工决定，正式卡一行不动", () => {
  const store = draftStore();
  try {
    const before = store.cardIds("lib_anime").length;
    assert.equal(store.draftEdit("lib_anime", "/W", { title: "我起的名字" }), true);
    assert.equal(store.draftEdit("lib_anime", "/Nope", { title: "x" }), false, "不存在的草稿卡返回 false");
    store.draftConfirm("lib_anime", "/Other", undefined); // 没有候选 → 失败但不抛
    const cards = store.listCards("lib_anime", undefined, undefined).items;
    assert.equal(cards.length, before, "编辑不建卡");
    const row = store.readDraft("lib_anime").find((entry) => entry.itemKey === "/W");
    assert.equal(row?.title, "我起的名字");
    assert.equal(row.confirmedBy, "manual");
    assert.equal(row.lookupState, "done", "下一轮判定不会再盖掉它");
    assert.equal(row.status, "candidate", "只改名字不算确认绑定");
  } finally {
    store.close();
  }
});

test("草稿确认/撤销：确认写进条目字段，撤销只撤人的决定、不清绑定", () => {
  const store = draftStore();
  try {
    store.writeDraftJudgment("lib_anime", "/W", { status: "candidate", candidates: [draftCandidate] });
    assert.equal(store.draftConfirm("lib_anime", "/W", { externalDb: "bangumi", externalId: "999" }), "unknown-candidate");
    assert.equal(store.draftConfirm("lib_anime", "/W", { externalDb: "bangumi", externalId: "4242" }), "ok");
    let row = store.readDraft("lib_anime").find((entry) => entry.itemKey === "/W");
    assert.equal(row?.status, "confirmed");
    assert.equal(row?.externalId, "4242");
    assert.equal(row?.year, 2021);
    assert.equal(row?.posterUrl, "https://x/p.jpg");
    assert.equal(row?.confirmedBy, "manual");

    store.draftUnconfirm("lib_anime", "/W");
    row = store.readDraft("lib_anime").find((entry) => entry.itemKey === "/W");
    assert.equal(row?.status, "candidate", "退回候选，不是 unmatched");
    assert.equal(row?.externalId, "4242", "条目留着，重新确认是一键的事");
    assert.equal(row?.confirmedBy, null);
  } finally {
    store.close();
  }
});

test("草稿合并：文件并到留着的卡，人已定过的那张不许被静默吃掉", () => {
  const store = draftStore();
  try {
    store.writeDraftJudgment("lib_anime", "/Other", { status: "candidate", candidates: [draftCandidate] });
    store.draftConfirm("lib_anime", "/Other", { externalDb: "bangumi", externalId: "4242" });
    assert.deepEqual(store.draftMerge("lib_anime", "/W", ["/Other"]), { error: "conflict", keys: ["/Other"] });

    store.draftUnconfirm("lib_anime", "/Other");
    assert.deepEqual(store.draftMerge("lib_anime", "/W", ["/Other"]), { error: null });
    const rows = store.readDraft("lib_anime");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.children.map((file) => file.mediaId).sort(), ["a1", "a2", "a3", "a4"]);
    assert.equal(rows[0]?.files, 4);
    assert.equal(rows[0]?.subtitle, "3 集", "文件 4 个，但集数行只数本卡目录里的那 3 个（口径与正式卡一致）");
    assert.equal(rows[0]?.files, 4);
    assert.equal(rows[0]?.candidates.length, 1, "候选并过来，不丢");
  } finally {
    store.close();
  }
});

test("草稿拆分：只传留下的那批，其余自动成新卡并回到待判定", () => {
  const store = draftStore();
  try {
    assert.deepEqual(store.draftSplit("lib_anime", "/W", ["a1", "a2", "a3"]), { error: "invalid" });
    const split = store.draftSplit("lib_anime", "/W", ["a1", "a2"]);
    assert.equal(split.error, null);
    assert.equal(split.created?.length, 1, "分出去的那 1 个文件还在 /W 目录里 ⇒ 用 #split 合成键");
    const rows = store.readDraft("lib_anime");
    const created = rows.find((row) => row.itemKey.startsWith("#split/"));
    assert.deepEqual(created?.children.map((file) => file.mediaId), ["a3"]);
    assert.equal(created?.lookupState, "pending", "新卡交给下一轮判定");
    assert.equal(created?.confirmedBy, null);
    assert.equal(rows.find((row) => row.itemKey === "/W")?.files, 2);
  } finally {
    store.close();
  }
});

test("撤销确认是粘的：草稿那份判定一起降级，再跑 apply 不会把绑定悄悄写回去", () => {
  const { store } = openStore();
  try {
    const hit = { externalDb: "bangumi" as const, externalId: "1", title: "机器挑的名", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 0.9 };
    store.upsertScan("lib_anime", "anime", [group("/A", "A", ["a1", "a2"])]);
    store.writeDraft("lib_anime", [group("/A", "A", ["a1", "a2"])]);
    store.writeDraftJudgment("lib_anime", "/A", { status: "confirmed", candidates: [hit], chosen: hit });
    store.applyDraftDecisions("lib_anime");
    const card = store.listCards("lib_anime", undefined, undefined).items.find((row) => store.getDetail(row.id)?.itemKey === "/A");
    assert.ok(card);
    assert.equal(store.getDetail(card.id)?.status, "confirmed", "前提：这张卡是草稿判定落下去的");

    store.unconfirm(card.id);
    const draft = store.readDraft("lib_anime").find((row) => row.itemKey === "/A");
    assert.equal(draft?.status, "candidate", "候选还在 ⇒ 落「待人工」，与 draftUnconfirm 同口径");
    assert.equal(draft?.confirmedBy, null, "草稿里那份\"人确认过\"也一起撤掉");
    assert.equal(draft?.lookupState, "done", "不许被下一轮判定重新捡起来确认回去");
    assert.ok(draft && draft.candidates.length > 0, "候选与条目都留着：重新确认是一键的事");

    const again = store.applyDraftDecisions("lib_anime");
    assert.ok(again.updated >= 1, "apply 确实动过这张卡，不是没跑");
    assert.equal(store.getDetail(card.id)?.status, "candidate", "撤销后 apply 只能把它推到\"有候选、待人工\"");
    assert.equal(store.getDetail(card.id)?.externalId, null, "绑定没有被写回来（撤销是粘的）");
    assert.equal(store.getDetail(card.id)?.confirmedBy ?? null, null, "也不算任何人确认过的");
  } finally {
    store.close();
  }
});

test("撤销确认在没有候选、或草稿里根本没这一行时也不炸", () => {
  const { store } = openStore();
  try {
    const hit = { externalDb: "bangumi" as const, externalId: "7", title: "条目", originalTitle: null, year: null, overview: null, imageUrl: null, episodes: null, score: 0.8 };
    store.upsertScan("lib_anime", "anime", [group("/A", "A", ["a1"]), group("/NoDraft", "NoDraft", ["z1"])]);
    store.writeDraft("lib_anime", [group("/A", "A", ["a1"])]);
    store.writeDraftJudgment("lib_anime", "/A", { status: "candidate", candidates: [hit], chosen: hit });
    store.draftConfirm("lib_anime", "/A", hit);
    store.applyDraftDecisions("lib_anime");
    const rows = store.listCards("lib_anime", undefined, undefined).items;
    const withCandidates = rows.find((row) => store.getDetail(row.id)?.itemKey === "/A");
    const orphan = rows.find((row) => store.getDetail(row.id)?.itemKey === "/NoDraft");
    assert.ok(withCandidates && orphan);

    // 人直接确认的（草稿不是 confirmed）：撤销后草稿落回它本来的桶，不报错
    assert.ok(store.unconfirm(withCandidates.id));
    assert.equal(store.readDraft("lib_anime").find((row) => row.itemKey === "/A")?.status, "candidate");
    // 草稿里没有这一行的卡（正式表里躺着、草稿没写）：撤销只动卡，不许抛
    assert.ok(store.unconfirm(orphan.id));
    assert.equal(store.getDetail(orphan.id)?.status, "unmatched");
  } finally {
    store.close();
  }
});

test("绑定承接：人可以选择让哪一半留住条目，应用时按这个决定搬绑定", () => {
  const store = draftStore();
  try {
    store.upsertScan("lib_anime", "anime", [group("/W", "W", ["a1", "a2", "a3"], { a1: "/W", a2: "/W", a3: "/W" }), group("/Other", "Other", ["a4"])]);
    const card = store.listCards("lib_anime", undefined, undefined).items.find((row) => store.getDetail(row.id)?.itemKey === "/W");
    assert.ok(card, "先找到 /W 那张卡");
    store.rebind(card!.id, { externalDb: "bangumi", externalId: "777", title: "人工挑的条目", originalTitle: null, year: null });
    store.writeDraft("lib_anime", [group("/W", "W", ["a1", "a2"]), group("/Other", "Other", ["a3", "a4"], { a3: "/W" })]);

    assert.equal(store.draftCarryBinding("lib_anime", "/Other", "/W"), true);
    assert.equal(store.draftDiff("lib_anime").confirmedDrift.find((row) => row.itemKey === "/W")?.keepsBindingOnKey, "/Other");

    store.upsertScan("lib_anime", "anime", [group("/W", "W", ["a1", "a2"]), group("/Other", "Other", ["a3", "a4"], { a3: "/W" })], false);
    const applied = store.applyDraftDecisions("lib_anime");
    assert.equal(applied.transferred, 1);
    const rows = store.listCards("lib_anime", undefined, undefined).items;
    const carrier = rows.find((row) => (store.getDetail(row.id)?.externalId ?? "") === "777");
    assert.equal(store.getDetail(carrier!.id)?.itemKey, "/Other", "绑定跟着人挑的那一半走了");
    const emptied = rows.find((row) => store.getDetail(row.id)?.itemKey === "/W");
    assert.equal(store.getDetail(emptied!.id)?.status, "unmatched", "另一半不再是确认态");

    // 选回自己 = 复位：下拉的默认项必须点得回去
    assert.equal(store.draftCarryBinding("lib_anime", "/Other", "/Other"), true);
    assert.equal(store.readDraft("lib_anime").find((row) => row.itemKey === "/Other")?.carriesKey, null);
  } finally {
    store.close();
  }
});

test("草稿编辑的路由：返回新摘要，错误按码分（前端按码映射，不解析 message）", async () => {
  const backend = await started({});
  try {
    const id = "lib_anime";
    const post = async (action: string, body: unknown) =>
      json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/draft/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify`, { method: "POST" });

    const edited = await post("edit", { itemKey: "/Medalist", title: "我要的名字" });
    assert.equal(edited.status, 200);
    assert.equal((edited.body as { card: { title: string; confirmedBy: string } }).card.title, "我要的名字");
    assert.equal((edited.body as { diff: { formalCards: number } }).diff.formalCards, 0, "编辑不碰正式表");

    const searched = await post("edit", {
      itemKey: "/Medalist", title: "搜索命中的作品", originalTitle: "Search hit", year: 2025,
      externalDb: "bangumi", externalId: "9622", posterUrl: "https://example.test/poster.jpg",
    });
    assert.equal(searched.status, 200, "搜索命中不在判定候选里，也能人工绑定");
    const searchedCard = (searched.body as { card: { externalDb: string; externalId: string; title: string; status: string; confirmedBy: string } }).card;
    assert.equal(searchedCard.externalDb, "bangumi");
    assert.equal(searchedCard.externalId, "9622");
    assert.equal(searchedCard.title, "搜索命中的作品");
    assert.equal(searchedCard.status, "confirmed");
    assert.equal(searchedCard.confirmedBy, "manual");

    assert.equal((await post("edit", { itemKey: "/Nope", title: "x" })).status, 404);
    assert.equal((await post("edit", { itemKey: "/Medalist" })).status, 400, "空补丁");
    assert.equal((await post("edit", { itemKey: "/Medalist", externalDb: "imdb", externalId: "tt1" })).status, 400, "条目库要在白名单里");
    assert.equal((await post("confirm", { itemKey: "/Medalist" })).status, 400, "没候选就确认不了");
    assert.equal((await post("split", { itemKey: "/Medalist", keep: [] })).status, 400);
    const merged = await post("merge", { keepKey: "/Medalist", dropKeys: ["/Nope"] });
    assert.equal(merged.status, 404);
  } finally {
    await backend.close();
  }
});

test("拆分接受真实的长 mediaId（HMAC 300+ 字），认不出的 id 说清是哪几个", () => {
  const { store } = openStore();
  try {
    const long = (n: number) => `v2.${Buffer.from(`/W/${"x".repeat(300)}#${n}`).toString("base64url")}.${"s".repeat(43)}`;
    const files = [1, 2, 3].map((n) => ({ relativePath: `/W/${n}.mkv`, name: `W ${n}.mkv`, mediaId: long(n) }));
    store.writeScan("lib_anime", files);
    store.writeDraft("lib_anime", [{ itemKey: "/W", query: "W", queries: ["W"], rawName: "W", files: files.map((file) => ({ ...file, season: null, episode: null })) }]);
    const split = store.draftSplit("lib_anime", "/W", [long(1), long(2)]);
    assert.equal(split.error, null);
    assert.equal(split.created?.length, 1);
    const unknown = store.draftSplit("lib_anime", "/W", ["v2.NS5taw.x"]);
    assert.equal(unknown.error, "unknown-media");
    assert.deepEqual(unknown.unknown, ["v2.NS5taw.x"]);
  } finally {
    store.close();
  }
});

test("绑定承接可以复位，也不会被反向调用点成环", () => {
  const store = draftStore();
  try {
    assert.equal(store.draftCarryBinding("lib_anime", "/Other", "/W"), true);
    assert.equal(store.draftDiff("lib_anime").changed.find((row) => row.itemKey === "/W")?.keepsBindingOnKey ?? "/Other", "/Other");
    // 反向再点一次：不该留下 A↔B 互指
    assert.equal(store.draftCarryBinding("lib_anime", "/W", "/Other"), true);
    const rows = store.readDraft("lib_anime");
    const pointing = rows.filter((row) => row.carriesKey);
    assert.equal(pointing.length, 1, "只有一行承接，不形成环");
    assert.equal(pointing[0]?.itemKey, "/W");
    // 选回自己 = 不搬
    assert.equal(store.draftCarryBinding("lib_anime", "/W", "/W"), true);
    assert.equal(store.readDraft("lib_anime").find((row) => row.itemKey === "/W")?.carriesKey ?? null, null);
    assert.equal(store.draftCarryBinding("lib_anime", "/Nope", "/W"), false);
  } finally {
    store.close();
  }
});

test("sidecar 元数据写入：可以覆盖字段，但不冒充人工决定，也不动人工决定的行", () => {
  const store = draftStore();
  try {
    assert.equal(store.draftEdit("lib_anime", "/Other", { title: "人起的名字" }), true);
    assert.equal(store.draftImport("lib_anime", "/Nope", { title: "x" }), "missing");
    assert.equal(store.draftImport("lib_anime", "/Other", { title: "sidecar 想改" }), "protected");
    assert.equal(store.readDraft("lib_anime").find((row) => row.itemKey === "/Other")?.title, "人起的名字", "人工决定优先");
    assert.equal(store.draftImport("lib_anime", "/W", { title: "侧车标题", year: 1999, externalDb: "bangumi", externalId: "4242" }), "ok");
    const row = store.readDraft("lib_anime").find((entry) => entry.itemKey === "/W");
    assert.equal(row?.title, "侧车标题");
    assert.equal(row?.year, 1999);
    assert.equal(row?.externalId, "4242");
    assert.equal(row?.status, "confirmed");
    assert.equal(row?.lookupState, "done", "sidecar 给出了条目，判定这一轮不必再跑");
    assert.equal(row?.confirmedBy, null, "导入不是人的决定：保护规则不能因为它失效");
    assert.equal(store.cardIds("lib_anime").length, 0, "一行正式卡都不写");
  } finally {
    store.close();
  }
});

/** sidecar 三条接口 + 单卡读取都要同一个前缀，两个用例共用一个助手。 */
function sidecarApi(backend: Backend) {
  const api = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? "{}" : JSON.stringify(body) }));
  const card = async (itemKey: string) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify?item=${encodeURIComponent(itemKey)}`));
  return { api, card };
}

test("collection sidecar 闭环：导出可读回，元数据写草稿，结构提案要显式落", async () => {
  const sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-sidecar-"));
  const backend = await started({ catalogSidecarDir: sidecarDir });
  const { api, card } = sidecarApi(backend);
  try {
    assert.equal((await api("classify")).status, 200);
    const exported = await api("import/export");
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.body.written, ["Medalist/.watchparty.collection.json"]);
    const file = path.join(sidecarDir, "lib_anime", "Medalist", ".watchparty.collection.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(doc.libraryId, "lib_anime");
    assert.equal(doc.basePath, "/Medalist");
    assert.deepEqual(doc.members.map((member: { path: string }) => member.path), [
      "[VCB-Studio] Medalist [01][Ma10p_1080p].mkv",
      "[VCB-Studio] Medalist [02][Ma10p_1080p].mkv",
    ]);

    doc.title = "メダリスト";
    doc.year = 2025;
    doc.external = { db: "bangumi", id: "430699" };
    fs.writeFileSync(file, JSON.stringify(doc));
    const preview = await api("import/preview");
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.written.map((entry: { itemKey: string }) => entry.itemKey), ["/Medalist"]);
    assert.deepEqual(preview.body.proposals, [], "文件集合一致，不该提出任何结构变更");
    const row = await card("/Medalist");
    assert.equal(row.body.card.title, "メダリスト");
    assert.equal(row.body.card.externalId, "430699");
    assert.equal(row.body.card.confirmedBy, null);

    assert.equal((await api("draft/edit", { itemKey: "/Medalist", title: "人起的名字" })).status, 200);
    const again = await api("import/preview");
    assert.deepEqual(again.body.protectedCards.map((entry: { itemKey: string }) => entry.itemKey), ["/Medalist"]);
    assert.deepEqual(again.body.written, []);
    assert.equal((await card("/Medalist")).body.card.title, "人起的名字");

    // 一个目录住两部作品：先只出提案，structure 之后才落到草稿。
    fs.rmSync(file);
    const dir = path.join(sidecarDir, "lib_anime", "Medalist");
    const half = (name: string, episode: number, title: string) =>
      fs.writeFileSync(
        path.join(dir, name),
        JSON.stringify({
          schemaVersion: 1,
          libraryId: "lib_anime",
          basePath: "/Medalist",
          title,
          members: [{ path: `[VCB-Studio] Medalist [0${episode}][Ma10p_1080p].mkv`, season: 1, episode, role: "episode" }],
        }),
      );
    half("part-1.watchparty.collection.json", 1, "第一部");
    half("part-2.watchparty.collection.json", 2, "第二部");
    const staged = await api("import/preview");
    assert.deepEqual(staged.body.applied, [], "preview 不执行结构");
    assert.deepEqual(staged.body.proposals.map((entry: { kind: string }) => entry.kind), ["split", "split"]);
    assert.equal((await card("/Medalist")).body.card.files, 2, "提案没落地前草稿还是两张文件");

    const structure = await api("import/structure", {});
    assert.equal(structure.status, 200);
    assert.deepEqual(
      structure.body.applied.map((entry: { result: string }) => entry.result),
      ["ok", "skipped"],
      "第一条拆完，第二条的文件集合已经正好等于新卡",
    );
    assert.deepEqual((await api("import/preview")).body.proposals, []);
    const applied = await api("import/preview");
    assert.equal(applied.body.draftCards, 2, "一个目录两张卡");
    assert.equal(applied.body.written.length, 1, "人改过的那半不许机器改名");
    assert.deepEqual(applied.body.protectedCards.map((entry: { itemKey: string }) => entry.itemKey), ["/Medalist"]);
    assert.equal((await card("/Medalist")).body.card.title, "人起的名字");
    const moved = applied.body.written[0].itemKey as string;
    assert.notEqual(moved, "/Medalist");
    assert.equal((await card(moved)).body.card.title, "第二部");
    assert.equal((await card(moved)).body.card.files, 1);
    const formal = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    assert.equal(formal.body.items.length, 0, "结构只到草稿：正式卡要等 apply");
  } finally {
    await backend.close();
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

test("两个 sidecar 抢同一个文件时谁都不许写，只报冲突", async () => {
  const sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-sidecar-"));
  const backend = await started({ catalogSidecarDir: sidecarDir });
  const { api, card } = sidecarApi(backend);
  const dir = path.join(sidecarDir, "lib_anime", "Medalist");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["one.watchparty.collection.json", "two.watchparty.collection.json"]) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ schemaVersion: 1, libraryId: "lib_anime", basePath: "/Medalist", title: `抢 ${name}`, members: [{ path: "[VCB-Studio] Medalist [01][Ma10p_1080p].mkv" }] }),
    );
  }
  try {
    assert.equal((await api("classify")).status, 200);
    const preview = await api("import/preview");
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.written, []);
    assert.deepEqual(preview.body.conflicts.map((entry: { reason: string }) => entry.reason), ["claimed-by-two", "claimed-by-two"]);
    assert.equal(preview.body.ambiguous.length, 1);
    assert.equal((await card("/Medalist")).body.card.files, 2, "冲突不许动草稿");
    assert.equal((await card("/Medalist")).body.card.title, "Medalist", "也没人替它改名");
  } finally {
    await backend.close();
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

/** 凭证的生命周期：批准的是"当前这套结构变更"，动过内容、用过、撤过都得重新批准。 */
test("结构 apply 的人工凭证：没批准不动结构，用过即废，内容变了即废", async () => {
  const backend = await started({});
  const id = "lib_anime";
  const post = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  try {
    await post("classify");
    await post("judge");
    const blocked = await post("apply");
    assert.equal(blocked.status, 409);
    assert.equal((blocked.body as { code: string }).code, "CATALOG_APPROVAL_REQUIRED");
    assert.deepEqual((blocked.body as { structural: { added: string[] } }).structural.added, ["/Medalist"]);
    assert.equal((await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`))).body.items.length, 0, "被拒绝的应用什么都没写");

    const first = await post("approval");
    assert.equal(first.status, 200);
    const token = (first.body as { approvalToken: string }).approvalToken;
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal((first.body as { structural: { added: string[] } }).structural.added.length, 1);
    assert.ok(new Date((first.body as { expiresAt: string }).expiresAt).getTime() - Date.now() > 47 * 3600 * 1000, "默认 48 小时有效");

    const children = (await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/classify?item=%2FMedalist`))).body.children as Array<{ mediaId: string }>;
    assert.equal((await post("draft/split", { itemKey: "/Medalist", keep: [children[0].mediaId] })).status, 200);
    const changed = await json(
      await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply-approved`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalToken: token, force: 1 }) }),
    );
    assert.equal(changed.status, 409);
    assert.equal((changed.body as { reason: string }).reason, "operations-changed", "批准之后又动了结构，旧凭证不能作数");
    // 界面不缓存凭证也不缓存差异，所以失败时必须把**当前**结构带回去，否则批准单重画不出来。
    const carried = (changed.body as { structural: { added: string[] } }).structural;
    assert.equal(carried.added.length, 2, "409 必须带**当前**结构：拆分后是两张新卡，不是批准时那一张");
    assert.ok(carried.added.some((key: string) => key.startsWith("#split")), `回来的应是拆分后的新键位，实际 ${JSON.stringify(carried.added)}`);

    const second = (await post("approval")) as { body: { approvalToken: string } };
    assert.equal((await post("approval/revoke", { approvalToken: second.body.approvalToken })).status, 200);
    const revoked = await json(
      await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply-approved`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalToken: second.body.approvalToken, force: 1 }) }),
    );
    assert.equal((revoked.body as { reason: string }).reason, "revoked");

    const third = (await post("approval")) as { body: { approvalToken: string } };
    const applied = await json(
      await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply-approved`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalToken: third.body.approvalToken, force: 1 }) }),
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((applied.body as { created: number }).created, 2, "拆开的一张卡跟着建出来");
    assert.equal((await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=${id}`))).body.items.length, 2);
    const replay = await json(
      await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply-approved`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalToken: third.body.approvalToken, force: 1 }) }),
    );
    assert.equal((replay.body as { reason: string }).reason, "used", "一次性：用过就不能再用");

    const nothing = await post("approval");
    assert.equal(nothing.status, 409);
    assert.equal((nothing.body as { code: string }).code, "CATALOG_NOTHING_TO_APPROVE", "已经没有结构要批准了");
    const metadataOnly = await json(await fetch(`${base(backend)}/api/admin/media-libraries/${id}/apply?force=1`, { method: "POST" }));
    assert.equal(metadataOnly.status, 200, "纯元数据的差异不必凭证");
  } finally {
    await backend.close();
  }
});

test("dropped 差异要能说清为什么：几个文件的路径已经没了、它们现在落在哪张草稿卡", () => {
  const { store } = openStore();
  try {
    // 人确认过的卡记着旧的库根路径；文件实际已经挪进 /Show，草稿按新路径成了另一张卡。
    store.writeScan("lib_tv", [{ relativePath: "/Show/S01E01.mkv", name: "S01E01.mkv", mediaId: "m1" }]);
    store.upsertScan("lib_tv", "tv", [
      { itemKey: "/Old", query: "Old", queries: ["Old"], rawName: "Old", files: [{ mediaId: "m1", name: "S01E01.mkv", season: 1, episode: 1, relativePath: "/S01E01.mkv" }] },
    ]);
    store.writeDraft("lib_tv", [
      { itemKey: "/Show", query: "Show", queries: ["Show"], rawName: "Show", files: [{ mediaId: "m1", name: "S01E01.mkv", season: 1, episode: 1, relativePath: "/Show/S01E01.mkv" }] },
    ]);
    const dropped = store.draftDiff("lib_tv").dropped;
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].missingPaths, 1, "这条差异的原因是路径没了，不是有人新增了卡");
    assert.deepEqual(dropped[0].suggestedKeys, ["/Show"]);
  } finally {
    store.close();
  }
});

test("批准密钥：只有出示第二把密钥的那一方能批，凭证照样一次性", async () => {
  const secret = "only-the-web-session-has-this";
  const backend = await started({ config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "secret-value", WATCHPARTY_CATALOG_APPROVAL_SECRET: secret }) });
  const call = async (route: string, body?: unknown, headers?: Record<string, string>) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) }));
  try {
    const caps = await json(await fetch(`${base(backend)}/api/media/capabilities`));
    assert.equal((caps.body as { catalogApproval: string }).catalogApproval, "secret", "能力位要如实报这是硬边界还是软边界");
    await call("classify");
    await call("judge");
    assert.equal((await call("approval")).status, 401);
    const missing = await call("approval");
    assert.equal((missing.body as { code: string }).code, "CATALOG_APPROVAL_SECRET_REQUIRED");
    assert.equal((await call("approval", {}, { "x-watchparty-approval": "wrong-value-here" })).status, 401);
    const granted = await call("approval", {}, { "x-watchparty-approval": secret });
    assert.equal(granted.status, 200);
    const token = (granted.body as { approvalToken: string }).approvalToken;
    assert.equal((await call("apply-approved", { approvalToken: token, force: 1 })).status, 200);
    assert.equal((await call("apply-approved", { approvalToken: token, force: 1 })).status, 409);
  } finally {
    await backend.close();
  }
});

/** 回滚台账：结构应用记下旧值/新值，撤回时要当场核对"还是不是当时那个样子"。 */
async function appliedWithApproval() {
  const backend = await started({});
  const api = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  const wall = async () => (await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`))).body.items as Array<{ id: string; title: string }>;
  await api("classify");
  await api("judge");
  const granted = await api("approval");
  const applied = await api("apply-approved", { approvalToken: (granted.body as { approvalToken: string }).approvalToken });
  return { backend, api, wall, applied: applied.body as { approvalId: string; rollbackAvailable: boolean; created: number }, status: applied.status };
}

test("回滚把那次结构应用原样撤回，撤回也要人再批一次", async () => {
  const { backend, api, wall, applied, status } = await appliedWithApproval();
  try {
    assert.equal(status, 200);
    assert.equal(applied.created, 1);
    assert.equal(applied.rollbackAvailable, true, "带凭证的应用必须留下反向操作");
    assert.equal((await wall()).length, 1);

    const plan = await api("approval", { rollbackOf: applied.approvalId });
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.rollback, { approvalId: applied.approvalId, keys: ["/Medalist"], counts: { created: 1, removed: 0, changed: 0 } });
    assert.equal(plan.body.structural, undefined, "批准回滚时不该再带应用差异");

    const done = await api("rollback", { rollbackOf: applied.approvalId, approvalToken: plan.body.approvalToken });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual((done.body as { removed: number; restored: number }).removed, 1);
    assert.equal((await wall()).length, 0, "新建的那张卡被撤掉了");
    const again = await api("approval", { rollbackOf: applied.approvalId });
    assert.equal(again.status, 409);
    assert.equal((again.body as { code: string }).code, "CATALOG_ROLLBACK_ALREADY_DONE", "同一次应用不能撤两遍");
  } finally {
    await backend.close();
  }
});

test("回滚前先核对现值：人在 apply 之后动过的卡，整批不动只报冲突", async () => {
  const { backend, api, wall, applied, status } = await appliedWithApproval();
  try {
    assert.equal(status, 200);
    const card = (await wall())[0];
    await fetch(`${base(backend)}/api/media/catalog/${card.id}/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalDb: "bangumi", externalId: "999001", title: "人后来改的名字" }),
    });
    const plan = await api("approval", { rollbackOf: applied.approvalId });
    const blocked = await api("rollback", { rollbackOf: applied.approvalId, approvalToken: plan.body.approvalToken });
    assert.equal(blocked.status, 409);
    assert.equal((blocked.body as { code: string }).code, "CATALOG_ROLLBACK_CONFLICT");
    assert.deepEqual((blocked.body as { keys: string[] }).keys, ["/Medalist"]);
    const still = await wall();
    assert.equal(still.length, 1, "冲突时一张都不动");
    assert.equal((await json(await fetch(`${base(backend)}/api/media/catalog/${card.id}`))).body.confirmedBy, "rebind", "人的后改不被回滚抹掉");
  } finally {
    await backend.close();
  }
});

test("纯元数据的 apply 不留回滚台账（没消耗凭证，也就没有可撤的那一批）", async () => {
  const { backend, wall, applied, status } = await appliedWithApproval();
  try {
    assert.equal(status, 200);
    assert.equal((await wall()).length, 1);
    // 草稿没变，再应用一次就只有元数据差异：不走凭证，approvalId 为空。
    const second = await json(
      await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/apply`, { method: "POST" }),
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal((second.body as { approvalId: string | null; rollbackAvailable: boolean }).approvalId, null);
    assert.equal((second.body as { rollbackAvailable: boolean }).rollbackAvailable, false);
  } finally {
    await backend.close();
  }
});

test("疑似同作只读不并：同一外部条目的两张卡会被报出来，卡数一行不变", () => {
  const { store } = openStore();
  try {
    store.upsertScan("lib_anime", "tv", [group("/OVA 一期", "我们的恋人 OVA", ["a1", "a2", "a3"]), group("/别放这里/OVA 二期", "完全不像的名字", ["a4"])]);
    const cards = store.listPending("lib_anime");
    assert.equal(cards.length, 2);
    const hit = { externalDb: "bangumi" as const, externalId: "587454", title: "我们的恋人", originalTitle: null, year: 2020, overview: null, imageUrl: null, episodes: null, score: 1 };
    for (const card of cards) store.applyMatch(card, "confirmed", hit, []);
    const before = store.cardIds("lib_anime").length;
    const groups = store.duplicateGroups("lib_anime");
    assert.equal(groups.length, 1, "两张卡绑在同一条目 ⇒ 一组疑似同作");
    assert.equal(groups[0].reason, "same-subject");
    assert.equal(groups[0].cards.length, 2);
    assert.equal(groups[0].cards[0].files, 3, "文件多的那张当保留卡");
    assert.equal(groups[0].suggestion.keepId, groups[0].cards[0].id);
    assert.equal(groups[0].suggestion.dropIds.length, 1);
    assert.equal(store.cardIds("lib_anime").length, before, "读一遍不改任何卡");
    assert.equal(store.draftDiff("lib_anime").added.length, 0, "也没动差异");
  } finally {
    store.close();
  }
});

test("台账与疑似同作两个读接口回真形状，台账绝不带出 token", async () => {
  const { backend, api, wall, applied, status } = await appliedWithApproval();
  try {
    assert.equal(status, 200);
    const ledger = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/approvals`));
    assert.equal(ledger.status, 200);
    const rows = ledger.body.items as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].approvalId, applied.approvalId);
    assert.equal(rows[0].kind, "apply");
    assert.equal(rows[0].rollbackAvailable, true);
    assert.deepEqual(rows[0].keys, ["/Medalist"]);
    assert.equal(JSON.stringify(rows).includes("token"), false, "台账里不许出现 token，也不许出现它的哈希");

    const dup = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/duplicates`));
    assert.equal(dup.status, 200);
    assert.equal(dup.body.readOnly, true);
    assert.equal(dup.body.autoMerge, false);
    assert.equal(dup.body.cards, 1, "墙上的卡数");
    assert.equal(dup.body.groupedCards, 0, "进了组的卡数");
    assert.deepEqual(dup.body.items, [], "墙上一张卡，谈不上疑似同作");
    assert.equal(dup.body.scan.files, 2, "顺带报快照有多新（这里就是 fakeTree 的两个文件）");

    // 再建一张绑到同一条目的卡，才会成组（这条只验读接口把分组带出来，判定本身在 duplicates 测试里钉）
    const draft = await api("classify");
    assert.equal(draft.status, 200);
    assert.equal((await wall()).length, 1);
  } finally {
    await backend.close();
  }
});

/**
 * 已定语义，不是缺口，别"顺手修好"（2026-09-29 与前端一起拍，理由两边都核过代码）。
 *
 * 凭证只绑**结构差异 + 两个 revision**，所以批准之后的判定写入与草稿编辑（都不 bump `rev`，
 * 也不改变 `structural`）不会让它失效 —— 应用落卡的是当时的最新内容，这是接受的代价：
 * 元数据是人的决定，本来就该落。结构那一半是真绑住的：scrape 会 bump 两个 revision，而
 * `/judge` 的隐式重新分类即使 revision 不动也会改变 `structural` 集合 ⇒ `operations-changed`。
 *
 * 不绑"整张草稿内容指纹"的原因：内容指纹会把上面这些日常操作全算成"内容变了"，而凭证先消费
 * 后执行、失败即作废 ⇒ 人的批准被正常操作打死，安全收益为零。
 * （原先这里写的理由是"判定会经 reclusterBySubject 改草稿文件集合"，前端逐行核代码后指出不
 * 成立：recluster 只在 scrape 的 run() 里调用，且它合并的是正式卡，结果本来就在 structural 里。
 * 结论不变，证据换掉 —— 假理由会连累一个对的决定。）
 */
test("已定语义：凭证只管结构失效，元数据后改照样落卡", async () => {
  const { backend, api, applied, status } = await appliedWithApproval();
  try {
    assert.equal(status, 200);
    // 文件集合一致的草稿只剩元数据：不该再要凭证，也就没有"批准后被改"的窗口。
    const metadataOnly = await api("apply");
    assert.equal(metadataOnly.status, 200);
    assert.deepEqual((metadataOnly.body as { structural: unknown }).structural, { added: [], dropped: [], moved: [], drift: [] });
    assert.equal((await api("approval")).status, 409, "没有结构差异时不签发凭证");

    const children = (await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify?item=%2FMedalist`))).body.children as Array<{ mediaId: string }>;
    assert.equal((await api("draft/split", { itemKey: "/Medalist", keep: [children[0].mediaId] })).status, 200);
    const granted = await api("approval");
    assert.equal(granted.status, 200);
    const token = (granted.body as { approvalToken: string }).approvalToken;

    assert.equal((await api("draft/edit", { itemKey: "/Medalist", title: "批准之后人改的名字" })).status, 200);
    const outcome = await api("apply-approved", { approvalToken: token, force: 1 });
    assert.equal(outcome.status, 200, "已定：元数据改动不会让凭证失效");
    const wall = await json(await fetch(`${base(backend)}/api/media/catalog?libraryId=lib_anime`));
    assert.equal((wall.body as { items: unknown[] }).items.length, 2);
    // 列表投影不带 itemKey（那是 CatalogDetail 上的），所以按标题找。
    const titles = (wall.body as { items: Array<{ title: string }> }).items.map((card) => card.title);
    assert.ok(titles.includes("批准之后人改的名字"), `人工后改的标题必须落卡（人的决定优先）：${JSON.stringify(titles)}`);
  } finally {
    await backend.close();
  }
});

/** 前端对台账行的策略是"读不到就静默降级"，所以它能遇到哪些错码必须钉住、不能靠猜。 */
test("台账与疑似同作两个只读接口的错码：403 ADMIN_FORBIDDEN、404 MEDIA_NOT_FOUND", async () => {
  const backend = await started({ trustLibraryAdminLoopback: false, libraryAdminToken: "sekret-token" });
  const read = async (libraryId: string, route: string, token?: string) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/${libraryId}/${route}`, { headers: token ? { "x-watchparty-admin": token } : {} }));
  try {
    for (const route of ["approvals", "duplicates"]) {
      const denied = await read("lib_anime", route);
      assert.equal(denied.status, 403, `${route} 无凭证必须 403（不是 401：管理面一律 ADMIN_FORBIDDEN）`);
      assert.equal((denied.body as { code: string }).code, "ADMIN_FORBIDDEN", `${route} 的拒绝码是 ADMIN_FORBIDDEN`);

      const wrong = await read("lib_anime", route, "not-the-token");
      assert.equal(wrong.status, 403);
      assert.equal((wrong.body as { code: string }).code, "ADMIN_FORBIDDEN");

      const missing = await read("lib_nope", route, "sekret-token");
      assert.equal(missing.status, 404, `${route} 查不存在的库必须 404`);
      assert.equal((missing.body as { code: string }).code, "MEDIA_NOT_FOUND");

      const ok = await read("lib_anime", route, "sekret-token");
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray((ok.body as { items: unknown[] }).items), `${route} 成功时 items 一定是数组`);
    }
  } finally {
    await backend.close();
  }
});

test("撤回会把被级联删掉的海报行接回来：缓存文件本来就在原位", () => {
  const { store, posterDir } = openStore();
  try {
    store.upsertScan("lib_tv", "tv", [group("/Clarks/Season 3", "荒原 S3", ["c1", "c2"]), group("/Clarks/Season 1", "Clarks Farm S1", ["c3", "c4"])]);
    const before = store.snapshotLibrary("lib_tv");
    const keep = before.find((card) => card.itemKey === "/Clarks/Season 1")!;
    const dropped = before.find((card) => card.itemKey === "/Clarks/Season 3")!;
    store.writePoster(dropped.id, "image/jpeg", Buffer.from("poster-bytes"));
    // 生产路径就是在改动之前抄一次海报行。
    const postersBefore = store.posterRows("lib_tv");
    assert.deepEqual(postersBefore.map((row) => row.itemId), [dropped.id]);

    assert.ok(store.mergeItems(keep.id, [dropped.id]));
    assert.equal(store.readPoster(dropped.id), undefined, "卡删了，poster_files 那行被级联删掉");
    assert.equal(fs.existsSync(path.join(posterDir, dropped.id)), true, "但磁盘上的缓存文件还在原位");

    const undo = diffSnapshots("lib_tv", before, store.snapshotLibrary("lib_tv"));
    assert.ok(undo);
    const touched = new Set([...undo.before, ...undo.after].map((card) => card.id));
    const outcome = store.restoreApplyUndo({ ...undo, posters: postersBefore.filter((row) => touched.has(row.itemId)) });
    assert.ok(!("conflict" in outcome), JSON.stringify(outcome));
    assert.equal(store.readPoster(dropped.id)?.bytes.toString(), "poster-bytes", "卡回来了，海报也必须回来");
    assert.equal(store.readPoster(dropped.id)?.contentType, "image/jpeg");
  } finally {
    store.close();
  }
});

test("开发期旁挂：镜像根里的 sidecar 读得到，导出仍然只落服务端根目录", async () => {
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "wp-mirror-"));
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-sidecar-server-"));
  const dir = path.join(mirror, "lib_anime", "Medalist");
  fs.mkdirSync(dir, { recursive: true });
  const doc = {
    schemaVersion: 1,
    libraryId: "lib_anime",
    basePath: "/Medalist",
    title: "旁挂写的标题",
    members: [{ path: "[VCB-Studio] Medalist [01][Ma10p_1080p].mkv" }, { path: "[VCB-Studio] Medalist [02][Ma10p_1080p].mkv" }],
  };
  fs.writeFileSync(path.join(dir, ".watchparty.collection.json"), JSON.stringify(doc));
  const backend = await started({ catalogSidecarDir: serverRoot, config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "secret-value", WATCHPARTY_CATALOG_MIRROR_ROOT: mirror }) });
  const api = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  try {
    assert.equal((await api("classify")).status, 200);
    const preview = await api("import/preview");
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.sources.map((row: { kind: string; collections: number }) => [row.kind, row.collections]), [["server", 0], ["mirror", 1]]);
    assert.deepEqual(preview.body.written.map((row: { itemKey: string }) => row.itemKey), ["/Medalist"]);
    const card = await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify?item=%2FMedalist`));
    assert.equal(card.body.card.title, "旁挂写的标题");

    // export 只往服务端根写，镜像里还是那一个文件。
    assert.equal((await api("import/export")).status, 200);
    assert.equal(fs.readdirSync(dir).length, 1, "镜像目录被写过 —— 旁挂必须只读");
    assert.ok(fs.existsSync(path.join(serverRoot, "lib_anime", "Medalist", ".watchparty.collection.json")), "导出的落点");

    // 同一个集合在两处各有一份：不许各认一次，报 claimed-by-two，谁都不写。
    fs.copyFileSync(path.join(serverRoot, "lib_anime", "Medalist", ".watchparty.collection.json"), path.join(dir, "dup.watchparty.collection.json"));
    const doubled = await api("import/preview");
    assert.equal(doubled.body.written.length, 0, "来源有歧义时一行都不写");
    // 三份都抢同一批文件：镜像原件 + 镜像副本 + 刚导出到服务端根的那份。
    assert.equal(doubled.body.collections, 3);
    assert.deepEqual(
      doubled.body.conflicts.map((row: { reason: string }) => row.reason),
      ["claimed-by-two", "claimed-by-two", "claimed-by-two"],
    );
    assert.equal(doubled.body.ambiguous.length, 2, "两个文件各被抢一次");
  } finally {
    await backend.close();
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

test("撤回窗口过了只清 undo：谁批的、什么时候用的，审计行还得读得到", () => {
  const { store } = openStore();
  try {
    store.writeScan("lib_tv", [{ relativePath: "/Show/S01E01.mkv", name: "S01E01.mkv", mediaId: "m1" }]);
    store.upsertScan("lib_tv", "tv", [group("/Show", "Show", ["m1"])]);
    const undo = {
      libraryId: "lib_tv",
      before: [],
      after: store.snapshotLibrary("lib_tv"),
      keys: ["/Show"],
      counts: { created: 1, removed: 0, changed: 0 },
      posters: [],
    };
    const approvalId = store.createApproval({
      tokenHash: "hash-1",
      libraryId: "lib_tv",
      draftRevision: 1,
      scanRevision: 1,
      operationHash: "ops-1",
      approvedBy: "网页",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    assert.ok(store.useApproval("hash-1"));
    store.setApprovalOutcome(approvalId, undo);
    assert.ok(store.readUndo(approvalId), "窗口内撤得掉");

    assert.equal(store.pruneExpiredUndo("2021-01-01T00:00:00.000Z"), 1);
    assert.equal(store.readUndo(approvalId), undefined, "过了窗口，反向操作回收");
    assert.equal(store.pruneExpiredUndo("2021-01-01T00:00:00.000Z"), 0, "第二次没有可清的");
    const row = store.findApprovalById(approvalId)!;
    assert.equal(row.approvedBy, "网页", "审计行留着：谁批的");
    assert.equal(row.usedAt !== null, true, "审计行留着：用过没有");
    assert.equal(row.appliedAt !== null, true, "审计行留着：什么时候应用的");
    assert.equal(row.rolledBackAt, null);
  } finally {
    store.close();
  }
});

test("撤回窗口就是凭证有效期：过了就只能前滚，签发时顺带回收并报数量", async () => {
  const backend = await started({ config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "secret-value", WATCHPARTY_CATALOG_APPROVAL_TTL_MS: "1200" }) });
  const api = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  const ledger = async () => (await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/approvals`))).body.items as Array<Record<string, unknown>>;
  try {
    await api("classify");
    await api("judge");
    const granted = await api("approval");
    assert.equal(granted.status, 200);
    assert.equal(granted.body.pruned, 0, "第一次没东西可回收");
    const applied = await api("apply-approved", { approvalToken: granted.body.approvalToken, force: 1 });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.rollbackAvailable, true);
    let rows = await ledger();
    assert.equal(rows[0].rollbackAvailable, true);
    assert.equal(rows[0].windowClosed, false);
    assert.deepEqual(rows[0].keys, ["/Medalist"], "窗口内连键位都还在，界面能写清要撤回什么");

    await new Promise((resolve) => setTimeout(resolve, 1400));

    rows = await ledger();
    assert.equal(rows[0].rollbackAvailable, false, "窗口过了就不能撤");
    assert.equal(rows[0].windowClosed, true);
    assert.equal(rows[0].keys, undefined, "键位随 undo 一起回收，但这一行还在");
    assert.equal(rows[0].approvedBy, "web");
    // 窗口判据必须排在读 undo 之前：签发这一刻会先回收过期 undo，
    // 若先读就会报成"那次应用没留台账"，把真原因说丢了。
    const refused = await api("approval", { rollbackOf: rows[0].approvalId });
    assert.equal(refused.status, 409);
    assert.equal((refused.body as { code: string }).code, "CATALOG_ROLLBACK_WINDOW_CLOSED");
    assert.equal((refused.body as { pruned: number }).pruned, 1, "这一次顺带回收了一条过期 undo");

    const next = await api("approval", { approvedBy: "网页" });
    assert.equal(next.status, 409, "这份草稿已应用完，没有新结构要批");
    assert.equal((next.body as { pruned: number }).pruned, 0, "回收只发生一次，不重复计数");
    const afterPrune = await ledger();
    assert.equal(afterPrune[0].windowClosed, true, "审计行还在，撤回权没了");
  } finally {
    await backend.close();
  }
});

test("快照把 size 一起存下来，没存的读回来是 null 而不是 0", () => {
  const { store } = openStore();
  try {
    store.writeScan("lib_anime", [
      { relativePath: "/A/one.mkv", name: "one.mkv", mediaId: "m1", size: 1234 },
      { relativePath: "/A/two.mkv", name: "two.mkv", mediaId: "m2" },
    ]);
    assert.deepEqual(
      store.readScan("lib_anime").map((file) => [file.relativePath, file.size]),
      [
        ["/A/one.mkv", 1234],
        ["/A/two.mkv", null],
      ],
    );
    // 重新枚举整批替换：旧行留下的 size 不会被当成新快照的答案。
    store.writeScan("lib_anime", [{ relativePath: "/A/one.mkv", name: "one.mkv", mediaId: "m1" }]);
    assert.equal(store.readScan("lib_anime")[0]?.size, null);
  } finally {
    store.close();
  }
});

test("size 校验的整条链：枚举存进快照 → 导出带上 → 改一个字节数就当冲突不写", async () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-sidecar-size-"));
  const backend = await started({ catalogSidecarDir: serverRoot });
  const api = async (route: string, body?: unknown) =>
    json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  const file = path.join(serverRoot, "lib_anime", "Medalist", ".watchparty.collection.json");
  try {
    // fakeTree 的两个文件都报 size 10，所以枚举后快照里就该有 10。
    assert.equal((await api("scan")).status, 200);
    assert.equal((await api("classify")).status, 200);
    assert.equal((await api("import/export")).status, 200);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(doc.members.map((member: { size: number }) => member.size), [10, 10], "导出的 size 取自快照，不是额外一次请求");

    const clean = await api("import/preview");
    assert.deepEqual(clean.body.sizeChecks, { compared: 2, mismatched: 0, unchecked: 0 }, "比过了，而且报得出来比过");
    assert.equal(clean.body.written.length, 1);

    doc.title = "换了内容的标题";
    doc.members[0].size = 999;
    fs.writeFileSync(file, JSON.stringify(doc));
    const tampered = await api("import/preview");
    assert.equal(tampered.body.sizeChecks.mismatched, 1);
    assert.deepEqual(
      tampered.body.conflicts.map((row: { reason: string }) => row.reason),
      ["size-mismatch"],
    );
    assert.deepEqual(tampered.body.conflicts[0].paths, ["/Medalist/[VCB-Studio] Medalist [01][Ma10p_1080p].mkv"]);
    assert.equal(tampered.body.written.length, 0, "内容换了一份，谁旧谁新判不出来，一行都不写");
    assert.equal((await json(await fetch(`${base(backend)}/api/admin/media-libraries/lib_anime/classify?item=%2FMedalist`))).body.card.title, "Medalist");
  } finally {
    await backend.close();
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});
