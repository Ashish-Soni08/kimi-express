// Trip tools used by the Kimi Express OpenClaw agent.
// All data sources are free and keyless:
//   places  -> OpenStreetMap Nominatim + Overpass
//   trains  -> v6.db.transport.rest (Deutsche Bahn), Transitous (MOTIS) as backup
//   walking -> FOSSGIS OSRM foot router, straight-line estimate as backup
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UA = process.env.KX_USER_AGENT || "kimi-express/0.1 (hackathon day-trip planner)";
const DB_REST = process.env.KX_DB_REST || "https://v6.db.transport.rest";
const TRANSITOUS = process.env.KX_TRANSITOUS || "https://api.transitous.org";
const NOMINATIM = process.env.KX_NOMINATIM || "https://nominatim.openstreetmap.org";
const OVERPASS = process.env.KX_OVERPASS || "https://overpass-api.de/api/interpreter";
const OSRM_FOOT = process.env.KX_OSRM_FOOT || "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const TRIPS_FILE = process.env.KX_TRIPS_FILE || fileURLToPath(new URL("../data/trips.json", import.meta.url));

// ---------- small helpers ----------
const cache = new Map();
async function getJson(url, { timeoutMs = 12000, init = {} } = {}) {
  const key = (init.method || "GET") + " " + url + " " + (init.body || "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.v;
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  const v = await res.json();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Nominatim asks for at most 1 request per second.
let nominatimChain = Promise.resolve();
function nominatim(path) {
  const run = nominatimChain.then(async () => {
    try {
      return await getJson(NOMINATIM + path);
    } finally {
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  nominatimChain = run.catch(() => {});
  return run;
}

const toRad = (d) => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mins = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }) : null);

// ---------- find_places ----------
async function geocodeOne(q, near) {
  let path = `/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  if (near) path += `&viewbox=${near.lon - 0.3},${near.lat + 0.2},${near.lon + 0.3},${near.lat - 0.2}`;
  const rows = await nominatim(path);
  if (!rows.length) return { query: q, found: false };
  const r = rows[0];
  return {
    query: q,
    found: true,
    name: r.name || r.display_name.split(",")[0],
    address: r.display_name,
    lat: +r.lat,
    lon: +r.lon,
    kind: r.type,
  };
}

async function attractionsNear(center, kinds, limit) {
  const want = kinds?.length ? kinds : ["attraction", "museum", "viewpoint", "gallery"];
  const filters = want
    .map((k) => `nwr(around:3500,${center.lat},${center.lon})["tourism"="${k.replace(/"/g, "")}"]["name"];`)
    .join("");
  const q = `[out:json][timeout:20];(${filters});out center tags 60;`;
  const data = await getJson(OVERPASS, {
    timeoutMs: 25000,
    init: { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  });
  const seen = new Set();
  return data.elements
    .map((e) => ({
      name: e.tags?.["name:en"] || e.tags?.name,
      lat: e.lat ?? e.center?.lat,
      lon: e.lon ?? e.center?.lon,
      kind: e.tags?.tourism,
      wikipedia: e.tags?.wikipedia || null,
      score: (e.tags?.wikipedia ? 3 : 0) + (e.tags?.wikidata ? 2 : 0) + (e.tags?.website ? 1 : 0),
    }))
    .filter((p) => p.name && p.lat && !seen.has(p.name) && seen.add(p.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...p }) => ({ ...p, kmFromCenter: round(haversineKm(center, p)) }));
}

export async function find_places({ city, places = [], discover = false, kinds, limit = 8 }) {
  const center = city ? await geocodeOne(city) : null;
  const near = center?.found ? center : null;
  const found = [];
  for (const q of places) {
    const query = city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q;
    try {
      found.push(await geocodeOne(query, near));
    } catch (e) {
      found.push({ query: q, found: false, error: String(e.message || e) });
    }
  }
  let suggestions = [];
  if ((discover || !places.length) && near) {
    try {
      suggestions = await attractionsNear(near, kinds, Math.min(limit, 15));
    } catch (e) {
      suggestions = [{ error: "Overpass unavailable: " + (e.message || e) }];
    }
  }
  return { city: near ? { name: city, lat: near.lat, lon: near.lon } : null, places: found, suggestions };
}

// ---------- search_trains ----------
function summarizeDbJourney(j) {
  const legs = j.legs.filter((l) => !l.walking || l.distance > 300);
  const first = j.legs[0];
  const last = j.legs[j.legs.length - 1];
  const dep = first.departure || first.plannedDeparture;
  const arr = last.arrival || last.plannedArrival;
  return {
    departure: dep,
    arrival: arr,
    departureLocal: hhmm(dep),
    arrivalLocal: hhmm(arr),
    durationMin: mins(dep, arr),
    changes: Math.max(0, j.legs.filter((l) => !l.walking).length - 1),
    delayMin: first.departureDelay ? Math.round(first.departureDelay / 60) : 0,
    price: j.price?.amount ? `${j.price.amount} ${j.price.currency || "EUR"}` : null,
    legs: legs.map((l) => ({
      line: l.walking ? "walk" : l.line?.name || l.line?.product || "train",
      product: l.walking ? "walking" : l.line?.product || null,
      from: l.origin?.name,
      to: l.destination?.name,
      dep: hhmm(l.departure || l.plannedDeparture),
      arr: hhmm(l.arrival || l.plannedArrival),
      platform: l.departurePlatform || l.plannedDeparturePlatform || null,
      cancelled: !!l.cancelled,
    })),
  };
}

async function dbStation(name) {
  const rows = await getJson(`${DB_REST}/locations?query=${encodeURIComponent(name)}&results=1&addresses=false&poi=false`);
  if (!rows.length) throw new Error(`No DB station found for "${name}"`);
  return { id: rows[0].id, name: rows[0].name, lat: rows[0].location?.latitude, lon: rows[0].location?.longitude };
}

async function trainsViaDb(from, to, when, arriveBy, results) {
  const [a, b] = await Promise.all([dbStation(from), dbStation(to)]);
  const t = arriveBy ? `arrival=${encodeURIComponent(when)}` : `departure=${encodeURIComponent(when)}`;
  const data = await getJson(
    `${DB_REST}/journeys?from=${encodeURIComponent(a.id)}&to=${encodeURIComponent(b.id)}&${t}&results=${results}&stopovers=false&remarks=false`,
    { timeoutMs: 20000 },
  );
  return { source: "Deutsche Bahn (db.transport.rest)", from: a, to: b, options: data.journeys.map(summarizeDbJourney) };
}

async function transitousGeocode(name) {
  for (const v of ["v1", "v5"]) {
    try {
      const rows = await getJson(`${TRANSITOUS}/api/${v}/geocode?text=${encodeURIComponent(name)}`);
      const r = rows.find((x) => x.type === "STOP") || rows[0];
      if (r) return { name: r.name, lat: r.lat, lon: r.lon };
    } catch {}
  }
  throw new Error(`Transitous could not find "${name}"`);
}

async function trainsViaTransitous(from, to, when, arriveBy, results) {
  const [a, b] = await Promise.all([transitousGeocode(from), transitousGeocode(to)]);
  let data, lastErr;
  for (const v of ["v5", "v4", "v1"]) {
    try {
      data = await getJson(
        `${TRANSITOUS}/api/${v}/plan?fromPlace=${a.lat},${a.lon}&toPlace=${b.lat},${b.lon}&time=${encodeURIComponent(new Date(when).toISOString())}&arriveBy=${!!arriveBy}&numItineraries=${results}`,
        { timeoutMs: 20000 },
      );
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw lastErr;
  return {
    source: "Transitous (open transit data, backup for DB)",
    from: a,
    to: b,
    options: (data.itineraries || []).slice(0, results).map((it) => ({
      departure: it.startTime,
      arrival: it.endTime,
      departureLocal: hhmm(it.startTime),
      arrivalLocal: hhmm(it.endTime),
      durationMin: Math.round(it.duration / 60),
      changes: it.transfers ?? 0,
      delayMin: 0,
      price: null,
      legs: it.legs
        .filter((l) => l.mode !== "WALK" || l.distance > 300)
        .map((l) => ({
          line: l.mode === "WALK" ? "walk" : l.routeShortName || l.mode,
          product: l.mode,
          from: l.from?.name,
          to: l.to?.name,
          dep: hhmm(l.startTime || l.from?.departure),
          arr: hhmm(l.endTime || l.to?.arrival),
          platform: l.from?.track || null,
          cancelled: false,
        })),
    })),
  };
}

export async function search_trains({ from, to, when, arriveBy = false, results = 4 }) {
  const t = when ? new Date(when) : new Date();
  if (isNaN(t)) throw new Error(`Could not read the time "${when}". Use ISO 8601, e.g. 2026-11-22T08:00:00+01:00`);
  const iso = t.toISOString();
  const n = Math.min(Math.max(results, 1), 6);
  try {
    return await trainsViaDb(from, to, iso, arriveBy, n);
  } catch (dbErr) {
    try {
      const r = await trainsViaTransitous(from, to, iso, arriveBy, n);
      r.note = "DB API failed (" + (dbErr.message || dbErr) + "), used Transitous instead.";
      return r;
    } catch (e2) {
      throw new Error(`Both train sources failed. DB: ${dbErr.message || dbErr}. Transitous: ${e2.message || e2}`);
    }
  }
}

// ---------- travel_between ----------
async function walk(a, b) {
  try {
    const r = await getJson(`${OSRM_FOOT}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`);
    const route = r.routes?.[0];
    if (route) {
      return { km: round(route.distance / 1000), minutes: Math.round(route.duration / 60), geometry: route.geometry?.coordinates?.map(([x, y]) => [y, x]) };
    }
  } catch {}
  const km = haversineKm(a, b) * 1.3;
  return { km: round(km), minutes: Math.round((km / 4.8) * 60), estimated: true };
}

async function localTransit(a, b, when) {
  const q = new URLSearchParams({
    "from.latitude": a.lat, "from.longitude": a.lon, "from.address": a.name || "start",
    "to.latitude": b.lat, "to.longitude": b.lon, "to.address": b.name || "end",
    results: "1", stopovers: "false", remarks: "false",
  });
  if (when) q.set("departure", new Date(when).toISOString());
  const data = await getJson(`${DB_REST}/journeys?${q}`, { timeoutMs: 15000 });
  const j = data.journeys?.[0];
  if (!j) return null;
  const s = summarizeDbJourney(j);
  return { minutes: s.durationMin, departureLocal: s.departureLocal, arrivalLocal: s.arrivalLocal, lines: s.legs.filter((l) => l.line !== "walk").map((l) => l.line) };
}

export async function travel_between({ legs, when }) {
  const out = [];
  for (const leg of legs.slice(0, 10)) {
    const a = leg.from, b = leg.to;
    const crow = haversineKm(a, b);
    const w = await walk(a, b);
    let transit = null;
    if (w.minutes > 20) {
      try { transit = await localTransit(a, b, leg.when || when); } catch (e) { transit = { error: String(e.message || e) }; }
    }
    const best = transit && !transit.error && transit.minutes < w.minutes ? "transit" : "walk";
    out.push({
      from: a.name, to: b.name,
      straightLineKm: round(crow),
      walk: { km: w.km, minutes: w.minutes, estimated: !!w.estimated },
      transit,
      recommended: best,
      minutes: best === "transit" ? transit.minutes : w.minutes,
      geometry: w.geometry || [[a.lat, a.lon], [b.lat, b.lon]],
    });
  }
  return { legs: out, totalMinutes: out.reduce((s, l) => s + l.minutes, 0), totalWalkKm: round(out.filter((l) => l.recommended === "walk").reduce((s, l) => s + l.walk.km, 0)) };
}

// ---------- trip log ----------
async function readTrips() {
  try { return JSON.parse(await readFile(TRIPS_FILE, "utf8")); } catch { return []; }
}
async function writeTrips(trips) {
  await mkdir(dirname(TRIPS_FILE), { recursive: true });
  await writeFile(TRIPS_FILE, JSON.stringify(trips, null, 2));
}

export async function save_trip({ plan, status = "planned", notes }) {
  const trips = await readTrips();
  const id = plan.id || `trip-${Date.now().toString(36)}`;
  const trip = { ...plan, id, status, notes: notes ?? plan.notes ?? null, savedAt: new Date().toISOString() };
  const i = trips.findIndex((t) => t.id === id);
  if (i >= 0) trips[i] = { ...trips[i], ...trip }; else trips.unshift(trip);
  await writeTrips(trips);
  return { saved: true, id, totalTrips: trips.length };
}

export async function list_trips({ city, limit = 20 } = {}) {
  const trips = await readTrips();
  const f = city ? trips.filter((t) => (t.destination || t.title || "").toLowerCase().includes(city.toLowerCase())) : trips;
  return {
    count: f.length,
    trips: f.slice(0, limit).map((t) => ({ id: t.id, title: t.title, date: t.date, destination: t.destination, status: t.status, stops: (t.stops || []).map((s) => s.name), travelMinutes: t.totals?.travelMinutes ?? null })),
  };
}

export async function delete_trip({ id }) {
  const trips = await readTrips();
  await writeTrips(trips.filter((t) => t.id !== id));
  return { deleted: true };
}

// publish_plan just hands the structured plan to the dashboard (the server broadcasts it).
export async function publish_plan({ plan }) {
  return { shown: true, stops: plan?.stops?.length ?? 0 };
}

export const TOOLS = { find_places, search_trains, travel_between, publish_plan, save_trip, list_trips };
