// 50-sample sweep: per sample = sign URL -> harness (open + 30s + 2 seeks) -> compact summary.
// Runs through the local Caddy fix chain (方案 A replica) against the real OpenList.
// Usage: node verify/sweep.mjs [sampleIndex ...]   (no args = all 50)
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const openListOrigin = "http://127.0.0.1:5349";
const proxyOrigin = "http://127.0.0.1:5397";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const sampleRoot = "/media/openlist-bdyun/Multimedia/";
const manifestPath = resolve(here, "../../ffprobe-sample-20260904/sample-manifest-current.json");
const summaryPath = join(here, "results", "sweep-summary.jsonl");
const only = process.argv.slice(2).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

const credentials = parseCredentials(readFileSync(credentialsPath, "utf8"));
const token = await login();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const targets = only.length ? manifest.filter((entry) => only.includes(entry.sampleIndex)) : manifest;
console.log(`sweep start: ${targets.length} samples at ${new Date().toISOString()}`);

for (const sample of targets) {
  const idx = sample.sampleIndex;
  const label = `sweep-${idx}`;
  let recorded = false;
  for (let attempt = 1; attempt <= 2 && !recorded; attempt += 1) {
    try {
      const resolved = await resolveMedia(token, sample.relativePath);
      if (!resolved) { record(idx, { ok: false, stage: "sign-url" }); recorded = true; break; }
      const url = resolved.rawUrl.replace(openListOrigin, proxyOrigin);
      const started = Date.now();
      const run = spawnSync(process.execPath, [
        join(here, "harness.mjs"),
        "--label", label, "--browser", "chrome", "--mode", "url",
        "--media", url, "--seconds", "30", "--seeks", "60,180",
      ], { encoding: "utf8", timeout: 8 * 60 * 1000 });
      const jsonPath = join(here, "results", `${label}.json`);
      if (!existsSync(jsonPath)) {
        record(idx, { ok: false, stage: "harness-exit", code: run.status, stderr: String(run.stderr ?? "").slice(0, 300) });
        recorded = true;
        break;
      }
      const r = JSON.parse(readFileSync(jsonPath, "utf8"));
      const summary = { ok: !r.error, ...compact(r), durationMs: Date.now() - started, attempt };
      if (!summary.ok && attempt < 2 && /403|等待新签名 URL|签名/.test(summary.error)) {
        await sleep(1500);
        continue;
      }
      record(idx, summary);
      recorded = true;
    } catch (error) {
      if (attempt < 2) { await sleep(1500); continue; }
      record(idx, { ok: false, stage: "sweep-exception", error: String(error).slice(0, 300) });
      recorded = true;
    }
  }
  console.log(`[${idx}/${manifest.length}] done`);
}
console.log(`SWEEP COMPLETE at ${new Date().toISOString()}`);

function compact(r) {
  return {
    error: r.error ? String(r.error).slice(0, 320) : null,
    range: r.afterLoad?.range ?? null,
    demux: r.afterLoad?.demux ?? null,
    codecState: r.afterLoad?.codecState ?? null,
    tracks: String(r.afterLoad?.tracks ?? "").replace(/\n+/g, " | ").slice(0, 420),
    seeks: (r.seeks ?? []).map((s) => ({ t: s.targetSeconds, ms: s.metricSeek ?? null, ev: s.event ? String(s.event).slice(10, 60) : "TIMEOUT" })),
    requests: r.afterLoad?.metrics?.requests ?? null,
    bytes: r.afterLoad?.metrics?.bytes ?? null,
    size: r.afterLoad?.metrics?.size ?? null,
    mediaStatuses: r.network?.mediaStatuses ?? null,
    failed: (r.network?.failed ?? []).slice(0, 3),
    events: String(r.final?.events ?? "").split("\n").slice(0, 5),
  };
}

function record(sampleIndex, obj) {
  appendFileSync(summaryPath, `${JSON.stringify({ sampleIndex, at: new Date().toISOString(), ...obj })}\n`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function parseCredentials(source) {
  try {
    return JSON.parse(source);
  } catch {
    return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? ["", ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }).filter(([key, value]) => key && value));
  }
}

async function login() {
  if (!credentials.username || !credentials.password) throw new Error("OpenList credentials file is incomplete");
  const result = await postOpenList("/api/auth/login", { username: credentials.username, password: credentials.password });
  if (result.code !== 200 || !result.data?.token) throw new Error("OpenList login failed");
  return result.data.token;
}

async function resolveMedia(authToken, relativePath) {
  try {
    const result = await postOpenList("/api/fs/get", { path: `${sampleRoot}${relativePath}` }, authToken);
    const rawUrl = result.data?.raw_url;
    const size = Number(result.data?.size);
    if (result.code !== 200 || typeof rawUrl !== "string" || !Number.isSafeInteger(size) || size <= 0) return null;
    return { rawUrl, size };
  } catch {
    return null;
  }
}

async function postOpenList(route, body, authToken) {
  const response = await fetch(`${openListOrigin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authToken ? { authorization: authToken } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList request failed with HTTP ${response.status}`);
  return response.json();
}
