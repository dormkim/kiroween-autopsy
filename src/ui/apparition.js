// The spirit photograph: the most requested line range of the session, developed as a figure.
// The figure is data. It holds exactly one exposure per request (with an explicit range) that
// covers the most requested lines, up to the replay step: none at zero, faint at one, dense at
// eight. Beside it, the line plate of that file is the exact reading, and one strand per
// exposure runs from the requested lines on the plate into the figure.
// Without any line range, the figure counts the requests of the whole of the file requested
// whole most often (analysis.topWhole); its plate has no line scale, because the length is unknown.
// Drawn in px units (viewBox equals the size), so SVG text never shrinks.

import { el, svg, replace } from './dom.js';
import { exposure } from './plates.js';

const FIG_W = 120;
const FIG_H = 240;
const HEAD_X = 60;
const HEAD_Y = 46;
// A draped veil over an elongated head, falling past the shoulders to a torn, uneven hem.
const VEIL = 'M60 6 C47 6 40 18 40 34 C40 52 42 66 40 78 C30 86 22 100 20 122 C16 150 14 180 10 206 '
  + 'L16 214 L12 226 L22 218 L26 234 L34 220 L40 238 L48 222 L56 236 L62 220 L70 232 L76 218 L84 236 L90 220 L98 230 L102 214 L110 210 '
  + 'C106 180 104 150 100 122 C98 100 90 86 80 78 C78 66 80 52 80 34 C80 18 73 6 60 6 Z';
// Folds of the veil, drawn as faint lines inside each exposure.
const FOLDS = 'M46 82 C40 120 34 170 30 220 M58 88 C56 130 54 180 52 228 M70 86 C74 128 80 176 86 226 M82 92 C90 130 96 170 100 212';
const COPY_OPACITY = 0.17;
const SKEW = 2.2;
/** Sideways displacement per step of age, alternating left and right, so stacked exposures separate. */
const DISPLACE = 2.4;

let seq = 0;

const linesText = (from, to) => (from === to ? `line ${from}` : `lines ${from} to ${to}`);

/**
 * Size of the photograph for a container width. Wide containers get the large card.
 * @param {number} width available px
 * @returns {{ W: number, H: number }}
 */
export function photoSize(width) {
  const W = Math.max(280, Math.min(560, Math.floor(width)));
  return { W, H: W >= 500 ? 440 : Math.min(240, Math.round(W * 0.75)) };
}

const geometry = (W, H) => {
  const small = W < 420;
  const rulerW = 40;
  const plateX = rulerW + 6;
  const pw = small ? 24 : 40;
  const plateY = 10;
  const PH = H - 34;
  const cardX = plateX + pw + (small ? 14 : 26);
  const m = small ? 8 : 14;
  const imprint = 20;
  const win = { x: cardX + m, y: m, w: W - cardX - 2 * m, h: H - 2 * m - imprint };
  const arch = Math.min(win.w * 0.32, win.h * 0.3);
  return { small, rulerW, plateX, pw, plateY, PH, cardX, m, imprint, win, arch };
};

const archPath = ({ x, y, w, h }, arch) =>
  `M ${x} ${y + h} L ${x} ${y + arch} A ${w / 2} ${arch} 0 0 1 ${x + w} ${y + arch} L ${x + w} ${y + h} Z`;

/**
 * Builds the photograph for one analysis, or null when it has neither a most requested line
 * range nor a file requested whole. Without a line range, the figure counts the requests of
 * the whole of the file requested whole most often (analysis.topWhole).
 * @param {ReturnType<typeof import('../core/metrics.js').analyse>} a
 * @param {{ width: number, name: string, onPick: (() => void)|null }} opts
 * @returns {{ node: HTMLElement, file: string, update: (k: number, intervals: object[]) => void, countAt: (k: number) => number }|null}
 */
export function apparition(a, opts) {
  const top = a.top.value;
  const whole = top === null && a.topWhole !== undefined ? a.topWhole.value : null;
  if (top === null && whole === null) return null;
  const file = top !== null ? top.file : whole.file;
  const requests = a.calls.flatMap((e) => e.effect.requests.filter((r) => r.file === file));
  const covering = top !== null
    ? requests.filter((r) => r.kind === 'range' && r.from <= top.from && r.to >= top.to)
    : requests.filter((r) => r.kind === 'open' && r.from === 1);
  // Whole-file mode draws only the whole-file requests: the length is unknown, so no line scale.
  const opens = top !== null ? requests.filter((r) => r.kind === 'open') : covering;
  const L = top === null ? 1 : Math.max(1, ...requests.filter((r) => r.kind === 'range').map((r) => r.to), ...opens.map((r) => r.from));

  const { W, H } = photoSize(opts.width);
  const g = geometry(W, H);
  const yOf = (line) => g.plateY + ((line - 1) / L) * g.PH;
  const box = (from, to) => {
    const h = Math.max(3, ((to - from + 1) / L) * g.PH);
    return { top: Math.min(yOf(from), g.plateY + g.PH - h), h };
  };
  const source = top !== null ? box(top.from, top.to) : { top: g.plateY, h: g.PH };
  const sourceY = source.top + source.h / 2;

  const s = Math.min((g.win.w * 0.62) / FIG_W, (g.win.h * 0.9) / FIG_H);
  const fx = g.win.x + g.win.w * 0.57 - (FIG_W * s) / 2;
  const fy = g.win.y + g.win.h - FIG_H * s + 2;

  seq += 1;
  const clipId = `window-${seq}`;
  const root = svg('svg', { class: 'photo-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // Mount: a worn cabinet card with an arched window.
  const clip = svg('clipPath', { id: clipId }, svg('path', { d: archPath(g.win, g.arch) }));
  const mount = svg('g', { 'aria-hidden': 'true' },
    svg('rect', { class: 'mount', x: g.cardX, y: 0, width: W - g.cardX, height: H }),
    svg('rect', { class: 'mount-rule', x: g.cardX + 3.5, y: 3.5, width: W - g.cardX - 7, height: H - 7 }),
    svg('rect', { class: 'grain mount-grain', x: g.cardX, y: 0, width: W - g.cardX, height: H, filter: 'url(#grain)' }));
  const figureLayer = svg('g', { filter: 'url(#haze)', transform: `translate(${fx.toFixed(1)} ${fy.toFixed(1)}) scale(${s.toFixed(3)})` });
  const windowLayer = svg('g', { 'clip-path': `url(#${clipId})` },
    svg('rect', { fill: 'url(#backdrop)', x: g.win.x, y: g.win.y, width: g.win.w, height: g.win.h }),
    figureLayer,
    svg('rect', { fill: 'url(#vignette)', x: g.win.x, y: g.win.y, width: g.win.w, height: g.win.h }),
    svg('rect', { class: 'grain photo-grain', x: g.win.x, y: g.win.y, width: g.win.w, height: g.win.h, filter: 'url(#grain)' }));
  const short = opts.name.replace(/\.events\.jsonl$|\.jsonl$/i, '') || opts.name;
  const fit = Math.max(8, Math.floor((W - g.cardX - 16) / 7.5) - 'Developed from '.length);
  const name = short.length > fit ? `${short.slice(0, fit - 3)}...` : short;
  const card = svg('g', {}, mount, clip, windowLayer,
    svg('path', { class: 'window-edge', d: archPath(g.win, g.arch) }),
    svg('text', { class: 'imprint', x: g.cardX + (W - g.cardX) / 2, y: H - 9, 'text-anchor': 'middle' }, `Developed from ${name}`));

  // The plate: the exact reading of the file's lines.
  const plateLayer = svg('g', {});
  const ruler = svg('g', { 'aria-hidden': 'true' });
  const strands = svg('g', { filter: 'url(#soft)', 'aria-hidden': 'true' });
  root.append(
    svg('rect', { class: 'mini-plate', x: g.plateX, y: g.plateY, width: g.pw, height: g.PH }),
    plateLayer, ruler, card, strands);

  const tick = (y, text, cls) => ruler.append(svg('text', { class: cls, x: g.rulerW, y: y + 4, 'text-anchor': 'end' }, text));
  if (top === null) {
    tick(g.plateY + 2, '1', 'tick-svg tick-source');
  } else {
    tick(sourceY, String(top.from), 'tick-svg tick-source');
    if (sourceY - g.plateY > 18) tick(g.plateY + 2, '1', 'tick-svg');
    if (opens.length === 0 && g.plateY + g.PH - sourceY > 18) tick(g.plateY + g.PH - 4, String(L), 'tick-svg');
    ruler.append(svg('line', { class: 'source-tie', x1: g.rulerW + 1, y1: sourceY, x2: g.plateX, y2: sourceY }));
  }

  if (opts.onPick !== null) {
    root.addEventListener('click', opts.onPick);
    root.classList.add('photo-pickable');
  }

  const caption = el('p', { class: 'photo-count' });
  const node = el('figure', { class: 'photo' }, root,
    el('figcaption', { class: 'photo-caption' },
      el('span', { class: 'photo-title' }, 'Plate I. ', el('span', { class: 'plate-path' }, file)),
      caption));

  const countAt = (k) => covering.filter((r) => r.call <= k).length;

  /** Redraws everything that depends on the step. */
  const update = (k, intervals) => {
    const live = covering.filter((r) => r.call <= k);
    const n = live.length;
    const lower = requests.some((r) => r.kind !== 'range' && r.call <= k);

    replace(plateLayer);
    for (const r of opens) {
      if (r.call > k) continue;
      plateLayer.append(svg('rect', { class: 'open-band', x: g.plateX, y: yOf(r.from), width: g.pw, height: g.plateY + g.PH - yOf(r.from) }));
    }
    for (const iv of intervals) {
      const b = box(iv.from, iv.to);
      const isSource = top !== null && iv.from <= top.to && top.from <= iv.to;
      plateLayer.append(svg('rect', {
        class: isSource ? 'band band-source' : 'band', x: g.plateX, y: b.top, width: g.pw, height: b.h, 'fill-opacity': exposure(iv.count).toFixed(3),
      }));
    }

    replace(figureLayer);
    for (let age = n - 1; age >= 0; age -= 1) {
      const r = live[n - 1 - age];
      const dx = age === 0 ? 0 : (age % 2 === 1 ? -1 : 1) * Math.ceil(age / 2) * DISPLACE;
      const copy = svg('g', {
        class: r.call === k ? 'exposure fresh' : 'exposure',
        opacity: COPY_OPACITY,
        mask: 'url(#hollow)',
        transform: `translate(${dx.toFixed(2)} ${(-age * 0.5).toFixed(2)}) translate(${HEAD_X} ${HEAD_Y}) skewX(${(-age * SKEW).toFixed(2)}) translate(${-HEAD_X} ${-HEAD_Y})`,
      },
      svg('path', { fill: 'url(#ecto)', d: VEIL }),
      svg('path', { class: 'fold', d: FOLDS }),
      svg('ellipse', { class: 'face', cx: HEAD_X, cy: HEAD_Y, rx: 11, ry: 21 }));
      figureLayer.append(copy);
    }

    replace(strands);
    live.forEach((r, i) => {
      const b = top !== null ? box(r.from, r.to) : source;
      const x1 = g.plateX + g.pw;
      const y1 = b.top + b.h / 2;
      const tx = fx + s * (34 + (i % 5) * 13);
      const ty = fy + s * (120 + (i % 3) * 32);
      strands.append(svg('path', {
        class: r.call === k ? 'strand fresh' : 'strand',
        d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + 40).toFixed(1)} ${(y1 - 6).toFixed(1)} ${(tx - 50).toFixed(1)} ${(ty + 30).toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`,
      }));
    });

    if (top === null) {
      const noun = n === 1 ? 'exposure' : 'exposures';
      caption.textContent = n === 0
        ? `No exposure yet: the whole of ${file} has not been requested at this call.`
        : `The figure is ${n} superimposed ${noun}, one per request of the whole of ${file} so far. The log does not say how long the file is.`;
      root.setAttribute('aria-label', `Spirit photograph of the whole of ${file}: ${n} superimposed ${noun}, one per request of the whole file so far, of a length the log does not give.`);
      return;
    }
    const range = linesText(top.from, top.to);
    if (n === 0) {
      caption.textContent = `No exposure yet: ${range} ${top.from === top.to ? 'has' : 'have'} not been requested at this call.`;
    } else {
      const noun = n === 1 ? 'exposure' : 'exposures';
      const bound = lower ? ` Requested at least ${n === 1 ? 'once' : `${n} times`}; open-ended requests are not drawn.` : '';
      caption.textContent = `The figure is ${n} superimposed ${noun}, one per request of ${range} so far.${bound}`;
    }
    root.setAttribute('aria-label', `Spirit photograph of ${range} of ${file}: ${n} superimposed ${n === 1 ? 'exposure' : 'exposures'}.`);
  };

  return { node, file, update, countAt };
}
