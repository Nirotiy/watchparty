// STRM 真数据自测（只读网盘，不动任何线上库）。
//
// 为什么需要它：本机没有 strm 库，网盘又不是我的写入对象，所以「A 只读支持」在
// 单测之外一直缺一条真链路。这里从 catalog_scan 快照里抽 30 个**真视频**，向真
// OpenList 要它们的 raw_url，把这些 URL 写成一行一文件的 .strm 存在本地目录树里
// （目录结构照抄网盘），再用一个假 OpenList 端点把这棵树喂给**真后端**（内存库）：
// 列目录 → 分组刮削 → 房间 resolve → 最后拿 resolve 出来的地址向网盘做 Range GET。
// 那一步 206 才是「指针真的能播」的证据；前面几步证明刮削和文案不用改。
//
// 跑法：NODE_USE_ENV_PROXY=1 node --experimental-strip-types dev/strm-local-check.mjs [--keep] [--n=30]
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../server/config.ts";
import { createOpenlistClient } from "../server/media/openlist.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const singleWork = args.includes("--single");
const wanted = Number((args.find((a) => a.startsWith("--n=")) ?? "--n=30").slice(4));
const ROOT = "/Multimedia";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-strm-check-"));
const treeDir = path.join(workDir, "root");
fs.mkdirSync(treeDir, { recursive: true });

const cfg = loadConfig(process.env);
// 网盘直链要走代理，但本机 OpenList 是回环地址——代理会把它答坏，所以两头都要顾。
process.env.NO_PROXY = [...new Set([process.env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean))].join(",");
process.env.no_proxy = process.env.NO_PROXY;
const real = createOpenlistClient(cfg);
const proxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);

const ILLEGAL = /[<>:"\\/|?*\x00-\x1F]/;
function pickSamples() {
  const catalog = new DatabaseSync(path.join(process.cwd(), "data", "watchparty-catalog.sqlite"), { readOnly: true });
  const rows = catalog.prepare("SELECT library_id, rel_path, name FROM catalog_scan ORDER BY library_id, rel_path").all();
  catalog.close();
  const libraryDb = new DatabaseSync(path.join(process.cwd(), "data", "watchparty-library.sqlite"), { readOnly: true });
  const roots = new Map(
    libraryDb
      .prepare("SELECT id, absolute_path, name FROM media_libraries")
      .all()
      .map((row) => [row.id, { absolute: row.absolute_path, folder: row.name }]),
  );
  libraryDb.close();
  const video = rows.filter((r) => /\.(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv)$/i.test(r.name));
  const legalSegments = (relPath) => relPath.split("/").filter(Boolean).every((segment) => !ILLEGAL.test(segment));
  const legal = video.filter((r) => !ILLEGAL.test(r.name) && legalSegments(r.rel_path) && roots.has(r.library_id));
  for (const row of legal) {
    const root = roots.get(row.library_id);
    row.realPath = `${root.absolute}${row.rel_path}`;
    row.fakePath = `${ROOT}/${root.folder}${row.rel_path}.strm`;
  }
  // 先按作品（上级目录）分桶，每桶轮流取，保证既有连续集数也有零散电影。
  const buckets = new Map();
  for (const row of legal) {
    const key = row.rel_path.slice(0, row.rel_path.lastIndexOf("/"));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const picked = [];
  const order = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  if (singleWork) {
    // 「N 集」只有在同一作品有多个文件时才看得见，所以 --single 只取最大的那个作品目录。
    picked.push(...(order[0]?.[1] ?? []).slice(0, wanted));
    return { picked, total: video.length, works: buckets.size };
  }
  for (let round = 0; picked.length < wanted; round += 1) {
    let grew = false;
    for (const [, list] of order) {
      const item = list[round % list.length];
      if (round < list.length && item && !picked.includes(item)) {
        picked.push(item);
        grew = true;
        if (picked.length >= wanted) break;
      }
    }
    if (!grew) break;
  }
  return { picked, total: video.length, works: buckets.size };
}

/** 真 OpenList 的 raw_url 就是网盘直链；strm 里写的正是它，所以指针和原生文件同源。 */
async function realLink(mediaPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await real.getDownloadInfo(mediaPath);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}

function writeTree(samples) {
  const written = [];
  for (const sample of samples) {
    const local = path.join(treeDir, ...sample.fakePath.slice(ROOT.length).split("/").filter(Boolean));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, `${sample.url}\n`, "utf8");
    written.push(sample);
  }
  return written;
}

/** 最小 OpenList 端点：只实现后端真客户端用到的那几个接口 + /d 取文件。 */
function startFakeOpenlist() {
  const json = (res, payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    res.end(body);
  };
  const localOf = (absPath) => {
    const decoded = decodeURIComponent(absPath);
    if (!decoded.startsWith(ROOT)) return null;
    const local = path.join(treeDir, ...decoded.slice(ROOT.length).split("/").filter(Boolean));
    const rootResolved = path.resolve(treeDir);
    const resolved = path.resolve(local);
    return resolved.startsWith(rootResolved) ? resolved : null;
  };
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      void handler(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/d/")) {
      const local = localOf(req.url.slice(2).split("?")[0]);
      if (!local || !fs.existsSync(local) || !fs.statSync(local).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      const bytes = fs.readFileSync(local);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(bytes.length) });
      res.end(bytes);
      return;
    }
    res.writeHead(404).end("no route");
  });
  const handler = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const abs = typeof body.path === "string" ? body.path : "";
    if (req.url === "/api/auth/login") return json(res, { code: 200, data: { token: "fake-token" } });
    if (req.url === "/api/fs/list") {
      const local = localOf(abs);
      if (!local || !fs.existsSync(local)) return json(res, { code: 200, data: { content: [] } });
      const content = fs
        .readdirSync(local, { withFileTypes: true })
        .map((entry) => {
          const childLocal = path.join(local, entry.name);
          const childAbs = `${abs.replace(/\/+$/, "")}/${entry.name}`;
          return {
            name: entry.name,
            size: entry.isDirectory() ? 0 : fs.statSync(childLocal).size,
            modified: "2026-09-28T00:00:00+08:00",
            is_dir: entry.isDirectory(),
            path: childAbs,
          };
        })
        .sort((l, r) => l.name.localeCompare(r.name, undefined, { numeric: true }));
      return json(res, { code: 200, data: { content, total: content.length } });
    }
    if (req.url === "/api/fs/get") {
      const local = localOf(abs);
      if (!local || !fs.existsSync(local)) return json(res, { code: 404, message: "not found" });
      const stat = fs.statSync(local);
      return json(res, {
        code: 200,
        data: {
          name: path.basename(abs),
          size: stat.size,
          raw_url: `${origin}/d${abs}`,
        },
      });
    }
    if (req.url === "/api/fs/link") return json(res, { code: 403, message: "admin link API disabled in this harness" });
    if (req.url === "/api/fs/search") return json(res, { code: 200, data: { content: [] } });
    return json(res, { code: 404, message: "no route" });
  };
  let origin = "";
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * 网盘没起时用来顶替真直链的本地流：支持 Range、报 video/mp4。
 * 这仍能验「解析出的地址能不能真拿到字节」，只是不证明那部片子本身。
 */
function startStreamOrigin() {
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 251;
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/stream/")) {
      res.writeHead(404).end("no route");
      return;
    }
    const range = req.headers.range;
    const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    const slice = bytes.subarray(start, end + 1);
    res.writeHead(match ? 206 : 200, {
      "content-type": "video/mp4",
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      "accept-ranges": "bytes",
    });
    res.end(slice);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** 指针里的地址是不是真的能出流：Range 一小段，比对原生文件的指纹。 */
async function probeStream(url, rangeBytes = 65536) {
  const started = Date.now();
  const response = await fetch(url, { headers: { range: `bytes=0-${rangeBytes - 1}` }, redirect: "follow" });
  const body = await response.arrayBuffer();
  const bytes = Buffer.from(body);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "-",
    contentRange: response.headers.get("content-range") ?? "-",
    bytes: bytes.length,
    head: sha(bytes.subarray(0, Math.min(bytes.length, 4096))),
    ms: Date.now() - started,
  };
}

const samples = pickSamples();
console.log(`快照里的视频文件 ${samples.total} 个 / ${samples.works} 个作品目录，本轮抽 ${samples.picked.length} 个（名字含 Windows 非法字符的已排除，避免落盘时改名）。`);

console.log("\n[1] 向真 OpenList 要 raw_url（这是网盘给原生文件的直链，strm 里写的就是它）");
const ping = await real.ping();
let stream = null;
if (!ping.ok) console.log(`  真 OpenList 不可用（${ping.error ?? "?"} @ ${cfg.openlistUrl}）：自动转离线模式，strm 改写本地合成流。`);
let offline = !ping.ok;
if (offline) stream = await startStreamOrigin();
for (const [index, sample] of samples.picked.entries()) {
  if (offline) {
    sample.url = `${stream.origin}/stream/${index}.mp4`;
    sample.direct = null;
    sample.size = 1024 * 1024;
    continue;
  }
  try {
    const link = await realLink(sample.realPath);
    sample.url = link?.url ?? "";
    sample.direct = sample.url;
    sample.size = link?.size ?? null;
  } catch (error) {
    sample.url = "";
    console.log(`  取直链失败，转离线：${error?.code ?? error?.message}`);
    offline = true;
    stream ??= await startStreamOrigin();
    sample.url = `${stream.origin}/stream/${index}.mp4`;
    sample.direct = null;
  }
}
const usable = samples.picked.filter((s) => s.url);
console.log(
  `  ${usable.length}/${samples.picked.length} 条有直链可用；主机：${[...new Set(usable.map((s) => new URL(s.url).host))].join(", ")}`,
);

const written = writeTree(usable);
const byFakePath = new Map(written.map((sample) => [sample.fakePath, sample.url]));
const fake = await startFakeOpenlist();
console.log(`\n[2] 本地 strm 树落在 ${treeDir}（${written.length} 个 .strm），假 OpenList 起在 ${fake.origin}`);

const { createBackend } = await import("../server/app.ts");
const backend = createBackend({
  host: "127.0.0.1",
  port: 0,
  pruneIntervalMs: 0,
  serveStatic: false,
  config: loadConfig({ ...process.env, NODE_ENV: "test", WATCHPARTY_MEDIA_ID_KEY: "strm-check-key" }),
  catalogInline: true,
  catalogDelayMs: 1200,
  catalogMaxLookups: 2,
});
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;

const created = await fetch(`${base}/api/admin/media-sources`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "STRM测试",
    internalBaseUrl: fake.origin,
    username: "fake",
    password: "fake",
    libraries: [{ name: "Strm", kind: "anime", path: ROOT }],
  }),
});
const source = await created.json();
const libraryId = source.libraries?.[0]?.id;
console.log(`\n[3] 注册假源 HTTP ${created.status}，libraryId=${libraryId}`);

const rootPage = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}&path=/`)).json();
console.log(`根目录条目：${(rootPage.items ?? []).map((i) => `${i.name}(${i.isDirectory ? "dir" : i.extension})`).join(" ")}`);

async function walk(relative, depth = 0) {
  const page = await (await fetch(`${base}/api/media/list?libraryId=${libraryId}&path=${encodeURIComponent(relative)}`)).json();
  const out = [];
  for (const item of page.items ?? []) {
    if (item.isDirectory) out.push(...(await walk(`${relative === "/" ? "" : relative}/${item.name}`, depth + 1)));
    else out.push({ ...item, at: `${relative === "/" ? "" : relative}/${item.name}` });
  }
  return out;
}
const leaves = await walk("/");
const strmLeaves = leaves.filter((i) => i.extension === "strm");
console.log(`\n[4] 递归列目录得到 ${leaves.length} 个文件，其中 strm ${strmLeaves.length} 个；兼容性抽样：`);
for (const item of strmLeaves.slice(0, 3)) {
  console.log(`  ${item.name.slice(0, 46).padEnd(48)} browser=${item.compatibility.browser} desktop=${item.compatibility.desktop} mime=${item.mime ?? "-"}`);
}
const notStrm = leaves.filter((i) => i.extension !== "strm");
if (notStrm.length) console.log(`  非 strm 文件（不该出现）：${notStrm.length}`);

console.log("\n[5] 走真刮削（inline，最多 2 次 Bangumi 检索）");
const scrapeStarted = Date.now();
const scrape = await fetch(`${base}/api/admin/media-libraries/${libraryId}/scrape`, { method: "POST" });
console.log(`  POST scrape HTTP ${scrape.status} 用时 ${((Date.now() - scrapeStarted) / 1000).toFixed(1)}s → ${(await scrape.text()).slice(0, 160)}`);
const snapshot = await (await fetch(`${base}/api/admin/media-libraries/${libraryId}/scan`)).json();
console.log(`  快照：${JSON.stringify(snapshot)}`);
const cards = await (await fetch(`${base}/api/media/catalog?libraryId=${libraryId}`)).json();
const list = cards.items ?? [];
console.log(`  ${list.length} 张卡：`);
for (const item of list.slice(0, 12)) {
  console.log(`    [${(item.status ?? "?").padEnd(9)}] ${(item.title ?? item.query ?? "-").slice(0, 26).padEnd(28)} sub=${item.subtitle ?? "-"}`);
}
for (const card of list.slice(0, 4)) {
  const detail = await (await fetch(`${base}/api/media/catalog/${card.id}`)).json();
  const first = (detail.children ?? [])[0];
  console.log(`  ${detail.title?.slice(0, 24).padEnd(26)} children=${detail.children?.length ?? 0} sub=${detail.subtitle ?? "-"} confirmedBy=${detail.confirmedBy ?? "-"} relDir=${first?.relDir ?? "-"} compat=${first?.compatibility?.browser}/${first?.compatibility?.desktop}`);
}

console.log(`\n[6] ${offline ? "房间 resolve 指针 → 本地合成流 Range GET（离线）" : "房间 resolve 指针 → 拿到的地址向网盘 Range GET"}`);
const room = await (
  await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: crypto.randomUUID(), nickname: "STRM" }),
  })
).json();
const resolve = async (mediaId) => {
  const response = await fetch(`${base}/api/rooms/${room.roomId}/media/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${room.accessToken}` },
    body: JSON.stringify({ mediaId }),
  });
  return { status: response.status, body: await response.json() };
};
let played = 0;
for (const leaf of strmLeaves.slice(0, 5)) {
  const resolved = await resolve(leaf.id);
  const url = resolved.body?.url;
  if (!url) {
    console.log(`  ${leaf.name.slice(0, 40)} → HTTP ${resolved.status} ${JSON.stringify(resolved.body).slice(0, 80)}`);
    continue;
  }
  const original = offline ? null : byFakePath.get(`${ROOT}${leaf.at}`);
  const probe = await probeStream(url);
  const direct = original ? await probeStream(original) : null;
  const same = direct && probe.head === direct.head && probe.bytes === direct.bytes;
  if (same) played += 1;
  console.log(
    `  ${leaf.name.slice(0, 34).padEnd(36)} resolve=HTTP ${resolved.status} mime=${resolved.body.mime ?? "-"} | ${probe.status} ${probe.bytes}B ${probe.ms}ms ${probe.type}${direct ? ` | 与原生直链首块${same ? "一致" : "不一致"}` : ""}`,
  );
}

console.log("\n[7] 对照：指针指向的原始路径与 strm 走同一条直链");
console.log(`  代理：${proxy ? "已启用（NODE_USE_ENV_PROXY）" : "未启用（网盘直链可能连不上，用 NODE_USE_ENV_PROXY=1 重跑）"}`);
console.log(`  resolve→Range 一致命中 ${played}/${Math.min(5, strmLeaves.length)} 次`);

await backend.close();
await fake.close();
if (keep) console.log(`\n现场留在 ${treeDir}`);
else fs.rmSync(workDir, { recursive: true, force: true });
