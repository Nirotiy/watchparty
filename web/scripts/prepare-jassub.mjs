import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptRoot, "..");
const sourceRoot = path.join(webRoot, "node_modules/jassub/dist");
const targetRoot = path.join(webRoot, "public/vendor/jassub");

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await Promise.all([
  build({
    entryPoints: [path.join(sourceRoot, "jassub.js")],
    absWorkingDir: webRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    outfile: path.join(targetRoot, "jassub.js"),
  }),
  build({
    entryPoints: [path.join(sourceRoot, "worker/worker.js")],
    absWorkingDir: webRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    outfile: path.join(targetRoot, "jassub-worker.js"),
  }),
]);
await Promise.all([
  cp(path.join(sourceRoot, "wasm", "jassub-worker.wasm"), path.join(targetRoot, "jassub-worker.wasm")),
  cp(
    path.join(sourceRoot, "wasm", "jassub-worker-modern.wasm"),
    path.join(targetRoot, "jassub-worker-modern.wasm"),
  ),
  cp(path.join(sourceRoot, "default.woff2"), path.join(targetRoot, "default.woff2")),
]);
