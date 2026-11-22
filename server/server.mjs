import { existsSync } from "node:fs";
// Kimi Express dashboard server.
// - Serves the dashboard (web/)
// - Runs the trip tools for the OpenClaw plugin (POST /api/tools/:name) and broadcasts results to the dashboard
// - Sends the user's request to the OpenClaw Gateway (Kimi K3.1 Pro on Cerebras) and streams the answer back with speed metrics
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, list_trips, save_trip, delete_trip, get_trip, GOOGLE_KEY_VAR } from "./tools.mjs";
import { SYSTEM_PROMPT } from "./prompt.mjs";

const PORT = +(process.env.KX_PORT || 5177);
const HOST = process.env.KX_HOST || "127.0.0.1";
const GATEWAY = (process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(/\/$/, "");
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD || "";
const AGENT = process.env.KX_AGENT || "openclaw/default";
// Optional GPU-hosted Kimi for the side-by-side race (any OpenClaw model ref). Cerebras stays the default lane.
const GPU_MODEL = process.env.KX_GPU_MODEL || "";
const GPU_LABEL = process.env.KX_GPU_LABEL || "GPU (Nebius)";
// The React dashboard (app/dist) is served when it has been built; KX_UI=classic serves the original web/ page.
const APP_DIST = fileURLToPath(new URL("../app/dist/", import.meta.url));
const WEB = process.env.KX_UI !== "classic" && existsSync(join(APP_DIST, "index.html")) ? APP_DIST : fileURLToPath(new URL("../web/", import.meta.url));

// ---------- dashboard event bus (SSE) ----------
const clients = new Set();
const runs = new Map(); // lane -> run currently being generated
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

// ---------- tool endpoint (called by the OpenClaw plugin) ----------
function laneFor(req) {
  const key = String(req.headers["x-kx-session"] || "");
  const m = key.match(/kx-(cerebras|gpu)-/);
  if (m) return m[1];
  return runs.size === 1 ? [...runs.keys()][0] : "cerebras";
}

async function runTool(name, args, lane = "cerebras") {
  const fn = TOOLS[name];
  if (!fn) throw Object.assign(new Error(`Unknown tool ${name}`), { code: 404 });
  const run = runs.get(lane);
  const id = Math.random().toString(36).slice(2, 9);
  const t0 = performance.now();
  broadcast({ type: "tool_start", id, name, args, lane });
  if (run && run.firstToolMs == null) run.firstToolMs = performance.now() - run.t0;
  if (run) run.marks.push({ k: "start", t: performance.now() - run.t0 });
  console.log(`[${lane}] → ${name} ${JSON.stringify(args).slice(0, 160)}`);
  try {
    const result = await fn(args || {});
    const ms = Math.round(performance.now() - t0);
    if (run) run.toolMs += ms, run.toolCalls++, run.marks.push({ k: "end", t: performance.now() - run.t0 });
    broadcast({ type: "tool_end", id, name, args, result, ms, lane });
    console.log(`[${lane}] ✓ ${name} ${ms} ms`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (run) run.toolMs += ms, run.toolCalls++, run.marks.push({ k: "end", t: performance.now() - run.t0 });
    broadcast({ type: "tool_error", id, name, args, error: String(e.message || e), ms, lane });
    console.log(`[${lane}] ✗ ${name} ${ms} ms: ${e.message || e}`);
    throw e;
  }
}


// POST with no idle/body timeout. Node's fetch (undici) aborts a response body after 300 s of
// silence, and the gateway can stay silent for a long time while the agent works.
function streamPost(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, signal },
      (res) => resolve(res),
    );
    req.on("error", reject);
    req.setTimeout(0);
    req.end(body);
  });
}

// ---------- plan endpoint: user prompt -> OpenClaw Gateway -> Kimi on Cerebras ----------
async function plan(req, res) {
  const { prompt, conversation, lane: laneIn } = await body(req);
  const lane = laneIn === "gpu" && GPU_MODEL ? "gpu" : "cerebras";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" });
  const me = { t0: performance.now(), toolMs: 0, toolCalls: 0, firstTokenMs: null, marks: [] };
  runs.set(lane, me);
  // With several OpenClaw agents configured, the session key must name its agent.
  const agentId = AGENT.replace(/^openclaw[/:]/, "").replace(/^agent:/, "") || "main";
  const sessionKey = `agent:${agentId === "default" ? "main" : agentId}:kx-${lane}-${conversation || "x"}-${Date.now().toString(36)}`;
  broadcast({ type: "run_start", prompt, lane });

  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });

  let usage = null;
  let text = "";
  try {
    const r = await streamPost(
      `${GATEWAY}/v1/chat/completions`,
      {
        "Content-Type": "application/json",
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
        "x-openclaw-session-key": sessionKey,
        ...(agentId !== "default" ? { "x-openclaw-agent-id": agentId } : {}),
        ...(lane === "gpu" ? { "x-openclaw-model": GPU_MODEL } : {}),
      },
      JSON.stringify({
        model: AGENT,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT.replace("{{TODAY}}", today) },
          { role: "user", content: prompt },
        ],
      }),
      ctrl.signal,
    );
    if (r.statusCode !== 200) {
      let t = "";
      for await (const c of r) t += c;
      throw new Error(`OpenClaw Gateway answered HTTP ${r.statusCode}: ${t.slice(0, 300)}`);
    }
    const dec = new TextDecoder();
    let buf = "";
    for await (const value of r) {
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (me.firstTokenMs == null) me.firstTokenMs = performance.now() - me.t0;
          text += delta;
          send({ type: "delta", text: delta });
        }
      }
    }
    const totalMs = performance.now() - me.t0;
    const completion = usage?.completion_tokens ?? Math.round(text.length / 4);
    const modelMs = Math.max(1, totalMs - me.toolMs);
    // Agent turns: the gaps when no tool was running (request -> first tool, between tool rounds, last tool -> end).
    // Each gap is one Kimi turn plus OpenClaw's own per-turn overhead.
    const turns = [];
    let busy = 0, last = 0;
    for (const m of me.marks.sort((a, b) => a.t - b.t)) {
      if (m.k === "start") { if (busy === 0 && m.t - last > 50) turns.push(Math.round(m.t - last)); busy++; }
      else { busy = Math.max(0, busy - 1); if (busy === 0) last = m.t; }
    }
    turns.push(Math.round(totalMs - last));
    const metrics = {
      turns,
      type: "metrics",
      lane,
      totalMs: Math.round(totalMs),
      toolMs: me.toolMs,
      modelMs: Math.round(modelMs),
      toolCalls: me.toolCalls,
      firstTokenMs: me.firstTokenMs && Math.round(me.firstTokenMs),
      firstToolMs: me.firstToolMs && Math.round(me.firstToolMs),
      promptTokens: usage?.prompt_tokens ?? null,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      completionTokens: completion,
      estimated: !usage,
      tokensPerSecond: Math.round(completion / (modelMs / 1000)),
    };
    send(metrics);
    broadcast(metrics);
    console.log(`[${lane}] done`, JSON.stringify(metrics));
    send({ type: "done", text });
  } catch (e) {
    console.log(`[${lane}] error after ${Math.round(performance.now() - me.t0)} ms: ${e.message || e}`);
    if (e.name !== "AbortError") send({ type: "error", error: String(e.message || e) });
  } finally {
    if (runs.get(lane) === me) runs.delete(lane);
    clearInterval(ping);
    res.end();
  }
}

// ---------- static files ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
async function serveStatic(req, res) {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  const file = join(WEB, p || "index.html");
  if (!file.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname.startsWith("/api/tools/") && req.method === "POST") {
      const name = url.pathname.slice("/api/tools/".length);
      try {
        return json(res, 200, await runTool(name, await body(req), laneFor(req)));
      } catch (e) {
        return json(res, e.code || 502, { error: String(e.message || e) });
      }
    }
    if (url.pathname === "/api/plan" && req.method === "POST") return plan(req, res);
    if (url.pathname === "/api/trips" && req.method === "GET") return json(res, 200, await list_trips({ limit: 200 }));
    if (url.pathname === "/api/trips" && req.method === "POST") {
      const b = await body(req);
      const r = await save_trip(b);
      broadcast({ type: "trips_changed" });
      return json(res, 200, r);
    }
    if (url.pathname.startsWith("/api/trips/") && req.method === "GET") {
      const trip = await get_trip({ id: decodeURIComponent(url.pathname.slice("/api/trips/".length)) });
      return trip ? json(res, 200, trip) : json(res, 404, { error: "not found" });
    }
    if (url.pathname.startsWith("/api/trips/") && req.method === "DELETE") {
      await delete_trip({ id: decodeURIComponent(url.pathname.slice("/api/trips/".length)) });
      broadcast({ type: "trips_changed" });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/maps-config") {
      // The Maps JavaScript API needs the key in the browser. The dashboard only listens on localhost.
      // Set KX_GOOGLE_MAP=0 to keep the OpenStreetMap map even when a key is set.
      const key = GOOGLE_KEY_VAR && process.env.KX_GOOGLE_MAP !== "0" ? process.env[GOOGLE_KEY_VAR] : null;
      return json(res, 200, { googleKey: key || null });
    }
    if (url.pathname === "/api/health") {
      let gateway = "unreachable";
      try {
        const r = await fetch(`${GATEWAY}/v1/models`, { headers: GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}, signal: AbortSignal.timeout(10000) });
        gateway = r.ok ? "ok" : `HTTP ${r.status}`;
      } catch (e) {
        // A timeout means the gateway accepted the connection but is busy (e.g. mid agent run); refused means it's down.
        if (e?.name === "TimeoutError") gateway = "busy";
      }
      return json(res, 200, { ok: true, gateway, agent: AGENT, tokenSet: !!GATEWAY_TOKEN, google: GOOGLE_KEY_VAR ? { keyVar: GOOGLE_KEY_VAR } : null, gpu: GPU_MODEL ? { model: GPU_MODEL, label: GPU_LABEL } : null });
    }
    return serveStatic(req, res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`Kimi Express dashboard: http://${HOST}:${PORT}`);
  console.log(`OpenClaw Gateway: ${GATEWAY} (agent ${AGENT}, token ${GATEWAY_TOKEN ? "set" : "NOT set"})`);
  console.log(GOOGLE_KEY_VAR ? `Google Maps Platform: on (key from env ${GOOGLE_KEY_VAR})` : "Google Maps Platform: off (OpenStreetMap, Photon, OSRM)");
  console.log(GPU_MODEL ? `Race mode: Cerebras vs ${GPU_LABEL} (${GPU_MODEL})` : "Race mode off (set KX_GPU_MODEL to enable)");
});
