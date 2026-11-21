// Kimi Express tools for OpenClaw.
// Each tool forwards to the local Kimi Express dashboard server, which runs the real
// data lookups (DB trains, OpenStreetMap, routing) and shows every result live on the dashboard.
import { Type } from "typebox";
import { defineToolPlugin, openRecord } from "openclaw/plugin-sdk/tool-plugin";

type Config = { baseUrl?: string };
type Ctx = { sessionKey?: string; runId?: string; activeModel?: { provider?: string; modelId?: string; modelRef?: string } };

async function call(config: Config, name: string, args: unknown, ctx: Ctx, signal?: AbortSignal): Promise<unknown> {
  const base = (config.baseUrl || process.env.KIMI_EXPRESS_URL || "http://127.0.0.1:5177").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/tools/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Lets the dashboard tell parallel runs apart (e.g. Cerebras vs GPU race).
        "x-kx-session": ctx.sessionKey ?? "",
        "x-kx-run": ctx.runId ?? "",
        "x-kx-model": ctx.activeModel?.modelRef ?? [ctx.activeModel?.provider, ctx.activeModel?.modelId].filter(Boolean).join("/"),
      },
      body: JSON.stringify(args ?? {}),
      signal,
    });
  } catch {
    return { error: `Kimi Express dashboard is not reachable at ${base}. Start it with "npm start" in the kimi-express folder.` };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { error: String(data.error ?? `HTTP ${res.status}`) };
  return data;
}

// Builds a runtime tool bound to the current session, so results can be routed to the right dashboard lane.
function bound(name: string, label: string, description: string, parameters: any) {
  return ({ config, toolContext }: { config: Config; toolContext: Ctx }) => ({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = await call(config, name, params, toolContext, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}

type Def = { name: string; label: string; description: string; parameters: any };
function mk(tool: any, def: Def) {
  return tool({ ...def, workspaceAccess: false, factory: bound(def.name, def.label, def.description, def.parameters) });
}

const Point = Type.Object({
  name: Type.String({ description: "Place or station name." }),
  lat: Type.Number(),
  lon: Type.Number(),
});

const TrainSummary = Type.Object(
  {
    departureLocal: Type.Optional(Type.String({ description: "HH:MM" })),
    arrivalLocal: Type.Optional(Type.String({ description: "HH:MM" })),
    durationMin: Type.Optional(Type.Number()),
    changes: Type.Optional(Type.Number()),
    lines: Type.Optional(Type.Array(Type.String(), { description: "e.g. ICE 1234" })),
  },
  { additionalProperties: true },
);

export default defineToolPlugin({
  id: "kimi-express-tools",
  name: "Kimi Express Tools",
  description: "Day-trip planning tools: places, Deutsche Bahn trains, walking/transit times, trip log.",
  configSchema: Type.Object({
    baseUrl: Type.Optional(Type.String({ description: "Kimi Express dashboard URL, default http://127.0.0.1:5177" })),
  }),
  tools: (tool) => [
    mk(tool, {
      name: "find_places",
      label: "Find places",
      description:
        "Geocode the places the user wants to visit in a city (OpenStreetMap). Set discover=true to also get the top sights near the city centre.",
      parameters: Type.Object({
        city: Type.String({ description: "Destination city, e.g. Berlin." }),
        places: Type.Optional(Type.Array(Type.String(), { description: "Names of places to locate, e.g. ['Museum Island', 'East Side Gallery']." })),
        discover: Type.Optional(Type.Boolean({ description: "Also suggest top sights near the centre." })),
        kinds: Type.Optional(Type.Array(Type.String(), { description: "OSM tourism kinds for discovery: attraction, museum, viewpoint, gallery, zoo, theme_park." })),
        limit: Type.Optional(Type.Number({ description: "Max suggestions (default 8)." })),
      }),
    }),
    mk(tool, {
      name: "search_trains",
      label: "Search trains",
      description:
        "Real Deutsche Bahn connections between two stations (falls back to Transitous). Returns departure/arrival times, duration, changes and lines.",
      parameters: Type.Object({
        from: Type.String({ description: "Origin station or city, e.g. 'Hannover Hbf'." }),
        to: Type.String({ description: "Destination station or city, e.g. 'Berlin Hbf'." }),
        when: Type.String({ description: "ISO 8601 date-time with offset, e.g. 2026-11-22T08:00:00+01:00." }),
        arriveBy: Type.Optional(Type.Boolean({ description: "true = 'when' is the latest arrival time." })),
        results: Type.Optional(Type.Number({ description: "Number of options, 1-6 (default 4)." })),
      }),
    }),
    mk(tool, {
      name: "travel_between",
      label: "Travel between stops",
      description:
        "Walking distance/time between consecutive stops, plus local public transport time when the walk is over 20 minutes. Send all legs of the day in one call.",
      parameters: Type.Object({
        legs: Type.Array(Type.Object({ from: Point, to: Point }), { description: "Ordered legs, e.g. station->stop1, stop1->stop2, ..., last stop->station." }),
        when: Type.Optional(Type.String({ description: "ISO date-time of the first leg, for transit lookups." })),
      }),
    }),
    mk(tool, {
      name: "publish_plan",
      label: "Publish plan",
      description: "Show the final day plan on the Kimi Express dashboard. Call this once, as the last tool call of a trip plan.",
      parameters: Type.Object({
        plan: Type.Object(
          {
            title: Type.String(),
            date: Type.String({ description: "YYYY-MM-DD" }),
            origin: Type.String(),
            destination: Type.String(),
            outbound: Type.Optional(TrainSummary),
            return: Type.Optional(TrainSummary),
            stops: Type.Array(
              Type.Object(
                {
                  name: Type.String(),
                  lat: Type.Number(),
                  lon: Type.Number(),
                  arrive: Type.Optional(Type.String({ description: "HH:MM" })),
                  leave: Type.Optional(Type.String({ description: "HH:MM" })),
                  minutes: Type.Optional(Type.Number({ description: "Time spent at the stop." })),
                  note: Type.Optional(Type.String()),
                },
                { additionalProperties: true },
              ),
            ),
            legs: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    from: Type.String(),
                    to: Type.String(),
                    mode: Type.Optional(Type.String({ description: "walk or transit" })),
                    minutes: Type.Optional(Type.Number()),
                    km: Type.Optional(Type.Number()),
                  },
                  { additionalProperties: true },
                ),
              ),
            ),
            totals: Type.Optional(openRecord("travelMinutes, trainMinutes, localMinutes, walkKm, stops")),
            tips: Type.Optional(Type.Array(Type.String())),
            summary: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      }),
    }),
    mk(tool, {
      name: "save_trip",
      label: "Save trip",
      description: "Save a trip plan to the user's trip log. Use status 'done' for trips already taken.",
      parameters: Type.Object({
        plan: openRecord("The trip plan, same shape as publish_plan.plan. Include an id to update an existing trip."),
        status: Type.Optional(Type.String({ description: "planned or done" })),
        notes: Type.Optional(Type.String()),
      }),
    }),
    mk(tool, {
      name: "list_trips",
      label: "List trips",
      description: "List trips from the user's trip log, optionally filtered by destination city.",
      parameters: Type.Object({
        city: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
    }),
  ],
});
