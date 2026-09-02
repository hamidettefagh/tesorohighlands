// Tiny zero-dependency static server for the Tesoro Highlands site (local dev only).
const http = require("http");
const fs = require("fs");
const path = require("path");

const { demoPurpleair, demoHistory, demoForecast } = require("./scripts/weather-demo-payloads.js");

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
  });
