// Tests for the alert bot's SCE shutoff (PSPS) check: which shutoff counts as ours,
// what each of SCE's steps says, and that a shutoff nearby is never reported as ours.
// Builds made-up SCE records, so nothing touches SCE, writes alert.json or pings a phone.
//
//   node scripts/alert-watch.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Importing must not run the bot: point its output somewhere we can check stays empty.
const OUT = path.join(os.tmpdir(), `alert-watch-test-${process.pid}.json`);
process.env.ALERT_OUT = OUT;
const { pspsRecords, pspsStage, pspsConditions } = await import("./alert-watch.mjs");

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); } };

const T = (s) => Date.parse(s);
const start = T("2026-10-15T06:00:00-07:00"), end = T("2026-10-16T18:00:00-07:00"), ert = T("2026-10-17T02:00:00-07:00");
const now = T("2026-10-15T15:10:00-07:00");
// A box around the houses behind the gate, one around their east half only, and boxes
// 3, 4 and 15 miles east of us.
const box = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
const ALL = box(-118.58, 34.47, -118.54, 34.50), EAST_HALF = box(-118.5625, 34.47, -118.54, 34.50);
const east = (mi) => box(-118.564 + mi / 57.2, 34.48, -118.564 + mi / 57.2 + 0.01, 34.49);
const feat = (layer, name, status, rings, extra = {}) =>
  ({ layer, a: { CIRCUIT_NAME: name, PSPS: status, PSPS_Details: status, StartDate: start, EndDate: end, ...extra }, rings });
const run = (...feats) => pspsConditions(pspsRecords(feats), now);
const ids = (c) => c.map((x) => x.id);

check("importing the bot doesn't run it", !fs.existsSync(OUT));

// --- SCE's steps
check("Monitored is a watch", pspsStage({ status: "Monitored Monitored", layer: 0 }) === "watch");
check("De-Energization Expected is expected", pspsStage({ status: "De-Energization Expected", layer: 0 }) === "expected");
check("De-Energized is off", pspsStage({ status: "De-Energized", layer: 1 }) === "off");
check("Re-Energization Expected is restoring", pspsStage({ status: "Re-Energization Expected", layer: 1 }) === "restoring");
check("Re-Energized is restored", pspsStage({ status: "Re-Energized", layer: 1 }) === "restored");
check("Downstream on the watch layer is a watch", pspsStage({ status: "Downstream", layer: 0 }) === "watch");
check("Downstream on the shut-off layer is off", pspsStage({ status: "Downstream", layer: 1 }) === "off");
check("an unknown status on the shut-off layer is off", pspsStage({ status: "", layer: 1 }) === "off");

// --- our circuit on the watch list (what SCE showed on Oct 13, 2026)
{
  const c = run(feat(0, "ORION", "Monitored", ALL, { ERT: ert }));
  check("on the watch list: one alert, keyed to the window", c.length === 1 && c[0].id === `power:ours:watch:${start}-${end}`, ids(c));
  check("...titled with SCE's window in Pacific time", c[0].title === "SCE may shut off our power Thu 6 AM – Fri 6 PM", c[0].title);
  check("...naming the circuit and the full dates", /our circuit \(Orion\)/.test(c[0].text) && c[0].text.includes("Thu, Oct 15, 6 AM to Fri, Oct 16, 6 PM"), c[0].text);
  check("...saying it isn't certain", /isn’t certain/.test(c[0].text));
  check("...outranking a distant fire (58) but not a nearby evacuation order (60)", c[0].prio > 58 && c[0].prio < 60, c[0].prio);
  check("...and covering the whole neighborhood", !/part of our neighborhood/.test(c[0].text));
}

// --- the later steps
{
  const exp = run(feat(0, "ORION", "De-Energization Expected", ALL));
  check("expected: its own alert, stamped with the time", ids(exp).join() === "power:ours:expected" && exp[0].text.includes("As of 3:10 PM") && /1 to 4 hours/.test(exp[0].text), exp);
  const off = run(feat(1, "ORION", "De-Energized", ALL, { ERT: ert }));
  check("off: says our power is off, with SCE's estimate and when it was read", ids(off).join() === "power:ours:off" && off[0].title.startsWith("Our power is shut off") &&
    off[0].text.includes("SCE’s estimate at 3:10 PM: back by Sat, Oct 17, 2 AM"), off);
  const noErt = run(feat(1, "ORION", "De-Energized", ALL));
  check("off without an estimate doesn't make one up", !/back by/.test(noErt[0].text), noErt[0].text);
  const rest = run(feat(1, "ORION", "Re-Energization Expected", ALL, { ERT: ert }));
  check("restoring: its own alert", ids(rest).join() === "power:ours:restoring" && /back by Sat, Oct 17, 2 AM/.test(rest[0].text), rest);
  const back = run(feat(1, "ORION", "Re-Energized", ALL));
  check("restored: power is back on", ids(back).join() === "power:ours:restored" && back[0].text.startsWith("✅"), back);
  const both = run(feat(0, "ORION", "Monitored", ALL), feat(1, "ORION", "De-Energized", ALL));
  check("on both layers, the worse step wins", ids(both).join() === "power:ours:off", ids(both));
  const ladder = [off, exp, rest].map((c) => c[0].prio);
  check("off > expected > restoring > watch > not-ours > restored", ladder[0] > ladder[1] && ladder[1] > ladder[2] && ladder[2] > 59 && back[0].prio < 56, ladder);
}

// --- shutoffs that aren't ours
{
  const c = run(feat(1, "TUBA", "De-Energized", east(3)), feat(1, "COBRA", "De-Energized", east(4)));
  check("nearby, ours not listed: one 'not our circuit' alert", ids(c).join() === "power:near" && c[0].title === "SCE shut off power nearby — not our circuit", ids(c));
  check("...naming them, nearest first, with distance and direction", c[0].text.includes("2 circuits near us: Tuba (~3 mi east) and Cobra (~4 mi east)"), c[0].text);
  check("...and saying ours wasn't on SCE's list, with the time", c[0].text.includes("Our circuit (Orion) was not on SCE’s shutoff list at 3:10 PM"), c[0].text);
  check("...never that ours is off", !/Our power is shut off/.test(c[0].text));

  const w = run(feat(0, "ORION", "Monitored", ALL), feat(1, "TUBA", "De-Energized", east(3)));
  check("nearby while ours is on the watch list: one combined alert", w.length === 1 && w[0].id === `power:ours:watch:${start}-${end}:near`, ids(w));
  check("...ours still on, and listed until SCE's end time", w[0].text.includes("Our circuit (Orion) was still on at 3:10 PM, and SCE lists it for a possible shutoff until Fri 6 PM"), w[0].text);

  const o = run(feat(1, "ORION", "De-Energized", ALL), feat(1, "TUBA", "De-Energized", east(3)));
  check("ours off: nothing about circuits nearby", ids(o).join() === "power:ours:off", ids(o));

  const r = run(feat(1, "ORION", "Re-Energized", ALL), feat(1, "TUBA", "De-Energized", east(3)));
  check("ours back on, one nearby still off: both said", ids(r).sort().join() === "power:near,power:ours:restored" && /Our circuit \(Orion\) is back on/.test(r.find((x) => x.id === "power:near").text), r);

  check("a shutoff 15 miles away isn't mentioned", run(feat(1, "FAR", "De-Energized", east(15))).length === 0);
  check("a nearby circuit already back on isn't a shutoff", run(feat(1, "TUBA", "Re-Energized", east(3))).length === 0);
  check("a nearby circuit only on the watch list isn't a shutoff", run(feat(0, "TUBA", "Monitored", east(3))).length === 0);

  const seg = run(feat(0, "ORION", "Monitored", ALL), feat(1, "ORION", "De-Energized", east(3)));
  check("a far section of our own circuit off: still on the watch, called another section", seg.length === 1 && seg[0].id.endsWith(":near") &&
    seg[0].text.includes("another section of Orion (~3 mi east)"), seg[0]?.text);

  const many = run(...["A", "B", "C", "D", "E", "F"].map((n, i) => feat(1, "C" + n, "De-Energized", east(2 + i))), feat(1, "CA", "De-Energized", east(9)));
  check("many nearby: the four closest, then a count, each circuit once", many[0].text.includes("6 circuits near us: Ca (~2 mi east), Cb (~3 mi east), Cc (~4 mi east), Cd (~5 mi east) and 2 more"), many[0].text);
}

// --- coverage is by place, not by name
{
  const renamed = run(feat(0, "NEWNAME", "Monitored", ALL));
  check("a renamed circuit over our streets is still ours, under its new name", renamed[0].id.startsWith("power:ours:watch") && /our circuit \(Newname\)/.test(renamed[0].text), renamed[0]);
  const half = run(feat(1, "ORION", "De-Energized", EAST_HALF));
  check("covering some of our streets: ours, and says only part", ids(half).join() === "power:ours:off" && /part of our neighborhood/.test(half[0].text), half[0].text);
  check("no records, no alerts", run().length === 0);
  check("a record without a shape is ignored", run(feat(1, "GHOST", "De-Energized", [])).length === 0);
}

// --- every message reads cleanly
{
  const all = [
    run(feat(0, "ORION", "Monitored", ALL)), run(feat(0, "ORION", "De-Energization Expected", ALL)),
    run(feat(1, "ORION", "De-Energized", ALL, { ERT: ert })), run(feat(1, "ORION", "Re-Energization Expected", ALL)),
    run(feat(1, "ORION", "Re-Energized", ALL)), run(feat(1, "TUBA", "De-Energized", east(3))),
    run(feat(0, "ORION", "Monitored", ALL), feat(1, "TUBA", "De-Energized", east(3))),
  ].flat();
  const bad = all.filter((c) => /undefined|NaN|Invalid Date|null| /.test(c.title + c.text) || !c.text.includes("tesorohighlands.com/fire") || !/sce\.com\/outagemap/.test(c.text));
  check("no undefined/NaN/odd spaces, and every message links SCE's map and our Fire page", bad.length === 0, bad.map((c) => c.id));
}

check("and the bot never ran", !fs.existsSync(OUT));
console.log(failed ? "\n" + failed + " FAILED" : "\nall alert-bot shutoff checks pass");
process.exit(failed ? 1 : 0);
