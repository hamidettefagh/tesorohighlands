// Halloween treat map (/treats): neighbors behind the gate mark their house as
// "knock for candy" or "candy out front", and flip to "out of candy" on the night.
// The rules, the code check and the storage are in _pins.js, shared with the
// holiday lights map (lights.js); this file is what makes it the Halloween one.

const { mapModule } = require("./_pins.js");

// The map opens Oct 1 and closes at midnight after Halloween, Pacific time.
// Midnight on Nov 1 is always still daylight time (it ends the first Sunday of
// November at 2 AM), so both edges are UTC-7.
function season(now) {
  const year = new Date(now - 7 * 3600e3).getUTCFullYear();
  const open = Date.UTC(year, 9, 1, 7), close = Date.UTC(year, 10, 1, 7);
  return { year, open, close, night: year + "-10-31", phase: now < open ? "before" : now < close ? "open" : "closed" };
}

module.exports = mapModule({
  key: "treats",
  how: ["knock", "bowl"],
  until: ["", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"], // "" = until it runs out
  flags: ["teal", "decor"],                                           // teal pumpkin, spooky yard
  season,
});
