// Unit test for the Fire page's headline logic — the single most safety-critical
// function on the site. It reads the real overall()/aqiInfo/fireWx/fireRisk out of
// fire.html (no copy to drift), so a change to the tier ladder either keeps these
// scenarios true or fails here.
//
//   node scripts/fire-status.test.mjs
//
// Remember the lockstep rule: this ladder is mirrored in nav.js's say() and in
// scripts/alert-watch.mjs. Priorities here match nav.js on purpose —
// order 100 > shelter 95 > warning 90 > air 80 > fires 75/70 > red flag 60.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "fire.html"), "utf8");

// Pull a top-level `function name(...) {...}` out of the page by brace balance.
function grab(name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("fire.html no longer defines " + name + "()");
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces reading " + name + "()");
}

const mod = { exports: {} };
new Function("module", "exports",
  ["aqiInfo", "fireWx", "fireRisk", "untilText", "overall"].map(grab).join("\n") +
  "\nfunction todayHigh(){ return null; }\n" +        // DOM-free stub
  "\nmodule.exports = { overall };")(mod, mod.exports);
const { overall } = mod.exports;

const base = { aqi: 40, temp: 78, rh: 45, wind: 8, gust: 12, wdir: 200, alerts: [], fires: [], evac: { lvl: 0, unknown: false }, raining: false };
const V = (o) => ({ ...base, ...o });
const fire = (dist, acres) => ({ dist, acres, name: "Test", mod: new Date().toISOString() });

let failed = 0;
function check(label, v, want) {
  const r = overall(v);
  const got = { title: r.title, lvl: r.lvl, klass: r.klass, ey: r.ey, text: r.text };
  const ok = Object.entries(want).every(([k, val]) => (val instanceof RegExp ? val.test(String(got[k])) : got[k] === val));
  if (!ok) { failed++; console.log("FAIL " + label + "\n  got " + JSON.stringify({ ...got, text: got.text.slice(0, 120) }) + "\n  want " + want); }
  else console.log("ok   " + label);
  return r;
}

// --- Shelter-in-place is level 2 like an order, but "leave now" is the dangerous
// instruction during a hazmat or police shelter order (Cal OES publishes both).
check("shelter-in-place leads with stay inside", V({ evac: { lvl: 2, shelter: true } }), { lvl: 2, klass: "danger", title: /Shelter in place/ });
const sh = overall(V({ evac: { lvl: 2, shelter: true } }));
if (/\bleave\b|\bevacuat/i.test(sh.title)) { failed++; console.log("FAIL shelter headline must not say leave/evacuate: " + sh.title); }
else console.log("ok   shelter headline never says leave or evacuate");

// --- An evacuation WARNING for our zone outranks air and fire for the headline
// (it used to lose to both), while the colour still follows the worst thing.
check("warning alone", V({ evac: { lvl: 1 } }), { lvl: 1, klass: "caution", title: /Evacuation warning/ });
check("warning + unhealthy air keeps the warning, goes red", V({ evac: { lvl: 1 }, aqi: 165 }), { lvl: 2, klass: "danger", ey: "Take action", title: /Evacuation warning/, text: /AQI 165/ });
check("warning + sizable nearby fire keeps the warning", V({ evac: { lvl: 1 }, fires: [fire(4, 800)] }), { lvl: 2, klass: "danger", title: /Evacuation warning/ });
check("order still outranks everything", V({ evac: { lvl: 2 }, aqi: 200, fires: [fire(3, 5000)] }), { lvl: 2, title: /Evacuation order/ });

// --- A nearby evacuation is not our zone (lvl 0) but it is NOT "all clear" either.
// This shipped green -- "Looks safe right now" -- while nav.js said amber for the
// same feed data, because overall() only ever read .lvl and .shelter.
check("evacuation order a few miles away", V({ evac: { lvl: 0, near: { kind: "order", dist: 6.3, dir: "NE" } } }), { lvl: 1, klass: "caution", title: /Evacuation order ~6 mi to our NE/ });
check("shelter-in-place nearby", V({ evac: { lvl: 0, near: { kind: "shelter", dist: 4, dir: "S" } } }), { lvl: 1, title: /Shelter-in-place ~4 mi/ });
check("evacuation warning nearby", V({ evac: { lvl: 0, near: { kind: "warning", dist: 9, dir: "W" } } }), { lvl: 1, title: /Evacuation warning ~9 mi/ });
check("our own warning still outranks a nearby order", V({ evac: { lvl: 1, near: { kind: "order", dist: 6, dir: "NE" } } }), { title: /Evacuation warning for our zone/ });
const nearOrder = overall(V({ evac: { lvl: 0, near: { kind: "order", dist: 6, dir: "NE" } } }));
if (/all clear/i.test(nearOrder.ey) || /looks safe/i.test(nearOrder.title)) { failed++; console.log("FAIL a nearby evacuation must never read as all clear: " + nearOrder.ey + " / " + nearOrder.title); }
else console.log("ok   a nearby evacuation never reads as all clear");

// --- Regression: the ordinary days must be unchanged.
check("quiet day", V({}), { lvl: 0, klass: "ok", ey: "All clear", title: /Looks safe/ });
check("moderate air is still a quiet day", V({ aqi: 80 }), { lvl: 0, title: /Looks safe/ });
check("AQI 120 = sensitive groups", V({ aqi: 120 }), { lvl: 1, title: /sensitive groups/ });
check("AQI 165 alone = unhealthy air", V({ aqi: 165 }), { lvl: 2, klass: "danger", title: /Unhealthy air/ });
check("fire 5 mi / 900 ac = sizable fire", V({ fires: [fire(5, 900)] }), { lvl: 2, title: /sizable fire/ });
check("fire 10 mi / 200 ac = fire activity", V({ fires: [fire(10, 200)] }), { lvl: 1, title: /Fire activity/ });
check("fire beyond 15 mi is not a tier", V({ fires: [fire(20, 200)] }), { lvl: 0, title: /Looks safe/ });
check("red flag warning", V({ alerts: [{ event: "Red Flag Warning" }] }), { lvl: 1, title: /Red Flag/ });
check("nearby fire outranks a red flag", V({ fires: [fire(10, 200)], alerts: [{ event: "Red Flag Warning" }] }), { title: /Fire activity/ });
check("red flag outranks heat", V({ alerts: [{ event: "Heat Advisory" }, { event: "Red Flag Warning" }] }), { title: /Red Flag/ });
check("non-fire NWS alert still counts", V({ alerts: [{ event: "Flood Advisory" }] }), { lvl: 1, title: /Flood Advisory/ });
check("rain on a quiet day", V({ raining: true }), { lvl: 0, title: /Looks safe/ });

// --- Two source-level guards for rules that live outside overall().
// (1) The quiet-day gate must lead with its ok flag. Written as !(ok && len) it
// reads a FAILED feed as "nothing to report" and prints that inside the green box.
const quietGate = /const quakesQuiet\s*=\s*([^;]+);/.exec(src);
if (!quietGate) { failed++; console.log("FAIL could not find the quakesQuiet gate in fire.html"); }
else if (!/^ok\.quakes\s*&&/.test(quietGate[1].trim())) {
  failed++; console.log("FAIL quakesQuiet must start with ok.quakes so an unknown never reads as quiet: " + quietGate[1].trim());
} else console.log("ok   a failed quake feed cannot collapse into the green quiet box");

// (2) The lockstep rule: an our-zone evacuation WARNING is caution in all three
// copies. alert-watch.mjs rated it danger, so the red share card sat under an amber
// hero and the phone ping went out at urgent.
const watch = fs.readFileSync(path.join(ROOT, "scripts/alert-watch.mjs"), "utf8");
const warnOur = /warn-our:\$\{zid\}`,\s*prio:\s*(\d+),\s*level:\s*"(\w+)"/.exec(watch);
if (!warnOur) { failed++; console.log("FAIL could not find warn-our in scripts/alert-watch.mjs"); }
else if (warnOur[1] !== "90" || warnOur[2] !== "caution") {
  failed++; console.log("FAIL warn-our must be prio 90 / caution to match fire.html and nav.js, got " + warnOur[1] + " / " + warnOur[2]);
} else console.log("ok   our-zone warning is prio 90 / caution in alert-watch.mjs too");

console.log(failed ? "\n" + failed + " FAILED" : "\nall fire-status scenarios pass");
process.exit(failed ? 1 : 0);
