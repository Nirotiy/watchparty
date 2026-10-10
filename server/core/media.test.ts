import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeYouTubeSource, validateMediaSource } from "./media.ts";

const id = "dQw4w9WgXcQ";

test("normalizes YouTube ids and supported URLs to a minimal source", () => {
  for (const input of [id, `https://youtube.com/watch?v=${id}`, `https://www.youtube.com/watch?v=${id}&list=ignored`, `https://m.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=tracking#player`]) {
    assert.deepEqual(normalizeYouTubeSource(input), { kind: "youtube", videoId: id });
  }
  assert.deepEqual(validateMediaSource({ kind: "youtube", url: `https://youtu.be/${id}`, title: "x", cookie: "secret" }), {
    kind: "youtube", videoId: id, title: "x",
  });
  assert.deepEqual(validateMediaSource(`https://youtube.com/watch?v=${id}`), { kind: "youtube", videoId: id });
});

test("rejects ambiguous YouTube paths and malformed ids", () => {
  for (const input of [
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/embed/${id}`,
    `https://youtube.com/playlist?list=${id}`,
    `https://youtube.com/channel/${id}`,
    `https://youtu.be/${id}/extra`,
    `http://youtube.com/watch?v=${id}`,
    "too-short",
  ]) assert.equal(normalizeYouTubeSource(input), undefined, input);
});
