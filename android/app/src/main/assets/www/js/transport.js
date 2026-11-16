/*
 * Transports move bytes between the UI and a light.
 *   NativeTransport: the Android app's Java bridge (real TCP sockets).
 *   DemoTransport:   an in-page simulated light, used when there is no bridge.
 * LightLink sits on top and gives the app request/response helpers, framing,
 * a send queue and connection state.
 */
(function (root) {
  'use strict';
  const P = root.NooProtocol;

  // ---- native bridge ------------------------------------------------------
  // Java calls window.__noo.resolve(id, json) / reject(id, msg) / event(json).
  const pending = new Map();
  let nextId = 1;
  const listeners = new Set();
  root.__noo = root.__noo || {};
  root.__noo.resolve = (id, json) => { const p = pending.get(id); if (p) { pending.delete(id); p.resolve(json == null ? null : JSON.parse(json)); } };
  root.__noo.reject = (id, msg) => { const p = pending.get(id); if (p) { pending.delete(id); p.reject(new Error(msg)); } };
  root.__noo.event = (json) => { const e = JSON.parse(json); listeners.forEach((l) => l(e)); };

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try { root.NooNative[method](id, ...args); } catch (e) { pending.delete(id); reject(e); }
    });
  }

  class NativeTransport {
    constructor() { this.kind = 'native'; this.onData = null; this.onClose = null; listeners.add((e) => this._event(e)); }
    _event(e) {
      if (e.type === 'data' && this.onData) this.onData(P.fromHex(e.hex));
      if (e.type === 'closed' && this.onClose) this.onClose(e.reason || 'closed');
    }
    connect(host, port) { return call('connect', host, port, 5000); }
    send(bytes) { return call('send', P.toHex(bytes)); }
    close() { try { root.NooNative.close(); } catch (e) { /* ignore */ } }
    scan(port) { return call('scan', port, 600); }
    netInfo() { return call('netInfo'); }
    wifiInfo() { return call('wifiInfo'); }
    provision(ssid, bssid, password, count) { return call('provision', ssid, bssid, password, count || 1); }
    cancelProvision() { try { root.NooNative.cancelProvision(); } catch (e) { /* ignore */ } }
    saveText(filename, text) { return call('saveText', filename, text); }
    openText() { return call('openText'); }
    copyText(text) { return call('copyText', text); }
  }

  // ---- demo transport --------------------------------------------------------
  class DemoTransport {
    constructor() {
      this.kind = 'demo';
      this.onData = null;
      this.onClose = null;
      this.lights = {
        '192.168.1.50': new root.NooMockLight({ name: 'K7_DEMO0001' }),
        '192.168.1.51': new root.NooMockLight({ name: 'K7M_DEMO002', manual: [40, 60, 20, 0, 0, 0] })
      };
      this.connected = null;
    }
    connect(host) {
      return new Promise((resolve, reject) => setTimeout(() => {
        if (!this.lights[host]) return reject(new Error('No light answered at ' + host));
        this.connected = host;
        resolve(true);
      }, 250));
    }
    send(bytes) {
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      const reply = this.lights[this.connected].handle(bytes);
      if (reply) {
        // deliver in two pieces to exercise reassembly, like real TCP can
        const cut = Math.min(reply.length, 4 + Math.floor(Math.random() * 120));
        setTimeout(() => this.onData && this.onData(reply.slice(0, cut)), 30);
        if (cut < reply.length) setTimeout(() => this.onData && this.onData(reply.slice(cut)), 60);
      }
      return Promise.resolve(true);
    }
    close() { this.connected = null; }
    scan() { return new Promise((r) => setTimeout(() => r(Object.keys(this.lights)), 600)); }
    netInfo() { return Promise.resolve({ ip: '192.168.1.20', gateway: '192.168.1.1', wifi: true }); }
    wifiInfo() { return Promise.resolve({ ssid: 'HomeWiFi', bssid: '00:11:22:33:44:55', frequency: 2437 }); }
    provision() { return new Promise((r) => setTimeout(() => r([{ ip: '192.168.1.52', bssid: 'aa:bb:cc:dd:ee:ff' }]), 1500)); }
    cancelProvision() {}
    saveText(filename, text) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = filename;
      a.click();
      return Promise.resolve(true);
    }
    openText() {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json,text/plain';
        input.onchange = () => { const f = input.files[0]; if (!f) return reject(new Error('cancelled')); f.text().then(resolve, reject); };
        input.click();
      });
    }
    copyText(text) { return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('No clipboard')); }
  }

  // ---- link -------------------------------------------------------------------
  class LightLink {
    constructor(transport) {
      this.t = transport;
      this.state = 'idle'; // idle | connecting | connected | offline
      this.host = null;
      this.handlers = {};
      this.waiters = [];
      this.queue = Promise.resolve();
      this.framer = new P.Framer((m) => this._message(m), 150);
      this.t.onData = (bytes) => { this._log('in', P.toHex(bytes)); this.framer.feed(bytes); };
      this.t.onClose = (reason) => this._closed(reason);
      this.log = [];
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    _emit(name, data) { (this.handlers[name] || []).forEach((fn) => fn(data)); }
    _setState(s) { if (this.state !== s) { this.state = s; this._emit('state', s); } }
    _log(dir, text) {
      this.log.push({ at: new Date().toLocaleTimeString(), dir, text });
      if (this.log.length > 200) this.log.shift();
      this._emit('log');
    }

    _message(m) {
      this._emit('message', m);
      this.waiters = this.waiters.filter((w) => {
        if (w.match(m)) { clearTimeout(w.timer); w.resolve(m); return false; }
        return true;
      });
    }

    _wait(match, timeout) {
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('The light did not answer')); }, timeout);
        this.waiters.push(w);
      });
    }

    _closed(reason) {
      this.framer.reset();
      this._log('sys', 'connection closed: ' + reason);
      if (this.state !== 'idle') this._setState('offline');
    }

    async connect(host) {
      if (this.host !== host || this.state !== 'connected') this.t.close();
      this.host = host;
      this._setState('connecting');
      this.framer.reset();
      try {
        await this.t.connect(host, P.PORT);
        this._log('sys', 'connected to ' + host);
        this._setState('connected');
      } catch (e) {
        this._log('sys', 'connect failed: ' + e.message);
        this._setState('offline');
        throw e;
      }
    }

    close() { this._setState('idle'); this.t.close(); this.framer.reset(); }

    send(bytes, opts) {
      opts = opts || {};
      const run = async () => {
        if (this.state !== 'connected') throw new Error('Not connected to a light');
        const waiting = opts.expect ? this._wait(opts.expect, opts.timeout || 4000) : null;
        this._log('out', P.toHex(bytes));
        await this.t.send(bytes);
        const result = waiting ? await waiting : null;
        await new Promise((r) => setTimeout(r, 40)); // the ESP8266 dislikes back-to-back frames
        return result;
      };
      const job = this.queue.then(run, run);
      this.queue = job.catch(() => {});
      return job;
    }

    readStatus() { return this.send(P.readAll(), { expect: (m) => m.type === 'status', timeout: 4000 }); }

    sendAck(bytes, timeout) {
      return this.send(bytes, { expect: (m) => m.type === 'ack', timeout: timeout || 2500 }).catch(() => null);
    }

    /* Connect to a host just long enough to learn its name. */
    async probe(host) {
      await this.connect(host);
      try { return await this.readStatus(); } finally { this.close(); }
    }
  }

  function createTransport() {
    return root.NooNative ? new NativeTransport() : new DemoTransport();
  }

  root.NooTransport = { createTransport, LightLink, DemoTransport, NativeTransport };
})(window);
