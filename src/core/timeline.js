// Analysis -> replay frames and the exposures at replay step k. Pure: no DOM, no I/O.

import { countLines } from './lines.js';

/**
 * @typedef {{ index: number, n: number, start: number|null, seconds: number|null, category: string,
 *   fog: boolean, blocked: boolean, cut: boolean,
 *   repeat: import('./metrics.js').RepeatMark|null }} Frame
 *   start: seconds from the first call; seconds: time until the next call; both null when unknown.
 */

/**
 * One frame per call, in log order.
 * @param {ReturnType<typeof import('./metrics.js').analyse>} analysis
 * @returns {Frame[]}
 */
export function frames(analysis) {
  const first = analysis.firstSource.value;
  return analysis.calls.map((e) => ({
    index: e.call.index,
    n: e.call.n,
    start: e.offset,
    seconds: e.interval.value,
    category: e.effect.category,
    fog: e.effect.hiddenEdit || e.effect.hiddenRequest,
    blocked: e.effect.category === 'blocked',
    cut: first !== null && first.call === e.call.index,
    repeat: e.repeat,
  }));
}

/**
 * Line counts per file of the requests from calls 1..k. A file appears once any of its
 * requests is in range, with an empty list if none of them has explicit lines.
 * @param {ReturnType<typeof import('./metrics.js').analyse>} analysis
 * @param {number} k call number, 0 for before the first call
 * @returns {Map<string, import('./lines.js').Interval[]>}
 */
export function exposuresAt(analysis, k) {
  const byFile = new Map();
  for (const e of analysis.calls) {
    if (e.call.index > k) break;
    for (const r of e.effect.requests) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
  }
  return new Map([...byFile].map(([file, reqs]) => [file, countLines(reqs)]));
}

/**
 * Which frames get edge codes on the strip. A cut frame always keeps its codes. Any other
 * frame is skipped when its code would sit closer than `gap` to the cut frame's, before or
 * after it, or closer than `gap` to the last code drawn.
 * @param {number[]} xs left edge of each frame
 * @param {boolean[]} cuts true for the cut frame
 * @param {number} gap least distance between two drawn codes
 * @returns {number[]} indexes of the frames to draw, ascending
 */
export function codeFrames(xs, cuts, gap) {
  const cutXs = xs.filter((_, i) => cuts[i]);
  const out = [];
  let last = -Infinity;
  xs.forEach((x, i) => {
    if (!cuts[i] && (x - last < gap || cutXs.some((c) => Math.abs(x - c) < gap))) return;
    last = x;
    out.push(i);
  });
  return out;
}
