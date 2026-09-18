// CAL FIRE incident proxy.
//
// Why this exists: the federal WFIGS feed (which the page reads directly) opens a
// stub record for fast local county fires and often never fills in acreage or
// containment — the Pointe Fire sat at null/null for hours while CAL FIRE had it
// at 58 acres / 32% contained. CAL FIRE's own API has the real numbers but sends
// no Access-Control-Allow-Origin, so a browser can't read it. This fetches it
// server-side and re-serves a trimmed copy the page can use.
//
// Cached at the CDN edge, so this function actually runs about once every two
// minutes no matter how many neighbors have the page open.
//
// 2026-09-18: CAL FIRE's API stopped answering — not an error, a hang. With no
// timeout here this function hung with it, and every page waiting on it sat at
// "status unknown". Now a hang fails like an error, within 7 s, and the miss is
// cached for a minute so neighbors don't each pay that wait.

const SRC = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");

  try {
    const upstream = await fetch(SRC, {
      headers: { "User-Agent": "tesorohighlands.com (neighbor community site)", Accept: "application/json" },
      signal: AbortSignal.timeout(7000)
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);

    const raw = await upstream.json();
    const list = Array.isArray(raw) ? raw : raw.Incidents || [];

    const fires = list
      .filter(i => i && i.IsActive !== false && i.Latitude && i.Longitude)
      .map(i => ({
        name: i.Name,
        county: i.County,
        lat: i.Latitude,
        lon: i.Longitude,
        acres: i.AcresBurned,
        contained: i.PercentContained,
        started: i.Started,
        updated: i.Updated,
        url: i.Url
      }));

    res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), source: "CAL FIRE", fires: fires });
  } catch (e) {
    // Non-fatal by design: the page keeps whatever the federal feed gave it.
    // 200 + a short cache (not a 502, which the CDN won't cache) so an outage costs
    // one slow request a minute per region instead of one per page view.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({ ok: false, error: "CAL FIRE feed unavailable", fires: [] });
  }
};
