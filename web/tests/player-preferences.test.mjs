import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/player-preferences.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const preferences = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => { values.delete(key); } };
}
const KEY = "watchparty.player-preferences.v1";
const DEFAULT_APPEARANCE = { fontScale: 100, color: "white", fontWeight: "normal", outline: "thin", shadow: "none", backgroundOpacity: 0, bottomRaisePercent: 0 };

test("preferences v3: defaults, round-trip, legacy migration (subtitlesOff / appearance / single languages)", () => {
  const local = storage();
  assert.deepEqual(preferences.readPlayerPreferences(local), {
    volume: 85, muted: false, audioLanguages: [], subtitleLanguages: [],
    subtitleMode: "media-default", subtitleSourcePreference: "external",
    subtitleAppearance: DEFAULT_APPEARANCE,
    skipBackwardSeconds: 10, skipForwardSeconds: 10, pictureFit: "contain",
  });
  preferences.savePlayerPreferences({ volume: 31, muted: true, audioLanguages: ["JPN", "jpn", "en"],
    subtitleLanguages: ["zh_TW", "en"], subtitleMode: "prefer-list", subtitleSourcePreference: "embedded",
    skipBackwardSeconds: 5, skipForwardSeconds: 30, pictureFit: "cover" }, local);
  const saved = preferences.readPlayerPreferences(local);
  assert.equal(saved.volume, 31);
  assert.equal(saved.muted, true);
  assert.deepEqual(saved.audioLanguages, ["ja", "en"]);
  assert.deepEqual(saved.subtitleLanguages, ["zh-tw", "en"]);
  assert.equal(saved.subtitleMode, "prefer-list");
  assert.equal(saved.subtitleSourcePreference, "embedded");
  assert.equal(saved.skipBackwardSeconds, 5);
  assert.equal(saved.skipForwardSeconds, 30);
  assert.equal(saved.pictureFit, "cover");
  // 旧 v1/v2 迁移：单值语言、subtitlesOff 布尔、外观布尔描边与 none/black 背景。
  local.setItem(KEY, JSON.stringify({ volume: 50, audioLanguage: "ja", subtitleLanguage: null, subtitlesOff: true,
    subtitleAppearance: { fontScale: 250, color: "yellow", outline: false, background: "black", bottomRaisePercent: 3 } }));
  const migrated = preferences.readPlayerPreferences(local);
  assert.deepEqual(migrated.audioLanguages, ["ja"]);
  assert.deepEqual(migrated.subtitleLanguages, []);
  assert.equal(migrated.subtitleMode, "off");
  assert.deepEqual(migrated.subtitleAppearance,
    { fontScale: 250, color: "yellow", fontWeight: "normal", outline: "none", shadow: "none", backgroundOpacity: 50, bottomRaisePercent: 5 });
  // subtitlesOff=false 不迁移成关闭。
  local.setItem(KEY, '{"subtitlesOff":false}');
  assert.equal(preferences.readPlayerPreferences(local).subtitleMode, "media-default");
  // 坏数据回退默认，不炸。
  local.setItem(KEY, '{"volume":900,"audioLanguages":"<script>","subtitleLanguages":[123,"en"],"subtitleMode":"nope","skipForwardSeconds":7,"pictureFit":"zoom"}');
  const bad = preferences.readPlayerPreferences(local);
  assert.equal(bad.volume, 100);
  assert.deepEqual(bad.audioLanguages, []);
  assert.deepEqual(bad.subtitleLanguages, ["en"]);
  assert.equal(bad.subtitleMode, "media-default");
  assert.equal(bad.skipForwardSeconds, 10);
  assert.equal(bad.pictureFit, "contain");
  local.setItem(KEY, "broken");
  assert.deepEqual(preferences.readPlayerPreferences(local), preferences.DEFAULT_PLAYER_PREFERENCES);
  // 列表限长（保序截断）。
  const many = ["en", "ja", "zh", "ko", "fr", "de", "es", "ru", "it", "pt"];
  assert.equal(preferences.savePlayerPreferences({ audioLanguages: many }, local).audioLanguages.length, preferences.LANGUAGE_LIST_LIMIT);
  // 存储不可用仍可用当前会话设置，且探测如实报告不可用。
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); }, removeItem() { throw Error("full"); } };
  assert.equal(preferences.savePlayerPreferences({ volume: 42 }, blocked).volume, 42);
  assert.equal(preferences.preferencesStorageAvailable(blocked), false);
  assert.equal(preferences.preferencesStorageAvailable(storage()), true);
});

test("subtitle appearance v3: palette, weight, outline, shadow, background opacity levels", () => {
  const local = storage();
  preferences.saveSubtitleAppearance({ fontScale: 250, color: "cyan", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 75 }, local);
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 250, color: "cyan", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 75, bottomRaisePercent: 0 });
  preferences.saveSubtitleAppearance({ color: "green", backgroundOpacity: 30, bottomRaisePercent: 3 }, local);
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 250, color: "green", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 25, bottomRaisePercent: 5 }); // 30 → 25；3 → 手动下限 5
  preferences.saveSubtitleAppearance({ color: "white", fontWeight: "normal", outline: "thin", shadow: "none", backgroundOpacity: 0, bottomRaisePercent: 0 }, local);
  const local2 = storage();
  local2.setItem(KEY, '{"subtitleAppearance":{"fontScale":999,"color":"blue","outline":"yes","background":"white","shadow":"x","backgroundOpacity":140,"bottomRaisePercent":99}}');
  assert.deepEqual(preferences.readPlayerPreferences(local2).subtitleAppearance,
    { fontScale: 300, color: "white", fontWeight: "normal", outline: "thin", shadow: "none", backgroundOpacity: 100, bottomRaisePercent: 30 });
  // 旧 v1 数据（没有 appearance 字段）向后兼容。
  local2.setItem(KEY, '{"volume":31,"muted":true}');
  assert.deepEqual(preferences.readPlayerPreferences(local2).subtitleAppearance, DEFAULT_APPEARANCE);
  assert.equal(preferences.readPlayerPreferences(local2).volume, 31);
});

test("offsets are clamped to ±30s, isolated by media, and never persist direct or signed URLs", () => {
  const local = storage();
  const a = preferences.getPreferenceMediaKey({ kind: "openlist", mediaId: "a" });
  const b = preferences.getPreferenceMediaKey({ kind: "youtube", videoId: "b" });
  preferences.saveSubtitleOffset(a, -1.8, local);
  preferences.saveSubtitleOffset(b, 2.5, local);
  assert.equal(preferences.readSubtitleOffset(a, local), -1.8);
  assert.equal(preferences.readSubtitleOffset(b, local), 2.5);
  assert.equal(preferences.readSubtitleOffset("other", local), 0);
  preferences.saveSubtitleOffset(a, 999, local);
  assert.equal(preferences.readSubtitleOffset(a, local), 30);
  preferences.saveSubtitleOffset(a, -999, local);
  assert.equal(preferences.readSubtitleOffset(a, local), -30);
  const direct = preferences.getPreferenceMediaKey({ kind: "http", url: "https://media.invalid/a?token=secret" });
  assert.equal(direct, null);
  preferences.saveSubtitleOffset(direct, 99, local);
  assert.ok(!JSON.stringify([...local.values]).includes("secret"));
  for (let index = 0; index < 101; index++) preferences.saveSubtitleOffset(`media:${index}`, index, local);
  assert.equal(preferences.readSubtitleOffset("media:0", local), 0);
  assert.equal(preferences.readSubtitleOffset("media:100", local), 30);
  preferences.clearAllSubtitleOffsets(local);
  assert.equal(preferences.readSubtitleOffset(b, local), 0);
});

test("audio matching: ordered list (exact then base, unsupported excluded) then engine default", () => {
  const tracks = { audioId: 1, subtitleId: null, items: [
    { id: 1, kind: "audio", codec: "aac", label: "EN", language: "eng", supported: true },
    { id: 19, kind: "audio", codec: "dts", label: "JA", language: "jpn", supported: false },
    { id: 20, kind: "audio", codec: "aac", label: "JA2", language: "ja", supported: true },
  ] };
  assert.equal(preferences.matchPreferredAudio(tracks, ["jpn"]), 20); // 不支持轨排除后主语言回退
  assert.equal(preferences.matchPreferredAudio(tracks, ["en", "ja"]), 1); // 列表顺序优先
  assert.equal(preferences.matchPreferredAudio(tracks, ["fr"]), 1); // 未命中 → 引擎默认
  assert.equal(preferences.matchPreferredAudio(tracks, []), 1); // 空列表 → 引擎默认
});

const embeddedTracks = [
  { id: 5, kind: "subtitle", codec: "subrip", label: "EN", language: "eng", supported: true },
  { id: 6, kind: "subtitle", codec: "subrip", label: "JA", language: "jpn", supported: true },
  { id: 7, kind: "subtitle", codec: "pgs", label: "TC", language: "zho", supported: false },
];
const externalTracks = [
  { id: "s1", label: "movie.en.srt", format: "srt", mediaId: "m", language: "en" },
  { id: "s2", label: "movie.zh.ass", format: "ass", mediaId: "m", language: "zh-Hans" },
];
const decide = (patch) => preferences.decideSubtitleSelection({
  mode: "media-default", languages: [], sourcePreference: "external",
  embedded: embeddedTracks, external: externalTracks, embeddedDefaultPickId: 5, ...patch,
});

test("subtitle decision: off wins, media-default fallback chain, no fabricated external default", () => {
  // 关闭最高优先级：任何候选都不选。
  assert.deepEqual(decide({ mode: "off", languages: ["en"] }), { kind: "none" });
  // 无默认标记（当前引擎常态）→ 语言列表；en 同时命中内嵌与外挂 → 来源偏好打破平局。
  assert.deepEqual(decide({ languages: ["en"] }), { kind: "external", track: externalTracks[0] });
  assert.deepEqual(decide({ languages: ["en"], sourcePreference: "embedded" }), { kind: "embedded", id: 5 });
  // 精确标签优先于主语言回退：zh 命中 zh-Hans（外挂）；内嵌 zho 不支持被排除。
  assert.deepEqual(decide({ languages: ["zh"] }), { kind: "external", track: externalTracks[1] });
  assert.deepEqual(decide({ languages: ["zh"], sourcePreference: "embedded" }), { kind: "external", track: externalTracks[1] });
  // 列表无命中 → 关闭；空列表（无默认标记）→ 关闭：外挂第一条不冒充默认轨。
  assert.deepEqual(decide({ languages: ["fr"] }), { kind: "none" });
  assert.deepEqual(decide({ languages: [] }), { kind: "none" });
  // 语言优先级高于来源偏好：列表第一项 ja 命中内嵌，即使 en 在外挂也有。
  assert.deepEqual(decide({ languages: ["ja", "en"], sourcePreference: "external" }), { kind: "embedded", id: 6 });
});

test("subtitle decision: default marker wins in media-default; prefer-list rules; engine fallback only for empty prefer-list", () => {
  const flagged = embeddedTracks.map((track) => track.id === 6 ? { ...track, default: true } : track);
  // 默认标记优先于语言列表（标记 JA，列表要 en 也给 JA）。
  assert.deepEqual(decide({ embedded: flagged, languages: ["en"] }), { kind: "embedded", id: 6 });
  // 空列表 + 标记 → 标记。
  assert.deepEqual(decide({ embedded: flagged, languages: [], mode: "prefer-list" }), { kind: "embedded", id: 6 });
  // 标记缺失时 media-default 不使用引擎默认（回退语言列表 → 未命中即关闭）。
  assert.deepEqual(decide({ languages: [], embeddedDefaultPickId: 5 }), { kind: "none" });
  // prefer-list：列表非空只按列表；未命中即关闭（即使有默认标记）。
  assert.deepEqual(decide({ mode: "prefer-list", languages: ["fr"], embedded: flagged }), { kind: "none" });
  assert.deepEqual(decide({ mode: "prefer-list", languages: ["ja"] }), { kind: "embedded", id: 6 });
  // prefer-list：列表为空且无标记 → 引擎自身默认选择可作回退。
  assert.deepEqual(decide({ mode: "prefer-list", languages: [], embeddedDefaultPickId: 5 }), { kind: "embedded", id: 5 });
  // 引擎默认轨不可用（不支持/不存在）→ 关闭。
  assert.deepEqual(decide({ mode: "prefer-list", languages: [], embeddedDefaultPickId: 7 }), { kind: "none" });
  assert.deepEqual(decide({ mode: "prefer-list", languages: [], embedded: [], external: externalTracks, embeddedDefaultPickId: null }), { kind: "none" });
});

test("subtitle decision: same-language candidates keep media track order when source preference ties", () => {
  const embedded = [
    { id: 5, kind: "subtitle", codec: "subrip", label: "EN-A", language: "eng", supported: true },
    { id: 9, kind: "subtitle", codec: "subrip", label: "EN-B", language: "eng", supported: true },
  ];
  // 内嵌优先、同语言多轨：保留媒体轨道顺序（首条）。
  assert.deepEqual(decide({ embedded, external: [], languages: ["en"], sourcePreference: "embedded", embeddedDefaultPickId: 5 }), { kind: "embedded", id: 5 });
  // 没有外挂候选时，即使外挂优先也用内嵌（来源偏好不是硬过滤）。
  assert.deepEqual(decide({ embedded, external: [], languages: ["en"], sourcePreference: "external", embeddedDefaultPickId: 5 }), { kind: "embedded", id: 5 });
});
