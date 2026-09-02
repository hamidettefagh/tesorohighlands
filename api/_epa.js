const PM25_BREAKPOINTS = [
  { cLo: 0.0, cHi: 9.0, iLo: 0, iHi: 50 },
  { cLo: 9.1, cHi: 35.4, iLo: 51, iHi: 100 },
  { cLo: 35.5, cHi: 55.4, iLo: 101, iHi: 150 },
  { cLo: 55.5, cHi: 125.4, iLo: 151, iHi: 200 },
  { cLo: 125.5, cHi: 225.4, iLo: 201, iHi: 300 },
  { cLo: 225.5, cHi: 325.4, iLo: 301, iHi: 400 },
  { cLo: 325.5, cHi: 500.4, iLo: 401, iHi: 500 }
];

function correctAtmPm25(x, rh) {
  if (rh == null || rh === "" || (typeof rh === "number" && Number.isNaN(rh))) return null;
  const xv = Number(x);
  const RH = Number(rh);
  if (!Number.isFinite(xv) || xv < 0) return null;
  if (!Number.isFinite(RH) || RH < 0 || RH > 100) return null;
  let y;
  if (xv < 30) y = 0.524 * xv - 0.0862 * RH + 5.75;
  else if (xv < 50) {
    const w = xv / 20 - 3 / 2;
    y = (0.786 * w + 0.524 * (1 - w)) * xv - 0.0862 * RH + 5.75;
  } else if (xv < 210) y = 0.786 * xv - 0.0862 * RH + 5.75;
  else if (xv < 260) {
    const w = xv / 50 - 21 / 5;
    y =
      (0.69 * w + 0.786 * (1 - w)) * xv -
      0.0862 * RH * (1 - w) +
      2.966 * w +
      5.75 * (1 - w) +
      8.84e-4 * xv * xv * w;
  } else y = 2.966 + 0.69 * xv + 8.84e-4 * xv * xv;
  if (!Number.isFinite(y)) return null;
  return Math.max(0, y);
}

function aqiFromPm25(pm25) {
  const c = Number(pm25);
  if (!Number.isFinite(c) || c < 0) return null;
  const truncated = Math.floor(c * 10) / 10;
  for (const bp of PM25_BREAKPOINTS) {
    if (truncated >= bp.cLo && truncated <= bp.cHi) {
      const aqi = ((bp.iHi - bp.iLo) / (bp.cHi - bp.cLo)) * (truncated - bp.cLo) + bp.iLo;
      return Math.round(aqi);
    }
  }
  if (truncated > 500.4) return 500;
  return null;
}

module.exports = { correctAtmPm25, aqiFromPm25, PM25_BREAKPOINTS };
