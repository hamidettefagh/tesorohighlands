// Neighbor-owned businesses (/business): a form anyone can fill in, a queue only the
// site owner sees, and the public list of what has been approved.
//
//   GET                      the approved listings (cached at the edge for a minute)
//   POST {action:"submit"}   a neighbor submits a listing; it waits for approval
//   POST {action:"status"}   the submitter's page asks what became of it, by its receipt id
//   POST {action:"list", code} and "approve" | "reject" | "save" | "remove" |
//        "confirm" | "add"   the owner's side, behind the admin code
//
// Nothing a visitor submits is shown until it has been approved, so spam can fill
// the queue at worst, and the queue is capped and rate-limited. A submission carries
// two private fields (who sent it and how to reach them) so the owner can check that
// it is a neighbor's; they are never returned by GET.
//
// Storage is the same Upstash Redis store as the treat map (_kv.js). Env:
//   ADMIN_CODE (or, if unset, TREAT_ADMIN_CODE)   the owner's code
//   NTFY_TOPIC                                     optional: ping a phone on each new submission
// With no store, every call answers 503 {error:"setup"}.

const crypto = require("crypto");
const { upstash, memoryStore, parseHash, sameCode, whoIs, send, readBody } = require("./_kv.js");

// Keys must match the CATS list in business.html (scripts/business.test.mjs checks).
const CATS = ["home", "food", "health", "kids", "pets", "pro", "beauty", "tech", "auto", "other"];
const PENDING = "biz:pending", LIVE = "biz:live";
const STALE_DAYS = 400;       // a listing not re-confirmed in about 13 months stops showing
const MAX_PENDING = 60;       // the queue can't be flooded past this
const SUBMITS_PER_HOUR = 3;   // per address
const BAD_CODES = 20;         // wrong admin codes per address before a 15-minute wait
const SITE = "https://tesorohighlands.com";

// A street number with a street ("123 Main St", or the local order, "24229 Calle
// Oruga"), or a street behind the gate by name. Listings never carry a home address.
const STREETY = /\b\d{3,6}\s+(?:[NSEW]\.?\s+)?(?:(?:Calle|Corte|Camino|Avenida|Paseo)\s+[A-Za-z]|[A-Za-z][A-Za-z ]{1,30}\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Blvd)\b)/i;
const HOME_STREET = /\b(Calle|Corte|Camino|Avenida|Paseo)\s+(la |los |las |el )?[A-Z]/;

const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const today = now => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now));
const key = name => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Turn whatever the form sent into a clean listing, or say which fields are wrong.
// `owner` is true for the site owner's own edits: no private fields or tick box needed.
function clean(raw, owner) {
  const b = raw && typeof raw === "object" ? raw : {};
  const bad = new Set(), item = {};
  item.name = str(b.name, 80); if (item.name.length < 2) bad.add("name");
  item.category = CATS.includes(b.category) ? b.category : (bad.add("category"), "");
  item.what = str(b.what, 220); if (item.what.length < 10) bad.add("what");

  const phone = str(b.phone, 25);
  if (phone) { if (/^[\d\-() +.]{7,20}$/.test(phone) && phone.replace(/\D/g, "").length >= 7) { item.phone = phone; if (b.text === true) item.text = true; } else bad.add("phone"); }
  let url = str(b.url, 200);
  if (url) {
    url = /^https?:\/\//i.test(url) ? url.replace(/^http:\/\//i, "https://") : "https://" + url;
    let host = "";
    try { const u = new URL(url); if (u.protocol === "https:" && !u.username && !u.password) host = u.hostname; } catch (e) {}
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/[\s"'<>]/.test(url)) item.url = url; else bad.add("url");
  }
  let ig = str(b.instagram, 80).replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/[/?].*$/, "");
  if (ig) { if (/^[A-Za-z0-9._]{1,30}$/.test(ig)) item.instagram = ig; else bad.add("instagram"); }
  const email = str(b.email, 120);
  if (email) { if (/^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i.test(email)) item.email = email; else bad.add("email"); }
  if (!item.phone && !item.url && !item.instagram && !item.email && !bad.has("phone") && !bad.has("url") && !bad.has("instagram") && !bad.has("email")) bad.add("reach");

  for (const [k, max] of [["license", 60], ["offer", 120], ["owner", 40], ["area", 60]]) { const v = str(b[k], max); if (v) item[k] = v; }
  for (const k of ["name", "what", "offer", "owner", "license", "area"]) if (item[k] && STREETY.test(item[k])) bad.add("address");
  if (item.area && HOME_STREET.test(item.area)) bad.add("address");
  item.community = "Tesoro Highlands";

  const by = str(b.by, 80), contact = str(b.contact, 120);
  if (!owner) {
    if (by.length < 2) bad.add("by");
    if (contact.length < 5) bad.add("contact");
    if (b.agree !== true) bad.add("agree");
  }
  if (by || contact) item.private = { by, contact };
  return { item, bad: [...bad] };
}

function isCurrent(l, now) {
  const t = Date.parse(String(l.confirmed || l.added || "") + "T12:00:00Z");
  return !isNaN(t) && (now - t) / 864e5 <= STALE_DAYS;
}
function publicList(live, now) {
  return Object.values(live).filter(l => l && l.name && l.what && isCurrent(l, now)).map(l => {
    const o = {};
    for (const k of ["name", "category", "what", "phone", "text", "url", "instagram", "email", "license", "offer", "owner", "area", "community", "added", "confirmed"]) if (l[k] !== undefined) o[k] = l[k];
    return o;
  }).sort((a, b) => a.name.localeCompare(b.name));
}
// The owner's view: everything, with ids, newest submission first.
const ownerList = (h, now) => Object.entries(h).map(([id, l]) => ({ id, ...l, stale: l.added ? !isCurrent(l, now) : undefined }))
  .sort((a, b) => (b.at || 0) - (a.at || 0) || String(a.name).localeCompare(String(b.name)));

async function ntfy(env, name) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), {
      method: "POST", body: "“" + name + "” is waiting for approval.\n" + SITE + "/business#admin",
      headers: { Title: "New business listing", Tags: "department_store", "User-Agent": "tesorohighlands.com (neighbor community site)" },
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) { /* a missed ping never fails the submission */ }
}

function makeHandler(opts) {
  const env = opts.env, store = opts.store, clock = opts.now || Date.now, notify = opts.notify || (name => ntfy(env, name));
  const adminCode = env.ADMIN_CODE || env.TREAT_ADMIN_CODE;
  return async function handler(req, res) {
    if (!store) return send(res, 503, { ok: false, error: "setup" });
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(res, 405, { ok: false, error: "method" }); }
    const now = clock();
    try {
      if (req.method === "GET") {
        const [raw] = await store.pipe([["HGETALL", LIVE]]);
        return send(res, 200, { ok: true, listings: publicList(parseHash(raw), now) }, "public, s-maxage=60, stale-while-revalidate=600");
      }

      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: "bad" }); }
      const action = String(body.action || ""), who = whoIs(req);

      if (action === "submit") {
        // A hidden field no person fills in. A bot that does is told "thanks" and dropped.
        if (str(body.hp, 50)) return send(res, 200, { ok: true });
        const { item, bad } = clean(body.item, false);
        if (bad.length) return send(res, 400, { ok: false, error: "fields", fields: bad });
        const subKey = "biz:sub:" + who;
        const [n, , rawP, rawL] = await store.pipe([["INCR", subKey], ["EXPIRE", subKey, 3600, "NX"], ["HGETALL", PENDING], ["HGETALL", LIVE]]);
        if (n > SUBMITS_PER_HOUR) return send(res, 429, { ok: false, error: "slow" });
        const pending = parseHash(rawP), live = parseHash(rawL);
        if (Object.keys(pending).length >= MAX_PENDING) return send(res, 429, { ok: false, error: "full" });
        const k = key(item.name);
        if ([...Object.values(pending), ...Object.values(live)].some(l => key(l.name) === k)) return send(res, 409, { ok: false, error: "dupe" });
        item.at = now;
        // The id doubles as the submitter's receipt: long and random, known only to them.
        const newId = crypto.randomBytes(8).toString("hex");
        await store.pipe([["HSET", PENDING, newId, JSON.stringify(item)]]);
        await notify(item.name);
        return send(res, 200, { ok: true, id: newId });
      }

      // "What became of my submission?" Waiting, on the list, or gone (rejected or removed).
      if (action === "status") {
        const sid = String(body.id || "");
        if (!/^[a-f0-9]{16}$/.test(sid)) return send(res, 200, { ok: true, state: "gone" });
        const [rawP, rawL] = await store.pipe([["HGETALL", PENDING], ["HGETALL", LIVE]]);
        const live = parseHash(rawL)[sid];
        if (live) return send(res, 200, { ok: true, state: "live", name: live.name });
        return send(res, 200, { ok: true, state: parseHash(rawP)[sid] ? "pending" : "gone" });
      }

      // Everything else is the owner's, behind the admin code.
      if (!["list", "approve", "reject", "save", "remove", "confirm", "add"].includes(action)) return send(res, 400, { ok: false, error: "bad" });
      if (!adminCode) return send(res, 503, { ok: false, error: "setup" });
      const badKey = "biz:bad:" + who;
      if (!sameCode(body.code, adminCode)) {
        const [n] = await store.pipe([["INCR", badKey], ["EXPIRE", badKey, 900, "NX"]]);
        return send(res, n > BAD_CODES ? 429 : 401, { ok: false, error: n > BAD_CODES ? "slow" : "code" });
      }
      const [badCount, rawP, rawL] = await store.pipe([["GET", badKey], ["HGETALL", PENDING], ["HGETALL", LIVE]]);
      if (+badCount > BAD_CODES) return send(res, 429, { ok: false, error: "slow" });
      const pending = parseHash(rawP), live = parseHash(rawL), id = String(body.id || "");
      const done = () => send(res, 200, { ok: true, pending: ownerList(pending, now), live: ownerList(live, now) });
      // An edit keeps what the form doesn't carry: who submitted it, and its dates.
      const merged = (old, item) => ({ ...item, private: item.private || old.private, at: old.at, added: old.added, confirmed: old.confirmed });

      if (action === "list") return done();

      if (action === "add") {
        const { item, bad } = clean(body.item, true);
        if (bad.length) return send(res, 400, { ok: false, error: "fields", fields: bad });
        const newId = crypto.randomBytes(8).toString("hex");
        live[newId] = { ...item, at: now, added: today(now), confirmed: today(now) };
        await store.pipe([["HSET", LIVE, newId, JSON.stringify(live[newId])]]);
        return done();
      }

      const from = action === "save" && body.where === "live" || action === "remove" || action === "confirm" ? live : pending;
      const cur = from[id];
      if (!cur) return send(res, 404, { ok: false, error: "gone" });

      if (action === "reject") { delete pending[id]; await store.pipe([["HDEL", PENDING, id]]); return done(); }
      if (action === "remove") { delete live[id]; await store.pipe([["HDEL", LIVE, id]]); return done(); }
      if (action === "confirm") { cur.confirmed = today(now); await store.pipe([["HSET", LIVE, id, JSON.stringify(cur)]]); return done(); }
      if (action === "save") {
        const { item, bad } = clean(body.item, true);
        if (bad.length) return send(res, 400, { ok: false, error: "fields", fields: bad });
        from[id] = merged(cur, item);
        await store.pipe([["HSET", from === live ? LIVE : PENDING, id, JSON.stringify(from[id])]]);
        return done();
      }
      // approve: the listing goes live as submitted (edit it first with "save").
      delete pending[id];
      live[id] = { ...cur, added: today(now), confirmed: today(now) };
      await store.pipe([["HSET", LIVE, id, JSON.stringify(live[id])], ["HDEL", PENDING, id]]);
      return done();
    } catch (e) {
      return send(res, 502, { ok: false, error: "store" });
    }
  };
}

module.exports = makeHandler({ env: process.env, store: upstash(process.env) });
module.exports.makeHandler = makeHandler;
module.exports.memoryStore = memoryStore;
module.exports.CATS = CATS;
