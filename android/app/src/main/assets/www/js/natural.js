/*
 * Natural cycle: a real reef's day, seasons and moon, turned into the light's
 * 24 daily slots, one day at a time.
 *
 * Modelled on the ex situ Acropora spawning protocol of Craggs et al. (2017,
 * Ecology and Evolution 7:11066): the reef's sunrise and sunset, a 3 hour
 * ramp from 0 at sunrise to the midday level and back to 0 at sunset, midday
 * intensity scaled through the year between 60% and 100% following the
 * reef's sunlight, and moonlight from moonrise to moonset following the
 * phase. The cue that triggers spawning, the dark gap between sunset and
 * moonrise on nights after the full moon (Lin et al. 2021, PNAS 118:
 * e2101985118), comes out of the real moon times.
 *
 * The light stores one point per clock hour and fades linearly between them,
 * so each day's curve is fitted to the best 24 points (dynamic programming),
 * weighting darkness and moonlight heavily so the night cues stay accurate.
 */
(function (root) {
  'use strict';
  var A = root.NooAstro || (typeof require !== 'undefined' ? require('./astro.js') : null);

  var DAY = 1440;
  var STEP = 5; // minutes between samples and candidate points

  var REEFS = [
    {
      id: 'singapore', name: 'Singapore, Kusu reef', lat: 1.223874, lon: 103.862622,
      spawning: 'Mass spawning 3 to 5 nights after the full moon in late March or early April.',
      source: 'Craggs et al. 2017'
    },
    {
      id: 'lizard', name: 'Great Barrier Reef, Lizard Island', lat: -14.687517, lon: 145.4635,
      spawning: 'Inner reef mass spawning 4 to 6 nights after the full moon in late October or early November.',
      source: 'Craggs et al. 2017'
    },
    {
      id: 'palau', name: 'Palau', lat: 7.34, lon: 134.48,
      spawning: 'Acropora spawned 5 nights after the March 2022 full moon, and 2 nights before the April one.',
      source: 'de la Torre Cerro et al. 2025'
    }
  ];

  function defaults(mix, model) {
    var mini = model === 'mini';
    return {
      reefId: 'singapore',
      lat: REEFS[0].lat,
      lon: REEFS[0].lon,
      seasonShiftMonths: 0,
      middayAt: 13 * 60,
      rampMin: 180,
      seasonMinPct: 60,
      mix: (mix || [40, 90, 20, 60, 80, 10]).slice(0, 6),
      moon: mini ? [0, 1, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0],
      steadyDst: true
    };
  }

  function reefById(id) {
    for (var i = 0; i < REEFS.length; i++) if (REEFS[i].id === id) return REEFS[i];
    return null;
  }

  // ---- calendar helpers -------------------------------------------------------

  function ymd(date) {
    var m = date.getMonth() + 1, d = date.getDate();
    return date.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }

  function parseYmd(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function addDays(date, n) { var d = new Date(date.valueOf()); d.setDate(d.getDate() + n); return d; }

  /* Minutes the phone clock is ahead of its standard time on this date (daylight saving). */
  function dstMinutes(date) {
    var y = date.getFullYear();
    var std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
    return std - date.getTimezoneOffset();
  }

  /*
   * The mapping between the tank's clock and the reef. Tank minute t on tank
   * date D is reef local mean solar time (t - shift) on reef date D + offset,
   * where shift moves the reef's mean noon to "midday on the tank".
   */
  function clockFor(settings, tankDate) {
    var shiftDays = Math.round((settings.seasonShiftMonths || 0) * 30.4375);
    var reef = addDays(tankDate, shiftDays);
    var dst = settings.steadyDst ? dstMinutes(tankDate) : 0;
    var shift = settings.middayAt - 720 + dst;
    var base = Date.UTC(reef.getFullYear(), reef.getMonth(), reef.getDate()) - settings.lon * 4 * 60000;
    return {
      reefDate: reef,
      shift: shift,
      utc: function (t) { return new Date(base + (t - shift) * 60000); },
      tank: function (utcDate) { return (utcDate.valueOf() - base) / 60000 + shift; }
    };
  }

  // ---- season ---------------------------------------------------------------------

  var insolationCache = {};
  function yearRange(lat) {
    var key = lat.toFixed(3);
    if (!insolationCache[key]) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < 365; i++) {
        var h = A.dailyInsolation(new Date(Date.UTC(2026, 0, 1 + i, 12)), lat);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      insolationCache[key] = { lo: lo, hi: hi };
    }
    return insolationCache[key];
  }

  /* 0.6 .. 1.0 (for seasonMinPct 60): where this date sits in the reef's sunlight year. */
  function seasonFactor(settings, reefDate) {
    var r = yearRange(settings.lat);
    var h = A.dailyInsolation(new Date(Date.UTC(reefDate.getFullYear(), reefDate.getMonth(), reefDate.getDate(), 12)), settings.lat);
    var x = r.hi - r.lo < 1e-6 ? 1 : (h - r.lo) / (r.hi - r.lo);
    var min = Math.max(0, Math.min(100, settings.seasonMinPct)) / 100;
    return min + (1 - min) * x;
  }

  // ---- one day -------------------------------------------------------------------------

  /* Everything needed to evaluate the desired light at any tank minute of one tank day. */
  function dayModel(settings, tankDate) {
    var clk = clockFor(settings, tankDate);
    var from = clk.utc(-720), to = clk.utc(DAY + 720);
    var sun = A.sunEvents(from, to, settings.lat, settings.lon).map(function (e) { return { t: clk.tank(e.time), rising: e.rising }; });
    var moonEv = A.moonEvents(from, to, settings.lat, settings.lon).map(function (e) { return { t: clk.tank(e.time), rising: e.rising }; });
    // the day's sunrise and sunset: the ones nearest the reef's 6:00 and 18:00
    var nearest = function (list, rising, target) {
      var best = null;
      list.forEach(function (e) { if (e.rising === rising && (!best || Math.abs(e.t - target) < Math.abs(best.t - target))) best = e; });
      return best ? best.t : null;
    };
    var sunrise = nearest(sun, true, 360 + clk.shift);
    var sunset = nearest(sun, false, 1080 + clk.shift);
    var factor = seasonFactor(settings, clk.reefDate);
    var peak = settings.mix.map(function (v) { return v * factor; });
    var dayLen = sunset - sunrise;
    var ramp = Math.min(settings.rampMin, dayLen / 2);

    // moon illumination, hourly, for interpolation
    var illum = [];
    for (var h = -1; h <= 25; h++) illum.push(A.moonIllumination(clk.utc(h * 60)).fraction);

    function daylight(t) {
      if (t <= sunrise || t >= sunset) return 0;
      if (t < sunrise + ramp) return (t - sunrise) / ramp;
      if (t > sunset - ramp) return (sunset - t) / ramp;
      return 1;
    }
    function fractionAt(t) {
      var x = Math.max(-60, Math.min(25 * 60, t)) / 60 + 1;
      var i = Math.floor(x), f = x - i;
      return illum[Math.min(i, illum.length - 1)] * (1 - f) + illum[Math.min(i + 1, illum.length - 1)] * f;
    }
    function moonFactor(t) {
      var alt = A.moonAltitude(clk.utc(t), settings.lat, settings.lon);
      return Math.max(0, Math.min(1, (alt - A.MOON_H0) / 6)); // full brightness about 25 minutes after moonrise
    }
    /* Desired channel values at tank minute t (t may be outside 0..1440 for the neighbouring days). */
    function value(t) {
      var d = daylight(t);
      var mf = settings.moon.some(function (x) { return x > 0; }) ? moonFactor(t) : 0;
      var frac = mf > 0 ? fractionAt(t) : 0;
      var out = [];
      for (var c = 0; c < 6; c++) {
        var sunV = peak[c] * d;
        var moonV = mf > 0 ? Math.round(settings.moon[c] * frac) * mf : 0;
        out.push(Math.max(sunV, moonV));
      }
      return out;
    }
    return {
      tankDate: tankDate, reefDate: clk.reefDate, clock: clk,
      sunrise: sunrise, sunset: sunset, ramp: ramp, factor: factor, peak: peak,
      moonEvents: moonEv, value: value
    };
  }

  // ---- fitting to 24 hourly points -----------------------------------------------------

  function err(L, D) { return Math.abs(L - D) / (Math.max(L, D) + 1); }

  /* Best 24 points (one per clock hour) for one day's curve. Returns slots and the model. */
  function fitDay(model) {
    // candidate points: every 5 minutes plus the exact event times
    var events = [model.sunrise, model.sunrise + model.ramp, model.sunset - model.ramp, model.sunset]
      .concat(model.moonEvents.map(function (e) { return e.t; }));
    var cands = [];
    for (var h = 0; h < 24; h++) {
      var set = {};
      for (var m = 0; m < 60; m += STEP) set[h * 60 + m] = true;
      events.forEach(function (t) {
        var tt = ((Math.round(t) % DAY) + DAY) % DAY;
        if (Math.floor(tt / 60) === h) set[tt] = true;
      });
      cands.push(Object.keys(set).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return { t: t, v: model.value(t) }; }));
    }
    // samples every 5 minutes over the day plus a margin for the wrap-around segment
    var samples = [];
    for (var s = 0; s < DAY + 120; s += STEP) samples.push({ t: s, v: model.value(s >= DAY ? s - DAY : s) });
    function segCost(a, b, wrap) {
      var tb = b.t + (wrap ? DAY : 0), cost = 0;
      var i0 = Math.ceil((a.t + 1e-9) / STEP);
      for (var i = i0; i < samples.length && samples[i].t < tb; i++) {
        var f = (samples[i].t - a.t) / (tb - a.t), sv = samples[i].v;
        for (var c = 0; c < 6; c++) cost += err(a.v[c] + (b.v[c] - a.v[c]) * f, sv[c]);
      }
      return cost;
    }
    // segment costs between consecutive hours (hour 23 wraps to hour 0 of the next day)
    var seg = [];
    for (var h2 = 0; h2 < 24; h2++) {
      var next = (h2 + 1) % 24, rows = [];
      for (var a = 0; a < cands[h2].length; a++) {
        var row = [];
        for (var b = 0; b < cands[next].length; b++) row.push(segCost(cands[h2][a], cands[next][b], h2 === 23));
        rows.push(row);
      }
      seg.push(rows);
    }
    var best = { cost: Infinity, path: null };
    for (var start = 0; start < cands[0].length; start++) {
      var cost = [], back = [];
      cost[0] = cands[0].map(function (_, j) { return j === start ? 0 : Infinity; });
      for (var hh = 1; hh < 24; hh++) {
        cost[hh] = []; back[hh] = [];
        for (var j = 0; j < cands[hh].length; j++) {
          var bc = Infinity, bk = -1;
          for (var k = 0; k < cands[hh - 1].length; k++) {
            var c2 = cost[hh - 1][k] + seg[hh - 1][k][j];
            if (c2 < bc) { bc = c2; bk = k; }
          }
          cost[hh][j] = bc; back[hh][j] = bk;
        }
      }
      for (var j2 = 0; j2 < cands[23].length; j2++) {
        var total = cost[23][j2] + seg[23][j2][start];
        if (total < best.cost) {
          var path = [j2];
          for (var h3 = 23; h3 > 0; h3--) path.unshift(back[h3][path[0]]);
          best = { cost: total, path: path };
        }
      }
    }
    var slots = best.path.map(function (j, h4) {
      var p = cands[h4][j];
      return { h: h4, m: p.t % 60, v: p.v.map(function (x) { return Math.max(0, Math.min(100, Math.round(x))); }) };
    });
    return { slots: slots, cost: best.cost };
  }

  function computeDay(settings, tankDate) {
    var model = dayModel(settings, tankDate);
    var fit = fitDay(model);
    return { slots: fit.slots, model: model, cost: fit.cost };
  }

  // ---- what the light will actually do, and the night calendar --------------------------------

  /* The light's output at tank minute t for these slots (linear between points, wrapping). */
  function slotValue(slots, t) {
    var pts = slots.map(function (s) { return { t: s.h * 60 + s.m, v: s.v }; });
    var prev = pts[pts.length - 1], pt = prev.t - DAY, next = pts[0], nt = next.t;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].t <= t) { prev = pts[i]; pt = pts[i].t; next = pts[(i + 1) % pts.length]; nt = i + 1 < pts.length ? next.t : next.t + DAY; }
    }
    var f = nt === pt ? 0 : (t - pt) / (nt - pt);
    return prev.v.map(function (v, c) { return v + (next.v[c] - v) * f; });
  }

  function phaseName(fraction, waxing) {
    if (fraction < 0.03) return 'New moon';
    if (fraction > 0.97) return 'Full moon';
    if (Math.abs(fraction - 0.5) < 0.06) return waxing ? 'First quarter' : 'Last quarter';
    if (fraction < 0.5) return waxing ? 'Waxing crescent' : 'Waning crescent';
    return waxing ? 'Waxing gibbous' : 'Waning gibbous';
  }

  /*
   * One evening on the tank: sunset, moonrise and the dark gap between them,
   * illumination, and nights after the last full moon.
   */
  function night(settings, tankDate) {
    var model = dayModel(settings, tankDate);
    var clk = model.clock;
    var after = model.moonEvents.filter(function (e) { return e.rising && e.t > model.sunset - 12 * 60; })
      .sort(function (a, b) { return a.t - b.t; });
    var rise = after.length ? after[0].t : null;
    var sets = model.moonEvents.filter(function (e) { return !e.rising; }).map(function (e) { return e.t; });
    var upAtSunset = A.moonAltitude(clk.utc(model.sunset), settings.lat, settings.lon) > A.MOON_H0;
    var nextRise = model.moonEvents.filter(function (e) { return e.rising && e.t > model.sunset; }).sort(function (a, b) { return a.t - b.t; })[0];
    var gap = upAtSunset ? 0 : (nextRise ? Math.round(nextRise.t - model.sunset) : null);
    var il = A.moonIllumination(clk.utc(model.sunset + 120));
    var fulls = A.fullMoons(new Date(clk.utc(model.sunset).valueOf() - 31 * 86400000), clk.utc(model.sunset));
    var lastFull = fulls.length ? fulls[fulls.length - 1] : null;
    var nafm = lastFull ? Math.floor((clk.utc(model.sunset).valueOf() - lastFull.valueOf()) / 86400000) + 1 : null;
    return {
      tankDate: tankDate,
      reefDate: model.reefDate,
      sunrise: model.sunrise,
      sunset: model.sunset,
      moonrise: rise,
      moonsets: sets,
      upAtSunset: upAtSunset,
      darkGap: gap,
      fraction: il.fraction,
      waxing: il.waxing,
      phase: phaseName(il.fraction, il.waxing),
      nightsAfterFull: nafm,
      season: model.factor
    };
  }

  function fmt(t) {
    if (t == null) return '-';
    t = ((Math.round(t) % DAY) + DAY) % DAY;
    var h = Math.floor(t / 60), m = t % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  var api = {
    REEFS: REEFS,
    defaults: defaults,
    reefById: reefById,
    ymd: ymd,
    parseYmd: parseYmd,
    addDays: addDays,
    clockFor: clockFor,
    seasonFactor: seasonFactor,
    dayModel: dayModel,
    computeDay: computeDay,
    slotValue: slotValue,
    night: night,
    phaseName: phaseName,
    fmt: fmt
  };
  root.NooNatural = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
