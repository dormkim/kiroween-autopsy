// Exposure plates: one per requested file. Each request exposes its lines once;
// overlapping exposures stack, so the brightest band is the most requested range.

import { el, svg, setVar, replace } from './dom.js';

/** Plate sizes in px. The hero plate holds the most requested range of the session. */
const TIERS = {
  hero: { W: 148, H: 520, minPx: 3, labels: true, outlines: true, grain: true },
  minor: { W: 104, H: 220, minPx: 3, labels: true, outlines: true, grain: true },
  single: { W: 22, H: 72, minPx: 2, labels: false, outlines: false, grain: false },
};
const NARROW = { hero: 104, minor: 84, single: 22 };
const SHIFT_MAX = 24;

/** Steering opacity formula: n=1 0.25, 2 0.40, 3 0.52, 5 0.69, 8 0.85. */
export const exposure = (n) => 0.25 + 0.75 * (1 - 0.8 ** (n - 1));

const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export const roman = (n) => {
  let out = '';
  let rest = n;
  if (rest >= 40) return String(n);
  for (const [v, s] of ROMAN) while (rest >= v) { out += s; rest -= v; }
  return out;
};

const linesText = (from, to) => (from === to ? `line ${from}` : `lines ${from} to ${to}`);
const timesText = (n) => (n === 1 ? 'once' : `${n} times`);

/** A round step for about five ruler ticks. */
const niceStep = (span) => {
  const raw = Math.max(1, span / 5);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

/** Ragged bottom edge for a request whose length is unknown: it runs off the plate. */
const raggedPoints = (x0, y0, w, H) => {
  const pts = [[x0, y0], [x0 + w, y0], [x0 + w, H + 6]];
  const teeth = Math.max(3, Math.round(w / 8));
  for (let i = 1; i <= teeth; i += 1) {
    const x = x0 + w - (w * i) / teeth;
    pts.push([x, H + (i % 2 === 0 ? 6 : 14)]);
  }
  pts.push([x0, H + 6]);
  return pts.map(([x, y]) => `${x.toFixed(1)},${Math.max(y0, y).toFixed(1)}`).join(' ');
};

/**
 * Draws one plate. `update(k, intervals, selectedKey)` exposes the requests of calls 1..k.
 * @param {{ file: string, requests: object[], tier: 'hero'|'minor'|'single', number: number|null,
 *   narrow: boolean, onPick: ((sel: object) => void)|null, note: unknown[] }} spec
 */
export function drawPlate(spec) {
  const t = TIERS[spec.tier];
  const W = spec.narrow ? NARROW[spec.tier] : t.W;
  const { H, minPx } = t;
  const ranges = spec.requests.filter((r) => r.kind === 'range');
  const opens = spec.requests.filter((r) => r.kind === 'open');
  const L = Math.max(1, ...ranges.map((r) => r.to), ...opens.map((r) => r.from));
  const bandW = t.outlines ? W - SHIFT_MAX - 4 : W;
  const yOf = (line) => ((line - 1) / L) * H;
  const box = (from, to) => {
    const h = Math.max(minPx, ((to - from + 1) / L) * H);
    return { top: Math.min(yOf(from), H - h), h };
  };
  const order = new Map(ranges.map((r, i) => [r, i + 1]));

  const layer = svg('g', {});
  const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' });
  if (t.grain) root.append(svg('rect', { class: 'grain', x: 0, y: 0, width: W, height: H, filter: 'url(#grain)' }));
  root.append(layer);

  const labels = el('div', { class: 'plate-labels' });
  const ruler = el('div', { class: 'plate-ruler', 'aria-hidden': 'true' });
  if (t.labels) {
    const step = niceStep(L);
    const ticks = [1];
    for (let v = step; v < L; v += step) if (yOf(v) > 16 && yOf(L) - yOf(v) > 16) ticks.push(v);
    if (L > 1) ticks.push(L);
    for (const v of ticks) {
      const tick = el('span', { class: 'tick' }, String(v));
      setVar(tick, '--y', Math.min(H - 6, Math.max(6, yOf(v))));
      ruler.append(tick);
    }
    if (opens.length > 0) {
      const tick = el('span', { class: 'tick tick-unknown' }, 'end unknown');
      setVar(tick, '--y', H + 16);
      ruler.append(tick);
    }
  }

  /** Keeps labels from overlapping: higher priority first, the rest are hidden. */
  const placeLabels = (items) => {
    const taken = [];
    for (const { node, y } of items) {
      labels.append(node);
      const h = node.offsetHeight;
      const centre = Math.min(H - h / 2, Math.max(h / 2, y));
      setVar(node, '--y', centre);
      const top = centre - h / 2;
      const bottom = centre + h / 2;
      if (taken.some(([a, b]) => top < b + 2 && a < bottom + 2)) {
        node.hidden = true;
      } else {
        taken.push([top, bottom]);
      }
    }
  };

  const update = (k, intervals, selectedKey) => {
    replace(layer);
    replace(labels);
    const live = spec.requests.filter((r) => r.call <= k);
    const items = [];

    const liveOpens = live.filter((r) => r.kind === 'open');
    for (const r of liveOpens) {
      const poly = svg('polygon', { class: r.call === k ? 'open-band fresh' : 'open-band', points: raggedPoints(0, yOf(r.from), bandW, H) });
      layer.append(poly);
    }
    if (t.labels && liveOpens.length > 0) {
      const first = liveOpens.reduce((p, q) => (q.from < p.from ? q : p));
      const text = first.from === 1 ? 'whole file, length unknown' : `from line ${first.from}, length unknown`;
      const more = liveOpens.length > 1 ? `, ${liveOpens.length} such requests` : '';
      items.push({ priority: 3, y: yOf(first.from) + 10, node: el('span', { class: 'band-label band-label-open' }, text + more) });
    }

    const brightest = intervals.reduce((p, q) => (p === null || q.count > p.count ? q : p), null);
    const lower = live.some((r) => r.kind !== 'range');
    const times = (c) => (lower ? `at least ${timesText(c)}` : timesText(c));
    for (const iv of intervals) {
      const { top, h } = box(iv.from, iv.to);
      const key = `${iv.from}:${spec.file}`;
      const selected = key === selectedKey;
      let cls = selected ? 'band band-selected' : 'band';
      if (iv.lines.includes(spec.requests.find((r) => r.call === k)?.n)) cls += ' fresh';
      const rect = svg('rect', { class: cls, x: 0, y: top, width: bandW, height: h, 'fill-opacity': exposure(iv.count).toFixed(3) });
      if (spec.onPick !== null) {
        rect.addEventListener('click', () => spec.onPick({ kind: 'interval', file: spec.file, from: iv.from, to: iv.to, count: iv.count, lines: iv.lines }));
      }
      layer.append(rect);
      if (!t.labels) continue;
      const isTop = iv === brightest;
      if (!isTop && !selected && iv.count < 2 && spec.tier !== 'hero') continue;
      let node;
      if (isTop && spec.tier === 'hero' && iv.count >= 2) {
        node = el('span', { class: 'band-label apparition' }, 'Brightest: ', el('span', { class: 'data' }, linesText(iv.from, iv.to)), `, requested ${times(iv.count)}`);
      } else {
        node = el('span', { class: 'band-label' }, `${linesText(iv.from, iv.to)}, ${times(iv.count)}`);
      }
      if (selected) node.classList.add('band-label-selected');
      const priority = selected ? 0 : isTop ? 1 : iv.count >= 2 ? 2 : 4;
      items.push({ priority, count: iv.count, y: top + h / 2, node });
    }

    if (t.outlines) {
      const sel = intervals.find((iv) => `${iv.from}:${spec.file}` === selectedKey) ?? null;
      for (const r of live) {
        if (r.kind !== 'range') continue;
        const { top, h } = box(r.from, r.to);
        const shift = Math.min(SHIFT_MAX, 2 * order.get(r));
        let cls = sel !== null && sel.lines.includes(r.n) ? 'outline outline-selected' : 'outline';
        if (r.call === k) cls += ' fresh';
        layer.append(svg('rect', { class: cls, x: shift + 0.5, y: top + 0.5, width: bandW - 1, height: Math.max(1, h - 1) }));
      }
    }

    if (t.labels) {
      items.sort((p, q) => p.priority - q.priority || (q.count ?? 0) - (p.count ?? 0) || p.y - q.y);
      placeLabels(items);
    }
  };

  if (spec.tier === 'single') {
    return { node: el('div', { class: 'single-glass' }, root), update };
  }

  const caption = el('figcaption', { class: 'plate-caption' },
    spec.number === null ? null : el('span', { class: 'plate-no' }, `Plate ${roman(spec.number)}. `),
    el('span', { class: 'plate-path' }, spec.file));
  const glass = el('div', { class: 'plate-glass' }, root);
  const body = el('div', { class: 'plate-body' }, ruler, glass, labels);
  setVar(body, '--h', H);
  const node = el('figure', { class: `plate plate-${spec.tier === 'hero' ? 'hero' : 'minor'}` },
    caption, body, spec.note.length > 0 ? el('p', { class: 'plate-note' }, ...spec.note) : null);
  return { node, update };
}

// ---- plates for an opened log ----

const describeOne = (r) => {
  if (r.kind === 'range') return linesText(r.from, r.to);
  if (r.kind === 'open') return r.from === 1 ? 'whole file, length unknown' : `from line ${r.from}, length unknown`;
  return 'lines unknown';
};

/** Requests per file, in log order. */
const requestsByFile = (a) => {
  const out = new Map();
  for (const e of a.calls) {
    for (const r of e.effect.requests) {
      if (!out.has(r.file)) out.set(r.file, []);
      out.get(r.file).push(r);
    }
  }
  return out;
};

/** Hero, minor and single-exposure files. Files requested once never take a full plate. */
export const tiers = (a) => {
  const byFile = requestsByFile(a);
  const files = [...byFile.keys()];
  const topCount = (f) => a.files.get(f)?.top?.count ?? 0;
  let hero = a.top.value === null ? null : a.top.value.file;
  if (hero === null && files.length > 0) {
    hero = [...files].sort((p, q) => byFile.get(q).length - byFile.get(p).length || (p < q ? -1 : 1))[0];
  }
  const rest = files.filter((f) => f !== hero);
  const minor = rest.filter((f) => topCount(f) >= 2).sort((p, q) => topCount(q) - topCount(p) || (p < q ? -1 : 1));
  const singles = rest.filter((f) => topCount(f) < 2).sort((p, q) => (p < q ? -1 : 1));
  return { byFile, hero, minor, singles };
};

const isNarrow = () => window.matchMedia('(max-width: 599px)').matches;

/**
 * Plates for the opened log, following replay steps and selections.
 * @param {object} ctx
 * @param {(ctx: object, text: string, traced: object, label: string) => Node} traced
 * @returns {HTMLElement}
 */
export function plates(ctx, traced) {
  const a = ctx.analysis;
  const { byFile, hero, minor, singles } = tiers(a);
  const narrow = isNarrow();
  const head = el('h2', { class: 'section-head', id: 'plates-head' }, 'Plates');
  const intro = el('p', { class: 'section-note' },
    'Each file is a plate, its lines running top to bottom. Every request exposes its lines once, so lines requested again come out brighter. Lines that were never requested stay dark. The staggered outlines are the separate exposures, in request order from left to right.');
  const out = el('section', { class: 'plates', 'aria-labelledby': 'plates-head' }, el('div', {}, head, intro));
  if (hero === null) {
    out.append(el('p', { class: 'section-note' }, 'No file request was recognised, so no plate was exposed.'));
    return out;
  }

  const editsOn = (file) => a.calls.flatMap((e) => e.effect.edits.filter((x) => x.file === file));
  const noteFor = (file, reqs) => {
    const f = a.files.get(file);
    const lines = reqs.map((r) => r.n);
    const n = reqs.length;
    const parts = [traced(ctx, String(n), { value: n, lines, reason: null }, `Requests of ${file}`), n === 1 ? ' request: ' : ' requests: ',
      `${f.ranges.length} with line ranges, ${f.open.length} open-ended, ${f.unlocated.length} with lines unknown.`];
    if (f.lowerBound) parts.push(' Line counts on this plate are a lower bound.');
    const edits = editsOn(file);
    if (edits.length > 0) {
      const ns = [...new Set(edits.map((e) => e.n))];
      parts.push(' Edit attempts on this file: ', traced(ctx, String(ns.length), { value: ns.length, lines: ns, reason: null }, `Edit attempts on ${file}`), '.');
    }
    return parts;
  };

  const pick = (sel) => ctx.select(sel, { reveal: false, origin: null });
  const all = [];
  const add = (file, tier, number) => {
    const reqs = byFile.get(file);
    const p = drawPlate({ file, requests: reqs, tier, number, narrow, onPick: pick, note: tier === 'single' ? [] : noteFor(file, reqs) });
    all.push({ file, reqs, p, seen: -1 });
    return p.node;
  };

  out.append(add(hero, 'hero', 1));
  if (minor.length > 0) out.append(el('div', { class: 'plates-minor' }, minor.map((f, i) => add(f, 'minor', i + 2))));
  if (singles.length > 0) {
    const items = singles.map((f) => {
      const reqs = byFile.get(f);
      const text = reqs.length === 1 ? `requested once: ${describeOne(reqs[0])}` : `${reqs.length} requests, no line requested twice`;
      return el('li', { class: 'single' }, add(f, 'single', null),
        el('div', {}, el('span', { class: 'single-path' }, f), el('br'),
          el('span', { class: 'single-text' }, text, ', ',
            traced(ctx, reqs.length === 1 ? `log line ${reqs[0].n}` : `${reqs.length} log lines`,
              { value: reqs.length, lines: reqs.map((r) => r.n), reason: null }, `Requests of ${f}`))));
    });
    out.append(el('div', {}, el('h3', { class: 'singles-head' }, `Single exposures: ${singles.length} ${singles.length === 1 ? 'file' : 'files'} with no line requested twice`),
      el('ul', { class: 'singles' }, items)));
  }

  let exposures = new Map();
  let selectedKey = null;
  let selectedFile = null;
  const redraw = (item) => item.p.update(ctx.step, exposures.get(item.file) ?? [], item.file === selectedFile ? selectedKey : null);

  ctx.onStep((k, exp) => {
    exposures = exp;
    for (const item of all) {
      const seen = item.reqs.filter((r) => r.call <= k).length;
      const fresh = item.reqs.some((r) => r.call === k);
      if (seen !== item.seen || fresh) {
        item.seen = seen;
        redraw(item);
      }
    }
  });
  ctx.onSelect((sel) => {
    const before = selectedFile;
    selectedFile = sel.kind === 'interval' ? sel.file : null;
    selectedKey = sel.kind === 'interval' ? `${sel.from}:${sel.file}` : null;
    for (const item of all) if (item.file === before || item.file === selectedFile) redraw(item);
  });
  return out;
}

