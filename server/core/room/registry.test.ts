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

afterEach(() => { while (registries.length) registries.pop()?.destroyAll(); });

test("creation returns access and owner credentials without exposing room internals", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  assert.equal(registry.get(created.room.id), created.room);
  assert.equal(registry.authenticate(created.room.id, owner, created.accessToken)?.nickname, "Owner");
  assert.equal(registry.isOwner(created.room.id, owner, created.ownerToken), true);
});

test("PIN access is rate limited after five failures", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner", pin: "1234" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(registry.issueAccess(created.room.id, guest, "Guest", "0000", "10.0.0.1"), { ok: false, code: "INVALID_PIN" });
  }
  assert.deepEqual(registry.issueAccess(created.room.id, guest, "Guest", "0000", "10.0.0.1"), { ok: false, code: "RATE_LIMITED" });
  assert.equal(registry.issueAccess(created.room.id, guest, "Guest", "1234", "10.0.0.1").ok, false);
});

test("owner transfer invalidates the old owner token and requires an online target", () => {
  const registry = createRegistry(() => 1);
  const created = registry.create({ clientId: owner, nickname: "Owner" });
  const access = registry.issueAccess(created.room.id, guest, "Guest", undefined, "10.0.0.2");
  assert.equal(access.ok, true);
  created.room.join(owner, "Owner");
  created.room.join(guest, "Guest");
  const transferred = registry.transferOwner(created.room.id, owner, created.ownerToken, guest);
  assert.equal(transferred.ok, true);
  assert.equal(registry.isOwner(created.room.id, owner, created.ownerToken), false);
  assert.equal(registry.isOwner(created.room.id, guest, transferred.ok ? transferred.ownerToken : ""), true);
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
