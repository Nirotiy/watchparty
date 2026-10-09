import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/subtitle-parser.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const parser = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("parseSubtitleCues: SRT/VTT to plain-text cues (tags stripped, entities decoded), ASS/SSA empty", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,500\nHello <i>world</i>\n\n2\n00:00:05,000 --> 00:00:07,000\n第二行\n续行\n";
  assert.deepEqual(parser.parseSubtitleCues(srt, "srt"), [
    { start: 1, end: 3.5, text: "Hello world" },
    { start: 5, end: 7, text: "第二行\n续行" },
  ]);
  const vtt = "WEBVTT\n\nNOTE comment\n\ncue-1\n00:00:01.000 --> 00:00:02.000 align:middle\nA &amp; B\n\n00:01:02.500 --> 00:01:04.000\nSecond\n";
  assert.deepEqual(parser.parseSubtitleCues(vtt, "vtt"), [
    { start: 1, end: 2, text: "A & B" },
    { start: 62.5, end: 64, text: "Second" },
  ]);
  assert.deepEqual(parser.parseSubtitleCues("[Script Info]\nWhatever", "ass"), []);
  assert.deepEqual(parser.parseSubtitleCues("", "vtt"), []);
});
