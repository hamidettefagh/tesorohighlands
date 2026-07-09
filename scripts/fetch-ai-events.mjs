// Optional AI-assisted event discovery for the Tesoro Highlands events page.
//
// Uses the Claude API's built-in web search to find local, in-person Santa
// Clarita Valley events that the structured feeds (City calendar, Eventbrite,
// library) miss — venue pages, farms, community orgs, Macaroni KID, churches.
//
// This is a SUPPLEMENT, not the backbone. An LLM can get a date or price wrong,
// so: every event links to the page it was found on, the prompt is tuned hard
// for accuracy-over-quantity, results are validated (real URL, future date, SCV
// city), and the output is written to a SEPARATE ai-events.json for review —
// it is NOT merged into the live feed unless a human wires it in.
//
// Runs in GitHub Actions (.github/workflows/refresh-ai-events.yml). The web
// search runs on Anthropic's servers, so — unlike the Eventbrite scraper — this
// works fine from CI runner IPs. Needs the ANTHROPIC_API_KEY repo secret; if it
// is unset the script exits cleanly without doing anything.
//
//   node scripts/fetch-ai-events.mjs
//
// Model: defaults to claude-opus-4-8. Set ANTHROPIC_MODEL=claude-haiku-4-5 to
// cut the cost of this background task ~5x (see README for the math).

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../ai-events.json", import.meta.url);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const WINDOW_DAYS = 42;
const MAX_EVENTS = 25;
const SCV = /santa clarita|valencia|newhall|saugus|canyon country|castaic|stevenson ranch|agua dulce|val verde/i;
const AUD = ["toddlers", "kids", "teens", "adults", "everyone"];

// No key → no-op (lets the workflow run harmlessly before the secret is added).
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY not set — skipping AI event discovery.");
  process.exit(0);
}

const ymd = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const windowEnd = new Date(today.getTime() + WINDOW_DAYS * 86400000);

// Strict JSON Schema for the submit_events tool. All fields required, no extras —
// this is what makes Claude's output reliably parseable.
const EVENTS_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string", description: "ISO date, YYYY-MM-DD" },
          time: { type: "string", description: 'e.g. "7:00 PM", or "" if not stated' },
          venue: { type: "string" },
          city: { type: "string" },
          url: { type: "string", description: "the web page this event was found on" },
          free: { type: "boolean" },
          price: { type: "string", description: 'e.g. "$20", or "" if free/unknown' },
          audience: { type: "array", items: { type: "string", enum: AUD } },
          source_name: { type: "string", description: "the website the info came from" },
        },
        required: ["title", "date", "time", "venue", "city", "url", "free", "price", "audience", "source_name"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
  additionalProperties: false,
};

const PROMPT = `You are helping a Santa Clarita Valley community website find LOCAL, IN-PERSON events residents can attend.

Today is ${ymd(today)}. Find events happening between ${ymd(today)} and ${ymd(windowEnd)} in the Santa Clarita Valley — the California cities of Santa Clarita, Valencia, Newhall, Saugus, Canyon Country, Castaic, Stevenson Ranch, and Agua Dulce.

Use web search to find real events. Good places to look: local venue pages, Macaroni KID Santa Clarita, the City of Santa Clarita arts/events pages, Visit Santa Clarita, community organizations, farms (e.g. Gilchrist Farm), breweries and restaurants that host events, churches, schools, and local event roundups.

INCLUDE things a family or an adult can physically show up to: festivals, farmers markets, live music, comedy, kids' activities and classes, story times, farm events, holiday events, community and rec events.
EXCLUDE online/virtual events, corporate training or professional certification courses, anything outside the Santa Clarita Valley, and anything that has already happened.

ACCURACY MATTERS MORE THAN QUANTITY:
- Only include an event if a web search actually found it on a real, working page. Put that page's URL in "url".
- Never invent an event, a date, a price, or a venue. If you are not sure of the exact date, leave the event out.
- Returning 5 events you are confident about is far better than 20 you are guessing at.

When you have gathered what you can confidently confirm, call the submit_events tool exactly once with all of them. If you cannot confirm any events, call submit_events with an empty list.`;

const client = new Anthropic();

const tools = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  {
    name: "submit_events",
    description: "Record the confirmed local events you found. Call this exactly once when done.",
    strict: true,
    input_schema: EVENTS_SCHEMA,
  },
];

// web_search is a server tool (runs on Anthropic's side, auto-resolved). We just
// loop through any pause_turn until Claude calls our submit_events tool.
async function discover() {
  const messages = [{ role: "user", content: PROMPT }];
  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 8000, tools, messages });
    const submit = res.content.find((b) => b.type === "tool_use" && b.name === "submit_events");
    if (submit) return submit.input.events || [];
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    return []; // finished without submitting → nothing confirmed
  }
  return [];
}

function to24(t) {
  const m = String(t || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const min = m[2] || "00";
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || h < 0) return "";
  return String(h).padStart(2, "0") + ":" + min;
}

// Hard validation — the anti-hallucination backstop. Drop anything without a
// real URL, a parseable in-window date, or an SCV location; shape to match the
// events.json schema so it can be merged/displayed later if desired.
function clean(raw) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const maxT = start.getTime() + (WINDOW_DAYS + 3) * 86400000;
  const seen = new Set();
  const out = [];
  for (const e of raw || []) {
    if (!e || !e.title || !e.url) continue;
    if (!/^https?:\/\//i.test(e.url)) continue;
    const dm = String(e.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm) continue;
    const dt = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    if (isNaN(dt) || dt.getTime() < start.getTime() || dt.getTime() > maxT) continue;
    if (!SCV.test((e.city || "") + " " + (e.venue || ""))) continue;
    const key = e.title.toLowerCase().replace(/\W+/g, " ").trim() + "|" + e.date;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = to24(e.time);
    const aud = Array.isArray(e.audience) ? e.audience.filter((a) => AUD.includes(a) && a !== "everyone") : [];
    out.push({
      title: e.title.trim(),
      url: e.url.trim(),
      start: e.date + (t ? "T" + t : ""),
      venue: (e.venue || "").trim() || null,
      city: (e.city || "Santa Clarita").replace(/,?\s*CA\b.*$/i, "").trim() || "Santa Clarita",
      free: !!e.free,
      price: e.free ? "Free" : (String(e.price || "").trim() || null),
      audience: aud.length ? aud : ["everyone"],
      source: "Web (AI)",
      via: (e.source_name || "").trim() || null,
    });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, MAX_EVENTS);
}

let events;
try {
  events = clean(await discover());
} catch (err) {
  console.error("AI discovery failed:", String(err).slice(0, 200));
  process.exit(0); // fail soft — keep the last good file
}

console.log(`AI discovery: ${events.length} confirmed events (model ${MODEL}).`);

let old = null;
try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
if (old && JSON.stringify(old.events) === JSON.stringify(events)) {
  console.log("No content change.");
  process.exit(0);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      note: "AI-assisted event discovery via Claude web search. A supplement to the verified feeds — every item links to the page it was found on. Details can be wrong; always confirm at the source before relying on it.",
      events,
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${events.length} events to ai-events.json.`);
