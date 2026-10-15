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

// The well-contained cutoff is a page constant that fireRisk() reads.
const wellContained = (s) => { const m = /\bWELL_CONTAINED\s*=\s*(\d+)/.exec(s); return m ? +m[1] : null; };
const CUTOFF = wellContained(src);
if (CUTOFF == null) throw new Error("fire.html no longer defines WELL_CONTAINED");
const mod = { exports: {} };
new Function("module", "exports",
  "const WELL_CONTAINED = " + CUTOFF + ";\n" +
  ["aqiInfo", "fireWx", "alertable", "fireRisk", "untilText", "whenText", "overall"].map(grab).join("\n") +
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

// --- A well-contained fire stops raising the alert (it stays in the list). The Bike
// Fire sat at 81% contained, 9 miles out, and still headlined the page.
const contained = (pct) => ({ ...fire(9.1, 172), contain: pct });
check("a 172-acre fire 9 mi out is worth watching", V({ fires: [fire(9.1, 172)] }), { lvl: 1, title: /Fire activity/ });
check("the same fire " + CUTOFF + "%+ contained no longer alerts", V({ fires: [contained(81)] }), { lvl: 0 });
check("the same fire half contained still alerts", V({ fires: [contained(50)] }), { lvl: 1, title: /Fire activity/ });
check("containment given as text counts too", V({ fires: [contained("90")] }), { lvl: 0 });
check("a close, big fire " + CUTOFF + "%+ contained no longer alerts", V({ fires: [{ ...fire(4, 900), contain: CUTOFF }] }), { lvl: 0 });
check("a contained fire doesn't hide an uncontained one", V({ fires: [contained(95), fire(5, 120)] }), { lvl: 2, title: /sizable fire/i });

// --- Our own power (SCE's status for our circuit, from /api/power). It leads over a
// fire in the area and a Red Flag, but never over an evacuation or a close fire.
const power = (stage, extra) => ({ ok: true, ours: { stage, circuit: "Orion", wholeNeighborhood: true, ert: Date.parse("2026-10-17T05:00:00-07:00"), ...extra }, outages: [] });
check("power shut off leads the page", V({ power: power("off") }), { lvl: 1, klass: "caution", title: /Our power is off/, text: /back by/ });
check("power off beats a fire in the area", V({ power: power("off"), fires: [fire(9.1, 172)] }), { title: /Our power is off/ });
check("power off beats a Red Flag Warning", V({ power: power("off"), alerts: [{ event: "Red Flag Warning" }] }), { title: /Our power is off/ });
check("a close, sizable fire beats power off", V({ power: power("off"), fires: [fire(4, 300)] }), { lvl: 2, title: /sizable fire/i });
check("an evacuation order beats power off", V({ power: power("off"), evac: { lvl: 2 } }), { lvl: 2, title: /Evacuation order/ });
check("shutoff expected", V({ power: power("expected") }), { lvl: 1, title: /expects to shut off our power/ });
check("power coming back", V({ power: power("restoring") }), { lvl: 1, title: /restoring our power/ });
check("on SCE's watch list", V({ power: power("watch", { windowEnd: Date.parse("2026-10-16T21:00:00-07:00") }) }), { lvl: 1, title: /may shut off our power until/ });
check("no shutoff for our circuit says nothing about power", V({ power: { ok: true, ours: null, outages: [] } }), { lvl: 0 });

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

// --- Flash floods (2026-09-30). NWS keeps the event name "Flash Flood Warning" and
// flags severity in a damage-threat tag; both tags set off phone alerts, so both go red.
const FFW = (threat, extra) => ({ event: "Flash Flood Warning", threat: threat || "", ...(extra || {}) });
check("flash flood warning: amber, says what to do", V({ alerts: [FFW("")] }), { lvl: 1, klass: "caution", title: /^Flash Flood Warning/, text: /moving water/ });
check("considerable-threat flash flood warning: red", V({ alerts: [FFW("CONSIDERABLE")] }), { lvl: 2, klass: "danger", title: /^Flash Flood Warning/ });
check("flash flood emergency: red, and named as one", V({ alerts: [FFW("CATASTROPHIC")] }), { lvl: 2, klass: "danger", ey: "Take action", title: /^Flash Flood Emergency/ });
check("the most severe of several flash flood warnings leads", V({ alerts: [FFW(""), FFW("CATASTROPHIC")] }), { title: /^Flash Flood Emergency/ });
check("a cancelled flash flood warning does not escalate", V({ alerts: [FFW("CATASTROPHIC", { urgency: "past" })] }), { lvl: 0, title: /Looks safe/ });
check("our own evacuation warning still leads a flash flood emergency", V({ evac: { lvl: 1 }, alerts: [FFW("CATASTROPHIC")] }), { lvl: 2, title: /Evacuation warning for our zone/ });
check("a flash flood warning outranks a red flag", V({ alerts: [{ event: "Red Flag Warning" }, FFW("")] }), { title: /^Flash Flood Warning/ });
check("flood advisory stays on the general path", V({ alerts: [{ event: "Flood Advisory" }] }), { lvl: 1, title: /^Flood Advisory/ });
check("flood watch stays on the general path", V({ alerts: [{ event: "Flood Watch" }] }), { lvl: 1, title: /^Flood Watch/ });

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

// (3) The flash-flood ladder lives in two places, nav.js and overall() in fire.html,
// and must agree: emergency 85/level 2, considerable 82/level 2, warning 65/level 1.
const navSrc = fs.readFileSync(path.join(ROOT, "nav.js"), "utf8");
const ladder = [
  [/say\(72, 1, "⚡ Our power is off/, /say\(72, 1, "Our power is off/, "power off 72/1"],
  [/say\(71, 1, "⚡ SCE is restoring/, /say\(71, 1, "SCE is restoring/, "power restoring 71/1"],
  [/say\(71, 1, "⚡ SCE expects/, /say\(71, 1, "SCE expects/, "power expected 71/1"],
  [/say\(62, 1, "⚡ SCE may shut off/, /say\(62, 1, "SCE may shut off/, "power watch 62/1"],
  [/say\(85, 2, "Flash Flood Emergency"/, /say\(85, 2, "Flash Flood Emergency"/, "emergency 85/2"],
  [/say\(82, 2, "Flash Flood Warning"/, /say\(82, 2, "Flash Flood Warning"/, "considerable 82/2"],
  [/say\(65, 1, "Flash Flood Warning"/, /say\(65, 1, "Flash Flood Warning"/, "warning 65/1"],
];
const drift = ladder.filter(([inNav, inFire]) => !inNav.test(navSrc) || !inFire.test(src)).map(l => l[2]);
if (drift.length) { failed++; console.log("FAIL the ladder differs between nav.js and fire.html: " + drift.join(", ")); }
else console.log("ok   the flash-flood and power ladders match in nav.js and fire.html");

// (3b) The well-contained cutoff is the same number in all three copies.
const cutoffs = { "fire.html": CUTOFF, "nav.js": wellContained(navSrc), "scripts/alert-watch.mjs": wellContained(fs.readFileSync(path.join(ROOT, "scripts/alert-watch.mjs"), "utf8")) };
if (new Set(Object.values(cutoffs)).size !== 1 || Object.values(cutoffs).includes(null)) { failed++; console.log("FAIL the well-contained cutoff differs: " + JSON.stringify(cutoffs)); }
else console.log("ok   the well-contained cutoff (" + CUTOFF + "%) matches in fire.html, nav.js and the alert bot");

// (4) Phone numbers. The Fire page's "Who to call" list is the site's one copy of the
// 24/7 numbers; the Weather storm card and Living Here's utilities link to it instead
// of repeating them, so a changed number can't be fixed in one place and left stale in another.
const living = fs.readFileSync(path.join(ROOT, "living.html"), "utf8");
const weatherSrc = fs.readFileSync(path.join(ROOT, "weather.html"), "utf8");
const between = (s, from, to) => { const i = s.indexOf(from); if (i < 0) return ""; const j = s.indexOf(to, i); return j < 0 ? s.slice(i) : s.slice(i, j); };
const calls = [...between(src, 'id="call"', 'id="sources"').matchAll(/href="tel:([+\d]+)"/g)].map(m => m[1]);
const others = { "the Weather storm card": between(weatherSrc, 'id="storms"', "</section>"), "Living Here's utilities": between(living, 'id="utilities"', "</section>") };
if (calls.length < 8 || !calls.includes("911")) { failed++; console.log("FAIL the Who to call list lost numbers: " + calls.join(", ")); }
else console.log("ok   the Who to call list has " + calls.length + " numbers, 911 first");
for (const [where, html] of Object.entries(others)) {
  const repeated = [...html.matchAll(/href="tel:([+\d]+)"/g)].map(m => m[1]).filter(n => calls.includes(n));
  if (!html || !html.includes('href="/fire#call"')) { failed++; console.log("FAIL " + where + " should link to the Who to call list"); }
  else if (repeated.length) { failed++; console.log("FAIL " + where + " repeats Who to call numbers -- link instead: " + repeated.join(", ")); }
  else console.log("ok   " + where + " links to Who to call instead of repeating its numbers");
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall fire-status scenarios pass");
process.exit(failed ? 1 : 0);
