// WeatherFlow / Tempest station proxy.
//
// Why this exists: the Tempest REST API needs a personal token and has no CORS
// for browsers. This fetches the neighbor station server-side and re-serves a
// trimmed outdoor snapshot (no station name that could identify the address).
//
// Cached at the CDN edge (~once per minute) regardless of how many neighbors open the page.
//
// Upstream shapes handled defensively:
// - Classic /observations/station/{id}: { obs: [ { timestamp, air_temperature, ... } ] }
// - Nested / alternate: stations[0].obs, or top-level current_conditions
// - TempestOne-style: { ob_fields: [...], obs: [ [v0, v1, ...] ] }

const LABEL = "Neighbor Tempest near Tesoro Highlands";
const MAX_AGE_SEC = 30 * 60;

function softFail(res, reason) {
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: "Tempest",
    ok: false,
    station: null,
    error: reason
  });
}

function pickLatestObs(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Named-object observations (classic station endpoint).
  if (Array.isArray(raw.obs) && raw.obs.length) {
    const first = raw.obs[0];
    if (first && typeof first === "object" && !Array.isArray(first)) return first;
    // Parallel-array form with ob_fields (TempestOne / stn endpoint).
    if (Array.isArray(first) && Array.isArray(raw.ob_fields)) {
      const obj = {};
      raw.ob_fields.forEach((key, i) => {
        obj[key] = first[i];
      });
      // timestamp is always present but sometimes omitted from ob_fields lists
      if (obj.timestamp == null && Number.isFinite(first[0])) obj.timestamp = first[0];
      return obj;
    }
  }

  if (raw.current_conditions && typeof raw.current_conditions === "object") {
    return raw.current_conditions;
  }

  if (Array.isArray(raw.stations) && raw.stations[0]) {
    return pickLatestObs(raw.stations[0]);
  }

  if (raw.station && typeof raw.station === "object") {
    return pickLatestObs(raw.station);
  }

  return null;
}

function num(...candidates) {
  for (const v of candidates) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function unitsOf(raw) {
  // Prefer response `units` (TempestOne /ob_fields payloads that honor units_* query).
  // Do NOT use station_units — that is the owner's display preference only; classic
  // /observations/station obs remain SI (°C, m/s) even when station_units say f/mph.
  if (raw && raw.units && typeof raw.units === "object") return raw.units;
  return { units_temp: "c", units_wind: "mps" };
}

function toTempF(value, units) {
  if (value == null) return null;
  const u = String(units.units_temp || units.temp || "").toLowerCase();
  if (u === "f" || u === "fahrenheit") return Math.round(value);
  // Classic / default: Celsius → Fahrenheit
  return Math.round((value * 9) / 5 + 32);
}

function toMph(value, units) {
  if (value == null) return null;
  const u = String(units.units_wind || units.wind || "").toLowerCase();
  if (u === "mph") return Math.round(value * 10) / 10;
  if (u === "kph" || u === "km/h") return Math.round(value * 0.621371 * 10) / 10;
  if (u === "kts" || u === "knots") return Math.round(value * 1.15078 * 10) / 10;
  // Classic / default: m/s → mph
  return Math.round(value * 2.23694 * 10) / 10;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    softFail(res, "method not allowed");
    return;
  }

  const token = process.env.TEMPEST_TOKEN;
  // Env-only, no default. tempestwx.com/station/<id> is a public page tied to a
  // neighbor's yard — not something to commit to a public repo.
  const stationIdRaw = process.env.TEMPEST_STATION_ID;
  const stationId = Number(stationIdRaw) || stationIdRaw;

  if (!token) {
    softFail(res, "TEMPEST_TOKEN not configured");
    return;
  }
  if (!stationIdRaw) {
    softFail(res, "TEMPEST_STATION_ID not configured");
    return;
  }

  try {
    const qs = new URLSearchParams({
      units_temp: "f",
      units_wind: "mph",
      units_pressure: "mb",
      units_distance: "mi"
    });
    const url =
      "https://swd.weatherflow.com/swd/rest/observations/station/" +
      encodeURIComponent(String(stationId)) +
      "?" +
      qs.toString();

    // Bearer header rather than ?token= — query strings get written to upstream
    // access logs and proxies verbatim. Same auth, one fewer place the secret lands.
    const upstream = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "User-Agent": "tesorohighlands.com (neighbor community site)"
      }
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);

    const raw = await upstream.json();
    const obs = pickLatestObs(raw);
    if (!obs) throw new Error("missing observation");

    const units = unitsOf(raw);
    const obsTime = num(obs.timestamp, obs.obs_time, obs.time, obs.epoch);
    if (obsTime == null) throw new Error("missing obs time");

    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - obsTime);
    if (ageSec > MAX_AGE_SEC) {
      softFail(res, "station observation stale");
      return;
    }

    const tempRaw = num(obs.air_temperature, obs.air_temp, obs.temp, obs.temperature);
    const rh = num(obs.relative_humidity, obs.rh, obs.humidity);
    const windRaw = num(obs.wind_avg, obs.wind_average, obs.wind);
    const gustRaw = num(obs.wind_gust, obs.gust);
    const wdir = num(obs.wind_direction, obs.wind_dir, obs.wdir);

    const tempF = toTempF(tempRaw, units);
    const windMph = toMph(windRaw, units);
    const gustMph = toMph(gustRaw, units);
    // Require at least one usable fire-weather measurement — ok:true with all
    // nulls would suppress Open-Meteo fallbacks on the home page.
    if (tempF == null && rh == null && windMph == null) {
      softFail(res, "station observation empty");
      return;
    }

    // Generic label only — never return upstream station name or numeric id
    // (public map lookups can identify a home).
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      source: "Tempest",
      ok: true,
      station: {
        label: LABEL,
        tempF: tempF,
        rh: rh,
        windMph: windMph,
        gustMph: gustMph,
        wdir: wdir,
        obsTime: obsTime,
        ageSec: ageSec
      }
    });
  } catch (e) {
    // Non-fatal by design: the page can hide the weather card.
    softFail(res, "Tempest feed unavailable");
  }
};
