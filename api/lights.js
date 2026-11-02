// Holiday lights map (/lights): neighbors behind the gate mark their house once the
// lights are up, as "lights" or "lights + display" (inflatables, figures, a show),
// so families know which streets to walk. The rules, the code check and the
// storage are in _pins.js, shared with the Halloween treat map (treats.js); this
// file is what makes it the lights one. Same neighbor code as the treat map.

const { mapModule } = require("./_pins.js");

// The map opens Nov 1 (there's no set date to decorate: a house goes on when its
// lights are up) and closes at midnight after New Year's Day, Pacific time. Nov 1
// is daylight time (UTC-7); Jan 2 is standard time (UTC-8). The season is named
// for the year it opens in, so Jan 1, 2027 is still season 2026.
function season(now) {
  const y = new Date(now - 8 * 3600e3).getUTCFullYear(); // the Pacific year, to the hour
  const janClose = Date.UTC(y, 0, 2, 8);
  if (now < janClose) return { year: y - 1, open: Date.UTC(y - 1, 10, 1, 7), close: janClose, phase: "open" };
  const open = Date.UTC(y, 10, 1, 7), close = Date.UTC(y + 1, 0, 2, 8);
  return { year: y, open, close, phase: now < open ? "before" : "open" };
}

module.exports = mapModule({
  key: "lights",
  how: ["lights", "display"],
  until: ["", "20:00", "21:00", "22:00", "23:00"], // "" = no set time
  flags: ["music"],                                // the lights are set to music
  season,
});
