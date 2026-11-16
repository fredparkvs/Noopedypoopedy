// End-to-end UI test against the in-page simulated light.
// Run with: node tests/ui.e2e.js [screenshot-dir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const WWW = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www');
const SHOTS = process.argv[2] || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(WWW, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      if (!p.startsWith(WWW) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
  const light = () => page.evaluate(() => {
    const l = window.__nooApp.link.t.lights['192.168.1.50'];
    return { auto: l.auto, manual: l.manual, slots: l.slots, clock: l.clock, log: l.log };
  });

  await page.goto(url);

  // first run: the lights sheet opens and starts finding the simulated lights.
  // Tap the first one the moment it appears, while the scan is still probing the
  // second: choosing a light must stop the scan without losing the connection.
  await page.getByText('Found on this network').waitFor();
  assert.equal(await page.evaluate(() => window.__nooApp.state.scanning), true, 'scan still running');
  await page.locator('li', { hasText: 'K7_DEMO0001' }).getByRole('button', { name: 'Use' }).click();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  // and the full list is still reachable afterwards
  await page.locator('[data-action="lights"]').first().click();
  await page.locator('#lsScan').click();
  await page.getByText('K7M_DEMO002').waitFor();
  await page.locator('#lsScan:not([disabled])').waitFor();
  await shot('1-find-lights');
  await page.locator('#sheetWrap').click({ position: { x: 10, y: 10 } });
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  assert.equal(await page.locator('#lightName').textContent(), 'K7_DEMO0001');

  // the schedule was read from the light, not invented, and the clock was set
  await page.waitForFunction(() => window.__nooApp.link.t.lights['192.168.1.50'].clock, null, { timeout: 3000 });
  let st = await light();
  const times = await page.locator('.point .time').allTextContents();
  assert.deepEqual(times, ['08:00', '09:30', '10:00', '18:00', '19:00', '20:00']);
  assert.equal((await page.locator('#saveNote').textContent()).trim(), 'Everything is saved on the light');
  await shot('2-schedule');

  // edit a point: bump White at 10:00 by 5 and move it to 10:30
  await page.locator('.point', { hasText: '10:00' }).click();
  await page.locator('#sheetTitle', { hasText: 'Edit point' }).waitFor();
  for (let i = 0; i < 5; i++) await page.locator('button[data-group="point"][data-ch="0"][data-step="1"]').click();
  await page.locator('[data-pe="15"]').click();
  await page.locator('[data-pe="15"]').click();
  assert.equal(await page.locator('#peTime').textContent(), '10:30');
  // moving into an hour that is taken is refused with an explanation
  await page.locator('#peExact').fill('09:45');
  assert.match(await page.locator('#peErr').textContent(), /one point per hour/);
  assert.equal(await page.locator('#peExact').inputValue(), '10:30');
  await shot('3-edit-point');
  await page.locator('#peDone').click();
  assert.equal((await page.locator('#saveNote').textContent()).trim(), 'Unsaved changes');

  // preview frames were sent while editing, and the mode was restored after
  st = await light();
  assert.ok(st.log.some((h) => h.startsWith('aaa51006')), 'preview sent');

  await page.locator('#saveBtn').click();
  await page.locator('#toast', { hasText: 'The light confirmed' }).waitFor();
  st = await light();
  assert.equal(st.slots[10].m, 30);
  assert.equal(st.slots[10].v[0], 30); // was 25
  assert.equal(st.auto, true);
  assert.equal((await page.locator('#saveNote').textContent()).trim(), 'Everything is saved on the light');

  // manual: moving a slider switches the light to manual and applies live
  await page.locator('.tabs button[data-view="manual"]').click();
  const range = page.locator('input[data-group="manual"][data-ch="1"]');
  await range.fill('80');
  await page.waitForTimeout(400);
  st = await light();
  assert.equal(st.auto, false);
  assert.equal(st.manual[1], 80);
  await page.locator('#statusText', { hasText: 'Manual' }).waitFor();
  // "All" keeps the mix: halve everything
  const before = await page.evaluate(() => window.__nooApp.state.manual.slice());
  await page.locator('#masterRange').fill('40');
  await page.waitForTimeout(400);
  st = await light();
  assert.equal(st.manual[1], 40);
  assert.equal(st.manual[0], Math.round(before[0] / 80 * 40));
  await shot('4-manual');
  await page.locator('[data-scene-b="0"]').click(); // Off
  await page.waitForTimeout(400);
  st = await light();
  assert.deepEqual(st.manual, [0, 0, 0, 0, 0, 0]);
  await page.getByRole('button', { name: 'Run schedule' }).click();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  st = await light();
  assert.equal(st.auto, true);

  // quick setup builds a 4-point day and saves it
  await page.locator('.tabs button[data-view="schedule"]').click();
  await page.getByRole('button', { name: 'Quick setup' }).click();
  await page.locator('#qsOn').fill('10:00');
  await page.locator('#qsOff').fill('21:00');
  await shot('5-quick-setup');
  await page.locator('#qsGo').click();
  assert.deepEqual(await page.locator('.point .time').allTextContents(), ['10:00', '11:30', '19:00', '21:00']);
  await page.locator('#saveBtn').click();
  await page.locator('#toast', { hasText: 'The light confirmed' }).waitFor();
  st = await light();
  assert.equal(st.slots[11].m, 30);
  assert.equal(st.slots[3].v.every((x) => x === 0), true);

  // presets: load LPS factory, saved state becomes dirty
  await page.getByRole('button', { name: 'Presets' }).click();
  await page.locator('[data-factory="LPS"]').click();
  assert.equal((await page.locator('#saveNote').textContent()).trim(), 'Unsaved changes');

  // settings survive a reload of the app (stored on the phone and re-read from the light)
  await page.reload();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  assert.equal((await page.locator('#saveNote').textContent()).trim(), 'Unsaved changes', 'unsaved edits are kept across restarts');

  // lights & backup tab renders and shows the raw status
  await page.locator('.tabs button[data-view="more"]').click();
  await page.getByText('Last status from the light').waitFor();
  await shot('6-more');

  // add-point via chart tap at ~14:00
  await page.locator('.tabs button[data-view="schedule"]').click();
  const box = await page.locator('#chart').boundingBox();
  const x = box.x + box.width * ((30 + (14 / 24) * (360 - 38)) / 360);
  await page.mouse.click(x, box.y + box.height / 2);
  await page.locator('#sheetTitle', { hasText: 'New point' }).waitFor();
  assert.equal(await page.locator('#peTime').textContent(), '14:00');
  await page.locator('#peDone').click();

  // the slow K7 Mini (reply split with a long pause) still connects and reads
  await page.locator('[data-action="lights"]').first().click();
  await page.locator('#lsScan').click();
  await page.locator('li', { hasText: 'K7M_DEMO002' }).getByRole('button', { name: 'Use' }).click();
  await page.locator('#lightName', { hasText: 'K7M_DEMO002' }).waitFor();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.now-out .col').count(), 3, 'Mini shows 3 channels');

  // a light that never answers: clear explanation, retry, and copyable details
  await page.evaluate(() => { window.__nooApp.link.t.busyMs = 1e9; });
  await page.locator('[data-action="lights"]').first().click();
  await page.locator('li', { hasText: 'K7_DEMO0001' }).getByRole('button', { name: /Use|Reconnect/ }).click();
  await page.getByText('accepted the connection but did not answer').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#statusText').textContent(), 'Not answering');
  await shot('7-not-answering');
  const log = await page.evaluate(() => window.__nooApp.link.log.map((l) => l.text).join('\n'));
  assert.match(log, /attempt 4 of 4/);
  assert.match(log, /reconnecting/);
  // once the light is free again, Try again recovers
  await page.evaluate(() => { window.__nooApp.link.t.busyMs = 900; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByText('accepted the connection but did not answer').count(), 0);

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  srv.close();
  console.log('UI e2e: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
