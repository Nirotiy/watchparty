#!/usr/bin/env node
// Local Range server for the A/V marks clip with one-shot read-stall injection (underrun test) and
// the CORS expose headers the POC requires. TEST ONLY.
// Usage: node verify/marks-range-server.mjs [port=5191] [file=fixtures/av-sync-marks-400s.mkv]
// Control: GET /__stall?ms=2000  -> arms one stall; the NEXT range request is delayed by that many ms.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 5191);
const filePath = resolve(process.argv[3] ?? join(here, "..", "fixtures", "av-sync-marks-400s.mkv"));
if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
const size = statSync(filePath).size;
const etag = `"marks-${size}"`;
let stallUntil = 0;
let throttleKbps = Number(process.env.MARKS_KBPS ?? 0) || 0;   // 0 = unlimited
let nextSlotMs = Date.now();
let requestCount = 0;
let bytesServed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, If-Range, Content-Type",
    "access-control-expose-headers": "Content-Range, Accept-Ranges, ETag, Content-Length",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (url.pathname === "/__stall") {
    const ms = Math.max(0, Number(url.searchParams.get("ms") ?? 0));
    stallUntil = Date.now() + ms;
    console.log(`[marks-server] stall window armed: all range reads queued until +${ms} ms`);
    res.writeHead(200, { ...cors, "content-type": "text/plain" });
    res.end(`stall window ${ms}\n`);
    return;
  }
  if (url.pathname === "/__throttle") {
    throttleKbps = Math.max(0, Number(url.searchParams.get("kbps") ?? 0));
    console.log(`[marks-server] throttle set: ${throttleKbps} kbps`);
    res.writeHead(200, { ...cors, "content-type": "text/plain" });
    res.end(`throttle ${throttleKbps}\n`);
    return;
  }
  if (url.pathname !== "/marks.mkv") { res.writeHead(404, cors); res.end(); return; }

  requestCount += 1;
  const range = req.headers.range;
  let start = 0, end = size - 1, status = 200;
  if (typeof range === "string") {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      start = m[1] ? Number(m[1]) : 0;
      end = m[2] ? Number(m[2]) : size - 1;
      if (end >= size) end = size - 1;
      status = 206;
    }
  }
  if (start > end || start >= size) {
    res.writeHead(416, { ...cors, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  if (stallUntil > Date.now()) {
    const wait = stallUntil - Date.now();
    console.log(`[marks-server] queuing range ${start}-${end} for ${wait} ms (stall window)`);
    await sleep(wait + 30);
  }
  const len = end - start + 1;
  const headers = {
    ...cors,
    "content-type": "video/x-matroska",
    "accept-ranges": "bytes",
    etag,
    "content-length": String(len),
  };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  const buf = await new Promise((res, rej) => {
    const chunks = [];
    const rs = createReadStream(filePath, { start, end });
    rs.on("data", (c) => chunks.push(c));
    rs.on("end", () => res(Buffer.concat(chunks)));
    rs.on("error", rej);
  });
  res.writeHead(status, headers);
  if (throttleKbps > 0) {
    // Shared token bucket across all responses: every chunk occupies a slot on one global clock,
    // so parallel reads cannot multiply the aggregate rate.
    const slotMs = (32 * 1024 * 8) / throttleKbps;
    for (let off = 0; off < buf.length; off += 32 * 1024) {
      if (res.writableEnded || res.destroyed) break;
      nextSlotMs = Math.max(nextSlotMs, Date.now());
      const mySlot = nextSlotMs;
      nextSlotMs += slotMs;
      const wait = mySlot - Date.now();
      if (wait > 0) await sleep(wait);
      if (res.writableEnded || res.destroyed) break;
      const piece = buf.subarray(off, off + 32 * 1024);
      bytesServed += piece.length;
      res.write(piece);
    }
    res.end();
  } else {
    bytesServed += buf.length;
    res.end(buf);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[marks-server] http://127.0.0.1:${port}/marks.mkv size=${size} etag=${etag}`);
});

process.on("SIGUSR2", () => {
  console.log(`[marks-server] stats requests=${requestCount} bytes=${bytesServed}`);
});
