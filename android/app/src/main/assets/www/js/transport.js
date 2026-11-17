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

  // Android delivers results later through window.__noo.resolve; the Mac app's
  // bridge returns a promise of the same JSON instead. Both end up here.
  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        const r = root.NooNative[method](id, ...args);
        if (r && typeof r.then === 'function') {
          r.then((json) => root.__noo.resolve(id, json), (e) => root.__noo.reject(id, (e && e.message) || String(e)));
        }
      } catch (e) { pending.delete(id); reject(e); }
    });
  }

  class NativeTransport {
    constructor() {
      this.kind = 'native';
      this.platform = root.NooNative.platform || 'android';
      this.onData = null;
      this.onClose = null;
      listeners.add((e) => this._event(e));
      if (root.NooNative.onEvent) root.NooNative.onEvent((json) => root.__noo.event(json));
    }
    _event(e) {
      if (e.type === 'data' && this.onData) this.onData(P.fromHex(e.hex));
      if (e.type === 'closed' && this.onClose) this.onClose(e.reason || 'closed');
    }
    connect(host, port, timeoutMs) { return call('connect', host, port, timeoutMs || 5000); }
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
    setDailyPlan(json) { return call('setDailyPlan', json); }
    clearDailyPlan() { return call('clearDailyPlan'); }
    dailyStatus() { return call('dailyStatus'); }
    markApplied(date) { return call('markApplied', date); }
  }

  // ---- demo transport --------------------------------------------------------
  class DemoTransport {
    constructor() {
      this.kind = 'demo';
      this.onData = null;
      this.onClose = null;
      // window.__demoHotspot simulates a phone joined to a light's own hotspot;
      // window.__demoVpn a phone whose VPN swallows local traffic, with a VPN
      // address that accepts connections but never answers
      this.hotspot = !!root.__demoHotspot;
      this.vpn = !!root.__demoVpn;
      this.blackholes = this.vpn ? { '10.2.0.1': true } : {};
      this.lights = this.hotspot
        ? { '192.168.4.1': new root.NooMockLight({ name: 'K7_AP000001' }) }
        : {
          '192.168.1.50': new root.NooMockLight({ name: 'K7_DEMO0001' }),
          '192.168.1.51': new root.NooMockLight({ name: 'K7M_DEMO002', manual: [40, 60, 20, 0, 0, 0] })
        };
      // Like the real ESP8266: it serves one client, and a connection that
      // arrives too soon after the last one closed is accepted but ignored.
      this.busyMs = 900;
      this.closedAt = {};
      // The Mini answers slowly, in two pieces with a long gap between them.
      this.slow = { '192.168.1.51': 260 };
      if (this.vpn) this.lights = {};
      this.connected = null;
      this.silent = false;
    }
    connect(host) {
      this.close();
      return new Promise((resolve, reject) => setTimeout(() => {
        if (this.blackholes[host]) { this.connected = host; this.silent = true; return resolve(true); }
        if (!this.lights[host]) return reject(new Error('No answer from ' + host + '. Is the light on and on this WiFi?'));
        this.silent = Date.now() - (this.closedAt[host] || 0) < this.busyMs;
        this.connected = host;
        resolve(true);
      }, 60));
    }
    send(bytes) {
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      if (this.silent) return Promise.resolve(true);
      const reply = this.lights[this.connected].handle(bytes);
      if (reply) {
        // deliver in two pieces to exercise reassembly, like real TCP can
        const cut = Math.min(reply.length, 4 + Math.floor(Math.random() * 120));
        const gap = this.slow[this.connected] || 30;
        setTimeout(() => this.onData && this.onData(reply.slice(0, cut)), 30);
        if (cut < reply.length) setTimeout(() => this.onData && this.onData(reply.slice(cut)), 30 + gap);
      }
      return Promise.resolve(true);
    }
    close() {
      if (this.connected) this.closedAt[this.connected] = Date.now();
      this.connected = null;
    }
    scan() {
      // a port scan opens and closes a connection to every light
      return new Promise((r) => setTimeout(() => {
        Object.keys(this.lights).forEach((h) => { this.closedAt[h] = Date.now(); });
        r(Object.keys(this.lights).concat(Object.keys(this.blackholes)));
      }, 600));
    }
    netInfo() {
      const n = this.hotspot
        ? { ip: '192.168.4.2', prefix: 24, gateway: '192.168.4.1', dhcpServer: '192.168.4.1', wifi: true }
        : { ip: '192.168.1.20', prefix: 24, gateway: '192.168.1.1', dhcpServer: '192.168.1.1', wifi: true };
      n.vpn = this.vpn;
      return Promise.resolve(n);
    }
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
    // the daily background job only exists in the Android app; keep the plan for tests
    setDailyPlan(json) { this.plan = JSON.parse(json); return Promise.resolve(true); }
    clearDailyPlan() { this.plan = null; return Promise.resolve(true); }
    dailyStatus() { return Promise.resolve({}); }
    markApplied(date) { if (this.plan) this.plan.applied = date; return Promise.resolve(true); }
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
      this.lastClose = {};
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
      if (this.host) this.lastClose[this.host] = Date.now();
      this.framer.reset();
      this._log('sys', 'connection closed: ' + reason);
      if (this.state !== 'idle') this._setState('offline');
    }

    /* Note that something (e.g. a port scan) just opened and closed a connection to these hosts. */
    touched(hosts) { hosts.forEach((h) => { this.lastClose[h] = Date.now(); }); }

    async connect(host, timeoutMs) {
      if (this.state === 'connected' || this.state === 'connecting') {
        if (this.host) this.lastClose[this.host] = Date.now();
      }
      this.t.close();
      this.host = host;
      this._setState('connecting');
      this.framer.reset();
      // The light serves one client and needs a moment to free its slot after
      // a disconnect; a connection made sooner is accepted but never answered.
      // The official app waits a second before every connection for this.
      const wait = SETTLE_MS - (Date.now() - (this.lastClose[host] || 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        await this.t.connect(host, P.PORT, timeoutMs);
        this._log('sys', 'connected to ' + host);
        this._setState('connected');
      } catch (e) {
        this._log('sys', 'connect failed: ' + e.message);
        this._setState('offline');
        throw e;
      }
    }

    close() {
      if (this.host && (this.state === 'connected' || this.state === 'connecting')) this.lastClose[this.host] = Date.now();
      this._setState('idle');
      this.t.close();
      this.framer.reset();
    }

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

    /*
     * Ask for the status block. Like the official app, ask again when the
     * answer does not come; if the light stays silent, reconnect once and
     * try again, since a silent light usually means a stuck connection.
     */
    async readStatus(opts) {
      opts = opts || {};
      const tries = opts.tries || 4;
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        try {
          return await this.send(P.readAll(), { expect: (m) => m.type === 'status', timeout: 3000 });
        } catch (e) {
          lastErr = e;
          this._log('sys', 'no settings from the light (attempt ' + (i + 1) + ' of ' + tries + ')');
          if (opts.reconnect !== false && i === 1 && this.host) {
            this._log('sys', 'reconnecting to ' + this.host);
            try { await this.connect(this.host); } catch (ce) { throw ce; }
          }
        }
      }
      throw lastErr;
    }

    sendAck(bytes, timeout) {
      return this.send(bytes, { expect: (m) => m.type === 'ack', timeout: timeout || 2500 }).catch(() => null);
    }

    /* Connect to a host just long enough to learn its name. */
    async probe(host, timeoutMs) {
      try { await this.connect(host, timeoutMs); } catch (e) { e.stage = 'connect'; throw e; }
      try { return await this.readStatus({ tries: 2, reconnect: false }); } finally { this.close(); }
    }
  }

  const SETTLE_MS = 1200;

  function createTransport() {
    return root.NooNative ? new NativeTransport() : new DemoTransport();
  }

  root.NooTransport = { createTransport, LightLink, DemoTransport, NativeTransport };
})(window);
