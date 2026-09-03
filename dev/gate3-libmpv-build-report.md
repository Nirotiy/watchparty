# Gate 3 native libmpv build report

## Source and workflow

- Fork: https://github.com/Nirotiy/mpv-winbuild-cmake
- Fork commit: `eb7db6656674ac24481a1c3a17ac26900a1373e4`
- Workflow: https://github.com/Nirotiy/mpv-winbuild-cmake/actions/workflows/watchparty-libmpv.yml
- Triggered run: https://github.com/Nirotiy/mpv-winbuild-cmake/actions/runs/33788790006
- Target: `x86_64-w64-mingw32`
- mpv source: `v0.40.0`, commit `287d7cdb78975ae350d7c2a287eae3c2072c93f7`
- Build mode: shared library, `-Dlibmpv=true`
- Upload behavior: artifact only, no release and no SourceForge upload

The fork workflow is still running its GCC toolchain phase. The run has passed container initialization, checkout, and CMake configuration; no failure has been reported. It must finish before its artifact can be treated as the reproducible build result.

## Immediate compatible upstream artifact

The upstream release `20260903` already contains the expected development package for the same x86_64 Windows shape:

- Package: `mpv-dev-x86_64-20260903-git-69e63f425a.7z`
- URL: https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260903/mpv-dev-x86_64-20260903-git-69e63f425a.7z
- Package SHA-256: `fac135c68a35b7639e39d72c0c365104edbaebdea39a0dfdd8c36e8c8e80faef`
- `libmpv-2.dll` SHA-256: `673e6397920ab64a9c5b3a618f7f16d38854efe72b58665f1f84e4e873b763a4`
- Contents: `libmpv-2.dll`, `libmpv.dll.a`, `include/mpv/client.h`, `render.h`, `render_gl.h`, `stream_cb.h`
- Import library SHA-256: `bef1b89f534bc86b33135e1f04fa2d5064b9d48b5de8bc9866665bbf43def793`
- Header SHA-256: client `1acf99ee77c8c2a6f1d1993bd81bbc8a91d27fb5924e80171670e6139a4bd353`; render `192691941602052f00df0587f126246c48785a1cf21de68d22a92ea1908d1c55`; render_gl `48662c0ed9872a14dd9e1684105c97f69f94a0414709c254c5d372adc41d2e69`; stream_cb `188e58b6d14383e15a5dffdc4ecebbdfbf2e412b9c099ff21b571f747a8ce32d`
- DLL format: PE32+ Windows x86-64
- Export verification: `mpv_create`, `mpv_initialize`, `mpv_command`, `mpv_wait_event`, `mpv_terminate_destroy`

The matching runtime package is:

- `mpv-x86_64-20260903-git-69e63f425a.7z`
- Package SHA-256: `418dbfb5feb851cbed33d6c05d8481ba71802621bfd6efe8974522b28d42ac97`

## Local loader smoke test

The downloaded `libmpv-2.dll` was loaded on Windows with the bundled Python runtime. A native lifecycle smoke test passed:

```text
mpv_create -> mpv_set_option_string(vo/ao/idle/config) -> mpv_initialize
-> mpv_command_string(set pause yes) -> mpv_terminate_destroy
libmpv lifecycle: PASS
```

This proves the DLL loader and basic client lifecycle work on this machine. It does not yet prove video rendering, hardware decoding, or the high-risk media matrix.

## Remaining Gate 3 work

- Wait for the fork workflow and download its artifact.
- Record the fork-built DLL/import-library/header hashes and compare with the upstream artifact.
- Build a small Rust/native harness against `libmpv.dll.a` and run event-loop, `loadfile`, playback, seek, rate, volume, tracks, and `end-file`.
- Test the runtime bundle with `vo=gpu-next`, `hwdec=auto-safe`, and a real window only after the headless harness is stable.
- Supply and run ASS, PGS, FLAC, HEVC Main10, H.264 Hi10P, HDR, and 4K fixtures.
- Keep the libmpv artifact and all dependent DLLs outside Git; distribute only through a versioned build artifact after license review.
