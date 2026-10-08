import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { bearerToken, resolveGuestRead, GUEST_HEADER } from "./shared.ts";
import { GuestAccessStore, isGuestReadRoute } from "../guest-access.ts";

function reqWith(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

function reqFor(method: string, path: string, headers: Record<string, string | string[]> = {}, query: Record<string, string> = {}): Request {
  return { method, path, query, headers } as unknown as Request;
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

test("guest reads are limited to the whitelisted route shape", () => {
  assert.equal(isGuestReadRoute("GET", "/api/media/libraries", false), true);
  assert.equal(isGuestReadRoute("HEAD", "/api/media/catalog", false), true);
  assert.equal(isGuestReadRoute("GET", "/api/media/catalog/m1", false), true);
  assert.equal(isGuestReadRoute("GET", "/api/media/posters/m1/", false), true);
  assert.equal(isGuestReadRoute("GET", "/api/media/artwork/m1", false), true);
  // 带 libraryId 才是多源目录浏览；root= 的 legacy 单源浏览器不开给游客。
  assert.equal(isGuestReadRoute("GET", "/api/media/list", false), false);
  assert.equal(isGuestReadRoute("GET", "/api/media/list", true), true);
  assert.equal(isGuestReadRoute("GET", "/api/media/roots", false), false);
  assert.equal(isGuestReadRoute("GET", "/api/media/bangumi/search", false), false);
  assert.equal(isGuestReadRoute("GET", "/api/admin/media-sources", false), false);
  // id 只吃恰好一段：confirm/merge 这类写路由不会被前缀匹配放进来。
  assert.equal(isGuestReadRoute("GET", "/api/media/catalog/m1/confirm", false), false);
  assert.equal(isGuestReadRoute("POST", "/api/media/libraries", false), false);
});

test("room identity and the signing endpoint keep the guest channel out of the way", () => {
  const guests = new GuestAccessStore();
  const issued = guests.issue("203.0.113.7");
  assert.ok(issued);
  const headers = { [GUEST_HEADER]: issued.token };
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", headers), guests), "granted");
  // 没有游客头 → 一律交给原有房间鉴权。
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", {}), guests), "none");
  // 两个头都在：房间身份优先，游客头当噪声。
  assert.equal(
    resolveGuestRead(reqFor("GET", "/api/media/libraries", { ...headers, "x-watchparty-room": "room-1" }), guests),
    "none",
  );
  // 签发口自己不看凭据，否则旧凭据过期会把重签锁死。
  assert.equal(resolveGuestRead(reqFor("POST", "/api/media/guest-session", { [GUEST_HEADER]: "stale" }), guests), "none");
});

test("guest credential state drives 401 vs 403", () => {
  let now = 1_000;
  const guests = new GuestAccessStore({ now: () => now, ttlMs: 500 });
  const issued = guests.issue("203.0.113.7");
  assert.ok(issued);
  const headers = { [GUEST_HEADER]: issued.token };
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/catalog/m1", headers), guests), "granted");
  assert.equal(resolveGuestRead(reqFor("POST", "/api/media/catalog/m1/confirm", headers), guests), "forbidden");
  // 重复头 / 逗号合并头 / 空值：与 bearerToken 同口径失败关闭。
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", { [GUEST_HEADER]: [issued.token, issued.token] }), guests), "malformed");
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", { [GUEST_HEADER]: `${issued.token}, ${issued.token}` }), guests), "malformed");
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", { [GUEST_HEADER]: "   " }), guests), "malformed");
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", { [GUEST_HEADER]: "never-issued" }), guests), "unknown");
  now = 1_501;
  assert.equal(resolveGuestRead(reqFor("GET", "/api/media/libraries", headers), guests), "expired");
});

test("guest signing is capped per caller", () => {
  const guests = new GuestAccessStore({ issueLimit: 2 });
  assert.ok(guests.issue("203.0.113.7"));
  assert.ok(guests.issue("203.0.113.7"));
  assert.equal(guests.issue("203.0.113.7"), undefined);
  // 别的调用方不受这个 IP 的窗口影响。
  assert.ok(guests.issue("203.0.113.8"));
});
