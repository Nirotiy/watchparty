import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { createBackend } from "../../server/app.ts";
import { loadConfig } from "../../server/config.ts";

const MEDIA_KEY = "desktop-http-test-key";
const mediaPath = "/media/openlist-bdyun/Multimedia/Anime/Show 01.mp4";
let mediaId = "";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("stub server did not bind"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function socketCommand(socket: ReturnType<typeof io>, event: string, payload: unknown): Promise<{ ok: boolean; revision?: number; error?: unknown }> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function runCargo(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", ["test", "--test", "http_transport", "--", "--ignored", "--nocapture"], {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`cargo integration exited with ${code ?? signal}`));
    });
  });
}


const openlist = createServer((request, response) => {
  const pathname = (request.url ?? "").split("?")[0];
  response.setHeader("content-type", "application/json");
  if (pathname === "/api/auth/login") {
    response.end(JSON.stringify({ code: 200, data: { token: "stub-token" } }));
    return;
  }
  if (pathname === "/api/fs/list" || pathname === "/api/fs/search") {
    response.end(JSON.stringify({ code: 200, data: { content: [{ name: "Show 01.mp4", is_dir: false, size: 10, path: mediaPath }] } }));
    return;
  }
  if (pathname === "/api/fs/get") {
    request.resume();
    request.on("end", () => response.end(JSON.stringify({ code: 200, data: { raw_url: `http://127.0.0.1:${openlistPort}/p/clip.mp4`, size: 10 } })));
    return;
  }
  if (pathname === "/api/fs/link") {
    request.resume();
    request.on("end", () => response.end(JSON.stringify({ code: 200, data: { url: `http://127.0.0.1:${openlistPort}/d/direct.mp4`, header: { "User-Agent": "pan.baidu.com" } } })));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ code: 404 }));
});

let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
let ownerSocket: ReturnType<typeof io> | undefined;
let openlistPort: number | undefined;
try {
  openlistPort = await listen(openlist);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    OPENLIST_URL: `http://127.0.0.1:${openlistPort}`,
    OPENLIST_PUBLIC_URL: `http://127.0.0.1:${openlistPort}`,
    OPENLIST_USERNAME: "test-user",
    OPENLIST_PASSWORD: "test-password",
    WATCHPARTY_MEDIA_ID_KEY: MEDIA_KEY,
  });
  backend = createBackend({ host: "127.0.0.1", port: 0, pruneIntervalMs: 0, serveStatic: false, config });
  await backend.start();
  const origin = `http://127.0.0.1:${backend.port}`;
  const clientId = randomUUID();
  const createdResponse = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, nickname: "Owner" }),
  });
  if (!createdResponse.ok) throw new Error(`room creation failed: ${createdResponse.status}`);
  const created = await createdResponse.json() as { roomId: string; accessToken: string; ownerToken: string };
  const directoryResponse = await fetch(`${origin}/api/media/list?root=Anime`);
  if (!directoryResponse.ok) throw new Error(`media list failed: ${directoryResponse.status}`);
  const directory = await directoryResponse.json() as { items?: Array<{ name: string; id: string }> };
  mediaId = directory.items?.find((item) => item.name === "Show 01.mp4")?.id ?? "";
  if (!mediaId) throw new Error("media list did not return a signed media id");

  ownerSocket = io(origin, {
    transports: ["websocket"],
    auth: { roomId: created.roomId, clientId, accessToken: created.accessToken, ownerToken: created.ownerToken, clientProtocol: 2 },
  });
  await new Promise<void>((resolve, reject) => {
    ownerSocket!.once("connect", resolve);
    ownerSocket!.once("connect_error", reject);
  });
  const unlocked = await socketCommand(ownerSocket, "CMD:lock", { locked: false, expectedRevision: 0 });
  if (!unlocked.ok) throw new Error("could not unlock test room");
  const mediaSet = await socketCommand(ownerSocket, "CMD:mediaSet", {
    media: { kind: "openlist", mediaId, title: "Show 01", container: "mp4" },
    expectedRevision: unlocked.revision,
  });
  if (!mediaSet.ok) throw new Error("could not set test media");

  const ticketResponse = await fetch(`${origin}/api/rooms/${created.roomId}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.accessToken}` },
    body: JSON.stringify({ target: "desktop" }),
  });
  if (!ticketResponse.ok) throw new Error(`ticket issue failed: ${ticketResponse.status}`);
  const ticket = (await ticketResponse.json() as { ticket: string }).ticket;

  const env = {
    ...process.env,
    DESKTOP_HTTP_BASE_URL: origin,
    DESKTOP_HTTP_TICKET: ticket,
    DESKTOP_HTTP_ROOM_ID: created.roomId,
    DESKTOP_HTTP_MEDIA_ID: mediaId,
    DESKTOP_HTTP_OPENLIST_PORT: String(openlistPort),  };
  await runCargo(
    new URL("../", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)),
    env,
  );
  console.log("DesktopHttpTransport live Node integration: PASS");
} finally {
  ownerSocket?.disconnect();
  if (backend) await backend.close();
  if (openlistPort !== undefined) await close(openlist);
}
