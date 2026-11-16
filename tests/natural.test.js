const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const www = path.join(__dirname, '..', 'android/app/src/main/assets/www/js');
const A = require(path.join(www, 'astro.js'));
const N = require(path.join(www, 'natural.js'));

const MIX = [40, 90, 20, 60, 80, 10];
const settings = (over) => Object.assign(N.defaults(MIX, 'k7'), { steadyDst: false }, over || {});
const BLUE = 1;

// What the light shows at minute t: linear between points, and the light
// itself can only show whole percent, so treat >= 0.5 as on.
const lit = (slots, t, c) => N.slotValue(slots, t)[c] >= 0.5;
const firstLitAfter = (slots, from, c) => { for (let t = from; t < from + 900; t++) if (lit(slots, ((t % 1440) + 1440) % 1440, c)) return t; return null; };

test('a day is 24 valid slots, one per hour', () => {
  const day = N.computeDay(settings(), new Date(2026, 10, 17));
  assert.equal(day.slots.length, 24);
  day.slots.forEach((s, i) => {
    assert.equal(s.h, i);
    assert.ok(s.m >= 0 && s.m <= 59);
    s.v.forEach((v) => assert.ok(Number.isInteger(v) && v >= 0 && v <= 100));
  });
});

test('daylight follows the protocol: 0 at sunrise, full after the ramp, 0 at sunset', () => {
  const s = settings({ moon: [0, 0, 0, 0, 0, 0] });
  const day = N.computeDay(s, new Date(2026, 2, 20));
  const m = day.model;
  const mid = N.slotValue(day.slots, (m.sunrise + m.sunset) / 2);
  MIX.forEach((v, c) => assert.ok(Math.abs(mid[c] - v * m.factor) <= 1.5, `channel ${c}: ${mid[c]} vs ${v * m.factor}`));
  for (let c = 0; c < 6; c++) {
    assert.ok(N.slotValue(day.slots, m.sunrise - 10)[c] < 0.5, 'dark before sunrise');
    assert.ok(N.slotValue(day.slots, m.sunset + 10)[c] < 0.5, 'dark after sunset');
  }
  // halfway up the ramp is about half brightness
  const half = N.slotValue(day.slots, m.sunrise + m.ramp / 2)[BLUE];
  assert.ok(Math.abs(half - MIX[BLUE] * m.factor / 2) < 6, 'ramp midpoint ' + half);
  // midday on the tank lands where asked (reef mean noon, give or take the equation of time)
  assert.ok(Math.abs((m.sunrise + m.sunset) / 2 - 13 * 60) < 20);
});

test('after the full moon the dark gap after sunset appears and grows each night', () => {
  // full moon of 2026-03-03 11:38 UTC is the evening of 3 March in Singapore
  const s = settings();
  const nights = [1, 2, 3, 4, 5].map((n) => {
    const date = new Date(2026, 2, 3 + n);
    const day = N.computeDay(s, date);
    const info = N.night(s, date);
    const on = firstLitAfter(day.slots, Math.round(day.model.sunset) + 5, BLUE);
    return { n, gap: info.darkGap, simulated: on - day.model.sunset, nafm: info.nightsAfterFull };
  });
  for (let i = 1; i < nights.length; i++) {
    assert.ok(nights[i].gap > nights[i - 1].gap, 'real gap grows: ' + JSON.stringify(nights));
    assert.ok(nights[i].simulated > nights[i - 1].simulated, 'gap on the light grows: ' + JSON.stringify(nights));
  }
  nights.forEach((x) => {
    // the light's moon comes on shortly after moonrise (it brightens as it climbs, like the real one)
    assert.ok(x.simulated >= x.gap - 10 && x.simulated <= x.gap + 30, `night ${x.n}: real gap ${x.gap} min, on the light ${x.simulated} min`);
  });
  assert.deepEqual(nights.map((x) => x.nafm), [1, 2, 3, 4, 5]);
  console.log('  dark gap (real / on the light, minutes): ' + nights.map((x) => x.gap + '/' + x.simulated).join(', '));
});

test('before the full moon there is no dark gap: the moon is already up at sunset', () => {
  const s = settings();
  const date = new Date(2026, 1, 28); // 3 nights before the 3 March full moon
  const day = N.computeDay(s, date);
  const info = N.night(s, date);
  assert.equal(info.upAtSunset, true);
  assert.equal(info.darkGap, 0);
  assert.ok(info.fraction > 0.8);
  // moonlight shows within 45 minutes of sunset and stays on through the evening
  const on = firstLitAfter(day.slots, Math.round(day.model.sunset), BLUE);
  assert.ok(on - day.model.sunset < 45, 'moonlight after sunset: ' + (on - day.model.sunset));
  assert.ok(lit(day.slots, Math.round(day.model.sunset + 180) % 1440, BLUE), 'still on 3 hours after sunset');
});

test('a thin moon is too dim for the light and stays off', () => {
  const s = settings();
  const date = new Date(2026, 2, 19); // around new moon (2026-03-19)
  const day = N.computeDay(s, date);
  assert.ok(N.night(s, date).fraction < 0.1);
  for (let t = Math.round(day.model.sunset) + 15; t < Math.round(day.model.sunset) + 600; t += 10) {
    assert.ok(!lit(day.slots, t % 1440, BLUE), 'dark at ' + t);
  }
});

test('season: brighter in the reef summer, within the 60 to 100 percent band', () => {
  const s = settings({ reefId: 'lizard', lat: -14.687517, lon: 145.4635 });
  const dec = N.seasonFactor(s, new Date(2026, 11, 21));
  const jun = N.seasonFactor(s, new Date(2026, 5, 21));
  assert.ok(dec > 0.95 && jun < 0.65, `Dec ${dec.toFixed(2)} Jun ${jun.toFixed(2)}`);
  for (let m = 0; m < 12; m++) {
    const f = N.seasonFactor(s, new Date(2026, m, 1));
    assert.ok(f >= 0.6 - 1e-9 && f <= 1 + 1e-9);
  }
  // shifting the reef calendar by 6 months swaps the seasons
  const shifted = settings({ reefId: 'lizard', lat: -14.687517, lon: 145.4635, seasonShiftMonths: 6 });
  const junShifted = N.dayModel(shifted, new Date(2026, 5, 21)).factor;
  assert.ok(junShifted > 0.95, 'June runs like December: ' + junShifted.toFixed(2));
});

test('midday on the tank moves the whole day, sun and moon together', () => {
  const a = N.night(settings({ middayAt: 12 * 60 }), new Date(2026, 2, 6));
  const b = N.night(settings({ middayAt: 15 * 60 }), new Date(2026, 2, 6));
  assert.ok(Math.abs((b.sunset - a.sunset) - 180) < 1);
  assert.ok(Math.abs((b.moonrise - a.moonrise) - 180) < 1);
  assert.equal(a.darkGap, b.darkGap);
});

test('a day is quick enough to compute on a phone', () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) N.computeDay(settings(), new Date(2026, 3, 1 + i));
  const per = (Date.now() - t0) / 10;
  console.log('  ' + per.toFixed(1) + ' ms per day');
  assert.ok(per < 150);
});
