// PurpleAir sensor proxy.
//
// Why this exists: PurpleAir requires an API key and blocks browser CORS, so the
// neighbor page cannot call it directly. This fetches one outdoor sensor
// server-side and re-serves a privacy-trimmed AQI snapshot.
//
// Conversion / averaging notes (matches the owner's widget):
// - PM2.5 field preference: pm2.5_10minute, fallback pm2.5_cf_1
// - Conversion: raw / none ("C0") — no US EPA or ALT correction applied
// - AQI: US EPA NowCast-style breakpoints on that PM2.5 value (10-minute average)
//
// Cached at the CDN edge (~once per minute) regardless of how many neighbors open the page.

const { correctAtmPm25, aqiFromPm25 } = require("./_epa.js");

const LABEL = "Neighbor PurpleAir near Tesoro Highlands";
const MAX_AGE_SEC = 45 * 60;
const DEFAULT_INDEX = "304092";
const MIN_CONFIDENCE = 70;

function softFail(res, reason) {
  // 200 + ok:false so the CDN can cache the miss briefly and browsers don't
  // treat a soft feed failure as a hard HTTP error.
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: "PurpleAir",
    ok: false,
    primary: null,
    peers: null,
    error: reason
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    softFail(res, "method not allowed");
    return;
  }

  const apiKey = process.env.PURPLEAIR_API_KEY;
  const indexRaw = process.env.PURPLEAIR_SENSOR_INDEX || DEFAULT_INDEX;
  const index = Number(indexRaw) || indexRaw;

  if (!apiKey) {
    softFail(res, "PURPLEAIR_API_KEY not configured");
    return;
  }

  try {
    const fields = [
      "location_type",
      "last_seen",
      "humidity",
      "temperature",
      "pm2.5_10minute",
      "pm2.5_60minute",
      "pm2.5_cf_1",
      "confidence"
    ].join(",");
    const url = "https://api.purpleair.com/v1/sensors/" + encodeURIComponent(String(index)) + "?fields=" + encodeURIComponent(fields);

    const upstream = await fetch(url, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        "User-Agent": "tesorohighlands.com (neighbor community site)"
      }
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);

    const raw = await upstream.json();
    const sensor = raw && (raw.sensor || raw.data || raw);
    if (!sensor || typeof sensor !== "object") throw new Error("missing sensor payload");

    // location_type: 0 = outside, 1 = inside
    if (Number(sensor.location_type) === 1) {
      softFail(res, "sensor is indoor");
      return;
    }

    const lastSeen = Number(sensor.last_seen);
    if (!Number.isFinite(lastSeen)) throw new Error("missing last_seen");
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - lastSeen);
    if (ageSec > MAX_AGE_SEC) {
      softFail(res, "sensor reading stale");
      return;
    }

    const confidence = sensor.confidence != null ? Number(sensor.confidence) : null;
    if (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) {
      softFail(res, "sensor confidence too low");
      return;
    }

    // Prefer 10-minute average (widget average=10). PurpleAir often nests it under
    // sensor.stats when pm2.5_10minute is requested, not at the top level.
    // Fall back to CF=1 (raw). C0 = no correction (owner widget).
    const stats = sensor.stats && typeof sensor.stats === "object" ? sensor.stats : {};
    let pm25 = stats["pm2.5_10minute"];
    let averageMin = 10;
    if (pm25 == null || !Number.isFinite(Number(pm25))) {
      pm25 = sensor["pm2.5_10minute"];
    }
    if (pm25 == null || !Number.isFinite(Number(pm25))) {
      pm25 = sensor["pm2.5_cf_1"];
      averageMin = null;
    }
    pm25 = Number(pm25);
    if (!Number.isFinite(pm25)) throw new Error("missing pm2.5");

    const aqi = aqiFromPm25(pm25);
    if (aqi == null) throw new Error("aqi unavailable");

    const humidity = sensor.humidity != null ? Number(sensor.humidity) : null;

    const pm60raw = stats["pm2.5_60minute"] != null ? stats["pm2.5_60minute"] : sensor["pm2.5_60minute"];
    const pm60 = pm60raw != null ? Number(pm60raw) : null;
    const yEpa = pm60 != null && Number.isFinite(pm60) ? correctAtmPm25(pm60, humidity) : null;
    const aqiEpa = yEpa == null ? null : aqiFromPm25(yEpa);
    const pm25Epa = yEpa == null ? null : Math.round(yEpa * 10) / 10;

    // Never echo upstream sensor.name / lat / lon / index — those can identify a home.
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      source: "PurpleAir",
      ok: true,
      primary: {
        label: LABEL,
        aqi: aqi,
        pm25: Math.round(pm25 * 10) / 10,
        humidity: Number.isFinite(humidity) ? humidity : null,
        confidence: Number.isFinite(confidence) ? confidence : null,
        lastSeen: lastSeen,
        ageSec: ageSec,
        conversion: "C0",
        averageMin: averageMin,
        aqiEpa: aqiEpa,
        pm25Epa: pm25Epa,
        epaAverageMin: aqiEpa != null ? 60 : null,
        epaConversion: aqiEpa != null ? "EPA-2021-ATM-5seg" : null
      },
      peers: null
    });
  } catch (e) {
    // Non-fatal by design: the page can hide the AQI card.
    softFail(res, "PurpleAir feed unavailable");
  }
};
