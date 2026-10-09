import type { MediaSource, SubtitleTrack } from "./contracts";
import type { EmbeddedTrack, EmbeddedTracks } from "./player-local";

/** 字幕显示模式（追加裁决）：三模式共同决定自动选轨；手选始终覆盖自动结果。 */
export type SubtitleMode = "media-default" | "prefer-list" | "off";

export type SubtitleSourcePreference = "external" | "embedded";

export type SubtitleColor = "white" | "yellow" | "cyan" | "green";
export type SubtitleFontWeight = "normal" | "bold";
export type SubtitleOutline = "none" | "thin" | "thick";
export type SubtitleShadow = "none" | "soft" | "strong";
export const SUBTITLE_BACKGROUND_OPACITIES = [0, 25, 50, 75, 100] as const;
export type SubtitleBackgroundOpacity = (typeof SUBTITLE_BACKGROUND_OPACITIES)[number];

/** 普通文本字幕外观（仅作用于 VTT/SRT；ASS/SSA 走原样式不受影响）。 */
export type SubtitleAppearance = {
  /** 字号（%）：50–300，默认 100。 */
  fontScale: number;
  color: SubtitleColor;
  fontWeight: SubtitleFontWeight;
  outline: SubtitleOutline;
  shadow: SubtitleShadow;
  /** 黑色背景透明度（%）：0＝关闭，默认 0。 */
  backgroundOpacity: SubtitleBackgroundOpacity;
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
  fontScale: 100, color: "white", fontWeight: "normal", outline: "thin", shadow: "none",
  backgroundOpacity: 0, bottomRaisePercent: 0,
};

/** 快进/后退步长（秒）：两档各自独立保存。 */
export const SKIP_STEP_OPTIONS = [5, 10, 15, 20, 25, 30] as const;
export type SkipStepSeconds = (typeof SKIP_STEP_OPTIONS)[number];
export const DEFAULT_SKIP_STEP_SECONDS: SkipStepSeconds = 10;

/** 画面缩放：完整显示（默认，不裁切）或铺满画面（裁切边缘）。YouTube 不适用。 */
export type PictureFit = "contain" | "cover";

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

export type PlayerPreferences = {
  volume: number;
  muted: boolean;
  /** 有序语言列表（按顺序匹配：先精确标签，再主语言回退）；空列表＝媒体默认。 */
  audioLanguages: string[];
  subtitleLanguages: string[];
  subtitleMode: SubtitleMode;
  /** 源平局偏好：只在同一语言优先级出现多个候选时打破平局（不能推翻模式或语言优先级）。 */
  subtitleSourcePreference: SubtitleSourcePreference;
  subtitleAppearance: SubtitleAppearance;
  skipBackwardSeconds: SkipStepSeconds;
  skipForwardSeconds: SkipStepSeconds;
  pictureFit: PictureFit;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const GLOBAL_KEY = "watchparty.player-preferences.v1";
const OFFSET_KEY = "watchparty.subtitle-offsets.v1";
export const DEFAULT_PLAYER_PREFERENCES: Readonly<PlayerPreferences> = {
  volume: 85, muted: false, audioLanguages: [], subtitleLanguages: [],
  subtitleMode: "media-default", subtitleSourcePreference: "external",
  subtitleAppearance: { ...DEFAULT_SUBTITLE_APPEARANCE },
  skipBackwardSeconds: DEFAULT_SKIP_STEP_SECONDS, skipForwardSeconds: DEFAULT_SKIP_STEP_SECONDS,
  pictureFit: "contain",
};

function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** 存储是否可用：不可用时偏好仍供本次会话使用，但界面须提示未保存。 */
export function preferencesStorageAvailable(storage: PreferenceStorage | undefined = browserStorage()): boolean {
  try {
    storage?.setItem("watchparty.storage-probe", "1");
    storage?.removeItem("watchparty.storage-probe");
    return true;
  } catch { return false; }
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
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

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : fallback;
}

function validateSkipStep(value: unknown): SkipStepSeconds {
  return typeof value === "number" && (SKIP_STEP_OPTIONS as readonly number[]).includes(value)
    ? value as SkipStepSeconds : DEFAULT_SKIP_STEP_SECONDS;
}

function snapBackgroundOpacity(value: unknown): SubtitleBackgroundOpacity {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const snapped = Math.round(Math.max(0, Math.min(100, value)) / 25) * 25;
  return snapped as SubtitleBackgroundOpacity;
}

function validateSubtitleAppearance(value: unknown): SubtitleAppearance {
  const data = record(value) ? value : {};
  const bottomRaise = typeof data.bottomRaisePercent === "number" && Number.isFinite(data.bottomRaisePercent)
    ? (data.bottomRaisePercent <= 0 ? 0 : Math.max(SUBTITLE_BOTTOM_RAISE_MIN, Math.min(SUBTITLE_BOTTOM_RAISE_MAX, data.bottomRaisePercent)))
    : DEFAULT_SUBTITLE_APPEARANCE.bottomRaisePercent;
  // 迁移：旧 outline 布尔 → none/thin；旧 background "none"/"black"（固定 60% 透明度）→ 0/50。
  const outline = data.outline === "thick" ? "thick"
    : data.outline === "none" || data.outline === false ? "none"
      : data.outline === "thin" || data.outline === true ? "thin"
        : DEFAULT_SUBTITLE_APPEARANCE.outline;
  const backgroundOpacity = data.background === "black" ? 50
    : data.background === "none" ? 0
      : snapBackgroundOpacity(data.backgroundOpacity);
  return {
    fontScale: clampNumber(data.fontScale, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_APPEARANCE.fontScale),
    color: oneOf(data.color, ["white", "yellow", "cyan", "green"], DEFAULT_SUBTITLE_APPEARANCE.color),
    fontWeight: oneOf(data.fontWeight, ["normal", "bold"], DEFAULT_SUBTITLE_APPEARANCE.fontWeight),
    outline,
    shadow: oneOf(data.shadow, ["none", "soft", "strong"], DEFAULT_SUBTITLE_APPEARANCE.shadow),
    backgroundOpacity,
    bottomRaisePercent: bottomRaise,
  };
}

function validatePreferences(value: unknown): PlayerPreferences {
  const data = record(value) ? value : {};
  // 迁移：旧 subtitlesOff 布尔 → 显式关闭模式；缺省一律"跟随媒体默认"。
  const subtitleMode: SubtitleMode = data.subtitleMode === "prefer-list" || data.subtitleMode === "off"
    ? data.subtitleMode
    : data.subtitleMode === "media-default" ? "media-default"
      : data.subtitlesOff === true ? "off" : "media-default";
  return {
    volume: typeof data.volume === "number" && Number.isFinite(data.volume)
      ? Math.max(0, Math.min(100, data.volume)) : DEFAULT_PLAYER_PREFERENCES.volume,
    muted: typeof data.muted === "boolean" ? data.muted : false,
    // 迁移：旧单值字段 audioLanguage/subtitleLanguage（含 null）→ 有序列表。
    audioLanguages: normalizeLanguageList(data.audioLanguages ?? data.audioLanguage),
    subtitleLanguages: normalizeLanguageList(data.subtitleLanguages ?? data.subtitleLanguage),
    subtitleMode,
    subtitleSourcePreference: data.subtitleSourcePreference === "embedded" ? "embedded" : "external",
    subtitleAppearance: validateSubtitleAppearance(data.subtitleAppearance),
    skipBackwardSeconds: validateSkipStep(data.skipBackwardSeconds),
    skipForwardSeconds: validateSkipStep(data.skipForwardSeconds),
    pictureFit: data.pictureFit === "cover" ? "cover" : "contain",
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

/** 音轨自动选择：有序列表命中 → 该轨；未命中 → 引擎自身默认轨（tracks.audioId）。 */
export function matchPreferredAudio(tracks: EmbeddedTracks, audioLanguages: string[]): number | null {
  const supported = tracks.items.filter((track) => track.kind === "audio" && track.supported);
  return orderedLanguageMatch(supported, audioLanguages, (track) => track.language)?.id ?? tracks.audioId;
}

export type SubtitleSelection =
  | { kind: "external"; track: SubtitleTrack }
  | { kind: "embedded"; id: number }
  | { kind: "none" };

type SubtitleCandidate =
  | { kind: "embedded"; id: number; language?: string; defaulted: boolean }
  | { kind: "external"; track: SubtitleTrack; language?: string };

export type SubtitleDecisionInput = {
  mode: SubtitleMode;
  languages: string[];
  sourcePreference: SubtitleSourcePreference;
  /** 当前媒体全部内嵌轨（内部过滤 kind=subtitle 且 supported）。 */
  embedded: EmbeddedTrack[];
  external: SubtitleTrack[];
  /**
   * 引擎自身默认选择（载入后未干预时的内嵌字幕轨）。仅在"始终按偏好"列表为空、
   * 且媒体没有默认标记时可用的回退；媒体默认标记优先于它。
   */
  embeddedDefaultPickId: number | null;
};

/**
 * 字幕自动选轨（追加裁决 §字幕模式与自动选择）：
 * - 关闭：最高优先级，不显示任何字幕；
 * - 跟随媒体默认：默认标记轨 → 语言列表（跨外挂/内嵌）→ 关闭；
 * - 始终按偏好：语言列表命中（列表非空，未命中即关闭）；列表为空回退媒体默认轨
 *   （默认标记 → 引擎自身默认选择）。
 * 来源偏好只在同一语言优先级出现多个候选时打破平局；仍同级保留媒体轨道顺序。
 * 外挂字幕接口没有默认标记，永远不参与"媒体默认"步骤（不以第一条冒充默认轨）。
 */
export function decideSubtitleSelection(input: SubtitleDecisionInput): SubtitleSelection {
  if (input.mode === "off") return { kind: "none" };
  const candidates: SubtitleCandidate[] = [
    ...input.embedded
      .filter((track) => track.kind === "subtitle" && track.supported)
      .map((track): SubtitleCandidate => ({ kind: "embedded", id: track.id, language: track.language, defaulted: track.default === true })),
    ...input.external.map((track): SubtitleCandidate => ({ kind: "external", track, language: track.language })),
  ];
  const toSelection = (candidate: SubtitleCandidate | undefined): SubtitleSelection =>
    candidate?.kind === "embedded" ? { kind: "embedded", id: candidate.id }
      : candidate?.kind === "external" ? { kind: "external", track: candidate.track }
        : { kind: "none" };
  const pickSamePriority = (hits: SubtitleCandidate[]): SubtitleCandidate | undefined => {
    const embeddedHit = hits.find((hit) => hit.kind === "embedded");
    const externalHit = hits.find((hit) => hit.kind === "external");
    if (embeddedHit && externalHit) return input.sourcePreference === "external" ? externalHit : embeddedHit;
    return embeddedHit ?? externalHit;
  };
  const matchLanguages = (): SubtitleCandidate | undefined => {
    for (const language of input.languages) {
      const preferred = normalizeTrackLanguage(language);
      if (!preferred) continue;
      const tagOf = (candidate: SubtitleCandidate) => normalizeTrackLanguage(candidate.language);
      const exact = pickSamePriority(candidates.filter((candidate) => tagOf(candidate) === preferred));
      if (exact) return exact;
      const base = preferred.split("-")[0];
      const fallback = pickSamePriority(candidates.filter((candidate) => tagOf(candidate)?.split("-")[0] === base));
      if (fallback) return fallback;
    }
    return undefined;
  };
  const flaggedDefault = candidates.find((candidate) => candidate.kind === "embedded" && candidate.defaulted);

  if (input.mode === "media-default") {
    if (flaggedDefault) return toSelection(flaggedDefault);
    return toSelection(matchLanguages());
  }
  // prefer-list
  if (input.languages.length > 0) return toSelection(matchLanguages());
  if (flaggedDefault) return toSelection(flaggedDefault);
  const engineDefault = candidates.find((candidate) => candidate.kind === "embedded" && candidate.id === input.embeddedDefaultPickId);
  return toSelection(engineDefault);
}
