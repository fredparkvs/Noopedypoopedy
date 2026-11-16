// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const www = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'js');
const P = require(path.join(www, 'protocol.js'));
const S = require(path.join(www, 'schedule.js'));
const { buildStatus } = require('./fixtures.js');

// Byte strings below are exactly what the official app sends (CommandUtil).
test('simple commands match the official app byte for byte', () => {
  assert.equal(P.toHex(P.readAll()), 'aaa51008bb');
  assert.equal(P.toHex(P.syncTime(13, 5, 9)), 'aaa510030d0509bb');
  assert.equal(P.toHex(P.setAutoMode(true)), 'aaa5100401bb');
  assert.equal(P.toHex(P.setAutoMode(false)), 'aaa5100400bb');
  assert.equal(P.toHex(P.setManual([50, 50, 50, 50, 50, 50])), 'aaa51005323232323232bb');
  assert.equal(P.toHex(P.preview([0, 100, 0, 0, 0, 0])), 'aaa51006006400000000bb');
  // demo is inverted in the official app: on = 00, off = 01
  assert.equal(P.toHex(P.setDemo(true)), 'aaa5100a00bb');
  assert.equal(P.toHex(P.setDemo(false)), 'aaa5100a01bb');
});

test('channel values are clamped to 0..100 and padded to 6', () => {
  assert.deepEqual(P.setManual([150, -5, 33.6]).slice(4, 10), [100, 0, 34, 0, 0, 0]);
});

test('setAll layout: manual, 0x18, 24 slots, auto flag, clock, end tag', () => {
  const slots = S.factorySlots('k7', 'LPS');
  const bytes = P.setAll({ manual: [1, 2, 3, 4, 5, 6], slots, auto: true, time: new Date(2026, 0, 1, 7, 8, 9) });
  assert.equal(bytes.length, 208);
  assert.deepEqual(bytes.slice(0, 4), [0xaa, 0xa5, 0x10, 0x07]);
  assert.deepEqual(bytes.slice(4, 10), [1, 2, 3, 4, 5, 6]);
  assert.equal(bytes[10], 0x18);
  assert.deepEqual(bytes.slice(11 + 11 * 8, 11 + 12 * 8), [11, 0, 5, 80, 50, 10, 80, 0]);
  assert.equal(bytes[203], 1);
  assert.deepEqual(bytes.slice(204, 207), [7, 8, 9]);
  assert.equal(bytes[207], 0xbb);
  assert.throws(() => P.setAll({ manual: [], slots: slots.slice(1), auto: false }));
});

test('parses the status block the way the official app reads it', () => {
  const slots = S.factorySlots('k7', 'SPS');
  const bytes = buildStatus({ manual: [10, 20, 30, 40, 50, 60], slots, auto: true, name: 'K7_1A2B3C4D' });
  const msg = P.parseMessage(bytes);
  assert.equal(msg.type, 'status');
  assert.equal(msg.auto, true);
  assert.equal(msg.name, 'K7_1A2B3C4D');
  assert.equal(msg.model, 'k7');
  assert.equal(msg.channelCount, 6);
  assert.equal(msg.scheduleValid, true);
  assert.deepEqual(msg.manual, [10, 20, 30, 40, 50, 60]);
  assert.ok(S.slotsEqual(msg.slots, slots));
});

test('detects the 3-channel K7 Mini by name and manual mode by flag', () => {
  const bytes = buildStatus({ manual: [1, 2, 3, 0, 0, 0], slots: S.factorySlots('mini', 'LPS'), auto: false, name: 'K7M_00AA11B' });
  const msg = P.parseMessage(bytes);
  assert.equal(msg.model, 'mini');
  assert.equal(msg.channelCount, 3);
  assert.equal(msg.auto, false);
});

test('a status block with nonsense schedule bytes is not trusted', () => {
  const bytes = buildStatus({ manual: [0, 0, 0, 0, 0, 0], slots: S.factorySlots('k7', 'SPS'), auto: true, name: 'K7_X' });
  bytes[11 + 5 * 8] = 77; // hour 77
  const msg = P.parseMessage(bytes);
  assert.equal(msg.scheduleValid, false);
  assert.equal(msg.slots, null);
  assert.equal(msg.name, 'K7_X');
});

test('ack and unknown replies', () => {
  assert.equal(P.parseMessage(P.fromHex('abaaa5a1')).type, 'ack');
  assert.equal(P.parseMessage([1, 2, 3]).type, 'unknown');
});

test('framer reassembles a status block split across TCP reads', async () => {
  const got = [];
  const f = new P.Framer((m) => got.push(m), 20);
  const bytes = buildStatus({ manual: [5, 5, 5, 5, 5, 5], slots: S.factorySlots('k7', 'SPS'), auto: true, name: 'K7_SPLIT01' });
  f.feed(P.fromHex('abaaa5a1'));
  f.feed(bytes.slice(0, 100));
  f.feed(bytes.slice(100, 180));
  f.feed(bytes.slice(180));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got.map((m) => m.type), ['ack', 'status']);
  assert.equal(got[1].name, 'K7_SPLIT01');
});

test('official export code round-trips', () => {
  const slots = S.factorySlots('k7', 'Soft coral');
  const code = P.toOfficialCode([50, 50, 50, 50, 50, 50], slots);
  const back = P.parseOfficialCode(code);
  assert.deepEqual(back.manual, [50, 50, 50, 50, 50, 50]);
  assert.ok(S.slotsEqual(back.slots, slots));
  assert.throws(() => P.parseOfficialCode('nope'));
});
