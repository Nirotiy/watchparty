import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/media-operation-result.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const { runBatchOperation, getBatchRetryItems, operationResult, reconcilePlaylistAdd, confirmStoppedBatchItem } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const success = { ok: true, revision: 2 };
const failure = (code) => ({ ok: false, error: { code, message: code } });

test("batch stops on first known failure and retries only stopped and unexecuted items", async () => {
  const calls = [];
  const result = await runBatchOperation(["a", "b", "c"], async (item) => {
    calls.push(item); return item === "b" ? failure("PLAYLIST_FULL") : success;
  });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.addedCount, 1);
  assert.equal(result.stopped.index, 1);
  assert.deepEqual(result.remaining, [{ index: 2, item: "c" }]);
  assert.deepEqual(getBatchRetryItems(result), ["b", "c"]);
});

test("timeout and exceptions retain unknown outcome and prohibit blind retry", async () => {
  for (const execute of [async () => failure("TIMEOUT"), async () => failure("INVALID_ACK"), async () => { throw Error("transport lost"); }]) {
    const result = await runBatchOperation(["a", "b"], execute);
    assert.equal(result.status, "uncertain");
    assert.equal(result.addedCount, 0);
    assert.deepEqual(result.remaining, [{ index: 1, item: "b" }]);
    assert.equal(getBatchRetryItems(result), null);
  }
  assert.equal(operationResult(failure("NOT_CONNECTED")).status, "failed");
});

test("success preserves acknowledgements and command execution is sequential", async () => {
  let active = 0;
  const result = await runBatchOperation(["a", "b"], async () => {
    assert.equal(active++, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return success;
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.addedCount, 2);
  assert.equal(result.succeeded[1].acknowledgement.revision, 2);
  assert.deepEqual(getBatchRetryItems(result), []);
  assert.equal((await runBatchOperation([], async () => success)).status, "succeeded");
});

test("unknown add needs a unique new own item and a single committed revision", async () => {
  const media = { kind: "openlist", mediaId: "a", title: "A", container: "mkv" };
  const existing = { id: "old", media, addedByClientId: "self", addedAtMs: 0 };
  const before = { revision: 10, playlist: [existing] };
  const attempt = { before, media, clientId: "self" };
  assert.equal(reconcilePlaylistAdd(attempt, { revision: 11, playlist: [existing] }), null);
  const fresh = { ...existing, id: "new", media: { ...media, title: "Normalized title" } };
  assert.equal(reconcilePlaylistAdd(attempt, { revision: 11, playlist: [existing, { ...fresh, addedByClientId: "other" }] }), null);
  assert.equal(reconcilePlaylistAdd(attempt, { revision: 12, playlist: [existing, fresh] }), null);
  assert.equal(reconcilePlaylistAdd(attempt, { revision: 11, playlist: [fresh, { ...fresh, id: "second" }] }), null);
  const ack = reconcilePlaylistAdd(attempt, { revision: 11, playlist: [existing, fresh] });
  assert.deepEqual(ack, { ok: true, revision: 11 });
  const result = await runBatchOperation([media, { ...media, mediaId: "b" }], async () => failure("TIMEOUT"));
  const confirmed = confirmStoppedBatchItem(result, ack);
  assert.equal(confirmed.addedCount, 1);
  assert.equal(confirmed.stopped, null);
  assert.deepEqual(getBatchRetryItems(confirmed), [{ ...media, mediaId: "b" }]);
});
