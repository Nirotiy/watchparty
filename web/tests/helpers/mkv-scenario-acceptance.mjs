// Real Next room callbacks/Socket.IO, presented pixels, actual audio spectrum and network failures.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const base = process.env.WATCHPARTY_TEST_BACKEND ?? "http://127.0.0.1:18981";
const origin = process.env.WATCHPARTY_TEST_ORIGIN ?? "http://127.0.0.1:18982";
const caseName = process.argv[2] ?? "playback";
const output = process.argv[3] ?? `web/tests/results/mkv-next-${caseName}.json`;
const fixture = await (await fetch(`${base}/__fixture`)).json();
const clients = [], evidence = { startedAt: new Date().toISOString(), case: caseName, checks: [],
  scope: "Isolated production Next, actual menu clicks, real local synthetic MKV, muted headless Chrome; spectrum is before physical output, sync is presented-frame PTS." };
async function post(route, body) {
  return (await fetch(`${base}/__fixture/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
}
async function command(type, payload = {}) { const ack = await post("command", { type, ...payload }); assert.equal(ack.ok, true, JSON.stringify(ack)); }
const room = async () => (await (await fetch(`${base}/__fixture`)).json()).snapshot;
const source = (name) => fixture.sources[name];
const getState = (client) => client.evaluate(`(()=>{
  const canvas=document.querySelector('canvas[aria-label="MKV 视频"]'),rig=__scenario;
  let peakHz=0,peakDb=-200;
  for(const analyser of rig.analysers){if(analyser.context.state!=='running')continue;
    const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);
    let index=0;for(let i=1;i<bins.length;i++)if(bins[i]>bins[index])index=i;
    if(bins[index]>peakDb){peakDb=bins[index];peakHz=index*analyser.context.sampleRate/analyser.fftSize;}}
  return {epoch:performance.timeOrigin+performance.now(),time:Number(canvas?.dataset.mediaTime??-1),rate:Number(canvas?.dataset.playbackRate??0),
    phase:canvas?.dataset.playerPhase,audio:canvas?.dataset.audioState,width:canvas?.width,
    cues:rig.cues,errors:rig.errors,commands:rig.commands,snapshots:rig.snapshots,workers:rig.workers,audioContexts:rig.audio.map(x=>x.state),
    connected:document.body.innerText.includes('已连接'),text:document.body.innerText.slice(0,700),peakHz,peakDb};
})()`);
async function until(client, label, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await getState(client);
    assert.deepEqual(state.errors, [], label);
    if (await predicate(state)) { evidence.checks.push({ label, elapsedMs: Date.now() - start, state }); console.log(`PASS: ${label}`); return state; }
    await sleep(100);
  }
  throw Error(`${label}: ${JSON.stringify(await getState(client))}`);
}
async function refs(client) {
  return client.evaluate(`(()=>{
    const canvas=document.querySelector('canvas[aria-label="MKV 视频"]');
    if(!canvas)throw Error('No MKV canvas');
    let fiber=canvas[Object.keys(canvas).find(key=>key.startsWith('__reactFiber$'))],root;
    while(fiber){
      if(fiber.ref?.current?.getEmbeddedTracks)globalThis.__player=fiber.ref.current;
      for(let hook=fiber.memoizedState;hook;hook=hook.next){const value=hook.memoizedState;
        if(value?.current?.getClockOffset)globalThis.__room=value.current;
        if(value?.current?.manualRender)globalThis.__renderer=value.current;
        if(Array.isArray(value)&&typeof value[0]==='function'&&value[0].toString().includes('REVISION_SYNC_TIMEOUT'))globalThis.__runCommand=value[0];}
      if(fiber.memoizedProps?.roomId&&fiber.memoizedProps?.accessToken)root=fiber;
      fiber=fiber.return;
    }
    const visit=(f)=>{if(!f)return;if(f.memoizedProps?.onBatchAdd&&f.memoizedProps?.onPlayNow)globalThis.__actions=f.memoizedProps;
      for(let child=f.child;child;child=child.sibling)visit(child);};visit(root);
    if(!__room||!__player||!__runCommand||!__actions)throw Error('Room test callbacks unavailable');
    const socket=__room.socket;
    if(!socket.__observed){socket.__observed=true;const emit=socket.emit.bind(socket);
      socket.emit=(event,payload,ack)=>{if(!event.startsWith('CMD:')||event==='CMD:clockSync')return emit(event,payload,ack);
        return emit(event,payload,(value)=>{__scenario.commands.push({event,revision:payload.expectedRevision,ok:value.ok,
          error:value.error?.code,media:payload.media?.title,item:payload.expectedCurrentPlaylistItemId});if(__scenario.commands.length>100)__scenario.commands.shift();ack?.(value);});};
      socket.on('REC:snapshot',s=>{__scenario.snapshots.push({revision:s.revision,source:s.source?.title,item:s.currentPlaylistItemId,
        paused:s.paused,position:s.positionSeconds});if(__scenario.snapshots.length>100)__scenario.snapshots.shift();});}
    return {tracks:__player.getEmbeddedTracks(),renderer:Boolean(globalThis.__renderer)};
  })()`);
}
async function start(owner, left) {
  const client = await startChrome(left, { headless: true, muteAudio: true }); clients.push(client);
  client.clientId = owner ? fixture.ownerId : randomUUID();
  await client.send("Page.enable"); await client.send("Network.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
    localStorage.setItem('watchparty_client_id',${JSON.stringify(client.clientId)});
    localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    ${owner ? `localStorage.setItem(${JSON.stringify(`owner_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.ownerToken)});` : ""}
    globalThis.__scenario={cues:[],commands:[],snapshots:[],errors:[],audio:[],analysers:[],workers:[]};
    const Audio=AudioContext,W=Worker,connect=AudioNode.prototype.connect,fill=CanvasRenderingContext2D.prototype.fillText;
    globalThis.AudioContext=class extends Audio{constructor(...args){super(...args);__scenario.audio.push(this);}};
    AudioNode.prototype.connect=function(destination,...args){if(this instanceof GainNode&&destination instanceof AudioDestinationNode){
      const analyser=this.context.createAnalyser();analyser.fftSize=32768;__scenario.analysers.push(analyser);
      connect.call(this,analyser);return connect.call(analyser,destination,...args);}return connect.call(this,destination,...args);};
    globalThis.Worker=class extends W{constructor(...args){super(...args);const id=__scenario.workers.push(false)-1;
      const stop=this.terminate.bind(this);this.terminate=()=>{__scenario.workers[id]=true;stop();};}};
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){__scenario.cues.push({text,time:Number(this.canvas.dataset.mediaTime)});
      if(__scenario.cues.length>8)__scenario.cues.shift();return fill.call(this,text,...args);};
    addEventListener('error',e=>__scenario.errors.push(e.message));addEventListener('unhandledrejection',e=>__scenario.errors.push(String(e.reason)));
  })()` });
  await client.send("Page.navigate", { url: `${origin}/room/${fixture.room.roomId}` });
  await until(client, "initial-frame", (s) => s.time >= 0 && s.connected);
  await refs(client);
  return client;
}
async function click(client, selector) {
  const box = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box }); await sleep(100);
  for (const type of ["mousePressed", "mouseReleased"]) await client.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...box });
}
async function clickText(client, text) {
  const box = await client.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));
    if(!b)throw Error('Menu row missing: '+${JSON.stringify(text)});
    const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  for (const type of ["mousePressed", "mouseReleased"]) await client.send("Input.dispatchMouseEvent", { type, button:"left", clickCount:1, ...box });
  await sleep(100);
}
async function escapeMenu(client) {
  await client.send("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
  await client.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
  await client.evaluate("document.activeElement instanceof HTMLElement&&document.activeElement.blur()");
  await client.send("Input.dispatchMouseEvent", {type:"mouseMoved",x:640,y:250});
  await sleep(400);
}
async function selectMenuTrack(client, kind, track) {
  await click(client, kind === "audio" ? 'button[aria-label="音轨"]' : 'button[aria-label="字幕"]');
  await clickText(client, track.label);
  await escapeMenu(client);
  const selected = (await refs(client)).tracks;
  assert.equal(kind === "audio" ? selected.audioId : selected.subtitleId, track.id);
}
async function load(client, name, position = 0, playing = false) {
  await command("mediaSet", { media: source(name) });
  if (position) await command("seek", { positionSeconds: position });
  if (playing) await command("play");
  await until(client, `load-${name}`, (s) => s.width > 0 && Math.abs(s.time - position) < (playing ? 3 : 0.06) && s.phase !== "error");
  await refs(client);
}
async function paired(label, seconds = 4) {
  const samples = [], start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    const [a, b] = await Promise.all(clients.map(getState));
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
    const epoch = Math.max(a.epoch, b.epoch);
    const gapMs = Math.abs(a.time + (epoch-a.epoch)/1000*a.rate - b.time - (epoch-b.epoch)/1000*b.rate)*1000;
    samples.push({ gapMs, a: { time:a.time,peakHz:a.peakHz,audio:a.audio,rate:a.rate,cues:a.cues },
      b: { time:b.time,peakHz:b.peakHz,audio:b.audio,rate:b.rate,cues:b.cues } }); await sleep(100);
  }
  const sorted=samples.map(s=>s.gapMs).sort((a,b)=>a-b);
  const summary={label,p95Ms:sorted[Math.ceil(sorted.length*0.95)-1],maxMs:sorted.at(-1),samples};
  evidence.checks.push(summary);console.log(`PAIR: ${label} P95=${summary.p95Ms.toFixed(1)} max=${summary.maxMs.toFixed(1)}`);
  assert.ok(summary.p95Ms<=100&&summary.maxMs<=250,label);
  for(const key of ["a","b"])assert.ok(samples.at(-1)[key].time-samples[0][key].time>seconds*.8,`${label} advances`);
  return summary;
}
async function subtitlePixels(client) {
  const clip=await client.evaluate(`(()=>{const r=document.querySelector('canvas[aria-label="MKV 视频"]').getBoundingClientRect();
    return{x:r.x,y:r.y+r.height*.67,width:r.width,height:r.height*.33,scale:1};})()`);
  const capture=async()=>{
    const { data }=await client.send("Page.captureScreenshot",{format:"png",clip,fromSurface:true});
    return new Promise((resolve,reject)=>{
    const proc=spawn("ffmpeg",["-hide_banner","-loglevel","error","-f","image2pipe","-i","pipe:0","-f","rawvideo","-pix_fmt","rgba","pipe:1"],{stdio:["pipe","pipe","pipe"]});
    const chunks=[];proc.stdout.on("data",chunk=>chunks.push(chunk));proc.once("error",reject);
    proc.once("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(`Screenshot decode ${code}`)));proc.stdin.end(Buffer.from(data,"base64"));
    });
  };
  const bytes=await capture();
  let background;
  try{
    await client.evaluate("document.querySelector('canvas[aria-label=\"MKV 视频\"]').parentElement.querySelector('div').style.visibility='hidden'");
    background=await capture();
  }finally{await client.evaluate("document.querySelector('canvas[aria-label=\"MKV 视频\"]').parentElement.querySelector('div').style.visibility=''");}
  let white=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]>230&&bytes[i+1]>230&&bytes[i+2]>230)white++;
  let overlay=0;for(let i=0;i<bytes.length;i+=4)if(Math.abs(bytes[i]-background[i])+Math.abs(bytes[i+1]-background[i+1])+Math.abs(bytes[i+2]-background[i+2])>20)overlay++;
  return{hash:createHash("sha256").update(bytes).digest("hex"),whitePixels:white,overlayPixels:overlay,bytes:bytes.length};
}
const cases = {
  async playback() {
    await command("mediaSet", { media:source("tracks.mkv") });
    const a=await start(true,0),b=await start(false,1280);
    const requests=await a.evaluate("Promise.all([10,20,30,40,50].map(position=>__runCommand((socket,revision)=>socket.seek(position,revision))))");
    evidence.concurrent=requests;
    assert.ok(requests.every(ack=>ack.ok),"every queued user seek should settle successfully");
    assert.equal((await room()).positionSeconds,50,"last user seek wins");
    for(const client of clients)await until(client,"concurrent-seek-final-frame",s=>Math.abs(s.time-50)<.06);
    const mixed=await a.evaluate(`Promise.all([
      __runCommand((s,r)=>s.seek(12,r)),__runCommand((s,r)=>s.rate(.95,r)),
      __runCommand((s,r)=>s.play(r)),__runCommand((s,r)=>s.pause(r)),__runCommand((s,r)=>s.seek(22,r))])`);
    evidence.mixedCommands=mixed;assert.ok(mixed.every(ack=>ack.ok));
    const mixedState=await room();assert.equal(mixedState.paused,true);assert.equal(mixedState.positionSeconds,22);assert.equal(mixedState.playbackRate,.95);
    const previousCount=mixedState.playlist.length;
    const added=await a.evaluate(`Promise.all([__actions.onBatchAdd(${JSON.stringify([source("short-a.mkv"),source("short-b.mkv"),source("tracks.mkv")])}),
      __actions.onAddToQueue(${JSON.stringify(source("short-a.mkv"))}),__actions.onAddToQueue(${JSON.stringify(source("short-b.mkv"))})])`);
    assert.ok(added.every(Boolean));assert.equal((await room()).playlist.length,previousCount+5);evidence.concurrentBatch=added;
    await post("resolve-delay",{"short-a.mkv":800,"tracks.mkv":500,"short-b.mkv":50});
    const switchNames=["short-a.mkv","short-b.mkv","tracks.mkv","short-a.mkv","short-b.mkv"];
    const switches=await a.evaluate(`Promise.all(${JSON.stringify(switchNames.map(source))}.map(media=>__actions.onPlayNow(media)))`);
    evidence.switches=switches;assert.ok(switches.every(Boolean),"rapid source switches all Ack");
    assert.equal((await room()).source.title,"short-b.mkv");
    for(const client of clients)await until(client,"latest-source-wins-and-old-workers-close",s=>s.width===480&&s.workers.filter(stopped=>!stopped).length===1);
    await sleep(1100);
    for(const client of clients)await until(client,"late-old-resolve-cannot-replace-latest-source",s=>s.width===480&&s.workers.filter(stopped=>!stopped).length===1);
    await post("resolve-delay",{});
    await load(a,"tracks.mkv",15,true);
    for(const client of clients){await until(client,"playing-before-network-loss",s=>s.time>15&&s.phase==="playing");await refs(client);}
    for(const client of clients){await click(client,'button[aria-label="静音"]');await click(client,'button[aria-label="取消静音"]');
      await until(client,"trusted-audio-before-network-loss",s=>s.audio==="running"&&Math.abs(s.peakHz-440)<8);}
    await b.send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    const dropped=await post("drop",{clientId:b.clientId});
    // Chrome offline may have already closed the transport before the fixture arrives.
    assert.ok(dropped.closed===0||dropped.closed===1);evidence.networkDrop=dropped;
    await until(b,"actual-socket-disconnected",s=>!s.connected);
    await command("seek",{positionSeconds:45});await command("rate",{rate:.95});await sleep(2500);
    await b.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await until(b,"network-reconnect-applies-newest-room-state",s=>s.connected&&s.time>45&&s.rate===.95&&s.audio==="running"&&Math.abs(s.peakHz-418)<8,20000);
    await sleep(800);await paired("reconnected-sync",4);
    for(const item of (await room()).playlist)await command("playlistRemove",{itemId:item.id});
    for(const name of ["short-a.mkv","short-b.mkv"])await command("playlistAdd",{media:source(name)});
    let state=await room();const[first,second]=state.playlist;
    await command("playlistPlay",{itemId:first.id});await command("loop",{loop:false});await command("play");
    for(const client of clients)await until(client,"short-first-playing",s=>s.width===320&&s.time>1);
    for(const client of clients)await client.evaluate("__scenario.commands=[]");
    await until(a,"ended-selects-next-once",async s=>(await room()).currentPlaylistItemId===second.id&&s.width===480&&s.time===0,12000);
    assert.equal((await room()).paused,true,"current server contract selects next paused");
    await until(b,"guest-follows-auto-next-without-forbidden-command",s=>s.width===480&&s.time===0);
    const autoLogs=await Promise.all(clients.map(getState));
    evidence.autoNextCommands=autoLogs.map(s=>s.commands);
    assert.ok(autoLogs.every(s=>s.commands.every(ack=>ack.ok)),"guests must not issue owner-only automatic advancement");
    await command("play");
    for(const client of clients)await until(client,"last-item-ended-without-wrap",s=>s.width===480&&s.phase==="ended",10000);
    assert.equal((await room()).currentPlaylistItemId,second.id);
    await command("loop",{loop:true});await command("seek",{positionSeconds:4});await command("play");
    for(const client of clients)await until(client,"loop-wraps-to-first-once",s=>s.width===320&&s.time===0,10000);
    assert.equal((await room()).currentPlaylistItemId,first.id);assert.equal((await room()).loop,true);
  },
  async subtitles() {
    await command("mediaSet",{media:source("tracks.mkv")});const a=await start(true,0);
    for(const position of [20.5,30.5,10.5]){
      await command("seek",{positionSeconds:position});
      const expected=`EN M${String(Math.floor(position/5)).padStart(2,"0")}`;
      await until(a,`paused-seek-subtitle-${position}`,s=>Math.abs(s.time-position)<.06&&s.cues.some(c=>c.text===expected&&Math.abs(c.time-position)<.06));
    }
    const comparisons={};
    for(const name of ["ass-font.mkv","ass-fallback.mkv"]){
      await load(a,name,20.5);await sleep(800);await refs(a);
      const revision=(await room()).revision;
      await click(a,'button[aria-label="字幕"]');await clickText(a,"字幕关闭");await escapeMenu(a);
      assert.equal((await refs(a)).tracks.subtitleId,null);
      assert.equal((await subtitlePixels(a)).overlayPixels,0,"ASS off clears overlay");
      await selectMenuTrack(a,"subtitle",(await refs(a)).tracks.items.find(t=>t.kind==="subtitle"));
      await sleep(800);await refs(a);assert.equal((await room()).revision,revision);
      const details=await a.evaluate("Promise.all([__renderer.renderer.getEvents(),__renderer.renderer.getStyles()])");
      assert.ok(details[0].some(event=>event.Text?.includes('ASS M04')||event.text?.includes('ASS M04')),"ASS seek restores target event");
      comparisons[name]={events:details[0],styles:details[1],pixels:await subtitlePixels(a)};
      assert.ok(comparisons[name].pixels.overlayPixels>100,"ASS draws actual subtitle overlay pixels");
      evidence.checks.push({label:`menu-ASS-off-on-${name}`,revision,offOverlayPixels:0,onOverlayPixels:comparisons[name].pixels.overlayPixels});
    }
    evidence.assFontComparison=comparisons;
    assert.notEqual(comparisons["ass-font.mkv"].pixels.hash,comparisons["ass-fallback.mkv"].pixels.hash,"attachment font changes glyph raster versus fallback");
    evidence.checks.push({label:"menu-attachment-font-versus-fallback-raster",pass:true});
    await command("seek",{positionSeconds:30.5});await sleep(800);await refs(a);
    const pausedEvents=await a.evaluate("__renderer.renderer.getEvents()");
    assert.ok(pausedEvents.some(event=>event.Start===30000&&event.Text.includes('ASS M06')));
    const assBefore=await subtitlePixels(a);
    await command("seek",{positionSeconds:34.5});await sleep(800);
    const assExpired=await subtitlePixels(a);
    assert.ok(assBefore.overlayPixels>100&&assExpired.overlayPixels===0,"paused ASS cue clears outside its interval");
    evidence.pausedAss={before:assBefore,expired:assExpired,events:pausedEvents};
    evidence.checks.push({label:"paused-ASS-seek-preview-and-expiry",pass:true});
    for(const [name,expected] of [["external-vtt.mkv","VTT M06"],["external-ass.mkv","EXTERNAL ASS M06"]]){
      await post("resolve-delay",{"external-vtt.en.vtt":1800,"external-ass.en.ass":1800});
      await load(a,name,30.5);await sleep(1000);await refs(a);
      const revision=(await room()).revision;
      const embedded=(await refs(a)).tracks.items.find(t=>t.kind==="subtitle");
      await a.evaluate("__scenario.cues=[]");
      await selectMenuTrack(a,"subtitle",embedded);await sleep(800);await refs(a);
      if(name.includes("vtt"))await until(a,"menu-embedded-SRT-replaces-external-VTT",s=>s.cues.some(c=>c.text==="EN M06"&&Math.abs(c.time-30.5)<.06));
      else assert.ok((await a.evaluate("__renderer.renderer.getEvents()")).some(e=>String(e.Text??e.text).startsWith("ASS M06")));
      await a.evaluate("__scenario.cues=[]");
      await click(a,'button[aria-label="字幕"]');await clickText(a,name.includes("vtt")?"en.vtt":"en.ass");await escapeMenu(a);
      await sleep(2400);await refs(a);assert.equal((await room()).revision,revision);
      if(name.includes("vtt"))await until(a,"external-vtt-paused-target-cue",s=>s.cues.some(c=>c.text===expected&&Math.abs(c.time-30.5)<.06));
      else{
        const events=await a.evaluate("__renderer.renderer.getEvents()");
        assert.ok(events.some(event=>String(event.Text??event.text).includes(expected)));evidence.externalAss={events,pixels:await subtitlePixels(a)};
        assert.ok(evidence.externalAss.pixels.overlayPixels>100);
      }
      evidence.checks.push({label:`menu-external-embedded-${name}`,revision});
    }
    await post("resolve-delay",{});
  },
  async tracks() {
    await command("mediaSet",{media:source("tracks.mkv")});const a=await start(true,0),b=await start(false,1280);
    await click(a,'button[aria-label="播放"]');for(const client of clients){await click(client,'button[aria-label="静音"]');await click(client,'button[aria-label="取消静音"]');}
    const tracks=(await refs(a)).tracks;const audio=tracks.items.filter(t=>t.kind==="audio"),subs=tracks.items.filter(t=>t.kind==="subtitle");
    assert.equal(audio[0].codec,"aac");assert.equal(audio[1].codec,"opus");assert.ok(audio.every(t=>t.supported));
    await selectMenuTrack(b,"audio",audio[1]);await selectMenuTrack(b,"subtitle",subs[1]);
    for(const [client,hz,prefix] of [[a,440,"EN"],[b,880,"JP"]])await until(client,`distinct-output-${prefix}`,s=>Math.abs(s.peakHz-hz)<8&&s.peakDb>-55&&s.cues.some(c=>c.text.startsWith(prefix)));
    let revision=(await room()).revision;await paired("different-codecs-and-caption-content",6);assert.equal((await room()).revision,revision);
    evidence.checks.push({label:"menu-different-tracks-preserve-revision",revision});
    await command("rate",{rate:.95});await sleep(700);
    for(const [client,hz] of [[a,418],[b,836]])await until(client,`rate-095-spectrum-${hz}`,s=>Math.abs(s.peakHz-hz)<8&&s.rate===.95);
    await paired("different-codecs-at-095",5);
    revision=(await room()).revision;
    await selectMenuTrack(a,"audio",audio[1]);await selectMenuTrack(a,"subtitle",subs[1]);
    await selectMenuTrack(b,"audio",audio[0]);await selectMenuTrack(b,"subtitle",subs[0]);
    for(const [client,hz,prefix] of [[a,836,"JP"],[b,418,"EN"]])await until(client,`swapped-output-${prefix}`,s=>Math.abs(s.peakHz-hz)<8&&s.cues.some(c=>c.text.startsWith(prefix)&&c.time>s.time-1));
    await paired("swapped-local-tracks-still-sync",5);assert.equal((await room()).revision,revision);
    evidence.checks.push({label:"menu-swapped-tracks-preserve-revision",revision});
    evidence.tracks=tracks;
  },
  async throttle() {
    await command("mediaSet",{media:source("tracks.mkv")});const a=await start(true,0);
    const tracks=(await refs(a)).tracks;
    await selectMenuTrack(a,"audio",tracks.items.find(t=>t.kind==="audio"&&t.codec==="aac"));
    await selectMenuTrack(a,"subtitle",tracks.items.find(t=>t.kind==="subtitle"&&t.language==="eng"));
    await command("rate",{rate:.95});await click(a,'button[aria-label="播放"]');
    await until(a,"clean-start-at-095",s=>s.time>1&&s.audio==="running"&&s.rate===.95);
    const limited=await post("limit",{bytesPerSecond:375000});
    await command("seek",{positionSeconds:70});
    await until(a,"real-throughput-underrun",s=>s.phase==="buffering",10000);
    const revision=(await room()).revision,samples=[],samplingStart=Date.now();
    while(Date.now()-samplingStart<35000){samples.push(await getState(a));await sleep(500);}
    const lift=await post("limit",{bytesPerSecond:0});
    evidence.throughput={seconds:(lift.epoch-limited.epoch)/1000,bytes:lift.sentBytes-limited.sentBytes,
      bitsPerSecond:(lift.sentBytes-limited.sentBytes)*8000/(lift.epoch-limited.epoch),samples};
    assert.ok(evidence.throughput.bitsPerSecond<3200000&&evidence.throughput.bitsPerSecond>2000000,"measured global throughput matches 3 Mbps");
    assert.equal((await room()).revision,revision);assert.equal((await room()).paused,false);
    const recovered=await until(a,"throughput-lift-video-audio-caption-recovery",s=>s.phase==="playing"&&s.audio==="running"&&Math.abs(s.peakHz-418)<8&&s.time>100&&s.cues.some(c=>c.time>s.time-1),20000);
    const samplesAfter=[];for(let i=0;i<60;i++){samplesAfter.push(await getState(a));await sleep(100);}
    const first=samplesAfter[0],last=samplesAfter.at(-1),observedRate=(last.time-first.time)*1000/(last.epoch-first.epoch);
    assert.ok(Math.abs(observedRate-.95)<.025);assert.equal((await room()).revision,revision);
    evidence.recovery={recovered,observedRate,samples:samplesAfter};
    const metrics=(await(await fetch(`${base}/__fixture`)).json()).metrics;assert.equal(metrics.fullRequests,0);
  },
};
try { assert.ok(cases[caseName],"Unknown scenario");await cases[caseName]();evidence.pass=true; }
catch(error){evidence.pass=false;evidence.error=error.message;process.exitCode=1;console.error(error.message);}
finally{
  await post("resolve-delay",{});
  await post("limit",{bytesPerSecond:0});await command("pause");
  for(const client of clients){await client.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}).catch(()=>{});await client.close();}
  evidence.profilesDeleted=true;await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2));console.log(`Evidence: ${output}`);
}
