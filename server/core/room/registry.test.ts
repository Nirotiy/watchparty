import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RoomRegistry } from "./registry.ts";

const registries: RoomRegistry[] = [];
const owner = "11111111-1111-4111-8111-111111111111";
const guest = "22222222-2222-4222-8222-222222222222";

function createRegistry(now: () => number, idleTtlMs = 1_000) {
  const registry = new RoomRegistry({ now, idleTtlMs });
  registries.push(registry);
  return registry;
}

afterEach(() => {
  while (registries.length) registries.pop()?.destroyAll();
});

test("creation returns access and owner credentials without exposing room internals", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  assert.equal(registry.get(created.room.id), created.room);
  assert.equal(
    registry.authenticate(created.room.id, owner, created.accessToken)
      ?.nickname,
    "Owner",
  );
  assert.equal(
    registry.isOwner(created.room.id, owner, created.ownerToken),
    true,
  );
});

test("PIN access is rate limited after five failures", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({
    clientId: owner,
    nickname: "Owner",
    pin: "1234",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(
      registry.issueAccess(created.room.id, guest, "Guest", "0000", "10.0.0.1"),
      { ok: false, code: "INVALID_PIN" },
    );
  }
  assert.deepEqual(
    registry.issueAccess(created.room.id, guest, "Guest", "0000", "10.0.0.1"),
    { ok: false, code: "RATE_LIMITED" },
  );
  assert.equal(
    registry.issueAccess(created.room.id, guest, "Guest", "1234", "10.0.0.1")
      .ok,
    false,
  );
});

test("owner transfer invalidates the old owner token and requires an online target", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  const access = registry.issueAccess(
    created.room.id,
    guest,
    "Guest",
    undefined,
    "10.0.0.2",
  );
  assert.equal(access.ok, true);
  created.room.join(owner, "Owner");
  created.room.join(guest, "Guest");
  const transferred = registry.transferOwner(
    created.room.id,
    owner,
    created.ownerToken,
    guest,
  );
  assert.equal(transferred.ok, true);
  assert.equal(
    registry.isOwner(created.room.id, owner, created.ownerToken),
    false,
  );
  assert.equal(
    registry.isOwner(
      created.room.id,
      guest,
      transferred.ok ? transferred.ownerToken : "",
    ),
    true,
  );
});

test("empty rooms are pruned after the idle TTL", () => {
  let now = 10_000;
  const registry = createRegistry(() => now);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  created.room.lastUpdateTime = new Date(0);
  assert.deepEqual(registry.pruneIdle(), [created.room.id]);
  assert.equal(registry.size, 0);
  now += 1;
});

test("handoff tickets are browser-only, one-time and expire", () => {
  let now = 1_000_000;
  const registry = createRegistry(() => now, 8 * 60 * 60 * 1000);
  const created = registry.create({ clientId: owner, nickname: "Owner" });

  const issued = registry.issueHandoffTicket(
    created.room.id,
    created.accessToken,
  );
  assert.ok(issued);
  assert.equal(issued.expiresAt, now + 120_000);

  const redeemed = registry.redeemHandoffTicket(issued.ticket);
  assert.ok(redeemed);
  assert.equal(redeemed.roomId, created.room.id);
  assert.notEqual(redeemed.clientId, owner);
  // One-time: the same ticket can never be redeemed again.
  assert.equal(registry.redeemHandoffTicket(issued.ticket), undefined);

  // The redeemed token authenticates as MPV only, never as a browser member.
  assert.ok(
    registry.authenticateMpvToken(created.room.id, redeemed.accessToken),
  );
  assert.equal(
    registry.authenticateMpvToken(created.room.id, created.accessToken),
    undefined,
  );
  assert.equal(
    registry.authenticate(
      created.room.id,
      redeemed.clientId,
      redeemed.accessToken,
    )?.clientType,
    "mpv",
  );

  // Expired tickets are rejected even on first redemption.
  const second = registry.issueHandoffTicket(
    created.room.id,
    created.accessToken,
  );
  assert.ok(second);
  now += 121_000;
  assert.equal(registry.redeemHandoffTicket(second.ticket), undefined);

  // Unknown / garbage tickets are rejected.
  assert.equal(registry.redeemHandoffTicket("not-a-ticket"), undefined);
  assert.equal(registry.redeemHandoffTicket(""), undefined);
});

test("MPV tokens cannot issue handoff tickets", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  const issued = registry.issueHandoffTicket(
    created.room.id,
    created.accessToken,
  );
  assert.ok(issued);
  const redeemed = registry.redeemHandoffTicket(issued.ticket);
  assert.ok(redeemed);
  assert.equal(
    registry.issueHandoffTicket(created.room.id, redeemed.accessToken),
    undefined,
  );
});

test("stale MPV members are removed from the room when polling stops", () => {
  let now = 1_000_000;
  const registry = createRegistry(() => now, 8 * 60 * 60 * 1000);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  const issued = registry.issueHandoffTicket(
    created.room.id,
    created.accessToken,
  );
  assert.ok(issued);
  const redeemed = registry.redeemHandoffTicket(issued.ticket);
  assert.ok(redeemed);
  created.room.join(redeemed.clientId, "MPV");
  registry.touchMpvClient(created.room.id, redeemed.clientId);
  assert.equal(created.room.onlineCount, 1);

  // Fresh heartbeat keeps the member alive across prunes.
  now += 60_000;
  registry.pruneIdle();
  assert.equal(created.room.onlineCount, 1);

  // Silence beyond the stale window drops the MPV member.
  now += 121_000;
  registry.pruneIdle();
  assert.equal(created.room.onlineCount, 0);
});
