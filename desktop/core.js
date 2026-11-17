// Reef Light for the Mac: the parts that talk to the light. Plain Node (no
// Electron), so it can be tested on its own. Mirrors the Android app's Kotlin
// side: LightConnection, NetScanner, DailySender and DailyPlan.
'use strict';

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = 8266;

const toHex = (buf) => Buffer.from(buf).toString('hex');
const fromHex = (hex) => Buffer.from(String(hex).replace(/[^0-9a-fA-F]/g, ''), 'hex');

function friendly(err, host) {
  if (err.code === 'ETIMEDOUT' || err.message === 'timeout') return `No answer from ${host}. Is the light on and on this WiFi?`;
  if (err.code === 'ECONNREFUSED') return `${host} refused the connection. Close the official app if it is open.`;
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return `Cannot reach ${host} from this network.`;
  return err.message || `Could not connect to ${host}`;
}

/* Open a TCP connection with a timeout. Resolves with the socket. */
function dial(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

/*
 * One connection to a light. Bytes are handed on raw as they arrive; the
 * app's JavaScript reassembles replies. A drop we did not ask for is reported.
 */
class LightSession {
  constructor(onData, onClosed) {
    this.onData = onData;
    this.onClosed = onClosed;
    this.sock = null;
    this.host = null;
  }

  async connect(host, port, timeoutMs) {
    this.close();
    let sock;
    try {
      sock = await dial(host, port || PORT, timeoutMs || 5000);
    } catch (e) {
      throw new Error(friendly(e, host));
    }
    sock.setNoDelay(true);
    sock.setKeepAlive(true);
    this.sock = sock;
    this.host = host;
    sock.on('data', (d) => { if (this.sock === sock) this.onData(d); });
    const dropped = (reason) => {
      if (this.sock !== sock) return; // we closed it ourselves
      this.sock = null;
      this.host = null;
      this.onClosed(reason);
    };
    sock.on('error', (e) => dropped(e.message || 'connection lost'));
    sock.on('close', () => dropped('the light closed the connection'));
    return true;
  }

  send(hex) {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error('Not connected to a light'));
    return new Promise((resolve, reject) => sock.write(fromHex(hex), (e) => (e ? reject(e) : resolve(true))));
  }

  close() {
    const sock = this.sock;
    this.sock = null;
    this.host = null;
    if (sock) sock.destroy();
  }
}

// ---- network ------------------------------------------------------------------

function ipToInt(ip) { return ip.split('.').reduce((a, p) => ((a << 8) | (+p & 255)) >>> 0, 0); }
function intToIp(n) { return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'); }

/* This computer's IPv4 addresses on real networks (not loopback, not VPN tunnels). */
function localAddresses(ifaces) {
  ifaces = ifaces || os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/^(utun|tun|tap|ppp|ipsec|wg|lo|docker|br-|veth|awdl|llw|bridge)/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const prefix = a.cidr ? +a.cidr.split('/')[1] : 24;
      out.push({ name, ip: a.address, prefix });
    }
  }
  return out;
}

/* Every address in the /24 around each local address (or the real subnet if smaller), extras first. */
function candidates(addrs, extras) {
  const out = new Set((extras || []).filter(Boolean));
  for (const a of addrs) {
    const p = Math.max(24, Math.min(30, a.prefix));
    const mask = (0xffffffff << (32 - p)) >>> 0;
    const base = (ipToInt(a.ip) & mask) >>> 0;
    const count = 2 ** (32 - p);
    for (let i = 1; i < count - 1; i++) {
      const ip = intToIp((base + i) >>> 0);
      if (ip !== a.ip) out.add(ip);
    }
  }
  return [...out];
}

function gateway() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('route', ['-n', 'get', 'default'], { timeout: 2000 }, (err, stdout) => {
        const m = !err && /gateway:\s*([0-9.]+)/.exec(stdout || '');
        resolve(m ? m[1] : null);
      });
    } else if (process.platform === 'linux') {
      try {
        const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
        for (const l of lines) {
          const f = l.trim().split(/\s+/);
          if (f[1] === '00000000' && f[2] !== '00000000') {
            const g = parseInt(f[2], 16);
            return resolve([g & 255, (g >> 8) & 255, (g >> 16) & 255, (g >> 24) & 255].join('.'));
          }
        }
      } catch (e) { /* no route table */ }
      resolve(null);
    } else {
      resolve(null);
    }
  });
}

async function netInfo() {
  const addrs = localAddresses();
  const gw = await gateway();
  const first = addrs[0] || null;
  const vpn = Object.keys(os.networkInterfaces()).some((n) => /^(utun|tun|ppp|ipsec|wg)/.test(n) &&
    (os.networkInterfaces()[n] || []).some((a) => (a.family === 'IPv4' || a.family === 4) && !a.address.startsWith('169.254')));
  return { ip: first && first.ip, prefix: first ? first.prefix : 24, gateway: gw, dhcpServer: null, wifi: !!first, vpn };
}

async function isOpen(host, port, timeoutMs) {
  try { const s = await dial(host, port, timeoutMs); s.destroy(); return true; } catch (e) { return false; }
}

/* Hosts with the light's port open, in candidate order. */
async function scan(port, timeoutMs, extraHosts) {
  const gw = await gateway();
  const hosts = candidates(localAddresses(), [gw, '192.168.4.1'].concat(extraHosts || []));
  const found = new Array(hosts.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const i = next++;
      found[i] = await isOpen(hosts[i], port || PORT, timeoutMs || 600);
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, hosts.length) }, worker));
  return hosts.filter((h, i) => found[i]);
}

// ---- one day's light, sent by the background updater ----------------------------

const TIME_AT = 204; // h m s inside the 208-byte SAVE frame

function syncTimeFrame(h, m, s) { return Buffer.from([0xaa, 0xa5, 0x10, 0x03, h, m, s, 0xbb]); }

function withTime(frame, h, m, s) {
  if (frame.length !== 208 || frame[3] !== 0x07) throw new Error('not a SAVE frame');
  const f = Buffer.from(frame);
  f[TIME_AT] = h; f[TIME_AT + 1] = m; f[TIME_AT + 2] = s;
  return f;
}

/* Read until a status block (215+ bytes from AB AA, not an ack) arrives, or give up. */
function readStatus(sock, timeoutMs) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = (v) => { clearTimeout(timer); sock.removeListener('data', onData); resolve(v); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (let i = 0; i + 1 < buf.length; i++) {
        const ack = buf[i + 2] === 0xa5 && buf[i + 3] === 0xa1;
        if (buf[i] === 0xab && buf[i + 1] === 0xaa && !ack && buf.length - i >= 215) return done(buf.subarray(i));
      }
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('data', onData);
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendDay(host, frameHex, clock, opts) {
  opts = opts || {};
  const frame = fromHex(frameHex);
  let sock;
  try {
    sock = await dial(host, opts.port || PORT, opts.timeoutMs || 4000);
  } catch (e) {
    return { sent: false, confirmed: false, message: `could not reach the light at ${host} (${friendly(e, host)})` };
  }
  try {
    sock.on('error', () => {});
    sock.write(syncTimeFrame(clock.h, clock.m, clock.s));
    await pause(300);
    sock.write(withTime(frame, clock.h, clock.m, clock.s));
    await pause(500);
    const statusP = readStatus(sock, 3000);
    sock.write(Buffer.from([0xaa, 0xa5, 0x10, 0x08, 0xbb]));
    const status = await statusP;
    const confirmed = !!status && frame.subarray(11, 203).equals(status.subarray(11, 203));
    return { sent: true, confirmed, message: confirmed ? 'sent and confirmed by the light' : 'sent (the light did not confirm it)' };
  } finally {
    sock.destroy();
  }
}

// ---- the natural cycle's prepared days ------------------------------------------------

function ymd(d) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/*
 * The next 60 days prepared by the app, stored in a file, and a tick that
 * sends today's once whenever the light can be reached.
 */
class DailyPlan {
  constructor(file, opts) {
    this.file = file;
    this.opts = Object.assign({ now: () => new Date(), send: sendDay, busy: () => false, dhcpServer: () => null }, opts || {});
    this.data = this._load();
    this.running = false;
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return {}; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  save(json) {
    const plan = JSON.parse(json);
    this.data.plan = plan;
    if (plan.applied) this.data.applied = plan.applied;
    this._save();
    return true;
  }

  clear() { delete this.data.plan; this._save(); return true; }

  markApplied(date) { this.data.applied = date; this._save(); return true; }

  _result(text) {
    const n = this.opts.now();
    const p = (x) => (x < 10 ? '0' : '') + x;
    this.data.result = ymd(n) + ' ' + p(n.getHours()) + ':' + p(n.getMinutes()) + ', ' + text + '.';
    this._save();
  }

  status() {
    const plan = this.data.plan;
    return { hasPlan: !!plan, days: plan ? Object.keys(plan.frames || {}).length : 0, applied: this.data.applied || null, lastResult: this.data.result || null };
  }

  /* Send today's light if it has not been sent. Returns what happened. */
  async tick() {
    if (this.running) return 'busy';
    const plan = this.data.plan;
    if (!plan) return 'no plan';
    const now = this.opts.now();
    const today = ymd(now);
    if (this.data.applied === today) return 'done';
    if (this.opts.busy(plan.host)) return 'app connected';
    const hex = (plan.frames || {})[today];
    if (!hex) { this._result('the prepared days have run out; open the app to prepare more'); return 'expired'; }
    this.running = true;
    try {
      const hosts = [...new Set([plan.host, this.opts.dhcpServer()].filter(Boolean))];
      let last = 'could not reach the light';
      for (const host of hosts) {
        const r = await this.opts.send(host, hex, { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds() });
        if (r.sent) {
          this.data.applied = today;
          this._result(r.message);
          return 'sent';
        }
        last = r.message;
      }
      this._result(last + ', will try again');
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}

module.exports = { PORT, LightSession, localAddresses, candidates, gateway, netInfo, scan, isOpen, syncTimeFrame, withTime, sendDay, DailyPlan, ymd, toHex, fromHex };
