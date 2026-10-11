// Checks neighbor-businesses.json, the hand-kept list behind /business: every
// listing has what the page needs, links are real links, and nothing in it looks
// like a home address. The category keys are read from business.html, so the two
// can't drift apart.
//
//   node scripts/business.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(ROOT, "business.html"), "utf8");
const list = JSON.parse(fs.readFileSync(path.join(ROOT, "neighbor-businesses.json"), "utf8"));

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); } };

const catBlock = /var CATS = \[([\s\S]*?)\n    \];/.exec(page);
const CATS = catBlock ? [...catBlock[1].matchAll(/\["([a-z]+)"/g)].map(m => m[1]) : [];
check("the page defines its categories", CATS.length >= 5 && CATS.includes("other"), CATS);
check("the file is a list", Array.isArray(list));

const KNOWN = new Set(["name", "category", "what", "phone", "text", "url", "instagram", "email", "license", "offer", "owner", "area", "community", "added", "confirmed"]);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
// A street number with a street: "123 Main St", or the local order, "24229 Calle Oruga".
// Shops may have one in "area"; nothing else may.
const STREETY = /\b\d{3,6}\s+(?:[NSEW]\.?\s+)?(?:(?:Calle|Corte|Camino|Avenida|Paseo)\s+[A-Za-z]|[A-Za-z][A-Za-z ]{1,30}\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Blvd)\b)/i;
const HOME_STREETS = /\b(Calle|Corte|Camino|Avenida|Paseo)\s+(la |los |la )?[A-Z]/; // every street behind the gate starts this way

(Array.isArray(list) ? list : []).forEach((b, i) => {
  const tag = `listing ${i + 1}${b && b.name ? ` (${b.name})` : ""}`;
  const bad = [];
  if (!b || typeof b !== "object") { check(tag + " is an object", false); return; }
  for (const k of ["name", "category", "what"]) if (typeof b[k] !== "string" || !b[k].trim()) bad.push("missing " + k);
  for (const k of Object.keys(b)) if (!KNOWN.has(k)) bad.push("unknown field " + k);
  if (b.category && !CATS.includes(b.category)) bad.push("unknown category " + b.category);
  if (b.what && b.what.length > 220) bad.push("'what' is longer than 220 characters");
  if (b.phone && !/^[\d\-() +.]{7,20}$/.test(b.phone)) bad.push("phone format");
  if (b.url && !/^https:\/\/[^\s"'<>]+$/i.test(b.url)) bad.push("url must be https");
  if (b.email && !/^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i.test(b.email)) bad.push("email format");
  if (b.instagram && !/^@?[A-Za-z0-9._]{1,30}$/.test(b.instagram)) bad.push("instagram handle");
  if ("text" in b && typeof b.text !== "boolean") bad.push("'text' is true or false");
  for (const k of ["added", "confirmed"]) if (b[k] && !YMD.test(b[k])) bad.push(k + " must be YYYY-MM-DD");
  if (!b.added && !b.confirmed) bad.push("needs an 'added' or 'confirmed' date, or it never shows");
  // No home addresses: nothing outside "area" may look like a street address, and
  // "area" may not name a street behind the gate.
  for (const k of ["name", "what", "offer", "owner", "license"]) if (b[k] && STREETY.test(b[k])) bad.push(k + " looks like a street address");
  if (b.area && HOME_STREETS.test(b.area)) bad.push("'area' names a neighborhood street: no home addresses");
  check(tag, bad.length === 0, bad);
});

const names = (Array.isArray(list) ? list : []).map(b => String(b && b.name || "").trim().toLowerCase()).filter(Boolean);
check("no business is listed twice", new Set(names).size === names.length);

console.log(failed ? "\n" + failed + " FAILED" : "\nall business-list checks pass (" + names.length + " listing" + (names.length === 1 ? "" : "s") + ")");
process.exit(failed ? 1 : 0);
