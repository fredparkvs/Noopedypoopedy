(function () {
  'use strict';
  const P = window.NooProtocol;
  const S = window.NooSchedule;
  const { createTransport, LightLink } = window.NooTransport;
  const VERSION = '1.0.1';

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
    try { st = await link.readStatus(); } catch (e) { /* shown as a banner */ }
    state.reading = false;
    state.readFailed = !st;
    if (st) applyStatus(st, force); else renderAll();
    await link.sendAck(P.syncTimeFromDate(new Date()));
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

  async function runDiscover() {
    state.scanning = true;
    state.found = [];
    refreshLightsSheet();
    const wasHost = connected() ? link.host : null;
    try {
      const hosts = await transport.scan(P.PORT);
      link.touched(hosts.filter((h) => h !== wasHost)); // the scan itself just connected to each of them
      for (const host of hosts) {
        if (state.scanAbort) break;
        if (host === wasHost && state.light) {
          state.found.push({ host, name: state.light.name, model: state.light.model });
          continue;
        }
        link.quiet = true;
        try {
          const st = await link.probe(host);
          state.found.push({ host, name: st.name, model: st.model });
          const known = lights().find((l) => l.name && l.name === st.name);
          if (known && known.host !== host) upsertLight({ id: known.id, name: known.name, host, model: st.model });
        } catch (e) {
          state.found.push({ host, name: null });
        } finally {
          link.quiet = false;
        }
        refreshLightsSheet();
      }
    } catch (e) {
      toast('Scan failed: ' + e.message);
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
      const slots = S.toSlots(state.points);
      await link.sendAck(P.setAll({ manual: state.manual, slots, auto: state.auto, time: new Date() }), 4000);
      let verified = false;
      try {
        const st = await link.readStatus();
        state.lastStatus = st;
        verified = st.scheduleValid && S.slotsEqual(st.slots, slots);
      } catch (e) { /* unverified */ }
      state.savedFp = fp();
      state.source = 'light';
      persistWorking();
      toast(verified ? 'Saved. The light confirmed the new settings.' : 'Sent to the light.');
    } catch (e) {
      toast('Save failed: ' + e.message);
    } finally {
      btn.disabled = false;
      renderSaveBar();
    }
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
    return '<div class="banner" style="display:block;border-color:#7a3b3b">' +
      '<p style="margin:0 0 8px;color:var(--ink)"><strong>The light accepted the connection but did not answer.</strong></p>' +
      '<p style="margin:0 0 8px">This usually means another app or phone is still connected to it, since the light only talks to one at a time. ' +
      'Force-stop the official app (Settings, Apps, Noo-Psyche, Force stop) and close it on any other phone. If that does not help, switch the light off for 10 seconds.</p>' +
      '<div class="btn-row"><button class="btn small" data-action="reload">Try again</button><button class="btn small" data-action="copy-diag">Copy details</button></div></div>';
  }

  function sourceNote() {
    if (!state.light || (state.readFailed && connected())) return '';
    if (state.source === 'light') return '';
    if (state.source === 'phone') return '<div class="banner"><span>Showing the copy saved on this phone. It will be replaced by what is on the light once it connects, unless you have unsaved changes.</span></div>';
    if (state.source === 'factory') return '<div class="banner"><span>Showing the factory LPS schedule until the light sends its own.</span></div>';
    return '';
  }

  function renderSchedule() {
    const v = $('view-schedule');
    if (!state.light) {
      v.innerHTML = '<div class="card"><h2>Find your light</h2><p class="sub">Your phone needs to be on the same WiFi as the light, or connected to the light\'s own K7 hotspot.</p>' +
        '<div class="btn-row"><button class="btn primary" data-action="lights">Find my light</button></div></div>' +
        '<div class="card"><h2>Preview</h2>' + '<div id="chartBox">' + chartSvg(state.points) + '</div></div>';
      return;
    }
    const sorted = state.points.slice().sort((a, b) => a.t - b.t);
    const ch = channels();
    const conflictHours = S.conflicts(state.points);
    let html = silentBanner();
    if (!state.auto && !state.readFailed) html += '<div class="banner"><span><strong>Manual mode.</strong> The light is ignoring this schedule.</span><button class="btn small" data-action="run-schedule">Run schedule</button></div>';
    html += sourceNote();
    html += '<div class="card"><div class="row spread"><h2>Today</h2><span class="hint num" id="clock"></span></div>' +
      '<div id="chartBox">' + chartSvg(state.points, null) + '</div>' +
      '<div id="nowBox">' + nowBars(currentOutput()) + '</div>' +
      '<p class="hint" style="margin:10px 0 0">Tap the chart to add or edit a point.</p></div>';
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
          toast('Saved "' + name + '" on this phone.');
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
      toast('Scene "' + name + '" saved on this phone.');
    });
    const clr = $('sceneClear');
    if (clr) clr.addEventListener('click', () => { store.set('scenes', []); renderManual(); });
  }

  // ---- lights & backup view ------------------------------------------------------------------------------
  function renderMore() {
    const v = $('view-more');
    const l = state.light;
    const st = state.lastStatus;
    const names = channels();
    v.innerHTML =
      '<div class="card"><h2>This light</h2>' +
      (l ? '<ul class="list">' +
        '<li><span class="sub-t">Name</span><span class="main-t">' + esc(l.name || 'unknown') + '</span></li>' +
        '<li><span class="sub-t">Address</span><span class="num">' + esc(l.host) + '</span></li>' +
        '<li><span class="sub-t">Type</span><span>' + (state.model === 'mini' ? 'K7 Mini, 3 channels' : 'K7 / K7 Pro, 6 channels') + '</span></li>' +
        '<li><span class="sub-t">Mode</span><span>' + (state.auto ? 'Schedule' : 'Manual') + '</span></li></ul>' +
        '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="reload">Reload from light</button><button class="btn" data-action="sync-clock">Set light clock</button></div>'
        : '<p class="hint">No light selected.</p>') +
      '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="lights">Switch or find lights</button><button class="btn" data-action="wifi-setup">Put a light on WiFi</button></div></div>' +

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
    const savedHosts = saved.map((l) => l.host);
    const extra = state.found.filter((f) => !saved.some((l) => (f.name && l.name === f.name) || l.host === f.host));
    let html = '';
    html += '<ul class="list">' + saved.map((l) => '<li><div><div class="main-t">' + esc(displayName(l)) + (l.id === cur ? ' <span class="hint">(current)</span>' : '') + '</div>' +
      '<div class="sub-t num">' + esc(l.host) + (l.model === 'mini' ? ', K7 Mini' : '') + '</div></div>' +
      '<div class="row"><button class="btn small" data-use="' + esc(l.id) + '">' + (l.id === cur ? 'Reconnect' : 'Use') + '</button>' +
      '<button class="btn small quiet" data-forget="' + esc(l.id) + '" aria-label="Forget ' + esc(displayName(l)) + '">Forget</button></div></li>').join('') + '</ul>';
    if (!saved.length) html += '<p class="hint" style="margin-top:0">No lights saved yet.</p>';
    if (extra.length) {
      html += '<h2 style="font-size:var(--fs-md);margin:14px 0 4px">Found on this network</h2><ul class="list">' + extra.map((f) => '<li><div><div class="main-t">' + esc(f.name || 'Unknown device') + '</div><div class="sub-t num">' + esc(f.host) + '</div></div>' +
        '<button class="btn small" data-add="' + esc(f.host) + '">Use</button></li>').join('') + '</ul>';
    }
    if (state.found.length && !extra.length && !state.scanning) html += '<p class="hint">No other lights found.</p>';
    html += '<div class="btn-row" style="margin-top:14px"><button class="btn primary" id="lsScan"' + (state.scanning ? ' disabled' : '') + '>' + (state.scanning ? 'Searching the network' : 'Search the network') + '</button></div>' +
      '<label class="field" style="margin:12px 0 0"><span>Or connect by IP address</span><div class="row"><input class="input num" id="lsIp" placeholder="192.168.1.50" inputmode="decimal" style="flex:1"><button class="btn" id="lsIpGo">Connect</button></div></label>' +
      '<p class="hint">On the light\'s own K7 hotspot? Search finds it too. To move a light onto your home WiFi, use "Put a light on WiFi".</p>' +
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
    else if (act === 'paste-code') pasteCode();
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
    tickClock();
    if (state.view === 'schedule' && !state.editing) refreshChart();
    renderGlass();
  }, 30000);

  // ---- start ----------------------------------------------------------------------------------------------------
  function start() {
    if (transport.kind === 'demo') $('demoBanner').hidden = false;
    const cur = store.get('current');
    const l = lights().find((x) => x.id === cur);
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
