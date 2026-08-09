// Neighborhood alert watcher — the "notification that lives in WhatsApp".
//
// Every ~10 minutes (GitHub Actions cron) this checks the same official feeds
// the site reads live — Cal OES evacuation zones, the WFIGS national fire feed
// enriched with CAL FIRE, and NWS alerts — and when something NEW starts
// affecting Tesoro Highlands it:
//   1. writes alert.json (deploys with the site → the Fire page shows a
//      one-tap "Share on WhatsApp" card with the message already composed), and
//   2. optionally pings the admin's phone via ntfy.sh (NTFY_TOPIC env) so a
//      human can forward the alert to the community group within seconds.
//
// Messages are deterministic templates, NOT AI — alert wording is a safety
// surface and must never be creative. Runs commit only on state transitions.
//
// Node 20+, zero dependencies.

import { readFileSync, writeFileSync } from "node:fs";

const HOME = { lat: 34.478, lon: -118.531 };
const SITE = "https://tesorohighlands.com";
const OUT = new URL("../alert.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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
    else if (covers && isWarn) out.push({ id: `warn-our:${zid}`, prio: 90, level: "danger",
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
  const out = [];
  for (const f of j.features) {
    if (!f.geometry?.coordinates) continue;
    const p = f.properties || {}, c = f.geometry.coordinates;
    const nm = String(p.IncidentName || "").trim();
    if (/^LAC-?\d+$/i.test(nm)) continue;
    let acres = p.IncidentSize, mod = p.ModifiedOnDateTime_dt;
    for (const cf of calList) {
      if (normName(cf.Name) !== normName(nm)) continue;
      if (haversine(c[1], c[0], cf.Latitude, cf.Longitude) > 15) continue;
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
    const dist = haversine(HOME.lat, HOME.lon, c[1], c[0]);
    if (dist > 12 || (acres || 0) < 20) continue;
    const dir = bearingWord(HOME.lat, HOME.lon, c[1], c[0]);
    out.push({ id: `fire:${normName(nm)}`, prio: 70, level: "danger",
      title: `${title(nm)} Fire ~${dist.toFixed(dist < 10 ? 1 : 0)} mi ${dir} of us`,
      text: `🔥 *${title(nm)} Fire* — about ${Math.round(acres).toLocaleString()} acres, ~${dist.toFixed(dist < 10 ? 1 : 0)} mi ${dir} of Tesoro Highlands.\nNot an evacuation notice — stay aware, keep phones charged, check your go-bag.\nLive map & evacuation status: ${SITE}/fire` });
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

/* ---------- main ---------- */
let prev = { sig: "", active: false };
try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {}

const results = await Promise.allSettled([checkEvac(), checkFires(), checkNws(), checkQuakes(), checkOutages()]);
const failed = results.filter((r) => r.status === "rejected");
// If EVERY check failed we know nothing — keep previous state rather than
// declaring a false all-clear (same honesty rule as the site).
if (failed.length === results.length) {
  console.error("All feeds failed; keeping previous alert state.");
  process.exit(0);
}
const conds = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => b.prio - a.prio);
const sig = conds.map((c) => c.id).sort().join("|");

if (sig === (prev.sig || "")) {
  console.log(conds.length ? `Unchanged: ${conds.length} active condition(s).` : "All quiet, no change.");
  process.exit(0);
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
const topic = process.env.NTFY_TOPIC;
if (topic && (fresh.length || (!top && prev.active))) {
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
