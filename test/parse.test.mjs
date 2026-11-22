// Tests for src/core/parse.js and the seeded helper in test/gen.mjs.
// Run: node --permission --allow-fs-read=. test/parse.test.mjs
// Expected values come from requirements R2 and design "Parse", and from the
// fixture text with its log line numbers. Never from the module's output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUT_LEN, parse, parseLine, splitLines } from '../src/core/parse.js';
import { check, gen, rng } from './gen.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const nums = (list) => list.map((x) => x.n);
const pre = (fields) => JSON.stringify({ hook: 'pre', tool: 'read_file', ...fields });
const callOf = (raw) => {
  const line = parseLine(raw, 1, 1);
  assert.equal(line.kind, 'call', `expected a call for ${raw}; got ${line.kind} (${line.reason ?? ''})`);
  return line.call;
};

// ---- A1: the seeded helper ----

test('rng gives the same sequence for the same seed and a different one for another seed', () => {
  const a = rng(42);
  const b = rng(42);
  const c = rng(43);
  const sa = Array.from({ length: 20 }, () => a());
  const sb = Array.from({ length: 20 }, () => b());
  const sc = Array.from({ length: 20 }, () => c());
  assert.deepEqual(sa, sb, 'mulberry32 must be deterministic for one seed');
  assert.notDeepEqual(sa, sc, 'seeds 42 and 43 should give different sequences');
  assert.ok(sa.every((x) => x >= 0 && x < 1), 'rng values must lie in [0, 1)');
});

test('a failing property names the seed, the case index and the input', () => {
  let i = 0;
  assert.throws(
    () => check('fails at case 3', { seed: 7, runs: 10 }, (r) => ({ value: r.int(0, 9), marker: 'abc' }), () => {
      i += 1;
      return i !== 4;
    }),
    (err) => {
      assert.match(err.message, /seed 7\b/, 'message must contain the seed');
      assert.match(err.message, /case 3\b/, 'message must contain the 0-based case index');
      assert.match(err.message, /"marker":"abc"/, 'message must contain the generated input');
      return true;
    },
  );
});

test('a passing property runs every case', () => {
  let runs = 0;
  check('always true', { seed: 1, runs: 25 }, (r) => r.int(0, 5), () => {
    runs += 1;
    return true;
  });
  assert.equal(runs, 25, 'check must call the property once per run');
});

// ---- splitLines ----

test('splitLines drops one trailing \\r and does not count a final empty string after the last \\n', () => {
  assert.deepEqual(splitLines('a\r\nb\nc\r\n'), ['a', 'b', 'c'], 'three lines, CR removed, no fourth empty line');
  assert.deepEqual(splitLines('a\r\r\n'), ['a\r'], 'only one trailing CR is dropped');
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b'], 'an empty middle line is a line; text without a final newline keeps its last line');
  assert.deepEqual(splitLines(''), [], 'empty text has no lines');
  assert.deepEqual(splitLines('\n'), [''], 'a single newline is one empty line');
});

// ---- parseLine kinds ----

test('a pre line with a string tool is a call; any other object with a string hook is a note', () => {
  const call = parseLine(pre({ t: 1795248000.5 }), 4, 2);
  assert.equal(call.kind, 'call');
  assert.equal(call.n, 4, 'Line.n is the log line');
  assert.equal(call.call.n, 4, 'Call.n is the log line');
  assert.equal(call.call.index, 2, 'Call.index is the index passed by the caller');
  assert.equal(call.call.tool, 'read_file');

  const note = parseLine(JSON.stringify({ t: 1795248001, hook: 'post', scope: {} }), 5, 3);
  assert.deepEqual(note, { n: 5, kind: 'note', t: 1795248001, hook: 'post' }, 'a note keeps n, t and hook only');
  const noteNoT = parseLine(JSON.stringify({ hook: 'end' }), 6, 3);
  assert.deepEqual(noteNoT, { n: 6, kind: 'note', t: null, hook: 'end' }, 'a note without t has t null');
});

test('whitespace-only lines are blank', () => {
  for (const raw of ['', ' ', '\t', '  \t  ']) {
    assert.deepEqual(parseLine(raw, 9, 1), { n: 9, kind: 'blank' }, `${JSON.stringify(raw)} is blank`);
  }
});

test('each broken reason, and a broken entry holds only n, kind and reason', () => {
  const cases = [
    ['{not json', 'json'],
    ['{"hook": "pre", "tool": "x"', 'json'],
    ['[1, 2]', 'not_object'],
    ['null', 'not_object'],
    ['"pre"', 'not_object'],
    ['42', 'not_object'],
    ['{"tool": "read_file"}', 'no_hook'],
    ['{"hook": 5, "tool": "read_file"}', 'no_hook'],
    ['{"hook": null}', 'no_hook'],
    ['{"hook": "pre"}', 'no_tool'],
    ['{"hook": "pre", "tool": 7}', 'no_tool'],
    ['{"hook": "pre", "tool": null}', 'no_tool'],
  ];
  for (const [raw, reason] of cases) {
    const line = parseLine(raw, 3, 1);
    assert.deepEqual(line, { n: 3, kind: 'broken', reason }, `${raw} must be broken with reason ${reason} and no content`);
  }
});

test('the logged kind, spans and call fields are ignored; index counts pre lines including blocked ones', () => {
  const text = [
    JSON.stringify({ t: 1795248000, hook: 'pre', tool: 'execute_bash', cmd: 'ls', allow: true, call: 1 }),
    JSON.stringify({ t: 1795248001, hook: 'pre', tool: 'web_fetch', cmd: 'x', allow: false }),
    JSON.stringify({ t: 1795248002, hook: 'post' }),
    JSON.stringify({ t: 1795248003, hook: 'pre', tool: 'read_file', paths: ['a.py'], allow: true, call: 2, kind: 'edit', spans: { 'a.py': [0, 5] } }),
  ].join('\n');
  const parsed = parse(text);
  assert.deepEqual(parsed.calls.map((c) => [c.n, c.index]), [[1, 1], [2, 2], [4, 3]], 'blocked line 2 is call 2; line 4 is call 3 although it logs call 2');
  for (const c of parsed.calls) {
    assert.ok(!('kind' in c) && !('spans' in c) && !('call' in c), `Call on log line ${c.n} must not carry kind, spans or call`);
  }
});

// ---- field validation (R2.4) ----

test('valid optional fields are kept with their types', () => {
  const c = callOf(pre({ t: 1795248000.25, cmd: 'ls', cmd_truncated: false, allow: true, paths: ['a.py', 'b.py'], range: { offset: 3, limit: 7 } }));
  assert.equal(c.t, 1795248000.25);
  assert.equal(c.cmd, 'ls');
  assert.equal(c.truncated, false);
  assert.equal(c.allow, true);
  assert.deepEqual(c.paths, ['a.py', 'b.py']);
  assert.deepEqual(c.range, { offset: 3, limit: 7 });
  assert.deepEqual(c.malformed, [], 'no field is malformed');
});

test('absent optional fields are null (or an empty Range) and are not malformed', () => {
  const c = callOf(pre({}));
  assert.equal(c.t, null, 'absent t is unknown');
  assert.equal(c.cmd, null, 'absent cmd is unknown');
  assert.equal(c.truncated, null, 'no cmd_truncated and no cmd: truncation unknown');
  assert.equal(c.allow, null, 'absent allow is unknown');
  assert.equal(c.paths, null, 'absent paths is unknown');
  assert.deepEqual(c.range, { offset: null, limit: null }, 'absent range is a Range with both fields absent');
  assert.deepEqual(c.malformed, [], 'absence is not a wrong type');
  assert.deepEqual(callOf(pre({ range: {} })).range, { offset: null, limit: null }, 'range {} has both fields absent');
  assert.deepEqual(callOf(pre({ range: { offset: 5 } })).range, { offset: 5, limit: null }, 'offset only');
  assert.deepEqual(callOf(pre({ range: { limit: 5 } })).range, { offset: null, limit: 5 }, 'limit only');
});

test('a wrong type on each optional field gives null and names the field', () => {
  const cases = [
    ['t', { t: 'soon' }, 't', null],
    ['t', { t: null }, 't', null],
    ['t', { t: true }, 't', null],
    ['cmd', { cmd: 42 }, 'cmd', null],
    ['cmd', { cmd: ['ls'] }, 'cmd', null],
    ['allow', { allow: 'yes' }, 'allow', null],
    ['allow', { allow: 1 }, 'allow', null],
    ['paths', { paths: 'a.py' }, 'paths', null],
    ['paths', { paths: [1] }, 'paths', null],
    ['paths', { paths: ['a.py', null] }, 'paths', null],
    ['range', { range: [] }, 'range', null],
    ['range', { range: 'x' }, 'range', null],
    ['range', { range: null }, 'range', null],
    ['range', { range: { offset: -1, limit: 5 } }, 'range', 'negative offset'],
    ['range', { range: { offset: 1.5, limit: 5 } }, 'range', 'fractional offset'],
    ['range', { range: { offset: '5' } }, 'range', 'string offset'],
    ['range', { range: { limit: 0 } }, 'range', 'limit 0'],
    ['range', { range: { limit: 2.5 } }, 'range', 'fractional limit'],
  ];
  for (const [field, fields, name, why] of cases) {
    const c = callOf(pre(fields));
    const key = field === 'range' ? 'range' : field;
    assert.equal(c[key], null, `${JSON.stringify(fields)}: ${field} must be null${why ? ` (${why})` : ''}`);
    assert.deepEqual(c.malformed, [name], `${JSON.stringify(fields)}: malformed must be exactly ['${name}']`);
  }
  const ct = callOf(pre({ cmd: 'ls', cmd_truncated: 'no' }));
  assert.deepEqual(ct.malformed, ['cmd_truncated'], 'cmd_truncated "no" is malformed');
  assert.equal(ct.truncated, false, 'with cmd_truncated malformed, truncated falls back to cmd.length >= CUT_LEN, here false');
});

test('truncated: boolean cmd_truncated wins, else cmd.length >= CUT_LEN, else null', () => {
  assert.equal(CUT_LEN, 200, 'CUT_LEN is 200 (design constants)');
  const long = 'x'.repeat(CUT_LEN);
  const short = 'x'.repeat(CUT_LEN - 1);
  assert.equal(callOf(pre({ cmd: 'ls', cmd_truncated: true })).truncated, true, 'boolean true wins over a short cmd');
  assert.equal(callOf(pre({ cmd: long, cmd_truncated: false })).truncated, false, 'boolean false wins over a long cmd');
  assert.equal(callOf(pre({ cmd: long })).truncated, true, '200 characters and no flag: truncated');
  assert.equal(callOf(pre({ cmd: short })).truncated, false, '199 characters and no flag: not truncated');
  assert.equal(callOf(pre({ cmd: 5 })).truncated, null, 'no flag and no string cmd: unknown');
});

test('parsing in chunks of 2,000 lines equals one pass', () => {
  const r = gen(rng(99));
  const rows = [];
  for (let i = 0; i < 4500; i += 1) {
    const k = r.int(0, 4);
    if (k === 0) rows.push(JSON.stringify({ t: 1795248000 + i, hook: 'pre', tool: 'read_file', paths: ['a.py'], range: { offset: i, limit: 3 } }));
    else if (k === 1) rows.push(JSON.stringify({ t: 1795248000 + i, hook: 'post' }));
    else if (k === 2) rows.push('{broken');
    else if (k === 3) rows.push('   ');
    else rows.push(JSON.stringify({ hook: 'pre', tool: 'web_fetch', allow: false }));
  }
  const text = rows.join('\n') + '\n';
  const whole = parse(text).lines;
  const raws = splitLines(text);
  const chunked = [];
  let index = 0;
  for (let start = 0; start < raws.length; start += 2000) {
    const chunk = raws.slice(start, start + 2000);
    chunk.forEach((raw, j) => {
      const line = parseLine(raw, start + j + 1, index + 1);
      if (line.kind === 'call') index += 1;
      chunked.push(line);
    });
  }
  assert.equal(whole.length, 4500, '4500 rows give 4500 lines');
  assert.deepEqual(chunked, whole, 'chunked parseLine with a running call index must equal parse()');
});

// ---- fixtures, with log line numbers counted from the fixture text ----

test('empty.jsonl: no lines at all', () => {
  const p = parse(fixture('empty.jsonl'));
  assert.equal(p.lines.length, 0, 'a 0-byte file has no lines');
  assert.deepEqual([p.calls.length, p.notes.length, p.broken.length, p.blank.length], [0, 0, 0, 0]);
});

test('whitespace.jsonl and inline whitespace text: every line blank, listed by log line', () => {
  const inline = parse('  \n\t\n\r\n');
  assert.deepEqual(inline.blank, [1, 2, 3], 'three whitespace lines are blank on log lines 1, 2, 3');
  const p = parse(fixture('whitespace.jsonl'));
  assert.ok(p.lines.length >= 1, 'the whitespace fixture has at least one line');
  assert.deepEqual(p.blank, p.lines.map((_, i) => i + 1), 'every line of whitespace.jsonl is blank');
  assert.deepEqual([p.calls.length, p.notes.length, p.broken.length], [0, 0, 0]);
});

const someBrokenExpect = (p, label) => {
  assert.equal(p.lines.length, 11, `${label}: 11 log lines`);
  assert.deepEqual(p.calls.map((c) => [c.n, c.index]), [[1, 1], [6, 2]], `${label}: calls on log lines 1 and 6`);
  assert.deepEqual(nums(p.notes), [7], `${label}: one note, log line 7`);
  assert.deepEqual(p.broken, [
    { n: 2, reason: 'json' },
    { n: 3, reason: 'not_object' },
    { n: 4, reason: 'no_hook' },
    { n: 5, reason: 'no_tool' },
    { n: 8, reason: 'not_object' },
    { n: 9, reason: 'not_object' },
    { n: 10, reason: 'no_hook' },
    { n: 11, reason: 'no_tool' },
  ], `${label}: broken log lines with reasons`);
  assert.deepEqual(p.blank, [], `${label}: no blank lines`);
  assert.deepEqual(p.calls[0].range, { offset: 10, limit: 5 }, `${label}: log line 1 range as logged`);
  assert.equal(p.calls[1].cmd, 'cat a.py', `${label}: log line 6 cmd without a trailing CR`);
};

test('some-broken.jsonl: calls, note and each broken line with its reason', () => {
  someBrokenExpect(parse(fixture('some-broken.jsonl')), 'LF');
});

test('some-broken.jsonl with CRLF line ends parses the same', () => {
  const text = fixture('some-broken.jsonl').replace(/\r?\n/g, '\r\n');
  assert.ok(text.includes('\r\n'), 'the converted text must contain CRLF');
  someBrokenExpect(parse(text), 'CRLF');
});

test('all-broken.jsonl: every non-blank line broken, log line 4 blank', () => {
  const p = parse(fixture('all-broken.jsonl'));
  assert.deepEqual(p.broken, [
    { n: 1, reason: 'json' },
    { n: 2, reason: 'not_object' },
    { n: 3, reason: 'no_hook' },
    { n: 5, reason: 'no_tool' },
  ]);
  assert.deepEqual(p.blank, [4]);
  assert.deepEqual([p.calls.length, p.notes.length], [0, 0], 'no calls and no notes');
});

test('truncated-cmd.jsonl: truncated flags per log line', () => {
  const p = parse(fixture('truncated-cmd.jsonl'));
  assert.equal(p.calls.length, 5);
  assert.ok(p.calls[2].cmd.length >= CUT_LEN, `log line 3 cmd must be at least ${CUT_LEN} characters for this fixture; it is ${p.calls[2].cmd.length}`);
  assert.deepEqual(p.calls.map((c) => c.truncated), [true, true, true, false, false],
    'lines 1, 2: flag true; line 3: no flag, 200+ chars; line 4: flag false; line 5: flag "yes" is malformed and "ls" is short');
  assert.deepEqual(p.calls[4].malformed, ['cmd_truncated'], 'log line 5 cmd_truncated "yes" is malformed');
});

test('blocked.jsonl: blocked lines are calls with allow false and get an index', () => {
  const p = parse(fixture('blocked.jsonl'));
  assert.deepEqual(p.calls.map((c) => [c.n, c.index, c.tool, c.allow]), [
    [1, 1, 'execute_bash', true],
    [2, 2, 'web_fetch', false],
    [3, 3, 'execute_bash', false],
    [4, 4, 'read_file', true],
  ], 'log line 4 logs call 2 but is the 4th pre line');
});

test('post-only.jsonl: notes and no calls', () => {
  const p = parse(fixture('post-only.jsonl'));
  assert.equal(p.calls.length, 0);
  assert.deepEqual(p.notes, [
    { n: 1, kind: 'note', t: 1795248300, hook: 'post' },
    { n: 2, kind: 'note', t: 1795248301.5, hook: 'post' },
    { n: 3, kind: 'note', t: null, hook: 'session_end' },
  ]);
});

test('bad-types.jsonl: each call keeps its line and names its malformed field', () => {
  const p = parse(fixture('bad-types.jsonl'));
  assert.equal(p.calls.length, 12, 'no line is broken: wrong optional types keep the call');
  assert.deepEqual(p.calls.map((c) => c.malformed), [
    ['t'], ['cmd'], ['cmd_truncated'], ['allow'], ['paths'], ['paths'],
    ['range'], ['range'], ['range'], ['range'], ['t'], ['range'],
  ], 'log lines 1 to 12 in order: t string, cmd number, cmd_truncated string, allow string, paths string, paths [1], range [], offset -1, offset 1.5, limit 0, t null, offset "5"');
  assert.equal(p.calls[0].t, null, 'log line 1 t "soon" is unknown');
  assert.equal(p.calls[1].cmd, null, 'log line 2 cmd 42 is unknown');
  assert.equal(p.calls[1].truncated, false, 'log line 2 cmd_truncated false still applies');
  assert.equal(p.calls[3].allow, null, 'log line 4 allow "yes" is unknown');
  assert.equal(p.calls[6].range, null, 'log line 7 range [] is unknown');
});

test('time-anomalies.jsonl: parse keeps any finite t; a non-number t is malformed; absent t is null', () => {
  const p = parse(fixture('time-anomalies.jsonl'));
  assert.deepEqual(p.calls.map((c) => c.t), [1795248500, null, null, 99999999999, 1795248490, 1795248510],
    'range and order checks happen in metrics, not in parse');
  assert.deepEqual(p.calls.map((c) => c.malformed), [[], [], ['t'], [], [], []], 'only log line 3 ("NaN" string) is malformed');
  assert.deepEqual(nums(p.notes), [7]);
});

// ---- properties ----

const VALUES = [null, true, false, 0, 1, -1, 1.5, 1795248000.5, 'x', '', [], {}, [1], ['a.py'], { offset: -1 }, { offset: 2, limit: 3 }, { limit: 0 }];

/** Builds one log line and the kind it must parse to, decided from the inputs only. */
const genLine = (r) => {
  const k = r.int(0, 5);
  if (k === 0) return { raw: r.pick(['', ' ', '\t ', '   ']), kind: 'blank' };
  if (k === 1) return { raw: r.pick(['{', '{"hook":', 'not json', '{"a":1', '[', '"']), kind: 'broken' };
  if (k === 2) return { raw: JSON.stringify(r.pick([[1], null, 3, 'pre', true])), kind: 'broken' };
  if (k === 3) return { raw: JSON.stringify({ hook: r.pick(['post', 'end', 'pre_x']), t: r.pick(VALUES) }), kind: 'note' };
  if (k === 4) {
    const bad = r.pick([{}, { hook: 5 }, { hook: 'pre' }, { hook: 'pre', tool: 3 }]);
    return { raw: JSON.stringify({ ...bad, cmd: 'ls' }), kind: 'broken' };
  }
  const obj = { hook: 'pre', tool: r.pick(['read_file', 'execute_bash', 'str_replace', 'zz']) };
  for (const f of ['t', 'cmd', 'cmd_truncated', 'allow', 'paths', 'range', 'kind', 'spans', 'call']) {
    if (r.bool(0.6)) obj[f] = r.pick(VALUES);
  }
  return { raw: JSON.stringify(obj) + (r.bool(0.2) ? '\r' : ''), kind: 'call' };
};

test('P1: every log line is exactly one of call, note, broken or blank, numbered 1..N in order', () => {
  check('P1', {}, (r) => Array.from({ length: r.int(0, 30) }, () => genLine(r)), (rows) => {
    // Every row ends with \n, so an empty last row is still a line.
    const text = rows.map((x) => x.raw + '\n').join('');
    const p = parse(text);
    assert.equal(p.lines.length, rows.length, 'one Line per row');
    p.lines.forEach((line, i) => {
      assert.equal(line.n, i + 1, `line ${i + 1} must have n ${i + 1}`);
      assert.equal(line.kind, rows[i].kind, `log line ${i + 1} must be ${rows[i].kind}`);
    });
    const total = p.calls.length + p.notes.length + p.broken.length + p.blank.length;
    assert.equal(total, rows.length, 'calls, notes, broken and blank partition the lines');
    assert.deepEqual(p.calls.map((c) => c.index), p.calls.map((_, i) => i + 1), 'call indexes are 1..k');
  });
});

const isRange = (x) => x === null || (typeof x === 'object' && Object.keys(x).sort().join() === 'limit,offset'
  && (x.offset === null || (Number.isInteger(x.offset) && x.offset >= 0))
  && (x.limit === null || (Number.isInteger(x.limit) && x.limit >= 1)));

test('P2: parseLine never throws, broken entries hold no content, call fields have their declared types', () => {
  const chars = '{}[]":,\\ \tabc01-.eE\r\n\u00e9\ud83d';
  const genRaw = (r) => {
    if (r.bool(0.5)) return genLine(r).raw;
    return Array.from({ length: r.int(0, 40) }, () => chars[r.int(0, chars.length - 1)]).join('');
  };
  check('P2', { runs: 500 }, genRaw, (raw) => {
    const line = parseLine(raw, 1, 1);
    assert.ok(['call', 'note', 'broken', 'blank'].includes(line.kind), `unknown kind ${line.kind}`);
    if (line.kind === 'broken') {
      assert.deepEqual(Object.keys(line).sort(), ['kind', 'n', 'reason'], 'broken holds only n, kind and reason');
      assert.ok(['json', 'not_object', 'no_hook', 'no_tool'].includes(line.reason), `reason ${line.reason}`);
    }
    if (line.kind === 'call') {
      const c = line.call;
      assert.ok(c.t === null || Number.isFinite(c.t), 't is null or finite');
      assert.ok(c.cmd === null || typeof c.cmd === 'string', 'cmd is null or a string');
      assert.ok(c.truncated === null || typeof c.truncated === 'boolean', 'truncated is null or boolean');
      assert.ok(c.allow === null || typeof c.allow === 'boolean', 'allow is null or boolean');
      assert.ok(c.paths === null || (Array.isArray(c.paths) && c.paths.every((p) => typeof p === 'string')), 'paths is null or strings');
      assert.ok(isRange(c.range), `range ${JSON.stringify(c.range)} is null or a valid Range`);
      assert.ok(Array.isArray(c.malformed) && c.malformed.every((f) => ['t', 'cmd', 'cmd_truncated', 'allow', 'paths', 'range'].includes(f)), 'malformed names known fields');
    }
  });
});

test('P3: changing kind, spans or call leaves the parsed Call unchanged', () => {
  check('P3 parse', {}, (r) => {
    const base = { t: 1795248000 + r.int(0, 100), hook: 'pre', tool: r.pick(['read_file', 'execute_bash']), cmd: 'cat a.py', paths: ['a.py'], range: { offset: r.int(0, 9), limit: r.int(1, 9) }, allow: true };
    const extra = { kind: r.pick(['read', 'edit', 'other', 5]), spans: r.pick([{}, { 'a.py': [0, 9] }, 'x']), call: r.pick([1, 99, 'z']) };
    return { base, extra };
  }, ({ base, extra }) => {
    const a = parseLine(JSON.stringify(base), 3, 2);
    const b = parseLine(JSON.stringify({ ...base, ...extra }), 3, 2);
    assert.deepEqual(b, a, 'kind, spans and call must not change the Line');
  });
});
