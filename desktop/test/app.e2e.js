// Runs the real desktop app (Electron, Linux build of the same code) against a
// fake light on 127.0.0.1:8266. Needs a display: xvfb-run -a node test/app.e2e.js [screenshot-dir]
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { startFakeLight } = require('./fake-light');

const SHOTS = process.argv[2] || null;
const appDir = path.join(__dirname, '..');

(async () => {
  const fake = await startFakeLight({ port: 8266, name: 'K7_MAC00001' });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-mac-'));
  const env = Object.assign({}, process.env, { REEF_USER_DATA: userData, REEF_EXTRA_HOSTS: '127.0.0.1', REEF_TICK_MS: '1500' });
  delete env.NODE_OPTIONS; // Electron rejects some Node options set in this environment
  const app = await electron.launch({ executablePath: require('electron'), args: [appDir, '--no-sandbox'], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

  assert.equal(await page.title(), 'Reef Light');
  assert.equal(await page.evaluate(() => window.NooNative.platform), 'mac');
  assert.equal(await page.locator('#demoBanner').isHidden(), true, 'real bridge, not the demo');

  // first run: it searches, finds the only light, and connects by itself
  await page.locator('#lightName', { hasText: 'K7_MAC00001' }).waitFor({ timeout: 30000 });
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();
  await shot('mac-1-connected');

  // edit and save: the fake light holds the change, and the app confirms it
  await page.locator('.point').first().click();
  await page.locator('button[data-group="point"][data-ch="1"][data-step="1"]').click();
  await page.locator('#peDone').click();
  await page.locator('#saveBtn').click();
  await page.locator('#toast', { hasText: 'The light confirmed' }).waitFor();
  assert.ok(fake.received.some((h) => h.startsWith('aaa51007')), 'SAVE reached the light');

  // backup through the Mac save dialog (answered automatically here)
  const backupFile = path.join(userData, 'backup.json');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, backupFile);
  await page.locator('.tabs button[data-view="more"]').click();
  await page.getByRole('button', { name: 'Save backup file' }).click();
  await page.locator('#toast', { hasText: 'Backup saved' }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).app, 'reef-light');

  // putting a light on WiFi explains that it needs the phone
  await page.getByRole('button', { name: 'Put a light on WiFi' }).first().click();
  await page.getByText('needs the Android app').waitFor();
  await page.locator('#wsCancel').click();

  // natural cycle: today's light goes to the light, 60 days are stored for the menu-bar updater
  await page.locator('.tabs button[data-view="schedule"]').click();
  await page.getByRole('button', { name: 'Set up natural cycle' }).click();
  await page.locator('#nsPreview', { hasText: 'Today on your tank' }).waitFor();
  await page.locator('#nsGo').click();
  await page.getByText('Today\'s light is on the light.').waitFor({ timeout: 15000 });
  await shot('mac-2-natural');
  const planFile = path.join(userData, 'daily-plan.json');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (Object.keys(JSON.parse(fs.readFileSync(planFile, 'utf8')).plan.frames).length === 60) break; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const stored = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.equal(Object.keys(stored.plan.frames).length, 60);
  assert.equal(stored.plan.host, '127.0.0.1');

  // a new day with the window closed: the menu-bar updater sends it by itself
  await app.evaluate(() => { global.__reef.plan.markApplied('2000-01-01'); });
  const savesBefore = fake.received.filter((h) => h.startsWith('aaa51007')).length;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach((w) => w.close()); });
  const until = Date.now() + 15000;
  let status = null;
  while (Date.now() < until) {
    status = await app.evaluate(() => global.__reef.plan.status());
    if (status.lastResult && /sent/.test(status.lastResult)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.match(status.lastResult, /sent and confirmed by the light/, JSON.stringify(status));
  assert.equal(fake.received.filter((h) => h.startsWith('aaa51007')).length, savesBefore + 1, 'one SAVE from the updater');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0, 'still running with no window');

  assert.deepEqual(errors, [], 'no page errors');
  await app.close();
  await fake.close();
  console.log('Mac app e2e: all checks passed');
})().catch(async (e) => { console.error(e); process.exit(1); });
