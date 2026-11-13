#!/usr/bin/env node
// Builds icons.svg, the line-icon sprite the pages use in place of emoji:
//   <svg class="ic" aria-hidden="true"><use href="/icons.svg#i-flame"/></svg>
// Icons are Lucide (lucide.dev, ISC license), fetched from a pinned release so a
// re-run gives the same drawings. To add one, put its Lucide name in NAMES and
// run:  node scripts/make-icons.mjs
// (Home keeps its nine icons inline in index.html so they paint with the page.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.460.0";
const NAMES = `flame wind triangle-alert map backpack users phone megaphone cloud-fog droplets book-open
  smartphone file-text paw-print fuel map-pin bell baby house leaf sparkles volleyball wrench plug recycle
  graduation-cap hospital landmark construction sun droplet zap trash-2 wifi stethoscope shield siren
  calendar messages-square palette ferris-wheel gift headphones drama star tractor hammer library mountain
  waves scale handshake hand scroll-text inbox door-open folder-open vote ticket`.split(/\s+/).filter(Boolean);

const symbols = [];
for (const name of NAMES) {
  const r = await fetch(`https://unpkg.com/lucide-static@${VERSION}/icons/${name}.svg`);
  if (!r.ok) throw new Error(name + ": " + r.status);
  const svg = await r.text();
  const inner = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/\s*\n\s*/g, "").trim();
  if (!inner || /<script|href=|on\w+=/i.test(inner)) throw new Error(name + ": unexpected content");
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`);
}
const out = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide ${VERSION} (lucide.dev), ISC license. Built by scripts/make-icons.mjs; do not edit by hand. -->\n${symbols.join("\n")}\n</svg>\n`;
fs.writeFileSync(path.join(ROOT, "icons.svg"), out);
console.log("wrote icons.svg:", NAMES.length, "icons,", Math.round(out.length / 1024) + " KB");
