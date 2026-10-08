import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * 上传字幕的形状与旁挂字幕同构（`SubtitleTrack` + `source`），前端一份渲染逻辑。
 * `id` 是这条上传记录自己的身份，不是媒体 id —— 取内容/删除都按它寻址。
 */
export type UploadedSubtitleTrack = {
  id: string;
  mediaId: string;
  label: string;
  format: "ass" | "ssa" | "srt" | "vtt";
  language?: string;
  source: "upload";
};

export const SUBTITLE_FORMATS: readonly string[] = ["srt", "vtt", "ass", "ssa"];
/** 单条正文上限（契约 §1）：超了回 413，不截断。 */
export const SUBTITLE_CONTENT_CAP_BYTES = 512 * 1024;
/** 一个媒体最多挂多少条上传字幕（同名覆盖不占新位，所以这是"不同名字"的上限）。 */
export const SUBTITLE_TRACKS_PER_MEDIA = 32;

export type SubtitlePut = {
  mediaId: string;
  name: string;
  format: string;
  content: string;
  language?: string;
};

export type SubtitleStoreOptions = {
  /** 默认 `data/watchparty-subtitles.sqlite`；`NODE_ENV=test` 下用 `:memory:`。 */
  dbPath?: string;
  nodeEnv?: string;
};

export type SubtitleStore = {
  /** 同 media + 同 name 覆盖（契约 §1.5）：主键与 createdAt 保持稳定，只换正文。 */
  put(input: SubtitlePut): UploadedSubtitleTrack;
  list(mediaId: string): UploadedSubtitleTrack[];
  load(id: string): { mediaId: string; content: string } | undefined;
  remove(id: string): boolean;
  close(): void;
};

/**
 * 媒体级持久的上传字幕：按 `mediaId` 归属，不属于任何房间 —— 同一文件在哪个房间
 * 播放都选得到，服务端重启也在。正文就存在库里（不落文件系统），关库即无痕。
 */
export function createSubtitleStore(options: SubtitleStoreOptions = {}): SubtitleStore {
  const dbPath =
    options.dbPath ??
    (options.nodeEnv === "test"
      ? ":memory:"
      : path.join(process.cwd(), "data", "watchparty-subtitles.sqlite"));
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS uploaded_subtitles (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      language TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uploaded_subtitles_name
      ON uploaded_subtitles (media_id, name);
  `);

  const columns = "id, media_id, name, format, language, created_at";
  const upsert = db.prepare(`
    INSERT INTO uploaded_subtitles (id, media_id, name, format, language, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (media_id, name) DO UPDATE SET
      format = excluded.format,
      language = excluded.language,
      content = excluded.content,
      updated_at = excluded.updated_at
  `);
  const selectByMedia = db.prepare(
    `SELECT ${columns} FROM uploaded_subtitles WHERE media_id = ? ORDER BY created_at, id`,
  );
  const selectByName = db.prepare(
    `SELECT ${columns} FROM uploaded_subtitles WHERE media_id = ? AND name = ?`,
  );
  const selectContent = db.prepare("SELECT media_id, content FROM uploaded_subtitles WHERE id = ?");
  const deleteById = db.prepare("DELETE FROM uploaded_subtitles WHERE id = ?");

  return {
    put(input) {
      const now = new Date().toISOString();
      // 覆盖时保住旧 id：播放器可能正拿着按旧 id 取来的内容，换 id 会让它选中一条不存在的路。
      const existing = selectByName.get(input.mediaId, input.name);
      const id = isRecord(existing) ? text(existing, "id") : randomUUID();
      upsert.run(
        id,
        input.mediaId,
        input.name,
        input.format,
        input.language ?? null,
        input.content,
        now,
        now,
      );
      const row = selectByName.get(input.mediaId, input.name);
      if (!isRecord(row)) throw new Error("Subtitle write failed");
      return toTrack(row);
    },
    list(mediaId) {
      return rows(selectByMedia.all(mediaId)).map(toTrack);
    },
    load(id) {
      const row = selectContent.get(id);
      return isRecord(row)
        ? { mediaId: text(row, "media_id"), content: text(row, "content") }
        : undefined;
    },
    remove(id) {
      return deleteById.run(id).changes > 0;
    },
    close() {
      db.close();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toTrack(row: Record<string, unknown>): UploadedSubtitleTrack {
  const language = text(row, "language");
  return {
    id: text(row, "id"),
    mediaId: text(row, "media_id"),
    label: text(row, "name"),
    format: text(row, "format") as UploadedSubtitleTrack["format"],
    ...(language ? { language } : {}),
    source: "upload",
  };
}
