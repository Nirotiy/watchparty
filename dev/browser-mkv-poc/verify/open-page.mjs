#!/usr/bin/env node
// Opens a persistent interactive Chrome window on the POC page, loads a signed sample, and leaves it running.
// Usage: node verify/open-page.mjs [sampleIndex=35]
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const sample = Number(process.argv[2] || 35);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(exe)) throw new Error(`Chrome not found: ${exe}`);

const rawUrl = execFileSync(process.execPath, [join(here, "sign-url.mjs"), String(sample)], { encoding: "utf8" }).trim();
const mediaUrl = rawUrl.replace("http://127.0.0.1:5349", "http://127.0.0.1:5397");
const pageUrl = `http://localhost:5188/?mute=1`;

const profileDir = join(tmpdir(), "poc-manual-chrome");
mkdirSync(profileDir, { recursive: true });
const portFile = join(profileDir, "DevToolsActivePort");
if (existsSync(portFile)) rmSync(portFile);

const child = spawn(exe, [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0",
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "--window-size=1280,900",
  pageUrl,
], { stdio: "ignore", detached: true });
child.unref();

let port;
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  if (existsSync(portFile)) {
    port = readFileSync(portFile, "utf8").split("\n")[0].trim();
    break;
  }
}
if (!port) throw new Error("DevToolsActivePort was not created (is another poc-manual-chrome instance running?)");

let target;
for (let i = 0; i < 80; i += 1) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  target = list.find((t) => t.type === "page" && (t.url || "").includes("localhost:5188"));
  if (target?.webSocketDebuggerUrl) break;
  await sleep(250);
}
if (!target) throw new Error("POC page target not found on DevTools");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve: res, reject: rej } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

await send("Runtime.enable");
for (let i = 0; i < 60; i += 1) {
  if ((await evalJs(`!!document.querySelector("#media-url")`))) break;
  await sleep(250);
}

await evalJs(`document.querySelector('[data-mode="url"]').click()`);
await evalJs(`(() => { const i = document.querySelector("#media-url"); i.value = ${JSON.stringify(mediaUrl)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await evalJs(`document.querySelector("#inspect").click()`);

let loaded = false;
for (let i = 0; i < 480; i += 1) {
  await sleep(250);
  const demux = await evalJs(`document.querySelector("#demux-state")?.textContent ?? ""`);
  if (demux.includes("失败")) throw new Error("POC demux failed; see page event log");
  if (demux.includes("已解析")) { loaded = true; break; }
}
if (!loaded) throw new Error("Timed out waiting for track parse");
await sleep(500);

const state = await evalJs(`(() => ({
  demux: document.querySelector("#demux-state")?.textContent,
  seekTime: document.querySelector("#seek-time")?.textContent,
  tracks: (document.querySelector("#tracks")?.innerText || "").split("\\n").filter((l) => l === "VIDEO" || l === "AUDIO").join(","),
}))()`);
console.log(`open-page: sample ${sample} loaded; ${state.demux} | ${state.seekTime} | ${state.tracks}`);
console.log(`open-page: window left open at ${pageUrl} (paused; press play in the page). Do not screenshot with the URL field visible.`);
process.exit(0);
