# Kimi Express ⚡🚆

**Agentic day-trip planner: trains, maps and travel times in seconds.** Kimi K3.1 Pro on Cerebras, running through the OpenClaw harness.

Planning a day trip in Germany usually means googling sights, flipping to the DB Navigator app for trains, and doing distance maths in your head. Kimi Express does it in one go: tell it where you want to go and what you want to see, and an OpenClaw agent powered by Kimi K3.1 Pro on Cerebras finds the places, checks real Deutsche Bahn connections, works out walking and transit times between stops, and lays the whole day out on a live dashboard. Save the trip to your log and look back at past trips any time.

Built for the Cerebras × Kimi K3.1 Pro × OpenClaw hackathon. `#KimiOnCerebras`

## What you see

- **Where to?** One sentence, e.g. *"Day trip to Berlin tomorrow from Hannover. Museum Island and East Side Gallery, back by 21:00."*
- **Speed panel:** tokens/sec, time to first token and total time to a full plan, with model time and tool time split out.
- **Race vs GPU (optional):** the same request runs on Kimi K3.1 Pro on Cerebras and on a GPU-hosted Kimi at the same time, through the same OpenClaw agent and tools, with live progress bars and a "Cerebras finished N× faster" verdict.
- **Agent activity:** every tool call Kimi makes through OpenClaw, live, with its latency and result.
- **Map:** your stops, numbered in visiting order, with walking routes and transit hops.
- **Today's plan:** outbound and return trains, a timeline of stops with times, totals (time on trains, getting around, km walked) and tips.
- **Trip log:** saved trips with status (planned / done), number of cities and travel time.

## How it works

```
Dashboard (browser)
   │  your request
   ▼
Kimi Express server (Node, :5177) ──► OpenClaw Gateway (:18789, /v1/chat/completions)
   ▲                                       │  agent run
   │  tool calls (HTTP)                    ▼
   └──────── kimi-express-tools plugin ◄── Kimi K3.1 Pro on Cerebras
```

- The **OpenClaw agent** runs on `cerebras/moonshotai-kimi-k3.1-pro-trial`.
- The **kimi-express-tools** OpenClaw plugin gives the agent 6 tools: `find_places`, `search_trains`, `travel_between`, `publish_plan`, `save_trip`, `list_trips`.
- The plugin forwards each call to the local Kimi Express server, which runs the lookup and streams the result to the dashboard as it happens.

### Data sources (all free, no API keys)

| What | Source |
| --- | --- |
| Train connections | DB timetable data via [Transitous](https://transitous.org) (open, keyless). Optional: your own [db-rest](https://github.com/derhuerst/db-rest) via `KX_DB_REST` |
| Places / sights | OpenStreetMap via [Photon](https://photon.komoot.io) (backup: [Nominatim](https://nominatim.org)) + [Overpass](https://overpass-api.de) for sight ideas |
| Walking routes | [FOSSGIS OSRM](https://routing.openstreetmap.de) foot router |
| Local transit between stops | Transitous (S-Bahn, U-Bahn, tram, bus) |
| Map tiles | Standard [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles (keyless, light use only), darkened in CSS |

No ticket prices or booking: DB doesn't offer those without a partner contract.

## Run it (Windows, PowerShell)

Requirements: Node 24+, OpenClaw (2026.5.17 or newer), a Cerebras API key with Kimi K3.1 Pro access.

1. **Cerebras key** (never commit it):
   ```powershell
   setx CEREBRAS_API_KEY "csk-..."   # then open a new terminal
   ```
2. **OpenClaw config:** merge [`openclaw/kimi-express.openclaw.json5`](openclaw/kimi-express.openclaw.json5) into `%USERPROFILE%\.openclaw\openclaw.json`. It sets Kimi on Cerebras as the model, turns on the gateway's local chat-completions endpoint and enables the plugin. If you use the Cerebras provider plugin, `openclaw plugins install @openclaw/cerebras-provider` first.
3. **Install the tools plugin** (prebuilt `dist/` is included):
   ```powershell
   cd plugin
   npm ci --omit=dev --omit=peer      # installs the plugin's one runtime dependency (typebox)
   openclaw plugins install --link . --force --accept-capabilities
   openclaw plugins enable kimi-express-tools
   cd ..
   ```
4. **Start / restart the OpenClaw gateway** so it loads the key, config and plugin:
   ```powershell
   openclaw gateway --port 18789
   ```
   Wait for `gateway ready` in its log before sending the first request (on a slow machine, loading plugins can take a few minutes). The gateway token is `gateway.auth.token` in `openclaw.json`.
5. **Start the dashboard:**
   ```powershell
   $env:OPENCLAW_GATEWAY_TOKEN = "<your gateway token>"   # only if your gateway uses token auth
   .\start.ps1        # or: npm start, then open http://127.0.0.1:5177
   ```

The pill in the top right turns green when the dashboard can reach the gateway.

### Settings (environment variables)

| Variable | Default |
| --- | --- |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | none (set if the gateway uses token/password auth) |
| `KX_AGENT` | `openclaw/default`. Use `openclaw/kimi-express` with the lean agent from the config snippet |
| `KX_PORT` | `5177` |
| `KX_GPU_MODEL` | none. Set to a GPU-hosted Kimi, e.g. `nebius/moonshotai/Kimi-K3.1-Pro`, to show the **Race vs GPU** toggle |
| `KX_GPU_LABEL` | `GPU (Nebius)` |

### Rebuilding the plugin

```powershell
cd plugin
npm install
npm run plugin:validate
```

## Automation hooks (for recording demos)

The dashboard opens in trip mode. Add `?speed=1` to the URL (`http://127.0.0.1:5177/?speed=1`) to show the speed panel and the Race vs GPU toggle.

| Selector | Meaning |
| --- | --- |
| `[data-testid="trip-prompt"]` | Prompt box. Enter submits, Shift+Enter adds a new line |
| `[data-testid="plan-button"]` | Submit button |
| `[data-testid="status"]` | One-line status under the button ("Checking Deutsche Bahn trains…", "Your day is planned ✓") |
| `[data-testid="race-toggle"]` | "Race vs GPU" checkbox (only with `?speed=1` and `KX_GPU_MODEL` set; remembered per browser) |
| `[data-plan-ready]` / `[data-testid="plan-complete"]` | Hidden marker added once the Cerebras plan is fully rendered (trains, map, timeline, metrics) |
| `[data-testid="race-complete"]` | Hidden marker added once both race lanes finished |
| `[data-testid="race-verdict"]` | "Cerebras finished N× faster" text |
| `body[data-state]` | `idle`, `running`, `done` or `error` |

## Repo layout

```
server/   Node server: dashboard API, trip tools, OpenClaw gateway client, system prompt
web/      Dashboard (vanilla JS + Leaflet)
plugin/   OpenClaw tool plugin (TypeScript, defineToolPlugin)
openclaw/ OpenClaw config snippet
data/     Your trip log (trips.json, git-ignored)
```

## License

Apache-2.0
