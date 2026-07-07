// Refreshes events.json with local Santa Clarita headlines from public RSS feeds.
// Run by .github/workflows/refresh-events.yml on a ~30-minute schedule; also
// runnable locally: node scripts/fetch-events.mjs
// Writes the file only when content actually changed, so no-op runs produce no commit.

import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../events.json", import.meta.url);
const UA = "Mozilla/5.0 (compatible; TesoroHighlandsBot/1.0; +https://tesorohighlands.com)";
const MAX_ITEMS = 24;

const SOURCES = [
  { name: "KHTS", url: "https://www.hometownstation.com/feed/", drop: [] },
  { name: "The Signal", url: "https://signalscv.com/feed/", drop: [/nation\/world/i, /opinion/i, /sponsored/i] },
];

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}
function tags(block, name) {
  return [...block.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => decode(m[1]));
}

async function fetchSource(src) {
  const res = await fetch(src.url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${src.name}: HTTP ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items
    .map((b) => ({
      title: tag(b, "title"),
      url: tag(b, "link"),
      published: new Date(tag(b, "pubDate") || 0).toISOString(),
      source: src.name,
      categories: tags(b, "category"),
    }))
    .filter((it) => it.title && it.url)
    .filter((it) => !src.drop.some((rx) => it.categories.some((c) => rx.test(c))))
    .map(({ categories, ...it }) => it);
}

const results = await Promise.allSettled(SOURCES.map(fetchSource));
const news = [];
const errors = [];
for (let i = 0; i < results.length; i++) {
  if (results[i].status === "fulfilled") news.push(...results[i].value);
  else errors.push(`${SOURCES[i].name}: ${results[i].reason?.message || results[i].reason}`);
}
if (news.length === 0) {
  console.error("All sources failed:", errors.join(" | "));
  process.exit(0); // keep the last good file
}

const seen = new Set();
const merged = news
  .sort((a, b) => (a.published < b.published ? 1 : -1))
  .filter((it) => {
    const k = it.title.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .slice(0, MAX_ITEMS);

let old = null;
try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
if (old && JSON.stringify(old.news) === JSON.stringify(merged)) {
  console.log(`No content change (${merged.length} items).`);
  process.exit(0);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Auto-built from public local RSS feeds by scripts/fetch-events.mjs (GitHub Action, ~every 30 min). Headlines belong to their sources.",
      news: merged,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${merged.length} items.${errors.length ? " Partial: " + errors.join(" | ") : ""}`);
