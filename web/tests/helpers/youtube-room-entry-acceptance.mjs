// YouTube 房间级验收（真实房间/媒体库入口 + 真引擎接线）：watch 链与裸 ID 提交规范化、
// 不支持形态就地说明且不发请求、无 API key 参与、单客户端失败不改房间状态。
// 需要 fixture 栈 18981/18983（make-ui-fixture）与 18982 Next dev。
// node web/tests/helpers/youtube-room-entry-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const backend = "http://127.0.0.1:18981";
const origin = "http://127.0.0.1:18982";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const output = process.argv[2] ?? "web/tests/results/youtube-room-entry-2026-10-10.json";
const result = { startedAt: new Date().toISOString(), scope: "真实房间 + 媒体库入口；YouTube iframe 网络可达性因机器而异，不作播放声明", checks: [] };
const browser = await startChrome();
const evaluate = (expression) => browser.evaluate(expression);
const room = () => fetch(`${backend}/__fixture`).then((response) => response.json());
const command = async (event, payload = {}) => {
  const ack = await (await fetch(`${backend}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return ack;
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
async function clickSelector(selector) {
  const box = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('not found: '+${JSON.stringify(selector)});
    element.scrollIntoView({block:'center'});
    const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await sleep(60);
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
async function clickDialogButton(text) {
  const box = await evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
    .find(x=>x.textContent.trim()===${JSON.stringify(text)});
    if(!target)throw Error('dialog button not found: '+${JSON.stringify(text)});
    target.scrollIntoView({block:'center'});
    const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await sleep(60);
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
}
const setSearchInput = (value) => evaluate(`(()=>{const input=document.querySelector('[role="dialog"][data-state="open"] input');
  if(!input)throw Error('search input missing');
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const sourceOf = async () => (await room()).snapshot.source;

try {
  await command("CMD:mediaSet");
  await command("CMD:pause");
  await browser.send("Page.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__ytRig={errors:[],fetches:[]};
    const rig=globalThis.__ytRig;
    const nativeFetch=globalThis.fetch.bind(globalThis);
    globalThis.fetch=(input,...rest)=>{try{rig.fetches.push(String(typeof input==='string'?input:input.url));}catch{}return nativeFetch(input,...rest);};
    const send=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...rest){try{rig.fetches.push(String(url));}catch{}return send.call(this,method,url,...rest);};
    addEventListener('error',event=>rig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>rig.errors.push(String(event.reason)));
    if(location.origin===${JSON.stringify(origin)}) {
      localStorage.setItem('watchparty_client_id',crypto.randomUUID());
      localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    }
  })()` });
  await browser.send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until("room-ready", async () => (await evaluate(`Boolean(document.querySelector('canvas[aria-label="MKV 视频"]')?.width===1920)`)) === true, 25000);
  const browserClientId = await evaluate(`localStorage.getItem('watchparty_client_id')`);
  await command("CMD:transferOwner", { targetClientId: browserClientId });
  await until("browser-is-owner", async () => (await room()).snapshot.ownerClientId === browserClientId, 8000);

  // ---- 1. watch 链入口：识别 → capability 说明 → 提交规范化 source（revision 只 +mediaSet 一次） ----
  const ensureLibraryOpen = async () => {
    // 提交后弹窗会在关闭动画里逗留；先等它离场，再开新的，并留出异步初始化重置输入的确定窗口。
    await until("library-closed-settled", async () => (await evaluate(`!document.querySelector('[role="dialog"]')`)) === true, 6000).catch(() => {});
    await clickSelector('button[aria-label="点播媒体库"]');
    await until("library-opened", async () => (await evaluate(`Boolean(document.querySelector('[role="dialog"][data-state="open"] input'))`)) === true, 8000);
    await sleep(1200);
  };
  await ensureLibraryOpen();
  await setSearchInput("https://www.youtube.com/watch?v=WO6aRHKe7_c");  await until("link-row-visible", async () => (await evaluate(`document.body.innerText.includes('播放此链接')`)) === true);
  assert.ok(await evaluate(`document.body.innerText.includes('YouTube')`), "YouTube chip visible");
  await until("capability-note", async () => (await evaluate(`document.body.innerText.includes('需能访问 youtube.com')`)) === true, 5000);
  const revisionBefore = (await room()).snapshot.revision;
  // 该行按钮含键帽文本（"播放此链接⏎"），按包含匹配点击。
  await evaluate(`(()=>{const target=[...document.querySelectorAll('[role="dialog"] button')]
    .find(x=>x.textContent.includes('播放此链接'));
    if(!target)throw Error('play-link button missing');target.click();})()`);
  await until("watch-link-source", async () => {
    const source = await sourceOf();
    return source?.kind === "youtube" && source.videoId === "WO6aRHKe7_c";
  }, 8000);
  const revisionAfter = (await room()).snapshot.revision;
  assert.equal(revisionAfter, revisionBefore + 1, "exactly one mediaSet command");
  const submitted = await sourceOf();
  assert.equal(submitted.title, "YouTube 视频");
  result.checks.push({ label: "watch-url-entry-normalized", value: { source: submitted, revisionBefore, revisionAfter } });

  // 无 API key：页面没有任何带 key 的 YouTube/Google API 请求（iframe 资源请求可接受）。
  const keyed = await evaluate(`window.__ytRig.fetches.filter((url)=>/googleapis|key=/i.test(url))`);
  assert.deepEqual(keyed, [], "no API-key requests from the page");
  result.checks.push({ label: "no-api-key-requests", value: { keyedRequests: keyed, sampleFetches: (await evaluate(`window.__ytRig.fetches.slice(-6)`)) } });

  // ---- 2. 单客户端失败不改房间：无效视频（浏览器提交）→ 契约消息出现，revision/paused 不变 ----
  const youtubeMessages = ["YouTube 视频标识无效", "YouTube 播放失败", "YouTube 视频不存在、已移除或为私密视频",
    "该 YouTube 视频不允许嵌入播放", "YouTube 无法确认嵌入客户端身份", "YouTube 播放器接口加载失败，请检查浏览器网络或代理", "YouTube 播放器发生未知错误"];
  await ensureLibraryOpen();
  await setSearchInput("zzzzzzzzzzz");
  await until("invalid-id-row", async () => (await evaluate(`Boolean(document.querySelector('[data-testid="youtube-id-row"]'))`)) === true, 5000);
  await evaluate(`document.querySelector('[data-testid="youtube-id-row"] button').click()`);
  await until("invalid-video-source", async () => {
    const source = await sourceOf();
    return source?.kind === "youtube" && source.videoId === "zzzzzzzzzzz";
  }, 8000);
  const failureBaseline = (await room()).snapshot;
  await until("local-failure-surfaced", async () =>
    (await evaluate(`document.body.innerText`)).split("\n").some((line) => youtubeMessages.some((message) => line.includes(message))), 20000);
  await sleep(1500);
  const failureAfter = (await room()).snapshot;
  assert.equal(failureAfter.revision, failureBaseline.revision, "local failure must not send room commands");
  assert.equal(failureAfter.paused, failureBaseline.paused, "local failure must not change shared playback");
  result.checks.push({ label: "single-client-failure-keeps-room", value: {
    revision: failureBaseline.revision, paused: failureBaseline.paused, messageShown: true } });

  // ---- 3. 裸 11 位 ID：内联行提交（不打断搜索） ----
  await ensureLibraryOpen();
  await setSearchInput("WO6aRHKe7_c");
  await until("bare-id-row", async () => (await evaluate(`Boolean(document.querySelector('[data-testid="youtube-id-row"]'))`)) === true, 5000);
  const revisionBeforeBare = (await room()).snapshot.revision;
  await evaluate(`document.querySelector('[data-testid="youtube-id-row"] button').click()`);
  await until("bare-id-source", async () => {
    const source = await sourceOf();
    return source?.kind === "youtube" && source.videoId === "WO6aRHKe7_c";
  }, 8000);
  assert.equal((await room()).snapshot.revision, revisionBeforeBare + 1, "bare id submits exactly one command");
  result.checks.push({ label: "bare-id-entry", value: { videoId: "WO6aRHKe7_c", revisionDelta: 1 } });

  // ---- 4. 不支持形态（shorts）：就地说明 + 无动作按钮 + 不发请求 ----
  await ensureLibraryOpen();
  await setSearchInput("https://www.youtube.com/shorts/WO6aRHKe7_c");
  await until("shorts-rejected", async () => (await evaluate(`document.body.innerText.includes('暂不支持 Shorts 链接')`)) === true, 5000);
  assert.equal(await evaluate(`document.body.innerText.includes('播放此链接')`), false, "no play action for unsupported shape");
  const revisionBeforeUnsupported = (await room()).snapshot.revision;
  await sleep(700);
  assert.equal((await room()).snapshot.revision, revisionBeforeUnsupported, "unsupported shape must not command the room");
  result.checks.push({ label: "unsupported-shape-rejected-locally", value: { axis: "shorts", revisionUnchanged: true } });

  // 交还房主 + 收尾（CMD 需要 fixture 持有房主）。
  await evaluate(`document.querySelector('[role="dialog"] button[aria-label="关闭媒体库"]')?.click()`);
  await sleep(300);
  await clickSelector('button[aria-label^="在线成员"]');
  await until("handback-modal-open", async () => (await evaluate(`document.body.innerText.includes('移交房主')`)) === true, 5000);
  await clickDialogButton("移交房主");
  await until("handback-confirm", async () => (await evaluate(`document.body.innerText.includes('确认移交')`)) === true, 5000);
  await clickDialogButton("确认移交");
  await until("ownership-returned", async () => (await room()).snapshot.ownerClientId === fixture.ownerId, 8000);
  await command("CMD:mediaSet");
  await until("fixture-restored", async () => (await room()).snapshot.source?.kind === "openlist", 8000);
  assert.deepEqual(await evaluate(`window.__ytRig.errors`), [], "no page errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  try { result.final = { body: await evaluate(`document.body.innerText.slice(0,600)`), errors: await evaluate(`globalThis.__ytRig?.errors`) }; } catch { /* page gone */ }
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  // 兜底交还房主 + 恢复 fixture 媒体。
  try {
    const owner = (await room()).snapshot.ownerClientId;
    const clientId = await evaluate(`localStorage.getItem('watchparty_client_id')`).catch(() => null);
    if (clientId && owner === clientId) {
      await evaluate(`document.querySelector('[role="dialog"] button[aria-label="关闭媒体库"]')?.click()`);
      await sleep(200);
      await clickSelector('button[aria-label^="在线成员"]');
      await sleep(300);
      await clickDialogButton("移交房主");
      await sleep(200);
      await clickDialogButton("确认移交");
      for (let attempt = 0; attempt < 20 && (await room()).snapshot.ownerClientId !== fixture.ownerId; attempt += 1) await sleep(200);
    }
    if ((await room()).snapshot.source?.kind !== "openlist") await command("CMD:mediaSet").catch(() => {});
  } catch { /* best-effort */ }
  await browser.close();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
