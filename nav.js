/* Tesoro Highlands — shared top nav, theme toggle, and live "right now" status.
   Injected on every page. Renders a big hero on the Home hub, a slim strip on
   other pages, and nothing on the Fire page (which has its own hero).
   Status is cached in sessionStorage for 5 min for instant paint, then
   refreshed in the background. */

/* Vercel Web Analytics + Speed Insights — both anonymous and cookieless (no
   cookies, no IP storage, no personal data, no cross-site tracking): Analytics
   counts visits/pages, Speed Insights measures real page-load performance. Each
   script route is served by Vercel only when that feature is enabled for the
   project; it 404s harmlessly elsewhere (e.g. local preview). */
(function () {
  var head = document.head || document.documentElement;
  // Web Analytics
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  var a = document.createElement("script");
  a.defer = true; a.src = "/_vercel/insights/script.js";
  head.appendChild(a);
  // Speed Insights
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
  var p = document.createElement("script");
  p.defer = true; p.src = "/_vercel/speed-insights/script.js";
  head.appendChild(p);
})();

(function () {
  "use strict";

  var path = location.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
  if (path.length > 1) path = path.replace(/\/$/, "");
  var isHome = path === "/" || path === "";
  var isFire = path === "/fire";

  var NAV = [
    { href: "/", label: "Home", on: isHome },
    { href: "/fire", label: "Fire & Emergency", on: isFire },
    { href: "/living", label: "Living Here", on: path === "/living" },
    { href: "/events", label: "Events", on: path === "/events" },
    { href: "/hoa", label: "HOA", on: path === "/hoa" }
  ];
  var BRAND =
    '<svg aria-hidden="true" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="14" fill="#14161b"/><circle cx="43" cy="21" r="6.5" fill="#e8a33d"/><path d="M3 53 L21 29 L31 41 L41 27 L61 53 Z" fill="#e7e9ee"/></svg>';

  var nav = document.createElement("nav");
  nav.className = "thnav";
  nav.setAttribute("aria-label", "Primary");
  nav.innerHTML =
    '<a class="brand" href="/">' + BRAND + "<span>Tesoro Highlands</span></a>" +
    '<div class="links">' +
    NAV.map(function (n) {
      return '<a href="' + n.href + '"' + (n.on ? ' aria-current="page"' : "") + ">" + n.label + "</a>";
    }).join("") +
    "</div>" +
    '<button class="themebtn" id="thThemeBtn" type="button"></button>';
  document.body.insertBefore(nav, document.body.firstChild);

  /* ---- theme toggle: auto → dark → light → auto ---- */
  (function () {
    var btn = document.getElementById("thThemeBtn");
    if (!btn || !window.__theme) { if (btn) btn.style.display = "none"; return; }
    var ICONS = { auto: "◐", light: "☀", dark: "☾" };
    var NEXT = { auto: "dark", dark: "light", light: "auto" };
    function label(mode) { return "Theme: " + mode.charAt(0).toUpperCase() + mode.slice(1) + " — click for " + NEXT[mode]; }
    function paint() {
      var m = window.__theme.get();
      btn.textContent = ICONS[m];
      btn.title = label(m);
      btn.setAttribute("aria-label", label(m));
    }
    btn.addEventListener("click", function () { window.__theme.set(NEXT[window.__theme.get()]); paint(); });
    paint();
  })();

  /* ---- live status ---- */
  function haversine(la1, lo1, la2, lo2) {
    var R = 3958.8, t = function (x) { return x * Math.PI / 180; };
    var dla = t(la2 - la1), dlo = t(lo2 - lo1);
    var h = Math.sin(dla / 2) * Math.sin(dla / 2) + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function loc() {
    try { var s = JSON.parse(localStorage.getItem("tesoro.loc")); if (s && s.lat && s.lon) return { lat: s.lat, lon: s.lon }; } catch (e) {}
    return { lat: 34.478, lon: -118.531 };
  }

  var CACHE_KEY = "tesoro.status.v1";
  var stripEl = null;

  async function computeStatus() {
    var L = loc(), lvl = 0, text = "";
    var okAir = false, okAlerts = false, okFires = false, okEvac = false;
    // The checks race each other, so choose what to SAY by priority rather than by
    // whichever request happened to land last: an evacuation outranks a fire, and
    // a fire outranks the air it is busy smoking up.
    var said = -1;
    function say(prio, level, msg) { lvl = Math.max(lvl, level); if (prio > said) { said = prio; text = msg; } }
    var jobs = [
      fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + L.lat + "&longitude=" + L.lon + "&current=us_aqi&timezone=America%2FLos_Angeles").then(function (r) { return r.json(); }).then(function (a) {
        var aqi = a.current && a.current.us_aqi;
        if (aqi == null) return; okAir = true;
        if (aqi > 150) { say(80, 2, "Air is unhealthy (AQI " + Math.round(aqi) + ") — limit time outside."); }
        else if (aqi > 100) { say(40, 1, "Air unhealthy for sensitive groups (AQI " + Math.round(aqi) + ")."); }
      }).catch(function () {}),
      fetch("https://api.weather.gov/alerts/active?point=" + L.lat + "," + L.lon, { headers: { Accept: "application/geo+json" } }).then(function (r) { return r.json(); }).then(function (al) {
        if (!al || !al.features) return; okAlerts = true;
        var evs = al.features.map(function (f) { return f.properties && f.properties.event; }).filter(Boolean);
        var red = evs.find(function (e) { return /red flag|fire weather/i.test(e); });
        var heat = evs.find(function (e) { return /heat/i.test(e); });
        var warn = evs.find(function (e) { return /warning/i.test(e) && !/heat/i.test(e); });
        if (red) { say(60, 1, red + " in effect — elevated fire danger."); }
        else if (heat) { say(30, 1, heat + " — hydrate and plan around the heat."); }
        else if (warn) { say(20, 1, warn + " in effect."); }
      }).catch(function () {}),
      Promise.all([
        fetch("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=" + encodeURIComponent("IncidentTypeCategory='WF' AND FireOutDateTime IS NULL AND (PercentContained < 100 OR PercentContained IS NULL)") + "&outFields=IncidentName,IncidentSize,ModifiedOnDateTime_dt&geometry=" + (L.lon - 1.3) + "," + (L.lat - 1) + "," + (L.lon + 1.3) + "," + (L.lat + 1) + "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outSR=4326&f=geojson").then(function (r) { return r.json(); }),
        // This strip only speaks up at 50+ acres, and the federal feed leaves local
        // fires unsized — so without CAL FIRE the hero silently missed a 58-acre
        // fire five miles away. See /api/calfire.
        fetch("/api/calfire").then(function (r) { return r.json(); }).catch(function () { return null; })
      ]).then(function (res) {
        var f = res[0], cal = (res[1] && res[1].fires) || [];
        if (!f || !f.features) return; okFires = true;
        function nrm(s) { return String(s || "").toUpperCase().replace(/\bFIRE\b/g, " ").replace(/[^A-Z0-9]/g, ""); }
        var fires = f.features.filter(function (ft) { return ft.geometry && ft.geometry.coordinates; }).map(function (ft) {
          var c = ft.geometry.coordinates, p = ft.properties || {};
          var acres = p.IncidentSize, mod = p.ModifiedOnDateTime_dt;
          for (var i = 0; i < cal.length; i++) {
            var cf = cal[i];
            if (cf.acres == null || nrm(cf.name) !== nrm(p.IncidentName)) continue;
            if (cf.lat == null || cf.lon == null || haversine(c[1], c[0], cf.lat, cf.lon) > 15) continue;  // same name, but ours?
            var cu = cf.updated ? Date.parse(cf.updated) : NaN;
            // CAL FIRE wins on gaps and when it's fresher: the federal feed often
            // freezes a local fire at its dispatch-time 0.1 acres and walks away,
            // which would keep it under this strip's 50-acre bar forever.
            if (acres == null || acres === 0 || (!isNaN(cu) && (mod == null || cu >= mod))) acres = cf.acres;
            if (!isNaN(cu) && (mod == null || cu > mod)) mod = cu;
            break;
          }
          return { name: p.IncidentName, acres: acres || 0, mod: mod, d: haversine(L.lat, L.lon, c[1], c[0]) };
        }).filter(function (x) {
          // Sizable and still being reported on — a record nobody has touched in two
          // days is a fire that's out but never got flagged out.
          return x.acres >= 50 && (x.mod == null || (Date.now() - x.mod) < 48 * 3600 * 1000);
        }).sort(function (a, b) { return a.d - b.d; });
        if (fires[0] && fires[0].d <= 15) {
          var nm = String(fires[0].name || "").toLowerCase().replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); });
          say(70, 1, nm + " Fire ~" + fires[0].d.toFixed(0) + " mi away — stay aware.");
        }
      }).catch(function () {}),
      fetch("https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query?where=1%3D1&geometry=" + (L.lon - 0.35) + "," + (L.lat - 0.35) + "," + (L.lon + 0.35) + "," + (L.lat + 0.35) + "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=STATUS,NOTES&returnGeometry=true&outSR=4326&f=json").then(function (r) { return r.json(); }).then(function (ev) {
        if (!ev || ev.error || !ev.features) return; okEvac = true;
        // "Our zone" means home is INSIDE the polygon — a zone merely inside the
        // search box gets distance-and-direction wording instead (a warning 13 mi
        // away in another county is context, not "your area").
        function inPoly(px, py, rings) {
          var inside = false;
          for (var r = 0; r < rings.length; r++) {
            var g = rings[r];
            for (var i = 0, j = g.length - 1; i < g.length; j = i++) {
              var xi = g[i][0], yi = g[i][1], xj = g[j][0], yj = g[j][1];
              if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
            }
          }
          return inside;
        }
        var COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
        var zones = [];
        for (var i = 0; i < ev.features.length; i++) {
          var f = ev.features[i], a = f.attributes || {}, rings = (f.geometry && f.geometry.rings) || [];
          var st = String(a.STATUS || "");
          var isOrder = /order/i.test(st), isWarn = /warning/i.test(st);
          if ((!isOrder && !isWarn) || !rings.length) continue;
          var cx = 0, cy = 0, n = 0;
          for (var r2 = 0; r2 < rings.length; r2++) for (var p = 0; p < rings[r2].length; p++) { cx += rings[r2][p][0]; cy += rings[r2][p][1]; n++; }
          cx /= n; cy /= n;
          var yb = Math.sin((cx - L.lon) * Math.PI / 180) * Math.cos(cy * Math.PI / 180);
          var xb = Math.cos(L.lat * Math.PI / 180) * Math.sin(cy * Math.PI / 180) - Math.sin(L.lat * Math.PI / 180) * Math.cos(cy * Math.PI / 180) * Math.cos((cx - L.lon) * Math.PI / 180);
          zones.push({
            order: isOrder,
            covers: inPoly(L.lon, L.lat, rings),
            dist: haversine(L.lat, L.lon, cy, cx),
            dir: COMPASS[Math.round(((Math.atan2(yb, xb) * 180 / Math.PI + 360) % 360) / 22.5) % 16],
            notes: String(a.NOTES || "").trim()
          });
        }
        zones.sort(function (a, b) { return a.dist - b.dist; });
        var covOrder = null, covWarn = null, nearOrder = null, nearWarn = null;
        for (var k = 0; k < zones.length; k++) {
          var z = zones[k];
          if (z.order) { if (z.covers && !covOrder) covOrder = z; if (!nearOrder) nearOrder = z; }
          else { if (z.covers && !covWarn) covWarn = z; if (!nearWarn) nearWarn = z; }
        }
        if (covOrder) { say(100, 2, "EVACUATION ORDER for our zone — leave now."); }
        else if (covWarn) { say(90, 1, "Evacuation WARNING includes our zone" + (covWarn.notes ? " (" + covWarn.notes + ")" : "") + " — be packed and ready."); }
        else if (nearOrder) { say(50, 1, "Evacuation ORDER ~" + Math.round(nearOrder.dist) + " mi to our " + nearOrder.dir + (nearOrder.notes ? " (" + nearOrder.notes + ")" : "") + " — not our zone; stay aware."); }
        else if (nearWarn) { say(50, 1, "Evacuation warning ~" + Math.round(nearWarn.dist) + " mi " + nearWarn.dir + " of us" + (nearWarn.notes ? " (" + nearWarn.notes + ")" : "") + " — not our zone."); }
      }).catch(function () {})
    ];
    await Promise.allSettled(jobs);

    var okCount = [okAir, okAlerts, okFires, okEvac].filter(Boolean).length;
    if (lvl === 0) {
      if (okCount === 4) text = "All clear — air is good and no active alerts.";
      else if (okCount === 0) return { level: "neutral", text: "Live status unavailable right now — open the dashboard for details." };
      else return { level: "neutral", text: "No alerts in the live checks that loaded (" + okCount + "/4) — see the dashboard." };
    }
    return { level: lvl >= 2 ? "danger" : lvl >= 1 ? "caution" : "ok", text: text };
  }

  function render(st) {
    if (isFire) return; // fire page shows the full hero itself
    if (isHome) {
      var hero = document.getElementById("th-hero");
      if (!hero) return;
      hero.className = "hub-hero " + st.level;
      hero.innerHTML =
        '<div class="eyebrow">Right now in Tesoro Highlands</div>' +
        '<div class="htext">' + st.text + "</div>" +
        '<a class="hlink" href="/fire">Open the full fire &amp; emergency dashboard &rarr;</a>';
    } else {
      if (!stripEl) {
        stripEl = document.createElement("a");
        stripEl.href = "/fire";
        nav.parentNode.insertBefore(stripEl, nav.nextSibling);
      }
      stripEl.className = "thstrip " + st.level;
      stripEl.innerHTML = '<span class="dot"></span><span class="txt">' + st.text + '</span><span class="arrow">Fire &amp; Emergency &rarr;</span>';
    }
  }

  if (!isFire) {
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (c && c.st && Date.now() - c.ts < 5 * 60 * 1000) render(c.st);
    } catch (e) {}
    computeStatus().then(function (st) {
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), st: st })); } catch (e) {}
      render(st);
    }).catch(function () {});
  }
})();
