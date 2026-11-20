// PAR calibration wizard and planner, end to end against the simulated light.
// Run with: node tests/par.e2e.js [screenshot-dir]
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
  const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const light = () => page.evaluate(() => { const l = window.__nooApp.link.t.lights['192.168.4.1']; return { auto: l.auto, manual: l.manual.slice() }; });

  await page.goto(url);
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  await page.getByRole('tab', { name: 'Lights & backup' }).click();
  await page.getByText('has not been calibrated yet').waitFor();
  await page.getByRole('button', { name: 'Calibrate with a PAR meter' }).click();
  await page.locator('#parH').fill('20');
  await shot('20-par-setup');
  await page.locator('#parGo').click();

  // a made-up light gives the "meter readings"; the meter reads 40 low, the app adds the 40 back
  const truthReading = (values, pos) => page.evaluate(([values, pos]) => {
    const truth = {
      lightHeight: 20, fixtureHalfSize: 8, combined: [[1 / 6, 1], [0.5, 0.97], [1, 0.9]],
      channels: [[600000, 2], [900000, 3], [150000, 1.5], [200000, 2.5], [500000, 3.5], [120000, 1.2]].map(([I0, m], c) => ({
        I0, m, absorb: [0.06, 0.02, 0.05, 0.03, 0.02, 0.4][c], curve: [[0, 0], [10, 0.06], [25, 0.2], [50, 0.47], [75, 0.74], [100, 1]]
      }))
    };
    return Math.max(0, Math.round(window.NooPar.predict(truth, pos, values, 20) + 45 - 40)); // 45 PAR of room light, so the meter never bottoms out at 0
  }, [values, pos]);

  const steps = await page.evaluate(() => window.NooPar.buildSteps('k7', window.NooPar.defaultPositions()));
  const positions = await page.evaluate(() => window.NooPar.defaultPositions());
  for (let i = 0; i < steps.length; i++) {
    await page.locator('#sheetTitle', { hasText: 'Reading ' + (i + 1) + ' of ' + steps.length }).waitFor();
    if (i === 0) await shot('21-par-step');
    // the light shows exactly what the step asks for, in manual mode
    await page.waitForFunction((v) => { const l = window.__nooApp.link.t.lights['192.168.4.1']; return !l.auto && JSON.stringify(l.manual) === JSON.stringify(v); }, steps[i].values, { timeout: 3000 });
    if (i === 12) { // stop half way and carry on later
      await page.locator('#parStop').click();
      assert.equal((await light()).auto, true, 'stopping puts the schedule back');
      await page.getByRole('button', { name: /Continue calibrating \(12 of/ }).click();
      await page.locator('#parGo').click();
      await page.locator('#sheetTitle', { hasText: 'Reading 13 of' }).waitFor();
    }
    await page.locator('#parVal').fill(String(await truthReading(steps[i].values, positions[steps[i].pos])));
    await page.locator('#parVal').press('Enter');
  }

  await page.locator('#sheetTitle', { hasText: 'Calibration done' }).waitFor();
  assert.equal((await light()).auto, true, 'the schedule runs again after calibrating');
  const cal = await page.evaluate(() => JSON.parse(localStorage.getItem('noo.parCal:k7')));
  assert.ok(cal.rms < 0.05, 'fits the readings, rms ' + cal.rms);
  assert.deepEqual(cal.correction, { add: 40, mult: 1 });
  await shot('22-par-results');

  // the planner
  await page.locator('#sheetBody').getByRole('button', { name: 'Open planner' }).click();
  await page.locator('#ppD').fill('30');
  await page.locator('#ppO').fill('10');
  await page.locator('#ppT').fill('250');
  await page.locator('#ppT').dispatchEvent('input');
  await page.locator('.par-big', { hasText: /2[45]\d PAR estimated/ }).waitFor();
  await shot('23-par-planner');
  await page.locator('#ppShow').click();
  // the light shows the planned settings, in manual mode
  await page.waitForFunction(() => {
    const l = window.__nooApp.link.t.lights['192.168.4.1'];
    return !l.auto && JSON.stringify(l.manual) === JSON.stringify(window.__nooApp.state.manual) && l.manual[1] < 100;
  }, null, { timeout: 3000 });

  await page.locator('#ppMeas').fill('260');
  await page.locator('#ppCmp').click();
  await page.locator('#ppCmpOut', { hasText: /Meter 260, estimate 2\d\d/ }).waitFor();
  const checks = await page.evaluate(() => JSON.parse(localStorage.getItem('noo.parChecks:k7')));
  assert.equal(checks.length, 1);

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PAR e2e passed');
})().catch((e) => { console.error(e); process.exit(1); });
