import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const web = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "watchparty-adapter-"));
function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr);
}
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-c:a", "aac", "-movflags", "+faststart", path.join(directory, "clip.mp4")]);
ffmpeg(["-i", path.join(directory, "clip.mp4"), "-c", "copy", "-hls_time", "1", "-hls_list_size", "0",
  "-hls_segment_filename", path.join(directory, "clip%d.ts"), path.join(directory, "clip.m3u8")]);
const bundle = await build({ entryPoints: [path.join(web, "tests/helpers/player-adapter-harness.tsx")], bundle: true,
  write: false, platform: "browser", format: "esm", absWorkingDir: web });
const script = bundle.outputFiles[0].text;
const mockBundle = await build({ entryPoints: [path.join(web, "tests/helpers/player-adapter-harness.tsx")], bundle: true,
  write: false, platform: "browser", format: "esm", absWorkingDir: web, plugins: [{ name: "mkv-lifecycle-fixture", setup(build) {
    build.onResolve({ filter: /^@\/lib\/mkv\/player$/ }, () => ({ path: "mkv", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
      export class MkvPlayer {
        currentTime=0; duration=12; volume=85; muted=false; rate=1; disposed=false;
        embeddedTracks={items:[],audioId:null,subtitleId:null};
        constructor(options){this.options=options;(globalThis.__mkvTestInstances??=[]).push(this);}
        async load(url){
          const base=url.includes('second')?100:0;
          this.embeddedTracks={audioId:base+1,subtitleId:base+5,items:[
            {id:base+1,kind:'audio',codec:'aac',label:'EN',language:'eng',supported:true},
            {id:base+2,kind:'audio',codec:'aac',label:'JA',language:'jpn',supported:true},
            {id:base+5,kind:'subtitle',codec:'subrip',label:'EN',language:'eng',supported:true},
            {id:base+6,kind:'subtitle',codec:'subrip',label:'JA',language:'jpn',supported:true}]};
          this.options.onTracks(this.embeddedTracks);this.options.onReady(12);
        }
        async selectAudioTrack(id){this.embeddedTracks.audioId=id;this.options.onTracks(this.embeddedTracks);}
        selectSubtitleTrack(id){this.embeddedTracks.subtitleId=id;this.options.onTracks(this.embeddedTracks);}
        setExternalSubtitle(){} setSubtitleOffset(){} async unlockAudio(){}
        seek(time){this.currentTime=time;} setVolume(v){this.volume=v;} setMuted(v){this.muted=v;}
        setPlaybackRate(v){this.rate=v;} async play(){this.playing=true;} pause(){this.playing=false;}
        dispose(){this.disposed=true;}
      }` }));
  } }] });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    const harness = new URL(req.url, "http://localhost").searchParams.has("mock") ? "/mock-harness.js" : "/harness.js";
    res.end(`<!doctype html><meta charset="utf-8"><title>Player adapter verification</title><body style="background:#000;color:#fff"><script type="module" src="${harness}"></script>`);
    return;
  }
  if (pathname === "/harness.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
  if (pathname === "/mock-harness.js") { res.setHeader("Content-Type", "text/javascript"); res.end(mockBundle.outputFiles[0].text); return; }
  if (!/^\/clip(?:\d+\.ts|\.mp4|\.m3u8)$/.test(pathname)) { res.writeHead(404).end(); return; }
  try {
    const filename = path.join(directory, pathname.slice(1));
    const size = (await stat(filename)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
    const type = filename.endsWith(".mp4") ? "video/mp4" : filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
    res.writeHead(range ? 206 : 200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
    res.end((await readFile(filename)).subarray(start, end + 1));
  } catch { res.writeHead(404).end(); }
});
server.listen(18984, "127.0.0.1", () => console.log("Adapter fixture: http://127.0.0.1:18984"));
process.on("SIGINT", () => server.close(() => process.exit(0)));
