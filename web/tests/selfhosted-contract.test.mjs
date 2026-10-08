import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import { build } from "esbuild";
import ts from "typescript";
import { test } from "node:test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

async function bundleModule(entryPoint, directory, platform = "node") {
  const result = await build({
    absWorkingDir: webRoot,
    alias: { "@": webRoot },
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    outfile: "bundle.mjs",
    platform,
    write: false,
  });
  const file = path.join(directory, `${entryPoint.replace(/[^a-zA-Z0-9]+/g, "_")}.mjs`);
  await writeFile(file, result.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}

test("Next approval route settings and signed issuance forward to the backend contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchparty-next-contract-"));
  const previousConfigPath = process.env.WATCHPARTY_APPROVAL_CONFIG_FILE;
  const secret = randomBytes(24).toString("base64url");
  const replacement = randomBytes(24).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16);
  const configPath = path.join(directory, "approval.json");
  const upstreamRequests = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({
      url: request.url,
      method: request.method,
      approval: request.headers["x-watchparty-approval"],
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ approvalToken: "one-time-token" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  try {
    process.env.WATCHPARTY_APPROVAL_CONFIG_FILE = configPath;
    await writeFile(configPath, JSON.stringify({
      backendOrigin: `http://127.0.0.1:${upstream.address().port}`,
      frontendOrigin: "http://127.0.0.1:3011",
      username: "human",
      passwordHash: `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`,
      secret,
    }));

    const settings = await bundleModule("app/api/catalog-approval/settings/route.ts", directory);
    const issuance = await bundleModule("app/api/catalog-approval/libraries/[libraryId]/approval/route.ts", directory);
    const authorization = `Basic ${Buffer.from(`human:${password}`).toString("base64")}`;
    const request = (method, body) => new Request("http://localhost:3011/api/catalog-approval/settings", {
      method,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3011",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const initial = await settings.GET(request("GET"));
    assert.deepEqual(await initial.json(), { configured: true, mask: "••••••••" });
    assert.equal(initial.headers.get("cache-control"), "no-store");

    const saved = await settings.POST(request("POST", { secret: replacement }));
    assert.deepEqual(await saved.json(), { configured: true, mask: "••••••••" });

    const issued = await issuance.POST(request("POST", { approvedBy: "ignored-by-server" }), {
      params: Promise.resolve({ libraryId: "lib_test" }),
    });
    assert.equal(issued.status, 200);
    assert.deepEqual(await issued.json(), { approvalToken: "one-time-token" });
    assert.deepEqual(upstreamRequests, [{
      url: "/api/admin/media-libraries/lib_test/approval",
      method: "POST",
      approval: replacement,
      authorization: undefined,
      body: { approvedBy: "网页" },
    }]);
  } finally {
    if (previousConfigPath === undefined) delete process.env.WATCHPARTY_APPROVAL_CONFIG_FILE;
    else process.env.WATCHPARTY_APPROVAL_CONFIG_FILE = previousConfigPath;
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Next API client keeps its production HTTP route and method contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchparty-next-api-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    const { api } = await bundleModule("lib/api.ts", directory, "browser");
    globalThis.fetch = async (input, init = {}) => {
      calls.push({
        path: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body,
      });
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await api.approvalSecretStatus();
    await api.setApprovalSecret("secret-value");
    await api.catalogApproval("lib_test");
    await api.createRoom({ clientId: "client" });
    await api.getRoomInfo("room id");
    await api.accessRoom("room id", { clientId: "client" });
    await api.resolveMedia("room id", "media-id", "room-token");
    await api.getSubtitleTracks("room id", "media-id", "room-token");
    await api.getSubtitleContent("room id", "subtitle-id", "room-token");
    await api.issueHandoffTicket("room id", "room-token", "desktop");

    assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
      ["/api/catalog-approval/settings", "GET"],
      ["/api/catalog-approval/settings", "POST"],
      ["/api/catalog-approval/libraries/lib_test/approval", "POST"],
      ["/api/rooms", "POST"],
      ["/api/rooms/room%20id", "GET"],
      ["/api/rooms/room%20id/access", "POST"],
      ["/api/rooms/room%20id/media/resolve", "POST"],
      ["/api/rooms/room%20id/media/subtitles?mediaId=media-id", "GET"],
      ["/api/rooms/room%20id/media/subtitle?mediaId=subtitle-id", "GET"],
      ["/api/rooms/room%20id/handoff", "POST"],
    ]);
    for (const index of [6, 7, 8, 9]) assert.equal(calls[index].headers.get("x-watchparty-token"), "room-token");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

function interfaceEvents(source, name) {
  const file = ts.createSourceFile("protocol.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name);
  assert.ok(declaration, `missing ${name}`);
  return declaration.members
    .map((member) => member.name?.text)
    .filter((event) => typeof event === "string");
}

function socketCalls(source, method, prefix) {
  const file = ts.createSourceFile("socket.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const events = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text.startsWith(prefix)) {
      events.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...events].sort();
}

test("Next Socket.IO event names match the backend protocol", async () => {
  const [webSocket, backendProtocol] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(path.join(webRoot, "lib/socket.ts"), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(path.join(repoRoot, "server/core/protocol.ts"), "utf8")),
  ]);
  assert.deepEqual(socketCalls(webSocket, "emitCommand", "CMD:"), interfaceEvents(backendProtocol, "ClientToServerEvents").sort());
  assert.deepEqual(socketCalls(webSocket, "on", "REC:"), interfaceEvents(backendProtocol, "ServerToClientEvents").sort());
});
