/*
 * A simulated K7 light that speaks the real protocol. Used for the in-app
 * demo (when no native bridge is present) and by the automated tests.
 */
(function (root) {
  'use strict';
  var P = root.NooProtocol || (typeof require !== 'undefined' ? require('./protocol.js') : null);

  function MockLight(opts) {
    opts = opts || {};
    this.name = opts.name || 'K7_DEMO0001';
    this.manual = (opts.manual || [50, 50, 50, 50, 50, 50]).slice();
    this.auto = opts.auto !== false;
    this.slots = opts.slots || defaultSlots();
    this.clock = null;
    this.demo = false;
    this.preview = null;
    this.log = [];
  }

  function defaultSlots() {
    var s = [];
    for (var h = 0; h < 24; h++) {
      var v = h >= 10 && h <= 18 ? [25, 70, 10, 40, 60, 8] : h === 9 || h === 19 ? [5, 30, 2, 15, 25, 1] : [0, 0, 0, 0, 0, 0];
      s.push({ h: h, m: 0, v: v });
    }
    s[9].m = 30;
    return s;
  }

  MockLight.prototype.statusBytes = function () {
    var b = [0xAB, 0xAA, 0x10, 0x08].concat(this.manual.slice(0, 6), [0x18]);
    this.slots.forEach(function (s) { b.push(s.h, s.m); b = b.concat(s.v.slice(0, 6)); });
    b.push(this.auto ? 1 : 0);
    var n = (this.name + '\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000').slice(0, 11);
    for (var i = 0; i < 11; i++) b.push(n.charCodeAt(i));
    return b.concat([0, 0, 0, 0, 0, 0]);
  };

  /* Returns the reply bytes (or null) for one incoming frame. */
  MockLight.prototype.handle = function (bytes) {
    this.log.push(P.toHex(bytes));
    if (bytes.length < 5 || bytes[0] !== 0xAA || bytes[1] !== 0xA5 || bytes[2] !== 0x10 || bytes[bytes.length - 1] !== 0xBB) return null;
    var cmd = bytes[3], p = bytes.slice(4, -1);
    var ack = P.fromHex(P.ACK_HEX);
    switch (cmd) {
      case P.CMD.READ_ALL: return this.statusBytes();
      case P.CMD.SYNC_TIME: this.clock = p.slice(0, 3); return ack;
      case P.CMD.AUTO_MODE: this.auto = p[0] === 1; this.preview = null; return ack;
      case P.CMD.MANUAL: this.manual = p.slice(0, 6); return ack;
      case P.CMD.PREVIEW: this.preview = p.slice(0, 6); return ack;
      case P.CMD.DEMO: this.demo = p[0] === 0; return ack;
      case P.CMD.SET_ALL:
        if (p.length !== 203 || p[6] !== 0x18) return null;
        this.manual = p.slice(0, 6);
        var slots = [];
        for (var i = 0; i < 24; i++) {
          var o = 7 + i * 8;
          slots.push({ h: p[o], m: p[o + 1], v: p.slice(o + 2, o + 8) });
        }
        this.slots = slots;
        this.auto = p[199] === 1;
        this.clock = p.slice(200, 203);
        return ack;
      default: return ack;
    }
  };

  root.NooMockLight = MockLight;
  if (typeof module !== 'undefined' && module.exports) module.exports = MockLight;
})(typeof window !== 'undefined' ? window : globalThis);
