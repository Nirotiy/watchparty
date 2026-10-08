// Real Next room: signed-URL expiry and delayed media responses at 0.95x.
// Requires the large looped fixture so seeks escape the bounded read cache.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const backend = "http://127.0.0.1:18981";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const browser = await startChrome();
const result = { startedAt: new Date().toISOString(), checks: [], scope: "Next integration, local server response stall; not a global throughput limit" };
const output = process.argv[2] ?? "web/tests/results/mkv-chrome-fault.json";
const command = async (event, payload = {}) => {
  const ack = await (await fetch(`${backend}/__fixture/command`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, payload }) })).json();
  assert.equal(ack.ok, true);
};
const snapshot = () => browser.evaluate(`(()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');
  return {time:Number(c?.dataset.mediaTime??-1),phase:c?.dataset.playerPhase,audio:c?.dataset.audioState,
    rate:Number(c?.dataset.playbackRate??0),workers:__faultRig.workers,errors:__faultRig.errors,cues:__faultRig.cues,
    control:document.querySelector('button[aria-label="播放"],button[aria-label="暂停"]')?.getAttribute('aria-label')};})()`);
async function until(label, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await snapshot();
    assert.deepEqual(value.errors, []);
    if (predicate(value)) { result.checks.push({ label, elapsedMs: Date.now() - start, value }); console.log(`PASS: ${label}`); return value; }
    await sleep(100);
  }
  throw new Error(`${label}: ${JSON.stringify(await snapshot())}`);
}
try {
  await command("CMD:mediaSet");
  await browser.send("Page.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
    localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    localStorage.setItem('watchparty_client_id',crypto.randomUUID());
    globalThis.__faultRig={workers:[],errors:[],cues:[]};
    const W=Worker;globalThis.Worker=class extends W{constructor(...args){super(...args);const index=__faultRig.workers.push(false)-1;
      const stop=this.terminate.bind(this);this.terminate=()=>{__faultRig.workers[index]=true;stop();};}};
    const fill=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){__faultRig.cues.push({text,time:Number(this.canvas.dataset.mediaTime)});
      if(__faultRig.cues.length>8)__faultRig.cues.shift();return fill.call(this,text,...args);};
    addEventListener('error',event=>__faultRig.errors.push(event.message));
    addEventListener('unhandledrejection',event=>__faultRig.errors.push(String(event.reason)));
  })()` });
  await browser.send("Page.navigate", { url: `http://127.0.0.1:18982/room/${fixture.room.roomId}` });
  await until("initial-frame", (s) => s.time === 0);
  const box = await browser.evaluate("(()=>{const r=document.querySelector('button[aria-label=\"播放\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
  await until("trusted-gesture-audio", (s) => s.audio === "running" && s.time > 1);
  const tracks = await browser.evaluate(`(()=>{
    const canvas=document.querySelector('canvas[aria-label="MKV 视频"]');
    let fiber=canvas[Object.keys(canvas).find(key=>key.startsWith('__reactFiber$'))];
    while(fiber){if(fiber.ref?.current?.getEmbeddedTracks){globalThis.__faultHandle=fiber.ref.current;break;}fiber=fiber.return;}
    if(!globalThis.__faultHandle)throw Error('No MKV adapter handle');
    return __faultHandle.getEmbeddedTracks();
  })()`);
  assert.equal(tracks.items.filter((item) => item.kind === "audio").length, 2);
  assert.deepEqual(tracks.items.filter((item) => item.kind === "audio").map((item) => item.language), ["eng", "jpn"]);
  const trackRoom = await (await fetch(`${backend}/__fixture`)).json();
  const audio = tracks.items.filter((item) => item.kind === "audio")[1];
  const subtitle = tracks.items.filter((item) => item.kind === "subtitle")[1];
  await browser.evaluate(`__faultHandle.selectAudioTrack(${audio.id})`);
  await browser.evaluate(`__faultHandle.selectSubtitleTrack(${subtitle.id})`);
  await until("local-track-switch-keeps-playing", (s) => s.time > 2 && s.audio === "running" && s.control === "暂停");
  assert.equal(await browser.evaluate("__faultHandle.getEmbeddedTracks().audioId"), audio.id);
  assert.equal(await browser.evaluate("__faultHandle.getEmbeddedTracks().subtitleId"), subtitle.id);
  await browser.evaluate("__faultHandle.selectSubtitleTrack(null);__faultRig.cues=[]");
  await until("disabled-subtitles-still-play-video", (s) => s.time > 6.7);
  assert.deepEqual((await snapshot()).cues, []);
  await browser.evaluate(`__faultHandle.selectSubtitleTrack(${subtitle.id})`);
  await until("selected-subtitle-track-renders", (s) => s.cues.some((cue) => cue.time > 10), 10000);
  const afterTracks = await (await fetch(`${backend}/__fixture`)).json();
  assert.equal(afterTracks.snapshot.revision, trackRoom.snapshot.revision);
  result.tracks = { items: tracks.items, localSelectionPreservesRoomRevision: true };
  await command("CMD:rate", { rate: 0.95 });
  const before = await (await fetch(`${backend}/__fixture`)).json();
  await fetch(`${backend}/__fixture/expire`, { method: "POST" });
  await command("CMD:seek", { positionSeconds: 16000 });
  await until("expired-range-renews-and-resumes", (s) => s.time >= 16000 && s.time < 16015 && s.rate === 0.95);
  const renewed = await (await fetch(`${backend}/__fixture`)).json();
  assert.ok(renewed.metrics.expired > before.metrics.expired);
  assert.equal(renewed.metrics.resolveCalls - before.metrics.resolveCalls, 1);
  result.renewal = { rejectedRanges: renewed.metrics.expired - before.metrics.expired, renewals: 1 };
  await fetch(`${backend}/__fixture/stall`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ durationMs: 4000 }) });
  await command("CMD:seek", { positionSeconds: 8000 });
  await until("read-stall-is-local-buffering", (s) => s.phase === "buffering" && s.control === "暂停", 5000);
  const stalledRoom = await (await fetch(`${backend}/__fixture`)).json();
  assert.equal(stalledRoom.snapshot.paused, false);
  await until("stall-recovery-at-095", (s) => s.time >= 8003 && s.time < 8020 && s.phase === "playing" && s.audio === "running" && s.rate === 0.95);
  await until("subtitles-resume-after-stall", (s) => s.cues.some((cue) => cue.time > 8003), 10000);
  const after = await (await fetch(`${backend}/__fixture`)).json();
  assert.equal(after.snapshot.revision, stalledRoom.snapshot.revision, "buffer recovery must not mutate room state");
  assert.equal(after.metrics.fullRequests, 0);
  const state = await snapshot();
  assert.equal(state.workers.length, 1, "renewal retains the current decoder Worker");
  assert.equal(state.workers[0], false);
  const retryTime = state.time;
  const retryRevision = after.snapshot.revision;
  await browser.evaluate("__faultHandle.retry()");
  await until("same-media-retry-follows-current-room-time", (s) => s.workers.length === 2 && s.workers[0] === true && s.time >= retryTime && s.time < retryTime + 10 && s.phase === "playing");
  await browser.evaluate("__faultHandle.unlockAudio()");
  await until("retry-audio-unlocked", (s) => s.audio === "running");
  const retried = await (await fetch(`${backend}/__fixture`)).json();
  assert.equal(retried.snapshot.revision, retryRevision);
  result.pass = true;
} catch (error) { result.pass = false; result.error = error.message; process.exitCode = 1; }
finally {
  await command("CMD:pause");
  await browser.close();
  result.profileDeleted = true;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
