import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [destination, publicIp] = process.argv.slice(2);
if (!destination || !path.isAbsolute(destination) || !publicIp || !/^[0-9.]+$/.test(publicIp)) throw new Error("Supply a new absolute configuration directory and IPv4 address");
if (fs.existsSync(destination)) throw new Error("Configuration directory already exists; refusing to rotate credentials");
const local = parseEnv(fs.readFileSync(path.join(repo, ".env"), "utf8"));
if (!local.WATCHPARTY_MEDIA_ID_KEY) throw new Error("Local signing key is not persistent; coordinate migration before generating configuration");
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(destination, "approval"), { mode: 0o700 });
const secret = randomBytes(32).toString("base64url");
const sitePassword = randomBytes(24).toString("base64url");
const approvalPassword = randomBytes(24).toString("base64url");
const salt = randomBytes(16).toString("hex");
const backend = {
  OPENLIST_URL: "http://127.0.0.1:5244",
  OPENLIST_PUBLIC_URL: "https://watchparty.nirotiy.top",
  OPENLIST_USERNAME: local.OPENLIST_USERNAME || "admin",
  OPENLIST_PASSWORD: local.OPENLIST_PASSWORD || "",
  WATCHPARTY_MEDIA_ID_KEY: local.WATCHPARTY_MEDIA_ID_KEY,
  WATCHPARTY_CATALOG_APPROVAL_SECRET: secret,
  WATCHPARTY_MEDIA_PUBLIC_ORIGINS: `https://watchparty.nirotiy.top,https://${publicIp}:8443`,
  ...(local.BANGUMI_TOKEN ? { BANGUMI_TOKEN: local.BANGUMI_TOKEN } : {}),
  ...(local.TMDB_API_KEY ? { TMDB_API_KEY: local.TMDB_API_KEY } : {}),
  ...(local.TMDB_READ_TOKEN ? { TMDB_READ_TOKEN: local.TMDB_READ_TOKEN } : {}),
};
for (const value of Object.values(backend)) if (/[\r\n]/.test(value)) throw new Error("Multiline environment value requires explicit provisioning");
fs.writeFileSync(path.join(destination, "backend.env"), Object.entries(backend).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
fs.writeFileSync(path.join(destination, "approval", "catalog-approval.json"), JSON.stringify({
  backendOrigin: "http://127.0.0.1:18080", frontendOrigin: "https://watchparty.nirotiy.top",
  username: "approval-admin", passwordHash: `${salt}:${scryptSync(approvalPassword, Buffer.from(salt, "hex"), 64).toString("hex")}`, secret,
}), { mode: 0o600, flag: "wx" });
// Operator-only input for hashing on the VPS; never print this file or pass it as argv.
fs.writeFileSync(path.join(destination, "operator-input.json"), JSON.stringify({ siteUsername: "watchparty", sitePassword, approvalUsername: "approval-admin", approvalPassword, approvalSecret: secret }), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ configuration: destination, generated: true, valuesLogged: false }));
