// Exposes window.NooNative to the page, the same bridge the Android app
// provides, carried over Electron IPC to the main process. Each method takes
// the request id first (ignored here) and returns a promise of a JSON string.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (method) => (id, ...args) =>
  ipcRenderer.invoke('noo', method, args).then((r) => {
    if (r && r.error) throw new Error(r.error);
    return r.json;
  });

const methods = ['connect', 'send', 'close', 'scan', 'netInfo', 'wifiInfo', 'provision', 'cancelProvision',
  'saveText', 'openText', 'copyText', 'setDailyPlan', 'clearDailyPlan', 'dailyStatus', 'markApplied'];

const api = { platform: 'mac' };
methods.forEach((m) => { api[m] = call(m); });
api.onEvent = (cb) => { ipcRenderer.on('noo-event', (_e, json) => cb(json)); };

contextBridge.exposeInMainWorld('NooNative', api);
