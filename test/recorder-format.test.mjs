// How the page reads recorder logs: permission states, ranges, /outside-workspace, new tools.
// Run: node --permission --allow-fs-read=. test/recorder-format.test.mjs
// Expected values follow requirements R14 and design.md "Reading recorder logs". Written before
// the implementation; new exports are read through namespace imports so each test fails on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseLine } from '../src/core/parse.js';
import * as classifyMod from '../src/core/classify.js';
import * as metricsMod from '../src/core/metrics.js';
import * as findingsMod from '../src/core/findings.js';
import { check } from './gen.mjs';

const { classify } = classifyMod;
const { analyse } = metricsMod;
const OUT = '/outside-workspace';
const T = 1795248000;

/** A recorder line: no allow, no cmd, unless given. */
const pre = (fields, i = 0) => ({ t: T + i, hook: 'pre', ...fields });
const callOf = (fields) => {
  const line = parseLine(JSON.stringify(pre(fields)), 1, 1);
  assert.equal(line.kind, 'call', 'test helper must build a call');
  return line.call;
};
const effectOf = (fields) => classify(callOf(fields));
const logOf = (objs) => `${objs.map((o, i) => JSON.stringify(pre(o, i))).join('\n')}\n`;
const analyseLog = (objs) => analyse(parse(logOf(objs)));
const reqs = (e) => e.requests.map((r) => {
  if (r.kind === 'range') return [r.file, 'range', r.from, r.to];
  if (r.kind === 'open') return [r.file, 'open', r.from];
  return [r.file, r.kind];
});
const edits = (e) => e.edits.map((x) => [x.file, x.cls]);
const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');

// ---- permission (R14.1, R14.2, P26) ----

test('parse keeps absent, true, false and malformed allow apart (R14.1)', () => {
  const absent = callOf({ tool: 'read_file', paths: ['a.py'], range: {} });
  assert.equal(absent.permission, 'not_recorded', 'absent allow: permission not_recorded');
  assert.equal(absent.allow, null, 'absent allow stays null in allow');
  assert.deepEqual(absent.malformed, [], 'absent allow is not malformed');
  const yes = callOf({ tool: 'read_file', paths: ['a.py'], range: {}, allow: true });
  assert.equal(yes.permission, 'allowed');
  const no = callOf({ tool: 'read_file', paths: ['a.py'], range: {}, allow: false });
  assert.equal(no.permission, 'blocked');
  for (const bad of ['yes', 1, null, [], {}]) {
    const c = callOf({ tool: 'read_file', paths: ['a.py'], range: {}, allow: bad });
    assert.equal(c.permission, 'unknown', `allow ${JSON.stringify(bad)}: permission unknown`);
    assert.ok(c.malformed.includes('allow'), `allow ${JSON.stringify(bad)} is listed as malformed`);
  }
});

test('an absent allow is classified as an attempt, like an allowed call, and marked not_recorded (R14.2, P26)', () => {
  const cases = [
    { tool: 'read_file', paths: ['a.py'], range: { offset: 2, limit: 3 } },
    { tool: 'read_file', paths: ['a.py'], range: {} },
    { tool: 'str_replace', paths: ['src/m.py'] },
    { tool: 'execute_bash', cmd: 'cat a.py', cmd_truncated: false },
    { tool: 'list_directory', paths: ['src'] },
    { tool: 'search' },
  ];
  for (const fields of cases) {
    const absent = effectOf(fields);
    const allowed = effectOf({ ...fields, allow: true });
    assert.equal(absent.permission, 'not_recorded', `${fields.tool}: effect carries permission not_recorded`);
    assert.equal(allowed.permission, 'allowed', `${fields.tool}: effect carries permission allowed`);
    const { permission: p1, ...a } = absent;
    const { permission: p2, ...b } = allowed;
    assert.deepEqual(a, b, `${fields.tool}: apart from permission, absent allow gives the same effect as allow true`);
  }
  assert.deepEqual(reqs(effectOf(cases[0])), [['a.py', 'range', 3, 5]], 'offset 2, limit 3 requests lines 3 to 5');
  assert.deepEqual(edits(effectOf(cases[2])), [['src/m.py', 'source']], 'an edit attempt on a source file');
});

test('a malformed allow stays unknown with hidden effects, and false stays blocked (R14.2)', () => {
  const bad = effectOf({ tool: 'read_file', paths: ['a.py'], range: {}, allow: 'yes' });
  assert.equal(bad.category, 'unknown');
  assert.deepEqual([bad.hiddenEdit, bad.hiddenRequest], [true, true]);
  assert.deepEqual([bad.requests, bad.edits], [[], []]);
  const blocked = effectOf({ tool: 'str_replace', paths: ['src/m.py'], allow: false });
  assert.equal(blocked.category, 'blocked');
  assert.deepEqual([blocked.requests, blocked.edits, blocked.hiddenEdit, blocked.hiddenRequest], [[], [], false, false]);
});

// ---- new tools (R14.6) ----

test('list_directory is a search with no effects; search hides requests; unknown_tool and execute_bash without cmd are unknown (R14.6)', () => {
  for (const fields of [{ tool: 'list_directory', paths: ['src'] }, { tool: 'list_directory', paths: ['/workspace'] }, { tool: 'list_directory' }]) {
    const e = effectOf(fields);
    assert.equal(e.category, 'search', `${JSON.stringify(fields)}: search`);
    assert.deepEqual([e.requests, e.edits, e.hiddenEdit, e.hiddenRequest], [[], [], false, false], `${JSON.stringify(fields)}: no effects`);
  }
  const s = effectOf({ tool: 'search' });
  assert.equal(s.category, 'search');
  assert.deepEqual([s.requests, s.edits, s.hiddenEdit, s.hiddenRequest], [[], [], false, true], 'search: hidden requests only');
  for (const fields of [{ tool: 'unknown_tool' }, { tool: 'execute_bash' }]) {
    const e = effectOf(fields);
    assert.equal(e.category, 'unknown', `${fields.tool}: unknown`);
    assert.deepEqual([e.hiddenEdit, e.hiddenRequest], [true, true], `${fields.tool}: hidden edits and requests`);
  }
});

test('notRecorded is a traced count and permissionNote gives the fixed copy (R14.3)', () => {
  const a = analyseLog([
    { tool: 'read_file', paths: ['a.py'], range: {} },
    { tool: 'search' },
    { tool: 'read_file', paths: ['a.py'], range: {}, allow: true },
    { tool: 'unknown_tool' },
  ]);
  assert.deepEqual(a.notRecorded, { value: 3, lines: [1, 2, 4], reason: null }, 'three calls without allow, on log lines 1, 2 and 4');
  assert.equal(typeof findingsMod.permissionNote, 'function', 'findings.js exports permissionNote');
  const note = findingsMod.permissionNote(a);
  assert.equal(text(note), 'Whether 3 calls were allowed or ran was not recorded. They count as attempts and can include denied calls.');
  const numbers = note.filter((p) => typeof p !== 'string');
  assert.equal(numbers.length, 1, 'the count is one traced part');
  assert.equal(numbers[0].traced, a.notRecorded, 'the part carries the traced count');

  const one = analyseLog([{ tool: 'read_file', paths: ['a.py'], range: {}, allow: true }, { tool: 'search' }]);
  assert.deepEqual(one.notRecorded, { value: 1, lines: [2], reason: null });
  assert.equal(text(findingsMod.permissionNote(one)), 'Whether 1 call was allowed or ran was not recorded. It counts as an attempt and can be a denied call.');

  const none = analyseLog([{ tool: 'read_file', paths: ['a.py'], range: {}, allow: true }]);
  assert.deepEqual(none.notRecorded, { value: 0, lines: [1], reason: null }, '0 is traced to the calls that were checked');
  assert.equal(findingsMod.permissionNote(none), null, 'no note when every call recorded allow');

  const noCalls = analyse(parse('{"t":1795248000,"hook":"post"}\n'));
  assert.equal(noCalls.notRecorded.value, null, 'no calls: unknown, never 0');
  assert.equal(noCalls.notRecorded.reason, 'no_calls');
  assert.equal(findingsMod.permissionNote(noCalls), null);
});

test('no finding or headline calls a not_recorded call allowed (R14.2)', () => {
  const a = analyseLog([
    { tool: 'read_file', paths: ['a.py'], range: { offset: 0, limit: 5 } },
    { tool: 'read_file', paths: ['a.py'], range: { offset: 0, limit: 5 } },
    { tool: 'str_replace', paths: ['a.py'] },
  ]);
  const copy = [
    ...findingsMod.findings(a).map(text),
    ...findingsMod.headlines(a).flatMap((h) => [h.text, h.label]),
  ];
  for (const s of copy) assert.ok(!/\ballowed\b/i.test(s), `finding copy must not say allowed: ${s}`);
});

// ---- ranges (R14.4, P27) ----

test('a valid ranges array gives one request per path by the read_file range rules (R14.4, P27)', () => {
  const call = callOf({ tool: 'read_file', paths: ['a.py', 'b.py', 'c.py'], ranges: [{ offset: 0, limit: 10 }, {}, { offset: 5 }] });
  assert.deepEqual(call.ranges, [{ offset: 0, limit: 10 }, { offset: null, limit: null }, { offset: 5, limit: null }], 'parse gives each entry the Range shape');
  assert.deepEqual(call.malformed, [], 'a valid ranges array is not malformed');
  const e = classify(call);
  assert.equal(e.category, 'request');
  assert.deepEqual(reqs(e), [['a.py', 'range', 1, 10], ['b.py', 'open', 1], ['c.py', 'open', 6]]);
  assert.deepEqual([e.hiddenEdit, e.hiddenRequest], [false, false]);
});

test('an invalid ranges array never invents lines: one request with unknown lines per usable path (R14.4, P27)', () => {
  const paths = ['a.py', 'b.py'];
  const bad = [
    ['a shorter array', { ranges: [{}] }],
    ['a longer array', { ranges: [{}, {}, {}] }],
    ['an empty array', { ranges: [] }],
    ['a string', { ranges: 'x' }],
    ['an object', { ranges: { offset: 1 } }],
    ['a null entry', { ranges: [{}, null] }],
    ['a negative offset', { ranges: [{}, { offset: -1 }] }],
    ['limit 0', { ranges: [{ limit: 0 }, {}] }],
    ['a string offset', { ranges: [{ offset: '1' }, {}] }],
    ['ranges beside range', { ranges: [{}, {}], range: { offset: 1, limit: 2 } }],
  ];
  for (const [what, extra] of bad) {
    const e = effectOf({ tool: 'read_file', paths, ...extra });
    assert.ok(e.requests.every((r) => r.kind === 'unlocated'), `${what}: no range or open request may be invented`);
    assert.deepEqual(reqs(e), [['a.py', 'unlocated'], ['b.py', 'unlocated']], `${what}: one request with unknown lines per path`);
  }
  for (const value of ['x', [null], [{ offset: -1 }]]) {
    const c = callOf({ tool: 'read_file', paths: ['a.py'], ranges: value });
    assert.equal(c.ranges, null, `ranges ${JSON.stringify(value)}: unknown`);
    assert.ok(c.malformed.includes('ranges'), `ranges ${JSON.stringify(value)} is listed as malformed`);
  }
});

test('ranges with /workspace or /outside-workspace among the paths (R14.4, R14.5)', () => {
  const ws = effectOf({ tool: 'read_file', paths: ['a.py', '/workspace'], ranges: [{}, {}] });
  assert.deepEqual(reqs(ws), [['a.py', 'open', 1]], '/workspace is an unknown target, not a file');
  assert.equal(ws.hiddenRequest, true, 'an unknown target hides a request');
  const out = effectOf({ tool: 'read_file', paths: [OUT, 'a.py'], ranges: [{ offset: 0, limit: 3 }, { limit: 2 }] });
  assert.deepEqual(reqs(out), [['a.py', 'range', 1, 2]], 'the outside path gives no request');
  assert.equal(out.hiddenRequest, false, 'an outside request is known to be outside, so nothing is hidden');
});

// ---- /outside-workspace (R14.5, R14.7) ----

test('OUTSIDE is exported as /outside-workspace (R14.5)', () => {
  assert.equal(classifyMod.OUTSIDE, OUT, 'classify.js exports OUTSIDE');
  assert.equal(metricsMod.OUTSIDE, OUT, 'metrics.js re-exports OUTSIDE');
});

test('/outside-workspace is never a request, a line count or a repeat, and a write there is class outside (R14.5)', () => {
  const read = effectOf({ tool: 'read_file', paths: [OUT], range: { offset: 0, limit: 10 } });
  assert.deepEqual([read.requests, read.hiddenRequest], [[], false], 'a read outside gives no request');
  const write = effectOf({ tool: 'str_replace', paths: [OUT] });
  assert.deepEqual(edits(write), [[OUT, 'outside']], 'a write outside is an edit of class outside');
  for (const cmd of [`cat ${OUT}`, `grep x ${OUT}`, `head -n 5 ${OUT}`]) {
    const e = effectOf({ tool: 'execute_bash', cmd, cmd_truncated: false, allow: true });
    assert.deepEqual(reqs(e), [], `${cmd}: a request on ${OUT} is dropped, shell included`);
  }
  const redirect = effectOf({ tool: 'execute_bash', cmd: `echo x > ${OUT}`, cmd_truncated: false, allow: true });
  assert.deepEqual(edits(redirect), [[OUT, 'outside']], 'a redirect to /outside-workspace is an outside write');

  const a = analyseLog([
    { tool: 'read_file', paths: [OUT], range: { offset: 0, limit: 10 } },
    { tool: 'read_file', paths: [OUT], range: { offset: 0, limit: 10 } },
    { tool: 'str_replace', paths: [OUT] },
    { tool: 'str_replace', paths: ['src/m.py'] },
  ]);
  assert.ok(!a.files.has(OUT), 'no file entry for /outside-workspace');
  assert.equal(a.top.value, null, 'no line counts');
  assert.equal(a.requests.value, 0, 'no requests');
  assert.equal(a.repeats.value, 0, 'two reads outside are not a repeat');
  assert.equal(a.firstSource.value.call, 4, 'the first source edit attempt is the edit on src/m.py');
  assert.deepEqual(a.possibleEarlier, { value: 0, lines: [1, 2, 3], reason: null }, 'an outside write is not a call that might have changed files earlier');
});

test('other absolute paths keep the phase 1 rule: only /workspace is the project (R14.7)', () => {
  assert.deepEqual(reqs(effectOf({ tool: 'read_file', paths: ['/tmp/x.py'], range: {} })), [['/tmp/x.py', 'open', 1]]);
  assert.deepEqual(reqs(effectOf({ tool: 'read_file', paths: ['/workspace/a.py'], range: {} })), [['a.py', 'open', 1]]);
  assert.deepEqual(edits(effectOf({ tool: 'str_replace', paths: ['/tmp/x.py'] })), [['/tmp/x.py', 'outside']]);
  assert.deepEqual(edits(effectOf({ tool: 'str_replace', paths: ['/workspacex/a.py'] })), [['/workspacex/a.py', 'outside']]);
});

// ---- end to end ----

test('a recorder log of the measured V2 probe, end to end through parse and analyse (R14.1 to R14.6)', () => {
  const a = analyseLog([
    { tool: 'read_file', paths: ['numbered.txt'], range: { offset: 2, limit: 3 } },
    { tool: 'read_file', paths: ['numbered.txt'], range: { limit: 2 } },
    { tool: 'read_file', paths: ['numbered.txt'], range: {} },
    { tool: 'read_file', paths: ['a.py', 'numbered.txt'], ranges: [{}, {}] },
    { tool: 'list_directory', paths: ['/workspace'] },
    { tool: 'str_replace', paths: ['b.py'] },
    { tool: 'str_replace', paths: ['a.py'] },
    { tool: 'read_file', paths: [OUT], range: {} },
    { tool: 'str_replace', paths: [OUT] },
    { tool: 'read_file', paths: ['numbered.txt'], range: { offset: 2, limit: 3 } },
  ]);
  assert.deepEqual(a.totals.broken, [], 'no broken lines');
  assert.equal(a.totals.calls, 10);
  assert.deepEqual(a.notRecorded, { value: 10, lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], reason: null });
  assert.deepEqual(a.requests, { value: 6, lines: [1, 2, 3, 4, 10], reason: null }, 'six requests; log line 4 holds two');
  assert.deepEqual(a.repeats, { value: 1, lines: [10], reason: null }, 'log line 10 repeats lines 3 to 5 from log line 1; edits on a.py and b.py do not reset numbered.txt');
  assert.deepEqual(a.unchecked, { value: 2, lines: [3, 4], reason: null }, 'the whole-file requests on log lines 3 and 4 cannot be checked');
  assert.deepEqual(a.calls[9].repeat, { kind: 'repeat', earlier: [1] });
  assert.deepEqual(a.top, { value: { file: 'numbered.txt', from: 3, to: 5, count: 2 }, lines: [1, 10], reason: null });
  assert.equal(a.files.get('numbered.txt').lowerBound, true, 'open-ended requests make the count a lower bound');
  assert.deepEqual([...a.files.keys()].sort(), ['a.py', 'numbered.txt'], 'only real project files are file keys');
  assert.equal(a.firstSource.value.call, 6);
  assert.equal(a.firstSource.value.n, 6);
  assert.equal(a.firstSource.value.file, 'b.py');
  assert.deepEqual(a.possibleEarlier, { value: 0, lines: [1, 2, 3, 4, 5], reason: null }, 'list_directory and reads cannot change files');
  assert.deepEqual(a.otherEdits.map((x) => [x.file, x.cls, x.n]), [['a.py', 'source', 7], [OUT, 'outside', 9]]);
  assert.equal(a.calls[4].effect.category, 'search', 'list_directory is a search');
});

// ---- property (P28) ----

const POOL = [OUT, '/workspace', '/tmp/x.py', '/etc/a.py', '/workspacex/a.py', '/outside-workspacex.py', 'a.py', 'src/m.py', 'pkg/b.js', 'tests/test_a.py'];

const genCall = (r) => {
  const p = () => r.pick(POOL);
  const range = () => r.pick([{}, { offset: r.int(0, 20) }, { limit: r.int(1, 10) }, { offset: r.int(0, 20), limit: r.int(1, 10) }]);
  const k = r.int(0, 8);
  if (k <= 2) return { tool: 'read_file', paths: [p()], range: range() };
  if (k === 3) {
    const n = r.int(1, 4);
    return { tool: 'read_file', paths: Array.from({ length: n }, p), ranges: Array.from({ length: r.bool(0.8) ? n : n + 1 }, range) };
  }
  if (k === 4) return { tool: 'str_replace', paths: [p()] };
  if (k === 5) return { tool: r.pick(['list_directory', 'search', 'unknown_tool', 'execute_bash']), ...(r.bool() ? { paths: [p()] } : {}) };
  if (k === 6) return { tool: 'execute_bash', cmd: `echo x > ${p()}`, cmd_truncated: false, allow: true };
  if (k === 7) return { tool: 'execute_bash', cmd: `cat ${p()}`, cmd_truncated: false, allow: true };
  return { tool: 'str_replace', paths: [p()], allow: r.pick([true, false]) };
};

test('property: no path outside the project becomes a file key, a repeat or a source edit (P28)', () => {
  check('outside paths are never source edits', { runs: 300 }, (r) => Array.from({ length: r.int(1, 20) }, () => genCall(r)), (calls) => {
    const a = analyseLog(calls);
    for (const e of a.calls) {
      for (const req of e.effect.requests) assert.notEqual(req.file, OUT, 'no request on /outside-workspace');
      for (const ed of e.effect.edits) {
        if (ed.file !== null && ed.file.startsWith('/')) assert.notEqual(ed.cls, 'source', `an edit on ${ed.file} is never a source edit`);
      }
      e.marks.forEach((m, i) => {
        if (m !== null) assert.notEqual(e.effect.requests[i].file, OUT, 'no repeat on /outside-workspace');
      });
    }
    assert.ok(!a.files.has(OUT), 'no file entry for /outside-workspace');
    if (a.firstSource.value !== null) {
      assert.ok(!a.firstSource.value.file.startsWith('/'), `the first source edit attempt is inside the project, got ${a.firstSource.value.file}`);
    }
    const byLine = new Map(a.calls.map((e) => [e.call.n, e]));
    for (const n of a.possibleEarlier.value > 0 ? a.possibleEarlier.lines : []) {
      const e = byLine.get(n);
      assert.ok(e.effect.hiddenEdit || e.effect.edits.some((x) => x.cls === 'unknown'), `log line ${n} counts as possibly earlier only with a hidden or unknown-target edit`);
    }
    return true;
  });
});

// ---- samples (P29) ----

const SAMPLES = ['requests-6644', 'rich-3506', 'rich-3480'];
const loadSample = (name) => analyse(parse(readFileSync(new URL(`../samples/${name}.events.jsonl`, import.meta.url), 'utf8')));

test('the three samples are unchanged: every call recorded allow, notRecorded 0, phase 1 numbers (R14.8, P29)', () => {
  for (const name of SAMPLES) {
    const a = loadSample(name);
    assert.ok(a.calls.every((e) => e.call.permission === 'allowed' || e.call.permission === 'blocked'), `${name}: every sample line records allow`);
    assert.equal(a.notRecorded.value, 0, `${name}: notRecorded is 0`);
    assert.ok(a.notRecorded.lines.length > 0, `${name}: the 0 is traced to the checked calls`);
    assert.equal(findingsMod.permissionNote(a), null, `${name}: no permission note`);
  }
  const r6644 = loadSample('requests-6644');
  assert.equal(r6644.firstSource.value.call, 46, 'requests-6644: first source edit attempt at call 46 (design.md table)');
  assert.deepEqual([r6644.requests.value, r6644.repeats.value], [13, 1]);
  const r3506 = loadSample('rich-3506');
  assert.equal(r3506.firstSource.value, null, 'rich-3506: none recognised');
  assert.deepEqual([r3506.requests.value, r3506.repeats.value, r3506.possibleEarlier.value], [19, 7, 23]);
  const r3480 = loadSample('rich-3480');
  assert.deepEqual(r3480.top.value, { file: 'rich/text.py', from: 1007, to: 1010, count: 8 });
  assert.deepEqual([r3480.firstSource.value.call, r3480.requests.value, r3480.repeats.value, r3480.possibleEarlier.value], [162, 69, 27, 35]);
});
