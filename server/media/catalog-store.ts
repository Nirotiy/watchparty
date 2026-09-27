import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { episodeSubtitle, type CatalogGroup, type CatalogGroupFile } from "./catalog-names.ts";
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
      "INSERT INTO catalog_children (id, item_id, media_id, name, season, episode, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    files.forEach((file, index) => {
      insert.run(nid("ch"), itemId, file.mediaId, file.name, file.season, file.episode, index);
    });
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
      const seen = new Set<string>();
      db.exec("BEGIN");
      try {
        for (const group of groups) {
          seen.add(group.itemKey);
          const subtitle = episodeSubtitle(group.files);
          const row = byKey.get(group.itemKey);
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
          if (seen.has(text(row, "item_key")) || text(row, "status") === "confirmed") continue;
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
      const row = itemById.get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const candidates = (candidatesStmt.all(id) as Array<Record<string, unknown>>).map((candidate) => ({
        id: text(candidate, "id"),
        title: text(candidate, "title"),
        year: intOrNull(candidate, "year"),
        score: num(candidate, "score"),
      }));
      const children = (childrenStmt.all(id) as Array<Record<string, unknown>>).map((child) => {
        const name = text(child, "name");
        return {
          mediaId: text(child, "media_id"),
          name,
          season: intOrNull(child, "season"),
          episode: intOrNull(child, "episode"),
          compatibility: compatibilityOf(false, extensionOf(name)),
        };
      });
      return {
        ...cardOf(row),
        originalTitle: text(row, "original_title") || null,
        overview: text(row, "overview") || null,
        candidates,
        children,
      };
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
