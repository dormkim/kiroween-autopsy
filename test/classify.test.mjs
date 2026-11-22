// Unit tests for src/core/classify.js.
// Run: node --permission --allow-fs-read=. test/classify.test.mjs
// Expected values follow requirements R3 and design "Classify". Calls are built
// with parseLine so the classifier sees the same Call shape as in the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseLine } from '../src/core/parse.js';
import { MAX_LINE, ROOT, classify, editClass, resolve } from '../src/core/classify.js';

const T = 1795248000;
const mkCall = (fields, n = 1, index = 1) => {
  const line = parseLine(JSON.stringify({ t: T, hook: 'pre', allow: true, cmd_truncated: false, ...fields }), n, index);
  assert.equal(line.kind, 'call', 'test helper must build a call');
  return line.call;
};
const bash = (cmd, extra = {}) => classify(mkCall({ tool: 'execute_bash', cmd, paths: [], range: {}, ...extra }));
const readFile = (paths, range) => classify(mkCall({ tool: 'read_file', paths, ...(range === undefined ? {} : { range }), cmd: '' }));
const strReplace = (paths) => classify(mkCall({ tool: 'str_replace', paths, cmd: '' }));

/** Requests as compact tuples: [file, 'range', from, to] | [file, 'open', from] | [file, 'unlocated'] */
const reqs = (e) => e.requests.map((r) => {
  if (r.kind === 'range') return [r.file, 'range', r.from, r.to];
  if (r.kind === 'open') return [r.file, 'open', r.from];
  return [r.file, r.kind];
});
const edits = (e) => e.edits.map((x) => [x.file, x.cls]);
const flags = (e) => [e.hiddenEdit, e.hiddenRequest];
const fx = (cmd) => {
  const e = bash(cmd);
  return { category: e.category, requests: reqs(e), edits: edits(e), hidden: flags(e) };
};

// ---- the four R3.11 regression cases ----

test('regression: grep x a.py 2> /dev/null requests a.py with unknown lines and edits nothing', () => {
  assert.deepEqual(fx('grep x a.py 2> /dev/null'), {
    category: 'search',
    requests: [['a.py', 'unlocated']],
    edits: [],
    hidden: [false, false],
  }, 'x is the pattern, a.py the file; a redirect to /dev/null is not a write');
});

test('regression: cat a.py > /tmp/x requests a.py from line 1 and makes an outside write, not a source edit', () => {
  const e = bash('cat a.py > /tmp/x');
  assert.equal(e.category, 'request', 'a write outside the workspace does not make the call an edit attempt');
  assert.deepEqual(reqs(e), [['a.py', 'open', 1]], 'cat requests the whole file from line 1');
  assert.deepEqual(edits(e), [['/tmp/x', 'outside']], 'the redirect is an edit on /tmp/x with class outside (tasks.md note)');
  assert.ok(e.edits.every((x) => x.cls !== 'source'), 'never a source edit');
  assert.deepEqual(flags(e), [false, false]);
});

test('regression: cd pkg && cat a.py requests pkg/a.py', () => {
  assert.deepEqual(fx('cd pkg && cat a.py'), {
    category: 'request',
    requests: [['pkg/a.py', 'open', 1]],
    edits: [],
    hidden: [false, false],
  }, 'cd is tracked within the call, starting from /workspace');
});

test('regression: cat a.py; echo requests a.py', () => {
  assert.deepEqual(fx('cat a.py; echo'), {
    category: 'request',
    requests: [['a.py', 'open', 1]],
    edits: [],
    hidden: [false, false],
  }, 'the ; splits the command; echo is neutral');
});

// ---- constants and helpers ----

test('constants: ROOT and MAX_LINE', () => {
  assert.equal(ROOT, '/workspace');
  assert.equal(MAX_LINE, 10_000_000);
});

test('resolve joins cwd and path, normalises, and keys workspace files relative', () => {
  assert.equal(resolve('a.py', ROOT), 'a.py');
  assert.equal(resolve('./src//x/../a.py', ROOT), 'src/a.py');
  assert.equal(resolve('/workspace/rich/text.py', ROOT), 'rich/text.py');
  assert.equal(resolve('a.py', '/workspace/pkg'), 'pkg/a.py');
  assert.equal(resolve('../b.py', '/workspace/pkg'), 'b.py');
  assert.equal(resolve('../../etc/x', '/workspace/pkg'), '/etc/x', 'leaving the workspace gives an absolute key');
  assert.equal(resolve('/tmp/x', ROOT), '/tmp/x');
  assert.equal(resolve('/workspace', ROOT), null, '/workspace itself is not a file');
  assert.equal(resolve('/workspace/', ROOT), null);
  assert.equal(resolve('.', ROOT), null, 'the workspace directory is not a file');
  assert.equal(resolve('/workspacex/a', ROOT), '/workspacex/a', 'a sibling directory is outside');
  assert.equal(resolve('/../../a', ROOT), '/a', '.. above / stays at /');
});

test('editClass in the documented order', () => {
  const cases = [
    [null, 'unknown'],
    ['/tmp/x', 'outside'],
    ['/tmp/test_a.py', 'outside'],
    ['.kiro/exorcist/hooks.py', 'other'],
    ['src/.hidden/a.py', 'other'],
    ['tests/helpers.py', 'test'],
    ['pkg/test/a.py', 'test'],
    ['pkg/testing/a.py', 'test'],
    ['ui/__tests__/a.js', 'test'],
    ['spec/a.rb', 'test'],
    ['src/test_models.py', 'test'],
    ['src/models_test.go', 'test'],
    ['src/a.test.js', 'test'],
    ['src/a.spec.ts', 'test'],
    ['conftest.py', 'test'],
    ['repro.py', 'scratch'],
    ['Scratch_1.py', 'scratch'],
    ['src/debug_x.py', 'scratch'],
    ['TMP.py', 'scratch'],
    ['temp_check.js', 'scratch'],
    ['src/requests/models.py', 'source'],
    ['rich/text.py', 'source'],
    ['a.rs', 'source'],
    ['README.md', 'other'],
    ['setup.cfg', 'other'],
    ['Makefile', 'other'],
  ];
  for (const [key, cls] of cases) assert.equal(editClass(key), cls, `${key} must be ${cls}`);
});

// ---- tool table ----

test('allow false: blocked with no effects and no hidden flags, for any tool', () => {
  for (const tool of ['execute_bash', 'read_file', 'str_replace', 'web_fetch', 'zz_tool']) {
    const e = classify(mkCall({ tool, cmd: 'cat a.py > src/b.py', paths: ['a.py'], allow: false }));
    assert.equal(e.category, 'blocked', `${tool} with allow false is blocked`);
    assert.deepEqual([e.requests, e.edits, flags(e)], [[], [], [false, false]], `${tool}: blocked means no request and no edit attempt`);
  }
});

test('allow of wrong type: unknown with both hidden flags', () => {
  for (const allow of ['yes']) {
    const fields = { tool: 'read_file', paths: ['a.py'], cmd: '' };
    const raw = { t: T, hook: 'pre', cmd_truncated: false, ...fields, allow };
    const e = classify(parseLine(JSON.stringify(raw), 1, 1).call);
    assert.equal(e.category, 'unknown', `allow ${String(allow)}: unknown`);
    assert.deepEqual(flags(e), [true, true]);
  }
});

// Changed in increment E (R14.1): an absent allow was unknown; it is now permission not_recorded,
// classified as an attempt. Malformed allow above is unchanged.
test('allow absent: permission not_recorded, classified as an attempt (R14.1)', () => {
  const raw = { t: T, hook: 'pre', cmd_truncated: false, tool: 'read_file', paths: ['a.py'], cmd: '' };
  const e = classify(parseLine(JSON.stringify(raw), 1, 1).call);
  assert.equal(e.category, 'request', 'absent allow: a request attempt');
  assert.equal(e.permission, 'not_recorded');
  assert.deepEqual(flags(e), [false, false]);
});

test('read_file range rules', () => {
  assert.deepEqual(reqs(readFile(['a.py'])), [['a.py', 'open', 1]], 'range absent: open from 1');
  assert.deepEqual(reqs(readFile(['a.py'], {})), [['a.py', 'open', 1]], 'range {}: open from 1');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: 360 })), [['a.py', 'open', 361]], 'offset only: open from offset + 1');
  assert.deepEqual(reqs(readFile(['a.py'], { limit: 100 })), [['a.py', 'range', 1, 100]], 'limit only: offset 0');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: 360, limit: 50 })), [['a.py', 'range', 361, 410]], 'offset 360, limit 50');
  assert.deepEqual(reqs(readFile(['a.py'], [])), [['a.py', 'unlocated']], 'range of wrong type: unlocated');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: -1, limit: 3 })), [['a.py', 'unlocated']], 'invalid offset: unlocated');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: MAX_LINE - 10, limit: 10 })), [['a.py', 'range', MAX_LINE - 9, MAX_LINE]], 'end exactly MAX_LINE is counted');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: MAX_LINE - 10, limit: 11 })), [['a.py', 'unlocated']], 'end above MAX_LINE: unlocated');
  assert.deepEqual(reqs(readFile(['a.py'], { offset: MAX_LINE })), [['a.py', 'unlocated']], 'open start above MAX_LINE: unlocated');
  const e = readFile(['rich/text.py'], { offset: 962, limit: 100 });
  assert.equal(e.category, 'request');
  assert.deepEqual(flags(e), [false, false]);
  assert.deepEqual(e.edits, []);
  assert.deepEqual([e.requests[0].call, e.requests[0].n], [1, 1], 'a request carries the call index and log line');
});

test('read_file and str_replace: /workspace, no path or several paths give no file key', () => {
  for (const paths of [['/workspace'], [], ['a.py', 'b.py'], 'a.py', ['/workspace/']]) {
    const r = readFile(paths, { offset: 1, limit: 2 });
    assert.equal(r.category, 'request', `read_file ${JSON.stringify(paths)} is a request`);
    assert.deepEqual(r.requests, [], `read_file ${JSON.stringify(paths)}: no file key`);
    assert.equal(r.hiddenRequest, true, `read_file ${JSON.stringify(paths)}: hidden request`);
    const s = strReplace(paths);
    assert.equal(s.category, 'edit');
    assert.deepEqual(edits(s), [[null, 'unknown']], `str_replace ${JSON.stringify(paths)}: edit with unknown target`);
  }
  assert.deepEqual(reqs(readFile(['/workspace/rich/a.py'])), [['rich/a.py', 'open', 1]], 'an absolute workspace path becomes a relative key');
});

test('str_replace with one path is an edit attempt with its class', () => {
  const e = strReplace(['src/requests/models.py']);
  assert.equal(e.category, 'edit');
  assert.deepEqual(edits(e), [['src/requests/models.py', 'source']]);
  assert.deepEqual([e.requests, flags(e)], [[], [false, false]]);
  assert.deepEqual(edits(strReplace(['tests/test_a.py'])), [['tests/test_a.py', 'test']]);
  assert.deepEqual(edits(strReplace(['/tmp/x.py'])), [['/tmp/x.py', 'outside']]);
});

test('web_fetch is other with no effects; unknown tools are unknown with both hidden flags', () => {
  const w = classify(mkCall({ tool: 'web_fetch', cmd: 'page' }));
  assert.deepEqual([w.category, w.requests, w.edits, flags(w)], ['other', [], [], [false, false]]);
  const u = classify(mkCall({ tool: 'fs_write', paths: ['src/a.py'] }));
  assert.deepEqual([u.category, u.requests, u.edits, flags(u)], ['unknown', [], [], [true, true]]);
  const nocmd = classify(mkCall({ tool: 'execute_bash', cmd: 42 }));
  assert.deepEqual([nocmd.category, flags(nocmd)], ['unknown', [true, true]], 'execute_bash with an unknown cmd');
});

// ---- shell program table ----

test('cat and nl: open request from line 1 per file operand; no operand is neutral', () => {
  assert.deepEqual(fx('cat a.py b.py'), { category: 'request', requests: [['a.py', 'open', 1], ['b.py', 'open', 1]], edits: [], hidden: [false, false] });
  assert.deepEqual(fx('nl -ba src/x.py').requests, [['src/x.py', 'open', 1]], 'options are skipped');
  assert.deepEqual(fx('cat /workspace/a.py').requests, [['a.py', 'open', 1]]);
  assert.deepEqual(fx('echo x | cat'), { category: 'other', requests: [], edits: [], hidden: [false, false] }, 'cat with no file is a neutral filter');
});

test('head: -n N, -nN, -N give 1..N; no count gives 1..10; -c or an unparsed option is unlocated', () => {
  assert.deepEqual(fx('head -n 20 a.py').requests, [['a.py', 'range', 1, 20]]);
  assert.deepEqual(fx('head -n20 a.py').requests, [['a.py', 'range', 1, 20]]);
  assert.deepEqual(fx('head -20 a.py').requests, [['a.py', 'range', 1, 20]]);
  assert.deepEqual(fx('head a.py b.py').requests, [['a.py', 'range', 1, 10], ['b.py', 'range', 1, 10]]);
  assert.deepEqual(fx('head -c 100 a.py').requests, [['a.py', 'unlocated']]);
  assert.deepEqual(fx('head -n -5 a.py').requests, [['a.py', 'unlocated']], 'a negative count is not parsed');
  assert.deepEqual(fx('head --zz a.py').requests, [['a.py', 'unlocated']]);
  assert.equal(fx('head -n 20 a.py').category, 'request');
  assert.deepEqual(fx('ls | head -20'), { category: 'search', requests: [], edits: [], hidden: [false, false] }, 'head with no file is a filter');
});

test("sed -n 'A,Bp' F and sed -n 'Ap' F give a range; any other sed with a file is unknown with hidden edit", () => {
  assert.deepEqual(fx("sed -n '81,100p' src/models.py").requests, [['src/models.py', 'range', 81, 100]]);
  assert.deepEqual(fx('sed -n 5p a.py').requests, [['a.py', 'range', 5, 5]]);
  assert.deepEqual(fx('sed -n "5,9p" a.py').requests, [['a.py', 'range', 5, 9]]);
  assert.equal(fx("sed -n '81,100p' a.py").category, 'request');
  for (const cmd of ["sed 's/a/b/' a.py", "sed -n '5,$p' a.py", "sed -n '9,5p' a.py"]) {
    const r = fx(cmd);
    assert.equal(r.category, 'unknown', `${cmd}: unknown`);
    assert.equal(r.hidden[0], true, `${cmd}: hidden edit`);
    assert.deepEqual(r.requests, [], `${cmd}: no counted request`);
  }
  assert.deepEqual(fx("sed -n '1,99999999p' a.py").requests, [['a.py', 'unlocated']], 'an end above MAX_LINE is unlocated');
  assert.deepEqual(fx("cat a.py | sed 's/x/y/'"), { category: 'request', requests: [['a.py', 'open', 1]], edits: [], hidden: [false, false] }, 'sed with no file is a filter');
});

// ---- shell write programs: sed in place and tee (reviewer probe after increment A) ----

test('sed -i, -iSUFFIX and --in-place with static file operands: edit attempt on each file, never on the script', () => {
  const cases = [
    ["sed -i 's/a/b/' src/a.py", [['src/a.py', 'source']]],
    ["sed -i '1d' src/a.py tests/test_a.py", [['src/a.py', 'source'], ['tests/test_a.py', 'test']]],
    ["sed --in-place 's|a|b|g; s/c/d/2' rich/text.py", [['rich/text.py', 'source']]],
    ["sed -i -e 's/a/b/' -e '/^#/d' a.py", [['a.py', 'source']]],
    ["sed -i --expression='3,5d' a.py b.md", [['a.py', 'source'], ['b.md', 'other']]],
    ["sed -Ei 's/a+/b/' a.py", [['a.py', 'source']]],
    ["sed -i -E 's/x/y/g' a.py", [['a.py', 'source']]],
    ["sed -i -- 's/x/y/' a.py", [['a.py', 'source']]],
    ["cd rich && sed -i 's/x/y/' text.py", [['rich/text.py', 'source']]],
    ["sed -i 's/x/y/' /workspace/rich/text.py", [['rich/text.py', 'source']]],
  ];
  for (const [cmd, expected] of cases) {
    assert.deepEqual(fx(cmd), { category: 'edit', requests: [], edits: expected, hidden: [false, false] },
      `${cmd}: the first operand is the script unless -e gave one; every other static operand is rewritten in place`);
  }
});

test('sed in place with a backup suffix also writes the backup file', () => {
  assert.deepEqual(fx("sed -i.bak 's/a/b/' src/a.py").edits, [['src/a.py', 'source'], ['src/a.py.bak', 'other']],
    '-i.bak writes src/a.py and the backup src/a.py.bak');
  assert.deepEqual(fx("sed --in-place=.orig 's/a/b/' a.py b.py").edits,
    [['a.py', 'source'], ['a.py.orig', 'other'], ['b.py', 'source'], ['b.py.orig', 'other']], 'one backup per file, after its file');
  assert.deepEqual(fx("sed -ie 's/a/b/' a.py").edits, [['a.py', 'source'], ['a.pye', 'other']],
    '-ie is -i with suffix "e" (the letters after -i are the suffix), so the script is the next word');
  const star = fx("sed '-ibak/*' 's/a/b/' a.py");
  assert.deepEqual([star.edits, star.hidden], [[['a.py', 'source']], [true, false]],
    'a suffix with * or / names the backup by a template: the file edit stays, the backup is a hidden edit');
});

test('sed in place: a script that may write or run other things keeps the file edits and adds a hidden edit', () => {
  for (const cmd of ["sed -i 's/a/b/w out.txt' a.py", "sed -i 's/a/b/e' a.py", "sed -i '1e date' a.py", "sed -i '/x/W log' a.py", 'sed -i "s/a/$X/" a.py']) {
    assert.deepEqual(fx(cmd), { category: 'edit', requests: [], edits: [['a.py', 'source']], hidden: [true, false] },
      `${cmd}: the w, W and e commands and a dynamic script can write files the log does not name`);
  }
});

test('sed in place: dynamic, glob or unresolvable file operands give an edit with unknown target', () => {
  for (const cmd of ["sed -i 's/a/b/' $F", "sed -i 's/a/b/' rich/*.py", "cd $D && sed -i 's/a/b/' a.py"]) {
    assert.deepEqual(fx(cmd), { category: 'unknown', requests: [], edits: [[null, 'unknown']], hidden: [true, false] },
      `${cmd}: sed writes a file, but which one is unknown`);
  }
  assert.deepEqual(fx("sed -i 's/a/b/' /tmp/x.py"), { category: 'other', requests: [], edits: [['/tmp/x.py', 'outside']], hidden: [false, false] },
    'a write outside the workspace does not make the call an edit attempt, as for redirects');
});

test('sed in place stays unknown when the script and the file operands cannot be told apart', () => {
  for (const cmd of ["sed -i '' 's/a/b/' a.py", "sed -i .bak 's/a/b/' a.py", "sed -Ei '' 's/a/b/' a.py", "sed -i 's/a/b/'", "sed -i -f fix.sed a.py"]) {
    assert.deepEqual(fx(cmd), { category: 'unknown', requests: [], edits: [], hidden: [true, true] },
      `${cmd}: BSD sed reads the word after a bare -i as a suffix, GNU sed as the script; -f and no file are not followed`);
  }
});

test('tee with static file operands: edit attempt on each file, also after a pipe', () => {
  assert.deepEqual(fx('echo x | tee src/a.py'), { category: 'edit', requests: [], edits: [['src/a.py', 'source']], hidden: [false, false] });
  assert.deepEqual(fx('cat a.py | tee -a notes.md /tmp/copy'), {
    category: 'edit', requests: [['a.py', 'open', 1]], edits: [['notes.md', 'other'], ['/tmp/copy', 'outside']], hidden: [false, false],
  }, 'tee -a appends to every file operand');
  assert.deepEqual(fx('python3 t.py 2>&1 | tee --append repro_log.txt'), {
    category: 'edit', requests: [], edits: [['repro_log.txt', 'scratch']], hidden: [true, true],
  }, 'python3 keeps its hidden flags; edit outranks run');
  assert.deepEqual(fx('cd pkg && echo x | tee -i -p a.py').edits, [['pkg/a.py', 'source']], '-i and -p take no argument; cd before the pipe is followed');
  assert.deepEqual(fx('tee a.py < b.py'), { category: 'edit', requests: [['b.py', 'unlocated']], edits: [['a.py', 'source']], hidden: [false, false] });
  assert.deepEqual(fx('echo x | tee /tmp/out'), { category: 'other', requests: [], edits: [['/tmp/out', 'outside']], hidden: [false, false] });
  assert.deepEqual(fx('echo x | tee'), { category: 'other', requests: [], edits: [], hidden: [false, false] }, 'tee with no file only copies to stdout');
  assert.deepEqual(fx('echo x | tee /dev/null'), { category: 'other', requests: [], edits: [], hidden: [false, false] }, '/dev/null is not a write');
});

test('tee stays unknown where the target or the options cannot be read', () => {
  for (const cmd of ['echo x | tee "$OUT"', 'echo x | tee *.log', 'echo x | tee -']) {
    assert.deepEqual(fx(cmd), { category: 'unknown', requests: [], edits: [[null, 'unknown']], hidden: [true, false] },
      `${cmd}: tee writes, but the file is unknown`);
  }
  assert.deepEqual(fx('echo x | tee --zz a.py'), { category: 'unknown', requests: [], edits: [], hidden: [true, true] },
    'an unparsed option could take a.py as its argument');
});

test('truncated: sed in place and tee keep edits only from segments that ended before the cut', () => {
  const t = (cmd) => {
    const e = bash(cmd, { cmd_truncated: true });
    return { category: e.category, edits: edits(e), hidden: flags(e) };
  };
  assert.deepEqual(t("sed -i 's/a/b/' src/a.py; cat b.py"), { category: 'edit', edits: [['src/a.py', 'source']], hidden: [true, true] });
  assert.deepEqual(t('echo x | tee src/a.py').edits, [], 'the cut tee segment adds no edit');
  assert.deepEqual(t("sed -i 's/a/b/' src/a.py").edits, [], 'the cut sed segment adds no edit');
});

test('tail and wc with files: request with unknown lines', () => {
  assert.deepEqual(fx('tail -50 tests/test_text.py'), { category: 'request', requests: [['tests/test_text.py', 'unlocated']], edits: [], hidden: [false, false] },
    'pinned from rich-3480 log line 80');
  assert.deepEqual(fx('tail -n 5 a.py').requests, [['a.py', 'unlocated']], '-n takes the next word');
  assert.deepEqual(fx('wc -l a.py b.py').requests, [['a.py', 'unlocated'], ['b.py', 'unlocated']]);
  assert.deepEqual(fx('ls | wc -l').requests, []);
});

test('grep: file operands unlocated; -r or no file operand: none; unparsed option: hidden request', () => {
  assert.deepEqual(fx('grep -n "def path_url" ./src/requests/models.py'), {
    category: 'search', requests: [['src/requests/models.py', 'unlocated']], edits: [], hidden: [false, false],
  });
  assert.deepEqual(fx('grep -A 2 x a.py b.py').requests, [['a.py', 'unlocated'], ['b.py', 'unlocated']], '-A takes a number; then pattern, then files');
  assert.deepEqual(fx('grep -e x -e y a.py').requests, [['a.py', 'unlocated']], 'with -e every operand is a file');
  assert.deepEqual(fx('egrep x a.py').requests, [['a.py', 'unlocated']]);
  assert.deepEqual(fx('fgrep x a.py').requests, [['a.py', 'unlocated']]);
  assert.deepEqual(fx('grep -rn "x" ./src --include="*.py"'), { category: 'search', requests: [], edits: [], hidden: [false, false] }, '-r names roots, not files');
  assert.deepEqual(fx('git log | grep -i x'), { category: 'search', requests: [], edits: [], hidden: [false, false] }, 'no file operand: no request; search outranks vcs');
  const odd = fx('grep --zz x a.py');
  assert.deepEqual([odd.category, odd.requests, odd.hidden], ['search', [], [false, true]], 'unparsed option: hidden request, no named file');
  assert.deepEqual(fx('grep -- -x a.py').requests, [['a.py', 'unlocated']], '-- ends options');
});

test('rg is a search with a hidden request', () => {
  assert.deepEqual(fx('rg path_url src'), { category: 'search', requests: [], edits: [], hidden: [false, true] });
});

test('ls, find, pwd and which are searches; find with -exec, -delete or -fprint has a hidden edit', () => {
  for (const cmd of ['ls -la', 'pwd', 'which python3', 'find . -type f -name "*.py"']) {
    assert.deepEqual(fx(cmd), { category: 'search', requests: [], edits: [], hidden: [false, false] }, cmd);
  }
  for (const cmd of ['find . -delete', 'find . -fprint out.txt', 'find . -fls out', 'find . -name x -fprintf out "%p"']) {
    const r = fx(cmd);
    assert.deepEqual([r.category, r.hidden[0]], ['search', true], `${cmd}: search with hidden edit`);
  }
  const ex = fx('find . -name "*.py" -type f -exec grep -l "x" {} \\;');
  assert.deepEqual([ex.category, ex.hidden], ['search', [true, true]], 'find -exec grep: category of grep, both hidden');
  assert.deepEqual(fx('find . -execdir python3 x.py {} +').category, 'run', 'find -execdir python3: category of python3');
  assert.deepEqual(fx('find . -ok rm {} \\;').category, 'unknown');
});

test('neutral programs: echo, printf, true, sort without -o, cut, tr', () => {
  for (const cmd of ['echo hi', 'printf "%s" x', 'true', 'echo a | sort', 'echo a | cut -d, -f1', 'echo a | tr a b']) {
    assert.deepEqual(fx(cmd), { category: 'other', requests: [], edits: [], hidden: [false, false] }, `${cmd} is neutral`);
  }
  assert.equal(fx('sort -o out.txt a').hidden[0], true, 'sort -o writes a file');
});

test('git: read-only subcommands are vcs with no effects; others have a hidden edit', () => {
  for (const cmd of ['git log --all --oneline --grep="6643"', 'git show 5cb1035c --stat', 'git diff src/requests/models.py', 'git status --short',
    'git rev-parse HEAD', 'git blame a.py', 'git ls-files', 'git grep x', 'git stash list', 'git stash show', 'git branch -a',
    'git branch -a --list "*3479*"', 'git branch -r --list "*append*" "*3479*"', 'git -C /workspace log', 'git --no-pager diff', 'git log -1 --format="%H %s"']) {
    assert.deepEqual(fx(cmd), { category: 'vcs', requests: [], edits: [], hidden: [false, false] }, `${cmd} is read-only`);
  }
  for (const cmd of ['git stash', 'git stash pop', 'git checkout a.py', 'git apply x.patch', 'git reset --hard', 'git restore a.py', 'git branch new-name', 'git diff --output=x.txt']) {
    const r = fx(cmd);
    assert.deepEqual([r.category, r.hidden[0]], ['vcs', true], `${cmd} can change files`);
  }
});

test('test runners: pytest, py.test and python -m pytest or unittest', () => {
  for (const cmd of ['pytest -x', 'py.test tests', 'python3 -m pytest tests/ -v', '/lab/venvs/x/bin/python -m pytest a', 'python -m unittest']) {
    assert.deepEqual(fx(cmd), { category: 'test', requests: [], edits: [], hidden: [true, true] }, cmd);
  }
});

test('interpreters and code runners: run with both hidden flags', () => {
  for (const cmd of ['python3 -c "print(1)"', 'python3.11 x.py', 'node x.js', 'bash x.sh', 'sh -c "ls"', 'zsh', 'perl -e 1', 'ruby x.rb', 'php x.php',
    'eval "ls"', 'exec ls', 'source env.sh', '. env.sh', "python3 << 'EOF'\nprint(1)\nEOF"]) {
    assert.deepEqual(fx(cmd), { category: 'run', requests: [], edits: [], hidden: [true, true] }, cmd);
  }
});

test('xargs CMD: category of CMD with both hidden flags', () => {
  const r = fx('find ./src -type f -name "*.py" | xargs grep -l "urllib3"');
  assert.deepEqual([r.category, r.requests, r.hidden], ['search', [], [true, true]]);
  assert.equal(fx('ls | xargs -n 1 cat').category, 'request');
  assert.equal(fx('ls | xargs -I{} python3 {}').category, 'run');
  assert.equal(fx('ls | xargs rm').category, 'unknown');
});

test('unknown programs: unknown with both hidden flags', () => {
  for (const cmd of ['rm a.py', 'make', 'cp a b', 'sleep 1', '/usr/bin/zz']) {
    assert.deepEqual(fx(cmd), { category: 'unknown', requests: [], edits: [], hidden: [true, true] }, cmd);
  }
});

// ---- prefixes ----

test('NAME=value, env and timeout prefixes are skipped', () => {
  assert.equal(fx('PYTHONPATH=src python3 x.py').category, 'run');
  assert.deepEqual(fx('env A=1 cat a.py').requests, [['a.py', 'open', 1]]);
  assert.deepEqual(fx('env -i A=1 cat a.py').requests, [['a.py', 'open', 1]]);
  assert.deepEqual(fx('timeout 60 cat a.py').requests, [['a.py', 'open', 1]]);
  assert.deepEqual(fx('timeout -s KILL 5 cat a.py').requests, [['a.py', 'open', 1]], '-s takes a signal');
  assert.deepEqual(fx('timeout --signal=KILL 5s grep x a.py').requests, [['a.py', 'unlocated']]);
  assert.deepEqual(fx('A=1 env B=2 timeout 5 cat a.py').requests, [['a.py', 'open', 1]], 'all three in design order');
  assert.equal(fx('cd /workspace && timeout 60 /lab/venvs/x/bin/python -m pytest tests/test_text.py -x 2>&1 | tail').category, 'test');
  assert.deepEqual(fx('A=1'), { category: 'other', requests: [], edits: [], hidden: [false, false] }, 'an assignment alone is neutral');
});

// ---- cd tracking ----

test('cd is tracked within one call from /workspace', () => {
  assert.deepEqual(fx('cd /workspace/rich && cat text.py').requests, [['rich/text.py', 'open', 1]]);
  assert.deepEqual(fx('cd rich; cd ..; cat a.py').requests, [['a.py', 'open', 1]]);
  assert.deepEqual(fx('cd /tmp && cat x').requests, [['/tmp/x', 'open', 1]], 'outside the workspace the key is absolute');
  assert.deepEqual(fx('cd /workspace && grep -n x rich/text.py').requests, [['rich/text.py', 'unlocated']]);
  assert.deepEqual(fx('cat a.py').requests, [['a.py', 'open', 1]], 'a new call starts at /workspace again');
});

test('cd with a dynamic target, -, no argument, or inside a pipeline makes relative paths unknown', () => {
  for (const cmd of ['cd $D && cat a.py', 'cd - && cat a.py', 'cd && cat a.py', 'cd ~ && cat a.py', 'ls | cd x; cat a.py', 'cd x | ls; cat a.py']) {
    const r = fx(cmd);
    assert.deepEqual(r.requests, [], `${cmd}: the relative file cannot be named`);
    assert.equal(r.hidden[1], true, `${cmd}: hidden request`);
  }
  assert.deepEqual(fx('cd $D && cat /workspace/a.py').requests, [['a.py', 'open', 1]], 'absolute paths still resolve');
  const w = fx('cd $D && echo x > a.py');
  assert.deepEqual([w.edits, w.hidden[0]], [[[null, 'unknown']], true], 'a relative write target is unknown');
});

// ---- redirects ----

test('redirect rules', () => {
  assert.deepEqual(fx('echo x > src/a.py'), { category: 'edit', requests: [], edits: [['src/a.py', 'source']], hidden: [false, false] });
  assert.deepEqual(fx('echo x >> notes.md').edits, [['notes.md', 'other']]);
  assert.equal(fx('echo x >> notes.md').category, 'edit', 'any edit inside the workspace makes an edit call');
  assert.deepEqual(fx('cat > tests/test_x.py << EOF\nx = 1\nEOF').edits, [['tests/test_x.py', 'test']]);
  assert.deepEqual(fx('python3 x.py > repro_out.txt').edits, [['repro_out.txt', 'scratch']]);
  assert.equal(fx('python3 x.py > repro_out.txt').category, 'edit', 'edit outranks run');
  assert.deepEqual(fx('echo x > /tmp/out'), { category: 'other', requests: [], edits: [['/tmp/out', 'outside']], hidden: [false, false] });
  for (const cmd of ['ls 2>&1 | head', 'echo x > /dev/null', 'echo x &> /dev/null', 'echo x 2>/dev/null', 'cat <<< "y"', 'ls >&2']) {
    assert.deepEqual(fx(cmd).edits, [], `${cmd}: no write`);
  }
  assert.deepEqual(fx('cat < a.py'), { category: 'request', requests: [['a.py', 'unlocated']], edits: [], hidden: [false, false] }, '< reads a file with unknown lines');
  for (const cmd of ['echo x > "$OUT"', 'echo x > *.py', 'echo x > /workspace']) {
    const r = fx(cmd);
    assert.deepEqual(r.edits, [[null, 'unknown']], `${cmd}: edit with unknown target`);
    assert.equal(r.hidden[0], true, `${cmd}: hidden edit`);
  }
});

// ---- dynamic, glob, group and exec ----

test('a dynamic or glob program word, or a group, makes the segment unknown', () => {
  for (const cmd of ['$PY x.py', '*.sh', '{ cat a.py; }', '(cd pkg; cat a.py)']) {
    const r = fx(cmd);
    assert.deepEqual([r.category, r.requests, r.hidden], ['unknown', [], [true, true]], cmd);
  }
});

test('dynamic or glob file operands are not recorded and set hidden request', () => {
  const r = fx('cat $F rich/a.py *.py');
  assert.deepEqual(r.requests, [['rich/a.py', 'open', 1]]);
  assert.equal(r.hidden[1], true);
  assert.equal(r.hidden[0], false, 'reading never sets hidden edit');
  assert.deepEqual(fx('grep -n "class JupyterMixin" rich/*.py').hidden, [false, true], 'rich-3480 log line 82');
});

test('exec keeps the category, sets both hidden flags and keeps no effects from the segment', () => {
  const a = fx('cat $(ls)');
  assert.deepEqual([a.category, a.requests, a.hidden], ['request', [], [true, true]]);
  const b = fx('echo $(date) > src/a.py');
  assert.deepEqual([b.edits, b.hidden], [[], [true, true]]);
  const c = fx('cat a.py; diff <(ls) b');
  assert.deepEqual(c.requests, [['a.py', 'open', 1]], 'other segments keep their effects');
});

// ---- precedence ----

test('call category is the highest among segments', () => {
  const cases = [
    ['cat a.py; echo x > src/b.py; python3 t.py; pytest', 'edit'],
    ['cat a.py && pytest', 'test'],
    ['python3 x && make', 'run'],
    ['make; cat a.py', 'unknown'],
    ['cat a.py; ls', 'request'],
    ['ls; git log', 'search'],
    ['git log; echo', 'vcs'],
    ['echo; true', 'other'],
  ];
  for (const [cmd, category] of cases) assert.equal(fx(cmd).category, category, `${cmd} is ${category}`);
});

// ---- truncation ----

test('a truncated command keeps only segments that ended before the cut', () => {
  const t = (cmd) => {
    const e = bash(cmd, { cmd_truncated: true });
    return { category: e.category, requests: reqs(e), edits: edits(e), hidden: flags(e) };
  };
  assert.deepEqual(t('cat a.py; cat b.py'), { category: 'request', requests: [['a.py', 'open', 1]], edits: [], hidden: [true, true] },
    'b.py may be cut short, so only a.py counts');
  assert.deepEqual(t('cat a.py rich/b'), { category: 'request', requests: [], edits: [], hidden: [true, true] },
    'the cut segment gives only its category, because "cat" was followed by a space');
  assert.equal(t('pyth').category, 'unknown', 'a cut program word gives no category; the call is unknown');
  assert.deepEqual(t('echo x > src/a').edits, [], 'a redirect in the cut segment adds nothing');
  assert.deepEqual(t("cd /workspace && python3 << 'EOF'\nimport os"), { category: 'run', requests: [], edits: [], hidden: [true, true] });
});

test('truncated-cmd.jsonl per log line', () => {
  const p = parse(readFileSync(new URL('./fixtures/truncated-cmd.jsonl', import.meta.url), 'utf8'));
  const got = p.calls.map((c) => {
    const e = classify(c);
    return [c.n, e.category, reqs(e), flags(e)];
  });
  assert.deepEqual(got, [
    [1, 'run', [['rich/a.py', 'open', 1]], [true, true]],
    [2, 'request', [], [true, true]],
    [3, 'request', [['rich/a.py', 'open', 1]], [true, true]],
    [4, 'request', [['rich/a.py', 'open', 1]], [false, false]],
    [5, 'search', [], [false, false]],
  ], 'line 1: cat complete, python3 heredoc complete; 2: cut cat; 3: cut by length after "cat rich/a.py;"; 4: not cut; 5: ls');
});

test('blocked.jsonl: categories per log line', () => {
  const p = parse(readFileSync(new URL('./fixtures/blocked.jsonl', import.meta.url), 'utf8'));
  assert.deepEqual(p.calls.map((c) => classify(c).category), ['search', 'blocked', 'blocked', 'request'],
    'log line 3 would write rich/b.py but allow is false');
  assert.deepEqual(classify(p.calls[2]).edits, []);
});

// ---- pinned from the samples ----

const sample = (name) => parse(readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8'));

test('requests-6644: calls before log line 46 that could change files, and the edit attempt on log line 46', () => {
  const p = sample('requests-6644.events.jsonl');
  const before = p.calls.filter((c) => c.n < 46);
  const hidden = before.filter((c) => {
    const e = classify(c);
    return e.hiddenEdit || e.edits.some((x) => x.cls === 'unknown');
  }).map((c) => c.n);
  assert.deepEqual(hidden, [4, 8, 21, 32, 33, 34, 35, 36, 39, 40, 41, 42, 44],
    'design.md sample table: xargs (4, 8, 21), python3 -c (32), truncated heredocs (33 to 35, 39, 40, 44), find -exec (36), pytest (41, 42)');
  assert.ok(before.every((c) => classify(c).edits.every((x) => x.cls !== 'source')), 'no source edit attempt before log line 46');
  assert.deepEqual(edits(classify(p.calls[45])), [['src/requests/models.py', 'source']], 'log line 46 is str_replace on models.py');
  assert.deepEqual(reqs(classify(p.calls[19])), [['src/requests/models.py', 'range', 81, 100]], 'log line 20: offset 80, limit 20');
  assert.deepEqual(reqs(classify(p.calls[44])), [['src/requests/models.py', 'range', 81, 105]], 'log line 45: offset 80, limit 25');
  assert.deepEqual(reqs(classify(p.lines[66].call)), [['src/requests/models.py', 'range', 81, 110]], 'log line 67: offset 80, limit 30');
});

test('rich-3506 log lines 41 and 42 do not overlap; rich-3480 log line 80 is unlocated', () => {
  const a = sample('rich-3506.events.jsonl');
  assert.deepEqual(reqs(classify(a.lines[40].call)), [['rich/segment.py', 'range', 531, 630]], 'log line 41: offset 530, limit 100');
  assert.deepEqual(reqs(classify(a.lines[41].call)), [['rich/segment.py', 'range', 631, 680]], 'log line 42: offset 630, limit 50');
  const b = sample('rich-3480.events.jsonl');
  assert.deepEqual(reqs(classify(b.lines[79].call)), [['tests/test_text.py', 'unlocated']], 'log line 80: tail -50 tests/test_text.py');
  assert.equal(classify(b.lines[1].call).category, 'blocked', 'log line 2 is blocked');
  assert.equal(classify(b.lines[36].call).category, 'blocked', 'log line 37 is blocked');
});
