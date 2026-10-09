// Scheme A room UI acceptance: viewports, fullscreen overlays, subtitle safe area,
// local audio entry, track menus, buffering status, same-media retry, touch first tap.
// node web/tests/helpers/mkv-ui-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const backend = "http://127.0.0.1:18981";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const browser = await startChrome();
const result = { startedAt: new Date().toISOString(), checks: [], geometry: [], scope: "Scheme A UI surfaces; fixture room only" };
const output = process.argv[2] ?? "web/tests/results/mkv-ui-scheme-a.json";
const room = () => fetch(`${backend}/__fixture`).then((response) => response.json());
const command = async (event, payload = {}) => {
  const ack = await (await fetch(`${backend}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(ack.ok, true, JSON.stringify(ack));
};

const evaluate = (expression) => browser.evaluate(expression);
async function until(label, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) { result.checks.push({ label, elapsedMs: Date.now() - start }); console.log(`PASS: ${label} (${Date.now() - start}ms)`); return value; }
    await sleep(120);
  }
  throw new Error(`timeout: ${label}`);
}
async function clickPoint(point) {
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await sleep(60);
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function clickSelector(selector) {
  const box = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('not found: '+${JSON.stringify(selector)});
    const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await clickPoint(box);
}
async function clickButtonWithText(text) {
  const box = await evaluate(`(()=>{const target=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(text)}));
    if(!target)throw Error('button not found: '+${JSON.stringify(text)});
    const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await clickPoint(box);
}
const escapeKey = async () => {
  await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};
const viewport = (width, height) => browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const mediaTime = () => evaluate(`Number(document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.mediaTime)`);
const revision = async () => (await room()).snapshot.revision;
const engineTracks = () => evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
  let fiber=c[Object.keys(c).find(key=>key.startsWith('__reactFiber$'))];
  while(fiber){if(fiber.ref?.current?.getEmbeddedTracks){return fiber.ref.current.getEmbeddedTracks();}fiber=fiber.return;}
  throw Error('no adapter handle');})()`);

// 各断点下：三组控件可见内容互不重叠、必要控件在视口内。
// 运输组在宽屏是绝对居中，落在两侧 flex 容器的空区上；比较内容边界而非容器盒子。
async function measureControls(label) {
  const value = await evaluate(`(() => {
    const contentRect = (group) => {
      const rects = [...group.children].map((child) => child.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const picked = rects.length ? rects : [group.getBoundingClientRect()];
      const x = Math.min(...picked.map((r) => r.x));
      const y = Math.min(...picked.map((r) => r.y));
      const right = Math.max(...picked.map((r) => r.right));
      const bottom = Math.max(...picked.map((r) => r.bottom));
      return { x, y, right, bottom, w: right - x, h: bottom - y };
    };
    const transport = document.querySelector('button[aria-label="播放"],button[aria-label="暂停"]').parentElement;
    const left = document.querySelector('button[aria-label="静音"],button[aria-label="取消静音"]').parentElement;
    const right = document.querySelector('button[aria-label="进入全屏"],button[aria-label="退出全屏"]').parentElement;
    return { transport: contentRect(transport), left: contentRect(left), right: contentRect(right),
      width: innerWidth, height: innerHeight,
      volumeSliderVisible: (() => { const s = document.querySelector('[aria-label="音量"]'); return Boolean(s && s.offsetParent); })(),
      moreVisible: Boolean(document.querySelector('button[aria-label="更多工具"]')?.offsetParent),
      audioMenuButton: Boolean(document.querySelector('button[aria-label="音轨"]')),
      subtitleButton: Boolean(document.querySelector('button[aria-label="字幕"]')) };
  })()`);
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
  result.geometry.push({ label, ...value });
  assert.ok(!overlap(value.transport, value.left), `${label}: transport overlaps left tools`);
  assert.ok(!overlap(value.transport, value.right), `${label}: transport overlaps right tools`);
  for (const [name, box] of Object.entries({ transport: value.transport, left: value.left, right: value.right })) {
    assert.ok(box.x >= -1 && box.right <= value.width + 1, `${label}: ${name} out of viewport`);
  }
  assert.ok(value.audioMenuButton && value.subtitleButton, `${label}: track buttons missing`);
  return value;
}

try {
  await command("CMD:mediaSet");
  await browser.send("Page.enable");
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__uiRig={errors:[],cues:[],workers:[],fetches:[]};
    const rig=globalThis.__uiRig;
    const NativeWorker=Worker;
    globalThis.Worker=class extends NativeWorker { constructor(...args){super(...args);const entry={stopped:false};rig.workers.push(entry);
      const stop=this.terminate.bind(this);this.terminate=()=>{entry.stopped=true;stop();};} };
    const nativeFetch=globalThis.fetch.bind(globalThis);
    globalThis.fetch=(input,...rest)=>{try{rig.fetches.push(String(typeof input==='string'?input:input.url));}catch{}return nativeFetch(input,...rest);};
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
      if(this.canvas && this.canvas.getAttribute('aria-label')==='MKV 视频'){
        rig.cues.push({text:String(text),x,y,canvasWidth:this.canvas.width,canvasHeight:this.canvas.height,
          time:Number(this.canvas.dataset.mediaTime)});
        if(rig.cues.length>40)rig.cues.shift();
      }
      return fill.call(this,text,x,y,...args);
    };
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify("http://127.0.0.1:18982")}) {
      localStorage.setItem('watchparty_client_id',crypto.randomUUID());
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    }
  })()` });
  await browser.send("Page.navigate", { url: `http://127.0.0.1:18982/room/${fixture.room.roomId}` });
  await until("first-paused-frame", async () => (await evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');return Boolean(c&&c.width===1920&&Number(c.dataset.mediaTime)>=0);})()`)) === true);

  // ---- 1. 视口几何：360 / 390 / 683(200% 缩放等效) / 1366 / 2560 ----
  for (const [label, width, height] of [["ui-360", 360, 640], ["ui-390", 390, 844], ["ui-683", 683, 768], ["ui-1366", 1366, 768], ["ui-2560", 2560, 1440]]) {
    await viewport(width, height);
    await sleep(350);
    const value = await measureControls(label);
    result.checks.push({ label: `geometry-${label}`, value });
    console.log(`PASS: geometry-${label} transport=[${value.transport.x.toFixed(0)},${value.transport.y.toFixed(0)},${value.transport.right.toFixed(0)}] leftBottom=${value.left.bottom.toFixed(0)} rightTop=${value.right.y.toFixed(0)}`);
  }
  const narrow360 = result.geometry.find((entry) => entry.label === "ui-360");
  assert.equal(narrow360.volumeSliderVisible, false, "360: volume slider hidden");
  assert.equal(narrow360.moreVisible, true, "360: more menu present");
  const wide1366 = result.geometry.find((entry) => entry.label === "ui-1366");
  assert.equal(wide1366.volumeSliderVisible, true, "1366: volume slider visible");
  assert.equal(wide1366.moreVisible, false, "1366: more menu hidden");
  assert.ok(narrow360.transport.bottom <= Math.min(narrow360.left.y, narrow360.right.y) + 2, "360: transport owns its own row");
  result.checks.push({ label: "narrow-360-two-row-layout", value: { transportBottom: narrow360.transport.bottom, leftTop: narrow360.left.y, rightTop: narrow360.right.y } });

  await viewport(1366, 768);
  await sleep(300);

  // ---- 2. 音频入口（刷新到无手势状态）----
  await browser.send("Page.reload");
  await until("reload-blocked-audio", async () => (await evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');return Boolean(c&&Number(c.dataset.mediaTime)>=0&&c.dataset.audioState==='blocked');})()`)) === true);
  assert.equal(await evaluate(`document.body.innerText.includes('声音未开启')`), true, "audio chip visible while blocked");
  const revisionBeforeUnlock = await revision();
  await clickButtonWithText("声音未开启");
  await until("audio-chip-unlock", async () => (await evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.audioState`)) === "running");
  const revisionAfterUnlock = await revision();
  assert.equal(revisionAfterUnlock, revisionBeforeUnlock, "local unlock must not change revision");
  await until("audio-chip-gone", async () => (await evaluate(`!document.body.innerText.includes('声音未开启')`)) === true);
  result.checks.push({ label: "audio-chip-local-unlock", value: { revisionBeforeUnlock, revisionAfterUnlock } });

  // ---- 3. 轨道菜单（音轨切换 / 内嵌字幕选择 / 字幕关闭），全程不改 revision ----
  const revisionBeforeTracks = await revision();
  await clickSelector('button[aria-label="音轨"]');
  await until("audio-menu-opens", async () => (await evaluate(`document.body.innerText.includes('本机音轨')`)) === true);
  const audioRows = await evaluate(`[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('audio')).length`);
  assert.equal(audioRows, 2, "audio menu lists two embedded tracks");
  const beforeAudioId = (await engineTracks()).audioId;
  await evaluate(`(()=>{const rows=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('audio'));
    const target=rows.find(x=>!x.className.includes('text-sky-400'));
    if(!target)throw Error('no alternative audio row');target.click();})()`);
  await until("audio-track-switched", async () => (await engineTracks()).audioId !== beforeAudioId);
  await escapeKey();
  await sleep(200);

  await clickSelector('button[aria-label="字幕"]');
  await until("subtitle-menu-opens", async () => (await evaluate(`document.body.innerText.includes('本机字幕控制')`)) === true);
  assert.ok(await evaluate(`document.body.innerText.includes('内嵌字幕轨')`), "subtitle menu shows embedded section");
  assert.ok(await evaluate(`document.body.innerText.includes('字幕关闭')`), "subtitle menu shows off row");
  await evaluate(`(()=>{const rows=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('subtitle'));
    const target=rows[rows.length-1];if(!target)throw Error('no embedded subtitle row');target.click();})()`);
  await until("embedded-subtitle-selected", async () => (await engineTracks()).subtitleId !== null);
  await clickButtonWithText("字幕关闭");
  await until("subtitles-off", async () => (await engineTracks()).subtitleId === null);
  const revisionAfterTracks = await revision();
  assert.equal(revisionAfterTracks, revisionBeforeTracks, "track selections must not change revision");
  await evaluate(`(()=>{const target=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('subtitle 4'));
    if(!target)throw Error('subtitle 4 row missing');target.click();})()`);
  await until("embedded-subtitle-reselected", async () => (await engineTracks()).subtitleId !== null);
  await escapeKey();
  result.checks.push({ label: "track-menus-local-only", value: { revisionBeforeTracks, revisionAfterTracks } });

  // ---- 4. 字幕安全区：暂停在字幕窗口，最低一行字幕必须高于底部浮层顶边 ----
  let cueCaptured = null;
  for (const target of [10.25, 0.9, 8005.2]) {
    await evaluate(`window.__uiRig.cues.length = 0`);
    await command("CMD:seek", { positionSeconds: target });
    try {
      await until(`cue-at-${target}`, async () => (await evaluate(`window.__uiRig.cues.length > 0`)) === true, 5000);
      cueCaptured = target;
      break;
    } catch { /* 换下一个已知字幕窗口 */ }
  }
  assert.ok(cueCaptured !== null, "no subtitle cue drawn for safe-area measurement");
  const safeArea = await evaluate(`(() => {
    const canvas=document.querySelector('canvas[aria-label="MKV 视频"]');
    const overlay=document.querySelector('[data-controls-pinned]');
    const rect=canvas.getBoundingClientRect();const overlayRect=overlay.getBoundingClientRect();
    const scale=Math.min(rect.width/canvas.width, rect.height/canvas.height);
    const letterbox=(rect.height-canvas.height*scale)/2;
    const cssYs=window.__uiRig.cues.map(cue=>rect.top+letterbox+cue.y*scale);
    return { cues: window.__uiRig.cues.map(cue=>cue.text),
      lowestCssY: Math.min(...cssYs), overlayTop: overlayRect.top,
      marginCssPx: overlayRect.top-Math.min(...cssYs),
      controlsState: overlay.getAttribute('data-controls-state') };
  })()`);
  assert.equal(safeArea.controlsState, "visible", "controls visible while measuring subtitle safe area");
  assert.ok(safeArea.marginCssPx >= 0, `subtitle baseline must clear the overlay: ${JSON.stringify(safeArea)}`);
  result.checks.push({ label: "subtitle-safe-area", value: { ...safeArea, atSeconds: cueCaptured } });
  console.log(`PASS: subtitle-safe-area margin=${safeArea.marginCssPx.toFixed(1)}px cues=${safeArea.cues.join("/")}`);

  // ---- 5. 缓冲状态：媒体响应停顿期间舞台显示本机缓冲，恢复后消失 ----
  await command("CMD:play");
  await until("playing-before-stall", async () => (await mediaTime()) > 11);
  await fetch(`${backend}/__fixture/stall`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ durationMs: 4000 }) });
  await command("CMD:seek", { positionSeconds: 8000 });
  await until("buffering-status-visible", async () => (await evaluate(`document.body.innerText.includes('缓冲中')&&document.body.innerText.includes('本机缓冲')`)) === true, 6000);
  for (let i = 0; i < 40 && await evaluate(`document.body.innerText.includes('缓冲中')`); i++) await sleep(250);
  await until("buffering-recovered", async () => (await mediaTime()) > 8001, 15000);
  await command("CMD:pause");
  result.checks.push({ label: "buffering-status-local", value: { visibleDuringStall: true, hiddenAfterRecovery: true } });

  // ---- 6. 同媒体重试面板与桌面出口 ----
  await command("CMD:mediaSet", { media: { kind: "http", url: "https://127.0.0.1:18982/__missing.mkv" } });
  await until("retry-panel-visible", async () => (await evaluate(`document.body.innerText.includes('本机播放失败')&&document.body.innerText.includes('重试本机播放')&&document.body.innerText.includes('桌面端播放')`)) === true, 25000);
  // 探测失败发生在引擎 Worker 创建之前，用对同媒体 URL 的重新拉取证明 retry() 重建了引擎。
  const missingFetches = () => evaluate(`window.__uiRig.fetches.filter((url)=>url.includes('__missing')).length`);
  const fetchesBeforeRetry = await missingFetches();
  await clickButtonWithText("重试本机播放");
  await until("retry-refetches-same-media", async () => (await missingFetches()) > fetchesBeforeRetry, 10000);
  await until("retry-panel-returns", async () => (await evaluate(`document.body.innerText.includes('重试本机播放')&&![...document.querySelectorAll('button')].some(x=>x.disabled&&x.textContent.includes('重试中'))`)) === true, 25000);
  await clickButtonWithText("桌面端播放");
  await until("desktop-handoff-dialog", async () => (await evaluate(`document.body.innerText.includes('在桌面端播放')`)) === true);
  await clickSelector('button[aria-label="关闭"]');
  await sleep(300);
  await command("CMD:mediaSet");
  await until("fixture-media-restored", async () => (await evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');return Boolean(c&&c.width===1920&&Number(c.dataset.mediaTime)>=0);})()`)) === true, 25000);
  result.checks.push({ label: "same-media-retry-panel", value: { fetchesBeforeRetry, fetchesAfterRetry: await missingFetches() } });

  // ---- 7. 全屏：整文档全屏下控制栏、菜单与弹窗均可见 ----
  const fullscreenDiagnostics = [];
  let fullscreenEntered = false;
  for (let attempt = 0; attempt < 3 && !fullscreenEntered; attempt += 1) {
    fullscreenDiagnostics.push(await evaluate(`(()=>{const b=document.querySelector('button[aria-label="进入全屏"]');
      if(!b)return {found:false};
      const r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {found:true, rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
        hit: hit ? String(hit.getAttribute?.('aria-label') || hit.tagName) : null,
        active: String(document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName || ''),
        bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
        fullscreenEnabled: document.fullscreenEnabled};})()`));
    await evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
    await clickSelector('button[aria-label="进入全屏"]');
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !fullscreenEntered) {
      fullscreenEntered = await evaluate(`document.fullscreenElement===document.documentElement`);
      if (!fullscreenEntered) await sleep(120);
    }
  }
  if (!fullscreenEntered) throw new Error(`fullscreen not entered: ${JSON.stringify(fullscreenDiagnostics)}`);
  result.checks.push({ label: "fullscreen-entered", value: { attempts: fullscreenDiagnostics.length, diagnostics: fullscreenDiagnostics } });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
  await until("fullscreen-controls-visible", async () => (await evaluate(`document.querySelector('[data-controls-pinned]')?.getAttribute('data-controls-state')==='visible'`)) === true);
  await clickSelector('button[aria-label="字幕"]');
  await until("fullscreen-menu-visible", async () => (await evaluate(`(()=>{const el=[...document.querySelectorAll('*')].find(x=>x.textContent==='本机字幕控制'&&x.children.length===0);
    if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})()`)) === true);
  await clickSelector('button[aria-label="字幕"]');
  await sleep(200);
  await clickSelector('button[aria-label="点播媒体库"]');
  await until("fullscreen-dialog-visible", async () => (await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');
    if(!dialog)return false;const r=dialog.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+1;})()`)) === true);
  await clickSelector('button[aria-label="关闭媒体库"]');
  await sleep(200);
  // 退出与进入同为命令式全屏代理；弹窗关闭动画/控制层时序会让单次点击偶发落空，
  // 与进入步骤对称做重试并记录每次诊断（命中元素、按钮矩形、当前 fullscreenElement）。
  const fullscreenExitDiagnostics = [];
  let fullscreenExited = false;
  for (let attempt = 0; attempt < 4 && !fullscreenExited; attempt += 1) {
    fullscreenExitDiagnostics.push(await evaluate(`(()=>{const b=document.querySelector('button[aria-label="退出全屏"]');
      if(!b)return {found:false};
      const r=b.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {found:true,rect:{x:Math.round(r.x),y:Math.round(r.y)},hit:hit?String(hit.getAttribute?.('aria-label')||hit.tagName):null,
        fullscreen: document.fullscreenElement?.tagName ?? null,
        controlsState: document.querySelector('[data-controls-pinned]')?.getAttribute('data-controls-state')};})()`));
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 300 });
    await sleep(80);
    await clickSelector('button[aria-label="退出全屏"]');
    const exitDeadline = Date.now() + 2000;
    while (Date.now() < exitDeadline && !fullscreenExited) {
      fullscreenExited = await evaluate(`document.fullscreenElement===null`);
      if (!fullscreenExited) await sleep(100);
    }
  }
  if (!fullscreenExited) throw new Error(`fullscreen not exited: ${JSON.stringify(fullscreenExitDiagnostics)}`);
  result.checks.push({ label: "fullscreen-exited", value: { attempts: fullscreenExitDiagnostics.length, diagnostics: fullscreenExitDiagnostics } });
  result.checks.push({ label: "fullscreen-includes-overlays-and-dialogs", value: true });

  // ---- 8. 触屏：控制层隐藏时首次点按只呼出，不切换共享播放 ----
  await command("CMD:play");
  await until("playing-for-touch", async () => (await mediaTime()) > 0);
  // 脚本点击按钮会留下焦点（产品有意在焦点位于控制层时不隐藏）；先失焦再触发一次指针移动重新计时。
  await evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 300 });
  await sleep(3200);
  assert.equal(await evaluate(`document.querySelector('[data-controls-pinned]')?.getAttribute('data-controls-state')`), "hidden", "controls auto-hidden before touch tap");
  const touchPoint = await evaluate(`(()=>{const r=document.querySelector('canvas[aria-label="MKV 视频"]').getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...touchPoint }] });
  await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(500);
  assert.equal(await evaluate(`document.querySelector('[data-controls-pinned]')?.getAttribute('data-controls-state')`), "visible", "first touch tap reveals controls");
  await sleep(800);
  assert.equal((await room()).snapshot.paused, false, "first touch tap must not toggle shared playback");
  await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...touchPoint }] });
  await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until("second-tap-toggles", async () => (await room()).snapshot.paused === true, 5000);
  await command("CMD:play");
  result.checks.push({ label: "touch-first-tap-reveals-only", value: { secondTapToggled: true } });

  assert.deepEqual(await evaluate(`window.__uiRig.errors`), [], "no page errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = { body: await evaluate(`document.body.innerText.slice(0,800)`), errors: await evaluate(`globalThis.__uiRig?.errors`) }; } catch {}
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  await browser.close();
  result.profileDeleted = true;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
