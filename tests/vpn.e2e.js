// Reproduces a real report: a VPN on the phone, and an earlier session that
// saved a VPN address (10.2.0.1) as "the light" because it accepted a
// connection. The app must not trust an address that never answered, must
// never list it as a light, and must say plainly that a VPN is in the way.
// Run with: node tests/vpn.e2e.js [screenshot-dir]
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const url = 'file://' + path.join(__dirname, '..', 'android/app/src/main/assets/www/index.html');
const SHOTS = process.argv[2] || null;
const staleLight = () => {
  localStorage.setItem('noo.lights', JSON.stringify([{ id: '10.2.0.1', host: '10.2.0.1', model: 'k7' }]));
  localStorage.setItem('noo.current', JSON.stringify('10.2.0.1'));
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // A: VPN on, stale saved address, no light reachable
  const a = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  a.on('pageerror', (e) => errors.push(e.message));
  await a.addInitScript(staleLight);
  await a.addInitScript(() => { window.__demoVpn = true; });
  await a.goto(url);
  await a.getByText('A VPN is switched on.').first().waitFor();
  await a.getByText('No light answered.').waitFor({ timeout: 15000 });
  await a.getByText('1 other device on this network did not answer like a light').waitFor();
  assert.equal(await a.locator('[data-add="10.2.0.1"]').count(), 0, 'the VPN address is never offered as a light');
  assert.equal(await a.locator('[data-use="10.2.0.1"]').count(), 0, 'the stale saved address is forgotten');
  assert.equal(await a.evaluate(() => window.__nooApp.state.light), null, 'no light selected');
  if (SHOTS) await a.screenshot({ path: path.join(SHOTS, '9-vpn.png') });

  // B: VPN off, phone on the light's hotspot, same stale saved address
  const b = await browser.newPage({ viewport: { width: 400, height: 860 } });
  b.on('pageerror', (e) => errors.push(e.message));
  await b.addInitScript(staleLight);
  await b.addInitScript(() => { window.__demoHotspot = true; });
  await b.goto(url);
  await b.locator('#lightName', { hasText: 'K7_AP000001' }).waitFor();
  await b.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  const saved = await b.evaluate(() => JSON.parse(localStorage.getItem('noo.lights')).map((l) => l.id));
  assert.deepEqual(saved, ['K7_AP000001'], 'the address that never answered was replaced by the real light');
  assert.equal(await b.getByText('A VPN is switched on.').count(), 0);

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('VPN e2e: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
