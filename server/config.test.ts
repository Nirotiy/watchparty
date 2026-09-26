import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("importing the config module has no import-time side effects", async () => {
  // Must not throw even when the outer environment is production without a
  // signing key: evaluation only happens inside loadConfig().
  const fresh = await import(`./config.ts?evaluation=${Date.now()}`);
  assert.equal(typeof fresh.loadConfig, "function");
});

test("production mode refuses to start without a media-id signing key", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", WATCHPARTY_MEDIA_ID_KEY: "" }),
    /WATCHPARTY_MEDIA_ID_KEY is required/,
  );
  const config = loadConfig({ NODE_ENV: "production", WATCHPARTY_MEDIA_ID_KEY: "strong-key" });
  assert.equal(config.watchPartyMediaIdKey, "strong-key");
});

test("dev mode falls back to a random per-process signing key", () => {
  const first = loadConfig({ NODE_ENV: "test", WATCHPARTY_MEDIA_ID_KEY: "" });
  const second = loadConfig({ NODE_ENV: "test", WATCHPARTY_MEDIA_ID_KEY: "" });
  assert.notEqual(first.watchPartyMediaIdKey, "");
  assert.notEqual(first.watchPartyMediaIdKey, second.watchPartyMediaIdKey);
});

test("public url falls back to the internal openlist url", () => {
  const config = loadConfig({ OPENLIST_URL: "http://127.0.0.1:5244", OPENLIST_PUBLIC_URL: "" });
  assert.equal(config.openlistUrl, "http://127.0.0.1:5244");
  assert.equal(config.openlistPublicUrl, "");
});

test("config status reports how each setting was provisioned, not the resolved value", () => {
  // The defaults below are exactly what loadConfig resolves these to, so a
  // status derived from the resolved config would claim everything is set.
  const bare = loadConfig({ NODE_ENV: "test" });
  assert.deepEqual(bare.configStatus, {
    openlist: { url: "default", username: "default", password: "missing" },
    mediaIdKey: { mode: "ephemeral" },
  });

  const chosen = loadConfig({
    NODE_ENV: "test",
    OPENLIST_URL: "http://127.0.0.1:5244",
    OPENLIST_USERNAME: "admin",
    OPENLIST_PASSWORD: "pw",
    WATCHPARTY_MEDIA_ID_KEY: "key",
  });
  assert.deepEqual(chosen.configStatus, {
    openlist: { url: "explicit", username: "explicit", password: "explicit" },
    mediaIdKey: { mode: "persistent" },
  });
});
