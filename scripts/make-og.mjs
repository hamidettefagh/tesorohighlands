#!/usr/bin/env node
// Share-card generator: renders the 1200×630 link-preview images (og:image) from
// HTML/CSS with headless Chrome. No dependencies — it speaks the DevTools
// protocol over Node 22's built-in WebSocket.
//
//   node scripts/make-og.mjs                  events cards + og-events.json manifest
//   node scripts/make-og.mjs --home out.jpg   the site-wide card, to a path you choose
//
// Run it whenever a featured event (community-events.json: "featured": true plus a
// "flyer") is added, changed or removed. It writes one card per "phase" — all the
// upcoming featured events, then the same list minus the first, and so on — so the
// preview never advertises an event that has already happened. api/og-events.js
// reads the manifest and serves the right card for today's date; og-events.jpg is
// the evergreen card for when nothing is featured.
//
// Chrome is found automatically; set CHROME_PATH to override.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1200, H = 630;

// ---------------------------------------------------------------- the scene
// Golden hour over the hills. Ridges are sums of sines, sampled into paths, so the
// little houses can sit exactly on the ridge they belong to.
const ridge = {
  far: (x) => 392 + 26 * Math.sin(x / 210 + 0.6) + 12 * Math.sin(x / 83 + 2.1),
  mid: (x) => 455 + 24 * Math.sin(x / 170 + 2.4) + 10 * Math.sin(x / 67 + 0.4),
  near: (x) => 522 + 20 * Math.sin(x / 190 + 4.0) + 8 * Math.sin(x / 59 + 1.2),
  fore: (x) => 590 + 14 * Math.sin(x / 230 + 1.0) + 6 * Math.sin(x / 71 + 3.0),
};
function ridgePath(f) {
  let d = "M0 " + f(0).toFixed(1);
  for (let x = 8; x <= W; x += 8) d += " L" + x + " " + f(x).toFixed(1);
  return d + ` L${W} ${H} L0 ${H} Z`;
}
function houses(list) {
  let body = "", lit = "";
  for (const [x, w, h, win] of list) {
    const base = ridge.near(x + w / 2) + 6, top = base - h, roof = Math.round(w * 0.42);
    body += `<path d="M${x} ${base} V${top} L${x + w / 2} ${top - roof} L${x + w} ${top} V${base} Z"/>`;
    for (const [dx, dy] of win) lit += `<rect x="${x + dx}" y="${(top + dy).toFixed(1)}" width="6" height="7" rx="1"/>`;
  }
  return `<g fill="#21112f">${body}</g><g fill="#ffd27a">${lit}</g>`;
}
function scene({ sunX = 880, sunY = 350, withHouses = true } = {}) {
  const stars = [[92, 64, 1.6], [188, 128, 1.1], [266, 52, 1.3], [352, 150, 1], [438, 78, 1.5], [531, 40, 1.1], [612, 118, 1.2],
    [705, 58, 1.4], [148, 214, 1], [820, 96, 1], [948, 44, 1.3], [1076, 88, 1.1], [1142, 38, 1.4], [486, 196, 0.9]]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${(0.35 + r * 0.3).toFixed(2)}"/>`).join("");
  return `<svg class="scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1240"/><stop offset=".20" stop-color="#47206c"/><stop offset=".38" stop-color="#a8366f"/>
      <stop offset=".52" stop-color="#ee6f40"/><stop offset=".64" stop-color="#ffc466"/>
    </linearGradient>
    <radialGradient id="glow" cx="${sunX}" cy="${sunY}" r="430" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff0c2" stop-opacity=".95"/><stop offset=".22" stop-color="#ffc77a" stop-opacity=".55"/><stop offset="1" stop-color="#ff9a5a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bloom" cx="${sunX}" cy="392" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${sunX} 392) scale(760 120) translate(${-sunX} -392)">
      <stop offset="0" stop-color="#ffd98a" stop-opacity=".75"/><stop offset="1" stop-color="#ffb066" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbe6"/><stop offset="1" stop-color="#ffd878"/></linearGradient>
    <linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9527a"/><stop offset=".35" stop-color="#8d3f78"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars}
  <rect width="${W}" height="${H}" fill="url(#bloom)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <circle cx="${sunX}" cy="${sunY}" r="78" fill="url(#sun)"/>
  <path d="${ridgePath(ridge.far)}" fill="url(#far)"/>
  <path d="${ridgePath(ridge.mid)}" fill="#5d2a63"/>
  ${withHouses ? houses([[742, 30, 22, [[6, 7], [18, 7]]], [780, 36, 28, [[7, 8], [22, 8]]], [826, 28, 20, [[11, 6]]], [986, 34, 26, [[7, 8], [21, 8]]],
    [1028, 28, 21, [[6, 6], [16, 6]]], [1066, 38, 30, [[8, 9], [24, 9]]], [1114, 30, 22, [[12, 7]]]]) : ""}
  <path d="${ridgePath(ridge.near)}" fill="#2c1745"/>
  <path d="${ridgePath(ridge.fore)}" fill="#130b24"/>
</svg>`;
}

const MARK = `<svg class="mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="15" fill="rgba(12,7,26,.55)" stroke="rgba(255,255,255,.28)" stroke-width="1.5"/><circle cx="43" cy="21" r="6.5" fill="#ffc15e"/><path d="M3 53 L21 29 L31 41 L41 27 L61 53 Z" fill="#fff"/></svg>`;

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#1a1240;color:#fff;-webkit-font-smoothing:antialiased;
  font-family:"Plus Jakarta Sans","Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif}
.scene{position:absolute;inset:0}
.scrim{position:absolute;inset:0;background:linear-gradient(90deg,rgba(24,11,48,.80) 0%,rgba(24,11,48,.60) 34%,rgba(24,11,48,.18) 58%,rgba(24,11,48,0) 74%)}
.copy{position:absolute;left:68px;top:60px;width:580px}
.copy.wide{width:700px}
.eyebrow{font-size:21px;font-weight:700;letter-spacing:.17em;text-transform:uppercase;color:#ffd08a}
h1{font-size:76px;line-height:1.03;font-weight:800;letter-spacing:-.028em;margin-top:18px;text-shadow:0 2px 24px rgba(10,5,25,.35)}
h1.big{font-size:92px}
.sub{font-size:30px;line-height:1.32;font-weight:500;margin-top:20px;color:rgba(255,255,255,.95);max-width:640px;text-shadow:0 1px 14px rgba(10,5,25,.45)}
.rows{margin-top:30px;display:grid;gap:15px}
.row{display:flex;align-items:center;gap:16px;font-size:35px;font-weight:700;letter-spacing:-.012em;white-space:nowrap}
.chip{flex:none;min-width:142px;text-align:center;font-size:19px;font-weight:800;letter-spacing:.09em;color:#2a1430;background:#ffc15e;border-radius:9px;padding:7px 12px}
.meta{font-size:27px;font-weight:600;margin-top:22px;color:rgba(255,255,255,.93)}
.pills{display:flex;flex-wrap:nowrap;gap:11px;margin-top:28px}
.pill{font-size:23px;font-weight:700;padding:9px 17px;border-radius:999px;background:rgba(22,12,44,.40);border:1.5px solid rgba(255,255,255,.38);white-space:nowrap}
.foot{position:absolute;left:68px;bottom:46px;display:flex;align-items:center;gap:14px;font-size:25px;font-weight:700;letter-spacing:-.005em}
.foot .mark{width:44px;height:44px;display:block}
.posters{position:absolute;right:0;top:0;width:600px;height:${H}px}
.poster{position:absolute;background:#fff;padding:9px;border-radius:13px;box-shadow:0 24px 54px rgba(8,4,20,.58),0 3px 10px rgba(8,4,20,.35)}
.poster img{display:block;width:100%;height:auto;border-radius:6px}
.float{position:absolute;right:0;top:0;width:560px;height:${H}px}
.float .pill{position:absolute;font-size:26px;padding:11px 20px;background:rgba(22,12,44,.42);border-color:rgba(255,255,255,.42);box-shadow:0 10px 26px rgba(8,4,20,.30)}
`;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (body) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=block" rel="stylesheet">
<style>${CSS}</style></head><body>${body}</body></html>`;
const foot = (url) => `<div class="foot">${MARK}<span>${esc(url)}</span></div>`;

const ymd = (s) => { const p = String(s || "").split("T")[0].split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const chipDate = (s) => { const d = ymd(s); return d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase() + " · " + d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() + " " + d.getDate(); };
const shortName = (e) => e.short || e.title;

// Posters fan out on the right; the soonest event sits on top.
const POSTER_LAYOUT = {
  1: [{ left: 150, top: 86, width: 330, rot: 4 }],
  2: [{ left: 34, top: 120, width: 296, rot: -6, z: 2 }, { left: 284, top: 84, width: 292, rot: 5, z: 1 }],
  3: [{ left: 16, top: 150, width: 246, rot: -8, z: 3 }, { left: 186, top: 92, width: 246, rot: 1, z: 2 }, { left: 350, top: 136, width: 240, rot: 8, z: 1 }],
};
function posters(events) {
  const shown = events.slice(0, 3), lay = POSTER_LAYOUT[shown.length];
  // Paint back-to-front so the soonest event's flyer ends up on top.
  return `<div class="posters">` + shown.map((e, i) => {
    const p = lay[i];
    return `<div class="poster" style="left:${p.left}px;top:${p.top}px;width:${p.width}px;transform:rotate(${p.rot}deg);z-index:${p.z || 1}"><img src="${pathToFileURL(path.join(ROOT, e.flyer)).href}" alt=""></div>`;
  }).join("") + `</div>`;
}

function cardEventsFeatured(events) {
  const samePlace = events.every((e) => e.place && e.place === events[0].place);
  let copy;
  if (events.length === 1) {
    const e = events[0];
    copy = `<div class="eyebrow">Tesoro Highlands · Events</div><h1>${esc(shortName(e))}</h1>
      <div class="rows"><div class="row"><span class="chip">${esc(chipDate(e.date))}</span>${esc(e.time || "")}</div></div>
      ${e.place ? `<div class="meta">📍 ${esc(e.place)}</div>` : ""}`;
  } else {
    copy = `<div class="eyebrow">Tesoro Highlands · Events</div>
      <h1>${samePlace ? "Coming up at<br>" + esc(events[0].place) : "Coming up in the neighborhood"}</h1>
      <div class="rows">${events.slice(0, 3).map((e) => `<div class="row"><span class="chip">${esc(chipDate(e.date))}</span>${esc(shortName(e))}</div>`).join("")}</div>`;
  }
  return page(`${scene({ sunX: 900, withHouses: false })}<div class="scrim"></div>${posters(events)}<div class="copy">${copy}</div>${foot("tesorohighlands.com/events")}`);
}
function cardEventsGeneric() {
  // Placed to leave the setting sun clear.
  const pills = [["🎶 Live music", 60, 88, -4], ["🎭 Theater", 300, 80, 5], ["🧺 Farmers markets", 150, 166, 3], ["📚 Storytime", 0, 246, 2], ["🏓 Pickleball", 340, 250, -3]];
  return page(`${scene()}<div class="scrim"></div>
    <div class="float">${pills.map(([t, x, y, r]) => `<span class="pill" style="left:${x}px;top:${y}px;transform:rotate(${r}deg)">${t}</span>`).join("")}</div>
    <div class="copy"><div class="eyebrow">Tesoro Highlands · Events &amp; clubs</div><h1>What’s on around the neighborhood</h1>
    <div class="sub">Local events you can actually go to, plus clubs and neighbor get-togethers.</div></div>${foot("tesorohighlands.com/events")}`);
}
function cardHome() {
  return page(`${scene()}<div class="scrim"></div>
    <div class="copy wide"><div class="eyebrow">A neighbor project · Valencia, CA</div><h1 class="big">Tesoro<br>Highlands</h1>
    <div class="sub">Live fire &amp; air status, backyard weather, and what’s on around the neighborhood.</div>
    <div class="pills"><span class="pill">🔥 Fire &amp; air</span><span class="pill">🌤️ Weather</span><span class="pill">📅 Events</span><span class="pill">🏡 Living here</span></div></div>
    ${foot("tesorohighlands.com")}`);
}

// ---------------------------------------------------------------- headless Chrome over CDP
function findChrome() {
  const c = [process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error("Chrome not found — set CHROME_PATH");
  return hit;
}
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "og-chrome-"));
  const proc = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ""; const t = setTimeout(() => reject(new Error("Chrome did not start")), 20000);
    proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on("exit", () => reject(new Error("Chrome exited early")));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("DevTools socket failed")); });
  let id = 0; const pending = new Map(), waiters = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); return; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === d.method && waiters[i].sessionId === d.sessionId) waiters.splice(i, 1)[0].resolve(d.params);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const waitFor = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));
  const close = () => { try { ws.close(); } catch {} try { proc.kill(); } catch {} setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 500); };
  return { send, waitFor, close };
}
async function render(chrome, html, outFile) {
  const tmp = path.join(os.tmpdir(), "og-card-" + process.pid + "-" + Date.now() + ".html");
  fs.writeFileSync(tmp, html);
  try {
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    await chrome.send("Page.enable", {}, sessionId);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
    const loaded = chrome.waitFor("Page.loadEventFired", sessionId);
    await chrome.send("Page.navigate", { url: pathToFileURL(tmp).href }, sessionId);
    await loaded;
    // Fonts and flyers must be fully decoded before the shutter clicks.
    const r = await chrome.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression:
      `document.fonts.ready.then(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => null))))
        .then(() => ({ font: document.fonts.check('800 40px "Plus Jakarta Sans"'), broken: Array.from(document.images).filter((i) => !i.naturalWidth).length }))` }, sessionId);
    const info = (r.result && r.result.value) || {};
    if (info.broken) throw new Error(info.broken + " flyer image(s) failed to load");
    const shot = await chrome.send("Page.captureScreenshot", { format: "jpeg", quality: 90, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } }, sessionId);
    fs.writeFileSync(outFile, Buffer.from(shot.data, "base64"));
    await chrome.send("Target.closeTarget", { targetId });
    console.log("  wrote", path.relative(ROOT, outFile) || outFile, Math.round(fs.statSync(outFile).size / 1024) + " KB", info.font ? "" : "(web font unavailable — used the system font)");
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// ---------------------------------------------------------------- main
const args = process.argv.slice(2);
const chrome = await launch();
try {
  if (args[0] === "--home") {
    await render(chrome, cardHome(), path.resolve(args[1] || "og-home.jpg"));
  } else {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, "community-events.json"), "utf8"));
    const featured = (Array.isArray(list) ? list : [])
      .filter((e) => e && e.featured === true && e.title && e.date && ymd(e.date) >= today && /^\/img\/[\w\-.]+\.(webp|png|jpe?g)$/i.test(e.flyer || "") && fs.existsSync(path.join(ROOT, e.flyer)))
      .sort((a, b) => ymd(a.date) - ymd(b.date));
    for (const f of fs.readdirSync(ROOT)) if (/^og-events-\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(ROOT, f));
    await render(chrome, cardEventsGeneric(), path.join(ROOT, "og-events.jpg"));
    const variants = [];
    for (let i = 0; i < featured.length; i++) {
      const evs = featured.slice(i), file = "og-events-" + (i + 1) + ".jpg";
      await render(chrome, cardEventsFeatured(evs), path.join(ROOT, file));
      variants.push({ until: featured[i].date.split("T")[0], file, events: evs.slice(0, 3).map((e) => e.title) });
    }
    fs.writeFileSync(path.join(ROOT, "og-events.json"), JSON.stringify({ note: "Written by scripts/make-og.mjs — read by api/og-events.js. Do not edit by hand.", variants, fallback: "og-events.jpg" }, null, 2) + "\n");
    console.log("  wrote og-events.json |", variants.length, "featured phase(s)");
  }
} finally { chrome.close(); }
