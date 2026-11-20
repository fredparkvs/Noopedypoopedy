const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PAR = require(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'js', 'par.js'));

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), (msg || '') + ': ' + a + ' vs ' + b);

test('in air a small source follows the inverse square law', () => {
  const e20 = PAR.pointE(0, 20, 0, 0, 0), e40 = PAR.pointE(0, 40, 0, 0, 0);
  close(e20 / e40, 4, 1e-9, 'double the distance, a quarter of the light');
});

test('underwater, on axis, the light behaves as if the water were thinner by the refractive index', () => {
  const e = PAR.pointE(0, 20, 30, 0, 0);
  const expected = PAR.fresnelT(0) / Math.pow(20 + 30 / 1.34, 2);
  close(e, expected, 1e-6, 'on axis');
  // off axis the numeric flux tube agrees with the on-axis limit as the offset shrinks
  close(PAR.pointE(0, 20, 30, 0.01, 0), e, 1e-3, 'near axis');
});

test('a wider beam spreads light to the side; a narrow beam keeps it in the centre', () => {
  const ratio = (m) => PAR.pointE(m, 20, 30, 30, 0) / PAR.pointE(m, 20, 30, 0, 0);
  assert.ok(ratio(1) > ratio(10));
});

// A made-up light, used to produce meter readings the way a person would take them.
function fakeLight() {
  const cal = {
    model: 'k7', lightHeight: 20, fixtureHalfSize: 8,
    channels: [
      { I0: 600000, m: 2.0, absorb: 0.06 }, { I0: 900000, m: 3.0, absorb: 0.02 }, { I0: 150000, m: 1.5, absorb: 0.05 },
      { I0: 200000, m: 2.5, absorb: 0.03 }, { I0: 500000, m: 3.5, absorb: 0.02 }, { I0: 120000, m: 1.2, absorb: 0.4 }
    ].map((c) => Object.assign(c, { curve: [[0, 0], [10, 0.06], [25, 0.2], [50, 0.47], [75, 0.74], [100, 1]] })),
    combined: [[1 / 6, 1], [0.5, 0.97], [1, 0.9]]
  };
  return cal;
}

function takeReadings(truth, positions, correction, ambient) {
  const steps = PAR.buildSteps('k7', positions);
  const readings = {};
  let wobble = 0;
  steps.forEach((s) => {
    const p = positions[s.pos];
    const par = PAR.predict(truth, p, s.values, truth.lightHeight);
    wobble = (wobble * 7 + 3) % 11; // +-2.5% repeatable "noise"
    const meter = (par * (1 + (wobble - 5) * 0.005) + ambient);
    readings[s.key] = Math.round((meter - correction.add) / correction.mult);
  });
  return { steps, readings };
}

test('the plan has the steps a person would take', () => {
  const pos = PAR.defaultPositions();
  const steps = PAR.buildSteps('k7', pos);
  // per position: dark, 6 channels, all at 100 and 50; plus 24 curve readings and a second dark at the reference
  assert.equal(steps.length, pos.length * 9 + 24 + 1);
  assert.equal(new Set(steps.map((s) => s.key)).size, steps.length, 'unique keys');
  assert.equal(PAR.buildSteps('mini', pos).length, pos.length * 6 + 12 + 1);
});

test('fitting the readings recovers the light well enough to predict new places', () => {
  const truth = fakeLight();
  const positions = PAR.defaultPositions();
  const correction = { add: 40, mult: 1 };
  const { readings } = takeReadings(truth, positions, correction, 15);
  const cal = PAR.fit({ model: 'k7', lightHeight: 20, positions, correction, readings });

  assert.ok(cal.rms < 0.06, 'fits the readings within a few percent, rms ' + cal.rms);
  close(cal.combined[2][1], 0.9, 0.05, 'all-on factor');
  close(cal.channels[1].curve[3][1], 0.47, 0.06, 'blue at 50%');

  // places that were never measured, including a different light height
  const mix = [40, 100, 10, 50, 80, 10];
  [
    [{ medium: 'water', depth: 30, offset: 10 }, 20],
    [{ medium: 'water', depth: 50, offset: 20 }, 20],
    [{ medium: 'water', depth: 25, offset: 0 }, 30]
  ].forEach(([p, h]) => {
    close(PAR.predict(cal, p, mix, h), PAR.predict(truth, p, mix, h), 0.12, JSON.stringify(p) + ' at ' + h + ' cm');
  });
});

test('the planner finds settings that give the asked-for PAR and keeps the mix', () => {
  const truth = fakeLight();
  const mix = [40, 100, 10, 50, 80, 10];
  const p = { medium: 'water', depth: 30, offset: 10 };
  const r = PAR.plan(truth, p, 250, mix, 20);
  assert.equal(r.capped, false);
  close(r.predicted, 250, 0.03, 'predicted');
  assert.equal(r.values[1], Math.max(...r.values), 'blue stays the strongest');
  close(r.values[0] / r.values[1], 0.4, 0.1, 'white to blue ratio kept');

  const big = PAR.plan(truth, p, 100000, mix, 20);
  assert.equal(big.capped, true);
  assert.equal(big.values[1], 100);
});
