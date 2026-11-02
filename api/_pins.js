// The house-pin map behind /treats (Halloween) and /lights (holiday lights): neighbors
// behind the gate mark their own house on a map of the lots. One handler, two
// configurations (api/treats.js and api/lights.js); the pages differ, the rules don't.
//
// Neighbors only. Every call carries the neighbor code (shared in the community
// WhatsApp groups); without it this returns nothing, not even the house outlines.
// The code keeps the maps off search engines and out of casual view. It is not a
// vault, and the pages say so. Both maps share one code (TREAT_CODE) and one admin
// code (TREAT_ADMIN_CODE), so a neighbor enters one code for both.
//
// What's stored, per house: the choice (cfg.how), the extras (cfg.flags), an
// "until" time (cfg.until), an on/off switch, and a hash of the random token the
// adding phone made up. No names, addresses or phone numbers. Only that phone (or
// the admin code) can change or remove the pin. Each map keeps its pins under its
// own key, and everything expires when its season closes (cfg.season).
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
const PER_PHONE = 1;      // one house per phone; the admin code can add houses for neighbors who ask
// The limits key on the address, and phones on one carrier can share an address,
// so they are generous: the point is to blunt a script, not to count neighbors.
const BAD_CODES = 20;     // wrong codes per address before a 15-minute wait
const WRITES = 120;       // changes per address per 10 minutes
const NEW_PINS = 6;       // new houses per address per hour (the admin code is exempt)

const validToken = t => typeof t === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(t);

function publicPins(cfg, all) {
  const out = {};
  for (const id in all) {
    if (!HOME_IDS.has(id)) continue;
    const p = all[id], o = { how: p.how, until: p.until || "", out: !!p.out, t: p.t };
    for (const f of cfg.flags) o[f] = !!p[f];
    out[id] = o;
  }
  return out;
}
const mineOf = (all, own) => own ? Object.keys(all).filter(id => all[id].own === own) : [];

// cfg: { key, how, until, flags, season }
//   key     the map's name, prefixing its Redis keys ("treats", "lights")
//   how     the allowed values of a pin's main choice
//   until   the allowed "until" times ("" allowed means "no set time")
//   flags   the extra yes/no fields a pin carries
//   season  now -> { year, open, close, phase, ...extra }; extra fields (such as
//           the treat map's "night") are returned to the page as they are
function makeHandler(opts) {
  const cfg = opts.cfg, env = opts.env, store = opts.store, clock = opts.now || Date.now;
  return async function handler(req, res) {
    if (!store || !env.TREAT_CODE) return send(res, 503, { ok: false, error: "setup" });
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(res, 405, { ok: false, error: "method" }); }

    const now = clock(), S = cfg.season(now);
    const { year, open, close, phase, ...extra } = S;
    const KEY = cfg.key + ":" + year + ":pins";
    const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
    const who = hash("ip", ip), badKey = cfg.key + ":bad:" + who, writeKey = cfg.key + ":w:" + who, newKey = cfg.key + ":new:" + who;
    const state = all => ({ ok: true, role, phase, ...extra, closes: new Date(close).toISOString(), pins: publicPins(cfg, all) });

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
        return send(res, 200, { ...state(all), mine: mineOf(all, own), homes: skipHomes ? undefined : DATA });
      }

      // POST: add, change or remove one house.
      if (phase !== "open") return send(res, 403, { ok: false, error: phase });
      if (!own) return send(res, 400, { ok: false, error: "token" });
      const home = String(body.home || "");
      if (!HOME_IDS.has(home)) return send(res, 400, { ok: false, error: "home" });
      const action = body.action === "remove" ? "remove" : "set";
      let pin = null;
      if (action === "set") {
        const until = body.until == null ? "" : String(body.until);
        if (!cfg.how.includes(body.how) || !cfg.until.includes(until)) return send(res, 400, { ok: false, error: "fields" });
        pin = { how: body.how, until, out: !!body.out, t: now };
        for (const f of cfg.flags) pin[f] = !!body[f];
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
        await store.pipe([["HSET", KEY, home, JSON.stringify(pin)], ["EXPIREAT", KEY, Math.floor(close / 1000)]]);
        all[home] = pin;
      }
      return send(res, 200, { ...state(all), mine: mineOf(all, own) });
    } catch (e) {
      return send(res, 502, { ok: false, error: "store" });
    }
  };
}

// What each map's module exports: the live handler, plus the pieces server.js and
// the tests use to run it against the in-memory store with a fake clock.
function mapModule(cfg) {
  const make = opts => makeHandler({ ...opts, cfg });
  const live = make({ env: process.env, store: upstash(process.env) });
  live.makeHandler = make;
  live.memoryStore = memoryStore;
  live.season = cfg.season;
  live.cfg = cfg;
  return live;
}

module.exports = { makeHandler, mapModule, memoryStore };
