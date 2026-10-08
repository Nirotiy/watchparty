import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Isolated real Chrome on H27T22; callers must close it in finally. */
export async function startChrome(left = 0, { headless = false, muteAudio = false } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "next-logic-check-"));
  const process = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    ...(headless ? ["--headless=new"] : []),
    ...(muteAudio ? ["--mute-audio"] : []),
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--window-position=${left},-1440`, "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  let ws;
  const close = async () => {
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ id: 999999, method: "Browser.close" })); ws.close(); }
    await sleep(500);
    process.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    let port;
    for (let i = 0; i < 80; i++) {
      try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
      catch { await sleep(100); }
    }
    assert.ok(port, "Chrome debugging port");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method) { events.push(message); if (events.length > 1000) events.shift(); }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(current, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: current, method, params }));
    });
    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    };
    return { send, evaluate, close, events };
  } catch (error) { await close(); throw error; }
}
