import {
  registerHandoffHttp,
  registerNativeClientHttp,
  registerNativeHandoffHttp,
  requireMpvContext,
  runMpvCommand,
} from "./native-routes.ts";

export {
  registerHandoffHttp,
  registerNativeClientHttp,
  registerNativeHandoffHttp,
  requireMpvContext,
  runMpvCommand,
};
export type { NativeRequestContext as MpvRequestContext } from "./native-routes.ts";

import type { Express } from "express";
import type { RoomRegistry } from "../room/registry.ts";
import type { WatchpartyMedia } from "../../media/watchparty-media.ts";

/** Compatibility entry point for integrations that still register MPV routes directly. */
export function registerMpvHttp(
  app: Express,
  registry: RoomRegistry,
  media: WatchpartyMedia,
): void {
  registerHandoffHttp(app, registry);
  registerNativeHandoffHttp(app, registry, "mpv");
  registerNativeClientHttp(app, registry, media, "mpv");
}
