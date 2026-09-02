import type { Express } from "express";
import { makeRoomName, makeUserName } from "../../utils/moniker.ts";
import { searchYoutube, youtubePlaylist } from "../../media/youtube.ts";
import type { Room } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";

/** Core HTTP whitelist used by the Vite UI. */
export function registerCoreHttp(app: Express, registry: RoomRegistry): void {
  app.get("/ping", (_req, res) => {
    res.json("pong");
  });

  app.post("/createRoom", (req, res) => {
    const name = "/" + makeRoomName();
    const password =
      typeof req.body?.password === "string" ? req.body.password : undefined;
    let newRoom: Room;
    try {
      newRoom = registry.create(name, { password });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid room",
      });
      return;
    }
    console.log("created room %s", name);
    const preload = String(req.body?.video ?? "").slice(0, 20000);
    if (preload) {
      newRoom.apply("", { type: "host", url: preload });
      newRoom.apply("", { type: "pause" });
    }
    const prePlaylist = Array.isArray(req.body?.playlist)
      ? req.body.playlist
      : [];
    for (const item of prePlaylist) {
      const url = typeof item === "string" ? item : item?.url;
      if (url) {
        newRoom.apply("", { type: "playlistAdd", url: String(url) });
      }
    }
    res.json({ name, isProtected: registry.isProtected(name) });
  });

  app.get("/roomInfo/:roomId", (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const room = registry.get(roomId);
    res.json({
      roomId: roomId.slice(1),
      exists: Boolean(room),
      isProtected: registry.isProtected(roomId),
      onlineCount: room?.roster.length ?? 0,
    });
  });

  app.post("/verifyRoomPin", (req, res) => {
    const roomId = normalizeRoomId(req.body?.roomId);
    const room = registry.get(roomId);
    if (!room) {
      res.status(404).json({ valid: false, error: "Room not found" });
      return;
    }
    if (!registry.isProtected(roomId)) {
      res.json({ valid: true });
      return;
    }
    const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
    const token = registry.verifyPin(roomId, pin);
    if (!token) {
      res.status(401).json({ valid: false, error: "Invalid PIN" });
      return;
    }
    res.json({ valid: true, token });
  });

  app.get("/youtube", async (req, res) => {
    if (typeof req.query.q !== "string") {
      res.status(500).json({ error: "query must be a string" });
      return;
    }
    try {
      const items = await searchYoutube(req.query.q);
      res.json(items);
    } catch {
      res.status(500).json({ error: "youtube error" });
    }
  });

  app.get("/youtubePlaylist/:playlistId", async (req, res) => {
    try {
      const items = await youtubePlaylist(req.params.playlistId);
      res.json(items);
    } catch {
      res.status(500).json({ error: "youtube error" });
    }
  });

  app.get("/generateName", (_req, res) => {
    res.send(makeUserName());
  });

  app.get("/resolveShard/:roomId", (_req, res) => {
    res.send("");
  });
}

function normalizeRoomId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  return "/" + raw.replace(/^\/+/, "");
}
