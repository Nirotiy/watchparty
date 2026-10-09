/* WatchParty MPV 插件 E2E 冒烟：真实 mpv.exe + 本地后端（自包含，无中间文件）
 *
 * 场景：
 *   1. 建房（默认锁定+暂停）→ 房主 socket 解锁 → 签发票据 → mpv 加入并起播
 *   2. 房主 play/pause → mpv 跟随
 *   3. 房主 seek（暂停态）→ mpv 位置纠偏
 *   4. mpv 本地 seek（房间已解锁）→ 回传 → 房间快照跟随
 *   5. 房主上锁 → mpv 本地操作被 FORBIDDEN 拒绝并被快照拉回；房主远端命令仍生效
 */
const net = require("net");
const fs = require("fs");
const { spawn } = require("child_process");
const clientIo = require("C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/node_modules/socket.io-client");

const B = "http://127.0.0.1:18099";
const MEDIA = "https://127.0.0.1:18443/test.mp4";
const MPV = "D:/mpv/mpv-lazy/mpv.com";
const PIPE = "\\\\.\\pipe\\wp-e2e4";
const confDir = __dirname + "\\mpvconf";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 建房 + 房主 token + 票据
  const ownerClientId = crypto.randomUUID();
  const r = await fetch(`${B}/api/rooms`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner",
      initialMedia: { kind: "http", url: MEDIA, title: "E2E Test" } }),
  });
  const room = await r.json();
  if (!room.roomId) throw new Error("room create failed: " + JSON.stringify(room));
  const access = await (await fetch(`${B}/api/rooms/${room.roomId}/access`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: ownerClientId, nickname: "Owner" }),
  })).json();
  if (!access.accessToken) throw new Error("access failed: " + JSON.stringify(access));
  const ticket = (await (await fetch(`${B}/api/rooms/${room.roomId}/handoff`, {
    method: "POST", headers: { authorization: `Bearer ${room.accessToken}` }, body: "{}",
  })).json()).ticket;
  console.log("room:", room.roomId);

  // 2. 启动 mpv（隔离配置目录）并连接 IPC
  fs.rmSync(confDir, { recursive: true, force: true });
  fs.mkdirSync(confDir, { recursive: true });
  fs.rmSync(__dirname + "/watchparty.json", { force: true });
  spawn(MPV, [
    "--idle=yes", "--no-config", "--config-dir=" + confDir,
    "--script=C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua",
    "--script-opts=watchparty-backend_origin=http://127.0.0.1:18099",
    "--tls-verify=no", "--vo=null", "--ao=null", "--really-quiet",
    "--input-ipc-server=" + PIPE,
    "--log-file=" + __dirname + "\\mpv.log",
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
  if (!ipc) throw new Error("cannot connect to mpv ipc pipe");
  let ipcBuf = "";
  const ipcPending = [];
  ipc.on("data", (d) => {
    ipcBuf += d.toString();
    let idx;
    while ((idx = ipcBuf.indexOf("\n")) >= 0) {
      const line = ipcBuf.slice(0, idx);
      ipcBuf = ipcBuf.slice(idx + 1);
      if (ipcPending.length) ipcPending.shift()(JSON.parse(line));
    }
  });
  const ipcCmd = (command) => new Promise((resolve) => {
    ipcPending.push(resolve);
    ipc.write(JSON.stringify({ command }) + "\n");
  });

  // 3. 加入房间
  await ipcCmd(["script-message", "watchparty-join", ticket]);
  await sleep(2500);
  const info = await (await fetch(`${B}/api/rooms/${room.roomId}`)).json();
  check("join: mpv member online", info.onlineCount === 1, JSON.stringify(info));

  // 4. 自动起播
  let path = null;
  for (let i = 0; i < 20 && !path; i++) {
    const p = await ipcCmd(["get_property", "path"]);
    if (typeof p.data === "string") path = p.data;
    else await sleep(500);
  }
  check("playback: auto-started room media", Boolean(path && path.includes("test.mp4")), String(path));

  // 5. 房主 socket 接入并解锁房间（mpv 的回传命令需要自由房间）
  const socket = clientIo(B, {
    transports: ["websocket"],
    auth: { roomId: room.roomId, clientId: ownerClientId, accessToken: access.accessToken,
      ownerToken: room.ownerToken, clientProtocol: 2 },
  });
  let snap = null;
  socket.on("REC:snapshot", (s) => { snap = s; });
  const connectResult = await new Promise((resolve) => {
    socket.once("connect", () => resolve("ok"));
    socket.once("connect_error", (e) => resolve(e));
  });
  if (connectResult !== "ok") {
    check("browser: socket connect", false, connectResult.message);
    process.exit(1);
  }
  check("browser: socket connect", true);
  await sleep(400);

  // 带一次冲突重试的房主命令
  let ownerCmd = (type, payload = {}) => new Promise(async (res) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ack = await new Promise((r2) => socket.emit(`CMD:${type}`, { ...payload, expectedRevision: snap.revision }, r2));
      if (ack.ok || ack.error?.code !== "REVISION_CONFLICT") return res(ack);
      await sleep(400);
    }
    res({ ok: false, error: { code: "GAVE_UP" } });
  });

  const unlock = await ownerCmd("lock", { locked: false });
  check("browser: unlock room", Boolean(unlock.ok), JSON.stringify(unlock).slice(0, 80));
  await sleep(600);

  // 6. 房主 play → mpv 播放；pause → mpv 暂停
  const play1 = await ownerCmd("play");
  check("browser: CMD:play ack", Boolean(play1.ok), JSON.stringify(play1).slice(0, 80));
  await sleep(2500);
  const pauseProp0 = await ipcCmd(["get_property", "pause"]);
  check("sync: mpv followed remote play", pauseProp0.data === false, String(pauseProp0.data));

  const pause1 = await ownerCmd("pause");
  check("browser: CMD:pause ack", Boolean(pause1.ok), JSON.stringify(pause1).slice(0, 80));
  await sleep(2500);
  const pauseProp = await ipcCmd(["get_property", "pause"]);
  check("sync: mpv followed remote pause", pauseProp.data === true, String(pauseProp.data));

  // 7. 暂停态下房主 seek 10 → mpv 位置纠偏
  const seek1 = await ownerCmd("seek", { positionSeconds: 10 });
  check("browser: CMD:seek ack", Boolean(seek1.ok), JSON.stringify(seek1).slice(0, 80));
  await sleep(4500);
  const pos1 = await ipcCmd(["get_property", "time-pos"]);
  check("sync: mpv followed remote seek to 10s (paused)", typeof pos1.data === "number" && Math.abs(pos1.data - 10) < 1.5, String(pos1.data));

  // 8. mpv 本地 seek 20（房间已解锁）→ 回传 → 快照跟随（暂停态位置稳定可断言）
  await sleep(1300);
  await ipcCmd(["seek", 20, "absolute", "exact"]);
  await sleep(4500);
  check("report: local seek propagated to room", snap && typeof snap.positionSeconds === "number" && Math.abs(snap.positionSeconds - 20) < 1.5, "snapshot pos=" + (snap && snap.positionSeconds));

  // 9. 房主上锁后：mpv 本地 pause 被 FORBIDDEN 拒绝，并被快照拉回播放态
  await ownerCmd("play");
  await sleep(2500);
  const lock2 = await ownerCmd("lock", { locked: true });
  check("browser: lock room", Boolean(lock2.ok), JSON.stringify(lock2).slice(0, 80));
  await sleep(600);
  await ipcCmd(["set_property", "pause", true]); // mpv 本地暂停 → observer → FORBIDDEN
  await sleep(3500);
  const pauseProp2 = await ipcCmd(["get_property", "pause"]);
  check("forbidden: mpv local pause rejected and reverted", pauseProp2.data === false, String(pauseProp2.data));

  // 10. 锁定状态下房主远端 pause 仍生效
  const pause2 = await ownerCmd("pause");
  check("browser: owner pause under lock ack", Boolean(pause2.ok), JSON.stringify(pause2).slice(0, 80));
  await sleep(2500);
  const pauseProp3 = await ipcCmd(["get_property", "pause"]);
  check("sync: mpv followed remote pause under lock", pauseProp3.data === true, String(pauseProp3.data));

  // 11. 播完推进列表（loop=true 回卷到同一短条目）：
  //     eof → mpv 发 playlistNext → 服务端 revision 推进并重置位置 → 插件重载同一媒体
  const unlock2 = await ownerCmd("lock", { locked: false });
  const loopOn = await ownerCmd("loop", { loop: true });
  const addShort = await ownerCmd("playlistAdd", { media: { kind: "http", url: MEDIA.replace("test.mp4", "short.mp4"), title: "Short Clip" } });
  const shortItemId = snap.playlist[snap.playlist.length - 1].id;
  const playShort = await ownerCmd("playlistPlay", { itemId: shortItemId });
  const playShort2 = await ownerCmd("play"); // playlistPlay 重置为暂停态，需解除才会播到 eof
  check("browser: play short clip", Boolean(unlock2.ok && loopOn.ok && addShort.ok && playShort.ok && playShort2.ok), JSON.stringify({ unlock2, loopOn, addShort, playShort, playShort2 }).slice(0, 140));
  const revisionBeforeEof = snap.revision;
  // 等短片播完（4s）+ playlistNext 往返 + 同条目重载
  await sleep(11000);
  const posEof = await ipcCmd(["get_property", "time-pos"]);
  const wrapped = snap.currentPlaylistItemId === shortItemId && snap.revision > revisionBeforeEof;
  check("eof: playlistNext wrapped and reloaded", wrapped && typeof posEof.data === "number" && posEof.data < 2.5,
    `rev ${revisionBeforeEof}→${snap.revision} itemId=${snap.currentPlaylistItemId === shortItemId} pos=${posEof.data}`);

  socket.disconnect();
  await sleep(500);
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(1); });
