# Gate 3 upstream LGPL libmpv development artifact

## Status

This artifact is accepted as a temporary development dependency for the Rust/libmpv harness. It is not yet the final WatchParty release dependency. The self-hosted LGPL-only workflow remains a reproducible-build and licensing-audit side path.

## Fixed source

- Repository: https://github.com/zhongfly/mpv-winbuild
- Release: `2026-09-03-f5bcfb1954`
- Package: `mpv-dev-lgpl-x86_64-20260903-git-f5bcfb1954.7z`
- Download URL: https://github.com/zhongfly/mpv-winbuild/releases/download/2026-09-03-f5bcfb1954/mpv-dev-lgpl-x86_64-20260903-git-f5bcfb1954.7z
- Package SHA-256: `05bee13e04189f1be59a84fcb5f57993584240302de047b57b368cd63f255e31`
- Architecture: PE32+ Windows x86-64
- x86_64 (not x86_64-v3), to preserve compatibility with older Windows CPUs

## Verified contents

- `libmpv-2.dll` (99,003,392 bytes)
- `libmpv.dll.a` (53,308 bytes)
- `include/mpv/client.h`
- `include/mpv/render.h`
- `include/mpv/render_gl.h`
- `include/mpv/stream_cb.h`

## Verified hashes

- `libmpv-2.dll`: `42097b72b9175c980cdbdfd10cf2c7111e39645f639d8502ff34171d01224ae8`
- `libmpv.dll.a`: `bef1b89f534bc86b33135e1f04fa2d5064b9d48b5de8bc9866665bbf43def793`
- `client.h`: `1acf99ee77c8c2a6f1d1993bd81bbc8a91d27fb5924e80171670e6139a4bd353`
- `render.h`: `192691941602052f00df0587f126246c48785a1cf21de68d22a92ea1908d1c55`
- `render_gl.h`: `48662c0ed9872a14dd9e1684105c97f69f94a0414709c254c5d372adc41d2e69`
- `stream_cb.h`: `188e58b6d14383e15a5dffdc4ecebbdfbf2e412b9c099ff21b571f747a8ce32d`

## Export and dependency checks

The DLL export table contains the required libmpv C API, including:

- `mpv_create`
- `mpv_initialize`
- `mpv_command`
- `mpv_wait_event`
- `mpv_terminate_destroy`

The PE import table contains Windows system libraries and `vulkan-1.dll`. No separate FFmpeg, x264, x265, libgcc, or libstdc++ DLL was present in the import table.

This is an import scan, not a legal conclusion. The release package itself contains no license files; source licenses and the maintainer's LGPL build claims must be retained and reviewed before redistribution.

## Local storage

The binary is kept outside the WatchParty Git working tree under the local temporary artifact directory used for Gate 3 testing. It must not be committed to this repository.

## Runtime smoke test

The standalone Rust harness was linked against `libmpv.dll.a` and executed successfully with the Windows system runtime available:

```text
libmpv lifecycle: PASS
```

The matching upstream runtime package was also inspected for later media tests:

- `mpv-x86_64-20260903-git-f5bcfb1954.7z`
- Package SHA-256: `a170ff6e4eaa1066a2c4785e1b77173f2b3c3fdfba6c18e338d8d7b5df8274f9`

The runtime archive does not include DLLs; the development DLL imports Windows system libraries and `vulkan-1.dll`. The local harness required `VCRUNTIME140.dll`, which is a host Windows runtime prerequisite, not a libmpv package member.

## Next verification

- Run `dev/gate3-libmpv-harness` against the DLL and import library.
- Verify `file-loaded`, playback commands, seek, rate, volume, track-list and `end-file`.
- Test `vo=gpu-next`, `hwdec=auto-safe`, and a real Tauri window.
- Run the anonymous real-media capability matrix.
- Complete source-license and dependency review before selecting a release artifact.
