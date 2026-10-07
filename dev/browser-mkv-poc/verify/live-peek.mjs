// Attach to the currently-running harness Chrome (newest poc-verify-chrome profile) and read POC state live.
// Usage: node verify/live-peek.mjs [--gap 3000]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const gap = Number((process.argv.indexOf("--gap") >= 0 ? process.argv[process.argv.indexOf("--gap") + 1] : 3000)) || 3000;
const dirs = readdirSync(tmpdir()).filter((name) => name.startsWith("poc-verify-chrome-")).map((name) => ({
  path: join(tmpdir(), name), mtime: statSync(join(tmpdir(), name)).mtimeMs,
})).sort((a, b) => b.mtime - a.mtime);
if (!dirs.length) throw new Error("no poc-verify-chrome profile found");

let connected = false;
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
    const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
    await send("Runtime.enable");
    console.log("attached:", dir.path, "port", port, "url", target.url.replace(/media=[^&]+/, "media=…"));
    const snap = async () => ({
      at: new Date().toTimeString().slice(0, 8),
      seekTime: await evalJs(`document.querySelector("#seek-time")?.textContent`),
      decode: await evalJs(`document.querySelector("#decode-state")?.textContent`),
      requests: await evalJs(`document.querySelector("#metric-requests")?.textContent`),
      bytes: await evalJs(`document.querySelector("#metric-bytes")?.textContent`),
      coverage: await evalJs(`document.querySelector("#metric-full")?.textContent`),
      limitations: await evalJs(`document.querySelector("#limitations")?.textContent`),
    });
    const a = await snap();
    await new Promise((r) => setTimeout(r, gap));
    const b = await snap();
    console.log(JSON.stringify(a));
    console.log(JSON.stringify(b));
    console.log("mediaTime delta over " + gap + "ms:", (b.seekTime || "").split(" /")[0], "->", (a.seekTime || "").split(" /")[0]);
    const events = await evalJs(`[...document.querySelectorAll("#events li")].slice(0, 16).map(li => li.innerText.replace(/\\s+/g, " ")).join("\\n")`);
    console.log("--- newest events:\n" + String(events).slice(0, 2600));
    connected = true;
    break;
  } catch (error) {
    console.error("skip", dir.path, String(error).slice(0, 120));
  }
}
if (!connected) throw new Error("could not attach to any harness browser");
process.exit(0);
