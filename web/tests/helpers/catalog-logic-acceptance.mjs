// Runs the actual Next library component with deterministic, delayed HTTP responses.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startChrome, sleep } from "./chrome-session.mjs";

const browser = await startChrome();
const result = { startedAt: new Date().toISOString(), checks: [] };
const output = process.argv[2] ?? "web/tests/results/catalog-logic.json";
const fixture = await (await fetch("http://127.0.0.1:18981/__fixture")).json();
async function check(label, expression) {
  const pass = await browser.evaluate(expression);
  result.checks.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
}
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await browser.evaluate(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`UI condition timed out: ${expression}`);
}
try {
  await browser.send("Page.enable");
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    localStorage.setItem(${JSON.stringify(`token_${fixture.room.roomId}`)},${JSON.stringify(fixture.room.accessToken)});
    localStorage.setItem('watchparty_client_id',crypto.randomUUID());
    const native=fetch;
    globalThis.__catalogRig={slowLibrary:false,slowDetail:false,slowWrite:false,calls:[]};
    const card=(id,title)=>({id,title,status:'confirmed',kind:'anime',year:null,posterUrl:null,subtitle:null});
    globalThis.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      let value;
      if(url.pathname==='/api/media/capabilities')value={libraries:true,mediaAdmin:true};
      else if(url.pathname==='/api/media/libraries')value={libraries:['a','b'].map(id=>({id,name:'Library '+id.toUpperCase(),kind:'anime',sourceName:'Fixture',health:'ok'}))};
      else if(url.pathname==='/api/media/catalog'){
        const id=url.searchParams.get('libraryId'),q=url.searchParams.get('q')??'';
        __catalogRig.calls.push({id,q});
        await new Promise(r=>setTimeout(r,__catalogRig.slowLibrary&&id==='a'?300:25));
        value={items:[card(id+'1','Alpha '+id.toUpperCase()),card(id+'2','Beta '+id.toUpperCase())].filter(x=>!q||x.title.includes(q)),hasMore:false};
      }else if(url.pathname.startsWith('/api/media/catalog/')){
        const write=init?.method==='POST',id=url.pathname.split('/').at(write?-2:-1);
        await new Promise(r=>setTimeout(r,(write&&__catalogRig.slowWrite)||(__catalogRig.slowDetail&&id.endsWith('1'))?300:25));
        value={...card(id,id.endsWith('1')?'Alpha A':'Beta A'),originalTitle:null,overview:'Detail '+id,children:[],
          candidates:[{id:'candidate',title:'Candidate',score:1,year:null}]};
      }else if(url.pathname.includes('/scrape')){
        if(init?.method==='POST'&&__catalogRig.slowWrite)await new Promise(r=>setTimeout(r,300));
        value={status:'done',total:2,scanned:2,matched:2,lastError:null};
      }
      else return native(input,init);
      return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
    };
  })()` });
  await browser.send("Page.navigate", { url: `http://127.0.0.1:18982/room/${fixture.room.roomId}` });
  await waitFor("document.querySelector('button[aria-label=\"点播媒体库\"]')");
  await sleep(1500);
  await browser.evaluate("document.querySelector('button[aria-label=\"点播媒体库\"]').click()");
  await waitFor("document.querySelectorAll('[aria-label=\"标题墙\"] li').length===2");
  // 搜索即输入（无提交按钮）：首载结束后搜索框应存在且可用，标题墙已就位。
  await check("title-initial-load-releases-search", "(()=>{const i=document.querySelector('input[aria-label*=\"搜索标题\"]');return Boolean(i)&&!i.disabled&&document.querySelectorAll('[aria-label=\"标题墙\"] li').length===2})()");
  // Select the current library so the remaining checks also run on the pre-fix loading bug.
  await browser.evaluate("document.querySelector('[aria-label=\"媒体库\"] button').click()");
  await sleep(150);
  await browser.evaluate(`(()=>{const input=document.querySelector('input[aria-label*="搜索标题"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Alpha');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  // 250ms 防抖 + 请求落地。
  await sleep(600);
  await check("title-query-filters", "document.querySelectorAll('[aria-label=\"标题墙\"] li').length===1");
  await browser.evaluate("document.querySelector('button[aria-label=\"清除搜索\"]').click()");
  await sleep(600);
  await check("clearing-title-query-restores-library", "document.querySelectorAll('[aria-label=\"标题墙\"] li').length===2");
  await browser.evaluate("__catalogRig.slowLibrary=true;document.querySelector('[aria-label=\"媒体库\"] button').click()");
  await sleep(40);
  await browser.evaluate("document.querySelectorAll('[aria-label=\"媒体库\"] button')[1].click()");
  await sleep(450);
  await check("old-library-response-cannot-overwrite-new-library", "[...document.querySelectorAll('[aria-label=\"标题墙\"] button')].every(x=>x.title.includes(' B'))&&document.querySelectorAll('[aria-label=\"标题墙\"] li').length===2");
  await browser.evaluate("__catalogRig.slowLibrary=false;document.querySelector('[aria-label=\"媒体库\"] button').click()");
  await sleep(150);
  await browser.evaluate("__catalogRig.slowDetail=true;document.querySelector('[aria-label=\"标题墙\"] button').click()");
  await sleep(40);
  await browser.evaluate("document.querySelectorAll('[aria-label=\"标题墙\"] button')[1].click()");
  await sleep(450);
  await check("old-detail-response-cannot-overwrite-current-card", "document.querySelector('[aria-label=\"标题详情\"]').textContent.includes('Detail a2')");
  await browser.evaluate("__catalogRig.slowWrite=true;[...document.querySelectorAll('[aria-label=\"标题详情\"] button')].find(x=>x.textContent.trim()==='确认').click()");
  await sleep(40);
  await browser.evaluate("document.querySelectorAll('[aria-label=\"媒体库\"] button')[1].click()");
  await sleep(450);
  await check("old-review-response-cannot-reopen-detail-or-library", "!document.querySelector('[aria-label=\"标题详情\"]')&&[...document.querySelectorAll('[aria-label=\"标题墙\"] button')].every(x=>x.title.includes(' B'))");
  // 刮削入口与状态行已下线（2026-10-08）：原 old-scrape-response 检查随功能退役；
  // 陈旧库/详情/确认三类响应隔离已由上面三项覆盖。
  result.pass = result.checks.every((item) => item.pass);
  assert.ok(result.pass, "Catalog state regression");
} catch (error) {
  result.pass = false; result.error = error.message;
  result.lastButtons = await browser.evaluate("[...document.querySelectorAll('button')].map(x=>x.textContent.trim())");
  result.diagnostic = await browser.evaluate("({body:document.body.innerText.slice(-1500),rig:globalThis.__catalogRig})");
  process.exitCode = 1;
}
finally {
  await browser.close();
  result.profileDeleted = true;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
