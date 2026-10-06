# Gate 3 Windows media-player assets

## Sidecar verifier result

Command:

```text
npm run test:gate3-sidecar
```

Result on 2026-09-04:

```text
S1-S6, S8-S9: passed
S7, S10: pending
failed: 0
pending: 2
```

The verifier uses a local short H.264/AAC fixture at `dev/mpv-e2e/short.mp4`. Supply another fixture with `GATE3_MEDIA_FILE=/absolute/path/file.mp4` when needed.

- Binary: `D:/mpv/mpv-lazy/mpv.com`
- Reported version: `mpv v0.41.0-615-g7b057f66f`
- Build date: `2026-05-09 16:03:22`
- libplacebo: `v7.364.0`
- FFmpeg: `N-124424-gb2dfc1427`
- SHA-256: `fb9693318d371c044c38dcdec4a3cebeceeaf091f68d1e445d19d730475d322d`
- `video-format`: `h264`
- `audio-codec-name`: `aac`
- `hwdec-current`: `no` with `vo=null`
- `current-vo`: `null`
- `vo-configured`: `true`
- track-list: one H.264 video track and one AAC audio track

The sidecar is a Gate 3 verifier only. It is not the product embedding path and it does not prove that `libmpv-2.dll` is available. The current machine audit found no `libmpv-2.dll`, mpv C header, or import library under the searched C:/ and D:/ roots. A fixed LGPL libmpv build must be acquired and hashed before a native embedding POC can start.

## Verified behaviors

| ID | Behavior | Status |
| --- | --- | --- |
| S1 | initialize and capability properties | passed |
| S2 | loadfile and file-loaded event | passed |
| S3 | play, pause, seek and rate | passed |
| S4 | volume and track-list | passed |
| S5 | end-file event | passed |
| S6 | direct URL User-Agent | passed |
| S7 | direct URL Range and deep-seek request path | pending; the 4-second, 53,950-byte fixture cannot prove a non-zero deep-seek Range request |
| S8 | redirect and dynamic reload | passed |
| S9 | fallback URL Basic Auth and Range | passed |
| S10 | high-risk codecs/subtitles/HDR/4K | pending; needs media fixtures |

S9 uses a local test credential injected into mpv only to exercise the HTTP boundary. Product code must continue to inject site credentials from native Rust memory and must not put them in URLs, renderer state, or logs.

## Required S10 sample matrix

The following fixtures still need to be supplied and run individually: ASS, PGS, FLAC, HEVC Main10, H.264 Hi10P, HDR, 4K, plus at least one dynamic/redirecting network sample and one direct-to-fallback failure case. Each result must record startup, codec mode, seek, dropped frames/errors, and the reason for any software-decoding fallback.
