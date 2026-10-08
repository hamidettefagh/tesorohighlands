// Tests for the Halloween treat map API (api/treats.js): the neighbor code, who
// can change which pin, the limits, and the season edges. Runs the real handler
// against its in-memory store with a fake clock, so nothing touches Redis.
//
//   node scripts/treats.test.mjs

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const api = require(path.join(ROOT, "api", "treats.js"));
const DATA = require(path.join(ROOT, "api", "_treat-homes.js"));

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("ok   " + name);
  else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}

const PT = s => Date.parse(s); // ISO strings with an explicit -07:00 offset
let now = PT("2026-10-20T18:00:00-07:00");
const clock = () => now;
const ENV = { TREAT_CODE: "pumpkin", TREAT_ADMIN_CODE: "big-pumpkin" };

function fresh(env = ENV) {
  return api.makeHandler({ env, store: api.memoryStore(clock), now: clock });
}
async function call(h, { method = "GET", code, token, body, ip = "10.0.0.1", url = "/api/treats" } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (method === "GET") {
    if (code !== undefined) headers["x-treat-code"] = encodeURIComponent(code);
    if (token) headers["x-treat-token"] = token;
  }
  const req = { method, url, headers, body: method === "POST" ? { code, token, ...body } : undefined, socket: {} };
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(s) { this.body = s; } };
  await h(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}
const A = "phone-a-0123456789abcdef", B = "phone-b-0123456789abcdef", ADMIN_PHONE = "phone-z-0123456789abcdef";
const ids = DATA.homes.map(h => h[0]);
const set = (home, extra) => ({ action: "set", home, how: "knock", teal: false, decor: false, until: "", ...extra });

// --- the house list
check("368 house lots behind the gate", DATA.homes.length === 368, DATA.homes.length);
check("house ids are unique", new Set(ids).size === ids.length);
check("every lot outline has at least 3 corners", DATA.homes.every(h => h[4].length >= 6));
check("no parcel numbers in the house list", !/\b3244\d{6}\b/.test(JSON.stringify(DATA)));

// --- not set up yet
{
  const r = await call(api.makeHandler({ env: {}, store: api.memoryStore(clock), now: clock }), { code: "pumpkin" });
  check("no code configured: 503 setup", r.status === 503 && r.json.error === "setup", r);
  const r2 = await call(api.makeHandler({ env: ENV, store: null, now: clock }), { code: "pumpkin" });
  check("no store configured: 503 setup", r2.status === 503 && r2.json.error === "setup", r2);
}

// --- the code
{
  const h = fresh();
  const probe = await call(h, {});
  check("no code is a probe: 401, no homes", probe.status === 401 && !probe.json.homes, probe.status);
  const ok = await call(h, { code: "  PumpKin " });
  check("code ignores case and spaces", ok.status === 200 && ok.json.role === "neighbor", ok.status);
  check("a good code gets the houses and an open map", ok.json.homes && ok.json.homes.homes.length === 368 && ok.json.phase === "open");
  check("responses are never cached and never indexed", ok.headers["cache-control"] === "no-store" && ok.headers["x-robots-tag"] === "noindex");
  check("no CORS header: other sites can't read the map", !("access-control-allow-origin" in ok.headers));
  const lean = await call(h, { code: "pumpkin", url: "/api/treats?homes=0" });
  check("?homes=0 skips the house list on refresh", lean.status === 200 && lean.json.homes === undefined);
  const admin = await call(h, { code: "big-pumpkin" });
  check("the admin code is recognized", admin.json.role === "admin");

  for (let i = 0; i < 8; i++) await call(h, { code: "guess" + i, ip: "10.9.9.9" });
  const ninth = await call(h, { code: "guess-9", ip: "10.9.9.9" });
  check("the 9th wrong code in 15 minutes waits", ninth.status === 429 && ninth.json.error === "slow", ninth.status);
  const right = await call(h, { code: "pumpkin", ip: "10.9.9.9" });
  check("...and so does the right code from that address", right.status === 429, right.status);
  const other = await call(h, { code: "pumpkin", ip: "10.1.1.1" });
  check("other neighbors aren't locked out", other.status === 200, other.status);
  now += 16 * 60e3;
  const later = await call(h, { code: "pumpkin", ip: "10.9.9.9" });
  check("the wait is over after 15 minutes", later.status === 200, later.status);
  now = PT("2026-10-20T18:00:00-07:00");

  const uni = await call(fresh({ ...ENV, TREAT_CODE: "Calabaza Ñ" }), { code: "calabaza ñ" });
  check("a non-ASCII code works through the header", uni.status === 200, uni.status);
}

// --- pins: who can change what
{
  const h = fresh();
  const home = ids[10], home2 = ids[11], home3 = ids[12];
  const bad = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "fullsize" }) });
  check("unknown candy style is refused", bad.status === 400, bad.status);
  const badUntil = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { until: "23:00" }) });
  check("unknown 'until' time is refused", badUntil.status === 400, badUntil.status);
  const badHome = await call(h, { method: "POST", code: "pumpkin", token: A, body: set("deadbeef") });
  check("a house that isn't behind the gate is refused", badHome.status === 400 && badHome.json.error === "home", badHome.status);
  const noTok = await call(h, { method: "POST", code: "pumpkin", token: "short", body: set(home) });
  check("a write needs this phone's token", noTok.status === 400 && noTok.json.error === "token", noTok.status);
  const wrong = await call(h, { method: "POST", code: "nope", token: A, body: set(home) });
  check("a write needs the code", wrong.status === 401, wrong.status);

  const add = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "bowl", teal: true, until: "20:30" }) });
  check("phone A adds a house", add.status === 200 && add.json.pins[home].how === "bowl" && add.json.mine.includes(home), add.json);
  check("the owner hash never leaves the server", !JSON.stringify(add.json).includes('"own"'));
  const view = await call(h, { code: "pumpkin", token: B });
  check("phone B sees it, and it isn't B's", view.json.pins[home] && view.json.pins[home].until === "20:30" && !view.json.mine.includes(home));
  const steal = await call(h, { method: "POST", code: "pumpkin", token: B, body: set(home) });
  check("phone B can't change A's house", steal.status === 409 && steal.json.error === "taken", steal.status);
  const delB = await call(h, { method: "POST", code: "pumpkin", token: B, body: { action: "remove", home } });
  check("phone B can't remove A's house", delB.status === 409, delB.status);
  const out = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "bowl", out: true }) });
  check("phone A flips to out of candy", out.status === 200 && out.json.pins[home].out === true, out.status);

  const fix = await call(h, { method: "POST", code: "big-pumpkin", token: ADMIN_PHONE, body: set(home, { how: "knock" }) });
  check("the admin can fix anyone's pin", fix.status === 200 && fix.json.pins[home].how === "knock", fix.status);
  const still = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "bowl" }) });
  check("...and it stays in the owner's hands", still.status === 200, still.status);

  const two = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home2) });
  check("a phone can add a second house (a parent next door)", two.status === 200, two.status);
  const three = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home3) });
  check("but not a third", three.status === 409 && three.json.error === "limit", three.status);

  const del = await call(h, { method: "POST", code: "pumpkin", token: A, body: { action: "remove", home } });
  check("phone A removes its house", del.status === 200 && !del.json.pins[home], del.status);
  const adminDel = await call(h, { method: "POST", code: "big-pumpkin", token: ADMIN_PHONE, body: { action: "remove", home: home2 } });
  check("the admin can remove any house", adminDel.status === 200 && !adminDel.json.pins[home2], adminDel.status);
}

// --- too many changes
{
  const h = fresh();
  let last;
  for (let i = 0; i < 41; i++) last = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[0], { out: i % 2 === 1 }), ip: "10.5.5.5" });
  check("the 41st change in 10 minutes waits", last.status === 429, last.status);
}

// --- the season
{
  check("Oct 1, 12:00 AM Pacific: open", api.season(PT("2026-10-01T00:00:00-07:00")).phase === "open");
  check("Sept 30, 11:59 PM Pacific: not yet", api.season(PT("2026-09-30T23:59:00-07:00")).phase === "before");
  check("Halloween, 11:59 PM Pacific: still open", api.season(PT("2026-10-31T23:59:00-07:00")).phase === "open");
  check("Nov 1, 12:00 AM Pacific: closed", api.season(PT("2026-11-01T00:00:00-07:00")).phase === "closed");
  check("next year rolls over on its own", api.season(PT("2027-10-15T12:00:00-07:00")).night === "2027-10-31");

  now = PT("2026-10-31T21:00:00-07:00");
  const h = fresh();
  const add = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[3]) });
  check("adding on Halloween night works", add.status === 200, add.status);
  now = PT("2026-11-01T00:00:01-07:00");
  const shut = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[4]) });
  check("after midnight, no more changes", shut.status === 403 && shut.json.error === "closed", shut.status);
  const view = await call(h, { code: "pumpkin" });
  check("after midnight, every pin is gone", view.status === 200 && view.json.phase === "closed" && Object.keys(view.json.pins).length === 0, view.json.pins);
  now = PT("2027-09-20T12:00:00-07:00");
  const early = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[4]) });
  check("before Oct 1, no changes yet", early.status === 403 && early.json.error === "before", early.status);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall treat-map checks pass");
process.exit(failed ? 1 : 0);
