import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { openCatalogStore, structuralCount, structuralChanges, diffSnapshots } from "../media/catalog-store.ts";
import { exportOfflineBundle, inspectOfflineBundle, stageOfflineBundle, readOfflinePoster } from "../media/catalog-offline.ts";
import type { CatalogGroup } from "../media/catalog-names.ts";
import { createBackend } from "../app.ts";
import { loadConfig } from "../config.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-offline-"));
  const store = openCatalogStore(path.join(root, "catalog.sqlite"), path.join(root, "posters"));
  const group: CatalogGroup = { itemKey: "/Show", query: "Show", rawName: "Show", queries: ["Show"], files: [1, 2].map(n => ({ relativePath: `/Show/${n}.mkv`, name: `${n}.mkv`, mediaId: `target-${n}`, season: 1, episode: n })) };
  store.writeScan("lib_anime", group.files.map(file => ({ ...file, relativePath: file.relativePath!, size: 123 })));
  store.writeDraft("lib_anime", [group]);
  store.draftImport("lib_anime", "/Show", { title: "Show", externalDb: "bangumi", externalId: "1" });
  store.upsertScan("lib_anime", "anime", [group], false);
  store.applyDraftDecisions("lib_anime");
  const id = store.cardIds("lib_anime")[0];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=", "base64");
  store.writePoster(id, "image/png", png);
  const report = exportOfflineBundle(store, root, "lib_anime", "test-bundle");
  const directory = path.join(root, "offline-bundles/test-bundle");
  const edit = (transform: (collection: { members: Array<{ episode: number; title?: string; role: string }>; title: string }) => void) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    const descriptor = manifest.entries[0].collection;
    const collectionPath = path.join(directory, descriptor.file);
    const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
    transform(collection);
    const bytes = Buffer.from(JSON.stringify(collection));
    fs.writeFileSync(collectionPath, bytes);
    descriptor.sha256 = createHash("sha256").update(bytes).digest("hex");
    descriptor.bytes = bytes.length;
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    return inspectOfflineBundle(store, root, "lib_anime", "test-bundle").report;
  };
  const close = () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, store, group, id, png, report, edit, directory, close };
}

test("offline check is read-only; swapped episode numbers with identical coverage are a real diff, persist and rollback", () => {
  const f = fixture();
  try {
    const before = f.store.snapshotLibrary("lib_anime");
    const report = f.edit(collection => { collection.members[0].episode = 2; collection.members[0].title = "Second"; collection.members[1].episode = 1; });
    assert.equal(report.passed, true);
    assert.deepEqual(f.store.snapshotLibrary("lib_anime"), before);
    stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", report.bundleSha256);
    const diff = f.store.draftDiff("lib_anime");
    assert.equal(diff.confirmedDrift.length, 1);
    assert.deepEqual(diff.confirmedDrift[0].episodes, { from: 2, to: 2 });
    assert.equal(structuralCount(structuralChanges(diff)), 0);
    f.store.upsertScan("lib_anime", "anime", f.store.readDraft("lib_anime").map(card => ({ ...f.group, files: card.children })), false);
    f.store.applyDraftDecisions("lib_anime");
    assert.deepEqual(f.store.getDetail(f.id)?.children.map(child => [child.episode, child.episodeTitle]), [[2, "Second"], [1, null]]);
    const restarted = openCatalogStore(path.join(f.root, "catalog.sqlite"), path.join(f.root, "posters"));
    assert.deepEqual(restarted.getDetail(f.id)?.children.map(child => [child.episode, child.episodeTitle]), [[2, "Second"], [1, null]]);
    restarted.close();
    const undo = diffSnapshots("lib_anime", before, f.store.snapshotLibrary("lib_anime"))!;
    assert.deepEqual(f.store.restoreApplyUndo(undo), { applied: 1 });
    assert.deepEqual(f.store.snapshotLibrary("lib_anime"), before);
    f.store.close();
    const reopened = openCatalogStore(path.join(f.root, "catalog.sqlite"), path.join(f.root, "posters"));
    assert.equal(reopened.getDetail(f.id)?.children[0].episode, 1);
    reopened.close();
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("offline package rejects stale inventory, altered assets, unreviewed digests and unsafe bundle IDs", () => {
  const f = fixture();
  try {
    assert.throws(() => stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", "wrong"), /OFFLINE_CHECK_REQUIRED/);
    assert.throws(() => inspectOfflineBundle(f.store, f.root, "lib_anime", "../escape"), /OFFLINE_BUNDLE_ID_INVALID/);
    f.store.writeScan("lib_anime", [{ relativePath: "/Show/1.mkv", name: "1.mkv", mediaId: "target-1", size: 999 }]);
    const report = inspectOfflineBundle(f.store, f.root, "lib_anime", "test-bundle").report;
    assert.equal(report.passed, false);
    assert.ok(report.conflicts.some(item => item.reason === "size-mismatch"));
    assert.ok(report.conflicts.some(item => item.reason === "missing-file"));
    fs.appendFileSync(path.join(f.directory, "collections/0.json"), " ");
    assert.throws(() => inspectOfflineBundle(f.store, f.root, "lib_anime", "test-bundle"), /OFFLINE_ASSET_HASH_MISMATCH/);
  } finally { f.close(); }
});

test("human metadata conflict blocks staging; matching identity preserves human fields and permits episode enrichment", () => {
  const f = fixture();
  try {
    f.store.rebind(f.id, { externalDb: "bangumi", externalId: "1", title: "Show", overview: "Human overview" });
    const report = f.edit(collection => { collection.members[0].title = "Episode one"; });
    assert.equal(report.passed, true);
    stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", report.bundleSha256);
    assert.equal(f.store.readDraft("lib_anime")[0].overview, "Human overview");
    assert.equal(f.store.readDraft("lib_anime")[0].confirmedBy, "rebind");
    const conflict = f.edit(collection => { collection.title = "Different"; });
    assert.equal(conflict.passed, false);
    assert.ok(conflict.conflicts.some(item => item.reason === "human-decision-conflict"));
    assert.throws(() => stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", conflict.bundleSha256), /OFFLINE_CHECK_REQUIRED/);
  } finally { f.close(); }
});

test("new manually bound draft posters can be exported without applying the formal catalog", () => {
  const f = fixture();
  try {
    const before = f.store.snapshotLibrary("lib_anime");
    stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", f.report.bundleSha256);
    const posterUrl = f.store.readDraft("lib_anime")[0].posterUrl!;
    f.store.draftEdit("lib_anime", "/Show", { externalDb: "bangumi", externalId: "2", posterUrl });
    const report = exportOfflineBundle(f.store, f.root, "lib_anime", "new-binding");
    assert.equal(report.passed, true);
    assert.equal(report.posters, 1);
    assert.deepEqual(f.store.snapshotLibrary("lib_anime"), before);
    fs.appendFileSync(path.join(f.root, "offline-assets", posterUrl.slice(8)), "bad");
    assert.throws(() => exportOfflineBundle(f.store, f.root, "lib_anime", "corrupt-draft-poster"), /OFFLINE_POSTER_HASH_MISMATCH/);
  } finally { f.close(); }
});

test("offline posters are hash checked and immutable cache paths preserve old bytes", () => {
  const f = fixture();
  try {
    stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", f.report.bundleSha256);
    const reference = f.store.readDraft("lib_anime")[0].posterUrl!;
    assert.deepEqual(readOfflinePoster(f.root, reference).bytes, f.png);
    const old = f.store.posterRows("lib_anime")[0];
    f.store.writePoster(f.id, "image/png", Buffer.concat([f.png, Buffer.from("new")]));
    assert.deepEqual(fs.readFileSync(old.cachePath), f.png);
    assert.notEqual(f.store.posterRows("lib_anime")[0].cachePath, old.cachePath);
    fs.appendFileSync(path.join(f.root, "offline-assets", reference.slice(8)), "bad");
    assert.throws(() => readOfflinePoster(f.root, reference), /OFFLINE_POSTER_HASH_MISMATCH/);
  } finally { f.close(); }
});

test("HTTP offline staging and apply work without vendors; explicit bonus nulls and titles survive restart", async () => {
  const f = fixture();
  const report = f.edit(collection => {
    collection.members[0].title = "Portable title";
    Object.assign(collection.members[1], { season: null, episode: null, role: "bonus" });
  });
  f.store.close();
  let externalCalls = 0;
  const unavailable = async () => { externalCalls++; throw new Error("Offline path called a vendor"); };
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "fixture-only", WATCHPARTY_CATALOG_APPROVAL_SECRET: "human-fixture" }),
    catalogDbPath: path.join(f.root, "catalog.sqlite"), posterDir: path.join(f.root, "posters"), catalogSidecarDir: f.root,
    bangumi: { search: unavailable, episodeTitles: unavailable }, tmdb: { search: unavailable }, fetchPoster: unavailable });
  await backend.start();
  const origin = `http://127.0.0.1:${backend.port}`;
  const post = (action: string, body: unknown = {}) => fetch(`${origin}/api/admin/media-libraries/lib_anime/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post("import/offline-check", { bundleId: "test-bundle" })).status, 200);
    assert.equal((await post("import/offline-stage", { bundleId: "test-bundle", bundleSha256: report.bundleSha256 })).status, 200);
    assert.equal((await post("approval")).status, 401);
    assert.equal((await post("apply")).status, 200);
    const response = await fetch(`${origin}/api/media/catalog/${f.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.children[0].episodeTitle, "Portable title");
    assert.equal(detail.children[1].episode, null);
    assert.equal(detail.subtitle, null);
    assert.equal((await fetch(`${origin}/api/media/posters/${f.id}`)).status, 200);
    assert.equal(externalCalls, 0);
    await backend.close();
    const reopened = openCatalogStore(path.join(f.root, "catalog.sqlite"), path.join(f.root, "posters"));
    assert.equal(reopened.getDetail(f.id)?.children[0].episodeTitle, "Portable title");
    assert.equal(reopened.getDetail(f.id)?.children[1].episode, null);
    reopened.close();
  } finally { await backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an accepted scan blocks offline staging until it settles", async () => {
  const f = fixture();
  f.store.close();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false, syncGraceMs: 5,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "fixture-only" }),
    catalogDbPath: path.join(f.root, "catalog.sqlite"), posterDir: path.join(f.root, "posters"), catalogSidecarDir: f.root,
    libraryClientFactory: () => ({
      async list() { await barrier; return { code: 200, data: { content: [] } }; },
      async listShallow() { return { code: 200, data: { content: [] } }; },
      async search() { return { code: 200, data: { content: [] } }; },
      async getDownloadInfo() { return null; }, async getLinkInfo() { return null; },
      async fetchOriginText() { return undefined; }, async ping() { return { ok: true }; },
    }) });
  await backend.start();
  const origin = `http://127.0.0.1:${backend.port}/api/admin/media-libraries/lib_anime`;
  try {
    assert.equal((await fetch(`${origin}/scan`, { method: "POST" })).status, 202);
    const response = await fetch(`${origin}/import/offline-stage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundleId: "test-bundle", bundleSha256: f.report.bundleSha256 }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "OFFLINE_LIBRARY_BUSY");
  } finally {
    release();
    for (let attempts = 0; attempts < 100; attempts++) {
      if (!(await (await fetch(`${origin}/scan`)).json()).running) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await backend.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("unassigned files block import; retained exclusions still require human structural approval and survive rollback", async () => {
  const f = fixture();
  const report = f.edit(collection => { collection.members.pop(); });
  assert.equal(report.passed, false);
  assert.deepEqual(report.unassigned, ["/Show/2.mkv"]);
  assert.throws(() => stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", report.bundleSha256), /OFFLINE_CHECK_REQUIRED/);
  f.store.markExcluded("lib_anime", ["/Show/2.mkv"], "");
  const inspected = inspectOfflineBundle(f.store, f.root, "lib_anime", "test-bundle").report;
  assert.equal(inspected.passed, true);
  stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", inspected.bundleSha256);
  assert.equal(f.store.exclusions("lib_anime").excluded, 1);
  f.store.close();
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "fixture-only", WATCHPARTY_CATALOG_APPROVAL_SECRET: "human-fixture" }),
    catalogDbPath: path.join(f.root, "catalog.sqlite"), posterDir: path.join(f.root, "posters"), catalogSidecarDir: f.root,
    bangumi: { async search() { return []; }, async episodeTitles() { return new Map(); } } });
  await backend.start();
  const origin = `http://127.0.0.1:${backend.port}/api/admin/media-libraries/lib_anime`;
  const post = (action: string, body: unknown = {}, approve = false) => fetch(`${origin}/${action}`, { method: "POST",
    headers: { "content-type": "application/json", ...(approve ? { "x-watchparty-approval": "human-fixture" } : {}) }, body: JSON.stringify(body) });
  try {
    const refused = await post("apply");
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "CATALOG_APPROVAL_REQUIRED");
    assert.equal((await post("approval")).status, 401);
    const approvalResponse = await post("approval", {}, true);
    assert.equal(approvalResponse.status, 200);
    const approval = await approvalResponse.json();
    const applied = await post("apply-approved", { approvalToken: approval.approvalToken });
    assert.equal(applied.status, 200);
    const outcome = await applied.json();
    assert.equal(outcome.rollbackAvailable, true);
    const rollbackApproval = await (await post("approval", { rollbackOf: outcome.approvalId }, true)).json();
    assert.equal((await post("rollback", { rollbackOf: outcome.approvalId, approvalToken: rollbackApproval.approvalToken })).status, 200);
    const exclusions = await (await fetch(`${origin}/exclusions`)).json();
    assert.equal(exclusions.excluded, 1);
    const detail = await (await fetch(`http://127.0.0.1:${backend.port}/api/media/catalog/${f.id}`)).json();
    assert.equal(detail.children.length, 2);
  } finally { await backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("package budget and linked parent directories are rejected before staging", () => {
  const f = fixture();
  try {
    const manifestFile = path.join(f.directory, "manifest.json");
    const original = fs.readFileSync(manifestFile);
    const manifest = JSON.parse(original.toString());
    manifest.entries[0].collection.bytes = 300 * 1024 * 1024;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => inspectOfflineBundle(f.store, f.root, "lib_anime", "test-bundle"), /OFFLINE_BUNDLE_TOO_LARGE/);
    fs.writeFileSync(manifestFile, original);
    const linked = path.join(f.root, "offline-assets");
    const actual = path.join(f.root, "actual-assets");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => stageOfflineBundle(f.store, f.root, "lib_anime", "test-bundle", f.report.bundleSha256), /OFFLINE_SYMLINK_REJECTED/);
    assert.equal(fs.readdirSync(actual).length, 0);
  } finally { f.close(); }
});

test("explicit missing-human deletion is revision checked, staged only and cannot bypass approval", async () => {
  const f = fixture();
  f.store.rebind(f.id, { title: "Human show", externalDb: "bangumi", externalId: "1" });
  const group: CatalogGroup = { itemKey: "/New", query: "New", rawName: "New", queries: ["New"],
    files: [{ name: "New 01.mkv", relativePath: "/New/01.mkv", mediaId: "new-target", season: 1, episode: 1 }] };
  f.store.writeScan("lib_anime", group.files.map(file => ({ ...file, relativePath: file.relativePath!, size: 123 })));
  f.store.writeDraft("lib_anime", [group]);
  f.store.draftImport("lib_anime", "/New", { title: "New", externalDb: "bangumi", externalId: "2" });
  const omitted = exportOfflineBundle(f.store, f.root, "lib_anime", "omitted");
  assert.equal(omitted.passed, false);
  assert.ok(omitted.conflicts.some(conflict => conflict.reason === "human-card-omitted"));
  const proposal = exportOfflineBundle(f.store, f.root, "lib_anime", "explicit", ["/Show"]);
  assert.equal(proposal.passed, true);
  assert.equal(proposal.deletionProposals.length, 1);
  f.store.rebind(f.id, { title: "Later human change", externalDb: "bangumi", externalId: "1" });
  assert.ok(inspectOfflineBundle(f.store, f.root, "lib_anime", "explicit").report.conflicts.some(conflict => conflict.reason === "deletion-proposal-stale"));
  assert.throws(() => stageOfflineBundle(f.store, f.root, "lib_anime", "explicit", proposal.bundleSha256), /OFFLINE_CHECK_REQUIRED/);
  f.store.rebind(f.id, { title: "Human show", externalDb: "bangumi", externalId: "1" });
  f.store.writeScan("lib_anime", [...group.files.map(file => ({ ...file, relativePath: file.relativePath!, size: 123 })), { name: "1.mkv", relativePath: "/Show/1.mkv", mediaId: "returned-file", size: 123 }]);
  assert.ok(inspectOfflineBundle(f.store, f.root, "lib_anime", "explicit").report.conflicts.some(conflict => conflict.reason === "deletion-proposal-stale"));
  f.store.writeScan("lib_anime", group.files.map(file => ({ ...file, relativePath: file.relativePath!, size: 123 })));
  const before = f.store.snapshotLibrary("lib_anime");
  stageOfflineBundle(f.store, f.root, "lib_anime", "explicit", proposal.bundleSha256);
  assert.deepEqual(f.store.snapshotLibrary("lib_anime"), before);
  assert.ok(f.store.draftDiff("lib_anime").dropped.some(card => card.itemKey === "/Show"));
  f.store.close();
  const backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false,
    config: loadConfig({ NODE_ENV: "test", OPENLIST_PASSWORD: "fixture-only", WATCHPARTY_CATALOG_APPROVAL_SECRET: "human-fixture" }),
    catalogDbPath: path.join(f.root, "catalog.sqlite"), posterDir: path.join(f.root, "posters"), catalogSidecarDir: f.root });
  await backend.start();
  try {
    const origin = `http://127.0.0.1:${backend.port}`;
    const apply = await fetch(`${origin}/api/admin/media-libraries/lib_anime/apply`, { method: "POST" });
    assert.equal(apply.status, 409);
    assert.equal((await apply.json()).code, "CATALOG_APPROVAL_REQUIRED");
    const approval = await fetch(`${origin}/api/admin/media-libraries/lib_anime/approval`, { method: "POST" });
    assert.equal(approval.status, 401);
    const store = openCatalogStore(path.join(f.root, "catalog.sqlite"), path.join(f.root, "posters"));
    assert.deepEqual(store.snapshotLibrary("lib_anime"), before);
    store.close();
  } finally { await backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
