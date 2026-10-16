// Live power status for the houses behind the gate, from SCE's own outage map
// data: is our circuit shut off (or about to be, or coming back), and is there a
// repair outage near our streets. The site's status strip, home page and Fire
// page read this every minute; the edge caches it for 30 seconds, so however many
// neighbors are checking, SCE sees about two requests a minute from us.
//
// SCE's map lags homes that already have power, so neighbors can also check in
// ("my power's back" / "still out"). Reports are anonymous (a hashed per-device
// token), count for two hours, and an address can send only a few an hour.
//
//   GET  /api/power  ->  { ok, checkedAt, ours: {...} | null, outages: [...], reports }
//   POST /api/power  { state: "on" | "off", token }  ->  { ok, reports }
//
// reports: { on, off, verdict } where verdict is "back" (most who checked in have
// power), "mixed", or null. ok:false means SCE couldn't be read: the pages say
// "unknown", never "power on".

const { send, upstash, parseHash, hash, whoIs, readBody } = require("./_kv.js");
const P = require("./_power.js");

const UA = { "User-Agent": "tesorohighlands.com power status (neighbor community site)" };
const NEAR_OUTAGE_MI = 1.5;            // a repair outage this close may be ours; SCE only gives a point, not an area
const KEY = "power:reports";           // hashed device -> {s: "on" | "off", t}
const FRESH_MS = 2 * 3600 * 1000;      // a check-in counts for two hours
const KEEP_S = 12 * 3600;              // the whole list goes 12 hours after the last check-in
const PER_HOUR = 6;                    // check-ins one address can send in an hour
// "Back for most of us": at least this many say so, and they outnumber "still out" 3 to 1.
const BACK_MIN = 3;

async function features(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("SCE " + r.status);
  const j = await r.json();
  if (!j || j.error || !Array.isArray(j.features)) throw new Error("SCE answered without data");
  return j.features;
}

const pspsUrl = (layer) => `${P.PSPS}/${layer}/query?where=1%3D1&geometry=${P.ENVELOPE}` +
  "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
  "&outFields=OBJECTID,CIRCUIT_NAME,PSPS,PSPS_Details,StartDate,EndDate,ERT,DateDeEnergized,EditDate" +
  "&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0001&f=json";
const outageUrl = () => `${P.OUTAGES}/query?where=1%3D1&geometry=${P.MID.lon - 0.035},${P.MID.lat - 0.03},${P.MID.lon + 0.035},${P.MID.lat + 0.03}` +
  "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
  "&outFields=NoOfAffectedCust_Inci,OutageStartDateTime,LastChngDateTime,ERT,MemoCauseCdDesc,CrewStatusCdDesc,JobStatus,IncidentType" +
  "&returnGeometry=true&outSR=4326&f=json";

async function readOnce() {
  const [watch, off, outs] = await Promise.all([features(pspsUrl(0)), features(pspsUrl(1)), features(outageUrl())]);
  const recs = P.pspsRecords([
    ...watch.map((f) => ({ layer: 0, a: f.attributes || {}, rings: (f.geometry && f.geometry.rings) || [] })),
    ...off.map((f) => ({ layer: 1, a: f.attributes || {}, rings: (f.geometry && f.geometry.rings) || [] })),
  ]);
  return { recs, outs };
}

// SCE's view: our circuit's step, and repair outages near our streets.
async function readSce() {
  let { recs, outs } = await readOnce();
  // SCE's layers read empty for a moment while SCE refreshes them; a second look
  // a beat later tells that apart from "nothing going on".
  if (!recs.length) { await new Promise((r) => setTimeout(r, 1500)); ({ recs, outs } = await readOnce()); }

  const mine = P.ourRecords(recs);
  const lead = mine[0];
  let ours = null;
  if (lead) {
    const starts = mine.map((r) => r.start).filter(Boolean), ends = mine.map((r) => r.end).filter(Boolean);
    ours = {
      stage: P.pspsStage(lead),                  // off | restoring | expected | watch | restored
      circuit: lead.name || P.OUR_CIRCUIT,
      wholeNeighborhood: lead.covers >= P.STREETS.length,
      ert: lead.ert || null,                     // SCE's estimated restoration (ms)
      offSince: lead.offSince || null,           // when SCE shut it off, if it says
      updated: lead.edited || null,              // when SCE last changed this record
      windowStart: starts.length ? Math.min(...starts) : null,   // the period of concern, for a watch
      windowEnd: ends.length ? Math.max(...ends) : null,
    };
  }
  const outages = outs.map((f) => {
    const a = f.attributes || {}, g = f.geometry || {};
    const dist = P.haversine(P.MID.lat, P.MID.lon, g.y, g.x);
    return { dist: Math.round(dist * 10) / 10, dir: P.bearingWord(P.MID.lat, P.MID.lon, g.y, g.x),
      customers: a.NoOfAffectedCust_Inci || null, since: a.OutageStartDateTime || null, ert: a.ERT || null,
      cause: (a.MemoCauseCdDesc || "").trim() || null, crew: (a.CrewStatusCdDesc || "").trim() || null };
  }).filter((o) => o.dist <= NEAR_OUTAGE_MI && isFinite(o.dist)).sort((x, y) => x.dist - y.dist).slice(0, 3);
  return { ours, outages };
}

// The neighbor check-ins from the last two hours.
function tally(raw, now) {
  let on = 0, off = 0;
  for (const v of Object.values(parseHash(raw))) {
    if (!v || typeof v.t !== "number" || now - v.t > FRESH_MS) continue;
    if (v.s === "on") on++; else if (v.s === "off") off++;
  }
  const verdict = on >= BACK_MIN && on >= 3 * off ? "back" : on || off ? "mixed" : null;
  return { on, off, verdict };
}

function makeHandler({ store, now = Date.now, sce = readSce } = {}) {
  return async function handler(req, res) {
    if (req.method === "POST") {
      if (!store) return send(res, 503, { ok: false, error: "setup" });
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: "bad" }); }
      const state = body && body.state, token = String((body && body.token) || "");
      if ((state !== "on" && state !== "off") || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return send(res, 400, { ok: false, error: "bad" });
      try {
        const rl = "power:rl:" + whoIs(req);
        const [n] = await store.pipe([["INCR", rl], ["EXPIRE", rl, 3600, "NX"]]);
        if (n > PER_HOUR) return send(res, 429, { ok: false, error: "slow" });
        const t = now();
        const out = await store.pipe([["HSET", KEY, hash("pow", token), JSON.stringify({ s: state, t })], ["EXPIRE", KEY, KEEP_S], ["HGETALL", KEY]]);
        return send(res, 200, { ok: true, reports: tally(out[2], t) });
      } catch (e) {
        return send(res, 502, { ok: false, error: "store" });
      }
    }

    const [sceR, repR] = await Promise.allSettled([sce(), store ? store.pipe([["HGETALL", KEY]]) : Promise.resolve(null)]);
    const reports = repR.status === "fulfilled" && repR.value ? tally(repR.value[0], now()) : null;
    const checkedAt = new Date(now()).toISOString();
    if (sceR.status !== "fulfilled") {
      return send(res, 502, { ok: false, checkedAt, error: "SCE's outage data didn't answer", reports }, "public, max-age=0, s-maxage=20");
    }
    send(res, 200, { ok: true, checkedAt, ...sceR.value, reports }, "public, max-age=0, s-maxage=30, stale-while-revalidate=30");
  };
}

module.exports = makeHandler({ store: upstash(process.env) });
module.exports.makeHandler = makeHandler;
module.exports.tally = tally;
