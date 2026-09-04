import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { createBackend } from "../../server/app.ts";
import { loadConfig } from "../../server/config.ts";

const MEDIA_KEY = "desktop-vertical-test-key";
const mediaPath = "/media/openlist-bdyun/Multimedia/Anime/Vertical 01.mp4";
const fixture = resolve("dev/mpv-e2e/short.mp4");
const fixtureSize = statSync(fixture).size;
let openlistPort = 0;
let directRequests = 0;
let rangeRequests = 0;

type Ack = { ok: boolean; revision?: number; error?: { code?: string } };
type Snapshot = {
  revision: number;
  currentPlaylistItemId?: string;
  playlist: Array<{ id: string }>;
};

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server did not bind"));
      else resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

function command(socket: ReturnType<typeof io>, event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolveAck) => socket.emit(event, payload, resolveAck));
}

function serveMedia(request: IncomingMessage, response: ServerResponse): void {
  directRequests += 1;
  if (request.headers["user-agent"] !== "pan.baidu.com") {
    response.writeHead(403).end();
    return;
  }
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", "video/mp4");
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { "content-length": fixtureSize });
    createReadStream(fixture).pipe(response);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416).end();
    return;
  }
  rangeRequests += 1;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), fixtureSize - 1) : fixtureSize - 1;
  response.writeHead(206, {
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${fixtureSize}`,
  });
  createReadStream(fixture, { start, end }).pipe(response);
}

const openlist = createServer((request, response) => {
  const pathname = (request.url ?? "").split("?")[0];
  if (pathname === "/d/direct.mp4" || pathname === "/p/clip.mp4") {
    serveMedia(request, response);
    return;
  }
  response.setHeader("content-type", "application/json");
  if (pathname === "/api/auth/login") {
    response.end(JSON.stringify({ code: 200, data: { token: "stub-token" } }));
  } else if (pathname === "/api/fs/list") {
    response.end(
      JSON.stringify({
        code: 200,
        data: { content: [{ name: "Vertical 01.mp4", is_dir: false, size: fixtureSize, path: mediaPath }] },
      }),
    );
  } else if (pathname === "/api/fs/get") {
    request.resume();
    request.on("end", () =>
      response.end(
        JSON.stringify({
          code: 200,
          data: { raw_url: `http://127.0.0.1:${openlistPort}/p/clip.mp4`, size: fixtureSize },
        }),
      ),
    );
  } else if (pathname === "/api/fs/link") {
    request.resume();
    request.on("end", () =>
      response.end(
        JSON.stringify({
          code: 200,
          data: {
            url: `http://127.0.0.1:${openlistPort}/d/direct.mp4`,
            header: { "User-Agent": "pan.baidu.com" },
          },
        }),
      ),
    );
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404 }));
  }
});

let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
let owner: ReturnType<typeof io> | undefined;
let desktopChild: ReturnType<typeof spawn> | undefined;
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
  const created = (await createdResponse.json()) as {
    roomId: string;
    accessToken: string;
    ownerToken: string;
  };
  const directoryResponse = await fetch(`${origin}/api/media/list?root=Anime`);
  const directory = (await directoryResponse.json()) as {
    items?: Array<{ name: string; id: string }>;
  };
  const mediaId = directory.items?.find((item) => item.name === "Vertical 01.mp4")?.id;
  if (!mediaId) throw new Error("signed media id missing");

  let snapshot: Snapshot | undefined;
  owner = io(origin, {
    transports: ["websocket"],
    auth: {
      roomId: created.roomId,
      clientId,
      accessToken: created.accessToken,
      ownerToken: created.ownerToken,
      clientProtocol: 2,
    },
  });
  owner.on("REC:snapshot", (value: Snapshot) => {
    snapshot = value;
  });
  await new Promise<void>((resolveConnect, reject) => {
    owner!.once("connect", resolveConnect);
    owner!.once("connect_error", reject);
  });
  while (!snapshot) await new Promise((resolveWait) => setTimeout(resolveWait, 10));

  const run = async (event: string, payload: Record<string, unknown>): Promise<Ack> => {
    const ack = await command(owner!, event, { ...payload, expectedRevision: snapshot!.revision });
    if (!ack.ok) throw new Error(`${event} failed: ${ack.error?.code ?? "unknown"}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    return ack;
  };
  await run("CMD:lock", { locked: false });
  const media = { kind: "openlist", mediaId, title: "Vertical 01", container: "mp4" };
  await run("CMD:playlistAdd", { media });
  await run("CMD:playlistAdd", { media });
  const firstItemId = snapshot.playlist[0]?.id;
  if (!firstItemId) throw new Error("first playlist item missing");
  await run("CMD:playlistPlay", { itemId: firstItemId });

  const ticketResponse = await fetch(`${origin}/api/rooms/${created.roomId}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-WatchParty-Token": created.accessToken },
    body: JSON.stringify({ target: "desktop" }),
  });
  if (!ticketResponse.ok) throw new Error(`ticket issue failed: ${ticketResponse.status}`);
  const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;

  const child = spawn(
    "cargo",
    ["run", "--quiet", "--bin", "desktop-vertical-smoke"],
    {
      cwd: resolve("src-tauri"),
      env: {
        ...process.env,
        WATCHPARTY_BACKEND_ORIGIN: origin,
        WATCHPARTY_LIBMPV_PATH:
          process.env.WATCHPARTY_LIBMPV_PATH ??
          resolve(process.env.LOCALAPPDATA ?? "", "WatchParty/runtime/libmpv-2.dll"),
        DESKTOP_VERTICAL_TICKET: ticket,
        DESKTOP_VERTICAL_ROOM_ID: created.roomId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  desktopChild = child;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const readyDeadline = Date.now() + 45_000;
  while (!stdout.includes("WATCHPARTY_VERTICAL_READY_FOR_REMOTE")) {
    if (Date.now() >= readyDeadline) throw new Error(`desktop did not become ready\n${stdout}\n${stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  await run("CMD:pause", {});
  await run("CMD:seek", { positionSeconds: 1.0 });
  await run("CMD:rate", { rate: 1.25 });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0 || !stdout.includes("WATCHPARTY_VERTICAL_PASS")) {
    throw new Error(`desktop vertical smoke failed (${exitCode})\n${stdout}\n${stderr}`);
  }
  if (directRequests === 0 || rangeRequests === 0) {
    throw new Error(`native media requests missing: direct=${directRequests} range=${rangeRequests}`);
  }

  const roomResponse = await fetch(`${origin}/api/rooms/${created.roomId}`);
  const roomInfo = (await roomResponse.json()) as { onlineCount: number };
  if (roomInfo.onlineCount !== 1) throw new Error(`desktop cleanup failed: ${roomInfo.onlineCount}`);
  console.log(stdout.trim());
  console.log(`Desktop vertical integration: PASS (direct=${directRequests}, range=${rangeRequests})`);
} finally {
  if (desktopChild?.exitCode === null) desktopChild.kill();
  owner?.disconnect();
  if (backend) await backend.close();
  await close(openlist);
}
