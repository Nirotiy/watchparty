#!/usr/bin/env node
// Zero-dependency CDP harness that drives the MKV POC in real Chrome/Edge and records evidence.
// Usage:
//   node verify/harness.mjs --label <name> --browser chrome|edge --mode url --media <signedUrl> [options]
//   node verify/harness.mjs --label <name> --browser chrome|edge --mode file --file <path> [options]
// Options: --seconds <playSeconds> --seeks "60,120" --readLimit <bytes> --videoOnly --unmute --keepProfile
// Output: verify/results/<label>.json + screenshots (media URL never written to results).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next !== undefined && !next.startsWith("--") ? next : true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const label = opt("label");
if (!label) throw new Error("--label is required");
const browserKey = String(opt("browser", "chrome"));
const mode = String(opt("mode", "url"));
const browserPath = opt("browserPath");
const mediaUrl = opt("media");
const filePath = opt("file");
const playSeconds = Number(opt("seconds", 30)) || 30;
const seeks = String(opt("seeks", "")).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const keepProfile = Boolean(opt("keepProfile"));
const captureGate = typeof opt("captureGate") === "string" ? resolve(String(opt("captureGate"))) : null;
const pocPort = Number(opt("port", 5188));

const BROWSERS = {
  chrome: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  edge: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
};
const exe = typeof browserPath === "string" ? resolve(browserPath) : BROWSERS[browserKey];
if (!exe || !existsSync(exe)) throw new Error(`Browser binary not found for ${browserKey}: ${exe}`);
if (mode === "url" && typeof mediaUrl !== "string") throw new Error("--mode url needs --media <signedUrl>");
if (mode === "file" && typeof filePath !== "string") throw new Error("--mode file needs --file <path>");

const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const profileDir = join(tmpdir(), `poc-verify-${browserKey}-${process.pid}-${Date.now()}`);
mkdirSync(profileDir, { recursive: true });
const portFile = join(profileDir, "DevToolsActivePort");

const query = new URLSearchParams();
query.set("mute", opt("unmute") ? "0" : "1");
if (opt("videoOnly")) query.set("video-only", "1");
if (opt("readLimit")) query.set("read-limit", String(opt("readLimit")));
if (opt("rate")) query.set("rate", String(opt("rate")));
const pageUrl = `http://localhost:${pocPort}/?${query.toString()}`;

const result = {
  label, browser: browserKey, executable: exe, mode,
  pageUrl: pageUrl.replace(/\/\/[^/]+/, "//localhost:" + pocPort),
  startedAt: new Date().toISOString(), steps: [],
};
const mediaHost = mode === "url" ? new URL(String(mediaUrl)).host : null;
const mediaReqs = new Map();
const network = { statuses: {}, mediaStatuses: {}, encodedBytesByHost: {}, mediaResponses: [], failed: [] };
const consoleEntries = [];

const child = spawn(exe, [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0",
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  ...(opt("windowPos") ? [`--window-position=${opt("windowPos")}`] : []),
  ...(opt("fullscreen") ? ["--start-fullscreen"] : ["--window-size=1280,900"]),
  ...(opt("extra") ? [String(opt("extra"))] : []),
  "about:blank",
], { stdio: "ignore" });

try {
  let port;
  for (let i = 0; i < 160; i += 1) {
    if (existsSync(portFile)) {
      port = readFileSync(portFile, "utf8").split("\n")[0].trim();
      break;
    }
    await sleep(250);
  }
  if (!port) throw new Error("DevToolsActivePort was not created");
  result.devtoolsPort = Number(port);

  let target;
  for (let i = 0; i < 80; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target?.webSocketDebuggerUrl) break;
    await sleep(250);
  }
  if (!target) throw new Error("No page target on DevTools");

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
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const sessionId = message.params?.sessionId;
      if (sessionId) void send("Network.enable", {}, sessionId).catch(() => {});
      return;
    }
    const p = message.params;
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240);
      if (["error", "warning", "assert"].includes(p.type)) consoleEntries.push({ type: p.type, text, at: Date.now() });
    } else if (message.method === "Log.entryAdded" && p.entry.level !== "verbose") {
      consoleEntries.push({ type: p.entry.level, text: String(p.entry.text).slice(0, 240), at: Date.now() });
    } else if (message.method === "Network.requestWillBeSent") {
      mediaReqs.set(p.requestId, p.request.url);
    } else if (message.method === "Network.responseReceived") {
      const url = p.response.url;
      const host = safeHost(url);
      network.statuses[p.response.status] = (network.statuses[p.response.status] ?? 0) + 1;
      if (mediaHost && host === mediaHost) {
        network.mediaStatuses[p.response.status] = (network.mediaStatuses[p.response.status] ?? 0) + 1;
        if (network.mediaResponses.length < 3) {
          const h = p.response.headers || {};
          const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
          network.mediaResponses.push({
            status: p.response.status,
            fromDiskCache: p.response.fromDiskCache ?? null,
            contentRange: lower["content-range"] ?? null,
            acceptRanges: lower["accept-ranges"] ?? null,
            exposeHeaders: lower["access-control-expose-headers"] ?? null,
            allowOrigin: lower["access-control-allow-origin"] ?? null,
          });
        }
      }
    } else if (message.method === "Network.loadingFinished") {
      const url = mediaReqs.get(p.requestId);
      if (url) {
        const host = safeHost(url);
        network.encodedBytesByHost[host] = (network.encodedBytesByHost[host] ?? 0) + (p.encodedDataLength ?? 0);
      }
    } else if (message.method === "Network.loadingFailed") {
      const url = mediaReqs.get(p.requestId) ?? "";
      if (network.failed.length < 40) network.failed.push({ error: p.errorText, blocked: p.blockedReason ?? null, host: safeHost(url) });
    }
  };
  const send = (method, params = {}, sessionId = undefined) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 300)}`);
    return r.result?.value;
  };
  const waitFor = async (fn, timeoutMs, intervalMs = 400) => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
      await sleep(intervalMs);
    }
  };
  const stateText = (selector) => evalJs(`document.querySelector(${JSON.stringify(selector)})?.textContent || ""`);

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("DOM.enable");
  // Flattened auto-attach so worker-side network traffic (libav/JASSUB assets) is visible too.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  await send("Page.navigate", { url: pageUrl });
  await waitFor(async () => (await evalJs("document.readyState")) === "complete", 30000);
  await sleep(700);
  const windowTitle = `POC_AV_CAPTURE_${label}`;
  await evalJs(`document.title = ${JSON.stringify(windowTitle)}`);
  result.windowTitle = windowTitle;

  const snapshot = async () => ({
    ua: await evalJs("navigator.userAgent"),
    isolation: await stateText("#isolation-label"),
    browserLabel: await stateText("#browser-label"),
    sharedArrayBuffer: await evalJs("typeof SharedArrayBuffer"),
    crossOriginIsolated: await evalJs("crossOriginIsolated"),
    range: await stateText("#range-state"),
    demux: await stateText("#demux-state"),
    codecState: await stateText("#codec-state"),
    decode: await stateText("#decode-state"),
    tracks: await evalJs(`document.querySelector("#tracks")?.innerText`),
    subtitleNote: await stateText("#subtitle-note"),
    metrics: await evalJs(`(() => ({
      requests: document.querySelector("#metric-requests")?.textContent,
      bytes: document.querySelector("#metric-bytes")?.textContent,
      size: document.querySelector("#metric-size")?.textContent,
      full: document.querySelector("#metric-full")?.textContent,
      seek: document.querySelector("#metric-seek")?.textContent,
    }))()`),
    seekTime: await stateText("#seek-time"),
    limitations: await stateText("#limitations"),
    events: await evalJs(`[...document.querySelectorAll("#events li")].slice(0, 50).map(li => li.innerText.replace(/\\s+/g, " ")).join("\\n")`),
  });
  const shot = async (name) => {
    try {
      const s = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from(s.data, "base64"));
    } catch { /* screenshot is optional evidence */ }
  };

  result.initial = await snapshot();

  if (mode === "url") {
    await evalJs(`document.querySelector('[data-mode="url"]').click()`);
    await evalJs(`(() => { const i = document.querySelector("#media-url"); i.value = ${JSON.stringify(String(mediaUrl))}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  } else {
    await evalJs(`document.querySelector('[data-mode="file"]').click()`);
    const doc = await send("DOM.getDocument");
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#media-file" });
    await send("DOM.setFileInputFiles", { files: [resolve(String(filePath))], nodeId: q.nodeId });
  }
  result.steps.push({ step: "select-source", at: Date.now() });
  await evalJs(`document.querySelector("#inspect").click()`);
  await waitFor(async () => {
    const demux = await stateText("#demux-state");
    if (demux.includes("失败")) throw new Error(`POC demux failed: ${(await snapshot()).events.slice(0, 600)}`);
    return demux.includes("已解析");
  }, 120000);
  await sleep(800);
  // Clear the input so later screenshots never include a signed URL.
  await evalJs(`document.querySelector("#media-url").value = ""`);
  result.afterLoad = await snapshot();
  await shot("load");

  if (captureGate) await waitFor(async () => existsSync(captureGate), 120000, 100);

  await evalJs(`document.querySelector("#play-toggle").click()`);
  for (const entry of String(opt("rateAt", "")).split(",").map((s) => s.trim()).filter(Boolean)) {
    const [atSec, value] = entry.split(":").map(Number);
    if (Number.isFinite(atSec) && Number.isFinite(value)) {
      setTimeout(() => { void evalJs(`globalThis.__pocSetRate && globalThis.__pocSetRate(${value})`); }, atSec * 1000);
    }
  }
  await sleep(1200);
  const playStart = Date.now();
  result.playSamples = [];
  while ((Date.now() - playStart) / 1000 < playSeconds) {
    await sleep(5000);
    result.playSamples.push({
      wallSeconds: Number(((Date.now() - playStart) / 1000).toFixed(1)),
      mediaTime: await stateText("#seek-time"),
      decode: await stateText("#decode-state"),
      requests: await stateText("#metric-requests"),
      bytes: await stateText("#metric-bytes"),
      coverage: await stateText("#metric-full"),
    });
  }
  await shot("playing");

  // Pause via the same toggle (playback may already have ended).
  const toggleText = async () => (await evalJs(`document.querySelector("#play-toggle")?.textContent.trim()`));
  if ((await toggleText()) === "Ⅱ") {
    await evalJs(`document.querySelector("#play-toggle").click()`);
    await sleep(900);
  }
  result.afterPause = await snapshot();

  result.seeks = [];
  for (const target of seeks) {
    const before = (await evalJs(`[...document.querySelectorAll("#events li")].filter(li => li.innerText.includes("libav seek")).length`)) || 0;
    await evalJs(`(() => { const s = document.querySelector("#seek-range"); s.value = ${JSON.stringify(String(target))}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    let seekEvent = null;
    try {
      await waitFor(async () => {
        const info = await evalJs(`(() => { const items = [...document.querySelectorAll("#events li")].filter(li => li.innerText.includes("libav seek")); return { count: items.length, latest: items[0]?.innerText.replace(/\\s+/g, " ") ?? "" }; })()`);
        if (info.count > before) { seekEvent = info.latest; return true; }
        return false;
      }, 30000);
    } catch { /* recorded as a seek failure below */ }
    result.seeks.push({
      targetSeconds: target,
      event: seekEvent,
      metricSeek: await stateText("#metric-seek"),
      decode: await stateText("#decode-state"),
      seekTime: await stateText("#seek-time"),
      requests: await stateText("#metric-requests"),
      bytes: await stateText("#metric-bytes"),
    });
    await sleep(400);
  }

  if (seeks.length) {
    await evalJs(`document.querySelector("#play-toggle").click()`);
    await sleep(Number(opt("resume", 5)) * 1000);
    result.postSeekResume = {
      decode: await stateText("#decode-state"),
      seekTime: await stateText("#seek-time"),
      requests: await stateText("#metric-requests"),
    };
    if ((await toggleText()) === "Ⅱ") {
      await evalJs(`document.querySelector("#play-toggle").click()`);
      await sleep(900);
    }
  }

  result.final = await snapshot();
  await shot("final");
} catch (error) {
  result.error = String(error?.stack ?? error).slice(0, 1500);
  try { result.partialFinal = null; } catch { /* ignore */ }
} finally {
  result.endedAt = new Date().toISOString();
  result.network = {
    statuses: network.statuses,
    mediaStatuses: network.mediaStatuses,
    encodedBytesByHost: network.encodedBytesByHost,
    mediaResponses: network.mediaResponses,
    failed: network.failed,
  };
  result.console = consoleEntries.slice(-80);
  writeFileSync(join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
  try { await new Promise((res) => { const c = child; c.once("exit", res); setTimeout(res, 2500); c.kill(); }); } catch { /* already gone */ }
  try { if (!keepProfile) rmSync(profileDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ }
  process.exit(result.error ? 2 : 0);
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return "invalid"; }
}
