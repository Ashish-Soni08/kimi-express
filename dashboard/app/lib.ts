export type Lane = "cerebras" | "gpu";

export type Train = {
  departureLocal?: string;
  arrivalLocal?: string;
  durationMin?: number;
  changes?: number;
  lines?: string[];
};
export type Stop = { name: string; lat: number; lon: number; arrive?: string; leave?: string; minutes?: number; note?: string };
export type Leg = { from?: string; to?: string; mode?: string; minutes?: number; km?: number };
export type Route = { geometry: [number, number][]; mode: "walk" | "transit"; label?: string; dotted?: boolean };
export type Place = { name: string; lat: number; lon: number; found?: boolean; address?: string; rating?: number; ratings?: number; mapsUrl?: string };
export type Plan = {
  id?: string;
  title?: string;
  date?: string;
  origin?: string;
  destination?: string;
  summary?: string;
  outbound?: Train;
  return?: Train;
  stops?: Stop[];
  legs?: Leg[];
  totals?: { travelMinutes?: number; trainMinutes?: number; localMinutes?: number; walkKm?: number; stops?: number };
  tips?: string[];
  routes?: Route[];
  places?: Place[];
};
export type Step = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "run" | "ok" | "err";
  ms?: number;
  result?: Record<string, unknown>;
  error?: string;
};
export type TripSummary = { id: string; title?: string; destination?: string; date?: string; status?: string; stops?: string[]; travelMinutes?: number };
export type Pin = { lat: number; lon: number; label?: number; kind: "stop" | "sugg"; title: string; sub?: string };
export type Health = { gateway?: string; agent?: string; gpu?: { model: string; label: string } | null; google?: { keyVar: string } | null };

export const fmtDur = (m?: number | null) =>
  m == null || isNaN(m) ? "–" : m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")}` : `${Math.round(m)} min`;

export const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

export const store = {
  get(k: string, d: string) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export const STATUS: Record<string, string> = {
  find_places: "Finding the places…",
  search_trains: "Checking Deutsche Bahn trains…",
  travel_between: "Working out walking and transit times…",
  publish_plan: "Laying out your day…",
  save_trip: "Saving to your trip log…",
  list_trips: "Reading your trip log…",
};
export const TOOL_LABEL: Record<string, string> = {
  find_places: "Find places",
  search_trains: "Search trains",
  travel_between: "Travel times",
  publish_plan: "Publish plan",
  save_trip: "Save trip",
  list_trips: "Trip log",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function argSummary(name: string, a: any = {}) {
  if (name === "find_places") return `${a.city || ""}: ${(a.places || []).join(", ") || (a.discover ? "discover sights" : "")}`;
  if (name === "search_trains")
    return `${a.from} → ${a.to}, ${a.arriveBy ? "arrive by" : "depart"} ${a.when ? new Date(a.when).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "now"}`;
  if (name === "travel_between") return `${(a.legs || []).length} legs`;
  if (name === "publish_plan") return a.plan?.title || "";
  return "";
}
export function resultSummary(name: string, r: any) {
  if (!r) return "";
  if (name === "find_places") return `${(r.places || []).filter((p: any) => p.found).length} found${r.suggestions?.length ? `, ${r.suggestions.length} ideas` : ""}`;
  if (name === "search_trains")
    return (r.options || []).slice(0, 3).map((o: any) => `${o.departureLocal}–${o.arrivalLocal}`).join("  ·  ") || r.error || "";
  if (name === "travel_between") return `${r.totalMinutes} min in total, ${r.totalWalkKm} km on foot`;
  if (name === "list_trips") return `${r.count} trips`;
  if (name === "publish_plan") return "Sent to the dashboard";
  return "";
}

// ---------- sample run for ?demo=1 (design preview without the agent; times are made up) ----------
const P = {
  hbf: { name: "Potsdam Hbf", lat: 52.3916, lon: 13.0667 },
  dutch: { name: "Dutch Quarter", lat: 52.4026, lon: 13.0619 },
  gate: { name: "Brandenburg Gate", lat: 52.3997, lon: 13.0481 },
  sans: { name: "Sanssouci Palace", lat: 52.4042, lon: 13.0385 },
};
const line = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): [number, number][] => [
  [a.lat, a.lon],
  [(a.lat + b.lat) / 2 + 0.0012, (a.lon + b.lon) / 2 - 0.0008],
  [b.lat, b.lon],
];
export const DEMO_PLAN: Plan = {
  title: "Potsdam: palace, old town and the Dutch Quarter",
  date: "2026-11-23",
  origin: "Berlin Hbf",
  destination: "Potsdam",
  summary: "An easy loop from the station through the Dutch Quarter to Sanssouci and back.",
  outbound: { departureLocal: "09:12", arrivalLocal: "09:37", durationMin: 25, changes: 0, lines: ["RE 1"] },
  return: { departureLocal: "17:54", arrivalLocal: "18:21", durationMin: 27, changes: 0, lines: ["S 7"] },
  stops: [
    { ...P.dutch, arrive: "09:58", leave: "11:00", minutes: 62, note: "Red-brick gabled houses, coffee on Mittelstraße" },
    { ...P.gate, arrive: "11:14", leave: "11:35", minutes: 21, note: "Potsdam's own gate, at the end of Brandenburger Straße" },
    { ...P.sans, arrive: "11:52", leave: "15:30", minutes: 218, note: "Palace, terraces and a late lunch in the park" },
  ],
  legs: [
    { from: "Potsdam Hbf", to: "Dutch Quarter", mode: "walk", minutes: 21, km: 1.6 },
    { from: "Dutch Quarter", to: "Brandenburg Gate", mode: "walk", minutes: 14, km: 1.1 },
    { from: "Brandenburg Gate", to: "Sanssouci Palace", mode: "walk", minutes: 17, km: 1.3 },
    { from: "Sanssouci Palace", to: "Potsdam Hbf", mode: "transit", minutes: 16, km: 3.1 },
  ],
  totals: { travelMinutes: 120, trainMinutes: 52, localMinutes: 68, walkKm: 4.0, stops: 3 },
  tips: ["Sanssouci is closed on Mondays; the park stays open.", "Bus 695 runs from the palace straight back to the station."],
};
export const DEMO_STEPS: { name: string; args: any; result: any; ms: number }[] = [
  {
    name: "find_places",
    args: { city: "Potsdam", places: ["Sanssouci Palace", "Dutch Quarter", "Brandenburg Gate"] },
    result: { places: [P.sans, P.dutch, P.gate].map((p) => ({ ...p, found: true })) },
    ms: 640,
  },
  {
    name: "search_trains",
    args: { from: "Berlin Hbf", to: "Potsdam Hbf", when: "2026-11-23T09:00:00+01:00" },
    result: { options: [{ departureLocal: "09:12", arrivalLocal: "09:37" }, { departureLocal: "09:27", arrivalLocal: "09:59" }, { departureLocal: "09:42", arrivalLocal: "10:07" }] },
    ms: 910,
  },
  {
    name: "search_trains",
    args: { from: "Potsdam Hbf", to: "Berlin Hbf", when: "2026-11-23T17:30:00+01:00" },
    result: { options: [{ departureLocal: "17:54", arrivalLocal: "18:21" }, { departureLocal: "18:09", arrivalLocal: "18:34" }] },
    ms: 870,
  },
  {
    name: "travel_between",
    args: { legs: [1, 2, 3, 4] },
    result: {
      totalMinutes: 68,
      totalWalkKm: 4.0,
      legs: [
        { from: P.hbf.name, to: P.dutch.name, minutes: 21, recommended: "walk", geometry: line(P.hbf, P.dutch) },
        { from: P.dutch.name, to: P.gate.name, minutes: 14, recommended: "walk", geometry: line(P.dutch, P.gate) },
        { from: P.gate.name, to: P.sans.name, minutes: 17, recommended: "walk", geometry: line(P.gate, P.sans) },
        { from: P.sans.name, to: P.hbf.name, minutes: 16, recommended: "transit", geometry: line(P.sans, P.hbf) },
      ],
    },
    ms: 1180,
  },
  { name: "publish_plan", args: { plan: DEMO_PLAN }, result: { ok: true }, ms: 12 },
];
