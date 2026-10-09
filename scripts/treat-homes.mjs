// Builds api/_treat-homes.js: every house lot behind the gate, for the Halloween
// treat map (/treats). Run once a season, before the map opens:
//
//   node scripts/treat-homes.mjs
//
// Sources, both public:
//   - LA County Assessor parcels (lot outlines). Only the outline, a land-use code
//     and the parcel's centre point are read. No owner names, no values, no addresses.
//   - OpenStreetMap streets (to label each lot "on Calle Palomino" and the like).
//
// "Behind the gate" = north of Avenida Rancho Tesoro, between the Camino Oceano gate
// on the west and the Camino Los Robles entrance on the east. GATE traces that
// stretch of road; homes south of it (Tesoro del Valle) are not part of this map.
//
// Each lot gets a stable id: a hash of its parcel number, so re-running this
// mid-season keeps everyone's pin on the same house, and the page never carries
// the parcel number itself. Each lot's street comes from its shape against the
// street centrelines (see "which street each house is on" below).
//
// Checked against satellite imagery on 2026-10-07: 368 house lots. Some lots in
// the newest Lennar phase were still bare pads; they stay in, since they'll be
// homes, and an empty lot simply never gets a pumpkin.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "api", "_treat-homes.js");
const UA = "tesorohighlands.com (neighbor community site)";

// [lon, lat]: north of Avenida Rancho Tesoro, from the Camino Oceano gate to the
// Camino Los Robles entrance, closed off well into the hills on the other sides.
const GATE = [[-118.57250,34.49300],[-118.57250,34.48002],[-118.57220,34.48002],[-118.57179,34.48061],[-118.57128,34.48112],[-118.57116,34.48122],[-118.57038,34.48163],[-118.57025,34.48168],[-118.56927,34.48193],[-118.56832,34.48203],[-118.56734,34.48209],[-118.56693,34.48200],[-118.56630,34.48180],[-118.56570,34.48161],[-118.56492,34.48141],[-118.56394,34.48124],[-118.56351,34.48108],[-118.56310,34.48080],[-118.56278,34.48057],[-118.56214,34.48005],[-118.56207,34.48000],[-118.56205,34.47996],[-118.56195,34.47979],[-118.56157,34.47917],[-118.56101,34.47854],[-118.56051,34.47813],[-118.56032,34.47795],[-118.55993,34.47752],[-118.55961,34.47725],[-118.55938,34.47708],[-118.55300,34.47708],[-118.55300,34.49300]];
const BBOX = { s: 34.4790, w: -118.5730, n: 34.4900, e: -118.5540 };

// Lots that pass the filters but have no house, checked against imagery.
const NOT_HOMES = {
  "3244103010": "drainage basin by the Camino Oceano gate",
  "3244197020": "road shoulder at the Camino Los Robles entrance",
  "3244207027": "empty pad at the Camino Los Robles entrance",
  "3244207041": "slope strip along Avenida Rancho Tesoro",
  "3244215055": "landscape strip along Avenida Rancho Tesoro",
  "3244215066": "landscape strip along Avenida Rancho Tesoro",
  "3244218052": "landscape strip along Avenida Rancho Tesoro",
};
// Street corrections confirmed on the ground or against imagery, by parcel number.
// A neighbour reporting "my house shows the wrong street" goes here.
const OVERRIDES = {
  "3244215054": "Corte Parillada", // corner lot at Camino Oceano; reported by the owner, 2026-10-08
};
// House lots here run about 300–2,400 m². Smaller parcels are slivers; bigger ones
// are the private streets, slopes, parks and the water tanks.
const MIN_M2 = 250, MAX_M2 = 2500;

const LAT0 = 34.484, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const xy = (lon, lat) => [(lon + 118.56) * KX, (lat - LAT0) * KY];

function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function area(ring) {
  const p = ring.map(c => xy(c[0], c[1]));
  let s = 0;
  for (let i = 0; i < p.length - 1; i++) s += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1];
  return Math.abs(s) / 2;
}
// Douglas–Peucker in metres, so curved cul-de-sac lots don't carry 40 vertices.
// A ring starts and ends on the same point, so it's split at the vertex farthest
// from the start first; run whole, every lot collapses to a single point.
function simplify(ring, tol) {
  const p = ring.map(c => xy(c[0], c[1]));
  const keep = new Array(p.length).fill(false);
  const dist = (i, a, b) => {
    const [ax, ay] = p[a], [bx, by] = p[b], L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) return Math.hypot(p[i][0] - ax, p[i][1] - ay);
    return Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / L;
  };
  function dp(a, b) {
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) { const d = dist(i, a, b); if (d > best) { best = d; idx = i; } }
    if (best > tol) { keep[idx] = true; dp(a, idx); dp(idx, b); }
  }
  let far = 1;
  for (let i = 1; i < p.length - 1; i++) if (dist(i, 0, 0) > dist(far, 0, 0)) far = i;
  keep[0] = keep[far] = keep[p.length - 1] = true;
  dp(0, far); dp(far, p.length - 1);
  return ring.filter((_, i) => keep[i]);
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init && init.headers) }, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(url.split("?")[0] + " -> " + r.status);
  return r.json();
}

const parcelsUrl = "https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query?" + new URLSearchParams({
  geometry: [BBOX.w, BBOX.s, BBOX.e, BBOX.n].join(","), geometryType: "esriGeometryEnvelope", inSR: "4326",
  spatialRel: "esriSpatialRelIntersects", outFields: "AIN,UseDescription,CENTER_LAT,CENTER_LON",
  outSR: "4326", resultRecordCount: "2000", f: "geojson",
});
const overpass = `[out:json][timeout:60];way["highway"~"^(residential|tertiary|unclassified|living_street)$"]["name"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});out geom;`;

const [parcels, osm] = await Promise.all([
  getJson(parcelsUrl),
  getJson("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: overpass }) }),
]);
if (parcels.exceededTransferLimit) throw new Error("parcel query was truncated; page it");

// ---- which street each house is on
// The county has no addresses for these new homes yet, so the street is worked out
// from the lot's shape against OpenStreetMap's centrelines: the lot fronts the
// street whose centreline its lot line comes nearest to, ignoring a street that only
// clips a corner at a junction. A corner lot with two streets within a metre of each
// other follows its row (the street its unambiguous neighbours are on). Checked
// against satellite imagery on 2026-10-08; OVERRIDES settles what the rule gets wrong.
const TOUCH = 14;   // a lot line within this many metres of a centreline is along that street
const BULB = 11;    // OSM draws a cul-de-sac only to the middle of its bulb: extend it that far
const TIE = 1;      // two streets this close in distance are a tie, settled by the row
const MINADJ = 8;   // metres of lot line along a street before it counts as a frontage

// A way end is a dead end only if no node of any OTHER way lies within 2 m of it
// (side streets join at a node in the middle of the through street).
const allNodes = osm.elements.flatMap(w => w.geometry.map(q => [w.id, xy(q.lon, q.lat)]));
const deadEnd = (wid, p) => !allNodes.some(([oid, [x, y]]) => oid !== wid && Math.hypot(x - p[0], y - p[1]) <= 2);
const segs = [];
for (const w of osm.elements) {
  let g = w.geometry.map(q => xy(q.lon, q.lat));
  const stretch = (p, q) => { const dx = p[0] - q[0], dy = p[1] - q[1], L = Math.hypot(dx, dy) || 1; return [p[0] + dx / L * BULB, p[1] + dy / L * BULB]; };
  if (deadEnd(w.id, g[0])) g = [stretch(g[0], g[1]), ...g];
  if (deadEnd(w.id, g[g.length - 1])) g = [...g, stretch(g[g.length - 1], g[g.length - 2])];
  for (let i = 0; i < g.length - 1; i++) segs.push([w.tags.name, g[i], g[i + 1]]);
}
const dSeg = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
};
const dPoly = (p, edges) => { let m = Infinity; for (const [a, b] of edges) { const d = dSeg(p, a, b); if (d < m) m = d; } return m; };

// For one lot outline ([lon, lat] ring): how near each street's centreline comes to the
// lot line, how much lot line runs along it, and the streets that qualify as frontages.
function lotFacts(ring) {
  const pts = ring.map(c => xy(c[0], c[1]));
  const near = new Map(), adj = new Map(), samples = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1], L = Math.hypot(c[0] - a[0], c[1] - a[1]), n = Math.max(1, Math.floor(L));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, p = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
      samples.push(p);
      const ds = new Map();
      for (const [name, s1, s2] of segs) { const d = dSeg(p, s1, s2); if (!ds.has(name) || d < ds.get(name)) ds.set(name, d); }
      for (const [name, d] of ds) {
        if (!near.has(name) || d < near.get(name)) near.set(name, d);
        if (d <= TOUCH) adj.set(name, (adj.get(name) || 0) + L / n);
      }
    }
  }
  const top = Math.max(0, ...adj.values());
  const cands = [...adj.keys()].filter(n => adj.get(n) >= Math.max(MINADJ, 0.5 * top)).sort((a, b) => near.get(a) - near.get(b));
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  return { edges: pts.slice(0, -1).map((q, i) => [q, pts[i + 1]]), samples, near, adj, cands, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

const BASE = [34.48, -118.56];
const enc = (lat, lon) => [Math.round((lat - BASE[0]) * 1e6), Math.round((lon - BASE[1]) * 1e6)];
const lots = [], ids = new Set();
for (const f of parcels.features) {
  const p = f.properties, g = f.geometry;
  if (!g || g.type !== "Polygon") continue;
  if (!(p.UseDescription === "Single" || p.UseDescription == null)) continue;
  if (NOT_HOMES[p.AIN]) continue;
  const lon = p.CENTER_LON, lat = p.CENTER_LAT;
  if (!inside([lon, lat], GATE)) continue;
  const m2 = area(g.coordinates[0]);
  if (m2 < MIN_M2 || m2 > MAX_M2) continue;
  const id = crypto.createHash("sha256").update("tesoro-treats|" + p.AIN).digest("hex").slice(0, 8);
  if (ids.has(id)) throw new Error("id collision " + id);
  ids.add(id);
  lots.push({ id, ain: p.AIN, lat, lon, ring: g.coordinates[0], facts: lotFacts(g.coordinates[0]) });
}

// Neighbours: lots sharing at least 5 m of lot line.
const nbrs = new Map(lots.map(l => [l.id, new Set()]));
for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
  const A = lots[i].facts, B = lots[j].facts;
  if (A.box[0] > B.box[2] + 1 || B.box[0] > A.box[2] + 1 || A.box[1] > B.box[3] + 1 || B.box[1] > A.box[3] + 1) continue;
  let shared = 0;
  for (let k = 0; k < A.samples.length; k += 2) if (dPoly(A.samples[k], B.edges) <= 0.6) shared += 2;
  if (shared >= 5) { nbrs.get(lots[i].id).add(lots[j].id); nbrs.get(lots[j].id).add(lots[i].id); }
}
const sure = new Map(lots.filter(l => l.facts.cands.length === 1).map(l => [l.id, l.facts.cands[0]]));
function streetOf(l) {
  if (OVERRIDES[l.ain]) return OVERRIDES[l.ain];
  const { cands, near, adj } = l.facts;
  if (!cands.length) return [...near.entries()].sort((a, b) => a[1] - b[1])[0][0];
  if (cands.length === 1) return cands[0];
  if (near.get(cands[1]) - near.get(cands[0]) > TIE) return cands[0];
  const tied = cands.filter(n => near.get(n) - near.get(cands[0]) <= TIE);
  const votes = new Map();
  for (const n of nbrs.get(l.id)) { const s = sure.get(n); if (s && tied.includes(s)) votes.set(s, (votes.get(s) || 0) + 1); }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return ranked[0][0];
  return tied.slice().sort((a, b) => (adj.get(a) - adj.get(b)) || (near.get(a) - near.get(b)))[0];
}

const streets = [], homes = [];
for (const l of lots) {
  const st = streetOf(l);
  if (!streets.includes(st)) streets.push(st);
  const ring = simplify(l.ring, 0.5).slice(0, -1).flatMap(c => enc(c[1], c[0]));
  homes.push([l.id, streets.indexOf(st), ...enc(l.lat, l.lon), ring]);
}
homes.sort((a, b) => a[2] - b[2] || a[3] - b[3]);

// Streets for the page to draw as glowing roads and label: every street with a
// house on this map, plus Avenida Rancho Tesoro along the gates (drawn dimmer).
function simplifyLine(pts, tol) {
  const p = pts.map(q => xy(q.lon, q.lat));
  const keep = new Array(p.length).fill(false);
  keep[0] = keep[p.length - 1] = true;
  (function dp(a, b) {
    let best = -1, idx = -1;
    const [ax, ay] = p[a], [bx, by] = p[b], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / L;
      if (d > best) { best = d; idx = i; }
    }
    if (best > tol) { keep[idx] = true; dp(a, idx); dp(idx, b); }
  })(0, p.length - 1);
  return pts.filter((_, i) => keep[i]);
}
const NEAR = { s: 34.4795, w: -118.5735, n: 34.4895, e: -118.5545 };
const near = q => q.lat >= NEAR.s && q.lat <= NEAR.n && q.lon >= NEAR.w && q.lon <= NEAR.e;
const roads = [], homeStreets = new Set(streets);
for (const w of osm.elements) {
  const name = w.tags.name, edge = name === "Avenida Rancho Tesoro";
  // A street with houses on this map; a court just outside the gate can poke into GATE's corners.
  if (!edge && !homeStreets.has(name)) continue;
  if (!streets.includes(name)) streets.push(name);
  let run = [];
  const flush = () => {
    if (run.length > 1) roads.push([streets.indexOf(name), edge ? 0 : 1, simplifyLine(run, 1.5).flatMap(q => enc(q.lat, q.lon))]);
    run = [];
  };
  for (const q of w.geometry) { if (near(q)) run.push(q); else flush(); }
  flush();
}

const made = new Date().toISOString().slice(0, 10);
const src = `// Generated by scripts/treat-homes.mjs on ${made}. Do not edit by hand; re-run it.
// House lots behind the gate for the Halloween treat map. Served only through
// /api/treats, to neighbors who have the code.
//   homes: [id, street index, lat, lon, outline]; coordinates are millionths of a
//   degree from base, outline is a flat lat,lon,lat,lon... ring.
//   roads: [street index, 1 inside the gate / 0 the road along it, flat lat,lon,... line]
module.exports = ${JSON.stringify({ made, base: BASE, streets, homes, roads })};
`;
fs.writeFileSync(OUT, src);
console.log(`${homes.length} homes, ${roads.length} road lines, ${streets.length} street names -> ${path.relative(ROOT, OUT)} (${(src.length / 1024).toFixed(1)} KB)`);
