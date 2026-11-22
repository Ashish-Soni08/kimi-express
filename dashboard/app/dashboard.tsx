"use client";

import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { Textarea } from "@ui-sdk/react/textarea";
import { Timeline, TimelineConnector, TimelineDescription, TimelineItem, TimelineMarker, TimelineTime, TimelineTitle } from "@ui-sdk/react/timeline";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEMO_STEPS,
  STATUS,
  TOOL_LABEL,
  argSummary,
  fmtDur,
  km,
  resultSummary,
  store,
  type Health,
  type Lane,
  type Pin,
  type Place,
  type Plan,
  type Route,
  type Step,
  type Train,
  type TripSummary,
} from "./lib";

const MapView = dynamic(() => import("./map-view"), { ssr: false });

const MODEL: Record<Lane, string> = { cerebras: "Cerebras", gpu: "Nebius" };
const CITIES = ["Potsdam", "Hamburg", "Leipzig"];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

type Tone = "idle" | "busy" | "ok" | "err";

export default function Dashboard() {
  const [googleKey, setGoogleKey] = useState<string | null | undefined>(undefined);
  const [health, setHealth] = useState<Health | null>(null);
  const [prompt, setPrompt] = useState("");
  const [home, setHome] = useState("Berlin Hbf");
  const [lane, setLane] = useState<Lane>("cerebras");
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: "Ready when you are.", tone: "idle" });
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [sugg, setSugg] = useState<Place[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [saved, setSaved] = useState(false);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [tab, setTab] = useState("plan");
  const [fitKey, setFitKey] = useState(0);
  const [focus, setFocus] = useState<{ lat: number; lon: number; n: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [demo, setDemo] = useState(false);
  const [tomorrow, setTomorrow] = useState("tomorrow");

  const running = state === "running";
  const t0 = useRef(0);
  const runRef = useRef(false);
  const laneRef = useRef<Lane>("cerebras");
  const planRef = useRef<Plan | null>(null);
  const busyRef = useRef(0);

  useEffect(() => {
    document.body.dataset.state = state;
  }, [state]);

  const checkHealth = useCallback(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ gateway: "unreachable" }));
  }, []);
  const loadTrips = useCallback(
    () =>
      fetch("/api/trips")
        .then((r) => r.json())
        .then((r) => setTrips(r.trips || []))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    const isDemo = new URLSearchParams(location.search).has("demo");
    // Browser-only values are read after hydration so the prerendered page matches.
    setDemo(isDemo);
    setHome(store.get("kx-home", "Berlin Hbf"));
    setLane(store.get("kx-model", "cerebras") === "gpu" ? "gpu" : "cerebras");
    setTomorrow(new Date(Date.now() + 86400000).toLocaleDateString("en-GB", { weekday: "long" }));
    fetch("/api/maps-config")
      .then((r) => r.json())
      .then((c) => setGoogleKey(c.googleKey || null))
      .catch(() => setGoogleKey(null));
    if (isDemo) return;
    checkHealth();
    loadTrips();
    const t = setInterval(() => !runRef.current && checkHealth(), 30000);
    return () => clearInterval(t);
  }, [checkHealth, loadTrips]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Math.round((performance.now() - t0.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const onToolResult = useCallback((name: string, args: any, r: any) => {
    if (name === "find_places" && r) {
      setPlaces((prev) => {
        const found: Place[] = (r.places || []).filter((p: Place) => p.found);
        const m = new Map([...prev, ...found].map((p) => [`${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, p]));
        return [...m.values()];
      });
      setSugg((r.suggestions || []).filter((s: Place) => s.lat));
      setFitKey((k) => k + 1);
    }
    if (name === "travel_between" && r) {
      setRoutes(
        (r.legs || [])
          .filter((l: any) => l.geometry?.length)
          .map((l: any) => ({ geometry: l.geometry, mode: l.recommended === "transit" ? "transit" : "walk", label: `${l.from} → ${l.to}: ${l.minutes} min` })),
      );
      setFitKey((k) => k + 1);
    }
    if (name === "publish_plan" && args?.plan) {
      planRef.current = args.plan;
      setPlan(args.plan);
      setSaved(false);
      setTab("plan");
      setFitKey((k) => k + 1);
    }
  }, []);

  const onEvent = useCallback(
    (e: any) => {
      if (e.type === "trips_changed") return void loadTrips();
      if (e.lane && e.lane !== laneRef.current) return;
      if (e.type === "tool_start") {
        setHealth((h) => ({ ...(h || {}), gateway: "ok" }));
        busyRef.current++;
        if (runRef.current) setStatus({ text: STATUS[e.name] || "Working…", tone: "busy" });
        setSteps((f) => [...f, { id: e.id, name: e.name, args: e.args, status: "run" }]);
      }
      if (e.type === "tool_end" || e.type === "tool_error") {
        setSteps((f) => f.map((x) => (x.id === e.id ? { ...x, status: e.type === "tool_end" ? "ok" : "err", ms: e.ms, result: e.result, error: e.error } : x)));
        if (e.type === "tool_end") onToolResult(e.name, e.args, e.result);
        busyRef.current = Math.max(0, busyRef.current - 1);
        if (runRef.current && e.name !== "publish_plan")
          setTimeout(() => runRef.current && busyRef.current === 0 && setStatus({ text: "Kimi is thinking…", tone: "busy" }), 700);
      }
    },
    [loadTrips, onToolResult],
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  useEffect(() => {
    if (new URLSearchParams(location.search).has("demo")) return;
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (m) => onEvent(JSON.parse(m.data));
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, [onEvent]);

  async function playDemo() {
    for (const [i, s] of DEMO_STEPS.entries()) {
      await wait(i ? 500 : 900);
      onEvent({ type: "tool_start", id: `demo-${i}`, name: s.name, args: s.args });
      await wait(s.ms);
      onEvent({ type: "tool_end", id: `demo-${i}`, name: s.name, args: s.args, result: s.result, ms: s.ms });
    }
    await wait(400);
    setAnswer("RE 1 at 09:12 gets you to Potsdam by 09:37. Dutch Quarter first, then the Brandenburg Gate and Sanssouci, and the S 7 home at 17:54. (Sample data.)");
  }

  async function ask(text: string) {
    if (!text.trim() || runRef.current) return;
    runRef.current = true;
    laneRef.current = lane;
    t0.current = performance.now();
    setElapsed(0);
    setState("running");
    setStatus({ text: "Kimi is planning your day…", tone: "busy" });
    setSteps([]);
    setAnswer("");
    setPlaces([]);
    setSugg([]);
    setRoutes([]);
    setPlan(null);
    setSaved(false);
    planRef.current = null;
    busyRef.current = 0;
    setTab("steps");
    let failed = false;
    try {
      if (demo) await playDemo();
      else {
        const res = await post("/api/plan", { prompt: text, conversation: Math.random().toString(36).slice(2), lane });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!chunk.startsWith("data:")) continue;
            const e = JSON.parse(chunk.slice(5));
            if (e.type === "delta") setAnswer((a) => a + e.text);
            if (e.type === "error") {
              failed = true;
              setAnswer((a) => `${a}\n${e.error}`);
            }
          }
        }
      }
    } catch (err) {
      failed = true;
      setAnswer((a) => `${a}\n${(err as Error).message}`);
    }
    runRef.current = false;
    if (planRef.current) {
      setStatus({ text: "Your day is planned", tone: "ok" });
      setState(failed ? "error" : "done");
      setTab("plan");
    } else {
      setStatus({ text: "Kimi didn't finish a plan. Try again.", tone: "err" });
      setState("error");
    }
  }

  async function save() {
    if (!plan) return;
    if (demo) return setSaved(true);
    const r = await post("/api/trips", { plan: { ...plan, routes: plan.routes || routes, places: plan.places || places }, status: "planned" }).then((r) => r.json());
    setPlan((p) => ({ ...p, id: r.id }));
    setSaved(true);
    loadTrips();
  }
  async function openTrip(id: string) {
    const t: Plan | null = await fetch(`/api/trips/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!t) return;
    setPlan(t);
    setSaved(true);
    setRoutes(t.routes || []);
    setPlaces(t.places || []);
    setSugg([]);
    setTab("plan");
    setFitKey((k) => k + 1);
  }
  async function tripAction(t: TripSummary, action: "done" | "del") {
    if (action === "done") await post("/api/trips", { plan: { id: t.id }, status: t.status === "done" ? "planned" : "done" });
    if (action === "del") await fetch(`/api/trips/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    loadTrips();
  }

  const pins = useMemo(() => {
    const out: Pin[] = [];
    const stops = (plan?.stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lon));
    if (stops.length)
      stops.forEach((s, i) => {
        const g = places.find((q) => km(s, q) < 0.3);
        const sub = [s.arrive && `${s.arrive}${s.leave ? `–${s.leave}` : ""}`, g?.rating && `★ ${g.rating}`, s.note].filter(Boolean).join(" · ");
        out.push({ lat: s.lat, lon: s.lon, label: i + 1, kind: "stop", title: `${i + 1}. ${s.name}`, sub });
      });
    else places.forEach((p, i) => out.push({ lat: p.lat, lon: p.lon, label: i + 1, kind: "stop", title: p.name, sub: p.address }));
    sugg.slice(0, 12).forEach((s) => out.push({ lat: s.lat, lon: s.lon, kind: "sugg", title: s.name }));
    return out;
  }, [plan, places, sugg]);

  const mapRoutes = useMemo<Route[]>(() => {
    if (routes.length) return routes;
    const stops = (plan?.stops || []).filter((s) => isFinite(s.lat));
    return stops.length > 1 ? [{ geometry: stops.map((s) => [s.lat, s.lon] as [number, number]), mode: "walk", dotted: true }] : [];
  }, [routes, plan]);

  const examples = [
    `Day trip to Potsdam ${tomorrow} from ${home}. Sanssouci Palace and the Dutch Quarter, back by 19:00.`,
    `Day trip to Hamburg ${tomorrow} from ${home}. Speicherstadt, Elbphilharmonie plaza and a harbour walk, home by 21:00.`,
    `Leipzig ${tomorrow} from ${home}: Thomaskirche, the Old Town Hall and coffee at Zum Arabischen Coffe Baum.`,
  ];
  const gw = demo ? "ok" : health?.gateway;
  const nebiusOff = !demo && health != null && !health.gpu;
  const online = gw === "ok" || gw === "busy";

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div className="absolute inset-0">{googleKey !== undefined && <MapView googleKey={googleKey} pins={pins} routes={mapRoutes} fitKey={fitKey} focus={focus} />}</div>

      <aside className="kx-panel absolute inset-y-4 left-4 z-[1000] flex w-[448px] max-w-[calc(100vw-2rem)] flex-col">
        <header className="flex items-center justify-between px-5 pt-4">
          <div className="flex items-center gap-2.5">
            <Logo />
            <h1 className="text-[15px] font-semibold tracking-tight">Kimi Express</h1>
            {demo && <span className="rounded-full bg-[var(--kx-accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--kx-accent-ink)]">Sample data</span>}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-[var(--kx-muted)]" data-testid="gateway-pill">
            <span className="kx-dot" data-tone={online ? "ok" : gw ? "err" : "idle"} />
            {gw === "ok" ? "Agent online" : gw === "busy" ? "Agent busy" : gw ? "Agent offline" : "Connecting…"}
          </span>
        </header>

        <form
          className="px-5 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            ask(prompt);
          }}
        >
          <Field name="prompt">
            <FieldLabel className="text-[22px] font-semibold tracking-tight">Where to?</FieldLabel>
            <div className="kx-composer">
              <Textarea
                rows={3}
                data-testid="trip-prompt"
                placeholder={examples[0]}
                value={prompt}
                onValueChange={(v: string) => setPrompt(v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(prompt);
                  }
                }}
              />
              <div className="flex items-center gap-2 border-t border-[var(--kx-line)] px-3 py-2">
                <label htmlFor="kx-home" className="text-xs text-[var(--kx-muted)]">
                  From
                </label>
                <Input
                  id="kx-home"
                  data-testid="home-station"
                  className="kx-home"
                  value={home}
                  onValueChange={(v: string) => setHome(v)}
                  onBlur={() => store.set("kx-home", home.trim() || "Berlin Hbf")}
                />
                <div className="ml-auto flex gap-1">
                  {CITIES.map((c, i) => (
                    <button type="button" key={c} className="kx-chip" onClick={() => setPrompt(examples[i])}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Field>

          <div className="mt-3 flex items-center gap-2">
            <SegmentedControl
              aria-label="Model provider"
              data-testid="model-picker"
              value={lane}
              disabled={running}
              onValueChange={(v) => {
                const next: Lane = v === "gpu" ? "gpu" : "cerebras";
                setLane(next);
                store.set("kx-model", next);
              }}
            >
              <SegmentedControlIndicator />
              <SegmentedControlItem value="cerebras">Cerebras</SegmentedControlItem>
              <SegmentedControlItem value="gpu" disabled={nebiusOff} title={nebiusOff ? "Set KX_GPU_MODEL on the server to enable Nebius" : undefined}>
                Nebius
              </SegmentedControlItem>
            </SegmentedControl>
            <Button type="submit" data-testid="plan-button" disabled={running} className="kx-primary flex-1">
              {running ? "Planning…" : "Plan my day"}
              <kbd aria-hidden="true">↵</kbd>
            </Button>
          </div>

          <div className="mt-3 flex items-center justify-between text-[13px]" data-testid="status">
            <span className="flex min-w-0 items-center gap-2" data-tone={status.tone}>
              <span className="kx-dot flex-none" data-tone={status.tone} />
              <span className={`truncate ${status.tone === "err" ? "text-[var(--kx-bad)]" : status.tone === "idle" ? "text-[var(--kx-muted)]" : ""}`}>{status.text}</span>
            </span>
            <span className="flex-none whitespace-nowrap pl-3 text-xs text-[var(--kx-muted)]">
              {running && elapsed >= 3 ? <span className="font-mono tabular-nums">{`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} · `}</span> : null}
              Kimi K3.1 Pro on {MODEL[lane]} · OpenClaw
            </span>
          </div>
        </form>

        <Tabs value={tab} onValueChange={(v) => v && setTab(v)} className="mt-3 min-h-0 flex-1">
          <TabsList aria-label="Trip views" className="px-5">
            <TabsTab value="plan" data-testid="tab-plan">
              Plan
            </TabsTab>
            <TabsTab value="steps" data-testid="tab-agent">
              Live steps{steps.length ? <span className="kx-count">{steps.length}</span> : null}
            </TabsTab>
            <TabsTab value="trips" data-testid="tab-trips">
              Trip log{trips.length ? <span className="kx-count">{trips.length}</span> : null}
            </TabsTab>
          </TabsList>
          <TabsPanel value="plan" className="kx-scroll">
            <PlanPanel plan={plan} places={places} saved={saved} onSave={save} running={running} onFocus={(s) => setFocus({ lat: s.lat, lon: s.lon, n: Date.now() })} />
          </TabsPanel>
          <TabsPanel value="steps" className="kx-scroll">
            <StepsPanel steps={steps} answer={answer} running={running} model={MODEL[laneRef.current]} />
          </TabsPanel>
          <TabsPanel value="trips" className="kx-scroll">
            <TripsPanel trips={trips} onOpen={openTrip} onAction={tripAction} />
          </TabsPanel>
        </Tabs>
      </aside>

      {plan && (
        <div className="kx-panel kx-rise pointer-events-none absolute right-4 top-4 z-[1000] max-w-sm px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--kx-muted)]">
            {plan.date} · {plan.origin} → {plan.destination}
          </div>
          <div className="mt-0.5 text-sm font-semibold">{plan.title}</div>
          {plan.summary && <div className="mt-1 text-xs text-[var(--kx-muted)]">{plan.summary}</div>}
        </div>
      )}
      <div className="kx-panel pointer-events-none absolute bottom-4 right-4 z-[1000] flex gap-4 px-3 py-2 text-xs text-[var(--kx-muted)]">
        <span className="flex items-center gap-1.5">
          <i className="h-[3px] w-5 rounded bg-[var(--kx-accent)]" />
          Walk
        </span>
        <span className="flex items-center gap-1.5">
          <i className="h-0 w-5 border-t-[3px] border-dashed border-[#2563eb]" />
          Transit
        </span>
      </div>
      {state !== "running" && plan && <span hidden data-testid="plan-complete" data-plan-ready="" />}
    </div>
  );
}

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="var(--kx-ink)" />
      <path d="M7 15.5 12 6l5 9.5" fill="none" stroke="var(--kx-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 18.5h11" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode?: string }) {
  return mode === "transit" ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Transit">
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 11h14M9 21l1.5-4M15 21l-1.5-4M9 14h.01M15 14h.01" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Walk">
      <circle cx="13" cy="4.5" r="1.5" />
      <path d="m7 21 3-7 3 3v4M10 14l1-6 4 3 3 1M11 8 8 9.5V12" />
    </svg>
  );
}

function TrainCard({ tag, t }: { tag: string; t?: Train }) {
  if (!t) return null;
  return (
    <div className="kx-train">
      <div className="flex items-center justify-between text-xs text-[var(--kx-muted)]">
        <span className="font-medium text-[var(--kx-ink)]">{tag}</span>
        <span>
          {fmtDur(t.durationMin)} · {t.changes ? `${t.changes} ${t.changes === 1 ? "change" : "changes"}` : "direct"}
        </span>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <div className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums">
          {t.departureLocal}
          <span className="mx-2 text-[var(--kx-faint)]">→</span>
          {t.arrivalLocal}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {(t.lines || []).map((l) => (
            <span key={l} className="kx-line">
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div>
      <div className="font-mono text-[15px] font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-[var(--kx-muted)]">{label}</div>
    </div>
  );
}

function PlanPanel({
  plan,
  places,
  saved,
  onSave,
  running,
  onFocus,
}: {
  plan: Plan | null;
  places: Place[];
  saved: boolean;
  onSave: () => Promise<void> | void;
  running: boolean;
  onFocus: (s: { lat: number; lon: number }) => void;
}) {
  if (!plan)
    return (
      <p className="kx-empty" data-testid="plan-panel">
        {running ? "Kimi is working on it. Watch the live steps and the map fill in." : "Your day appears here: trains there and back, each stop with times, and how you get between them."}
      </p>
    );
  const tot = plan.totals || {};
  const legs = plan.legs || [];
  const stops = plan.stops || [];
  return (
    <div data-testid="plan-panel" className="kx-rise">
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat value={fmtDur(tot.trainMinutes)} label="on trains" />
        <Stat value={fmtDur(tot.localMinutes)} label="getting around" />
        <Stat value={tot.walkKm != null ? `${tot.walkKm} km` : "–"} label="on foot" />
      </div>
      <TrainCard tag="Outbound" t={plan.outbound} />
      <Timeline aria-label="Stops" className="kx-stops">
        {stops.map((s, i) => {
          const g = isFinite(s.lat) ? places.find((q) => km(s, q) < 0.3) : null;
          const leg = legs[i + 1];
          return (
            <TimelineItem key={`${s.name}-${s.arrive}`} value={`stop-${i}`}>
              <TimelineMarker>{i + 1}</TimelineMarker>
              <TimelineConnector />
              <TimelineTime>
                {s.arrive}
                {s.leave ? `–${s.leave}` : ""}
                {s.minutes ? <span className="text-[var(--kx-faint)]"> · {fmtDur(s.minutes)}</span> : null}
              </TimelineTime>
              <TimelineTitle>
                <button type="button" className="kx-stop-name" onClick={() => onFocus(s)}>
                  {s.name}
                </button>
              </TimelineTitle>
              <TimelineDescription>
                {g?.rating && (
                  <span className="block">
                    ★ {g.rating}
                    {g.ratings ? ` (${g.ratings.toLocaleString()} reviews)` : ""}
                    {g.mapsUrl && (
                      <a className="ml-2 underline underline-offset-2" href={g.mapsUrl} target="_blank" rel="noreferrer">
                        Google Maps
                      </a>
                    )}
                  </span>
                )}
                {s.note}
                {leg && i < stops.length - 1 && (
                  <span className="kx-leg">
                    <ModeIcon mode={leg.mode} />
                    {fmtDur(leg.minutes)}
                    {leg.km ? ` · ${leg.km} km` : ""}
                  </span>
                )}
              </TimelineDescription>
            </TimelineItem>
          );
        })}
      </Timeline>
      <TrainCard tag="Return" t={plan.return} />
      {!!plan.tips?.length && (
        <ul className="mb-4 mt-1 space-y-1.5 text-[13px] text-[var(--kx-muted)]">
          {plan.tips.map((t) => (
            <li key={t} className="flex gap-2">
              <span aria-hidden="true" className="text-[var(--kx-accent)]">
                •
              </span>
              {t}
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => onSave()} disabled={saved} data-testid="save-trip" className="kx-secondary w-full">
        {saved ? "In your trip log" : "Save to trip log"}
      </Button>
    </div>
  );
}

function StepsPanel({ steps, answer, running, model }: { steps: Step[]; answer: string; running: boolean; model: string }) {
  if (!steps.length && !running && !answer) return <p className="kx-empty">Every tool call Kimi makes through OpenClaw shows up here as it happens.</p>;
  const thinking = running && steps.every((s) => s.status !== "run");
  return (
    <div>
      <Timeline aria-label="Agent steps" className="kx-steps" data-testid="agent-feed">
        {steps.map((s) => (
          <TimelineItem key={s.id} value={s.id} status={s.status === "run" ? "current" : "complete"} data-error={s.status === "err" ? "" : undefined}>
            <TimelineMarker />
            <TimelineConnector />
            <TimelineTitle>{TOOL_LABEL[s.name] || s.name}</TimelineTitle>
            <TimelineTime>{s.ms != null ? (s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${s.ms} ms`) : ""}</TimelineTime>
            <TimelineDescription>
              {argSummary(s.name, s.args)}
              {s.status === "ok" && resultSummary(s.name, s.result) && <span className="kx-result">{resultSummary(s.name, s.result)}</span>}
              {s.status === "err" && <span className="kx-result text-[var(--kx-bad)]">{s.error}</span>}
            </TimelineDescription>
          </TimelineItem>
        ))}
        {thinking && (
          <TimelineItem value="thinking" status="current">
            <TimelineMarker />
            <TimelineTitle>
              <span className="kx-shimmer">Kimi is thinking</span>
            </TimelineTitle>
            <TimelineDescription>Kimi K3.1 Pro on {model}</TimelineDescription>
          </TimelineItem>
        )}
      </Timeline>
      {answer && (
        <div className="kx-rise mt-4 border-t border-[var(--kx-line)] pt-4">
          <div className="mb-1.5 text-xs font-medium text-[var(--kx-muted)]">Kimi says</div>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed" data-testid="answer">
            {answer}
          </div>
        </div>
      )}
    </div>
  );
}

function TripsPanel({ trips, onOpen, onAction }: { trips: TripSummary[]; onOpen: (id: string) => void; onAction: (t: TripSummary, a: "done" | "del") => void }) {
  if (!trips.length) return <p className="kx-empty">No trips yet. Plan one and save it to start your log.</p>;
  const cities = new Set(trips.map((t) => t.destination).filter(Boolean));
  const minutes = trips.reduce((s, t) => s + (t.travelMinutes || 0), 0);
  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat value={trips.length} label="trips" />
        <Stat value={cities.size} label="cities" />
        <Stat value={fmtDur(minutes)} label="of travel" />
      </div>
      <ul className="space-y-2">
        {trips.map((t) => (
          <li key={t.id} className="kx-trip">
            <button type="button" data-testid="trip-item" className="block w-full text-left" onClick={() => onOpen(t.id)}>
              <span className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium">{t.title || t.destination}</span>
                <span className="kx-badge" data-done={t.status === "done" ? "" : undefined}>
                  {t.status || "planned"}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-[var(--kx-muted)]">
                {t.date} · {(t.stops || []).join(" → ")}
              </span>
            </button>
            <div className="mt-2 flex gap-1.5">
              <button type="button" className="kx-chip" onClick={() => onAction(t, "done")}>
                {t.status === "done" ? "Mark planned" : "Mark done"}
              </button>
              <button type="button" className="kx-chip" onClick={() => onAction(t, "del")}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
