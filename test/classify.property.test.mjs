// Seeded property tests for src/core/classify.js.
// Run: node --permission --allow-fs-read=. test/classify.property.test.mjs
// SEED=<n> changes the seed. Every failure prints the seed, the case index and the input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../src/core/parse.js';
import { MAX_LINE, classify } from '../src/core/classify.js';
import { check, dirName, fileName, limit, offset, quote, quoteStyle } from './gen.mjs';

const T = 1795248000;
const mkCall = (fields) => parseLine(JSON.stringify({ t: T, hook: 'pre', allow: true, cmd_truncated: false, ...fields }), 1, 1).call;
const bash = (cmd, extra = {}) => classify(mkCall({ tool: 'execute_bash', cmd, paths: [], range: {}, ...extra }));
const reqs = (e) => e.requests.map((r) => {
  if (r.kind === 'range') return [r.file, 'range', r.from, r.to];
  if (r.kind === 'open') return [r.file, 'open', r.from];
  return [r.file, r.kind];
});
const edits = (e) => e.edits.map((x) => [x.file, x.cls]);

/** True when every item of `small` appears in `big`, counting repeats. */
const isSubBag = (small, big) => {
  const counts = new Map();
  for (const x of big) counts.set(JSON.stringify(x), (counts.get(JSON.stringify(x)) ?? 0) + 1);
  for (const x of small) {
    const k = JSON.stringify(x);
    const c = counts.get(k) ?? 0;
    if (c === 0) return false;
    counts.set(k, c - 1);
  }
  return true;
};

const PREFIXES = ['', 'A=1 ', 'timeout 5 ', 'env B=2 ', 'PYTHONPATH=src timeout 60 ', 'X=1 env -i Y=2 timeout -s KILL 9 '];
const SUFFIXES = ['', ' 2>&1', ' | head -n 3', ' | head -n 17', '; echo x', ' && echo done'];

/**
 * One of the four R3.11 cases with generated names, quoting, prefix and suffix,
 * and the result it must give. Expected keys are joined by hand here, not by resolve().
 */
const genRegression = (r) => {
  const kind = r.int(1, 4);
  const f = fileName(r);
  const useDir = r.bool(0.4);
  const d = dirName(r);
  const rel = useDir ? `${d}/${f}` : f;
  const q = () => quoteStyle(r);
  const prefix = r.pick(PREFIXES);
  const suffix = r.pick(SUFFIXES);
  if (kind === 1) {
    return {
      cmd: `${prefix}grep ${quote('x', q())} ${quote(rel, q())} 2> /dev/null${suffix}`,
      expect: { category: 'search', requests: [[rel, 'unlocated']], edits: [] },
    };
  }
  if (kind === 2) {
    const out = `/tmp/${r.pick(['x', 'out', 'res.txt', 'a.py'])}`;
    return {
      cmd: `${prefix}cat ${quote(rel, q())} > ${quote(out, q())}${suffix}`,
      expect: { category: 'request', requests: [[rel, 'open', 1]], edits: [[out, 'outside']] },
    };
  }
  if (kind === 3) {
    const target = r.bool(0.3) ? `/workspace/${d}` : d;
    return {
      cmd: `cd ${quote(target, q())} && ${prefix}cat ${quote(f, q())}${suffix}`,
      expect: { category: 'request', requests: [[`${d}/${f}`, 'open', 1]], edits: [] },
    };
  }
  return {
    cmd: `${prefix}cat ${quote(rel, q())}; echo${suffix}`,
    expect: { category: 'request', requests: [[rel, 'open', 1]], edits: [] },
  };
};

test('P7: the four R3.11 cases hold for generated names, directories, quoting, prefixes and harmless suffixes', () => {
  check('P7', { runs: 400 }, genRegression, ({ cmd, expect }) => {
    const e = bash(cmd);
    assert.equal(e.category, expect.category, 'category');
    assert.deepEqual(reqs(e), expect.requests, 'requests');
    assert.deepEqual(edits(e), expect.edits, 'edits');
    assert.equal(e.hiddenEdit, false, 'none of these can change a workspace file');
    assert.ok(e.edits.every((x) => x.cls !== 'source'), 'never a source edit');
  });
});

const SHELL_CMDS = ['cat a.py', 'grep -n x rich/text.py', 'cd pkg && cat a.py', 'echo x > src/a.py', 'python3 x.py', 'git status', 'ls -la', 'tail -5 a.py'];

test('P3: changing paths on a shell call changes no effect', () => {
  check('P3 classify', {}, (r) => ({
    cmd: r.pick(SHELL_CMDS),
    paths: r.pick([[], ['a.py'], ['src/a.py', 'b.py'], ['/workspace'], null]),
  }), ({ cmd, paths }) => {
    const base = bash(cmd);
    const other = paths === null
      ? classify(mkCall({ tool: 'execute_bash', cmd, range: {} }))
      : bash(cmd, { paths });
    assert.deepEqual(other, base, 'paths must be ignored for execute_bash');
  });
});

test('P4: allow false is blocked with no requests, no edits and no hidden flags', () => {
  check('P4', {}, (r) => ({
    tool: r.pick(['execute_bash', 'read_file', 'str_replace', 'web_fetch', 'zz']),
    cmd: r.pick(SHELL_CMDS.concat(['', 'rm -rf x'])),
    paths: r.pick([[], ['a.py'], ['a', 'b']]),
    range: r.pick([{}, { offset: 3, limit: 4 }, []]),
  }), (fields) => {
    const e = classify(mkCall({ ...fields, allow: false }));
    assert.equal(e.category, 'blocked');
    assert.deepEqual([e.requests, e.edits, e.hiddenEdit, e.hiddenRequest], [[], [], false, false]);
  });
});

test('P5: read_file ranges are offset+1 .. offset+limit; without limit open; an end above MAX_LINE is unlocated', () => {
  check('P5', { runs: 400 }, (r) => {
    const near = r.bool(0.2);
    const off = near ? MAX_LINE - r.int(0, 60) : offset(r);
    const lim = r.bool(0.75) ? limit(r) : null;
    const withOffset = off !== 0 || r.bool(0.5);
    const range = {};
    if (withOffset) range.offset = off;
    if (lim !== null) range.limit = lim;
    return { range, off, lim };
  }, ({ range, off, lim }) => {
    const e = classify(mkCall({ tool: 'read_file', paths: ['src/a.py'], range, cmd: '' }));
    assert.equal(e.requests.length, 1, 'one request');
    const req = e.requests[0];
    if (lim !== null) {
      if (off + lim > MAX_LINE) assert.deepEqual(reqs(e), [['src/a.py', 'unlocated']], 'end above MAX_LINE');
      else assert.deepEqual(reqs(e), [['src/a.py', 'range', off + 1, off + lim]], 'explicit range');
    } else if (off + 1 > MAX_LINE) {
      assert.deepEqual(reqs(e), [['src/a.py', 'unlocated']], 'open start above MAX_LINE');
    } else {
      assert.deepEqual(reqs(e), [['src/a.py', 'open', off + 1]], 'no limit: open-ended');
      assert.ok(!('to' in req), 'an open request has no end line, so it can add nothing to counts');
    }
  });
});

test('P6: /workspace, no path or several paths never produce a file key', () => {
  check('P6', {}, (r) => ({
    paths: r.pick([['/workspace'], ['/workspace/'], [], [fileName(r), fileName(r)], '/workspace']),
    range: r.pick([{}, { offset: offset(r), limit: limit(r) }, { limit: limit(r) }]),
  }), ({ paths, range }) => {
    const rf = classify(mkCall({ tool: 'read_file', paths, range, cmd: '' }));
    assert.deepEqual(rf.requests, [], 'read_file: no file key');
    assert.equal(rf.hiddenRequest, true, 'read_file: hidden request');
    const sr = classify(mkCall({ tool: 'str_replace', paths, cmd: '' }));
    assert.deepEqual(edits(sr), [[null, 'unknown']], 'str_replace: unknown target');
  });
});

const UNKNOWN_TAILS = [' | python3', '; eval x', '; echo $(x)', ' && make', ' | xargs rm', '; $CMD', '; bash -c "rm a.py"'];

test('P9: an appended unknown segment or truncation never adds requests or edits and never clears hiddenEdit', () => {
  check('P9', { runs: 400 }, (r) => {
    const { cmd } = genRegression(r);
    return { cmd, tail: r.pick(UNKNOWN_TAILS), cut: r.int(0, cmd.length) };
  }, ({ cmd, tail, cut }) => {
    const base = bash(cmd);
    const longer = bash(cmd + tail);
    assert.ok(isSubBag(reqs(longer), reqs(base)), 'appending must not add requests');
    assert.ok(isSubBag(edits(longer), edits(base)), 'appending must not add edits');
    assert.equal(longer.hiddenEdit, true, 'an unknown segment sets hiddenEdit');

    const marked = bash(cmd, { cmd_truncated: true });
    assert.ok(isSubBag(reqs(marked), reqs(base)) && isSubBag(edits(marked), edits(base)), 'marking truncated keeps a subset');
    assert.deepEqual([marked.hiddenEdit, marked.hiddenRequest], [true, true], 'a truncated call has both hidden flags');

    const prefix = cmd.slice(0, cut);
    const cutCall = bash(prefix, { cmd_truncated: true });
    assert.ok(isSubBag(reqs(cutCall), reqs(base)), `prefix ${JSON.stringify(prefix)}: requests must be a subset of the full command's`);
    assert.ok(isSubBag(edits(cutCall), edits(base)), `prefix ${JSON.stringify(prefix)}: edits must be a subset of the full command's`);
    assert.equal(cutCall.hiddenEdit, true, 'a truncated prefix has hiddenEdit');
  });
});

test('P10: requests from grep, rg, tail and wc never carry line numbers', () => {
  check('P10', { runs: 300 }, (r) => {
    const files = Array.from({ length: r.int(1, 3) }, () => (r.bool(0.5) ? `${dirName(r)}/${fileName(r)}` : fileName(r)));
    const prog = r.pick(['grep', 'egrep', 'rg', 'tail', 'wc']);
    const opts = {
      grep: ['', '-n', '-in', '-A 3', '-c', '-l'],
      egrep: ['', '-n'],
      rg: ['', '-n', '--type py'],
      tail: ['', '-50', '-n 20', '-f'],
      wc: ['', '-l', '-c'],
    }[prog];
    const pattern = ['grep', 'egrep', 'rg'].includes(prog) ? ` ${quote('x', quoteStyle(r))}` : '';
    return { cmd: `${prog} ${r.pick(opts)}${pattern} ${files.map((f) => quote(f, quoteStyle(r))).join(' ')}`.replace(/ +/g, ' ') };
  }, ({ cmd }) => {
    const e = bash(cmd);
    for (const req of e.requests) {
      assert.equal(req.kind, 'unlocated', `${cmd}: request on ${req.file} must be unlocated`);
      assert.ok(!('from' in req) && !('to' in req), 'no line numbers');
    }
  });
});

test('P11: /dev/null and fd-copy redirects never edit; a static write redirect into the workspace always edits the resolved path', () => {
  check('P11', { runs: 300 }, (r) => {
    const base = r.pick(['echo x', 'ls', 'cat a.py', 'grep -n x a.py', 'git status']);
    const harmless = r.pick(['> /dev/null', '2>/dev/null', '2>&1', '>&2', '&> /dev/null', '1>&2', '2> /dev/null', '>>/dev/null']);
    const f = fileName(r);
    const d = dirName(r);
    const style = r.bool(0.5) ? 'cd' : r.pick(['rel', 'abs']);
    const op = r.pick(['>', '>>', '>|', '&>', '1>']);
    let write;
    if (style === 'cd') write = `cd ${d} && ${base} ${op} ${quote(f, quoteStyle(r))}`;
    else if (style === 'rel') write = `${base} ${op} ${quote(`${d}/${f}`, quoteStyle(r))}`;
    else write = `${base} ${op} /workspace/${d}/${f}`;
    return { harmlessCmd: `${base} ${harmless}`, write, key: `${d}/${f}` };
  }, ({ harmlessCmd, write, key }) => {
    assert.deepEqual(bash(harmlessCmd).edits, [], `${harmlessCmd}: no edit`);
    const e = bash(write);
    assert.deepEqual(edits(e), [[key, 'source']], `${write}: edit on ${key}`);
    assert.equal(e.category, 'edit', 'an edit inside the workspace makes an edit call');
  });
});
