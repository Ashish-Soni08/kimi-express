"use client";

import { APIProvider, AdvancedMarker, InfoWindow, Map, useMap } from "@vis.gl/react-google-maps";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { Pin, Route } from "./lib";

type Props = { googleKey: string | null; pins: Pin[]; routes: Route[]; fitKey: number; focus: { lat: number; lon: number; n: number } | null };

const GERMANY = { lat: 51.2, lng: 10.4 };
// The floating panel covers the left of the map, so fitted bounds are padded past it.
const PAD = { top: 80, right: 80, bottom: 80, left: 500 };
const routeColor = (m: string) => (m === "transit" ? "#2563eb" : "#e8501e");
const pinClass = (p: Pin) => `kx-pin${p.kind === "sugg" ? " kx-pin-sugg" : ""}`;

export default function MapView(props: Props) {
  return (
    <div className="h-full w-full" data-testid="map">
      {props.googleKey ? <GoogleMapView {...props} googleKey={props.googleKey} /> : <LeafletMapView {...props} />}
    </div>
  );
}

function GoogleMapView({ googleKey, pins, routes, fitKey, focus }: Props & { googleKey: string }) {
  const [open, setOpen] = useState<Pin | null>(null);
  return (
    <APIProvider apiKey={googleKey}>
      <Map
        defaultCenter={GERMANY}
        defaultZoom={6}
        mapId="DEMO_MAP_ID"
        colorScheme="LIGHT"
        disableDefaultUI
        clickableIcons={false}
        gestureHandling="greedy"
        className="h-full w-full"
      >
        {pins.map((p) => (
          <AdvancedMarker
            key={`${p.kind}-${p.lat}-${p.lon}`}
            position={{ lat: p.lat, lng: p.lon }}
            title={p.title}
            zIndex={p.kind === "sugg" ? 1 : 10}
            onClick={() => setOpen(p)}
          >
            <div className={pinClass(p)} style={{ translate: "0 50%" }}>
              {p.kind === "sugg" ? "" : p.label}
            </div>
          </AdvancedMarker>
        ))}
        {open && (
          <InfoWindow position={{ lat: open.lat, lng: open.lon }} onCloseClick={() => setOpen(null)} headerContent={<b>{open.title}</b>}>
            <div style={{ maxWidth: 220 }}>{open.sub}</div>
          </InfoWindow>
        )}
        <GoogleRoutes routes={routes} />
        <GoogleFit pins={pins} routes={routes} fitKey={fitKey} focus={focus} />
      </Map>
    </APIProvider>
  );
}

function GoogleRoutes({ routes }: { routes: Route[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !window.google) return;
    const lines = routes.map((r) => {
      const dashed = r.mode === "transit" || r.dotted;
      const color = routeColor(r.mode);
      return new google.maps.Polyline({
        map,
        path: r.geometry.map(([lat, lng]) => ({ lat, lng })),
        strokeColor: color,
        strokeOpacity: dashed ? 0 : 0.95,
        strokeWeight: 5,
        icons: dashed ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.95, strokeColor: color, scale: 4 }, offset: "0", repeat: "16px" }] : [],
      });
    });
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, routes]);
  return null;
}

function GoogleFit({ pins, routes, fitKey, focus }: Pick<Props, "pins" | "routes" | "fitKey" | "focus">) {
  const map = useMap();
  useEffect(() => {
    if (!map || !window.google) return;
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.geometry)];
    if (!pts.length) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach(([lat, lng]) => b.extend({ lat, lng }));
    map.fitBounds(b, PAD);
    google.maps.event.addListenerOnce(map, "idle", () => {
      if ((map.getZoom() ?? 0) > 16) map.setZoom(16);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  useEffect(() => {
    if (!map || !focus) return;
    map.panTo({ lat: focus.lat, lng: focus.lon });
    if ((map.getZoom() ?? 0) < 15) map.setZoom(15);
    map.panBy(-(PAD.left - PAD.right) / 2, 0);
  }, [map, focus]);
  return null;
}

function LeafletMapView({ pins, routes, fitKey, focus }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const st = useRef<{ map?: L.Map; layer?: L.LayerGroup }>({});
  useEffect(() => {
    const map = L.map(el.current!, { zoomControl: false }).setView([GERMANY.lat, GERMANY.lng], 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    st.current = { map, layer: L.layerGroup().addTo(map) };
    return () => {
      map.remove();
    };
  }, []);
  useEffect(() => {
    const { map, layer } = st.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const r of routes)
      L.polyline(r.geometry, { color: routeColor(r.mode), weight: 5, opacity: 0.95, dashArray: r.mode === "transit" || r.dotted ? "6 9" : undefined })
        .bindTooltip(r.label || "")
        .addTo(layer);
    for (const p of pins) {
      const size = p.kind === "sugg" ? 12 : 30;
      const html = `<div class="${pinClass(p)}">${p.kind === "sugg" ? "" : p.label}</div>`;
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) })
        .bindTooltip(p.title || "")
        .addTo(layer);
    }
  }, [pins, routes]);
  useEffect(() => {
    const { map } = st.current;
    if (!map) return;
    const pts = [...pins.map((p) => [p.lat, p.lon] as [number, number]), ...routes.flatMap((r) => r.geometry)];
    if (pts.length) map.flyToBounds(pts, { paddingTopLeft: [PAD.left, PAD.top], paddingBottomRight: [PAD.right, PAD.bottom], maxZoom: 16, duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  useEffect(() => {
    const { map } = st.current;
    if (!map || !focus) return;
    const z = Math.max(map.getZoom(), 15);
    const pt = map.project([focus.lat, focus.lon], z).subtract([(PAD.left - PAD.right) / 2, 0]);
    map.flyTo(map.unproject(pt, z), z, { duration: 0.5 });
  }, [focus]);
  return <div ref={el} className="h-full w-full" />;
}
