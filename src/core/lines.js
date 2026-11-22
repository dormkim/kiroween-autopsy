// Range requests -> merged count intervals. Pure: no DOM, no I/O.

/**
 * @typedef {{ from: number, to: number, count: number, lines: number[] }} Interval
 *   count: requests covering every line of the interval; lines: their log lines, sorted, unique.
 */

/**
 * Counts how many range requests cover each line, as merged intervals.
 * A sweep over request starts and ends, so the cost depends on the number of requests,
 * never on the number of lines. Requests with a `kind` other than 'range' are skipped.
 * Neighbouring intervals with the same covering log lines are merged.
 * @param {{ kind?: string, from: number, to: number, n: number }[]} requests
 * @returns {Interval[]}
 */
export function countLines(requests) {
  /** @type {[number, number, number][]} position, +1 or -1, log line */
  const events = [];
  for (const r of requests) {
    if (r.kind !== undefined && r.kind !== 'range') continue;
    events.push([r.from, 1, r.n], [r.to + 1, -1, r.n]);
  }
  events.sort((p, q) => p[0] - q[0]);
  const active = new Map();
  let size = 0;
  const out = [];
  const keys = [];
  let i = 0;
  while (i < events.length) {
    const pos = events[i][0];
    while (i < events.length && events[i][0] === pos) {
      const [, delta, n] = events[i];
      const c = (active.get(n) ?? 0) + delta;
      if (c === 0) active.delete(n);
      else active.set(n, c);
      size += delta;
      i += 1;
    }
    if (size === 0 || i >= events.length) continue;
    const to = events[i][0] - 1;
    const lines = [...active.keys()].sort((p, q) => p - q);
    const key = lines.map((n) => `${n}:${active.get(n)}`).join(',');
    const last = out[out.length - 1];
    if (last !== undefined && last.to === pos - 1 && keys[keys.length - 1] === key) {
      last.to = to;
    } else {
      out.push({ from: pos, to, count: size, lines });
      keys.push(key);
    }
  }
  return out;
}

/** True when p ranks above q: count, then length, then smaller from, then path order. */
const ranksAbove = (p, q) => {
  if (p.count !== q.count) return p.count > q.count;
  const lp = p.to - p.from;
  const lq = q.to - q.from;
  if (lp !== lq) return lp > lq;
  if (p.from !== q.from) return p.from < q.from;
  if (typeof p.file === 'string' && typeof q.file === 'string' && p.file !== q.file) return p.file < q.file;
  return false;
};

/**
 * The most requested interval: largest count, then the longer interval, then the smaller
 * `from`, then (when intervals carry a `file`) path order. Returns the interval itself.
 * @template {Interval & { file?: string }} T
 * @param {T[]} intervals
 * @returns {T|null}
 */
export function topInterval(intervals) {
  let best = null;
  for (const x of intervals) if (best === null || ranksAbove(x, best)) best = x;
  return best;
}
