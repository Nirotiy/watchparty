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
  // Gate 3: a desktop member is a first-class ownership target. The rotation
  // mints a fresh owner token for the target and retires the browser's one.
  const transferred = backend.registry.transferOwner(
    created.roomId,
    created.clientId,
    created.ownerToken,
    desktop.clientId,
  );
  assert.equal(transferred.ok, true);
  assert.ok(transferred.ok && transferred.ownerToken);
  assert.equal(
    backend.registry.get(created.roomId)?.ownerId,
    desktop.clientId,
  );
  const afterTransfer = backend.registry.isOwner(
    created.roomId,
    created.clientId,
    created.ownerToken,
  );
  assert.equal(afterTransfer, false);
});

test("desktop lifecycle creates a native identity without browser handoff", async () => {
  const backend = await boot();
  const clientId = randomUUID();
  const headers = {
    "x-watchparty-client-type": "desktop",
    "x-watchparty-protocol": "2",
    "content-type": "application/json",
  };
  const createdResponse = await fetch(url(backend, "/api/desktop/rooms"), {
    method: "POST", headers,
    body: JSON.stringify({ clientId, nickname: "Native", pin: "1234" }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as {
    roomId: string; clientId: string; accessToken: string; ownerToken: string;
    clientType: string; sessionGeneration: number;
  };
  assert.equal(created.clientId, clientId);
  assert.equal(created.clientType, "desktop");
  assert.equal(created.sessionGeneration, 1);
  assert.ok(created.ownerToken);
  assert.equal(backend.registry.get(created.roomId)?.memberClientType(clientId), "desktop");

  const guestId = randomUUID();
  const accessResponse = await fetch(url(backend, `/api/desktop/rooms/${created.roomId}/access`), {
    method: "POST", headers,
    body: JSON.stringify({ clientId: guestId, nickname: "Guest", pin: "1234" }),
  });
  assert.equal(accessResponse.status, 200);
  const access = await accessResponse.json() as { accessToken: string; clientType: string };
  assert.equal(access.clientType, "desktop");
  assert.ok(access.accessToken);

  const claimResponse = await fetch(url(backend, `/api/rooms/${created.roomId}/desktop/session`), {
    method: "POST",
    headers: { ...headers, "x-watchparty-token": access.accessToken },
  });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json() as { sessionGeneration: number };
  assert.equal(claim.sessionGeneration, 1);
  assert.equal(backend.registry.get(created.roomId)?.memberClientType(guestId), "desktop");
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
