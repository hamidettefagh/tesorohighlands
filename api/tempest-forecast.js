// WeatherFlow / Tempest Better Forecast proxy.
//
// Fetches neighbor-station forecast server-side (token has no browser CORS).
// Returns trimmed current + hourly + daily without station identity or coordinates.

const MAX_AGE_SEC = 30 * 60;

function softFail(res, reason) {
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: "Tempest",
    ok: false,
    currentStale: false,
    current: null,
    hourly: null,
    daily: null,
    error: reason
  });
}

function num(...candidates) {
  for (const v of candidates) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function roundTemp(value) {
  const n = num(value);
  if (n == null) return null;
  return Math.round(n);
}

function roundWind(value) {
  const n = num(value);
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

function addNum(obj, key, value, rounder) {
  const n = rounder ? rounder(value) : num(value);
  if (n != null) obj[key] = n;
}

function mapCurrent(cc, isOnline) {
  if (!cc || typeof cc !== "object") return { current: null, currentStale: true };

  const obsTime = num(cc.time);
  if (obsTime == null) return { current: null, currentStale: true };

  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - obsTime);
  const stale = !isOnline || ageSec > MAX_AGE_SEC;
  if (stale) return { current: null, currentStale: true };

  const current = {};

  if (cc.conditions != null) current.conditions = String(cc.conditions);
  if (cc.icon != null) current.icon = String(cc.icon);

  addNum(current, "tempF", cc.air_temperature, roundTemp);
  addNum(current, "feelsLikeF", cc.feels_like, roundTemp);
  addNum(current, "rh", cc.relative_humidity);
  addNum(current, "windMph", cc.wind_avg, roundWind);
  addNum(current, "gustMph", cc.wind_gust, roundWind);
  addNum(current, "wdir", cc.wind_direction);
  addNum(current, "uv", cc.uv);
  addNum(current, "pressureMb", cc.sea_level_pressure);
  addNum(current, "dewpointF", cc.dew_point, roundTemp);

  const precipMinutes = num(cc.precip_minutes_local_day);
  if (precipMinutes != null) current.precipMinutesToday = Math.floor(precipMinutes);

  if (!cc.is_precip_local_day_rain_check) {
    addNum(current, "precipTodayIn", cc.precip_accum_local_day);
  }

  if (cc.pressure_trend != null) {
    const trend = String(cc.pressure_trend).toLowerCase();
    if (trend === "rising" || trend === "falling" || trend === "steady") {
      current.pressureTrend = trend;
    } else {
      current.pressureTrend = "unknown";
    }
  }

  current.obsTime = obsTime;
  current.ageSec = ageSec;

  return { current, currentStale: false };
}

function mapHourly(items) {
  if (!Array.isArray(items)) return [];
  return items.map((h) => {
    const row = {};
    addNum(row, "time", h.time);
    if (h.icon != null) row.icon = String(h.icon);
    if (h.conditions != null) row.conditions = String(h.conditions);
    addNum(row, "tempF", h.air_temperature, roundTemp);
    addNum(row, "feelsLikeF", h.feels_like, roundTemp);
    if (h.precip_probability != null) {
      addNum(row, "precipProbability", h.precip_probability);
    } else {
      row.precipProbability = null;
    }
    addNum(row, "precipIn", h.precip);
    addNum(row, "windMph", h.wind_avg, roundWind);
    addNum(row, "uv", h.uv);
    return row;
  });
}

function mapDaily(items) {
  if (!Array.isArray(items)) return [];
  return items.map((d) => {
    const row = {};
    addNum(row, "dayStart", d.day_start_local);
    if (d.icon != null) row.icon = String(d.icon);
    if (d.conditions != null) row.conditions = String(d.conditions);
    addNum(row, "tempHighF", d.air_temp_high, roundTemp);
    addNum(row, "tempLowF", d.air_temp_low, roundTemp);
    if (d.precip_probability != null) {
      addNum(row, "precipProbability", d.precip_probability);
    } else {
      row.precipProbability = null;
    }
    addNum(row, "sunrise", d.sunrise);
    addNum(row, "sunset", d.sunset);
    return row;
  });
}

function mapForecast(raw) {
  const generatedAt = new Date().toISOString();

  if (Number(raw && raw.status && raw.status.status_code) !== 0) {
    return {
      ok: false,
      generatedAt,
      source: "Tempest",
      currentStale: false,
      current: null,
      hourly: null,
      daily: null,
      error: "upstream status"
    };
  }

  const forecast =
    raw.forecast != null && typeof raw.forecast === "object" && !Array.isArray(raw.forecast)
      ? raw.forecast
      : null;
  if (!forecast) {
    return {
      ok: false,
      generatedAt,
      source: "Tempest",
      currentStale: false,
      current: null,
      hourly: null,
      daily: null,
      error: "missing forecast"
    };
  }

  const station = raw.station && typeof raw.station === "object" ? raw.station : null;
  const isOnline = station == null || station.is_station_online !== false;

  const cc = raw.current_conditions;
  const { current, currentStale } = mapCurrent(cc, isOnline);

  const hourly = mapHourly(forecast.hourly);
  const daily = mapDaily(forecast.daily);

  return {
    ok: true,
    generatedAt,
    source: "Tempest",
    currentStale,
    current,
    hourly,
    daily
  };
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    softFail(res, "method not allowed");
    return;
  }

  const token = process.env.TEMPEST_TOKEN;
  // Env-only, no default — tempestwx.com/station/<id> is a public page tied to a
  // neighbor's yard. Same rule as api/tempest.js.
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
      station_id: String(stationId),
      units_temp: "f",
      units_wind: "mph",
      units_pressure: "mb",
      units_precip: "in",
      units_distance: "mi"
    });
    const url = "https://swd.weatherflow.com/swd/rest/better_forecast?" + qs.toString();

    // Bearer header, not ?token= — same rule as api/tempest.js: query strings get
    // written to upstream access logs and proxies verbatim.
    const upstream = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "User-Agent": "tesorohighlands.com (neighbor community site)"
      }
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);

    const raw = await upstream.json();
    const out = mapForecast(raw);
    res.status(200).json(out);
  } catch (e) {
    softFail(res, "Tempest feed unavailable");
  }
}

module.exports = handler;
module.exports.mapForecast = mapForecast;
