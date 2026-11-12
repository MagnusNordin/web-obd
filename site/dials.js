// Round dials for the main live values: engine speed, vehicle speed and
// temperatures. A 270° scale with ticks, a filled arc, a needle and the
// digital value in the middle. A warning zone marks the top of the scale.

const SVG = 'http://www.w3.org/2000/svg';
const SWEEP = 270; // degrees, from bottom-left round to bottom-right
const START = -SWEEP / 2; // angle from 12 o'clock, clockwise positive

// Scales per PID. `size: 'large'` for the two main dials.
// rpm scales depend on the engine: diesels rev lower.
export function dialScales({ diesel = false } = {}) {
  return {
    0x0c: diesel
      ? { size: 'large', min: 0, max: 5000, major: 1000, minor: 500, warnFrom: 4500, tickLabel: (v) => v / 1000 }
      : { size: 'large', min: 0, max: 7000, major: 1000, minor: 500, warnFrom: 6000, tickLabel: (v) => v / 1000 },
    0x0d: { size: 'large', min: 0, max: 240, major: 40, minor: 20 },
    0x05: { min: 40, max: 140, major: 20, minor: 10, warnFrom: 110 },
    0x5c: { min: 40, max: 160, major: 40, minor: 20, warnFrom: 140 },
    0x0f: { min: -20, max: 80, major: 20, minor: 10 },
    0x46: { min: -30, max: 50, major: 20, minor: 10 },
    0x78: { min: 0, max: 1000, major: 250, minor: 125, warnFrom: 800 }
  };
}

// Display order: main dials first, then temperatures.
export const DIAL_ORDER = [0x0c, 0x0d, 0x05, 0x5c, 0x0f, 0x78, 0x46];

// Value → fraction of the scale (clamped), and → needle angle.
export function dialFraction(v, { min, max }) {
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}
export const dialAngle = (v, scale) => START + dialFraction(v, scale) * SWEEP;

// Point on a circle round (50, 50) at `deg` clockwise from 12 o'clock.
export function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [+(50 + r * Math.sin(a)).toFixed(2), +(50 - r * Math.cos(a)).toFixed(2)];
}

// SVG arc from angle a to angle b (clockwise) at radius r.
export function arcPath(r, a, b) {
  const [x1, y1] = polar(r, a);
  const [x2, y2] = polar(r, b);
  return `M${x1},${y1}A${r},${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2},${y2}`;
}

function node(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// Builds a dial; returns { element, update(v) }.
export function createDial({ name, unit, digits }, scale) {
  const svg = node('svg', { viewBox: '0 0 100 102', class: 'dial-svg', 'aria-hidden': 'true' });
  const end = START + SWEEP;
  const R = 42; // the arc
  svg.append(node('path', { d: arcPath(R, START, end), class: 'dial-track' }));
  if (scale.warnFrom != null) {
    svg.append(node('path', { d: arcPath(R + 4.5, dialAngle(scale.warnFrom, scale), end), class: 'dial-warn' }));
  }
  const fill = node('path', { d: arcPath(R, START, end), class: 'dial-fill', pathLength: 100, 'stroke-dasharray': '0 101', style: 'opacity: 0' });
  svg.append(fill);

  // Ticks and numbers inside the arc.
  const large = scale.size === 'large';
  for (let v = scale.min; v <= scale.max + 1e-9; v += scale.minor) {
    const major = Math.abs(((v - scale.min) / scale.major) - Math.round((v - scale.min) / scale.major)) < 1e-9;
    const a = dialAngle(v, scale);
    const [x1, y1] = polar(R - 4, a);
    const [x2, y2] = polar(R - (major ? 9 : 6.5), a);
    svg.append(node('line', { x1, y1, x2, y2, class: major ? 'dial-tick major' : 'dial-tick' }));
    if (major) {
      const [tx, ty] = polar(R - (large ? 15 : 16), a);
      svg.append(node('text', { x: tx, y: ty + 2.2, class: 'dial-num', 'text-anchor': 'middle' }, String(scale.tickLabel ? scale.tickLabel(v) : v)));
    }
  }

  const needle = node('g', { class: 'dial-needle' });
  needle.append(node('path', { d: `M49,52 L50,${50 - (R - 3)} L51,52 Z`, class: 'dial-needle-line' }));
  needle.append(node('circle', { cx: 50, cy: 50, r: 3, class: 'dial-hub' }));
  svg.append(needle);

  // The digital value sits in the open gap at the bottom of the scale.
  const value = node('text', { x: 50, y: 90, class: 'dial-value', 'text-anchor': 'middle' }, '–');
  const unitText = node('text', { x: 50, y: 99, class: 'dial-unit', 'text-anchor': 'middle' }, unit);
  svg.append(value, unitText);

  const element = document.createElement('button');
  element.type = 'button';
  element.className = `dial ${large ? 'large' : 'small'} stale`;
  element.setAttribute('aria-pressed', 'false');
  const label = document.createElement('span');
  label.className = 'dial-label';
  label.textContent = name;
  element.append(svg, label);

  function update(v) {
    element.classList.toggle('stale', v == null);
    if (v == null) { value.textContent = '–'; return; }
    value.textContent = v.toFixed(digits);
    const f = dialFraction(v, scale);
    // A zero-length dash would still draw round end caps as dots.
    fill.setAttribute('stroke-dasharray', `${(f * 100).toFixed(2)} 101`);
    fill.style.opacity = f < 0.005 ? 0 : 1;
    needle.style.transform = `rotate(${dialAngle(v, scale).toFixed(1)}deg)`;
    element.classList.toggle('warn', scale.warnFrom != null && v >= scale.warnFrom);
    element.setAttribute('aria-label', `${name}: ${v.toFixed(digits)} ${unit}`);
  }
  element.setAttribute('aria-label', name);
  needle.style.transform = `rotate(${START}deg)`;
  return { element, update };
}
