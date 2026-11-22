// Sample tests (R11.3): every value below was derived by hand from the log text and is
// copied from the samples.test.mjs table in design.md. If a test fails, re-check the log
// before changing either the test or the code.
// Run: node --permission --allow-fs-read=. test/samples.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/core/parse.js';
import { analyse } from '../src/core/metrics.js';

const load = (name) => analyse(parse(readFileSync(new URL(`../samples/${name}.events.jsonl`, import.meta.url), 'utf8')));
const RULE = 'Re-check the log before changing either side.';
const why = (sample, what, lines) => `${sample}: expected ${what}, derived by hand from log lines ${lines}. ${RULE}`;
const near = (got, want, eps, message) => {
  assert.ok(typeof got === 'number' && Math.abs(got - want) <= eps, `${message} Got ${got}.`);
};

/** Mark kinds of the requests on one log line. */
const marksOn = (a, n) => {
  const c = a.calls.find((x) => x.call.n === n);
  return c.marks.map((m) => (m === null ? null : m.kind));
};

const TABLE = {
  'requests-6644': {
    lines: 72, calls: 71, notes: [47], blocked: [],
    span: [456.932, [1, 72]],
    first: { call: 46, n: 46, file: 'src/requests/models.py', offset: 177.800, share: 0.389 },
    earlier: [13, [4, 8, 21, 32, 33, 34, 35, 36, 39, 40, 41, 42, 44]],
    top: [{ file: 'src/requests/models.py', from: 81, to: 100, count: 3 }, [20, 45, 67]],
    requests: 13, repeats: [1, [45]],
    longest: [69.441, 65, [66, 67]],
  },
  'rich-3506': {
    lines: 78, calls: 78, notes: [], blocked: [4, 27],
    span: [351.992, [1, 78]],
    first: null,
    earlier: [23, null],
    top: [{ file: 'rich/segment.py', from: 110, to: 120, count: 6 }, [20, 21, 39, 56, 66, 67]],
    requests: 19, repeats: [7, [21, 39, 55, 56, 66, 67, 77]],
    longest: [17.612, 71, [71, 72]],
  },
  'rich-3480': {
    lines: 172, calls: 171, notes: [163], blocked: [2, 37],
    span: [887.957, [1, 172]],
    first: { call: 162, n: 162, file: 'rich/text.py', offset: 801.497, share: 0.903 },
    earlier: [35, null],
    top: [{ file: 'rich/text.py', from: 1007, to: 1010, count: 8 }, [8, 30, 86, 99, 118, 127, 164, 172]],
    requests: 69, repeats: [27, null],
    longest: [18.299, 144, [144, 145]],
  },
};

for (const [sample, want] of Object.entries(TABLE)) {
  test(`${sample}: log lines, calls, notes and blocked calls`, () => {
    const a = load(sample);
    assert.equal(a.totals.lines, want.lines, why(sample, `${want.lines} log lines`, `1 to ${want.lines}`));
    assert.equal(a.totals.calls, want.calls, why(sample, `${want.calls} calls (pre lines, blocked included)`, `1 to ${want.lines}`));
    assert.deepEqual(a.totals.noteLines, want.notes, why(sample, `notes on log lines ${want.notes.join(', ') || 'none'}`, 'with "hook": "post"'));
    assert.deepEqual(a.totals.blocked, want.blocked, why(sample, `blocked calls on ${want.blocked.join(', ') || 'none'}`, 'with "allow": false'));
    assert.equal(a.totals.partial, false, why(sample, 'no broken line', 'all'));
  });

  test(`${sample}: span`, () => {
    const a = load(sample);
    near(a.time.span.value, want.span[0], 1e-3, why(sample, `span ${want.span[0]} s`, want.span[1].join(' and ')));
    assert.deepEqual(a.time.span.lines, want.span[1], why(sample, 'the span traced to its two ends', want.span[1].join(' and ')));
  });

  test(`${sample}: first source edit attempt and the calls that could have changed files`, () => {
    const a = load(sample);
    const fs = a.firstSource.value;
    if (want.first === null) {
      assert.equal(fs, null, why(sample, 'no source edit attempt recognised', 'all str_replace and write calls'));
      assert.equal(a.firstSource.reason, 'none_recognised', why(sample, 'reason none_recognised', 'all'));
    } else {
      const where = String(want.first.n);
      assert.deepEqual([fs.call, fs.n, fs.file], [want.first.call, want.first.n, want.first.file], why(sample, `call ${want.first.call} on ${want.first.file}`, where));
      near(fs.offset, want.first.offset, 1e-3, why(sample, `offset ${want.first.offset} s`, `1 and ${where}`));
      near(fs.share, want.first.share, 1e-3, why(sample, `share ${want.first.share}`, `1, ${where} and ${want.lines}`));
    }
    const [count, lines] = want.earlier;
    assert.equal(a.possibleEarlier.value, count, why(sample, `${count} calls that could have changed files`, lines === null ? 'the table in design.md' : lines.join(', ')));
    if (lines !== null) assert.deepEqual(a.possibleEarlier.lines, lines, why(sample, 'those calls by log line', lines.join(', ')));
  });

  test(`${sample}: most requested range`, () => {
    const a = load(sample);
    const [value, lines] = want.top;
    assert.deepEqual(a.top.value, value, why(sample, `${value.file} ${value.from} to ${value.to}, ${value.count} times`, lines.join(', ')));
    assert.deepEqual(a.top.lines, lines, why(sample, 'the covering requests', lines.join(', ')));
  });

  test(`${sample}: requests and repeat requests`, () => {
    const a = load(sample);
    assert.equal(a.requests.value, want.requests, why(sample, `${want.requests} requests`, 'the request table in design.md'));
    const [count, lines] = want.repeats;
    assert.equal(a.repeats.value, count, why(sample, `${count} repeat requests`, lines === null ? 'the table in design.md' : lines.join(', ')));
    if (lines !== null) assert.deepEqual(a.repeats.lines, lines, why(sample, 'repeat requests by log line', lines.join(', ')));
  });

  test(`${sample}: longest interval`, () => {
    const a = load(sample);
    const [seconds, call, lines] = want.longest;
    const top = a.time.longest[0];
    near(top.value.seconds, seconds, 1e-3, why(sample, `longest interval ${seconds} s`, lines.join(' and ')));
    assert.equal(top.value.call, call, why(sample, `the longest interval after call ${call}`, lines.join(' and ')));
    assert.deepEqual(top.lines, lines, why(sample, 'both ends of the longest interval', lines.join(' and ')));
  });
}

test('requests-6644: log line 67 (call 66) is not a repeat, because the edit attempt on log line 46 reset models.py', () => {
  const a = load('requests-6644');
  assert.equal(a.calls.find((c) => c.call.n === 67).call.index, 66, why('requests-6644', 'call 66 on log line 67', '47 (a note)'));
  assert.deepEqual(marksOn(a, 67), [null], why('requests-6644', 'no mark on log line 67', '46 and 67'));
});

test('rich-3506: log lines 41 and 42 do not overlap', () => {
  const a = load('rich-3506');
  assert.notEqual(marksOn(a, 42)[0], 'repeat', why('rich-3506', 'offset 630, limit 50 does not overlap offset 530, limit 100', '41 and 42'));
});

test('rich-3480: log line 172 is not a repeat; log line 80 is a request with unknown lines', () => {
  const a = load('rich-3480');
  assert.notEqual(marksOn(a, 172)[0], 'repeat', why('rich-3480', 'no repeat on log line 172, because the edit attempt on log line 165 reset rich/text.py', '165 and 172'));
  const c80 = a.calls.find((c) => c.call.n === 80);
  assert.deepEqual(c80.effect.requests.map((r) => [r.file, r.kind]), [['tests/test_text.py', 'unlocated']],
    why('rich-3480', 'tail -50 tests/test_text.py is a request with unknown lines', '80'));
  assert.ok(a.files.get('tests/test_text.py').lowerBound, why('rich-3480', 'tests/test_text.py line counts are a lower bound', '80'));
});
