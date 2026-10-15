// SCE power status for the houses behind the gate. One copy of "which shutoff is
// ours", shared by api/power.js (the site, live) and scripts/alert-watch.mjs (the
// WhatsApp alert bot), so the two can never disagree about our power.
//
// The data is what SCE's own outage map reads (sce.com/outagemap). Those ArcGIS
// layers aren't a published API: they can change without notice and briefly
// come back empty while SCE refreshes them, so callers treat a failed read as
// "unknown", never as "the power is on".

const PSPS = "https://sce-outage-ags.esriemcs.com/arcgis/rest/services/43/psps/MapServer"; // 0 under consideration, 1 shut off
const OUTAGES = "https://sce-outage-ags.esriemcs.com/arcgis/rest/services/43/outage/MapServer/0"; // repair outages (points)
// What SCE called our circuit in Oct 2026; named in messages when SCE's data doesn't name one.
const OUR_CIRCUIT = "Orion";
// One point per street behind the gate (street centres from api/_treat-homes.js).
// A shutoff is ours when SCE's area covers any of them: by place, not by name,
// so a renamed circuit still counts and a far-off section of Orion doesn't.
const STREETS = [[-118.5581,34.4878],[-118.5573,34.4878],[-118.559,34.4876],[-118.5627,34.487],[-118.5588,34.487],[-118.5565,34.487],
  [-118.5578,34.4869],[-118.5624,34.4865],[-118.5596,34.4863],[-118.5584,34.4861],[-118.5578,34.4858],[-118.5607,34.4856],[-118.559,34.4853],
  [-118.5592,34.4845],[-118.561,34.4843],[-118.5623,34.4841],[-118.5673,34.484],[-118.5707,34.484],[-118.5632,34.4837],[-118.5674,34.4837],
  [-118.5657,34.4834],[-118.569,34.4834],[-118.5581,34.4833],[-118.5608,34.4833],[-118.5634,34.4828],[-118.5686,34.4827]];
const MID = { lat: 34.4845, lon: -118.564 };   // middle of those houses
const ENVELOPE = "-118.5727,34.4807,-118.5545,34.4898";   // the streets above, padded ~200 m

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
// Even-odd ray cast across all rings (holes included).
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
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

// ArcGIS features ({layer, a: attributes, rings}) -> records with how many of our
// streets each one covers, and how far its nearest edge is from the middle of them.
function pspsRecords(feats) {
  return feats.map(({ layer, a, rings }) => {
    let dist = Infinity, at = null;
    for (const g of rings) for (const p of g) {
      const d = haversine(MID.lat, MID.lon, p[1], p[0]);
      if (d < dist) { dist = d; at = p; }
    }
    return { layer, name: titleCase(a.CIRCUIT_NAME), status: [a.PSPS, a.PSPS_Details].filter(Boolean).join(" "),
      start: a.StartDate, end: a.EndDate, ert: a.ERT, offSince: a.DateDeEnergized || null, edited: a.EditDate || null, dist,
      covers: STREETS.filter(([x, y]) => inPoly(x, y, rings)).length,
      dir: at ? bearingWord(MID.lat, MID.lon, at[1], at[0]) : "" };
  });
}

// SCE's steps: Monitored → De-Energization Expected → De-Energized →
// Re-Energization Expected → Re-Energized. Anything else ("Downstream": off
// because a circuit feeding it is) goes with the layer it sits on.
function pspsStage(r) {
  const s = r.status;
  if (/re-?energi[sz]ation expected/i.test(s)) return "restoring";
  if (/re-?energi[sz]ed/i.test(s)) return "restored";
  if (/de-?energi[sz]ation expected/i.test(s)) return "expected";
  if (/de-?energi[sz]ed/i.test(s)) return "off";
  if (/monitor/i.test(s)) return "watch";
  return r.layer === 1 ? "off" : "watch";
}
const STAGE_RANK = { off: 5, restoring: 4, expected: 3, watch: 2, restored: 1 };

// The records that cover our streets, worst step first.
function ourRecords(recs) {
  return recs.filter((r) => r.covers > 0).sort((x, y) => STAGE_RANK[pspsStage(y)] - STAGE_RANK[pspsStage(x)]);
}

module.exports = { PSPS, OUTAGES, OUR_CIRCUIT, STREETS, MID, ENVELOPE, haversine, bearingWord, inPoly, titleCase,
  pspsRecords, pspsStage, ourRecords, STAGE_RANK };
