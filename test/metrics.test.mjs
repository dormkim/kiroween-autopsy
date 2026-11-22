// Tests for src/core/metrics.js.
// Run: node --permission --allow-fs-read=. test/metrics.test.mjs
// Expected values follow design "Repeat requests", "First source edit attempt" and "Time".
// Hand-built logs are written here line by line; each expected value names its log lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/core/parse.js';
import {
  analyse, MAX_BYTES, MAX_LINE, T_MIN, T_MAX, CUT_LEN, ROOT, LONGEST,
} from '../src/core/metrics.js';
import { check, sessionLines } from './gen.mjs';
import {
  checkFileCounts, checkFirstSource, checkTime, checkTraced, checkPartial, allRequests,
} from './invariants.mjs';

const T0 = 1795248000;
const pre = (fields) => JSON.stringify({ hook: 'pre', allow: true, cmd_truncated: false, paths: [], range: {}, cmd: '', ...fields });
const read = (t, file, offset, limit) => {
  let range = {};
  if (limit !== undefined) range = { offset, limit };
  else if (offset !== undefined) range = { offset };
  return pre({ t, tool: 'read_file', paths: [file], range });
};
const edit = (t, file) => pre({ t, tool: 'str_replace', paths: [file] });
const sh = (t, cmd) => pre({ t, tool: 'execute_bash', cmd });
const note = (t) => JSON.stringify({ t, hook: 'post', scope: {} });
const run = (lines) => analyse(parse(lines.join('\n')));
const fixture = (name) => analyse(parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')));

/** Per request in log order: [log line, mark kind or null, earlier log lines or null]. */
const marks = (a) => a.calls.flatMap((c) => c.marks.map((m) => [c.call.n, m === null ? null : m.kind, m === null ? null : m.earlier]));

test('exported constants match design.md', () => {
  assert.equal(MAX_BYTES, 50 * 1024 * 1024, '50 MB');
  assert.equal(MAX_LINE, 10_000_000);
  assert.equal(T_MIN, 946684800, '2000-01-01');
  assert.equal(T_MAX, 4102444800, '2100-01-01');
  assert.equal(CUT_LEN, 200);
  assert.equal(ROOT, '/workspace');
  assert.equal(LONGEST, 5);
});

test('totals on some-broken.jsonl: two calls, one note, eight broken lines, partial', () => {
  const a = fixture('some-broken.jsonl');
  assert.equal(a.totals.lines, 11, 'the fixture has 11 log lines');
  assert.equal(a.totals.calls, 2, 'calls on log lines 1 and 6');
  assert.equal(a.totals.notes, 1, 'the post line on log line 7');
  assert.deepEqual(a.totals.noteLines, [7]);
  assert.deepEqual(a.totals.broken.map((b) => b.n), [2, 3, 4, 5, 8, 9, 10, 11], 'broken log lines');
  assert.deepEqual(a.totals.blank, []);
  assert.deepEqual(a.totals.blocked, []);
  assert.equal(a.totals.partial, true, 'some lines are broken, so every result is partial');
});

test('totals on blocked.jsonl: blocked calls by log line, not partial', () => {
  const a = fixture('blocked.jsonl');
  assert.deepEqual(a.totals.blocked, [2, 3], 'allow false on log lines 2 and 3');
  assert.equal(a.totals.partial, false);
});

test('files: counts, open and unlocated requests, top and lowerBound', () => {
  const a = run([
    read(T0, 'a.py', 0, 10), // 1: lines 1..10
    read(T0 + 1, 'a.py'), // 2: open from 1
    sh(T0 + 2, 'grep -n x a.py'), // 3: unlocated
    read(T0 + 3, 'b.py', 0, 5), // 4: lines 1..5
  ]);
  const fa = a.files.get('a.py');
  assert.deepEqual(fa.counts, [{ from: 1, to: 10, count: 1, lines: [1] }]);
  assert.deepEqual(fa.open.map((r) => r.n), [2], 'log line 2 is open-ended');
  assert.deepEqual(fa.unlocated.map((r) => r.n), [3], 'log line 3 has unknown lines');
  assert.equal(fa.lowerBound, true, 'a.py has open and unlocated requests, so its counts are a lower bound');
  assert.deepEqual(fa.top, { from: 1, to: 10, count: 1, lines: [1] });
  assert.equal(a.files.get('b.py').lowerBound, false, 'b.py has only an explicit range');
  assert.deepEqual(a.top.value, { file: 'a.py', from: 1, to: 10, count: 1 }, 'a.py 1..10 is longer than b.py 1..5');
  assert.deepEqual(a.top.lines, [1]);
});

test('top is null with a reason when no explicit range was requested', () => {
  const a = run([read(T0, 'a.py'), sh(T0 + 1, 'ls')]);
  assert.equal(a.top.value, null, 'an open request is not counted');
  assert.equal(typeof a.top.reason, 'string');
  assert.equal(a.requests.value, 1, 'one request on log line 1');
  assert.deepEqual(a.requests.lines, [1]);
});

const REPEAT_LOG = [
  read(T0, 'a.py', 0, 10), // 1: 1..10, first: no mark
  read(T0 + 1, 'a.py', 5, 10), // 2: 6..15 overlaps 1: repeat
  read(T0 + 2, 'a.py', 20, 5), // 3: 21..25, no overlap and nothing open: no mark
  read(T0 + 3, 'b.py'), // 4: open on b.py, nothing before: no mark
  read(T0 + 4, 'b.py', 0, 5), // 5: 1..5, open from 1 on line 4: unchecked
  sh(T0 + 5, 'grep -n x b.py'), // 6: unlocated with b.py requests before: unchecked
  edit(T0 + 6, 'a.py'), // 7: resets a.py
  read(T0 + 7, 'a.py', 0, 10), // 8: right after the edit: no mark
  edit(T0 + 8, 'c.py'), // 9: another file, no reset of a.py
  read(T0 + 9, 'a.py', 0, 10), // 10: repeat of 8
  sh(T0 + 10, 'cat a.py > a.py'), // 11: open request first (unchecked), then the edit resets a.py
  read(T0 + 11, 'a.py', 0, 10), // 12: no mark, a.py was reset on line 11
  sh(T0 + 12, 'echo x > $OUT'), // 13: unknown target: no reset
  read(T0 + 13, 'a.py', 0, 10), // 14: repeat of 12
  sh(T0 + 14, 'python3 x.py'), // 15: unknown effect: no reset
  read(T0 + 15, 'a.py', 0, 10), // 16: repeat of 12 and 14
];

test('repeat and unchecked marks for each rule, with the earlier log lines', () => {
  assert.deepEqual(marks(run(REPEAT_LOG)), [
    [1, null, null],
    [2, 'repeat', [1]],
    [3, null, null],
    [4, null, null],
    [5, 'unchecked', [4]],
    [6, 'unchecked', [4, 5]],
    [8, null, null],
    [10, 'repeat', [8]],
    [11, 'unchecked', [8, 10]],
    [12, null, null],
    [14, 'repeat', [12]],
    [16, 'repeat', [12, 14]],
  ], 'see the comment on each log line of REPEAT_LOG');
});

test('requests, repeats and unchecked are separate traced counts', () => {
  const a = run(REPEAT_LOG);
  assert.deepEqual([a.requests.value, a.requests.lines], [12, [1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 14, 16]]);
  assert.deepEqual([a.repeats.value, a.repeats.lines], [4, [2, 10, 14, 16]]);
  assert.deepEqual([a.unchecked.value, a.unchecked.lines], [3, [5, 6, 11]]);
});

test('a call mark is repeat if any request repeats, otherwise unchecked if any is', () => {
  const a = run(REPEAT_LOG);
  const byLine = new Map(a.calls.map((c) => [c.call.n, c.repeat]));
  assert.deepEqual(byLine.get(2), { kind: 'repeat', earlier: [1] });
  assert.deepEqual(byLine.get(11), { kind: 'unchecked', earlier: [8, 10] });
  assert.equal(byLine.get(7), null, 'an edit attempt has no request and no mark');
});

test('zero repeats is a proven 0, traced to the requests that were checked', () => {
  const a = run([read(T0, 'a.py', 0, 10), read(T0 + 1, 'a.py', 20, 10)]);
  assert.deepEqual([a.repeats.value, a.repeats.lines, a.repeats.reason], [0, [1, 2], null]);
  assert.deepEqual([a.unchecked.value, a.unchecked.lines], [0, [1, 2]]);
});

test('with no request at all, counts are 0 traced to the calls; with no call they are unknown', () => {
  const a = run([sh(T0, 'ls'), sh(T0 + 1, 'git status')]);
  assert.deepEqual([a.requests.value, a.requests.lines], [0, [1, 2]], 'both calls were classified, neither requested lines');
  const b = fixture('post-only.jsonl');
  assert.equal(b.requests.value, null, 'no calls: unknown, never 0');
  assert.equal(b.requests.reason, 'no_calls');
});

// ---- first source edit attempt ----

test('firstSource with offset and share; possibleEarlier and otherEdits', () => {
  const a = run([
    read(T0, 'a.py', 0, 10), // 1
    edit(T0 + 10, 'docs/x.md'), // 2: class other
    sh(T0 + 20, 'python3 x.py'), // 3: hidden edit
    edit(T0 + 30, 'a.py'), // 4: first source edit attempt
    edit(T0 + 40, 'pkg/b.py'), // 5: a later source edit
    note(T0 + 60), // 6: last valid event
  ]);
  assert.deepEqual(a.firstSource.value, { call: 4, n: 4, file: 'a.py', offset: 30, share: 0.5 },
    'call 4 at 30 s of a 60 s span (log lines 1 to 6)');
  assert.deepEqual(a.firstSource.lines, [4]);
  assert.deepEqual([a.possibleEarlier.value, a.possibleEarlier.lines], [1, [3]], 'python3 on log line 3 could have changed files');
  assert.deepEqual(a.otherEdits.map((e) => [e.n, e.file, e.cls]), [[2, 'docs/x.md', 'other'], [5, 'pkg/b.py', 'source']],
    'every edit that is not the first source edit attempt, in log order');
});

test('no source edit attempt: null with reason none_recognised, possibleEarlier covers the session', () => {
  const a = run([read(T0, 'a.py', 0, 10), sh(T0 + 1, 'python3 x.py'), sh(T0 + 2, 'echo x > tests/test_a.py')]);
  assert.equal(a.firstSource.value, null, 'never 0 and never "did not edit"');
  assert.equal(a.firstSource.reason, 'none_recognised');
  assert.deepEqual([a.possibleEarlier.value, a.possibleEarlier.lines], [1, [2]]);
  assert.deepEqual(a.otherEdits.map((e) => [e.n, e.cls]), [[3, 'test']]);
});

test('possibleEarlier 0 is traced to the earlier calls, or to the edit itself on call 1', () => {
  const a = run([read(T0, 'a.py', 0, 10), sh(T0 + 1, 'ls'), edit(T0 + 2, 'a.py')]);
  assert.deepEqual([a.possibleEarlier.value, a.possibleEarlier.lines], [0, [1, 2]], 'log lines 1 and 2 were checked');
  const b = run([edit(T0, 'a.py'), sh(T0 + 1, 'ls')]);
  assert.deepEqual([b.possibleEarlier.value, b.possibleEarlier.lines], [0, [1]], 'no earlier call: traced to log line 1');
});

test('firstSource offset and share are null when its time is unknown', () => {
  const a = run([read(T0, 'a.py', 0, 10), pre({ tool: 'str_replace', paths: ['a.py'] }), sh(T0 + 10, 'ls')]);
  assert.equal(a.firstSource.value.call, 2);
  assert.equal(a.firstSource.value.offset, null, 'log line 2 has no t');
  assert.equal(a.firstSource.value.share, null);
});

// ---- time ----

test('intervals run call to next call; notes do not split them; the last call runs to the last valid event', () => {
  const a = run([sh(T0, 'ls'), note(T0 + 2), sh(T0 + 5, 'pwd'), note(T0 + 9)]);
  assert.deepEqual(a.calls.map((c) => [c.interval.value, c.interval.lines]), [[5, [1, 3]], [4, [3, 4]]]);
  assert.deepEqual([a.time.span.value, a.time.span.lines], [9, [1, 4]], 'first call to last valid event');
  assert.deepEqual(a.calls.map((c) => c.offset), [0, 5], 'offsets from the first call');
  assert.deepEqual(a.time.gaps, []);
});

test('the last call that is also the last event has a proven 0 interval', () => {
  const a = fixture('blocked.jsonl');
  const last = a.calls[a.calls.length - 1];
  assert.deepEqual([last.interval.value, last.interval.lines], [0, [4]], 'log line 4 is the last call and the last event');
  assert.deepEqual([a.time.span.value, a.time.span.lines], [3, [1, 4]]);
});

test('time-anomalies.jsonl: anomalies, null intervals, one unknown gap, span 20 s', () => {
  const a = fixture('time-anomalies.jsonl');
  assert.deepEqual(a.time.anomalies, [
    { n: 2, reason: 'missing' },
    { n: 3, reason: 'not_a_number' },
    { n: 4, reason: 'out_of_range' },
    { n: 5, reason: 'backwards' },
  ], 'log line 2 has no t, 3 has a string, 4 is past 2100, 5 is earlier than log line 1');
  assert.deepEqual(a.calls.map((c) => c.interval.value), [null, null, null, null, null, 10],
    'calls 1 to 5 border an unknown time; call 6 runs to the note on log line 7');
  assert.ok(a.calls.slice(0, 5).every((c) => c.interval.reason === 'time_anomaly'), 'reason time_anomaly');
  assert.deepEqual(a.calls[5].interval.lines, [6, 7]);
  assert.deepEqual(a.calls.map((c) => c.call.n), [1, 2, 3, 4, 5, 6], 'log order is kept');
  assert.deepEqual(a.calls.map((c) => c.offset), [0, null, null, null, null, 10]);
  assert.deepEqual([a.time.span.value, a.time.span.lines], [20, [1, 7]]);
  assert.deepEqual(a.time.gaps.map((g) => [g.value, g.lines]), [[10, [1, 2, 3, 4, 5, 6]]],
    'log lines 1 and 6 have accepted times but are not neighbours');
  assert.deepEqual(a.time.byCategory.get('unknown_time').value, 10);
  assert.deepEqual(a.time.byCategory.get('request').value, 10, 'the read_file on log line 6');
  assert.equal(a.time.byCategory.has('search'), false, 'the ls calls have no known interval');
});

test('a call after the last accepted call with an unknown time leaves an unknown tail gap', () => {
  const a = run([sh(T0, 'ls'), sh(T0 + 4, 'pwd'), pre({ tool: 'execute_bash', cmd: 'ls' }), note(T0 + 10)]);
  assert.deepEqual(a.calls.map((c) => c.interval.value), [4, null, null]);
  assert.deepEqual(a.time.gaps.map((g) => [g.value, g.lines]), [[6, [2, 3, 4]]], 'from log line 2 to the note on log line 4');
  assert.equal(a.time.span.value, 10);
});

test('longest holds the LONGEST known intervals, longest first, earlier call on ties', () => {
  const ts = [0, 1, 3, 6, 10, 15, 21, 28, 28];
  const a = run(ts.map((d) => sh(T0 + d, 'ls')));
  assert.deepEqual(a.time.longest.map((t) => [t.value.call, t.value.seconds, t.lines]), [
    [7, 7, [7, 8]], [6, 6, [6, 7]], [5, 5, [5, 6]], [4, 4, [4, 5]], [3, 3, [3, 4]],
  ], 'intervals are 1..7 s and 0; the top five, each with both log lines');
  const b = run([sh(T0, 'ls'), sh(T0 + 2, 'ls'), sh(T0 + 4, 'ls')]);
  assert.deepEqual(b.time.longest.map((t) => t.value.call), [1, 2, 3], 'equal 2 s intervals keep call order; the last has 0 s');
});

test('afterRepeats sums intervals after repeat-request calls and counts unknown ones', () => {
  const a = run([read(T0, 'a.py', 0, 10), read(T0 + 3, 'a.py', 0, 10), read(T0 + 10, 'a.py', 0, 10), sh(T0 + 12, 'ls')]);
  assert.deepEqual(a.time.afterRepeats.value, { seconds: 9, calls: 2, unknown: 0 }, 'calls 2 and 3: 7 s and 2 s');
  assert.deepEqual(a.time.afterRepeats.lines, [2, 3, 4]);
  const b = run([read(T0, 'a.py', 0, 10), read(T0 + 3, 'a.py', 0, 10), pre({ tool: 'read_file', paths: ['a.py'], range: { offset: 0, limit: 10 } }), sh(T0 + 12, 'ls')]);
  assert.deepEqual(b.time.afterRepeats.value, { seconds: 0, calls: 2, unknown: 2 }, 'log line 3 has no t, so both intervals are unknown');
  assert.deepEqual(b.time.afterRepeats.lines, [2, 3]);
  const c = run([read(T0, 'a.py', 0, 10), sh(T0 + 1, 'ls')]);
  assert.deepEqual([c.time.afterRepeats.value, c.time.afterRepeats.reason], [null, 'no_repeats']);
});

// ---- properties on generated logs ----

const genLog = (r) => sessionLines(r);

/** Analysis without the parsed Call objects, which hold the logged paths. */
const project = (a) => ({
  ...a,
  calls: a.calls.map(({ call, ...rest }) => ({ ...rest, n: call.n, index: call.index })),
});

test('P3: changing kind, spans, call, or paths on shell calls changes no result', () => {
  check('P3 analysis', { runs: 150 }, genLog, (lines) => {
    const noisy = lines.map((raw, i) => {
      const o = JSON.parse(raw);
      if (o.hook !== 'pre') return raw;
      o.kind = ['read', 'shell_edit', 'other'][i % 3];
      o.spans = { 'zz.py': [0, i] };
      o.call = 1000 - i;
      if (o.tool === 'execute_bash') o.paths = ['src/zz.py', '/workspace'];
      return JSON.stringify(o);
    });
    assert.deepEqual(project(run(noisy)), project(run(lines)), 'logged kind, spans, call and shell paths are ignored');
  });
});

const lastT = (lines, i) => {
  for (let k = i; k >= 0; k -= 1) {
    const o = JSON.parse(lines[k]);
    if (typeof o.t === 'number') return o.t;
  }
  return T0;
};

test('P14: an edit on G never changes marks on other files', () => {
  check('P14 isolation', { runs: 200 }, (r) => {
    const lines = genLog(r);
    const at = r.int(0, lines.length);
    return { lines, at, g: r.pick(['a.py', 'pkg/b.py', 'tests/test_c.py', 'docs/d.md']) };
  }, ({ lines, at, g }) => {
    const before = run(lines);
    const inserted = [...lines.slice(0, at), edit(lastT(lines, at - 1), g), ...lines.slice(at)];
    const after = run(inserted);
    const shift = (n) => (n > at ? n + 1 : n);
    const keep = (a, mapLine) => a.calls.flatMap((c) => c.effect.requests.map((req, i) => [req, c.marks[i]]))
      .filter(([req]) => req.file !== g)
      .map(([req, m]) => [mapLine(req.n), m === null ? null : m.kind, m === null ? null : m.earlier.map(mapLine)]);
    assert.deepEqual(keep(after, (n) => n), keep(before, shift), `inserting an edit on ${g} must not change marks on other files`);
  });
});

test('P14: a repeated explicit range with no edit on its file in between is a repeat', () => {
  check('P14 repeat', { runs: 200 }, genLog, (lines) => {
    const a = run(lines);
    const ranges = allRequests(a).filter((q) => q.kind === 'range');
    const candidates = ranges.filter((q) => !a.calls.some((c) => c.call.n > q.n && c.effect.edits.some((e) => e.file === q.file)));
    if (candidates.length === 0) return true;
    const q = candidates[candidates.length - 1];
    const b = run([...lines, read(lastT(lines, lines.length - 1), q.file, q.from - 1, q.to - q.from + 1)]);
    const last = b.calls[b.calls.length - 1];
    assert.equal(last.marks[0]?.kind, 'repeat', `log line ${q.n} requested ${q.file} ${q.from}..${q.to} with no edit since`);
    return true;
  });
});

test('P14: a request right after an edit on its file is never a repeat; repeats + unchecked <= requests', () => {
  check('P14 reset', { runs: 200 }, (r) => ({ lines: genLog(r), file: r.pick(['a.py', 'pkg/b.py']) }), ({ lines, file }) => {
    const t = lastT(lines, lines.length - 1);
    const a = run([...lines, edit(t, file), read(t, file, 0, 50)]);
    const last = a.calls[a.calls.length - 1];
    assert.equal(last.marks[0], null, `the request right after the edit on ${file} has nothing earlier to repeat`);
    assert.ok(a.repeats.value + a.unchecked.value <= a.requests.value, 'repeats + unchecked <= requests');
  });
});

test('P15, P16, P18, P20 and P12 on generated logs, some with a broken line', () => {
  check('analysis invariants', { runs: 200 }, (r) => {
    const lines = genLog(r);
    if (r.bool(0.3)) lines.splice(r.int(0, lines.length), 0, r.pick(['{oops', '[1]', '{"tool":"x"}']));
    return lines;
  }, (lines) => {
    const a = run(lines);
    checkFirstSource(a);
    checkTime(a);
    checkTraced(a, lines.length);
    checkPartial(a);
    checkFileCounts(a);
  });
});

test('P17: one bad t gives an anomaly and null intervals, never 0, and keeps call order', () => {
  check('P17 time anomalies', { runs: 300 }, (r) => {
    const lines = genLog(r);
    const callIdx = lines.map((raw, i) => [raw, i]).filter(([raw]) => JSON.parse(raw).hook === 'pre').map(([, i]) => i);
    const j = r.pick(callIdx);
    const kind = r.pick(['missing', 'nan', 'huge', 'negative', 'earlier']);
    return { lines, j, kind };
  }, ({ lines, j, kind }) => {
    const o = JSON.parse(lines[j]);
    const first = JSON.parse(lines[0]).t;
    if (kind === 'missing') delete o.t;
    else if (kind === 'nan') o.t = 'NaN';
    else if (kind === 'huge') o.t = 1e12;
    else if (kind === 'negative') o.t = -5;
    else o.t = j === 0 ? -5 : first - 100;
    const bad = [...lines];
    bad[j] = JSON.stringify(o);
    const a = run(bad);
    const n = j + 1;
    assert.ok(a.time.anomalies.some((x) => x.n === n), `log line ${n} must be listed as a time anomaly`);
    const k = a.calls.findIndex((c) => c.call.n === n);
    assert.equal(a.calls[k].interval.value, null, `the call on log line ${n} has an unknown interval, never 0`);
    assert.equal(a.calls[k].offset, null, 'its offset is unknown');
    if (k > 0) assert.equal(a.calls[k - 1].interval.value, null, 'the interval of the call before it is unknown too');
    assert.deepEqual(a.calls.map((c) => c.call.index), a.calls.map((_, i) => i + 1), 'call order is log order');
    checkTime(a);
    checkTraced(a, bad.length);
  });
});
