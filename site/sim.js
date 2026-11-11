// A pretend car behind a pretend ELM327, for the demo mode and the tests.
// Speaks CAN 11-bit with headers and spaces on, like a real C30 would.

import { hex2 } from './obd.js';

const SUPPORTED = [0x01, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x20, 0x2f, 0x33, 0x40, 0x42, 0x46];
const VIN = 'YV1MK0000DEMO0001';

function mask(base) {
  const bytes = [0, 0, 0, 0];
  for (const pid of SUPPORTED) {
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
  constructor({ latency = 25, now = () => Date.now() } = {}) {
    this.name = 'Demo car';
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
    const rpm = 800 + 2600 * rev * rev;
    const coolant = Math.min(90, 20 + t * 2);
    const u16 = (v) => [Math.round(v) >> 8, Math.round(v) & 0xff];
    const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
    switch (pid) {
      case 0x04: return [byte(20 + 60 * rev)];
      case 0x05: return [byte(coolant + 40)];
      case 0x06: return [byte(128 + 6 * Math.sin(t * 2))];
      case 0x07: return [byte(128 + 9)];
      case 0x0b: return [byte(35 + 120 * rev)];
      case 0x0c: return u16(rpm * 4);
      case 0x0d: return [byte(40 + 50 * rev)];
      case 0x0e: return [byte((12 + 10 * rev + 64) * 2)];
      case 0x0f: return [byte(18 + 40)];
      case 0x10: return u16((3 + 60 * rev) * 100);
      case 0x11: return [byte(255 * (0.12 + 0.6 * rev))];
      case 0x1f: return u16(t);
      case 0x2f: return [byte(255 * 0.62)];
      case 0x33: return [101];
      case 0x42: return u16(14100 + 100 * Math.sin(t));
      case 0x46: return [byte(7 + 40)];
      default: return null;
    }
  }

  respond(cmd) {
    if (cmd === 'ATZ' || cmd === 'ATI') return 'ELM327 v2.3';
    if (cmd === 'ATDPN') return 'A6';
    if (cmd === 'ATRV') return `${(12.4 + 1.7 * (this.now() - this.start > 1000)).toFixed(1)}V`;
    if (cmd.startsWith('AT')) return 'OK';

    const ecm = (...bytes) => frames('7E8', bytes);
    const tcm = (...bytes) => frames('7E9', bytes);
    let lines;
    if (cmd === '0100' || cmd === '0120' || cmd === '0140') {
      const base = parseInt(cmd.slice(2), 16);
      lines = ecm(0x41, base, ...mask(base));
      if (base === 0) lines.push(...tcm(0x41, 0x00, 0x80, 0x00, 0x00, 0x00));
    } else if (cmd === '0101') {
      lines = this.cleared ? ecm(0x41, 0x01, 0x00, 0x07, 0x65, 0x65) : ecm(0x41, 0x01, 0x82, 0x07, 0x65, 0x04);
    } else if (/^01[0-9A-F]{2}$/.test(cmd)) {
      const pid = parseInt(cmd.slice(2), 16);
      const data = this.live(pid);
      lines = data ? ecm(0x41, pid, ...data) : null;
    } else if (cmd === '03') {
      lines = this.cleared
        ? [...ecm(0x43, 0x00), ...tcm(0x43, 0x00)]
        : [...ecm(0x43, 0x02, 0x04, 0x20, 0x01, 0x71), ...tcm(0x43, 0x01, 0x07, 0x31)];
    } else if (cmd === '07') {
      lines = this.cleared ? ecm(0x47, 0x00) : ecm(0x47, 0x01, 0x03, 0x00);
    } else if (cmd === '0A') {
      lines = ecm(0x4a, 0x00);
    } else if (cmd === '04') {
      this.cleared = true;
      lines = [...ecm(0x44), ...tcm(0x44)];
    } else if (cmd === '0902') {
      lines = ecm(0x49, 0x02, 0x01, ...[...VIN].map((c) => c.charCodeAt(0)));
    }
    return lines ? lines.join('\r') : 'NO DATA';
  }
}
