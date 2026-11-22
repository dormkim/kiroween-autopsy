// Tests for src/core/findings.js.
// Run: node --permission --allow-fs-read=. test/findings.test.mjs
// Expected sentences follow design "Findings" and the States table, word for word, with
// singular and plural forms. Unit tests use hand-built analyses, not analyse() output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { analyse } from '../src/core/metrics.js';
import { findings, stateMessage, formatTime } from '../src/core/findings.js';
import { check, sessionLines } from './gen.mjs';

const tr = (value, lines = [1], reason = null) => ({ value, lines: value === null ? [] : lines, reason: value === null ? (reason ?? 'unknown') : null });
const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');
const tracedLines = (parts) => parts.filter((p) => typeof p !== 'string' && p.traced).flatMap((p) => p.traced.lines);

/** A hand-built analysis shaped like requests-6644; override any top-level field. */
const base = (over = {}) => ({
  totals: { partial: false, broken: [] },
  top: tr({ file: 'src/requests/models.py', from: 81, to: 100, count: 3 }, [20, 45, 67]),
  requests: tr(13, [5, 7]),
  repeats: tr(1, [45]),
  unchecked: tr(6, [7, 15]),
  firstSource: tr({ call: 46, n: 46, file: 'src/requests/models.py', offset: 177.8, share: 0.389 }, [46]),
  possibleEarlier: tr(13, [4, 8]),
  time: {
    span: tr(456.932, [1, 72]),
    byCategory: new Map([['request', tr(30, [5, 6])], ['run', tr(250.4, [32, 33])], ['test', tr(100, [41, 42])]]),
    longest: [tr({ call: 65, n: 66, seconds: 69.441 }, [66, 67])],
    gaps: [],
  },
  ...over,
});
const withTime = (time) => base({ time: { ...base().time, ...time } });
const sentences = (a) => findings(a).map(text);

test('the three findings, word for word', () => {
  assert.deepEqual(sentences(base()), [
    'Lines 81 to 100 of src/requests/models.py were requested 3 times. 1 of 13 requests asked again for lines already requested since the last edit attempt on that file; 6 could not be checked.',
    'First source edit attempt: call 46 at 2:58, 39% into the session (log line 46). 13 earlier calls might also have changed files; the log cannot tell.',
    'The largest share of the session, 4:10 of 7:37 (55%), came after code runs. That includes the tool, the model and waiting. The longest time until the next call was 1:09, after call 65 (log lines 66 and 67).',
  ]);
});

test('a file with open-ended or unlocated requests gives a lower bound: "at least"', () => {
  const files = new Map([['src/requests/models.py', { lowerBound: true }]]);
  assert.equal(sentences(base({ files }))[0],
    'Lines 81 to 100 of src/requests/models.py were requested at least 3 times. 1 of 13 requests asked again for lines already requested since the last edit attempt on that file; 6 could not be checked.',
    'an open-ended request may cover these lines too, so 3 is a lower bound');
  const other = new Map([['src/requests/models.py', { lowerBound: false }], ['b.py', { lowerBound: true }]]);
  assert.ok(!sentences(base({ files: other }))[0].includes('at least'), 'only the lower bound of the most requested file counts');
  const one = base({ files, top: tr({ file: 'src/requests/models.py', from: 5, to: 5, count: 1 }, [3]) });
  assert.ok(sentences(one)[0].startsWith('Line 5 of src/requests/models.py was requested at least 1 time.'), 'singular');
});

test('every number is a traced part, never fixed text', () => {
  for (const sentence of findings(base())) {
    for (const p of sentence) {
      if (typeof p === 'string') assert.ok(!/\d/.test(p), `fixed text "${p}" must not hold a number`);
      else assert.ok(p.traced && Array.isArray(p.traced.lines), `part "${p.text}" must carry its traced value`);
    }
  }
  assert.deepEqual(findings(base())[0][1].traced.lines, [20, 45, 67], 'the range is traced to the covering requests');
});

test('singular forms', () => {
  const a = base({
    top: tr({ file: 'a.py', from: 5, to: 5, count: 1 }, [3]),
    requests: tr(1, [3]),
    repeats: tr(0, [3]),
    unchecked: tr(1, [3]),
    possibleEarlier: tr(1, [2]),
  });
  const s = sentences(a);
  assert.equal(s[0], 'Line 5 of a.py was requested 1 time. 0 of 1 request asked again for lines already requested since the last edit attempt on that file; 1 could not be checked.');
  assert.equal(s[1], 'First source edit attempt: call 46 at 2:58, 39% into the session (log line 46). 1 earlier call might also have changed files; the log cannot tell.');
});

test('no explicit range: open-ended or unknown lines, or no request at all', () => {
  assert.equal(sentences(base({ top: tr(null, [], 'no_ranges'), requests: tr(2, [1, 2]) }))[0],
    'No line ranges were requested. 2 requests had unknown or open-ended lines.');
  assert.equal(sentences(base({ top: tr(null, [], 'no_ranges'), requests: tr(1, [1]) }))[0],
    'No line ranges were requested. 1 request had unknown or open-ended lines.');
  assert.equal(sentences(base({ top: tr(null, [], 'no_ranges'), requests: tr(0, [1, 2]) }))[0],
    'No file requests were recognised.');
});

test('no source edit attempt recognised, never "did not edit"', () => {
  const none = tr(null, [], 'none_recognised');
  assert.equal(sentences(base({ firstSource: none, possibleEarlier: tr(23, [5, 9]) }))[1],
    'No source edit attempt recognised. 23 calls might have changed files; the log cannot tell.');
  assert.equal(sentences(base({ firstSource: none, possibleEarlier: tr(1, [5]) }))[1],
    'No source edit attempt recognised. 1 call might have changed files; the log cannot tell.');
  assert.equal(sentences(base({ firstSource: none, possibleEarlier: tr(0, [1, 2]) }))[1],
    'No source edit attempt recognised. 0 calls could have changed files.');
  assert.equal(sentences(base({ possibleEarlier: tr(0, [46]) }))[1],
    'First source edit attempt: call 46 at 2:58, 39% into the session (log line 46). 0 earlier calls could have changed files.');
});

test('first source edit attempt with an unknown time', () => {
  const fs = tr({ call: 2, n: 2, file: 'a.py', offset: null, share: null }, [2]);
  assert.equal(sentences(base({ firstSource: fs, possibleEarlier: tr(0, [1]) }))[1],
    'First source edit attempt: call 2 at an unknown time (log line 2). 0 earlier calls could have changed files.');
});

test('time: one-line longest, unknown gaps, unknown span, unknown effect category', () => {
  const one = withTime({ longest: [tr({ call: 9, n: 9, seconds: 4 }, [9])] });
  assert.equal(sentences(one)[2], 'The largest share of the session, 4:10 of 7:37 (55%), came after code runs. That includes the tool, the model and waiting. The longest time until the next call was 0:04, after call 9 (log line 9).');
  const gaps = withTime({ gaps: [tr(10, [1, 2, 3])], byCategory: new Map([['unknown', tr(300, [1])], ['unknown_time', tr(10, [1, 2, 3])]]) });
  assert.equal(sentences(gaps)[2],
    'The largest share of the session, 5:00 of 7:37 (66%), came after calls with unknown effect. That includes the tool, the model and waiting. The longest time until the next call was 1:09, after call 65 (log lines 66 and 67). Times are unknown for 0:10 of the session.');
  const span = withTime({ span: tr(null, [], 'no_time'), byCategory: new Map(), longest: [] });
  assert.equal(sentences(span)[2], 'No call has a usable time, so where the time went is unknown.');
});

test('category names are plain words', () => {
  const label = (category) => /came after (.+?)\. That/.exec(sentences(withTime({ byCategory: new Map([[category, tr(400, [1])]]) }))[2])[1];
  assert.deepEqual(['request', 'search', 'edit', 'test', 'run', 'vcs', 'other', 'blocked', 'unknown'].map(label), [
    'file requests',
    'searches',
    'edit attempts',
    'test runs',
    'code runs',
    'version control calls',
    'other calls',
    'blocked calls',
    'calls with unknown effect',
  ]);
});

test('partial suffix on every finding, singular and plural', () => {
  const two = sentences(base({ totals: { partial: true, broken: [{ n: 3, reason: 'json' }, { n: 9, reason: 'json' }] } }));
  for (const s of two) assert.ok(s.endsWith(' Partial: 2 log lines could not be read.'), s);
  const one = sentences(base({ totals: { partial: true, broken: [{ n: 3, reason: 'json' }] } }));
  for (const s of one) assert.ok(s.endsWith(' Partial: 1 log line could not be read.'), s);
  const parts = findings(base({ totals: { partial: true, broken: [{ n: 3, reason: 'json' }, { n: 9, reason: 'json' }] } }));
  for (const p of parts) assert.ok(tracedLines(p).includes(9), 'the broken count is traced to the broken log lines');
});

test('formatTime: m:ss rounded to the nearest second; minutes pass 59; unknown for null', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(59.4), '0:59');
  assert.equal(formatTime(59.5), '1:00');
  assert.equal(formatTime(177.8), '2:58');
  assert.equal(formatTime(887.957), '14:48');
  assert.equal(formatTime(3725), '62:05');
  assert.equal(formatTime(null), 'unknown');
});

// ---- state messages ----

const brokenAt = (...ns) => ns.map((n) => ({ n, reason: 'json' }));

test('stateMessage for each state in the States table', () => {
  const s = (input) => text(stateMessage(input));
  assert.equal(s({ state: 'load_error', name: 'x.jsonl', cause: 'the file could not be read' }), 'Could not open x.jsonl: the file could not be read.');
  assert.equal(s({ state: 'too_large', name: 'x.jsonl', bytes: 60 * 1024 * 1024 }), 'x.jsonl is 60.0 MB; the limit is 50 MB.');
  assert.equal(s({ state: 'empty', name: 'x.jsonl' }), 'x.jsonl is empty.');
  assert.equal(s({ state: 'not_a_log', name: 'x.jsonl', broken: brokenAt(1, 2, 3, 5) }),
    'x.jsonl is not a session log: no log line could be read (log lines 1 to 3, 5).');
  assert.equal(s({ state: 'not_a_log', name: 'x.jsonl', broken: brokenAt(4) }),
    'x.jsonl is not a session log: no log line could be read (log line 4).');
  assert.equal(s({ state: 'no_calls', name: 'x.jsonl', notes: [1, 2, 3] }), 'x.jsonl has 3 notes and no calls.');
  assert.equal(s({ state: 'no_calls', name: 'x.jsonl', notes: [2] }), 'x.jsonl has 1 note and no calls.');
  assert.equal(s({ state: 'partial', name: 'x.jsonl', broken: brokenAt(2, 3, 4, 5, 8, 9, 10, 11) }),
    'Partial: 8 log lines could not be read (log lines 2 to 5, 8 to 11).', 'some-broken.jsonl');
  assert.equal(s({ state: 'partial', name: 'x.jsonl', broken: brokenAt(3, 4) }), 'Partial: 2 log lines could not be read (log lines 3, 4).',
    'two neighbours are listed, not shortened');
});

test('stateMessage keeps the file name as a value part, never as fixed copy', () => {
  const parts = stateMessage({ state: 'empty', name: 'my_log<b>.jsonl' });
  const name = parts.find((p) => typeof p !== 'string');
  assert.equal(name.text, 'my_log<b>.jsonl', 'the name is shown as given, as text');
  assert.equal(parts.filter((p) => typeof p === 'string').join('').includes('my_log'), false);
});

// ---- properties ----

const BANNED = [
  /found it but did not fix/i, /would have failed/i, /early warning/i, /\bstuck\b/i, /\bwasted\b/i, /\bdoomed\b/i,
  /\bhealthy\b/i, /\bstruggling\b/i, /did not edit/i, /\u2014/, /!/,
];
const BAD_PLURAL = /\b1 (requests|calls|times|notes|log lines|earlier calls)\b/;
const INTERNAL = /[A-Za-z0-9]_[A-Za-z0-9]|\bvcs\b|\bnull\b|\bundefined\b|\bNaN\b/;

const checkCopy = (parts, label) => {
  const all = text(parts);
  for (const re of BANNED) assert.ok(!re.test(all), `P19 ${label}: "${all}" must not match ${re}`);
  assert.ok(!BAD_PLURAL.test(all), `P19 ${label}: "${all}" has a plural after 1`);
  const fixed = parts.filter((p) => typeof p === 'string').join('');
  assert.ok(!INTERNAL.test(fixed), `P19 ${label}: fixed copy "${fixed}" must not contain internal ids or snake_case`);
};

const genAnalysis = (r) => {
  const lines = sessionLines(r, { calls: r.int(1, 20) });
  if (r.bool(0.3)) lines.splice(r.int(0, lines.length), 0, '{oops');
  if (r.bool(0.2)) {
    const o = JSON.parse(lines[lines.length - 1]);
    delete o.t;
    lines[lines.length - 1] = JSON.stringify(o);
  }
  return lines;
};

test('P19: findings on generated analyses use plain copy with no banned words', () => {
  check('P19 findings', { runs: 200 }, genAnalysis, (lines) => {
    const sents = findings(analyse(parse(lines.join('\n'))));
    assert.equal(sents.length, 3, 'three findings');
    sents.forEach((s, i) => checkCopy(s, `finding ${i + 1}`));
  });
});

const NAMES = ['a.jsonl', 'my_session.events.jsonl', 'x y.jsonl', 'rich-3480.events.jsonl'];

test('P19 and P20: every stateMessage output; broken lines all reachable', () => {
  check('P19 P20 states', { runs: 200 }, (r) => {
    const broken = [];
    let n = 0;
    for (let i = r.int(1, 15); i > 0; i -= 1) {
      n += r.int(1, 3);
      broken.push({ n, reason: 'json' });
    }
    return {
      name: r.pick(NAMES), broken, notes: broken.map((b) => b.n + 100).slice(0, r.int(1, broken.length)),
      bytes: r.int(50 * 1024 * 1024 + 1, 900 * 1024 * 1024),
    };
  }, ({ name, broken, notes, bytes }) => {
    const inputs = [
      { state: 'load_error', name, cause: 'the file could not be read' },
      { state: 'too_large', name, bytes },
      { state: 'empty', name },
      { state: 'not_a_log', name, broken },
      { state: 'no_calls', name, notes },
      { state: 'partial', name, broken },
    ];
    for (const input of inputs) {
      const parts = stateMessage(input);
      checkCopy(parts, input.state);
      if (input.state === 'not_a_log' || input.state === 'partial') {
        const reach = new Set(tracedLines(parts));
        for (const b of broken) assert.ok(reach.has(b.n), `P20 ${input.state}: broken log line ${b.n} must be reachable`);
      }
    }
  });
});
