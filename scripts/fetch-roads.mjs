// Builds roads.json: planned Caltrans lane/ramp closures on I-5 and SR-14
// within ~12 miles of Tesoro Highlands, from the Caltrans District 7 Lane
// Closure System feed (cwwp2.dot.ca.gov — public JSON, no key). The source
// file is ~9 MB, so this runs server-side (GitHub Action / local) and commits
// a tiny filtered file the fire page can fetch.
//
// Planned roadwork only — live incidents and emergency closures are QuickMap's
// job (the page links it). Fails soft: any error keeps the last good file.
//
//   node scripts/fetch-roads.mjs

import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../roads.json", import.meta.url);
const SRC = "https://cwwp2.dot.ca.gov/data/d7/lcs/lcsStatusD07.json";
const HOME = { lat: 34.478, lon: -118.531 };
const RADIUS_MI = 12;
const DAYS_AHEAD = 10;
const ROUTES = new Set(["I-5", "SR-14"]);

function hav(la1, lo1, la2, lo2) {
  const R = 3958.8, t = (x) => (x * Math.PI) / 180;
  const dla = t(la2 - la1), dlo = t(lo2 - lo1);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const flag = (o, k) => String((o && o[k] && o[k]["is" + k.charAt(0).toUpperCase() + k.slice(1)]) || "") === "true";

let data;
try {
  const res = await fetch(SRC, {
    headers: { "User-Agent": "tesorohighlands.com feed builder", Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  data = (await res.json()).data || [];
} catch (err) {
  console.error("roads: fetch failed —", String(err).slice(0, 120), "— keeping last good file.");
  process.exit(0);
}

const now = Date.now() / 1000;
const horizon = now + DAYS_AHEAD * 86400;
const groups = new Map();
for (const rec of data) {
  const l = rec && rec.lcs;
  if (!l) continue;
  const loc = l.location || {}, b = loc.begin || {}, c = l.closure || {};
  if (!ROUTES.has(b.beginRoute)) continue;
  if (!b.beginLatitude || hav(HOME.lat, HOME.lon, +b.beginLatitude, +b.beginLongitude) > RADIUS_MI) continue;
  if (flag(c, "code1098") || flag(c, "code1022")) continue; // completed or cancelled
  const ts = c.closureTimestamp || {};
  const start = +ts.closureStartEpoch, end = +ts.closureEndEpoch;
  if (!start || !end || end <= now || start > horizon) continue;

  // Nightly windows of the same job repeat as separate records — group them,
  // keep the soonest window, count the rest.
  const key = [c.closureID, b.beginRoute, loc.travelFlowDirection, b.beginLocationName].join("|");
  const item = {
    route: b.beginRoute,
    dir: loc.travelFlowDirection || "",
    at: b.beginLocationName || b.beginFreeFormDescription || "unnamed location",
    place: b.beginNearbyPlace || "",
    facility: c.facility || "",
    type: c.typeOfClosure || "",
    work: c.typeOfWork || "",
    lanes: c.lanesClosed || "",
    total: c.totalExistingLanes || "",
    startEpoch: start,
    endEpoch: end,
    moreWindows: 0,
  };
  const prev = groups.get(key);
  if (!prev) groups.set(key, item);
  else if (start < prev.startEpoch) { item.moreWindows = prev.moreWindows + 1; groups.set(key, item); }
  else prev.moreWindows++;
}

const closures = [...groups.values()].sort((a, b) => a.startEpoch - b.startEpoch).slice(0, 12);
console.log(`roads: ${closures.length} planned I-5/SR-14 closures within ${RADIUS_MI} mi, next ${DAYS_AHEAD} days.`);

let old = null;
try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
if (old && JSON.stringify(old.closures) === JSON.stringify(closures)) {
  console.log("No content change.");
  process.exit(0);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Planned Caltrans lane/ramp closures on I-5 and SR-14 near Tesoro Highlands, from the District 7 Lane Closure System (cwwp2.dot.ca.gov). Planned roadwork only — for live incidents use quickmap.dot.ca.gov.",
      closures,
    },
    null,
    2
  ) + "\n"
);
console.log("Wrote roads.json.");
