// Dump Edge/Chrome GPU-status lines relevant to video decode acceleration.
// Usage: node verify/browser-gpu-probe.mjs edge|chrome
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const browser = process.argv[2] || "edge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = browser === "edge"
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  : "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profileDir = join(tmpdir(), `poc-gpuprobe-${browser}-${Date.now()}`);
mkdirSync(profileDir, { recursive: true });
const portFile = join(profileDir, "DevToolsActivePort");
const child = spawn(exe, [`--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--no-first-run",
  "--no-default-browser-check", `--window-size=900,700`, "about:blank"], { stdio: "ignore" });

let port;
for (let i = 0; i < 120; i += 1) { await sleep(250); try { port = readFileSync(portFile, "utf8").split("\n")[0].trim(); break; } catch {} }
let target;
for (let i = 0; i < 80; i += 1) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  target = list.find((t) => t.type === "page");
  if (target?.webSocketDebuggerUrl) break;
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

await send("Page.navigate", { url: browser === "edge" ? "edge://gpu" : "chrome://gpu" });
await sleep(9000);
const text = await evalJs("document.documentElement ? document.documentElement.innerText : ''");
const lines = String(text).split("\n").map((l) => l.trim());
const keep = lines.filter((l) => /video decode|video encode|hardware accel|DXVA|H264|H\.264|HEVC|AV1|Vulkan|OpenGL|ANGLE|GPU0|GPU1|drive|bl|blocklist|software only|沙盒|Problems|disabled/i.test(l));
writeFileSync(join(tmpdir(), `gpu-probe-${browser}.txt`), String(text), "utf8");
console.log(keep.slice(0, 45).join("\n"));
console.log("---- total lines:", lines.length, "saved full text to %TEMP%/gpu-probe-" + browser + ".txt");
child.kill();
process.exit(0);
