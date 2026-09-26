import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DESKTOP_SERVICE_VERSION, PROTOCOL_VERSION } from "../core/protocol.ts";
import { createReadinessProbe } from "../core/http/readiness.ts";

const backends: Backend[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const ANIME = "/media/openlist-bdyun/Multimedia/Anime";
const FILM = "/media/openlist-bdyun/Multimedia/Film";

/**
 * Minimal fake OpenList: login always succeeds unless `mode` says otherwise;
 * fs/list answers per path so root-level readiness is deterministic.
 */
function startFakeOpenlist(
  mode: "ok" | "auth-failed" | "film-missing" | "hang-list" = "ok",
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const payload = JSON.parse(body || "{}") as { path?: string };
        if (req.url === "/api/auth/login") {
          if (mode === "auth-failed") {
            res.end(JSON.stringify({ code: 401, message: "bad credentials" }));
            return;
          }
          res.end(JSON.stringify({ code: 200, data: { token: "fake-token" } }));
          return;
        }
        if (req.url === "/api/fs/list") {
          if (mode === "hang-list") return; // never answer: exercises the client timeout
          if (payload.path === FILM && mode === "film-missing") {
            res.end(JSON.stringify({ code: 500, message: "object not found" }));
            return;
          }
          res.end(
            JSON.stringify({ code: 200, data: { content: [{ name: "x" }] } }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 404 }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function boot(options: {
  openlistUrl: string;
  readinessCacheTtlMs?: number;
  openlistPingTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<Backend> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: options.openlistUrl,
    OPENLIST_USERNAME: "probe-user",
    OPENLIST_PASSWORD: "sekret-pass-123",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
    ...options.env,
  });
  const backend = createBackend({
    host: "127.0.0.1",
    port: 0,
    pruneIntervalMs: 0,
    serveStatic: false,
    config,
    ...(options.readinessCacheTtlMs !== undefined
      ? { readinessCacheTtlMs: options.readinessCacheTtlMs }
      : {}),
    ...(options.openlistPingTimeoutMs !== undefined
      ? { openlistPingTimeoutMs: options.openlistPingTimeoutMs }
      : {}),
  });
  await backend.start();
  backends.push(backend);
  return backend;
}

function url(backend: Backend, path: string): string {
  return `http://127.0.0.1:${backend.port}${path}`;
}

test("desktop readiness is public, ready against a healthy source, and reports the bound listener", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });

  const response = await fetch(url(backend, "/api/desktop/readiness"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    status: string;
    service: string;
    protocolVersion: number;
    serviceVersion: string;
    readinessVersion: number;
    bootId: string;
    startedAt: number;
    checkedAt: number;
    listener: { host: string; configuredPort: number; boundPort: number; secure: boolean };
    cache: { ttlMs: number; ageMs: number; fromCache: boolean };
    components: {
      core: { status: string };
      openlist: { status: string; code: string; latencyMs: number };
      mediaRoots?: { status: string; roots: { name: string; ok: boolean; code: string }[] };
    };
    diagnostics: unknown[];
  };
  assert.equal(body.status, "ready");
  assert.equal(body.service, "watchparty");
  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
  assert.equal(body.serviceVersion, DESKTOP_SERVICE_VERSION);
  assert.equal(body.readinessVersion, 1);
  assert.equal(body.listener.boundPort, backend.port);
  assert.equal(body.listener.configuredPort, 0);
  assert.equal(body.listener.secure, false);
  assert.equal(body.components.core.status, "up");
  // core is {status:"up"} and nothing else; Go now matches this shape exactly.
  assert.deepEqual(body.components.core, { status: "up" });
  // Units are contractual, not incidental: every timestamp/duration is epoch ms
  // as a JSON number. The shell deserialises them as u64, so a string here fails
  // silently and the UI just drops back to its single status line.
  assert.equal(typeof body.startedAt, "number");
  assert.equal(typeof body.checkedAt, "number");
  assert.equal(typeof body.cache.ttlMs, "number");
  assert.equal(typeof body.listener.boundPort, "number");
  assert.ok(body.startedAt > 1e12 && body.checkedAt > 1e12, "epoch milliseconds");
  assert.equal(body.components.openlist.status, "up");
  assert.equal(body.components.openlist.code, "OPENLIST_OK");
  assert.equal(body.components.mediaRoots?.status, "up");
  assert.deepEqual(body.diagnostics, []);
  // Internal media root paths must never leak through the readiness surface.
  assert.ok(!JSON.stringify(body).includes(ANIME), "root paths must not leak");
  // Credentials must never leak.
  assert.ok(
    !JSON.stringify(body).includes("sekret-pass-123"),
    "openlist password must not leak",
  );
});

test("readiness alias /api/readiness shares the same probe (same bootId)", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const aRes = await fetch(url(backend, "/api/desktop/readiness"));
  const a = (await aRes.json()) as { bootId?: string };
  const bRes = await fetch(url(backend, "/api/readiness"));
  const b = (await bRes.json()) as { bootId?: string };
  assert.equal(aRes.status, 200);
  assert.equal(bRes.status, 200, "alias /api/readiness body: " + JSON.stringify(b));
  assert.equal(a.bootId, b.bootId);
});

test("unreachable OpenList degrades with a stable code and remediation", async () => {
  const backend = await boot({
    openlistUrl: "http://127.0.0.1:1",
    readinessCacheTtlMs: 0,
  });
  const response = await fetch(url(backend, "/api/desktop/readiness"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    status: string;
    components: {
      openlist: { status: string; code: string; remediation?: string };
      mediaRoots?: unknown;
    };
    diagnostics: { code: string; remediation?: string }[];
  };
  assert.equal(body.status, "degraded");
  assert.equal(body.components.openlist.status, "down");
  assert.equal(body.components.openlist.code, "OPENLIST_UNREACHABLE");
  assert.equal(body.components.openlist.remediation, "CHECK_OPENLIST_URL");
  assert.equal(body.components.mediaRoots, undefined);
  assert.equal(body.diagnostics[0]?.remediation, "CHECK_OPENLIST_URL");
});

test("auth failure maps to OPENLIST_AUTH_FAILED with a credentials remediation", async () => {
  const openlistUrl = await startFakeOpenlist("auth-failed");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const body = (await (await fetch(url(backend, "/api/desktop/readiness"))).json()) as {
    status: string;
    components: { openlist: { code: string; remediation?: string } };
  };
  assert.equal(body.status, "degraded");
  assert.equal(body.components.openlist.code, "OPENLIST_AUTH_FAILED");
  assert.equal(
    body.components.openlist.remediation,
    "CHECK_OPENLIST_CREDENTIALS",
  );
});

test("a hung OpenList surfaces OPENLIST_TIMEOUT with a timeout remediation", async () => {
  const openlistUrl = await startFakeOpenlist("hang-list");
  const backend = await boot({
    openlistUrl,
    readinessCacheTtlMs: 0,
    openlistPingTimeoutMs: 150,
  });
  const body = (await (await fetch(url(backend, "/api/desktop/readiness"))).json()) as {
    status: string;
    components: { openlist: { code: string; remediation?: string } };
  };
  assert.equal(body.status, "degraded");
  assert.equal(body.components.openlist.code, "OPENLIST_TIMEOUT");
  assert.equal(body.components.openlist.remediation, "CHECK_OPENLIST_TIMEOUT");
});

test("a missing media root degrades readiness without leaking its path", async () => {
  const openlistUrl = await startFakeOpenlist("film-missing");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const body = (await (await fetch(url(backend, "/api/desktop/readiness"))).json()) as {
    status: string;
    components: {
      openlist: { status: string };
      mediaRoots?: { status: string; roots: { name: string; ok: boolean; code: string }[] };
    };
    diagnostics: { code: string; remediation?: string; message: string }[];
  };
  assert.equal(body.status, "degraded");
  assert.equal(body.components.openlist.status, "up");
  assert.equal(body.components.mediaRoots?.status, "down");
  const film = body.components.mediaRoots?.roots.find((r) => r.name === "Film");
  assert.equal(film?.ok, false);
  assert.equal(film?.code, "MEDIA_ROOT_NOT_FOUND");
  assert.equal(body.diagnostics[0]?.remediation, "CHECK_MEDIA_ROOTS");
  assert.ok(!JSON.stringify(body).includes(FILM), "root paths must not leak");
});

test("readiness requires only an optional protocol header (426 on explicit mismatch)", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const mismatch = await fetch(url(backend, "/api/desktop/readiness"), {
    headers: { "x-watchparty-protocol": String(PROTOCOL_VERSION + 1) },
  });
  assert.equal(mismatch.status, 426);
  const noHeader = await fetch(url(backend, "/api/desktop/readiness"));
  assert.equal(noHeader.status, 200);
});

test("capabilities advertise the readiness capability", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const body = (await (await fetch(url(backend, "/api/desktop/capabilities"))).json()) as {
    capabilities: Record<string, unknown>;
  };
  assert.equal(body.capabilities.readiness, true);
});

test("probe cache honors ttl and single-flight (shared checkedAt)", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });

  const config = loadConfig({
    NODE_ENV: "test",
    OPENLIST_URL: openlistUrl,
    OPENLIST_USERNAME: "u",
    OPENLIST_PASSWORD: "p",
    WATCHPARTY_MEDIA_ID_KEY: "test-key",
  });
  const { createWatchpartyMedia } = await import("../media/watchparty-media.ts");
  const { createOpenlistClient } = await import("../media/openlist.ts");
  const configSummary = {
    openlist: {
      url: "explicit",
      username: "explicit",
      password: "explicit",
    },
    mediaIdKey: { mode: "persistent" },
  } as const;
  const media = createWatchpartyMedia(createOpenlistClient(config), {
    mediaIdKey: "test-key",
    internalBaseUrl: openlistUrl,
    publicBaseUrl: openlistUrl,
  });

  const probe = createReadinessProbe({
    media,
    configStatus: () => configSummary,
    ttlMs: 60_000,
  });
  const first = await probe.snapshot({
    host: "127.0.0.1",
    configuredPort: 0,
    boundPort: 1,
    secure: false,
  });
  const second = await probe.snapshot({
    host: "127.0.0.1",
    configuredPort: 0,
    boundPort: 1,
    secure: false,
  });
  assert.equal(first.cache.fromCache, false);
  assert.equal(second.cache.fromCache, true);
  assert.equal(second.checkedAt, first.checkedAt);

  // ttlMs=0 disables caching, but concurrent calls still single-flight.
  const noCache = createReadinessProbe({ media, configStatus: () => configSummary, ttlMs: 0 });
  const [c, d] = await Promise.all([
    noCache.snapshot({ host: "127.0.0.1", configuredPort: 0, boundPort: 1, secure: false }),
    noCache.snapshot({ host: "127.0.0.1", configuredPort: 0, boundPort: 1, secure: false }),
  ]);
  assert.equal(c.cache.fromCache, false);
  assert.equal(d.cache.fromCache, false);
  assert.equal(d.checkedAt, c.checkedAt);
});

type ReadinessConfigBody = {
  status: string;
  config: {
    openlist: { url: string; username: string; password: string };
    mediaIdKey: { mode: string };
  };
  components: { openlist: { status: string; code: string } };
  diagnostics: {
    severity: string;
    code: string;
    remediation?: string;
  }[];
};

async function fetchConfigProbe(backend: Backend): Promise<ReadinessConfigBody> {
  const response = await fetch(url(backend, "/api/desktop/readiness"));
  assert.equal(response.status, 200);
  return (await response.json()) as ReadinessConfigBody;
}

test("unset openlist url/credentials are reported as provisioning gaps with setup remediation", async () => {
  // No fake source: OPENLIST_URL is unset, so the backend falls back to its
  // built-in address. Which transport code that produces is environment
  // dependent; the provisioning diagnostics must be reported either way.
  const backend = await boot({
    openlistUrl: "http://127.0.0.1:1",
    readinessCacheTtlMs: 0,
    env: {
      OPENLIST_URL: "",
      OPENLIST_USERNAME: "",
      OPENLIST_PASSWORD: "",
    },
  });
  const body = await fetchConfigProbe(backend);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.config, {
    openlist: { url: "default", username: "default", password: "missing" },
    mediaIdKey: { mode: "persistent" },
  });
  // Invariant shared with Go: components.*.code only ever holds a transport
  // code. Provisioning gaps belong to diagnostics[] — a caller that read
  // "not configured" off the component would flag a healthy backend down.
  assert.ok(
    [
      "OPENLIST_OK",
      "OPENLIST_UNREACHABLE",
      "OPENLIST_TIMEOUT",
      "OPENLIST_AUTH_FAILED",
      "OPENLIST_BAD_RESPONSE",
    ].includes(body.components.openlist.code),
    `unexpected component code: ${body.components.openlist.code}`,
  );
  assert.ok(
    !JSON.stringify(body.components).includes("NOT_CONFIGURED"),
    "provisioning codes must not leak into components",
  );
  // Invariant shared with Go: the most actionable diagnostic comes first, so a
  // caller may act on diagnostics[0] alone. Provisioning gaps outrank the
  // transport code that the missing setting caused.
  assert.equal(body.diagnostics[0]?.code, "OPENLIST_URL_NOT_CONFIGURED");
  const provisioningCodes = body.diagnostics
    .map((d) => d.code)
    .filter((code) => code.startsWith("OPENLIST_URL") || code.startsWith("OPENLIST_PASSWORD") || code.startsWith("OPENLIST_USERNAME"));
  const firstTransport = body.diagnostics.findIndex((d) => !provisioningCodes.includes(d.code));
  if (firstTransport >= 0) {
    assert.ok(
      provisioningCodes.length <= firstTransport,
      `provisioning diagnostics must precede transport ones: ${body.diagnostics.map((d) => d.code).join(",")}`,
    );
  }
  const provisioning = body.diagnostics.filter((d) =>
    d.code.startsWith("OPENLIST_URL") ||
    d.code.startsWith("OPENLIST_PASSWORD") ||
    d.code.startsWith("OPENLIST_USERNAME"),
  );
  assert.deepEqual(
    provisioning.map((d) => [d.severity, d.code, d.remediation]),
    [
      ["error", "OPENLIST_URL_NOT_CONFIGURED", "OPENLIST_URL_SETUP"],
      ["error", "OPENLIST_PASSWORD_NOT_CONFIGURED", "OPENLIST_CREDENTIALS_SETUP"],
      ["warning", "OPENLIST_USERNAME_DEFAULTED", "OPENLIST_CREDENTIALS_SETUP"],
    ],
  );
  // Names, never values: the built-in address must not be echoed.
  const json = JSON.stringify(body);
  assert.ok(!json.includes("5244"), "default openlist url must not leak");
  assert.ok(!json.includes("sekret-pass-123"), "password must not leak");
});

test("an explicit openlist url still yields a transport code, not a setup diagnostic", async () => {
  const backend = await boot({
    openlistUrl: "http://127.0.0.1:1",
    readinessCacheTtlMs: 0,
    env: {
      OPENLIST_URL: "http://127.0.0.1:1",
      OPENLIST_USERNAME: "probe-user",
      OPENLIST_PASSWORD: "",
    },
  });
  const body = await fetchConfigProbe(backend);
  assert.equal(body.status, "degraded");
  assert.equal(body.config.openlist.url, "explicit");
  assert.equal(body.config.openlist.password, "missing");
  assert.equal(body.components.openlist.status, "down");
  assert.equal(body.components.openlist.code, "OPENLIST_UNREACHABLE");
  const codes = body.diagnostics.map((d) => d.code);
  assert.ok(
    !codes.includes("OPENLIST_URL_NOT_CONFIGURED"),
    `configured url must not be reported as unset: ${codes.join(",")}`,
  );
  assert.ok(codes.includes("OPENLIST_PASSWORD_NOT_CONFIGURED"));
});

test("a working source with explicit configuration raises no provisioning diagnostics", async () => {
  const openlistUrl = await startFakeOpenlist("ok");
  const backend = await boot({ openlistUrl, readinessCacheTtlMs: 0 });
  const body = await fetchConfigProbe(backend);
  assert.equal(body.status, "ready");
  assert.deepEqual(body.config.openlist, {
    url: "explicit",
    username: "explicit",
    password: "explicit",
  });
  assert.deepEqual(body.diagnostics, []);
});