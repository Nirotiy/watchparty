import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LibraryKind = "anime" | "movie" | "tv" | "other";

export type StoredSource = {
  id: string;
  name: string;
  internalBaseUrl: string;
  publicBaseUrl: string;
  username: string;
  password: string;
  createdAt: string;
};

export type StoredLibrary = {
  id: string;
  sourceId: string;
  name: string;
  kind: LibraryKind;
  absolutePath: string;
};

const LIBRARY_KINDS = new Set<string>(["anime", "movie", "tv", "other"]);

export function isLibraryKind(value: string): value is LibraryKind {
  return LIBRARY_KINDS.has(value);
}

export type LibraryStore = {
  close(): void;
  sourceCount(): number;
  listSources(): StoredSource[];
  getSource(id: string): StoredSource | undefined;
  listLibraries(): StoredLibrary[];
  librariesFor(sourceId: string): StoredLibrary[];
  getLibrary(id: string): StoredLibrary | undefined;
  findLibraryByName(sourceId: string, name: string): StoredLibrary | undefined;
  insertSource(source: StoredSource, libraries: StoredLibrary[]): void;
  replaceSource(source: StoredSource, libraries: StoredLibrary[] | undefined): boolean;
  deleteSource(id: string): boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function mapSource(row: Record<string, unknown>): StoredSource {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    internalBaseUrl: text(row, "internal_base_url"),
    publicBaseUrl: text(row, "public_base_url"),
    username: text(row, "username"),
    password: text(row, "password"),
    createdAt: text(row, "created_at"),
  };
}

function mapLibrary(row: Record<string, unknown>): StoredLibrary {
  const kind = text(row, "kind");
  return {
    id: text(row, "id"),
    sourceId: text(row, "source_id"),
    name: text(row, "name"),
    kind: isLibraryKind(kind) ? kind : "other",
    absolutePath: text(row, "absolute_path"),
  };
}

export function openLibraryStore(dbPath: string): LibraryStore {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      internal_base_url TEXT NOT NULL,
      public_base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_libraries (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      absolute_path TEXT NOT NULL
    );
  `);

  const selectSources = db.prepare(
    "SELECT id, name, internal_base_url, public_base_url, username, password, created_at FROM media_sources ORDER BY created_at, id",
  );
  const selectSourceById = db.prepare(
    "SELECT id, name, internal_base_url, public_base_url, username, password, created_at FROM media_sources WHERE id = ?",
  );
  const selectLibraries = db.prepare(
    "SELECT id, source_id, name, kind, absolute_path FROM media_libraries ORDER BY name, id",
  );
  const selectLibrariesFor = db.prepare(
    "SELECT id, source_id, name, kind, absolute_path FROM media_libraries WHERE source_id = ? ORDER BY name, id",
  );
  const selectLibraryById = db.prepare(
    "SELECT id, source_id, name, kind, absolute_path FROM media_libraries WHERE id = ?",
  );
  const selectLibraryByName = db.prepare(
    "SELECT id, source_id, name, kind, absolute_path FROM media_libraries WHERE source_id = ? AND name = ?",
  );
  const countSources = db.prepare("SELECT COUNT(*) AS n FROM media_sources");
  const insertSourceStmt = db.prepare(
    "INSERT INTO media_sources (id, name, internal_base_url, public_base_url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLibraryStmt = db.prepare(
    "INSERT INTO media_libraries (id, source_id, name, kind, absolute_path) VALUES (?, ?, ?, ?, ?)",
  );
  const updateSourceStmt = db.prepare(
    "UPDATE media_sources SET name = ?, internal_base_url = ?, public_base_url = ?, username = ?, password = ? WHERE id = ?",
  );
  const deleteLibrariesStmt = db.prepare("DELETE FROM media_libraries WHERE source_id = ?");
  const deleteSourceStmt = db.prepare("DELETE FROM media_sources WHERE id = ?");

  let closed = false;

  function sourceRows(value: unknown): StoredSource[] {
    return Array.isArray(value) ? value.filter(isRecord).map(mapSource) : [];
  }

  function libraryRows(value: unknown): StoredLibrary[] {
    return Array.isArray(value) ? value.filter(isRecord).map(mapLibrary) : [];
  }

  function writeLibraries(sourceId: string, libraries: StoredLibrary[]): void {
    for (const library of libraries) {
      insertLibraryStmt.run(library.id, sourceId, library.name, library.kind, library.absolutePath);
    }
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
    sourceCount() {
      const row = countSources.get();
      return isRecord(row) ? Number(row.n ?? 0) : 0;
    },
    listSources() {
      return sourceRows(selectSources.all());
    },
    getSource(id) {
      const row = selectSourceById.get(id);
      return isRecord(row) ? mapSource(row) : undefined;
    },
    listLibraries() {
      return libraryRows(selectLibraries.all());
    },
    librariesFor(sourceId) {
      return libraryRows(selectLibrariesFor.all(sourceId));
    },
    getLibrary(id) {
      const row = selectLibraryById.get(id);
      return isRecord(row) ? mapLibrary(row) : undefined;
    },
    findLibraryByName(sourceId, name) {
      const row = selectLibraryByName.get(sourceId, name);
      return isRecord(row) ? mapLibrary(row) : undefined;
    },
    insertSource(source, libraries) {
      db.exec("BEGIN");
      try {
        insertSourceStmt.run(
          source.id,
          source.name,
          source.internalBaseUrl,
          source.publicBaseUrl,
          source.username,
          source.password,
          source.createdAt,
        );
        writeLibraries(source.id, libraries);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    replaceSource(source, libraries) {
      if (!isRecord(selectSourceById.get(source.id))) return false;
      db.exec("BEGIN");
      try {
        updateSourceStmt.run(
          source.name,
          source.internalBaseUrl,
          source.publicBaseUrl,
          source.username,
          source.password,
          source.id,
        );
        if (libraries) {
          deleteLibrariesStmt.run(source.id);
          writeLibraries(source.id, libraries);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return true;
    },
    deleteSource(id) {
      const result = deleteSourceStmt.run(id) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    },
  };
}
