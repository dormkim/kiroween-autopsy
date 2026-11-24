// Invariant checks shared by metrics.test.mjs and samples-invariants.test.mjs.
// Each throws an assertion error naming the property and what was expected.
// Node-only test helper: imports core, never ui. No writes, no processes, no network.

import assert from 'node:assert/strict';

const KINDS = new Set(['call', 'note', 'broken', 'blank']);

/** P1: every log line is exactly one kind, numbered 1..N in order. */
export function checkLineKinds(parsed, total) {
  assert.equal(parsed.lines.length, total, `P1: expected ${total} log lines`);
  parsed.lines.forEach((line, i) => {
    assert.equal(line.n, i + 1, `P1: log line ${i + 1} must carry n = ${i + 1}`);
    assert.ok(KINDS.has(line.kind), `P1: log line ${i + 1} has kind ${line.kind}, expected call, note, broken or blank`);
  });
  const sum = parsed.calls.length + parsed.notes.length + parsed.broken.length + parsed.blank.length;
  assert.equal(sum, total, 'P1: calls + notes + broken + blank must equal the number of log lines');
}

/** Every request of the analysis, in log order. */
export const allRequests = (a) => a.calls.flatMap((c) => c.effect.requests);

/** Naive per-line count: line -> { count, lines } for range requests. */
export function naiveCounts(requests) {
  const out = new Map();
  for (const r of requests) {
    if (r.kind !== 'range') continue;
    for (let x = r.from; x <= r.to; x += 1) {
      const e = out.get(x) ?? { count: 0, lines: new Set() };
      e.count += 1;
      e.lines.add(r.n);
      out.set(x, e);
    }
  }
  return out;
}

/**
 * P12: intervals are sorted, disjoint, count >= 1, and match a naive per-line count,
 * including the log lines of the covering requests.
 * @param {{ from: number, to: number, count: number, lines: number[] }[]} intervals
 * @param {object[]} requests
 * @param {string} label
 */
export function checkIntervals(intervals, requests, label) {
  const naive = naiveCounts(requests);
  let prevTo = -Infinity;
  let covered = 0;
  for (const iv of intervals) {
    assert.ok(iv.from <= iv.to, `P12 ${label}: interval ${iv.from}..${iv.to} must have from <= to`);
    assert.ok(iv.from > prevTo, `P12 ${label}: intervals must be sorted and disjoint, ${iv.from} follows ${prevTo}`);
    assert.ok(iv.count >= 1, `P12 ${label}: interval ${iv.from}..${iv.to} must have count >= 1`);
    prevTo = iv.to;
    for (let x = iv.from; x <= iv.to; x += 1) {
      const e = naive.get(x);
      assert.ok(e, `P12 ${label}: line ${x} is in an interval but no range covers it`);
      assert.equal(iv.count, e.count, `P12 ${label}: line ${x} count, naive count ${e.count}`);
      assert.deepEqual(iv.lines, [...e.lines].sort((p, q) => p - q), `P12 ${label}: line ${x} log lines must be the covering requests`);
      covered += 1;
    }
  }
  assert.equal(covered, naive.size, `P12 ${label}: every naively counted line must be in exactly one interval`);
}

/** P12 for every file of an analysis. */
export function checkFileCounts(a) {
  const byFile = new Map();
  for (const r of allRequests(a)) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, reqs] of byFile) {
    assert.ok(a.files.has(file), `P12: requested file ${file} must have an entry in files`);
    checkIntervals(a.files.get(file).counts, reqs, file);
  }
  assert.equal(a.files.size, byFile.size, 'P12: files holds exactly the requested files');
}

const couldEdit = (e) => e.hiddenEdit || e.edits.some((x) => x.cls === 'unknown');

/** P15: first source edit attempt and the calls before it that could have changed files. */
export function checkFirstSource(a) {
  const firstIdx = a.calls.findIndex((c) => c.effect.edits.some((x) => x.cls === 'source'));
  if (firstIdx === -1) {
    assert.equal(a.firstSource.value, null, 'P15: with no source edit attempt the value is null, never 0');
    assert.equal(a.firstSource.reason, 'none_recognised', 'P15: reason none_recognised');
  } else {
    const c = a.calls[firstIdx];
    assert.equal(a.firstSource.value.call, c.call.index, 'P15: first source edit attempt is the first call with a source edit');
    assert.equal(a.firstSource.value.n, c.call.n, 'P15: log line of the first source edit attempt');
  }
  const earlier = (firstIdx === -1 ? a.calls : a.calls.slice(0, firstIdx)).filter((x) => couldEdit(x.effect)).map((x) => x.call.n);
  assert.equal(a.possibleEarlier.value, earlier.length, 'P15: possibleEarlier counts earlier calls with hiddenEdit or an unknown-target edit');
  if (earlier.length > 0) assert.deepEqual(a.possibleEarlier.lines, earlier, 'P15: possibleEarlier is traced to those calls');
}

/** P16: known intervals plus unknown gaps equal span, and so do the byCategory totals. */
export function checkTime(a) {
  const span = a.time.span.value;
  const known = a.calls.map((c) => c.interval.value).filter((v) => v !== null);
  for (const v of known) assert.ok(v >= 0, `P16: a known interval must be >= 0, got ${v}`);
  if (span === null) {
    assert.equal(known.length, 0, 'P16: no known interval when span is unknown');
    return;
  }
  const gaps = a.time.gaps.reduce((s, g) => s + g.value, 0);
  const sumKnown = known.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sumKnown + gaps - span) < 1e-6, `P16: known ${sumKnown} + gaps ${gaps} must equal span ${span}`);
  let byCat = 0;
  for (const t of a.time.byCategory.values()) byCat += t.value;
  assert.ok(Math.abs(byCat - span) < 1e-6, `P16: byCategory total ${byCat} must equal span ${span}`);
}

/** Every traced value of an analysis with a name for messages. */
export function tracedValues(a) {
  const out = [
    ['top', a.top], ['topWhole', a.topWhole], ['requests', a.requests], ['repeats', a.repeats], ['unchecked', a.unchecked],
    ['firstSource', a.firstSource], ['possibleEarlier', a.possibleEarlier],
    ['time.span', a.time.span], ['time.afterRepeats', a.time.afterRepeats],
  ];
  a.time.longest.forEach((t, i) => out.push([`time.longest[${i}]`, t]));
  a.time.gaps.forEach((t, i) => out.push([`time.gaps[${i}]`, t]));
  for (const [k, t] of a.time.byCategory) out.push([`time.byCategory.${k}`, t]);
  a.calls.forEach((c) => out.push([`interval of call ${c.call.index}`, c.interval]));
  return out;
}

/** P18: non-null values have non-empty, sorted, unique lines within 1..N; null values have a reason. */
export function checkTraced(a, total) {
  for (const [name, t] of tracedValues(a)) {
    assert.ok(t && 'value' in t && Array.isArray(t.lines) && 'reason' in t, `P18: ${name} must be { value, lines, reason }`);
    if (t.value === null) {
      assert.equal(typeof t.reason, 'string', `P18: ${name} is null, so it needs a reason code`);
    } else {
      assert.equal(t.reason, null, `P18: ${name} has a value, so its reason is null`);
      assert.ok(t.lines.length > 0, `P18: ${name} has a value, so it must be traced to at least one log line`);
    }
    t.lines.forEach((n, i) => {
      assert.ok(Number.isInteger(n) && n >= 1 && n <= total, `P18: ${name} line ${n} must be within 1..${total}`);
      if (i > 0) assert.ok(n > t.lines[i - 1], `P18: ${name} lines must be sorted and unique`);
    });
  }
}

/** P20 (analysis part): partial exactly when some line is broken. */
export function checkPartial(a) {
  assert.equal(a.totals.partial, a.totals.broken.length > 0, 'P20: partial is true exactly when some log line is broken');
}
