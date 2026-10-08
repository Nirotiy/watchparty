import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/playback-sync.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const { synchronizePlayback } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function rig(time) {
  const calls = { seeks: [], rates: [], playing: null };
  const player = { play: async () => { calls.playing = true; }, pause: () => { calls.playing = false; },
    seek: (target) => calls.seeks.push(target), setPlaybackRate: (rate) => calls.rates.push(rate),
    getCurrentTime: () => time };
  return { player, calls };
}

test("paused snapshots apply one-second and sub-second seeks without treating them as running drift", () => {
  for (const target of [61, 59, 60.2, 59.8]) {
    const { player, calls } = rig(60);
    synchronizePlayback(player, { paused: true, positionSeconds: target, playbackRate: 1, serverTimeMs: 1000 }, 9000);
    assert.deepEqual(calls.seeks, [target]);
    assert.equal(calls.playing, false);
    assert.deepEqual(calls.rates, [1]);
  }
});

test("running snapshots preserve clock offset, hard seeking and 0.95/1.05 correction", () => {
  const snapshot = { paused: false, positionSeconds: 10, playbackRate: 1.25, serverTimeMs: 1000 };
  for (const [time, expectedRate, seek] of [[11.25, 1.25, false], [11.75, 1.25 * 0.95, false],
    [10.75, 1.25 * 1.05, false], [9, 1.25, true]]) {
    const { player, calls } = rig(time);
    synchronizePlayback(player, snapshot, 2000);
    assert.deepEqual(calls.seeks, seek ? [11.25] : []);
    assert.equal(calls.rates.at(-1), expectedRate);
    assert.equal(calls.playing, true);
  }
});
