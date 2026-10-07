#!/usr/bin/env node
// P0 rig: records display output (ddagrab) + HDA mic (physical) + E1x2 loopback (digital control)
// in ONE ffmpeg process (shared timeline), while the harness drives an unmuted POC playback run.
// Usage: node verify/av-sync-capture.mjs --label <name> [--browser chrome|edge] [--file <path>]
//        [--media <signedUrl>] [--seconds 300] [--seeks "340"] [--captureSeconds N] [--noE1x2]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { uptime as osUptime } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next !== undefined && !next.startsWith("--") ? next : true;
};
const label = opt("label");
if (!label) throw new Error("--label is required");
const browser = String(opt("browser", "chrome"));
const mode = opt("file") ? "file" : "url";
const filePath = opt("file");
const mediaUrl = opt("media");
const playSeconds = Number(opt("seconds", 300));
const seeks = String(opt("seeks", "340"));
const captureSeconds = Number(opt("captureSeconds", playSeconds + 100));
const withE1x2 = !opt("noE1x2");
const fullscreen = Boolean(opt("fullscreen"));
const monitorSpec = opt("monitor"); // "x,y,w,h,outputIdx" — target display for window + capture
let monitor = null;
if (typeof monitorSpec === "string") {
  const parts = monitorSpec.split(",").map(Number);
  if (parts.length >= 4 && parts.every(Number.isFinite)) {
    monitor = { x: parts[0], y: parts[1], w: parts[2], h: parts[3], outputIdx: Number.isFinite(parts[4]) ? parts[4] : 0 };
  }
}
if (mode === "file" && typeof filePath !== "string") throw new Error("--file <path> required for file mode");

const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const capturePath = join(resultsDir, `${label}-capture.mkv`);
const captureLogPath = join(resultsDir, `${label}-capture.log`);
const metaPath = join(resultsDir, `${label}-capture-meta.json`);

const MIC = "Microphone (High Definition Audio Device)";
const E1X2 = "Loopback 1/2 (2- E1x2 OTG)";

const ffmpegArgs = [
  "-hide_banner", "-loglevel", "info",
  "-f", "lavfi", "-i", `ddagrab=output_idx=${monitor ? monitor.outputIdx : 0}:framerate=30`,
  "-f", "dshow", "-audio_buffer_size", "20", "-i", `audio=${MIC}`,
];
if (withE1x2) ffmpegArgs.push("-f", "dshow", "-audio_buffer_size", "20", "-i", `audio=${E1X2}`);
ffmpegArgs.push(
  "-filter_complex", "[0:v]hwdownload,format=bgra,scale=640:360[outv]",
  "-map", "[outv]",
  "-map", "1:a",
);
if (withE1x2) ffmpegArgs.push("-map", "2:a");
ffmpegArgs.push(
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "flac",
  "-t", String(captureSeconds),
  "-y", capturePath,
);

const capture = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"] });
const captureClosed = new Promise((res) => capture.on("close", res));
capture.stdin.on("error", () => { /* EPIPE if ffmpeg already exited */ });
let captureLog = "";
capture.stderr.setEncoding("utf8");
capture.stderr.on("data", (chunk) => { captureLog += chunk; });
const captureStart = Date.now();
// gdigrab stamps frames with UTC epoch seconds while dshow stamps with uptime seconds;
// this bridge converts between the two so the per-run capture skew can be computed.
const bridgeEpochMinusUptime = Date.now() / 1000 - osUptime();
console.log(`capture started: ${label} (t=${captureSeconds}s) -> ${capturePath}`);

// Calibration flash: a fullscreen white form shown once right after capture start. Its show
// timestamp (wall clock, printed by the form process) anchors the zero-based ddagrab timeline
// to the same wall clock the dshow inputs report, so the per-run capture skew is measurable.
await new Promise((r) => setTimeout(r, 800));
let calibrationWallEpochSec = null;
{
  const ps = "Add-Type -AssemblyName System.Windows.Forms; " +
    "Add-Type -AssemblyName System.Drawing; " +
    "$f = New-Object System.Windows.Forms.Form; " +
    "$f.FormBorderStyle = 'None'; $f.TopMost = $true; " +
    (monitor
      ? `$f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(${monitor.x},${monitor.y}); $f.Size = New-Object System.Drawing.Size(${monitor.w},${monitor.h}); `
      : "$f.WindowState = 'Maximized'; ") +
    "$f.BackColor = [System.Drawing.Color]::White; $f.Show(); " +
    "[Console]::Out.WriteLine('CALIB ' + ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0)); " +
    "Start-Sleep -Milliseconds 1200; $f.Close();";
  const p = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] });
  let o = "";
  p.stdout.on("data", (c) => { o += c; });
  await new Promise((res) => p.on("close", res));
  const m = /CALIB ([\d.]+)/.exec(o);
  if (m) calibrationWallEpochSec = Number(m[1]);
  console.log(`calibration flash at epoch ${calibrationWallEpochSec}`);
}
await new Promise((r) => setTimeout(r, 300));

const harnessArgs = [
  join(here, "harness.mjs"),
  "--label", label,
  "--browser", browser,
  "--mode", mode,
  "--seconds", String(playSeconds),
  "--seeks", seeks,
  "--unmute",
  "--port", "5188",
];
if (fullscreen) harnessArgs.push("--fullscreen");
if (monitor) harnessArgs.push("--windowPos", `${monitor.x},${monitor.y}`);
if (opt("resume")) harnessArgs.push("--resume", String(opt("resume")));
if (opt("rate")) harnessArgs.push("--rate", String(opt("rate")));
if (opt("rateAt")) harnessArgs.push("--rateAt", String(opt("rateAt")));
if (mode === "file") harnessArgs.push("--file", resolve(String(filePath)));
else harnessArgs.push("--media", String(mediaUrl));
const harness = spawn(process.execPath, harnessArgs, { stdio: ["ignore", "inherit", "inherit"] });

// The harness window must be on top for the screen capture to see the canvas; force z-order
// explicitly instead of relying on --start-fullscreen focus behavior.
if (fullscreen) {
  const suffix = browser === "edge" ? " - Microsoft Edge" : " - Google Chrome";
  const windowTitle = `POC_AV_CAPTURE_${label}${suffix}`;
  const ps = [
    "Add-Type -Namespace W -Name E -MemberDefinition '",
    "[DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);",
    "public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);",
    "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);",
    "[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);",
    "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);",
    "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
    "';",
    "$script:found = [IntPtr]::Zero;",
    `$cb = [W.E+EnumWindowsProc]{ param($h,$l); $sb = New-Object System.Text.StringBuilder 1024; [void][W.E]::GetWindowText($h,$sb,1024); $t = $sb.ToString(); if ($t -eq '${windowTitle.replace(/'/g, "''")}') { $script:found = $h; return $false }; return $true };`,
    "[void][W.E]::EnumWindows($cb, [IntPtr]::Zero);",
    "if ($script:found -eq [IntPtr]::Zero) { exit 2 }",
    "[void][W.E]::SetWindowPos($script:found, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002);",
    "[void][W.E]::ShowWindow($script:found, 3);",
    "[void][W.E]::SetForegroundWindow($script:found);",
    "exit 0",
  ].join(" ");
  void (async () => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
      if (r.status === 0) { console.log(`window forced to front: ${windowTitle}`); break; }
      if (harness.exitCode !== null) break;
    }
  })();
}

const stallSpec = opt("stall"); // "secondsAfterSpawn,stallMs" for the underrun run
if (typeof stallSpec === "string") {
  const [atSec, ms] = stallSpec.split(",").map(Number);
  setTimeout(() => {
    fetch(`http://127.0.0.1:5191/__stall?ms=${ms}`)
      .then((r) => r.text())
      .then((t) => console.log(`stall triggered at +${atSec}s: ${t.trim()}`))
      .catch((e) => console.log(`stall trigger failed: ${e.message}`));
  }, atSec * 1000);
}
const liftSec = opt("lift"); // "secondsAfterSpawn" -> clear the media-server throttle
if (typeof liftSec === "string") {
  setTimeout(() => {
    fetch("http://127.0.0.1:5191/__throttle?kbps=0")
      .then((r) => r.text())
      .then((t) => console.log(`throttle lifted at +${liftSec}s: ${t.trim()}`))
      .catch((e) => console.log(`lift failed: ${e.message}`));
  }, Number(liftSec) * 1000);
}
const harnessExit = await new Promise((res) => harness.on("close", res));
console.log(`harness exited: ${harnessExit}`);
// Stop the capture gracefully so the mkv finalizes.
await new Promise((res) => setTimeout(res, 800));
if (capture.exitCode === null) {
  try { capture.stdin.write("q"); capture.stdin.end(); } catch { /* already gone */ }
}
const captureExit = await new Promise((res) => {
  const timer = setTimeout(() => { try { capture.kill(); } catch {} }, 15000);
  captureClosed.then((code) => { clearTimeout(timer); res(code ?? "killed"); });
});
const captureEnd = Date.now();
writeFileSync(captureLogPath, captureLog, "utf8");

const meta = {
  label,
  browser,
  mode,
  fullscreen,
  monitor,
  stallSpec: typeof stallSpec === "string" ? stallSpec : null,
  captureFile: capturePath,
  devices: { video: `ddagrab output_idx=${monitor ? monitor.outputIdx : 0} @30fps scaled 640x360`, audio0: MIC, audio1: withE1x2 ? E1X2 : null },
  bridgeEpochMinusUptime,
  calibrationWallEpochSec,
  captureStartEpochMs: captureStart,
  captureEndEpochMs: captureEnd,
  captureSecondsPlanned: captureSeconds,
  harnessExit,
  captureExit,
  file: mode === "file" ? resolve(String(filePath)) : null,
};
writeFileSync(metaPath, JSON.stringify(meta, null, 1), "utf8");
console.log(JSON.stringify({ label, harnessExit, captureExit, captureSecondsActual: ((captureEnd - captureStart) / 1000).toFixed(1) }));
