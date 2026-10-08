// Actual isolated production Next, real backend and MKV decode. Muted headless.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startChrome, sleep } from "./chrome-session.mjs";

const backend = process.env.WATCHPARTY_TEST_BACKEND ?? "http://127.0.0.1:18981";
const origin = process.env.WATCHPARTY_TEST_ORIGIN ?? "http://127.0.0.1:18982";
const output = process.argv[2] ?? "web/tests/results/next-preferences-2026-10-08.json";
const fixture = await (await fetch(`${backend}/__fixture`)).json();
const source = fixture.sources["tracks.mkv"];
await fetch(`${backend}/__fixture/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "mediaSet", media: source }) });
const browser = await startChrome(0, { headless: true, muteAudio: true });
const result = { startedAt: new Date().toISOString(), checks: [], scope: "Actual production Next, real loopback backend, real local MKV decode. Muted/headless, no physical audio." };
async function until(expression) { for (let i = 0; i < 150; i++) { if (await browser.evaluate(expression)) return; await sleep(100); } throw Error(`Timeout: ${expression}`); }
async function check(label, expression) { const pass = await browser.evaluate(expression); result.checks.push({ label, pass }); assert.equal(pass, true, label); console.log(`PASS: ${label}`); }
async function post(route, body) {
  return (await fetch(`${backend}/__fixture/${route}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) })).json();
}
const snapshot = async () => (await (await fetch(`${backend}/__fixture`)).json()).snapshot;
async function click(expression) {
  const point = await browser.evaluate(`(()=>{const b=${expression};if(!b)throw Error('Control missing');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for(const type of ["mouseMoved","mousePressed","mouseReleased"])await browser.send("Input.dispatchMouseEvent",{type,button:type==="mouseMoved"?"none":"left",clickCount:1,...point});
  await sleep(150);
}
async function escape() {
  await browser.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await browser.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
}
async function choose(kind, language) {
  await click(`document.querySelector('button[aria-label="${kind === "audio" ? "音轨" : "字幕"}"]')`);
  const track = await browser.evaluate(`__tracks().items.find(t=>t.kind===${JSON.stringify(kind)}&&t.language===${JSON.stringify(language)})`);
  await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(track.label)}))`);
  await escape();
  await until(`__tracks().${kind === "audio" ? "audioId" : "subtitleId"}===${track.id}`);
}
async function load(name) {
  const ack=await post("command",{type:"mediaSet",media:fixture.sources[name]});assert.equal(ack.ok,true);
  await until(`document.body.innerText.includes(${JSON.stringify(name)})&&__tracks()?.items.length>0&&document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.playerPhase==='paused'`);
  await sleep(500);
}
try {
  await browser.send("Page.enable");
  await browser.send("Runtime.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.setItem('watchparty_client_id',${JSON.stringify(fixture.ownerId)});
    localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    localStorage.setItem(${JSON.stringify(`owner_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.ownerToken)});
    if(!localStorage.getItem('watchparty.player-preferences.v1'))localStorage.setItem('watchparty.player-preferences.v1',JSON.stringify({volume:31,muted:true,audioLanguage:'ja',subtitleLanguage:'en',subtitlesOff:true}));
    if(!localStorage.getItem('watchparty.subtitle-offsets.v1'))localStorage.setItem('watchparty.subtitle-offsets.v1',JSON.stringify([{mediaKey:${JSON.stringify(`openlist:${source.mediaId}`)},seconds:.4}]));
    window.__tracks=()=>{const c=document.querySelector('canvas[aria-label="MKV 视频"]');let f=c?.[Object.keys(c??{}).find(k=>k.startsWith('__reactFiber$'))];while(f){if(f.ref?.current?.getEmbeddedTracks)return f.ref.current.getEmbeddedTracks();f=f.return;}return null;};
    window.__rig={workers:[],errors:[]};const W=Worker;window.Worker=class extends W{constructor(...args){super(...args);const i=__rig.workers.push(false)-1;const stop=this.terminate.bind(this);this.terminate=()=>{__rig.workers[i]=true;stop();};}};
    addEventListener('error',e=>__rig.errors.push(e.message));addEventListener('unhandledrejection',e=>__rig.errors.push(String(e.reason)));
  ` });
  await browser.send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until("typeof window.__tracks==='function' && window.__tracks()?.items.some(x=>x.kind==='audio'&&x.language==='jpn') && !!document.querySelector('button[aria-label=音轨]')");
  await check("next-language-restored-on-real-decoder", "__tracks().items.find(x=>x.id===__tracks().audioId).language==='jpn'");
  await check("next-global-subtitle-off-applied", "__tracks().subtitleId===null");
  await check("next-volume-mute-offset-visible", "!!document.querySelector('button[aria-label=取消静音]') && document.querySelector('[aria-label=音量] [role=slider]')?.getAttribute('aria-valuenow')==='0' && document.body.innerText.includes('+0.4s')");
  await browser.evaluate("document.querySelector('button[aria-label=字幕]').click()"); await sleep(100);
  await browser.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='+0.1s').click()"); await sleep(100);
  await check("next-offset-writes-current-media", `JSON.parse(localStorage.getItem('watchparty.subtitle-offsets.v1')).find(x=>x.mediaKey===${JSON.stringify(`openlist:${source.mediaId}`)}).seconds===.5`);
  await browser.send("Page.reload"); await until("typeof window.__tracks==='function' && window.__tracks()?.items.length>0 && document.body.innerText.includes('+0.5s')");
  await check("next-reload-preserves-language-and-off", "__tracks().items.find(x=>x.id===__tracks().audioId).language==='jpn' && __tracks().subtitleId===null");
  await escape();
  await load("external-vtt.mkv");
  await check("next-subtitle-off-persists-across-media-with-external", "__tracks().subtitleId===null&&!document.querySelector('track[src]')");
  await load("tracks.mkv");
  const revision=(await snapshot()).revision;
  await click("document.querySelector('button[aria-label=取消静音]')");
  await check("next-unmute-restores-saved-volume", "document.querySelector('[aria-label=音量] [role=slider]').getAttribute('aria-valuenow')==='31' && JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).muted===false");
  await click("document.querySelector('button[aria-label=静音]')");
  await choose("audio","eng");await choose("subtitle","jpn");
  await check("next-menu-manual-pick-does-not-rewrite-global-lists", "(()=>{const p=JSON.parse(localStorage.getItem('watchparty.player-preferences.v1'));return p.audioLanguages.length===1&&p.audioLanguages[0]==='ja'&&p.subtitleLanguages[0]==='en'&&!p.subtitlesOff;})()");
  assert.equal((await snapshot()).revision,revision,"Local menus must not mutate the room");
  const first=await browser.evaluate("__tracks()");
  await load("tracks-reordered.mkv");
  await check("next-cross-media-language-list-restored-with-different-ids", `__tracks().items.find(t=>t.id===__tracks().audioId).language==='jpn'&&__tracks().items.find(t=>t.id===__tracks().subtitleId).language==='eng'&&__tracks().audioId!==${first.audioId}&&__tracks().subtitleId!==${first.subtitleId}`);
  await check("next-offset-does-not-leak-to-other-media", "!document.body.innerText.includes('+0.5s')&&!!document.querySelector('button[aria-label=取消静音]')");
  await load("tracks.mkv");
  await check("next-original-media-offset-restored", "document.body.innerText.includes('+0.5s')");
  await choose("subtitle","eng");
  await load("external-vtt.mkv");await sleep(1000);
  await check("next-external-language-preference-restored", "!!document.querySelector('track[src]')");
  await browser.send("Page.reload");await until("typeof __tracks==='function'&&__tracks()?.items.length>0&&!!document.querySelector('track[src]')");
  await check("next-external-restored-after-refresh", "!!document.querySelector('track[src]')&&JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitleLanguages.includes('en')");
  await load("tracks-reordered.mkv");
  const beforeRetry=await snapshot();const workersBefore=await browser.evaluate("__rig.workers.length");
  await post("media-failure",{names:["tracks-reordered.mkv"]});
  assert.equal((await post("command",{type:"seek",positionSeconds:150.5})).ok,true);
  await until("document.body.innerText.includes('重试本机播放')");
  const retryRevision=(await snapshot()).revision;
  await post("media-failure",{names:[]});
  await click("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试本机播放'))");
  await until(`__rig.workers.length>${workersBefore}&&document.querySelector('canvas[aria-label="MKV 视频"]')?.dataset.playerPhase==='paused'&&Math.abs(Number(document.querySelector('canvas[aria-label="MKV 视频"]').dataset.mediaTime)-150.5)<.06`);
  await check("next-same-media-menu-retry-restores-frame-and-preferences", `__rig.workers.slice(0,${workersBefore}).every(Boolean)&&__tracks().items.find(t=>t.id===__tracks().audioId).language==='eng'&&__tracks().items.find(t=>t.id===__tracks().subtitleId).language==='eng'&&!!document.querySelector('button[aria-label=取消静音]')&&!document.body.innerText.includes('本机播放失败')`);
  const afterRetry=await snapshot();assert.equal(afterRetry.revision,retryRevision);assert.deepEqual(afterRetry.source,beforeRetry.source);
  result.retry={workersBefore,workersAfter:await browser.evaluate("__rig.workers.length"),revisionBefore:retryRevision,revisionAfter:afterRetry.revision,position:afterRetry.positionSeconds};
  await check("next-no-unhandled-errors", "__rig.errors.length===0");
  assert.equal(browser.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);
  result.pass = true;
} catch (error) { result.pass = false; result.error = String(error); throw error; }
finally { await post("media-failure",{names:[]}); await writeFile(output,JSON.stringify(result,null,2)); await browser.close(); }
