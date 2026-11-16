const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'js', 'schedule.js'));

const pt = (h, m, v) => ({ t: h * 60 + m, v });
const flat = (x) => [x, x, x, x, x, x];

test('valueAt interpolates linearly and wraps across midnight', () => {
  const pts = [pt(10, 0, flat(0)), pt(12, 0, flat(100)), pt(22, 0, flat(20))];
  assert.deepEqual(S.valueAt(pts, 11 * 60), flat(50));
  assert.deepEqual(S.valueAt(pts, 12 * 60), flat(100));
  // 22:00 (20) -> 10:00 next day (0) is 12 hours; at 04:00 we are halfway
  assert.deepEqual(S.valueAt(pts, 4 * 60), flat(10));
  assert.deepEqual(S.valueAt([pt(5, 0, flat(7))], 999), flat(7));
  assert.deepEqual(S.valueAt([], 0), flat(0));
});

test('toSlots keeps key points exactly and fills the rest on the line', () => {
  const pts = [pt(9, 30, flat(0)), pt(11, 0, flat(90)), pt(18, 0, flat(90)), pt(20, 30, flat(0))];
  const slots = S.toSlots(pts);
  assert.equal(slots.length, 24);
  slots.forEach((s, i) => assert.equal(s.h, i));
  assert.deepEqual(slots[9], { h: 9, m: 30, v: flat(0) });
  assert.deepEqual(slots[10], { h: 10, m: 0, v: flat(30) }); // 30 of 90 minutes into the ramp
  assert.deepEqual(slots[20], { h: 20, m: 30, v: flat(0) });
  assert.deepEqual(slots[3], { h: 3, m: 0, v: flat(0) });
});

test('fromSlots(toSlots(points)) gives the same key points back', () => {
  const pts = [pt(9, 30, [0, 0, 0, 0, 0, 0]), pt(11, 0, [40, 90, 20, 60, 80, 10]), pt(18, 15, [40, 90, 20, 60, 80, 10]), pt(20, 30, [0, 3, 0, 0, 2, 0])];
  const back = S.fromSlots(S.toSlots(pts));
  assert.deepEqual(back, S.sortPoints(pts));
});

test('factory LPS (24 slots) simplifies to its 6 corner points and is reproduced exactly', () => {
  const slots = S.factorySlots('k7', 'LPS');
  const pts = S.fromSlots(slots);
  assert.deepEqual(pts.map((p) => S.fmtTime(p.t)), ['08:00', '09:00', '10:00', '11:00', '18:00', '19:00', '20:00', '21:00']);
  assert.ok(S.slotsEqual(S.toSlots(pts), slots));
});

test('every factory preset round-trips through key points without change', () => {
  for (const model of ['k7', 'mini']) {
    for (const name of Object.keys(S.FACTORY[model])) {
      const slots = S.factorySlots(model, name);
      assert.ok(S.slotsEqual(S.toSlots(S.fromSlots(slots)), slots), model + ' ' + name);
    }
  }
});

test('conflicts flags two points in the same clock hour', () => {
  assert.deepEqual(S.conflicts([pt(9, 0, flat(0)), pt(9, 30, flat(1)), pt(10, 0, flat(2))]), [9]);
  assert.deepEqual(S.conflicts([pt(9, 0, flat(0)), pt(10, 0, flat(2))]), []);
});

test('photoperiod builds four points and validates lengths', () => {
  const pts = S.photoperiod({ on: 9 * 60 + 30, off: 20 * 60 + 30, rampUp: 90, rampDown: 120, peak: flat(80), night: [0, 2, 0, 0, 0, 0] });
  assert.deepEqual(pts.map((p) => S.fmtTime(p.t)), ['09:30', '11:00', '18:30', '20:30']);
  assert.deepEqual(pts[0].v, [0, 2, 0, 0, 0, 0]);
  assert.deepEqual(S.conflicts(pts), []);
  assert.throws(() => S.photoperiod({ on: 600, off: 720, rampUp: 60, rampDown: 60, peak: flat(1) }));
});

test('time helpers', () => {
  assert.equal(S.fmtTime(9 * 60 + 5), '09:05');
  assert.equal(S.fmtTime(-30), '23:30');
  assert.equal(S.parseTime('7:45'), 465);
  assert.equal(S.parseTime('24:00'), null);
});
