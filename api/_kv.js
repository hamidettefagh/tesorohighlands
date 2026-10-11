// Shared by the endpoints that keep a little state (api/treats.js, api/business.js):
// the Upstash Redis store over its REST API (no npm dependencies), an in-memory
// stand-in with the same commands for local dev and the tests, and the small
// request/response helpers both endpoints use.
//
// Env: KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN).

const crypto = require("crypto");

function upstash(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async pipe(cmds) {
      const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error("store " + r.status);
      return (await r.json()).map(o => { if (o && o.error) throw new Error("store: " + o.error); return o && o.result; });
    },
  };
}

// Same commands, in memory: local dev (server.js) and the tests.
function memoryStore(clock) {
  const now = clock || Date.now;
  const db = new Map();
  const get = k => { const e = db.get(k); if (e && e.exp && e.exp <= now()) { db.delete(k); return undefined; } return e; };
  const ops = {
    GET: k => { const e = get(k); return e ? String(e.v) : null; },
    INCR: k => { let e = get(k); if (!e) db.set(k, (e = { v: 0 })); return ++e.v; },
    EXPIRE: (k, s, nx) => { const e = get(k); if (!e || (nx === "NX" && e.exp)) return 0; e.exp = now() + s * 1000; return 1; },
    EXPIREAT: (k, t) => { const e = get(k); if (!e) return 0; e.exp = t * 1000; return 1; },
    HGETALL: k => { const e = get(k); return e ? Object.entries(e.v).flat() : []; },
    HSET: (k, f, v) => { let e = get(k); if (!e) db.set(k, (e = { v: {} })); const n = f in e.v ? 0 : 1; e.v[f] = v; return n; },
    HDEL: (k, f) => { const e = get(k); if (!e || !(f in e.v)) return 0; delete e.v[f]; return 1; },
  };
  return { async pipe(cmds) { return cmds.map(([op, ...a]) => ops[op](...a)); } };
}

// HGETALL comes back as a flat [field, value, ...] list over REST.
function parseHash(raw) {
  const out = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) { try { out[raw[i]] = JSON.parse(raw[i + 1]); } catch (e) {} }
  else if (raw && typeof raw === "object") for (const k in raw) { try { out[k] = typeof raw[k] === "string" ? JSON.parse(raw[k]) : raw[k]; } catch (e) {} }
  return out;
}

const norm = s => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, "");
// Codes compare without regard to case or spaces, and in constant time.
function sameCode(given, want) {
  if (!want || !norm(given)) return false;
  const a = crypto.createHash("sha256").update(norm(given)).digest();
  const b = crypto.createHash("sha256").update(norm(want)).digest();
  return crypto.timingSafeEqual(a, b);
}
const hash = (salt, s) => crypto.createHash("sha256").update(salt + "|" + s).digest("hex").slice(0, 24);
// The caller's address, hashed: rate limits key on it without storing the address.
const whoIs = req => hash("ip", String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim());

function send(res, status, obj, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache || "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  let s = "";
  for await (const c of req) { s += c; if (s.length > 4096) throw new Error("too big"); }
  return s ? JSON.parse(s) : {};
}

module.exports = { upstash, memoryStore, parseHash, norm, sameCode, hash, whoIs, send, readBody };
