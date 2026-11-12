// UI for the OBD reader: connect, vehicle info, fault codes, readiness, live data.

import { Elm327, ObdClient, connectBluetooth, connectSerial, describeError } from './elm.js';
import { SimTransport } from './sim.js';
import { PIDS, PID_ORDER, ecuName, decodePid, vinMake } from './obd.js';
import { describeDtc } from './dtc-codes.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let transport = null;
let obd = null;
let live = false;
let recording = null;
let make = null;
// After a failed device search, the next try lists only OBD adapters.
let bleFiltered = false;
const unsupported = new Set();

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `pill ${kind}`;
}

function showError(err) {
  $('error').hidden = !err;
  $('error').textContent = err ? (err instanceof Error ? err.message : `Error: ${describeError(err)}`) : '';
}

function log(cmd, raw) {
  const pre = $('log');
  const reply = String(raw).replace(/\r+/g, '\n  ').trim();
  pre.textContent += `> ${cmd}\n  ${reply}\n`;
  if (pre.textContent.length > 40000) pre.textContent = pre.textContent.slice(-30000);
  pre.scrollTop = pre.scrollHeight;
}

function step(text) {
  const list = $('steps');
  list.lastElementChild?.classList.add('done');
  list.append(el('li', '', text));
}

function setBusy(busy) {
  for (const id of ['btn-ble', 'btn-serial', 'btn-demo', 'btn-demo-diesel']) $(id).disabled = busy || Boolean(obd) || unsupported.has(id);
}

async function connect(kind, demo = 'petrol') {
  showError(null);
  $('steps').replaceChildren();
  setBusy(true);
  setStatus('Connecting…', 'busy');
  try {
    if (kind === 'ble') transport = await connectBluetooth(onLost, step, { filtered: bleFiltered });
    else if (kind === 'serial') transport = await connectSerial(Number($('baud').value), onLost);
    else transport = new SimTransport({ engine: demo });
    step(`Connected to ${transport.name}`);
    const client = new ObdClient(new Elm327(transport, log));
    const info = await client.init(step);
    obd = client;
    step('Ready');
    $('steps').lastElementChild.classList.add('done');
    $('adapter').textContent = info.adapter || '–';
    $('protocol').textContent = info.protocol;
    setStatus(transport.name, 'on');
    for (const id of ['vehicle', 'faults', 'readiness', 'live', 'console']) $(id).hidden = false;
    $('btn-disconnect').hidden = false;
    buildGauges();
    await refreshVehicle();
    await readCodes();
  } catch (err) {
    if (err?.name === 'NotFoundError') showError(null); // user closed the device picker
    else if (kind === 'ble' && !obd && /choosing the device/.test(err?.message) && !bleFiltered) {
      bleFiltered = true;
      showError(new Error(`${err.message} Press Bluetooth again to try a search for OBD adapters only.`));
    } else showError(err);
    await disconnect();
  } finally {
    setBusy(false);
  }
}

function onLost() {
  if (!obd) return;
  showError(new Error('Lost the connection to the adapter.'));
  disconnect();
}

async function disconnect() {
  live = false;
  obd = null;
  make = null;
  const t = transport;
  transport = null;
  try { await t?.close(); } catch { /* already gone */ }
  setStatus('Not connected');
  for (const id of ['vehicle', 'faults', 'readiness', 'live', 'console']) $(id).hidden = true;
  $('btn-disconnect').hidden = true;
  $('btn-live').textContent = 'Start';
  stopRecording(false);
  setBusy(false);
}

async function refreshVehicle() {
  const vin = await obd.vin().catch(() => null);
  make = vinMake(vin);
  $('vin').textContent = vin ? `${vin}${make ? ` (${make})` : ''}` : 'Not reported';
  await refreshBattery();
}

async function refreshBattery() {
  const v = await obd?.batteryVoltage().catch(() => null);
  if (v != null) $('battery').textContent = `${v.toFixed(1)} V ${v < 12.2 ? '(low)' : v > 13.2 ? '(charging)' : ''}`;
}

async function readCodes() {
  const button = $('btn-read');
  button.disabled = true;
  try {
    const status = await obd.status();
    const mil = $('mil');
    if (status) {
      mil.className = `mil ${status.mil ? 'on' : 'off'}`;
      mil.textContent = status.mil
        ? `Check-engine light ON · ${status.count} code(s) reported`
        : `Check-engine light off · ${status.count} code(s) reported`;
      renderReadiness(status);
    } else {
      mil.className = 'mil';
      mil.textContent = 'Could not read engine status';
    }
    renderCodes(await obd.dtcs());
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

function renderCodes(codes) {
  const list = $('dtc-list');
  if (codes.length === 0) {
    list.replaceChildren(el('li', 'none', 'No fault codes stored. 👍'));
    return;
  }
  const kindText = { stored: 'Stored', pending: 'Pending (seen once, not confirmed)', permanent: 'Permanent (clears itself after repair)' };
  list.replaceChildren(...codes.map((d) => {
    const li = el('li', d.kind);
    const head = el('div', 'dtc-head');
    head.append(el('span', 'dtc-code', d.code), el('span', 'dtc-meta', `${ecuName(d.ecu)} · ${kindText[d.kind]}`));
    const desc = describeDtc(d.code);
    const text = el('div', 'dtc-text', desc.text);
    const a = el('a', '', desc.known ? 'Search' : 'Look up');
    a.href = `https://www.google.com/search?q=${encodeURIComponent(`${make ? `${make} ` : ''}${d.code}`)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    text.append(a);
    li.append(head, text);
    return li;
  }));
}

function renderReadiness(status) {
  const list = $('ready-list');
  list.replaceChildren(...status.tests.map((t) => {
    const li = el('li');
    li.append(el('span', '', t.name), el('span', t.complete ? 'ok' : 'no', t.complete ? 'Complete' : 'Not complete'));
    return li;
  }));
  if (status.tests.length === 0) list.replaceChildren(el('li', '', 'No monitors reported'));
}

async function clearCodes() {
  const dialog = $('confirm-clear');
  dialog.returnValue = '';
  dialog.showModal();
  await new Promise((r) => dialog.addEventListener('close', r, { once: true }));
  if (dialog.returnValue !== 'clear') return;
  try {
    await obd.clearDtcs();
    await readCodes();
  } catch (err) {
    showError(err);
  }
}

function livePids() {
  return PID_ORDER.filter((pid) => obd?.supported.includes(pid));
}

function buildGauges() {
  const pids = livePids();
  $('gauges').replaceChildren(...pids.map((pid) => {
    const def = PIDS[pid];
    const g = el('div', 'gauge stale');
    g.dataset.pid = pid;
    const value = el('div', 'value', '–');
    value.append(el('span', 'unit', def.unit));
    const bar = el('div', 'bar');
    bar.append(el('i'));
    g.append(el('div', 'label', def.name), value, bar);
    return g;
  }));
  if (pids.length === 0) $('gauges').replaceChildren(el('p', 'hint', 'The car reported no live data the app knows.'));
}

function showValue(pid, v) {
  const g = $('gauges').querySelector(`[data-pid="${pid}"]`);
  if (!g) return;
  const def = PIDS[pid];
  g.classList.toggle('stale', v == null);
  g.querySelector('.value').firstChild.textContent = v == null ? '–' : v.toFixed(def.digits);
  const pct = v == null ? 0 : Math.max(0, Math.min(100, ((v - def.min) / (def.max - def.min)) * 100));
  g.querySelector('.bar i').style.width = `${pct}%`;
}

async function toggleLive() {
  if (live) {
    live = false;
    return;
  }
  live = true;
  $('btn-live').textContent = 'Stop';
  $('btn-rec').disabled = false;
  const pids = livePids();
  let count = 0;
  let since = performance.now();
  let cycle = 0;
  while (live && obd) {
    const row = { time: new Date().toISOString() };
    for (const pid of pids) {
      if (!live || !obd) break;
      try {
        const bytes = await obd.readPid(pid);
        const v = decodePid(pid, bytes);
        showValue(pid, v);
        row[pid] = v;
        count++;
      } catch (err) {
        showValue(pid, null);
      }
    }
    if (recording) recording.push(row);
    if (++cycle % 10 === 0) await refreshBattery();
    const now = performance.now();
    if (now - since > 2000) {
      $('rate').textContent = `${((count * 1000) / (now - since)).toFixed(1)} values/s`;
      count = 0;
      since = now;
    }
  }
  live = false;
  $('btn-live').textContent = 'Start';
  $('rate').textContent = '';
  stopRecording(true);
  $('btn-rec').disabled = true;
}

function toggleRecording() {
  if (recording) stopRecording(true);
  else {
    recording = [];
    $('btn-rec').textContent = 'Stop & save CSV';
  }
}

function stopRecording(save) {
  const rows = recording;
  recording = null;
  $('btn-rec').textContent = 'Record CSV';
  if (!save || !rows || rows.length === 0) return;
  const pids = livePids();
  const header = ['time', ...pids.map((p) => `${PIDS[p].name} (${PIDS[p].unit})`)];
  const lines = [header, ...rows.map((r) => [r.time, ...pids.map((p) => (r[p] == null ? '' : r[p].toFixed(3)))])];
  const csv = lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `obd-log-${rows[0].time.slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function sendRaw(e) {
  e.preventDefault();
  const cmd = $('term-in').value.trim().toUpperCase();
  if (!cmd || !obd) return;
  $('term-in').value = '';
  try {
    await obd.elm.send(cmd, 10000); // reply goes to the log
  } catch (err) {
    log(cmd, err.message);
  }
}

function checkSupport() {
  const notes = [];
  if (!window.isSecureContext) notes.push('Open this page over https:// or localhost: browsers block Bluetooth and serial access elsewhere.');
  if (!navigator.bluetooth) {
    unsupported.add('btn-ble');
    notes.push('This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows, macOS or ChromeOS. On iPhone, use the Bluefy browser.');
  }
  if (!navigator.serial) {
    unsupported.add('btn-serial');
    $('baud-row').hidden = true;
  }
  $('support').textContent = notes.join(' ');
  setBusy(false);
}

$('btn-ble').addEventListener('click', () => connect('ble'));
$('btn-serial').addEventListener('click', () => connect('serial'));
$('btn-demo').addEventListener('click', () => connect('demo', 'petrol'));
$('btn-demo-diesel').addEventListener('click', () => connect('demo', 'diesel'));
$('btn-disconnect').addEventListener('click', disconnect);
$('btn-read').addEventListener('click', readCodes);
$('btn-clear').addEventListener('click', clearCodes);
$('btn-live').addEventListener('click', toggleLive);
$('btn-rec').addEventListener('click', toggleRecording);
$('term').addEventListener('submit', sendRaw);
checkSupport();
$('version').textContent = `Version ${document.querySelector('meta[name=version]').content.slice(0, 7)}`;
const demoParam = new URLSearchParams(location.search).get('demo');
if (demoParam !== null) connect('demo', demoParam === 'diesel' ? 'diesel' : 'petrol');
