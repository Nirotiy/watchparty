import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createBackend, type Backend } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { RoomMember } from "../core/protocol.ts";

type DesktopRedeem = {
  protocolVersion: number;
  roomId: string;
  clientId: string;
  accessToken: string;
  nickname: string;
  clientType: "desktop";
  sessionGeneration: number;
};

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

async function createRoom(backend: Backend) {
  const clientId = randomUUID();
  const response = await fetch(url(backend, "/api/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, nickname: "Owner" }),
  });
  assert.equal(response.status, 200);
  return {
    clientId,
    ...((await response.json()) as {
      roomId: string;
      accessToken: string;
      ownerToken: string;
    }),
  };
}

async function post(
  backend: Backend,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url(backend, path), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function desktopHeaders(
  token: string,
  generation: number,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-watchparty-client-type": "desktop",
    "x-watchparty-protocol": "2",
    "x-watchparty-session-generation": String(generation),
  };
}

async function redeemDesktop(
  backend: Backend,
  roomId: string,
  browserToken: string,
): Promise<DesktopRedeem> {
  const ticketResponse = await post(
    backend,
    `/api/rooms/${roomId}/handoff`,
    { target: "desktop" },
    { authorization: `Bearer ${browserToken}` },
  );
  assert.equal(ticketResponse.status, 200);
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const response = await post(backend, "/api/desktop/handoff", {
    ticket: ticket.ticket,
  });
  assert.equal(response.status, 200);
  return (await response.json()) as DesktopRedeem;
}

function errorCode(body: unknown): string | undefined {
  const value = body as { code?: string; error?: { code?: string } };
  return value.error?.code ?? value.code;
}

test("desktop handoff issues a separate identity and exposes one typed member", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const desktop = await redeemDesktop(
    backend,
    created.roomId,
    created.accessToken,
  );

  assert.equal(desktop.protocolVersion, 2);
  assert.equal(desktop.clientType, "desktop");
  assert.equal(desktop.nickname, "Desktop");
  assert.equal(desktop.sessionGeneration, 1);
  assert.notEqual(desktop.clientId, created.clientId);
  assert.notEqual(desktop.accessToken, created.accessToken);

  const snapshot = await fetch(
    url(backend, `/api/rooms/${created.roomId}/desktop/snapshot`),
    { headers: desktopHeaders(desktop.accessToken, desktop.sessionGeneration) },
  );
  assert.equal(snapshot.status, 200);
  const members = backend.registry
    .get(created.roomId)
    ?.snapshotMembers() as RoomMember[];
  assert.deepEqual(
    members
      .filter((member) => member.clientId === desktop.clientId)
      .map((member) => member.clientType),
    ["desktop"],
  );
  assert.deepEqual(
    backend.registry.transferOwner(
      created.roomId,
      created.clientId,
      created.ownerToken,
      desktop.clientId,
    ),
    { ok: false, code: "OWNER_TARGET_OFFLINE" },
  );
});

test("desktop and MPV identities cannot cross native routes or handoff targets", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const desktop = await redeemDesktop(
    backend,
    created.roomId,
    created.accessToken,
  );
  const mpvTicketResponse = await post(
    backend,
    `/api/rooms/${created.roomId}/handoff`,
    {},
    { authorization: `Bearer ${created.accessToken}` },
  );
  const mpvTicket = (await mpvTicketResponse.json()) as { ticket: string };
  const mpvResponse = await post(backend, "/api/mpv/handoff", {
    ticket: mpvTicket.ticket,
  });
  const mpv = (await mpvResponse.json()) as { accessToken: string };

  const desktopRoute = `/api/rooms/${created.roomId}/desktop/snapshot`;
  const browserAttempt = await fetch(url(backend, desktopRoute), {
    headers: desktopHeaders(created.accessToken, 1),
  });
  assert.equal(browserAttempt.status, 403);
  const mpvAttempt = await fetch(url(backend, desktopRoute), {
    headers: desktopHeaders(mpv.accessToken, 1),
  });
  assert.equal(mpvAttempt.status, 403);

  const wrongRedeem = await post(backend, "/api/mpv/handoff", {
    ticket: (
      (await (
        await post(
          backend,
          `/api/rooms/${created.roomId}/handoff`,
          { target: "desktop" },
          { authorization: `Bearer ${created.accessToken}` },
        )
      ).json()) as { ticket: string }
    ).ticket,
  });
  assert.equal(wrongRedeem.status, 401);
  assert.equal(errorCode(await wrongRedeem.json()), "HANDOFF_TICKET_INVALID");
  assert.equal(desktop.clientType, "desktop");
});

test("stale desktop generations cannot heartbeat or remove the current member", async () => {
  const backend = await boot();
  const created = await createRoom(backend);
  const desktop = await redeemDesktop(
    backend,
    created.roomId,
    created.accessToken,
  );
  const claim = await post(
    backend,
    `/api/rooms/${created.roomId}/desktop/session`,
    {},
    {
      authorization: `Bearer ${desktop.accessToken}`,
      "x-watchparty-client-type": "desktop",
      "x-watchparty-protocol": "2",
    },
  );
  assert.equal(claim.status, 200);
  const current = (await claim.json()) as { sessionGeneration: number };
  assert.equal(current.sessionGeneration, 2);

  const stale = await fetch(
    url(backend, `/api/rooms/${created.roomId}/desktop/snapshot`),
    { headers: desktopHeaders(desktop.accessToken, desktop.sessionGeneration) },
  );
  assert.equal(stale.status, 409);
  assert.equal(errorCode(await stale.json()), "SESSION_GENERATION_STALE");
  assert.equal(backend.registry.get(created.roomId)?.onlineCount, 1);

  const active = await fetch(
    url(backend, `/api/rooms/${created.roomId}/desktop/snapshot`),
    { headers: desktopHeaders(desktop.accessToken, current.sessionGeneration) },
  );
  assert.equal(active.status, 200);

  const staleDelete = await fetch(
    url(backend, `/api/rooms/${created.roomId}/desktop/session`),
    {
      method: "DELETE",
      headers: desktopHeaders(desktop.accessToken, desktop.sessionGeneration),
    },
  );
  assert.equal(staleDelete.status, 409);
  assert.equal(backend.registry.get(created.roomId)?.onlineCount, 1);

  const activeDelete = await fetch(
    url(backend, `/api/rooms/${created.roomId}/desktop/session`),
    {
      method: "DELETE",
      headers: desktopHeaders(desktop.accessToken, current.sessionGeneration),
    },
  );
  assert.equal(activeDelete.status, 204);
  assert.equal(backend.registry.get(created.roomId)?.onlineCount, 0);
});
