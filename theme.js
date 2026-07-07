/* Tesoro Highlands — theme boot. Loaded synchronously in <head> so the right
   theme applies before first paint. Modes: auto (follow system) | light | dark. */
(function () {
  "use strict";
  var KEY = "tesoro.theme";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function stored() {
    try { var v = localStorage.getItem(KEY); if (v === "light" || v === "dark") return v; } catch (e) {}
    return "auto";
  }
  function effective(mode) {
    mode = mode || stored();
    return mode === "auto" ? (mq && mq.matches ? "dark" : "light") : mode;
  }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", effective(mode) === "dark" ? "#0f1114" : "#f4f5f7");
    try { window.dispatchEvent(new CustomEvent("themechange", { detail: { mode: mode, effective: effective(mode) } })); } catch (e) {}
  }

  window.__theme = {
    get: stored,
    effective: function () { return effective(); },
    set: function (mode) {
      try { if (mode === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) {}
      apply(mode);
    }
  };

  apply(stored());
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (stored() === "auto") apply("auto"); });
})();
