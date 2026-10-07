import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prints ONLY the signed media URL for one manifest sample index (stdout, single line).
// Usage: node verify/sign-url.mjs <sampleIndex>
const openListOrigin = "http://127.0.0.1:5349";
const credentialsPath = "C:\\Users\\Nirotiy\\Documents\\openlist_credentials.json";
const sampleRoot = "/media/openlist-bdyun/Multimedia/";
const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../ffprobe-sample-20260904/sample-manifest-current.json");

const sampleIndex = Number(process.argv[2]);
if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 1) throw new Error("Pass a sampleIndex >= 1");

const credentials = parseCredentials(await readFile(credentialsPath, "utf8"));
const token = await loginOpenList(credentials);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sample = manifest.find((entry) => entry.sampleIndex === sampleIndex);
if (!sample?.relativePath) throw new Error(`Manifest has no sampleIndex ${sampleIndex}`);
const result = await postOpenList("/api/fs/get", { path: `${sampleRoot}${sample.relativePath}` }, token);
const rawUrl = result.data?.raw_url;
const size = Number(result.data?.size);
if (result.code !== 200 || typeof rawUrl !== "string" || !Number.isSafeInteger(size) || size <= 0) {
  throw new Error("OpenList did not return a signed media URL and file size");
}
process.stderr.write(`sample ${sampleIndex}: ${sample.relativePath} (${size} bytes)\n`);
process.stdout.write(`${rawUrl}\n`);

function parseCredentials(source) {
  try {
    return JSON.parse(source);
  } catch {
    return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? ["", ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }).filter(([key, value]) => key && value));
  }
}

async function loginOpenList(credentials) {
  if (!credentials.username || !credentials.password) throw new Error("OpenList credentials file is incomplete");
  const result = await postOpenList("/api/auth/login", {
    username: credentials.username,
    password: credentials.password,
  });
  if (result.code !== 200 || !result.data?.token) throw new Error("OpenList login failed");
  return result.data.token;
}

async function postOpenList(route, body, token) {
  const response = await fetch(`${openListOrigin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenList request failed with HTTP ${response.status}`);
  return response.json();
}
