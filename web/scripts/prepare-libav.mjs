import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve("@libav.js/variant-webcodecs"));
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/vendor/libav");
await mkdir(target, { recursive: true });
for (const name of [
  "libav-6.10.9.0-webcodecs.wasm.mjs",
  "libav-6.10.9.0-webcodecs.wasm.wasm",
  "libav-6.10.9.0-webcodecs.thr.mjs",
  "libav-6.10.9.0-webcodecs.thr.wasm",
]) {
  await copyFile(path.join(source, name), path.join(target, name));
}
// The pinned loader hides its Worker until initialization completes. Allow the
// room to own it from creation so cancellation also covers a stalled WASM boot.
const loader = await readFile(path.join(source, "libav-webcodecs.mjs"), "utf8");
const constructor = 'ret.worker=new Worker(toImport,{type:useES6?"module":"classic"})';
if (loader.split(constructor).length !== 2) throw new Error("Pinned libav loader Worker hook changed");
await writeFile(path.join(target, "libav-webcodecs.mjs"), loader.replace(constructor,
  'ret.worker=opts.worker||new Worker(toImport,{type:useES6?"module":"classic"})'));
console.log("Prepared same-origin libav.js 6.10.9 assets.");
const bridgeDist = path.dirname(require.resolve("libavjs-webcodecs-bridge"));
await copyFile(path.join(bridgeDist, "libavjs-webcodecs-bridge.mjs"), path.join(target, "bridge.mjs"));
