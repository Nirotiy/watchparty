import { randomUUID } from "node:crypto";
import { DESKTOP_SERVICE_VERSION, PROTOCOL_VERSION } from "../protocol.ts";
import type { ConfigStatus } from "../../config.ts";
import type {
  MediaHealth,
  MediaHealthCode,
  MediaRootProbe,
  WatchpartyMedia,
} from "../../media/watchparty-media.ts";

/**
 * Readiness contract for the desktop setup guide (readinessVersion 1).
 *
 * This endpoint answers "can this backend serve content right now?" without
 * credentials. The HTTP status is always 200 while the process itself is up:
 * fetch failures (backend down / wrong origin) and 426 (protocol mismatch)
 * are the shell's signals, and `status`/diagnostic codes carry the rest.
 */
export const READINESS_VERSION = 1 as const;

export const DEFAULT_READINESS_CACHE_TTL_MS = 5_000;

/**
 * Stable remediation hints. `CHECK_BACKEND_ORIGIN`, `UPGRADE_CLIENT` and
 * `START_BANGURU_BACKEND` are never emitted by the server (it must be up to
 * answer); they belong to the shell for fetch-failure / 426 cases and are
 * listed here so both sides share one enum.
 */
export type RemediationCode =
  | "START_BANGURU_BACKEND"
  | "CHECK_BACKEND_ORIGIN"
  | "UPGRADE_CLIENT"
  | "CHECK_OPENLIST_URL"
  | "CHECK_OPENLIST_TIMEOUT"
  | "CHECK_OPENLIST_CREDENTIALS"
  | "CHECK_MEDIA_ROOTS"
  | "OPENLIST_URL_SETUP"
  | "OPENLIST_CREDENTIALS_SETUP";

export type ListenerInfo = {
  host: string;
  configuredPort: number;
  boundPort: number;
  secure: boolean;
};

export type ReadinessDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  remediation?: RemediationCode;
};

export type ReadinessSnapshot = {
  status: "ready" | "degraded";
  service: "watchparty";
  protocolVersion: typeof PROTOCOL_VERSION;
  serviceVersion: typeof DESKTOP_SERVICE_VERSION;
  readinessVersion: typeof READINESS_VERSION;
  bootId: string;
  startedAt: number;
  checkedAt: number;
  listener: ListenerInfo;
  cache: { ttlMs: number; ageMs: number; fromCache: boolean };
  config: ConfigStatus;
  components: {
    core: { status: "up" };
    openlist: {
      status: "up" | "down";
      code: MediaHealthCode;
      latencyMs: number;
      message?: string;
      remediation?: RemediationCode;
    };
    mediaRoots?: {
      status: "up" | "down";
      roots: MediaRootProbe[];
    };
  };
  diagnostics: ReadinessDiagnostic[];
};

const OPENLIST_REMEDIATION: Record<
  MediaHealthCode,
  RemediationCode | undefined
> = {
  OPENLIST_OK: undefined,
  OPENLIST_UNREACHABLE: "CHECK_OPENLIST_URL",
  OPENLIST_TIMEOUT: "CHECK_OPENLIST_TIMEOUT",
  OPENLIST_AUTH_FAILED: "CHECK_OPENLIST_CREDENTIALS",
  OPENLIST_BAD_RESPONSE: "CHECK_OPENLIST_URL",
};

type CoreResult = {
  status: ReadinessSnapshot["status"];
  components: ReadinessSnapshot["components"];
  diagnostics: ReadinessDiagnostic[];
  checkedAt: number;
};

/** The readiness surface exposes provisioning enums only, never values. */

/**
 * When the media source is down, "nobody ever set this" is a more actionable
 * diagnosis than "unreachable", so say it explicitly instead of leaving the
 * generic transport code alone. Emitted only on the failure path: a working
 * default must not nag the operator.
 */
function unconfiguredDiagnostics(config: ConfigStatus): ReadinessDiagnostic[] {
  const { url, username, password } = config.openlist;
  const diagnostics: ReadinessDiagnostic[] = [];
  if (url !== "explicit") {
    diagnostics.push({
      severity: "error",
      code: "OPENLIST_URL_NOT_CONFIGURED",
      message:
        url === "default"
          ? "OPENLIST_URL is unset; the backend is probing its built-in default address"
          : "OPENLIST_URL has no value",
      remediation: "OPENLIST_URL_SETUP",
    });
  }
  if (password === "missing") {
    diagnostics.push({
      severity: "error",
      code: "OPENLIST_PASSWORD_NOT_CONFIGURED",
      message:
        "OPENLIST_PASSWORD is unset, so the media source cannot authenticate",
      remediation: "OPENLIST_CREDENTIALS_SETUP",
    });
  }
  if (username !== "explicit") {
    diagnostics.push({
      severity: "warning",
      code: "OPENLIST_USERNAME_DEFAULTED",
      message:
        "OPENLIST_USERNAME is unset; the backend is using its built-in default account",
      remediation: "OPENLIST_CREDENTIALS_SETUP",
    });
  }
  return diagnostics;
}

function coreFromHealth(
  health: MediaHealth,
  config: ConfigStatus,
): CoreResult {
  const checkedAt = Date.now();
  const coreComponent = { status: "up" as const };
  if (!health.ok) {
    const remediation = OPENLIST_REMEDIATION[health.code];
    const diagnostics: ReadinessDiagnostic[] = [
      ...unconfiguredDiagnostics(config),
      {
        severity: "error",
        code: health.code,
        message: health.detail ?? "OpenList media source is not ready",
        ...(remediation ? { remediation } : {}),
      },
    ];
    const openlist: ReadinessSnapshot["components"]["openlist"] = {
      status: "down",
      code: health.code,
      latencyMs: health.latencyMs,
      ...(remediation ? { remediation } : {}),
      ...(health.detail ? { message: health.detail } : {}),
    };
    return {
      status: "degraded",
      components: { core: coreComponent, openlist },
      diagnostics,
      checkedAt,
    };
  }
  const openlist: ReadinessSnapshot["components"]["openlist"] = {
    status: "up",
    code: "OPENLIST_OK",
    latencyMs: health.latencyMs,
  };
  const failedRoots = health.roots.filter((root) => !root.ok);
  const mediaRoots: ReadinessSnapshot["components"]["mediaRoots"] = {
    status: failedRoots.length === 0 ? "up" : "down",
    roots: health.roots,
  };
  const diagnostics: ReadinessDiagnostic[] = failedRoots.map((root) => ({
    severity: "error" as const,
    code: root.code,
    message: `media root "${root.name}" is not reachable`,
    remediation: "CHECK_MEDIA_ROOTS" as const,
  }));
  return {
    status: failedRoots.length === 0 ? "ready" : "degraded",
    components: { core: coreComponent, openlist, mediaRoots },
    diagnostics,
    checkedAt,
  };
}
export type ReadinessProbeOptions = {
  media: WatchpartyMedia;
  /** Non-sensitive provisioning facts (enums, never values). */
  configStatus: () => ConfigStatus;
  /** 0 disables caching; single-flight de-duplication always applies. */
  ttlMs?: number;
};

export type ReadinessProbe = {
  snapshot(listener: ListenerInfo): Promise<ReadinessSnapshot>;
  readonly bootId: string;
  readonly startedAt: number;
  readonly ttlMs: number;
};

/**
 * readiness probe with a short TTL cache and single-flight de-duplication so
 * a polling setup wizard can never stampede OpenList.
 */
export function createReadinessProbe(
  options: ReadinessProbeOptions,
): ReadinessProbe {
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  const bootId = randomUUID();
  const startedAt = Date.now();
  let cached: CoreResult | null = null;
  let inflight: Promise<CoreResult & { fromCache: boolean }> | null = null;

  async function probeCore(): Promise<CoreResult> {
    return coreFromHealth(
      await options.media.checkHealth(),
      options.configStatus(),
    );
  }

  function core(): Promise<CoreResult & { fromCache: boolean }> {
    if (cached && ttlMs > 0 && Date.now() - cached.checkedAt < ttlMs) {
      return Promise.resolve({ ...cached, fromCache: true });
    }
    inflight ??= probeCore()
      .then((value) => {
        cached = ttlMs > 0 ? value : null;
        inflight = null;
        return { ...value, fromCache: false };
      })
      .catch((error: unknown) => {
        inflight = null;
        throw error;
      });
    return inflight;
  }

  return {
    bootId,
    startedAt,
    ttlMs,
    async snapshot(listener: ListenerInfo): Promise<ReadinessSnapshot> {
      const { fromCache, ...result } = await core();
      return {
        status: result.status,
        service: "watchparty",
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: DESKTOP_SERVICE_VERSION,
        readinessVersion: READINESS_VERSION,
        bootId,
        startedAt,
        checkedAt: result.checkedAt,
        listener,
        cache: {
          ttlMs,
          ageMs: Math.max(0, Date.now() - result.checkedAt),
          fromCache,
        },
        config: options.configStatus(),
        components: result.components,
        diagnostics: result.diagnostics,
      };
    },
  };
}