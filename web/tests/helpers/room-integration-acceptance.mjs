import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const browser = await startChrome(0, { headless: true, muteAudio: true });
const result = { startedAt: new Date().toISOString(), checks: [], scope: "Actual room/adapter/modal components. Explicit Socket/API/MKV lifecycle fixtures, real silent MP4/HLS, YouTube SDK fixture. No physical audio or real MKV decoding claim." };
const evaluate = (expression) => browser.evaluate(expression);
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(80); }
  throw Error(`condition timeout: ${expression}`);
}
async function check(label, expression) {
  const pass = await evaluate(expression);
  result.checks.push({ label, pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${label}`); assert.equal(pass, true, label);
}
async function click(label, aria = false) {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(${aria ? "b.getAttribute('aria-label')??''" : "b.textContent.trim()"}).includes(${JSON.stringify(label)}));if(!b)throw Error('missing button '+${JSON.stringify(label)});b.click();})()`);
  await sleep(100);
}
const media = (id) => `({kind:'openlist',mediaId:'${id}',title:'Media ${id}',container:'mkv'})`;
async function source(id) { await evaluate(`roomRig.setSource(${media(id)})`); await until(`roomRig.latest()?.embeddedTracks.items.length===4 && roomRig.snapshot.source.mediaId==='${id}'`); await sleep(180); }
async function openLibrary() { await click("点播媒体库", true); await until("!!document.querySelector('[role=dialog]')"); await click("文件"); await until("document.body.innerText.includes('添加当前文件夹全部剧集')"); }

try {
  await browser.send("Runtime.enable");
  await browser.send("Page.navigate", { url: "http://127.0.0.1:18985/room/fixture" });
  await until("window.roomRig?.latest()?.embeddedTracks.audioId===2");
  await check("initial-global-preferences-restore", "roomRig.latest().volume===31 && roomRig.latest().muted && roomRig.latest().embeddedTracks.subtitleId===null");
  await check("track-capabilities-connected", "roomRig.capabilities.at(-1).embeddedTracks && !!document.querySelector('button[aria-label=音轨]')");
  await click("字幕", true); await click("EN subtitle");
  await click("+0.1s"); await click("+0.1s");
  await check("subtitle-selection-and-offset-persist", "!JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitlesOff && roomRig.latest().offset===.2");
  await click("字幕关闭");
  await check("closing-subtitles-preserves-media-offset", "roomRig.latest().offset===.2 && JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitlesOff");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(100);
  await source("b");
  await check("new-media-matches-language-not-track-id", "roomRig.latest().embeddedTracks.audioId===102 && roomRig.latest().embeddedTracks.subtitleId===null && roomRig.latest().offset===0");
  await source("a");
  await check("returning-media-restores-offset", "roomRig.latest().offset===.2");
  await evaluate("roomRig.remount()"); await until("roomRig.latest().volume===31 && roomRig.latest().offset===.2");
  await check("remount-restores-persisted-preferences", "roomRig.latest().muted && roomRig.latest().embeddedTracks.audioId===2 && roomRig.latest().embeddedTracks.subtitleId===null");
  await click("音轨", true); await click("EN audio");
  await check("successful-audio-selection-writes-language", "JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).audioLanguage==='en'");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(100);
  await evaluate("roomRig.externalTracks=[{id:'ext-en',mediaId:'ext-en',label:'External EN',format:'srt',language:'eng'},{id:'ext-ja',mediaId:'ext-ja',label:'External JA',format:'srt',language:'jpn'}];roomRig.setSource({kind:'openlist',mediaId:'b',title:'Media b',container:'mkv'})");
  await sleep(300);
  await check("global-subtitle-off-skips-external-fetch", "roomRig.subtitleRequests.length===0");
  await click("字幕", true); await click("External JA");
  await check("external-selection-persists-language", "JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitleLanguage==='ja' && !JSON.parse(localStorage.getItem('watchparty.player-preferences.v1')).subtitlesOff");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(100);
  await source("a"); await until("roomRig.subtitleRequests.filter(x=>x==='ext-ja').length>=2");
  await check("new-media-restores-external-language", "roomRig.subtitleRequests.at(-1)==='ext-ja'");

  await openLibrary();
  await evaluate("roomRig.nextAdds=['success','failed','success']");
  await click("+ 添加当前文件夹全部剧集至播放清单");
  await check("batch-first-failure-results-visible", "document.body.innerText.includes('已成功 1 项') && document.body.innerText.includes('失败 1 项') && document.body.innerText.includes('未执行 1 项') && roomRig.snapshot.playlist.length===1");
  await click("重试未完成项");
  await check("batch-retry-does-not-repeat-success", "roomRig.snapshot.playlist.length===3 && roomRig.snapshot.playlist.filter(x=>x.media.mediaId==='a').length===1");
  await evaluate("roomRig.nextAdds=['timeoutCommitted']");
  await click("+ 添加当前文件夹全部剧集至播放清单");
  await check("unknown-result-blocks-retry-and-new-batch", "document.body.innerText.includes('结果未知 1 项') && ![...document.querySelectorAll('button')].some(b=>b.textContent.includes('重试未完成项')) && [...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加当前文件夹全部剧集')).disabled");
  await click("核对房间清单");
  await check("snapshot-diff-confirms-committed-timeout", "roomRig.refreshes===1 && document.body.innerText.includes('失败 0 项') && document.body.innerText.includes('未执行 2 项')");
  await click("重试未完成项");
  await check("confirmed-timeout-is-not-added-again", "roomRig.snapshot.playlist.length===6 && roomRig.snapshot.playlist.filter(x=>x.media.mediaId==='a').length===2");
  await evaluate("roomRig.nextAdds=['timeoutUncommitted']");
  await click("+ 添加当前文件夹全部剧集至播放清单"); await click("核对房间清单");
  await check("absence-remains-unknown", "document.body.innerText.includes('仍无法确认是否写入') && document.body.innerText.includes('结果未知 1 项') && roomRig.snapshot.playlist.length===6");
  await click("关闭", true); await openLibrary();
  await check("close-reopen-keeps-unknown-guard", "document.body.innerText.includes('结果未知 1 项') && [...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加当前文件夹全部剧集')).disabled");
  await click("关闭", true);

  await evaluate("roomRig.setSource({kind:'http',url:'/clip.mp4',title:'Native'})");
  await until("document.querySelector('video')?.readyState>=2");
  await check("native-capabilities-hide-embedded-audio", "roomRig.capabilities.at(-1).engine==='native' && !document.querySelector('button[aria-label=音轨]') && document.querySelector('video').muted");
  await evaluate("roomRig.snapshot.paused=false;roomRig.snapshot.revision++;roomRig.publish()");
  await until("roomRig.states.at(-1).phase==='playing'");
  await evaluate("document.querySelector('video').dispatchEvent(new Event('waiting'))");
  await sleep(80);
  await check("native-buffering-state-visible", "document.body.innerText.includes('缓冲中')");
  await evaluate("roomRig.snapshot.paused=true;roomRig.snapshot.revision++;roomRig.publish()"); await sleep(100);
  await evaluate("Object.defineProperty(document.querySelector('video'),'error',{configurable:true,value:{code:3,message:'Fixture decode error'}});document.querySelector('video').dispatchEvent(new Event('error'))");
  await sleep(80);
  await check("native-local-error-retry-panel", "document.body.innerText.includes('本机播放失败') && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('重试本机播放')&&!b.disabled)");
  await click("重试本机播放"); await until("!document.body.innerText.includes('本机播放失败') && document.querySelector('video')?.readyState>=2");
  await check("native-retry-preserves-paused-muted-controls", "document.querySelector('video').paused && document.querySelector('video').muted && Math.abs(document.querySelector('video').volume-.31)<.001");
  await evaluate("roomRig.setSource({kind:'hls',url:'/clip.m3u8',title:'HLS'})");
  await until("document.querySelector('video')?.readyState>=2 && roomRig.capabilities.at(-1).engine==='hls'");
  await check("hls-capabilities-and-local-pause", "!document.querySelector('button[aria-label=音轨]') && document.querySelector('video').paused && roomRig.capabilities.at(-1).bufferedAhead");

  await evaluate(`window.__yt=[];window.YT={Player:class {
    constructor(el,o){this.o=o;this.plays=0;this.muted=false;__yt.push(this);setTimeout(()=>o.events.onReady({target:this}),0)}
    getCurrentTime(){return 0}getDuration(){return 12}getVideoLoadedFraction(){return .8}
    setVolume(v){this.volume=v}setPlaybackRate(){}seekTo(){}mute(){this.muted=true}unMute(){this.muted=false}
    playVideo(){this.plays++;this.o.events.onStateChange({target:this,data:1})}pauseVideo(){this.o.events.onStateChange({target:this,data:2})}destroy(){}
  }};roomRig.setSource({kind:'youtube',videoId:'fixture',title:'YouTube fixture'})`);
  await until("window.__yt.length===1 && roomRig.states.at(-1).phase==='paused'");
  await check("youtube-no-fabricated-buffer-or-track-capabilities", "!roomRig.capabilities.at(-1).bufferedAhead && !document.querySelector('button[aria-label=音轨]') && __yt[0].muted");
  await evaluate("__yt[0].o.events.onStateChange({target:__yt[0],data:3})");
  await sleep(80);
  await check("youtube-buffering-without-playable-seconds", "document.body.innerText.includes('缓冲中') && !document.body.innerText.includes('可播 ')");
  await evaluate("__yt[0].o.events.onError()");
  await sleep(80);
  await click("重试本机播放"); await until("__yt.length===2 && !document.body.innerText.includes('本机播放失败')");
  await check("youtube-retry-remains-paused-muted", "__yt[1].plays===0 && __yt[1].muted");

  await click("在线成员", true);
  await click("移交房主"); await evaluate("roomRig.transfers=[{ok:false,error:{code:'FORBIDDEN',message:'Transfer rejected'}}]"); await click("确认移交");
  await check("ownership-real-ack-failure-visible-in-modal", "document.body.innerText.includes('Transfer rejected') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='确认移交'&&!b.disabled)");
  await click("确认移交");
  await check("ownership-success-closes-modal", "!document.querySelector('[role=dialog]') && roomRig.snapshot.ownerClientId==='target'");
  const exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  result.pass = true;
} catch (error) { result.error = String(error); result.exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown"); throw error; }
finally {
  const output = process.argv[2] ?? "web/tests/results/room-integration-2026-10-08.json";
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2)); await browser.close();
}
