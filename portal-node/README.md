# portal-node — Node variant of the craft-suite portal

The main portal runs nginx inside a Docker image (see the repo root `Dockerfile`),
which is what Railway and Pxxl paid plans build. **Pxxl's Free plan builds GitHub
repositories with a generic install/build/start pipeline (no Docker) and cannot
host two services inside one project.** This folder is the same portal as a
plain Node app so Pxxl Free can serve it as one single-service project, with the
relay as a second free project.

## What it does

- `scripts/fetch-apps.mjs` (build command): downloads the 10 pinned web-WASM
  release zips (same pins and fork-release bookmarks as the root Dockerfile),
  extracts them into `site/<app>`, injects the relay bridge tags, precompresses
  `.wasm/.js/.html/...` to `.gz` and writes `versions.json`. It fails fast if
  any artifact is missing.
- `server.mjs` (start command): serves `site/` with the same headers nginx used
  — `application/wasm`, immutable caching for hashed assets, no-cache for
  unhashed builds and HTML, COOP/COEP/CORP + nosniff on every response,
  precompressed `.gz` when the client accepts gzip — plus `/healthz`.
- `/relay/` (HTTP and WebSocket) is proxied to `RELAY_URL` so the in-page
  bridge keeps connecting same-origin with `window.CRAFT_RELAY.url = "/relay"`.

## Pxxl Free settings

**Project 1 — craft-relay**

| Field | Value |
| --- | --- |
| Working Directory | `server` |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Start Command | `node dist/index.js` |
| Port | `8080` |
| Env vars | `MCP_TOKEN` (≥32 chars), `BRIDGE_TOKEN` (≥16), `ALLOWED_ORIGINS` = portal origin |

**Project 2 — craft-suite (portal)**

| Field | Value |
| --- | --- |
| Working Directory | `portal-node` |
| Install Command | `npm install` |
| Build Command | `node scripts/fetch-apps.mjs` |
| Start Command | `node server.mjs` |
| Port | `8080` |
| Env vars | `RELAY_URL` = the relay project's public URL |

The build downloads ~200 MB of artifacts; deploy takes a few minutes.
