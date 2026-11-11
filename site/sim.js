// Pretend cars behind a pretend ELM327, for the demo mode and the tests.
// Both speak CAN 11-bit with headers and spaces on, like real cars do:
// a petrol car (Volvo VIN) and a diesel (BMW VIN) with DPF, boost and AdBlue.

import { hex2 } from './obd.js';

const u16 = (v) => [(Math.round(v) >> 8) & 0xff, Math.round(v) & 0xff];
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));

const ENGINES = {
  petrol: {
    vin: 'YV1MK0000DEMO0001',
    supported: [0x01, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x20, 0x2f, 0x33, 0x40, 0x42, 0x46],
    // 0101: A = MIL + count, B = continuous tests (spark), C/D = available/incomplete.
    status: [0x82, 0x07, 0x65, 0x04],
    statusCleared: [0x00, 0x07, 0x65, 0x65],
    stored: { '7E8': [0x04, 0x20, 0x01, 0x71], '7E9': [0x07, 0x31] }, // P0420, P0171; P0731
    pending: [0x03, 0x00], // P0300
    live: (pid, t, rev) => ({
      0x04: [byte(20 + 60 * rev)],
      0x06: [byte(128 + 6 * Math.sin(t * 2))],
      0x07: [byte(128 + 9)],
      0x0b: [byte(35 + 120 * rev)],
      0x0e: [byte((12 + 10 * rev + 64) * 2)],
      0x10: u16((3 + 60 * rev) * 100),
      0x11: [byte(255 * (0.12 + 0.6 * rev))],
      0x2f: [byte(255 * 0.62)]
    })[pid]
  },
  diesel: {
    vin: 'WBA2C000000DEMO01',
    supported: [
      0x01, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x1f, 0x20, 0x2c, 0x33, 0x40,
      0x42, 0x46, 0x49, 0x59, 0x5e, 0x60, 0x62, 0x70, 0x78, 0x7a, 0x80, 0x85
    ],
    status: [0x81, 0x0f, 0xeb, 0x40], // diesel monitors, DPF not complete
    statusCleared: [0x00, 0x0f, 0xeb, 0xeb],
    stored: { '7E8': [0x24, 0x63], '7E9': [] }, // P2463 DPF soot accumulation
    pending: [0x04, 0x01], // P0401 EGR flow insufficient
    live: (pid, t, rev) => ({
      0x04: [byte(25 + 65 * rev)],
      0x0b: [byte(100 + 140 * rev)],
      0x10: u16((8 + 90 * rev) * 100),
      0x11: [byte(255 * (0.3 + 0.6 * rev))],
      0x2c: [byte(255 * 0.35 * (1 - rev))],
      0x49: [byte(255 * (0.15 + 0.7 * rev))],
      0x59: u16((300 + 1300 * rev) * 10),
      0x5e: u16((0.8 + 11 * rev) * 20),
      0x62: [byte(125 + 10 + 80 * rev)],
      0x70: [0x03, ...u16((105 + 150 * rev) * 32), ...u16((100 + 145 * rev) * 32), 0, 0, 0, 0, 0],
      0x78: [0x01, ...u16((260 + 280 * rev + 40) * 10), 0, 0, 0, 0, 0, 0],
      0x7a: [0x01, ...u16((0.8 + 5 * rev) * 100), 0, 0, 0, 0],
      0x85: [0x07, ...u16(40), ...u16(42), byte(255 * 0.48), 0, 0, 0, 0]
    })[pid]
  }
};

function mask(supported, base) {
  const bytes = [0, 0, 0, 0];
  for (const pid of supported) {
    const i = pid - base - 1;
    if (i >= 0 && i < 32) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return bytes;
}

// One CAN reply → ISO-TP frames as the adapter prints them.
function frames(ecu, bytes) {
  const line = (b) => [ecu, ...b.map(hex2)].join(' ');
  if (bytes.length <= 7) return [line([bytes.length, ...bytes])];
  const out = [line([0x10 | (bytes.length >> 8), bytes.length & 0xff, ...bytes.slice(0, 6)])];
  for (let i = 6, seq = 1; i < bytes.length; i += 7, seq++) out.push(line([0x20 | (seq & 0x0f), ...bytes.slice(i, i + 7)]));
  return out;
}

export class SimTransport {
  constructor({ engine = 'petrol', latency = 25, now = () => Date.now() } = {}) {
    this.car = ENGINES[engine] || ENGINES.petrol;
    this.name = engine === 'diesel' ? 'Demo diesel' : 'Demo petrol';
    this.latency = latency;
    this.now = now;
    this.start = now();
    this.cleared = false;
    this.onData = () => {};
  }

  async write(text) {
    const reply = this.respond(text.replace(/\s/g, '').toUpperCase());
    setTimeout(() => this.onData(`${reply}\r\r>`), this.latency);
  }

  async close() {}

  live(pid) {
    const t = (this.now() - this.start) / 1000;
    const rev = 0.5 + 0.5 * Math.sin(t / 3);
    const common = {
      0x05: [byte(Math.min(90, 20 + t * 2) + 40)],
      0x0c: u16((800 + 2600 * rev * rev) * 4),
      0x0d: [byte(40 + 50 * rev)],
      0x0f: [byte(18 + 40)],
      0x1f: u16(t),
      0x33: [101],
      0x42: u16(14100 + 100 * Math.sin(t)),
      0x46: [byte(7 + 40)]
    };
    if (!this.car.supported.includes(pid)) return null;
    return common[pid] || this.car.live(pid, t, rev) || null;
  }

  respond(cmd) {
    if (cmd === 'ATZ' || cmd === 'ATI') return 'ELM327 v2.3';
    if (cmd === 'ATDPN') return 'A6';
    if (cmd === 'ATRV') return `${(12.4 + 1.7 * (this.now() - this.start > 1000)).toFixed(1)}V`;
    if (cmd.startsWith('AT')) return 'OK';

    const car = this.car;
    const ecm = (...bytes) => frames('7E8', bytes);
    const tcm = (...bytes) => frames('7E9', bytes);
    const codes = (service, list) => [service, list.length / 2, ...list];
    let lines = null;
    if (/^01[02468ACE]0$/.test(cmd) && (cmd === '0100' || car.supported.includes(parseInt(cmd.slice(2), 16)))) {
      const base = parseInt(cmd.slice(2), 16);
      lines = ecm(0x41, base, ...mask(car.supported, base));
      if (base === 0) lines.push(...tcm(0x41, 0x00, 0x80, 0x00, 0x00, 0x00));
    } else if (cmd === '0101') {
      lines = ecm(0x41, 0x01, ...(this.cleared ? car.statusCleared : car.status));
    } else if (/^01[0-9A-F]{2}$/.test(cmd)) {
      const pid = parseInt(cmd.slice(2), 16);
      const data = this.live(pid);
      if (data) lines = ecm(0x41, pid, ...data);
    } else if (cmd === '03') {
      lines = this.cleared
        ? [...ecm(0x43, 0x00), ...tcm(0x43, 0x00)]
        : [...ecm(...codes(0x43, car.stored['7E8'])), ...tcm(...codes(0x43, car.stored['7E9']))];
    } else if (cmd === '07') {
      lines = ecm(...codes(0x47, this.cleared ? [] : car.pending));
    } else if (cmd === '0A') {
      lines = ecm(0x4a, 0x00);
    } else if (cmd === '04') {
      this.cleared = true;
      lines = [...ecm(0x44), ...tcm(0x44)];
    } else if (cmd === '0902') {
      lines = ecm(0x49, 0x02, 0x01, ...[...car.vin].map((c) => c.charCodeAt(0)));
    }
    return lines ? lines.join('\r') : 'NO DATA';
  }
}
