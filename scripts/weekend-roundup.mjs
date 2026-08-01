// Weekend Roundup — the AI agent that writes the WhatsApp-ready weekend text.
//
// Every Friday morning this reads the site's OWN verified events feed
// (events.json + ai-events.json — already fetched, filtered, and deduped by
// the other pipelines), asks Claude to pick the 5–7 best weekend picks for
// this community (families with kids + adults, prefer free/local), and writes
// roundup.json. The events page renders it with a one-tap
// "Copy for WhatsApp" / "Share" card.
//
// Hallucination-proof by construction: the model chooses events BY INDEX from
// the list we hand it and writes only a short note per pick — every title,
// day, time, venue, and price in the final text comes from our own feed data,
// formatted deterministically by this script.
//
// Requires ANTHROPIC_API_KEY (same repo secret the AI events sweep uses).
// Model: claude-haiku-4-5 (override with ANTHROPIC_MODEL).

import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const SITE = "https://tesorohighlands.com";
const root = (f) => new URL(`../${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("No ANTHROPIC_API_KEY — skipping roundup (nothing written).");
  process.exit(0);
}

/* ---------- collect this weekend's candidate events from our own feeds ---------- */
const laDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + offsetDays * 86400000));

// Weekend window regardless of run day: from max(today, this week's Friday)
// through Sunday. Friday cron → Fri-Sun; a Saturday manual run → Sat-Sun;
// a midweek run previews the coming weekend.
const dow = new Date(laDate(0) + "T12:00:00").getDay(); // LA day-of-week
const toFri = (5 - dow + 7) % 7;
const startOff = dow === 6 || dow === 0 ? 0 : toFri;
const endOff = dow === 6 ? 1 : dow === 0 ? 0 : toFri + 2;
const days = [];
for (let o = startOff; o <= endOff; o++) days.push(laDate(o));
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function load(f) { try { return JSON.parse(readFileSync(root(f), "utf8")); } catch { return null; } }
const feed = load("events.json"), ai = load("ai-events.json");

function occurrencesInWeekend(e) {
  const ds = (e.dates && e.dates.length ? e.dates : [e.start]).filter(Boolean);
  return ds.filter((s) => days.includes(String(s).split("T")[0]));
}
const seen = new Set();
const candidates = [];
for (const e of [...(feed?.events || []), ...(ai?.events || [])]) {
  if (!e || !e.title) continue;
  for (const occ of occurrencesInWeekend(e)) {
    const key = e.title.toLowerCase().replace(/\W+/g, " ").trim() + "|" + occ.split("T")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      title: e.title, start: occ, venue: e.venue || "", city: e.city || "",
      free: !!e.free, price: e.price || "", audience: e.audience || [], url: e.url || "",
    });
  }
}
candidates.sort((a, b) => (a.start < b.start ? -1 : 1));

if (candidates.length < 3) {
  console.log(`Only ${candidates.length} weekend events found — not enough for a roundup; nothing written.`);
  process.exit(0);
}

/* ---------- ask Claude to curate (by index only) ---------- */
const listing = candidates.map((c, i) =>
  `${i}. [${c.start}] ${c.title}${c.venue ? " @ " + c.venue : ""}${c.city ? ", " + c.city : ""} | ${c.free ? "FREE" : c.price || "ticketed"} | audience: ${(c.audience || []).join(",") || "everyone"}`).join("\n");

const TOOL = {
  name: "submit_roundup",
  description: "Submit the curated weekend picks.",
  strict: true,
  input_schema: {
    type: "object", additionalProperties: false, required: ["intro", "picks"],
    properties: {
      intro: { type: "string", description: "One warm, plain opening line for the neighborhood (max 90 chars). No hype words, no exclamation overload." },
      picks: {
        // no minItems/maxItems: strict tool schemas only allow 0/1 there —
        // counts are enforced by the prompt and by validation below instead
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["index", "emoji", "note"],
          properties: {
            index: { type: "integer", description: "Index of the chosen event from the provided list." },
            emoji: { type: "string", description: "One fitting emoji for this event." },
            note: { type: "string", description: "Optional 6-12 word reason it's a good pick; empty string if the title says it all." },
          },
        },
      },
    },
  },
};

const client = new Anthropic();
const msg = await client.messages.create({
  model: MODEL,
  max_tokens: 1500,
  tools: [TOOL],
  tool_choice: { type: "tool", name: "submit_roundup" },
  messages: [{
    role: "user",
    content: `You are curating a short WhatsApp weekend roundup for the Tesoro Highlands neighborhood group chat in Valencia / Santa Clarita, CA — families with young kids, plus adults who like local food, music, and comedy.

Pick the 5-7 best events for THIS weekend from the numbered list below. Rules:
- Balance the picks: at least 2 good for kids/families and at least 2 for adults, when available.
- Prefer free, local, and one-off events over generic recurring ones; at most one library storytime.
- Never pick the same event twice, and skip anything that reads like spam or a class/certification.
- Reference events ONLY by their index number. Do not invent or restate dates, prices, or venues — the site formats those itself.

${listing}`,
  }],
});

const call = msg.content.find((b) => b.type === "tool_use" && b.name === "submit_roundup");
if (!call) { console.error("Model returned no tool call; nothing written."); process.exit(1); }

/* ---------- format deterministically from OUR data ---------- */
function fmtTime(s) {
  const t = String(s).split("T")[1];
  if (!t || t.slice(0, 5) === "00:00") return "";
  const [h, m] = t.split(":").map(Number);
  return `${(h % 12) || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h >= 12 ? "PM" : "AM"}`;
}
function fmtDay(s) {
  const [y, mo, d] = String(s).split("T")[0].split("-").map(Number);
  return DAY_NAME[new Date(y, mo - 1, d, 12).getDay()] || "";
}
function shortPrice(c) {
  if (c.free) return "free";
  const p = String(c.price || "");
  if (!p) return "";
  if (p.length <= 16) return p.toLowerCase();
  const amts = (p.match(/\$\s?\d+(?:\.\d{2})?/g) || []).map((s) => parseFloat(s.replace(/[^\d.]/g, ""))).filter((n) => !isNaN(n));
  return amts.length ? "from $" + Math.min(...amts) : "";
}

const picks = [];
const used = new Set(), usedTitles = new Set();
for (const p of (call.input.picks || []).slice(0, 7)) {
  const c = candidates[p.index];
  if (!c || used.has(p.index)) continue;   // out-of-range or duplicate index → dropped, never invented
  const tkey = c.title.toLowerCase().replace(/\W+/g, " ").trim();
  if (usedTitles.has(tkey)) continue;      // same show on two days counts as one pick
  used.add(p.index); usedTitles.add(tkey);
  // Emoji must be handled by CODE POINT, never by UTF-16 unit: slicing a
  // compound emoji like 🧑‍🌾 mid-surrogate leaves a lone surrogate that makes
  // encodeURIComponent throw in the browser (this exact bug hid the card once).
  const emojiPts = [...String(p.emoji || "📍")];
  picks.push({ emoji: emojiPts.length && emojiPts.length <= 4 ? emojiPts.join("") : "📍",
    day: fmtDay(c.start), time: fmtTime(c.start),
    title: c.title, price: shortPrice(c), note: String(p.note || "").trim().slice(0, 90), url: c.url });
}
if (picks.length < 3) { console.error(`Only ${picks.length} valid picks after validation; nothing written.`); process.exit(1); }

const intro = String(call.input.intro || "").trim().slice(0, 120);
const lines = picks.map((p) => {
  const when = [p.day, p.time].filter(Boolean).join(" ");
  const tail = p.price ? ` (${p.price})` : "";
  return `${p.emoji} *${when}* — ${p.title}${tail}${p.note ? `\n   ${p.note}` : ""}`;
});
// Final safety net: strip any lone surrogates so the text is always valid
// Unicode — a malformed emoji anywhere must never break downstream encoding.
const stripLone = (s) => s
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
  .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1");
const waText = stripLone(`🌵 *This weekend in Tesoro Highlands*\n${intro ? intro + "\n" : ""}\n${lines.join("\n")}\n\nFull list → ${SITE}/events`);

writeFileSync(root("roundup.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  weekendOf: days[0],
  model: MODEL,
  intro, picks, waText,
}, null, 2) + "\n");
console.log(`Roundup written: ${picks.length} picks for the weekend of ${days[0]}.`);
