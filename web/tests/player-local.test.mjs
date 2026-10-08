import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/player-local.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const { bufferedAheadSeconds } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
test("playable runway excludes disconnected buffered ranges", () => {
  const ranges = { length: 2, start: (index) => [0, 20][index], end: (index) => [5, 30][index] };
  assert.equal(bufferedAheadSeconds(ranges, 2), 3);
  assert.equal(bufferedAheadSeconds(ranges, 10), 0);
  assert.equal(bufferedAheadSeconds(ranges, 25), 5);
  assert.equal(bufferedAheadSeconds(ranges, 30), 0);
});
