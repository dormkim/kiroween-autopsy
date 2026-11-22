// Tests for src/core/lines.js.
// Run: node --permission --allow-fs-read=. test/lines.test.mjs
// Expected values follow design "Line counts (lines.js)": a sweep over range requests,
// intervals with the count and the log lines of the covering requests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLines, topInterval } from '../src/core/lines.js';
import { MAX_LINE } from '../src/core/classify.js';
import { check } from './gen.mjs';
import { checkIntervals } from './invariants.mjs';

const range = (from, to, n) => ({ file: 'a.py', call: n, n, kind: 'range', from, to });
const iv = (from, to, count, lines) => ({ from, to, count, lines });

test('no ranges give no intervals', () => {
  assert.deepEqual(countLines([]), []);
});

test('one range is one interval with count 1 and its log line', () => {
  assert.deepEqual(countLines([range(1, 5, 3)]), [iv(1, 5, 1, [3])]);
});

test('nested ranges split into three intervals', () => {
  assert.deepEqual(countLines([range(1, 10, 1), range(3, 4, 2)]), [
    iv(1, 2, 1, [1]), iv(3, 4, 2, [1, 2]), iv(5, 10, 1, [1]),
  ], 'lines 3 and 4 are covered by both requests');
});

test('overlapping ranges', () => {
  assert.deepEqual(countLines([range(4, 8, 2), range(1, 5, 1)]), [
    iv(1, 3, 1, [1]), iv(4, 5, 2, [1, 2]), iv(6, 8, 1, [2]),
  ], 'input order does not matter');
});

test('touching ranges from different requests stay separate', () => {
  assert.deepEqual(countLines([range(1, 5, 1), range(6, 10, 2)]), [iv(1, 5, 1, [1]), iv(6, 10, 1, [2])],
    '1..5 and 6..10 do not overlap, and their covering requests differ');
});

test('a gap between ranges is not an interval', () => {
  assert.deepEqual(countLines([range(1, 2, 1), range(5, 6, 2)]), [iv(1, 2, 1, [1]), iv(5, 6, 1, [2])]);
});

test('neighbours with the same covering log lines are merged', () => {
  assert.deepEqual(countLines([range(1, 5, 7), range(6, 10, 7)]), [iv(1, 10, 1, [7])],
    'two touching ranges from the same log line have the same active set, so they merge');
});

test('the same range twice from one log line counts twice and lists the line once', () => {
  assert.deepEqual(countLines([range(3, 4, 9), range(3, 4, 9)]), [iv(3, 4, 2, [9])],
    'count is the number of requests, lines are unique log lines');
});

test('open and unlocated requests add nothing to counts', () => {
  const open = { file: 'a.py', call: 1, n: 1, kind: 'open', from: 1 };
  const unlocated = { file: 'a.py', call: 2, n: 2, kind: 'unlocated' };
  assert.deepEqual(countLines([open, unlocated, range(2, 3, 3)]), [iv(2, 3, 1, [3])],
    'file length is unknown, so an open request is never turned into counted lines');
});

test('ranges up to MAX_LINE give at most 2r intervals, never one per line', () => {
  const got = countLines([range(1, MAX_LINE, 1), range(5, MAX_LINE, 2), range(100, 200, 3)]);
  assert.ok(got.length <= 6, `3 ranges give at most 6 intervals, got ${got.length}`);
  assert.deepEqual(got, [
    iv(1, 4, 1, [1]), iv(5, 99, 2, [1, 2]), iv(100, 200, 3, [1, 2, 3]), iv(201, MAX_LINE, 2, [1, 2]),
  ]);
});

test('topInterval: count first, then the longer interval, then the smaller from', () => {
  assert.equal(topInterval([]), null, 'no intervals: no top');
  const a = iv(1, 2, 3, [1]);
  const b = iv(10, 30, 2, [2]);
  assert.deepEqual(topInterval([b, a]), a, 'count 3 beats count 2 even when shorter');
  const c = iv(40, 49, 3, [3]);
  assert.deepEqual(topInterval([a, c]), c, 'same count: 10 lines beat 2 lines');
  const d = iv(60, 69, 3, [4]);
  assert.deepEqual(topInterval([d, c]), c, 'same count and length: smaller from wins');
});

test('topInterval overall: path order breaks a full tie', () => {
  const x = { ...iv(5, 9, 2, [1]), file: 'rich/text.py' };
  const y = { ...iv(5, 9, 2, [2]), file: 'rich/segment.py' };
  assert.deepEqual(topInterval([x, y]), y, 'rich/segment.py sorts before rich/text.py');
  assert.deepEqual(topInterval([y, x]), y, 'the result does not depend on input order');
});

const genRanges = (r) => {
  const out = [];
  const k = r.int(0, 12);
  for (let i = 0; i < k; i += 1) {
    const from = r.int(1, 40);
    out.push(range(from, from + r.int(0, 25), r.int(1, 20)));
  }
  return out;
};

test('P12: countLines equals a naive per-line count on generated ranges', () => {
  check('P12 countLines', { runs: 300 }, genRanges, (ranges) => {
    checkIntervals(countLines(ranges), ranges, 'generated');
  });
});

test('P13: topInterval is a maximum count with the documented tie-break', () => {
  check('P13 topInterval', { runs: 300 }, genRanges, (ranges) => {
    const ivs = countLines(ranges);
    const top = topInterval(ivs);
    if (ivs.length === 0) return top === null;
    const max = Math.max(...ivs.map((x) => x.count));
    assert.equal(top.count, max, 'top has the largest count');
    const best = ivs.filter((x) => x.count === max).sort((p, q) => (q.to - q.from) - (p.to - p.from) || p.from - q.from)[0];
    assert.deepEqual(top, best, 'ties go to the longer interval, then the smaller from');
    return true;
  });
});
