/*
 * Schedule model.
 *
 * The light stores exactly 24 slots, one per clock hour (slot i has hour i and
 * a free minute), and fades linearly between them, wrapping at midnight.
 *
 * People think in key points instead ("ramp up from 9:00, full by 11:00,
 * start sunset at 18:00"), so the app edits a short list of key points:
 *     { t: minute of day (0..1439), v: [6 channel %] }
 * and converts to and from the 24 device slots:
 *   - toSlots: a key point inside an hour takes that hour's slot (keeping its
 *     minute); every other slot sits on the line between key points, so the
 *     light reproduces the curve exactly.
 *   - fromSlots: drops slots that lie on the line between their neighbours,
 *     so 24 slots read from the light become a handful of editable points.
 * The one rule this imposes: at most one key point per clock hour.
 */
(function (root) {
  'use strict';

  var DAY = 1440;
  var N = 6;

  function zeros() { return [0, 0, 0, 0, 0, 0]; }

  function copyPoint(p) { return { t: p.t, v: p.v.slice(0, N) }; }

  function sortPoints(points) {
    return points.map(copyPoint).sort(function (a, b) { return a.t - b.t; });
  }

  function mod(t) { return ((t % DAY) + DAY) % DAY; }

  /* Value of every channel at minute t, linear between points, wrapping at midnight. */
  function valueAt(points, t) {
    if (!points.length) return zeros();
    var pts = sortPoints(points);
    if (pts.length === 1) return pts[0].v.slice();
    t = mod(t);
    var prev = null, next = null;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].t <= t) prev = pts[i];
      if (pts[i].t > t && next === null) next = pts[i];
    }
    var pt, nt;
    if (prev === null) { prev = pts[pts.length - 1]; pt = prev.t - DAY; } else { pt = prev.t; }
    if (next === null) { next = pts[0]; nt = next.t + DAY; } else { nt = next.t; }
    if (nt === pt) return prev.v.slice();
    var f = (t - pt) / (nt - pt);
    var out = [];
    for (var c = 0; c < N; c++) out.push(prev.v[c] + (next.v[c] - prev.v[c]) * f);
    return out;
  }

  function hourOf(t) { return Math.floor(mod(t) / 60); }

  /* Returns the hours that hold more than one key point. */
  function conflicts(points) {
    var seen = {}, bad = [];
    points.forEach(function (p) {
      var h = hourOf(p.t);
      if (seen[h] && bad.indexOf(h) < 0) bad.push(h);
      seen[h] = true;
    });
    return bad;
  }

  function roundV(v) { return v.map(function (x) { return Math.max(0, Math.min(100, Math.round(x))); }); }

  function toSlots(points) {
    var pts = sortPoints(points);
    var slots = [];
    for (var h = 0; h < 24; h++) {
      var inHour = pts.filter(function (p) { return hourOf(p.t) === h; });
      if (inHour.length) slots.push({ h: h, m: mod(inHour[0].t) % 60, v: roundV(inHour[0].v) });
      else slots.push({ h: h, m: 0, v: roundV(valueAt(pts, h * 60)) });
    }
    return slots;
  }

  function slotsToRawPoints(slots) {
    return sortPoints(slots.map(function (s) { return { t: s.h * 60 + s.m, v: s.v.slice(0, N) }; }));
  }

  /*
   * Smallest set of slots that, joined by straight lines (wrapping at
   * midnight), reproduces every slot exactly after rounding. Only on-the-hour
   * slots may be dropped, because toSlots puts fillers on the hour. Found as a
   * shortest path over valid segments, so rounding in the filler slots can
   * never leave stray points behind.
   */
  function fromSlots(slots) {
    var raw = slotsToRawPoints(slots);
    var n = raw.length;
    if (n <= 1) return raw;
    function at(k) { return raw[k % n]; }
    function tAt(k) { return raw[k % n].t + Math.floor(k / n) * DAY; }
    function segmentOk(i, j) { // i < j <= i + n, indices on the unrolled cycle
      var ti = tAt(i), tj = tAt(j), vi = at(i).v, vj = at(j).v;
      for (var k = i + 1; k < j; k++) {
        var p = at(k);
        if (p.t % 60 !== 0) return false;
        var f = tj === ti ? 0 : (tAt(k) - ti) / (tj - ti);
        for (var c = 0; c < N; c++) {
          if (Math.abs(vi[c] + (vj[c] - vi[c]) * f - p.v[c]) > 0.5 + 1e-9) return false;
        }
      }
      return true;
    }
    var best = null;
    for (var s = 0; s < n; s++) {
      var dist = [], prev = [];
      for (var a = 0; a <= n; a++) { dist.push(Infinity); prev.push(-1); }
      dist[0] = 0;
      for (var x = 0; x < n; x++) {
        if (dist[x] === Infinity) continue;
        for (var y = x + 1; y <= n; y++) {
          if (dist[x] + 1 < dist[y] && segmentOk(s + x, s + y)) { dist[y] = dist[x] + 1; prev[y] = x; }
        }
      }
      if (best === null || dist[n] < best.count) {
        var path = [], cur = prev[n];
        while (cur > 0) { path.push((s + cur) % n); cur = prev[cur]; }
        path.push(s);
        best = { count: dist[n], idx: path };
      }
    }
    return sortPoints(best.idx.map(function (k) { return raw[k]; }));
  }

  function slotsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].h !== b[i].h || a[i].m !== b[i].m) return false;
      for (var c = 0; c < N; c++) if ((a[i].v[c] | 0) !== (b[i].v[c] | 0)) return false;
    }
    return true;
  }

  /*
   * Simple photoperiod: off at night, ramp up, hold, ramp down.
   * o.on, o.off: minute of day. o.rampUp, o.rampDown: minutes (>= 60).
   * o.peak, o.night: channel arrays.
   */
  function photoperiod(o) {
    var on = mod(o.on), off = mod(o.off);
    var up = Math.max(60, o.rampUp | 0), down = Math.max(60, o.rampDown | 0);
    var dayLen = mod(off - on);
    if (dayLen < up + down + 60) throw new Error('The light needs at least an hour at full brightness between the ramps.');
    if (DAY - dayLen < 60) throw new Error('Leave at least an hour of night.');
    var night = (o.night || zeros()).slice(0, N);
    var peak = o.peak.slice(0, N);
    return sortPoints([
      { t: on, v: night },
      { t: mod(on + up), v: peak },
      { t: mod(off - down), v: peak },
      { t: off, v: night }
    ]);
  }

  /* Manufacturer defaults from the official app (hour, minute, ch1..ch6). */
  var FACTORY = {
    k7: {
      SPS: [[9, 30, 30, 30, 30, 30, 30], [10, 50, 50, 50, 50, 50, 50], [11, 95, 95, 95, 95, 95, 95], [18, 95, 95, 95, 95, 95, 95], [19, 50, 50, 50, 50, 50, 50], [20, 30, 30, 30, 30, 30, 30]],
      LPS: [[9, 0, 10, 0, 3, 10, 0], [10, 1, 30, 20, 5, 30, 0], [11, 5, 80, 50, 10, 80, 0], [18, 5, 80, 50, 10, 80, 0], [19, 1, 30, 20, 5, 30, 0], [20, 0, 10, 0, 3, 10, 0]],
      'Soft coral': [[9, 5, 20, 20, 20, 20, 0], [10, 10, 40, 40, 40, 40, 5], [11, 30, 90, 90, 70, 90, 20], [18, 30, 90, 90, 70, 90, 20], [19, 10, 40, 40, 40, 40, 5], [20, 5, 20, 20, 20, 20, 0]]
    },
    mini: {
      SPS: [[9, 30, 30, 30, 0, 0, 0], [10, 50, 50, 50, 0, 0, 0], [11, 95, 95, 95, 0, 0, 0], [18, 95, 95, 95, 0, 0, 0], [19, 50, 50, 50, 0, 0, 0], [20, 30, 30, 30, 0, 0, 0]],
      LPS: [[9, 0, 10, 0, 0, 0, 0], [10, 1, 30, 20, 0, 0, 0], [11, 5, 80, 50, 0, 0, 0], [18, 5, 80, 50, 0, 0, 0], [19, 1, 30, 20, 0, 0, 0], [20, 0, 10, 0, 0, 0, 0]],
      'Soft coral': [[9, 5, 20, 20, 0, 0, 0], [10, 10, 40, 40, 0, 0, 0], [11, 30, 90, 90, 0, 0, 0], [18, 30, 90, 90, 0, 0, 0], [19, 10, 40, 40, 0, 0, 0], [20, 5, 20, 20, 0, 0, 0]]
    }
  };

  /* Factory slots: hours 0-8 and 21-23 are off, listed hours as above. */
  function factorySlots(model, name) {
    var rows = FACTORY[model][name];
    var byHour = {};
    rows.forEach(function (r) { byHour[r[0]] = r.slice(1); });
    // the official tables repeat the 11:00 values every hour until 18:00
    for (var h = 12; h < 18; h++) byHour[h] = byHour[11];
    var slots = [];
    for (var i = 0; i < 24; i++) slots.push({ h: i, m: 0, v: byHour[i] ? byHour[i].slice() : zeros() });
    return slots;
  }

  function factoryPoints(model, name) { return fromSlots(factorySlots(model, name)); }

  function fmtTime(t) {
    t = mod(Math.round(t));
    var h = Math.floor(t / 60), m = t % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function parseTime(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  var api = {
    DAY: DAY,
    zeros: zeros,
    sortPoints: sortPoints,
    valueAt: valueAt,
    hourOf: hourOf,
    conflicts: conflicts,
    toSlots: toSlots,
    fromSlots: fromSlots,
    slotsEqual: slotsEqual,
    photoperiod: photoperiod,
    FACTORY: FACTORY,
    factorySlots: factorySlots,
    factoryPoints: factoryPoints,
    fmtTime: fmtTime,
    parseTime: parseTime
  };

  root.NooSchedule = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
