import { useEffect, useRef } from "react";
import { APIProvider, Map, AdvancedMarker, useMap, InfoWindow } from "@vis.gl/react-google-maps";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useState } from "react";

// pins: [{lat, lon, label, kind: "stop"|"sugg"|"station", title, sub}]
// routes: [{geometry: [[lat, lon]...], mode: "walk"|"transit", label}]
const GERMANY = { lat: 51.2, lng: 10.4 };
const routeColor = (m) => (m === "transit" ? "#5b8cff" : "#f05a28");

export default function MapView({ googleKey, pins, routes, fitKey }) {
  return (
    <div className="h-full w-full" data-testid="map">
      {googleKey ? <GoogleMapView googleKey={googleKey} pins={pins} routes={routes} fitKey={fitKey} /> : <LeafletMapView pins={pins} routes={routes} fitKey={fitKey} />}
    </div>
  );
}

// ---------- Google Maps ----------
function GoogleMapView({ googleKey, pins, routes, fitKey }) {
  const [open, setOpen] = useState(null);
  return (
    <APIProvider apiKey={googleKey}>
      <Map
        defaultCenter={GERMANY}
        defaultZoom={6}
        mapId="DEMO_MAP_ID"
        colorScheme="DARK"
        disableDefaultUI
        zoomControl
        clickableIcons={false}
        gestureHandling="greedy"
        className="h-full w-full"
      >
        {pins.map((p, i) => (
          <AdvancedMarker key={`${p.kind}-${i}-${p.lat}`} position={{ lat: p.lat, lng: p.lon }} title={p.title} zIndex={p.kind === "sugg" ? 1 : 10} onClick={() => setOpen(p)}>
            <div className={`kx-pin ${p.kind === "stop" ? "" : p.kind}`} style={{ transform: "translateY(50%)" }}>{p.kind === "sugg" ? "" : p.label}</div>
          </AdvancedMarker>
        ))}
        {open && (
          <InfoWindow position={{ lat: open.lat, lng: open.lon }} onCloseClick={() => setOpen(null)} headerContent={<b style={{ color: "#111" }}>{open.title}</b>}>
            <div style={{ color: "#333", maxWidth: 220 }}>{open.sub}</div>
          </InfoWindow>
        )}
        <GoogleRoutes routes={routes} />
        <GoogleFit pins={pins} routes={routes} fitKey={fitKey} />
      </Map>
    </APIProvider>
  );
}

function GoogleRoutes({ routes }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !window.google) return;
    const lines = routes.map((r) => {
      const dashed = r.mode === "transit" || r.dotted;
      return new google.maps.Polyline({
        map,
        path: r.geometry.map(([lat, lng]) => ({ lat, lng })),
        strokeColor: routeColor(r.mode),
        strokeOpacity: dashed ? 0 : 0.9,
        strokeWeight: 5,
        icons: dashed ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: routeColor(r.mode), scale: 4 }, offset: "0", repeat: "16px" }] : [],
      });
    });
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, routes]);
  return null;
}

function GoogleFit({ pins, routes, fitKey }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !window.google) return;
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.geometry)];
    if (!pts.length) return;
    if (pts.length === 1) { map.panTo({ lat: pts[0][0], lng: pts[0][1] }); map.setZoom(14); return; }
    const b = new google.maps.LatLngBounds();
    pts.forEach(([lat, lng]) => b.extend({ lat, lng }));
    map.fitBounds(b, 60);
    google.maps.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > 16) map.setZoom(16); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  return null;
}

// ---------- OpenStreetMap fallback (no Google key) ----------
function LeafletMapView({ pins, routes, fitKey }) {
  const el = useRef(null);
  const st = useRef({});
  useEffect(() => {
    const map = L.map(el.current, { zoomControl: true }).setView([GERMANY.lat, GERMANY.lng], 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    st.current = { map, layer: L.layerGroup().addTo(map) };
    return () => map.remove();
  }, []);
  useEffect(() => {
    const { map, layer } = st.current;
    if (!map) return;
    layer.clearLayers();
    for (const r of routes) L.polyline(r.geometry, { color: routeColor(r.mode), weight: 5, opacity: 0.9, dashArray: r.mode === "transit" || r.dotted ? "6 8" : null }).bindTooltip(r.label || "").addTo(layer);
    for (const p of pins) {
      const size = p.kind === "sugg" ? 12 : 30;
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="kx-pin ${p.kind === "stop" ? "" : p.kind}">${p.kind === "sugg" ? "" : p.label}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) })
        .bindTooltip(p.title || "").addTo(layer);
    }
  }, [pins, routes]);
  useEffect(() => {
    const { map } = st.current;
    if (!map) return;
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.geometry)];
    if (pts.length === 1) map.flyTo(pts[0], 14, { duration: 0.6 });
    else if (pts.length > 1) map.flyToBounds(pts, { padding: [50, 50], maxZoom: 16, duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  return <div ref={el} className="h-full w-full" />;
}
