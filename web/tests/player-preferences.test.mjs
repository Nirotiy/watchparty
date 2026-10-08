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

test("preferences survive reload, migrate legacy single languages, and tolerate unavailable storage", () => {
  const local = storage();
  preferences.savePlayerPreferences({ volume: 31, muted: true, audioLanguages: ["JPN", "jpn", "en"],
    subtitleLanguages: ["zh_TW", "en"], subtitlesOff: true, subtitleSourcePreference: "embedded" }, local);
  assert.deepEqual(preferences.readPlayerPreferences(local), {
    volume: 31, muted: true,
    audioLanguages: ["ja", "en"],
    subtitleLanguages: ["zh-tw", "en"],
    subtitlesOff: true,
    subtitleSourcePreference: "embedded",
    subtitleAppearance: { fontScale: 100, color: "white", outline: true, background: "none", bottomRaisePercent: 0 },
  });
  // 旧 v1 单值字段迁移为单元素列表（null → 空列表）。
  local.setItem("watchparty.player-preferences.v1", '{"volume":50,"audioLanguage":"ja","subtitleLanguage":null,"subtitlesOff":false}');
  const migrated = preferences.readPlayerPreferences(local);
  assert.deepEqual(migrated.audioLanguages, ["ja"]);
  assert.deepEqual(migrated.subtitleLanguages, []);
  assert.equal(migrated.volume, 50);
  assert.equal(migrated.subtitleSourcePreference, "external");
  // 坏数据回退默认，不炸。
  local.setItem("watchparty.player-preferences.v1", '{"volume":900,"audioLanguages":"<script>","subtitleLanguages":[123,"en"]}');
  const bad = preferences.readPlayerPreferences(local);
  assert.equal(bad.volume, 100);
  assert.deepEqual(bad.audioLanguages, []);
  assert.deepEqual(bad.subtitleLanguages, ["en"]);
  local.setItem("watchparty.player-preferences.v1", "broken");
  assert.deepEqual(preferences.readPlayerPreferences(local), preferences.DEFAULT_PLAYER_PREFERENCES);
  // 列表限长（保序截断）。
  const many = ["en", "ja", "zh", "ko", "fr", "de", "es", "ru", "it", "pt"];
  assert.equal(preferences.savePlayerPreferences({ audioLanguages: many }, local).audioLanguages.length, preferences.LANGUAGE_LIST_LIMIT);
  // 存储不可用仍可用当前会话设置。
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); }, removeItem() { throw Error("full"); } };
  assert.equal(preferences.savePlayerPreferences({ volume: 42 }, blocked).volume, 42);
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

test("ordered language matching: list order, exact tag then base language, unsupported excluded, off first", () => {
  const tracks = { audioId: 1, subtitleId: 5, items: [
    { id: 1, kind: "audio", language: "eng", supported: true },
    { id: 19, kind: "audio", language: "jpn", supported: false },
    { id: 20, kind: "audio", language: "ja", supported: true },
    { id: 5, kind: "subtitle", language: "zh-CN", supported: true },
    { id: 31, kind: "subtitle", language: "zho_TW", supported: true },
  ] };
  // 列表顺序决定优先级：en 命中在前。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: ["en", "ja"], subtitleLanguages: ["zh-TW"], subtitlesOff: false }),
    { audioId: 1, subtitleId: 31 });
  // 精确标签优先：zh-CN 精确命中 id 5（先于 base 回退）。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: [], subtitleLanguages: ["zh-CN"], subtitlesOff: false }),
    { audioId: 1, subtitleId: 5 });
  // 主语言回退：zh 精确无、base 命中 zh-CN。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: [], subtitleLanguages: ["zh"], subtitlesOff: false }),
    { audioId: 1, subtitleId: 5 });
  // 不可用轨道被排除：jpn 精确命中 id19 但不支持 → base ja 回退 id20。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: ["jpn"], subtitleLanguages: [], subtitlesOff: false }),
    { audioId: 20, subtitleId: 5 });
  // 显式关闭优先于语言匹配。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: ["ja"], subtitleLanguages: ["zh"], subtitlesOff: true }),
    { audioId: 20, subtitleId: null });
  // 空列表＝媒体默认。
  assert.deepEqual(preferences.matchPreferredTracks(tracks, { audioLanguages: [], subtitleLanguages: [], subtitlesOff: false }),
    { audioId: 1, subtitleId: 5 });
});

test("external subtitle auto-selection follows the ordered list and falls back to the source default", () => {
  const subs = [
    { id: "s1", label: "movie.eng.srt", format: "srt", mediaId: "m", language: "en" },
    { id: "s2", label: "movie.zh.ass", format: "ass", mediaId: "m", language: "zh-Hans" },
  ];
  assert.equal(preferences.preferredExternalSubtitle(subs, []).id, "s1");          // 空表 → 外挂默认（首个）
  assert.equal(preferences.preferredExternalSubtitle(subs, ["zh"]).id, "s2");      // 主语言命中
  assert.equal(preferences.preferredExternalSubtitle(subs, ["fr"]).id, "s1");      // 无命中 → 来源默认轨（handoff §八）
});

test("subtitle appearance clamps ranges, merges patches, and stays backward compatible", () => {
  const local = storage();
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 100, color: "white", outline: true, background: "none", bottomRaisePercent: 0 });
  preferences.saveSubtitleAppearance({ fontScale: 250, background: "black" }, local);
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 250, color: "white", outline: true, background: "black", bottomRaisePercent: 0 });
  preferences.saveSubtitleAppearance({ color: "yellow", outline: false, bottomRaisePercent: 3 }, local);
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 250, color: "yellow", outline: false, background: "black", bottomRaisePercent: 5 }); // 3 → 夹到手动下限 5
  preferences.saveSubtitleAppearance({ bottomRaisePercent: 0 }, local);
  assert.equal(preferences.readPlayerPreferences(local).subtitleAppearance.bottomRaisePercent, 0);
  local.setItem("watchparty.player-preferences.v1",
    '{"subtitleAppearance":{"fontScale":999,"color":"blue","outline":"yes","background":"white","bottomRaisePercent":99}}');
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 300, color: "white", outline: true, background: "none", bottomRaisePercent: 30 });
  // 旧 v1 数据（没有 appearance 字段）向后兼容。
  local.setItem("watchparty.player-preferences.v1", '{"volume":31,"muted":true}');
  assert.deepEqual(preferences.readPlayerPreferences(local).subtitleAppearance,
    { fontScale: 100, color: "white", outline: true, background: "none", bottomRaisePercent: 0 });
  assert.equal(preferences.readPlayerPreferences(local).volume, 31);
});

test("manual track picks only toggle explicit-off and never rewrite the global language lists", () => {
  assert.deepEqual(preferences.trackPreferencePatch("audio", { id: 1, kind: "audio", language: "jpn", supported: true }), {});
  assert.deepEqual(preferences.trackPreferencePatch("subtitle", null), { subtitlesOff: true });
  assert.deepEqual(preferences.trackPreferencePatch("subtitle", { id: 5, kind: "subtitle", language: "zh-CN", supported: true }),
    { subtitlesOff: false });
});
