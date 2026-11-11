// OBD reader (site/obd/): decoding of ELM327 replies, and the client end to end
// against the simulated car.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanResponse, parseProtocol, parseMessages, dtcCode, decodeDtcs, decodeSupported,
  decodeVin, decodeStatus, pidReply, ecuName, PIDS
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
