'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const core = require('../core');
const { startFakeLight } = require('./fake-light');

const READ_ALL = 'aaa51008bb';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function saveFrameHex() {
  const b = [0xaa, 0xa5, 0x10, 0x07, 50, 50, 50, 50, 50, 50, 0x18];
  for (let h = 0; h < 24; h++) b.push(h, h === 9 ? 30 : 0, h, h, h, h, h, 0);
  b.push(1, 0, 0, 0, 0xbb);
  return Buffer.from(b).toString('hex');
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

test('a session receives the whole status block, even when split', async () => {
  const fake = await startFakeLight();
  const chunks = [];
  const s = new core.LightSession((d) => chunks.push(d), () => {});
  await s.connect('127.0.0.1', fake.port, 2000);
  await s.send(READ_ALL);
  await wait(150);
  const all = Buffer.concat(chunks);
  assert.ok(all.length >= 215);
  assert.equal(all[0], 0xab);
  assert.equal(all.subarray(204, 215).toString('ascii'), 'K7_MAC00001');
  s.close();
  await fake.close();
});

test('a drop by the light is reported; closing ourselves is not', async () => {
  const fake = await startFakeLight({ dropAfterFrame: true });
  const closed = [];
  const s = new core.LightSession(() => {}, (r) => closed.push(r));
  await s.connect('127.0.0.1', fake.port, 2000);
  await s.send(READ_ALL);
  await wait(150);
  assert.equal(closed.length, 1);
  await assert.rejects(s.send(READ_ALL), /Not connected/);
  await fake.close();

  const fake2 = await startFakeLight();
  const closed2 = [];
  const s2 = new core.LightSession(() => {}, (r) => closed2.push(r));
  await s2.connect('127.0.0.1', fake2.port, 2000);
  s2.close();
  await wait(150);
  assert.equal(closed2.length, 0);
  await fake2.close();
});

test('nothing listening gives a friendly error', async () => {
  const port = await freePort();
  const s = new core.LightSession(() => {}, () => {});
  await assert.rejects(s.connect('127.0.0.1', port, 1000), /refused the connection/);
});

test('scan candidates: the subnet around each real interface, extras first, no tunnels', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' }],
    en0: [{ family: 'IPv4', address: '192.168.68.20', internal: false, cidr: '192.168.68.20/22' }],
    utun3: [{ family: 'IPv4', address: '10.2.0.2', internal: false, cidr: '10.2.0.2/32' }],
  };
  const addrs = core.localAddresses(ifaces);
  assert.deepEqual(addrs.map((a) => a.name), ['en0'], 'loopback and VPN tunnels are skipped');
  const c = core.candidates(addrs, ['192.168.68.1', '192.168.4.1']);
  assert.equal(c[0], '192.168.68.1');
  assert.ok(c.includes('192.168.4.1'));
  assert.ok(!c.includes('192.168.68.20'));
  assert.ok(!c.some((h) => h.startsWith('10.2.0.')));
  assert.equal(c.length, 254);
});

test('scan finds a light at an extra address', async () => {
  const fake = await startFakeLight();
  const found = await core.scan(fake.port, 300, ['127.0.0.1']);
  assert.ok(found.includes('127.0.0.1'));
  await fake.close();
});

test('the clock is filled in just before sending', () => {
  const f = core.withTime(Buffer.from(saveFrameHex(), 'hex'), 7, 8, 9);
  assert.deepEqual([...f.subarray(204, 207)], [7, 8, 9]);
  assert.equal(f[207], 0xbb);
  assert.throws(() => core.withTime(Buffer.alloc(10), 1, 2, 3));
  assert.equal(core.syncTimeFrame(6, 30, 0).toString('hex'), 'aaa51003061e00bb');
});

test('sendDay: clock, then the day, confirmed by reading it back', async () => {
  const fake = await startFakeLight();
  const r = await core.sendDay('127.0.0.1', saveFrameHex(), { h: 6, m: 30, s: 0 }, { port: fake.port });
  assert.equal(r.sent, true);
  assert.equal(r.confirmed, true, r.message);
  assert.equal(fake.received[0], 'aaa51003061e00bb');
  assert.equal(fake.received[1], core.withTime(Buffer.from(saveFrameHex(), 'hex'), 6, 30, 0).toString('hex'));
  assert.equal(fake.received[2], READ_ALL);
  assert.equal(fake.light.slots[9].m, 30);
  await fake.close();
});

test('sendDay: a light that does not keep it is unconfirmed; no light is a clear failure', async () => {
  const fake = await startFakeLight({ ignoreSave: true });
  const r = await core.sendDay('127.0.0.1', saveFrameHex(), { h: 1, m: 2, s: 3 }, { port: fake.port });
  assert.equal(r.sent, true);
  assert.equal(r.confirmed, false);
  await fake.close();
  const port = await freePort();
  const r2 = await core.sendDay('127.0.0.1', saveFrameHex(), { h: 1, m: 2, s: 3 }, { port, timeoutMs: 800 });
  assert.equal(r2.sent, false);
  assert.match(r2.message, /^could not reach the light/);
});

test('daily plan: sends today once, skips while the app is connected, says when it runs out', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reef-')), 'plan.json');
  let now = new Date(2026, 10, 17, 9, 15, 0);
  let busy = false;
  const sent = [];
  const plan = new core.DailyPlan(file, {
    now: () => now,
    busy: () => busy,
    send: async (host, hex, clock) => { sent.push({ host, clock }); return { sent: true, confirmed: true, message: 'sent and confirmed by the light' }; },
  });
  assert.equal(await plan.tick(), 'no plan');
  plan.save(JSON.stringify({ light: 'K7_MAC00001', host: '10.0.0.9', frames: { '2026-11-17': saveFrameHex(), '2026-11-18': saveFrameHex() } }));
  busy = true;
  assert.equal(await plan.tick(), 'app connected');
  busy = false;
  assert.equal(await plan.tick(), 'sent');
  assert.deepEqual(sent, [{ host: '10.0.0.9', clock: { h: 9, m: 15, s: 0 } }]);
  assert.equal(await plan.tick(), 'done', 'only once a day');
  assert.match(plan.status().lastResult, /^2026-11-17 09:15, sent and confirmed/);
  // survives a restart
  const again = new core.DailyPlan(file, { now: () => now });
  assert.equal(again.status().applied, '2026-11-17');
  assert.equal(again.status().days, 2);
  // next day goes too, then the plan runs out
  now = new Date(2026, 10, 18, 0, 5, 0);
  assert.equal(await plan.tick(), 'sent');
  now = new Date(2026, 10, 19, 0, 5, 0);
  assert.equal(await plan.tick(), 'expired');
  assert.match(plan.status().lastResult, /run out/);
  plan.clear();
  assert.equal(plan.status().hasPlan, false);
});
