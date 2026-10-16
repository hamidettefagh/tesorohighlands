// Tests for the live power endpoint (api/power.js): SCE's view passes through, and
// the neighbor check-ins ("my power's back" / "still out") count the way the pages
// expect. Runs the real handler with an in-memory store, a fake clock and a fake
// SCE answer, so nothing touches SCE or Redis.
//
//   node scripts/power.test.mjs

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const api = require(path.join(ROOT, "api", "power.js"));
const { memoryStore } = require(path.join(ROOT, "api", "_kv.js"));

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); } };

let now = Date.parse("2026-10-15T19:40:00-07:00");
const clock = () => now;
const OFF = { ours: { stage: "restoring", circuit: "Orion", wholeNeighborhood: true, ert: Date.parse("2026-10-17T05:00:00-07:00") }, outages: [] };
const fresh = (sce = async () => OFF, store = memoryStore(clock)) => api.makeHandler({ store, now: clock, sce });
async function call(h, { method = "GET", body, ip = "10.0.0.1" } = {}) {
  const req = { method, url: "/api/power", headers: { "x-forwarded-for": ip }, body: method === "POST" ? body : undefined, socket: {} };
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(s) { this.body = s; } };
  await h(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}
const tok = (n) => "device-token-" + String(n).padStart(8, "0");
const say = (h, state, n, ip) => call(h, { method: "POST", body: { state, token: tok(n) }, ip: ip || "10.1." + n + ".1" });

// --- SCE's view passes through, cached briefly at the edge
{
  const h = fresh();
  const r = await call(h);
  check("SCE's status for our circuit comes through", r.status === 200 && r.json.ok && r.json.ours.stage === "restoring" && r.json.ours.circuit === "Orion", r.json);
  check("no check-ins yet", r.json.reports && r.json.reports.on === 0 && r.json.reports.off === 0 && r.json.reports.verdict === null, r.json.reports);
  check("cached 30 s at the edge", /s-maxage=30/.test(r.headers["cache-control"]), r.headers["cache-control"]);
  const down = await call(fresh(async () => { throw new Error("SCE down"); }));
  check("SCE unreadable: ok false, briefly cached, never 'power on'", down.status === 502 && down.json.ok === false && !("ours" in down.json) && /s-maxage=20/.test(down.headers["cache-control"]), down);
  const noStore = await call(api.makeHandler({ store: null, now: clock, sce: async () => OFF }));
  check("without the database, the status still loads (no check-ins)", noStore.status === 200 && noStore.json.reports === null, noStore.json);
  const noStorePost = await call(api.makeHandler({ store: null, now: clock, sce: async () => OFF }), { method: "POST", body: { state: "on", token: tok(1) } });
  check("without the database, a check-in says so", noStorePost.status === 503, noStorePost.status);
}

// --- check-ins
{
  const h = fresh();
  const one = await say(h, "on", 1);
  check("a neighbor says their power is back", one.status === 200 && one.json.reports.on === 1 && one.json.reports.verdict === "mixed", one.json);
  check("check-ins are never cached", one.headers["cache-control"] === "no-store");
  await say(h, "on", 2);
  const three = await say(h, "on", 3);
  check("three say it's back: back for most of us", three.json.reports.verdict === "back" && three.json.reports.on === 3, three.json.reports);
  const out1 = await say(h, "off", 4);
  check("one still out against three back: still mostly back", out1.json.reports.verdict === "back" && out1.json.reports.off === 1, out1.json.reports);
  const out2 = await say(h, "off", 5);
  check("two still out against three back: mixed", out2.json.reports.verdict === "mixed", out2.json.reports);
  const changed = await say(h, "on", 4);
  check("a neighbor changing their answer counts once", changed.json.reports.on === 4 && changed.json.reports.off === 1 && changed.json.reports.verdict === "back", changed.json.reports);
  const seen = await call(h);
  check("everyone's page sees the tally", seen.json.reports.on === 4 && seen.json.reports.verdict === "back", seen.json.reports);

  now += 2 * 3600 * 1000 + 60000;
  const later = await call(h);
  check("check-ins older than two hours stop counting", later.json.reports.on === 0 && later.json.reports.verdict === null, later.json.reports);
  now = Date.parse("2026-10-15T19:40:00-07:00");
}

// --- what's refused
{
  const h = fresh();
  const bad = async (body, label) => { const r = await call(h, { method: "POST", body }); check(label, r.status === 400, r.status); };
  await bad({ state: "maybe", token: tok(1) }, "a check-in is 'on' or 'off', nothing else");
  await bad({ state: "on", token: "short" }, "a check-in needs a real device token");
  await bad({ state: "on", token: "<script>alert(1)</script>xxxxxxxx" }, "a token can't carry markup");
  let last;
  for (let i = 0; i < 7; i++) last = await say(h, "on", 100 + i, "10.9.9.9");
  check("the 7th check-in in an hour from one address waits", last.status === 429, last.status);
  const tally = (await call(h)).json.reports;
  check("...so one address can't stuff the count past 6", tally.on === 6, tally);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall power checks pass");
process.exit(failed ? 1 : 0);
