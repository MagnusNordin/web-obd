// Pure OBD-II / ELM327 decoding: no DOM, no I/O, so it can be unit-tested.
//
// The app runs the adapter with headers and spaces on (ATH1, ATS1), so a CAN
// reply looks like "7E8 06 41 0C 1A F8 00 00". Every reply is split into
// messages per ECU, with ISO-TP multi-frame replies (VIN, many DTCs)
// reassembled here.

const ERRORS = [
  'NO DATA', 'UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY',
  'FB ERROR', 'DATA ERROR', 'BUFFER FULL', 'STOPPED', 'ERROR', 'ACT ALERT', 'LV RESET'
];

// Raw adapter text (everything before the ">" prompt) → useful lines.
// Drops the echo of the command, "SEARCHING..." and "BUS INIT" noise.
export function cleanResponse(raw, cmd = '') {
  const echo = cmd.replace(/\s/g, '').toUpperCase();
  const lines = String(raw)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && l.replace(/\s/g, '').toUpperCase() !== echo)
    .filter((l) => !/^SEARCHING/i.test(l) && !/^BUS INIT/i.test(l));
  if (lines.length === 1 && lines[0] === '?') return { lines: [], error: 'Unknown command' };
  const data = lines.filter((l) => !ERRORS.some((e) => l.toUpperCase().includes(e)));
  if (data.length === 0 && lines.length > 0) {
    return { lines: [], error: lines.find((l) => ERRORS.some((e) => l.toUpperCase().includes(e))) };
  }
  return { lines: data, error: null };
}

// ATDPN replies "6" or "A6" (A = chosen automatically). 6–9 are CAN.
export function parseProtocol(text) {
  const m = /A?([0-9A-C])\s*$/i.exec(String(text).trim());
  return m ? parseInt(m[1], 16) : 0;
}

export const isCan = (protocol) => protocol >= 6;
const isExtended = (protocol) => protocol === 7 || protocol === 9;

const PROTOCOLS = {
  1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2', 4: 'ISO 14230-4 KWP (5 baud)',
  5: 'ISO 14230-4 KWP (fast)', 6: 'ISO 15765-4 CAN (11 bit, 500 kbaud)', 7: 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
  8: 'ISO 15765-4 CAN (11 bit, 250 kbaud)', 9: 'ISO 15765-4 CAN (29 bit, 250 kbaud)'
};
export const protocolName = (p) => PROTOCOLS[p] || `Protocol ${p}`;

const hexBytes = (tokens) => tokens.map((h) => parseInt(h, 16));

// Lines → [{ ecu, bytes }] with one entry per reassembled message.
export function parseMessages(lines, protocol) {
  const out = [];
  if (!isCan(protocol)) {
    // J1850 / ISO 9141 / KWP: 3 header bytes, data, 1 checksum byte.
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      if (!tokens.every((t) => /^[0-9A-F]{2}$/i.test(t)) || tokens.length < 5) continue;
      out.push({ ecu: tokens[2].toUpperCase(), bytes: hexBytes(tokens.slice(3, -1)) });
    }
    return out;
  }
  const ext = isExtended(protocol);
  const pending = new Map(); // ecu → { len, data }
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens.every((t) => /^[0-9A-F]+$/i.test(t))) continue;
    let ecu, data;
    if (ext) {
      if (tokens.length < 5) continue;
      ecu = tokens.slice(0, 4).join('').toUpperCase();
      data = hexBytes(tokens.slice(4));
    } else {
      if (tokens[0].length !== 3 || tokens.length < 2) continue;
      ecu = tokens[0].toUpperCase();
      data = hexBytes(tokens.slice(1));
    }
    const type = data[0] >> 4;
    if (type === 0) {
      out.push({ ecu, bytes: data.slice(1, 1 + (data[0] & 0x0f)) });
    } else if (type === 1) {
      pending.set(ecu, { len: ((data[0] & 0x0f) << 8) | data[1], data: data.slice(2) });
    } else if (type === 2 && pending.has(ecu)) {
      const p = pending.get(ecu);
      p.data.push(...data.slice(1));
      if (p.data.length >= p.len) {
        out.push({ ecu, bytes: p.data.slice(0, p.len) });
        pending.delete(ecu);
      }
    }
  }
  for (const [ecu, p] of pending) out.push({ ecu, bytes: p.data }); // incomplete: best effort
  return out;
}

// Which control unit sent a message. 7E8/…10 is the engine, 7E9/…18 the gearbox.
export function ecuName(ecu) {
  const id = ecu.length === 3 ? { '7E8': '10', '7E9': '18', '7EA': '28' }[ecu] : ecu.slice(-2);
  return { 10: 'Engine (ECM)', 18: 'Transmission (TCM)', 28: 'ABS / chassis' }[id] || `ECU ${ecu}`;
}

const MAIN_ECUS = ['7E8', '18DAF110', '10'];

// The reply to a mode 01 request from the engine ECU (or any ECU) → data bytes after the PID.
export function pidReply(messages, pid) {
  const hits = messages.filter((m) => m.bytes[0] === 0x41 && m.bytes[1] === pid);
  const hit = hits.find((m) => MAIN_ECUS.includes(m.ecu)) || hits[0];
  return hit ? hit.bytes.slice(2) : null;
}

// Two DTC bytes → "P0420".
export function dtcCode(a, b) {
  const letter = 'PCBU'[a >> 6];
  const rest = ((a & 0x0f).toString(16) + b.toString(16).padStart(2, '0')).toUpperCase();
  return `${letter}${(a >> 4) & 0x03}${rest}`;
}

// Replies to mode 03 (stored), 07 (pending) or 0A (permanent) → [{ code, ecu }].
export function decodeDtcs(messages, mode, protocol) {
  const service = 0x40 + mode;
  const start = isCan(protocol) ? 2 : 1; // CAN replies carry a count byte first
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    if (m.bytes[0] !== service) continue;
    for (let i = start; i + 1 < m.bytes.length; i += 2) {
      const [a, b] = [m.bytes[i], m.bytes[i + 1]];
      if (a === 0 && b === 0) continue;
      const code = dtcCode(a, b);
      if (seen.has(m.ecu + code)) continue;
      seen.add(m.ecu + code);
      out.push({ code, ecu: m.ecu });
    }
  }
  return out;
}

// Reply to 0100 / 0120 / 0140 … → supported PID numbers.
export function decodeSupported(bytes, base) {
  const out = [];
  if (!bytes) return out;
  for (let i = 0; i < 32; i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) out.push(base + i + 1);
  }
  return out;
}

// Reply to 0902 → VIN string.
export function decodeVin(messages, protocol) {
  const parts = messages.filter((m) => m.bytes[0] === 0x49 && m.bytes[1] === 0x02);
  if (parts.length === 0) return null;
  let bytes;
  if (isCan(protocol)) {
    const m = parts.find((p) => MAIN_ECUS.includes(p.ecu)) || parts[0];
    bytes = m.bytes.slice(3);
  } else {
    bytes = parts.sort((a, b) => a.bytes[2] - b.bytes[2]).flatMap((p) => p.bytes.slice(3));
  }
  const vin = String.fromCharCode(...bytes.filter((b) => b >= 0x21 && b <= 0x7e));
  return vin.length >= 17 ? vin.slice(-17) : vin || null;
}

const SPARK_TESTS = [
  'Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air system',
  'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR system'
];
const DIESEL_TESTS = [
  'NMHC catalyst', 'NOx / SCR aftertreatment', null, 'Boost pressure',
  null, 'Exhaust gas sensor', 'Particulate filter (DPF)', 'EGR / VVT system'
];

// Reply to 0101 → check-engine light, DTC count and readiness monitors.
export function decodeStatus(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const [a, b, c, d] = bytes;
  const diesel = Boolean(b & 0x08);
  const tests = [
    { name: 'Misfire', available: Boolean(b & 0x01), complete: !(b & 0x10) },
    { name: 'Fuel system', available: Boolean(b & 0x02), complete: !(b & 0x20) },
    { name: 'Components', available: Boolean(b & 0x04), complete: !(b & 0x40) }
  ];
  (diesel ? DIESEL_TESTS : SPARK_TESTS).forEach((name, i) => {
    if (name) tests.push({ name, available: Boolean(c & (1 << i)), complete: !(d & (1 << i)) });
  });
  return { mil: Boolean(a & 0x80), count: a & 0x7f, diesel, tests: tests.filter((t) => t.available) };
}

const u16 = ([a, b]) => a * 256 + b;

// Live-data PIDs: what the app polls when the car supports them.
export const PIDS = {
  0x0c: { name: 'Engine speed', unit: 'rpm', min: 0, max: 7000, digits: 0, decode: (x) => u16(x) / 4 },
  0x0d: { name: 'Vehicle speed', unit: 'km/h', min: 0, max: 240, digits: 0, decode: ([a]) => a },
  0x05: { name: 'Coolant temp', unit: '°C', min: -40, max: 130, digits: 0, decode: ([a]) => a - 40 },
  0x0f: { name: 'Intake air temp', unit: '°C', min: -40, max: 80, digits: 0, decode: ([a]) => a - 40 },
  0x04: { name: 'Engine load', unit: '%', min: 0, max: 100, digits: 0, decode: ([a]) => (a * 100) / 255 },
  0x11: { name: 'Throttle', unit: '%', min: 0, max: 100, digits: 0, decode: ([a]) => (a * 100) / 255 },
  0x0b: { name: 'Intake pressure', unit: 'kPa', min: 0, max: 255, digits: 0, decode: ([a]) => a },
  0x10: { name: 'Air flow (MAF)', unit: 'g/s', min: 0, max: 250, digits: 1, decode: (x) => u16(x) / 100 },
  0x06: { name: 'Short fuel trim B1', unit: '%', min: -25, max: 25, digits: 1, decode: ([a]) => ((a - 128) * 100) / 128 },
  0x07: { name: 'Long fuel trim B1', unit: '%', min: -25, max: 25, digits: 1, decode: ([a]) => ((a - 128) * 100) / 128 },
  0x0e: { name: 'Timing advance', unit: '°', min: -20, max: 50, digits: 1, decode: ([a]) => a / 2 - 64 },
  0x2f: { name: 'Fuel level', unit: '%', min: 0, max: 100, digits: 0, decode: ([a]) => (a * 100) / 255 },
  0x42: { name: 'ECU voltage', unit: 'V', min: 10, max: 16, digits: 1, decode: (x) => u16(x) / 1000 },
  0x5c: { name: 'Oil temp', unit: '°C', min: -40, max: 150, digits: 0, decode: ([a]) => a - 40 },
  0x46: { name: 'Ambient temp', unit: '°C', min: -40, max: 50, digits: 0, decode: ([a]) => a - 40 },
  0x33: { name: 'Barometric pressure', unit: 'kPa', min: 60, max: 110, digits: 0, decode: ([a]) => a },
  0x23: { name: 'Fuel rail pressure', unit: 'bar', min: 0, max: 2000, digits: 0, decode: (x) => (u16(x) * 10) / 100 },
  0x1f: { name: 'Run time since start', unit: 's', min: 0, max: 3600, digits: 0, decode: (x) => u16(x) }
};

export const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
