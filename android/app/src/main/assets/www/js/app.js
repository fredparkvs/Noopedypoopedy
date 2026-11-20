(function () {
  'use strict';
  const P = window.NooProtocol;
  const S = window.NooSchedule;
  const { createTransport, LightLink } = window.NooTransport;
  const VERSION = '1.1.0';

  // ---- storage ------------------------------------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('noo.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('noo.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem('noo.' + k); } catch (e) { /* ignore */ } },
    keys() { try { return Object.keys(localStorage).filter((k) => k.indexOf('noo.') === 0).map((k) => k.slice(4)); } catch (e) { return []; } }
  };

  // ---- channels -------------------------------------------------------------
  // Order and colours match the official app; names from the K7 Pro LED layout.
  const CHANNELS = {
    k7: [
      { name: 'White', color: '#ecebe9', rgb: [255, 250, 240] },
      { name: 'Blue', color: '#5b93e8', rgb: [40, 80, 255] },
      { name: 'Green', color: '#3cbc84', rgb: [60, 230, 140] },
      { name: 'UV', color: '#b276e6', rgb: [120, 40, 255] },
      { name: 'Cyan', color: '#4ccaf7', rgb: [40, 200, 255] },
      { name: 'Red', color: '#f27352', rgb: [255, 110, 70] }
    ],
    mini: [
      { name: 'White', color: '#ecebe9', rgb: [255, 250, 240] },
      { name: 'Blue', color: '#5b93e8', rgb: [40, 80, 255] },
      { name: 'UV', color: '#b276e6', rgb: [120, 40, 255] }
    ]
  };

  function channels() {
    const names = store.get('names', {})[state.model] || [];
    return CHANNELS[state.model].map((c, i) => Object.assign({}, c, { name: names[i] || c.name }));
  }

  // ---- state ------------------------------------------------------------------
  const transport = createTransport();
  const MAC = transport.platform === 'mac';
  const DEVICE = MAC ? 'Mac' : 'phone'; // what this app runs on, for the texts
  const link = new LightLink(transport);
  const state = {
    view: 'schedule',
    light: null,          // { id, name, host, model }
    model: 'k7',
    points: S.factoryPoints('k7', 'LPS'),
    manual: [50, 50, 50, 50, 50, 50],
    auto: true,
    savedFp: null,        // fingerprint of what we know is on the light
    source: 'none',       // light | phone | factory | none
    lastStatus: null,
    editing: null,        // key point being edited
    editingNew: false,
    previewOn: true,
    scanning: false,
    silentHosts: [],
    net: null,
    found: [],
    retries: 0
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const fp = () => JSON.stringify({ s: S.toSlots(state.points), m: state.manual.map((x) => Math.round(x)) });
  const isDirty = () => state.savedFp !== fp();
  const connected = () => link.state === 'connected';

  // ---- lights list ---------------------------------------------------------------
  function lights() { return store.get('lights', []); }
  function saveLights(list) { store.set('lights', list); }
  function displayName(l) { return l ? (l.nickname || l.name || l.host) : 'No light yet'; }

  function upsertLight(rec) {
    const list = lights();
    let i = list.findIndex((l) => (rec.name && l.name === rec.name) || l.id === rec.id);
    if (i < 0 && !rec.name) i = list.findIndex((l) => l.host === rec.host);
    const merged = Object.assign({}, i >= 0 ? list[i] : {}, rec);
    merged.id = merged.name || merged.id || merged.host;
    if (i >= 0) list[i] = merged; else list.push(merged);
    saveLights(list);
    return merged;
  }

  function persistWorking() {
    if (!state.light) return;
    store.set('light:' + state.light.id, { points: state.points, manual: state.manual, auto: state.auto, savedFp: state.savedFp, model: state.model });
  }

  function loadWorking(light) {
    const w = store.get('light:' + light.id, null);
    state.model = light.model || 'k7';
    if (w) {
      state.points = w.points; state.manual = w.manual; state.auto = w.auto !== false;
      state.savedFp = w.savedFp; state.model = w.model || state.model; state.source = 'phone';
    } else {
      state.points = S.factoryPoints(state.model, 'LPS');
      state.manual = [50, 50, 50, state.model === 'mini' ? 0 : 50, state.model === 'mini' ? 0 : 50, state.model === 'mini' ? 0 : 50];
      state.savedFp = null; state.source = 'factory';
    }
  }

  // ---- connection ------------------------------------------------------------------
  link.on('state', (s) => {
    renderHeader();
    if (s === 'offline' && state.light && !link.quiet && document.visibilityState === 'visible' && state.retries < 3) {
      state.retries++;
      setTimeout(() => { if (link.state === 'offline') connectTo(state.light, { rescan: false, silent: true }); }, 2500 * state.retries);
    }
  });
  link.on('log', () => { if (state.view === 'more') renderLog(); });

  // probes reuse the one socket; keep the header steady while they run
  const origSetState = link._setState.bind(link);
  link._setState = (s) => { if (!link.quiet) origSetState(s); else link.state = s; };

  async function connectTo(light, opts) {
    opts = opts || {};
    await stopScan();
    if (state.light && state.light.id !== light.id) loadWorking(light);
    state.light = light;
    store.set('current', light.id);
    renderAll();
    try {
      await link.connect(light.host);
      state.retries = 0;
      await afterConnect(opts.force);
    } catch (e) {
      if (opts.rescan !== false) {
        if (!opts.silent) toast('Could not reach ' + displayName(light) + ' at ' + light.host + '. Searching the network.');
        await discover();
        const moved = state.found.find((f) => f.name && f.name === light.name && f.host !== light.host);
        if (moved) {
          const rec = upsertLight({ id: light.id, name: light.name, host: moved.host, model: light.model });
          return connectTo(rec, { rescan: false });
        }
        renderHeader();
      } else if (!opts.silent) {
        toast('Could not connect: ' + e.message);
      }
    }
  }

  async function afterConnect(force) {
    let st = null;
    state.reading = true;
    renderHeader();
    refreshNet();
    try { st = await link.readStatus(); } catch (e) { /* shown as a banner */ }
    state.reading = false;
    state.readFailed = !st;
    if (st) applyStatus(st, force); else renderAll();
    await link.sendAck(P.syncTimeFromDate(new Date()));
    const n = natural();
    if (st && n && n.enabled && n.lastApplied !== NN.ymd(today())) await applyNatural({ silent: true });
  }

  function applyStatus(st, force) {
    state.lastStatus = st;
    const oldId = state.light && state.light.id;
    const rec = upsertLight({ id: st.name || state.light.host, name: st.name || null, host: state.light.host, model: st.model });
    if (oldId && oldId !== rec.id) {
      // first contact: the record was keyed by IP until the light told us its name
      const w = store.get('light:' + oldId, null);
      if (w && !store.get('light:' + rec.id, null)) store.set('light:' + rec.id, w);
      store.del('light:' + oldId);
      saveLights(lights().filter((l) => l.id !== oldId || l.id === rec.id));
    }
    state.light = rec;
    store.set('current', rec.id);
    state.model = st.model;
    state.auto = st.auto;
    const keepEdits = !force && state.savedFp != null && isDirty();
    if (st.scheduleValid && !keepEdits) {
      state.points = S.fromSlots(st.slots);
      state.manual = st.manual.slice();
      state.savedFp = fp();
      state.source = 'light';
    } else if (st.scheduleValid && keepEdits) {
      state.savedFp = JSON.stringify({ s: st.slots, m: st.manual });
      state.source = 'light';
    } else {
      state.source = state.source === 'factory' ? 'factory' : 'phone';
    }
    persistWorking();
    renderAll();
  }

  async function ensureConnected() {
    if (connected()) return true;
    if (!state.light) { openLightsSheet(); return false; }
    await connectTo(state.light, { rescan: true });
    return connected();
  }

  /* Probing borrows the single socket, so a user's choice must stop the scan first. */
  async function stopScan() {
    if (!state.scanning) return;
    state.scanAbort = true;
    try { await state.scanPromise; } catch (e) { /* ignore */ }
  }

  function discover() {
    if (state.scanning) return state.scanPromise;
    state.scanAbort = false;
    state.scanPromise = runDiscover();
    return state.scanPromise;
  }

  async function refreshNet() {
    try { state.net = await transport.netInfo(); } catch (e) { state.net = null; }
    return state.net;
  }

  /* Drop saved addresses that never answered as a light. */
  function forgetUnconfirmed() {
    lights().filter((l) => !l.name).forEach((l) => store.del('light:' + l.id));
    saveLights(lights().filter((l) => l.name));
    if (state.light && !state.light.name) { state.light = null; store.del('current'); }
  }

  function vpnNote() {
    if (!state.net || !state.net.vpn) return '';
    return '<div class="banner" style="display:block;border-color:#7a3b3b"><p style="margin:0 0 6px;color:var(--ink)"><strong>A VPN is switched on.</strong></p>' +
      '<p style="margin:0">It sends this app\'s traffic through the VPN instead of to the light. Turn the VPN off while you adjust the light, ' +
      'or in the VPN app exclude Reef Light (often called split tunnelling) or allow LAN connections.</p></div>';
  }

  /* Is this address the light whose own hotspot the phone is on? */
  function viaHotspot(host) {
    const n = state.net;
    return !!(n && host && (host === n.dhcpServer || host === n.gateway));
  }

  async function runDiscover() {
    state.scanning = true;
    state.found = [];
    state.silentHosts = [];
    refreshLightsSheet();
    const wasHost = connected() ? link.host : null;
    const asked = new Set();

    const ask = async (host, direct) => {
      asked.add(host);
      if (host === wasHost && state.light) {
        state.found.push({ host, name: state.light.name, model: state.light.model, hotspot: direct });
        return;
      }
      link.quiet = true;
      try {
        const st = await link.probe(host, direct ? 1500 : undefined);
        state.found.push({ host, name: st.name, model: st.model, hotspot: direct });
        const known = lights().find((l) => l.name && l.name === st.name);
        if (known && known.host !== host) upsertLight({ id: known.id, name: known.name, host, model: st.model });
      } catch (e) {
        // something accepted the connection but did not answer like a light
        // (a router, a VPN, another gadget): never offer it as a light
        if (e.stage !== 'connect') state.silentHosts.push(host);
      } finally {
        link.quiet = false;
      }
      refreshLightsSheet();
    };

    try {
      // On the light's own hotspot the light hands out the addresses, so ask
      // that address first, exactly like the official app's "AP connection".
      const net = await refreshNet();
      if (state.view === 'schedule' && !state.editing) renderView(); // shows the VPN warning if there is one
      const direct = [net && net.dhcpServer, net && net.gateway].filter((h, i, a) => h && a.indexOf(h) === i);
      for (const host of direct) {
        if (state.scanAbort) break;
        await ask(host, true);
      }
      // Not on a light's hotspot: search the whole network (the light is on your home WiFi).
      if (!state.found.some((f) => f.hotspot && f.name) && !state.scanAbort) {
        const hosts = (await transport.scan(P.PORT)).filter((h) => !asked.has(h));
        link.touched(hosts.filter((h) => h !== wasHost)); // the scan itself just connected to each of them
        for (const host of hosts) {
          if (state.scanAbort) break;
          await ask(host, false);
        }
      }
    } catch (e) {
      toast('Search failed: ' + e.message);
    } finally {
      state.scanning = false;
      link.quiet = false;
      if (wasHost && state.light && !state.scanAbort) {
        try { await link.connect(state.light.host); } catch (e) { /* reconnect is best effort */ }
      } else {
        renderHeader();
      }
      refreshLightsSheet();
    }

    // First run (or the saved "light" never answered): if the answer is
    // unambiguous, connect without making you tap.
    if ((!state.light || !state.light.name) && !state.scanAbort) {
      const named = state.found.filter((f) => f.name);
      const pick = state.found.find((f) => f.hotspot && f.name) || (named.length === 1 ? named[0] : null);
      if (pick) {
        closeSheet();
        forgetUnconfirmed();
        const rec = upsertLight({ id: pick.name, name: pick.name, host: pick.host, model: pick.model || 'k7' });
        loadWorking(rec);
        toast('Found ' + pick.name + (pick.hotspot ? ' (you are on its hotspot)' : '') + '. Connecting.');
        setTimeout(() => connectTo(rec, { force: true, rescan: false }), 0);
      }
    }
  }

  /*
   * Flash the light twice so you can see which light the app is talking to:
   * dark if it is on, a gentle blue if it is off (at night "dark" would show
   * nothing). Then put it back exactly as it was.
   */
  async function blink() {
    if (!(await ensureConnected())) return;
    toast('Watch the light: it should flash twice.');
    const wasAuto = state.auto;
    const now = (wasAuto ? S.valueAt(state.points, nowMinutes()) : state.manual).map((x) => Math.round(x));
    const isOn = Math.max.apply(null, now) >= 10;
    const flash = isOn ? [0, 0, 0, 0, 0, 0] : (state.model === 'mini' ? [0, 30, 20, 0, 0, 0] : [0, 30, 0, 20, 30, 0]);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (wasAuto) await link.send(P.setAutoMode(false));
      for (let i = 0; i < 2; i++) {
        await link.send(P.setManual(flash));
        await pause(900);
        await link.send(P.setManual(now));
        await pause(700);
      }
    } finally {
      // put everything back exactly as it was
      if (wasAuto) await link.send(P.setAutoMode(true)).catch(() => {});
      else await link.send(P.setManual(state.manual)).catch(() => {});
    }
  }

  // ---- sending -------------------------------------------------------------------------
  let manualTimer = null;
  let warnedOffline = false;
  function sendManualLive() {
    if (!connected()) {
      if (!warnedOffline) { toast('Not connected. Your changes are kept until you save.'); warnedOffline = true; }
      return;
    }
    if (manualTimer) return;
    manualTimer = setTimeout(async () => {
      manualTimer = null;
      try {
        if (state.auto) { state.auto = false; persistWorking(); renderHeader(); updateManualBanner(); await link.send(P.setAutoMode(false)); }
        await link.send(P.setManual(state.manual));
      } catch (e) { /* connection errors are shown by the status pill */ }
    }, 120);
  }

  let previewTimer = null;
  let previewed = false;
  function sendPreview(values) {
    if (!connected() || !state.previewOn) return;
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      previewed = true;
      link.send(P.preview(values)).catch(() => {});
    }, 120);
  }

  async function endPreview() {
    if (!previewed || !connected()) return;
    previewed = false;
    await link.send(P.setAutoMode(state.auto)).catch(() => {});
    if (!state.auto) await link.send(P.setManual(state.manual)).catch(() => {});
  }

  async function setMode(auto) {
    state.auto = auto;
    persistWorking();
    renderAll();
    if (await ensureConnected()) {
      await link.sendAck(P.setAutoMode(auto));
      if (!auto) await link.send(P.setManual(state.manual)).catch(() => {});
      toast(auto ? 'The light is running the schedule.' : 'The light is in manual mode.');
    }
  }

  async function saveToLight() {
    const bad = S.conflicts(state.points);
    if (bad.length) { toast('Two points share the ' + S.fmtTime(bad[0] * 60) + ' hour. Fix that first.'); return; }
    if (!state.points.length) { toast('Add at least one point first.'); return; }
    if (!(await ensureConnected())) return;
    const btn = $('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving';
    try {
      const verified = await writeSlots(S.toSlots(state.points), state.auto);
      if (naturalOn()) pushPlan();
      toast(verified ? 'Saved. The light confirmed the new settings.' : 'Sent to the light.');
    } catch (e) {
      toast('Save failed: ' + e.message);
    } finally {
      btn.disabled = false;
      renderSaveBar();
    }
  }

  /* Send a full day (and the manual mix) to the light, then read it back. Returns true if confirmed. */
  async function writeSlots(slots, auto) {
    await link.sendAck(P.setAll({ manual: state.manual, slots, auto, time: new Date() }), 4000);
    let verified = false;
    try {
      const st = await link.readStatus();
      state.lastStatus = st;
      verified = st.scheduleValid && S.slotsEqual(st.slots, slots);
    } catch (e) { /* unverified */ }
    state.savedFp = fp();
    state.source = 'light';
    persistWorking();
    return verified;
  }

  // ---- natural cycle ---------------------------------------------------------------------------
  const NN = window.NooNatural;
  const PLAN_DAYS = 60;

  function natural() { return state.light ? store.get('natural:' + state.light.id, null) : null; }
  function saveNatural(n) { if (state.light) store.set('natural:' + state.light.id, n); }
  function naturalOn() { const n = natural(); return !!(n && n.enabled); }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  /* Peak mix to start from: the brightest value of each channel in the current schedule. */
  function currentMix() {
    const n = channels().length;
    const mix = [0, 1, 2, 3, 4, 5].map((c) => (c < n ? Math.round(Math.max.apply(null, state.points.map((p) => p.v[c]))) : 0));
    return mix.some((x) => x > 0) ? mix : [40, 90, 20, 60, 80, 10].map((v, c) => (c < n ? v : 0));
  }

  /* Work out today's light, show it, and send it to the light when connected. */
  async function applyNatural(opts) {
    opts = opts || {};
    const n = natural();
    if (!n || !n.enabled) return false;
    const day = NN.computeDay(n.settings, today());
    state.points = S.fromSlots(day.slots);
    state.auto = true;
    persistWorking();
    renderAll();
    pushPlan();
    if (!connected()) {
      if (!opts.silent) toast('Today\'s light is ready. It will be sent when the light is connected.');
      return false;
    }
    try {
      const verified = await writeSlots(day.slots, true);
      n.lastApplied = NN.ymd(today());
      saveNatural(n);
      if (transport.markApplied) transport.markApplied(n.lastApplied).catch(() => {});
      if (!opts.quiet) toast(verified ? 'Today\'s natural light is on the light (confirmed).' : 'Today\'s natural light was sent to the light.');
      renderAll();
      return true;
    } catch (e) {
      toast('Could not send today\'s light: ' + e.message);
      return false;
    }
  }

  /*
   * The next 60 days, ready to send, for the Android background job: it runs
   * every hour and sends the day's light once, whenever the light is reachable.
   */
  let planTimer = null;
  let planGen = 0; // a newer request (or turning off) makes an unfinished calculation stale
  function pushPlan() {
    if (!transport.setDailyPlan || !state.light) return;
    clearTimeout(planTimer);
    const gen = ++planGen;
    planTimer = setTimeout(async () => {
      const n = natural();
      if (!n || !n.enabled) { transport.clearDailyPlan().catch(() => {}); return; }
      const frames = {};
      const start = today();
      for (let i = 0; i < PLAN_DAYS; i++) {
        const date = NN.addDays(start, i);
        const slots = NN.computeDay(n.settings, date).slots;
        frames[NN.ymd(date)] = P.toHex(P.setAll({ manual: state.manual, slots, auto: true, time: new Date(2000, 0, 1, 0, 0, 0) }));
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)); // keep the screen responsive
        if (gen !== planGen) return;
      }
      if (gen !== planGen || !naturalOn()) return;
      const plan = { light: state.light.name || state.light.host, host: state.light.host, applied: n.lastApplied || null, frames };
      transport.setDailyPlan(JSON.stringify(plan)).catch(() => {});
    }, 300);
  }

  function hm(min) {
    if (min == null) return '-';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }

  function nightSummary(nt, settings) {
    if (settings && !settings.moon.some((m) => Math.round(m * nt.fraction) > 0)) return 'Moon too thin to show, dark all night';
    if (nt.upAtSunset) return 'Moon already up at sunset (' + Math.round(nt.fraction * 100) + '%)';
    if (nt.darkGap != null) return 'Dark for ' + hm(nt.darkGap) + ' after sunset, then the moon rises';
    return 'No moonrise tonight';
  }

  function naturalCard() {
    const n = natural();
    const s = n.settings;
    const reef = NN.reefById(s.reefId);
    const nt = NN.night(s, today());
    const sentToday = n.lastApplied === NN.ymd(today());
    const after = nt.nightsAfterFull;
    const moonOn = s.moon.some((x) => x > 0);
    let html = '<div class="card"><div class="row spread"><h2 style="margin:0">Natural cycle</h2>' +
      '<span class="hint">' + esc(reef ? reef.name : 'Custom location') + '</span></div>' +
      (s.seasonShiftMonths ? '<p class="hint" style="margin:4px 0 0">Reef year shifted by ' + (s.seasonShiftMonths > 0 ? '+' : '') + s.seasonShiftMonths + ' months.</p>' : '') +
      '<ul class="list" style="margin-top:6px">' +
      '<li><span class="sub-t">Sunrise, sunset</span><span class="num">' + NN.fmt(nt.sunrise) + ', ' + NN.fmt(nt.sunset) + '</span></li>' +
      '<li><span class="sub-t">Midday brightness</span><span class="num">' + Math.round(nt.season * 100) + '% of your mix</span></li>' +
      '<li><span class="sub-t">Moon</span><span>' + esc(nt.phase) + ', ' + Math.round(nt.fraction * 100) + '%</span></li>' +
      '<li><span class="sub-t">Tonight</span><span style="text-align:right">' + (moonOn ? esc(nightSummary(nt, s)) : 'Moonlight is off') + '</span></li>' +
      (after != null && after <= 10 ? '<li><span class="sub-t">Lunar night</span><span>Night ' + after + ' after the full moon</span></li>' : '') +
      '</ul>' +
      '<p style="margin:8px 0;color:' + (sentToday ? 'var(--ok)' : 'var(--warn)') + '">' +
      (sentToday ? 'Today\'s light is on the light.' : 'Today\'s light has not been sent yet.') + '</p>' +
      '<p class="hint" id="autoStatus" style="margin:0 0 10px"></p>' +
      '<div class="btn-row">' + (sentToday ? '' : '<button class="btn primary small" data-action="natural-send">Send today\'s light</button>') +
      '<button class="btn small" data-action="natural-calendar">Calendar</button><button class="btn small" data-action="natural-setup">Settings</button>' +
      '<button class="btn small quiet" data-action="natural-off">Turn off</button></div></div>';
    return html;
  }

  async function refreshAutoStatus() {
    const el = $('autoStatus');
    if (!el) return;
    if (!transport.dailyStatus) { el.textContent = ''; return; }
    let st = null;
    try { st = await transport.dailyStatus(); } catch (e) { st = null; }
    const hotspot = state.light && viaHotspot(state.light.host);
    let text = transport.kind === 'demo' ? 'Automatic daily updates run in the Android app.'
      : MAC ? 'Automatic daily updates: this Mac sends each day\'s light once, whenever it can reach the light. Reef Light keeps running in the menu bar when you close the window; turn on Open at login there to keep it going after a restart.'
        : 'Automatic daily updates: the phone sends each day\'s light once, whenever it can reach the light.';
    if (st && st.lastResult) text += ' Last: ' + st.lastResult;
    if (hotspot) text += ' Your light is on its own hotspot, so it is only reachable while your ' + DEVICE + ' is joined to it. For hands-off daily updates, put the light on your home WiFi.';
    el.textContent = text;
  }

  function naturalInvite() {
    return '<div class="card"><h2>Natural cycle</h2><p class="sub">Follow a real reef\'s sunrise, sunset, seasons and moon, worked out fresh every day. ' +
      'Modelled on the ex situ coral spawning work of Craggs and colleagues (Horniman Museum, 2017), including the dark gap after sunset on the nights after a full moon.</p>' +
      '<div class="btn-row"><button class="btn" data-action="natural-setup">Set up natural cycle</button></div></div>';
  }

  function openNaturalSetup() {
    const existing = natural();
    const s = existing ? JSON.parse(JSON.stringify(existing.settings)) : NN.defaults(currentMix(), state.model);
    const n = channels().length;
    const reefOpts = NN.REEFS.map((r) => '<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--sea-700)">' +
      '<input type="radio" name="nsReef" value="' + r.id + '"' + (s.reefId === r.id ? ' checked' : '') + ' style="margin-top:4px">' +
      '<span><span class="main-t">' + esc(r.name) + '</span><br><span class="hint">' + esc(r.spawning) + ' (' + esc(r.source) + ')</span></span></label>').join('') +
      '<label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--sea-700)"><input type="radio" name="nsReef" value="custom"' + (s.reefId === 'custom' ? ' checked' : '') + '>' +
      '<span class="main-t">Another place</span></label>' +
      '<div class="row" id="nsCustom" style="gap:8px;margin-bottom:8px"' + (s.reefId === 'custom' ? '' : ' hidden') + '>' +
      '<label class="field" style="flex:1;margin:0"><span>Latitude</span><input class="input num" id="nsLat" inputmode="decimal" value="' + s.lat + '"></label>' +
      '<label class="field" style="flex:1;margin:0"><span>Longitude</span><input class="input num" id="nsLon" inputmode="decimal" value="' + s.lon + '"></label></div>';
    const months = [];
    for (let m = -6; m <= 6; m++) months.push('<option value="' + m + '"' + (s.seasonShiftMonths === m ? ' selected' : '') + '>' + (m === 0 ? 'No shift' : (m > 0 ? '+' : '') + m + ' months') + '</option>');
    const ramps = [60, 120, 180, 240].map((r) => '<option value="' + r + '"' + (s.rampMin === r ? ' selected' : '') + '>' + r / 60 + (r === 60 ? ' hour' : ' hours') + (r === 180 ? ' (study)' : '') + '</option>').join('');
    const mins = [60, 70, 80, 90, 100].map((v) => '<option value="' + v + '"' + (s.seasonMinPct === v ? ' selected' : '') + '>' + (v === 100 ? 'No change' : v + '%' + (v === 60 ? ' (study)' : '')) + '</option>').join('');
    openSheet(existing && existing.enabled ? 'Natural cycle settings' : 'Set up natural cycle',
      '<h2 style="font-size:var(--fs-md);margin:0 0 4px">Reef</h2>' + reefOpts +
      '<div class="row" style="gap:12px;margin-top:8px">' +
      '<label class="field" style="flex:1"><span>Midday on your tank</span><input class="input" type="time" id="nsMidday" value="' + S.fmtTime(s.middayAt) + '"></label>' +
      '<label class="field" style="flex:1"><span>Shift the reef\'s year</span><select class="input" id="nsShift">' + months.join('') + '</select></label></div>' +
      '<div class="row" style="gap:12px">' +
      '<label class="field" style="flex:1"><span>Sunrise and sunset ramps</span><select class="input" id="nsRamp">' + ramps + '</select></label>' +
      '<label class="field" style="flex:1"><span>Dimmest season</span><select class="input" id="nsMin">' + mins + '</select></label></div>' +
      '<h2 style="font-size:var(--fs-md);margin:6px 0 2px">Your mix at the brightest time of year</h2>' + sliderRows('nsMix', s.mix) +
      '<h2 style="font-size:var(--fs-md);margin:14px 0 2px">Full moon</h2>' +
      '<p class="hint" style="margin:0 0 4px">The moon dims with its phase and is off when too thin. The light\'s dimmest step, 1%, is far brighter than real moonlight (about 1 lux), so keep it low; the timing is what matters for spawning.</p>' +
      sliderRows('nsMoon', s.moon) +
      '<p class="hint" id="nsPreview" style="margin:10px 0"></p><p class="err" id="nsErr"></p>' +
      '<div class="btn-row"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="nsGo">' + (existing && existing.enabled ? 'Save settings' : 'Start natural cycle') + '</button></div>',
      (body) => {
        const read = () => {
          const reefId = body.querySelector('input[name="nsReef"]:checked').value;
          $('nsCustom').hidden = reefId !== 'custom';
          const reef = NN.reefById(reefId);
          s.reefId = reefId;
          s.lat = reef ? reef.lat : parseFloat($('nsLat').value);
          s.lon = reef ? reef.lon : parseFloat($('nsLon').value);
          s.middayAt = S.parseTime($('nsMidday').value) == null ? s.middayAt : S.parseTime($('nsMidday').value);
          s.seasonShiftMonths = +$('nsShift').value;
          s.rampMin = +$('nsRamp').value;
          s.seasonMinPct = +$('nsMin').value;
          if (!(s.lat >= -60 && s.lat <= 60) || !(s.lon >= -180 && s.lon <= 180)) throw new Error('Enter a latitude between -60 and 60 and a longitude between -180 and 180.');
        };
        let previewTimer = null;
        const preview = () => {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(() => {
            try {
              read();
              $('nsErr').textContent = '';
              const nt = NN.night(s, today());
              $('nsPreview').textContent = 'Today on your tank: sunrise ' + NN.fmt(nt.sunrise) + ', sunset ' + NN.fmt(nt.sunset) +
                ', midday at ' + Math.round(nt.season * 100) + '% of your mix. ' + nt.phase + ' (' + Math.round(nt.fraction * 100) + '%). ' + nightSummary(nt, s) + '.';
            } catch (e) { $('nsErr').textContent = e.message; }
          }, 150);
        };
        body.querySelectorAll('input[name="nsReef"]').forEach((r) => r.addEventListener('change', preview));
        ['nsLat', 'nsLon', 'nsMidday', 'nsShift', 'nsRamp', 'nsMin'].forEach((id) => $(id).addEventListener('change', preview));
        bindSliders(body, 'nsMix', s.mix, () => {});
        bindSliders(body, 'nsMoon', s.moon, () => {});
        for (let c = n; c < 6; c++) { s.mix[c] = 0; s.moon[c] = 0; }
        $('nsGo').addEventListener('click', async () => {
          try { read(); } catch (e) { $('nsErr').textContent = e.message; return; }
          const next = Object.assign({}, existing || {}, { enabled: true, settings: s, lastApplied: null });
          saveNatural(next);
          closeSheet();
          await applyNatural();
        });
        preview();
      });
  }

  function openNaturalCalendar() {
    const n = natural();
    const s = n.settings;
    const reef = NN.reefById(s.reefId);
    const rows = [];
    const start = today();
    for (let i = 0; i < 35; i++) {
      const date = NN.addDays(start, i);
      const nt = NN.night(s, date);
      const key = nt.fraction > 0.97 || (nt.nightsAfterFull != null && nt.nightsAfterFull <= 7);
      rows.push('<tr' + (key ? ' style="background:var(--sea-700)"' : '') + '>' +
        '<td>' + date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + '</td>' +
        '<td class="num">' + NN.fmt(nt.sunset) + '</td>' +
        '<td class="num">' + Math.round(nt.fraction * 100) + '%</td>' +
        '<td class="num">' + (nt.upAtSunset ? 'up' : nt.darkGap == null ? '-' : hm(nt.darkGap)) + '</td>' +
        '<td class="num">' + (nt.nightsAfterFull != null && nt.nightsAfterFull <= 10 ? nt.nightsAfterFull : '') + '</td></tr>');
    }
    openSheet('The next five weeks',
      (reef ? '<p class="hint" style="margin-top:0"><strong>' + esc(reef.name) + ':</strong> ' + esc(reef.spawning) + ' (' + esc(reef.source) + ')</p>' : '') +
      '<p class="hint">Highlighted: the full moon and the 7 nights after it. "Dark" is how long the tank stays dark between sunset and moonrise; "up" means the moon is already up at sunset. Spawning in the wild follows the first nights with a dark gap. In aquaria it has come later: 6 to 16 nights after the full moon in the Horniman study.</p>' +
      '<div style="overflow-x:auto"><table class="cal"><thead><tr><th>Night</th><th>Sunset</th><th>Moon</th><th>Dark</th><th>After full</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
  }

  // ---- rendering: shell -------------------------------------------------------------------
  function renderAll() { renderHeader(); renderView(); renderSaveBar(); renderGlass(); }

  function renderHeader() {
    $('lightName').textContent = displayName(state.light);
    let s = state.light ? link.state : 'idle';
    if (s === 'connected' && state.reading) s = 'connecting';
    const silent = s === 'connected' && state.readFailed;
    const el = $('status');
    el.dataset.state = silent ? 'offline' : s;
    $('statusText').textContent = !state.light ? 'Find light'
      : silent ? 'Not answering'
      : s === 'connected' ? (state.auto ? 'Running schedule' : 'Manual')
      : s === 'connecting' ? 'Connecting'
      : s === 'offline' ? 'Offline, tap to retry' : 'Not connected';
  }

  function renderSaveBar() {
    const dirty = isDirty();
    const note = $('saveNote');
    note.classList.toggle('dirty', dirty);
    note.textContent = state.savedFp == null ? 'Not saved to this light yet'
      : dirty ? 'Unsaved changes' : 'Everything is saved on the light';
    $('saveBtn').textContent = 'Save to light';
  }

  function currentOutput() {
    return state.auto ? S.valueAt(state.points, nowMinutes()) : state.manual.slice();
  }

  function renderGlass() {
    const ch = channels();
    const v = currentOutput();
    let r = 0, g = 0, b = 0, total = 0, max = 0;
    ch.forEach((c, i) => { const w = v[i] / 100; r += c.rgb[0] * w; g += c.rgb[1] * w; b += c.rgb[2] * w; total += w; max = Math.max(max, w); });
    if (total <= 0) { $('glass').style.backgroundColor = '#24475a'; return; }
    const k = Math.max(r, g, b) || 1;
    const lvl = 0.35 + 0.65 * max;
    $('glass').style.backgroundColor = 'rgb(' + [r, g, b].map((x) => Math.round((x / k) * 255 * lvl)).join(',') + ')';
  }

  function switchView(v) {
    state.view = v;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    ['schedule', 'manual', 'more'].forEach((n) => { $('view-' + n).hidden = n !== v; });
    renderView();
    window.scrollTo(0, 0);
  }

  function renderView() {
    if (state.view === 'schedule') renderSchedule();
    if (state.view === 'manual') renderManual();
    if (state.view === 'more') renderMore();
  }

  // ---- sliders ------------------------------------------------------------------------------
  function sliderRows(group, values) {
    return channels().map((c, i) => {
      const v = Math.round(values[i] || 0);
      return '<div class="ch" style="--c:' + c.color + '">' +
        '<span class="name">' + esc(c.name) + '</span>' +
        '<input type="range" min="0" max="100" step="1" value="' + v + '" data-group="' + group + '" data-ch="' + i + '" aria-label="' + esc(c.name) + ' brightness" style="--p:' + v + '%">' +
        '<button class="step" data-group="' + group + '" data-ch="' + i + '" data-step="-1" aria-label="' + esc(c.name) + ' down one">&minus;</button>' +
        '<span class="pct num" data-pct="' + group + '-' + i + '">' + v + '%</span>' +
        '<button class="step" data-group="' + group + '" data-ch="' + i + '" data-step="1" aria-label="' + esc(c.name) + ' up one">+</button>' +
        '</div>';
    }).join('');
  }

  /* Wire the sliders of one group to an array; onChange runs on every move. */
  function bindSliders(root, group, arr, onChange) {
    const set = (i, v) => {
      v = Math.max(0, Math.min(100, Math.round(v)));
      arr[i] = v;
      const r = root.querySelector('input[data-group="' + group + '"][data-ch="' + i + '"]');
      if (r) { r.value = v; r.style.setProperty('--p', v + '%'); }
      const p = root.querySelector('[data-pct="' + group + '-' + i + '"]');
      if (p) p.textContent = v + '%';
      onChange(i, v);
    };
    root.querySelectorAll('input[data-group="' + group + '"]').forEach((r) => {
      r.addEventListener('input', () => set(+r.dataset.ch, +r.value));
    });
    root.querySelectorAll('button[data-group="' + group + '"]').forEach((b) => {
      b.addEventListener('click', () => set(+b.dataset.ch, arr[+b.dataset.ch] + (+b.dataset.step)));
    });
    return set;
  }

  // ---- chart ------------------------------------------------------------------------------------
  const W = 360, H = 176, PL = 30, PR = 8, PT = 10, PB = 22;
  const cx = (t) => PL + (t / 1440) * (W - PL - PR);
  const cy = (v) => PT + (1 - v / 100) * (H - PT - PB);

  function chartSvg(points, selected) {
    const ch = channels();
    let s = '<svg class="chart" id="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Brightness of each channel over the day">';
    for (let h = 0; h <= 24; h += 3) s += '<line class="grid" x1="' + cx(h * 60) + '" y1="' + PT + '" x2="' + cx(h * 60) + '" y2="' + (H - PB) + '"/>';
    [0, 50, 100].forEach((v) => {
      s += '<line class="grid" x1="' + PL + '" y1="' + cy(v) + '" x2="' + (W - PR) + '" y2="' + cy(v) + '"/>';
      s += '<text class="axis" x="' + (PL - 6) + '" y="' + (cy(v) + 3) + '" text-anchor="end">' + v + '</text>';
    });
    for (let h = 0; h <= 24; h += 6) s += '<text class="axis" x="' + cx(h * 60) + '" y="' + (H - 6) + '" text-anchor="' + (h === 0 ? 'start' : h === 24 ? 'end' : 'middle') + '">' + (h < 10 ? '0' : '') + h + ':00</text>';
    const pts = S.sortPoints(points);
    ch.forEach((c, i) => {
      const line = [[0, S.valueAt(pts, 0)[i]]].concat(pts.map((p) => [p.t, p.v[i]]), [[1440, S.valueAt(pts, 0)[i]]]);
      s += '<polyline fill="none" stroke="' + c.color + '" stroke-width="2" stroke-linejoin="round" points="' + line.map((q) => cx(q[0]).toFixed(1) + ',' + cy(q[1]).toFixed(1)).join(' ') + '"/>';
    });
    const n = nowMinutes();
    s += '<line class="now" x1="' + cx(n) + '" y1="' + PT + '" x2="' + cx(n) + '" y2="' + (H - PB) + '"/>';
    pts.forEach((p) => {
      const top = Math.max.apply(null, p.v.slice(0, ch.length));
      const sel = selected && selected.t === p.t;
      s += '<circle class="handle' + (sel ? ' sel' : '') + '" cx="' + cx(p.t) + '" cy="' + cy(top) + '" r="5"/>';
    });
    return s + '</svg>';
  }

  function nowBars(values) {
    const ch = channels();
    return '<div class="now-out" style="--n:' + ch.length + '">' + ch.map((c, i) => {
      const v = Math.round(values[i]);
      return '<div class="col"><div class="bar"><i style="height:' + v + '%;background:' + c.color + '"></i></div>' +
        '<span class="val num">' + v + '%</span><span class="lbl">' + esc(c.name) + '</span></div>';
    }).join('') + '</div>';
  }

  function refreshChart() {
    const box = $('chartBox');
    if (box) box.innerHTML = chartSvg(state.points, state.editing);
    const nb = $('nowBox');
    if (nb) nb.innerHTML = nowBars(currentOutput());
    bindChart();
  }

  function bindChart() {
    const svg = $('chart');
    if (!svg || svg.dataset.bound) return;
    svg.dataset.bound = '1';
    svg.addEventListener('click', (e) => {
      if (naturalOn()) { toast('The natural cycle sets the schedule each day. Turn it off to edit points by hand.'); return; }
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const t = Math.max(0, Math.min(1439, ((x - PL) / (W - PL - PR)) * 1440));
      const near = state.points.slice().sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
      if (near && Math.abs(near.t - t) <= 40) return openPointEditor(near, false);
      const h = Math.round(t / 60) % 24;
      if (state.points.some((p) => S.hourOf(p.t) === h)) return openPointEditor(state.points.find((p) => S.hourOf(p.t) === h), false);
      addPoint(h * 60);
    });
  }

  // ---- schedule view ------------------------------------------------------------------------------
  function silentBanner() {
    if (!state.readFailed || !connected()) return '';
    if (state.net && state.net.vpn) return vpnNote();
    return '<div class="banner" style="display:block;border-color:#7a3b3b">' +
      '<p style="margin:0 0 8px;color:var(--ink)"><strong>The light accepted the connection but did not answer.</strong></p>' +
      '<p style="margin:0 0 8px">This usually means another app or phone is still connected to it, since the light only talks to one at a time. ' +
      'Force-stop the official app (Settings, Apps, Noo-Psyche, Force stop) and close it on any other phone. If that does not help, switch the light off for 10 seconds.</p>' +
      '<p style="margin:0 0 8px"><strong>Blink the light</strong> checks whether your commands reach it even though it is not replying.</p>' +
      '<div class="btn-row"><button class="btn small" data-action="reload">Try again</button><button class="btn small" data-action="blink">Blink the light</button><button class="btn small" data-action="copy-diag">Copy details</button></div></div>';
  }

  function sourceNote() {
    if (!state.light || (state.readFailed && connected())) return '';
    if (state.source === 'light') return '';
    if (state.source === 'phone') return '<div class="banner"><span>Showing the copy saved on this ' + DEVICE + '. It will be replaced by what is on the light once it connects, unless you have unsaved changes.</span></div>';
    if (state.source === 'factory') return '<div class="banner"><span>Showing the factory LPS schedule until the light sends its own.</span></div>';
    return '';
  }

  function renderSchedule() {
    const v = $('view-schedule');
    if (!state.light) {
      v.innerHTML = vpnNote() + '<div class="card"><h2>Find your light</h2><p class="sub">Connect your ' + DEVICE + ' to the light\'s own WiFi hotspot (named K7_ and some letters) in your ' + DEVICE + '\'s WiFi settings, as you do for the official app. If the light is on your home WiFi instead, stay on that.</p>' +
        '<div class="btn-row"><button class="btn primary" data-action="lights">Find my light</button></div></div>' +
        '<div class="card"><h2>Preview</h2>' + '<div id="chartBox">' + chartSvg(state.points) + '</div></div>';
      return;
    }
    const sorted = state.points.slice().sort((a, b) => a.t - b.t);
    const ch = channels();
    const conflictHours = S.conflicts(state.points);
    let html = silentBanner() || (!connected() ? vpnNote() : '');
    if (!state.auto && !state.readFailed) html += '<div class="banner"><span><strong>Manual mode.</strong> The light is ignoring this schedule.</span><button class="btn small" data-action="run-schedule">Run schedule</button></div>';
    const nat = naturalOn();
    if (!nat) html += sourceNote();
    if (nat) html += naturalCard();
    html += '<div class="card"><div class="row spread"><h2>Today</h2><span class="hint num" id="clock"></span></div>' +
      '<div id="chartBox">' + chartSvg(state.points, null) + '</div>' +
      '<div id="nowBox">' + nowBars(currentOutput()) + '</div>' +
      '<p class="hint" style="margin:10px 0 0">' + (nat ? 'Worked out for today by the natural cycle.' : 'Tap the chart to add or edit a point.') + '</p></div>';
    if (nat) {
      v.innerHTML = html;
      tickClock();
      bindChart();
      refreshAutoStatus();
      return;
    }
    html += '<div class="card"><h2>Key points</h2><p class="sub">The light fades smoothly from one point to the next.</p><ul class="points">' +
      sorted.map((p) => {
        const idx = state.points.indexOf(p);
        const top = Math.max.apply(null, p.v.slice(0, ch.length));
        const bars = ch.map((c, i) => '<i style="height:' + Math.max(2, p.v[i] / 100 * 26) + 'px;background:' + c.color + '"></i>').join('');
        const clash = conflictHours.indexOf(S.hourOf(p.t)) >= 0 ? ' <span style="color:var(--bad)">same hour</span>' : '';
        return '<li><button class="point" data-action="edit-point" data-idx="' + idx + '">' +
          '<span class="time num">' + S.fmtTime(p.t) + '</span><span class="mini">' + bars + '</span>' +
          '<span class="peak num">' + (top === 0 ? 'off' : 'up to ' + Math.round(top) + '%') + clash + '</span></button></li>';
      }).join('') + '</ul>' +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn" data-action="add-point">Add point</button>' +
      '<button class="btn" data-action="quick-setup">Quick setup</button>' +
      '<button class="btn" data-action="presets">Presets</button></div></div>';
    html += naturalInvite();
    v.innerHTML = html;
    tickClock();
    bindChart();
  }

  function tickClock() {
    const c = $('clock');
    if (c) c.textContent = 'now ' + S.fmtTime(nowMinutes());
  }

  function freeHourNear(t) {
    for (let d = 0; d < 24; d++) {
      for (const s of [d, -d]) {
        const h = ((Math.round(t / 60) + s) % 24 + 24) % 24;
        if (!state.points.some((p) => S.hourOf(p.t) === h)) return h;
      }
    }
    return -1;
  }

  function addPoint(t) {
    let h;
    if (t == null) {
      // middle of the longest gap between points
      const pts = state.points.slice().sort((a, b) => a.t - b.t);
      let best = 720, gap = -1;
      pts.forEach((p, i) => {
        const nxt = i + 1 < pts.length ? pts[i + 1].t : pts[0].t + 1440;
        if (nxt - p.t > gap) { gap = nxt - p.t; best = (p.t + (nxt - p.t) / 2) % 1440; }
      });
      h = freeHourNear(best);
    } else {
      h = freeHourNear(t);
    }
    if (h < 0) { toast('Every hour already has a point. The light has 24 hourly slots.'); return; }
    const p = { t: h * 60, v: S.valueAt(state.points, h * 60).map((x) => Math.round(x)) };
    state.points.push(p);
    openPointEditor(p, true);
  }

  // ---- point editor -------------------------------------------------------------------------------
  function openPointEditor(p, isNew) {
    state.editing = p;
    state.editingNew = isNew;
    const before = { t: p.t, v: p.v.slice() };
    openSheet(isNew ? 'New point' : 'Edit point',
      '<div class="time-edit"><button class="btn" data-pe="-15" aria-label="15 minutes earlier">&minus;15</button>' +
      '<span class="big num" id="peTime">' + S.fmtTime(p.t) + '</span>' +
      '<button class="btn" data-pe="15" aria-label="15 minutes later">+15</button></div>' +
      '<div class="row" style="justify-content:center;margin-bottom:6px"><label class="hint">Exact time <input class="input" type="time" id="peExact" value="' + S.fmtTime(p.t) + '" style="width:auto;min-height:36px;display:inline-block"></label></div>' +
      '<p class="err" id="peErr"></p>' +
      sliderRows('point', p.v) +
      '<div class="row spread" style="margin:10px 0">' +
      '<label class="row hint"><input type="checkbox" id="pePreview"' + (state.previewOn ? ' checked' : '') + '> Show on the light while I edit</label></div>' +
      '<div class="btn-row"><button class="btn danger" id="peDelete">Delete</button>' +
      (isNew ? '' : '<button class="btn quiet" id="peUndo">Undo changes</button>') +
      '<button class="btn primary" id="peDone">Done</button></div>',
      (body) => {
        const err = $('peErr');
        const setTime = (t) => {
          t = ((t % 1440) + 1440) % 1440;
          const clash = state.points.find((q) => q !== p && S.hourOf(q.t) === S.hourOf(t));
          if (clash) {
            err.textContent = 'There is already a point at ' + S.fmtTime(clash.t) + '. The light allows one point per hour.';
            $('peExact').value = S.fmtTime(p.t);
            return;
          }
          err.textContent = '';
          p.t = t;
          $('peTime').textContent = S.fmtTime(t);
          $('peExact').value = S.fmtTime(t);
          changed();
        };
        const changed = () => { persistWorking(); refreshChart(); renderSaveBar(); renderGlass(); };
        body.querySelectorAll('[data-pe]').forEach((b) => b.addEventListener('click', () => setTime(p.t + (+b.dataset.pe))));
        $('peExact').addEventListener('change', (e) => { const t = S.parseTime(e.target.value); if (t != null) setTime(t); });
        bindSliders(body, 'point', p.v, () => { changed(); sendPreview(p.v); });
        $('pePreview').addEventListener('change', (e) => { state.previewOn = e.target.checked; if (state.previewOn) sendPreview(p.v); else endPreview(); });
        $('peDelete').addEventListener('click', () => {
          if (state.points.length <= 1) { err.textContent = 'Keep at least one point.'; return; }
          state.points.splice(state.points.indexOf(p), 1);
          closeSheet();
        });
        const undo = $('peUndo');
        if (undo) undo.addEventListener('click', () => { p.t = before.t; p.v = before.v.slice(); closeSheet(); });
        $('peDone').addEventListener('click', closeSheet);
        if (state.previewOn) sendPreview(p.v);
      },
      () => { state.editing = null; endPreview(); persistWorking(); renderAll(); });
  }

  // ---- quick setup ----------------------------------------------------------------------------------
  function openQuickSetup() {
    const n = channels().length;
    const peak = [0, 1, 2, 3, 4, 5].map((i) => i < n ? Math.max.apply(null, state.points.map((p) => p.v[i])) : 0);
    const night = [0, 1, 2, 3, 4, 5].map((i) => i < n ? Math.min.apply(null, state.points.map((p) => p.v[i])) : 0);
    if (peak.every((x) => x === 0)) peak.fill(50, 0, n);
    const ramps = [60, 90, 120, 180, 240].map((m) => '<option value="' + m + '">' + (m / 60) + (m === 60 ? ' hour' : ' hours') + '</option>').join('');
    openSheet('Quick setup',
      '<p class="hint" style="margin-top:0">Builds a simple day: off at night, a sunrise ramp, full brightness, a sunset ramp.</p>' +
      '<div class="row" style="gap:12px">' +
      '<label class="field" style="flex:1"><span>Sunrise starts</span><input class="input" type="time" id="qsOn" value="09:30"></label>' +
      '<label class="field" style="flex:1"><span>Dark by</span><input class="input" type="time" id="qsOff" value="20:30"></label></div>' +
      '<div class="row" style="gap:12px">' +
      '<label class="field" style="flex:1"><span>Sunrise takes</span><select class="input" id="qsUp">' + ramps + '</select></label>' +
      '<label class="field" style="flex:1"><span>Sunset takes</span><select class="input" id="qsDown">' + ramps + '</select></label></div>' +
      '<h2 style="font-size:var(--fs-md);margin:6px 0">Full brightness</h2>' + sliderRows('peak', peak) +
      '<details style="margin:10px 0"><summary class="hint">Night light (moonlight)</summary>' + sliderRows('night', night) + '</details>' +
      '<p class="err" id="qsErr"></p>' +
      '<div class="btn-row"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="qsGo">Use this schedule</button></div>',
      (body) => {
        $('qsUp').value = '90';
        $('qsDown').value = '120';
        bindSliders(body, 'peak', peak, () => {});
        bindSliders(body, 'night', night, () => {});
        $('qsGo').addEventListener('click', () => {
          try {
            const on = S.parseTime($('qsOn').value), off = S.parseTime($('qsOff').value);
            if (on == null || off == null) throw new Error('Pick both times.');
            state.points = S.photoperiod({ on, off, rampUp: +$('qsUp').value, rampDown: +$('qsDown').value, peak, night });
            closeSheet();
            toast('Schedule built. Tap Save to light when you are happy with it.');
          } catch (e) { $('qsErr').textContent = e.message; }
        });
      },
      () => { persistWorking(); renderAll(); });
  }

  // ---- presets ----------------------------------------------------------------------------------------
  function openPresets() {
    const lib = store.get('library', []);
    const factory = Object.keys(S.FACTORY[state.model]);
    openSheet('Presets',
      '<h2 style="font-size:var(--fs-md);margin:0 0 6px">Factory</h2><p class="hint" style="margin-top:0">The same starting points the official app offers.</p>' +
      '<div class="btn-row" style="margin-bottom:16px">' + factory.map((f) => '<button class="btn" data-factory="' + esc(f) + '">' + esc(f) + '</button>').join('') + '</div>' +
      '<h2 style="font-size:var(--fs-md);margin:0 0 6px">My schedules</h2>' +
      (lib.length ? '<ul class="list">' + lib.map((x, i) => '<li><div><div class="main-t">' + esc(x.name) + '</div><div class="sub-t">' + x.points.length + ' points, saved ' + esc(new Date(x.at).toLocaleDateString()) + '</div></div>' +
        '<div class="row"><button class="btn small" data-load="' + i + '">Load</button><button class="btn small quiet" data-del="' + i + '" aria-label="Delete ' + esc(x.name) + '">Delete</button></div></li>').join('') + '</ul>'
        : '<p class="hint">Nothing saved yet.</p>') +
      '<div class="row" style="margin-top:12px"><input class="input" id="libName" placeholder="Name for the current schedule" style="flex:1"><button class="btn" id="libSave">Save current</button></div>',
      (body) => {
        body.querySelectorAll('[data-factory]').forEach((b) => b.addEventListener('click', () => {
          state.points = S.factoryPoints(state.model, b.dataset.factory);
          closeSheet();
          toast(b.dataset.factory + ' loaded. Tap Save to light to apply it.');
        }));
        body.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => {
          state.points = lib[+b.dataset.load].points.map((p) => ({ t: p.t, v: p.v.slice() }));
          closeSheet();
          toast('Loaded. Tap Save to light to apply it.');
        }));
        body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
          lib.splice(+b.dataset.del, 1);
          store.set('library', lib);
          closeSheet();
          openPresets();
        }));
        $('libSave').addEventListener('click', () => {
          const name = $('libName').value.trim() || ('Schedule ' + (lib.length + 1));
          lib.push({ name, points: state.points, model: state.model, at: Date.now() });
          store.set('library', lib);
          closeSheet();
          openPresets();
          toast('Saved "' + name + '" on this ' + DEVICE + '.');
        });
      },
      () => { persistWorking(); renderAll(); });
  }

  // ---- manual view --------------------------------------------------------------------------------------
  function scenes() { return store.get('scenes', []); }

  function updateManualBanner() {
    const b = $('manualBanner');
    if (!b) return;
    b.innerHTML = state.auto
      ? '<span>The light is running its schedule. Moving a slider switches it to manual.</span>'
      : '<span><strong>Manual mode is on.</strong> The schedule is paused.</span><button class="btn small" data-action="run-schedule">Run schedule</button>';
  }

  function renderManual() {
    const v = $('view-manual');
    const n = channels().length;
    const builtIn = [
      { name: 'Off', v: [0, 0, 0, 0, 0, 0] },
      { name: 'Blues 30%', v: n === 3 ? [0, 30, 30, 0, 0, 0] : [0, 30, 0, 30, 30, 0] },
      { name: 'All 50%', v: [50, 50, 50, n === 3 ? 0 : 50, n === 3 ? 0 : 50, n === 3 ? 0 : 50] },
      { name: 'All 100%', v: [100, 100, 100, n === 3 ? 0 : 100, n === 3 ? 0 : 100, n === 3 ? 0 : 100] }
    ];
    const mine = scenes();
    const overall = Math.max.apply(null, state.manual.slice(0, n));
    v.innerHTML = '<div class="banner" id="manualBanner"></div>' +
      '<div class="card"><h2>Channels</h2>' + sliderRows('manual', state.manual) +
      '<div class="ch" style="--c:var(--ink);margin-top:6px;border-top:1px solid var(--sea-700);padding-top:12px"><span class="name">All</span>' +
      '<input type="range" min="0" max="100" value="' + overall + '" id="masterRange" aria-label="All channels, keeps the mix" style="--p:' + overall + '%">' +
      '<span></span><span class="pct num" id="masterPct">' + overall + '%</span><span></span></div>' +
      '<p class="hint" style="margin:6px 0 0">"All" dims or brightens every channel together and keeps your mix.</p></div>' +
      '<div class="card"><h2>Scenes</h2><div class="scenes">' +
      builtIn.map((s, i) => '<button class="btn small" data-scene-b="' + i + '">' + esc(s.name) + '</button>').join('') +
      mine.map((s, i) => '<button class="btn small" data-scene-m="' + i + '">' + esc(s.name) + '</button>').join('') +
      '</div><div class="row" style="margin-top:10px"><input class="input" id="sceneName" placeholder="Name this mix" style="flex:1"><button class="btn" id="sceneSave">Save scene</button></div>' +
      (mine.length ? '<button class="btn quiet small" id="sceneClear" style="margin-top:6px">Remove my scenes</button>' : '') + '</div>';

    updateManualBanner();
    const live = () => { sendManualLive(); persistWorking(); renderSaveBar(); renderGlass(); syncMaster(); };
    const set = bindSliders(v, 'manual', state.manual, live);
    const master = $('masterRange');
    let base = null;
    const syncMaster = () => {
      if (base) return;
      const o = Math.max.apply(null, state.manual.slice(0, n));
      master.value = o; master.style.setProperty('--p', o + '%'); $('masterPct').textContent = o + '%';
    };
    master.addEventListener('pointerdown', () => { base = state.manual.slice(); });
    master.addEventListener('input', () => {
      if (!base) base = state.manual.slice();
      const bmax = Math.max.apply(null, base.slice(0, n));
      const target = +master.value;
      master.style.setProperty('--p', target + '%');
      $('masterPct').textContent = target + '%';
      for (let i = 0; i < n; i++) {
        const nv = bmax > 0 ? (base[i] / bmax) * target : target;
        state.manual[i] = Math.round(nv);
        const r = v.querySelector('input[data-group="manual"][data-ch="' + i + '"]');
        r.value = state.manual[i]; r.style.setProperty('--p', state.manual[i] + '%');
        v.querySelector('[data-pct="manual-' + i + '"]').textContent = state.manual[i] + '%';
      }
      sendManualLive(); persistWorking(); renderSaveBar(); renderGlass();
    });
    master.addEventListener('change', () => { base = null; });

    const apply = (vals) => { for (let i = 0; i < 6; i++) { if (i < n) set(i, vals[i]); else state.manual[i] = 0; } };
    v.querySelectorAll('[data-scene-b]').forEach((b) => b.addEventListener('click', () => apply(builtIn[+b.dataset.sceneB].v)));
    v.querySelectorAll('[data-scene-m]').forEach((b) => b.addEventListener('click', () => apply(mine[+b.dataset.sceneM].v)));
    $('sceneSave').addEventListener('click', () => {
      const name = $('sceneName').value.trim() || ('Scene ' + (mine.length + 1));
      mine.push({ name, v: state.manual.slice() });
      store.set('scenes', mine);
      renderManual();
      toast('Scene "' + name + '" saved on this ' + DEVICE + '.');
    });
    const clr = $('sceneClear');
    if (clr) clr.addEventListener('click', () => { store.set('scenes', []); renderManual(); });
  }

  // ---- PAR: calibration wizard and planner ------------------------------------------------------------------
  const PAR = window.NooPar;
  const ownCal = () => store.get('parCal:' + state.model, null);
  const builtInCal = () => (window.NooParData || {})[state.model] || null;
  function parCal() { return ownCal() || builtInCal(); }
  function parRun() { return store.get('parRun:' + state.model, null); }
  function saveParRun(r) { store.set('parRun:' + state.model, r); }
  function parChecks() { return store.get('parChecks:' + state.model, []); }
  const numOr = (v, d) => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? d : x; };

  function parCard() {
    const cal = parCal();
    const run = parRun();
    const total = run ? PAR.buildSteps(run.model, run.positions).length : 0;
    const taken = run ? Object.keys(run.readings || {}).length : 0;
    return '<div class="card"><h2>PAR</h2>' +
      '<p class="sub">' + (cal
        ? 'Ask for a PAR at a depth and get settings for it. Calibrated ' + esc(cal.made) + (ownCal() ? ' on this ' + DEVICE + '.' : ', built into the app.')
        : 'This light type has not been calibrated yet. Calibrating takes a PAR meter and about 40 minutes.') + '</p>' +
      (cal ? '<div class="btn-row"><button class="btn primary" data-action="par-plan">PAR planner</button></div>' : '') +
      '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="par-calibrate">' + (run && taken < total ? 'Continue calibrating (' + taken + ' of ' + total + ')' : 'Calibrate with a PAR meter') + '</button></div>' +
      '<div class="btn-row" style="margin-top:8px">' +
      (ownCal() ? '<button class="btn" data-action="par-export">Save calibration file</button>' : '') +
      '<button class="btn" data-action="par-import">Load calibration file</button></div></div>';
  }

  // Everything the wizard shows on the light is temporary; put the light back as it was afterwards.
  let parLive = false;
  async function parShow(values) {
    if (!connected()) return false;
    try {
      if (!parLive) { parLive = true; await link.send(P.setAutoMode(false)); }
      await link.send(P.setManual(values));
      return true;
    } catch (e) { return false; }
  }
  async function parRestore() {
    if (!parLive) return;
    parLive = false;
    if (!connected()) return;
    if (state.auto) await link.send(P.setAutoMode(true)).catch(() => {});
    else await link.send(P.setManual(state.manual)).catch(() => {});
  }

  function posRows(positions) {
    return positions.map((p, i) => '<div class="row par-pos" data-i="' + i + '">' +
      '<select class="input" data-f="medium" aria-label="Air or water"><option value="water"' + (p.medium === 'water' ? ' selected' : '') + '>Water</option><option value="air"' + (p.medium === 'air' ? ' selected' : '') + '>Air</option></select>' +
      '<label class="mini-f"><span>' + (p.medium === 'air' ? 'Below light' : 'Depth') + '</span><input class="input num" data-f="d" inputmode="decimal" value="' + (p.medium === 'air' ? p.dist : p.depth) + '"></label>' +
      '<label class="mini-f"><span>To the side</span><input class="input num" data-f="offset" inputmode="decimal" value="' + (p.offset || 0) + '"></label>' +
      '<label class="mini-f" title="Measure the dimming curves here"><span>Curves</span><input type="radio" name="parRef" data-f="ref"' + (p.ref ? ' checked' : '') + '></label>' +
      '<button class="btn quiet small" data-del="' + i + '" aria-label="Remove this position">&times;</button></div>').join('');
  }

  function openParSetup() {
    const run = parRun();
    const cfg = run ? JSON.parse(JSON.stringify(run)) : { model: state.model, lightHeight: 20, correction: Object.assign({}, PAR.CORRECTION_DEFAULT), positions: PAR.defaultPositions(), readings: {} };
    cfg.model = state.model;
    const taken = Object.keys(cfg.readings || {}).length;
    const nSteps = () => PAR.buildSteps(cfg.model, cfg.positions).length;
    openSheet('Calibrate PAR',
      '<p class="sub" style="margin-top:0">The app sets the light for each reading; you hold the meter where it says and type what the meter shows. Your progress is kept if you stop.</p>' +
      '<ul class="par-check">' +
      '<li>Dark room: curtains closed, room lights off.</li>' +
      '<li>Wavemakers and return pump off, so the surface is flat. Turn them back on afterwards.</li>' +
      '<li>Sensor level and facing up. Measure "to the side" along the light\'s long side.</li>' +
      '<li>Warm the light up first: all channels at 100% for 10 minutes. Corals can take a few short bright steps, but not 40 minutes at full: shade them or keep the 100% steps quick.</li></ul>' +
      '<div class="row" style="gap:10px">' +
      '<label class="field" style="flex:1"><span>Light above water (cm)</span><input class="input num" id="parH" inputmode="decimal" value="' + cfg.lightHeight + '"></label>' +
      '<label class="field" style="flex:1"><span>Meter: add</span><input class="input num" id="parAdd" inputmode="decimal" value="' + cfg.correction.add + '"></label>' +
      '<label class="field" style="flex:1"><span>then multiply by</span><input class="input num" id="parMult" inputmode="decimal" value="' + cfg.correction.mult + '"></label></div>' +
      '<p class="hint" style="margin:-6px 0 10px">Type the meter\'s own number at every step; the app applies the correction. All distances are in cm. Depth is from the water surface to the sensor.</p>' +
      '<h2 style="font-size:var(--fs-md);margin:4px 0">Where to measure</h2><div id="parPos"></div>' +
      '<button class="btn small" id="parAddPos" style="margin:6px 0 10px">Add a position</button>' +
      '<p class="hint" id="parCount"></p><p class="err" id="parErr"></p>' +
      '<div class="btn-row"><button class="btn" id="parWarm">Warm up: all at 100%</button></div>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn quiet" data-close>Close</button>' +
      (taken ? '<button class="btn" id="parReset">Start over</button>' : '') +
      '<button class="btn primary" id="parGo">' + (taken ? 'Continue' : 'Start') + '</button></div>',
      (body) => {
        const orig = JSON.stringify(cfg.positions);
        const draw = () => {
          $('parPos').innerHTML = posRows(cfg.positions);
          const changed = JSON.stringify(cfg.positions) !== orig;
          $('parCount').textContent = nSteps() + ' readings, about ' + Math.round(nSteps() * 25 / 60) + ' minutes.' +
            (taken && changed ? ' Changing the positions clears the ' + taken + ' readings taken so far.' : '');
          body.querySelectorAll('.par-pos').forEach((row) => {
            const i = +row.dataset.i, p = cfg.positions[i];
            row.querySelector('[data-f="medium"]').addEventListener('change', (e) => {
              const d = p.medium === 'air' ? p.dist : p.depth;
              p.medium = e.target.value; delete p.dist; delete p.depth;
              if (p.medium === 'air') p.dist = d; else p.depth = d;
              draw();
            });
            row.querySelector('[data-f="d"]').addEventListener('change', (e) => { const v = Math.max(0, numOr(e.target.value, 0)); if (p.medium === 'air') p.dist = v; else p.depth = v; draw(); });
            row.querySelector('[data-f="offset"]').addEventListener('change', (e) => { p.offset = Math.max(0, numOr(e.target.value, 0)); draw(); });
            row.querySelector('[data-f="ref"]').addEventListener('change', () => { cfg.positions.forEach((q, k) => { q.ref = k === i; }); draw(); });
            row.querySelector('[data-del]').addEventListener('click', () => { cfg.positions.splice(i, 1); if (!cfg.positions.some((q) => q.ref) && cfg.positions[0]) cfg.positions[0].ref = true; draw(); });
          });
        };
        draw();
        $('parAddPos').addEventListener('click', () => { cfg.positions.push({ id: 'p' + Date.now(), medium: 'water', depth: 30, offset: 0 }); draw(); });
        $('parWarm').addEventListener('click', async () => {
          if (!(await ensureConnected())) return;
          await parShow(PAR.buildSteps(cfg.model, cfg.positions).find((s) => s.kind === 'all' && s.level === 100).values);
          toast('All channels at 100%. Keep this screen open for about 10 minutes, then tap Start. Closing it puts the light back.');
        });
        const reset = $('parReset');
        if (reset) reset.addEventListener('click', () => { store.del('parRun:' + state.model); parRestore(); closeSheet(); openParSetup(); });
        $('parGo').addEventListener('click', async () => {
          const h = numOr($('parH').value, NaN);
          if (!(h >= 0)) { $('parErr').textContent = 'Enter the light\'s height above the water.'; return; }
          if (!cfg.positions.length) { $('parErr').textContent = 'Add at least one position.'; return; }
          if (!(await ensureConnected())) { $('parErr').textContent = 'Connect to the light first.'; return; }
          if (JSON.stringify(cfg.positions) !== orig) cfg.readings = {};
          cfg.lightHeight = h;
          cfg.correction = { add: numOr($('parAdd').value, 0), mult: numOr($('parMult').value, 1) };
          saveParRun(cfg);
          const steps = PAR.buildSteps(cfg.model, cfg.positions);
          const next = steps.findIndex((s) => cfg.readings[s.key] == null);
          openParStep(next < 0 ? steps.length : next);
        });
      },
      () => { if (!parStepping) parRestore(); });
  }

  let parStepping = false;
  function stepWhat(s) {
    if (s.kind === 'dark') return 'Everything off';
    if (s.kind === 'all') return 'All channels at ' + s.level + '%';
    return channels()[s.ch].name + ' at ' + s.level + '%';
  }

  function openParStep(i) {
    const run = parRun();
    const steps = PAR.buildSteps(run.model, run.positions);
    if (i >= steps.length) { parStepping = false; return finishPar(); }
    const s = steps[i];
    const p = run.positions[s.pos];
    const moved = i === 0 || steps[i - 1].pos !== s.pos;
    const prev = run.readings[s.key];
    const pct = Math.round((i / steps.length) * 100);
    parStepping = true;
    openSheet('Reading ' + (i + 1) + ' of ' + steps.length,
      '<div class="par-progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="par-where' + (moved ? ' moved' : '') + '"><span class="hint">' + (moved ? 'Move the meter to' : 'Meter at') + '</span><strong>' + esc(PAR.posLabel(p)) + '</strong></div>' +
      '<p class="par-what">' + esc(stepWhat(s)) + '</p>' +
      (s.kind === 'curve' && s.level === PAR.CURVE_LEVELS[0] ? '<p class="hint">Dimming curve for ' + esc(channels()[s.ch].name) + ': the same spot, at lower settings.</p>' : '') +
      '<label class="field"><span>Meter shows</span><input class="input num par-in" id="parVal" inputmode="decimal" autocomplete="off" value="' + (prev == null ? '' : prev) + '"></label>' +
      '<p class="hint" id="parNote">' + (s.kind === 'dark' ? 'Light from the room. 0 is fine.' : 'Give it a few seconds to settle. If it jumps around, use the middle of the range.') + '</p>' +
      '<div class="btn-row"><button class="btn quiet" id="parStop">Stop for now</button>' +
      '<button class="btn" id="parBack"' + (i === 0 ? ' disabled' : '') + '>Back</button>' +
      '<button class="btn" id="parSkip">Skip</button>' +
      '<button class="btn primary" id="parNext">Next</button></div>',
      (body) => {
        parShow(s.values).then((ok) => { if (!ok) $('parNote').textContent = 'Not connected to the light: it is not showing this step.'; });
        const inp = $('parVal');
        setTimeout(() => inp.focus(), 50);
        const go = (j) => { parStepping = true; openParStep(j); };
        const take = () => {
          const v = numOr(inp.value, NaN);
          if (!(v >= 0)) { $('parNote').textContent = 'Type the number on the meter, or tap Skip.'; return; }
          const r = parRun(); r.readings[s.key] = v; saveParRun(r);
          go(i + 1);
        };
        $('parNext').addEventListener('click', take);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') take(); });
        $('parSkip').addEventListener('click', () => go(i + 1));
        $('parBack').addEventListener('click', () => go(i - 1));
        $('parStop').addEventListener('click', () => { parStepping = false; closeSheet(); toast('Readings kept. Continue any time from Lights & backup.'); });
      },
      () => { if (!parStepping) { parRestore(); renderView(); } parStepping = false; });
    parStepping = false;
  }

  function finishPar() {
    parRestore();
    let cal;
    try { cal = PAR.fit(parRun()); } catch (e) { toast('Could not calibrate: ' + e.message); return; }
    store.set('parCal:' + state.model, cal);
    renderView();
    openParResults(cal);
  }

  function openParResults(cal) {
    const ch = channels();
    const pc = (x) => Math.round(x * 100) + '%';
    const allOn = cal.combined[2][1];
    openSheet('Calibration done',
      '<p class="sub" style="margin-top:0">The model matches your readings to within about ' + Math.round(cal.rms * 100) + '% on average. Under 10% is good; more usually means a reading was mistyped or the meter moved.</p>' +
      '<h2 style="font-size:var(--fs-md);margin:8px 0 4px">All channels at 100%</h2>' +
      '<table class="par-table"><tr><th>Where</th><th>Meter</th><th>Model</th></tr>' +
      cal.check.map((c) => '<tr><td>' + esc(c.label) + '</td><td class="num">' + Math.round(c.measured) + '</td><td class="num">' + c.predicted + '</td></tr>').join('') + '</table>' +
      '<p class="hint">With every channel at 100% the light gives ' + pc(allOn) + ' of what the channels add up to on their own' + (allOn < 0.93 ? ': it limits its power or loses output to heat when everything is on.' : '.') + '</p>' +
      '<h2 style="font-size:var(--fs-md);margin:8px 0 4px">Dimming: share of full output</h2>' +
      '<table class="par-table"><tr><th></th>' + PAR.CURVE_LEVELS.map((l) => '<th>' + l + '%</th>').join('') + '</tr>' +
      cal.channels.map((c, i) => '<tr><td style="color:' + ch[i].color + '">' + esc(ch[i].name) + '</td>' +
        PAR.CURVE_LEVELS.map((l) => { const q = c.curve.find((x) => x[0] === l); return '<td class="num">' + (q ? pc(q[1]) : '') + '</td>'; }).join('') + '</tr>').join('') + '</table>' +
      '<p class="hint">Save the calibration file and send it to be built into the app, so everyone with this light can use the planner.</p>' +
      '<div class="btn-row"><button class="btn" data-action="par-export">Save calibration file</button><button class="btn primary" data-action="par-plan">Open planner</button></div>');
  }

  function parExportText() {
    return JSON.stringify(Object.assign({}, ownCal(), { checks: parChecks(), raw: parRun() }), null, 2);
  }
  function exportPar() {
    if (!ownCal()) { toast('No calibration on this ' + DEVICE + ' yet.'); return; }
    const text = parExportText();
    transport.saveText('reef-light-par-' + state.model + '-' + new Date().toISOString().slice(0, 10) + '.json', text).then(
      (ok) => { if (ok !== false) toast('Calibration saved.'); },
      (e) => {
        if (e.message === 'cancelled') return;
        transport.copyText(text).then(() => toast('Copied the calibration.'), () => openSheet('Calibration', '<textarea class="input" readonly rows="10">' + esc(text) + '</textarea>'));
      });
  }
  function importPar() {
    transport.openText().then((text) => {
      const c = JSON.parse(text);
      if (!c || c.app !== 'reef-light-par' || !c.channels) throw new Error('This is not a Reef Light PAR calibration.');
      if (c.model !== state.model) throw new Error('This calibration is for a ' + (c.model === 'mini' ? 'K7 Mini' : 'K7 / K7 Pro') + '.');
      const keep = Object.assign({}, c); delete keep.raw; delete keep.checks;
      store.set('parCal:' + state.model, keep);
      renderView();
      toast('Calibration loaded.');
    }).catch((e) => { if (e.message !== 'cancelled') toast('Could not load: ' + e.message); });
  }

  function openParPlanner() {
    const cal = parCal();
    if (!cal) { openParSetup(); return; }
    const n = channels().length;
    const pr = Object.assign({ h: cal.lightHeight, depth: 30, offset: 0, target: 250, mixFrom: 'schedule' }, store.get('parPlan', {}));
    let result = null;
    openSheet('PAR planner',
      '<p class="sub" style="margin-top:0">Pick a spot and the PAR you want there. The app keeps your colour mix and works out how bright to run it.</p>' +
      '<div class="row" style="gap:10px">' +
      '<label class="field" style="flex:1"><span>Light above water (cm)</span><input class="input num" id="ppH" inputmode="decimal" value="' + pr.h + '"></label>' +
      '<label class="field" style="flex:1"><span>Depth (cm)</span><input class="input num" id="ppD" inputmode="decimal" value="' + pr.depth + '"></label>' +
      '<label class="field" style="flex:1"><span>To the side (cm)</span><input class="input num" id="ppO" inputmode="decimal" value="' + pr.offset + '"></label></div>' +
      '<div class="row" style="gap:10px">' +
      '<label class="field" style="flex:1"><span>PAR wanted</span><input class="input num" id="ppT" inputmode="decimal" value="' + pr.target + '"></label>' +
      '<label class="field" style="flex:2"><span>Colour mix</span><select class="input" id="ppMix">' +
      '<option value="schedule"' + (pr.mixFrom === 'schedule' ? ' selected' : '') + '>My schedule at its brightest</option>' +
      '<option value="manual"' + (pr.mixFrom === 'manual' ? ' selected' : '') + '>The Manual sliders</option></select></label></div>' +
      '<div class="par-out" id="ppOut"></div>' +
      '<div class="btn-row"><button class="btn" id="ppShow">Show on the light</button><button class="btn" id="ppApply">Use for my schedule</button></div>' +
      '<h2 style="font-size:var(--fs-md);margin:14px 0 4px">Check it with a meter</h2>' +
      '<div class="row"><input class="input num" id="ppMeas" inputmode="decimal" placeholder="PAR your meter shows" style="flex:1"><button class="btn" id="ppCmp">Compare</button></div>' +
      '<p class="hint" id="ppCmpOut"></p>' +
      '<p class="hint">Estimates assume a clear tank and a level sensor; glass walls, white sand and the light\'s age can move the real number by 10 to 20%. Calibrated ' + esc(cal.made) + ' with the light ' + cal.lightHeight + ' cm above the water' + (ownCal() ? ', on this ' + DEVICE : '') + '.</p>',
      (body) => {
        const mixNow = () => ($('ppMix').value === 'manual' ? state.manual.slice() : currentMix());
        const calc = () => {
          pr.h = numOr($('ppH').value, pr.h); pr.depth = Math.max(0, numOr($('ppD').value, pr.depth));
          pr.offset = Math.max(0, numOr($('ppO').value, pr.offset)); pr.target = Math.max(0, numOr($('ppT').value, pr.target));
          pr.mixFrom = $('ppMix').value;
          store.set('parPlan', pr);
          const pos = { medium: 'water', depth: pr.depth, offset: pr.offset };
          result = PAR.plan(cal, pos, pr.target, mixNow(), pr.h);
          result.pos = pos;
          const ch = channels();
          $('ppOut').innerHTML =
            '<div class="par-big"><span class="num">' + result.predicted + '</span> PAR estimated</div>' +
            (result.capped ? '<p class="err" style="margin:0 0 6px">This mix tops out at about ' + result.max + ' PAR here. Lower the light, go shallower, or use a brighter mix.</p>'
              : '<p class="hint" style="margin:0 0 6px">This mix can reach about ' + result.max + ' PAR here.</p>') +
            '<div class="par-vals">' + ch.map((c, i) => '<span style="--c:' + c.color + '"><b>' + esc(c.name) + '</b><span class="num">' + result.values[i] + '%</span></span>').join('') + '</div>';
          $('ppApply').disabled = pr.mixFrom !== 'schedule' || naturalOn();
          $('ppApply').title = naturalOn() ? 'The natural cycle sets the schedule; change its mix instead.' : '';
        };
        body.querySelectorAll('input:not(#ppMeas), select').forEach((el) => el.addEventListener('input', calc));
        calc();
        $('ppShow').addEventListener('click', () => {
          for (let i = 0; i < 6; i++) state.manual[i] = i < n ? result.values[i] : 0;
          setMode(false);
        });
        $('ppApply').addEventListener('click', () => {
          const mix = currentMix(), top = Math.max.apply(null, mix.slice(0, n));
          const k = top > 0 ? Math.max.apply(null, result.values.slice(0, n)) / top : 1;
          state.points.forEach((p) => { for (let c = 0; c < n; c++) p.v[c] = Math.max(0, Math.min(100, Math.round(p.v[c] * k))); });
          persistWorking();
          closeSheet();
          switchView('schedule');
          renderAll();
          toast('Schedule brightened to ' + result.predicted + ' PAR at its peak. Tap Save to light.');
        });
        $('ppCmp').addEventListener('click', () => {
          const m = numOr($('ppMeas').value, NaN);
          if (!(m > 0) || !result) return;
          const off = Math.round(((m - result.predicted) / result.predicted) * 100);
          const list = parChecks();
          list.push({ at: new Date().toISOString(), lightHeight: pr.h, pos: result.pos, values: result.values, predicted: result.predicted, measured: m });
          store.set('parChecks:' + state.model, list);
          $('ppCmpOut').textContent = 'Meter ' + m + ', estimate ' + result.predicted + ': ' + (Math.abs(off) <= 10 ? 'within ' + Math.abs(off) + '%, as good as the meter.' : (off > 0 ? off + '% more' : -off + '% less') + ' than estimated. Check the depth and height, and that the sensor is level.') + ' Saved with the calibration file.';
        });
      });
  }

  // ---- lights & backup view ------------------------------------------------------------------------------
  function renderMore() {
    const v = $('view-more');
    const l = state.light;
    const st = state.lastStatus;
    const names = channels();
    v.innerHTML =
      '<div class="card"><h2>This light</h2>' +
      (l ? '<ul class="list">' + identityRows(l) +
        '<li><span class="sub-t">Type</span><span>' + (state.model === 'mini' ? 'K7 Mini, 3 channels' : 'K7 / K7 Pro, 6 channels') + '</span></li>' +
        '<li><span class="sub-t">Mode</span><span>' + (state.auto ? 'Schedule' : 'Manual') + '</span></li></ul>' +
        '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="blink">Blink the light</button><button class="btn" data-action="reload">Reload from light</button></div>' +
        '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="sync-clock">Set light clock</button></div>'
        : '<p class="hint">No light selected.</p>') +
      '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="lights">Switch or find lights</button><button class="btn" data-action="wifi-setup">Put a light on WiFi</button></div></div>' +

      parCard() +

      '<div class="card"><h2>Backup</h2><p class="sub">Your schedules are also stored on the light itself. A backup file keeps a copy you control.</p>' +
      '<div class="btn-row"><button class="btn" data-action="export">Save backup file</button><button class="btn" data-action="import">Restore backup file</button></div>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="copy-code">Copy official-app code</button><button class="btn" data-action="paste-code">Paste official-app code</button></div></div>' +

      '<div class="card"><h2>Channel names</h2><p class="sub">Rename channels to match how you think about them.</p>' +
      names.map((c, i) => '<label class="field"><span style="color:' + c.color + '">Channel ' + (i + 1) + '</span><input class="input" data-name="' + i + '" value="' + esc(c.name) + '"></label>').join('') + '</div>' +

      '<div class="card"><h2>Diagnostics</h2>' +
      '<div class="btn-row"><button class="btn" data-action="demo-on">Run the light\'s day demo</button><button class="btn" data-action="demo-off">Stop demo</button></div>' +
      '<p class="hint">Last status from the light' + (st ? ' (' + st.length + ' bytes, schedule ' + (st.scheduleValid ? 'read OK' : 'not readable') + ')' : '') + ':</p>' +
      '<pre class="log">' + esc(st ? st.hex.replace(/(.{32})/g, '$1\n') : 'nothing yet') + '</pre>' +
      '<p class="hint">Traffic</p><pre class="log" id="log"></pre>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="copy-diag">Copy details</button></div></div>' +

      '<div class="card"><h2>About</h2><p class="hint" style="margin:0">Reef Light ' + VERSION + '. An independent app for Noo-Psyche K7 lights. It talks to the light directly over your WiFi (TCP port 8266), needs no account and sends nothing to the internet.</p></div>';

    v.querySelectorAll('[data-name]').forEach((inp) => inp.addEventListener('change', () => {
      const all = store.get('names', {});
      const arr = all[state.model] || [];
      arr[+inp.dataset.name] = inp.value.trim();
      all[state.model] = arr;
      store.set('names', all);
      renderGlass();
    }));
    renderLog();
  }

  /* What we actually know about who is on the other end. */
  function identityRows(l) {
    const st = state.lastStatus;
    const confirmed = connected() && !state.readFailed && st && st.name && st.name === l.name;
    const how = !connected() ? 'Not connected'
      : viaHotspot(l.host) ? 'Through the light\'s own WiFi hotspot'
      : 'Through your WiFi network';
    return '<li><span class="sub-t">Name</span><span class="main-t">' + esc(l.name || 'not known yet') + '</span></li>' +
      '<li><span class="sub-t">Identity</span><span style="text-align:right;color:' + (confirmed ? 'var(--ok)' : 'var(--warn)') + '">' +
      (confirmed ? 'Confirmed: the light answered with its own name' : 'Not confirmed: the light has not answered yet') + '</span></li>' +
      '<li><span class="sub-t">Connection</span><span style="text-align:right">' + how + '</span></li>' +
      '<li><span class="sub-t">Address</span><span class="num">' + esc(l.host) + '</span></li>';
  }

  function renderLog() {
    const el = $('log');
    if (!el) return;
    el.textContent = link.log.slice(-60).map((x) => x.at + ' ' + x.dir.padEnd(3) + ' ' + x.text).join('\n') || 'nothing yet';
  }

  // ---- lights sheet ---------------------------------------------------------------------------------------
  let lightsSheetOpen = false;
  function lightsSheetBody() {
    const saved = lights();
    const cur = state.light && state.light.id;
    const extra = state.found.filter((f) => f.name && !saved.some((l) => l.name === f.name || l.host === f.host));
    let html = vpnNote();
    html += '<ul class="list">' + saved.map((l) => '<li><div><div class="main-t">' + esc(displayName(l)) + (l.id === cur ? ' <span class="hint">(current)</span>' : '') + '</div>' +
      '<div class="sub-t num">' + esc(l.host) + (l.model === 'mini' ? ', K7 Mini' : '') + (l.name ? '' : ', never answered') + '</div></div>' +
      '<div class="row"><button class="btn small" data-use="' + esc(l.id) + '">' + (l.id === cur ? 'Reconnect' : 'Use') + '</button>' +
      '<button class="btn small quiet" data-forget="' + esc(l.id) + '" aria-label="Forget ' + esc(displayName(l)) + '">Forget</button></div></li>').join('') + '</ul>';
    if (!saved.length) html += '<p class="hint" style="margin-top:0">No lights saved yet.</p>';
    if (extra.length) {
      html += '<h2 style="font-size:var(--fs-md);margin:14px 0 4px">Found on this network</h2><ul class="list">' + extra.map((f) => '<li><div><div class="main-t">' + esc(f.name || 'Unknown device') + '</div><div class="sub-t num">' + esc(f.host) + (f.hotspot ? ', you are on its hotspot' : '') + '</div></div>' +
        '<button class="btn small" data-add="' + esc(f.host) + '">Use</button></li>').join('') + '</ul>';
    }
    if (!state.scanning && state.scanPromise && !state.found.some((f) => f.name)) {
      html += '<p class="err" style="margin-top:12px">No light answered.' +
        (state.silentHosts.length ? ' (' + state.silentHosts.length + ' other device' + (state.silentHosts.length > 1 ? 's' : '') + ' on this network did not answer like a light.)' : '') + '</p>' +
        '<p class="hint">Check that your ' + DEVICE + ' is joined to the light\'s own WiFi (named K7_ and some letters), that the official app is force-stopped, and that no VPN is on.</p>';
    } else if (state.found.some((f) => f.name) && !extra.length && !state.scanning) {
      html += '<p class="hint">No other lights found.</p>';
    }
    html += '<div class="btn-row" style="margin-top:14px"><button class="btn primary" id="lsScan"' + (state.scanning ? ' disabled' : '') + '>' + (state.scanning ? 'Searching the network' : 'Search the network') + '</button></div>' +
      '<label class="field" style="margin:12px 0 0"><span>Or connect by IP address</span><div class="row"><input class="input num" id="lsIp" placeholder="192.168.1.50" inputmode="decimal" style="flex:1"><button class="btn" id="lsIpGo">Connect</button></div></label>' +
      '<p class="hint">Two ways to reach a light: join its own WiFi hotspot (named K7_ and some letters) in your ' + DEVICE + '\'s WiFi settings, as with the official app, or put the light on your home WiFi once with "Put a light on WiFi". Search works for both.</p>' +
      '<div class="btn-row"><button class="btn" id="lsWifi">Put a light on WiFi</button></div>';
    return html;
  }

  function bindLightsSheet(body) {
    body.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
      const l = lights().find((x) => x.id === b.dataset.use);
      closeSheet();
      connectTo(l, { force: true });
    }));
    body.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.forget;
      saveLights(lights().filter((x) => x.id !== id));
      store.del('light:' + id);
      if (state.light && state.light.id === id) { link.close(); state.light = null; store.del('current'); renderAll(); }
      refreshLightsSheet();
    }));
    body.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const f = state.found.find((x) => x.host === b.dataset.add);
      const rec = upsertLight({ id: f.name || f.host, name: f.name, host: f.host, model: f.model || 'k7' });
      closeSheet();
      loadWorking(rec);
      connectTo(rec, { force: true, rescan: false });
    }));
    $('lsScan').addEventListener('click', discover);
    $('lsIpGo').addEventListener('click', () => {
      const host = $('lsIp').value.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { toast('That does not look like an IP address.'); return; }
      const rec = upsertLight({ id: host, host, model: 'k7' });
      closeSheet();
      loadWorking(rec);
      connectTo(rec, { force: true, rescan: false });
    });
    $('lsWifi').addEventListener('click', () => { closeSheet(); openWifiSetup(); });
  }

  function openLightsSheet() {
    lightsSheetOpen = true;
    openSheet('Lights', lightsSheetBody(), bindLightsSheet, () => { lightsSheetOpen = false; });
    if (!lights().length && !state.scanning && !state.found.length) discover();
  }

  function refreshLightsSheet() {
    if (!lightsSheetOpen) return;
    const body = $('sheetBody');
    body.innerHTML = lightsSheetBody();
    bindLightsSheet(body);
  }

  // ---- WiFi provisioning (EspTouch) -------------------------------------------------------------------------
  async function openWifiSetup() {
    let info = null;
    try { info = await transport.wifiInfo(); } catch (e) { info = { error: e.message }; }
    const five = info && info.frequency > 4900;
    openSheet('Put a light on WiFi',
      '<p class="hint" style="margin-top:0">This sends your WiFi name and password to a light that is waiting for setup, the same way the official app does (EspTouch).</p>' +
      '<ol class="hint" style="padding-left:18px"><li>Put the light into WiFi setup mode (see its manual; the official app calls this network configuration).</li>' +
      '<li>Keep this phone on the WiFi you want the light to join. It must be 2.4 GHz.</li><li>Enter the WiFi password and start.</li></ol>' +
      (info && info.ssid ? '<p>Network: <strong>' + esc(info.ssid) + '</strong></p>' : '<p class="err">' + esc((info && info.error) || 'Could not read the WiFi name.') + '</p>') +
      (five ? '<p class="err">Your phone is on 5 GHz WiFi. The light only joins 2.4 GHz networks.</p>' : '') +
      '<label class="field"><span>WiFi password</span><input class="input" type="password" id="wsPass" autocomplete="current-password"></label>' +
      '<p class="hint" id="wsMsg"></p>' +
      '<div class="btn-row"><button class="btn quiet" id="wsCancel">Cancel</button><button class="btn primary" id="wsGo"' + (info && info.ssid ? '' : ' disabled') + '>Start setup</button></div>',
      (body) => {
        let running = false;
        $('wsCancel').addEventListener('click', () => { if (running) transport.cancelProvision(); closeSheet(); });
        $('wsGo').addEventListener('click', async () => {
          running = true;
          $('wsGo').disabled = true;
          $('wsMsg').textContent = 'Sending WiFi details. This can take up to a minute.';
          try {
            const res = await transport.provision(info.ssid, info.bssid, $('wsPass').value, 1);
            if (!res || !res.length) throw new Error('No light answered.');
            const host = res[0].ip;
            $('wsMsg').textContent = 'Light joined at ' + host + '. Connecting.';
            const rec = upsertLight({ id: host, host, model: 'k7' });
            closeSheet();
            loadWorking(rec);
            connectTo(rec, { force: true, rescan: false });
          } catch (e) {
            $('wsMsg').textContent = 'Setup failed: ' + e.message + ' Check the password and that the light is in setup mode.';
            $('wsGo').disabled = false;
          } finally { running = false; }
        });
      });
  }

  // ---- backup ----------------------------------------------------------------------------------------------
  function exportBackup() {
    const data = {};
    store.keys().forEach((k) => { data[k] = store.get(k); });
    const json = JSON.stringify({ app: 'reef-light', version: 1, exported: new Date().toISOString(), data }, null, 2);
    const day = new Date().toISOString().slice(0, 10);
    transport.saveText('reef-light-backup-' + day + '.json', json).then(
      (ok) => { if (ok !== false) toast('Backup saved.'); },
      (e) => { if (e.message !== 'cancelled') toast('Could not save: ' + e.message); });
  }

  function importBackup() {
    transport.openText().then((text) => {
      const obj = JSON.parse(text);
      if (!obj || obj.app !== 'reef-light' || !obj.data) throw new Error('This is not a Reef Light backup.');
      Object.keys(obj.data).forEach((k) => store.set(k, obj.data[k]));
      const cur = store.get('current');
      const l = lights().find((x) => x.id === cur) || lights()[0];
      if (l) {
        loadWorking(l);
        state.light = l;
        state.savedFp = null; // what is on the light is unknown until it is saved again
        persistWorking();
      }
      renderAll();
      toast('Backup restored. Tap Save to light to send it to the light.');
    }).catch((e) => { if (e.message !== 'cancelled') toast('Restore failed: ' + e.message); });
  }

  function copyCode() {
    const code = P.toOfficialCode(state.manual, S.toSlots(state.points));
    transport.copyText(code).then(() => toast('Copied. Paste it anywhere to keep it.'), () => {
      openSheet('Official-app code', '<textarea class="input" readonly>' + esc(code) + '</textarea>');
    });
  }

  function diagnosticsText() {
    const st = state.lastStatus;
    return [
      'Reef Light ' + VERSION + ' (' + transport.kind + ')',
      'Light: ' + (state.light ? (state.light.name || '?') + ' at ' + state.light.host : 'none'),
      'Link: ' + link.state + (state.readFailed ? ', settings not received' : ''),
      'Last status: ' + (st ? st.length + ' bytes, schedule ' + (st.scheduleValid ? 'OK' : 'unreadable') + '\n' + st.hex : 'none'),
      'Traffic:',
      link.log.slice(-80).map((x) => x.at + ' ' + x.dir + ' ' + x.text).join('\n')
    ].join('\n');
  }

  function copyDiagnostics() {
    const text = diagnosticsText();
    transport.copyText(text).then(() => toast('Details copied. Paste them into the chat.'), () => {
      openSheet('Details', '<textarea class="input" readonly style="min-height:240px">' + esc(text) + '</textarea>');
    });
  }

  function pasteCode() {
    openSheet('Paste official-app code',
      '<p class="hint" style="margin-top:0">The official app exports a QR code. Scan it with any QR reader and paste the text here.</p>' +
      '<textarea class="input" id="pcText" placeholder="323232323232#00000000..."></textarea><p class="err" id="pcErr"></p>' +
      '<div class="btn-row"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="pcGo">Load</button></div>',
      () => {
        $('pcGo').addEventListener('click', () => {
          try {
            const r = P.parseOfficialCode($('pcText').value);
            state.points = S.fromSlots(r.slots);
            state.manual = r.manual;
            closeSheet();
            toast('Loaded. Tap Save to light to apply it.');
          } catch (e) { $('pcErr').textContent = e.message; }
        });
      },
      () => { persistWorking(); renderAll(); });
  }

  // ---- sheet & toast -----------------------------------------------------------------------------------------
  let sheetOnClose = null;
  function openSheet(title, html, onMount, onClose) {
    if (!$('sheetWrap').hidden) closeSheet();
    $('sheetTitle').textContent = title;
    const body = $('sheetBody');
    body.innerHTML = html;
    $('sheetWrap').hidden = false;
    $('sheet').scrollTop = 0; // each sheet starts at its top, not where the last one was left
    sheetOnClose = onClose || null;
    body.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
    if (onMount) onMount(body);
  }

  function closeSheet() {
    if ($('sheetWrap').hidden) return;
    $('sheetWrap').hidden = true;
    $('sheetBody').innerHTML = '';
    const cb = sheetOnClose;
    sheetOnClose = null;
    if (cb) cb();
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---- global events -----------------------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tabs button');
    if (tab) return switchView(tab.dataset.view);
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'lights') openLightsSheet();
    else if (act === 'status') {
      if (!state.light) openLightsSheet();
      else if (!connected()) { state.retries = 0; connectTo(state.light, { rescan: true }); }
      else if (state.readFailed) connectTo(state.light, { force: true, rescan: false });
      else openLightsSheet();
    }
    else if (act === 'save') saveToLight();
    else if (act === 'run-schedule') setMode(true);
    else if (act === 'add-point') addPoint(null);
    else if (act === 'edit-point') openPointEditor(state.points[+a.dataset.idx], false);
    else if (act === 'quick-setup') openQuickSetup();
    else if (act === 'presets') openPresets();
    else if (act === 'reload') { if (state.light) connectTo(state.light, { force: true }); }
    else if (act === 'sync-clock') ensureConnected().then((ok) => ok && link.sendAck(P.syncTimeFromDate(new Date())).then(() => toast('Light clock set to ' + S.fmtTime(nowMinutes()) + '.')));
    else if (act === 'wifi-setup') openWifiSetup();
    else if (act === 'export') exportBackup();
    else if (act === 'import') importBackup();
    else if (act === 'copy-code') copyCode();
    else if (act === 'copy-diag') copyDiagnostics();
    else if (act === 'blink') blink();
    else if (act === 'natural-setup') openNaturalSetup();
    else if (act === 'natural-calendar') openNaturalCalendar();
    else if (act === 'natural-send') ensureConnected().then((ok) => ok && applyNatural());
    else if (act === 'natural-off') {
      const n = natural();
      if (n) { n.enabled = false; saveNatural(n); }
      planGen++;
      clearTimeout(planTimer);
      if (transport.clearDailyPlan) transport.clearDailyPlan().catch(() => {});
      toast('Natural cycle off. Today\'s points stay on the light until you change them.');
      renderAll();
    }
    else if (act === 'paste-code') pasteCode();
    else if (act === 'par-plan') openParPlanner();
    else if (act === 'par-calibrate') openParSetup();
    else if (act === 'par-export') exportPar();
    else if (act === 'par-import') importPar();
    else if (act === 'demo-on') ensureConnected().then((ok) => ok && link.sendAck(P.setDemo(true)).then(() => toast('Demo running on the light.')));
    else if (act === 'demo-off') ensureConnected().then((ok) => ok && link.sendAck(P.setDemo(false)).then(() => toast('Demo stopped.')));
  });

  $('sheetWrap').addEventListener('click', (e) => { if (e.target === $('sheetWrap')) closeSheet(); });

  // Android back button: the native side asks us first.
  window.__noo.back = () => {
    if (!$('sheetWrap').hidden) { closeSheet(); return true; }
    if (state.view !== 'schedule') { switchView('schedule'); return true; }
    return false;
  };

  // Free the light's single connection while the app is in the background.
  let bgTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      bgTimer = setTimeout(() => { if (connected()) link.close(); }, 30000);
    } else {
      clearTimeout(bgTimer);
      if (state.light && !connected() && link.state !== 'connecting') { state.retries = 0; connectTo(state.light, { rescan: true, silent: true }); }
    }
  });

  setInterval(() => {
    const n = natural();
    if (n && n.enabled && n.lastApplied !== NN.ymd(today()) && connected() && !state.editing) applyNatural({ silent: true });
    tickClock();
    if (state.view === 'schedule' && !state.editing) refreshChart();
    renderGlass();
  }, 30000);

  // ---- start ----------------------------------------------------------------------------------------------------
  function start() {
    if (transport.kind === 'demo') $('demoBanner').hidden = false;
    const cur = store.get('current');
    const l = lights().find((x) => x.id === cur && x.name);
    if (!l) forgetUnconfirmed();
    if (l) {
      loadWorking(l);
      state.light = l;
      renderAll();
      connectTo(l, { rescan: true, silent: true });
    } else {
      renderAll();
      openLightsSheet();
    }
  }

  window.__nooApp = { state, link, store, S, P }; // for tests and debugging
  start();
})();
