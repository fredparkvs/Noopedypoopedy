// Runs the UI against a fake window.NooNative that behaves like LightBridge.kt:
// same method names and argument counts (read from the Kotlin source), results
// delivered later through window.__noo.resolve/reject with JSON strings, and
// incoming bytes pushed through window.__noo.event.
// Run with: node tests/native-bridge.e2e.js
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const kotlin = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/dev/reeflight/k7/LightBridge.kt'), 'utf8');
const signatures = {};
for (const m of kotlin.matchAll(/@JavascriptInterface\s+fun\s+(\w+)\(([^)]*)\)/g)) {
  signatures[m[1]] = m[2].trim() ? m[2].split(',').length : 0;
}
assert.ok(Object.keys(signatures).length >= 10, 'found the bridge methods');

const url = 'file://' + path.join(ROOT, 'android/app/src/main/assets/www/index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.addInitScript((sigs) => {
    const calls = [];
    window.__calls = calls;
    let light = null;
    let connectedHost = null;
    const later = (fn) => setTimeout(fn, 20);
    const ok = (id, value) => later(() => window.__noo.resolve(id, JSON.stringify(value)));
    const fail = (id, msg) => later(() => window.__noo.reject(id, msg));
    const emit = (o) => later(() => window.__noo.event(JSON.stringify(o)));
    const hex = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
    const impl = {
      connect(id, host, port, timeout) {
        if (host !== '10.0.0.77' || port !== 8266) return fail(id, 'No answer from ' + host);
        light = light || new window.NooMockLight({ name: 'K7_BRIDGE01' });
        connectedHost = host;
        ok(id, true);
      },
      send(id, h) {
        if (!connectedHost) return fail(id, 'Not connected to a light');
        const reply = light.handle(window.NooProtocol.fromHex(h));
        ok(id, true);
        if (reply) { emit({ type: 'data', hex: hex(reply.slice(0, 60)) }); emit({ type: 'data', hex: hex(reply.slice(60)) }); }
      },
      close() { connectedHost = null; },
      scan(id, port, timeout) { ok(id, ['10.0.0.77']); },
      netInfo(id) { ok(id, { ip: '10.0.0.5', prefix: 24, gateway: '10.0.0.1', wifi: true }); },
      wifiInfo(id) { ok(id, { ssid: 'Reef', bssid: '00:11:22:33:44:55', frequency: 2412 }); },
      provision(id, ssid, bssid, password, count) { ok(id, [{ ip: '10.0.0.77', bssid: 'aa:bb' }]); },
      cancelProvision() {},
      saveText(id, filename, text) { window.__saved = { filename, text }; ok(id, true); },
      openText(id) { ok(id, window.__saved ? window.__saved.text : ''); },
      copyText(id, text) { window.__copied = text; ok(id, true); },
      setDailyPlan(id, json) { window.__plan = JSON.parse(json); ok(id, true); },
      clearDailyPlan(id) { window.__plan = null; ok(id, true); },
      dailyStatus(id) { ok(id, { hasPlan: !!window.__plan, lastResult: null }); },
      markApplied(id, date) { ok(id, true); }
    };
    window.__dropLight = () => { connectedHost = null; emit({ type: 'closed', reason: 'connection lost' }); };
    window.__light = () => light;
    // Like the real WebView bridge: unknown methods are missing, wrong arity throws.
    window.NooNative = {};
    Object.keys(sigs).forEach((name) => {
      window.NooNative[name] = function () {
        calls.push(name);
        if (arguments.length !== sigs[name]) throw new Error('Bridge ' + name + ' expects ' + sigs[name] + ' args, got ' + arguments.length);
        if (!impl[name]) throw new Error('fake has no ' + name);
        return impl[name].apply(null, arguments);
      };
    });
  }, signatures);

  await page.goto(url);
  assert.equal(await page.locator('#demoBanner').isHidden(), true, 'native transport is used, no demo banner');

  // the only light on the network: the app connects without a tap
  await page.locator('#lightName', { hasText: 'K7_BRIDGE01' }).waitFor();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();

  // edit, save, verify on the fake light
  await page.locator('.point').first().click();
  await page.locator('button[data-group="point"][data-ch="1"][data-step="1"]').click();
  await page.locator('#peDone').click();
  await page.locator('#saveBtn').click();
  await page.locator('#toast', { hasText: 'The light confirmed' }).waitFor();

  // the light drops the connection: the app notices and reconnects by itself
  await page.evaluate(() => window.__dropLight());
  await page.locator('#statusText', { hasText: 'Offline' }).waitFor();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor({ timeout: 8000 });

  // backup goes through saveText, restore through openText
  await page.locator('.tabs button[data-view="more"]').click();
  await page.getByRole('button', { name: 'Save backup file' }).click();
  await page.locator('#toast', { hasText: 'Backup saved' }).waitFor();
  const saved = await page.evaluate(() => window.__saved);
  assert.match(saved.filename, /^reef-light-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(JSON.parse(saved.text).app, 'reef-light');
  await page.getByRole('button', { name: 'Restore backup file' }).click();
  await page.locator('#toast', { hasText: 'Backup restored' }).waitFor();

  await page.getByRole('button', { name: 'Copy official-app code' }).click();
  assert.match(await page.evaluate(() => window.__copied), /^[0-9a-f]{12}#[0-9a-f]{384}$/);

  // WiFi provisioning passes the SSID, BSSID and password to EspTouch
  await page.getByRole('button', { name: 'Put a light on WiFi' }).first().click();
  await page.getByText('Network:').waitFor();
  await page.locator('#wsPass').fill('hunter22');
  await page.locator('#wsGo').click();
  await page.locator('#statusText', { hasText: 'Running schedule' }).waitFor();

  const calls = await page.evaluate(() => window.__calls);
  for (const m of ['scan', 'connect', 'send', 'saveText', 'openText', 'copyText', 'wifiInfo', 'provision']) {
    assert.ok(calls.includes(m), 'bridge method used: ' + m);
  }
  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('Native bridge e2e: all checks passed (' + Object.keys(signatures).length + ' bridge methods checked)');
})().catch((e) => { console.error(e); process.exit(1); });
