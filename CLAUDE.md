# Kimi Express

Agentic day-trip planner for the Cerebras × Kimi K3.1 Pro × OpenClaw hackathon (deadline Sun 2026-11-22, 10:00 AM PT). See README.md for the full setup.

## Hackathon rules (must hold for every change)
- Kimi K3.1 Pro on Cerebras is the core: OpenClaw model `cerebras/moonshotai-kimi-k3.1-pro-trial`. Cerebras limits: 100K uncached tokens/min, 40,960 max completion tokens.
- The dashboard has a model picker (Ashish's decision, 2026-11-22): Cerebras (default) or Nebius (`KX_GPU_MODEL`, default `nebius/moonshotai/Kimi-K3.1-Pro`). Both run the same OpenClaw agent and tools; there is no automatic fallback.
- Everything runs through the **OpenClaw harness** (gateway + the `kimi-express-tools` plugin). Never call Cerebras directly from the app.
- Public X/Reddit demos are recorded with **standard OpenClaw**, never the speed-patch build.
- Demo video ≤ 60 s, shows Cerebras speed; side-by-side vs a GPU provider is recommended (the Race vs GPU mode).

## Secrets
- Never read, print, log or commit API keys or the gateway token. They live only in env vars (`CEREBRAS_API_KEY`, `NEBIUS_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`) or OpenClaw's own config, which references them as `${VAR}`.

## Run (Windows, PowerShell)
1. OpenClaw gateway on `127.0.0.1:18789`: `openclaw gateway --port 18789`. Wait for `gateway ready` in its log (can take minutes) before sending requests. Needs `gateway.http.endpoints.chatCompletions.enabled = true` and the plugin enabled (see `openclaw/kimi-express.openclaw.json5`).
2. Plugin: `cd plugin; npm ci --omit=dev --omit=peer; openclaw plugins install --link . --force --accept-capabilities`.
3. Dashboard on `127.0.0.1:5177`: `node server/server.mjs` with env `OPENCLAW_GATEWAY_TOKEN` (from `gateway.auth.token`), optional `KX_AGENT=openclaw/kimi-express`, and `KX_GPU_MODEL=nebius/moonshotai/Kimi-K3.1-Pro` to enable the Race vs GPU toggle (Nebius Token Factory, key in `NEBIUS_API_KEY`).
4. Check: `GET http://127.0.0.1:5177/api/health`.

## Layout
- `server/tools.mjs` trip tools; `server/server.mjs` dashboard API, tool endpoint for the plugin, gateway client and speed metrics; `server/prompt.mjs` system prompt (keep it stable for prompt caching).
- `plugin/` OpenClaw tool plugin (forwards tool calls to `POST /api/tools/:name`). After editing `plugin/src`, run `npm run build` and `openclaw plugins build --entry ./dist/index.js`, and commit `dist/` and `openclaw.plugin.json`.
- `dashboard/` the dashboard: Next.js 16 + React 19 + Tailwind 4 + ui-sdk, exported statically to `dashboard/out/` (committed) and served by `server/server.mjs`. After editing, run `npm run build` in `dashboard/` and commit `out/`. Follow `dashboard/AGENTS.md`. `?demo=1` plays a sample run without the agent (made-up times, labelled "Sample data"; never record it as a real run).
- Older UIs: `app/` (Vite React, `KX_UI=vite`) and `web/` (vanilla JS, `KX_UI=classic`). Keep the `data-testid` hooks stable in all of them; the demo recorder uses them.
- `scripts/smoke-tools.mjs` checks the data sources without OpenClaw or Kimi.

## Data sources (free, no keys)
- Trains: DB timetable via Transitous (`api.transitous.org`). `v6.db.transport.rest` is shut down; only use db-rest if `KX_DB_REST` points at a self-hosted instance.
- Places: Photon (`photon.komoot.io`), Nominatim as backup (max 1 request/s). Sight ideas: Overpass mirrors (often overloaded, 4 s cap) with Photon fallback.
- Walking: FOSSGIS OSRM foot router; local transit: Transitous.
- Never invent train times; only use tool results.
