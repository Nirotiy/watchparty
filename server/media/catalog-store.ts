import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { episodeSubtitle, titleCandidates, type CatalogGroup, type CatalogGroupFile, type ScanFile } from "./catalog-names.ts";
import { compatibilityOf, extensionOf } from "./library-browser.ts";
import type { MediaCompatibility } from "./watchparty-media.ts";
import type { MetadataDb, RankedHit } from "./catalog-metadata.ts";
import type { LibraryKind } from "./library-store.ts";

export type CatalogStatus = "unmatched" | "candidate" | "confirmed" | "rejected";

export type ScrapeJob = {
  libraryId: string;
  status: "running" | "done" | "failed";
  total: number;
  scanned: number;
  matched: number;
  enumerated: boolean;
  lastError: string | null;
};

export type PendingItem = {
  id: string;
  libraryId: string;
  itemKey: string;
  kind: LibraryKind;
  query: string;
  rawName: string;
  subtitle: string | null;
  fileCount: number;
  /**
   * File names under this item, used to rebuild the title candidates at lookup
   * time. Persisting `queries` instead would need a column; the children already
   * carry the names, so a re-scan can never leave a stale candidate list behind.
   */
  fileNames: string[];
};

export type CatalogCard = {
  id: string;
  title: string;
  year: number | null;
  kind: LibraryKind;
  status: CatalogStatus;
  posterUrl: string | null;
  subtitle: string | null;
};

export type CatalogDetail = CatalogCard & {
  originalTitle: string | null;
  overview: string | null;
  /**
   * Which subject the card is bound to. The list payload stays lean and omits it,
   * but a person correcting a binding has to be able to see what is bound now -
   * `rebind` takes the same pair, so the round trip is symmetric.
   */
  externalDb: string | null;
  externalId: string | null;
  candidates: Array<{ id: string; title: string; year: number | null; score: number }>;
  children: Array<{
    mediaId: string;
    name: string;
    season: number | null;
    episode: number | null;
    /**
     * Computed from the file name, same rule the browser listing uses, so a
     * catalog card can tell "this episode needs MPV" without a second request.
     */
    compatibility: MediaCompatibility;
  }>;
};

/**
 * A human's answer for one card: the subject they picked themselves, after
 * searching the vendor by hand. `confirm` only accepts a stored candidate, which
 * is dead-ended whenever the scrape never proposed the right one (a trilogy box
 * set, a same-title ambiguity with no year in the folder).
 */
export type ManualBinding = {
  externalDb: MetadataDb;
  externalId: string;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  overview?: string | null;
  imageUrl?: string | null;
};

export type CatalogStore = {
  close(): void;
  getJob(libraryId: string): ScrapeJob | undefined;
  listRunningJobs(): ScrapeJob[];
  markRunning(libraryId: string, reset: boolean): void;
  upsertScan(libraryId: string, kind: LibraryKind, groups: CatalogGroup[]): void;
  listPending(libraryId: string): PendingItem[];
  rejectionKeys(libraryId: string, itemKey: string): Set<string>;
  applyMatch(item: PendingItem, status: CatalogStatus, chosen: RankedHit | null, candidates: RankedHit[]): void;
  bumpJob(libraryId: string, matched: boolean): void;
  finishJob(libraryId: string): void;
  failJob(libraryId: string, code: string): void;
  listCards(libraryId: string, cursor: string | undefined, query: string | undefined): { items: CatalogCard[]; hasMore: boolean; nextCursor?: string };
  getDetail(id: string): CatalogDetail | undefined;
  confirm(itemId: string, candidateId: string): { imageUrl: string | null } | undefined;
  reject(itemId: string, candidateId: string): boolean;
  /** 撤销一次确认：卡片退回待判定，绑定清空，文件留在原处。 */
  unconfirm(itemId: string): CatalogDetail | undefined;
  /** 人工直填条目（配合 `/api/media/bangumi/search`），不要求它是刮出来的候选。 */
  rebind(itemId: string, choice: ManualBinding): { imageUrl: string | null } | undefined;
  /** 多张卡并成一张：文件与人工绑定合到 keepId，其余行删除。 */
  mergeItems(keepId: string, dropIds: string[]): CatalogDetail | undefined;
  /** 一张卡按文件拆成多张：首组留在原卡，其余新建待判定卡。 */
  splitItem(itemId: string, groups: string[][]): CatalogDetail[] | undefined;
  /** 快照：一次枚举的完整文件列表，供离线分类反复跑。 */
  writeScan(libraryId: string, files: ScanFile[]): number;
  readScan(libraryId: string): ScanFile[];
  scanInfo(libraryId: string): { files: number; enumeratedAt: string | null };
  writePoster(itemId: string, contentType: string, bytes: Buffer): void;
  readPoster(itemId: string): { contentType: string; bytes: Buffer } | undefined;
};

const PAGE_SIZE = 100;

export function openCatalogStore(dbPath: string, posterDir: string): CatalogStore {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.mkdirSync(posterDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      query TEXT NOT NULL,
      raw_name TEXT NOT NULL,
      title TEXT NOT NULL,
      original_title TEXT,
      year INTEGER,
      overview TEXT,
      external_db TEXT,
      external_id TEXT,
      status TEXT NOT NULL,
      lookup_state TEXT NOT NULL,
      subtitle TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (library_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS catalog_children (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL,
      name TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      sort_index INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_candidates (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      external_db TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      score REAL NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (item_id, external_db, external_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_rejections (
      library_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      external_db TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (library_id, item_key, external_db, external_id)
    );
    CREATE TABLE IF NOT EXISTS poster_files (
      item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      cache_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      library_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      total INTEGER NOT NULL,
      scanned INTEGER NOT NULL,
      matched INTEGER NOT NULL,
      enumerated INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_scan (
      library_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      media_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enumerated_at TEXT NOT NULL,
      PRIMARY KEY (library_id, rel_path)
    );
  `);

  const jobStmt = db.prepare("SELECT * FROM scrape_jobs WHERE library_id = ?");
  const runningStmt = db.prepare("SELECT * FROM scrape_jobs WHERE status = 'running' ORDER BY library_id");
  const itemByKey = db.prepare("SELECT * FROM catalog_items WHERE library_id = ? AND item_key = ?");
  const itemsForLibrary = db.prepare("SELECT * FROM catalog_items WHERE library_id = ?");
  const pendingStmt = db.prepare("SELECT * FROM catalog_items WHERE library_id = ? AND lookup_state = 'pending' ORDER BY item_key");
  const itemById = db.prepare("SELECT * FROM catalog_items WHERE id = ?");
  const childrenStmt = db.prepare("SELECT * FROM catalog_children WHERE item_id = ? ORDER BY sort_index");
  const candidatesStmt = db.prepare("SELECT * FROM catalog_candidates WHERE item_id = ? ORDER BY score DESC, title");
  const candidateById = db.prepare("SELECT * FROM catalog_candidates WHERE id = ?");
  const rejectionsStmt = db.prepare("SELECT external_db, external_id FROM catalog_rejections WHERE library_id = ? AND item_key = ?");
  const posterStmt = db.prepare("SELECT * FROM poster_files WHERE item_id = ?");

  function nid(prefix: string): string {
    return `${prefix}_${randomBytes(9).toString("base64url")}`;
  }

  /**
   * `catalog_children.rel_path` on a database that predates it: the item key is
   * the folder the files were grouped from, so key + name rebuilds the path. Rows
   * for loose root files already store the file path as their key. Without this,
   * the first scan after the column exists would find no identity for the cards
   * people had already confirmed and duplicate them.
   */
  function ensureChildPathsColumn(): void {
    const columns = (db.prepare("PRAGMA table_info(catalog_children)").all() as Array<Record<string, unknown>>).map((row) => text(row, "name"));
    if (columns.includes("rel_path")) return;
    db.exec("ALTER TABLE catalog_children ADD COLUMN rel_path TEXT");
    const rows = db.prepare("SELECT c.id AS id, c.name AS name, i.item_key AS key FROM catalog_children c JOIN catalog_items i ON i.id = c.item_id WHERE c.rel_path IS NULL").all() as Array<Record<string, unknown>>;
    const update = db.prepare("UPDATE catalog_children SET rel_path = ? WHERE id = ?");
    for (const row of rows) {
      const key = text(row, "key");
      const isLooseFile = /\.(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv)$/i.test(key);
      update.run(isLooseFile ? key : `${key}/${text(row, "name")}`, text(row, "id"));
    }
  }

  ensureChildPathsColumn();

  function now(): string {
    return new Date().toISOString();
  }

  function mapJob(row: Record<string, unknown> | undefined): ScrapeJob | undefined {
    if (!row) return undefined;
    const status = text(row, "status");
    return {
      libraryId: text(row, "library_id"),
      status: status === "done" || status === "failed" ? status : "running",
      total: num(row, "total"),
      scanned: num(row, "scanned"),
      matched: num(row, "matched"),
      enumerated: num(row, "enumerated") === 1,
      lastError: text(row, "last_error") || null,
    };
  }

  function replaceChildren(itemId: string, files: CatalogGroupFile[]): void {
    db.prepare("DELETE FROM catalog_children WHERE item_id = ?").run(itemId);
    const insert = db.prepare(
      "INSERT INTO catalog_children (id, item_id, media_id, name, season, episode, sort_index, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    files.forEach((file, index) => {
      insert.run(nid("ch"), itemId, file.mediaId, file.name, file.season, file.episode, index, file.relativePath ?? null);
    });
  }

  /**
   * The card list is keyed by path, but a path is a coincidence of how somebody
   * put files on a drive: one folder can hold three films, and one film can be
   * split across four folders. Once a human has corrected the grouping, the next
   * scan must find that card again by *what it contains*, not by where it was.
   */
  function signatureOf(files: Array<{ mediaId: string; relativePath?: string }>): string {
    return [...new Set(files.map((file) => file.relativePath ?? `id:${file.mediaId}`))].sort().join("|");
  }

  function childrenOf(itemId: string): Array<CatalogGroupFile & { mediaId: string }> {
    return (childrenStmt.all(itemId) as Array<Record<string, unknown>>).map((child) => ({
      mediaId: text(child, "media_id"),
      name: text(child, "name"),
      season: intOrNull(child, "season"),
      episode: intOrNull(child, "episode"),
      relativePath: text(child, "rel_path") || undefined,
    }));
  }

  /** Renumber the order and recompute the sub-line after a manual merge/split. */
  function resequence(itemId: string): void {
    const ids = (db.prepare("SELECT id FROM catalog_children WHERE item_id = ? ORDER BY sort_index, name").all(itemId) as Array<Record<string, unknown>>).map((row) => text(row, "id"));
    const update = db.prepare("UPDATE catalog_children SET sort_index = ? WHERE id = ?");
    ids.forEach((id, index) => update.run(index, id));
    db.prepare("UPDATE catalog_items SET subtitle = ?, updated_at = ? WHERE id = ?").run(episodeSubtitle(childrenOf(itemId)), now(), itemId);
  }

  /** Shared by the read path and by every mutating endpoint's response. */
  function readDetail(id: string): CatalogDetail | undefined {
    const row = itemById.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const candidates = (candidatesStmt.all(id) as Array<Record<string, unknown>>).map((candidate) => ({
      id: text(candidate, "id"),
      title: text(candidate, "title"),
      year: intOrNull(candidate, "year"),
      score: num(candidate, "score"),
    }));
    const children = childrenOf(id).map((child) => ({
      mediaId: child.mediaId,
      name: child.name,
      season: child.season,
      episode: child.episode,
      compatibility: compatibilityOf(false, extensionOf(child.name)),
    }));
    return {
      ...cardOf(row),
      originalTitle: text(row, "original_title") || null,
      overview: text(row, "overview") || null,
      externalDb: text(row, "external_db") || null,
      externalId: text(row, "external_id") || null,
      candidates,
      children,
    };
  }

  function cardOf(row: Record<string, unknown>): CatalogCard {
    const id = text(row, "id");
    const poster = posterStmt.get(id) as Record<string, unknown> | undefined;
    const status = text(row, "status");
    return {
      id,
      title: text(row, "title"),
      year: intOrNull(row, "year"),
      kind: kindOf(text(row, "kind")),
      status: status === "candidate" || status === "confirmed" || status === "rejected" ? status : "unmatched",
      posterUrl: poster ? `/api/media/posters/${id}` : null,
      subtitle: text(row, "subtitle") || null,
    };
  }

  return {
    close() {
      db.close();
    },
    getJob(libraryId) {
      return mapJob(jobStmt.get(libraryId) as Record<string, unknown> | undefined);
    },
    listRunningJobs() {
      return (runningStmt.all() as Array<Record<string, unknown>>).flatMap((row) => {
        const job = mapJob(row);
        return job ? [job] : [];
      });
    },
    markRunning(libraryId, reset) {
      const existing = jobStmt.get(libraryId) as Record<string, unknown> | undefined;
      if (!existing) {
        db.prepare(
          "INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at) VALUES (?, 'running', 0, 0, 0, 0, NULL, ?)",
        ).run(libraryId, now());
        return;
      }
      if (reset) {
        db.prepare(
          "UPDATE scrape_jobs SET status = 'running', total = 0, scanned = 0, matched = 0, enumerated = 0, last_error = NULL, updated_at = ? WHERE library_id = ?",
        ).run(now(), libraryId);
        return;
      }
      db.prepare("UPDATE scrape_jobs SET status = 'running', last_error = NULL, updated_at = ? WHERE library_id = ?").run(now(), libraryId);
    },
    upsertScan(libraryId, kind, groups) {
      const existing = itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>;
      const byKey = new Map(existing.map((row) => [text(row, "item_key"), row]));
      // Second chance at identity: a card the human merged or split no longer sits
      // at the folder path the grouper would produce, but the set of files in it is
      // still unique. Match on that before creating a new card, or every re-scan
      // would undo the correction.
      const bySignature = new Map<string, Record<string, unknown>>();
      for (const row of existing) {
        const signature = signatureOf(childrenOf(text(row, "id")));
        if (signature) bySignature.set(signature, row);
      }
      const seen = new Set<string>();
      const kept = new Set<string>();
      db.exec("BEGIN");
      try {
        for (const group of groups) {
          seen.add(group.itemKey);
          const subtitle = episodeSubtitle(group.files);
          const row = byKey.get(group.itemKey) ?? bySignature.get(signatureOf(group.files));
          if (row) {
            const id = text(row, "id");
            kept.add(id);
            bySignature.delete(signatureOf(group.files));
            if (text(row, "item_key") !== group.itemKey) {
              db.prepare("UPDATE catalog_items SET item_key = ? WHERE id = ?").run(group.itemKey, id);
              byKey.set(group.itemKey, row);
            }
          }
          if (row && text(row, "status") === "confirmed") {
            replaceChildren(text(row, "id"), group.files);
            continue;
          }
          const id = row ? text(row, "id") : nid("cat");
          if (!row) {
            db.prepare(
              `INSERT INTO catalog_items (
                id, library_id, item_key, kind, query, raw_name, title, original_title, year, overview,
                external_db, external_id, status, lookup_state, subtitle, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'unmatched', 'pending', ?, ?)`,
            ).run(id, libraryId, group.itemKey, kind, group.query, group.rawName, group.query, subtitle, now());
          } else {
            db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(id);
            db.prepare("DELETE FROM poster_files WHERE item_id = ?").run(id);
            db.prepare(
              `UPDATE catalog_items
               SET kind = ?, query = ?, raw_name = ?, title = ?, original_title = NULL, year = NULL, overview = NULL,
                   external_db = NULL, external_id = NULL, status = 'unmatched', lookup_state = 'pending', subtitle = ?, updated_at = ?
               WHERE id = ?`,
            ).run(kind, group.query, group.rawName, group.query, subtitle, now(), id);
          }
          replaceChildren(id, group.files);
        }
        for (const row of existing) {
          // `kept` matters: a card reused under a new key still holds its old
          // `item_key` in this pre-update snapshot, so the key test alone would
          // delete the very card we just moved.
          if (kept.has(text(row, "id")) || seen.has(text(row, "item_key")) || text(row, "status") === "confirmed") continue;
          db.prepare("DELETE FROM catalog_items WHERE id = ?").run(text(row, "id"));
        }
        const confirmed = (itemsForLibrary.all(libraryId) as Array<Record<string, unknown>>).filter((row) => text(row, "status") === "confirmed").length;
        db.prepare(
          `INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at)
           VALUES (?, 'running', ?, ?, ?, 1, NULL, ?)
           ON CONFLICT(library_id) DO UPDATE SET
             status = 'running', total = excluded.total, scanned = excluded.scanned, matched = excluded.matched,
             enumerated = 1, last_error = NULL, updated_at = excluded.updated_at`,
        ).run(libraryId, groups.length, confirmed, confirmed, now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listPending(libraryId) {
      return (pendingStmt.all(libraryId) as Array<Record<string, unknown>>).map((row) => {
        const children = childrenStmt.all(text(row, "id")) as Array<Record<string, unknown>>;
        return {
          id: text(row, "id"),
          libraryId: text(row, "library_id"),
          itemKey: text(row, "item_key"),
          kind: kindOf(text(row, "kind")),
          query: text(row, "query"),
          rawName: text(row, "raw_name"),
          subtitle: text(row, "subtitle") || null,
          fileCount: children.length,
          fileNames: children.map((child) => text(child, "name")),
        };
      });
    },
    rejectionKeys(libraryId, itemKey) {
      const rows = rejectionsStmt.all(libraryId, itemKey) as Array<Record<string, unknown>>;
      return new Set(rows.map((row) => `${text(row, "external_db")}:${text(row, "external_id")}`));
    },
    applyMatch(item, status, chosen, candidates) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(item.id);
        const insert = db.prepare(
          "INSERT INTO catalog_candidates (id, item_id, external_db, external_id, title, year, score, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const candidate of candidates) {
          insert.run(
            nid("cand"),
            item.id,
            candidate.externalDb,
            candidate.externalId,
            candidate.title,
            candidate.year,
            candidate.score,
            JSON.stringify({
              imageUrl: candidate.imageUrl,
              overview: candidate.overview,
              originalTitle: candidate.originalTitle,
            }),
          );
        }
        const picked = status === "confirmed" ? chosen : null;
        db.prepare(
          `UPDATE catalog_items
           SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
               status = ?, lookup_state = 'done', updated_at = ?
           WHERE id = ?`,
        ).run(
          picked?.title ?? item.query,
          picked?.originalTitle ?? null,
          picked?.year ?? null,
          picked?.overview ?? null,
          picked?.externalDb ?? null,
          picked?.externalId ?? null,
          status,
          now(),
          item.id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    bumpJob(libraryId, matched) {
      db.prepare(
        "UPDATE scrape_jobs SET scanned = scanned + 1, matched = matched + ?, updated_at = ? WHERE library_id = ?",
      ).run(matched ? 1 : 0, now(), libraryId);
    },
    finishJob(libraryId) {
      db.prepare("UPDATE scrape_jobs SET status = 'done', enumerated = 1, last_error = NULL, updated_at = ? WHERE library_id = ?").run(now(), libraryId);
    },
    failJob(libraryId, code) {
      const existing = jobStmt.get(libraryId) as Record<string, unknown> | undefined;
      if (!existing) {
        db.prepare(
          "INSERT INTO scrape_jobs (library_id, status, total, scanned, matched, enumerated, last_error, updated_at) VALUES (?, 'failed', 0, 0, 0, 0, ?, ?)",
        ).run(libraryId, code, now());
        return;
      }
      db.prepare("UPDATE scrape_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE library_id = ?").run(code, now(), libraryId);
    },
    listCards(libraryId, cursor, query) {
      const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const like = query?.trim() ? `%${query.trim().replace(/[\\%_]/g, "")}%` : null;
      const rows = (
        like
          ? db.prepare(
              "SELECT * FROM catalog_items WHERE library_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY title, id",
            ).all(libraryId, like)
          : db.prepare("SELECT * FROM catalog_items WHERE library_id = ? ORDER BY title, id").all(libraryId)
      ) as Array<Record<string, unknown>>;
      if (!Number.isSafeInteger(start) || start < 0 || start > rows.length) {
        throw new Error("Invalid cursor");
      }
      const slice = rows.slice(start, start + PAGE_SIZE);
      const end = start + slice.length;
      return {
        items: slice.map(cardOf),
        hasMore: end < rows.length,
        ...(end < rows.length ? { nextCursor: String(end) } : {}),
      };
    },
    getDetail(id) {
      return readDetail(id);
    },
    confirm(itemId, candidateId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      const candidate = candidateById.get(candidateId) as Record<string, unknown> | undefined;
      if (!item || !candidate || text(candidate, "item_id") !== itemId) return undefined;
      const payload = parsePayload(text(candidate, "payload"));
      db.prepare(
        `UPDATE catalog_items
         SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
             status = 'confirmed', lookup_state = 'done', updated_at = ?
         WHERE id = ?`,
      ).run(
        text(candidate, "title"),
        payload.originalTitle,
        intOrNull(candidate, "year"),
        payload.overview,
        text(candidate, "external_db"),
        text(candidate, "external_id"),
        now(),
        itemId,
      );
      return { imageUrl: payload.imageUrl };
    },
    reject(itemId, candidateId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      const candidate = candidateById.get(candidateId) as Record<string, unknown> | undefined;
      if (!item || !candidate || text(candidate, "item_id") !== itemId) return false;
      db.prepare(
        "INSERT OR IGNORE INTO catalog_rejections (library_id, item_key, external_db, external_id) VALUES (?, ?, ?, ?)",
      ).run(text(item, "library_id"), text(item, "item_key"), text(candidate, "external_db"), text(candidate, "external_id"));
      db.prepare("DELETE FROM catalog_candidates WHERE id = ?").run(candidateId);
      const remaining = (candidatesStmt.all(itemId) as unknown[]).length;
      const rejectedThis =
        text(item, "external_db") === text(candidate, "external_db") && text(item, "external_id") === text(candidate, "external_id");
      if (rejectedThis || text(item, "status") === "confirmed") {
        db.prepare(
          `UPDATE catalog_items
           SET status = ?, external_db = NULL, external_id = NULL, original_title = NULL, overview = NULL, year = NULL,
               title = query, lookup_state = 'done', updated_at = ?
           WHERE id = ?`,
        ).run(remaining > 0 ? "candidate" : "unmatched", now(), itemId);
      } else if (remaining === 0) {
        db.prepare("UPDATE catalog_items SET status = 'unmatched', updated_at = ? WHERE id = ?").run(now(), itemId);
      }
      return true;
    },
    unconfirm(itemId) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      db.prepare(
        `UPDATE catalog_items
         SET status = 'unmatched', external_db = NULL, external_id = NULL, original_title = NULL, year = NULL,
             overview = NULL, title = query, lookup_state = 'pending', updated_at = ?
         WHERE id = ?`,
      ).run(now(), itemId);
      return readDetail(itemId);
    },
    rebind(itemId, choice) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      db.prepare(
        `UPDATE catalog_items
         SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
             status = 'confirmed', lookup_state = 'done', updated_at = ?
         WHERE id = ?`,
      ).run(
        choice.title,
        choice.originalTitle ?? null,
        choice.year ?? null,
        choice.overview ?? null,
        choice.externalDb,
        choice.externalId,
        now(),
        itemId,
      );
      return { imageUrl: choice.imageUrl ?? null };
    },
    mergeItems(keepId, dropIds) {
      const keep = itemById.get(keepId) as Record<string, unknown> | undefined;
      if (!keep) return undefined;
      const libraryId = text(keep, "library_id");
      const keepKey = text(keep, "item_key");
      const drops = dropIds
        .filter((id) => id && id !== keepId)
        .map((id) => itemById.get(id) as Record<string, unknown> | undefined)
        .filter((row): row is Record<string, unknown> => Boolean(row) && text(row as Record<string, unknown>, "library_id") === libraryId);
      if (drops.length === 0) return readDetail(keepId);
      db.exec("BEGIN");
      try {
        const keepConfirmed = text(keep, "status") === "confirmed";
        const keepPoster = db.prepare("SELECT cache_path FROM poster_files WHERE item_id = ?").get(keepId) as { cache_path?: string } | undefined;
        let posterTaken = Boolean(keepPoster);
        for (const drop of drops) {
          const dropId = text(drop, "id");
          // A human merging an unconfirmed card onto a confirmed one must not lose
          // the confirmation, whichever card they clicked from.
          if (!keepConfirmed && text(drop, "status") === "confirmed") {
            db.prepare(
              `UPDATE catalog_items
               SET title = ?, original_title = ?, year = ?, overview = ?, external_db = ?, external_id = ?,
                   status = 'confirmed', lookup_state = 'done'
               WHERE id = ?`,
            ).run(text(drop, "title"), text(drop, "original_title") || null, intOrNull(drop, "year"), text(drop, "overview") || null, text(drop, "external_db"), text(drop, "external_id"), keepId);
          }
          db.prepare("UPDATE catalog_children SET item_id = ? WHERE item_id = ?").run(keepId, dropId);
          const carried = db.prepare("SELECT external_db, external_id FROM catalog_candidates WHERE item_id = ?").all(dropId) as Array<Record<string, unknown>>;
          const clash = db.prepare("SELECT 1 hit FROM catalog_candidates WHERE item_id = ? AND external_db = ? AND external_id = ?");
          const adopt = db.prepare("UPDATE catalog_candidates SET item_id = ? WHERE item_id = ? AND external_db = ? AND external_id = ?");
          for (const candidate of carried) {
            if (!clash.get(keepId, text(candidate, "external_db"), text(candidate, "external_id"))) {
              adopt.run(keepId, dropId, text(candidate, "external_db"), text(candidate, "external_id"));
            }
          }
          db.prepare("DELETE FROM catalog_candidates WHERE item_id = ?").run(dropId);
          const dropPoster = db.prepare("SELECT cache_path FROM poster_files WHERE item_id = ?").get(dropId) as { cache_path?: string } | undefined;
          if (dropPoster) {
            if (!posterTaken) {
              db.prepare("UPDATE poster_files SET item_id = ? WHERE item_id = ?").run(keepId, dropId);
              posterTaken = true;
            } else {
              db.prepare("DELETE FROM poster_files WHERE item_id = ?").run(dropId);
              if (dropPoster.cache_path && dropPoster.cache_path !== keepPoster?.cache_path) fs.rmSync(dropPoster.cache_path, { force: true });
            }
          }
          db.prepare(
            `INSERT OR IGNORE INTO catalog_rejections (library_id, item_key, external_db, external_id)
             SELECT ?, ?, external_db, external_id FROM catalog_rejections WHERE library_id = ? AND item_key = ?`,
          ).run(libraryId, keepKey, libraryId, text(drop, "item_key"));
          db.prepare("DELETE FROM catalog_rejections WHERE library_id = ? AND item_key = ?").run(libraryId, text(drop, "item_key"));
          db.prepare("DELETE FROM catalog_items WHERE id = ?").run(dropId);
        }
        db.prepare("UPDATE catalog_items SET updated_at = ? WHERE id = ?").run(now(), keepId);
        resequence(keepId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return readDetail(keepId);
    },
    splitItem(itemId, groups) {
      const item = itemById.get(itemId) as Record<string, unknown> | undefined;
      if (!item) return undefined;
      const libraryId = text(item, "library_id");
      const mine = childrenOf(itemId);
      const known = new Map(mine.map((file) => [file.mediaId, file]));
      const cleaned = groups
        .map((group) => [...new Set(group)].filter((mediaId) => known.has(mediaId)))
        .filter((group) => group.length > 0);
      if (cleaned.length < 2) return undefined;
      const claimed = new Set(cleaned.flat());
      const leftover = mine.map((file) => file.mediaId).filter((mediaId) => !claimed.has(mediaId));
      const batches = leftover.length > 0 ? [cleaned[0], leftover, ...cleaned.slice(1)] : [cleaned[0], ...cleaned.slice(1)];
      const created: string[] = [];
      db.exec("BEGIN");
      try {
        const insertItem = db.prepare(
          `INSERT INTO catalog_items (
             id, library_id, item_key, kind, query, raw_name, title, original_title, year, overview,
             external_db, external_id, status, lookup_state, subtitle, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'unmatched', 'pending', NULL, ?)`,
        );
        const move = db.prepare("UPDATE catalog_children SET item_id = ? WHERE item_id = ? AND media_id = ?");
        for (const batch of batches.slice(1)) {
          const id = nid("cat");
          const names = batch.map((mediaId) => known.get(mediaId)?.name ?? "");
          const query = titleCandidates(names, "")[0] ?? text(item, "query");
          // A split card has no folder of its own any more, so its key is synthetic;
          // the scan finds it again by media set, not by path.
          insertItem.run(id, libraryId, `#split/${id}`, text(item, "kind"), query, names[0] ?? "", query, now());
          for (const mediaId of batch) move.run(id, itemId, mediaId);
          created.push(id);
        }
        db.prepare("UPDATE catalog_items SET updated_at = ? WHERE id = ?").run(now(), itemId);
        resequence(itemId);
        for (const id of created) resequence(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [readDetail(itemId), ...created.map(readDetail)].filter((detail): detail is CatalogDetail => Boolean(detail));
    },
    writeScan(libraryId, files) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM catalog_scan WHERE library_id = ?").run(libraryId);
        const insert = db.prepare("INSERT OR IGNORE INTO catalog_scan (library_id, rel_path, media_id, name, enumerated_at) VALUES (?, ?, ?, ?, ?)");
        const stamp = now();
        for (const file of files) insert.run(libraryId, file.relativePath, file.mediaId, file.name, stamp);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return (db.prepare("SELECT COUNT(*) n FROM catalog_scan WHERE library_id = ?").get(libraryId) as { n: number }).n;
    },
    readScan(libraryId) {
      return (db.prepare("SELECT rel_path, name, media_id FROM catalog_scan WHERE library_id = ? ORDER BY rel_path").all(libraryId) as Array<Record<string, unknown>>).map((row) => ({
        relativePath: text(row, "rel_path"),
        name: text(row, "name"),
        mediaId: text(row, "media_id"),
      }));
    },
    scanInfo(libraryId) {
      const row = db.prepare("SELECT COUNT(*) files, MAX(enumerated_at) at FROM catalog_scan WHERE library_id = ?").get(libraryId) as { files: number; at: string | null };
      return { files: row.files, enumeratedAt: row.at ?? null };
    },
    writePoster(itemId, contentType, bytes) {
      const cachePath = path.join(posterDir, itemId);
      fs.writeFileSync(cachePath, bytes);
      db.prepare(
        `INSERT INTO poster_files (item_id, content_type, cache_path, byte_size) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET content_type = excluded.content_type, cache_path = excluded.cache_path, byte_size = excluded.byte_size`,
      ).run(itemId, contentType, cachePath, bytes.length);
    },
    readPoster(itemId) {
      const row = posterStmt.get(itemId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const cachePath = text(row, "cache_path");
      const root = path.resolve(posterDir);
      const resolved = path.resolve(cachePath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
      if (!fs.existsSync(resolved)) return undefined;
      return { contentType: text(row, "content_type"), bytes: fs.readFileSync(resolved) };
    },
  };
}

function parsePayload(value: string): { imageUrl: string | null; overview: string | null; originalTitle: string | null } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl : null,
      overview: typeof parsed.overview === "string" ? parsed.overview : null,
      originalTitle: typeof parsed.originalTitle === "string" ? parsed.originalTitle : null,
    };
  } catch {
    return { imageUrl: null, overview: null, originalTitle: null };
  }
}

function kindOf(value: string): LibraryKind {
  if (value === "anime" || value === "movie" || value === "tv" || value === "other") return value;
  return "other";
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

function intOrNull(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}
