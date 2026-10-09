// UI 验收 fixture 生成器（可复现，替代此前丢失的临时文件）。
// 形状满足 mkv-ui-acceptance 的约定：
//   - 1920×1080 视频（画布宽度断言 1920）
//   - 2 条音轨（index 1 英语 aac / index 2 日语 opus）→ 菜单标签 "audio 1"/"audio 2"
//   - 2 条字幕轨（index 3 英语 / index 4 日语 srt）→ 标签 "subtitle 3"/"subtitle 4"
//   - 每 5 秒一条 "EN/JP M##" 提示（覆盖开头的字幕窗口探测 0.9s / 10.25s）
//   - 时长 8100s（容纳 buffering 段落的 seek 8000）
//   - 全部轨道不带 default/forced 标记（"默认标记缺失"正是要验收的现状）
// 用法：node web/tests/helpers/make-ui-fixture.mjs [输出路径]
// 然后用同一文件启动房间 fixture：
//   node web/tests/helpers/mkv-local-server.mjs <输出路径> 18981 18983
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const directory = path.dirname(process.argv[2] ?? path.join(tmpdir(), "watchparty-ui-fixture", "ui-fixture.mkv"));
await mkdir(directory, { recursive: true });
const target = process.argv[2] ?? path.join(directory, "ui-fixture.mkv");
const scratch = await mkdtemp(path.join(tmpdir(), "watchparty-ui-fixture-src-"));
const stamp = (seconds) => `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")},000`;
for (const language of ["EN", "JP"]) {
  const cues = Array.from({ length: 60 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, index }));
  await writeFile(path.join(scratch, `${language}.srt`),
    cues.map((cue) => `${cue.index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${language} M${String(cue.index).padStart(2, "0")}\n`).join("\n"));
}
await run("ffmpeg", ["-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=4",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
  "-i", path.join(scratch, "EN.srt"), "-i", path.join(scratch, "JP.srt"), "-t", "8100",
  "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-crf", "30", "-g", "48",
  "-c:a:0", "aac", "-b:a:0", "24k", "-ac:a:0", "1",
  "-c:a:1", "libopus", "-b:a:1", "24k", "-ac:a:1", "1",
  "-c:s", "srt",
  "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn",
  "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=jpn",
  "-y", target], { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 });
console.log(`fixture: ${target}`);
console.log(`node web/tests/helpers/mkv-local-server.mjs "${target}" 18981 18983`);
