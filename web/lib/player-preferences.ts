import type { MediaSource, SubtitleTrack } from "./contracts";
import type { EmbeddedTrack, EmbeddedTracks } from "./player-local";

export type TrackPreferences = {
  /** 有序语言列表（按顺序匹配：先精确标签，再主语言回退）；空列表＝媒体默认。 */
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitlesOff: boolean;
};

/** 普通文本字幕外观（handoff 三轮裁决）：仅作用于画布渲染的 VTT/SRT，ASS 走原样式不受影响。 */
export type SubtitleAppearance = {
  /** 字号（%）：50–300，默认 100。 */
  fontScale: number;
  color: "white" | "yellow";
  outline: boolean;
  background: "none" | "black";
  /** 底部位置上移（% of 视觉高度）：0＝自动安全区（默认）；手动 5–30，渲染端再约束防裁切。 */
  bottomRaisePercent: number;
};

export const SUBTITLE_FONT_MIN = 50;
export const SUBTITLE_FONT_MAX = 300;
export const SUBTITLE_BOTTOM_RAISE_MIN = 5;
export const SUBTITLE_BOTTOM_RAISE_MAX = 30;
export const SUBTITLE_OFFSET_LIMIT_SECONDS = 30;
export const LANGUAGE_LIST_LIMIT = 8;

export const DEFAULT_SUBTITLE_APPEARANCE: Readonly<SubtitleAppearance> = {
  fontScale: 100, color: "white", outline: true, background: "none", bottomRaisePercent: 0,
};

export type SubtitleSourcePreference = "external" | "embedded";

/** 语言列表编辑器的固定选项。 */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "ru", label: "俄语" },
];

export type PlayerPreferences = TrackPreferences & {
  volume: number;
  muted: boolean;
  /** 字幕来源优先级：默认外挂优先（上传字幕归外挂来源）。 */
  subtitleSourcePreference: SubtitleSourcePreference;
  subtitleAppearance: SubtitleAppearance;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const GLOBAL_KEY = "watchparty.player-preferences.v1";
const OFFSET_KEY = "watchparty.subtitle-offsets.v1";
export const DEFAULT_PLAYER_PREFERENCES: Readonly<PlayerPreferences> = {
  volume: 85, muted: false, audioLanguages: [], subtitleLanguages: [], subtitlesOff: false,
  subtitleSourcePreference: "external",
  subtitleAppearance: { ...DEFAULT_SUBTITLE_APPEARANCE },
};

function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

function readJson(storage: PreferenceStorage | undefined, key: string): unknown {
  try { return JSON.parse(storage?.getItem(key) ?? "null"); }
  catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en", jpn: "ja", zho: "zh", chi: "zh", fra: "fr", fre: "fr", deu: "de", ger: "de",
  spa: "es", ita: "it", kor: "ko", rus: "ru", por: "pt", ara: "ar", und: "",
};

export function normalizeTrackLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag)) return null;
  const [base, ...parts] = tag.split("-");
  const normalized = LANGUAGE_ALIASES[base] ?? base;
  return normalized ? [normalized, ...parts].join("-") : null;
}

function clampNumber(value:unknown, min:number, max:number, fallback:number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** 语言列表：规范化、保序去重、坏值丢弃、限长。空值/旧单值/数组都接受（handoff §八 迁移）。 */
function normalizeLanguageList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const list: string[] = [];
  for (const item of raw) {
    const normalized = normalizeTrackLanguage(item);
    if (normalized && !list.includes(normalized)) list.push(normalized);
    if (list.length >= LANGUAGE_LIST_LIMIT) break;
  }
  return list;
}

function validateSubtitleAppearance(value: unknown): SubtitleAppearance {
  const data = record(value) ? value : {};
  const bottomRaise = typeof data.bottomRaisePercent === "number" && Number.isFinite(data.bottomRaisePercent)
    ? (data.bottomRaisePercent <= 0 ? 0 : Math.max(SUBTITLE_BOTTOM_RAISE_MIN, Math.min(SUBTITLE_BOTTOM_RAISE_MAX, data.bottomRaisePercent)))
    : DEFAULT_SUBTITLE_APPEARANCE.bottomRaisePercent;
  return {
    fontScale: clampNumber(data.fontScale, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_APPEARANCE.fontScale),
    color: data.color === "yellow" ? "yellow" : "white",
    outline: typeof data.outline === "boolean" ? data.outline : DEFAULT_SUBTITLE_APPEARANCE.outline,
    background: data.background === "black" ? "black" : "none",
    bottomRaisePercent: bottomRaise,
  };
}

function validatePreferences(value: unknown): PlayerPreferences {
  const data = record(value) ? value : {};
  return {
    volume: typeof data.volume === "number" && Number.isFinite(data.volume)
      ? Math.max(0, Math.min(100, data.volume)) : DEFAULT_PLAYER_PREFERENCES.volume,
    muted: typeof data.muted === "boolean" ? data.muted : false,
    // 迁移：旧单值字段 audioLanguage/subtitleLanguage（含 null）→ 有序列表。
    audioLanguages: normalizeLanguageList(data.audioLanguages ?? data.audioLanguage),
    subtitleLanguages: normalizeLanguageList(data.subtitleLanguages ?? data.subtitleLanguage),
    subtitlesOff: typeof data.subtitlesOff === "boolean" ? data.subtitlesOff : false,
    subtitleSourcePreference: data.subtitleSourcePreference === "embedded" ? "embedded" : "external",
    subtitleAppearance: validateSubtitleAppearance(data.subtitleAppearance),
  };
}

export function readPlayerPreferences(storage = browserStorage()): PlayerPreferences {
  return validatePreferences(readJson(storage, GLOBAL_KEY));
}

/** Returns usable preferences even when storage is unavailable or full. */
export function savePlayerPreferences(patch: Partial<PlayerPreferences>, storage = browserStorage()): PlayerPreferences {
  const next = validatePreferences({ ...readPlayerPreferences(storage), ...patch });
  try { storage?.setItem(GLOBAL_KEY, JSON.stringify(next)); } catch { /* Keep playback usable without persistence. */ }
  return next;
}

/** 合并式字幕外观写入（避免整对象覆盖）。 */
export function saveSubtitleAppearance(patch: Partial<SubtitleAppearance>, storage = browserStorage()): SubtitleAppearance {
  const current = readPlayerPreferences(storage).subtitleAppearance;
  return savePlayerPreferences({ subtitleAppearance: { ...current, ...patch } }, storage).subtitleAppearance;
}

/** 清除全部媒体偏移（需调用方单独确认）；与房间凭据、观看记录无关。 */
export function clearAllSubtitleOffsets(storage = browserStorage()): void {
  try { storage?.removeItem(OFFSET_KEY); } catch { /* Optional local persistence. */ }
}

/** Direct URLs need a caller-supplied stable identity; never persist signed URLs. */
export function getPreferenceMediaKey(source: MediaSource | null): string | null {
  if (source?.kind === "openlist") return `openlist:${source.mediaId}`;
  if (source?.kind === "youtube") return `youtube:${source.videoId}`;
  return null;
}

type OffsetEntry = { mediaKey: string; seconds: number };
function readOffsets(storage: PreferenceStorage | undefined): OffsetEntry[] {
  const value = readJson(storage, OFFSET_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is OffsetEntry => record(entry) && typeof entry.mediaKey === "string"
    && typeof entry.seconds === "number" && Number.isFinite(entry.seconds)).slice(-100);
}

export function clampSubtitleOffset(seconds: number): number {
  return Math.max(-SUBTITLE_OFFSET_LIMIT_SECONDS, Math.min(SUBTITLE_OFFSET_LIMIT_SECONDS, seconds));
}

export function readSubtitleOffset(mediaKey: string | null, storage = browserStorage(), fallback = 0): number {
  const stored = mediaKey ? readOffsets(storage).findLast((entry) => entry.mediaKey === mediaKey)?.seconds : undefined;
  return stored === undefined ? fallback : clampSubtitleOffset(stored);
}

export function saveSubtitleOffset(mediaKey: string | null, seconds: number, storage = browserStorage()): void {
  if (!mediaKey || !Number.isFinite(seconds)) return;
  const entries = readOffsets(storage).filter((entry) => entry.mediaKey !== mediaKey);
  entries.push({ mediaKey, seconds: clampSubtitleOffset(seconds) });
  try { storage?.setItem(OFFSET_KEY, JSON.stringify(entries.slice(-100))); } catch { /* Optional local persistence. */ }
}

/**
 * 有序语言匹配（handoff §八）：按列表顺序逐项匹配，每项先精确标签、再主语言回退；
 * 同级候选保留原始顺序（find 首次命中）。supported 为真时才入候选。
 */
export function orderedLanguageMatch<T>(
  items: T[],
  languages: string[],
  languageOf: (item: T) => string | null | undefined,
  supported?: (item: T) => boolean,
): T | undefined {
  const pool = supported ? items.filter(supported) : items;
  for (const language of languages) {
    const preferred = normalizeTrackLanguage(language);
    if (!preferred) continue;
    const exact = pool.find((item) => normalizeTrackLanguage(languageOf(item)) === preferred);
    if (exact) return exact;
    const base = preferred.split("-")[0];
    const fallback = pool.find((item) => normalizeTrackLanguage(languageOf(item))?.split("-")[0] === base);
    if (fallback) return fallback;
  }
  return undefined;
}

/** 外挂字幕自动选择：语言列表命中 → 命中轨；空表或无命中 → 该来源默认轨（首个，handoff §八）。 */
export function preferredExternalSubtitle(tracks: SubtitleTrack[], languages: string[]): SubtitleTrack | undefined {
  return orderedLanguageMatch(tracks, languages, (track) => track.language) ?? tracks[0];
}

/** 内嵌轨道自动选择（音轨/字幕各按有序语言列表；字幕另受"关闭字幕"优先）。 */
export function matchPreferredTracks(tracks: EmbeddedTracks, preferences: TrackPreferences): Pick<EmbeddedTracks, "audioId" | "subtitleId"> {
  const supported = tracks.items.filter((track) => track.supported);
  const audioMatch = orderedLanguageMatch(supported.filter((track) => track.kind === "audio"), preferences.audioLanguages, (track) => track.language);
  const subtitleMatch = orderedLanguageMatch(supported.filter((track) => track.kind === "subtitle"), preferences.subtitleLanguages, (track) => track.language);
  return {
    audioId: audioMatch?.id ?? tracks.audioId,
    subtitleId: preferences.subtitlesOff ? null : subtitleMatch?.id ?? tracks.subtitleId,
  };
}

/**
 * 菜单手选只影响当前媒体（覆盖自动选择、同媒体重试保留），不重排全局语言列表（handoff §八）。
 * 唯一跨媒体记忆：字幕显式关闭；重新选字幕解除关闭。
 */
export function trackPreferencePatch(kind: EmbeddedTrack["kind"], track: EmbeddedTrack | null): Partial<TrackPreferences> {
  if (kind === "audio") return {};
  return { subtitlesOff: track === null };
}
