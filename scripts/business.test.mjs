// Tests for the neighbor-owned business list (api/business.js): what a visitor can
// submit, that nothing shows until the owner approves it, that private details never
// reach the public list, and the limits. Runs the real handler against the in-memory
// store with a fake clock, so nothing touches Redis or sends a phone ping.
//
//   node scripts/business.test.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const api = require(path.join(ROOT, "api", "business.js"));
const page = fs.readFileSync(path.join(ROOT, "business.html"), "utf8");

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); } };

let now = Date.parse("2026-10-11T18:00:00-07:00");
const clock = () => now;
const ENV = { TREAT_ADMIN_CODE: "big-pumpkin" };
const pings = [];
const fresh = (env = ENV, store = api.memoryStore(clock)) => api.makeHandler({ env, store, now: clock, notify: async n => { pings.push(n); } });
async function call(h, { method = "POST", body, ip = "10.0.0.1" } = {}) {
  const req = { method, url: "/api/business", headers: { "x-forwarded-for": ip }, body: method === "POST" ? body : undefined, socket: {} };
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(s) { this.body = s; } };
  await h(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}
const good = extra => ({ name: "Sample Plumbing", category: "home", what: "Leaks, water heaters and repipes.", phone: "661-555-0100", by: "Pat Neighbor", contact: "pat@example.com", agree: true, ...extra });
const submit = (h, item, opt) => call(h, { body: { action: "submit", item }, ...opt });
const admin = (h, action, extra, code = "big-pumpkin") => call(h, { body: { action, code, ...extra } });
const names = r => r.json.listings.map(l => l.name);

// --- the page and the API agree on categories
{
  const block = /var CATS = \[([\s\S]*?)\n    \];/.exec(page);
  const pageCats = block ? [...block[1].matchAll(/\["([a-z]+)"/g)].map(m => m[1]) : [];
  check("the page and the API list the same categories", JSON.stringify(pageCats) === JSON.stringify(api.CATS), { pageCats, api: api.CATS });
}

// --- not set up
{
  const r = await call(api.makeHandler({ env: ENV, store: null, now: clock }), { method: "GET" });
  check("no store configured: 503 setup", r.status === 503 && r.json.error === "setup", r.status);
  const noCode = await admin(fresh({}), "list");
  check("no admin code configured: the owner's side is off", noCode.status === 503, noCode.status);
}

// --- submit -> queue -> approve -> public
{
  const h = fresh();
  const empty = await call(h, { method: "GET" });
  check("the public list starts empty", empty.status === 200 && empty.json.listings.length === 0);
  check("the public list is cached at the edge", /s-maxage=\d+/.test(empty.headers["cache-control"]), empty.headers["cache-control"]);

  const s = await submit(h, good());
  check("a neighbor submits a listing and gets a receipt", s.status === 200 && s.json.ok === true && /^[a-f0-9]{16}$/.test(s.json.id), s.json);
  const state = async id => (await call(h, { body: { action: "status", id } })).json.state;
  check("their page can ask: it is waiting", await state(s.json.id) === "pending");
  check("a made-up receipt says nothing useful", await state("0123456789abcdef") === "gone" && await state("nope") === "gone");
  check("submitting is never cached", s.headers["cache-control"] === "no-store");
  check("the owner's phone is pinged once", pings.length === 1 && pings[0] === "Sample Plumbing", pings);
  const after = await call(h, { method: "GET" });
  check("a submission is NOT public until approved", after.json.listings.length === 0, names(after));

  const q = await admin(h, "list");
  check("the owner sees it waiting, with who sent it", q.status === 200 && q.json.pending.length === 1 && q.json.pending[0].private.contact === "pat@example.com", q.json);
  const id = q.json.pending[0].id;

  const noCode = await call(h, { body: { action: "list" } });
  check("the queue needs the admin code", noCode.status === 401, noCode.status);
  const wrong = await admin(h, "approve", { id }, "guess");
  check("approving needs the admin code", wrong.status === 401, wrong.status);

  const fixed = await admin(h, "save", { id, where: "pending", item: { ...good(), name: "Sample Plumbing Co.", license: "CSLB #1234567" } });
  check("the owner can fix a submission before approving", fixed.status === 200 && fixed.json.pending[0].name === "Sample Plumbing Co." && fixed.json.pending[0].private.by === "Pat Neighbor", fixed.json.pending);

  const ok = await admin(h, "approve", { id });
  check("the owner approves it", ok.status === 200 && ok.json.pending.length === 0 && ok.json.live.length === 1, ok.json);
  const pub = await call(h, { method: "GET" });
  check("an approved listing is public", names(pub).join() === "Sample Plumbing Co.", names(pub));
  const st = (await call(h, { body: { action: "status", id: s.json.id } })).json;
  check("their page learns it is on the list, under its tidied name", st.state === "live" && st.name === "Sample Plumbing Co.", st);
  check("private details never reach the public list", !/private|pat@example|Pat Neighbor|"id"/.test(JSON.stringify(pub.json)), pub.json);
  check("it is dated the day it was approved, Pacific time", pub.json.listings[0].added === "2026-10-11" && pub.json.listings[0].confirmed === "2026-10-11", pub.json.listings[0]);

  const dupe = await submit(h, good({ name: "sample plumbing CO" }), { ip: "10.0.0.2" });
  check("the same business can't be submitted twice", dupe.status === 409 && dupe.json.error === "dupe", dupe.status);

  // a year and a bit later
  now += 401 * 864e5;
  const stale = await call(h, { method: "GET" });
  check("a listing not re-confirmed in 13 months stops showing", stale.json.listings.length === 0, names(stale));
  const still = await admin(h, "list");
  check("...but the owner still sees it, flagged", still.json.live.length === 1 && still.json.live[0].stale === true, still.json.live);
  const re = await admin(h, "confirm", { id });
  const back = await call(h, { method: "GET" });
  check("re-confirming brings it back", re.status === 200 && back.json.listings.length === 1, names(back));
  const gone = await admin(h, "remove", { id });
  check("the owner can take a listing down", gone.status === 200 && gone.json.live.length === 0 && (await call(h, { method: "GET" })).json.listings.length === 0);
  check("...and their page learns it is gone", await state(s.json.id) === "gone");
  now = Date.parse("2026-10-11T18:00:00-07:00");
}

// --- reject, and the owner adding one directly
{
  const h = fresh();
  await submit(h, good({ name: "Junk Listing" }));
  const q = await admin(h, "list");
  const r = await admin(h, "reject", { id: q.json.pending[0].id });
  check("a rejected submission is deleted", r.status === 200 && r.json.pending.length === 0 && r.json.live.length === 0, r.json);
  const again = await admin(h, "approve", { id: q.json.pending[0].id });
  check("acting on something already handled says so", again.status === 404 && again.json.error === "gone", again.status);
  const add = await admin(h, "add", { item: { name: "Added By Owner", category: "food", what: "Cakes and cookie boxes.", instagram: "@addedbyowner" } });
  check("the owner can add a listing without the private fields", add.status === 200 && add.json.live.length === 1 && add.json.live[0].instagram === "addedbyowner", add.json);
  check("...and it is public straight away", names(await call(h, { method: "GET" })).join() === "Added By Owner");
}

// --- what the form accepts
{
  const h = fresh();
  const bad = async (item, want, label) => { const r = await submit(h, item, { ip: "10.1." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250) }); check(label, r.status === 400 && r.json.fields.includes(want), r.json); };
  await bad(good({ name: "" }), "name", "a name is required");
  await bad(good({ category: "plumbing" }), "category", "the category must be one of the list");
  await bad(good({ what: "Hi" }), "what", "what-you-do needs a real sentence");
  await bad(good({ phone: "" }), "reach", "at least one way to reach the business is required");
  await bad(good({ phone: "call me" }), "phone", "a phone number must look like one");
  await bad(good({ email: "not-an-email" }), "email", "an email must look like one");
  await bad(good({ url: "javascript:alert(1)" }), "url", "a link can't be a script");
  await bad(good({ instagram: "has spaces" }), "instagram", "an Instagram handle must look like one");
  await bad(good({ what: "Come by 24229 Calle Oruga any time." }), "address", "no street address in the description");
  await bad(good({ area: "Corte Parillada" }), "address", "no neighborhood street as the work area");
  await bad(good({ offer: "Visit us at 123 Main Street" }), "address", "no street address in the offer");
  await bad(good({ by: "" }), "by", "the sender's name is required");
  await bad(good({ contact: "" }), "contact", "a way to confirm with the sender is required");
  await bad(good({ agree: false }), "agree", "the sender must tick the box");
  const none = await admin(h, "list");
  check("nothing invalid reached the queue", none.json.pending.length === 0, none.json.pending.length);

  const tidy = await submit(h, good({ name: "  Tidy   Co  ", url: "http://tidy.example.com/page", instagram: "https://www.instagram.com/tidyco/", area: "Comes to you", text: true }));
  const got = (await admin(h, "list")).json.pending[0];
  check("links are tidied: https, and a bare Instagram handle", tidy.status === 200 && got.name === "Tidy Co" && got.url === "https://tidy.example.com/page" && got.instagram === "tidyco" && got.text === true, got);
  const before = pings.length;
  const bot = await call(h, { body: { action: "submit", hp: "http://spam.example", item: good({ name: "Spam Bot" }) }, ip: "10.7.7.7" });
  check("a bot filling the hidden field is thanked and dropped", bot.status === 200 && (await admin(h, "list")).json.pending.length === 1 && pings.length === before, bot.status);
}

// --- limits
{
  const h = fresh();
  let r;
  for (let i = 0; i < 4; i++) r = await submit(h, good({ name: "Flood " + i }), { ip: "10.3.3.3" });
  check("the 4th submission in an hour from one address waits", r.status === 429 && r.json.error === "slow", r.status);
  const other = await submit(h, good({ name: "Someone Else" }), { ip: "10.4.4.4" });
  check("other neighbors can still submit", other.status === 200, other.status);

  const h2 = fresh();
  let last;
  for (let i = 0; i < 61; i++) last = await submit(h2, good({ name: "Queue " + i }), { ip: "10.8." + i + ".1" });
  check("the approval queue is capped at 60", last.status === 429 && last.json.error === "full" && (await admin(h2, "list")).json.pending.length === 60, last.status);

  const h3 = fresh();
  for (let i = 0; i < 20; i++) await call(h3, { body: { action: "list", code: "guess" + i }, ip: "10.9.9.9" });
  const locked = await call(h3, { body: { action: "list", code: "guess-21" }, ip: "10.9.9.9" });
  check("the 21st wrong admin code in 15 minutes waits", locked.status === 429, locked.status);
  const right = await call(h3, { body: { action: "list", code: "big-pumpkin" }, ip: "10.9.9.9" });
  check("...and so does the right code from that address", right.status === 429, right.status);
  check("the admin code ignores case and spaces", (await admin(h3, "list", {}, " Big-Pumpkin ")).status === 200);
  const own = api.makeHandler({ env: { ADMIN_CODE: "its-own", TREAT_ADMIN_CODE: "big-pumpkin" }, store: api.memoryStore(clock), now: clock, notify: async () => {} });
  check("ADMIN_CODE, when set, replaces the treat map's admin code", (await admin(own, "list", {}, "its-own")).status === 200 && (await admin(own, "list")).status === 401);
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall business-list checks pass");
process.exit(failed ? 1 : 0);
