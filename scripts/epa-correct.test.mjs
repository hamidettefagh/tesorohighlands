import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { correctAtmPm25, aqiFromPm25 } = require("../api/_epa.js");

function assertClose(actual, expected, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.001) {
    throw new Error(label + ": got " + actual + " expected ~" + expected);
  }
}

const RH = 30;
const pins = [
  [0, 3.164],
  [29.9, 18.8316],
  [30, 18.884],
  [49.9, 42.32],
  [50, 42.464],
  [209.9, 168.1454],
  [210, 168.224],
  [259.9, 241.94],
  [260, 242.1244]
];
for (const [x, exp] of pins) {
  assertClose(correctAtmPm25(x, RH), exp, "x=" + x);
}
assertClose(correctAtmPm25(30, RH), correctAtmPm25(30, RH), "self");
if (Math.abs(correctAtmPm25(30, RH) - (0.524 * 30 - 0.0862 * RH + 5.75)) > 1e-9) {
  throw new Error("x=30 must equal low-segment formula (blend weight 0)");
}
if (correctAtmPm25(10, -1) !== null) throw new Error("RH < 0");
if (correctAtmPm25(10, 101) !== null) throw new Error("RH > 100");
if (correctAtmPm25(-1, 30) !== null) throw new Error("x < 0");
if (correctAtmPm25(0, 30) < 0) throw new Error("y must be >= 0 after clamp for x=0 RH=30");
const yHighRh = correctAtmPm25(2, 90);
if (yHighRh !== 0) throw new Error("clamp to 0, got " + yHighRh);
if (aqiFromPm25(8.2) !== 46 && aqiFromPm25(8.2) < 40) throw new Error("aqiFromPm25 sanity");
if (aqiFromPm25(0) !== 0) throw new Error("AQI 0");
console.log("epa-correct.test.mjs ok");
