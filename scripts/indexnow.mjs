// Tell IndexNow (Bing, DuckDuckGo, Yandex and others) that pages are new or changed.
//
//   node scripts/indexnow.mjs              every URL in sitemap.xml
//   node scripts/indexnow.mjs /holidays    just these paths
//
// Run it after the change is live. The key below is public by design: the same value is
// served at /<key>.txt, which is how the search engines confirm the site sent the ping.
// Google does not use IndexNow. For a new page, also open Search Console, paste the URL
// into "Inspect any URL" and press "Request indexing".
import fs from "node:fs";

const HOST = "tesorohighlands.com";
const KEY = "fc6aefb138293ec09242c5e391d2e353";

const args = process.argv.slice(2);
const urls = args.length
  ? args.map((p) => "https://" + HOST + (p.startsWith("/") ? p : "/" + p))
  : [...fs.readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8").matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

const res = await fetch("https://api.indexnow.org/IndexNow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log(`IndexNow answered ${res.status} for ${urls.length} URL(s):\n  ${urls.join("\n  ")}`);
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
