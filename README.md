# Tesoro Highlands — Fire & Air Watch

A hyper-local wildfire, air-quality, and evacuation-readiness page for the **Tesoro Highlands community, Valencia CA 91354**. Lives at **tesorohighlands.com**.

The pitch: Watch Duty gives you a great regional incident map and makes *you* interpret it. This flips it around and answers the three questions a household in a fire zone actually asks —

- **Can the kids play outside?** (air quality + fire weather, judged for children)
- **What are we breathing?** (live US AQI + PM2.5/PM10 + an hourly outlook)
- **Do we need to get ready to leave?** (evacuation guidance + a saved go-bag checklist)

It also surfaces **fire weather** (wind, gusts, humidity, Santa Ana direction) — the danger signal that shows up *before* a fire starts — and a **live nearby-fire radar** listing active incidents with their real distance and direction from Tesoro Highlands.

## Project layout

```
index.html      the whole app — one self-contained file (inline CSS + JS, no build)
icon.svg        favicon
server.js       tiny zero-dep static server for LOCAL dev only (not deployed)
vercel.json     static deploy config (headers, clean URLs)
.vercelignore   keeps server.js out of the deploy
```

## Run it locally

```
node server.js       # serves on http://localhost:3100
```

Or just open `index.html` directly in a browser — it's a single self-contained file and the data APIs allow cross-origin requests, so `file://` works too.

## Deploy (Vercel + DNS)

The site is 100% static (all data is fetched client-side from public APIs — no backend, no secrets), so any static host works. To match the hamidettefagh.com setup:

1. **Push to GitHub** (done — public repo `hamidettefagh/tesorohighlands`).
2. **Vercel** → New Project → Import that repo. Framework preset: **Other** (no build command, output = repo root). Deploy.
3. **Domain** → in the Vercel project, Settings → Domains → add `tesorohighlands.com` (and `www`). Vercel shows the exact DNS records.
4. **DNS** → at wherever `tesorohighlands.com` is registered, add Vercel's records (typically an `A` record `76.76.21.21` for the apex and a `CNAME` to `cname.vercel-dns.com` for `www`), or point the nameservers to Vercel.

No `ANTHROPIC_API_KEY` or other env vars are needed (unlike the portfolio's `/api/ask`).

## What's live vs. demo

| Panel | Source | Status |
|---|---|---|
| Air quality (US AQI, PM2.5/PM10, hourly outlook) | Open-Meteo Air Quality API | **Live**, no API key |
| Fire weather (wind, gusts, humidity, temp) | Open-Meteo Forecast API | **Live**, no API key |
| Active alerts (Red Flag, Fire Weather, Heat) | NWS `api.weather.gov` | **Live**, no API key |
| Nearby fire incidents (distance + direction) | NIFC/IRWIN via ArcGIS `USA_Wildfires_v1` | **Live**, no API key |
| Evacuation status | — | **Not monitored** (directs to Genasys / Watch Duty) |

The evacuation panel does **not** fake an "all clear" — there's no clean free feed for evacuation zones, so it honestly says it isn't monitored and points to official sources. Two demo scenarios (**Red Flag day**, **Fire near you**) preview the stressed UI; only "Fire near you" swaps in demo incidents — "Red Flag day" and the live view show the *real* nearby fires.

### A note on the fire feed
CAL FIRE's own feed (`incidents.fire.ca.gov`) has richer California detail but sends no CORS header, so a browser can't read it directly. The app uses the national **NIFC/IRWIN** wildfire feed via ArcGIS, which is CORS-open. Its acreage is often blank for brand-new incidents (shown as "size not yet reported"), but distance and direction are always accurate. LA-County dispatch-number noise (`LAC-#####`) is filtered out, and risk escalation is deliberately conservative so routine small fires don't cry wolf.

## Neighbor knowledge

Some content is adapted from fire-safety guidance neighbors shared in the community group chat, credited in-app as local knowledge (not official) and kept anonymous:

- **"When it's smoky — the playbook"** — the indoor-air protocol (seal the house, AC on recirculate + fan on, purifiers, no indoor smoke, N95s outside, mind toddlers/elderly/asthma, leave if it gets thick and hot).
- **"Your community"** — the four shared water tanks, the uncleared brush hazard by the water towers and up Avenida Rancho Tesoro, and the Hughes Fire history that makes it matter.

## To take it further

- **Evacuation zones** → wire Genasys Protect / Zonehaven so the evac panel is live.
- **Push alerts** → a small backend polling these feeds that sends web-push/SMS, so it warns residents instead of them checking.
- **Richer incident detail** → NASA FIRMS satellite hot-spots (free API key) + a server-side proxy for the CAL FIRE feed to recover acreage/containment.

## Not an official source

This is a community tool, not an emergency-warning system. Always follow CAL FIRE, LA County Fire, and Sheriff evacuation orders. In an emergency call 911.
