// Reef Light for the Mac: the app window, the menu-bar icon, and the bridge
// between the page and the light. Keeps running in the menu bar when the
// window is closed, so the natural cycle can send each new day.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const core = require('./core');

if (process.env.REEF_USER_DATA) app.setPath('userData', process.env.REEF_USER_DATA);
const extraHosts = (process.env.REEF_EXTRA_HOSTS || '').split(',').filter(Boolean); // for tests
const TICK_MS = +(process.env.REEF_TICK_MS || 10 * 60 * 1000);

let win = null;
let tray = null;
let quitting = false;
const sessions = new Map(); // webContents id -> LightSession

const plan = new core.DailyPlan(path.join(app.getPath('userData'), 'daily-plan.json'), {
  // leave the light alone while a window holds its single connection
  busy: (host) => [...sessions.values()].some((s) => s.host === host),
});

const NO_WIFI_SETUP = 'Putting a light on WiFi needs the Android app: it uses the phone\'s WiFi radio.';

function sessionFor(contents) {
  let s = sessions.get(contents.id);
  if (!s) {
    const send = (o) => { if (!contents.isDestroyed()) contents.send('noo-event', JSON.stringify(o)); };
    s = new core.LightSession(
      (data) => send({ type: 'data', hex: core.toHex(data) }),
      (reason) => send({ type: 'closed', reason }),
    );
    sessions.set(contents.id, s);
    contents.once('destroyed', () => { s.close(); sessions.delete(contents.id); });
  }
  return s;
}

const handlers = {
  connect: (c, host, port, timeoutMs) => sessionFor(c).connect(host, port, timeoutMs),
  send: (c, hex) => sessionFor(c).send(hex),
  close: (c) => { sessionFor(c).close(); return true; },
  scan: (c, port, timeoutMs) => core.scan(port, timeoutMs, extraHosts),
  netInfo: () => core.netInfo(),
  wifiInfo: () => { throw new Error(NO_WIFI_SETUP); },
  provision: () => { throw new Error(NO_WIFI_SETUP); },
  cancelProvision: () => true,
  saveText: async (c, filename, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: 'Backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) throw new Error('cancelled');
    fs.writeFileSync(r.filePath, text);
    return true;
  },
  openText: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Backup', extensions: ['json', 'txt'] }] });
    if (r.canceled || !r.filePaths.length) throw new Error('cancelled');
    return fs.readFileSync(r.filePaths[0], 'utf8');
  },
  copyText: (c, text) => { clipboard.writeText(text); return true; },
  setDailyPlan: (c, json) => { const ok = plan.save(json); setTimeout(() => plan.tick(), 5000); return ok; },
  clearDailyPlan: () => plan.clear(),
  dailyStatus: () => plan.status(),
  markApplied: (c, date) => plan.markApplied(date),
};

ipcMain.handle('noo', async (event, method, args) => {
  const fn = handlers[method];
  if (!fn) return { error: 'Unknown command ' + method };
  try {
    const result = await fn(event.sender, ...(args || []));
    return { json: JSON.stringify(result === undefined ? null : result) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 920,
    minWidth: 380,
    minHeight: 560,
    title: 'Reef Light',
    backgroundColor: '#0d1f2b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'www', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // links to anywhere else open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function trayMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Open Reef Light', click: showWindow },
    { type: 'separator' },
    { label: 'Keep running for daily updates', enabled: false },
    { label: 'Open at login', type: 'checkbox', checked: login, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }); } },
    { type: 'separator' },
    { label: 'Quit Reef Light', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Reef Light');
  tray.on('click', () => tray.popUpContextMenu(trayMenu()));
  tray.setContextMenu(trayMenu());
}

function appMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ];
  if (process.platform !== 'darwin') template.shift();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    appMenu();
    createTray();
    const hidden = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;
    if (!hidden) createWindow();
    setTimeout(() => plan.tick(), 30000);
    setInterval(() => plan.tick(), TICK_MS);
  });
  app.on('activate', showWindow);
  // stay in the menu bar when the window closes; quit only from the menu
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && quitting) app.quit(); });
  app.on('before-quit', () => { quitting = true; });
}

global.__reef = { plan, sessions }; // for the end-to-end test
module.exports = { handlers, plan };
