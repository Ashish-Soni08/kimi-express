import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "./MapView.jsx";

// ---------- helpers ----------
const fmtDur = (m) => (m == null || isNaN(m) ? "—" : m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)} min`);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const km = (a, b) => {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const tomorrow = () => new Date(Date.now() + 86400000).toLocaleDateString("en-GB", { weekday: "long" });

const STEP = {
  find_places: "Finding the places…",
  search_trains: "Checking Deutsche Bahn trains…",
  travel_between: "Working out walking and transit times…",
  publish_plan: "Laying out your day…",
  save_trip: "Saving to your trip log…",
  list_trips: "Reading your trip log…",
};
const TOOL = {
  find_places: { icon: "📍", label: "Find places" },
  search_trains: { icon: "🚆", label: "Search trains" },
  travel_between: { icon: "🚶", label: "Travel times" },
  publish_plan: { icon: "🗺️", label: "Publish plan" },
  save_trip: { icon: "💾", label: "Save trip" },
  list_trips: { icon: "📒", label: "Trip log" },
};
function argSummary(name, a = {}) {
  if (name === "find_places") return `${a.city || ""}: ${(a.places || []).join(", ") || (a.discover ? "discover sights" : "")}`;
  if (name === "search_trains") return `${a.from} → ${a.to} · ${a.arriveBy ? "arrive by" : "depart"} ${a.when ? new Date(a.when).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "now"}`;
  if (name === "travel_between") return `${(a.legs || []).length} legs`;
  if (name === "publish_plan") return a.plan?.title || "";
  return "";
}
function resultSummary(name, r) {
  if (!r) return "";
  if (name === "find_places") return `${(r.places || []).filter((p) => p.found).length} found${r.suggestions?.length ? ` · ${r.suggestions.length} ideas` : ""}`;
  if (name === "search_trains") return (r.options || []).slice(0, 3).map((o) => `${o.departureLocal}→${o.arrivalLocal} ${o.changes}×`).join(" · ") || r.error || "";
  if (name === "travel_between") return `${r.totalMinutes} min · ${r.totalWalkKm} km walking`;
  if (name === "list_trips") return `${r.count} trips`;
  return "";
}

// ---------- app ----------
export default function App() {
  const [cfg, setCfg] = useState({ googleKey: null, loaded: false });
  const [health, setHealth] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [home, setHome] = useState(() => store.get("kx-home", "Berlin Hbf"));
  const [state, setState] = useState("idle");
  const [status, setStatus] = useState({ text: "Ready when you are.", tone: "idle" });
  const [feed, setFeed] = useState([]);
  const [answer, setAnswer] = useState("");
  const [places, setPlaces] = useState([]);
  const [sugg, setSugg] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [plan, setPlan] = useState(null);
  const [saved, setSaved] = useState(false);
  const [trips, setTrips] = useState([]);
  const [tab, setTab] = useState("plan");
  const [fitKey, setFitKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const running = state === "running";
  const t0 = useRef(0);
  const runRef = useRef(false);
  const planRef = useRef(null);

  useEffect(() => { document.body.dataset.state = state; }, [state]);
  useEffect(() => { fetch("/api/maps-config").then((r) => r.json()).then((c) => setCfg({ googleKey: c.googleKey, loaded: true })).catch(() => setCfg({ googleKey: null, loaded: true })); }, []);
  const checkHealth = useCallback(() => { fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth({ gateway: "unreachable" })); }, []);
  useEffect(() => { checkHealth(); const t = setInterval(() => !runRef.current && checkHealth(), 30000); return () => clearInterval(t); }, [checkHealth]);
  const loadTrips = useCallback(() => fetch("/api/trips").then((r) => r.json()).then((r) => setTrips(r.trips || [])).catch(() => {}), []);
  useEffect(() => { loadTrips(); }, [loadTrips]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Math.round((performance.now() - t0.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  // live tool events from the OpenClaw agent
  useEffect(() => {
    let es, retry;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.lane === "gpu") return;
        if (e.type === "trips_changed") return loadTrips();
        if (e.type === "tool_start") {
          setHealth((h) => ({ ...(h || {}), gateway: "ok" }));
          if (runRef.current) setStatus({ text: STEP[e.name] || "Working…", tone: "busy" });
          setFeed((f) => [...f, { id: e.id, name: e.name, args: e.args, status: "run" }]);
        }
        if (e.type === "tool_end" || e.type === "tool_error") {
          setFeed((f) => f.map((x) => (x.id === e.id ? { ...x, status: e.type === "tool_end" ? "ok" : "err", ms: e.ms, result: e.result, error: e.error } : x)));
          if (e.type === "tool_end") onToolResult(e.name, e.args, e.result);
          if (runRef.current && e.name !== "publish_plan") setTimeout(() => runRef.current && setStatus((s) => (s.tone === "busy" ? { text: "Kimi is thinking…", tone: "busy" } : s)), 700);
        }
      };
      es.onerror = () => { es.close(); retry = setTimeout(connect, 2000); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToolResult = (name, args, r) => {
    if (name === "find_places" && r) {
      setPlaces((prev) => {
        const found = (r.places || []).filter((p) => p.found);
        const key = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        const m = new Map([...prev, ...found].map((p) => [key(p), p]));
        return [...m.values()];
      });
      setSugg((r.suggestions || []).filter((s) => s.lat));
      setFitKey((k) => k + 1);
    }
    if (name === "travel_between" && r) {
      setRoutes((r.legs || []).filter((l) => l.geometry?.length).map((l) => ({ geometry: l.geometry, mode: l.recommended === "transit" ? "transit" : "walk", label: `${l.from} → ${l.to}: ${l.minutes} min` })));
      setFitKey((k) => k + 1);
    }
    if (name === "publish_plan" && args?.plan) {
      planRef.current = args.plan;
      setPlan(args.plan);
      setSaved(false);
      setTab("plan");
      if (args.plan.origin) setHome(args.plan.origin);
      setFitKey((k) => k + 1);
    }
  };

  async function ask(text) {
    if (!text.trim() || runRef.current) return;
    runRef.current = true;
    t0.current = performance.now();
    setElapsed(0);
    setState("running");
    setStatus({ text: "Kimi is planning your day…", tone: "busy" });
    setFeed([]); setAnswer(""); setPlaces([]); setSugg([]); setRoutes([]); setPlan(null); setSaved(false);
    planRef.current = null;
    setTab("agent");
    let failed = false;
    try {
      const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, conversation: Math.random().toString(36).slice(2), lane: "cerebras" }) });
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
          if (e.type === "delta") setAnswer((a) => a + e.text);
          if (e.type === "error") { failed = true; setAnswer((a) => a + `\n⚠️ ${e.error}`); }
        }
      }
    } catch (err) {
      failed = true;
      setAnswer((a) => a + `\n⚠️ ${err.message}`);
    }
    runRef.current = false;
    if (planRef.current) { setStatus({ text: "Your day is planned ✓", tone: "ok" }); setState(failed ? "error" : "done"); setTab("plan"); }
    else { setStatus({ text: "Kimi didn't finish a plan. Try again.", tone: "err" }); setState("error"); }
  }

  async function save() {
    if (!plan) return;
    const r = await fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: { ...plan, routes: plan.routes || routes, places: plan.places || places }, status: "planned" }) }).then((r) => r.json());
    setPlan((p) => ({ ...p, id: r.id }));
    setSaved(true);
    loadTrips();
  }
  async function openTrip(id) {
    const t = await fetch("/api/trips/" + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!t) return;
    setPlan(t); setSaved(true); setRoutes(t.routes || []); setPlaces(t.places || []); setSugg([]); setTab("plan"); setFitKey((k) => k + 1);
  }
  async function tripAction(t, action) {
    if (action === "done") await fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: { id: t.id }, status: t.status === "done" ? "planned" : "done" }) });
    if (action === "del") await fetch("/api/trips/" + encodeURIComponent(t.id), { method: "DELETE" });
    loadTrips();
  }

  // map pins: plan stops (numbered) once there is a plan, otherwise places found so far
  const pins = useMemo(() => {
    const out = [];
    const stops = (plan?.stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lon));
    const enrich = (p) => places.find((q) => km(p, q) < 0.3);
    if (stops.length) stops.forEach((s, i) => { const g = enrich(s); out.push({ lat: s.lat, lon: s.lon, label: i + 1, kind: "stop", title: `${i + 1}. ${s.name}`, sub: [s.arrive && `${s.arrive}${s.leave ? "–" + s.leave : ""}`, g?.rating && `★ ${g.rating} (${g.ratings?.toLocaleString() || 0})`, s.note].filter(Boolean).join(" · ") }); });
    else places.forEach((p, i) => out.push({ lat: p.lat, lon: p.lon, label: i + 1, kind: "stop", title: p.name, sub: [p.address, p.rating && `★ ${p.rating}`].filter(Boolean).join(" · ") }));
    sugg.slice(0, 12).forEach((s) => out.push({ lat: s.lat, lon: s.lon, kind: "sugg", title: s.name, sub: s.kind || "" }));
    return out;
  }, [plan, places, sugg]);
  const mapRoutes = useMemo(() => {
    if (routes.length) return routes;
    const stops = (plan?.stops || []).filter((s) => isFinite(s.lat));
    return stops.length > 1 ? [{ geometry: stops.map((s) => [s.lat, s.lon]), mode: "walk", dotted: true }] : [];
  }, [routes, plan]);

  const examples = [
    `Day trip to Potsdam ${tomorrow()} from ${home}. Sanssouci Palace and the Dutch Quarter, back by 19:00.`,
    `Day trip to Hamburg ${tomorrow()} from ${home}. Speicherstadt, Elbphilharmonie plaza and a harbour walk, home by 21:00.`,
    `Leipzig ${tomorrow()} from ${home}: Thomaskirche, the Old Town Hall and coffee at Zum Arabischen Coffe Baum.`,
  ];
  const planReady = state !== "running" && !!plan;
  const gw = health?.gateway;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex items-center justify-between gap-4 border-b border-line bg-panel/80 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-[#b3361a] text-xl shadow-[0_0_24px_#f05a2855]">🚆</div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight">Kimi Express</h1>
            <p className="text-xs text-muted">Your day trip, planned end to end: places, real DB trains, walking times</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-line px-3 py-1 text-muted">Kimi K3.1 Pro · Cerebras</span>
          <span className="rounded-full border border-line px-3 py-1 text-muted">OpenClaw</span>
          {cfg.googleKey && <span className="rounded-full border border-line px-3 py-1 text-muted">Google Maps</span>}
          <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1 text-muted" data-testid="gateway-pill">
            <span className={`h-2 w-2 rounded-full ${gw === "ok" || gw === "busy" ? "bg-good shadow-[0_0_8px_#3ecf8e]" : gw ? "bg-red-500" : "bg-muted"}`} />
            {gw === "ok" ? "Agent online" : gw === "busy" ? "Agent busy" : gw ? "Agent offline" : "Connecting…"}
          </span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[440px_1fr]">
        {/* left column */}
        <section className="flex min-h-0 flex-col gap-4">
          <form
            className="rounded-2xl border border-line bg-panel p-4"
            onSubmit={(e) => { e.preventDefault(); ask(prompt); }}
          >
            <label className="mb-2 block text-sm font-bold">Where to?</label>
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-muted">From</span>
              <input
                className="flex-1 rounded-lg border border-line bg-panel2 px-2 py-1.5 outline-none focus:border-accent"
                value={home}
                onChange={(e) => setHome(e.target.value)}
                onBlur={() => store.set("kx-home", home.trim() || "Berlin Hbf")}
                data-testid="home-station"
              />
            </div>
            <textarea
              rows={3}
              data-testid="trip-prompt"
              className="w-full resize-none rounded-xl border border-line bg-panel2 p-3 text-sm outline-none focus:border-accent"
              placeholder={examples[0]}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(prompt); } }}
            />
            <div className="my-2 flex flex-wrap gap-1.5">
              {["Potsdam", "Hamburg", "Leipzig"].map((c, i) => (
                <button type="button" key={c} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-white" onClick={() => setPrompt(examples[i])}>{c}</button>
              ))}
            </div>
            <button type="submit" data-testid="plan-button" disabled={running} className="w-full rounded-xl bg-gradient-to-br from-accent to-[#c63d17] py-2.5 text-sm font-bold text-white disabled:cursor-progress disabled:opacity-60">
              {running ? "Planning…" : "Plan my day"} <span className="ml-1 text-xs opacity-70">↵</span>
            </button>
            <div className="mt-3 flex items-center justify-between text-sm" data-testid="status">
              <span className={`flex items-center gap-2 ${status.tone === "err" ? "text-red-400" : status.tone === "idle" ? "text-muted" : ""}`}>
                <span className={`h-2 w-2 rounded-full ${status.tone === "busy" ? "pulse-dot bg-accent" : status.tone === "ok" ? "bg-good" : status.tone === "err" ? "bg-red-500" : "bg-muted"}`} />
                <span className="txt">{status.text}</span>
              </span>
              {running && elapsed >= 5 && <span className="font-mono text-xs text-muted">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>}
            </div>
          </form>

          <div className="flex gap-1.5">
            {[["plan", "Today's plan"], ["agent", `Agent${feed.length ? ` · ${feed.length}` : ""}`], ["trips", `Trip log · ${trips.length}`]].map(([k, label]) => (
              <button key={k} data-testid={`tab-${k}`} onClick={() => setTab(k)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${tab === k ? "border-accent text-white" : "border-line text-muted"}`}>{label}</button>
            ))}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-panel p-4">
            {tab === "plan" && <PlanPanel plan={plan} places={places} saved={saved} onSave={save} running={running} />}
            {tab === "agent" && <AgentPanel feed={feed} answer={answer} running={running} />}
            {tab === "trips" && <TripsPanel trips={trips} onOpen={openTrip} onAction={tripAction} />}
          </div>
        </section>

        {/* map */}
        <section className="relative min-h-[420px] overflow-hidden rounded-2xl border border-line bg-panel">
          {cfg.loaded && <MapView googleKey={cfg.googleKey} pins={pins} routes={mapRoutes} fitKey={fitKey} />}
          {plan && (
            <div className="pointer-events-none absolute right-4 top-4 max-w-sm rounded-xl border border-line bg-ink/85 px-4 py-3 backdrop-blur">
              <div className="text-xs uppercase tracking-wider text-muted">{plan.date} · {plan.origin} → {plan.destination}</div>
              <div className="font-bold">{plan.title}</div>
              {plan.summary && <div className="mt-1 text-xs text-muted">{plan.summary}</div>}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-4 left-4 flex gap-3 rounded-lg bg-ink/80 px-3 py-1.5 text-xs text-muted">
            <span><span className="mr-1 inline-block h-1 w-4 rounded bg-accent align-middle" />walk</span>
            <span><span className="mr-1 inline-block h-1 w-4 rounded bg-transit align-middle" />transit</span>
          </div>
        </section>
      </main>
      {planReady && <span hidden data-testid="plan-complete" data-plan-ready="" />}
    </div>
  );
}

// ---------- plan ----------
function TrainCard({ tag, t }) {
  if (!t) return null;
  return (
    <div className="mb-3 rounded-xl border border-line bg-gradient-to-br from-[#1f2433] to-[#171a23] px-4 py-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted">
        <span>{tag}</span>
        <span>{fmtDur(t.durationMin)} · {t.changes ?? 0} {t.changes === 1 ? "change" : "changes"}</span>
      </div>
      <div className="mt-1 font-mono text-xl font-bold">{t.departureLocal} → {t.arrivalLocal}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {(t.lines || []).map((l, i) => <span key={i} className="rounded bg-rail/90 px-1.5 py-0.5 text-[11px] font-bold text-white">{l}</span>)}
      </div>
    </div>
  );
}

function PlanPanel({ plan, places, saved, onSave, running }) {
  if (!plan) {
    return (
      <div className="text-sm text-muted" data-testid="plan-panel">
        {running ? "Kimi is working on it. Watch the Agent tab and the map fill in." : "Your plan appears here: trains there and back, your stops with times, and how you get between them."}
      </div>
    );
  }
  const tot = plan.totals || {};
  const legs = plan.legs || [];
  const enrich = (s) => (isFinite(s.lat) ? places.find((q) => km(s, q) < 0.3) : null);
  return (
    <div data-testid="plan-panel">
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        {[[fmtDur(tot.trainMinutes), "on trains"], [fmtDur(tot.localMinutes), "getting around"], [tot.walkKm != null ? `${tot.walkKm} km` : "—", "walking"]].map(([v, l]) => (
          <div key={l} className="rounded-xl bg-panel2 py-2"><div className="font-mono text-base font-bold">{v}</div><div className="text-[11px] text-muted">{l}</div></div>
        ))}
      </div>
      <TrainCard tag="Outbound" t={plan.outbound} />
      <ol className="relative mb-3 ml-1 border-l-2 border-line pl-6">
        {(plan.stops || []).map((s, i) => {
          const g = enrich(s);
          const leg = legs[i + 1];
          return (
            <li key={i} className="relative pb-4">
              <span className="absolute -left-[37px] top-0 grid h-7 w-7 place-items-center rounded-full bg-accent text-xs font-bold text-white">{i + 1}</span>
              <div className="font-mono text-xs font-semibold text-accent2">{s.arrive}{s.leave ? `–${s.leave}` : ""}{s.minutes ? ` · ${fmtDur(s.minutes)}` : ""}</div>
              <div className="font-bold">{s.name}</div>
              {g?.rating && <div className="text-xs text-amber-300">★ {g.rating} <span className="text-muted">({g.ratings?.toLocaleString()} reviews)</span>{g.mapsUrl && <a className="ml-2 text-transit hover:underline" href={g.mapsUrl} target="_blank" rel="noreferrer">Google Maps ↗</a>}</div>}
              {s.note && <div className="text-xs text-muted">{s.note}</div>}
              {leg && i < plan.stops.length - 1 && <div className="mt-2 text-xs text-muted">{leg.mode === "transit" ? "🚋" : "🚶"} {fmtDur(leg.minutes)}{leg.km ? ` · ${leg.km} km` : ""}</div>}
            </li>
          );
        })}
      </ol>
      <TrainCard tag="Return" t={plan.return} />
      {plan.tips?.length > 0 && <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-muted">{plan.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      <button onClick={onSave} disabled={saved} data-testid="save-trip" className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold ${saved ? "border-good text-good" : "border-accent hover:bg-accent/10"}`}>
        {saved ? "✓ In your trip log" : "💾 Save to trip log"}
      </button>
    </div>
  );
}

// ---------- agent ----------
function AgentPanel({ feed, answer, running }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Kimi's tool calls via OpenClaw</div>
      <ol className="mb-4 space-y-1.5" data-testid="agent-feed">
        <li className={`rounded-lg border-l-4 bg-panel2 px-3 py-2 text-xs ${running ? "border-amber-400" : "border-good"}`}>
          <span className="font-mono font-bold">🧠 Kimi K3.1 Pro</span><span className="float-right text-muted">{running ? "working" : feed.length ? "done" : "idle"}</span>
          <div className="text-muted">on Cerebras, via the OpenClaw agent harness</div>
        </li>
        {feed.map((f) => (
          <li key={f.id} className={`rounded-lg border-l-4 bg-panel2 px-3 py-2 text-xs ${f.status === "run" ? "border-amber-400" : f.status === "ok" ? "border-good" : "border-red-500"}`}>
            <span className="font-mono font-bold">{TOOL[f.name]?.icon} {TOOL[f.name]?.label || f.name}</span>
            <span className="float-right font-mono text-muted">{f.ms != null ? `${f.ms} ms` : "…"}</span>
            <div className="text-muted">{argSummary(f.name, f.args)}</div>
            {f.status === "ok" && <div className="text-muted">{resultSummary(f.name, f.result)}</div>}
            {f.status === "err" && <div className="text-red-400">⚠️ {f.error}</div>}
          </li>
        ))}
      </ol>
      {answer && (
        <>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Kimi says</div>
          <div className="whitespace-pre-wrap text-sm" data-testid="answer">{answer}</div>
        </>
      )}
    </div>
  );
}

// ---------- trip log ----------
function TripsPanel({ trips, onOpen, onAction }) {
  const cities = new Set(trips.map((t) => t.destination).filter(Boolean));
  const minutes = trips.reduce((s, t) => s + (t.travelMinutes || 0), 0);
  const done = trips.filter((t) => t.status === "done").length;
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        {[[trips.length, "trips"], [cities.size, "cities"], [done, "done"]].map(([v, l]) => (
          <div key={l} className="rounded-xl bg-panel2 py-2"><div className="font-mono text-lg font-bold">{v}</div><div className="text-[11px] text-muted">{l}</div></div>
        ))}
      </div>
      {minutes > 0 && <div className="mb-3 text-xs text-muted">{fmtDur(minutes)} of travel planned so far</div>}
      {!trips.length && <div className="text-sm text-muted">No trips yet. Plan one and press Save.</div>}
      <ul className="space-y-2">
        {trips.map((t) => (
          <li key={t.id} data-testid="trip-item" onClick={() => onOpen(t.id)} className="cursor-pointer rounded-xl border border-transparent bg-panel2 p-3 hover:border-line">
            <div className="flex items-start justify-between gap-2">
              <div className="font-bold">{t.title || t.destination}</div>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${t.status === "done" ? "bg-good/15 text-good" : "bg-transit/20 text-[#8fb0ff]"}`}>{t.status || "planned"}</span>
            </div>
            <div className="text-xs text-muted">{t.date} · {(t.stops || []).join(" → ")}</div>
            <div className="mt-2 flex gap-2">
              <button className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:text-white" onClick={(e) => { e.stopPropagation(); onAction(t, "done"); }}>{t.status === "done" ? "Mark planned" : "Mark done"}</button>
              <button className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:text-white" onClick={(e) => { e.stopPropagation(); onAction(t, "del"); }}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
