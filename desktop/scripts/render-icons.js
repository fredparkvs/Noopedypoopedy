// Renders the SVG icons to PNG with the bundled Chromium (Playwright).
// Run: node scripts/render-icons.js  (then scripts/make-icns.py builds icon.icns)
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const assets = path.join(__dirname, '..', 'assets');
(async () => {
  const browser = await chromium.launch();
  const render = async (svgFile, size, out) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const svg = fs.readFileSync(path.join(assets, svgFile), 'utf8').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: path.join(assets, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  };
  await render('icon.svg', 1024, 'icon-1024.png');
  await render('tray.svg', 16, 'trayTemplate.png');
  await render('tray.svg', 32, 'trayTemplate@2x.png');
  await browser.close();
  console.log('icons rendered');
})();
