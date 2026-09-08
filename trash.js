// Tesoro Highlands trash schedule — the one place that knows our pickup day and
// Burrtec's holiday rule. Loaded (without defer, ahead of each page's own script)
// by / for the Living card and by /living for the trash section.
//
// Source: burrtec.com/residential-services → "Holiday Schedule". Six holidays:
// New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day,
// Christmas Day. "When a holiday falls on a weekday, service will be delayed by
// one day" for the rest of that week; a holiday on a Saturday or Sunday changes
// nothing. For our Tuesday route that means a Monday or Tuesday holiday moves
// pickup to Wednesday, and Thanksgiving (always a Thursday) never touches it.
//
// Everything is computed in the visitor's local time — our neighbors are in
// Pacific time, and a day boundary is the only thing that matters here.
(function () {
  "use strict";
  var PICKUP_DOW = 2; // 0 = Sunday … 2 = Tuesday

  function day(y, m, d) { return new Date(y, m, d); }
  function addDays(d, n) { return day(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  // n-th weekday (0–6) of month m, and the last one.
  function nthDow(y, m, dow, n) { var first = day(y, m, 1); return day(y, m, 1 + ((dow - first.getDay() + 7) % 7) + 7 * (n - 1)); }
  function lastDow(y, m, dow) { var last = day(y, m + 1, 0); return addDays(last, -((last.getDay() - dow + 7) % 7)); }
  function weekMonday(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function today() { var n = new Date(); return day(n.getFullYear(), n.getMonth(), n.getDate()); }

  function holidays(y) {
    return [
      { name: "New Year's Day", date: day(y, 0, 1) },
      { name: "Memorial Day", date: lastDow(y, 4, 1) },
      { name: "Independence Day", date: day(y, 6, 4) },
      { name: "Labor Day", date: nthDow(y, 8, 1, 1) },
      { name: "Thanksgiving", date: nthDow(y, 10, 4, 4) },
      { name: "Christmas Day", date: day(y, 11, 25) }
    ];
  }

  // Our pickup in the week that starts on `monday`, and whether a weekday
  // holiday on or before that day pushes it back one.
  function pickupForWeek(monday) {
    var scheduled = addDays(monday, PICKUP_DOW - 1);
    var years = [monday.getFullYear()];
    if (scheduled.getFullYear() !== years[0]) years.push(scheduled.getFullYear());
    for (var yi = 0; yi < years.length; yi++) {
      var hs = holidays(years[yi]);
      for (var i = 0; i < hs.length; i++) {
        var h = hs[i], dow = h.date.getDay();
        if (dow >= 1 && dow <= PICKUP_DOW && h.date >= monday && h.date <= scheduled) {
          return { scheduled: scheduled, date: addDays(scheduled, 1), delayed: true, holiday: h.name };
        }
      }
    }
    return { scheduled: scheduled, date: scheduled, delayed: false, holiday: null };
  }

  // The next pickup on or after `from` (default: today).
  function next(from) {
    var t = from ? day(from.getFullYear(), from.getMonth(), from.getDate()) : today();
    var p = pickupForWeek(weekMonday(t));
    if (p.date < t) p = pickupForWeek(addDays(weekMonday(t), 7));
    return p;
  }

  // The next six holidays (one full cycle) from the start of this week, each
  // with the pickup it moves — `pickup` is null when it leaves our day alone.
  function upcoming(from) {
    var t = from ? day(from.getFullYear(), from.getMonth(), from.getDate()) : today();
    var start = weekMonday(t), y = t.getFullYear();
    return holidays(y).concat(holidays(y + 1))
      .filter(function (h) { return h.date >= start; })
      .slice(0, 6)
      .map(function (h) {
        var p = pickupForWeek(weekMonday(h.date));
        return { name: h.name, date: h.date, pickup: p.delayed ? p.date : null, thisWeek: weekMonday(h.date).getTime() === start.getTime() };
      });
  }

  function fmt(d, o) { return d.toLocaleDateString([], o || { weekday: "long", month: "short", day: "numeric" }); }

  window.tesoroTrash = { PICKUP_DOW: PICKUP_DOW, holidays: holidays, next: next, upcoming: upcoming, fmt: fmt, today: today };
})();
