/* Tesoro Highlands — shared top nav + live "right now" safety status.
   Injected on every page. Renders a big hero on the Home hub, a slim strip
   on other pages, and nothing on the Fire page (which has its own hero). */
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
    '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="14" fill="#14161b"/><circle cx="43" cy="21" r="6.5" fill="#e8a33d"/><path d="M3 53 L21 29 L31 41 L41 27 L61 53 Z" fill="#e7e9ee"/></svg>';

  var nav = document.createElement("nav");
  nav.className = "thnav";
  nav.innerHTML =
    '<a class="brand" href="/">' + BRAND + "<span>Tesoro Highlands</span></a>" +
    '<div class="links">' +
    NAV.map(function (n) {
      return '<a href="' + n.href + '"' + (n.on ? ' aria-current="page"' : "") + ">" + n.label + "</a>";
    }).join("") +
    "</div>";
  document.body.insertBefore(nav, document.body.firstChild);

  function haversine(la1, lo1, la2, lo2) {
    var R = 3958.8, t = function (x) { return x * Math.PI / 180; };
    var dla = t(la2 - la1), dlo = t(lo2 - lo1);
    var h = Math.sin(dla / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function loc() {
    try { var s = JSON.parse(localStorage.getItem("tesoro.loc")); if (s && s.lat && s.lon) return { lat: s.lat, lon: s.lon }; } catch (e) {}
    return { lat: 34.478, lon: -118.531 };
  }

  // Compact live status: worst of air / NWS alerts / nearby fire / evacuation.
  async function computeStatus() {
    var L = loc(), lvl = 0, text = "All clear — air is good and no active alerts.";
    var jobs = [
      fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + L.lat + "&longitude=" + L.lon + "&current=us_aqi&timezone=America%2FLos_Angeles").then(function (r) { return r.json(); }).then(function (a) {
        var aqi = a.current && a.current.us_aqi;
        if (aqi > 150) { lvl = Math.max(lvl, 2); text = "Air is unhealthy (AQI " + Math.round(aqi) + ") — limit time outside."; }
        else if (aqi > 100) { lvl = Math.max(lvl, 1); text = "Air unhealthy for sensitive groups (AQI " + Math.round(aqi) + ")."; }
      }).catch(function () {}),
      fetch("https://api.weather.gov/alerts/active?point=" + L.lat + "," + L.lon, { headers: { Accept: "application/geo+json" } }).then(function (r) { return r.json(); }).then(function (al) {
        var evs = (al.features || []).map(function (f) { return f.properties && f.properties.event; }).filter(Boolean);
        var red = evs.find(function (e) { return /red flag|fire weather/i.test(e); });
        var warn = evs.find(function (e) { return /warning/i.test(e); });
        if (red) { lvl = Math.max(lvl, 1); text = red + " in effect — elevated fire danger."; }
        else if (warn && lvl < 1) { lvl = 1; text = warn + " in effect."; }
      }).catch(function () {}),
      fetch("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=" + encodeURIComponent("IncidentTypeCategory='WF'") + "&outFields=IncidentName,IncidentSize&geometry=" + (L.lon - 1.3) + "," + (L.lat - 1) + "," + (L.lon + 1.3) + "," + (L.lat + 1) + "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outSR=4326&f=geojson").then(function (r) { return r.json(); }).then(function (f) {
        var fires = (f.features || []).map(function (ft) {
          var c = ft.geometry.coordinates;
          return { name: ft.properties.IncidentName, acres: ft.properties.IncidentSize || 0, d: haversine(L.lat, L.lon, c[1], c[0]) };
        }).filter(function (x) { return x.acres >= 50; }).sort(function (a, b) { return a.d - b.d; });
        if (fires[0] && fires[0].d <= 15) { lvl = Math.max(lvl, 1); text = fires[0].name + " Fire ~" + fires[0].d.toFixed(0) + " mi away — stay aware."; }
      }).catch(function () {}),
      fetch("https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query?where=1%3D1&geometry=" + (L.lon - 0.35) + "," + (L.lat - 0.35) + "," + (L.lon + 0.35) + "," + (L.lat + 0.35) + "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=STATUS&returnGeometry=false&f=json").then(function (r) { return r.json(); }).then(function (ev) {
        var zs = (ev.features || []).map(function (x) { return x.attributes.STATUS || ""; });
        if (zs.some(function (s) { return /order/i.test(s); })) { lvl = 2; text = "EVACUATION ORDER active for your area — act now."; }
        else if (zs.some(function (s) { return /warning/i.test(s); })) { lvl = Math.max(lvl, 1); text = "Evacuation WARNING for your area — be ready."; }
      }).catch(function () {})
    ];
    await Promise.allSettled(jobs);
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
      var strip = document.createElement("a");
      strip.className = "thstrip " + st.level;
      strip.href = "/fire";
      strip.innerHTML = '<span class="dot"></span><span class="txt">' + st.text + '</span><span class="arrow">Fire &amp; Emergency &rarr;</span>';
      nav.parentNode.insertBefore(strip, nav.nextSibling);
    }
  }

  if (!isFire) computeStatus().then(render).catch(function () {});
})();
