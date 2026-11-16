// Natural cycle end to end against the simulated light.
// Run with: node tests/natural.e2e.js [screenshot-dir]
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
  const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(300); } if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const light = () => page.evaluate(() => {
    const l = window.__nooApp.link.t.lights['192.168.4.1'];
    return { slots: l.slots, auto: l.auto, log: l.log.slice() };
  });
  const expected = () => page.evaluate(() => {
    const n = JSON.parse(localStorage.getItem('noo.natural:K7_AP000001'));
    const d = new Date();
    return window.NooNatural.computeDay(n.settings, new Date(d.getFullYear(), d.getMonth(), d.getDate())).slots;
  });

  await page.goto(url);
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();

  // set up: the study reefs are offered, Singapore is the default
  await page.getByRole('button', { name: 'Set up natural cycle' }).click();
  await page.getByText('Singapore, Kusu reef').waitFor();
  await page.getByText('Great Barrier Reef, Lizard Island').waitFor();
  await page.locator('#nsPreview', { hasText: 'Today on your tank: sunrise' }).waitFor();
  await shot('10-natural-setup');
  await page.locator('#nsGo').click();

  // today's light goes to the light, exactly as computed
  await page.getByText('Today\'s light is on the light.').waitFor({ timeout: 10000 });
  let st = await light();
  assert.deepEqual(st.slots, await expected(), 'the light holds today\'s natural slots');
  assert.equal(st.auto, true);
  await page.getByText('Night ').first().isVisible().catch(() => {});
  await shot('11-natural-card');

  // the 60-day plan for the background job
  await page.waitForFunction(() => window.__nooApp.link.t.plan && Object.keys(window.__nooApp.link.t.plan.frames).length === 60, null, { timeout: 15000 });
  const planOk = await page.evaluate(() => {
    const plan = window.__nooApp.link.t.plan;
    const d = new Date();
    const key = window.NooNatural.ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    const frame = window.NooProtocol.fromHex(plan.frames[key]);
    const slots = [];
    for (let i = 0; i < 24; i++) { const o = 11 + i * 8; slots.push({ h: frame[o], m: frame[o + 1], v: frame.slice(o + 2, o + 8) }); }
    const l = window.__nooApp.link.t.lights['192.168.4.1'];
    return { len: frame.length, auto: frame[203], same: JSON.stringify(slots) === JSON.stringify(l.slots), host: plan.host };
  });
  assert.deepEqual(planOk, { len: 208, auto: 1, same: true, host: '192.168.4.1' });

  // the calendar of nights
  await page.getByRole('button', { name: 'Calendar' }).click();
  await page.locator('#sheetTitle', { hasText: 'The next five weeks' }).waitFor();
  assert.equal(await page.locator('table.cal tbody tr').count(), 35);
  assert.ok(await page.locator('table.cal tbody tr[style]').count() >= 7, 'full moon and the nights after it are highlighted');
  assert.equal(await page.evaluate(() => document.getElementById('sheet').scrollTop), 0, 'the calendar opens at its top');
  await shot('12-natural-calendar');
  await page.locator('#sheetWrap').click({ position: { x: 10, y: 10 } });

  // hand edits are blocked while it runs
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.locator('#toast', { hasText: 'natural cycle sets the schedule' }).waitFor();

  // reopening the app the same day does not send it again
  await page.reload();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  await page.waitForTimeout(800);
  st = await light();
  assert.equal(st.log.filter((h) => h.startsWith('aaa51007')).length, 0, 'not re-sent on the same day');

  // a new day: it catches up as soon as it connects
  await page.evaluate(() => {
    const n = JSON.parse(localStorage.getItem('noo.natural:K7_AP000001'));
    n.lastApplied = '2000-01-01';
    localStorage.setItem('noo.natural:K7_AP000001', JSON.stringify(n));
  });
  await page.reload();
  await page.getByText('Today\'s light is on the light.').waitFor({ timeout: 10000 });
  st = await light();
  assert.equal(st.log.filter((h) => h.startsWith('aaa51007')).length, 1, 'sent once on the new day');

  // turning it off brings back hand editing and clears the plan
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('button', { name: 'Set up natural cycle' }).waitFor();
  await page.getByRole('button', { name: 'Add point' }).waitFor();
  assert.equal(await page.evaluate(() => window.__nooApp.link.t.plan), null);

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('Natural cycle e2e: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
