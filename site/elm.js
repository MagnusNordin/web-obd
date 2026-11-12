// Talking to an ELM327-compatible adapter (vLinker FD+, OBDLink, clones).
//
// A transport moves text: write(text) sends, onData(text) receives, close().
// Elm327 turns that into request/response: send "010C", wait for the ">"
// prompt, return what came before it. Commands are queued, one at a time.

import {
  cleanResponse, parseMessages, parseProtocol, protocolName, pidReply,
  decodeSupported, decodeStatus, decodeDtcs, decodeVin
} from './obd.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// BLE serial services used by ELM327 adapters. vLinker uses 18F0; clones
// often use FFF0 or FFE0. The app picks whichever the adapter exposes.
// Written out in full: some iOS Bluetooth browsers (Bluefy) reject the short
// numeric form that the standard allows.
export const fullUuid = (id) =>
  typeof id === 'number' ? `0000${id.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb` : id.toLowerCase();
const BLE_SERVICES = [
  0x18f0, 0xfff0, 0xffe0, 0xffe5, 0xbeef,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
].map(fullUuid);

// Some error values (e.g. from Bluefy on iOS) are bare codes like 2, not Error objects.
export function describeError(err) {
  if (err == null) return 'unknown error';
  if (typeof err !== 'object') return `code ${err}`;
  const text = [err.name && err.name !== 'Error' ? err.name : '', err.message || ''].filter(Boolean).join(': ');
  if (text) return text;
  try { return JSON.stringify(err); } catch { return String(err); }
}

const isCancel = (err) => err?.name === 'NotFoundError' || /cancel/i.test(err?.message || '');

// Runs one Bluetooth step and names it in the error, so failures say where they happened.
async function stage(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isCancel(err) && label === 'choosing the device') throw Object.assign(new Error('Cancelled'), { name: 'NotFoundError' });
    const hint = err === 2 || err === '2'
      ? ' On iPhone, check that the browser may use Bluetooth (Settings → Privacy & Security → Bluetooth).'
      : '';
    throw new Error(`Bluetooth failed while ${label} (${describeError(err)}).${hint}`);
  }
}

// Every service the adapter exposes: all at once where the browser can,
// otherwise by asking for each known serial service in turn (Bluefy).
async function findServices(server) {
  try {
    const all = await server.getPrimaryServices();
    if (all.length) return all;
  } catch { /* fall back below */ }
  const found = [];
  for (const uuid of BLE_SERVICES) {
    try { found.push(await server.getPrimaryService(uuid)); } catch { /* not on this adapter */ }
  }
  return found;
}

// For browsers that can't list every device: only OBD adapter names and services.
const ADAPTER_FILTERS = [
  ...['vLinker', 'VLINKER', 'Vlinker', 'V-LINK', 'IOS-Vlink', 'Android-Vlink', 'OBD', 'Obd', 'obd', 'ELM', 'OBDLink', 'Viecar', 'KONNWEI', 'Veepeak', 'VEEPEAK']
    .map((namePrefix) => ({ namePrefix })),
  ...BLE_SERVICES.map((uuid) => ({ services: [uuid] }))
];

// Ways to ask for the device, tried in turn after failures:
// all devices; only likely OBD adapters; all devices with no service list (bare minimum).
export const SEARCH_MODES = ['all', 'filtered', 'basic'];
const SEARCH = {
  all: { label: 'Choose the adapter in the Bluetooth list', options: { acceptAllDevices: true, optionalServices: BLE_SERVICES } },
  filtered: { label: 'Choose the adapter (searching for OBD adapters only)', options: { filters: ADAPTER_FILTERS, optionalServices: BLE_SERVICES } },
  basic: { label: 'Choose the adapter (basic search)', options: { acceptAllDevices: true } }
};

export async function connectBluetooth(onDisconnect, step = () => {}, { mode = 'all' } = {}) {
  const search = SEARCH[mode] || SEARCH.all;
  step(search.label);
  const options = search.options;
  const device = await stage('choosing the device', () => navigator.bluetooth.requestDevice(options));
  device.addEventListener('gattserverdisconnected', () => onDisconnect?.());
  step(`Connecting to ${device.name || 'the adapter'}`);
  const server = await stage('connecting to the adapter', () => device.gatt.connect());
  step('Looking for the serial service');
  const services = await stage('looking for services', () => findServices(server));
  let write = null;
  let notify = null;
  for (const service of services) {
    let chars;
    try { chars = await service.getCharacteristics(); } catch { continue; }
    const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    const n = chars.find((c) => c.properties.notify || c.properties.indicate);
    if (w && n) { write = w; notify = n; break; }
  }
  if (!write || !notify) {
    device.gatt.disconnect();
    const ids = services.map((sv) => sv.uuid).join(', ') || 'none';
    throw new Error(`This Bluetooth device has no serial service the app recognises (services found: ${ids}). Is it the OBD adapter?`);
  }
  const transport = {
    name: device.name || 'Bluetooth adapter',
    onData: () => {},
    async write(text) {
      const bytes = encoder.encode(text);
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        if (write.properties.writeWithoutResponse && write.writeValueWithoutResponse) await write.writeValueWithoutResponse(chunk);
        else await write.writeValue(chunk);
      }
    },
    async close() { if (device.gatt.connected) device.gatt.disconnect(); }
  };
  notify.addEventListener('characteristicvaluechanged', (e) => transport.onData(decoder.decode(e.target.value)));
  await stage('starting notifications', () => notify.startNotifications());
  return transport;
}

export async function connectSerial(baudRate, onDisconnect) {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const transport = {
    name: 'Serial adapter',
    onData: () => {},
    async write(text) { await writer.write(encoder.encode(text)); },
    async close() {
      try { await reader.cancel(); } catch { /* already closed */ }
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    }
  };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        transport.onData(decoder.decode(value));
      }
    } catch { /* port lost */ }
    onDisconnect?.();
  })();
  return transport;
}

export class Elm327 {
  constructor(transport, onTraffic = () => {}) {
    this.transport = transport;
    this.onTraffic = onTraffic;
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    transport.onData = (text) => this.receive(text);
  }

  receive(text) {
    this.buffer += text;
    const end = this.buffer.indexOf('>');
    if (end === -1) return;
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    const pending = this.pending;
    this.pending = null;
    if (pending) pending.resolve(raw);
  }

  send(cmd, timeout = 5000) {
    const run = () => new Promise((resolve, reject) => {
      this.buffer = '';
      const timer = setTimeout(() => {
        this.pending = null;
        this.onTraffic(cmd, '(no reply)');
        reject(new Error(`No reply from the adapter to ${cmd}`));
      }, timeout);
      this.pending = {
        resolve: (raw) => { clearTimeout(timer); this.onTraffic(cmd, raw); resolve(raw); }
      };
      this.transport.write(cmd + '\r').catch((err) => { clearTimeout(timer); this.pending = null; reject(err); });
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

// OBD-II on top of the adapter.
export class ObdClient {
  constructor(elm) {
    this.elm = elm;
    this.protocol = 0;
    this.adapter = '';
    this.supported = [];
  }

  // Resets the adapter and finds the car's protocol. step(text) reports progress.
  async init(step = () => {}) {
    step('Resetting adapter');
    await this.elm.send('ATZ', 4000).catch(() => this.elm.send('ATZ', 4000));
    for (const cmd of ['ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATAT1', 'ATSP0']) await this.elm.send(cmd);
    this.adapter = cleanResponse(await this.elm.send('ATI')).lines.join(' ');

    step('Searching for the car (ignition must be on)');
    const first = await this.elm.send('0100', 15000);
    const check = cleanResponse(first, '0100');
    if (check.error) throw new Error(`The car did not answer (${check.error}). Turn the ignition to position II or start the engine, then try again.`);
    this.protocol = parseProtocol(cleanResponse(await this.elm.send('ATDPN')).lines.join(''));

    step('Reading supported data');
    this.supported = decodeSupported(pidReply(parseMessages(check.lines, this.protocol), 0x00), 0x00);
    for (const base of [0x20, 0x40, 0x60, 0x80]) {
      if (!this.supported.includes(base)) break;
      const reply = await this.query(`01${base.toString(16).padStart(2, '0')}`);
      this.supported.push(...decodeSupported(pidReply(reply.messages, base), base));
    }
    return { adapter: this.adapter, protocol: protocolName(this.protocol) };
  }

  async query(cmd, timeout = 5000) {
    const { lines, error } = cleanResponse(await this.elm.send(cmd, timeout), cmd);
    return { error, messages: error ? [] : parseMessages(lines, this.protocol) };
  }

  async batteryVoltage() {
    const { lines } = cleanResponse(await this.elm.send('ATRV'), 'ATRV');
    const v = parseFloat(lines.join(''));
    return Number.isFinite(v) ? v : null;
  }

  async vin() {
    const { messages } = await this.query('0902');
    return decodeVin(messages, this.protocol);
  }

  async status() {
    const { messages } = await this.query('0101');
    return decodeStatus(pidReply(messages, 0x01));
  }

  async dtcs() {
    const out = [];
    for (const [mode, kind] of [[3, 'stored'], [7, 'pending'], [0x0a, 'permanent']]) {
      const { messages } = await this.query(`0${mode.toString(16).toUpperCase()}`, 8000);
      for (const d of decodeDtcs(messages, mode, this.protocol)) out.push({ ...d, kind });
    }
    return out;
  }

  async clearDtcs() {
    const { error } = await this.query('04', 10000);
    if (error) throw new Error(`Clearing failed: ${error}. Engine must be off with ignition on.`);
  }

  async readPid(pid) {
    const { messages } = await this.query(`01${pid.toString(16).toUpperCase().padStart(2, '0')}`);
    return pidReply(messages, pid);
  }
}
