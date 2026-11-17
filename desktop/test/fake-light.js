// A fake light on a real TCP port, speaking the protocol through the same
// simulated light the browser tests use (www/js/mock-light.js).
'use strict';
const net = require('node:net');
const path = require('node:path');
const www = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'js');
require(path.join(www, 'protocol.js'));
const MockLight = require(path.join(www, 'mock-light.js'));

function startFakeLight(opts) {
  opts = opts || {};
  const light = new MockLight({ name: opts.name || 'K7_MAC00001' });
  const received = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = [];
    sock.on('data', (d) => {
      for (const b of d) {
        buf.push(b);
        if (b !== 0xbb) continue;
        const frame = buf; buf = [];
        received.push(Buffer.from(frame).toString('hex'));
        if (opts.dropAfterFrame) { sock.destroy(); return; }
        const isSave = frame[3] === 0x07;
        const before = isSave && opts.ignoreSave ? JSON.stringify(light.slots) : null;
        const reply = light.handle(frame);
        if (before) light.slots = JSON.parse(before);
        if (!reply) continue;
        // like real TCP: the status block can arrive in two pieces
        const cut = Math.min(reply.length, 60);
        sock.write(Buffer.from(reply.slice(0, cut)));
        if (cut < reply.length) setTimeout(() => { if (!sock.destroyed) sock.write(Buffer.from(reply.slice(cut))); }, 20);
      }
    });
  });
  return new Promise((resolve) => server.listen(opts.port || 0, opts.host || '127.0.0.1', () => {
    resolve({
      light, received, port: server.address().port,
      close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
    });
  }));
}

module.exports = { startFakeLight };
