/* 阶段 2 验收补充：双 MPV eof 竞态 + rate 回传 + 收敛
 * 前置：后端 18100（任意后端均可，http 媒体不需要 OpenList）、媒体服务器 18443
 */
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const clientIo = require("C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/node_modules/socket.io-client");

const B = "http://127.0.0.1:18100";
const MAIN = "https://127.0.0.1:18443/test.mp4";
const SHORT = "https://127.0.0.1:18443/short.mp4";
const MPV = "D:/mpv/mpv-lazy/mpv.com";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnMpv(tag, roomId, ticket) {
  const confDir = __dirname + "\\mpvconf-" + tag;
  fs.rmSync(confDir, { recursive: true, force: true });
  fs.mkdirSync(confDir, { recursive: true });
  const pipe = "\\\\.\\pipe\\wp-" + tag;
  spawn(MPV, [
    "--idle=yes", "--no-config", "--config-dir=" + confDir,
    "--script=C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua",
    "--script-opts=watchparty-backend_origin=http://127.0.0.1:18100",
    "--vo=null", "--ao=null", "--really-quiet",
    "--input-ipc-server=" + pipe,
    "--log-file=" + __dirname + "\\mpv-" + tag + ".log",
  ], { stdio: "ignore", cwd: confDir });
  await sleep(2500);
  let ipc;
  for (let i = 0; i < 10 && !ipc; i++) {
    ipc = await new Promise((resolve) => {
      const s = net.connect(pipe);
      s.once("connect", () => resolve(s));
      s.once("error", () => resolve(null));
    });
    if (!ipc) await sleep(500);
  }
  if (!ipc) throw new Error("cannot connect ipc " + tag);
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
  await sleep(2000);
  return { ipcCmd, confDir };
}

async function main() {
  // 1. 建房 + 房主 + 两张票据
  const ownerClientId = crypto.randomUUID();
  const room = await (await fetch(`${B}/api/rooms`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner",
      initialMedia: { kind: "http", url: MAIN, title: "Main" } }),
  })).json();
  const access = await (await fetch(`${B}/api/rooms/${room.roomId}/access`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner" }),
  })).json();
  const ticket1 = (await (await fetch(`${B}/api/rooms/${room.roomId}/handoff`, {
    method: "POST", headers: { authorization: `Bearer ${access.accessToken}` }, body: "{}",
  })).json()).ticket;
  const ticket2 = (await (await fetch(`${B}/api/rooms/${room.roomId}/handoff`, {
    method: "POST", headers: { authorization: `Bearer ${access.accessToken}` }, body: "{}",
  })).json()).ticket;

  const socket = clientIo(B, {
    transports: ["websocket"],
    auth: { roomId: room.roomId, clientId: ownerClientId, accessToken: access.accessToken,
      ownerToken: room.ownerToken, clientProtocol: 2 },
  });
  let snap = null;
  socket.on("REC:snapshot", (s) => { snap = s; });
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("connect_error", rej); });
  await sleep(400);
  const ownerCmd = (type, payload = {}) => new Promise(async (res) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ack = await new Promise((r2) => socket.emit(`CMD:${type}`, { ...payload, expectedRevision: snap.revision }, r2));
      if (ack.ok || ack.error?.code !== "REVISION_CONFLICT") return res(ack);
      await sleep(400);
    }
    res({ ok: false, error: { code: "GAVE_UP" } });
  });

  // 2. 解锁 + 两个 mpv 加入
  await ownerCmd("lock", { locked: false });
  const m1 = await spawnMpv("b1", room.roomId, ticket1);
  const m2 = await spawnMpv("b2", room.roomId, ticket2);
  await sleep(1500);
  const info = await (await fetch(`${B}/api/rooms/${room.roomId}`)).json();
  check("setup: owner + 2 mpv online", info.onlineCount === 3, JSON.stringify(info));

  // 3. 播放主媒体（两者都加载）
  await ownerCmd("play");
  await sleep(2500);
  const p1 = await m1.ipcCmd(["get_property", "path"]);
  const p2 = await m2.ipcCmd(["get_property", "path"]);
  check("setup: both mpvs loaded main media", String(p1.data).includes("test.mp4") && String(p2.data).includes("test.mp4"),
    `${String(p1.data).slice(0, 40)} / ${String(p2.data).slice(0, 40)}`);

  // 4. 双 MPV eof 竞态：播列表 [short, main]，回卷到 4 秒短片，两者同时播完
  await ownerCmd("pause");
  await sleep(1500);
  const addShort = await ownerCmd("playlistAdd", { media: { kind: "http", url: SHORT, title: "Short" } });
  const addMain = await ownerCmd("playlistAdd", { media: { kind: "http", url: MAIN, title: "Main" } });
  const shortId = snap.playlist.find(x => x.media.url === SHORT).id;
  const mainId = snap.playlist.find(x => x.media.url === MAIN).id;
  const playShort = await ownerCmd("playlistPlay", { itemId: shortId });
  await ownerCmd("play");
  check("setup: race scenario armed", Boolean(addShort.ok && addMain.ok && playShort.ok), "");
  await sleep(2500); // 两者都加载短片
  const revisionBeforeEof = snap.revision;
  const bothLoaded = (await m1.ipcCmd(["get_property", "path"])).data?.includes("short.mp4")
    && (await m2.ipcCmd(["get_property", "path"])).data?.includes("short.mp4");
  check("setup: both mpvs on short clip", Boolean(bothLoaded), "");
  await sleep(9000); // 4s 播完 → 两个 eof → playlistNext 竞态 → 回卷后两者重载短片

  // 断言：恰好推进一次（revision delta = 1），currentPlaylistItemId 回到 short
  const delta = snap.revision - revisionBeforeEof;
  check("race: exactly one playlistNext accepted (delta=1)", delta === 1, "revision delta=" + delta);
  check("race: advanced to main entry", snap.currentPlaylistItemId === mainId, "item=" + snap.currentPlaylistItemId);
  const p1b = await m1.ipcCmd(["get_property", "path"]);
  const p2b = await m2.ipcCmd(["get_property", "path"]);
  check("race: both mpvs reloaded main after advance",
    String(p1b.data).includes("test.mp4") && String(p2b.data).includes("test.mp4"),
    `${String(p1b.data).slice(0, 40)} / ${String(p2b.data).slice(0, 40)}`);

  // 5. rate 回传：mpv1 本地改倍速 → 房间跟随；非法倍速被插件拦截
  await m1.ipcCmd(["set_property", "speed", 1.5]);
  await sleep(2500);
  check("rate: mpv local 1.5 propagated to room", snap && Math.abs(snap.playbackRate - 1.5) < 0.001, "room rate=" + (snap && snap.playbackRate));
  await m1.ipcCmd(["set_property", "speed", 0.1]);
  await sleep(2500);
  check("rate: below-min rate not propagated", snap && Math.abs(snap.playbackRate - 1.5) < 0.001, "room rate=" + (snap && snap.playbackRate));
  await m1.ipcCmd(["set_property", "speed", 1]);
  await sleep(2500);
  check("rate: reset to 1 propagated", snap && Math.abs(snap.playbackRate - 1) < 0.001, "room rate=" + (snap && snap.playbackRate));

  // 6. 收敛：播放中远端 seek → 两个 mpv 都收敛到同一位置（±1.5s）
  const convSeek = await ownerCmd("seek", { positionSeconds: 12 });
  check("browser: convergence seek ack", Boolean(convSeek.ok), JSON.stringify(convSeek).slice(0, 80));
  await sleep(5000);
  const c1 = await m1.ipcCmd(["get_property", "time-pos"]);
  const c2 = await m2.ipcCmd(["get_property", "time-pos"]);
  const target = snap ? snap.positionSeconds : 12;
  check("convergence: mpv1 within 1.5s of room", typeof c1.data === "number" && Math.abs(c1.data - target) < 1.5, `mpv1=${c1.data} room=${target}`);
  check("convergence: mpv2 within 1.5s of room", typeof c2.data === "number" && Math.abs(c2.data - target) < 1.5, `mpv2=${c2.data} room=${target}`);

  socket.disconnect();
  await sleep(300);
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(1); });
