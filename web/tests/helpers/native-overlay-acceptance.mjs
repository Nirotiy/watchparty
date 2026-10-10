// 原生路径 VTT/SRT 覆盖层验收（适配器级、真实本地 MP4）：外观档位、偏移、画面缩放。
// 自起 player-adapter-server（127.0.0.1:18984）。node web/tests/helpers/native-overlay-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChrome, sleep } from "./chrome-session.mjs";

const server = spawn("node", [fileURLToPath(new URL("./player-adapter-server.mjs", import.meta.url))], { stdio: "ignore" });
const output = process.argv[2] ?? "web/tests/results/native-overlay-2026-10-10.json";
const result = { startedAt: new Date().toISOString(), scope: "原生 <video> 路径：VTT 覆盖层外观/偏移/缩放（本地 MP4，无物理渲染声明）", checks: [] };
let browser;
const evaluate = (expression) => browser.evaluate(expression);
async function until(label, predicate, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) { result.checks.push({ label, elapsedMs: Date.now() - start }); console.log(`PASS: ${label} (${Date.now() - start}ms)`); return value; }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}
const overlayDraws = () => evaluate(`window.__adRig.draws.filter((entry)=>entry.canvas==='overlay')`);
const clearDraws = () => evaluate(`window.__adRig.draws.length = 0`);

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fetch("http://127.0.0.1:18984/"); break; } catch { await sleep(200); }
  }
  browser = await startChrome();
  await browser.send("Page.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__adRig={draws:[],errors:[]};
    const rig=globalThis.__adRig;
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
      const cls=String(this.canvas?.className??'');
      if(cls.includes('pointer-events-none')) rig.draws.push({canvas:'overlay',text:String(text),font:this.font,
        fillStyle:String(this.fillStyle),lineWidth:this.lineWidth,shadowBlur:this.shadowBlur,w:this.canvas.width,h:this.canvas.height,className:cls});
      if(rig.draws.length>200)rig.draws.shift();
      return fill.call(this,text,x,y,...args);
    };
    const fillRect=CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect=function(...args){
      const cls=String(this.canvas?.className??'');
      if(cls.includes('pointer-events-none')) rig.draws.push({canvas:'overlay',rect:args,fillStyle:String(this.fillStyle),className:cls});
      if(rig.draws.length>200)rig.draws.shift();
      return fillRect.apply(this,args);
    };
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
  })()` });
  await browser.send("Page.navigate", { url: "http://127.0.0.1:18984/" });
  await until("video-ready", async () => (await evaluate(`typeof rig !== 'undefined' && rig.video()?.readyState>=2`)) === true);

  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nNATIVE CUE 01\n\n00:00:04.000 --> 00:00:06.000\nNATIVE CUE 02\n";
  const style = { fontScale: 150, color: "cyan", fontWeight: "bold", outline: "thick", shadow: "strong", backgroundOpacity: 50, bottomRaisePercent: 0 };
  await evaluate(`rig.render({ source:{kind:'openlist',mediaId:'native-a',title:'A',container:'mp4'}, streamUrl:'/clip.mp4',
    subtitleText: ${JSON.stringify(vtt)}, subtitleFormat:'vtt', subtitleOffsetSeconds: 0, subtitleStyle: ${JSON.stringify(style)}, pictureFit:'cover' })`);
  await until("overlay-canvas-sized", async () => (await evaluate(`(()=>{const c=[...document.querySelectorAll('canvas')].find(x=>x.className.includes('pointer-events-none'));return Boolean(c&&c.width===320&&c.height===180);})()`)) === true);
  await evaluate(`rig.ref.current.seek(4.5)`);
  await until("cue-drawn-with-style", async () => (await overlayDraws()).some((entry) => entry.text === "NATIVE CUE 02" && entry.fillStyle === "#00e5ff"));
  const cueDraw = (await overlayDraws()).find((entry) => entry.text === "NATIVE CUE 02");
  assert.ok(cueDraw.font.startsWith("bold "), `bold font: ${cueDraw.font}`);
  assert.ok(cueDraw.lineWidth >= 6, `thick outline: ${cueDraw.lineWidth}`);
  assert.ok(cueDraw.shadowBlur > 0, `strong shadow: ${cueDraw.shadowBlur}`);
  const halfBackground = (await overlayDraws()).some((entry) => entry.rect && entry.fillStyle.includes("0.5"));
  assert.ok(halfBackground, "background opacity 50% must paint rgba(0,0,0,0.5)");
  const fitState = await evaluate(`(()=>{const video=document.querySelector('video');
    const canvas=[...document.querySelectorAll('canvas')].find(x=>x.className.includes('pointer-events-none'));
    return { video: video.className, overlay: canvas.className };})()`);
  assert.ok(fitState.video.includes("object-cover") && fitState.overlay.includes("object-cover"), `cover fit: ${JSON.stringify(fitState)}`);
  result.checks.push({ label: "native-overlay-style-and-cover", value: { font: cueDraw.font, fillStyle: cueDraw.fillStyle,
    lineWidth: cueDraw.lineWidth, shadowBlur: cueDraw.shadowBlur, halfBackground, fit: fitState } });

  // 间隙不显示；切回完整显示。
  await clearDraws();
  await evaluate(`rig.render({ pictureFit:'contain' })`);
  await evaluate(`rig.ref.current.seek(3.6)`);
  await sleep(500);
  assert.equal((await overlayDraws()).filter((entry) => entry.text).length, 0, "no cue between 3s and 4s");
  const containState = await evaluate(`document.querySelector('video').className`);
  assert.ok(containState.includes("object-contain"), `contain fit: ${containState}`);

  // 偏移：+2s 后 3.6s 处应显示 1–3s 的 cue；-0.5s 时 4.2s 处应显示 4–6s 的 cue、且 1–3s 的 cue 已出窗。
  await clearDraws();
  await evaluate(`rig.render({ subtitleOffsetSeconds: 2 })`);
  await until("offset-positive-shows-earlier-cue", async () => (await overlayDraws()).some((entry) => entry.text === "NATIVE CUE 01"));
  await clearDraws();
  await evaluate(`rig.render({ subtitleOffsetSeconds: -0.5 })`);
  await evaluate(`rig.ref.current.seek(4.2)`);
  await until("offset-negative-keeps-current-cue", async () => (await overlayDraws()).some((entry) => entry.text === "NATIVE CUE 02"));
  assert.ok(!(await overlayDraws()).some((entry) => entry.text === "NATIVE CUE 01"), "earlier cue must fall outside the shifted window");
  result.checks.push({ label: "native-overlay-offset-and-contain", value: { gapHidden: true, offsetShift: true, contain: true } });

  assert.deepEqual(await evaluate(`window.__adRig.errors`), [], "no page errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = { errors: await evaluate(`globalThis.__adRig?.errors`) }; } catch { /* page gone */ }
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
