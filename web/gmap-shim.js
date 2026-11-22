// Minimal Leaflet-shaped wrapper around the Google Maps JavaScript API, so app.js can draw
// the same markers, routes and fits on a Google map. Loaded only when a Google key is configured.
window.makeGoogleShim = function makeGoogleShim() {
  const g = google.maps;
  const plain = (html) => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent; };
  class Group {
    constructor() { this.items = []; this.map = null; }
    addTo(m) { this.map = m; this.items.forEach((i) => i._attach(m)); return this; }
    clearLayers() { this.items.forEach((i) => i._detach()); this.items = []; return this; }
    getLayers() { return this.items; }
    _add(i) { this.items.push(i); if (this.map) i._attach(this.map); }
  }
  class Layer {
    bindTooltip(t) { this.tip = t; return this; }
    addTo(target) { if (target instanceof Group) target._add(this); else this._attach(target); return this; }
  }
  class Marker extends Layer {
    constructor(ll, opt = {}) { super(); this.ll = ll; this.opt = opt; }
    _attach(m) {
      const wrap = document.createElement("div");
      wrap.innerHTML = this.opt.icon?.html || "";
      const node = wrap.firstElementChild || wrap;
      node.style.transform = "translateY(50%)"; // AdvancedMarker anchors bottom-centre; ours are centred circles
      this.m = new g.marker.AdvancedMarkerElement({ map: m.gm, position: { lat: this.ll[0], lng: this.ll[1] }, content: node, title: plain(this.tip) });
    }
    _detach() { if (this.m) this.m.map = null; }
  }
  class Polyline extends Layer {
    constructor(pts, o = {}) { super(); this.pts = pts; this.o = o; }
    _attach(m) {
      const path = this.pts.map(([lat, lng]) => ({ lat, lng }));
      const dashed = !!this.o.dashArray;
      this.p = new g.Polyline({
        map: m.gm, path,
        strokeColor: this.o.color || "#f05a28",
        strokeWeight: this.o.weight || 3,
        strokeOpacity: dashed ? 0 : this.o.opacity ?? 0.85,
        icons: dashed ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: this.o.opacity ?? 0.85, strokeColor: this.o.color, scale: this.o.weight || 3 }, offset: "0", repeat: "14px" }] : [],
      });
    }
    _detach() { if (this.p) this.p.setMap(null); }
  }
  class GMap {
    constructor(id) { this.el = document.getElementById(id); }
    setView([lat, lng], zoom) {
      this.gm = new g.Map(this.el, {
        center: { lat, lng }, zoom, mapId: "DEMO_MAP_ID", colorScheme: g.ColorScheme?.DARK ?? "DARK",
        disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: "greedy",
      });
      return this;
    }
    flyTo([lat, lng], zoom) { this.gm.panTo({ lat, lng }); this.gm.setZoom(zoom); return this; }
    flyToBounds(pts, o = {}) {
      const b = new g.LatLngBounds();
      pts.forEach(([lat, lng]) => b.extend({ lat, lng }));
      this.gm.fitBounds(b, (o.padding && o.padding[0]) || 40);
      if (o.maxZoom) g.event.addListenerOnce(this.gm, "idle", () => { if (this.gm.getZoom() > o.maxZoom) this.gm.setZoom(o.maxZoom); });
      return this;
    }
  }
  return {
    map: (id) => new GMap(id),
    tileLayer: () => ({ addTo() { return this; } }),
    layerGroup: () => new Group(),
    marker: (ll, o) => new Marker(ll, o),
    polyline: (pts, o) => new Polyline(pts, o),
    divIcon: (o) => o,
  };
};
