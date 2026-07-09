// Builds events.json: attendable events in the Santa Clarita Valley.
// Sources:
//   1. Eventbrite public search pages for six SCV city slugs (deduped),
//      price-enriched from each event page, spam-filtered.
//   2. Santa Clarita Public Library calendar (santaclarita.librarycalendar.com)
//      via its server-rendered per-day calendar feed — free programs with
//      official age-group labels (Babies/Toddler/Preschool/Teens/Adults...).
// Each event is tagged by audience (toddlers/kids/teens/adults) for the site's
// filter chips. Run by .github/workflows/refresh-events.yml (note: Eventbrite
// 405-blocks GitHub runner IPs — the library source may still work there; real
// refreshes run from a residential IP). Also runnable locally:
//   node scripts/fetch-events.mjs
// Writes the file only when content actually changed.

import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../events.json", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const EB_SLUGS = [
  // ca--newhall and ca--canyon-country don't exist on Eventbrite (404) —
  // those venues surface under the santa-clarita search anyway.
  { slug: "ca--santa-clarita", pages: 8 },
  { slug: "ca--valencia", pages: 3 },
  { slug: "ca--stevenson-ranch", pages: 3 },
  { slug: "ca--castaic", pages: 3 },
];
const EB_MAX = 30;        // Eventbrite events kept (after filters)
const EB_ENRICH = 45;     // max event pages fetched for prices
const LIB_DAYS = 21;      // how many days of library programs to pull
const LIB_MAX = 25;       // unique library programs kept (after recurring collapse)
const LOCALIST_HOST = "calendar.santaclarita.gov"; // official City of Santa Clarita calendar (Localist)
const LOCALIST_MAX = 30;
const WINDOW_DAYS = 60;   // how far ahead to look (Eventbrite)
const SCV = /santa clarita|valencia|newhall|saugus|canyon country|castaic|stevenson ranch|agua dulce|val verde/i;
// Mass-posted corporate training-mill listings — not real community events.
const SPAM = /six sigma|\bpmp\b|\bcapm\b|\bcissp\b|\bcbap\b|\bitil\b|\bscrum\b|certification|bootcamp|classroom training|(\d+|one|two|half)[- ]day (workshop|training|technique)|training course|certified data analyst|business analyt|project management/i;
// Mill listings often stuff a non-SCV city into the title while faking an SCV venue.
const WRONG_CITY = /\b(palmdale|lancaster|burbank|glendale|northridge|sylmar|san fernando|pasadena|van nuys)\b/i;

const AUDIENCES = [
  { key: "toddlers", rx: /\btoddlers?\b|\bpre-?school(ers)?\b|\bpre-?k\b|story ?time|\btiny tots?\b|little ones|mommy (&|and) me|\bages? 0\b|\bbab(y|ies)\b/i },
  { key: "kids", rx: /\bkids?\b|\bchild(ren)?\b|\bfamily\b|\byouth\b|\bjunior\b|\bjr\.?\b|elementary|\btweens?\b|summer camp|\bcamps?\b|face ?paint|storybook|\bages? [4-9]\b/i },
  { key: "teens", rx: /\bteens?\b|\bteenagers?\b|high school|\bages? 1[3-7]\b/i },
  { key: "adults", rx: /\b21\s*\+|\b18\s*\+|\badult'?s?\b|\bwine(ry)?\b|\bbeer\b|brew(ing|ery|s)?|taproom|distillery|\bpub\b|tavern|cocktail|comedy|stand-?up|nightlife|singles|networking|happy hour|bar crawl|\bcasino\b/i },
];
function classify(text) {
  const hits = AUDIENCES.filter((a) => a.rx.test(text)).map((a) => a.key);
  return hits.length ? hits : ["everyone"];
}
function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
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
// YYYY-MM-DD in Los Angeles time, offset by N days
function laDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

/* ---------------- Source 1: Eventbrite (six SCV city searches) ---------------- */
async function fetchEventbrite() {
  const seen = new Map();
  let pagesOk = 0;
  for (const { slug, pages } of EB_SLUGS) {
    for (let p = 1; p <= pages; p++) {
      try {
        const html = await get(`https://www.eventbrite.com/d/${slug}/all-events/?page=${p}`);
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
        console.error(`eventbrite ${slug} p${p}:`, String(err).slice(0, 100));
        if (p === 1) break; // slug entirely failing — don't hammer
      }
    }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maxT = today.getTime() + WINDOW_DAYS * 86400000;
  let events = [...seen.values()]
    .filter((e) => { const t = new Date(e.start).getTime(); return t >= today.getTime() && t <= maxT; })
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .slice(0, EB_ENRICH);

  // enrich with price from each event page
  const fmtMoney = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
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

  // drop listings whose cheapest ticket is over $400 (corporate trainings), then cap
  events = events.filter((e) => {
    if (!e.price) return true;
    const lo = parseFloat((e.price.match(/[\d.]+/) || [0])[0]);
    return lo <= 400;
  }).slice(0, EB_MAX);

  return { events, pagesOk };
}

/* ---------------- Source 2: Santa Clarita Public Library calendar ---------------- */
function parseLibTime(t) {
  const m = (t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return "";
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  return String(h).padStart(2, "0") + ":" + m[2];
}
function mapLibGroups(groups, title) {
  const set = new Set();
  for (const g of groups) {
    const s = g.toLowerCase();
    if (/bab|toddler|preschool|early|storytime/.test(s)) set.add("toddlers");
    if (/kid|school age|tween|child|storytime|family/.test(s)) set.add("kids");
    if (/teen/.test(s)) set.add("teens");
    if (/adult|senior/.test(s)) set.add("adults");
  }
  return set.size ? [...set] : classify(title);
}
function parseLibraryDay(html, date) {
  const out = [];
  for (const c of html.split('<article class="event-card').slice(1)) {
    if (/cancell/i.test(c)) continue;
    const link = c.match(/href="(\/event\/[^"]+)"[^>]*class="lc-event__link"[^>]*>\s*([^<]+)/);
    if (!link) continue;
    const time = (c.match(/lc-event-info-item--time"\s*>\s*([^<]+)</) || [])[1] || "";
    const branch = decode(((c.match(/lc-event-info__item--categories"\s*>\s*([^<]+)</) || [])[1] || ""));
    const groups = [...c.matchAll(/This event is in the "([^"]+)" group/g)].map((m) => m[1]);
    const startTime = parseLibTime(time);
    const title = decode(link[2]);
    out.push({
      title,
      url: "https://santaclarita.librarycalendar.com" + link[1],
      start: date + (startTime ? `T${startTime}` : ""),
      venue: branch || "Santa Clarita Public Library",
      city: "Santa Clarita",
      free: true,
      price: "Free",
      audience: mapLibGroups(groups, title),
      source: "SC Library",
    });
  }
  return out;
}
async function fetchLibrary() {
  const all = [];
  let daysOk = 0;
  for (let i = 0; i < LIB_DAYS; i++) {
    const date = laDate(i);
    try {
      const html = await get(`https://santaclarita.librarycalendar.com/events/feed/html?_wrapper_format=lc_calendar_feed&current_date=${date}&ongoing_events=hide`);
      all.push(...parseLibraryDay(html, date));
      daysOk++;
    } catch (err) {
      console.error(`library ${date}:`, String(err).slice(0, 90));
      if (i === 0) break; // endpoint down/blocked — don't hammer 21 times
    }
  }
  // Collapse recurring programs (same title + branch — weekly storytimes etc.)
  // into one entry carrying the earliest upcoming date and a repeat count.
  const groups = new Map();
  for (const e of all) {
    const k = e.title.toLowerCase().replace(/\W+/g, " ").trim() + "|" + (e.venue || "");
    if (!groups.has(k)) { e.dates = [e.start]; groups.set(k, e); }
    else { const g = groups.get(k); g.dates.push(e.start); g.repeats = g.dates.length - 1; }
  }
  return { events: [...groups.values()].slice(0, LIB_MAX), daysOk };
}

/* ---------------- Source 3: City of Santa Clarita calendar (Localist JSON) ---------------- */
async function fetchLocalist() {
  const events = [];
  let ok = false;
  try {
    const res = await fetch(`https://${LOCALIST_HOST}/api/2/events?days=${WINDOW_DAYS}&pp=100`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    ok = true;
    for (const wrap of (j.events || [])) {
      const e = wrap && wrap.event;
      if (!e || !e.title || e.status === "cancelled") continue;
      const insts = (e.event_instances || [])
        .map((i) => i.event_instance && i.event_instance.start)
        .filter(Boolean).map((s) => s.slice(0, 16)).sort();
      if (!insts.length) continue;
      const filters = ((e.filters && e.filters.event_calendar) || []).map((f) => f.name).join(" ");
      const cost = e.ticket_cost && String(e.ticket_cost).trim();
      events.push({
        title: e.title.trim(),
        url: e.localist_url || `https://${LOCALIST_HOST}/event/${e.urlname}`,
        start: insts[0],
        dates: insts,
        repeats: insts.length - 1,
        venue: e.location_name || null,
        city: "Santa Clarita",
        free: !!e.free,
        price: e.free ? "Free" : (cost || null),
        audience: classify([e.title, e.description_text, filters, e.location_name].join(" ")),
        source: "City of Santa Clarita",
      });
    }
  } catch (err) {
    console.error("localist:", String(err).slice(0, 100));
  }
  return { events: events.slice(0, LOCALIST_MAX), ok };
}

/* ---------------- merge, dedupe, write ---------------- */
const [eb, lib, loc] = await Promise.all([fetchEventbrite(), fetchLibrary(), fetchLocalist()]);
console.log(`eventbrite: ${eb.events.length} (${eb.pagesOk} pages) | library: ${lib.events.length} (${lib.daysOk}/${LIB_DAYS} days) | city: ${loc.events.length} (${loc.ok ? "ok" : "FAILED"})`);

let old = null;
try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}

if (eb.pagesOk === 0 && lib.daysOk === 0 && !loc.ok) {
  console.error("All sources failed; keeping last good file.");
  process.exit(0);
}

// Per-source fallback: if ONE source failed entirely (e.g. Eventbrite 405-blocks
// GitHub runner IPs while the library still answers), carry forward that
// source's still-upcoming events from the previous file instead of wiping them.
const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
function carryForward(source) {
  if (!old || !Array.isArray(old.events)) return [];
  const kept = old.events.filter((e) => e.source === source && new Date(e.start).getTime() >= cutoff.getTime());
  console.error(`${source} fetch failed — carrying forward ${kept.length} previous events.`);
  return kept;
}
const ebEvents = eb.pagesOk === 0 ? carryForward("Eventbrite") : eb.events;
const libEvents = lib.daysOk === 0 ? carryForward("SC Library") : lib.events;
const locEvents = !loc.ok ? carryForward("City of Santa Clarita") : loc.events;

const seen = new Set();
const events = [...ebEvents, ...libEvents, ...locEvents]
  .filter((e) => {
    const k = e.title.toLowerCase().replace(/\W+/g, " ").trim() + "|" + e.start;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => (a.start < b.start ? -1 : 1));

if (old && JSON.stringify(old.events) === JSON.stringify(events)) {
  console.log(`No content change (${events.length} events).`);
  process.exit(0);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Attendable events in the Santa Clarita Valley, auto-built from Eventbrite, the Santa Clarita Public Library calendar, and the City of Santa Clarita calendar by scripts/fetch-events.mjs. Listings belong to their organizers; details can change — always check the source link.",
      events,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${events.length} events total.`);
