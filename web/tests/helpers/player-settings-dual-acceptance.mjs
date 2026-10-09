// 双客户端设置独立性验收：同一房间、不同本机偏好（音量/外观/步长/缩放）互不覆盖，房间播放状态保持同步。
// node web/tests/helpers/player-settings-dual-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sleep } from "./chrome-session.mjs";

const backend = "http://127.0.0.1:18981";
const origin = "http://127.0.0.1:18982";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const output = process.argv[2] ?? "web/tests/results/player-settings-dual-2026-10-10.json";
const result = { startedAt: new Date().toISOString(), scope: "两名浏览器客户端同房、不同本机偏好；真实 MKV 引擎；本地 fixture 房间", checks: [] };
const clients = [];
const room = () => fetch(`${backend}/__fixture`).then((response) => response.json());
const command = async (event, payload = {}) => {
  const ack = await (await fetch(`${backend}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(ack.ok, true, JSON.stringify(ack));
};
async function until(label, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) { result.checks.push({ label, elapsedMs: Date.now() - start }); console.log(`PASS: ${label} (${Date.now() - start}ms)`); return value; }
    await sleep(120);
  }
  throw new Error(`timeout: ${label}`);
}
async function startClient(name, prefs) {
  const profile = await mkdtemp(path.join(tmpdir(), `next-wp-dual-${name}-`));
  const process = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--window-position=0,-1440", "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  const client = { name, profile, process };
  clients.push(client);
  let port;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await sleep(250); }
  }
  assert.ok(port, `${name} Chrome port`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  client.send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${name} CDP timeout: ${method}`)); }, 15000);
    pending.set(current, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
  client.evaluate = async (expression) => {
    const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await client.send("Page.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__dualRig={draws:[],errors:[]};
    const rig=globalThis.__dualRig;
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
      if(this.canvas?.getAttribute('aria-label')==='MKV 视频'){rig.draws.push({text:String(text),font:this.font,
        fillStyle:String(this.fillStyle),lineWidth:this.lineWidth,shadowBlur:this.shadowBlur});
        if(rig.draws.length>100)rig.draws.shift();}
      return fill.call(this,text,x,y,...args);
    };
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify(origin)}) {
      localStorage.setItem('watchparty_client_id',crypto.randomUUID());
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
      localStorage.setItem('watchparty.player-preferences.v1', JSON.stringify(${JSON.stringify(prefs)}));
    }
  })()` });
  await client.send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until(`${name}-loaded`, async () => (await client.evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
    return Boolean(c&&c.width===1920&&Number(c.dataset.mediaTime)>=0);})()`)) === true, 25000);
  client.clientId = await client.evaluate(`localStorage.getItem('watchparty_client_id')`);
  return client;
}
async function clickSelector(client, selector) {
  const box = await client.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('not found: '+${JSON.stringify(selector)});
    element.scrollIntoView({block:'center'});
    const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await sleep(60);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
async function clickDialogButton(client, text) {
  const box = await client.evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
    .find(x=>x.textContent.trim()===${JSON.stringify(text)});
    if(!target)throw Error('dialog button not found: '+${JSON.stringify(text)});
    target.scrollIntoView({block:'center'});
    const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await sleep(60);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
const engineTracks = (client) => client.evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
  let fiber=c[Object.keys(c).find(key=>key.startsWith('__reactFiber$'))];
  while(fiber){if(fiber.ref?.current?.getEmbeddedTracks){return fiber.ref.current.getEmbeddedTracks();}fiber=fiber.return;}
  throw Error('no adapter handle');})()`);
const mediaTime = (client) => client.evaluate(`Number(document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.mediaTime ?? -1)`);

try {
  await command("CMD:mediaSet");
  await command("CMD:pause");
  const appearanceA = { fontScale: 100, color: "cyan", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 50, bottomRaisePercent: 0 };
  const appearanceB = { fontScale: 100, color: "white", fontWeight: "normal", outline: "thin", shadow: "none", backgroundOpacity: 0, bottomRaisePercent: 0 };
  const prefsA = { volume: 20, muted: false, audioLanguages: [], subtitleLanguages: ["jpn"], subtitleMode: "prefer-list", subtitleSourcePreference: "embedded",
    subtitleAppearance: appearanceA, skipBackwardSeconds: 5, skipForwardSeconds: 30, pictureFit: "cover" };
  const prefsB = { volume: 80, muted: false, audioLanguages: [], subtitleLanguages: ["jpn"], subtitleMode: "prefer-list", subtitleSourcePreference: "embedded",
    subtitleAppearance: appearanceB, skipBackwardSeconds: 10, skipForwardSeconds: 10, pictureFit: "contain" };
  const clientA = await startClient("A", prefsA);
  const clientB = await startClient("B", prefsB);

  // 两台都按各自语言列表自动选到日语内嵌轨。
  await until("A-subtitle-selected", async () => (await engineTracks(clientA)).subtitleId === 4);
  await until("B-subtitle-selected", async () => (await engineTracks(clientB)).subtitleId === 4);

  // 缩放偏好互不覆盖（本机画布类名各自不同）。
  const fitA = await clientA.evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]').className`);
  const fitB = await clientB.evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]').className`);
  assert.ok(fitA.includes("object-cover") && fitB.includes("object-contain"), `fit independence: ${fitA} | ${fitB}`);

  // 同一暂停 seek：外观各自生效（A 青/粗体/粗描边/阴影；B 白/普通）。
  await command("CMD:seek", { positionSeconds: 11.25 });
  await sleep(200);
  await clientA.evaluate(`window.__dualRig.draws.length = 0`);
  await clientB.evaluate(`window.__dualRig.draws.length = 0`);
  await command("CMD:seek", { positionSeconds: 10.25 });
  await until("A-styled-cue", async () => {
    const draws = await clientA.evaluate(`window.__dualRig.draws.filter((entry)=>entry.text&&entry.text.includes('M02'))`);
    return draws.length > 0 && draws[0].fillStyle === "#00e5ff" && draws[0].font.startsWith("bold ");
  });
  await until("B-plain-cue", async () => {
    const draws = await clientB.evaluate(`window.__dualRig.draws.filter((entry)=>entry.text&&entry.text.includes('M02'))`);
    return draws.length > 0 && draws[0].fillStyle === "#ffffff" && !draws[0].font.startsWith("bold ");
  });
  const styleEvidence = {
    A: await clientA.evaluate(`window.__dualRig.draws.find((entry)=>entry.text&&entry.text.includes('M02'))`),
    B: await clientB.evaluate(`window.__dualRig.draws.find((entry)=>entry.text&&entry.text.includes('M02'))`),
  };
  await clientA.evaluate(`window.__dualRig.draws.length = 0`);
  await clientB.evaluate(`window.__dualRig.draws.length = 0`);

  // 房主移交给 A（步长按钮与后续 CMD 都由 A 承担；fixture 的 CMD 在移交前用完）。
  await command("CMD:transferOwner", { targetClientId: clientA.clientId });
  await until("A-is-owner", async () => (await room()).snapshot.ownerClientId === clientA.clientId, 8000);

  // A 的按钮步长=30（房间操作，revision+1）；B 的本机步长仍是 10，且 B 的偏好文件不被改写。
  const positionBefore = (await room()).snapshot.positionSeconds;
  const revisionBefore = (await room()).snapshot.revision;
  await clickSelector(clientA, 'button[aria-label="快进 30 秒（→）"]');
  await until("A-skip-forward-30", async () => Math.abs((await room()).snapshot.positionSeconds - (positionBefore + 30)) < 0.8, 6000);
  assert.equal((await room()).snapshot.revision, revisionBefore + 1, "one room seek command");
  const storedB = JSON.parse(await clientB.evaluate(`localStorage.getItem('watchparty.player-preferences.v1')`));
  const storedA = JSON.parse(await clientA.evaluate(`localStorage.getItem('watchparty.player-preferences.v1')`));
  assert.equal(storedB.skipForwardSeconds, 10, "B skip step untouched");
  assert.equal(storedA.skipForwardSeconds, 30, "A skip step kept");
  const preferenceDiff = {
    volume: [storedA.volume, storedB.volume], pictureFit: [storedA.pictureFit, storedB.pictureFit],
    skip: [storedA.skipBackwardSeconds, storedB.skipBackwardSeconds], color: [storedA.subtitleAppearance.color, storedB.subtitleAppearance.color],
    weight: [storedA.subtitleAppearance.fontWeight, storedB.subtitleAppearance.fontWeight],
  };
  assert.deepEqual(preferenceDiff.volume, [20, 80]);
  assert.deepEqual(preferenceDiff.pictureFit, ["cover", "contain"]);
  assert.deepEqual(preferenceDiff.skip, [5, 10]);
  assert.deepEqual(preferenceDiff.color, ["cyan", "white"]);
  assert.deepEqual(preferenceDiff.weight, ["bold", "normal"]);

  // 房间播放状态同步：A 播放 → B 跟上（两台的引擎时间都前进）。
  await clickSelector(clientA, 'button[aria-label="播放"]');
  await until("A-playing-advances", async () => (await mediaTime(clientA)) > positionBefore + 30.5, 8000);
  await until("B-follows-room-sync", async () => Math.abs((await mediaTime(clientB)) - (await mediaTime(clientA))) < 2.5, 8000);
  result.checks.push({ label: "independent-preferences-and-synced-room", value: {
    fitA, fitB, styleEvidence, preferenceDiff, positionBefore, afterSeek: (await room()).snapshot.positionSeconds } });

  // 交还房主（避免影响后续套件的 CMD 权限）。
  await clickSelector(clientA, 'button[aria-label^="在线成员"]');
  await until("handback-modal-open", async () => (await clientA.evaluate(`document.body.innerText.includes('移交房主')`)) === true, 5000);
  await clickDialogButton(clientA, "移交房主");
  await until("handback-confirm", async () => (await clientA.evaluate(`document.body.innerText.includes('确认移交')`)) === true, 5000);
  await clickDialogButton(clientA, "确认移交");
  await until("ownership-returned", async () => (await room()).snapshot.ownerClientId === fixture.ownerId, 8000);

  assert.deepEqual(await clientA.evaluate(`window.__dualRig.errors`), [], "A no page errors");
  assert.deepEqual(await clientB.evaluate(`window.__dualRig.errors`), [], "B no page errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = { owner: (await room()).snapshot.ownerClientId, fixtureOwner: fixture.ownerId }; } catch { /* room gone */ }
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  // 兜底交还：房主还挂在 A 上时尽力经 UI 交还
  try {
    const owner = (await room()).snapshot.ownerClientId;
    const clientA = clients[0];
    if (clientA && owner === clientA.clientId) {
      await clickSelector(clientA, 'button[aria-label^="在线成员"]');
      await sleep(300);
      await clickDialogButton(clientA, "移交房主");
      await sleep(200);
      await clickDialogButton(clientA, "确认移交");
      for (let attempt = 0; attempt < 20 && (await room()).snapshot.ownerClientId !== fixture.ownerId; attempt += 1) await sleep(200);
    }
  } catch { /* best-effort handback */ }
  for (const client of clients) {
    try { await client.send("Browser.close"); } catch { /* already gone */ }
    await sleep(300);
    client.process.kill();
    await rm(client.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
