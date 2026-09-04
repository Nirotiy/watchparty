import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { bearerToken } from "./shared.ts";

function reqWith(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

test("room token prefers X-WatchParty-Token when both headers are present", () => {
  const req = reqWith({
    "x-watchparty-token": "tok-x",
    authorization: "Bearer tok-legacy",
  });
  assert.equal(bearerToken(req), "tok-x");
});

test("legacy Authorization Bearer still works without the custom header", () => {
  assert.equal(
    bearerToken(reqWith({ authorization: "Bearer tok-legacy" })),
    "tok-legacy",
  );
});

test("invalid X-WatchParty-Token never falls back to Authorization", () => {
  const auth = { authorization: "Bearer tok" };
  // Empty value: fail closed, no legacy fallback.
  assert.equal(bearerToken(reqWith({ "x-watchparty-token": "", ...auth })), undefined);
  // Comma-merged duplicate: fail closed.
  assert.equal(bearerToken(reqWith({ "x-watchparty-token": "a, b", ...auth })), undefined);
  // Repeated header rendered as an array: fail closed.
  assert.equal(
    bearerToken(reqWith({ "x-watchparty-token": ["a", "b"], ...auth })),
    undefined,
  );
  // Whitespace-only value: fail closed.
  assert.equal(bearerToken(reqWith({ "x-watchparty-token": "   ", ...auth })), undefined);
});

test("Authorization without a Bearer scheme is rejected", () => {
  assert.equal(bearerToken(reqWith({ authorization: "Basic dXNlcjpwYXNz" })), undefined);
  assert.equal(bearerToken(reqWith({})), undefined);
});
