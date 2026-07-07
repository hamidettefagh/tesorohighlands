// Builds events.json: attendable events near Santa Clarita from Eventbrite's
// public city pages — filtered to Santa Clarita Valley venues, price-enriched
// from each event page, and tagged by audience (toddlers/kids/teens/adults).
// Run by .github/workflows/refresh-events.yml (~every 30 min); also runnable
// locally: node scripts/fetch-events.mjs
// Writes the file only when content actually changed, so no-op runs produce no commit.

import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../events.json", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PAGES = 8;          // Eventbrite search pages to scan (19 results each)
const MAX_EVENTS = 30;    // cap after filtering + enrichment
const MAX_ENRICH = 45;    // max event pages to fetch for prices
const WINDOW_DAYS = 60;   // how far ahead to look
const SCV = /santa clarita|valencia|newhall|saugus|canyon country|castaic|stevenson ranch|agua dulce|val verde/i;
// Mass-posted corporate training-mill listings — not real community events.
const SPAM = /six sigma|\bpmp\b|\bcapm\b|\bcissp\b|\bcbap\b|\bitil\b|\bscrum\b|certification|bootcamp|classroom training|(\d+|one|two|half)[- ]day (workshop|training|technique)|training course|certified data analyst|business analyt|project management/i;
// Mill listings often stuff a non-SCV city into the title while faking an SCV venue.
const WRONG_CITY = /\b(palmdale|lancaster|burbank|glendale|northridge|sylmar|san fernando|pasadena|van nuys)\b/i;

const AUDIENCES = [
  { key: "toddlers", rx: /\btoddlers?\b|\bpre-?school(ers)?\b|\bpre-?k\b|story ?time|\btiny tots?\b|little ones|mommy (&|and) me|\bages? 0\b/i },
  { key: "kids", rx: /\bkids?\b|\bchild(ren)?\b|\bfamily\b|\byouth\b|\bjunior\b|\bjr\.?\b|elementary|\btweens?\b|summer camp|\bcamps?\b|face ?paint|storybook|\bages? [4-9]\b/i },
  { key: "teens", rx: /\bteens?\b|\bteenagers?\b|high school|\bages? 1[3-7]\b/i },
  { key: "adults", rx: /\b21\s*\+|\b18\s*\+|\badult'?s?\b|\bwine\b|\bbeer\b|brewery|cocktail|comedy|stand-?up|nightlife|singles|networking|happy hour|bar crawl|\bcasino\b/i },
];
function classify(text) {
  const hits = AUDIENCES.filter((a) => a.rx.test(text)).map((a) => a.key);
  return hits.length ? hits : ["everyone"];
}

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}
function serverData(html) {
  const m =
    html.match(/window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) ||
    html.match(/window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});/);
  return m ? JSON.parse(m[1]) : null;
}

// ---- 1) collect events from the search pages ----
const seen = new Map();
let pagesOk = 0;
for (let p = 1; p <= PAGES; p++) {
  try {
    const html = await get(`https://www.eventbrite.com/d/ca--santa-clarita/all-events/?page=${p}`);
    const results = serverData(html)?.search_data?.events?.results || [];
    pagesOk++;
    for (const e of results) {
      if (!e || e.is_online_event || e.is_cancelled) continue;
      const city = e.primary_venue?.address?.localized_area_display || "";
      if (!SCV.test(city)) continue;
      if (SPAM.test(e.name || "") || WRONG_CITY.test(e.name || "")) continue;
      const id = e.eventbrite_event_id || e.id || e.url;
      if (!id || seen.has(id)) continue;
      seen.set(id, {
        title: (e.name || "").trim(),
        url: e.url,
        start: e.start_date && e.start_time ? `${e.start_date}T${e.start_time}` : e.start_date,
        venue: e.primary_venue?.name || null,
        city: city.replace(/,\s*CA\s*$/i, "").trim().replace(/\b\w/g, (c) => c.toUpperCase()),
        free: null,
        price: null,
        audience: classify([e.name, e.summary, (e.tags || []).map((t) => t.display_name).join(" ")].join(" ")),
        source: "Eventbrite",
      });
    }
    if (results.length === 0) break;
  } catch (err) {
    console.error(`search page ${p}:`, String(err).slice(0, 120));
  }
}

if (pagesOk === 0) {
  console.error("All search pages failed; keeping last good file.");
  process.exit(0);
}

const today = new Date(); today.setHours(0, 0, 0, 0);
const maxT = today.getTime() + WINDOW_DAYS * 86400000;
let events = [...seen.values()]
  .filter((e) => { const t = new Date(e.start).getTime(); return t >= today.getTime() && t <= maxT; })
  .sort((a, b) => (a.start < b.start ? -1 : 1))
  .slice(0, MAX_ENRICH);

// ---- 2) enrich each event with price from its page ----
function fmtMoney(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }
async function enrich(e) {
  try {
    const html = await get(e.url);
    const free = html.match(/"isFree":(true|false)/);
    const low = html.match(/"lowPrice":"([\d.]+)"/);
    const high = html.match(/"highPrice":"([\d.]+)"/);
    if (free) e.free = free[1] === "true";
    if (low) {
      const lo = parseFloat(low[1]);
      const hi = high ? parseFloat(high[1]) : lo;
      if (lo === 0 && hi === 0) e.free = true;
      else {
        e.price = hi > lo ? `$${fmtMoney(lo)}–$${fmtMoney(hi)}` : `$${fmtMoney(lo)}`;
        if (e.free === null) e.free = false;
      }
    }
    if (e.free && !e.price) e.price = "Free";
  } catch { /* leave price unknown — UI shows a tickets link */ }
}
const queue = [...events];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await enrich(queue.shift()); }));

// Drop listings whose cheapest ticket is over $400 — corporate trainings, not
// community events — then cap.
events = events.filter((e) => {
  if (!e.price) return true;
  const lo = parseFloat((e.price.match(/[\d.]+/) || [0])[0]);
  return lo <= 400;
}).slice(0, MAX_EVENTS);

// ---- 3) write only on content change ----
let old = null;
try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
if (old && JSON.stringify(old.events) === JSON.stringify(events)) {
  console.log(`No content change (${events.length} events).`);
  process.exit(0);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Attendable events near Santa Clarita, auto-built from Eventbrite's public pages by scripts/fetch-events.mjs. Listings belong to their organizers; details can change — always check the source link.",
      events,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${events.length} SCV events (searched ${pagesOk} pages).`);
