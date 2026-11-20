#!/usr/bin/env node
// Measured UX check for one page, using the installed Chrome. No dependencies.
//
//   node scripts/ux-probe.mjs <url> [width]     e.g. node scripts/ux-probe.mjs http://localhost:3100/holidays
//
// Opens the page at phone width (390 unless given) in the light and the dark theme, opens
// every <details>, and reports:
//   contrast  text below WCAG AA (4.5:1, or 3:1 for large text). Text over a photo or a
//             gradient can't be computed and is listed to check by eye.
//   type      readable text under 12.5px, or anything under 11px (the floor written in th.css;
//             uppercase labels may go down to 11px, and the footer's fine print is exempt)
//   controls  links and buttons under 40px tall or wide (links inside a sentence are exempt)
//   focus     controls that show no focus ring
//   overflow  sideways scroll
//   shift     how far the page jumps while it loads. Over 0.1 fails. Measured in the worst
//             case a phone sees, where the page paints before anything else has arrived:
//             nav.js is held back 1.5 s, every other script but theme.js 0.9 s, and every
//             data request (fetch/XHR) 0.8 s. Without the hold, localhost often answers
//             before the first paint, and the same page read 0 on one run and 0.3 on the
//             next. (The holds are over half a second on purpose: Chrome ignores jumps in
//             the first 500 ms of a phone-sized load.) The total is taken before the checks
//             below open the fold-out sections, because opening them moves the page too
//             and that is this script's doing, not the page's.
//   weight    total download and the heaviest files
// Exit code 1 if anything but weight fails.
//
// Why it exists: on 2026-11-19 it found a 0.18 load jump on every page and four text sizes
// under the floor on /holidays. All of them had passed several rounds of looking at screenshots.
// Chrome is found automatically; set CHROME_PATH to override.
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const [url, wArg] = process.argv.slice(2);
if (!url) { console.error("usage: node scripts/ux-probe.mjs <url> [width]"); process.exit(2); }
const W = +wArg || 390;

function findChrome() {
  const c = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error("Chrome not found — set CHROME_PATH");
  return hit;
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ux-probe-"));
const proc = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error("Chrome did not start")), 20000); });
const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(), listeners = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); return; }
  for (const l of listeners) if (l.method === d.method && l.session === d.sessionId) l.fn(d.params);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

// Runs in the page. Everything it returns is plain data.
const audit = async () => {
  // The load jump first, before anything below touches the page. Until 2026-11-19 this was
  // read at the end, so it also counted the page moving when the next line opens every
  // <details>: /fire, with two fold-outs on its first screen, read 0.22 too high on a phone.
  if (window.__shiftFlush) window.__shiftFlush();
  const shiftLog = (window.__shift || []).slice();
  document.querySelectorAll("details").forEach((d) => (d.open = true));
  document.querySelectorAll("img[loading=lazy]").forEach((i) => (i.loading = "eager"));
  await Promise.all([...document.images].map((i) => i.decode().catch(() => 0)));
  await new Promise((r) => setTimeout(r, 500));
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
  const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : "");
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && +cs.opacity > 0; };
  const say = (t) => t.replace(/\s+/g, " ").trim().slice(0, 36);
  // The colour behind an element; `unsure` when a photo or a gradient is in the way.
  const behind = (e) => {
    const layers = []; let unsure = false, n = e;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") unsure = true;
      if ([...n.children].some((k) => (k.tagName === "IMG" || k.tagName === "PICTURE") && getComputedStyle(k.tagName === "IMG" ? k : k.querySelector("img") || k).position === "absolute")) unsure = true;
      const c = parse(cs.backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
      n = n.parentElement;
    }
    let base = layers.length && layers[layers.length - 1].a >= 0.999 ? layers.pop() : parse(matchMedia("(prefers-color-scheme: dark)").matches ? "#000" : "#fff");
    base.a = 1; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return { bg: base, unsure };
  };
  const contrast = [], byEye = new Set(), type = [], seenC = new Set(), seenT = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const t = tw.currentNode; if (!t.nodeValue.trim()) continue;
    const e = t.parentElement; if (!e || !vis(e) || e.closest("script,style,noscript")) continue;
    const cs = getComputedStyle(e), px = parseFloat(cs.fontSize), weight = +cs.fontWeight || 400;
    const upper = cs.textTransform === "uppercase" || (t.nodeValue.trim().length > 1 && t.nodeValue === t.nodeValue.toUpperCase() && /[A-Z]/.test(t.nodeValue));
    if (!e.closest("footer") && (px < 10.99 || (px < 12.49 && !upper)) && !seenT.has(name(e) + px)) { seenT.add(name(e) + px); type.push(`${px}px  ${name(e)}  "${say(t.nodeValue)}"`); }
    const { bg, unsure } = behind(e);
    if (unsure) { byEye.add(name(e)); continue; }
    const fg = over(parse(cs.color), bg), r = ratio(fg, bg), need = px >= 24 || (px >= 18.66 && weight >= 700) ? 3 : 4.5;
    const key = name(e) + hex(fg) + hex(bg);
    if (r < need && !seenC.has(key)) { seenC.add(key); contrast.push(`${r.toFixed(2)}:1 (needs ${need})  ${name(e)}  ${hex(fg)} on ${hex(bg)}  "${say(t.nodeValue)}"`); }
  }
  const controls = [], focus = [];
  for (const e of document.querySelectorAll("a[href],button,summary,input,select,textarea,[role=button]")) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const inSentence = cs.display === "inline" && e.parentElement && [...e.parentElement.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (!inSentence && !e.closest("footer") && (r.height < 39.5 || r.width < 39.5)) controls.push(`${Math.round(r.width)}x${Math.round(r.height)}  ${name(e)}  "${say(e.textContent || "")}"`);
    const b = { o: cs.outlineStyle + cs.outlineWidth, s: cs.boxShadow, bc: cs.borderColor, bg: cs.backgroundColor };
    e.focus({ preventScroll: true });
    const a = getComputedStyle(e);
    if (!((a.outlineStyle !== "none" && parseFloat(a.outlineWidth) > 0) || a.boxShadow !== b.s || a.borderColor !== b.bc || a.backgroundColor !== b.bg)) focus.push(`${name(e)}  "${say(e.textContent || "")}"`);
    e.blur();
  }
  const res = performance.getEntriesByType("resource").map((r) => ({ u: r.name.replace(location.origin, "").slice(0, 70), kb: r.transferSize / 1024 })).sort((a, b) => b.kb - a.kb);
  const shift = shiftLog.reduce((a, b) => a + b.v, 0);
  return {
    contrast, type, controls, focus, byEye: [...byEye],
    overflow: document.documentElement.scrollWidth > innerWidth ? [`page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`] : [],
    shift: shift > 0.1 ? [`${shift.toFixed(3)} (good is under 0.1)  moved: ${[...new Set(shiftLog.flatMap((s) => s.src))].slice(0, 4).join(", ")}`] : [],
    shiftTotal: shift, kb: res.reduce((a, r) => a + r.kb, 0), top: res.slice(0, 5).map((r) => `${r.kb.toFixed(0)} KB  ${r.u}`),
    height: document.documentElement.scrollHeight,
  };
};
const watchShift = "window.__shift=[];(()=>{const add=l=>{for(const e of l)if(!e.hadRecentInput)window.__shift.push({v:e.value,src:(e.sources||[]).map(x=>x.node&&x.node.nodeName?(x.node.nodeName.toLowerCase()+(x.node.id?'#'+x.node.id:'')):'?')})};const o=new PerformanceObserver(l=>add(l.getEntries()));o.observe({type:'layout-shift',buffered:true});window.__shiftFlush=()=>add(o.takeRecords());})();";
// How long each kind of request is held before it is let through (see "shift" at the top).
// theme.js is let straight through: it sits in <head> so that it runs before the first paint.
const holdMs = (p) => (/\/nav\.js/.test(p.request.url) ? 1500 : /\/theme\.js/.test(p.request.url) ? 0 : p.resourceType === "Script" ? 900 : p.resourceType === "XHR" || p.resourceType === "Fetch" ? 800 : 0);

let failed = false;
for (const scheme of ["light", "dark"]) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 844, deviceScaleFactor: 2, mobile: W < 700 }, s);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, s);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: watchShift }, s);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
  listeners.push({ method: "Fetch.requestPaused", session: s, fn: (p) => setTimeout(() => send("Fetch.continueRequest", { requestId: p.requestId }, s).catch(() => {}), holdMs(p)) });
  const loaded = new Promise((res) => listeners.push({ method: "Page.loadEventFired", session: s, fn: res }));
  await send("Page.navigate", { url }, s); await loaded;
  await new Promise((r) => setTimeout(r, 4000));
  const out = await send("Runtime.evaluate", { expression: `(${audit.toString()})()`, awaitPromise: true, returnByValue: true }, s);
  if (out.exceptionDetails) { console.error("probe failed in the page:", JSON.stringify(out.exceptionDetails).slice(0, 600)); failed = true; continue; }
  const r = out.result.value;
  console.log(`\n${url}  ·  ${W}px  ·  ${scheme}  ·  page is ${r.height}px tall`);
  for (const k of ["contrast", "type", "controls", "focus", "overflow", "shift"]) {
    if (r[k].length) { failed = true; console.log(`  FAIL ${k}`); r[k].forEach((x) => console.log("       " + x)); }
    else console.log(`  ok   ${k}${k === "shift" ? "  " + r.shiftTotal.toFixed(3) : ""}`);
  }
  if (scheme === "light") {
    if (r.byEye.length) console.log(`  by eye (text over a photo or gradient): ${r.byEye.slice(0, 8).join(", ")}`);
    console.log(`  weight ${r.kb.toFixed(0)} KB with every image loaded`); r.top.forEach((x) => console.log("       " + x));
  }
  await send("Target.closeTarget", { targetId });
}
ws.close(); proc.kill();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 400);
