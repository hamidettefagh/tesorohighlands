// 24-hour PurpleAir history for the /weather sparkline, served on demand.
//
// Why this exists: the same data is also written to purpleair-history.json by an
// hourly GitHub Action, but GitHub's free-tier scheduler routinely skips slots —
// on 2026-09-05 it missed four in a row and the graph sat six hours behind under
// a caption saying so. This endpoint fetches the history when someone actually
// opens the page and caches it at the edge for an hour, so freshness no longer
// depends on a cron firing. The committed file stays as the fallback.
//
// Cost: at most one upstream call per hour per edge region, whatever the traffic.
// Same EPA correction as everything else (api/_epa.js), applied per hourly row
// with that hour's humidity; rows without humidity are dropped, never served raw.

const { correctAtmPm25, aqiFromPm25 } = require("./_epa.js");

const FIELDS = "pm2.5_atm,humidity";

// Shared with scripts/purpleair-history-parse.mjs so the cron and the endpoint
// cannot drift apart.
function rowsFromHistoryPayload(raw) {
  const fields = raw && raw.fields;
  const data = raw && raw.data;
  if (!Array.isArray(fields) || !Array.isArray(data)) return [];
  const ti = fields.indexOf("time_stamp");
  const pi = fields.indexOf("pm2.5_atm");
  const hi = fields.indexOf("humidity");
  if (ti < 0 || pi < 0 || hi < 0) return [];
  const rows = [];
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[ti]);
    const pmRaw = row[pi];
    const rhRaw = row[hi];
    if (pmRaw == null || rhRaw == null) continue;
    const y = correctAtmPm25(pmRaw, rhRaw);
    const aqi = y == null ? null : aqiFromPm25(y);
    if (!Number.isFinite(t) || aqi == null) continue;
    rows.push({ t, aqi });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

function softFail(res, reason) {
  // A miss must not pin the edge for an hour — cache it briefly instead.
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({ generatedAt: new Date().toISOString(), source: "PurpleAir", ok: false, history: [], error: reason });
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=3600");

  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    softFail(res, "method not allowed");
    return;
  }
  const apiKey = process.env.PURPLEAIR_API_KEY;
  const index = process.env.PURPLEAIR_SENSOR_INDEX;
  if (!apiKey) { softFail(res, "PURPLEAIR_API_KEY not configured"); return; }
  if (!index) { softFail(res, "PURPLEAIR_SENSOR_INDEX not configured"); return; }

  try {
    const now = Math.floor(Date.now() / 1000);
    const url =
      "https://api.purpleair.com/v1/sensors/" + encodeURIComponent(String(index)) +
      "/history?average=60&fields=" + encodeURIComponent(FIELDS) +
      "&start_timestamp=" + (now - 86400) + "&end_timestamp=" + now;
    const upstream = await fetch(url, {
      headers: { "X-API-Key": apiKey, Accept: "application/json", "User-Agent": "tesorohighlands.com (neighbor community site)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);
    const history = rowsFromHistoryPayload(await upstream.json());
    if (!history.length) { softFail(res, "no usable rows"); return; }
    // Never echo the sensor index or anything that could place a home.
    res.status(200).json({ generatedAt: new Date().toISOString(), source: "PurpleAir", ok: true, history });
  } catch (e) {
    softFail(res, "PurpleAir history unavailable");
  }
}

module.exports = handler;
module.exports.rowsFromHistoryPayload = rowsFromHistoryPayload;
