import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PlayerAdapter, type PlayerAdapterHandle, type PlayerAdapterProps } from "../../components/player-adapter";
import { MembersModal } from "../../components/members-modal";
import type { PlayerCapabilities, PlayerLocalState } from "../../lib/player-local";

const events: PlayerLocalState[] = [];
const errors: string[] = [];
const errorDetails: string[] = [];
const capabilities: PlayerCapabilities[] = [];
const ref = createRef<PlayerAdapterHandle>();
const host = document.createElement("main");
host.style.cssText = "height:360px;width:640px;max-width:100%;background:#000";
document.body.append(host);
const root = createRoot(host);
const memberHost = document.createElement("div");
document.body.append(memberHost);
const memberRoot = createRoot(memberHost);
let memberCloses = 0;
type MemberProps = React.ComponentProps<typeof MembersModal>;
let memberProps: MemberProps = { isOpen: false, isOwner: true,
  onClose: () => { memberCloses++; }, onTransferOwnership: async () => ({ ok: true, revision: 1 }),
  members: [{ clientId: "owner", name: "Owner", isOwner: true, clientType: "browser" },
    { clientId: "target", name: "Target", isOwner: false, clientType: "browser" }],
};
let props: PlayerAdapterProps = { source: { kind: "http", url: "/clip.mp4" }, streamUrl: "/clip.mp4" };
let playCalls = 0;
const originalPlay = HTMLMediaElement.prototype.play;
let rejectPlay = false;
HTMLMediaElement.prototype.play = function () {
  playCalls++;
  return rejectPlay ? Promise.reject(new DOMException("Blocked by fixture", "NotAllowedError")) : originalPlay.call(this);
};

type YoutubeOptions = { events: {
  onReady: (event: { target: FakeYouTube }) => void;
  onStateChange: (event: { target: FakeYouTube; data: number }) => void;
  onError: (event?: { target: FakeYouTube; data?: number }) => void;
  onAutoplayBlocked: () => void;
} };
const youtubeInstances: FakeYouTube[] = [];
class FakeYouTube {
  time = 0;
  rate = 1;
  volume = 100;
  muted = false;
  destroyed = false;
  plays = 0;
  constructor(element: HTMLElement, readonly options: YoutubeOptions) {
    youtubeInstances.push(this);
    const iframe = document.createElement("div");
    element.replaceWith(iframe);
    setTimeout(() => options.events.onReady({ target: this }), 0);
  }
  destroy() { this.destroyed = true; }
  getCurrentTime() { return this.time; }
  getDuration() { return 12; }
  getVideoLoadedFraction() { return 0.8; }
  mute() { this.muted = true; }
  pauseVideo() { this.options.events.onStateChange({ target: this, data: 2 }); }
  playVideo() { this.plays++; this.options.events.onStateChange({ target: this, data: 1 }); }
  seekTo(seconds: number) { this.time = seconds; }
  setPlaybackRate(rate: number) { this.rate = rate; }
  setVolume(volume: number) { this.volume = volume; }
  unMute() { this.muted = false; }
}
Object.defineProperty(window, "YT", { value: { Player: FakeYouTube }, configurable: true, writable: true });

function render(patch: Partial<PlayerAdapterProps> = {}) {
  props = { ...props, ...patch };
  flushSync(() => root.render(<PlayerAdapter {...props} ref={ref}
    onLocalState={(state) => events.push(state)} onCapabilities={(value) => capabilities.push(value)}
    onError={(error) => { errors.push(error.code); errorDetails.push(error.message); }} />));
}
render();
const rig = { ref, events, errors, errorDetails, capabilities, render, youtubeInstances,
  get playCalls() { return playCalls; },
  setRejectPlay(value: boolean) { rejectPlay = value; },
  video: () => document.querySelector("video"),
  clear: () => { events.length = 0; errors.length = 0; },
  renderMembers: (patch: Partial<MemberProps>) => {
    memberProps = { ...memberProps, ...patch };
    flushSync(() => memberRoot.render(<MembersModal {...memberProps} />));
  },
  get memberCloses() { return memberCloses; },
  stop: () => { flushSync(() => { root.unmount(); memberRoot.unmount(); }); },
};
Object.assign(window, { rig });
