// Trip tools used by the Kimi Express OpenClaw agent.
// All data sources are free and keyless:
//   places  -> OpenStreetMap Nominatim + Overpass
//   trains  -> v6.db.transport.rest (Deutsche Bahn), Transitous (MOTIS) as backup
//   walking -> FOSSGIS OSRM foot router, straight-line estimate as backup
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UA = process.env.KX_USER_AGENT || "kimi-express/0.1 (hackathon day-trip planner)";
// v6.db.transport.rest was shut down (DNS gone). Set KX_DB_REST to a self-hosted db-rest instance to use it again.
const DB_REST = process.env.KX_DB_REST || "";
const TRANSITOUS = process.env.KX_TRANSITOUS || "https://api.transitous.org";
const PHOTON = process.env.KX_PHOTON || "https://photon.komoot.io";
const NOMINATIM = process.env.KX_NOMINATIM || "https://nominatim.openstreetmap.org";
const OVERPASS = (process.env.KX_OVERPASS || "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass.kumi.systems/api/interpreter").split(",");
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
async function photonOne(q, near) {
  let url = `${PHOTON}/api/?limit=1&q=${encodeURIComponent(q)}`;
  // Keep results inside the destination city (about 25 x 25 km around its centre).
  if (near) url += `&lat=${near.lat}&lon=${near.lon}&bbox=${near.lon - 0.18},${near.lat - 0.11},${near.lon + 0.18},${near.lat + 0.11}`;
  const r = await getJson(url, { timeoutMs: 6000 });
  const f = r.features?.[0];
  if (!f) return { query: q, found: false };
  const pr = f.properties || {};
  return {
    query: q,
    found: true,
    name: pr.name || q,
    address: [pr.name, pr.street, pr.district, pr.city].filter(Boolean).join(", "),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    kind: pr.osm_value,
  };
}

// Photon first (fast, can run in parallel), Nominatim as backup (1 request/second).
async function geocodeOne(q, near) {
  try {
    const r = await photonOne(q, near);
    if (r.found) return r;
  } catch {}
  return geocodeNominatim(q, near);
}

async function geocodeNominatim(q, near) {
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

// Sight ideas from Photon (fast and reliable), used alongside Overpass, which is often overloaded.
async function photonSights(center, cityName, kinds, limit) {
  const want = kinds?.length ? kinds : ["attraction", "museum", "viewpoint", "gallery"];
  const tags = want.map((k) => `&osm_tag=tourism:${encodeURIComponent(k)}`).join("");
  const terms = [cityName, "museum", "Sehenswürdigkeit"].filter(Boolean);
  const results = await Promise.all(
    terms.map((t) =>
      getJson(`${PHOTON}/api/?q=${encodeURIComponent(t)}${tags}&lat=${center.lat}&lon=${center.lon}&location_bias_scale=0.9&limit=15&lang=en`, { timeoutMs: 5000 })
        .then((r) => r.features || [])
        .catch(() => []),
    ),
  );
  const seen = new Set();
  return results
    .flat()
    .map((f) => ({ name: f.properties?.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], kind: f.properties?.osm_value }))
    .filter((p) => p.name && !seen.has(p.name) && seen.add(p.name))
    .map((p) => ({ ...p, kmFromCenter: round(haversineKm(center, p)) }))
    .filter((p) => p.kmFromCenter < 8)
    .sort((a, b) => a.kmFromCenter - b.kmFromCenter)
    .slice(0, limit);
}

async function attractionsNear(center, kinds, limit) {
  const want = kinds?.length ? kinds : ["attraction", "museum", "viewpoint", "gallery"];
  const filters = want
    .map((k) => `nwr(around:3500,${center.lat},${center.lon})["tourism"="${k.replace(/"/g, "")}"]["name"];`)
    .join("");
  const q = `[out:json][timeout:4];(${filters});out center tags 60;`;
  // Ask all mirrors at once and take the first good answer; give up after 4 s so the demo stays fast.
  const data = await Promise.any(
    OVERPASS.map((url) =>
      getJson(url, {
        timeoutMs: 4000,
        init: { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      }),
    ),
  ).catch(() => { throw new Error("all Overpass mirrors failed or timed out"); });
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
  const sugg = (discover || !places.length) && near
    ? attractionsNear(near, kinds, Math.min(limit, 15))
        .catch(() => photonSights(near, city, kinds, Math.min(limit, 15)))
        .catch((e) => [{ error: "Sight suggestions unavailable: " + (e.message || e) }])
    : Promise.resolve([]);
  const found = await Promise.all(
    places.map((q) => {
      const query = city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q;
      return geocodeOne(query, near).catch((e) => ({ query: q, found: false, error: String(e.message || e) }));
    }),
  );
  const suggestions = await sugg;
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

const MODE_PREFIX = { HIGHSPEED_RAIL: "ICE", LONG_DISTANCE: "IC", NIGHT_RAIL: "NJ", REGIONAL_FAST_RAIL: "RE", REGIONAL_RAIL: "RB", SUBURBAN: "S", SUBWAY: "U", METRO: "U", TRAM: "Tram", BUS: "Bus", COACH: "Bus", FERRY: "Ferry" };
function motisLine(l) {
  const named = l.displayName || l.tripShortName || l.routeShortName;
  if (named && /[A-Za-z]/.test(named)) return named;
  const prefix = MODE_PREFIX[l.mode] || l.mode;
  return named ? `${prefix} ${named}` : prefix;
}

async function transitousPlan(a, b, when, arriveBy, n) {
  let data, lastErr;
  for (const v of ["v5", "v4", "v1"]) {
    try {
      data = await getJson(
        `${TRANSITOUS}/api/${v}/plan?fromPlace=${a.lat},${a.lon}&toPlace=${b.lat},${b.lon}&time=${encodeURIComponent(new Date(when || Date.now()).toISOString())}&arriveBy=${!!arriveBy}&numItineraries=${n}`,
        { timeoutMs: 20000 },
      );
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw lastErr;
  return data;
}

async function trainsViaTransitous(from, to, when, arriveBy, results) {
  const [a, b] = await Promise.all([transitousGeocode(from), transitousGeocode(to)]);
  const data = await transitousPlan(a, b, when, arriveBy, results);
  return {
    source: "DB timetable via Transitous",
    from: a,
    to: b,
    options: (data.itineraries || []).slice(0, results).map((it) => {
      const ride = it.legs.filter((l) => l.mode !== "WALK");
      const dep = ride[0]?.startTime || it.startTime;
      const arr = ride[ride.length - 1]?.endTime || it.endTime;
      return {
      departure: dep,
      arrival: arr,
      departureLocal: hhmm(dep),
      arrivalLocal: hhmm(arr),
      durationMin: mins(dep, arr),
      changes: it.transfers ?? 0,
      delayMin: 0,
      price: null,
      legs: it.legs
        .filter((l) => l.mode !== "WALK" || l.distance > 300)
        .map((l) => ({
          line: l.mode === "WALK" ? "walk" : motisLine(l),
          product: l.mode,
          from: l.from?.name,
          to: l.to?.name,
          dep: hhmm(l.startTime || l.from?.departure),
          arr: hhmm(l.endTime || l.to?.arrival),
          platform: l.from?.track || null,
          cancelled: false,
        })),
      };
    }),
  };
}

export async function search_trains({ from, to, when, arriveBy = false, results = 4 }) {
  const t = when ? new Date(when) : new Date();
  if (isNaN(t)) throw new Error(`Could not read the time "${when}". Use ISO 8601, e.g. 2026-11-22T08:00:00+01:00`);
  const iso = t.toISOString();
  const n = Math.min(Math.max(results, 1), 6);
  if (DB_REST) {
    try { return await trainsViaDb(from, to, iso, arriveBy, n); } catch {}
  }
  return trainsViaTransitous(from, to, iso, arriveBy, n);
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
  if (DB_REST) {
    try {
      const r = await localTransitDb(a, b, when);
      if (r) return r;
    } catch {}
  }
  const data = await transitousPlan(a, b, when, false, 1);
  const it = data.itineraries?.[0];
  if (!it) return null;
  return {
    minutes: Math.round(it.duration / 60),
    departureLocal: hhmm(it.startTime),
    arrivalLocal: hhmm(it.endTime),
    lines: it.legs.filter((l) => l.mode !== "WALK").map(motisLine),
  };
}

async function localTransitDb(a, b, when) {
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

export async function get_trip({ id }) {
  return (await readTrips()).find((t) => t.id === id) || null;
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
