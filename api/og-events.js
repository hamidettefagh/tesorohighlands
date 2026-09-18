// Serves the Events page's share card (og:image) for today's date.
//
// Link previews are fetched by Facebook / WhatsApp / iMessage crawlers, which don't
// run JavaScript — so the page can't pick its own card. This endpoint does: featured
// neighborhood events get a card showing their flyers until the day they happen,
// then the next phase takes over, then the evergreen card. That way a preview never
// advertises an event that is already over.
//
// scripts/make-og.mjs renders the images and writes og-events.json; nothing here
// needs editing by hand. ?date=YYYY-MM-DD previews what a given day will serve.

const fs = require("fs");
const path = require("path");
const manifest = require("../og-events.json");

// Only ever serve the files the generator writes.
const SAFE = /^og-events(-\d+)?\.jpg$/;

module.exports = (req, res) => {
  // "Today" on our hill, not in whichever region the function runs.
  let today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const m = /[?&]date=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(req.url || "");
  if (m) today = m[1];

  const hit = (manifest.variants || []).find((v) => v && typeof v.until === "string" && v.until >= today && SAFE.test(v.file || ""));
  const file = hit ? hit.file : "og-events.jpg";

  res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=1800");
  try {
    const buf = fs.readFileSync(path.join(process.cwd(), file));
    res.setHeader("Content-Type", "image/jpeg");
    res.status(200).send(buf);
  } catch (e) {
    // Not bundled with the function? The same file is still on the CDN.
    res.statusCode = 302;
    res.setHeader("Location", "/" + file);
    res.end();
  }
};
