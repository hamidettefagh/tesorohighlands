// Tiny zero-dependency static server for the Tesoro Highlands site (local dev only).
const http = require("http");
const fs = require("fs");
const path = require("path");

const { demoPurpleair, demoHistory, demoForecast } = require("./scripts/weather-demo-payloads.js");

// Halloween treat map and holiday lights map APIs, with an in-memory store so
// /treats and /lights work locally. Local-only codes: TREAT_CODE (default
// "pumpkin"; the lights map needs none), TREAT_ADMIN_CODE (default "pumpkin-admin").
// TREAT_NOW=2026-11-01T00:30:00-07:00 sets the server clock, to try a map before
// it opens or after it closes.
const treatNow = process.env.TREAT_NOW ? () => Date.parse(process.env.TREAT_NOW) : Date.now;
const mapEnv = { TREAT_CODE: process.env.TREAT_CODE || "pumpkin", TREAT_ADMIN_CODE: process.env.TREAT_ADMIN_CODE || "pumpkin-admin" };
const treatsMod = require("./api/treats.js");
const treatsApi = treatsMod.makeHandler({ env: mapEnv, store: treatsMod.memoryStore(treatNow), now: treatNow });
const lightsMod = require("./api/lights.js");
const lightsApi = lightsMod.makeHandler({ env: mapEnv, store: lightsMod.memoryStore(treatNow), now: treatNow });

// Neighbor-owned businesses API, same in-memory store idea. The local admin code is
// TREAT_ADMIN_CODE (default "pumpkin-admin"); submissions vanish on restart.
const bizMod = require("./api/business.js");
const bizApi = bizMod.makeHandler({
  env: { TREAT_ADMIN_CODE: process.env.TREAT_ADMIN_CODE || "pumpkin-admin" },
  store: bizMod.memoryStore(),
  notify: async name => console.log("[business] new submission waiting for approval: " + name),
});

// Live SCE power status for our circuit: the real handler, reading SCE's live data,
// with neighbor check-ins kept in memory (they vanish on restart).
const powerApi = require("./api/power.js").makeHandler({ store: require("./api/_kv.js").memoryStore() });

const dir = __dirname;
const port = process.env.PORT || 3100;
const liveFeeds = process.env.WEATHER_LIVE === "1";

function sendJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/api/treats") return treatsApi(req, res);
    if (p === "/api/lights") return lightsApi(req, res);
    if (p === "/api/business") return bizApi(req, res);
    if (p === "/api/power") return powerApi(req, res);
    if (!liveFeeds) {
      if (p === "/api/purpleair") return sendJson(res, demoPurpleair());
      if (p === "/api/tempest-forecast") return sendJson(res, demoForecast());
      if (p === "/purpleair-history.json") return sendJson(res, demoHistory());
    }
    if (p === "/" || p === "") p = "/index.html";
    let fp = path.join(dir, p);
    if (!fp.startsWith(dir)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (!path.extname(fp)) fp += ".html"; // clean URLs: /fire -> fire.html
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": types[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, () => {
    console.log("Tesoro Highlands running on http://localhost:" + port);
    if (!liveFeeds) console.log("Local dummy weather feeds on (WEATHER_LIVE=1 to disable)");
    console.log("Treat map (/treats) and lights map (/lights) codes, local only: neighbor \"" + mapEnv.TREAT_CODE + "\", admin \"" + mapEnv.TREAT_ADMIN_CODE + "\"");
  });
