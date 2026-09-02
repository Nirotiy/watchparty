# WatchParty Web

Next.js frontend for creating rooms, browsing OpenList media, and keeping playback synchronized through the WatchParty backend.

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
npm run build
```

The `predev` and `prebuild` hooks generate JASSUB Worker, WASM, and font assets under `public/vendor/`. That directory is generated from the pinned `jassub` dependency and must not be committed.

## Production

Production routing is same-origin: Caddy sends `/api/*` and `/socket.io/*` to the backend and serves OpenList media through `/p/*`. Deployment files live at the repository root and are committed separately from this frontend.
