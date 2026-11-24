// Parsed log -> Analysis: line counts, repeat requests, first source edit attempt, time.
// Pure: no DOM, no I/O, no clock. Every metric is a traced value { value, lines, reason }.

import { classify, ROOT, MAX_LINE, OUTSIDE } from './classify.js';
import { CUT_LEN } from './parse.js';
import { countLines, topInterval } from './lines.js';

export { ROOT, MAX_LINE, CUT_LEN, OUTSIDE };
/** Largest log file the page opens. */
export const MAX_BYTES = 50 * 1024 * 1024;
/** Accepted times: 2000-01-01 to 2100-01-01, epoch seconds. */
export const T_MIN = 946684800;
export const T_MAX = 4102444800;
/** Number of longest intervals shown. */
export const LONGEST = 5;

/**
 * @typedef {import('./parse.js').Call} Call
 * @typedef {import('./parse.js').Line} Line
 * @typedef {import('./classify.js').Effect} Effect
 * @typedef {import('./classify.js').Request} Request
 * @typedef {import('./classify.js').Edit} Edit
 * @typedef {{ value: any, lines: number[], reason: string|null }} Traced
 * @typedef {{ kind: 'repeat'|'unchecked', earlier: number[] }} RepeatMark
 * @typedef {{ call: Call, effect: Effect, marks: (RepeatMark|null)[], repeat: RepeatMark|null,
 *   interval: Traced, offset: number|null }} CallEntry
 */

const sortedUnique = (ns) => [...new Set(ns)].sort((p, q) => p - q);
const traced = (value, lines) => ({ value, lines: sortedUnique(lines), reason: null });
const unknown = (reason) => ({ value: null, lines: [], reason });

/**
 * A count traced to its items (one log line per item). A 0 is traced to the first
 * non-empty population that was checked; with nothing checked, the count is unknown.
 */
const countOf = (items, ...populations) => {
  if (items.length > 0) return traced(items.length, items);
  const pop = populations.find((p) => p.length > 0);
  return pop === undefined ? unknown('no_calls') : traced(0, pop);
};

const intersects = (p, q) => p.from <= q.to && q.from <= p.to;
const linesOf = (requests) => sortedUnique(requests.map((r) => r.n));

/** Mark of one request against the requests on its file since the last edit attempt on it. */
const markOf = (r, prev) => {
  if (prev.length === 0) return null;
  if (r.kind === 'range') {
    const hit = prev.filter((p) => p.kind === 'range' && intersects(p, r));
    if (hit.length > 0) return { kind: 'repeat', earlier: linesOf(hit) };
    const block = prev.filter((p) => (p.kind === 'open' && p.from <= r.to) || p.kind === 'unlocated');
    return block.length > 0 ? { kind: 'unchecked', earlier: linesOf(block) } : null;
  }
  return { kind: 'unchecked', earlier: linesOf(prev) };
};

/** A call is a repeat if any request repeats, else unchecked if any is. */
const callMark = (marks) => {
  for (const kind of ['repeat', 'unchecked']) {
    const hit = marks.filter((m) => m !== null && m.kind === kind);
    if (hit.length > 0) return { kind, earlier: sortedUnique(hit.flatMap((m) => m.earlier)) };
  }
  return null;
};

/**
 * Sets marks and repeat on every entry. Within a call, requests come before edits.
 * Only an edit attempt with exactly that file as target resets a file.
 * @param {CallEntry[]} entries
 */
const markRepeats = (entries) => {
  /** @type {Map<string, Request[]>} */
  const since = new Map();
  for (const e of entries) {
    e.marks = e.effect.requests.map((r) => {
      const prev = since.get(r.file) ?? [];
      const mark = markOf(r, prev);
      since.set(r.file, [...prev, r]);
      return mark;
    });
    for (const ed of e.effect.edits) if (ed.file !== null) since.delete(ed.file);
    e.repeat = callMark(e.marks);
  }
};

/**
 * Per requested file: line counts over the whole session, open and unlocated requests.
 * @param {CallEntry[]} entries
 */
const fileEntries = (entries) => {
  const files = new Map();
  for (const e of entries) {
    for (const r of e.effect.requests) {
      if (!files.has(r.file)) files.set(r.file, { ranges: [], open: [], unlocated: [] });
      const f = files.get(r.file);
      if (r.kind === 'range') f.ranges.push(r);
      else if (r.kind === 'open') f.open.push(r);
      else f.unlocated.push(r);
    }
  }
  for (const f of files.values()) {
    f.counts = countLines(f.ranges);
    f.top = topInterval(f.counts);
    f.lowerBound = f.open.length + f.unlocated.length > 0;
  }
  return files;
};

/** The most requested range over all files, with path order as the last tie-break. */
const overallTop = (files) => {
  const tops = [];
  for (const [file, f] of files) if (f.top !== null) tops.push({ ...f.top, file });
  const best = topInterval(tops);
  if (best === null) return unknown('no_ranges');
  return traced({ file: best.file, from: best.from, to: best.to, count: best.count }, best.lines);
};

/**
 * The file requested whole most often: requests of kind 'open' from line 1, with path order
 * as the tie-break. Open requests from a later line and unlocated requests are not counted.
 * Used for the photograph only when no line range was requested.
 */
const overallWhole = (files) => {
  let best = null;
  for (const [file, f] of files) {
    const lines = f.open.filter((r) => r.from === 1).map((r) => r.n);
    if (lines.length === 0) continue;
    if (best === null || lines.length > best.lines.length || (lines.length === best.lines.length && file < best.file)) {
      best = { file, lines };
    }
  }
  if (best === null) return unknown('no_whole_file');
  return traced({ file: best.file, count: best.lines.length }, best.lines);
};

// ---- time ----

/** Accepts times in log order; every other time becomes an anomaly. Lines are never reordered. */
const acceptTimes = (lines) => {
  const accepted = new Map();
  const anomalies = [];
  let last = null;
  let lastLine = null;
  for (const line of lines) {
    let t;
    let malformed = false;
    if (line.kind === 'call') {
      t = line.call.t;
      malformed = line.call.malformed.includes('t');
    } else if (line.kind === 'note') {
      t = line.t;
    } else {
      continue;
    }
    let reason = null;
    if (t === null) reason = malformed ? 'not_a_number' : 'missing';
    else if (t < T_MIN || t > T_MAX) reason = 'out_of_range';
    else if (last !== null && t < last) reason = 'backwards';
    if (reason !== null) {
      anomalies.push({ n: line.n, reason });
    } else {
      accepted.set(line.n, t);
      last = t;
      lastLine = line.n;
    }
  }
  return { accepted, anomalies, end: last, endLine: lastLine };
};

/**
 * Sets interval and offset on every entry and returns the time part of the Analysis.
 * @param {Line[]} lines
 * @param {CallEntry[]} entries
 */
const timeOf = (lines, entries) => {
  const { accepted, anomalies, end, endLine } = acceptTimes(lines);
  const tOf = (e) => (accepted.has(e.call.n) ? accepted.get(e.call.n) : null);
  const first = entries.find((e) => tOf(e) !== null);
  const start = first === undefined ? null : tOf(first);
  const span = start === null ? unknown('no_time') : traced(end - start, [first.call.n, endLine]);

  entries.forEach((e, i) => {
    const t = tOf(e);
    const next = entries[i + 1];
    e.offset = t === null ? null : t - start;
    if (t === null) e.interval = unknown('time_anomaly');
    else if (next === undefined) e.interval = traced(end - t, [e.call.n, endLine]);
    else if (tOf(next) !== null) e.interval = traced(tOf(next) - t, [e.call.n, next.call.n]);
    else e.interval = unknown('time_anomaly');
  });

  // Unknown gaps: between accepted calls that are not neighbours, and after the last
  // accepted call when later calls have unknown times.
  const gaps = [];
  const known = entries.map((e, i) => [e, i]).filter(([e]) => tOf(e) !== null);
  const callLines = (from, to) => entries.slice(from, to + 1).map((e) => e.call.n);
  for (let k = 1; k < known.length; k += 1) {
    const [a, i] = known[k - 1];
    const [b, j] = known[k];
    if (j !== i + 1) gaps.push(traced(tOf(b) - tOf(a), callLines(i, j)));
  }
  if (known.length > 0) {
    const [a, i] = known[known.length - 1];
    if (i !== entries.length - 1) gaps.push(traced(end - tOf(a), [...callLines(i, entries.length - 1), endLine]));
  }

  const sums = new Map();
  const add = (key, t) => {
    const s = sums.get(key) ?? { value: 0, lines: [] };
    s.value += t.value;
    s.lines.push(...t.lines);
    sums.set(key, s);
  };
  for (const e of entries) if (e.interval.value !== null) add(e.effect.category, e.interval);
  for (const g of gaps) add('unknown_time', g);
  const byCategory = new Map([...sums].map(([k, s]) => [k, traced(s.value, s.lines)]));

  const longest = entries
    .filter((e) => e.interval.value !== null)
    .sort((p, q) => q.interval.value - p.interval.value || p.call.index - q.call.index)
    .slice(0, LONGEST)
    .map((e) => traced({ call: e.call.index, n: e.call.n, seconds: e.interval.value }, e.interval.lines));

  const repeatCalls = entries.filter((e) => e.repeat !== null && e.repeat.kind === 'repeat');
  let afterRepeats = unknown('no_repeats');
  if (repeatCalls.length > 0) {
    const knownR = repeatCalls.filter((e) => e.interval.value !== null);
    afterRepeats = traced({
      seconds: knownR.reduce((s, e) => s + e.interval.value, 0),
      calls: repeatCalls.length,
      unknown: repeatCalls.length - knownR.length,
    }, [...repeatCalls.map((e) => e.call.n), ...knownR.flatMap((e) => e.interval.lines)]);
  }

  return { span, byCategory, longest, gaps, afterRepeats, anomalies };
};

// ---- first source edit attempt ----

const couldEdit = (e) => e.effect.hiddenEdit || e.effect.edits.some((x) => x.cls === 'unknown');

const firstSourceOf = (entries, span) => {
  const idx = entries.findIndex((e) => e.effect.edits.some((x) => x.cls === 'source'));
  const callLines = entries.map((e) => e.call.n);
  const allEdits = entries.flatMap((e) => e.effect.edits);
  if (idx === -1) {
    return {
      firstSource: unknown('none_recognised'),
      possibleEarlier: countOf(entries.filter(couldEdit).map((e) => e.call.n), callLines),
      otherEdits: allEdits,
    };
  }
  const e = entries[idx];
  const edit = e.effect.edits.find((x) => x.cls === 'source');
  const share = e.offset !== null && span.value !== null && span.value > 0 ? e.offset / span.value : null;
  const earlier = entries.slice(0, idx);
  return {
    firstSource: traced({ call: e.call.index, n: e.call.n, file: edit.file, offset: e.offset, share }, [e.call.n]),
    possibleEarlier: countOf(earlier.filter(couldEdit).map((x) => x.call.n), earlier.map((x) => x.call.n), [e.call.n]),
    otherEdits: allEdits.filter((x) => x !== edit),
  };
};

/**
 * Analyses a parsed log.
 * @param {{ lines: Line[], calls: Call[], notes: Line[], broken: { n: number, reason: string }[], blank: number[] }} parsed
 */
export function analyse(parsed) {
  /** @type {CallEntry[]} */
  const entries = parsed.calls.map((call) => ({
    call, effect: classify(call), marks: [], repeat: null, interval: unknown('time_anomaly'), offset: null,
  }));
  markRepeats(entries);
  const files = fileEntries(entries);
  const time = timeOf(parsed.lines, entries);

  const callLines = entries.map((e) => e.call.n);
  const requestLines = entries.flatMap((e) => e.effect.requests.map((r) => r.n));
  const markLines = (kind) => entries.flatMap((e) => e.effect.requests
    .filter((_, i) => e.marks[i] !== null && e.marks[i].kind === kind).map((r) => r.n));

  return {
    totals: {
      lines: parsed.lines.length,
      calls: entries.length,
      notes: parsed.notes.length,
      noteLines: parsed.notes.map((x) => x.n),
      blocked: entries.filter((e) => e.effect.category === 'blocked').map((e) => e.call.n),
      blank: [...parsed.blank],
      broken: parsed.broken.map((b) => ({ n: b.n, reason: b.reason })),
      partial: parsed.broken.length > 0,
    },
    calls: entries,
    files,
    top: overallTop(files),
    topWhole: overallWhole(files),
    requests: countOf(requestLines, callLines),
    repeats: countOf(markLines('repeat'), requestLines, callLines),
    unchecked: countOf(markLines('unchecked'), requestLines, callLines),
    notRecorded: countOf(entries.filter((e) => e.call.permission === 'not_recorded').map((e) => e.call.n), callLines),
    ...firstSourceOf(entries, time.span),
    time,
  };
}
