import { rowsFromHistoryPayload } from "./purpleair-history-parse.mjs";

const raw = {
  fields: ["time_stamp", "pm2.5_atm", "humidity"],
  data: [
    [1000, 10, 30],
    [500, 15, 30],
    [2000, 8, 200],
  ],
};

const rows = rowsFromHistoryPayload(raw);
if (rows.length !== 2) throw new Error("expected 2 rows, got " + rows.length);
if (rows[0].t !== 500 || rows[1].t !== 1000) throw new Error("sort by t");
if (!Number.isFinite(rows[0].aqi) || !Number.isFinite(rows[1].aqi)) throw new Error("aqi");

if (rowsFromHistoryPayload(null).length !== 0) throw new Error("null");
if (rowsFromHistoryPayload({ fields: [], data: [] }).length !== 0) throw new Error("empty");

console.log("fetch-purpleair-history.test.mjs ok");
