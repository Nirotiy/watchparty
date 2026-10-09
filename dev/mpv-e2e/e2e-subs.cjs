/* 阶段 3 真机验收：真实 OpenList + 百度直链 + 外挂字幕
 * 前置：后端 18100（接真实 OpenList）、OpenList Desktop 5247
 */
const net = require("net");
const fs = require("fs");
const { spawn } = require("child_process");
const clientIo = require("C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/node_modules/socket.io-client");

const B = "http://127.0.0.1:18100";
const MPV = "D:/mpv/mpv-lazy/mpv.com";
const PIPE = "\\\\.\\pipe\\wp-subs";
const confDir = __dirname + "\\mpvconf-subs";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = "[DBD-Raws][4K_HDR][攻壳机动队2：无罪][2160P][BDRip][HEVC-10bit][简体字幕外挂][FLAC][MKV]";

async function main() {
  // 1. 列目录取视频 mediaId
  const d = await (await fetch(`${B}/api/media/list?root=Anime&path=${encodeURIComponent(DIR)}`)).json();
  const vids = d.items.filter(i => i.type === "file" && i.compatibility !== "unsupported");
  if (!vids.length) throw new Error("no videos in dir");
  const video = vids[0];
  const media = { kind: "openlist", mediaId: video.id, title: video.name, container: "mkv" };
  console.log("video:", video.name.slice(0, 60));

  // 2. 建房 + 房主 token + 设置媒体
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

  // 3. 票据 → mpv 加入
  const ticket = (await (await fetch(`${B}/api/rooms/${room.roomId}/handoff`, {
    method: "POST", headers: { authorization: `Bearer ${access.accessToken}` }, body: "{}",
  })).json()).ticket;

  fs.rmSync(confDir, { recursive: true, force: true });
  fs.mkdirSync(confDir, { recursive: true });
  spawn(MPV, [
    "--idle=yes", "--no-config", "--config-dir=" + confDir,
    "--script=C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua",
    "--script-opts=watchparty-backend_origin=http://127.0.0.1:18100",
    "--vo=null", "--ao=null", "--really-quiet",
    "--input-ipc-server=" + PIPE,
    "--log-file=" + __dirname + "\\mpv-subs.log",
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
  let ipcBuf = "";
  const ipcPending = [];
  ipc.on("data", (dd) => {
    ipcBuf += dd.toString();
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

  await ipcCmd(["script-message", "watchparty-join", ticket]);
  await sleep(3000);
  const info = await (await fetch(`${B}/api/rooms/${room.roomId}`)).json();
  check("join: mpv member online (browser+mpv)", info.onlineCount === 2, JSON.stringify(info));

  // 4. 起播：轮询等 path
  let path = null;
  for (let i = 0; i < 40 && !path; i++) {
    const p = await ipcCmd(["get_property", "path"]);
    if (typeof p.data === "string" && p.data) path = p.data;
    else await sleep(500);
  }
  check("playback: media loaded", Boolean(path), String(path).slice(0, 110));
  const isDirect = path && !path.includes(":5247");
  const isFallback = path && path.includes(":5247");
  check("dual-link: " + (isDirect ? "DIRECT baidu link" : isFallback ? "FALLBACK /p/ proxy" : "unknown"),
    Boolean(isDirect || isFallback), String(path).slice(0, 110));

  // 5. 外挂字幕：轮询 track-list 等 sub-add 生效（下载走真实百度直链，可能要几秒）
  let subs = [];
  for (let i = 0; i < 40; i++) {
    const tl = await ipcCmd(["get_property", "track-list"]);
    subs = (tl.data || []).filter(t => t.type === "sub");
    if (subs.some(t => t.external)) break;
    await sleep(1000);
  }
  const ext = subs.filter(t => t.external);
  check("subtitles: external track added", ext.length >= 1,
    JSON.stringify(subs.map(t => ({ title: t.title, lang: t.lang, external: t.external, codec: t.codec }))).slice(0, 220));
  if (ext.length) {
    const sel = subs.find(t => t.selected);
    console.log("   selected sub:", sel ? sel.title : "(none selected — auto 模式，用户手动切换)");
  }

  // 6. 房间暂停/播放指令在真实直链下仍然同步
  const pauseAck = await new Promise((res) => socket.emit("CMD:pause", { expectedRevision: snap.revision }, res));
  check("browser: pause ack (real media)", Boolean(pauseAck.ok), JSON.stringify(pauseAck).slice(0, 80));
  await sleep(2500);
  const pauseProp = await ipcCmd(["get_property", "pause"]);
  check("sync: mpv paused on real direct link", pauseProp.data === true, String(pauseProp.data));

  // 6.5 深度 seek：真实百度直链的 Range 行为（4K 大文件）
  const deepSeek = await new Promise((res) => socket.emit("CMD:seek", { positionSeconds: 900, expectedRevision: snap.revision }, res));
  check("browser: deep seek to 900s ack", Boolean(deepSeek.ok), JSON.stringify(deepSeek).slice(0, 80));
  await sleep(5000);
  const posDeep = await ipcCmd(["get_property", "time-pos"]);
  check("dual-link: deep seek on baidu direct link", typeof posDeep.data === "number" && Math.abs(posDeep.data - 900) < 5, String(posDeep.data));

  // 7. 检查临时字幕文件确实存在（换片前）
  const confFiles = fs.readdirSync(confDir).filter(f => /\.(srt|ass|ssa|vtt)$/i.test(f));
  console.log("   temp subtitle files in config dir:", confFiles.join(", ") || "(none — 在系统临时目录)");
  // 插件写在系统临时目录，列出进程临时目录中当天新增的字幕文件
  const osTemp = process.env.TEMP;
  if (osTemp) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const subs1 = fs.readdirSync(osTemp)
      .filter(f => /\.(srt|ass|ssa|vtt)$/i.test(f))
      .map(f => ({ f, t: fs.statSync(`${osTemp}\\${f}`).mtime }));
    const fresh = subs1.filter(x => x.t >= today);
    check("subtitle: temp file created in OS temp", fresh.length >= ext.length,
      fresh.map(x => x.f).slice(0, 6).join(", "));
  }

  // 7. watchparty:// 快捷方式：强杀 mpv（模拟崩溃）→ 用 URL 拉起新实例 → 应自动恢复房间并重载媒体
  const taskId = room.roomId;
  socket.disconnect();
  await sleep(500);
  require("child_process").execSync("taskkill /F /IM mpv.exe", { stdio: "ignore" });
  await sleep(1000);
  spawn(MPV, [
    "--idle=yes", "--no-config", "--config-dir=" + confDir,
    "--script=C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua",
    "--script-opts=watchparty-backend_origin=http://127.0.0.1:18100",
    "--vo=null", "--ao=null", "--really-quiet",
    "--input-ipc-server=" + PIPE,
    "--log-file=" + __dirname + "\\mpv-subs.log",
    "watchparty://" + taskId,
  ], { stdio: "ignore", cwd: confDir });
  await sleep(3500);

  // 重连 IPC（新进程）
  let ipc2 = null;
  for (let i = 0; i < 10 && !ipc2; i++) {
    ipc2 = await new Promise((resolve) => {
      const s = net.connect(PIPE);
      s.once("connect", () => resolve(s));
      s.once("error", () => resolve(null));
    });
    if (!ipc2) await sleep(500);
  }
  if (!ipc2) throw new Error("cannot reconnect mpv ipc");
  let ipcBuf2 = "";
  const ipcPending2 = [];
  ipc2.on("data", (dd) => {
    ipcBuf2 += dd.toString();
    let idx;
    while ((idx = ipcBuf2.indexOf("\n")) >= 0) {
      const line = ipcBuf2.slice(0, idx);
      ipcBuf2 = ipcBuf2.slice(idx + 1);
      if (ipcPending2.length) ipcPending2.shift()(JSON.parse(line));
    }
  });
  const ipcCmd2 = (command) => new Promise((resolve) => {
    ipcPending2.push(resolve);
    ipc2.write(JSON.stringify({ command }) + "\n");
  });

  // 轮询等媒体重载（房间当前媒体为无罪视频，直链）
  let resumedPath = null;
  for (let i = 0; i < 30 && !resumedPath; i++) {
    const p = await ipcCmd2(["get_property", "path"]);
    if (typeof p.data === "string" && p.data) resumedPath = p.data;
    else await sleep(500);
  }
  check("watchparty://: resumed and media reloaded", Boolean(resumedPath && resumedPath.includes("baidupcs.com")), String(resumedPath).slice(0, 90));
  const info2 = await (await fetch(`${B}/api/rooms/${room.roomId}`)).json();
  check("watchparty://: room rejoined", info2.onlineCount >= 1, JSON.stringify(info2));
  const resumedLog = fs.readFileSync(__dirname + "\\mpv-subs.log", "utf8");
  check("watchparty://: resume log line", resumedLog.includes("watchparty:// resumed " + taskId), "");

  await sleep(300);
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(1); });
