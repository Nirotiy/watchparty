import type { Express } from "express";
import { makeRoomName, makeUserName } from "../../utils/moniker.ts";
import { searchYoutube, youtubePlaylist } from "../../media/youtube.ts";
import type { RoomRegistry } from "../room/registry.ts";

/** Core HTTP whitelist used by the Vite UI. */
export function registerCoreHttp(app: Express, registry: RoomRegistry): void {
  app.get("/ping", (_req, res) => {
    res.json("pong");
  });

  app.post("/createRoom", (req, res) => {
    const name = "/" + makeRoomName();
    const newRoom = registry.create(name);
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
    res.json({ name });
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
