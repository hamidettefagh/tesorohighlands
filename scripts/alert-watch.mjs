// Neighborhood alert watcher — the "notification that lives in WhatsApp".
//
// Every ~10 minutes (GitHub Actions cron) this checks the same official feeds
// the site reads live — Cal OES evacuation zones, the WFIGS national fire feed
// enriched with CAL FIRE, and NWS alerts — plus SCE's own shutoff (PSPS) list
// for our circuit, and when something NEW starts affecting Tesoro Highlands it:
//   1. writes alert.json (deploys with the site → the Fire page shows a
//      one-tap "Share on WhatsApp" card with the message already composed), and
//   2. optionally pings the admin's phone via ntfy.sh (NTFY_TOPIC env) so a
//      human can forward the alert to the community group within seconds.
//
// Messages are deterministic templates, NOT AI — alert wording is a safety
// surface and must never be creative. Runs commit only on state transitions.
// ALERT_OUT=some/file.json writes there instead of alert.json (a dry run).
//
// Node 20+, zero dependencies. Tests: node scripts/alert-watch.test.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOME = { lat: 34.478, lon: -118.531 };
const SITE = "https://tesorohighlands.com";
const OUT = process.env.ALERT_OUT || new URL("../alert.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const UA = { "User-Agent": "tesorohighlands.com alert watcher (neighbor community site)" };

/* ---------- small geo helpers (ported from nav.js) ---------- */
function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = (x) => (x * Math.PI) / 180;
  const dla = t(la2 - la1), dlo = t(lo2 - lo1);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const DIR_WORD = { N:"north",NNE:"north-northeast",NE:"northeast",ENE:"east-northeast",E:"east",ESE:"east-southeast",SE:"southeast",SSE:"south-southeast",S:"south",SSW:"south-southwest",SW:"southwest",WSW:"west-southwest",W:"west",WNW:"west-northwest",NW:"northwest",NNW:"north-northwest" };
function bearingWord(lat1, lon1, lat2, lon2) {
  const y = Math.sin(((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180);
  const x = Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(((lon2 - lon1) * Math.PI) / 180);
  const b = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return DIR_WORD[COMPASS[Math.round(b / 22.5) % 16]];
}
// Even-odd ray cast — same algorithm the site uses for "is home in this zone".
function inPoly(px, py, rings) {
  let inside = false;
  for (const g of rings) {
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      const xi = g[i][0], yi = g[i][1], xj = g[j][0], yj = g[j][1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const normName = (s) => String(s || "").toUpperCase().replace(/\bFIRE\b/g, " ").replace(/[^A-Z0-9]/g, "");
const title = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* ---------- condition detectors ----------
   Each returns a list of {id, prio, level, title, text}. `id` must be stable
   while the condition persists so we only notify on genuinely-new things. */

async function checkEvac() {
  const env = `${HOME.lon - 0.35},${HOME.lat - 0.35},${HOME.lon + 0.35},${HOME.lat + 0.35}`;
  const u = "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query" +
    `?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    "&outFields=STATUS,NOTES,ZONE_ID&returnGeometry=true&outSR=4326&f=json";
  const j = await getJson(u);
  if (!j || j.error || !Array.isArray(j.features)) throw new Error("evac feed error");
  const out = [];
  for (const f of j.features) {
    const a = f.attributes || {}, rings = f.geometry?.rings || [];
    const st = String(a.STATUS || "");
    const isOrder = /order/i.test(st), isShelter = /shelter/i.test(st), isWarn = /warning/i.test(st);
    if ((!isOrder && !isWarn && !isShelter) || !rings.length) continue;
    let cx = 0, cy = 0, n = 0;
    for (const ring of rings) for (const p of ring) { cx += p[0]; cy += p[1]; n++; }
    cx /= n; cy /= n;
    const covers = inPoly(HOME.lon, HOME.lat, rings);
    const dist = haversine(HOME.lat, HOME.lon, cy, cx);
    const dir = bearingWord(HOME.lat, HOME.lon, cy, cx);
    // NOTES can be a full public alert paragraph — reduce to the fire name.
    const rawNotes = String(a.NOTES || "").trim();
    const notes = rawNotes.length <= 48 ? rawNotes
      : (rawNotes.match(/([A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+){0,3}\s+(?:Brush\s+)?Fire)\b/) || [,""])[1];
    const zid = String(a.ZONE_ID || `${cy.toFixed(3)},${cx.toFixed(3)}`);
    const why = notes ? ` (${notes})` : "";
    if (covers && isOrder) out.push({ id: `order-our:${zid}`, prio: 100, level: "danger",
      title: "EVACUATION ORDER — our zone",
      text: `🚨 *EVACUATION ORDER — Tesoro Highlands*${why}\nLeave NOW via your planned route — Copper Hill → McBean → I-5, or Newhall Ranch Rd → I-5.\nZone lookup: protect.genasys.com\nLive status: ${SITE}/fire` });
    else if (covers && isShelter) out.push({ id: `shelter-our:${zid}`, prio: 95, level: "danger",
      title: "SHELTER IN PLACE — our zone",
      text: `🚨 *SHELTER IN PLACE — Tesoro Highlands*${why}\nStay inside with doors and windows closed and follow official direction.\nLive status: ${SITE}/fire` });
    else if (covers && isWarn) out.push({ id: `warn-our:${zid}`, prio: 90, level: "caution",
      title: "Evacuation WARNING — our zone",
      text: `⚠️ *Evacuation WARNING includes our zone*${why}\nBe packed and ready to leave. Those needing extra time — older neighbors, mobility needs, large animals — should leave NOW.\nZone lookup: protect.genasys.com\nLive status: ${SITE}/fire` });
    else if (isOrder && dist <= 10) out.push({ id: `order-near:${zid}`, prio: 60, level: "caution",
      title: `Evacuation order ~${Math.round(dist)} mi ${dir} of us`,
      text: `⚠️ *Evacuation ORDER ~${Math.round(dist)} mi ${dir} of us*${why} — not our zone, but close. Worth knowing tonight.\nLive map: ${SITE}/fire` });
  }
  return out;
}

async function checkFires() {
  const env = `${HOME.lon - 0.5},${HOME.lat - 0.4},${HOME.lon + 0.5},${HOME.lat + 0.4}`;
  const where = encodeURIComponent("IncidentTypeCategory='WF' AND FireOutDateTime IS NULL AND (PercentContained < 100 OR PercentContained IS NULL)");
  const u = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query" +
    `?where=${where}&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    "&outFields=IncidentName,IncidentSize,PercentContained,ModifiedOnDateTime_dt&returnGeometry=true&outSR=4326&f=geojson";
  const [j, cal] = await Promise.all([
    getJson(u),
    getJson("https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false").catch(() => null),
  ]);
  if (!j || !Array.isArray(j.features)) throw new Error("fire feed error");
  const calList = (Array.isArray(cal) ? cal : cal?.Incidents || []).filter((i) => i && i.Latitude && i.Longitude);
  const cands = [];
  for (const f of j.features) {
    if (!f.geometry?.coordinates) continue;
    const p = f.properties || {}, c = f.geometry.coordinates;
    const nm = String(p.IncidentName || "").trim();
    if (/^LAC-?\d+$/i.test(nm)) continue;
    let acres = p.IncidentSize, mod = p.ModifiedOnDateTime_dt, calDist = null;
    for (const cf of calList) {
      if (normName(cf.Name) !== normName(nm)) continue;
      const cd = haversine(c[1], c[0], cf.Latitude, cf.Longitude);
      if (cd > 15) continue;
      calDist = cd;
      const cu = Date.parse(cf.Updated || "");
      if (cf.AcresBurned != null && (acres == null || acres === 0 || (!isNaN(cu) && (mod == null || cu >= mod)))) acres = cf.AcresBurned;
      if (!isNaN(cu) && (mod == null || cu > mod)) mod = cu;
      break;
    }
    // same staleness rule as the site: unsized+quiet = out; sized gets 48h
    if (mod != null) {
      const quiet = Date.now() - mod, sized = acres != null && acres >= 10;
      if (quiet > (sized ? 48 : 12) * 3600 * 1000) continue;
    }
    cands.push({ nm, norm: normName(nm), acres, mod, calDist, lat: c[1], lon: c[0] });
  }
  // IRWIN's duplicate records for one fire can sit miles apart (Holser's two
  // were 3.7 mi apart — the site listed one, this watcher alerted from the
  // other). Same rule as the site's list: same name within 10 mi = one fire,
  // keep the sized record, then the fresher — so the alert and the page can
  // never disagree on where a fire is.
  const kept = [];
  for (const c of cands) {
    const i = kept.findIndex((o) => o.norm === c.norm && haversine(o.lat, o.lon, c.lat, c.lon) < 10);
    if (i < 0) { kept.push(c); continue; }
    // score → nearest to CAL FIRE's authoritative point → freshest (enrichment
    // gives both duplicates the same timestamp, so mod alone ties on feed order)
    const score = (x) => (x.acres != null && x.acres > 0 ? 1 : 0);
    const dA = kept[i].calDist ?? Infinity, dB = c.calDist ?? Infinity;
    if (score(c) > score(kept[i]) || (score(c) === score(kept[i]) && dB < dA) ||
        (score(c) === score(kept[i]) && dB === dA && (c.mod || 0) > (kept[i].mod || 0))) kept[i] = c;
  }
  const out = [];
  for (const k of kept) {
    const dist = haversine(HOME.lat, HOME.lon, k.lat, k.lon);
    const acres = k.acres || 0;
    // WhatsApp-worthy only when genuinely action-relevant for THIS neighborhood.
    // A moderate fire 11 miles out belongs on the site, not in the group chat:
    //   close and real:      ≤6 mi and ≥20 acres   → urgent tone
    //   mid and substantial: ≤10 mi and ≥100 acres → watchful tone
    //   far but major:       ≤15 mi and ≥500 acres → awareness tone
    let level = null;
    if (dist <= 6 && acres >= 20) level = "danger";
    else if (dist <= 10 && acres >= 100) level = "caution";
    else if (dist <= 15 && acres >= 500) level = "caution";
    else continue;
    const dir = bearingWord(HOME.lat, HOME.lon, k.lat, k.lon);
    const dTxt = dist.toFixed(dist < 10 ? 1 : 0);
    // Growth tier lives in the condition id: a fire crossing 50/100/250/1000
    // acres changes the sig, so the message re-composes with CURRENT numbers.
    const tier = acres >= 1000 ? 4 : acres >= 250 ? 3 : acres >= 100 ? 2 : acres >= 50 ? 1 : 0;
    // A caution-tier fire ranks BELOW a real evacuation order near us (prio 60):
    // someone 8 miles away being ordered out matters more than distant flames.
    out.push(level === "danger"
      ? { id: `fire:${k.norm}:t${tier}`, prio: 70, level,
          title: `${title(k.nm)} Fire ~${dTxt} mi ${dir} of us`,
          text: `🔥 *${title(k.nm)} Fire* — about ${Math.round(acres).toLocaleString()} acres, ~${dTxt} mi ${dir} of Tesoro Highlands (straight-line).\nNot an evacuation notice — stay aware, keep phones charged, check your go-bag.\nLive map & evacuation status: ${SITE}/fire` }
      : { id: `fire:${k.norm}:t${tier}`, prio: 58, level,
          title: `${title(k.nm)} Fire ~${dTxt} mi ${dir} of us`,
          text: `🔥 *${title(k.nm)} Fire* — about ${Math.round(acres).toLocaleString()} acres, ~${dTxt} mi ${dir} of Tesoro Highlands (straight-line — farther by road).\nNot close, and no evacuation activity for our area — sharing for awareness only.\nLive map & status: ${SITE}/fire` });
  }
  return out;
}

async function checkNws() {
  const j = await getJson(`https://api.weather.gov/alerts/active?point=${HOME.lat},${HOME.lon}`, { Accept: "application/geo+json" });
  if (!j || !Array.isArray(j.features)) throw new Error("nws feed error");
  const out = [];
  for (const f of j.features) {
    const ev = String(f.properties?.event || "");
    if (/red flag warning/i.test(ev)) {
      out.push({ id: `redflag:${String(f.properties?.id || ev).slice(-24)}`, prio: 50, level: "caution",
        title: "Red Flag Warning",
        text: `🚩 *Red Flag Warning* for our area — dry, windy conditions where a spark spreads fast.\nNo open flames, no yard equipment today; report smoke immediately (911).\nConditions: ${SITE}/fire` });
    }
  }
  return out;
}

async function checkQuakes() {
  // Only quakes people definitely felt: M4.5+ within ~40 mi, last 2 hours.
  const start = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const j = await getJson(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${HOME.lat}&longitude=${HOME.lon}&maxradiuskm=64&minmagnitude=4.5&orderby=time&starttime=${encodeURIComponent(start)}`);
  if (!j || !Array.isArray(j.features)) throw new Error("quake feed error");
  return j.features.map((f) => {
    const c = f.geometry?.coordinates || [0, 0];
    const dist = haversine(HOME.lat, HOME.lon, c[1], c[0]);
    const dir = bearingWord(HOME.lat, HOME.lon, c[1], c[0]);
    const m = (Math.round((f.properties?.mag || 0) * 10) / 10).toFixed(1);
    return { id: `quake:${f.id}`, prio: 55, level: "caution",
      title: `M${m} earthquake ~${Math.round(dist)} mi ${dir} of us`,
      text: `🫨 *M${m} earthquake* — ${String(f.properties?.place || "").trim()}, ~${Math.round(dist)} mi ${dir} of Tesoro Highlands.\nIf you felt it: check for gas smell and make sure the water heater is strapped. Aftershocks are possible.\nDetails: ${f.properties?.url || "https://earthquake.usgs.gov"}\n${SITE}/fire` };
  });
}

async function checkOutages() {
  const env = `${HOME.lon - 0.3},${HOME.lat - 0.25},${HOME.lon + 0.3},${HOME.lat + 0.25}`;
  const u = "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_%28View%29/FeatureServer/0/query" +
    `?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    "&outFields=UtilityCompany,Cause,ImpactedCustomers,OutageStatus,OutageType,IncidentId&returnGeometry=true&outSR=4326&f=json";
  const j = await getJson(u);
  if (!j || j.error || !Array.isArray(j.features)) throw new Error("outage feed error");
  const out = [];
  for (const f of j.features) {
    const a = f.attributes || {}, g = f.geometry || {};
    if (!/active/i.test(String(a.OutageStatus || ""))) continue;
    const dist = haversine(HOME.lat, HOME.lon, g.y, g.x);
    const dir = bearingWord(HOME.lat, HOME.lon, g.y, g.x);
    const psps = /psps|public safety/i.test(`${a.OutageType} ${a.Cause}`);
    const cust = Number(a.ImpactedCustomers) || 0;
    const iid = String(a.IncidentId || `${(g.y||0).toFixed(3)},${(g.x||0).toFixed(3)}`);
    if (psps && dist <= 10) {
      out.push({ id: `psps:${iid}`, prio: 65, level: "caution",
        title: `PSPS power shutoff ~${Math.round(dist)} mi ${dir} of us`,
        text: `⚡ *PSPS Public Safety Power Shutoff* reported ~${Math.round(dist)} mi ${dir} of Tesoro Highlands${cust ? ` (~${cust.toLocaleString()} customers)` : ""}.\nCharge phones and backups now; fridge stays cold ~4 hours unopened.\nSCE status: sce.com/psps\nLive info: ${SITE}/fire` });
    } else if (!psps && dist <= 8 && cust >= 500) {
      out.push({ id: `outage:${iid}`, prio: 45, level: "caution",
        title: `Large SCE outage ~${Math.round(dist)} mi ${dir} of us`,
        text: `⚡ *Large power outage* — ~${cust.toLocaleString()} customers, ~${Math.round(dist)} mi ${dir} of Tesoro Highlands${a.Cause ? ` (${String(a.Cause).trim()})` : ""}.\nOutage map: sce.com/outages\nLive info: ${SITE}/fire` });
    }
  }
  return out;
}

/* ---------- SCE power shutoffs (PSPS) for our own circuit ----------
   The state feed above only sees a shutoff once it has happened, and only as a
   distance, so it can't tell our power from the next circuit over. SCE's own
   outage map can: layer 0 is "under consideration", layer 1 "power is shut
   off". Those layers aren't a published API — they can change without notice,
   and they briefly come back empty while SCE refreshes them — so a failed or
   suspicious read is retried, and one that still fails leaves the state feed's
   PSPS alert in place and says nothing about our circuit. */
const PSPS = "https://sce-outage-ags.esriemcs.com/arcgis/rest/services/43/psps/MapServer";
// What SCE called our circuit in Oct 2026; named in messages when SCE's data doesn't name one.
const OUR_CIRCUIT = "Orion";
// One point per street behind the gate (street centres from api/_treat-homes.js).
// A shutoff is ours when SCE's area covers any of them — by place, not by name,
// so a renamed circuit still counts and a far-off section of Orion doesn't.
const STREETS = [[-118.5581,34.4878],[-118.5573,34.4878],[-118.559,34.4876],[-118.5627,34.487],[-118.5588,34.487],[-118.5565,34.487],
  [-118.5578,34.4869],[-118.5624,34.4865],[-118.5596,34.4863],[-118.5584,34.4861],[-118.5578,34.4858],[-118.5607,34.4856],[-118.559,34.4853],
  [-118.5592,34.4845],[-118.561,34.4843],[-118.5623,34.4841],[-118.5673,34.484],[-118.5707,34.484],[-118.5632,34.4837],[-118.5674,34.4837],
  [-118.5657,34.4834],[-118.569,34.4834],[-118.5581,34.4833],[-118.5608,34.4833],[-118.5634,34.4828],[-118.5686,34.4827]];
const MID = { lat: 34.4845, lon: -118.564 };   // middle of those houses
const NEAR_MI = 10;

async function pspsRead() {
  const q = (layer, env, offset) => getJson(`${PSPS}/${layer}/query?where=1%3D1&geometry=${env}` +
    "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=OBJECTID,CIRCUIT_NAME,PSPS,PSPS_Details,StartDate,EndDate,ERT" +
    `&returnGeometry=true&outSR=4326&maxAllowableOffset=${offset}&f=json`).then((j) => {
    if (!j || j.error || !Array.isArray(j.features)) throw new Error(`SCE PSPS layer ${layer} error`);
    return j.features.map((f) => ({ layer, a: f.attributes || {}, rings: f.geometry?.rings || [] }));
  });
  const ours = "-118.5727,34.4807,-118.5545,34.4898";   // the streets above, padded ~200 m: exact shapes
  const wide = `${MID.lon - 0.18},${MID.lat - 0.15},${MID.lon + 0.18},${MID.lat + 0.15}`;   // ~10 mi out: rough shapes
  const [watch, off, around] = await Promise.all([q(0, ours, 0.0001), q(1, ours, 0.0001), q(1, wide, 0.002)]);
  const seen = new Set(off.map((f) => f.a.OBJECTID));
  return [...watch, ...off, ...around.filter((f) => !seen.has(f.a.OBJECTID))];
}

export function pspsRecords(feats) {
  return feats.map(({ layer, a, rings }) => {
    let dist = Infinity, at = null;
    for (const g of rings) for (const p of g) {
      const d = haversine(MID.lat, MID.lon, p[1], p[0]);
      if (d < dist) { dist = d; at = p; }
    }
    return { layer, name: title(a.CIRCUIT_NAME), status: [a.PSPS, a.PSPS_Details].filter(Boolean).join(" "),
      start: a.StartDate, end: a.EndDate, ert: a.ERT, dist,
      covers: STREETS.filter(([x, y]) => inPoly(x, y, rings)).length,
      dir: at ? bearingWord(MID.lat, MID.lon, at[1], at[0]) : "" };
  });
}

// SCE's steps: Monitored → De-Energization Expected → De-Energized →
// Re-Energization Expected → Re-Energized. Anything else ("Downstream": off
// because a circuit feeding it is) goes with the layer it sits on.
export function pspsStage(r) {
  const s = r.status;
  if (/re-?energi[sz]ation expected/i.test(s)) return "restoring";
  if (/re-?energi[sz]ed/i.test(s)) return "restored";
  if (/de-?energi[sz]ation expected/i.test(s)) return "expected";
  if (/de-?energi[sz]ed/i.test(s)) return "off";
  if (/monitor/i.test(s)) return "watch";
  return r.layer === 1 ? "off" : "watch";
}

const RANK = { off: 5, restoring: 4, expected: 3, watch: 2, restored: 1 };
const pt = (ms, o) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", ...o }).replace(/ /g, " ");
const clock = (ms) => pt(ms, { hour: "numeric", minute: "2-digit" }).replace(":00 ", " ");               // "6 AM"
const day = (ms) => `${pt(ms, { weekday: "short" })} ${clock(ms)}`;                                         // "Thu 6 AM"
const date = (ms) => `${pt(ms, { weekday: "short", month: "short", day: "numeric" })}, ${clock(ms)}`;      // "Thu, Oct 15, 6 AM"
const andList = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

// Prio: a shutoff of OUR power outranks a distant fire (58); shutoffs that
// aren't ours sit just above a Red Flag Warning (50).
export function pspsConditions(recs, now = Date.now()) {
  const ours = recs.filter((r) => r.covers > 0).sort((x, y) => RANK[pspsStage(y)] - RANK[pspsStage(x)]);
  const lead = ours[0], stage = lead ? pspsStage(lead) : null;
  const names = [...new Set(ours.map((r) => r.name).filter(Boolean))];
  const circuit = andList(names) || OUR_CIRCUIT;
  const part = lead && lead.covers < STREETS.length ? " SCE’s map shows part of our neighborhood, not all of it." : "";
  const asOf = clock(now), tail = `SCE status: sce.com/outagemap\nLive info: ${SITE}/fire`;
  const back = lead?.ert ? ` SCE’s estimate at ${asOf}: back by ${date(lead.ert)}.` : "";

  const near = [];
  for (const r of recs.filter((r) => !r.covers && r.dist <= NEAR_MI && ["off", "restoring"].includes(pspsStage(r))).sort((x, y) => x.dist - y.dist)) {
    if (!near.some((n) => n.name === r.name)) near.push(r);
  }
  const shown = near.slice(0, 4).map((r) => `${r.name && (names.includes(r.name) || r.name === OUR_CIRCUIT) ? `another section of ${r.name}` : r.name || "a circuit"}` +
    ` (${r.dist < 1 ? "under 1 mi" : `~${Math.round(r.dist)} mi`} ${r.dir})`);
  const nearTxt = `SCE has shut off power on ${near.length === 1 ? "one circuit" : `${near.length} circuits`} near us: ` +
    `${andList(near.length > shown.length ? [...shown, `${near.length - shown.length} more`] : shown)}.`;

  const out = [];
  if (stage === "off") out.push({ id: "power:ours:off", prio: 68, level: "caution",
    title: "Our power is shut off (SCE safety shutoff)",
    text: `⚡ *Our power is shut off — SCE safety shutoff (${circuit} circuit)*\nSCE has shut off our circuit to prevent wildfires.${part} Power comes back after the wind dies down and crews inspect the lines.${back}\nKeep the fridge closed: it stays cold about 4 hours, a full freezer about 2 days. Downed line? Stay away and call 911.\n${tail}` });
  else if (stage === "restoring") out.push({ id: "power:ours:restoring", prio: 64, level: "caution",
    title: "SCE is restoring our power",
    text: `⚡ *Power coming back — our circuit (${circuit})*\nSCE is working to turn our power back on; crews inspect the lines first.${back}\nDowned line? Stay away and call 911.\n${tail}` });
  else if (stage === "expected") out.push({ id: "power:ours:expected", prio: 67, level: "caution",
    title: "SCE expects to shut off our power soon",
    text: `⚡ *Power shutoff expected — our circuit (${circuit})*\nAs of ${asOf}, SCE expects to shut off our power, typically within 1 to 4 hours.${part}\nCharge phones and batteries now, and know how to open your garage door by hand. A closed fridge stays cold about 4 hours, a full freezer about 2 days.\n${tail}` });
  else if (stage === "watch") {
    const starts = ours.map((r) => r.start).filter(Boolean), ends = ours.map((r) => r.end).filter(Boolean);
    const start = starts.length ? Math.min(...starts) : 0, end = ends.length ? Math.max(...ends) : 0;
    const id = `power:ours:watch:${start}-${end}`;
    if (near.length) out.push({ id: `${id}:near`, prio: 59, level: "caution",
      title: "Shutoffs near us; our power still on",
      text: `⚡ *Power shutoffs near us — ours still on*\n${nearTxt} Our circuit (${circuit}) was still on at ${asOf}${end ? `, and SCE lists it for a possible shutoff until ${day(end)}` : ", and SCE still lists it for a possible shutoff"}.\nCharge phones and batteries now, and know how to open your garage door by hand.\n${tail}` });
    else out.push({ id, prio: 59, level: "caution",
      title: start && end ? `SCE may shut off our power ${day(start)} – ${day(end)}` : "SCE may shut off our power in the next few days",
      text: `⚡ *Possible power shutoff — our circuit (${circuit})*\nSCE has our circuit on its list for a possible wildfire-safety shutoff${start && end ? `, ${date(start)} to ${date(end)}` : ""}. It isn’t certain yet: SCE decides from the actual wind.${part}\nCharge phones, power banks and home batteries before then, and know how to open your garage door by hand. If someone at home relies on powered medical equipment, plan for that now.\n${tail}` });
  } else if (stage === "restored") out.push({ id: "power:ours:restored", prio: 40, level: "caution",
    title: "Our power is back on",
    text: `✅ *Power is back on — our circuit (${circuit})*\nSCE has restored our circuit after the safety shutoff. Still dark at your house? Report it at sce.com/outagemap\nLive info: ${SITE}/fire` });

  if (near.length && (!stage || stage === "restored")) out.push({ id: "power:near", prio: 56, level: "caution",
    title: "SCE shut off power nearby — not our circuit",
    text: `⚡ *Power shutoffs nearby — not our circuit*\n${nearTxt} Our circuit (${circuit}) ${stage ? "is back on" : `was not on SCE’s shutoff list at ${asOf}`}.\nCheck your address: sce.com/outagemap\nLive info: ${SITE}/fire` });
  return out;
}

async function checkPsps(prevSig) {
  // Our circuit (or nearby shutoffs) vanishing from one read is also how SCE's
  // refresh looks, so that gets re-read too before we believe it.
  const had = { ours: /power:ours:/.test(prevSig), near: /power:near|:near(\||$)/.test(prevSig) };
  for (let attempt = 1; ; attempt++) {
    try {
      const out = pspsConditions(pspsRecords(await pspsRead()));
      const ours = out.some((c) => c.id.startsWith("power:ours:")), near = out.some((c) => /^power:near$|:near$/.test(c.id));
      if (attempt < 3 && ((had.ours && !ours) || (had.near && !near))) throw new Error("what SCE listed last time is gone");
      return out;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`SCE shutoff read ${attempt} not trusted yet (${e.message}); reading again in 30 s.`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

/* ---------- main ---------- */
async function main() {
  let prev = { sig: "", active: false };
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {}

  const results = await Promise.allSettled([checkEvac(), checkFires(), checkNws(), checkQuakes(), checkOutages(), checkPsps(prev.sig || "")]);
  const failed = results.filter((r) => r.status === "rejected");
  for (const r of failed) console.error("Feed failed:", r.reason?.message || r.reason);
  // If EVERY check failed we know nothing — keep previous state rather than
  // declaring a false all-clear (same honesty rule as the site).
  if (failed.length === results.length) {
    console.error("All feeds failed; keeping previous alert state.");
    return;
  }
  let conds = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => b.prio - a.prio);
  // When SCE's read worked it knows which shutoff is ours, so it replaces the
  // state feed's distance-only PSPS alerts; when it failed, those stay.
  if (results[5].status === "fulfilled") conds = conds.filter((c) => !c.id.startsWith("psps:"));
  const sig = conds.map((c) => c.id).sort().join("|");

  if (sig === (prev.sig || "")) {
    console.log(conds.length ? `Unchanged: ${conds.length} active condition(s).` : "All quiet, no change.");
    return;
  }

  const prevIds = new Set((prev.sig || "").split("|").filter(Boolean));
  const fresh = conds.filter((c) => !prevIds.has(c.id));
  const top = conds[0] || null;

  const alert = top
    ? { active: true, sig, level: top.level, title: top.title, text: top.text.replace(/\*/g, ""), waText: top.text,
        others: conds.slice(1).map((c) => c.title), updatedAt: new Date().toISOString() }
    : { active: false, sig: "", updatedAt: new Date().toISOString() };
  writeFileSync(OUT, JSON.stringify(alert, null, 2) + "\n");
  console.log(top ? `ALERT: ${top.title} (${conds.length} condition(s), ${fresh.length} new)` : "Cleared — back to quiet.");

  // Optional phone ping so an admin can forward to the group within seconds.
  // No "all clear" while a feed is failing: its conditions may only be hidden.
  const topic = process.env.NTFY_TOPIC;
  if (topic && (fresh.length || (!top && prev.active && !failed.length))) {
    const body = top
      ? `${top.title}\n\nWhatsApp-ready message is one tap away:\n${SITE}/fire`
      : "All clear — the earlier alert condition has ended.";
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST", body,
        headers: { Title: top ? "Tesoro Highlands alert" : "Tesoro Highlands all clear",
          Priority: top?.level === "danger" ? "urgent" : "high", Tags: top ? "rotating_light" : "white_check_mark", ...UA },
        signal: AbortSignal.timeout(15000),
      });
      console.log("ntfy ping sent.");
    } catch (e) { console.error("ntfy ping failed (non-fatal):", e.message); }
  }
}

// Run when called as a script; tests import the PSPS helpers without running it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
