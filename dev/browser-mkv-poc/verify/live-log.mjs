// 15s-granularity live logger for a running harness browser: records POC progress and read rate deltas.
// Usage: node verify/live-log.mjs [--interval 15000] [--samples 48] [--out 4k-live.csv]
import { readdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const interval = Number(arg("interval", 15000));
const samples = Number(arg("samples", 48));
const out = join(process.cwd(), "verify", "results", String(arg("out", "4k-live.csv")));

const dirs = readdirSync(tmpdir()).filter((name) => name.startsWith("poc-verify-chrome-")).map((name) => ({
  path: join(tmpdir(), name), mtime: statSync(join(tmpdir(), name)).mtimeMs,
})).sort((a, b) => b.mtime - a.mtime);

let evalJs = null;
for (const dir of dirs.slice(0, 4)) {
  try {
    const port = readFileSync(join(dir.path, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((t) => t.type === "page" && (t.url || "").includes("localhost:5188"));
    if (!target) continue;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable");
    evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
    console.log("attached to", dir.path);
    break;
  } catch { /* try next */ }
}
if (!evalJs) throw new Error("could not attach");

writeFileSync(out, "time,media,bytesMB,requests,decode,readMBpsAvg\n");
let prev = null;
for (let i = 0; i < samples; i += 1) {
  const snap = {
    t: Date.now(),
    media: await evalJs(`document.querySelector("#seek-time")?.textContent || ""`),
    bytesMB: parseFloat(await evalJs(`document.querySelector("#metric-bytes")?.textContent || "0"`)) || 0,
    requests: Number(await evalJs(`document.querySelector("#metric-requests")?.textContent || "0`)) || 0,
    decode: await evalJs(`document.querySelector("#decode-state")?.textContent || ""`),
  };
  let rate = "";
  if (prev) {
    const dt = (snap.t - prev.t) / 1000;
    rate = ((snap.bytesMB - prev.bytesMB) / dt).toFixed(2);
  }
  prev = snap;
  const row = `${new Date(snap.t).toTimeString().slice(0, 8)},${(snap.media || "").split(" /")[0]},${snap.bytesMB.toFixed(1)},${snap.requests},${snap.decode},${rate}`;
  console.log(row);
  appendFileSync(out, row + "\n");
  const ticks = await evalJs(`JSON.stringify((globalThis.__pocTelemetry && globalThis.__pocTelemetry.ticks || []).slice(-8))`);
  console.log("ticks:", ticks);
  appendFileSync(out + ".ticks", (ticks || "[]") + "\n");
  if (i < samples - 1) await new Promise((r) => setTimeout(r, interval));
}
console.log("done ->", out);
process.exit(0);
