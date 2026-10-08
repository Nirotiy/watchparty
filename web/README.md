# WatchParty Web

Next.js frontend for creating rooms, browsing OpenList media, and keeping playback synchronized through the WatchParty backend.

## Code boundary

This is the only supported browser client. New browser features and fixes belong in `web/`. The retired root Vite client has been removed. Some modules are imported from `desktop-shell/shared/`; treat those modules as desktop-owned. Ask before changing one, and first check whether the browser behavior can live in `web/` instead.

## Local development

The backend listens on `http://localhost:8080` by default.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. HTTP API requests are rewritten through `BACKEND_ORIGIN`. Socket.IO connects directly to `NEXT_PUBLIC_SOCKET_ORIGIN` in development and uses the page origin when that variable is unset.

Copy `.env.example` to `.env.local` only when either origin needs to be overridden.

## Verification

```bash
npm run lint
npm test
npm run build
```

The `predev` and `prebuild` hooks generate JASSUB and libav Worker, WASM, bridge, and font assets under `public/vendor/`. That directory is generated from npm dependencies and must not be committed. The pinned libav loader has a checked Worker injection hook so room teardown can cancel initialization.

## MKV playback

MKV uses a room-local libav.js demux Worker and the browser's WebCodecs video/audio decoders. Playback, seeking, room rate corrections, and audio output share one media clock. The first supported video/audio tracks and first supported embedded text subtitle track are selected locally, with saved language preferences applied when available. Room controls expose local audio/subtitle selection, subtitle off, audio unlock, and same-media retry. External VTT/ASS subtitles take precedence; subtitle offsets remain local to each media. Unsupported codecs use the existing desktop handoff. No WASM software decoder or server transcoding is enabled.

Media hosts must support exact byte Range responses and expose `Content-Range` and `ETag` through CORS. Concurrent 403/410 responses share one authenticated URL renewal, then retry each original interval once. A 200 response is cancelled instead of downloading the complete file.

For isolated testing, run `node web/tests/helpers/mkv-local-server.mjs <local.mkv>` from the repository root, then start Next on port 18982 with `BACKEND_ORIGIN` and `NEXT_PUBLIC_SOCKET_ORIGIN` set to `http://127.0.0.1:18981`. The fixture binds only to loopback and uses in-memory databases. Tests cover clock/range/lifecycle behavior and the authenticated MKV HTTP contract. Next rewrites `tsconfig.json` includes for the active dist directory during `dev` or `build`; revert that edit after isolated runs.

Run `node web/tests/helpers/mkv-browser-acceptance.mjs <evidence.json>` with the local `av-sync-marks-400s-subs.mkv` fixture for real Chrome room acceptance. Add `--capture` for H27T22 screen/HDA microphone measurement. The capture mode requires the monitor at `(0,-1440)` with `output_idx=1`, and the named HDA/E1x2 devices in the script. It removes raw recordings; temporary subtitle screenshots can be inspected and then deleted.

On 2026-10-07, the integrated Next room passed local Chrome H.264/AAC/SRT playback, first-gesture audio unlock, pause, paused/playing seek, 0.95/1.05 rate changes, embedded subtitles, and source-switch cleanup. A H27T22 physical run matched 12 flash/beep pairs: offsets -98 to -49 ms, median -79 ms, absolute P95 98 ms. Evidence is in `tests/results/mkv-chrome-local.json` and `mkv-chrome-physical.json`.

Run `node web/tests/helpers/mkv-dual-client-acceptance.mjs <evidence.json>` against the same local fixture to check two independent Chrome profiles in one room. On 2026-10-07, both real Next players passed late join, pause/resume commands from either browser, paused seek to 60 seconds, running 0.95/1.05 rate changes, playing seek to 120 seconds, and reload/rejoin. Across the seven playing segments, the highest P95 frame-time difference was 34.1 ms and the maximum was 35.7 ms, below the acceptance limits of P95 100 ms and maximum 250 ms. Paused seeks and the final pause aligned exactly; the earlier pause differed by one 33 ms frame. The rig also checks actual media advancement, newly rendered matching SRT cues, audio context state after trusted gestures, and browser errors. Evidence is in `tests/results/mkv-chrome-dual.json`; temporary Chrome profiles were removed.

The follow-up `tests/results/mkv-chrome-dual-logic.json` also covers paused seeks from 60 to 61, 60.5, and 60 seconds, plus trusted mute/unmute gestures that unlock audio without changing the shared revision. The highest stable P95 frame gap was 33.8 ms and the maximum was 37 ms. `lib/playback-sync.ts` keeps running drift correction separate from paused position changes.

`node web/tests/helpers/catalog-logic-acceptance.mjs` runs the actual media modal with delayed HTTP fixtures. `tests/results/catalog-logic.json` covers initial loading, search/clear, stale library/detail reads, and stale review/scrape completion after a library switch. Reads and mutations are guarded independently of the shared desktop catalog helpers.

`node web/tests/helpers/mkv-fault-acceptance.mjs` requires a long local marker fixture with two audio and subtitle tracks so large seeks escape the bounded read cache. `tests/results/mkv-chrome-fault.json` records local track switching and subtitle off/on, expired-URL 403 renewal, a four-second media-response stall at 0.95x, video/audio/subtitle recovery, and same-media retry with old Worker teardown. These operations preserved the room revision; renewal retained the existing Worker and no full-file response was requested. This is response-delay injection, not sustained global bandwidth limiting. A unit test separately covers concurrent expired requests sharing one renewal. The fixture is a temporary local input: 41 concatenated copies of `av-sync-marks-400s-subs.mkv` (`ffmpeg -f concat -c copy`) followed by a stream copy that duplicates the audio and subtitle tracks with `eng`/`jpn` language tags; no re-encode, and the result must not be committed.

`node web/tests/helpers/mkv-ui-acceptance.mjs` runs the Scheme A room UI against the same fixture and local server: control-row geometry without overlaps at 360/390/683/1366/2560, the local audio entry (unlock without revision change), track menus (audio/subtitle/off, revision-preserving), the buffering status text during a media stall, the same-media retry panel with desktop exit, whole-document fullscreen with menus and dialogs visible, and the touch first-tap reveal. `tests/results/mkv-ui-scheme-a.json` records 39 passing checks; the subtitle safe-area measurement keeps the lowest cue line above the pinned control overlay.

`lib/player-local.ts` defines local phases, audio state, presented frame time, decoded buffer runway, and track metadata. `PlayerAdapterProps.onLocalState` and `onEmbeddedTracks` currently report these for MKV only. The room UI still needs to consume them. `getCurrentTime()` intentionally returns the media clock for snapshot alignment; displayed `onTimeUpdate` uses the last presented frame. Retry resets local track selection to supported defaults unless the caller reapplies a preference.

Dual-client measurements compare presented canvas frame PTS at a common sampling time, not physical scanout or sound arrival between devices. Late join and reload are sampled before playback-changing gestures; audio requires a trusted click in each new document. These earlier results cover local H.264/AAC/SRT only. The directed acceptance below extends the local integration coverage. Edge, additional codecs, baseline hardware, remote production sources, cross-device network-delay synchronization, and license/source distribution requirements remain release checks.

### Directed integration acceptance

The scenario fixture requires FFmpeg with libx264/libopus and real Chrome. Scenario and preference probes use muted headless Chrome. `prepare-mkv-scenarios.mjs` creates synthetic 180-second H.264 video at 8 Mbps, distinct AAC 440 Hz / Opus 880 Hz audio, different EN/JP subtitle text, a copy with reordered audio/subtitle IDs, ASS with/without an attached Windows font, external VTT/ASS, and two six-second colored clips. The temporary font/media files are local test inputs and must not be distributed with the app.

```bash
node web/tests/helpers/prepare-mkv-scenarios.mjs
node web/tests/helpers/mkv-scenario-server.mjs <printed-manifest-path>
```

Start the isolated Next preview on 18982 with the origins described above, then run each case separately:

```bash
node web/tests/helpers/mkv-scenario-acceptance.mjs playback
node web/tests/helpers/mkv-scenario-acceptance.mjs subtitles
node web/tests/helpers/mkv-scenario-acceptance.mjs tracks
node web/tests/helpers/mkv-scenario-acceptance.mjs throttle
```

On 2026-10-07 all four passed against the actual Next room. Evidence is `tests/results/mkv-next-{playback,subtitles,tracks,throttle}.json`:

- Concurrent seeks, mixed commands, and batch/single additions all settle through the room command queue. Deliberately delayed old resolutions cannot replace the last selected source. Old Workers close.
- Chrome network blocking and transport closure exercise a real reconnect. A failed Range read can dispose the engine; the first authoritative snapshot after reconnect rebuilds that same failed source once. The latest time/rate and audible spectrum recover. The test does not reload the document.
- Owner-only `playlistAutoNext` advances one item on ended; guests follow without sending a forbidden command. The last entry stays selected without loop; loop wraps to the first. **The current server contract selects the next item paused. This is not continuous playlist playback.**
- Paused SRT seeks show the target cue. ASS renders after initialization and same-source seek, and clears outside the cue interval. Attached-font and fallback glyph rasters differ. External VTT/ASS go through authenticated real backend routes with delayed subtitle loads. ASS pixel assertions compare visible and hidden subtitle overlays, excluding the underlying video. Captures are processed in memory and not saved.
- Two clients output AAC 440 Hz and Opus 880 Hz with different subtitle content, then run at 0.95x and exchange local tracks. Frequency peaks follow the selected codec/content and rate; shared revision remains unchanged. Highest segment P95 presented-frame gap was 32.9 ms, maximum 33.3 ms.
- The global media limiter measured 2.93 Mbps over 36.1 seconds, below the 8 Mbps source requirement, and recorded real underrun. After lifting, video/audio/subtitles recover without shared pause or revision changes; observed media rate was 0.95017. This is a server-wide byte limiter across concurrent media requests, not an operating-system link shaper.

The production fixes from this acceptance also preload the default ASS font, repaint a paused frame when the subtitle renderer becomes ready, and process a paused batch's subtitle packets before its first video frame. A decoder test locks down that ordering. Physical sound/scanout alignment after throttling, speech-language intelligibility, and other codecs are not inferred from spectrum or frame-PTS results.

On 2026-10-08 the redesigned menus and preference wiring passed an isolated production Next run on ports 18991/18992/18993. `next-preferences-acceptance.mjs` checks real MKV language restoration across reordered IDs, volume/mute, subtitle off, per-media offsets, external subtitle reload, and UI retry after a real 503 Range failure. The subtitles/tracks/throttle scenarios select tracks through room menus. Switching to an external VTT while paused now redraws the current frame when its track loads; the lifecycle test also covers this case. Results are `tests/results/next-preferences-2026-10-08.json` and `mkv-next-{subtitles,tracks,throttle}-menu-2026-10-08.json`. Historical 2026-10-07 results remain separate kernel/integration evidence.

For fresh isolated ports, set `WATCHPARTY_TEST_BACKEND_PORT` and `WATCHPARTY_TEST_MEDIA_PORT` before running the scenario server. Set `WATCHPARTY_TEST_BACKEND` and `WATCHPARTY_TEST_ORIGIN` for the probes. Build/start Next with matching `BACKEND_ORIGIN`, `NEXT_PUBLIC_SOCKET_ORIGIN`, and a new `WATCHPARTY_NEXT_DIST_DIR`. Run probes sequentially because they share one fixture room; each accepts an output path. Use the fixture close endpoint and stop Next when finished. Frequency checks sample the Web Audio graph before physical output; they do not require speakers or a loopback device.

## Production

Production routing is same-origin: Caddy sends `/api/*` and `/socket.io/*` to the backend and serves OpenList media through `/p/*`. Deployment files live at the repository root and are committed separately from this frontend.
