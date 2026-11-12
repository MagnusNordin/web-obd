// Live-data graphs: a history of readings per value, a sparkline in each
// tile, and one larger graph with axes, time window and a crosshair.
// One value per graph, so each has its own single y-axis.

const SVG = 'http://www.w3.org/2000/svg';
const GAP_MS = 5000; // a longer pause between readings breaks the line

export class History {
  constructor(maxAgeMs = 15 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs;
    this.series = new Map(); // key → [[t, v], ...] oldest first
  }

  add(key, t, v) {
    if (v == null || !Number.isFinite(v)) return;
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = []));
    s.push([t, v]);
    const cutoff = t - this.maxAgeMs;
    let drop = 0;
    while (drop < s.length && s[drop][0] < cutoff) drop++;
    if (drop) s.splice(0, drop);
  }

  get(key, from = -Infinity) {
    return (this.series.get(key) || []).filter(([t]) => t >= from);
  }

  last(key) {
    const s = this.series.get(key);
    return s && s.length ? s[s.length - 1] : null;
  }

  clear() { this.series.clear(); }
}

// Round numbers for axis ticks covering lo..hi (about `count` of them).
export function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) { const pad = Math.abs(lo) * 0.05 || 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const first = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = first; v <= hi + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < hi) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
  return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1], step };
}

// Value range for a series: the data's own range, but never narrower than
// `minSpan`, so sensor noise isn't blown up to fill the whole height.
export function extent(points, minSpan) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, v] of points) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity) return null;
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  return [lo, hi];
}

// SVG path for points, with x(t) and y(v) mappings; breaks the line at gaps.
export function linePath(points, x, y) {
  let d = '';
  let prev = null;
  for (const [t, v] of points) {
    d += `${prev == null || t - prev > GAP_MS ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    prev = t;
  }
  return d;
}

function node(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// Small trend line for a tile: last `windowMs` of readings, no axes.
export function drawSparkline(svg, points, { to, windowMs, minSpan }) {
  const w = 120;
  const h = 32;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const shown = points.filter(([t]) => t >= to - windowMs);
  const ext = extent(shown, minSpan);
  if (!ext) { svg.replaceChildren(); return; }
  // Until a full window of readings exists, stretch what there is across the tile.
  const from = Math.max(to - windowMs, shown[0][0]);
  const span = Math.max(1, to - from);
  const x = (t) => ((t - from) / span) * w;
  const y = (v) => h - 3 - ((v - ext[0]) / (ext[1] - ext[0])) * (h - 6);
  svg.replaceChildren(node('path', { d: linePath(shown, x, y), class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }));
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function windowLabel(ms) {
  return ms >= 60000 ? `${+(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
}

// The large graph. Returns the drawing scales so the crosshair can use them.
export function drawChart(svg, points, { to, windowMs, minSpan, digits, unit, endLabel = 'now' }) {
  const width = Math.max(260, Math.round(svg.parentElement.clientWidth || 600));
  const height = 240;
  const pad = { left: 46, right: 12, top: 34, bottom: 24 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  const from = to - windowMs;
  const shown = points.filter(([t]) => t >= from);
  const ext = extent(shown, minSpan) || [0, 1];
  const { ticks, lo, hi } = niceTicks(ext[0], ext[1], 4);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (t) => pad.left + ((t - from) / windowMs) * plotW;
  const y = (v) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const tickDigits = Math.max(0, Math.min(digits + 1, -Math.floor(Math.log10(ticks[1] - ticks[0] || 1))));

  const parts = [];
  for (const v of ticks) {
    parts.push(node('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'grid' }));
    parts.push(node('text', { x: pad.left - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, v.toFixed(tickDigits)));
  }
  parts.push(node('text', { x: pad.left, y: height - 6, class: 'axis', 'text-anchor': 'start' }, `−${windowLabel(windowMs)}`));
  parts.push(node('text', { x: width - pad.right, y: height - 6, class: 'axis', 'text-anchor': 'end' }, endLabel));
  parts.push(node('text', { x: pad.left + plotW / 2, y: height - 6, class: 'axis', 'text-anchor': 'middle' }, `−${windowLabel(windowMs / 2)}`));
  if (shown.length) {
    parts.push(node('path', { d: linePath(shown, x, y), class: 'chart-line' }));
    const [lt, lv] = shown[shown.length - 1];
    parts.push(node('circle', { cx: x(lt), cy: y(lv), r: 4, class: 'chart-dot' }));
  } else {
    parts.push(node('text', { x: pad.left + plotW / 2, y: pad.top + plotH / 2, class: 'axis', 'text-anchor': 'middle' }, 'No readings in this window'));
  }
  const cross = node('line', { y1: pad.top, y2: pad.top + plotH, class: 'cross', visibility: 'hidden' });
  const crossDot = node('circle', { r: 4, class: 'chart-dot', visibility: 'hidden' });
  parts.push(cross, crossDot);
  svg.replaceChildren(...parts);
  return { shown, x, y, pad, plotW, width, cross, crossDot, digits, unit };
}

// Crosshair + tooltip: snaps to the reading nearest the pointer's time.
// Returns refresh(), which puts the crosshair back after the graph is redrawn.
export function attachCrosshair(svg, tip, getState) {
  let px = null; // pointer x in graph units while the pointer is over it
  const hide = () => {
    const s = getState();
    tip.hidden = true;
    s?.cross.setAttribute('visibility', 'hidden');
    s?.crossDot.setAttribute('visibility', 'hidden');
  };
  const place = () => {
    const s = getState();
    if (px == null || !s || s.shown.length === 0) return hide();
    let best = s.shown[0];
    for (const p of s.shown) if (Math.abs(s.x(p[0]) - px) < Math.abs(s.x(best[0]) - px)) best = p;
    const [t, v] = best;
    const cx = s.x(t);
    s.cross.setAttribute('x1', cx);
    s.cross.setAttribute('x2', cx);
    s.cross.setAttribute('visibility', 'visible');
    s.crossDot.setAttribute('cx', cx);
    s.crossDot.setAttribute('cy', s.y(v));
    s.crossDot.setAttribute('visibility', 'visible');
    tip.textContent = `${v.toFixed(s.digits)} ${s.unit} · ${clock(t)}`;
    tip.hidden = false;
    const rect = svg.getBoundingClientRect();
    const left = (cx / s.width) * rect.width;
    tip.style.left = `${Math.max(0, Math.min(rect.width - tip.offsetWidth, left - tip.offsetWidth / 2))}px`;
  };
  svg.addEventListener('pointermove', (e) => {
    const s = getState();
    if (!s) return;
    const rect = svg.getBoundingClientRect();
    px = ((e.clientX - rect.left) / rect.width) * s.width;
    place();
  });
  const leave = () => { px = null; hide(); };
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointercancel', leave);
  return place;
}
