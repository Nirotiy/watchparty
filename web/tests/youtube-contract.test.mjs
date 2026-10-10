import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/youtube.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm" });
const youtube = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("iframe error codes map onto the contract catalog without claiming region/network causes", () => {
  assert.equal(youtube.youtubeErrorCode(2), "YOUTUBE_INVALID_VIDEO");
  assert.equal(youtube.youtubeErrorCode(5), "YOUTUBE_PLAYBACK_FAILED");
  assert.equal(youtube.youtubeErrorCode(100), "YOUTUBE_VIDEO_UNAVAILABLE");
  assert.equal(youtube.youtubeErrorCode(101), "YOUTUBE_EMBED_FORBIDDEN");
  assert.equal(youtube.youtubeErrorCode(150), "YOUTUBE_EMBED_FORBIDDEN");
  assert.equal(youtube.youtubeErrorCode(153), "YOUTUBE_CLIENT_IDENTITY_REQUIRED");
  for (const value of [undefined, null, 3, 999, "2", NaN, {}]) {
    assert.equal(youtube.youtubeErrorCode(value), "YOUTUBE_UNKNOWN_ERROR", JSON.stringify(value));
  }
  const unknown = youtube.youtubeErrorMessage("YOUTUBE_UNKNOWN_ERROR");
  assert.ok(!/地区|网络不可达|网络故障/.test(unknown), `unknown message must stay neutral: ${unknown}`);
  for (const code of ["YOUTUBE_INVALID_VIDEO", "YOUTUBE_PLAYBACK_FAILED", "YOUTUBE_VIDEO_UNAVAILABLE",
    "YOUTUBE_EMBED_FORBIDDEN", "YOUTUBE_CLIENT_IDENTITY_REQUIRED", "YOUTUBE_API_UNAVAILABLE",
    "YOUTUBE_CONTROL_UNAVAILABLE", "YOUTUBE_UNKNOWN_ERROR"]) {
    assert.ok(youtube.youtubeErrorMessage(code).length > 0, code);
  }
});

test("input classification mirrors the backend: bare id / watch / youtu.be pass; rejected shapes explain themselves", () => {
  const video = (id) => ({ kind: "video", videoId: id });
  assert.deepEqual(youtube.classifyYouTubeInput("dQw4w9WgXcQ"), video("dQw4w9WgXcQ"));
  assert.deepEqual(youtube.classifyYouTubeInput("  M7lc1UVf-VE  "), video("M7lc1UVf-VE"));
  assert.deepEqual(youtube.classifyYouTubeInput("https://www.youtube.com/watch?v=WO6aRHKe7_c"), video("WO6aRHKe7_c"));
  assert.deepEqual(youtube.classifyYouTubeInput("https://youtube.com/watch?v=WO6aRHKe7_c"), video("WO6aRHKe7_c"));
  assert.deepEqual(youtube.classifyYouTubeInput("https://m.youtube.com/watch?v=WO6aRHKe7_c&t=30s"), video("WO6aRHKe7_c"));
  assert.deepEqual(youtube.classifyYouTubeInput("https://youtu.be/WO6aRHKe7_c?t=30"), video("WO6aRHKe7_c"));
  for (const [url, pattern] of [
    ["https://www.youtube.com/shorts/WO6aRHKe7_c", /Shorts/],
    ["https://www.youtube.com/embed/WO6aRHKe7_c", /embed/],
    ["https://www.youtube.com/playlist?list=PL123", /播放列表/],
    ["https://www.youtube.com/channel/UC123", /频道/],
    ["https://www.youtube.com/@someone", /频道/],
    ["https://www.youtube.com/watch?v=short", /11 位/],
    ["https://www.youtube.com/watch", /11 位/],
    ["https://youtu.be/abc", /短链/],
    ["http://www.youtube.com/watch?v=WO6aRHKe7_c", /https/],
  ]) {
    const classified = youtube.classifyYouTubeInput(url);
    assert.equal(classified?.kind, "unsupported", url);
    assert.match(classified.reason, pattern, url);
  }
  assert.equal(youtube.classifyYouTubeInput("https://cdn.example.com/movie.mkv"), null);
  assert.equal(youtube.classifyYouTubeInput("https://example.com/watch?v=WO6aRHKe7_c"), null);
  assert.equal(youtube.classifyYouTubeInput("bebop12345"), null);
  assert.equal(youtube.classifyYouTubeInput("Steins;Gate"), null);
  assert.equal(youtube.classifyYouTubeInput(""), null);
});
