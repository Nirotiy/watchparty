// 播放器设置追加裁决（2026-10-09）验收：三模式选轨、外观档位与实时预览、快进/后退步长、
// 画面缩放、存储提示、重置与持久化。需要已运行 fixture 栈：18981/18983（make-ui-fixture 的文件）
// 与 18982 的 Next dev。node web/tests/helpers/player-settings-v3-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const backend = "http://127.0.0.1:18981";
const origin = "http://127.0.0.1:18982";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const output = process.argv[2] ?? "web/tests/results/player-settings-v3-2026-10-10.json";
const browser = await startChrome();
const result = { startedAt: new Date().toISOString(), scope: "追加设置三模式/外观/步长/缩放/存储/重启恢复；真实 MKV 引擎；本地 fixture 房间", checks: [] };

const evaluate = (expression) => browser.evaluate(expression);
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
/** 在设置窗内按精确文本点击按钮（chips 用）并返回该按钮的 aria-pressed。 */
async function clickDialogButton(text) {
  const box = await evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
    .find(x=>x.textContent.trim()===${JSON.stringify(text)});
    if(!target)throw Error('dialog button not found: '+${JSON.stringify(text)});
    target.scrollIntoView({block:'center'});
    const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await clickPoint(box);
}
/** 带图标按钮的文本会混入 ligature，按包含匹配。 */
async function clickDialogButtonContaining(text) {
  const box = await evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
    .find(x=>x.textContent.includes(${JSON.stringify(text)}));
    if(!target)throw Error('dialog button not found: '+${JSON.stringify(text)});
    target.scrollIntoView({block:'center'});
    const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await clickPoint(box);
}
const dialogButtonPressed = (text) => evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
  .find(x=>x.textContent.trim()===${JSON.stringify(text)});
  return target?target.getAttribute('aria-pressed'):null;})()`);
const pressKey = async (key, code, windowsVirtualKeyCode) => {
  await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
};
const escapeKey = () => pressKey("Escape", "Escape", 27);
const engineTracks = () => evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
  let fiber=c[Object.keys(c).find(key=>key.startsWith('__reactFiber$'))];
  while(fiber){if(fiber.ref?.current?.getEmbeddedTracks){return fiber.ref.current.getEmbeddedTracks();}fiber=fiber.return;}
  throw Error('no adapter handle');})()`);
const clearDraws = () => evaluate(`window.__v3Rig.draws.length = 0`);
const drawsFor = (canvasLabel) => evaluate(`window.__v3Rig.draws.filter((entry)=>entry.canvas===${JSON.stringify(canvasLabel)})`);
const seekAndAwaitCue = async (target, pattern) => {
  // 先跳到邻近点再回目标：房间若已在目标位置，重复 seek 不会产生新的预览重绘。
  await command("CMD:seek", { positionSeconds: target + 1 });
  await sleep(200);
  await clearDraws();
  await command("CMD:seek", { positionSeconds: target });
  await until(`cue-${pattern.source}-at-${target}`, async () =>
    (await drawsFor("MKV 视频")).some((entry) => entry.text && new RegExp(pattern.source).test(entry.text)), 8000);
  return (await drawsFor("MKV 视频")).filter((entry) => entry.text);
};
const localMediaTime = () => evaluate(`Number(document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.mediaTime ?? -1)`);
const seedPreferences = (partial) => evaluate(`(()=>{const KEY='watchparty.player-preferences.v1';
  const current=JSON.parse(localStorage.getItem(KEY)||'{}');
  localStorage.setItem(KEY, JSON.stringify({...current, ...${JSON.stringify(partial)}}));return localStorage.getItem(KEY);})()`);
const reloadRoom = async () => {
  await browser.send("Page.reload");
  await until("room-reloaded", async () => (await evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
    return Boolean(c&&c.width===1920&&Number(c.dataset.mediaTime)>=0);})()`)) === true, 20000);
};
async function openSettings() {
  await clickSelector('button[aria-label="设置"]');
  await until("settings-open", async () => (await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`)) === true);
}
async function closeSettings() {
  await escapeKey();
  await until("settings-closed", async () => (await evaluate(`!document.querySelector('[role="dialog"]')`)) === true);
}

try {
  await command("CMD:mediaSet");
  await command("CMD:pause");
  await browser.send("Page.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__v3Rig={errors:[],draws:[]};
    const rig=globalThis.__v3Rig;
    const watch=(canvas)=>canvas && (canvas.getAttribute('aria-label')==='MKV 视频'||canvas.getAttribute('aria-label')==='字幕外观预览');
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
      if(watch(this.canvas)){rig.draws.push({canvas:this.canvas.getAttribute('aria-label'),text:String(text),y,font:this.font,
        fillStyle:String(this.fillStyle),lineWidth:this.lineWidth,shadowBlur:this.shadowBlur,
        canvasWidth:this.canvas.width,canvasHeight:this.canvas.height,time:Number(this.canvas.dataset?.mediaTime??-1)});
        if(rig.draws.length>200)rig.draws.shift();}
      return fill.call(this,text,x,y,...args);
    };
    const fillRect=CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect=function(...args){
      if(watch(this.canvas)){rig.draws.push({canvas:this.canvas.getAttribute('aria-label'),rect:args,fillStyle:String(this.fillStyle)});
        if(rig.draws.length>200)rig.draws.shift();}
      return fillRect.apply(this,args);
    };
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify(origin)}) {
      localStorage.setItem('watchparty_client_id',crypto.randomUUID());
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    }
  })()` });
  await browser.send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until("first-paused-frame", async () => (await evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');return Boolean(c&&c.width===1920&&Number(c.dataset.mediaTime)>=0);})()`)) === true);
  const tracks = await engineTracks();
  const subtitleTracksMeta = tracks.items.filter((track) => track.kind === "subtitle");
  assert.equal(subtitleTracksMeta.length, 2, "fixture must expose two embedded subtitle tracks");
  const englishId = subtitleTracksMeta.find((track) => track.language === "eng").id;
  const japaneseId = subtitleTracksMeta.find((track) => track.language === "jpn").id;
  result.fixture = { subtitleTracks: subtitleTracksMeta.map((track) => ({ id: track.id, language: track.language })), englishId, japaneseId };

  // ---- 1. 默认模式：跟随媒体默认 + 空列表 + 默认标记缺失 → 关闭（不拿第一条冒充默认轨） ----
  assert.equal((await engineTracks()).subtitleId, null, "media-default without marker/list must not show a subtitle");
  await clearDraws();
  await command("CMD:seek", { positionSeconds: 10.25 });
  await sleep(800);
  const defaultModeDraws = (await drawsFor("MKV 视频")).filter((entry) => entry.text);
  assert.equal(defaultModeDraws.length, 0, "no cue may be drawn in media-default without marker/list");
  result.checks.push({ label: "media-default-missing-marker-falls-closed", value: { subtitleId: null, cueDraws: 0 } });

  // ---- 2. 设置窗结构 + 实时预览（各档位重绘证据） ----
  await openSettings();
  const dialogText = await evaluate(`document.querySelector('[role="dialog"]').innerText`);
  for (const section of ["基础", "字幕外观", "字幕偏移", "播放", "恢复"]) assert.ok(dialogText.includes(section), `settings nav missing ${section}`);
  await clickDialogButton("字幕外观");
  await until("preview-drawn", async () => {
    const draws = await drawsFor("字幕外观预览");
    return draws.some((entry) => entry.text && entry.text.includes("中文字幕示例")) && draws.some((entry) => entry.text && entry.text.includes("English subtitle sample"));
  });
  const previewBaseline = (await drawsFor("字幕外观预览")).find((entry) => entry.text?.includes("中文"));
  assert.ok(previewBaseline.font.includes("30px"), `preview font baseline: ${previewBaseline.font}`);
  assert.ok(["#fff", "#ffffff"].includes(previewBaseline.fillStyle), `preview fill: ${previewBaseline.fillStyle}`);
  await clearDraws();
  await clickDialogButton("粗体");
  await until("preview-bold", async () => (await drawsFor("字幕外观预览")).some((entry) => entry.text?.includes("中文") && entry.font.startsWith("bold ")));
  const boldDraw = (await drawsFor("字幕外观预览")).find((entry) => entry.text?.includes("中文"));
  await clearDraws();
  await clickDialogButton("青");
  await until("preview-cyan", async () => (await drawsFor("字幕外观预览")).some((entry) => entry.text?.includes("中文") && entry.fillStyle === "#00e5ff"));
  await clearDraws();
  await clickDialogButton("粗");
  await until("preview-thick-outline", async () => (await drawsFor("字幕外观预览")).some((entry) => entry.text?.includes("中文") && entry.lineWidth >= 6));
  const thickDraw = (await drawsFor("字幕外观预览")).find((entry) => entry.text?.includes("中文"));
  await clearDraws();
  await clickDialogButton("强");
  await until("preview-strong-shadow", async () => (await drawsFor("字幕外观预览")).some((entry) => entry.text?.includes("中文") && entry.shadowBlur > 0));
  await clearDraws();
  await clickDialogButton("50%");
  await until("preview-half-background", async () => (await drawsFor("字幕外观预览")).some((entry) => entry.rect && entry.fillStyle.includes("0.5")));
  result.checks.push({ label: "appearance-preview-live-levels", value: {
    fontBaseline: previewBaseline.font, fontBold: boldDraw.font, thickLineWidth: thickDraw.lineWidth,
    color: "#00e5ff", shadow: "blur>0", background: "rgba(0,0,0,0.5)" } });
  await closeSettings();

  // ---- 3. 始终按偏好 + 语言列表命中（真实引擎按 jpn 选到日语轨并渲染） ----
  await seedPreferences({ subtitleMode: "prefer-list", subtitleLanguages: ["jpn"] });
  await reloadRoom();
  await until("prefer-list-selects-japanese", async () => (await engineTracks()).subtitleId === japaneseId);
  const japaneseCue = await seekAndAwaitCue(10.25, /JP M02/);
  result.checks.push({ label: "prefer-list-language-hit", value: { subtitleId: japaneseId, cue: japaneseCue.map((entry) => entry.text) } });
  // 列表为空 → 回退媒体默认（无标记时=引擎自身默认轨）→ 英语轨
  await seedPreferences({ subtitleMode: "prefer-list", subtitleLanguages: [] });
  await reloadRoom();
  await until("prefer-list-empty-falls-to-engine-default", async () => (await engineTracks()).subtitleId === englishId);
  const englishCue = await seekAndAwaitCue(10.25, /EN M02/);
  result.checks.push({ label: "prefer-list-empty-engine-default", value: { subtitleId: englishId, cue: englishCue.map((entry) => entry.text) } });
  // 跟随媒体默认 + 语言列表（无标记时走列表）
  await seedPreferences({ subtitleMode: "media-default", subtitleLanguages: ["eng"] });
  await reloadRoom();
  await until("media-default-list-fallback", async () => (await engineTracks()).subtitleId === englishId);
  result.checks.push({ label: "media-default-list-fallback", value: { subtitleId: englishId } });
  // 关闭：最高优先级 + 重新选择解除
  await seedPreferences({ subtitleMode: "off", subtitleLanguages: ["eng"] });
  await reloadRoom();
  await until("off-mode-keeps-subtitles-off", async () => (await engineTracks()).subtitleId === null);
  await clickSelector('button[aria-label="字幕"]');
  await until("subtitle-menu-open", async () => (await evaluate(`document.body.innerText.includes('本机字幕控制')`)) === true);
  await evaluate(`(()=>{const rows=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('subtitle'));
    const target=rows[rows.length-1];if(!target)throw Error('no embedded subtitle row');target.click();})()`);
  await until("manual-reselect-clears-off", async () => {
    const mode = await evaluate(`JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitleMode`);
    return (await engineTracks()).subtitleId === japaneseId && mode === "media-default";
  });
  await escapeKey();
  result.checks.push({ label: "off-priority-and-reselect-clears", value: { subtitleId: japaneseId, modeAfterPick: "media-default" } });

  // ---- 4. 跨源平局：上传外挂（带 language:jpn）与内嵌日语并列 → 来源优先打破 ----
  const uploadContent = "1\n00:00:10,000 --> 00:00:14,000\nEXT M02\n";
  const uploaded = await (await fetch(`${backend}/api/rooms/${fixture.room.roomId}/media/subtitles`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-watchparty-room": fixture.room.roomId, "x-watchparty-token": fixture.room.accessToken },
    body: JSON.stringify({ mediaId: fixture.source.mediaId, name: "probe.jpn.srt", format: "srt", content: uploadContent, language: "jpn" }) })).json();
  assert.ok(uploaded.id, `upload failed: ${JSON.stringify(uploaded)}`);
  await seedPreferences({ subtitleMode: "media-default", subtitleLanguages: ["jpn"], subtitleSourcePreference: "external" });
  await reloadRoom();
  const externalCue = await seekAndAwaitCue(10.25, /EXT M02/);
  assert.ok(externalCue.some((entry) => entry.text.includes("EXT M02")), "external must win the tie");
  await seedPreferences({ subtitleSourcePreference: "embedded" });
  await reloadRoom();
  const embeddedCue = await seekAndAwaitCue(10.25, /JP M02/);
  assert.ok(!embeddedCue.some((entry) => entry.text.includes("EXT M02")), "embedded preference must pick the embedded track");
  result.checks.push({ label: "cross-source-tie-break", value: {
    externalCue: externalCue.map((entry) => entry.text), embeddedCue: embeddedCue.map((entry) => entry.text), uploadedId: uploaded.id } });
  await fetch(`${backend}/api/rooms/${fixture.room.roomId}/media/subtitles/${encodeURIComponent(uploaded.id)}`, { method: "DELETE",
    headers: { "x-watchparty-room": fixture.room.roomId, "x-watchparty-token": fixture.room.accessToken } });

  // ---- 5. 外观即时作用于 MKV 画布（暂停态 seek 重绘） ----
  await seedPreferences({ subtitleMode: "prefer-list", subtitleLanguages: ["jpn"],
    subtitleAppearance: { fontScale: 100, color: "cyan", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 0, bottomRaisePercent: 0 } });
  await reloadRoom();
  await until("styled-subtitle-tracks", async () => (await engineTracks()).subtitleId === japaneseId);
  const styledCue = await seekAndAwaitCue(10.25, /JP M02/);
  const styledDraw = styledCue.find((entry) => entry.text.includes("JP M02"));
  assert.ok(styledDraw.font.startsWith("bold "), `styled font: ${styledDraw.font}`);
  assert.equal(styledDraw.fillStyle, "#00e5ff");
  assert.ok(styledDraw.lineWidth >= 6, `thick outline: ${styledDraw.lineWidth}`);
  assert.ok(styledDraw.shadowBlur > 0, `strong shadow: ${styledDraw.shadowBlur}`);
  result.checks.push({ label: "appearance-applies-to-mkv-canvas", value: {
    font: styledDraw.font, fillStyle: styledDraw.fillStyle, lineWidth: styledDraw.lineWidth, shadowBlur: styledDraw.shadowBlur } });

  // ---- 6.（移至末尾执行：需先移交房主，见第 11 段）画面缩放先行 ----
  // ---- 画面缩放：铺满/完整切换作用于 MKV 画布；全屏下保持；字幕照常绘制 ----
  await openSettings();
  await clickDialogButton("播放");
  await clickDialogButton("铺满画面");
  await until("fit-cover", async () => (await evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]').className.includes('object-cover')`)) === true);
  await closeSettings();
  const coverCue = await seekAndAwaitCue(10.25, /JP M02/);
  assert.ok(coverCue.some((entry) => entry.text.includes("JP M02")), "subtitles must still draw under cover fit");
  // 全屏下 cross-check 画布仍是 cover。
  let fullscreen = false;
  for (let attempt = 0; attempt < 3 && !fullscreen; attempt += 1) {
    await evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
    await clickSelector('button[aria-label="进入全屏"]');
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !fullscreen) { fullscreen = await evaluate(`document.fullscreenElement===document.documentElement`); if (!fullscreen) await sleep(120); }
  }
  assert.ok(fullscreen, "fullscreen entered");
  assert.ok(await evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]').className.includes('object-cover')`), "cover fit persists in fullscreen");
  let exited = false;
  for (let attempt = 0; attempt < 4 && !exited; attempt += 1) {
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 300 });
    await sleep(80);
    await clickSelector('button[aria-label="退出全屏"]');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !exited) { exited = await evaluate(`document.fullscreenElement===null`); if (!exited) await sleep(100); }
  }
  assert.ok(exited, "fullscreen exited");
  await openSettings();
  await clickDialogButton("播放");
  await clickDialogButton("完整显示");
  await until("fit-contain", async () => (await evaluate(`document.querySelector('canvas[aria-label="MKV 视频"]').className.includes('object-contain')`)) === true);
  await closeSettings();
  result.checks.push({ label: "picture-fit-cover-contain-fullscreen", value: { coverCueDrawn: true, fullscreenCover: true, restoredContain: true } });

  // ---- 8. YouTube：画面缩放如实标记不适用 ----
  // 用户提供的可用样例视频（YouTube 路径本轮只验"能力如实报告"，不涉播放完整性）。
  await command("CMD:mediaSet", { media: { kind: "youtube", videoId: "WO6aRHKe7_c" } });
  await until("youtube-source-active", async () => (await room()).snapshot.source?.kind === "youtube", 8000);
  await openSettings();
  await clickDialogButton("播放");
  await until("fit-not-applicable-note", async () => (await evaluate(`document.body.innerText.includes('YouTube 播放器不支持画面缩放')`)) === true, 8000);
  const fitDisabled = await evaluate(`(()=>{const buttons=[...document.querySelectorAll('[role="dialog"] button')].filter(x=>['完整显示','铺满画面'].includes(x.textContent.trim()));
    return buttons.length===2&&buttons.every(x=>x.disabled);})()`);
  assert.ok(fitDisabled, "fit chips must be disabled on YouTube");
  await closeSettings();
  await command("CMD:mediaSet");
  await until("media-restored", async () => (await evaluate(`Boolean(document.querySelector('canvas[aria-label="MKV 视频"]')?.width===1920)`)) === true, 20000);
  result.checks.push({ label: "youtube-fit-not-applicable", value: { note: true, chipsDisabled: fitDisabled } });

  // ---- 9. 持久化（刷新恢复）+ 存储不可用提示 ----
  const storedBeforeReload = JSON.parse(await evaluate(`localStorage.getItem('watchparty.player-preferences.v1')`));
  await reloadRoom();
  await openSettings();
  await clickDialogButton("基础");
  const modeLabel = { "media-default": "跟随媒体默认", "prefer-list": "始终按偏好", "off": "关闭" }[storedBeforeReload.subtitleMode];
  await until("persisted-mode-chip", async () => (await dialogButtonPressed(modeLabel)) === "true");
  await clickDialogButton("播放");
  const persistedChips = await evaluate(`[...document.querySelectorAll('[role="dialog"] button')]
    .filter(x=>['5s','10s','15s','20s','25s','30s','完整显示','铺满画面'].includes(x.textContent.trim()))
    .map(x=>({text:x.textContent.trim(),pressed:x.getAttribute('aria-pressed')}))`);
  const pressedLabel = persistedChips.filter((chip) => chip.pressed === "true").map((chip) => chip.text);
  assert.equal(pressedLabel.filter((label) => label.endsWith("s")).length, 2, `two skip steps pressed: ${JSON.stringify(persistedChips)}`);
  assert.ok(pressedLabel.includes(`${storedBeforeReload.skipBackwardSeconds}s`), "backward step chip restored");
  assert.ok(pressedLabel.includes(`${storedBeforeReload.skipForwardSeconds}s`), "forward step chip restored");
  assert.equal(pressedLabel.includes("完整显示"), storedBeforeReload.pictureFit === "contain", "fit chip restored");
  await clickDialogButton("字幕外观");
  const appearanceRestored = await until("persisted-appearance", async () => (await dialogButtonPressed("粗体")) === "true");
  await closeSettings();
  result.checks.push({ label: "reload-restores-preferences", value: { mode: modeLabel, pressedChips: pressedLabel, appearanceRestored: Boolean(appearanceRestored) } });
  // 存储不可用：setItem 抛错时设置窗明示"仅本次会话"。
  await evaluate(`(()=>{window.__nativeSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('quota');};})()`);
  await openSettings();
  await until("storage-unavailable-notice", async () => (await evaluate(`document.body.innerText.includes('本机存储不可用：设置仅在本次会话生效')`)) === true);
  await closeSettings();
  await evaluate(`(()=>{Storage.prototype.setItem=window.__nativeSetItem;})()`);
  result.checks.push({ label: "storage-unavailable-notice", value: true });

  // ---- 10. 重置播放器偏好：回默认并重新决策（无列表无标记 → 字幕关闭） ----
  await openSettings();
  await clickDialogButton("恢复");
  await clickDialogButtonContaining("重置播放器偏好");
  await until("reset-defaults", async () => {
    const saved = JSON.parse(await evaluate(`localStorage.getItem('watchparty.player-preferences.v1')`));
    return saved.subtitleMode === "media-default" && saved.skipBackwardSeconds === 10 && saved.skipForwardSeconds === 10
      && saved.pictureFit === "contain" && saved.subtitleAppearance.color === "white" && saved.subtitleAppearance.fontWeight === "normal";
  });
  await closeSettings();
  await until("reset-reapplies-rules", async () => (await engineTracks()).subtitleId === null, 8000);
  result.checks.push({ label: "reset-restores-defaults-and-rules", value: true });

  // ---- 11. 快进/后退步长（分存）+ 按钮/键盘按步长发起房间 seek（房主身份）；改设置不动 revision ----
  // 浏览器以随机 clientId 入房；fixture 的 CMD 端点依赖它自己的 owner socket（不能冒充 ownerId），
  // 因此走正规移交：先把房主转给浏览器，测完经"成员"弹窗交还，保证后续套件的 CMD 仍持有房主。
  const browserClientId = await evaluate(`localStorage.getItem('watchparty_client_id')`);
  await command("CMD:transferOwner", { targetClientId: browserClientId });
  await until("browser-becomes-owner", async () => (await room()).snapshot.ownerClientId === browserClientId, 8000);
  assert.equal((await room()).snapshot.paused, true, "skip checks expect the shared playback paused");
  const revisionBeforeSettings = (await room()).snapshot.revision;
  await openSettings();
  await clickDialogButton("播放");
  await clickDialogButton("5s");
  await evaluate(`(()=>{const buttons=[...document.querySelectorAll('[role="dialog"] button')].filter(x=>x.textContent.trim()==='30s');
    if(buttons.length!==2)throw Error('expect two 30s chips, got '+buttons.length);buttons[1].scrollIntoView({block:'center'});buttons[1].click();})()`);
  await until("skip-steps-persisted", async () => {
    const saved = JSON.parse(await evaluate(`localStorage.getItem('watchparty.player-preferences.v1')`));
    return saved.skipBackwardSeconds === 5 && saved.skipForwardSeconds === 30;
  });
  const revisionDuringSettings = (await room()).snapshot.revision;
  assert.equal(revisionDuringSettings, revisionBeforeSettings, "changing local settings must not change revision");
  await closeSettings();
  const positionBefore = (await room()).snapshot.positionSeconds;
  await clickSelector('button[aria-label="快进 30 秒（→）"]');
  await until("skip-forward-30", async () => Math.abs((await room()).snapshot.positionSeconds - (positionBefore + 30)) < 0.6, 6000);
  const revisionAfterSkip = (await room()).snapshot.revision;
  assert.equal(revisionAfterSkip, revisionBeforeSettings + 1, "skip seek is exactly one room command");
  const positionAfterForward = (await room()).snapshot.positionSeconds;
  // 等本机画面时间追上新位置，避免下一跳以滞后时间作基准。
  await until("local-media-time-syncs-forward", async () => Math.abs((await localMediaTime()) - positionAfterForward) < 1.5, 6000);
  await evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await pressKey("ArrowLeft", "ArrowLeft", 37);
  await until("keyboard-skip-back-5", async () => Math.abs((await room()).snapshot.positionSeconds - (positionAfterForward - 5)) < 0.6, 6000);
  const positionAfterBack = (await room()).snapshot.positionSeconds;
  await until("local-media-time-syncs-back", async () => Math.abs((await localMediaTime()) - positionAfterBack) < 1.5, 6000);
  await pressKey("ArrowRight", "ArrowRight", 39);
  await until("keyboard-skip-forward-30", async () => Math.abs((await room()).snapshot.positionSeconds - (positionAfterBack + 30)) < 0.6, 6000);
  const positionAfterKeyboard = (await room()).snapshot.positionSeconds;
  result.checks.push({ label: "skip-steps-and-room-seek", value: {
    revisionBeforeSettings, revisionDuringSettings, revisionAfterSkip,
    forward30: positionAfterForward - positionBefore, keyboardBack: positionAfterBack - positionAfterForward,
    keyboardForward: positionAfterKeyboard - positionAfterBack } });
  await clickSelector('button[aria-label^="在线成员"]');
  await until("members-modal-open", async () => (await evaluate(`document.body.innerText.includes('移交房主')`)) === true, 5000);
  await clickDialogButton("移交房主");
  await until("transfer-confirm-visible", async () => (await evaluate(`document.body.innerText.includes('确认移交')`)) === true, 5000);
  await clickDialogButton("确认移交");
  await until("ownership-returned", async () => (await room()).snapshot.ownerClientId === fixture.ownerId, 8000);
  result.checks.push({ label: "ownership-handed-back", value: { ownerId: fixture.ownerId } });

  assert.deepEqual(await evaluate(`window.__v3Rig.errors`), [], "no page errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = { body: await evaluate(`document.body.innerText.slice(0,600)`), errors: await evaluate(`globalThis.__v3Rig?.errors`) }; } catch { /* page gone */ }
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  // 失败路径兜底：房主若还挂在浏览器上，尽力交还 fixture（否则后续套件的 CMD 都会被权限拦截）。
  try {
    const clientId = await evaluate(`localStorage.getItem('watchparty_client_id')`);
    if ((await room()).snapshot.ownerClientId === clientId) {
      await clickSelector('button[aria-label^="在线成员"]');
      await sleep(300);
      await clickDialogButton("移交房主");
      await sleep(200);
      await clickDialogButton("确认移交");
      for (let attempt = 0; attempt < 20 && (await room()).snapshot.ownerClientId !== fixture.ownerId; attempt += 1) await sleep(200);
    }
  } catch { /* best-effort handback */ }
  await browser.close();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
