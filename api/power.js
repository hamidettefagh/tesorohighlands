// Live power status for the houses behind the gate, from SCE's own outage map
// data: is our circuit shut off (or about to be, or coming back), and is there a
// repair outage near our streets. The site's status strip, home page and Fire
// page read this; the edge caches it for a minute, so however many neighbors are
// checking, SCE sees about one request a minute from us.
//
//   GET /api/power  ->  { ok, checkedAt, ours: {...} | null, outages: [...] }
//
// ok:false means SCE couldn't be read: the pages say "unknown", never "power on".

const { send } = require("./_kv.js");
const P = require("./_power.js");

const UA = { "User-Agent": "tesorohighlands.com power status (neighbor community site)" };
const NEAR_OUTAGE_MI = 1.5;   // a repair outage this close may be ours; SCE only gives a point, not an area

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

async function read() {
  const [watch, off, outs] = await Promise.all([features(pspsUrl(0)), features(pspsUrl(1)), features(outageUrl())]);
  const recs = P.pspsRecords([
    ...watch.map((f) => ({ layer: 0, a: f.attributes || {}, rings: (f.geometry && f.geometry.rings) || [] })),
    ...off.map((f) => ({ layer: 1, a: f.attributes || {}, rings: (f.geometry && f.geometry.rings) || [] })),
  ]);
  return { recs, outs };
}

module.exports = async function handler(req, res) {
  try {
    let { recs, outs } = await read();
    // SCE's layers read empty for a moment while SCE refreshes them; a second look
    // a beat later tells that apart from "nothing going on".
    if (!recs.length) { await new Promise((r) => setTimeout(r, 1500)); ({ recs, outs } = await read()); }

    const mine = P.ourRecords(recs);
    const lead = mine[0];
    let ours = null;
    if (lead) {
      const stage = P.pspsStage(lead);
      const starts = mine.map((r) => r.start).filter(Boolean), ends = mine.map((r) => r.end).filter(Boolean);
      ours = {
        stage,                                     // off | restoring | expected | watch | restored
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

    send(res, 200, { ok: true, checkedAt: new Date().toISOString(), ours, outages },
      "public, max-age=0, s-maxage=60, stale-while-revalidate=120");
  } catch (e) {
    send(res, 502, { ok: false, checkedAt: new Date().toISOString(), error: "SCE's outage data didn't answer" },
      "public, max-age=0, s-maxage=20");
  }
};
