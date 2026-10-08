// Requires the loopback-only scenario backend. Uses actual Next Socket adapter.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { WatchPartySocket } from "../../lib/socket.ts";

const fixture = await (await fetch("http://127.0.0.1:18981/__fixture")).json();
const previous = process.env.NEXT_PUBLIC_SOCKET_ORIGIN;
process.env.NEXT_PUBLIC_SOCKET_ORIGIN = "http://127.0.0.1:18981";
let received = 0;
let resolveInitial;
const initial = new Promise((resolve) => { resolveInitial = resolve; });
const socket = new WatchPartySocket({ roomId: fixture.room.roomId, clientId: fixture.ownerId, accessToken: fixture.room.accessToken,
  onSnapshot: (value) => { received++; resolveInitial(value); }, onMembers: () => {}, onError: (error) => console.log(error) });
const result = { startedAt: new Date().toISOString(), scope: "Actual web/lib/socket.ts and real loopback backend, no room mutation." };
let initialTimer;
try {
  socket.connect();
  await Promise.race([initial, new Promise((_, reject) => { initialTimer = setTimeout(() => reject(Error("Initial snapshot timeout")), 5000); })]);
  clearTimeout(initialTimer);
  const count = received;
  const snapshot = await socket.refreshSnapshot();
  assert.ok(received > count);
  assert.equal(snapshot.revision, fixture.snapshot.revision);
  assert.deepEqual(snapshot.playlist, fixture.snapshot.playlist);
  result.pass = true; result.received = received; result.revision = snapshot.revision;
} finally {
  clearTimeout(initialTimer);
  socket.disconnect();
  if (previous === undefined) delete process.env.NEXT_PUBLIC_SOCKET_ORIGIN; else process.env.NEXT_PUBLIC_SOCKET_ORIGIN = previous;
  await writeFile("web/tests/results/socket-snapshot-2026-10-08.json", JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
