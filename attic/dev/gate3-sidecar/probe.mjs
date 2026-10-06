import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";

const mpv = process.env.GATE3_MPV_PATH ?? "D:/mpv/mpv-lazy/mpv.com";
const mediaFile = process.env.GATE3_MEDIA_FILE ?? path.resolve("dev/mpv-e2e/short.mp4");
const authValue = "Basic Z2F0ZTM6c2lkZWNhcg==";
const timeoutMs = 20_000;

if (!existsSync(mpv)) throw new Error(`mpv executable not found: ${mpv}`);
if (!existsSync(mediaFile)) throw new Error(`media fixture not found: ${mediaFile}`);

const mediaSize = statSync(mediaFile).size;
const requests = [];
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({ pathname, userAgent: request.headers["user-agent"] ?? "", range: request.headers.range ?? "", authorization: request.headers.authorization ?? "" });
  if (pathname === "/redirect.mp4") {
    response.writeHead(302, { location: "/direct.mp4" });
    response.end();
    return;
  }
  if (pathname === "/fallback.mp4" && request.headers.authorization !== authValue) {
    response.writeHead(401, { "www-authenticate": "Basic realm=gate3" });
    response.end();
    return;
  }
  if (!["/direct.mp4", "/fallback.mp4"].includes(pathname)) {
    response.writeHead(404);
    response.end();
    return;
  }
  const range = parseRange(request.headers.range, mediaSize);
  if (range) {
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": range.end - range.start + 1,
      "content-range": `bytes ${range.start}-${range.end}/${mediaSize}`,
      "accept-ranges": "bytes",
    });
    createReadStream(mediaFile, { start: range.start, end: range.end }).pipe(response);
    return;
  }
  response.writeHead(200, { "content-type": "video/mp4", "content-length": mediaSize, "accept-ranges": "bytes" });
  createReadStream(mediaFile).pipe(response);
});

function parseRange(value, size) {
  if (!value || !value.startsWith("bytes=")) return null;
  const [rawStart, rawEnd] = value.slice(6).split("-");
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : Math.min(size - 1, start + 1024 * 1024 - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
function withTimeout(promise, label, ms = timeoutMs) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);
}
function waitUntil(predicate, label, ms = 3_000) {
  return withTimeout(new Promise((resolve) => {
    const check = () => predicate() ? resolve(true) : setTimeout(check, 25);
    check();
  }), label, ms);
}
function waitForLine(lines, predicate, label) {
  return withTimeout(new Promise((resolve) => {
    const check = () => {
      const index = lines.findIndex(predicate);
      if (index >= 0) resolve(lines.splice(index, 1)[0]);
    };
    lines.check = check;
    check();
  }), label);
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  try { await ipc?.command(["quit"]); } catch { /* mpv may already be exiting */ }
  const exited = Promise.race([once(processHandle, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  await exited;
  if (processHandle.exitCode === null && process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await once(killer, "exit");
  } else if (processHandle.exitCode === null) {
    processHandle.kill("SIGKILL");
  }
}

class MpvIpc {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.messages = [];
    this.events = [];
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.request_id !== undefined) this.messages.push(message);
        if (message.event) this.events.push(message);
      }
      this.flush();
    });
    this.waiters = [];
    this.nextId = 1;
  }
  flush() {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      const messageIndex = this.messages.findIndex((message) => message.request_id === waiter.id);
      if (messageIndex >= 0) {
        this.waiters.splice(index, 1);
        waiter.resolve(this.messages.splice(messageIndex, 1)[0]);
      }
    }
  }
  command(command) {
    const requestId = this.nextId++;
    this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    return withTimeout(new Promise((resolve, reject) => this.waiters.push({ id: requestId, resolve, reject })), `IPC ${command[0]}`);
  }
  event(name, predicate = () => true) {
    return withTimeout(new Promise((resolve) => {
      const check = () => {
        const index = this.events.findIndex((event) => event.event === name && predicate(event));
        if (index >= 0) resolve(this.events.splice(index, 1)[0]);
        else setTimeout(check, 20);
      };
      check();
    }), `event ${name}`);
  }
  close() { this.socket.destroy(); }
}

const results = [];
function record(id, status, detail) { results.push({ id, status, detail }); }
function assertResponse(response, label) {
  if (response.error !== "success") throw new Error(`${label}: ${response.error ?? "unknown error"}`);
}

let child;
let ipc;
let port;
try {
  port = await waitForServer();
  const digest = await sha256(mpv);
  const pipe = `\\\\.\\pipe\\watchparty-gate3-${process.pid}`;
  child = spawn(mpv, [
    "--no-config", "--idle=yes", "--pause=yes", "--keep-open=yes", "--vo=null", "--ao=null",
    "--input-ipc-server=" + pipe,
    "--user-agent=pan.baidu.com",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stderr.setEncoding("utf8");
  const socket = await withTimeout(new Promise((resolve, reject) => {
    const connect = () => {
      const candidate = net.createConnection(pipe, () => resolve(candidate));
      candidate.once("error", () => setTimeout(connect, 100));
    };
    connect();
    child.once("error", reject);
  }), "mpv IPC connection");
  ipc = new MpvIpc(socket);

  const version = await ipc.command(["get_property", "mpv-version"]);
  assertResponse(version, "mpv version");
  const capabilityProperties = ["hwdec-current", "video-format", "audio-codec-name", "track-list", "current-vo", "vo-configured"];
  const initialCapabilities = {};
  for (const property of capabilityProperties) {
    const response = await ipc.command(["get_property", property]);
    initialCapabilities[property] = response.error === "success" ? response.data ?? null : null;
  }

  const directUrl = `http://127.0.0.1:${port}/direct.mp4`;
  const loaded = ipc.event("file-loaded");
  assertResponse(await ipc.command(["loadfile", directUrl, "replace"]), "loadfile direct");
  await loaded;
  const capabilities = {};
  for (const property of capabilityProperties) {
    const response = await ipc.command(["get_property", property]);
    capabilities[property] = response.error === "success" ? response.data ?? null : initialCapabilities[property];
  }
  record("S1", "passed", `version=${version.data}; vo=${capabilities["current-vo"] ?? "null"}; hwdec=${capabilities["hwdec-current"] ?? "not-reported"}`);
  record("S2", "passed", "file-loaded received");

  for (const [id, command] of [["play", ["set_property", "pause", false]], ["pause", ["set_property", "pause", true]], ["seek", ["seek", 2, "absolute+exact"]], ["rate", ["set_property", "speed", 1.25]], ["volume", ["set_property", "volume", 35]]]) {
    assertResponse(await ipc.command(command), id);
  }
  record("S3", "passed", "play pause seek rate");
  record("S4", "passed", `volume and track-list=${JSON.stringify(capabilities["track-list"] ?? [])}`);

  const directRequest = requests.find((request) => request.pathname === "/direct.mp4");
  record("S6", directRequest?.userAgent.includes("pan.baidu.com") ? "passed" : "failed", `user-agent=${directRequest?.userAgent ?? "missing"}`);
  const duration = Number((await ipc.command(["get_property", "duration"])).data ?? 0);
  const deepSeekEligible = duration >= 60 && mediaSize >= 20 * 1024 * 1024;
  if (deepSeekEligible) {
    const requestMarker = requests.length;
    const seekTarget = Math.max(30, duration * 0.75);
    assertResponse(await ipc.command(["seek", seekTarget, "absolute+exact"]), "deep seek");
    try {
      await waitUntil(
        () => requests.slice(requestMarker).some((request) => {
          const match = /^bytes=(\d+)-/.exec(request.range);
          return match && Number(match[1]) > 0;
        }),
        "post-seek Range request",
      );
      record("S7", "passed", `non-zero Range observed after seek to ${seekTarget.toFixed(1)}s`);
    } catch {
      record("S7", "failed", "no non-zero Range request was observed after deep seek");
    }
  } else {
    record("S7", "pending", `fixture too small for deep-seek proof (duration=${duration.toFixed(1)}s, bytes=${mediaSize})`);
  }

  const redirectLoaded = ipc.event("file-loaded");
  assertResponse(await ipc.command(["loadfile", `http://127.0.0.1:${port}/redirect.mp4`, "replace"]), "loadfile redirect");
  await redirectLoaded;
  record("S8", requests.some((request) => request.pathname === "/redirect.mp4") && requests.some((request) => request.pathname === "/direct.mp4") ? "passed" : "failed", "redirect and dynamic reload observed");

  // This local header only exercises the fallback auth boundary. Product code must inject it from native memory.
  assertResponse(await ipc.command(["set_property", "http-header-fields", `Authorization: ${authValue}`]), "fallback auth headers");
  const fallbackLoaded = ipc.event("file-loaded");
  assertResponse(await ipc.command(["loadfile", `http://127.0.0.1:${port}/fallback.mp4`, "replace"]), "loadfile fallback");
  await fallbackLoaded;
  const fallbackRequest = requests.find((request) => request.pathname === "/fallback.mp4");
  record("S9", fallbackRequest?.authorization === authValue && fallbackRequest.range.includes("bytes=") ? "passed" : "failed", "fallback Authorization and Range observed");

  const endFile = ipc.event("end-file", (event) => event.reason === "eof");
  assertResponse(await ipc.command(["set_property", "keep-open", false]), "disable keep-open for EOF probe");
  assertResponse(await ipc.command(["seek", 0, "absolute+exact"]), "rewind short fixture");
  assertResponse(await ipc.command(["set_property", "pause", false]), "resume short fixture");
  try {
    const event = await endFile;
    record("S5", "passed", `end-file reason=${event.reason}`);
  } catch {
    record("S5", "failed", "end-file was not received from the short fixture");
  }
  record("S10", "pending", "codec/subtitle/HDR/4K fixture matrix requires explicit local media fixtures");

  const failed = results.filter((result) => result.status === "failed");
  const pending = results.filter((result) => result.status === "pending");
  console.log(JSON.stringify({ gate: "3-sidecar", mpv, sha256: digest, mediaFile, capabilities, results, failed: failed.length, pending: pending.length }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await stopChild(child);
  ipc?.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}
