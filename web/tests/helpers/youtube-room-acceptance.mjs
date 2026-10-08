// Real remote IFrame API attempt. Always headless and audio output disabled.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const browser = await startChrome(0, { headless: true, muteAudio: true });
const result = { startedAt: new Date().toISOString(), scope: "Real remote YouTube IFrame API in actual room/adapter components; Socket/API are fixtures. Headless and mute-audio, no physical audio claim." };
try {
  await browser.send("Page.navigate", { url: "http://127.0.0.1:18985/room/fixture" });
  await sleep(500);
  await browser.evaluate("roomRig.setSource({kind:'youtube',videoId:'M7lc1UVf-VE',title:'YouTube IFrame API demo'})");
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    const state = await browser.evaluate("({phase:roomRig.states.at(-1)?.phase,body:document.body.innerText,capabilities:roomRig.capabilities.at(-1),iframe:!!document.querySelector('iframe')})");
    if (state.phase === "paused" || state.phase === "ready") { ready = true; break; }
    if (state.body.includes("本机播放失败")) break;
    await sleep(250);
  }
  if (ready) {
    await browser.evaluate("document.querySelector('button[aria-label=播放]').click()");
    await sleep(4500);
  }
  result.state = await browser.evaluate("({phase:roomRig.states.at(-1)?.phase,presentedTime:roomRig.states.at(-1)?.presentedTime,audio:roomRig.states.at(-1)?.audio,body:document.body.innerText,capabilities:roomRig.capabilities.at(-1),iframe:!!document.querySelector('iframe')})");
  result.pass = ready && result.state.phase === "playing" && result.state.presentedTime > 0;
  if (!result.pass) result.limitation = "Remote IFrame API did not establish real playback. Deterministic SDK tests are separate and do not substitute for this result.";
} catch (error) { result.error = String(error); result.pass = false; }
finally {
  const output = process.argv[2] ?? "web/tests/results/youtube-room-2026-10-08.json";
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); await browser.close();
}
