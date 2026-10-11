// Halloween treat map (/treats): neighbors behind the gate mark their house as
// "knock for candy" or "candy out front", and flip to "out of candy" on the night.
//
// Neighbors only. Every call carries the neighbor code (shared in the community
// WhatsApp groups); without it this returns nothing, not even the house outlines.
// The code keeps the map off search engines and out of casual view. It is not a
// vault, and the page says so.
//
// What's stored, per house: how to get candy, the extras, a "handing out until"
// time, the out-of-candy switch, and a hash of the random token the adding phone
// made up. No names, addresses or phone numbers. Only that phone (or the admin
// code) can change or remove the pin. Everything expires at midnight after
// Halloween, Pacific time.
//
// Storage is Upstash Redis (Vercel Marketplace), through the shared store in
// _kv.js. Env:
//   TREAT_CODE                         the neighbor code
//   TREAT_ADMIN_CODE                   optional: can edit or remove any pin
//   KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN), see _kv.js
// With either missing, every call answers 503 {error:"setup"} and the page says
// the map isn't open yet.

const { upstash, memoryStore, parseHash: parsePins, norm, sameCode, hash, send, readBody } = require("./_kv.js");
const DATA = require("./_treat-homes.js");

const HOME_IDS = new Set(DATA.homes.map(h => h[0]));
const HOW = ["knock", "bowl"];
const UNTIL = ["", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]; // "" = until it runs out
const PER_PHONE = 1;      // one house per phone; the admin code can add houses for neighbors who ask
// The limits key on the address, and phones on one carrier can share an address,
// so they are generous: the point is to blunt a script, not to count neighbors.
const BAD_CODES = 20;     // wrong codes per address before a 15-minute wait
const WRITES = 120;       // changes per address per 10 minutes
const NEW_PINS = 6;       // new houses per address per hour (the admin code is exempt)

// The map opens Oct 1 and closes at midnight after Halloween, Pacific time.
// Midnight on Nov 1 is always still daylight time (it ends the first Sunday of
// November at 2 AM), so both edges are UTC-7.
function season(now) {
  const year = new Date(now - 7 * 3600e3).getUTCFullYear();
  const open = Date.UTC(year, 9, 1, 7), close = Date.UTC(year, 10, 1, 7);
  return { year, open, close, night: year + "-10-31", phase: now < open ? "before" : now < close ? "open" : "closed" };
}

const validToken = t => typeof t === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(t);

function publicPins(all) {
  const out = {};
  for (const id in all) {
    if (!HOME_IDS.has(id)) continue;
    const p = all[id];
    out[id] = { how: p.how, teal: !!p.teal, decor: !!p.decor, until: p.until || "", out: !!p.out, t: p.t };
  }
  return out;
}
const mineOf = (all, own) => own ? Object.keys(all).filter(id => all[id].own === own) : [];

function makeHandler(opts) {
  const env = opts.env, store = opts.store, clock = opts.now || Date.now;
  return async function handler(req, res) {
    if (!store || !env.TREAT_CODE) return send(res, 503, { ok: false, error: "setup" });
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(res, 405, { ok: false, error: "method" }); }

    const now = clock(), S = season(now);
    const KEY = "treats:" + S.year + ":pins";
    const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
    const who = hash("ip", ip), badKey = "treats:bad:" + who, writeKey = "treats:w:" + who, newKey = "treats:new:" + who;

    let body = {};
    if (req.method === "POST") { try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: "bad" }); } }
    // Header values must be plain ASCII, so the page sends the code URI-encoded.
    let code = body.code;
    if (req.method === "GET") { code = String(req.headers["x-treat-code"] || ""); try { code = decodeURIComponent(code); } catch (e) {} }
    const token = req.method === "POST" ? body.token : req.headers["x-treat-token"];
    const role = sameCode(code, env.TREAT_ADMIN_CODE) ? "admin" : sameCode(code, env.TREAT_CODE) ? "neighbor" : null;
    const own = validToken(token) ? hash("own", token) : "";

    try {
      // No code at all is the page asking whether the map is set up, not a guess.
      if (!role && !norm(code)) return send(res, 401, { ok: false, error: "code" });
      if (!role) {
        const [n] = await store.pipe([["INCR", badKey], ["EXPIRE", badKey, 900, "NX"]]);
        return send(res, n > BAD_CODES ? 429 : 401, { ok: false, error: n > BAD_CODES ? "slow" : "code" });
      }

      if (req.method === "GET") {
        const [bad, raw] = await store.pipe([["GET", badKey], ["HGETALL", KEY]]);
        if (+bad > BAD_CODES) return send(res, 429, { ok: false, error: "slow" });
        const all = parsePins(raw);
        const skipHomes = /[?&]homes=0\b/.test(req.url || "");
        return send(res, 200, {
          ok: true, role, phase: S.phase, night: S.night, closes: new Date(S.close).toISOString(),
          pins: publicPins(all), mine: mineOf(all, own), homes: skipHomes ? undefined : DATA,
        });
      }

      // POST: add, change or remove one house.
      if (S.phase !== "open") return send(res, 403, { ok: false, error: S.phase });
      if (!own) return send(res, 400, { ok: false, error: "token" });
      const home = String(body.home || "");
      if (!HOME_IDS.has(home)) return send(res, 400, { ok: false, error: "home" });
      const action = body.action === "remove" ? "remove" : "set";
      let pin = null;
      if (action === "set") {
        const until = body.until == null ? "" : String(body.until);
        if (!HOW.includes(body.how) || !UNTIL.includes(until)) return send(res, 400, { ok: false, error: "fields" });
        pin = { how: body.how, teal: !!body.teal, decor: !!body.decor, until, out: !!body.out, t: now };
      }

      const [bad, writes, , raw] = await store.pipe([["GET", badKey], ["INCR", writeKey], ["EXPIRE", writeKey, 600, "NX"], ["HGETALL", KEY]]);
      if (+bad > BAD_CODES || writes > WRITES) return send(res, 429, { ok: false, error: "slow" });
      const all = parsePins(raw), cur = all[home];
      if (cur && cur.own !== own && role !== "admin") return send(res, 409, { ok: false, error: "taken" });

      if (action === "remove") {
        if (cur) { await store.pipe([["HDEL", KEY, home]]); delete all[home]; }
      } else {
        if (!cur && role !== "admin" && mineOf(all, own).length >= PER_PHONE) return send(res, 409, { ok: false, error: "limit" });
        if (!cur && role !== "admin") {
          const [n] = await store.pipe([["INCR", newKey], ["EXPIRE", newKey, 3600, "NX"]]);
          if (n > NEW_PINS) return send(res, 429, { ok: false, error: "slow" });
        }
        // An admin fixing someone's pin leaves it in their hands.
        pin.own = cur && cur.own ? cur.own : own;
        await store.pipe([["HSET", KEY, home, JSON.stringify(pin)], ["EXPIREAT", KEY, Math.floor(S.close / 1000)]]);
        all[home] = pin;
      }
      return send(res, 200, { ok: true, role, phase: S.phase, night: S.night, closes: new Date(S.close).toISOString(), pins: publicPins(all), mine: mineOf(all, own) });
    } catch (e) {
      return send(res, 502, { ok: false, error: "store" });
    }
  };
}

module.exports = makeHandler({ env: process.env, store: upstash(process.env) });
module.exports.makeHandler = makeHandler;
module.exports.memoryStore = memoryStore;
module.exports.season = season;
