import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code !== "ENOENT") {
    console.warn("failed to load .env");
  }
}

export type AppConfig = {
  host: string;
  port: number;
  sslKeyFile: string;
  sslCrtFile: string;
  youtubeApiKey: string;
  roomIdleTtlMs: number;
  pruneIntervalMs: number;
  buildDirectory: string;
  nodeEnv: string;
};

function envString(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const raw = env[name];
  return raw == null || raw === "" ? fallback : raw;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Parse core process env. Extra SaaS keys are ignored. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: envString(env, "HOST", "0.0.0.0"),
    port: envNumber(env, "PORT", 8080),
    sslKeyFile: envString(env, "SSL_KEY_FILE", ""),
    sslCrtFile: envString(env, "SSL_CRT_FILE", ""),
    youtubeApiKey: envString(env, "YOUTUBE_API_KEY", ""),
    roomIdleTtlMs: envNumber(env, "ROOM_IDLE_TTL_MS", 8 * 60 * 60 * 1000),
    pruneIntervalMs: envNumber(env, "ROOM_PRUNE_INTERVAL_MS", 60 * 1000),
    buildDirectory: envString(env, "BUILD_DIRECTORY", "build"),
    nodeEnv: envString(env, "NODE_ENV", ""),
  };
}

const config = loadConfig();
export default config;
