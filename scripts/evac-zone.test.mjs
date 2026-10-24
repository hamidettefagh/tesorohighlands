// Which evacuation zone is "ours" — the check behind "EVACUATION ORDER — leave now".
//
//   node scripts/evac-zone.test.mjs
//
// The site used to test one point (34.478, -118.531) that sits ~1.8 mi east of the
// houses behind the gate, in a different Genasys zone (SCL-BLACKPINE; the streets
// are SCL-REYESADOBE). In the Hughes Fire on Jan 22, 2025, REYESADOBE was under an
// evacuation ORDER while BLACKPINE was only under a WARNING, so all three copies of
// the logic would have told us "be packed and ready" instead of "leave now".
//
// Now a zone is ours when it covers that point OR any street point. This test
// replays the Hughes Fire with the official zone boundaries
// (scripts/fixtures/evac-zones.json) through the real code in all three places —
// scripts/alert-watch.mjs, fire.html and nav.js — and checks that their copies of
// the street points and the home point still match api/_power.js and each other.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ZONES = JSON.parse(read("scripts/fixtures/evac-zones.json"));
const REYES = ZONES["SCL-REYESADOBE"], BLACK = ZONES["SCL-BLACKPINE"];
const { STREETS } = createRequire(import.meta.url)("../api/_power.js");

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); } };

// Pull `function name(...) {...}` out of a source file by brace balance.
function grab(src, name, file) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error(file + " no longer defines " + name + "()");
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces reading " + name + "() in " + file);
}
const literal = (src, re, file) => { const m = re.exec(src); if (!m) throw new Error(file + ": can't find " + re); return m[1]; };

// ---- the three copies ----
// 1. The alert bot (importing must not run it).
process.env.ALERT_OUT = path.join(os.tmpdir(), `evac-zone-test-${process.pid}.json`);
const bot = await import("./alert-watch.mjs");
const botSrc = read("scripts/alert-watch.mjs");
const botHome = Function("return " + literal(botSrc, /const HOME = (\{[^}]*\});/, "alert-watch.mjs"))();

// 2. The Fire page.
const fireSrc = read("fire.html");
const fireLoc = Function("return " + literal(fireSrc, /const LOC = (\{[^}]*\});/, "fire.html"))();
const fireStreets = JSON.parse(literal(fireSrc, /const STREETS = (\[\[[^;]*\]\]);/, "fire.html"));
const fireCovers = new Function("LOC", "STREETS", grab(fireSrc, "coversUs", "fire.html") + "\nreturn coversUs;")(fireLoc, fireStreets);

// 3. The status line on every page.
const navSrc = read("nav.js");
const navStreets = JSON.parse(literal(navSrc, /var STREETS = (\[\[[^;]*\]\]);/, "nav.js"));
const navLocFn = new Function("localStorage", grab(navSrc, "loc", "nav.js") + "\nreturn loc;")({ removeItem() {} });
const navCovers = new Function("STREETS", "loc", grab(navSrc, "coversUs", "nav.js") + "\nreturn coversUs;")(navStreets, navLocFn);

const COPIES = [["alert bot", bot.coversUs], ["fire.html", fireCovers], ["nav.js", navCovers]];

// ---- the copies agree with each other and with api/_power.js ----
check("fire.html's street points match api/_power.js", JSON.stringify(fireStreets) === JSON.stringify(STREETS));
check("nav.js's street points match api/_power.js", JSON.stringify(navStreets) === JSON.stringify(STREETS));
const nl = navLocFn();
check("the home point is the same in all three",
  botHome.lat === fireLoc.lat && botHome.lon === fireLoc.lon && nl.lat === fireLoc.lat && nl.lon === fireLoc.lon,
  { bot: botHome, fire: { lat: fireLoc.lat, lon: fireLoc.lon }, nav: nl });
check("fire.html decides 'covers' with coversUs()", /covers: coversUs\(rings\)/.test(fireSrc));
check("nav.js decides 'covers' with coversUs()", /covers: coversUs\(rings\)/.test(navSrc));
check("the bot decides 'covers' with coversUs()", /const covers = coversUs\(rings\)/.test(botSrc));

// ---- which zones count as ours ----
const box = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
const WEST_OF_STREETS = box(-118.595, 34.475, -118.5745, 34.495);   // just past the westmost street
const EAST_OF_HOME = box(-118.485, 34.47, -118.465, 34.49);         // ~3 mi east of the home point
const NORTH_OF_STREETS = box(-118.575, 34.49, -118.55, 34.50);       // just north of the northmost street
for (const [who, covers] of COPIES) {
  check(who + ": the streets' zone (SCL-REYESADOBE) is ours", covers(REYES) === true);
  check(who + ": the home point's zone (SCL-BLACKPINE) still counts", covers(BLACK) === true);
  check(who + ": a zone just west of the streets is not ours", covers(WEST_OF_STREETS) === false);
  check(who + ": a zone ~3 mi east of the home point is not ours", covers(EAST_OF_HOME) === false);
  check(who + ": a zone just north of the streets is not ours", covers(NORTH_OF_STREETS) === false);
}

// ---- the Hughes Fire, replayed through the bot's full alert logic ----
const feat = (status, rings, zone) => ({ attributes: { STATUS: status, NOTES: "Hughes Fire", ZONE_ID: zone }, geometry: { rings } });
const top = (conds) => conds.slice().sort((a, b) => b.prio - a.prio)[0];

let c = top(bot.evacConditions([feat("Evacuation Order", REYES, "SCL-REYESADOBE"), feat("Evacuation Warning", BLACK, "SCL-BLACKPINE")]));
check("Hughes Fire as issued: the bot leads with ORDER for our zone", c && c.id === "order-our:SCL-REYESADOBE" && c.level === "danger" && /Leave NOW/.test(c.text), c && c.id);

c = top(bot.evacConditions([feat("Evacuation Order", REYES, "SCL-REYESADOBE")]));
check("an order on the streets' zone alone is ORDER for our zone", c && c.id === "order-our:SCL-REYESADOBE", c && c.id);

c = top(bot.evacConditions([feat("Evacuation Warning", REYES, "SCL-REYESADOBE")]));
check("a warning on the streets' zone alone is WARNING for our zone", c && c.id === "warn-our:SCL-REYESADOBE" && c.prio === 90, c && c.id);

c = top(bot.evacConditions([feat("Shelter in Place", REYES, "SCL-REYESADOBE")]));
check("shelter-in-place on the streets' zone says stay inside, never leave", c && c.id === "shelter-our:SCL-REYESADOBE" && !/leave now/i.test(c.text), c && c.id);

const near = bot.evacConditions([feat("Evacuation Order", WEST_OF_STREETS, "TEST-WEST")]);
check("an order just west of the streets is 'nearby', not ours", near.length === 1 && near[0].id === "order-near:TEST-WEST", near.map((x) => x.id));

try { fs.unlinkSync(process.env.ALERT_OUT); } catch {}
console.log(failed ? `\n${failed} evacuation-zone check(s) FAILED` : "\nall evacuation-zone checks pass");
process.exit(failed ? 1 : 0);
