// Calls each trip tool directly (no OpenClaw, no Kimi) to check the free data sources.
// Usage: node scripts/smoke-tools.mjs [from] [to]
import { find_places, search_trains, travel_between } from "../server/tools.mjs";

const from = process.argv[2] || "Hannover Hbf";
const to = process.argv[3] || "Berlin Hbf";
const when = new Date(Date.now() + 86400000);
when.setHours(8, 0, 0, 0);

async function step(name, fn) {
  const t = performance.now();
  try {
    const r = await fn();
    console.log(`\n✓ ${name} (${Math.round(performance.now() - t)} ms)`);
    console.log(JSON.stringify(r, (k, v) => (k === "geometry" ? `[${v.length} points]` : v), 2).slice(0, 4000));
    return r;
  } catch (e) {
    console.log(`\n✗ ${name} (${Math.round(performance.now() - t)} ms): ${e.message}`);
  }
}

const places = await step("find_places", () => find_places({ city: "Berlin", places: ["Museum Island", "East Side Gallery"], discover: true, limit: 5 }));
await step("search_trains", () => search_trains({ from, to, when: when.toISOString(), results: 3 }));
const p = places?.places?.filter((x) => x.found) || [];
if (p.length >= 2) {
  const hbf = { name: "Berlin Hbf", lat: 52.5251, lon: 13.3694 };
  await step("travel_between", () => travel_between({ legs: [{ from: hbf, to: p[0] }, { from: p[0], to: p[1] }], when: when.toISOString() }));
}
