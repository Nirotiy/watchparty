import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCollection, collectionJson, collectionPath, parseCollection, resolveMemberPaths } from "./collection-sidecar.ts";
import type { CollectionSidecar } from "./collection-sidecar.ts";
import type { CatalogStore, DraftPatch, CatalogCardSnapshot } from "./catalog-store.ts";
import type { CatalogGroup, ScanFile } from "./catalog-names.ts";

type InventoryFile = { relativePath: string; size: number | null };
type Asset = { file: string; sha256: string; bytes: number; contentType?: string };
type Entry = { itemKey: string; collection: Asset; poster?: Asset };
type DeletionProposal = { itemKey: string; decisionSha256: string; reason: "all-files-missing" };
type Manifest = {
  format: "watchparty-offline-catalog";
  version: 1;
  libraryId: string;
  createdAt: string;
  inventory: InventoryFile[];
  inventorySha256: string;
  entries: Entry[];
  exclusions: Array<{ relativePath: string; reason: string }>;
  deletions: DeletionProposal[];
};
export type OfflineReport = {
  bundleId: string;
  bundleSha256: string;
  libraryId: string;
  inventorySha256: string;
  cards: number;
  members: number;
  posters: number;
  exclusions: number;
  conflicts: Array<{ reason: string; path?: string; itemKey?: string }>;
  uncheckedSizes: number;
  unassigned: string[];
  passed: boolean;
  deletionProposals: DeletionProposal[];
};

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const BUNDLE_CAP_BYTES = 256 * 1024 * 1024;

function rejectLinks(location: string): void {
  let current = path.resolve(location);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("OFFLINE_SYMLINK_REJECTED");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export function inventoryOf(files: ScanFile[]): InventoryFile[] {
  return files.map(file => ({ relativePath: file.relativePath, size: file.size ?? null })).sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
}
export const inventoryDigest = (files: InventoryFile[]) => sha(JSON.stringify(files));

function deletionDigest(card: CatalogCardSnapshot): string {
  return sha(JSON.stringify({ itemKey: card.itemKey, title: card.title, originalTitle: card.originalTitle,
    year: card.year, overview: card.overview, externalDb: card.externalDb, externalId: card.externalId, confirmedBy: card.confirmedBy,
    children: card.children.map(child => [child.relPath, child.season, child.episode, child.episodeTitle ?? null, child.role ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en")) }));
}

export function bundleDirectory(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("OFFLINE_BUNDLE_ID_INVALID");
  const directory = path.join(root, "offline-bundles", id);
  rejectLinks(directory);
  return directory;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OFFLINE_BUNDLE_INVALID");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("OFFLINE_BUNDLE_INVALID");
  return value;
}
function list(value: unknown, max = 20000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("OFFLINE_BUNDLE_INVALID");
  return value;
}
function relative(value: unknown): string {
  const raw = string(value);
  if (collectionPath("/", raw) !== raw || !raw.startsWith("/")) throw new Error("OFFLINE_PATH_INVALID");
  return raw;
}
function itemKeyOf(value: unknown): string {
  const key = string(value);
  return /^#split\/[a-zA-Z0-9_-]+$/.test(key) ? key : relative(key);
}
function bytesAt(root: string, file: string, limit: number): Buffer {
  if (!/^(collections|posters)\/[a-zA-Z0-9_-]+\.(json|jpg|png|webp)$/.test(file)) throw new Error("OFFLINE_ASSET_PATH_INVALID");
  const location = path.join(root, file);
  rejectLinks(location);
  const stat = fs.statSync(location);
  if (!stat.isFile() || stat.size > limit) throw new Error("OFFLINE_ASSET_TOO_LARGE");
  return fs.readFileSync(location);
}
export function imageType(bytes: Buffer): string {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("OFFLINE_POSTER_FORMAT_INVALID");
}
function asset(value: unknown): Asset {
  const row = record(value);
  const hash = string(row.sha256, 64);
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1) throw new Error("OFFLINE_ASSET_INVALID");
  return { file: string(row.file), sha256: hash, bytes: Number(row.bytes), ...(row.contentType ? { contentType: string(row.contentType, 40) } : {}) };
}

/** Fixed schema exports metadata only, never DB records, credentials or media IDs. */
export function exportOfflineBundle(catalog: CatalogStore, root: string, libraryId: string, bundleId: string, deletionKeys: string[] = []): OfflineReport {
  const directory = bundleDirectory(root, bundleId);
  if (fs.existsSync(directory)) throw new Error("OFFLINE_BUNDLE_EXISTS");
  const cards = catalog.readDraft(libraryId);
  if (!cards.length || cards.some(card => card.lookupState === "pending")) throw new Error("OFFLINE_DRAFT_NOT_READY");
  const scan = catalog.readScan(libraryId);
  const inventory = inventoryOf(scan);
  const formal = catalog.snapshotLibrary(libraryId);
  if (new Set(deletionKeys).size !== deletionKeys.length) throw new Error("OFFLINE_DELETION_INVALID");
  const deletions: DeletionProposal[] = deletionKeys.map(key => {
    const card = formal.find(card => card.itemKey === key);
    if (!card || card.status !== "confirmed" || card.confirmedBy === "auto" || !card.children.length ||
      cards.some(draft => draft.itemKey === key) || card.children.some(child => !child.relPath || scan.some(file => file.relativePath === child.relPath))) throw new Error("OFFLINE_DELETION_INVALID");
    return { itemKey: key, decisionSha256: deletionDigest(card), reason: "all-files-missing" };
  });
  fs.mkdirSync(path.join(directory, "collections"), { recursive: true });
  fs.mkdirSync(path.join(directory, "posters"));
  const entries: Entry[] = [];
  for (const [index, draft] of cards.entries()) {
    const match = formal.find(card => card.itemKey === draft.itemKey) ?? formal.find(card => card.children.length === draft.children.length && card.children.every(child => draft.children.some(file => file.relativePath === child.relPath)));
    const protectedCard = match && match.status === "confirmed" && match.confirmedBy !== "auto" ? match : undefined;
    const metadata = protectedCard ?? draft;
    const collection = buildCollection(libraryId, null, { ...metadata, posterUrl: null, children: draft.children, sizeByPath: new Map(scan.map(file => [file.relativePath, file.size ?? null])) });
    collection.members.forEach((member, memberIndex) => {
      const child = draft.children[memberIndex];
      member.title = child.episodeTitle ?? null;
      member.role = child.role ?? (child.bonus ? "bonus" : child.episode !== null ? "episode" : "other");
    });
    // Poster bytes travel separately; collection files contain no network URLs.
    collection.poster = null;
    const content = Buffer.from(collectionJson(collection));
    const file = `collections/${index}.json`;
    fs.writeFileSync(path.join(directory, file), content, { flag: "wx" });
    const entry: Entry = { itemKey: draft.itemKey, collection: { file, sha256: sha(content), bytes: content.length } };
    const formalPoster = match && match.externalDb === metadata.externalDb && match.externalId === metadata.externalId ? catalog.readPoster(match.id) : undefined;
    const poster = formalPoster ?? (!protectedCard && draft.posterUrl?.startsWith("offline:") ? readOfflinePoster(root, draft.posterUrl) : undefined);
    if (poster) {
      const contentType = imageType(poster.bytes);
      const posterFile = `posters/${index}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}`;
      fs.writeFileSync(path.join(directory, posterFile), poster.bytes, { flag: "wx" });
      entry.poster = { file: posterFile, sha256: sha(poster.bytes), bytes: poster.bytes.length, contentType };
    }
    entries.push(entry);
  }
  const manifest: Manifest = { format: "watchparty-offline-catalog", version: 1, libraryId, createdAt: new Date().toISOString(), inventory, inventorySha256: inventoryDigest(inventory), entries,
    exclusions: catalog.exclusions(libraryId).items.map(item => ({ relativePath: item.relativePath, reason: item.reason })), deletions };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return inspectOfflineBundle(catalog, root, libraryId, bundleId).report;
}

/** Checks are read-only. The digest binds later staging to the reviewed package. */
export function inspectOfflineBundle(catalog: CatalogStore, root: string, libraryId: string, bundleId: string) {
  const directory = bundleDirectory(root, bundleId);
  const manifestPath = path.join(directory, "manifest.json");
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(manifestPath).isSymbolicLink() || fs.statSync(manifestPath).size > 8 * 1024 * 1024) throw new Error("OFFLINE_MANIFEST_INVALID");
  const manifestBytes = fs.readFileSync(manifestPath);
  const row = record(JSON.parse(manifestBytes.toString()));
  if (row.format !== "watchparty-offline-catalog" || row.version !== 1) throw new Error("OFFLINE_VERSION_INVALID");
  const sourceLibrary = string(row.libraryId, 80);
  const inventory = list(row.inventory).map(value => {
    const file = record(value);
    if (file.size !== null && (!Number.isSafeInteger(file.size) || Number(file.size) < 0)) throw new Error("OFFLINE_SIZE_INVALID");
    return { relativePath: relative(file.relativePath), size: file.size === null ? null : Number(file.size) };
  });
  const inventoryByPath = new Map(inventory.map(file => [file.relativePath, file]));
  if (inventoryByPath.size !== inventory.length || inventoryDigest(inventory) !== row.inventorySha256) throw new Error("OFFLINE_INVENTORY_INVALID");
  const scan = catalog.readScan(libraryId);
  const target = new Map(scan.map(file => [file.relativePath, file]));
  const conflicts: OfflineReport["conflicts"] = [];
  let uncheckedSizes = 0;
  for (const file of inventory) {
    const actual = target.get(file.relativePath);
    if (!actual) conflicts.push({ reason: "missing-file", path: file.relativePath });
    else if (actual.size == null || file.size === null) uncheckedSizes++;
    else if (actual.size !== file.size) conflicts.push({ reason: "size-mismatch", path: file.relativePath });
  }
  for (const file of scan) if (!inventoryByPath.has(file.relativePath)) conflicts.push({ reason: "new-target-file", path: file.relativePath });
  const exclusions = list(row.exclusions).map(value => {
    const item = record(value);
    if (typeof item.reason !== "string" || item.reason.length > 500) throw new Error("OFFLINE_BUNDLE_INVALID");
    return { relativePath: relative(item.relativePath), reason: item.reason };
  });
  const excluded = new Set([...exclusions.map(item => item.relativePath), ...catalog.exclusions(libraryId).items.map(item => item.relativePath)]);
  for (const item of exclusions) if (!inventoryByPath.has(item.relativePath)) conflicts.push({ reason: "stale-exclusion", path: item.relativePath });
  const claims = new Set<string>();
  const keys = new Set<string>();
  const formal = catalog.snapshotLibrary(libraryId);
  const protectedDrafts = catalog.readDraft(libraryId).filter(card => card.confirmedBy && card.confirmedBy !== "auto");
  const deletions = list(row.deletions ?? [], 100).map(value => {
    const proposal = record(value);
    if (proposal.reason !== "all-files-missing" || typeof proposal.decisionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(proposal.decisionSha256)) throw new Error("OFFLINE_DELETION_INVALID");
    return { itemKey: itemKeyOf(proposal.itemKey), decisionSha256: proposal.decisionSha256, reason: "all-files-missing" as const };
  });
  const validDeletions = new Set<string>();
  for (const proposal of deletions) {
    if (validDeletions.has(proposal.itemKey)) throw new Error("OFFLINE_DELETION_INVALID");
    const card = formal.find(card => card.itemKey === proposal.itemKey);
    if (!card || card.status !== "confirmed" || card.confirmedBy === "auto" || deletionDigest(card) !== proposal.decisionSha256 ||
      !card.children.length || card.children.some(child => !child.relPath || target.has(child.relPath)) || protectedDrafts.some(draft => draft.itemKey === proposal.itemKey)) {
      conflicts.push({ reason: "deletion-proposal-stale", itemKey: proposal.itemKey });
    } else validDeletions.add(proposal.itemKey);
  }
  const cards: Array<{ group: CatalogGroup; metadata: DraftPatch }> = [];
  const posters: Array<{ itemKey: string; bytes: Buffer; contentType: string; sha256: string }> = [];
  let totalBytes = manifestBytes.length;
  const readAsset = (descriptor: Asset, limit: number) => {
    totalBytes += descriptor.bytes;
    if (totalBytes > BUNDLE_CAP_BYTES) throw new Error("OFFLINE_BUNDLE_TOO_LARGE");
    const bytes = bytesAt(directory, descriptor.file, limit);
    if (bytes.length !== descriptor.bytes || sha(bytes) !== descriptor.sha256) throw new Error("OFFLINE_ASSET_HASH_MISMATCH");
    return bytes;
  };
  for (const value of list(row.entries, 2000)) {
    const entry = record(value);
    const itemKey = itemKeyOf(entry.itemKey);
    if (validDeletions.has(itemKey)) throw new Error("OFFLINE_DELETION_INVALID");
    if (keys.has(itemKey)) throw new Error("OFFLINE_DUPLICATE_KEY");
    keys.add(itemKey);
    const descriptor = asset(entry.collection);
    const content = readAsset(descriptor, 1024 * 1024);
    const parsed = parseCollection(descriptor.file, content.toString());
    if (!parsed.sidecar || parsed.errors.length || parsed.warnings.length) throw new Error("OFFLINE_COLLECTION_INVALID");
    const collection: CollectionSidecar = parsed.sidecar;
    if (collection.libraryId !== sourceLibrary) throw new Error("OFFLINE_LIBRARY_MAPPING_INVALID");
    const paths = resolveMemberPaths(collection).paths;
    const files = collection.members.flatMap((member, index) => {
      const relativePath = paths[index];
      const actual = target.get(relativePath);
      if (!inventoryByPath.has(relativePath) || !actual) { conflicts.push({ reason: "member-not-in-inventory", path: relativePath }); return []; }
      if (claims.has(relativePath)) conflicts.push({ reason: "duplicate-claim", path: relativePath });
      claims.add(relativePath);
      if (excluded.has(relativePath)) conflicts.push({ reason: "excluded-member", path: relativePath });
      if (member.size !== inventoryByPath.get(relativePath)?.size) conflicts.push({ reason: "member-size-mismatch", path: relativePath });
      if ([member.season, member.episode].some(number => number !== null && (!Number.isSafeInteger(number) || number < 0))) throw new Error("OFFLINE_EPISODE_INVALID");
      return [{ mediaId: actual.mediaId, name: actual.name, relativePath, season: member.season, episode: member.episode, episodeTitle: member.title, role: member.role, bonus: member.role === "bonus" }];
    });
    if (!collection.title) throw new Error("OFFLINE_TITLE_REQUIRED");
    const metadata: DraftPatch = { title: collection.title, originalTitle: collection.originalTitle, year: collection.year, overview: collection.overview, externalDb: collection.externalDb, externalId: collection.externalId, posterUrl: null };
    for (const protectedCard of [...formal.filter(card => card.status === "confirmed" && card.confirmedBy !== "auto"), ...protectedDrafts]) {
      const pathsOwned = protectedCard.children.map(child => "relPath" in child ? child.relPath : child.relativePath);
      if (protectedCard.itemKey !== itemKey && !pathsOwned.some(file => paths.includes(file ?? ""))) continue;
      if (protectedCard.title !== metadata.title || protectedCard.externalDb !== metadata.externalDb || protectedCard.externalId !== metadata.externalId || protectedCard.itemKey !== itemKey) conflicts.push({ reason: "human-decision-conflict", itemKey: protectedCard.itemKey });
      // Keep every human metadata field, even when the portable package agrees on identity.
      else Object.assign(metadata, { title: protectedCard.title, originalTitle: protectedCard.originalTitle, year: protectedCard.year, overview: protectedCard.overview });
    }
    if (entry.poster) {
      const descriptor = asset(entry.poster);
      const bytes = readAsset(descriptor, 10 * 1024 * 1024);
      const contentType = imageType(bytes);
      if (sha(bytes) !== descriptor.sha256 || bytes.length !== descriptor.bytes || contentType !== descriptor.contentType) throw new Error("OFFLINE_POSTER_HASH_MISMATCH");
      metadata.posterUrl = `offline:${descriptor.sha256}`;
      posters.push({ itemKey, bytes, contentType, sha256: descriptor.sha256 });
    }
    cards.push({ group: { itemKey, query: collection.title, queries: [collection.title], rawName: itemKey.split("/").at(-1) ?? collection.title, files }, metadata });
  }
  for (const protectedCard of [...formal.filter(card => card.status === "confirmed" && card.confirmedBy !== "auto"), ...protectedDrafts]) {
    if (!keys.has(protectedCard.itemKey) && !validDeletions.has(protectedCard.itemKey)) conflicts.push({ reason: "human-card-omitted", itemKey: protectedCard.itemKey });
  }
  const unassigned = scan.filter(file => !claims.has(file.relativePath) && !excluded.has(file.relativePath)).map(file => file.relativePath);
  const report: OfflineReport = { bundleId, bundleSha256: sha(manifestBytes), libraryId, inventorySha256: inventoryDigest(inventoryOf(scan)), cards: cards.length, members: claims.size, posters: posters.length, exclusions: exclusions.length, conflicts, uncheckedSizes, unassigned, deletionProposals: deletions, passed: conflicts.length === 0 && uncheckedSizes === 0 && unassigned.length === 0 && cards.length > 0 };
  return { report, cards, posters, exclusions };
}

export function stageOfflineBundle(catalog: CatalogStore, root: string, libraryId: string, bundleId: string, expectedDigest: string) {
  const inspected = inspectOfflineBundle(catalog, root, libraryId, bundleId);
  if (!inspected.report.passed || inspected.report.bundleSha256 !== expectedDigest) throw new Error("OFFLINE_CHECK_REQUIRED");
  const assets = path.join(root, "offline-assets");
  rejectLinks(assets);
  fs.mkdirSync(assets, { recursive: true });
  for (const poster of inspected.posters) {
    const destination = path.join(assets, poster.sha256);
    rejectLinks(destination);
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, poster.bytes, { flag: "wx" });
    if (sha(fs.readFileSync(destination)) !== poster.sha256) throw new Error("OFFLINE_STAGED_ASSET_CORRUPT");
  }
  catalog.stageOffline(libraryId, inspected.cards, inspected.exclusions);
  return { ...inspected.report, staged: true, diff: catalog.draftDiff(libraryId) };
}

export function readOfflinePoster(root: string, reference: string) {
  if (!/^offline:[a-f0-9]{64}$/.test(reference)) throw new Error("OFFLINE_POSTER_REFERENCE_INVALID");
  const hash = reference.slice(8);
  const file = path.join(root, "offline-assets", hash);
  rejectLinks(file);
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error("OFFLINE_POSTER_INVALID");
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== hash) throw new Error("OFFLINE_POSTER_HASH_MISMATCH");
  return { bytes, contentType: imageType(bytes) };
}
