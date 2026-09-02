import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RoomRegistry } from "./registry.ts";

const registries: RoomRegistry[] = [];

function createRegistry(now: () => number, idleTtlMs = 1000): RoomRegistry {
  const registry = new RoomRegistry({ now, idleTtlMs });
  registries.push(registry);
  return registry;
}

afterEach(() => {
  while (registries.length) {
    registries.pop()?.destroyAll();
  }
});

test("create stores a room that get can load", () => {
  const registry = createRegistry(() => 1);
  const room = registry.create("/r1");
  assert.equal(registry.size, 1);
  assert.equal(registry.get("/r1"), room);
  assert.equal(room.id, "/r1");
});

test("empty idle rooms are unloaded using injected clock", () => {
  let now = 10_000;
  const registry = createRegistry(() => now, 1000);
  const room = registry.create("/idle");
  room.lastUpdateTime = new Date(0);
  const unloaded = registry.pruneIdle();
  assert.deepEqual(unloaded, ["/idle"]);
  assert.equal(registry.size, 0);
});

test("occupied rooms are not unloaded even if lastUpdateTime is old", () => {
  const registry = createRegistry(() => 50_000, 1000);
  const room = registry.create("/busy");
  room.join("c1");
  room.lastUpdateTime = new Date(0);
  registry.pruneIdle();
  assert.equal(registry.size, 1);
});

test("empty rooms that are still fresh stay in memory", () => {
  const now = 50_000;
  const registry = createRegistry(() => now, 10_000);
  const room = registry.create("/fresh");
  room.lastUpdateTime = new Date(now);
  registry.pruneIdle();
  assert.equal(registry.size, 1);
});
