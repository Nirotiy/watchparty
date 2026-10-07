// Bandwidth + redirect-behavior probe for the OpenList source (sample 43 signed URL).
// Answers: does the URL 302-redirect or proxy? What is real throughput at big sizes / with concurrency?
// Usage: node verify/bandwidth-probe.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const openListOrigin = "http://127.0.0.1:5349";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const root = "/media/openlist-bdyun/Multimedia/";
const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ffprobe-sample-20260904/sample-manifest-current.json");

const credentials = parseCredentials(readFileSync(credentialsPath, "utf8"));
const token = await login();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sample = manifest.find((entry) => entry.sampleIndex === 43);
const { rawUrl, size } = await resolveMedia(sample.relativePath);
console.log("file size:", size, "url host:", new URL(rawUrl).host);

// 1) Behavior: does it redirect (302) or serve directly (206/200)?
{
  const head = await fetch(rawUrl, { method: "HEAD", redirect: "manual" });
  const get0 = await fetch(rawUrl, { headers: { Range: "bytes=0-0" }, redirect: "manual" });
  console.log("HEAD status:", head.status, "location:", head.headers.get("location") ?? "(none)", "| server:", head.headers.get("server") ?? "?");
  await get0.body?.cancel();
  console.log("Range 0-0 status:", get0.status, "location:", get0.headers.get("location") ?? "(none)");
}

const mb = 1024 * 1024;
async function timed(start, bytes) {
  const t0 = performance.now();
  const response = await fetch(rawUrl, { headers: { Range: `bytes=${start}-${start + bytes - 1}` }, cache: "no-store" });
  if (response.status !== 206) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} for ${bytes}B`); }
  let received = 0;
  for await (const chunk of response.body) received += chunk.length;
  const seconds = (performance.now() - t0) / 1000;
  return { requestedMB: bytes / mb, receivedMB: +(received / mb).toFixed(2), seconds: +seconds.toFixed(3), MBps: +(received / mb / seconds).toFixed(2), Mbps: +(received * 8 / mb / seconds).toFixed(1) };
}

console.log("\n-- sequential single-range reads (distinct offsets):");
const seq = [[0, 1 * mb], [64 * mb, 4 * mb], [128 * mb, 8 * mb], [256 * mb, 16 * mb], [384 * mb, 32 * mb]];
for (const [start, bytes] of seq) console.log(JSON.stringify(await timed(start, bytes)));

console.log("\n-- parallel 4 x 8MB:");
{
  const t0 = performance.now();
  const parts = await Promise.all([0, 1, 2, 3].map((i) => timed(512 * mb + i * 8 * mb, 8 * mb)));
  const seconds = (performance.now() - t0) / 1000;
  const totalMB = parts.reduce((sum, p) => sum + p.receivedMB, 0);
  console.log(JSON.stringify({ totalMB: +totalMB.toFixed(1), seconds: +seconds.toFixed(3), MBps: +(totalMB / seconds).toFixed(2), Mbps: +(totalMB * 8 / seconds).toFixed(1) }));
}

console.log("\n-- parallel 4 x 32MB:");
{
  const t0 = performance.now();
  const parts = await Promise.all([0, 1, 2, 3].map((i) => timed(600 * mb + i * 32 * mb, 32 * mb)));
  const seconds = (performance.now() - t0) / 1000;
  const totalMB = parts.reduce((sum, p) => sum + p.receivedMB, 0);
  console.log(JSON.stringify({ totalMB: +totalMB.toFixed(1), seconds: +seconds.toFixed(3), MBps: +(totalMB / seconds).toFixed(2), Mbps: +(totalMB * 8 / seconds).toFixed(1) }));
}

function parseCredentials(source) {
  try { return JSON.parse(source); } catch {
    return Object.fromEntries(source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return i < 0 ? ["", ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
      .filter(([k, v]) => k && v));
  }
}
async function login() {
  const result = await post("/api/auth/login", { username: credentials.username, password: credentials.password });
  if (result.code !== 200 || !result.data?.token) throw new Error("login failed");
  return result.data.token;
}
async function resolveMedia(relativePath) {
  const result = await post("/api/fs/get", { path: `${root}${relativePath}` }, token);
  if (result.code !== 200 || typeof result.data?.raw_url !== "string") throw new Error("resolve failed");
  return { rawUrl: result.data.raw_url, size: Number(result.data.size) };
}
async function post(route, body, authToken) {
  const response = await fetch(`${openListOrigin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authToken ? { authorization: authToken } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList HTTP ${response.status}`);
  return response.json();
}
