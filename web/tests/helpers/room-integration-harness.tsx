import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import RoomPlayer from "../../components/room-player";
import { rig } from "./room-integration-fixture";

localStorage.setItem("watchparty_client_id", "self");
localStorage.setItem("owner_fixture", "owner");
if (!localStorage.getItem("watchparty.player-preferences.v1")) localStorage.setItem("watchparty.player-preferences.v1",
  JSON.stringify({ volume: 31, muted: true, audioLanguage: "ja", subtitleLanguage: "en", subtitlesOff: true }));
const host = document.createElement("main");
document.body.append(host);
const root = createRoot(host);
function mount() { flushSync(() => root.render(<RoomPlayer roomId="fixture" accessToken="fixture" />)); }
Object.assign(rig, { remount: () => { flushSync(() => root.render(null)); mount(); }, stop: () => root.unmount() });
Object.assign(window, { roomRig: rig });
mount();
