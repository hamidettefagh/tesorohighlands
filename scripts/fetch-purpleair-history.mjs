// Builds purpleair-history.json: EPA-corrected 60-minute AQI for the last 24 hours
// from one outdoor PurpleAir sensor. Runs server-side (GitHub Action / local) and
// commits a tiny file the weather page can fetch.
//
// Fails soft: any error keeps the last good file.
//
//   node scripts/fetch-purpleair-history.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { rowsFromHistoryPayload } from "./purpleair-history-parse.mjs";

const OUT = new URL("../purpleair-history.json", import.meta.url);
const FIELDS = "pm2.5_atm,humidity";

const apiKey = process.env.PURPLEAIR_API_KEY;
// Env-only, no default: a sensor index resolves to a street on PurpleAir's
// public map, so it stays out of a public repo. Set it as a GitHub secret
// alongside PURPLEAIR_API_KEY.
const index = process.env.PURPLEAIR_SENSOR_INDEX;

if (!apiKey) {
  console.error("purpleair-history: PURPLEAIR_API_KEY not set — keeping last good file.");
  process.exit(0);
}
if (!index) {
  console.error("purpleair-history: PURPLEAIR_SENSOR_INDEX not set — keeping last good file.");
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const start = now - 86400;
const url =
  "https://api.purpleair.com/v1/sensors/" +
  encodeURIComponent(String(index)) +
  "/history?average=60&fields=" +
  encodeURIComponent(FIELDS) +
  "&start_timestamp=" +
  start +
  "&end_timestamp=" +
  now;

let raw;
try {
  const res = await fetch(url, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
      "User-Agent": "tesorohighlands.com feed builder",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  raw = await res.json();
} catch (err) {
  console.error(
    "purpleair-history: fetch failed —",
    String(err).slice(0, 120),
    "— keeping last good file."
  );
  process.exit(0);
}

const history = rowsFromHistoryPayload(raw);
console.log(`purpleair-history: ${history.length} rows in last 24h.`);

let payload;
if (history.length) {
  payload = {
    generatedAt: new Date().toISOString(),
    ok: true,
    history,
  };
} else if (!existsSync(OUT)) {
  payload = {
    generatedAt: new Date().toISOString(),
    ok: false,
    history: [],
  };
} else {
  console.log("No usable rows — keeping last good file.");
  process.exit(0);
}

let old = null;
try {
  old = JSON.parse(readFileSync(OUT, "utf8"));
} catch {}
if (old && JSON.stringify(old) === JSON.stringify(payload)) {
  console.log("No content change.");
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
console.log("Wrote purpleair-history.json.");
