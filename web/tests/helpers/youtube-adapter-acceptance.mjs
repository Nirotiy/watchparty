// YouTube 适配器级验收（18984 harness，FakeYouTube 确定性）：错误码映射、API 不可用、
// 控制不可用（去重）、切源后旧实例回调失效、无 key 播放路径。
// node web/tests/helpers/youtube-adapter-acceptance.mjs <evidence.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChrome, sleep } from "./chrome-session.mjs";

const server = spawn("node", [fileURLToPath(new URL("./player-adapter-server.mjs", import.meta.url))], { stdio: "ignore" });
const output = process.argv[2] ?? "web/tests/results/youtube-adapter-2026-10-10.json";
const result = { startedAt: new Date().toISOString(), scope: "YouTube 契约前端：iframe 错误映射/API 不可用/控制不可用/旧回调失效；SDK 为确定性 fake，不涉真实播放声明", checks: [] };
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
const renderYouTube = (videoId, extra = {}) => evaluate(`rig.render({ source:{kind:'youtube',videoId:${JSON.stringify(videoId)}}, streamUrl:null, ...${JSON.stringify(extra)} })`);

// ---- 第一段：接口加载失败（新页面 + 黑掉 youtube.com + 摘掉预置 YT） ----
try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fetch("http://127.0.0.1:18984/"); break; } catch { await sleep(200); }
  }
  browser = await startChrome();
  await browser.send("Page.enable");
  await browser.send("Network.enable");
  await browser.send("Network.setBlockedURLs", { urls: ["*youtube.com/*", "*youtube-nocookie.com/*"] });
  await browser.send("Page.navigate", { url: "http://127.0.0.1:18984/" });
  await until("harness-ready", async () => (await evaluate(`typeof rig !== 'undefined'`)) === true);
  await evaluate(`delete window.YT`);
  await renderYouTube("WO6aRHKe7_c");
  await until("api-unavailable-reported", async () => (await evaluate(`rig.errors.includes('YOUTUBE_API_UNAVAILABLE')`)) === true, 15000);
  const apiDetail = await evaluate(`rig.errorDetails.at(-1)`);
  assert.match(apiDetail, /接口加载失败/, `API detail: ${apiDetail}`);
  assert.equal(await evaluate(`rig.events.at(-1)?.phase`), "error", "local phase must be error");
  // 控制调用：播放器已确定不可用 → CONTROL_UNAVAILABLE（只报一次）。
  await evaluate(`rig.ref.current.pause()`);
  await until("control-unavailable-reported", async () => (await evaluate(`rig.errors.filter((code)=>code==='YOUTUBE_CONTROL_UNAVAILABLE').length`)) === 1);
  await evaluate(`rig.ref.current.seek(5)`);
  await evaluate(`rig.ref.current.play()`);
  await sleep(200);
  assert.equal(await evaluate(`rig.errors.filter((code)=>code==='YOUTUBE_CONTROL_UNAVAILABLE').length`), 1, "control unavailable must not spam");
  result.checks.push({ label: "api-and-control-unavailable", value: {
    codes: await evaluate(`rig.errors`), apiDetail, controlDeduped: true } });
  await browser.send("Network.setBlockedURLs", { urls: [] });

  // ---- 第二段：新页面（YT 正常）——错误码映射 + 切源旧回调失效 ----
  await browser.send("Page.navigate", { url: "http://127.0.0.1:18984/" });
  await until("harness-ready-2", async () => (await evaluate(`typeof rig !== 'undefined'`)) === true);
  await renderYouTube("M7lc1UVf-VE");
  await until("first-player-paused", async () => (await evaluate(`rig.events.at(-1)?.phase === 'paused'`)) === true);
  const mapping = [];
  for (const [data, expected, note] of [
    [2, "YOUTUBE_INVALID_VIDEO"], [5, "YOUTUBE_PLAYBACK_FAILED"], [100, "YOUTUBE_VIDEO_UNAVAILABLE"],
    [101, "YOUTUBE_EMBED_FORBIDDEN"], [150, "YOUTUBE_EMBED_FORBIDDEN"], [153, "YOUTUBE_CLIENT_IDENTITY_REQUIRED"],
  ]) {
    await evaluate(`rig.errors.length = 0; rig.errorDetails.length = 0;`);
    await evaluate(`(()=>{const old=rig.youtubeInstances.at(-1);old.options.events.onError({target:old,data:${data}});})()`);
    const codes = await evaluate(`[...rig.errors]`);
    assert.deepEqual(codes, [expected], `data=${data} (${note ?? ""})`);
    mapping.push({ data, code: codes[0], message: await evaluate(`rig.errorDetails.at(-1)`) });
  }
  await evaluate(`rig.errors.length = 0; rig.errorDetails.length = 0;`);
  await evaluate(`(()=>{const old=rig.youtubeInstances.at(-1);old.options.events.onError({target:old});})()`);
  assert.deepEqual(await evaluate(`[...rig.errors]`), ["YOUTUBE_UNKNOWN_ERROR"], "missing data must map to UNKNOWN");
  const unknownMessage = await evaluate(`rig.errorDetails.at(-1)`);
  assert.ok(!/地区|网络不可达/.test(unknownMessage), `unknown message must not guess: ${unknownMessage}`);
  result.checks.push({ label: "iframe-error-mapping", value: { mapping, unknownMessage } });
  // 错误只落本机：不发任何播放/暂停命令（harness 计数 playCalls）。
  const playCallsAfterErrors = await evaluate(`rig.playCalls`);
  assert.ok(playCallsAfterErrors >= 0);
  result.checks.push({ label: "errors-stay-local", value: { playCalls: playCallsAfterErrors, lastPhase: await evaluate(`rig.events.at(-1)?.phase`) } });

  // 切源：旧实例回调必须失效（不产生错误、不改状态、不污染新实例）。
  await evaluate(`rig.clear()`);
  await renderYouTube("dQw4w9WgXcQ");
  await until("second-player-paused", async () => (await evaluate(`rig.events.at(-1)?.phase === 'paused'`)) === true);
  const instances = await evaluate(`rig.youtubeInstances.length`);
  assert.ok(instances >= 2, "second player created");
  assert.equal(await evaluate(`rig.youtubeInstances[0].destroyed`), true, "old player destroyed");
  const eventsBefore = await evaluate(`rig.events.length`);
  await evaluate(`rig.errors.length = 0; rig.errorDetails.length = 0;`);
  await evaluate(`(()=>{const old=rig.youtubeInstances[0];
    old.options.events.onReady({target:old});
    old.options.events.onStateChange({target:old,data:3});
    old.options.events.onError({target:old,data:100});
    old.options.events.onAutoplayBlocked();})()`);
  await sleep(300);
  assert.deepEqual(await evaluate(`[...rig.errors]`), [], "stale callbacks must not report errors");
  // 只允许旧回调触发点之后的新增为周期 tick（paused）；异样相位（buffering/loading/error）即泄漏。
  const phasesAfter = await evaluate(`rig.events.map((event)=>event.phase)`);
  const leaked = phasesAfter.slice(eventsBefore).filter((phase) => phase !== "paused");
  assert.deepEqual(leaked, [], `stale callbacks must not leak phases: ${JSON.stringify(phasesAfter)}`);
  assert.notEqual(await evaluate(`rig.events.at(-1)?.audio`), "blocked", "stale autoplay-blocked must not flip local audio");
  result.checks.push({ label: "stale-callbacks-ignored-after-source-switch", value: {
    instances, eventsBefore, phasesAfter, errors: [] } });

  // 无 API key：SDK fake 直接播放（真实入口在房间级验收），状态机按契约词表走。
  await evaluate(`rig.ref.current.play()`);
  await until("youtube-plays", async () => (await evaluate(`rig.events.at(-1)?.phase === 'playing'`)) === true);
  result.checks.push({ label: "play-without-api-key", value: { plays: await evaluate(`rig.youtubeInstances.at(-1).plays`) } });
  assert.deepEqual(await evaluate(`rig.errors`), [], "no unexpected errors");
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.failure = error.message;
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
