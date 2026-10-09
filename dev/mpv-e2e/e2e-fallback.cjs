/* 阶段 3/5 验收：直链失败 → DIRECT_RETRY → FALLBACK 状态机（假 OpenList + 真机 mpv）
 * 前置：
 *   node openlist-fake.cjs                    （18095，直链必败）
 *   node https-server.cjs                     （18443，/fail-direct 403，/p/ 正常）
 *   后端 18101: NODE_ENV=test WATCHPARTY_MEDIA_ID_KEY=e2e-key2
 *     OPENLIST_URL=http://127.0.0.1:18095 OPENLIST_PUBLIC_URL=https://127.0.0.1:18443
 *     OPENLIST_USERNAME=a OPENLIST_PASSWORD=b PORT=18101 node ../../../server/main.ts
 */
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");
const { createHmac } = require("crypto");
const { spawn } = require("child_process");
const clientIo = require("C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/node_modules/socket.io-client");

const B = "http://127.0.0.1:18101";
const MPV = "D:/mpv/mpv-lazy/mpv.com";
const PIPE = "\\\\.\\pipe\\wp-fallback";
const confDir = __dirname + "\\mpvconf-fb";
const MEDIA_PATH = "/media/openlist-bdyun/Multimedia/Anime/video.mp4";
const KEY = "e2e-key2";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 签出 openlist mediaId（与后端 WATCHPARTY_MEDIA_ID_KEY 一致）
  const payload = Buffer.from(MEDIA_PATH).toString("base64url");
  const mediaId = `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;
  const media = { kind: "openlist", mediaId, title: "Fake OpenList Video", container: "mp4" };

  // 2. 建房 + 房主 socket + mediaSet
  const ownerClientId = crypto.randomUUID();
  const room = await (await fetch(`${B}/api/rooms`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner" }),
  })).json();
  const access = await (await fetch(`${B}/api/rooms/${room.roomId}/access`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner" }),
  })).json();
  const socket = clientIo(B, {
    transports: ["websocket"],
    auth: { roomId: room.roomId, clientId: ownerClientId, accessToken: access.accessToken,
      ownerToken: room.ownerToken, clientProtocol: 2 },
  });
  let snap = null;
  socket.on("REC:snapshot", (s) => { snap = s; });
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("connect_error", rej); });
  await sleep(300);
  const setAck = await new Promise((res) => socket.emit("CMD:mediaSet", { media, expectedRevision: snap.revision }, res));
  check("setup: mediaSet ok", Boolean(setAck.ok), JSON.stringify(setAck).slice(0, 80));

  // 3. mpv 加入
  const ticket = (await (await fetch(`${B}/api/rooms/${room.roomId}/handoff`, {
    method: "POST", headers: { authorization: `Bearer ${access.accessToken}` }, body: "{}",
  })).json()).ticket;

  fs.rmSync(confDir, { recursive: true, force: true });
  fs.mkdirSync(confDir, { recursive: true });
  spawn(MPV, [
    "--idle=yes", "--no-config", "--config-dir=" + confDir,
    "--script=C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua",
    "--script-opts=watchparty-backend_origin=http://127.0.0.1:18101",
    "--tls-verify=no", "--vo=null", "--ao=null", "--really-quiet",
    "--input-ipc-server=" + PIPE,
    "--log-file=" + __dirname + "\\mpv-fallback.log",
  ], { stdio: "ignore", cwd: confDir });
  await sleep(2500);

  let ipc;
  for (let i = 0; i < 10 && !ipc; i++) {
    ipc = await new Promise((resolve) => {
      const s = net.connect(PIPE);
      s.once("connect", () => resolve(s));
      s.once("error", () => resolve(null));
    });
    if (!ipc) await sleep(500);
  }
  if (!ipc) throw new Error("cannot connect mpv ipc");
  let buf = "";
  const pending = [];
  ipc.on("data", (dd) => {
    buf += dd.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (pending.length) pending.shift()(JSON.parse(line));
    }
  });
  const ipcCmd = (command) => new Promise((resolve) => {
    pending.push(resolve);
    ipc.write(JSON.stringify({ command }) + "\n");
  });

  await ipcCmd(["script-message", "watchparty-join", ticket]);
  await sleep(2500);
  const info = await (await fetch(`${B}/api/rooms/${room.roomId}`)).json();
  check("join: mpv member online", info.onlineCount >= 1, JSON.stringify(info));

  // 4. 状态机：直链 403 → 重试一次 → 切 fallback。轮询等 path 落到 /p/
  let path = null;
  for (let i = 0; i < 60 && !path; i++) {
    const p = await ipcCmd(["get_property", "path"]);
    if (typeof p.data === "string" && p.data) path = p.data;
    else await sleep(500);
  }
  check("fallback: playing via /p/ proxy after direct 403", Boolean(path && path.includes("/p/video.mp4")), String(path).slice(0, 90));
  check("fallback: direct link NOT in use", Boolean(path && !path.includes("fail-direct")), String(path).slice(0, 90));

  // 5. 稳定性：回落到 fallback 后 6 秒内不得反复重载/震荡
  const pathStable = path;
  await sleep(6000);
  const p2 = await ipcCmd(["get_property", "path"]);
  check("fallback: stable (no reload thrash)", p2.data === pathStable, `${String(p2.data).slice(0, 60)} vs ${String(pathStable).slice(0, 60)}`);

  // 6. fallback 上暂停同步仍工作
  const pauseAck = await new Promise((res) => socket.emit("CMD:pause", { expectedRevision: snap.revision }, res));
  check("browser: pause ack on fallback", Boolean(pauseAck.ok), JSON.stringify(pauseAck).slice(0, 80));
  await sleep(2500);
  const pauseProp = await ipcCmd(["get_property", "pause"]);
  check("sync: mpv paused on fallback", pauseProp.data === true, String(pauseProp.data));

  // 7. mpv 日志确认有限重试：resolve 请求恰好 2 次（初始 + 一次重试），无无限循环
  const log = fs.readFileSync(__dirname + "\\mpv-fallback.log", "utf8");
  const resolveCount = (log.match(/Run command: subprocess.*resolve-mpv/g) || []).length;
  const failedOpen = /Failed to open .*fail-direct/.test(log);
  check("fallback: exactly 2 resolves (initial + one retry)", resolveCount === 2 && failedOpen, "resolves=" + resolveCount + " failedOpen=" + failedOpen);

  socket.disconnect();
  await sleep(300);
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(1); });
