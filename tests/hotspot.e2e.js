// The phone is joined to the light's own WiFi hotspot (the official app's
// "AP connection"): the app should go straight to the light, connect without
// a tap, show that the identity is confirmed, and Blink should reach it.
// Run with: node tests/hotspot.e2e.js [screenshot-dir]
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const url = 'file://' + path.join(__dirname, '..', 'android/app/src/main/assets/www/index.html');
const SHOTS = process.argv[2] || null;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__demoHotspot = true; });
  await page.goto(url);

  // no tap needed: it asks the hotspot's address first and connects
  await page.locator('#lightName', { hasText: 'K7_AP000001' }).waitFor();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  const log = await page.evaluate(() => window.__nooApp.link.log.map((l) => l.text));
  const firstConnect = log.find((t) => t.startsWith('connected to'));
  assert.equal(firstConnect, 'connected to 192.168.4.1', 'went straight to the hotspot address');

  await page.locator('.tabs button[data-view="more"]').click();
  await page.getByText('Confirmed: the light answered with its own name').waitFor();
  await page.getByText('Through the light\'s own WiFi hotspot').waitFor();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '8-hotspot-identity.png') });

  // Blink: dark twice, then exactly back to the schedule
  await page.evaluate(() => { window.__nooApp.link.t.lights['192.168.4.1'].log.length = 0; });
  await page.getByRole('button', { name: 'Blink the light' }).click();
  await page.waitForFunction(() => {
    const l = window.__nooApp.link.t.lights['192.168.4.1'].log;
    return l.length && l[l.length - 1] === 'aaa5100401bb';
  }, null, { timeout: 10000 });
  const sent = await page.evaluate(() => window.__nooApp.link.t.lights['192.168.4.1'].log.slice());
  assert.equal(sent[0], 'aaa5100400bb', 'switches to manual first');
  assert.equal(sent.filter((h) => h === 'aaa51005000000000000bb').length, 2, 'goes dark twice');
  const light = await page.evaluate(() => { const l = window.__nooApp.link.t.lights['192.168.4.1']; return { auto: l.auto }; });
  assert.equal(light.auto, true, 'back on the schedule afterwards');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('Hotspot e2e: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
