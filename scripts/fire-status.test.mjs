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

console.log(failed ? "\n" + failed + " FAILED" : "\nall fire-status scenarios pass");
process.exit(failed ? 1 : 0);
