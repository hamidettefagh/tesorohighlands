# Tesoro Highlands — Community Hub

A neighbor-built hub for the **Tesoro Highlands community, Valencia CA 91354**. Lives at **tesorohighlands.com**.

The hub answers the questions a household in a fire-zone community actually asks — **Can the kids play outside? What are we breathing? Do we need to get ready to leave?** — and grows from there into everyday community info: local events, amenities, and HOA transparency.

## Pages

```
/            landing hub — live "right now" safety status + section cards
/fire        the full fire & emergency dashboard (live map, air, weather, evac, checklist)
/events      community events + auto-updated local Santa Clarita feed
/living      everyday local info (coming soon)
/hoa         HOA transparency (coming soon; unofficial, resident-run)
```

## Project layout

```
index.html / fire.html / events.html / living.html / hoa.html
th.css                shared design tokens (light/dark/manual) + shell styles
theme.js              theme boot — auto/light/dark, persisted, no flash (loads first in <head>)
nav.js                injected top nav + theme toggle + live status strip (5-min session cache)
icon.svg              favicon
events.json           auto-built local feed (see pipeline below) — do not edit by hand
community-events.json neighbor events, maintained via git (schema below)
vendor/leaflet/       self-hosted Leaflet 1.9.4 (no CDN dependency during an emergency)
scripts/fetch-events.mjs   feed builder (Node, no deps)
.github/workflows/refresh-events.yml   ~30-min cron that refreshes events.json
server.js             tiny static server for LOCAL dev only (clean URLs like Vercel)
vercel.json           static deploy config (headers, clean URLs)
sitemap.xml / robots.txt
```

## Run it locally

```
node server.js       # serves on http://localhost:3100 with /fire-style clean URLs
```

## What's live vs. curated

| Panel | Source | Status |
|---|---|---|
| Air quality (US AQI, PM2.5/PM10, hourly outlook) | Open-Meteo Air Quality API | **Live**, no key |
| Fire weather (wind, gusts, humidity, temp) | Open-Meteo Forecast API | **Live**, no key |
| Active alerts (Red Flag, Fire Weather, Heat) | NWS `api.weather.gov` | **Live**, no key |
| Nearby fires — list, map points & perimeters | NIFC/WFIGS ArcGIS (`WFIGS_Incident_Locations_Current`, `WFIGS_Interagency_Perimeters_Current`) | **Live**, no key |
| Evacuation zone status (Order / Warning) | Cal OES "California Active Evacuation Zones" ArcGIS | **Live**, no key |
| Local attendable events (audience-tagged, priced) | Eventbrite public city pages via GitHub Action | **Auto**, ~every 30 min |
| Community events | `community-events.json` in git | Curated |

The dashboard's status logic is deliberately conservative (small routine incidents don't turn the page red), and every live panel degrades honestly — a failed feed says "unavailable," never "all clear."

## The local events pipeline

`scripts/fetch-events.mjs` scans Eventbrite's public Santa Clarita search pages (embedded `__SERVER_DATA__` JSON), keeps only events at Santa Clarita Valley venues (Santa Clarita, Valencia, Newhall, Saugus, Canyon Country, Castaic, Stevenson Ranch), drops corporate training-mill spam, fetches each event page to extract the real price (`isFree` / `lowPrice`–`highPrice`), and tags every event by audience (toddlers / kids / teens / adults) with keyword rules. It writes `events.json` only when content changed. The GitHub Action runs it about every 30 minutes and commits the diff, which auto-deploys via Vercel. No backend, no keys.

Fragility note: this parses Eventbrite's page structure, which can change; the script fails soft (keeps the last good file) and the page shows a "feed may be stale" note past 24h.

### community-events.json schema

```json
[{ "title": "Ice-cream social", "date": "2026-07-12", "time": "4:00 PM", "place": "The park", "note": "BYO toppings", "url": "" }]
```

Past-dated entries drop off automatically; keeping history in the file is fine.

## Theming

Light/dark follows the visitor's system by default; the nav toggle (◐/☀/☾) forces light or dark, persisted per device in localStorage. Tokens live once in `th.css`; the map swaps to dark basemap tiles automatically.

## Neighbor knowledge

Some fire-safety content is adapted from guidance neighbors shared in the community group chat, credited in-app as local knowledge (not official) and kept anonymous.

## Not an official source

This is a community tool, not an emergency-warning system, and not the HOA. Always follow CAL FIRE, LA County Fire, and Sheriff evacuation orders. In an emergency call 911.
