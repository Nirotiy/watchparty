import { createHash, randomBytes } from "node:crypto";

/** `verify` 分三种失败：从未签发过 / 已过期。两者都是 401，但日志要能分辨。 */
export type GuestTokenState = "valid" | "expired" | "unknown";
export type GuestIssue = { token: string; expiresAt: number };
export type GuestAccessOptions = {
  now?: () => number;
  /** 凭据有效期（毫秒）。默认 12 分钟 —— 够逛完一轮墙，又不至于长期有效。 */
  ttlMs?: number;
  /** 同一 IP 在一个窗口内最多签发多少次。默认 30。 */
  issueLimit?: number;
  issueWindowMs?: number;
};

const DEFAULT_TTL_MS = 12 * 60 * 1000;
const DEFAULT_ISSUE_LIMIT = 30;
const DEFAULT_ISSUE_WINDOW_MS = 60_000;

/**
 * 未入房只读浏览用的游客凭据：短时效、只读、不绑定任何房间。
 * 它是房间门禁之外多出来的一条通道，不是房间凭据的替代品 —— 写路由与播放
 * 路由一律不认它（见 `isGuestReadRoute` 与 `guestReadGuard`）。
 */
export class GuestAccessStore {
  private readonly tokens = new Map<string, number>();
  private readonly issueTimes = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly issueLimit: number;
  private readonly issueWindowMs: number;

  constructor(options: GuestAccessOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.issueLimit = options.issueLimit ?? DEFAULT_ISSUE_LIMIT;
    this.issueWindowMs = options.issueWindowMs ?? DEFAULT_ISSUE_WINDOW_MS;
  }

  /** 签一张短期只读凭据（会话内复用、过期重签）；该调用方签发过快时返回 undefined，由路由转 429。 */
  issue(ip: string): GuestIssue | undefined {
    const now = this.now();
    this.prune(now);
    const recent = this.recentIssueTimes(ip, now);
    if (recent.length >= this.issueLimit) return undefined;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.tokens.set(hashToken(token), expiresAt);
    this.issueTimes.set(ip, [...recent, now]);
    return { token, expiresAt };
  }

  /** 校验；过期就顺手回收，所以同一个过期 token 再问一次会成 unknown（两者都是 401）。 */
  verify(token: string): GuestTokenState {
    const expiresAt = this.tokens.get(hashToken(token));
    if (expiresAt === undefined) return "unknown";
    if (expiresAt > this.now()) return "valid";
    this.tokens.delete(hashToken(token));
    return "expired";
  }

  /** 清掉过期凭据与过窗的签发记录；签发时顺带跑，定时器再兜一次。 */
  prune(now = this.now()): void {
    for (const [key, expiresAt] of this.tokens) {
      if (expiresAt <= now) this.tokens.delete(key);
    }
    for (const [ip, times] of this.issueTimes) {
      const recent = times.filter((at) => at > now - this.issueWindowMs);
      if (recent.length === 0) this.issueTimes.delete(ip);
      else this.issueTimes.set(ip, recent);
    }
  }

  private recentIssueTimes(ip: string, now: number): number[] {
    const times = this.issueTimes.get(ip);
    if (!times) return [];
    const recent = times.filter((at) => at > now - this.issueWindowMs);
    if (recent.length === 0) this.issueTimes.delete(ip);
    return recent;
  }
}

/**
 * 游客凭据的只读白名单（变更单 §3.2）。
 *
 * `list` / `search` 只在带 `libraryId` 时开放：不带就是 legacy 单源 root 浏览器
 * （`?root=Anime`），那条路依赖 `GET /api/media/roots`，整体仍只属于房间。
 */
export function isGuestReadRoute(
  method: string,
  path: string,
  libraryScoped: boolean,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const route = path.replace(/\/+$/, "") || "/";
  switch (route) {
    case "/api/media/capabilities":
    case "/api/media/libraries":
    case "/api/media/catalog":
      return true;
    case "/api/media/list":
    case "/api/media/search":
      return libraryScoped;
    default:
      // 只放行恰好一段 id 的详情/图片，`catalog/<id>/confirm` 这类不会命中。
      return /^\/api\/media\/(?:catalog|posters|artwork)\/[^/]+$/.test(route);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
