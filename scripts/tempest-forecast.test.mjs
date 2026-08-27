import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { mapForecast } = require("../api/tempest-forecast.js");

const raw = {
  status: { status_code: 0 },
  latitude: 34.47,
  longitude: -118.53,
  location_name: "SECRET HOUSE",
  station: { station_id: 227733, is_station_online: true, elevation: 400 },
  current_conditions: {
    time: Math.floor(Date.now() / 1000) - 60,
    air_temperature: 78,
    feels_like: 76,
    conditions: "Partly Cloudy",
    icon: "partly-cloudy-day",
    relative_humidity: 28,
    wind_avg: 6,
    wind_gust: 11,
    wind_direction: 315,
    wind_direction_icon: "wind-rose-nw",
    uv: 8,
    precip_accum_local_day: 0,
    precip_minutes_local_day: 0,
    sea_level_pressure: 1012,
    pressure_trend: "steady",
    dew_point: 42
  },
  forecast: {
    hourly: [
      {
        time: Math.floor(Date.now() / 1000) + 3600,
        icon: "clear-day",
        conditions: "Clear",
        air_temperature: 80,
        feels_like: 78,
        precip_probability: 5,
        precip: 0,
        wind_avg: 7,
        uv: 7
      }
    ],
    daily: [
      {
        day_start_local: 1700000000,
        icon: "clear-day",
        conditions: "Clear",
        air_temp_high: 84,
        air_temp_low: 62,
        precip_probability: 10,
        sunrise: 1700001000,
        sunset: 1700040000
      }
    ]
  }
};

const out = mapForecast(raw);
if (out.ok !== true) throw new Error("ok");
if (out.currentStale !== false) throw new Error("stale");
if (out.latitude || out.station || (out.current && out.current.precipIn != null)) throw new Error("leaked");
if (JSON.stringify(out).includes("SECRET") || JSON.stringify(out).includes("227733")) throw new Error("pii");
if (out.current.icon === "wind-rose-nw") throw new Error("wind rose");
if (out.current.wdir !== 315) throw new Error("wdir");
if (out.hourly[0].precipProbability !== 5) throw new Error("pop");
if (out.daily[0].dayStart !== 1700000000) throw new Error("dayStart");
if (out.daily[0].windMph != null) throw new Error("no daily wind");

const staleRaw = JSON.parse(JSON.stringify(raw));
staleRaw.current_conditions.time = Math.floor(Date.now() / 1000) - 4000;
const stale = mapForecast(staleRaw);
if (stale.current !== null || stale.currentStale !== true) throw new Error("stale current");
if (!stale.hourly.length) throw new Error("keep hourly");

const bad = mapForecast({ status: { status_code: 1 }, forecast: { hourly: [], daily: [] } });
if (bad.ok !== false) throw new Error("status");

const noForecast = mapForecast({
  status: { status_code: 0 },
  current_conditions: raw.current_conditions,
  station: { is_station_online: true }
});
if (noForecast.ok !== false) throw new Error("missing forecast ok");
if (noForecast.current !== null || noForecast.hourly !== null || noForecast.daily !== null) {
  throw new Error("missing forecast nulls");
}

const emptyForecast = mapForecast({
  status: { status_code: 0 },
  current_conditions: raw.current_conditions,
  forecast: { hourly: [], daily: [] }
});
if (emptyForecast.ok !== true) throw new Error("empty forecast arrays");

console.log("tempest-forecast.test.mjs ok");
