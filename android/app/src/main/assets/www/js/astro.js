/*
 * Sun and moon for a place on Earth: altitude, rise and set, moon phase and
 * illumination, full moons, and daily top-of-atmosphere sunlight.
 *
 * Low-precision orbital elements with the main lunar perturbations
 * (evection, variation, yearly equation and others), as published by Paul
 * Schlyter ("How to compute planetary positions"). Accuracy is about an arc
 * minute for the sun and a few for the moon, so rise and set times are good
 * to a couple of minutes. Verified against PyEphem in tests/astro.test.js.
 */
(function (root) {
  'use strict';

  var RAD = Math.PI / 180;
  var DAY_MS = 86400000;

  function rev(x) { return x - Math.floor(x / 360) * 360; }
  function sind(x) { return Math.sin(x * RAD); }
  function cosd(x) { return Math.cos(x * RAD); }

  /* Days since 2000 Jan 0.0 UT (the epoch of the elements). */
  function dayNumber(date) { return date.valueOf() / DAY_MS + 2440587.5 - 2451543.5; }

  function sunElements(d) {
    return {
      w: rev(282.9404 + 4.70935e-5 * d),
      e: 0.016709 - 1.151e-9 * d,
      M: rev(356.0470 + 0.9856002585 * d),
      obl: 23.4393 - 3.563e-7 * d
    };
  }

  /* Ecliptic longitude (deg) and distance (AU) of the sun. */
  function sunEcliptic(d) {
    var s = sunElements(d);
    var E = s.M + (180 / Math.PI) * s.e * sind(s.M) * (1 + s.e * cosd(s.M));
    var xv = cosd(E) - s.e;
    var yv = Math.sqrt(1 - s.e * s.e) * sind(E);
    var v = Math.atan2(yv, xv) / RAD;
    return { lon: rev(v + s.w), r: Math.sqrt(xv * xv + yv * yv), M: s.M, L: rev(s.M + s.w), obl: s.obl };
  }

  /* Ecliptic longitude, latitude (deg) and distance (Earth radii) of the moon. */
  function moonEcliptic(d) {
    var N = rev(125.1228 - 0.0529538083 * d);
    var i = 5.1454;
    var w = rev(318.0634 + 0.1643573223 * d);
    var a = 60.2666;
    var e = 0.054900;
    var M = rev(115.3654 + 13.0649929509 * d);
    var E = M + (180 / Math.PI) * e * sind(M) * (1 + e * cosd(M));
    for (var k = 0; k < 5; k++) E = E - (E - (180 / Math.PI) * e * sind(E) - M) / (1 - e * cosd(E));
    var xv = a * (cosd(E) - e);
    var yv = a * Math.sqrt(1 - e * e) * sind(E);
    var v = Math.atan2(yv, xv) / RAD;
    var r = Math.sqrt(xv * xv + yv * yv);
    var xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    var yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    var zh = r * (sind(v + w) * sind(i));
    var lon = Math.atan2(yh, xh) / RAD;
    var lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) / RAD;

    var sun = sunEcliptic(d);
    var Ms = sun.M, Mm = M;
    var Lm = rev(N + w + M), Ls = sun.L;
    var D = Lm - Ls, F = Lm - N;
    lon += -1.274 * sind(Mm - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms)
      - 0.059 * sind(2 * Mm - 2 * D) - 0.057 * sind(Mm - 2 * D + Ms) + 0.053 * sind(Mm + 2 * D)
      + 0.046 * sind(2 * D - Ms) + 0.041 * sind(Mm - Ms) - 0.035 * sind(D)
      - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(Mm - 4 * D);
    lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(Mm - F - 2 * D) - 0.046 * sind(Mm + F - 2 * D)
      + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * Mm + F);
    r += -0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);
    return { lon: rev(lon), lat: lat, r: r, sun: sun };
  }

  function toEquatorial(lon, lat, obl) {
    var xe = cosd(lon) * cosd(lat);
    var ye = sind(lon) * cosd(lat) * cosd(obl) - sind(lat) * sind(obl);
    var ze = sind(lon) * cosd(lat) * sind(obl) + sind(lat) * cosd(obl);
    return { ra: rev(Math.atan2(ye, xe) / RAD), dec: Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) / RAD };
  }

  function altitudeOf(eq, d, latDeg, lonDeg, sunL) {
    var ut = (d - Math.floor(d)) * 24; // hours since 0h UT
    var lst = rev(sunL + 180 + ut * 15 + lonDeg);
    var ha = lst - eq.ra;
    return Math.asin(sind(latDeg) * sind(eq.dec) + cosd(latDeg) * cosd(eq.dec) * cosd(ha)) / RAD;
  }

  /* Geometric altitude of the sun's centre, degrees. */
  function sunAltitude(date, lat, lon) {
    var d = dayNumber(date);
    var s = sunEcliptic(d);
    return altitudeOf(toEquatorial(s.lon, 0, s.obl), d, lat, lon, s.L);
  }

  /* Geocentric altitude of the moon's centre, degrees. */
  function moonAltitude(date, lat, lon) {
    var d = dayNumber(date);
    var m = moonEcliptic(d);
    return altitudeOf(toEquatorial(m.lon, m.lat, m.sun.obl), d, lat, lon, m.sun.L);
  }

  /*
   * Rise and set thresholds: sun's upper limb with refraction at -0.833 deg;
   * moon's geocentric centre at +0.125 deg (parallax minus refraction and
   * semi-diameter), the standard values.
   */
  var SUN_H0 = -0.833;
  var MOON_H0 = 0.125;

  /*
   * Moon illumination: fraction lit (0..1), phase angle and whether waxing.
   * age is the elongation in degrees: 0 new, 90 first quarter, 180 full.
   */
  function moonIllumination(date) {
    var d = dayNumber(date);
    var m = moonEcliptic(d);
    var elong = Math.acos(cosd(m.lat) * cosd(m.lon - m.sun.lon)) / RAD;
    var sunKm = m.sun.r * 149597870.7, moonKm = m.r * 6378.137;
    var phaseAngle = Math.atan2(sunKm * sind(elong), moonKm - sunKm * cosd(elong)) / RAD;
    var age = rev(m.lon - m.sun.lon);
    return { fraction: (1 + cosd(phaseAngle)) / 2, waxing: age < 180, age: age };
  }

  /*
   * Times (Date) when fn(date) crosses h0 between start and end, found by
   * stepping and refining. Returns [{ time, rising }].
   */
  function crossings(fn, h0, start, end, stepMin) {
    stepMin = stepMin || 10;
    var out = [];
    var t0 = start.valueOf(), prevT = t0, prev = fn(new Date(t0)) - h0;
    for (var t = t0 + stepMin * 60000; t <= end.valueOf(); t += stepMin * 60000) {
      var cur = fn(new Date(t)) - h0;
      if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) {
        var lo = prevT, hi = t, flo = prev;
        for (var k = 0; k < 20; k++) {
          var mid = (lo + hi) / 2, fm = fn(new Date(mid)) - h0;
          if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; } else { hi = mid; }
        }
        out.push({ time: new Date((lo + hi) / 2), rising: prev < 0 });
      }
      prev = cur; prevT = t;
    }
    return out;
  }

  function sunEvents(start, end, lat, lon) {
    return crossings(function (dt) { return sunAltitude(dt, lat, lon); }, SUN_H0, start, end, 10);
  }

  function moonEvents(start, end, lat, lon) {
    return crossings(function (dt) { return moonAltitude(dt, lat, lon); }, MOON_H0, start, end, 10);
  }

  /* Full moons (Date) between start and end. */
  function fullMoons(start, end) {
    var out = [];
    var stepMs = 6 * 3600000, t = start.valueOf(), prev = moonIllumination(new Date(t)).age;
    for (t += stepMs; t <= end.valueOf(); t += stepMs) {
      var cur = moonIllumination(new Date(t)).age;
      if (prev < 180 && cur >= 180) {
        var lo = t - stepMs, hi = t;
        for (var k = 0; k < 30; k++) {
          var mid = (lo + hi) / 2;
          if (moonIllumination(new Date(mid)).age < 180) lo = mid; else hi = mid;
        }
        out.push(new Date((lo + hi) / 2));
      }
      prev = cur;
    }
    return out;
  }

  /*
   * Daily sunlight at the top of the atmosphere (MJ/m2), from day length and
   * sun angle. Clouds and monsoons are not included.
   */
  function dailyInsolation(date, lat) {
    var d = dayNumber(date);
    var s = sunEcliptic(d);
    var dec = toEquatorial(s.lon, 0, s.obl).dec;
    var x = -Math.tan(lat * RAD) * Math.tan(dec * RAD);
    var ws = x <= -1 ? Math.PI : x >= 1 ? 0 : Math.acos(x);
    var gsc = 0.0820; // MJ m-2 min-1
    return (24 * 60 / Math.PI) * gsc / (s.r * s.r) *
      (ws * sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * Math.sin(ws));
  }

  var api = {
    sunAltitude: sunAltitude,
    moonAltitude: moonAltitude,
    moonIllumination: moonIllumination,
    sunEvents: sunEvents,
    moonEvents: moonEvents,
    fullMoons: fullMoons,
    dailyInsolation: dailyInsolation,
    SUN_H0: SUN_H0,
    MOON_H0: MOON_H0
  };
  root.NooAstro = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
