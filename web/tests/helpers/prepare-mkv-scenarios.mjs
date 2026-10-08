// Synthetic media only; attached Windows font stays in this machine's temporary directory.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "watchparty-next-scenarios-"));
const file = (name) => path.join(directory, name);
const stamp = (seconds, separator = ",") => `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${separator}000`;
const cues = Array.from({ length: 36 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, index: i }));
for (const language of ["EN", "JP"]) await writeFile(file(`${language}.srt`), cues.map((cue) =>
  `${cue.index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${language} M${String(cue.index).padStart(2, "0")}\n`).join("\n"));
const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Comic Sans MS,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
const assTime = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.00`;
await writeFile(file("embedded.ass"), header + cues.map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,ASS M${String(cue.index).padStart(2, "0")} Font Test WWW iii`).join("\n"));
await writeFile(file("external-vtt.en.vtt"), "WEBVTT\n\n" + cues.map((cue) => `${stamp(cue.start, ".")} --> ${stamp(cue.end, ".")}\nVTT M${String(cue.index).padStart(2, "0")}\n`).join("\n"));
await writeFile(file("external-ass.en.ass"), header + cues.map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,EXTERNAL ASS M${String(cue.index).padStart(2, "0")}`).join("\n"));
console.log("Generating distinct AAC 440 Hz / Opus 880 Hz and two SRT contents...");
await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
  "-i", file("EN.srt"), "-i", file("JP.srt"), "-t", "180", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-b:v", "8M", "-minrate", "8M", "-maxrate", "8M", "-bufsize", "16M", "-x264-params", "nal-hrd=cbr:keyint=30",
  "-c:a:0", "aac", "-b:a:0", "96k", "-c:a:1", "libopus", "-b:a:1", "96k", "-c:s", "srt",
  "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=AAC 440 Hz", "-metadata:s:a:1", "language=jpn", "-metadata:s:a:1", "title=Opus 880 Hz",
  "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=jpn", "-y", file("tracks.mkv")], { maxBuffer: 1024 * 1024 });
await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file("tracks.mkv"),
  "-map", "0:v", "-map", "0:a:1", "-map", "0:a:0", "-map", "0:s:1", "-map", "0:s:0", "-c", "copy", "-y", file("tracks-reordered.mkv")]);
for (const attached of [true, false]) {
  const args = ["-hide_banner", "-loglevel", "error", "-i", file("tracks.mkv"), "-i", file("embedded.ass"), "-map", "0:v", "-map", "0:a:0", "-map", "1:s", "-c", "copy"];
  if (attached) args.push("-attach", "C:/Windows/Fonts/comic.ttf", "-metadata:s:t", "mimetype=application/x-truetype-font", "-metadata:s:t", "filename=comic.ttf");
  await run("ffmpeg", [...args, "-y", file(attached ? "ass-font.mkv" : "ass-fallback.mkv")]);
}
for (const [name, color, size] of [["short-a.mkv", "green", "320x180"], ["short-b.mkv", "red", "480x270"]]) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=30`,
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", file(name)]);
}
const manifest = { directory, files: [
  { name: "tracks.mkv", file: "tracks.mkv" }, { name: "tracks-reordered.mkv", file: "tracks-reordered.mkv" }, { name: "ass-font.mkv", file: "ass-font.mkv" }, { name: "ass-fallback.mkv", file: "ass-fallback.mkv" },
  { name: "external-vtt.mkv", file: "tracks.mkv" }, { name: "external-ass.mkv", file: "ass-font.mkv" },
  { name: "external-vtt.en.vtt", file: "external-vtt.en.vtt" }, { name: "external-ass.en.ass", file: "external-ass.en.ass" },
  { name: "short-a.mkv", file: "short-a.mkv" }, { name: "short-b.mkv", file: "short-b.mkv" },
] };
await writeFile(file("manifest.json"), JSON.stringify(manifest));
console.log(`Manifest: ${file("manifest.json")}`);
