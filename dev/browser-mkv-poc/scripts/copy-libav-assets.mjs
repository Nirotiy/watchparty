import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const distDirectory = dirname(require.resolve("@libav.js/variant-webcodecs"));
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectDirectory, "public/libav");
const assetNames = [
  "libav-6.10.9.0-webcodecs.wasm.mjs",
  "libav-6.10.9.0-webcodecs.wasm.wasm",
  "libav-6.10.9.0-webcodecs.thr.mjs",
  "libav-6.10.9.0-webcodecs.thr.wasm",
];

await mkdir(outputDirectory, { recursive: true });
let bytes = 0;
for (const name of assetNames) {
  const source = resolve(distDirectory, name);
  const target = resolve(outputDirectory, name);
  await copyFile(source, target);
  bytes += (await stat(target)).size;
}

console.log(`Prepared ${assetNames.length} same-origin libav assets (${bytes} bytes).`);
