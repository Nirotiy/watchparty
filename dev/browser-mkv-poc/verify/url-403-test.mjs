#!/usr/bin/env node
// Signed-URL 403 / renewal fault injection against the local Caddy fix chain.
// Scenarios: A) probe 403 once -> paste refreshed URL -> parses; B) mid-playback range 403 -> paste -> playback/seek recovers;
// C) two consecutive 403s -> must fail clearly (no third retry, no full-body 200 download).
// Usage: node verify/url-403-test.mjs [sampleIndex=43]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const sample = Number(process.argv[2] || 43);
const label = `url-403-test-${sample}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const rawUrl = (await new Promise((res, rej) => {
  const p = spawn(process.execPath, [join(here, "sign-url.mjs"), String(sample)], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  p.stdout.on("data", (c) => { o += c; });
  p.on("close", (code) => (code === 0 ? res(o.trim()) : rej(new Error("sign-url failed"))));
}));
const probeUrl = rawUrl.replace("http://127.0.0.1:5349", "http://127.0.0.1:5398");
const urlMarker = new URL(rawUrl).search.length > 1 ? new URL(rawUrl).search : "";

// start the injection proxy
const injector = spawn(process.execPath, [join(here, "inject-proxy.mjs"), "5398", "5397"], { stdio: ["ignore", "pipe", "pipe"] });
let injectorLog = "";
injector.stdout.on("data", (c) => { injectorLog += c; });
injector.stderr.on("data", (c) => { injectorLog += c; });
await sleep(800);
const inject = (qs) => fetch(`http://127.0.0.1:5398/__inject?${qs}`).then((r) => r.json());
const injectStats = () => fetch("http://127.0.0.1:5398/__stats").then((r) => r.json());

const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(exe)) throw new Error("chrome not found");
const profileDir = join(tmpdir(), `poc-url403-${Date.now()}`);
mkdirSync(profileDir, { recursive: true });
const portFile = join(profileDir, "DevToolsActivePort");
const child = spawn(exe, [
  `--user-data-dir=${profileDir}`, "--remote-debugging-port=0",
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1280,900", "http://localhost:5188/?mute=1",
], { stdio: "ignore" });

const kill = () => { try { child.kill(); } catch {} try { injector.kill(); } catch {} };
process.on("exit", kill);

let port;
for (let i = 0; i < 120; i += 1) { await sleep(250); if (existsSync(portFile)) { port = readFileSync(portFile, "utf8").split("\n")[0].trim(); break; } }
if (!port) throw new Error("DevToolsActivePort missing");
let target;
for (let i = 0; i < 80; i += 1) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  target = list.find((t) => t.type === "page" && (t.url || "").includes("localhost:5188"));
  if (target?.webSocketDebuggerUrl) break;
  await sleep(250);
}
if (!target) throw new Error("page target missing");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const consoleEntries = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve: res, reject: rej } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
    consoleEntries.push({ type: message.params.type, text });
  }
  if (message.method === "Log.entryAdded") consoleEntries.push({ type: message.params.entry.level, text: String(message.params.entry.text).slice(0, 300) });
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const stateText = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);
const eventLines = () => evalJs(`[...document.querySelectorAll("#events li")].map(li => li.innerText.replace(/\\s+/g, " "))`);
const waitFor = async (fn, timeoutMs) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(300);
  }
};
const pasteUrl = async (url) => {
  await evalJs(`(() => { const i = document.querySelector("#media-url"); i.value = ${JSON.stringify(url)}; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
};

await send("Runtime.enable");
await send("Log.enable");
await waitFor(() => evalJs(`!!document.querySelector("#inspect")`), 30000);

const result = { label, sample, scenarios: {}, consoleLeak: null, injectorStats: null };
const promptCount = async () => (await eventLines()).filter((t) => t.includes("403") && t.includes("粘贴刷新后")).length;

// ---- Scenario A: probe 403 once -> refresh -> parse ok -------------------------------------
await evalJs(`document.querySelector('[data-mode="url"]').click()`);
await pasteUrl(probeUrl);
const pA0 = await promptCount();
await inject("probe403=1");
await evalJs(`document.querySelector("#inspect").click()`);
const promptA = await waitFor(async () => (await promptCount()) > pA0, 20000);
await pasteUrl(probeUrl);
const demuxA = await waitFor(async () => { const d = await stateText("#demux-state"); return d.includes("已解析") || d.includes("失败") ? d : null; }, 60000);
const pA1 = await promptCount();
result.scenarios.A = { saw403Prompt: Boolean(promptA), promptsDelta: pA1 - pA0, demux: demuxA, ok: Boolean(demuxA?.includes("已解析")) && (pA1 - pA0) === 1 };

// ---- Scenario B: mid-playback range 403 -> refresh -> recovers -----------------------------
await evalJs(`document.querySelector("#play-toggle").click()`);
await sleep(3500);
const beforeB = await stateText("#seek-time");
const pB0 = await promptCount();
await inject("range403=1");
const promptB = await waitFor(async () => (await promptCount()) > pB0, 30000);
await pasteUrl(probeUrl);
const recoveredB = await waitFor(async () => { const s = await stateText("#seek-time"); return s !== beforeB ? s : null; }, 30000);
const pB1 = await promptCount();
result.scenarios.B = { saw403Prompt: Boolean(promptB), promptsDelta: pB1 - pB0, before: beforeB, after: recoveredB, ok: Boolean(promptB) && Boolean(recoveredB) && (pB1 - pB0) === 1 };
await evalJs(`document.querySelector("#play-toggle").click()`); // pause for scenario C

// ---- Scenario C: two consecutive 403s -> must fail clearly ---------------------------------
const pC0 = await promptCount();
await inject("reset=1&probe403=2");
await pasteUrl(probeUrl);
const eventsBeforeC = (await eventLines()).length;
await evalJs(`document.querySelector("#inspect").click()`);
const promptC = await waitFor(async () => (await promptCount()) > pC0, 20000);
await pasteUrl(probeUrl);   // still 403ing; retry must be rejected and then fail
const failedC = await waitFor(async () => {
  const lines = await eventLines();
  return lines.slice(0, Math.max(6, lines.length - eventsBeforeC + 6)).find((t) => /403/.test(t) && /失败|需要 206|仍失败/.test(t)) ?? (lines.find((t) => t.includes("仍失败") || t.includes("需要 206")) ?? null);
}, 30000);
await sleep(1500);
const pC1 = await promptCount();
const noThirdRetry = (pC1 - pC0) === 1;
result.scenarios.C = { saw403Prompt: Boolean(promptC), promptsDelta: pC1 - pC0, failureLine: failedC, noThirdRetry, ok: Boolean(promptC) && Boolean(failedC) && noThirdRetry };

// ---- leak check + stats --------------------------------------------------------------------
const leakHits = consoleEntries.filter((e) => urlMarker && (e.text.includes(urlMarker) || e.text.match(/sign=/i)));
result.consoleLeak = { markerChecked: Boolean(urlMarker), hits: leakHits.length, samples: leakHits.slice(0, 3).map((e) => e.text.slice(0, 80)) };
result.injectorStats = await injectStats();
result.injectorLogTail = injectorLog.split("\n").slice(-12);
result.ok = result.scenarios.A.ok && result.scenarios.B.ok && result.scenarios.C.ok && result.consoleLeak.hits === 0;

writeFileSync(join(resultsDir, `${label}.json`), JSON.stringify(result, null, 1), "utf8");
console.log(JSON.stringify({ A: result.scenarios.A, B: result.scenarios.B, C: result.scenarios.C, leak: result.consoleLeak.hits, injector: result.injectorStats }, null, 1));
kill();
process.exit(result.ok ? 0 : 2);
