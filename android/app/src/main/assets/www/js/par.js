/*
 * PAR calibration and planning.
 *
 * One person with a PAR meter calibrates a light model once (the wizard in the
 * app steps through the readings). The result is a small JSON "calibration"
 * that ships with the app, so anyone with the same light can ask
 * "I want 250 PAR, 30 cm deep, 10 cm off centre, light 20 cm above the water"
 * and get channel settings with an estimate.
 *
 * The model:
 *   PAR = combined(load) x sum over channels of  I0[c] x G(c, position) x curve[c](value%)
 *
 *   I0[c]      how strong channel c is (fitted)
 *   G          geometry: where the sensor is, the beam spread of channel c (fitted
 *              exponent m[c]), the size of the fixture, refraction and reflection
 *              at the water surface, and absorption in the water
 *   curve[c]   what fraction of full output the light gives at a slider value
 *              (measured; LED drivers are rarely linear, least of all at the low end)
 *   combined   how much less the light gives when many channels are on at once
 *              (heat, or a power limit in the driver), measured with all channels on
 *
 * Positions: { medium: 'air', dist: cm below the light, offset: cm to the side }
 *            { medium: 'water', depth: cm below the surface, offset: cm to the side }
 *            Water positions also need the light's height above the water.
 */
(function (root) {
  'use strict';

  var N_WATER = 1.34;
  // Absorption of clear seawater, per metre, roughly at each channel's peak.
  // Small next to the geometry except for red.
  var ABSORB = { k7: [0.06, 0.02, 0.05, 0.03, 0.02, 0.4], mini: [0.06, 0.02, 0.03] };
  var CURVE_LEVELS = [10, 25, 50, 75];
  var CORRECTION_DEFAULT = { add: 40, mult: 1 };

  function nCh(model) { return model === 'mini' ? 3 : 6; }
  function zeros() { return [0, 0, 0, 0, 0, 0]; }
  function only(c, v) { var a = zeros(); a[c] = v; return a; }
  function all(model, v) { var a = zeros(); for (var i = 0; i < nCh(model); i++) a[i] = v; return a; }

  // ---- geometry -------------------------------------------------------------

  /* Fresnel transmittance, air to water, unpolarised, at incidence angle ta. */
  function fresnelT(ta) {
    if (ta < 1e-6) { var r0 = (N_WATER - 1) / (N_WATER + 1); return 1 - r0 * r0; }
    var tw = Math.asin(Math.sin(ta) / N_WATER);
    var rs = Math.sin(ta - tw) / Math.sin(ta + tw);
    var rp = Math.tan(ta - tw) / Math.tan(ta + tw);
    return 1 - (rs * rs + rp * rp) / 2;
  }

  /*
   * Irradiance on a level sensor from a point source of intensity cos^m(theta)
   * (1 at straight down), units of 1/cm^2.
   * h: cm from the source down to the water surface (or to the sensor in air)
   * d: cm of water above the sensor (0 in air), rho: cm horizontally, k: absorption /m
   */
  function pointE(m, h, d, rho, k) {
    if (d <= 0) {
      var R2 = h * h + rho * rho, c = h / Math.sqrt(R2);
      return Math.pow(c, m) * c / R2;
    }
    // find the air angle whose refracted ray lands rho away
    var land = function (ta) { var tw = Math.asin(Math.sin(ta) / N_WATER); return h * Math.tan(ta) + d * Math.tan(tw); };
    var lo = 0, hi = Math.PI / 2 - 1e-6;
    if (rho > 1e-6) { for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (land(mid) < rho) lo = mid; else hi = mid; } }
    var ta = rho > 1e-6 ? (lo + hi) / 2 : 0;
    var tw = Math.asin(Math.sin(ta) / N_WATER);
    var ca = Math.cos(ta), cw = Math.cos(tw);
    var path = d / cw / 100;
    var atten = Math.exp(-(k || 0) * path) * fresnelT(ta);
    // flux tube: E = I * sin(ta) dta / (r dr); on axis the limit is I / (h + d/n)^2 with the cosine factors
    var drdta = h / (ca * ca) + d / (cw * cw) * (ca / (N_WATER * cw));
    var spread = rho > 1e-6 ? Math.sin(ta) / (rho * drdta) : 1 / (drdta * drdta);
    return Math.pow(ca, m) * atten * spread;
  }

  /* Geometry factor for one channel at one position: the fixture as a square of side 2a, sampled. */
  function geom(m, a, pos, lightHeight, k) {
    var h, d;
    if (pos.medium === 'air') { h = pos.dist; d = 0; } else { h = lightHeight; d = pos.depth; }
    var off = pos.offset || 0;
    if (!(a > 0)) return pointE(m, h, d, Math.abs(off), k);
    var n = 5, sum = 0;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var sx = -a + (2 * a) * (i + 0.5) / n, sy = -a + (2 * a) * (j + 0.5) / n;
        sum += pointE(m, h, d, Math.sqrt((off - sx) * (off - sx) + sy * sy), k);
      }
    }
    return sum / (n * n);
  }

  // ---- the measurement plan -------------------------------------------------

  function defaultPositions() {
    return [
      { id: 'air20', medium: 'air', dist: 20, offset: 0 },
      { id: 'w10c', medium: 'water', depth: 10, offset: 0 },
      { id: 'w25c', medium: 'water', depth: 25, offset: 0, ref: true },
      { id: 'w40c', medium: 'water', depth: 40, offset: 0 },
      { id: 'w10s30', medium: 'water', depth: 10, offset: 30 },
      { id: 'w40s15', medium: 'water', depth: 40, offset: 15 },
      { id: 'w40s30', medium: 'water', depth: 40, offset: 30 }
    ];
  }

  function posLabel(p) {
    var side = p.offset ? ', ' + p.offset + ' cm to the side' : ', centre';
    return p.medium === 'air' ? 'In air, ' + p.dist + ' cm below the light' + side : p.depth + ' cm deep' + side;
  }

  /*
   * The list of readings, in order. Each step: { key, pos (index), kind, ch, level, values }.
   * kind: dark | ch | all | curve. The dimming curves are measured at the reference position.
   */
  function buildSteps(model, positions) {
    var n = nCh(model), steps = [];
    var refIdx = positions.findIndex(function (p) { return p.ref; });
    if (refIdx < 0) refIdx = 0;
    positions.forEach(function (p, pi) {
      steps.push({ key: pi + ':dark', pos: pi, kind: 'dark', values: zeros() });
      for (var c = 0; c < n; c++) steps.push({ key: pi + ':ch' + c, pos: pi, kind: 'ch', ch: c, level: 100, values: only(c, 100) });
      steps.push({ key: pi + ':all100', pos: pi, kind: 'all', level: 100, values: all(model, 100) });
      steps.push({ key: pi + ':all50', pos: pi, kind: 'all', level: 50, values: all(model, 50) });
      if (pi === refIdx) {
        for (var c2 = 0; c2 < n; c2++) {
          CURVE_LEVELS.forEach(function (lv) { steps.push({ key: pi + ':curve' + c2 + '@' + lv, pos: pi, kind: 'curve', ch: c2, level: lv, values: only(c2, lv) }); });
        }
        steps.push({ key: pi + ':dark2', pos: pi, kind: 'dark', values: zeros() });
      }
    });
    return steps;
  }

  function correct(raw, corr) {
    corr = corr || CORRECTION_DEFAULT;
    return raw * (corr.mult == null ? 1 : corr.mult) + (corr.add || 0);
  }

  // ---- fitting --------------------------------------------------------------

  function interp(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) { var a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    }
    return pts[pts.length - 1][1];
  }

  /*
   * run: { model, lightHeight, positions, correction, readings: { stepKey: raw } }
   * Returns a calibration, or throws with what is missing.
   */
  function fit(run) {
    var model = run.model, n = nCh(model), pos = run.positions, R = run.readings || {};
    var val = function (key) { var r = R[key]; return r == null || r === '' || isNaN(r) ? null : correct(+r, run.correction); };
    var dark = pos.map(function (p, pi) {
      var a = val(pi + ':dark'), b = val(pi + ':dark2');
      return a == null ? (b == null ? 0 : b) : (b == null ? a : (a + b) / 2);
    });
    var net = function (pi, key) { var v = val(pi + ':' + key); return v == null ? null : Math.max(0, v - dark[pi]); };

    // per channel, per position, at 100%
    var E = pos.map(function (p, pi) { var row = []; for (var c = 0; c < n; c++) row.push(net(pi, 'ch' + c)); return row; });
    var refIdx = pos.findIndex(function (p) { return p.ref; });
    if (refIdx < 0) refIdx = 0;

    // dimming curves
    var curves = [];
    for (var c = 0; c < n; c++) {
      var full = E[refIdx][c], pts = [[0, 0]];
      CURVE_LEVELS.forEach(function (lv) {
        var v = net(refIdx, 'curve' + c + '@' + lv);
        if (full > 0 && v != null) pts.push([lv, Math.min(1.2, v / full)]);
      });
      pts.push([100, 1]);
      // keep it rising, the inverse needs that
      for (var i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
      curves.push(pts.map(function (q) { return [q[0], Math.round(q[1] * 10000) / 10000]; }));
    }

    // combined factor, from all channels together vs the channels added up
    var ratios = { 50: [], 100: [] };
    pos.forEach(function (p, pi) {
      [50, 100].forEach(function (lv) {
        var meas = net(pi, 'all' + lv), sum = 0, ok = true;
        for (var c = 0; c < n; c++) { if (E[pi][c] == null) ok = false; else sum += E[pi][c] * interp(curves[c], lv); }
        if (ok && meas != null && sum > 5) ratios[lv].push(meas / sum);
      });
    });
    var mean = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 1; };
    var combined = [[1 / n, 1], [0.5, round4(mean(ratios[50]))], [1, round4(mean(ratios[100]))]];

    // geometry: per channel beam exponent m and strength I0, one shared fixture size a
    var absorb = ABSORB[model] || ABSORB.k7;
    var best = null;
    [0, 4, 8, 12, 16].forEach(function (a) {
      var ch = [], err = 0, used = 0;
      for (var c = 0; c < n; c++) {
        var obs = [];
        pos.forEach(function (p, pi) { if (E[pi][c] != null && E[pi][c] > 2) obs.push({ p: p, e: E[pi][c] }); });
        if (!obs.length) { ch.push({ I0: 0, m: 1 }); continue; }
        var bc = null;
        for (var m = 0.25; m <= 40; m *= 1.12) {
          var g = obs.map(function (o) { return geom(m, a, o.p, run.lightHeight, absorb[c]); });
          var sgE = 0, sg2E2 = 0;
          obs.forEach(function (o, k) { sgE += g[k] / o.e; sg2E2 += (g[k] * g[k]) / (o.e * o.e); });
          var I0 = sgE / sg2E2, e2 = 0;
          obs.forEach(function (o, k) { var r = (I0 * g[k] - o.e) / o.e; e2 += r * r; });
          if (!bc || e2 < bc.e2) bc = { I0: I0, m: m, e2: e2 };
        }
        ch.push({ I0: bc.I0, m: bc.m });
        err += bc.e2; used += obs.length;
      }
      if (!best || err < best.err) best = { a: a, ch: ch, err: err, used: used };
    });
    if (!best || !best.used) throw new Error('No readings with the light on yet.');

    var cal = {
      app: 'reef-light-par', version: 1, model: model,
      made: new Date().toISOString().slice(0, 10),
      lightHeight: run.lightHeight,
      correction: run.correction || CORRECTION_DEFAULT,
      fixtureHalfSize: best.a,
      channels: best.ch.map(function (q, c) { return { I0: Math.round(q.I0 * 10) / 10, m: Math.round(q.m * 1000) / 1000, absorb: absorb[c], curve: curves[c] }; }),
      combined: combined,
      rms: Math.round(Math.sqrt(best.err / best.used) * 1000) / 1000,
      measured: pos.map(function (p, pi) { return { pos: p, dark: round1(dark[pi]), ch: E[pi].map(round1), all100: round1(net(pi, 'all100')), all50: round1(net(pi, 'all50')) }; })
    };
    // how well the model predicts each all-on reading, as a check
    cal.check = cal.measured.map(function (m) {
      if (m.all100 == null) return null;
      var pred = predict(cal, m.pos, all(model, 100), m.pos.medium === 'water' ? run.lightHeight : null);
      return { label: posLabel(m.pos), measured: m.all100, predicted: Math.round(pred) };
    }).filter(Boolean);
    return cal;
  }

  function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  // ---- prediction and planning ---------------------------------------------

  /* Predicted PAR for channel values (0..100 each) at a position. lightHeight: cm above water (water positions). */
  function predict(cal, pos, values, lightHeight) {
    var n = cal.channels.length, sum = 0, load = 0;
    var h = lightHeight == null ? cal.lightHeight : lightHeight;
    for (var c = 0; c < n; c++) {
      var ch = cal.channels[c], frac = interp(ch.curve, Math.max(0, Math.min(100, values[c] || 0)));
      load += frac;
      if (frac > 0) sum += ch.I0 * geom(ch.m, cal.fixtureHalfSize, pos, h, ch.absorb) * frac;
    }
    load /= n;
    var f = load <= cal.combined[0][0] ? 1 : interp(cal.combined, load);
    return sum * f;
  }

  /*
   * Settings that give `target` PAR at `pos`, keeping the ratios of `mix`.
   * Returns { values, predicted, max, capped }.
   */
  function plan(cal, pos, target, mix, lightHeight) {
    var n = cal.channels.length;
    var top = Math.max.apply(null, mix.slice(0, n));
    if (!(top > 0)) return { values: zeros(), predicted: 0, max: 0, capped: false };
    var at = function (s) { var v = zeros(); for (var c = 0; c < n; c++) v[c] = (mix[c] / top) * s; return v; };
    var max = predict(cal, pos, at(100), lightHeight);
    if (target >= max) {
      var vm = at(100).map(Math.round);
      return { values: vm, predicted: Math.round(predict(cal, pos, vm, lightHeight)), max: Math.round(max), capped: true };
    }
    var lo = 0, hi = 100;
    for (var i = 0; i < 40; i++) { var mid = (lo + hi) / 2; if (predict(cal, pos, at(mid), lightHeight) < target) lo = mid; else hi = mid; }
    var v = at((lo + hi) / 2).map(function (x) { return Math.round(x); });
    return { values: v, predicted: Math.round(predict(cal, pos, v, lightHeight)), max: Math.round(max), capped: false };
  }

  var api = {
    CURVE_LEVELS: CURVE_LEVELS, CORRECTION_DEFAULT: CORRECTION_DEFAULT,
    defaultPositions: defaultPositions, posLabel: posLabel, buildSteps: buildSteps,
    correct: correct, fit: fit, predict: predict, plan: plan,
    geom: geom, pointE: pointE, fresnelT: fresnelT, nCh: nCh
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NooPar = api;
})(typeof window !== 'undefined' ? window : this);
