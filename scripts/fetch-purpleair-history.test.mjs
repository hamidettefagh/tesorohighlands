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

// The two counters disagreeing (one faulty) drops the hour; agreeing keeps it.
const qa = rowsFromHistoryPayload({
  fields: ["time_stamp", "pm2.5_atm", "pm2.5_atm_a", "pm2.5_atm_b", "humidity"],
  data: [
    [100, 250, 495, 5, 20],     // one counter at 495, the other at 5: faulty, dropped
    [200, 9, 10, 8, 20],        // close agreement: kept
    [300, 4, 6, 2, 20],         // 4 µg/m³ apart (100%): under the 5 µg/m³ floor, kept
    [400, 120, 140, 100, 20],   // heavy smoke, 33% apart: kept
  ],
});
if (qa.map((r) => r.t).join() !== "200,300,400") throw new Error("agreement check kept " + qa.map((r) => r.t).join());

if (rowsFromHistoryPayload(null).length !== 0) throw new Error("null");
if (rowsFromHistoryPayload({ fields: [], data: [] }).length !== 0) throw new Error("empty");

console.log("fetch-purpleair-history.test.mjs ok");
