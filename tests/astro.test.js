// Checks the app's sun and moon calculations against PyEphem
// (tests/ephem-reference.json, made by a script with ephem 4.x) for the three
// reefs used in the spawning studies: Singapore Kusu reef, Lizard Island
// (Great Barrier Reef) and Palau.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'android/app/src/main/assets/www/js/astro.js'));
const ref = require('./ephem-reference.json');

const minutes = (a, b) => Math.abs(a - b) / 60000;

test('sun and moon rise/set match PyEphem', () => {
  let worst = { sun: 0, moon: 0 };
  for (const e of ref.events) {
    const start = new Date(e.start);
    const end = new Date(start.valueOf() + 86400000);
    const evs = e.body === 'sun' ? A.sunEvents(start, end, e.lat, e.lon) : A.moonEvents(start, end, e.lat, e.lon);
    const want = new Date(e.utc);
    const match = evs.filter((x) => x.rising === (e.which === 'rise'))
      .sort((a, b) => minutes(a.time, want) - minutes(b.time, want))[0];
    assert.ok(match, `no ${e.body} ${e.which} found for ${e.site} ${e.start}`);
    const diff = minutes(match.time, want);
    worst[e.body] = Math.max(worst[e.body], diff);
    assert.ok(diff <= (e.body === 'sun' ? 2 : 5), `${e.site} ${e.start} ${e.body} ${e.which}: off by ${diff.toFixed(1)} min`);
  }
  console.log('  worst difference: sun ' + worst.sun.toFixed(2) + ' min, moon ' + worst.moon.toFixed(2) + ' min');
});

test('moon illumination matches PyEphem', () => {
  let worst = 0;
  for (const r of ref.illum) {
    const f = A.moonIllumination(new Date(r.utc)).fraction;
    worst = Math.max(worst, Math.abs(f - r.fraction));
    assert.ok(Math.abs(f - r.fraction) < 0.02, `${r.utc}: ${f.toFixed(3)} vs ${r.fraction.toFixed(3)}`);
  }
  console.log('  worst illumination difference: ' + (worst * 100).toFixed(2) + '%');
});

test('full moons match PyEphem', () => {
  const end = new Date('2027-06-01T00:00:00Z');
  const found = A.fullMoons(new Date('2026-01-01T00:00:00Z'), end);
  const want = ref.fullmoons.filter((t) => new Date(t) < end);
  assert.equal(found.length, want.length);
  let worst = 0;
  found.forEach((t, i) => {
    const diff = minutes(t, new Date(want[i]));
    worst = Math.max(worst, diff);
    assert.ok(diff < 20, `full moon ${want[i]} off by ${diff.toFixed(1)} min`);
  });
  console.log('  worst full moon difference: ' + worst.toFixed(1) + ' min');
});

test('daily insolation has the expected seasonal shape', () => {
  const lizard = -14.687517;
  const dec = A.dailyInsolation(new Date('2026-12-21T02:00:00Z'), lizard);
  const jun = A.dailyInsolation(new Date('2026-06-21T02:00:00Z'), lizard);
  assert.ok(dec > jun * 1.2, 'southern summer brighter than winter at Lizard Island');
  const sg = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((m) => A.dailyInsolation(new Date(Date.UTC(2026, m, 15, 4)), 1.22));
  assert.ok(Math.max(...sg) / Math.min(...sg) < 1.15, 'Singapore varies little');
  assert.ok(dec > 35 && dec < 50, 'plausible MJ/m2/day: ' + dec.toFixed(1));
});
