// Tests for the holiday lights map API (api/lights.js): its own choices and
// season, and that it shares the rules (and nothing else) with the treat map.
// Runs the real handler against its in-memory store with a fake clock, so
// nothing touches Redis. The shared rules themselves (the code, who can change
// which pin, the limits) are covered by scripts/treats.test.mjs.
//
//   node scripts/lights.test.mjs

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const api = require(path.join(ROOT, "api", "lights.js"));
const treats = require(path.join(ROOT, "api", "treats.js"));
const DATA = require(path.join(ROOT, "api", "_treat-homes.js"));

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("ok   " + name);
  else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}

const PT = s => Date.parse(s); // ISO strings with an explicit Pacific offset
let now = PT("2026-12-10T18:00:00-08:00");
const clock = () => now;
const ENV = { TREAT_CODE: "pumpkin", TREAT_ADMIN_CODE: "big-pumpkin" };

function fresh(store) {
  return api.makeHandler({ env: ENV, store: store || api.memoryStore(clock), now: clock });
}
async function call(h, { method = "GET", code, token, body, ip = "10.0.0.1", url = "/api/lights" } = {}) {
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
const set = (home, extra) => ({ action: "set", home, how: "lights", music: false, until: "", ...extra });

// --- no code needed; the admin code still works
{
  const h = fresh();
  const ok = await call(h, {});
  check("no code opens the lights map as a neighbor", ok.status === 200 && ok.json.role === "neighbor" && ok.json.phase === "open", ok.json);
  check("it serves the same houses", ok.json.homes && ok.json.homes.homes.length === DATA.homes.length);
  check("no Halloween 'night' in the answer", !("night" in ok.json), Object.keys(ok.json));
  check("responses are never cached and never indexed", ok.headers["cache-control"] === "no-store" && ok.headers["x-robots-tag"] === "noindex");
  const saved = await call(h, { code: "pumpkin" });
  check("a phone with the treat-map code saved is still a neighbor", saved.status === 200 && saved.json.role === "neighbor", saved.json);
  const wrong = await call(h, { code: "guess" });
  check("a wrong code (an admin guess) is refused", wrong.status === 401 && wrong.json.error === "code", wrong.status);
  const admin = await call(h, { code: "big-pumpkin" });
  check("the admin code is recognized", admin.json.role === "admin");
  const noNeighborCode = await call(api.makeHandler({ env: { TREAT_ADMIN_CODE: "big-pumpkin" }, store: api.memoryStore(clock), now: clock }), {});
  check("works without a neighbor code configured", noNeighborCode.status === 200 && noNeighborCode.json.role === "neighbor", noNeighborCode.status);
  const noStore = await call(api.makeHandler({ env: ENV, store: null, now: clock }), {});
  check("no store configured: 503 setup", noStore.status === 503 && noStore.json.error === "setup", noStore.status);
  const add = await call(h, { method: "POST", token: A, body: set(ids[30]) });
  check("adding a house needs no code either", add.status === 200 && add.json.pins[ids[30]], add.status);
}

// --- a lights pin
{
  const h = fresh();
  const home = ids[10], home2 = ids[11];
  const bad = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "knock" }) });
  check("a Halloween choice is refused here", bad.status === 400 && bad.json.error === "fields", bad.status);
  const badUntil = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { until: "19:30" }) });
  check("a treat-map 'until' time is refused here", badUntil.status === 400, badUntil.status);
  const add = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(home, { how: "display", music: true, until: "22:00", teal: true }) });
  check("phone A adds a house with a display, set to music, lights on until 10", add.status === 200 && add.json.pins[home].how === "display" && add.json.pins[home].music === true && add.json.pins[home].until === "22:00", add.json);
  check("a treat-map extra (teal) isn't stored", !("teal" in add.json.pins[home]), add.json.pins[home]);
  check("the owner hash never leaves the server", !JSON.stringify(add.json).includes('"own"'));
  const plain = await call(h, { method: "POST", code: "pumpkin", token: B, body: set(home2) });
  check("phone B adds plain lights, no set time", plain.status === 200 && plain.json.pins[home2].how === "lights" && plain.json.pins[home2].until === "" && plain.json.pins[home2].music === false, plain.json);
  const steal = await call(h, { method: "POST", code: "pumpkin", token: B, body: set(home) });
  check("phone B can't change A's house", steal.status === 409 && steal.json.error === "taken", steal.status);
  const fix = await call(h, { method: "POST", code: "big-pumpkin", token: ADMIN_PHONE, body: set(home, { how: "lights" }) });
  check("the admin can fix anyone's pin", fix.status === 200 && fix.json.pins[home].how === "lights", fix.status);
  const two = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[12]) });
  check("one house per phone", two.status === 409 && two.json.error === "limit", two.status);
  const del = await call(h, { method: "POST", code: "pumpkin", token: A, body: { action: "remove", home } });
  check("phone A takes its house off when the lights come down", del.status === 200 && !del.json.pins[home], del.status);
}

// --- the two maps keep their pins apart, even in one store. Their seasons never
// overlap, so each handler gets its own clock inside its season; the store's clock
// (which only decides expiry) stays in October so neither pin expires.
{
  const october = PT("2026-10-20T18:00:00-07:00");
  const store = api.memoryStore(() => october);
  const lights = api.makeHandler({ env: ENV, store, now: () => PT("2026-12-10T18:00:00-08:00") });
  const tmap = treats.makeHandler({ env: ENV, store, now: () => october });
  await call(tmap, { method: "POST", code: "pumpkin", token: A, body: { action: "set", home: ids[5], how: "knock", until: "" }, url: "/api/treats" });
  await call(lights, { method: "POST", code: "pumpkin", token: A, body: set(ids[6]) });
  const t = await call(tmap, { code: "pumpkin", token: A, url: "/api/treats" }), l = await call(lights, { code: "pumpkin", token: A });
  check("a treat-map pin doesn't show on the lights map", !l.json.pins[ids[5]] && l.json.pins[ids[6]], Object.keys(l.json.pins));
  check("a lights pin doesn't show on the treat map", t.json.pins[ids[5]] && !t.json.pins[ids[6]], Object.keys(t.json.pins));
  check("one house per phone counts per map", l.json.mine.length === 1 && t.json.mine.length === 1);
}

// --- the season: Nov 1 through New Year's Day, named for the year it opens in
{
  const s = api.season;
  check("Oct 31, 11:59 PM Pacific: not yet", s(PT("2026-10-31T23:59:00-07:00")).phase === "before");
  check("Nov 1, 12:00 AM Pacific: open", s(PT("2026-11-01T00:00:00-07:00")).phase === "open" && s(PT("2026-11-01T00:00:00-07:00")).year === 2026);
  check("Christmas: open", s(PT("2026-12-25T19:00:00-08:00")).phase === "open");
  check("New Year's Day, 11:59 PM Pacific: still open, same season", s(PT("2027-01-01T23:59:00-08:00")).phase === "open" && s(PT("2027-01-01T23:59:00-08:00")).year === 2026);
  check("Jan 2, 12:00 AM Pacific: waiting for next November", s(PT("2027-01-02T00:00:00-08:00")).phase === "before" && s(PT("2027-01-02T00:00:00-08:00")).year === 2027);
  check("pins expire at the close", new Date(s(PT("2026-12-10T12:00:00-08:00")).close).toISOString() === "2027-01-02T08:00:00.000Z");
  check("next year rolls over on its own", s(PT("2027-11-15T12:00:00-08:00")).year === 2027 && s(PT("2027-11-15T12:00:00-08:00")).phase === "open");

  now = PT("2027-01-01T22:00:00-08:00");
  const h = fresh();
  const add = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[3]) });
  check("adding on New Year's night works", add.status === 200, add.status);
  now = PT("2027-01-02T00:00:01-08:00");
  const shut = await call(h, { method: "POST", code: "pumpkin", token: A, body: set(ids[4]) });
  check("after that, no more changes until November", shut.status === 403 && shut.json.error === "before", shut.status);
  const view = await call(h, { code: "pumpkin" });
  check("...and every pin is gone", view.status === 200 && view.json.phase === "before" && Object.keys(view.json.pins).length === 0, view.json.pins);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall lights-map checks pass");
process.exit(failed ? 1 : 0);
