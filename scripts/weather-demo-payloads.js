// Dummy backyard weather payloads for local `server.js` design preview only.
// Times are generated at request so hourly/daily windows stay current.

function laDayStartUnix(offsetDays) {
  const when = new Date(Date.now() + offsetDays * 86400000);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(when);
  return Math.floor(new Date(ymd + "T12:00:00-07:00").getTime() / 1000);
}

function demoPurpleair() {
  const lastSeen = Math.floor(Date.now() / 1000) - 4 * 60;
  return {
    generatedAt: new Date().toISOString(),
    source: "PurpleAir",
    ok: true,
    demo: true,
    primary: {
      label: "Neighbor PurpleAir near Tesoro Highlands",
      aqi: 81,
      pm25: 22.4,
      pm25Raw: 28.1,
      humidity: 32,
      confidence: 100,
      lastSeen: lastSeen,
      ageSec: 240,
      conversion: "US-EPA",
      averageMin: 10,
      aqiEpa: 68,
      pm25Epa: 19.6,
      epaAverageMin: 60,
      epaConversion: "EPA-2021-ATM-5seg"
    },
    peers: null
  };
}

function demoHistory() {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  const wave = [52, 48, 45, 49, 55, 61, 66, 70, 74, 72, 69, 64, 60, 58, 62, 67, 71, 68, 63, 59, 56, 54, 57, 61];
  for (let i = 0; i < 24; i++) {
    history.push({ t: now - (23 - i) * 3600, aqi: wave[i] });
  }
  return {
    generatedAt: new Date().toISOString(),
    ok: true,
    demo: true,
    history: history
  };
}

function demoForecast() {
  const now = Math.floor(Date.now() / 1000);
  const hourIcons = [
    "clear-day", "clear-day", "partly-cloudy-day", "partly-cloudy-day",
    "partly-cloudy-day", "cloudy", "possibly-rainy-day", "rainy"
  ];
  const hourly = [];
  for (let i = 0; i < 24; i++) {
    const t = now - (now % 3600) + i * 3600;
    const temp = 78 + Math.round(10 * Math.sin((i - 4) / 4));
    hourly.push({
      time: t,
      icon: hourIcons[i % hourIcons.length],
      conditions: i % 8 === 7 ? "Rain likely" : "Partly cloudy",
      tempF: temp,
      feelsLikeF: temp - 2,
      precipProbability: i % 8 === 7 ? 55 : i % 8 === 6 ? 30 : 5,
      precipIn: i % 8 === 7 ? 0.04 : 0,
      windMph: 4 + (i % 5),
      uv: i >= 8 && i <= 16 ? Math.max(0, 9 - Math.abs(i - 13)) : 0
    });
  }

  const days = [
    { icon: "clear-day", hi: 97, lo: 68, pop: 0 },
    { icon: "clear-day", hi: 99, lo: 70, pop: 0 },
    { icon: "partly-cloudy-day", hi: 95, lo: 67, pop: 10 },
    { icon: "possibly-rainy-day", hi: 88, lo: 64, pop: 40 },
    { icon: "cloudy", hi: 86, lo: 63, pop: 20 },
    { icon: "clear-day", hi: 92, lo: 65, pop: 0 },
    { icon: "clear-day", hi: 98, lo: 69, pop: 0 },
    { icon: "partly-cloudy-day", hi: 101, lo: 72, pop: 5 },
    { icon: "clear-day", hi: 100, lo: 71, pop: 0 },
    { icon: "clear-day", hi: 96, lo: 68, pop: 0 }
  ];

  const daily = days.map(function (d, i) {
    return {
      dayStart: laDayStartUnix(i),
      icon: d.icon,
      conditions: d.pop >= 40 ? "Chance of rain" : "Sunny",
      tempHighF: d.hi,
      tempLowF: d.lo,
      precipProbability: d.pop
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    source: "Tempest",
    ok: true,
    demo: true,
    currentStale: false,
    current: {
      conditions: "Partly cloudy",
      icon: "partly-cloudy-day",
      tempF: 89,
      feelsLikeF: 87,
      rh: 28,
      windMph: 6.2,
      gustMph: 11.4,
      wdir: 225,
      uv: 8,
      pressureMb: 1011,
      dewpointF: 51,
      precipMinutesToday: 0,
      precipTodayIn: 0,
      pressureTrend: "falling",
      obsTime: now - 90,
      ageSec: 90
    },
    hourly: hourly,
    daily: daily
  };
}

module.exports = { demoPurpleair, demoHistory, demoForecast };
