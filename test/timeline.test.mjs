// Tests for src/core/timeline.js.
// Run: node --permission --allow-fs-read=. test/timeline.test.mjs
// Expected values follow design "Replay (timeline.js)": one frame per call, and the line
// counts of every request up to replay step k.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/core/parse.js';
import { analyse } from '../src/core/metrics.js';
import { countLines } from '../src/core/lines.js';
import { frames, exposuresAt } from '../src/core/timeline.js';
import { check, sessionLines } from './gen.mjs';

const T0 = 1795248000;
const pre = (fields) => JSON.stringify({ hook: 'pre', allow: true, cmd_truncated: false, paths: [], range: {}, cmd: '', ...fields });
const read = (t, file, offset, limit) => pre({ t, tool: 'read_file', paths: [file], range: { offset, limit } });
const run = (lines) => analyse(parse(lines.join('\n')));

const LOG = [
  read(T0, 'a.py', 0, 10), // 1: lines 1..10
  read(T0 + 2, 'a.py', 5, 10), // 2: lines 6..15, a repeat of 1
  pre({ t: T0 + 5, tool: 'execute_bash', cmd: 'python3 x.py' }), // 3: hidden effects: fog
  pre({ t: T0 + 9, tool: 'execute_bash', cmd: 'cat a.py > a.py', allow: false }), // 4: blocked
  pre({ t: T0 + 10, tool: 'str_replace', paths: ['a.py'] }), // 5: first source edit attempt: cut
  read(T0 + 10, 'a.py', 0, 10), // 6: after the edit: no mark
];

test('frames: one per call in log order with time, category, fog, blocked, cut and repeat', () => {
  const f = (index, start, seconds, category, extra = {}) => ({
    index, n: index, start, seconds, category, fog: false, blocked: false, cut: false, repeat: null, ...extra,
  });
  assert.deepEqual(frames(run(LOG)), [
    f(1, 0, 2, 'request'),
    f(2, 2, 3, 'request', { repeat: { kind: 'repeat', earlier: [1] } }),
    f(3, 5, 4, 'run', { fog: true }),
    f(4, 9, 1, 'blocked', { blocked: true }),
    f(5, 10, 0, 'edit', { cut: true }),
    f(6, 10, 0, 'request'),
  ], 'times are seconds from the first call; intervals run to the next call');
});

test('frames: unknown times stay null, never 0', () => {
  const a = analyse(parse(readFileSync(new URL('./fixtures/time-anomalies.jsonl', import.meta.url), 'utf8')));
  const fr = frames(a);
  assert.deepEqual(fr.map((x) => x.seconds), [null, null, null, null, null, 10]);
  assert.deepEqual(fr.map((x) => x.start), [0, null, null, null, null, 10]);
  assert.ok(fr.every((x) => x.cut === false), 'no source edit attempt in this fixture, so no cut mark');
});

test('exposuresAt: counts of requests from calls up to k', () => {
  const a = run(LOG);
  assert.deepEqual(exposuresAt(a, 0), new Map(), 'before the first call nothing is exposed');
  assert.deepEqual(exposuresAt(a, 1), new Map([['a.py', [{ from: 1, to: 10, count: 1, lines: [1] }]]]));
  assert.deepEqual(exposuresAt(a, 2).get('a.py'), [
    { from: 1, to: 5, count: 1, lines: [1] },
    { from: 6, to: 10, count: 2, lines: [1, 2] },
    { from: 11, to: 15, count: 1, lines: [2] },
  ]);
});

const countAt = (ivs, line) => ivs.find((x) => x.from <= line && line <= x.to)?.count ?? 0;

test('generated: frames match the analysis and exposures never drop as k grows', () => {
  check('timeline', { runs: 150 }, (r) => sessionLines(r), (lines) => {
    const a = run(lines);
    const fr = frames(a);
    assert.equal(fr.length, a.calls.length, 'one frame per call');
    let cutCount = 0;
    fr.forEach((x, i) => {
      const c = a.calls[i];
      assert.deepEqual([x.index, x.n], [c.call.index, c.call.n], 'frames follow log order');
      assert.equal(x.fog, c.effect.hiddenEdit || c.effect.hiddenRequest, `frame ${x.index}: fog exactly when hidden effects are possible`);
      assert.equal(x.blocked, c.effect.category === 'blocked', `frame ${x.index}: blocked matches the effect`);
      assert.equal(x.seconds, c.interval.value, `frame ${x.index}: seconds is the interval, null when unknown`);
      if (x.cut) cutCount += 1;
    });
    const fs = a.firstSource.value;
    assert.equal(cutCount, fs === null ? 0 : 1, 'the cut mark is on the first source edit attempt only');
    if (fs !== null) assert.equal(fr[fs.call - 1].cut, true);
    const last = exposuresAt(a, a.calls.length);
    for (const [file, entry] of a.files) {
      const all = countLines(a.calls.flatMap((c) => c.effect.requests).filter((q) => q.file === file));
      assert.deepEqual(last.get(file) ?? [], all, `exposuresAt(last) on ${file} equals countLines of every request`);
      assert.deepEqual(all, entry.counts);
    }
    let prev = new Map();
    for (let k = 1; k <= a.calls.length; k += 1) {
      const now = exposuresAt(a, k);
      for (const [file, ivs] of prev) {
        for (let line = 1; line <= 120; line += 1) {
          assert.ok(countAt(now.get(file) ?? [], line) >= countAt(ivs, line), `${file} line ${line} must not drop from step ${k - 1} to ${k}`);
        }
      }
      prev = now;
    }
  });
});
