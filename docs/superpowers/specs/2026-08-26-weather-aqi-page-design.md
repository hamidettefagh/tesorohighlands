# Tesoro Highlands — Weather & AQI page

**Date:** 2026-08-26  
**Status:** approved for implementation planning  
**Goal:** A dedicated, easy-to-scan backyard weather and air page from the neighbor Tempest and PurpleAir stations. Not a fire/emergency dashboard.

## Problem

Air and weather already appear on Home glances and `/fire`, mixed with fires, evac, alerts, and maps. Neighbors need a calm everyday check: temperature, air quality, the next hours, and the week, from the two backyard sensors.

## Audience and job

A household in Tesoro Highlands opening the site to decide if it is nice to be outside. Five-second glance, then optional scroll. Fire weather, evacuation, and official alerts stay on `/fire`.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Job | Everyday outdoor check (not fire-weather framing) |
| Sources | Neighbor PurpleAir + Tempest only on this page (no Open-Meteo) |
| Forecast | WeatherFlow Better Forecast for the same Tempest station |
| History | PurpleAir AQI sparkline ~24h (required). No extra Tempest device-history API in v1. |
| Forecast depth | Full Better Forecast useful fields: hourly, up to 10-day, UV, precip, feels-like |
| Layout | One long page, nothing collapsed: now → hourly → 10-day → extras |
| Nav | Top-nav **Weather** → `/weather` |
| Architecture | New page + keep `/api/purpleair` + add `/api/tempest-forecast`; Fire keeps `/api/tempest` |
| AQI number | **US EPA-corrected** headline on Weather; Fire stays **C0 / raw** |
| Failures | Per-block “unavailable”; never invent numbers or imply all-clear |

Community UIs this copies: Tempest PiConsole / Halcyon / official Better Forecast hierarchy; Paku / AirNow / Apple AQI glance; Apple/Pixel hourly strip + 10-day rows. Equal-size temp + AQI heroes are the smoke-country kiosk pattern (Halcyon), which fits this neighborhood.

## Page layout (`weather.html`)

Same shell as other pages: `th.css`, `theme.js`, `nav.js`, skip link, `<main id="main">`, neighbor disclaimer footer.

**1. Right now (two peer cards)**

- **Tempest:** condition icon + large temperature (°F) + feels-like + short condition text. Small type: today’s high/low when the daily forecast is present. Chip row (smaller than the temp): wind average, gust, direction arrow (wind going toward), humidity, UV with WHO-style UV colors.
- **PurpleAir:** large **US AQI** + category **word** + EPA color on the **card chrome**, not a full-page wash. PM2.5 µg/m³ secondary. One EPA “who should care” line. Sparkline last ~24h, AQI-colored. “Updated X min ago.” Label conversion once: “US AQI (EPA-corrected).” No conversion picker.

Do not use AQI hues for the temperature number. Always pair AQI number + category word.

**2. Next hours**

Horizontal strip, ~24h (scroll on small screens). Per hour: time, icon, temp, precip probability. Do not default every extra series (wind/UV/AQI) onto every column. Optional extra fields may appear as small type if they stay scannable.

**3. 10-day**

One row per day: weekday, icon, precip %, low/high, wind. Range bar for low–high if it stays readable in the existing card style. No per-day AQI, humidity, or UV columns.

**4. Extra stats + sparklines (always visible, never as large as the hero)**

Equal-weight tiles, much smaller type than temp/AQI: pressure + trend, precip today, dew point, brightness/solar if present. Hide lightning and “rain drama” unless precip is actually occurring or forecast soon.

**Tempest history sparkline:** Better Forecast is current + future only. Do not call extra WeatherFlow device-history APIs in v1 (they need a device id and add identity surface). Omit a Tempest past-temp sparkline unless it can be built from data already in this payload. The required sparkline is PurpleAir AQI history.

**Privacy copy:** generic “near Tesoro Highlands” only. No station name, numeric station id, sensor index, lat/lon.

**Disclaimer:** same neighbor-project line as the rest of the site.

## Site integration

- **Nav:** `{ href: "/weather", label: "Weather" }` after Fire. Mark current on `/weather`. `nav.js` cache-bust query (`?v=N`) bumped when nav changes.
- **Home:** new hub card to `/weather`. **Air today** glance `href="/weather"`. **Fire weather** glance stays `/fire`.
- **Fire:** unchanged air/weather behavior (C0 AQI, Tempest observations, Open-Meteo fallbacks). One quiet text link to `/weather` (“Full backyard weather”).
- **Also:** `sitemap.xml`, `404.html` link, `README.md` pages list and sources table, `updates.json` neighbor-facing line (newest first).
- **`server.js`:** clean URLs already map `/weather` → `weather.html`.
- **`vercel.json`:** no special case required if `api/*.js` is already deployed as serverless (same as purpleair/tempest/calfire).

## APIs

### Shared rules

- `GET`/`HEAD` only; other methods → existing soft-fail shape.
- `Access-Control-Allow-Origin: *`
- `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
- HTTP **200** with `ok: false` on miss (CDN-cacheable, page hides/softens the block).
- Never log tokens or full URLs that embed `token=`.
- Never echo upstream names, coordinates, station ids, or sensor indexes.

### `/api/purpleair` (extend, do not split)

Keep today’s C0 path so **Fire does not change**:

- Prefer `pm2.5_10minute` (including `sensor.stats`), else `pm2.5_cf_1`.
- `primary.aqi` remains **C0** (raw PM2.5 → existing 2024 EPA PM2.5 breakpoints). `conversion: "C0"` stays.

Add EPA-corrected fields for Weather (same response, one cache):

- Input PM2.5: **CF=1** (`pm2.5_cf_1` or 60-minute CF=1 from stats/history when present). Headline prefers **60-minute** average when available; otherwise 10-minute and the page labels the window.
- Humidity: PurpleAir `humidity` as reported (percent, e.g. `24.7` not `0.247`).
- **Correction (v1):** AirNow Fire and Smoke Map US-wide piecewise on CF=1 `x` (µg/m³), then clamp corrected PM2.5 to ≥ 0, then the same `aqiFromPm25` breakpoints already in this file:

  - `x < 50`: `0.52 * x - 0.086 * RH + 5.75`
  - `50 ≤ x < 229`: `0.786 * x - 0.086 * RH + 5.75`
  - `x ≥ 229`: `0.69 * x + 8.84e-4 * x² + 2.97`

  If RH is missing, skip EPA fields (`aqiEpa: null`) rather than guessing RH. Do not show negative AQI; clamp index to 0–500.

- `primary.aqiEpa`, `primary.pm25Epa`, `primary.epaAverageMin` (`60` or `10`).
- **History:** last ~24h of samples (10-minute) via PurpleAir history endpoint, each point EPA-corrected, returned as `{ t, aqi }[]` with Unix seconds only (no coordinates). If history fails, `history: null` and the page omits the sparkline.

Indoor / stale / low-confidence rules stay as today (`ok: false`).

### `/api/tempest-forecast` (new)

- Upstream: `GET https://swd.weatherflow.com/swd/rest/better_forecast` with `station_id` (`TEMPEST_STATION_ID` or `227733`), `token` (`TEMPEST_TOKEN`), units `f` / `mph` / `mb` / `in` / `mi`.
- Strip: `latitude`, `longitude`, `location_name`, station ids, any nested station metadata.
- Return a trimmed object, for example:

  - `ok`, `generatedAt`, `source: "Tempest"`
  - `current`: tempF, feelsLikeF, conditions, icon, rh, windMph, gustMph, wdir, uv, precipIn, precipTodayIn, pressureMb, pressureTrend, dewpointF, brightness, obsTime, ageSec
  - `hourly`: array (~24–48h): time, icon, conditions, tempF, feelsLikeF, precipProbability, precipIn, windMph, uv
  - `daily`: array (up to 10): dayStart, icon, conditions, tempHighF, tempLowF, precipProbability, windMph, sunrise, sunset

- Stale current (same 30-minute window as `/api/tempest` observations): `ok: false` for the whole payload if current conditions are stale; do not serve a fresh-looking forecast glued to a dead station.
- If Better Forecast returns current but empty daily/hourly, `ok: true` with those arrays empty; the page shows now and unavailable on the forecast bands.
- Fire continues to call **`/api/tempest`** (observations). Do not expand that handler into the full forecast.

### Browser

`weather.html` `Promise.allSettled` fetches `/api/purpleair` and `/api/tempest-forecast` in parallel. Uses `aqiEpa` only for the hero. Does not call Open-Meteo, AirNow, or NWS on this page.

Local `node server.js` does not run Vercel `api/` functions (same as today). API behavior is verified on a Vercel preview (or equivalent) with `PURPLEAIR_API_KEY` and `TEMPEST_TOKEN`.

## Error and empty states

- Independent blocks: Tempest down still shows AQI; PurpleAir down still shows weather.
- Copy: **unavailable**, plus last-tried time if known. Never “all clear.”
- Inside age windows: show values + “updated X min ago.” Past window: unavailable.
- Forecast arrays empty: hide hourly/10-day with unavailable; keep current if present.
- History null: AQI number without sparkline.
- Missing env keys: `ok: false`, HTTP 200.

## Out of scope (v1)

Radar, maps, lightning as a default tile, station health (battery, RSSI, firmware), conversion picker, Open-Meteo on `/weather`, live websocket, indoor sensors, changing Fire to EPA AQI, Grafana/HA, CARROT-style series pickers, exposing sensor/station identifiers.

## Verification

- `/weather` loads locally; Weather is current in nav; skip link and theme work.
- With keys: purpleair JSON still has C0 `primary.aqi`; EPA fields + history present; tempest-forecast JSON has current/hourly/daily and **no** lat/lon/name/id.
- Without keys: both `ok: false`.
- One feed failed: that block unavailable, the other renders.
- Fire still C0; Home Air today links to `/weather`.
- Desktop + ~390px width: one long scroll; hourly strip scrolls sideways.

## Implementation notes

- Plain HTML/CSS/JS, no build step, match existing card/token patterns in `th.css` (AQI category colors already exist).
- Escape any upstream condition strings before `innerHTML` (same rule as fire names).
- Bump `nav.js?v=` on every page that includes it when nav changes.
- Do not treat this page as an official warning system in copy or in the status strip behavior.
