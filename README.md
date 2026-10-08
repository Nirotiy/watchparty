# WatchParty

WatchParty is a self-hosted synchronized media room service. The deployed browser client is the Next.js application in `web/`. The backend provides room state, Socket.IO synchronization, media library access, and playback handoff APIs.

## Local development

Install backend dependencies and start the API:

```sh
npm ci
npm run dev
```

In another terminal, start the browser client:

```sh
npm ci --prefix web
npm run dev --prefix web
```

Open `http://localhost:3000`. The Next.js client rewrites HTTP API calls to the backend on port 8080. Socket.IO connects to port 8080 directly in development.

## Self-hosted containers

The local Compose file builds the backend and Next.js frontend separately:

```sh
docker compose -f docker-compose.local.yml up --build
```

For VPS deployment, use the files under `deploy/` and the pinned backend/frontend images. See [web/README.md](web/README.md) for frontend verification and routing details.

The backend keeps room state in memory. OpenList, media signing, and production secrets require the environment settings documented by the deployment configuration.
