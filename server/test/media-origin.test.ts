import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { mediaForRequest } from "../core/http/media-origin.ts";
import { loadConfig } from "../config.ts";

const web = "https://watch.example.test";
const desktop = "https://192.0.2.1:8443";
const media = { url: `${web}/p/anime/a%20b.mkv?sign=test-sign`, fallbackUrl: `${web}/p/anime/a%20b.mkv?sign=test-sign`, directUrl: "https://cdn.example.test/p/video?token=test-token" };

test("loopback media proxy selects only configured origins, preserving signatures and direct CDN links", async () => {
  const app = express();
  app.get("/resolve", (req, res) => { res.json(mediaForRequest(req, media, [web, desktop])); });
  app.get("/foreign", (req, res) => { res.json(mediaForRequest(req, { url: media.directUrl }, [web, desktop])); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const chosen of [undefined, desktop, web, "https://attacker.example", `${desktop},${web}`]) {
      const response = await fetch(`${origin}/resolve`, { headers: chosen ? { "x-watchparty-media-origin": chosen } : {} });
      const actual = await response.json();
      assert.equal(actual.directUrl, media.directUrl);
      assert.equal(actual.url, chosen === desktop ? `${desktop}/p/anime/a%20b.mkv?sign=test-sign` : media.url);
      assert.equal(actual.fallbackUrl, actual.url);
    }
    const foreign = await fetch(`${origin}/foreign`, { headers: { "x-watchparty-media-origin": desktop } });
    assert.deepEqual(await foreign.json(), { url: media.directUrl });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("public media origins reject paths, credentials and HTTP at startup", () => {
  assert.deepEqual(loadConfig({ WATCHPARTY_MEDIA_PUBLIC_ORIGINS: `${web}, ${desktop}` }).mediaPublicOrigins, [web, desktop]);
  for (const bad of ["http://192.0.2.1:8443", `${web}/path`, "https://user:password@watch.example.test", "not-a-url"]) {
    assert.throws(() => loadConfig({ WATCHPARTY_MEDIA_PUBLIC_ORIGINS: bad }));
  }
});
