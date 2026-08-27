import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { correctAtmPm25, aqiFromPm25 } = require("../api/_epa.js");

export function rowsFromHistoryPayload(raw) {
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
    const y = correctAtmPm25(row[pi], row[hi]);
    const aqi = y == null ? null : aqiFromPm25(y);
    if (!Number.isFinite(t) || aqi == null) continue;
    rows.push({ t, aqi });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}
