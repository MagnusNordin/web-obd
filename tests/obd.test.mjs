// OBD reader (site/obd/): decoding of ELM327 replies, and the client end to end
// against the simulated car.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanResponse, parseProtocol, parseMessages, dtcCode, decodeDtcs, decodeSupported,
  decodeVin, decodeStatus, pidReply, ecuName, PIDS, PID_ORDER, decodePid, vinMake
} from '../site/obd.js';
import { describeDtc } from '../site/dtc-codes.js';
import { Elm327, ObdClient } from '../site/elm.js';
import { SimTransport } from '../site/sim.js';

test('cleanResponse drops echo and search noise, reports errors', () => {
  assert.deepEqual(cleanResponse('010C\rSEARCHING...\r7E8 04 41 0C 1A F8\r\r', '010C'),
    { lines: ['7E8 04 41 0C 1A F8'], error: null });
  assert.deepEqual(cleanResponse('NO DATA\r\r', '0105'), { lines: [], error: 'NO DATA' });
  assert.equal(cleanResponse('?\r', 'XYZ').error, 'Unknown command');
});

test('parseProtocol reads ATDPN', () => {
  assert.equal(parseProtocol('A6'), 6);
  assert.equal(parseProtocol('7'), 7);
});

test('CAN single frames from two ECUs decode to stored codes', () => {
  const lines = ['7E8 06 43 02 04 20 01 71', '7E9 04 43 01 07 31'];
  const msgs = parseMessages(lines, 6);
  assert.deepEqual(decodeDtcs(msgs, 3, 6), [
    { code: 'P0420', ecu: '7E8' }, { code: 'P0171', ecu: '7E8' }, { code: 'P0731', ecu: '7E9' }
  ]);
  assert.equal(ecuName('7E9'), 'Transmission (TCM)');
});

test('CAN multi-frame reply is reassembled (VIN)', () => {
  const lines = ['7E8 10 14 49 02 01 59 56 31', '7E8 21 4D 4B 30 30 30 30 44', '7E8 22 45 4D 4F 30 30 30 31'];
  assert.equal(decodeVin(parseMessages(lines, 6), 6), 'YV1MK0000DEMO0001');
});

test('29-bit CAN and non-CAN replies parse', () => {
  const ext = parseMessages(['18 DA F1 10 04 41 0C 1A F8'], 7);
  assert.deepEqual(pidReply(ext, 0x0c), [0x1a, 0xf8]);
  assert.equal(ecuName('18DAF110'), 'Engine (ECM)');
  const kwp = parseMessages(['48 6B 10 43 01 33 04 20 00 00 C4'], 3);
  assert.deepEqual(decodeDtcs(kwp, 3, 3).map((d) => d.code), ['P0133', 'P0420']);
});

test('dtc letters and descriptions', () => {
  assert.equal(dtcCode(0x01, 0x71), 'P0171');
  assert.equal(dtcCode(0xc1, 0x00), 'U0100');
  assert.equal(dtcCode(0x42, 0x2f), 'C022F');
  assert.equal(describeDtc('P0420').known, true);
  assert.match(describeDtc('P0399').text, /ignition/);
  assert.match(describeDtc('P1234').text, /Manufacturer/);
});

test('supported PIDs, status and live decoders', () => {
  assert.deepEqual(decodeSupported([0x80, 0x00, 0x00, 0x01], 0x00), [0x01, 0x20]);
  const s = decodeStatus([0x82, 0x07, 0x65, 0x04]);
  assert.equal(s.mil, true);
  assert.equal(s.count, 2);
  assert.equal(s.diesel, false);
  assert.equal(s.tests.find((t) => t.name === 'Evaporative system').complete, false);
  assert.equal(s.tests.find((t) => t.name === 'Catalyst').complete, true);
  assert.equal(decodeStatus([0x00, 0x0f, 0x40, 0x40]).tests.at(-1).name, 'Particulate filter (DPF)');
  assert.equal(PIDS[0x0c].decode([0x1a, 0xf8]), 1726);
  assert.equal(PIDS[0x05].decode([0x7b]), 83);
});

test('client against the simulated car: init, VIN, codes, clear, live data', async () => {
  const traffic = [];
  const obd = new ObdClient(new Elm327(new SimTransport({ latency: 1 }), (c) => traffic.push(c)));
  const info = await obd.init();
  assert.match(info.protocol, /CAN \(11 bit, 500/);
  assert.ok(obd.supported.includes(0x0c) && obd.supported.includes(0x42));
  assert.equal(await obd.vin(), 'YV1MK0000DEMO0001');
  assert.equal((await obd.status()).mil, true);
  const codes = await obd.dtcs();
  assert.deepEqual(codes.map((d) => `${d.code}/${d.kind}`), ['P0420/stored', 'P0171/stored', 'P0731/stored', 'P0300/pending']);
  await obd.clearDtcs();
  assert.deepEqual(await obd.dtcs(), []);
  assert.equal((await obd.status()).mil, false);
  const rpm = PIDS[0x0c].decode(await obd.readPid(0x0c));
  assert.ok(rpm >= 800 && rpm <= 3400, `rpm ${rpm}`);
  assert.equal(await obd.readPid(0x5c), null); // unsupported → NO DATA
  assert.ok(traffic.includes('ATSP0'));
});

test('diesel PIDs decode, and report null when the car has no such sensor', () => {
  assert.equal(decodePid(0x70, [0x02, 0, 0, 0x1f, 0x40, 0, 0, 0, 0, 0]), 2.5); // 8000/32 kPa = 2.5 bar
  assert.equal(decodePid(0x70, [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(decodePid(0x7a, [0x01, 0x01, 0xf4, 0, 0, 0, 0]), 5);
  assert.equal(decodePid(0x7a, [0x01, 0xff, 0x9c, 0, 0, 0, 0]), -1); // signed
  assert.equal(decodePid(0x78, [0x02, 0, 0, 0x16, 0xa8, 0, 0, 0, 0]), 540); // sensor 2 only
  assert.equal(decodePid(0x85, [0x04, 0, 0, 0, 0, 0x80, 0, 0, 0, 0]).toFixed(1), '50.2');
  assert.equal(decodePid(0x59, [0x2e, 0xe0]), 1200);
  assert.equal(decodePid(0x5e, [0x00, 0xc8]), 10);
  assert.equal(decodePid(0x62, [0xaf]), 50);
  assert.equal(decodePid(0x0c, []), null);
  assert.equal(decodePid(0x99, [1]), null);
});

test('vinMake reads the maker from the VIN', () => {
  assert.equal(vinMake('WBA2C000000DEMO01'), 'BMW');
  assert.equal(vinMake('YV1MK0000DEMO0001'), 'Volvo');
  assert.equal(vinMake('WMWXM510X02A00000'), 'MINI');
  assert.equal(vinMake('XXX00000000000000'), null);
  assert.equal(vinMake(null), null);
});

test('diesel demo car: supported ranges up to 0x85, diesel monitors, DPF code, live values', async () => {
  const obd = new ObdClient(new Elm327(new SimTransport({ engine: 'diesel', latency: 1 })));
  await obd.init();
  for (const pid of [0x59, 0x5e, 0x62, 0x70, 0x78, 0x7a, 0x85]) assert.ok(obd.supported.includes(pid), `0x${pid.toString(16)}`);
  assert.equal(vinMake(await obd.vin()), 'BMW');
  const status = await obd.status();
  assert.equal(status.diesel, true);
  assert.equal(status.tests.find((t) => t.name === 'Particulate filter (DPF)').complete, false);
  assert.deepEqual((await obd.dtcs()).map((d) => `${d.code}/${d.kind}`), ['P2463/stored', 'P0401/pending']);
  const boost = decodePid(0x70, await obd.readPid(0x70));
  assert.ok(boost > 0.9 && boost < 2.6, `boost ${boost}`);
  const egt = decodePid(0x78, await obd.readPid(0x78));
  assert.ok(egt >= 250 && egt <= 560, `egt ${egt}`);
  assert.ok(decodePid(0x7a, await obd.readPid(0x7a)) > 0);
  assert.equal(Math.round(decodePid(0x85, await obd.readPid(0x85))), 48);
});

test('every live PID has a place in the tile order, once', () => {
  assert.deepEqual([...PID_ORDER].sort((a, b) => a - b), Object.keys(PIDS).map(Number).sort((a, b) => a - b));
});

// A fake Web Bluetooth stack: an adapter with one serial service (FFF0).
function fakeBluetooth({ requestError, listAllFails = false } = {}) {
  const props = (p) => ({ write: false, writeWithoutResponse: false, notify: false, indicate: false, ...p });
  const notify = {
    properties: props({ notify: true }),
    listeners: [],
    addEventListener(_, fn) { this.listeners.push(fn); },
    async startNotifications() {}
  };
  const write = {
    properties: props({ write: true }),
    async writeValue(bytes) {
      // Answer every command like an adapter would.
      const reply = new TextEncoder().encode('OK\r\r>');
      setTimeout(() => notify.listeners.forEach((fn) => fn({ target: { value: reply } })), 1);
      return bytes;
    }
  };
  const service = { uuid: '0000fff0-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [write, notify] };
  const server = {
    async getPrimaryServices() { if (listAllFails) throw 2; return [service]; },
    async getPrimaryService(uuid) { if (uuid === 0xfff0) return service; throw new Error('NotFound'); }
  };
  const device = {
    name: 'vLinker FD', addEventListener() {},
    gatt: { connected: true, connect: async () => server, disconnect() {} }
  };
  return { requestDevice: async () => { if (requestError !== undefined) throw requestError; return device; } };
}

function withBluetooth(bt, fn) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: bt }, configurable: true });
  return fn().finally(() => Object.defineProperty(globalThis, 'navigator', before));
}

test('Bluetooth errors that are bare codes say which step failed', async () => {
  const { connectBluetooth, describeError } = await import('../site/elm.js');
  assert.equal(describeError(2), 'code 2');
  assert.equal(describeError(new DOMException('Timed out', 'NetworkError')), 'NetworkError: Timed out');
  await withBluetooth(fakeBluetooth({ requestError: 2 }), () =>
    assert.rejects(connectBluetooth(), /while choosing the device \(code 2\)/));
  await withBluetooth(fakeBluetooth({ requestError: new DOMException('User cancelled', 'NotFoundError') }), () =>
    assert.rejects(connectBluetooth(), (e) => e.name === 'NotFoundError'));
});

test('Bluetooth finds the serial service one by one when listing all fails (Bluefy)', async () => {
  const { connectBluetooth } = await import('../site/elm.js');
  await withBluetooth(fakeBluetooth({ listAllFails: true }), async () => {
    const steps = [];
    const t = await connectBluetooth(() => {}, (s) => steps.push(s));
    assert.equal(t.name, 'vLinker FD');
    assert.equal(await new Elm327(t).send('ATE0'), 'OK\r\r');
    assert.deepEqual(steps, ['Choose the adapter in the Bluetooth list', 'Connecting to vLinker FD', 'Looking for the serial service']);
  });
});
