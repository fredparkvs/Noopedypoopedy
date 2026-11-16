/*
 * Noo-Psyche K7 wire protocol.
 *
 * Decoded from the official "Noo-Psyche" Android app (com.nemo.caideng 2.0.3).
 * The light runs an ESP8266 and listens on TCP port 8266. There is no
 * encryption or authentication. See docs/PROTOCOL.md for the full write-up.
 *
 * Outgoing frame:  AA A5 10 <cmd> <payload...> BB
 * Short reply:     AB AA A5 A1            (acknowledgement)
 * Status reply:    AB AA ... (more than 214 bytes), sent after READ_ALL
 */
(function (root) {
  'use strict';

  var PORT = 8266;
  var SLOT_COUNT = 24;
  var CHANNELS = 6; // every frame carries 6 channel bytes; 3-channel lights leave 4-6 at 0

  var CMD = {
    SYNC_TIME: 0x03,   // h m s
    AUTO_MODE: 0x04,   // 01 = run schedule, 00 = manual
    MANUAL: 0x05,      // 6 channel values, applied live
    PREVIEW: 0x06,     // 6 channel values, temporary preview of a schedule point
    SET_ALL: 0x07,     // manual(6) 18 slots(24*8) auto(1) h m s
    READ_ALL: 0x08,    // no payload, light answers with the status block
    PASS_SET: 0x09,    // present in the official app but never used
    DEMO: 0x0A         // 00 = start demo, 01 = stop demo (inverted on purpose)
  };

  var ACK_HEX = 'abaaa5a1';
  var STATUS_MIN_LEN = 215;

  function clampPct(v) {
    v = Math.round(Number(v) || 0);
    return v < 0 ? 0 : v > 100 ? 100 : v;
  }

  function clampInt(v, lo, hi) {
    v = Math.round(Number(v) || 0);
    return v < lo ? lo : v > hi ? hi : v;
  }

  function channelBytes(values) {
    var out = [];
    for (var i = 0; i < CHANNELS; i++) out.push(clampPct(values && values[i]));
    return out;
  }

  function frame(cmd, payload) {
    return [0xAA, 0xA5, 0x10, cmd].concat(payload || [], [0xBB]);
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  function fromHex(hex) {
    hex = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
    var out = [];
    for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  // ---- command builders -------------------------------------------------

  function readAll() { return frame(CMD.READ_ALL); }

  function syncTime(h, m, s) {
    return frame(CMD.SYNC_TIME, [clampInt(h, 0, 23), clampInt(m, 0, 59), clampInt(s, 0, 59)]);
  }

  function syncTimeFromDate(d) {
    d = d || new Date();
    return syncTime(d.getHours(), d.getMinutes(), d.getSeconds());
  }

  function setAutoMode(auto) { return frame(CMD.AUTO_MODE, [auto ? 1 : 0]); }

  function setManual(values) { return frame(CMD.MANUAL, channelBytes(values)); }

  function preview(values) { return frame(CMD.PREVIEW, channelBytes(values)); }

  function setDemo(on) { return frame(CMD.DEMO, [on ? 0 : 1]); }

  /*
   * opts.manual   : 6 values (manual-mode brightness)
   * opts.slots    : 24 x {h, m, v:[6]}
   * opts.auto     : boolean, true = run the schedule
   * opts.time     : Date used to set the light's clock (defaults to now)
   */
  function setAll(opts) {
    var slots = opts.slots || [];
    if (slots.length !== SLOT_COUNT) throw new Error('setAll needs exactly 24 slots, got ' + slots.length);
    var payload = channelBytes(opts.manual);
    payload.push(SLOT_COUNT);
    for (var i = 0; i < SLOT_COUNT; i++) {
      var s = slots[i];
      payload.push(clampInt(s.h, 0, 23), clampInt(s.m, 0, 59));
      payload = payload.concat(channelBytes(s.v));
    }
    payload.push(opts.auto ? 1 : 0);
    var d = opts.time || new Date();
    payload.push(d.getHours(), d.getMinutes(), d.getSeconds());
    return frame(CMD.SET_ALL, payload);
  }

  // ---- reply parsing ----------------------------------------------------

  function printable(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    }
    return s.trim();
  }

  /*
   * Status block layout (offsets into the reply). Offsets 203 and 204-214 are
   * the ones the official app reads; 4-202 mirror the SET_ALL payload layout,
   * which is checked with a sanity test before being trusted.
   *   0-1    AB AA
   *   2-3    echo of the command (10 08)
   *   4-9    manual channel values
   *   10     slot count (0x18)
   *   11-202 24 slots of h, m, v1..v6
   *   203    1 = schedule (auto) mode, otherwise manual
   *   204-214 device name, ASCII, e.g. "K7_1A2B3C4D" or "K7M..." for the Mini
   */
  function parseStatus(bytes) {
    var manual = bytes.slice(4, 10);
    var slotCount = bytes[10];
    var slots = [];
    var valid = slotCount === SLOT_COUNT;
    for (var i = 0; i < SLOT_COUNT; i++) {
      var o = 11 + i * 8;
      var s = { h: bytes[o], m: bytes[o + 1], v: bytes.slice(o + 2, o + 8) };
      if (!(s.h <= 23 && s.m <= 59)) valid = false;
      for (var c = 0; c < CHANNELS; c++) if (!(s.v[c] <= 100)) valid = false;
      slots.push(s);
    }
    for (var k = 0; k < CHANNELS; k++) if (!(manual[k] <= 100)) valid = false;
    var name = printable(bytes.slice(204, 215));
    var isMini = name.toLowerCase().indexOf('k7m') === 0;
    return {
      type: 'status',
      auto: bytes[203] === 1,
      name: name,
      model: isMini ? 'mini' : 'k7',
      channelCount: isMini ? 3 : 6,
      manual: valid ? manual : null,
      slots: valid ? slots : null,
      scheduleValid: valid,
      length: bytes.length,
      hex: toHex(bytes)
    };
  }

  function parseMessage(bytes) {
    var hex = toHex(bytes);
    if (hex === ACK_HEX) return { type: 'ack', hex: hex };
    if (bytes.length >= STATUS_MIN_LEN && bytes[0] === 0xAB && bytes[1] === 0xAA) return parseStatus(bytes);
    return { type: 'unknown', hex: hex, length: bytes.length };
  }

  /*
   * TCP is a stream, so a 215+ byte status block can arrive in pieces (the
   * official app assumed one read = one reply, which is one reason it was
   * flaky). Feed every chunk in; acks are split off immediately, anything else
   * is emitted once the line has been quiet for `idleMs`.
   */
  function Framer(onMessage, idleMs) {
    this.buf = [];
    this.onMessage = onMessage;
    this.idleMs = idleMs == null ? 150 : idleMs;
    this.timer = null;
  }

  Framer.prototype.feed = function (bytes) {
    this.buf = this.buf.concat(Array.prototype.slice.call(bytes));
    this._drainAcks();
    var self = this;
    if (this.timer) clearTimeout(this.timer);
    if (this.buf.length) this.timer = setTimeout(function () { self.flush(); }, this.idleMs);
  };

  Framer.prototype._drainAcks = function () {
    while (this.buf.length >= 4 && this.buf[0] === 0xAB && this.buf[1] === 0xAA &&
           this.buf[2] === 0xA5 && this.buf[3] === 0xA1) {
      this.buf = this.buf.slice(4);
      this.onMessage({ type: 'ack', hex: ACK_HEX });
    }
  };

  Framer.prototype.flush = function () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this._drainAcks();
    if (!this.buf.length) return;
    var bytes = this.buf;
    this.buf = [];
    this.onMessage(parseMessage(bytes));
  };

  Framer.prototype.reset = function () {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buf = [];
  };

  /* The official app's export / QR format: "<manual hex>#<24 slots hex>" */
  function parseOfficialCode(text) {
    var parts = String(text || '').trim().split('#');
    if (parts.length !== 2) throw new Error('Expected two parts separated by #');
    var manual = fromHex(parts[0]);
    var raw = fromHex(parts[1]);
    if (manual.length !== 6 || raw.length !== 192) throw new Error('Code has the wrong length');
    var slots = [];
    for (var i = 0; i < SLOT_COUNT; i++) {
      var o = i * 8;
      slots.push({ h: raw[o], m: raw[o + 1], v: raw.slice(o + 2, o + 8) });
    }
    return { manual: manual, slots: slots };
  }

  function toOfficialCode(manual, slots) {
    var raw = [];
    slots.forEach(function (s) { raw.push(s.h, s.m); raw = raw.concat(channelBytes(s.v)); });
    return toHex(channelBytes(manual)) + '#' + toHex(raw);
  }

  var api = {
    PORT: PORT,
    SLOT_COUNT: SLOT_COUNT,
    CHANNELS: CHANNELS,
    CMD: CMD,
    ACK_HEX: ACK_HEX,
    toHex: toHex,
    fromHex: fromHex,
    readAll: readAll,
    syncTime: syncTime,
    syncTimeFromDate: syncTimeFromDate,
    setAutoMode: setAutoMode,
    setManual: setManual,
    preview: preview,
    setDemo: setDemo,
    setAll: setAll,
    parseMessage: parseMessage,
    parseStatus: parseStatus,
    Framer: Framer,
    parseOfficialCode: parseOfficialCode,
    toOfficialCode: toOfficialCode
  };

  root.NooProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
