// Isolated actual room/adapter components. Socket/API/MKV fixtures are explicit.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const web = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "watchparty-room-integration-"));
const fixture = path.join(web, "tests/helpers/room-integration-fixture.ts");
for (const args of [
  ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-an", "-movflags", "+faststart", path.join(directory, "clip.mp4")],
  ["-i", path.join(directory, "clip.mp4"), "-c", "copy", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_filename", path.join(directory, "clip%d.ts"), path.join(directory, "clip.m3u8")],
]) {
  const output = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (output.status !== 0) throw Error(output.stderr);
}
const bundle = await build({ entryPoints: [path.join(web, "tests/helpers/room-integration-harness.tsx")], bundle: true,
  write: false, platform: "browser", format: "esm", absWorkingDir: web, plugins: [{ name: "explicit-room-fixtures", setup(build) {
    build.onResolve({ filter: /^@\/lib\/(socket|api|mkv\/player)$/ }, (args) => {
      if (args.importer === fixture) return;
      return { path: args.path, namespace: "fixture" };
    });
    build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ loader: "js", resolveDir: web,
      contents: `export { ${args.path.endsWith('/socket') ? 'WatchPartySocket' : args.path.endsWith('/api') ? 'api' : 'MkvPlayer'} } from ${JSON.stringify(fixture)};` }));
    build.onResolve({ filter: /^\.\/player-adapter$/ }, (args) => args.importer.endsWith("room-player.tsx") ? { path: "adapter", namespace: "capture" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "capture" }, () => ({ loader: "tsx", resolveDir: web, contents: `
      import React,{forwardRef} from 'react';
      import {PlayerAdapter as Actual} from ${JSON.stringify(path.join(web, "components/player-adapter.tsx"))};
      import {rig} from ${JSON.stringify(fixture)};
      export const PlayerAdapter=forwardRef((props,ref)=><Actual {...props} ref={ref}
        onLocalState={state=>{rig.states.push(state);props.onLocalState?.(state);}}
        onCapabilities={caps=>{rig.capabilities.push(caps);props.onCapabilities?.(caps);}}/>);
    ` }));
  } }] });
const css = (await postcss([tailwind()]).process(await readFile(path.join(web, "app/globals.css"), "utf8"), { from: path.join(web, "app/globals.css") })).css;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/__close") { res.end("ok"); setTimeout(close, 50); return; }
  if (pathname === "/" || pathname === "/room/fixture") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Room integration verification</title><link rel="stylesheet" href="/style.css"><body style="margin:0;background:#000;color:#fff"><script type="module" src="/harness.js"></script></body></html>'); return;
  }
  if (pathname === "/harness.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
  if (!/^\/clip(?:\d+\.ts|\.mp4|\.m3u8)$/.test(pathname)) { res.writeHead(404).end(); return; }
  const file = path.join(directory, pathname.slice(1)), size = (await stat(file)).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? ""), start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  res.writeHead(range ? 206 : 200, { "Content-Type": file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
    "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  createReadStream(file, { start, end }).pipe(res);
});
async function close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); process.exit(0); }
server.listen(18985, "127.0.0.1", () => console.log("Room integration: http://127.0.0.1:18985/room/fixture"));
process.on("SIGINT", close);
process.on("SIGTERM", close);
