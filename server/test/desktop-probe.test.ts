import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DESKTOP_SERVICE_VERSION, PROTOCOL_VERSION } from "../core/protocol.ts";

const backends: Backend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

async function boot(): Promise<Backend> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: "http://127.0.0.1:1",
    OPENLIST_USERNAME: "",
    OPENLIST_PASSWORD: "",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config,
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

function url(backend: Backend, path: string): string {
  return `http://127.0.0.1:${backend.port}${path}`;
}

test("desktop health and capabilities are public and stable", async () => {
  const backend = await boot();

  const health = await fetch(url(backend, "/api/desktop/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: DESKTOP_SERVICE_VERSION,
  });

  const capabilities = await fetch(url(backend, "/api/desktop/capabilities"));
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: DESKTOP_SERVICE_VERSION,
    capabilities: {
      createRoom: true,
      joinRoom: true,
      restoreSession: true,
      mediaSearch: true,
      mediaQueue: true,
      handoffCode: true,
      readiness: true,
    },
  });
});

test("desktop probes accept the current protocol without room credentials", async () => {
  const backend = await boot();
  for (const path of ["/api/desktop/health", "/api/desktop/capabilities", "/api/desktop/readiness"]) {
    const response = await fetch(url(backend, path), {
      headers: { "x-watchparty-protocol": String(PROTOCOL_VERSION) },
    });
    assert.equal(response.status, 200, path);
  }
});

test("desktop probes reject an explicitly incompatible protocol", async () => {
  const backend = await boot();
  for (const path of ["/api/desktop/health", "/api/desktop/capabilities", "/api/desktop/readiness"]) {
    const response = await fetch(url(backend, path), {
      headers: { "x-watchparty-protocol": String(PROTOCOL_VERSION + 1) },
    });
    assert.equal(response.status, 426, path);
    assert.deepEqual(await response.json(), {
      code: "PROTOCOL_VERSION_MISMATCH",
      message: "客户端协议版本不兼容，请升级客户端",
    });
  }
});
