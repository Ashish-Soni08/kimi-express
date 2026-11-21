// Kimi Express dashboard
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- home station + example chips ----------
const home = () => store.get("kx-home", "Hannover Hbf");
const homeInput = document.createElement("input");
homeInput.id = "home";
homeInput.value = home();
homeInput.placeholder = "Your home station";
homeInput.className = "home";
homeInput.title = "Your home station (used in the examples)";
homeInput.addEventListener("change", () => { store.set("kx-home", homeInput.value.trim() || "Hannover Hbf"); renderChips(); });
const homeRow = document.createElement("div");
homeRow.className = "homerow";
homeRow.innerHTML = `<span class="muted">From</span>`;
homeRow.appendChild(homeInput);
$("#ask label").after(homeRow);
const st = document.createElement("style");
st.textContent = `.homerow{display:flex;gap:8px;align-items:center;margin-bottom:8px}.home{flex:1;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 8px;font:inherit}`;
document.head.appendChild(st);

function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}
const EXAMPLES = [
  ["Berlin classics", () => `Day trip to Berlin on ${tomorrow()} from ${home()}, leaving around 8:00. I want to see Museum Island, the Brandenburg Gate and the East Side Gallery. Back home by 21:00.`],
  ["Surprise me: Hamburg", () => `Plan a relaxed day in Hamburg on ${tomorrow()} from ${home()}. Suggest the 3 best sights near the centre, include lunch, back by 20:00.`],
  ["Cologne quickie", () => `Half-day in Cologne on ${tomorrow()} from ${home()}: Cologne Cathedral and the Chocolate Museum, leave after 12:00.`],
  ["My trip history", () => `How many day trips have I logged, and which city did I visit most?`],
];
function renderChips() {
  $("#chips").innerHTML = "";
  for (const [label, make] of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.onclick = () => { $("#prompt").value = make(); $("#prompt").focus(); };
    $("#chips").appendChild(b);
  }
}
renderChips();

// ---------- map ----------
const map = L.map("map", { zoomControl: true }).setView([51.2, 10.4], 6);
// Standard OpenStreetMap tiles (keyless), darkened with a CSS filter on the tile pane only.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);
let routeLayer = L.layerGroup().addTo(map);
let layers = L.layerGroup().addTo(map);
let suggLayer = L.layerGroup().addTo(map);
const icon = (html, cls = "") => L.divIcon({ className: "", html: `<div class="num-marker ${cls}">${html}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function fit(points) {
  const pts = points.filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
  if (pts.length === 1) map.flyTo(pts[0], 14, { duration: 0.6 });
  else if (pts.length > 1) map.flyToBounds(pts, { padding: [40, 40], duration: 0.6, maxZoom: 15 });
}

// ---------- status line + optional speed panel ----------
// The speed panel and race toggle only show with ?speed=1 (trip mode is the default).
const SHOW_SPEED = new URLSearchParams(location.search).get("speed") === "1";
if (!SHOW_SPEED) $("#speed").classList.add("hidden");
const STEP = { find_places: "Finding the places…", search_trains: "Checking Deutsche Bahn trains…", travel_between: "Working out walking and transit times…", publish_plan: "Laying out your day…", save_trip: "Saving to your trip log…", list_trips: "Reading your trip log…" };
let statusT0 = 0, statusTimer = null;
function status(text, cls = "") {
  const el = $("#status");
  el.className = "status " + cls;
  el.querySelector(".txt").textContent = text;
}
function statusStart() {
  statusT0 = performance.now();
  status("Kimi is planning your day…", "busy");
  clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    const s = Math.round((performance.now() - statusT0) / 1000);
    $("#status .el").textContent = s >= 5 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
  }, 1000);
}
function statusStop(text, cls) { clearInterval(statusTimer); $("#status .el").textContent = ""; status(text, cls); }
// ---------- speed panel ----------
let timerId = null, t0 = 0;
function startTimer() {
  t0 = performance.now();
  $("#speed").classList.add("running");
  ["#m-tps", "#m-total", "#m-ttft", "#m-tools", "#m-tokens"].forEach((s) => ($(s).textContent = "…"));
  clearInterval(timerId);
  timerId = setInterval(() => ($("#timer").textContent = ((performance.now() - t0) / 1000).toFixed(1) + " s"), 50);
}
function stopTimer() { clearInterval(timerId); $("#speed").classList.remove("running"); }
function showMetrics(m) {
  stopTimer();
  $("#m-tps").textContent = m.tokensPerSecond?.toLocaleString() ?? "—";
  $("#m-total").textContent = (m.totalMs / 1000).toFixed(1) + " s";
  $("#m-ttft").textContent = m.firstTokenMs ? (m.firstTokenMs / 1000).toFixed(2) + " s" : "—";
  $("#m-tools").textContent = `${m.toolCalls} · ${(m.toolMs / 1000).toFixed(1)} s`;
  $("#m-tokens").textContent = (m.completionTokens ?? "—").toLocaleString() + (m.estimated ? "≈" : "");
  const turns = (m.turns || []).map((t) => (t / 1000).toFixed(1) + "s").join(" · ");
  $("#timer").textContent = `Kimi turns ${turns || "—"} · tools ${(m.toolMs / 1000).toFixed(1)} s`;
}

// ---------- agent activity feed ----------
const LABEL = { find_places: "📍 find_places", search_trains: "🚆 search_trains", travel_between: "🚶 travel_between", publish_plan: "🗺️ publish_plan", save_trip: "💾 save_trip", list_trips: "📒 list_trips" };
function argSummary(name, a = {}) {
  if (name === "find_places") return `${a.city || ""}: ${(a.places || []).join(", ") || (a.discover ? "discover sights" : "")}`;
  if (name === "search_trains") return `${a.from} → ${a.to} · ${a.arriveBy ? "arrive by" : "depart"} ${a.when ? new Date(a.when).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "now"}`;
  if (name === "travel_between") return `${(a.legs || []).length} legs`;
  if (name === "publish_plan") return a.plan?.title || "";
  return "";
}
function resultSummary(name, r) {
  if (!r) return "";
  if (name === "find_places") return `${r.places?.filter((p) => p.found).length ?? 0} found${r.suggestions?.length ? `, ${r.suggestions.length} suggestions` : ""}`;
  if (name === "search_trains") {
    const opts = (r.options || []).slice(0, 4).map((o) => `<li>${esc(o.departureLocal)} → ${esc(o.arrivalLocal)} · ${Math.floor(o.durationMin / 60)}h${String(o.durationMin % 60).padStart(2, "0")} · ${o.changes}× · ${esc(o.legs.filter((l) => l.line !== "walk").map((l) => l.line).join(", "))}</li>`).join("");
    return `${esc(r.source || "")}${r.note ? " ⚠️" : ""}<ul class="options">${opts}</ul>`;
  }
  if (name === "travel_between") return `${r.totalMinutes} min total · ${r.totalWalkKm} km walking`;
  if (name === "list_trips") return `${r.count} trips`;
  return "";
}
const feedItems = new Map();
function feedClear() { $("#feed").innerHTML = ""; feedItems.clear(); }
function feedAdd(id, cls, html) {
  const li = document.createElement("li");
  li.className = cls; li.innerHTML = html;
  $("#feed").appendChild(li);
  feedItems.set(id, li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

// ---------- tool results -> map ----------
let lastPlaces = [];
let lastRoutes = []; // street routes from travel_between, stored with a saved trip
function onToolResult(name, args, r) {
  if (name === "find_places" && r) {
    lastPlaces = (r.places || []).filter((p) => p.found);
    suggLayer.clearLayers();
    for (const s of r.suggestions || []) if (s.lat) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="num-marker sugg"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) }).bindTooltip(esc(s.name)).addTo(suggLayer);
    layers.clearLayers();
    lastPlaces.forEach((p, i) => L.marker([p.lat, p.lon], { icon: icon(i + 1) }).bindTooltip(esc(p.name)).addTo(layers));
    fit([...lastPlaces.map((p) => [p.lat, p.lon]), ...(r.suggestions || []).filter((s) => s.lat).map((s) => [s.lat, s.lon])]);
  }
  if (name === "travel_between" && r) {
    for (const leg of r.legs || []) {
      if (leg.geometry?.length) lastRoutes.push({ geometry: leg.geometry, mode: leg.recommended, label: `${leg.from} → ${leg.to}: ${leg.minutes} min (${leg.recommended})` });
      L.polyline(leg.geometry, { color: leg.recommended === "transit" ? "#5b8cff" : "#f05a28", weight: 4, opacity: 0.85, dashArray: leg.recommended === "transit" ? "6 6" : null })
        .bindTooltip(`${esc(leg.from)} → ${esc(leg.to)}: ${leg.minutes} min (${leg.recommended})`)
        .addTo(routeLayer);
    }
  }
  if (name === "publish_plan") renderPlan(args.plan);
}

// ---------- plan panel ----------
let currentPlan = null;
const fmtDur = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}` : `${Math.round(m)}m`);
function trainCard(tag, t) {
  if (!t) return "";
  return `<div class="train"><div class="row"><span class="tag">${tag}</span><span class="tag">${fmtDur(t.durationMin)} · ${t.changes ?? 0} change${t.changes === 1 ? "" : "s"}</span></div>
    <div class="times">${esc(t.departureLocal)} → ${esc(t.arrivalLocal)}</div>
    <div class="lines">${esc((t.lines || []).join(" · "))}</div></div>`;
}
function renderPlan(plan) {
  if (!plan) return;
  currentPlan = plan;
  showTab("plan");
  if (plan.origin) homeInput.value = plan.origin; // show where this trip starts (not saved as home)
  const tot = plan.totals || {};
  const legs = plan.legs || [];
  let tl = "";
  (plan.stops || []).forEach((s, i) => {
    tl += `<li><span class="n">${i + 1}</span><div class="when">${esc(s.arrive || "")}${s.leave ? "–" + esc(s.leave) : ""}${s.minutes ? ` · ${fmtDur(s.minutes)}` : ""}</div>
      <div class="name">${esc(s.name)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}</li>`;
    const leg = legs[i + 1] || null;
    if (leg && i < plan.stops.length - 1) tl += `<div class="leg">${leg.mode === "transit" ? "🚇" : "🚶"} ${fmtDur(leg.minutes)}${leg.km ? ` · ${leg.km} km` : ""}</div>`;
  });
  $("#plan").classList.remove("muted");
  $("#plan").innerHTML = `
    <div class="plan-head"><h3>${esc(plan.title)}</h3><p>${esc(plan.date || "")} · ${esc(plan.origin)} → ${esc(plan.destination)}</p></div>
    <div class="totals">
      <div><b>${fmtDur(tot.trainMinutes)}</b><span>on trains</span></div>
      <div><b>${fmtDur(tot.localMinutes)}</b><span>getting around</span></div>
      <div><b>${tot.walkKm ?? "—"}${tot.walkKm != null ? " km" : ""}</b><span>walking</span></div>
    </div>
    ${trainCard("Outbound", plan.outbound)}
    <ol class="tl">${tl}</ol>
    ${trainCard("Return", plan.return)}
    ${plan.tips?.length ? `<ul class="tips">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <button class="btn" id="save">💾 Save to trip log</button>`;
  $("#save").onclick = saveCurrent;

  // redraw stops on the map in plan order
  layers.clearLayers();
  const pts = (plan.stops || []).filter((s) => isFinite(s.lat));
  pts.forEach((s, i) => L.marker([s.lat, s.lon], { icon: icon(i + 1) }).bindTooltip(`${i + 1}. ${esc(s.name)} ${esc(s.arrive || "")}`).addTo(layers));
  if (pts.length > 1 && !routeLayer.getLayers().length) L.polyline(pts.map((s) => [s.lat, s.lon]), { color: "#f05a28", weight: 3, opacity: 0.6, dashArray: "2 8" }).addTo(layers);
  fit(pts.map((s) => [s.lat, s.lon]));
}
async function saveCurrent() {
  if (!currentPlan) return;
  const r = await fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: { ...currentPlan, routes: currentPlan.routes || lastRoutes }, status: "planned" }) }).then((r) => r.json());
  currentPlan.id = r.id;
  const b = $("#save"); b.textContent = "✓ Saved to trip log"; b.classList.add("saved");
}

// ---------- trip log ----------
async function loadTrips() {
  const r = await fetch("/api/trips").then((r) => r.json()).catch(() => ({ trips: [] }));
  const trips = r.trips || [];
  $("#log-count").textContent = trips.length;
  const cities = new Set(trips.map((t) => t.destination).filter(Boolean));
  const trainMin = trips.reduce((s, t) => s + (t.travelMinutes || 0), 0);
  $("#log-stats").innerHTML = `<div><b>${trips.length}</b><span>trips</span></div><div><b>${cities.size}</b><span>cities</span></div><div><b>${fmtDur(trainMin)}</b><span>travel planned</span></div>`;
  $("#log").innerHTML = trips.length ? "" : `<li class="muted" style="cursor:default">No trips yet. Plan one and press Save.</li>`;
  for (const t of trips) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="status ${t.status === "done" ? "done" : ""}">${esc(t.status || "planned")}</span>
      <div class="title">${esc(t.title || t.destination)}</div>
      <div class="meta">${esc(t.date || "")} · ${esc((t.stops || []).join(" → "))}</div>
      <div class="actions"><button data-a="done">Mark done</button><button data-a="del">Delete</button></div>`;
    li.querySelector('[data-a="done"]').onclick = async (e) => { e.stopPropagation(); await fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: { id: t.id }, status: "done" }) }); };
    li.querySelector('[data-a="del"]').onclick = async (e) => { e.stopPropagation(); await fetch("/api/trips/" + encodeURIComponent(t.id), { method: "DELETE" }); };
    li.title = "Show this trip on the map";
    li.dataset.testid = "trip-item";
    li.onclick = () => openTrip(t.id);
    $("#log").appendChild(li);
  }
}
// Re-open a saved trip: plan panel, numbered stops and its stored routes on the map.
async function openTrip(id) {
  const t = await fetch("/api/trips/" + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!t) return;
  routeLayer.clearLayers();
  for (const r of t.routes || []) L.polyline(r.geometry, { color: r.mode === "transit" ? "#5b8cff" : "#f05a28", weight: 4, opacity: 0.85, dashArray: r.mode === "transit" ? "6 6" : null }).bindTooltip(esc(r.label || "")).addTo(routeLayer);
  suggLayer.clearLayers();
  renderPlan(t);
  const b = $("#save"); if (b) { b.textContent = t.status === "done" ? "✓ Done · in your trip log" : "✓ In your trip log"; b.classList.add("saved"); }
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("#tab-plan").classList.toggle("hidden", name !== "plan");
  $("#tab-log").classList.toggle("hidden", name !== "log");
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- live events from the server (tool calls made by the OpenClaw agent) ----------
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const gpu = e.lane === "gpu";
    const tag = gpu ? `<span class="lane-tag">${esc(gpuInfo?.label || "GPU")}</span>` : "";
    if (gpu && e.type?.startsWith("tool")) raceTool("gpu");
    if (!gpu && e.type?.startsWith("tool") && racing) raceTool("cerebras");
    if (e.type === "tool_start") gatewayPill("ok");
    if (e.type === "tool_start" && !gpu && $("#status").classList.contains("busy")) status(STEP[e.name] || "Working…", "busy");
    if (e.type === "tool_end" && !gpu && e.name !== "publish_plan" && $("#status").classList.contains("busy")) setTimeout(() => $("#status").classList.contains("busy") && status("Kimi is thinking…", "busy"), 600);
    if (e.type === "tool_start") feedAdd(e.id, "run" + (gpu ? " gpu" : ""), `${tag}<span class="t">${LABEL[e.name] || e.name}</span><span class="ms">…</span><div class="sub">${esc(argSummary(e.name, e.args))}</div>`);
    if (e.type === "tool_end" || e.type === "tool_error") {
      const li = feedItems.get(e.id) || feedAdd(e.id, "", "");
      li.className = (e.type === "tool_end" ? "ok" : "err") + (gpu ? " gpu" : "");
      li.innerHTML = `${tag}<span class="t">${LABEL[e.name] || e.name}</span><span class="ms">${e.ms} ms</span><div class="sub">${esc(argSummary(e.name, e.args))}</div><div class="sub">${e.type === "tool_end" ? resultSummary(e.name, e.result) : "⚠️ " + esc(e.error)}</div>`;
      if (e.type === "tool_end" && !gpu) onToolResult(e.name, e.args, e.result);
    }
    if (e.type === "trips_changed") loadTrips();
  };
  es.onerror = () => { es.close(); setTimeout(connectEvents, 2000); };
}

// ---------- ask ----------
const conversation = Math.random().toString(36).slice(2);
let gpuInfo = null;
let racing = false;

async function streamPlan(prompt, lane, { onDelta, onMetrics, onError }) {
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, conversation, lane }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith("data:")) continue;
        const e = JSON.parse(chunk.slice(5));
        if (e.type === "delta") onDelta?.(e.text);
        if (e.type === "metrics") onMetrics?.(e);
        if (e.type === "error") onError?.(e.error);
      }
    }
  } catch (err) {
    onError?.(err.message);
  }
}

// ---------- race: Cerebras vs GPU ----------
const race = {};
let raceTimer = null;
function raceStart() {
  const box = $("#race");
  box.classList.remove("hidden");
  const t = performance.now();
  for (const lane of ["cerebras", "gpu"]) race[lane] = { t, done: null, tools: 0, tps: null };
  box.innerHTML = ["cerebras", "gpu"].map((lane) => `
    <div class="lane ${lane}" id="lane-${lane}">
      <div class="lane-head"><b>${lane === "cerebras" ? "Kimi K3.1 Pro · Cerebras" : esc(gpuInfo?.label || "GPU")}</b><span class="lane-time" id="lt-${lane}">0.0 s</span></div>
      <div class="bar"><div class="fill" id="lb-${lane}"></div></div>
      <div class="lane-sub" id="ls-${lane}">working…</div>
    </div>`).join("");
  clearInterval(raceTimer);
  raceTimer = setInterval(() => {
    const now = performance.now();
    const max = Math.max(...Object.values(race).map((r) => ((r.done ?? now) - r.t) / 1000), 1);
    for (const lane of ["cerebras", "gpu"]) {
      const r = race[lane];
      const sec = ((r.done ?? now) - r.t) / 1000;
      $("#lt-" + lane).textContent = sec.toFixed(1) + " s";
      $("#lb-" + lane).style.width = Math.min(100, (sec / max) * 100) + "%";
    }
    if (Object.values(race).every((r) => r.done)) clearInterval(raceTimer);
  }, 50);
}
function raceTool(lane) { if (race[lane] && !race[lane].done) { race[lane].tools++; $("#ls-" + lane).textContent = `working… ${race[lane].tools} tool events`; } }
function raceDone(lane, m, err) {
  const r = race[lane];
  if (!r || r.done) return;
  r.done = performance.now();
  const el = $("#lane-" + lane);
  el.classList.add("done");
  $("#ls-" + lane).textContent = err ? `⚠️ ${err}` : `plan ready · ${m?.tokensPerSecond?.toLocaleString() ?? "—"} tok/s · ${m?.toolCalls ?? 0} tool calls`;
  const other = race[lane === "cerebras" ? "gpu" : "cerebras"];
  if (other?.done && !err) {
    const c = race.cerebras, g = race.gpu;
    const ct = c.done - c.t, gt = g.done - g.t;
    const x = gt / ct;
    $("#race").insertAdjacentHTML("beforeend", `<div class="verdict" data-testid="race-verdict">${x >= 1 ? `Cerebras finished <b>${x.toFixed(1)}× faster</b>` : `GPU finished first this time`}</div>`);
  }
}

// Automation hooks: body[data-state] is idle | running | done | error,
// [data-testid="plan-complete"] appears when the Cerebras plan is finished,
// [data-testid="race-complete"] appears when both race lanes are finished.
function setState(st) { document.body.dataset.state = st; }
function marker(id) {
  if (document.querySelector(`[data-testid="${id}"]`)) return;
  const m = document.createElement("span");
  m.dataset.testid = id; m.hidden = true;
  if (id === "plan-complete") m.setAttribute("data-plan-ready", "");
  document.body.appendChild(m);
}
setState("idle");

async function ask(prompt) {
  document.querySelectorAll('[data-testid="plan-complete"],[data-testid="race-complete"]').forEach((e) => e.remove());
  currentPlan = null;
  setState("running");
  $("#go").disabled = true;
  racing = !!(gpuInfo && $("#race-on")?.checked);
  feedClear();
  routeLayer.clearLayers();
  lastRoutes = [];
  feedAdd("k", "run", `<span class="t">🧠 Kimi K3.1 Pro</span><span class="ms">thinking</span><div class="sub">via OpenClaw → Cerebras</div>`);
  $("#answer").textContent = "";
  $("#answer").classList.remove("muted");
  $("#answer").classList.add("streaming");
  startTimer();
  statusStart();
  if (racing) raceStart(); else $("#race").classList.add("hidden");
  const main = streamPlan(prompt, "cerebras", {
    onDelta: (t) => ($("#answer").textContent += t),
    onMetrics: (m) => { showMetrics(m); if (racing) raceDone("cerebras", m); },
    onError: (e) => { $("#answer").textContent += `\n⚠️ ${e}`; stopTimer(); if (racing) raceDone("cerebras", null, e); },
  });
  const gpu = racing
    ? streamPlan(prompt, "gpu", { onMetrics: (m) => raceDone("gpu", m), onError: (e) => raceDone("gpu", null, e) })
    : Promise.resolve();
  await main;
  const k = feedItems.get("k"); if (k) { k.className = "ok"; k.querySelector(".ms").textContent = "done"; }
  $("#answer").classList.remove("streaming");
  if (currentPlan) { marker("plan-complete"); statusStop("Your day is planned ✓", "ok"); }
  else { setState("error"); statusStop("Kimi didn't finish a plan. Try again.", "err"); }
  await gpu;
  if (racing) marker("race-complete");
  setState(document.querySelector("#answer").textContent.includes("⚠️") ? "error" : "done");
  $("#go").disabled = false;
}
$("#ask").onsubmit = (e) => { e.preventDefault(); const p = $("#prompt").value.trim(); if (p) ask(p); };
$("#prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask").requestSubmit(); } });

// ---------- boot ----------
function gatewayPill(state) {
  const p = $("#pill-gateway");
  const ok = state === "ok" || state === "busy";
  p.textContent = state === "ok" ? "Gateway connected" : state === "busy" ? "Gateway busy" : `Gateway ${state}`;
  p.classList.toggle("ok", ok);
  p.classList.toggle("err", !ok);
}
function checkGateway() {
  if (document.body.dataset.state === "running") return; // a run in progress already proves the gateway is up
  fetch("/api/health").then((r) => r.json()).then((h) => gatewayPill(h.gateway)).catch(() => gatewayPill("unreachable"));
}
setInterval(checkGateway, 30000);
fetch("/api/health").then((r) => r.json()).then((h) => {
  gatewayPill(h.gateway);
  if (h.gpu && SHOW_SPEED) {
    gpuInfo = h.gpu;
    $("#go").insertAdjacentHTML("beforebegin", `<label class="race-toggle"><input type="checkbox" id="race-on" data-testid="race-toggle" /> Race vs ${esc(h.gpu.label)}</label>`);
    const cb = $("#race-on");
    cb.checked = store.get("kx-race", "0") === "1";
    cb.onchange = () => store.set("kx-race", cb.checked ? "1" : "0");
  }
}).catch(() => {});
connectEvents();
loadTrips();
