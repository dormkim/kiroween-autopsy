// Tests for recorder/session-autopsy-record.mjs, the preToolUse hook a user copies into a project.
// Run: node test/recorder.test.mjs
//
// This file runs WITHOUT the permission model (steering tech.md, the one exception):
// - it must run the real recorder the way Kiro does, as a child process with stdin, exit code
//   and stderr. That needs child processes, and --allow-child-process lifts the model for the
//   child anyway;
// - it must create files, symlinks and hard links, and Node's permission model follows symlinks
//   outside the granted paths, so it would not be a real fence for these cases.
//
// What this file does to the machine: it works only inside fresh fs.mkdtemp directories under
// os.tmpdir(), deletes nothing (the directories are left for inspection), uses no network, and
// gives every child a minimal environment: a fake HOME inside its temporary directory and one
// canary variable. Cases that need a non-root user are skipped when run as root.
//
// Expected values come from requirements R13 and design.md "Recorder", never from the recorder.
// These tests were written before the recorder and must not be weakened to make it pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/core/parse.js';
import { gen, rng, seedFromEnv } from './gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'recorder', 'session-autopsy-record.mjs');
const OUT = '/outside-workspace';
const WS = '/workspace';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const POSIX = { skip: process.platform === 'win32' ? 'the recorder tests need POSIX symlinks, hard links and modes' : false };
const NOT_ROOT = { skip: POSIX.skip || (IS_ROOT ? 'root ignores file modes and could write to /' : false) };

const FAIL_RE = /^session-autopsy-recorder: RECORDING FAILED \(([a-z_]+)\)\n$/;
const CODES = new Set([
  'input_too_large', 'input_invalid', 'session_id_invalid', 'cwd_mismatch', 'project_unsafe',
  'log_dir_unsafe', 'log_file_unsafe', 'write_failed', 'mode_unknown', 'internal',
]);
const OK_LINE = 'session-autopsy-recorder: OK\n';
const failLine = (code) => `session-autopsy-recorder: RECORDING FAILED (${code})\n`;
const instruction = (code) => 'Session Autopsy recorder: recording of this session failed '
  + `(${code}), so its log is incomplete. Begin your reply with this exact line: `
  + `Session Autopsy recorder: RECORDING FAILED (${code})\n`;

// Session ids in the shapes measured on Kiro CLI 3.5.0 (BUILD_LOG.md, Phase 2).
const V2_SID = '91a611b9-9cac-4500-89c8-770a1eea83a3';
const V3_SID = 'sess_6bbc52e5-67ef-4b88-85fb-65075b77e80a';

// Canaries: none of these may appear in any log, failure file, file name, stdout or stderr.
const C = {
  content: 'CANARY-CONTENT-q7k2',
  old: 'CANARY-OLDSTR-m3p9',
  new: 'CANARY-NEWSTR-x8r1',
  output: 'CANARY-TOOL-OUTPUT-b5n4',
  prompt: 'CANARY-PROMPT-h2w6',
  purpose: 'CANARY-PURPOSE-z1c8',
  command: 'CANARY-COMMAND-v4t3',
  fieldName: 'CANARYFIELDNAME_j6s5',
  fieldValue: 'CANARY-FIELD-VALUE-d9e2',
  tool: 'CANARY_TOOL_NAME_f3g7',
  mode: 'CANARYMODE_y5u1',
  writeCommand: 'CANARYWRITECMD_a2l8',
  pattern: 'CANARY-PATTERN-o6i4',
  outside: 'CANARY-OUTSIDE-NAME-k1j9',
  sibling: 'CANARY-SIBLING-NAME-w7q3',
  env: 'CANARY-ENV-VALUE-r8m2',
  home: 'CANARYHOME_t4b6',
  modeArg: 'CANARY-MODE-ARG-p3n5',
  session: 'CANARY-SESSION-e9v7',
};
const VICTIM_TEXT = 'victim file, must stay unchanged\n';

/**
 * A fresh sandbox under os.tmpdir(). Layout, all real directories:
 *   <root>/house-CANARYHOME.../        fake HOME for the child
 *   <root>/house-.../<name>/           the project (a.py, src/m.py, numbered.txt)
 *   <root>/house-.../<name>-evil/      sibling whose name starts with the project's name
 *   <root>/victim/secret.txt           target of the symlink and hard-link attacks
 * Nothing is ever deleted.
 */
const sandbox = (name = 'my-app') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'session-autopsy-recorder-')));
  const home = join(root, `house-${C.home}`);
  const project = join(home, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'a.py'), 'old\n');
  writeFileSync(join(project, 'src', 'm.py'), 'x = 1\n');
  writeFileSync(join(project, 'numbered.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n');
  const sibling = `${project}-evil`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, `${C.sibling}.txt`), 'sibling\n');
  const victim = join(root, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'secret.txt'), VICTIM_TEXT);
  return { root, home, project, name, sibling, victim, logDir: join(project, '.session-autopsy') };
};

const logPath = (box, sid) => join(box.logDir, `${sid}.events.jsonl`);
const failurePath = (box) => join(box.logDir, 'recording-failures.jsonl');
const toSlash = (p) => p.split(sep).join('/');

/** Every entry under dir, without following symlinks: kind, mode or link target, content. */
const snapshot = (dir) => {
  const out = new Map();
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const rel = toSlash(relative(dir, p));
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.set(rel, `dir:${(st.mode & 0o777).toString(8)}`);
        walk(p);
      } else if (st.isFile()) out.set(rel, `file:${st.nlink}:${readFileSync(p).toString('base64')}`);
      else out.set(rel, `other:${st.mode}`);
    }
  };
  walk(dir);
  return out;
};

const changes = (before, after) => {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
};

const logRel = (box) => toSlash(relative(box.root, box.logDir));
const inLogDir = (box, key) => key === logRel(box) || key.startsWith(`${logRel(box)}/`);

/** Asserts that nothing changed under the sandbox except inside <project>/.session-autopsy/. */
const assertOnlyLogDirChanged = (box, before, what) => {
  const outside = changes(before, snapshot(box.root)).filter((k) => !inLogDir(box, k));
  assert.deepEqual(outside, [], `${what}: the recorder may write only inside <project>/.session-autopsy/ (R13.11); changed elsewhere: ${outside.join(', ')}`);
};

/** Asserts that nothing at all changed under the sandbox. */
const assertNothingChanged = (box, before, what) => {
  const changed = changes(before, snapshot(box.root));
  assert.deepEqual(changed, [], `${what}: this must write no file at all; changed: ${changed.join(', ')}`);
};

const assertVictim = (box, what) => {
  assert.deepEqual(readdirSync(box.victim).sort(), ['secret.txt'], `${what}: nothing may be created next to the victim file`);
  assert.equal(readFileSync(join(box.victim, 'secret.txt'), 'utf8'), VICTIM_TEXT, `${what}: the victim file must keep its content`);
  assert.equal(statSync(join(box.victim, 'secret.txt')).size, Buffer.byteLength(VICTIM_TEXT), `${what}: the victim file must keep its size`);
};

const leakNeedles = (box) => [...Object.values(C), box.root, box.home, box.project, `house-${C.home}`];

/**
 * Searches every name and file content inside the log directory, and both streams of every
 * result, for each canary, the sandbox root, the home and the project's absolute path (P22).
 */
const assertNoLeak = (box, results, what) => {
  const hay = [];
  for (const r of results) hay.push(['stdout', r.stdout], ['stderr', r.stderr]);
  const rel = logRel(box);
  for (const [key, value] of snapshot(box.root)) {
    if (!inLogDir(box, key)) continue;
    const name = key.slice(rel.length);
    hay.push([`the file name ${JSON.stringify(name)}`, name]);
    if (value.startsWith('file:')) hay.push([`the file ${JSON.stringify(name)}`, Buffer.from(value.split(':')[2], 'base64').toString('utf8')]);
  }
  for (const needle of leakNeedles(box)) {
    for (const [where, text] of hay) {
      assert.ok(!text.includes(needle), `${what}: ${JSON.stringify(needle)} must not appear in ${where} (R13.8, P22)`);
    }
  }
};

/**
 * Runs the recorder as Kiro does: node <script> [args], stdin, exit code, both streams.
 * keepOpen leaves stdin open, so a mode that waits for stdin hits the timeout.
 */
const run = (box, args, { input = '', cwd = box.project, keepOpen = false, timeout = 30000 } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { HOME: box.home, SESSION_AUTOPSY_TEST_CANARY: C.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`the recorder did not exit within ${timeout} ms (args ${JSON.stringify(args)}); the check modes must never wait for stdin (R13.14, R13.15)`));
  }, timeout);
  child.on('error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    child.stdin.destroy();
    resolveRun({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
  });
  if (keepOpen) child.stdin.write(input);
  else child.stdin.end(input);
});

const record = (box, event, opts = {}) => run(box, [], {
  input: typeof event === 'string' || Buffer.isBuffer(event) ? event : JSON.stringify(event),
  ...opts,
});

const v2 = (box, toolName, toolInput, extra = {}) => ({
  hook_event_name: 'preToolUse', cwd: box.project, session_id: V2_SID, tool_name: toolName, tool_tags: [], tool_input: toolInput, ...extra,
});
const v3 = (box, toolName, toolInput, extra = {}) => ({
  session_id: V3_SID, hook_event_name: 'preToolUse', cwd: box.project, tool_name: toolName, tool_input: toolInput, ...extra,
});

const assertOk = (r, what) => {
  assert.equal(r.signal, null, `${what}: the recorder must exit by itself, not by a signal`);
  assert.equal(r.code, 0, `${what}: a recorded call exits 0; got ${r.code}, stderr ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, '', `${what}: record mode prints nothing on stdout`);
  assert.equal(r.stderr, '', `${what}: record mode prints nothing on stderr when it works`);
};

/** code null accepts any known failure code. */
const assertFailed = (r, code, what) => {
  assert.equal(r.signal, null, `${what}: the recorder must exit by itself, not by a signal`);
  assert.notEqual(r.code, 2, `${what}: exit 2 would block the tool; a failure must never block (R13.13)`);
  assert.equal(r.code, 1, `${what}: a failure exits 1; got ${r.code}, stderr ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, '', `${what}: record mode prints nothing on stdout, also on failure`);
  const m = FAIL_RE.exec(r.stderr);
  assert.ok(m, `${what}: stderr must be exactly one line "session-autopsy-recorder: RECORDING FAILED (<code>)", got ${JSON.stringify(r.stderr)}`);
  assert.ok(CODES.has(m[1]), `${what}: ${m[1]} is not one of the failure codes in design.md`);
  if (code !== null) assert.equal(m[1], code, `${what}: expected failure code ${code}`);
};

/** The parsed lines of a log file, which must end with a newline. */
const readLog = (box, sid) => {
  const text = readFileSync(logPath(box, sid), 'utf8');
  assert.ok(text.endsWith('\n'), 'every log line is complete, so the file ends with a newline');
  return text.slice(0, -1).split('\n').map((l) => JSON.parse(l));
};

/** Exactly these fields besides t (allow-list). deepEqual is strict about extra keys. */
const assertLine = (line, expected, what) => {
  assert.equal(typeof line.t, 'number', `${what}: t is a number of epoch seconds`);
  assert.ok(Number.isFinite(line.t), `${what}: t is finite`);
  const { t, ...rest } = line;
  assert.deepEqual(rest, { hook: 'pre', ...expected }, `${what}: the line must hold exactly these fields (R13.2, R13.8)`);
};

/** Records one event, expects exit 0 and exactly one new line equal to expected. */
const recordOne = async (box, event, expected, what) => {
  const before = snapshot(box.root);
  const sid = event.session_id;
  const prev = existsSync(logPath(box, sid)) ? readLog(box, sid).length : 0;
  const t0 = Date.now() / 1000;
  const r = await record(box, event);
  const t1 = Date.now() / 1000;
  assertOk(r, what);
  assertOnlyLogDirChanged(box, before, what);
  const lines = readLog(box, sid);
  assert.equal(lines.length, prev + 1, `${what}: exactly one line per tool call (R13.2)`);
  const line = lines[lines.length - 1];
  assert.ok(line.t >= t0 - 0.01 && line.t <= t1 + 0.01, `${what}: t is Date.now()/1000 taken during the run, got ${line.t}, run between ${t0} and ${t1} (R13.12)`);
  assertLine(line, expected, what);
  return { line, result: r };
};

/** Records a failing event, expects the failure, nothing outside the log directory, no event log. */
const recordFails = async (box, event, code, what, sid = null) => {
  const before = snapshot(box.root);
  const r = await record(box, event);
  assertFailed(r, code, what);
  assertOnlyLogDirChanged(box, before, what);
  if (sid !== null) assert.ok(!existsSync(logPath(box, sid)), `${what}: no event line is written on failure`);
  return r;
};

// ---- the script itself ----

/** Source without comments, so the header may describe what the code never does. */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('the recorder is one file using only allowed node: built-ins, with no network, child process or dynamic code (R13.1)', POSIX, () => {
  assert.ok(existsSync(SCRIPT), 'recorder/session-autopsy-record.mjs must exist (R13.1)');
  const code = codeOf(readFileSync(SCRIPT, 'utf8'));
  const specs = [...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  const allowed = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:process', 'node:buffer']);
  for (const s of specs) assert.ok(allowed.has(s), `import ${JSON.stringify(s)} is not allowed; only ${[...allowed].join(', ')} (R13.1)`);
  const banned = [
    [/\bimport\s*\(/, 'dynamic import()'],
    [/\brequire\s*\(/, 'require()'],
    [/child_process|worker_threads|node:(?:net|http|https|http2|dgram|tls|dns|vm|inspector|cluster)\b/, 'a network, process or vm module'],
    [/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/, 'a network call'],
    [/process\s*\.\s*env\b/, 'process.env (no environment read or dump)'],
    [/(?<![\w$.])eval\s*\(|\bnew\s+Function\b/, 'dynamic code'],
    [/['"]allow['"]\s*:|\ballow\s*:/, 'an allow field: preToolUse cannot know it (R13.7)'],
    [/\bexit(?:Code)?\s*(?:=|\()\s*2\b/, 'exit 2, which would block the tool (R13.13)'],
  ];
  for (const [re, label] of banned) assert.ok(!re.test(code), `the recorder must not contain ${label}`);
  for (const flag of ['O_APPEND', 'O_CREAT', 'O_NOFOLLOW', 'O_NONBLOCK']) {
    assert.ok(code.includes(flag), `the log file is opened with ${flag} (R13.11)`);
  }
  assert.ok(/\bchdir\s*\(/.test(code), 'the recorder changes into the log directory before opening a bare name (R13.11)');
  assert.ok(/\bfstat(?:Sync)?\s*\(/.test(code), 'the opened file is checked with fstat (R13.11)');
});

// ---- measured shapes ----

test('V2 shapes measured on Kiro CLI 3.5.0 become the documented lines (R13.2 to R13.6)', POSIX, async () => {
  const box = sandbox();
  const cases = [
    ['read with offset 2 and limit 3', 'read', { operations: [{ mode: 'Line', path: 'numbered.txt', offset: 2, limit: 3 }] },
      { tool: 'read_file', paths: ['numbered.txt'], range: { offset: 2, limit: 3 } }],
    ['read with only limit 2', 'read', { operations: [{ mode: 'Line', path: 'numbered.txt', limit: 2 }] },
      { tool: 'read_file', paths: ['numbered.txt'], range: { limit: 2 } }],
    ['read of a whole file', 'read', { operations: [{ mode: 'Line', path: 'numbered.txt' }] },
      { tool: 'read_file', paths: ['numbered.txt'], range: {} }],
    ['read with null offset and limit', 'read', { operations: [{ mode: 'Line', path: 'a.py', offset: null, limit: null }] },
      { tool: 'read_file', paths: ['a.py'], range: {} }],
    ['read with offset 0', 'read', { operations: [{ mode: 'Line', path: 'a.py', offset: 0, limit: 1 }] },
      { tool: 'read_file', paths: ['a.py'], range: { offset: 0, limit: 1 } }],
    ['one read call with two operations', 'read', { operations: [{ mode: 'Line', path: 'a.py' }, { mode: 'Line', path: 'numbered.txt', offset: 1, limit: 2 }] },
      { tool: 'read_file', paths: ['a.py', 'numbered.txt'], ranges: [{}, { offset: 1, limit: 2 }] }],
    ['one read call with three operations, one outside', 'read', { operations: [{ mode: 'Line', path: 'src/m.py', offset: 4 }, { mode: 'Line', path: '../outside.txt' }, { mode: 'Line', path: 'a.py', limit: 9 }] },
      { tool: 'read_file', paths: ['src/m.py', OUT, 'a.py'], ranges: [{ offset: 4 }, {}, { limit: 9 }] }],
    // Seen in a real probe: one read call with six files and a directory. Directory operations
    // have no file effect, so they are dropped and the Line operations stay, in order.
    ['one read call with six files and a directory', 'read', { operations: [
      { mode: 'Line', path: 'a.py' },
      { mode: 'Line', path: 'numbered.txt', offset: 2, limit: 3 },
      { mode: 'Line', path: 'src/m.py', limit: 4 },
      { mode: 'Directory', path: 'src' },
      { mode: 'Line', path: '../outside.txt' },
      { mode: 'Line', path: 'new/f.py', offset: 0 },
      { mode: 'Line', path: '.', offset: 5, limit: 1 },
    ] },
    { tool: 'read_file', paths: ['a.py', 'numbered.txt', 'src/m.py', OUT, 'new/f.py', WS], ranges: [{}, { offset: 2, limit: 3 }, { limit: 4 }, {}, { offset: 0 }, { offset: 5, limit: 1 }] }],
    ['one Line and one Directory operation', 'read', { operations: [{ mode: 'Line', path: 'a.py' }, { mode: 'Directory', path: '.' }] },
      { tool: 'read_file', paths: ['a.py'], range: {} }],
    ['a Directory operation before one Line operation', 'read', { operations: [{ mode: 'Directory', path: 'src' }, { mode: 'Line', path: 'numbered.txt', offset: 1, limit: 2 }] },
      { tool: 'read_file', paths: ['numbered.txt'], range: { offset: 1, limit: 2 } }],
    ['two Directory operations around two Line operations', 'read', { operations: [{ mode: 'Directory', path: '.' }, { mode: 'Line', path: 'a.py', limit: 1 }, { mode: 'Line', path: 'src/m.py' }, { mode: 'Directory', path: 'src' }] },
      { tool: 'read_file', paths: ['a.py', 'src/m.py'], ranges: [{ limit: 1 }, {}] }],
    ['list two directories in one call', 'read', { operations: [{ mode: 'Directory', path: '.' }, { mode: 'Directory', path: 'src' }] },
      { tool: 'list_directory', paths: [WS, 'src'] }],
    ['list the directory .', 'read', { operations: [{ mode: 'Directory', path: '.' }] },
      { tool: 'list_directory', paths: [WS] }],
    ['list the directory src', 'read', { operations: [{ mode: 'Directory', path: 'src' }] },
      { tool: 'list_directory', paths: ['src'] }],
    ['create b.py', 'write', { command: 'create', path: 'b.py', content: C.content },
      { tool: 'str_replace', paths: ['b.py'] }],
    ['strReplace in a.py', 'write', { command: 'strReplace', path: 'a.py', oldStr: C.old, newStr: C.new },
      { tool: 'str_replace', paths: ['a.py'] }],
    ['insert into a.py', 'write', { command: 'insert', path: 'a.py', insert_line: 1, newStr: C.new },
      { tool: 'str_replace', paths: ['a.py'] }],
    ['read ../outside.txt', 'read', { operations: [{ mode: 'Line', path: '../outside.txt' }] },
      { tool: 'read_file', paths: [OUT], range: {} }],
    ['create ../outside-new.txt', 'write', { command: 'create', path: '../outside-new.txt', content: C.content },
      { tool: 'str_replace', paths: [OUT] }],
    ['fs_read, the older name of read', 'fs_read', { operations: [{ mode: 'Line', path: 'a.py', offset: 3, limit: 4 }] },
      { tool: 'read_file', paths: ['a.py'], range: { offset: 3, limit: 4 } }],
    ['fs_write, the older name of write', 'fs_write', { command: 'create', path: 'c.py', content: C.content },
      { tool: 'str_replace', paths: ['c.py'] }],
  ];
  for (const [what, name, input, expected] of cases) {
    await recordOne(box, v2(box, name, { ...input, __tool_use_purpose: C.purpose }), expected, `V2 ${what}`);
  }
  const text = readFileSync(logPath(box, V2_SID), 'utf8');
  const parsed = parse(text);
  assert.equal(parsed.broken.length, 0, 'the page parses every recorder line');
  assert.equal(parsed.calls.length, cases.length, 'one call per recorded tool call');
  assert.ok(parsed.calls.every((c) => c.allow === null), 'no line carries allow (R13.7)');
  assert.ok(!existsSync(join(box.project, 'b.py')) && !existsSync(join(box.project, 'c.py')), 'the recorder only logs; it never performs the write');
  assertNoLeak(box, [], 'V2 shapes');
});

test('V3 shapes measured on Kiro CLI 3.5.0 become the documented lines (R13.2 to R13.6)', POSIX, async () => {
  const box = sandbox();
  const cases = [
    ['read_file with offset 2 and limit 3', 'read_file', { path: 'numbered.txt', offset: 2, limit: 3 },
      { tool: 'read_file', paths: ['numbered.txt'], range: { offset: 2, limit: 3 } }],
    ['read_file with null offset and limit', 'read_file', { path: 'a.py', offset: null, limit: null },
      { tool: 'read_file', paths: ['a.py'], range: {} }],
    ['read_file with only a limit', 'read_file', { path: 'a.py', offset: null, limit: 5 },
      { tool: 'read_file', paths: ['a.py'], range: { limit: 5 } }],
    ['read_file with only an offset', 'read_file', { path: 'a.py', offset: 7, limit: null },
      { tool: 'read_file', paths: ['a.py'], range: { offset: 7 } }],
    ['read_file ../outside.txt', 'read_file', { path: '../outside.txt', offset: null, limit: null },
      { tool: 'read_file', paths: [OUT], range: {} }],
    ['fs_write create', 'fs_write', { path: 'b.py', text: C.content },
      { tool: 'str_replace', paths: ['b.py'] }],
    ['fs_write ../outside-v3.txt', 'fs_write', { path: '../outside-v3.txt', text: C.content },
      { tool: 'str_replace', paths: [OUT] }],
    ['str_replace', 'str_replace', { path: 'a.py', oldStr: C.old, newStr: C.new, replace_all: false },
      { tool: 'str_replace', paths: ['a.py'] }],
    ['fs_append', 'fs_append', { path: 'a.py', text: C.content },
      { tool: 'str_replace', paths: ['a.py'] }],
    ['list_directory with a path', 'list_directory', { path: 'src' },
      { tool: 'list_directory', paths: ['src'] }],
    ['list_directory without a path', 'list_directory', {},
      { tool: 'list_directory' }],
    ['grep_search', 'grep_search', { pattern: C.pattern, path: 'src' }, { tool: 'search' }],
    ['file_search', 'file_search', { pattern: C.pattern, path: '../' }, { tool: 'search' }],
  ];
  for (const [what, name, input, expected] of cases) {
    await recordOne(box, v3(box, name, { ...input, __tool_use_purpose: C.purpose }), expected, `V3 ${what}`);
  }
  const parsed = parse(readFileSync(logPath(box, V3_SID), 'utf8'));
  assert.equal(parsed.broken.length, 0, 'the page parses every recorder line');
  assert.equal(parsed.calls.length, cases.length, 'one call per recorded tool call');
  assertNoLeak(box, [], 'V3 shapes');
});

test('shell tools become execute_bash with no command, cwd or path, on both engines (R13.4)', POSIX, async () => {
  const box = sandbox();
  for (const name of ['shell', 'execute_bash', 'execute_cmd', 'controlBashProcess']) {
    const input = { command: `cat ${C.command} > /etc/${C.outside}`, cwd: '/etc', working_dir: box.home, __tool_use_purpose: C.purpose };
    await recordOne(box, v2(box, name, input), { tool: 'execute_bash' }, `V2 ${name}`);
    await recordOne(box, v3(box, name, input), { tool: 'execute_bash' }, `V3 ${name}`);
  }
  assertNoLeak(box, [], 'shell tools');
});

test('unknown tool names and unknown shapes become unknown_tool, never a copied name (R13.3)', POSIX, async () => {
  const box = sandbox();
  const unknownNames = [C.tool, 'web_fetch', 'use_aws', 'READ', 'read ', ' read_file', 'Read_File', 'execute_bash\n', '', 'read_file\u0000', 'thinking', 'todo_list'];
  for (const name of unknownNames) {
    await recordOne(box, v3(box, name, { path: 'a.py' }), { tool: 'unknown_tool' }, `tool name ${JSON.stringify(name)}`);
  }
  for (const name of [123, null, true, ['read'], { name: 'read' }]) {
    await recordOne(box, v3(box, name, { path: 'a.py' }), { tool: 'unknown_tool' }, `tool name of type ${typeof name}`);
  }
  const shapes = [
    ['V2 read without operations', 'read', {}],
    ['V2 read with empty operations', 'read', { operations: [] }],
    ['V2 read with operations not an array', 'read', { operations: { mode: 'Line', path: 'a.py' } }],
    ['V2 read with an operation that is a string', 'read', { operations: ['a.py'] }],
    ['V2 read with a null operation', 'read', { operations: [null] }],
    ['V2 read with Line and Image', 'read', { operations: [{ mode: 'Line', path: 'a.py' }, { mode: 'Image', image_paths: ['x.png'] }] }],
    ['V2 read with Line, Directory and an unknown mode', 'read', { operations: [{ mode: 'Line', path: 'a.py' }, { mode: 'Directory', path: '.' }, { mode: C.mode, path: 'src/m.py' }] }],
    ['V2 read with Directory and no mode', 'read', { operations: [{ mode: 'Directory', path: '.' }, { path: 'a.py' }] }],
    ['V2 read with Line and a Directory without a path', 'read', { operations: [{ mode: 'Line', path: 'a.py' }, { mode: 'Directory' }] }],
    ['V2 read with Directory and a Line with a bad offset', 'read', { operations: [{ mode: 'Directory', path: '.' }, { mode: 'Line', path: 'a.py', offset: -1 }] }],
    ['V2 read in Image mode', 'read', { operations: [{ mode: 'Image', image_paths: ['x.png'] }] }],
    ['V2 read in an unknown mode', 'read', { operations: [{ mode: C.mode, path: 'a.py' }] }],
    ['V2 read with no mode', 'read', { operations: [{ path: 'a.py' }] }],
    ['V2 read with a path that is a number', 'read', { operations: [{ mode: 'Line', path: 42 }] }],
    ['V2 read with no path', 'read', { operations: [{ mode: 'Line' }] }],
    ['V2 write with an unknown command', 'write', { command: C.writeCommand, path: 'a.py' }],
    ['V2 write without a command', 'write', { path: 'a.py', content: C.content }],
    ['V2 write with a path that is not a string', 'write', { command: 'create', path: ['a.py'] }],
    ['V3 read_file with no path', 'read_file', { offset: null, limit: null }],
    ['V3 read_file with a path that is an object', 'read_file', { path: { p: 'a.py' } }],
    ['V3 fs_write with no path', 'fs_write', { text: C.content }],
    ['V3 str_replace with a null path', 'str_replace', { path: null }],
    ['tool_input null', 'read_file', null],
    ['tool_input a string', 'read_file', 'a.py'],
    ['tool_input an array', 'read', [{ mode: 'Line', path: 'a.py' }]],
  ];
  for (const [what, name, input] of shapes) {
    await recordOne(box, v3(box, name, input), { tool: 'unknown_tool' }, what);
  }
  const noInput = v3(box, 'read_file', null);
  delete noInput.tool_input;
  await recordOne(box, noInput, { tool: 'unknown_tool' }, 'no tool_input at all');
  assertNoLeak(box, [], 'unknown tools and shapes');
});

test('offset and limit are copied only as safe integers; any other value gives unknown_tool, never a whole-file request (R13.6)', POSIX, async () => {
  const box = sandbox();
  const badOffsets = [-1, 1.5, '2', true, {}, [], 2 ** 53, -0.5];
  const badLimits = [0, -1, 2.5, '3', false, {}, [3], 2 ** 53];
  for (const offset of badOffsets) {
    await recordOne(box, v3(box, 'read_file', { path: 'a.py', offset, limit: 3 }), { tool: 'unknown_tool' }, `V3 offset ${JSON.stringify(offset)}`);
    await recordOne(box, v2(box, 'read', { operations: [{ mode: 'Line', path: 'a.py', offset }] }), { tool: 'unknown_tool' }, `V2 offset ${JSON.stringify(offset)}`);
  }
  for (const limit of badLimits) {
    await recordOne(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit }), { tool: 'unknown_tool' }, `V3 limit ${JSON.stringify(limit)}`);
    await recordOne(box, v2(box, 'read', { operations: [{ mode: 'Line', path: 'a.py', limit }] }), { tool: 'unknown_tool' }, `V2 limit ${JSON.stringify(limit)}`);
  }
  await recordOne(box, v2(box, 'read', { operations: [{ mode: 'Line', path: 'a.py', limit: 5 }, { mode: 'Line', path: 'numbered.txt', offset: -3 }] }),
    { tool: 'unknown_tool' }, 'V2 a bad offset in the second of two operations makes the whole call unknown');
  const huge = JSON.stringify(v3(box, 'read_file', { path: 'a.py', offset: 0, limit: 3 })).replace('"offset":0', '"offset":1e400');
  assert.ok(huge.includes('1e400'), 'test setup: the raw JSON holds an offset that parses as Infinity');
  await recordOne(box, v3(box, 'read_file', {}), { tool: 'unknown_tool' }, 'V3 read_file with an empty input');
  const before = readLog(box, V3_SID).length;
  const r = await record(box, huge);
  assertOk(r, 'offset 1e400 (Infinity)');
  const lines = readLog(box, V3_SID);
  assert.equal(lines.length, before + 1, 'offset 1e400: one line');
  assertLine(lines[lines.length - 1], { tool: 'unknown_tool' }, 'offset 1e400 is not a safe integer');
});

test('a line above 16 KiB is written as unknown_tool, complete, never cut (R13.11)', POSIX, async () => {
  const box = sandbox();
  const longName = (i) => `big${i}/${'d'.repeat(250)}/${'e'.repeat(250)}/${'f'.repeat(250)}/${'g'.repeat(240)}.py`;
  const ops = Array.from({ length: 20 }, (_, i) => ({ mode: 'Line', path: longName(i), offset: i, limit: 1 }));
  assert.ok(ops.every((o) => o.path.length <= 1024), 'test setup: every path is at most 1024 characters, so each one alone is recorded');
  await recordOne(box, v2(box, 'read', { operations: ops }), { tool: 'unknown_tool' }, 'twenty 1000-character paths');
  const text = readFileSync(logPath(box, V2_SID), 'utf8');
  assert.ok(Buffer.byteLength(text) <= 16 * 1024, 'the written line is at most 16 KiB');
  const small = ops.slice(0, 3);
  await recordOne(box, v2(box, 'read', { operations: small }),
    { tool: 'read_file', paths: small.map((o) => o.path), ranges: small.map((o) => ({ offset: o.offset, limit: 1 })) }, 'three 1000-character paths fit');
});

// ---- privacy ----

test('no content, text, output, prompt, purpose, command, unknown field, tool name, mode, outside name, home, project path or environment value reaches any output (R13.8, P22)', POSIX, async () => {
  const box = sandbox();
  const extra = {
    prompt: C.prompt,
    tool_response: { output: C.output, success: true },
    [C.fieldName]: C.fieldValue,
    nested: { [C.fieldName]: [C.fieldValue] },
  };
  const results = [];
  const go = async (event, expected, what) => results.push((await recordOne(box, { ...event, ...extra }, expected, what)).result);
  const purpose = { __tool_use_purpose: C.purpose, [C.fieldName]: C.fieldValue };
  await go(v2(box, 'write', { command: 'create', path: 'b.py', content: C.content, ...purpose }), { tool: 'str_replace', paths: ['b.py'] }, 'V2 create with content');
  await go(v2(box, 'write', { command: 'strReplace', path: 'a.py', oldStr: C.old, newStr: C.new, ...purpose }), { tool: 'str_replace', paths: ['a.py'] }, 'V2 strReplace');
  await go(v2(box, 'write', { command: C.writeCommand, path: 'a.py', ...purpose }), { tool: 'unknown_tool' }, 'V2 unknown write command');
  await go(v2(box, 'read', { operations: [{ mode: 'Line', path: 'a.py', [C.fieldName]: C.fieldValue }], ...purpose }), { tool: 'read_file', paths: ['a.py'], range: {} }, 'V2 read with an unknown operation field');
  await go(v2(box, 'read', { operations: [{ mode: C.mode, path: 'a.py' }], ...purpose }), { tool: 'unknown_tool' }, 'V2 read in an unknown mode');
  await go(v2(box, 'read', { operations: [{ mode: 'Directory', path: `/etc/${C.outside}`, [C.fieldName]: C.fieldValue }, { mode: 'Line', path: 'a.py' }], ...purpose }),
    { tool: 'read_file', paths: ['a.py'], range: {} }, 'V2 read whose dropped Directory operation holds an outside name');
  await go(v3(box, 'fs_write', { path: 'b.py', text: C.content, ...purpose }), { tool: 'str_replace', paths: ['b.py'] }, 'V3 fs_write with text');
  await go(v3(box, 'str_replace', { path: 'a.py', oldStr: C.old, newStr: C.new, replace_all: true, ...purpose }), { tool: 'str_replace', paths: ['a.py'] }, 'V3 str_replace');
  await go(v3(box, 'grep_search', { pattern: C.pattern, path: 'src', ...purpose }), { tool: 'search' }, 'V3 grep_search');
  await go(v3(box, 'execute_bash', { command: C.command, ...purpose }), { tool: 'execute_bash' }, 'V3 shell command');
  await go(v2(box, 'shell', { command: C.command, ...purpose }), { tool: 'execute_bash' }, 'V2 shell command');
  await go(v3(box, C.tool, { path: 'a.py', ...purpose }), { tool: 'unknown_tool' }, 'unknown tool name');
  await go(v3(box, 'read_file', { path: `/etc/${C.outside}`, offset: null, limit: null }), { tool: 'read_file', paths: [OUT], range: {} }, 'absolute outside path');
  await go(v3(box, 'read_file', { path: `~/${C.outside}`, offset: null, limit: null }), { tool: 'read_file', paths: [OUT], range: {} }, 'home path outside the project');
  await go(v3(box, 'read_file', { path: join(box.home, C.outside), offset: null, limit: null }), { tool: 'read_file', paths: [OUT], range: {} }, 'absolute home path');
  await go(v3(box, 'fs_write', { path: `../${box.name}-evil/${C.sibling}.txt`, text: C.content }), { tool: 'str_replace', paths: [OUT] }, 'prefix sibling');
  // Failures carry canaries too: none may reach stderr, a file name or the failure file.
  const before = snapshot(box.root);
  const badSid = await record(box, { ...v3(box, 'read_file', { path: 'a.py' }), session_id: `${C.session}.json` });
  assertFailed(badSid, 'session_id_invalid', 'a session_id with a dot');
  const badMode = await run(box, [C.modeArg], { input: JSON.stringify(v3(box, 'read_file', { path: 'a.py' })) });
  assertFailed(badMode, 'mode_unknown', 'an unknown mode argument');
  const badJson = await record(box, `{"session_id":"${V3_SID}","prompt":"${C.prompt}",`);
  assertFailed(badJson, 'input_invalid', 'cut JSON holding a prompt');
  assertOnlyLogDirChanged(box, before, 'failures with canaries');
  results.push(badSid, badMode, badJson);
  assertNoLeak(box, results, 'privacy');
});

// ---- paths ----

/** A relative path inside the project of exactly n characters, segments of at most 100. */
const longPath = (n) => {
  let s = '';
  while (s.length < n) s += `${s === '' ? '' : '/'}${'d'.repeat(100)}`;
  s = s.slice(0, n);
  return s.endsWith('/') ? `${s.slice(0, -1)}e` : s;
};

const PATH_CASES = [
  ['a relative file', () => 'a.py', 'a.py'],
  ['a nested relative file', () => 'src/m.py', 'src/m.py'],
  ['dot segments that stay inside', () => './src/../a.py', 'a.py'],
  ['repeated slashes', () => 'src//m.py', 'src/m.py'],
  ['an absolute path inside', (b) => join(b.project, 'src', 'm.py'), 'src/m.py'],
  ['a file that does not exist yet', () => 'new/deeper/f.py', 'new/deeper/f.py'],
  ['a directory named workspace inside the project', () => 'workspace/x.py', 'workspace/x.py'],
  ['a file named outside-workspace inside the project', () => 'outside-workspace', 'outside-workspace'],
  ['the project itself, relative', () => '.', WS],
  ['the project itself, absolute', (b) => b.project, WS],
  ['the project with a trailing slash', (b) => `${b.project}/`, WS],
  ['the project through ../', (b) => `../${b.name}`, WS],
  ['an empty path', () => '', WS],
  ['a NUL character', () => 'a\u0000.py', WS],
  ['a bell character', () => 'a\u0007.py', WS],
  ['a newline', () => 'src/\nm.py', WS],
  ['a DEL character', () => 'a\u007f.py', WS],
  ['1025 characters', () => longPath(1025), WS],
  ['exactly 1024 characters', () => longPath(1024), longPath(1024)],
  ['~ into the project', (b) => `~/${b.name}/src/m.py`, 'src/m.py'],
  ['~ outside the project', () => `~/${C.outside}.txt`, OUT],
  ['~ alone, the home directory', () => '~', OUT],
  ['~/ alone', () => '~/', OUT],
  ['~user', () => `~${C.outside}/x`, OUT],
  ['../', () => `../${C.outside}`, OUT],
  ['many ../', () => `../../../../../../etc/${C.outside}`, OUT],
  ['an absolute path outside', () => `/etc/${C.outside}`, OUT],
  ['the root directory', () => '/', OUT],
  ['a prefix sibling, absolute', (b) => join(b.sibling, `${C.sibling}.txt`), OUT],
  ['a prefix sibling, relative', (b) => `../${b.name}-evil/${C.sibling}.txt`, OUT],
  ['a prefix sibling that does not exist', (b) => `${b.project}x/${C.outside}`, OUT],
  ['a symlink leading out', (b) => {
    symlinkSync(b.victim, join(b.project, 'link-out'));
    return 'link-out/secret.txt';
  }, OUT],
  ['a missing file under a symlink leading out', (b) => {
    symlinkSync(b.victim, join(b.project, 'link-out'));
    return `link-out/${C.outside}.txt`;
  }, OUT],
  ['a symlinked file leading out', (b) => {
    symlinkSync(join(b.victim, 'secret.txt'), join(b.project, 'file-link.txt'));
    return 'file-link.txt';
  }, OUT],
  ['a symlink leading inside', (b) => {
    symlinkSync(join(b.project, 'src'), join(b.project, 'link-in'));
    return 'link-in/m.py';
  }, 'src/m.py'],
  ['a missing file under a symlink leading inside', (b) => {
    symlinkSync(join(b.project, 'src'), join(b.project, 'link-in'));
    return 'link-in/new.py';
  }, 'src/new.py'],
  ['a dangling symlink', (b) => {
    symlinkSync(join(b.root, `nowhere-${C.outside}`), join(b.project, 'dangle'));
    return 'dangle';
  }, OUT],
  ['a path through a dangling symlink', (b) => {
    symlinkSync(join(b.root, `nowhere-${C.outside}`), join(b.project, 'dangle'));
    return 'dangle/x.py';
  }, OUT],
  ['a dangling symlink whose target would be inside', (b) => {
    symlinkSync(join(b.project, 'not-yet.py'), join(b.project, 'dangle-in.py'));
    return 'dangle-in.py';
  }, OUT],
  ['a symlink loop', (b) => {
    symlinkSync(join(b.project, 'loop-b'), join(b.project, 'loop-a'));
    symlinkSync(join(b.project, 'loop-a'), join(b.project, 'loop-b'));
    return 'loop-a/x.py';
  }, null],
];

test('every path case maps to a project-relative name, /workspace or /outside-workspace, for reads and writes on both engines (R13.9, P23)', POSIX, async () => {
  for (const [what, setup, expected] of PATH_CASES) {
    const box = sandbox();
    const p = setup(box);
    const results = [];
    if (expected === null) {
      // A symlink loop cannot be resolved, so the target is /workspace or /outside-workspace, never a name.
      const before = snapshot(box.root);
      const r = await record(box, v3(box, 'read_file', { path: p, offset: null, limit: null }));
      assertOk(r, what);
      assertOnlyLogDirChanged(box, before, what);
      const lines = readLog(box, V3_SID);
      assert.equal(lines.length, 1, `${what}: one line`);
      const got = Array.isArray(lines[0].paths) ? lines[0].paths[0] : undefined;
      assert.ok(got === WS || got === OUT, `${what}: an unresolvable target is /workspace or /outside-workspace, got ${JSON.stringify(got)}`);
      assertNoLeak(box, [r], what);
      continue;
    }
    const read = await recordOne(box, v3(box, 'read_file', { path: p, offset: null, limit: null }), { tool: 'read_file', paths: [expected], range: {} }, `V3 read of ${what}`);
    results.push(read.result);
    const write = await recordOne(box, v2(box, 'write', { command: 'create', path: p, content: C.content }), { tool: 'str_replace', paths: [expected] }, `V2 create of ${what}`);
    results.push(write.result);
    assertVictim(box, what);
    assertNoLeak(box, results, what);
  }
});

test('a project reached through a symlink records names relative to the real project (R13.9)', POSIX, async () => {
  const box = sandbox();
  const alias = join(box.root, 'alias');
  symlinkSync(box.project, alias);
  const ev = (p) => ({ ...v3(box, 'read_file', { path: p, offset: null, limit: null }), cwd: alias });
  const cases = [
    [join(alias, 'src', 'm.py'), 'src/m.py'],
    ['a.py', 'a.py'],
    [join(box.project, 'a.py'), 'a.py'],
    [alias, WS],
    [join(box.root, 'victim', 'secret.txt'), OUT],
    [join(alias, '..', `${box.name}-evil`), OUT],
  ];
  const results = [];
  for (const [p, expected] of cases) {
    const before = snapshot(box.root);
    const r = await record(box, ev(p), { cwd: alias });
    assertOk(r, `through a symlinked project: ${p}`);
    assertOnlyLogDirChanged(box, before, `through a symlinked project: ${p}`);
    results.push(r);
    const lines = readLog(box, V3_SID);
    assertLine(lines[lines.length - 1], { tool: 'read_file', paths: [expected], range: {} }, `through a symlinked project: ${p}`);
  }
  assert.ok(lstatSync(alias).isSymbolicLink(), 'the alias stays a symlink');
  assertNoLeak(box, results, 'symlinked project');
});

test('a project with another name, spaces and non-ASCII letters works the same, and its name is never logged (R13.9)', POSIX, async () => {
  const box = sandbox('Client App Ω 2');
  await recordOne(box, v3(box, 'read_file', { path: 'src/m.py', offset: 1, limit: 2 }), { tool: 'read_file', paths: ['src/m.py'], range: { offset: 1, limit: 2 } }, 'renamed project');
  await recordOne(box, v3(box, 'read_file', { path: `../${box.name}-evil/${C.sibling}.txt`, offset: null, limit: null }), { tool: 'read_file', paths: [OUT], range: {} }, 'renamed project, prefix sibling');
  await recordOne(box, v3(box, 'read_file', { path: join(box.project, 'Ω.py'), offset: null, limit: null }), { tool: 'read_file', paths: ['Ω.py'], range: {} }, 'a non-ASCII file name inside');
  const text = readFileSync(logPath(box, V3_SID), 'utf8');
  assert.ok(!text.includes('Client App'), 'the project name is never logged');
  assertNoLeak(box, [], 'renamed project');
});

test('each session id gets its own log file (R13.2)', POSIX, async () => {
  const box = sandbox();
  await recordOne(box, v2(box, 'read', { operations: [{ mode: 'Line', path: 'a.py' }] }), { tool: 'read_file', paths: ['a.py'], range: {} }, 'V2 session');
  await recordOne(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }), { tool: 'read_file', paths: ['a.py'], range: {} }, 'V3 session');
  const names = readdirSync(box.logDir).sort();
  assert.deepEqual(names, [`${V2_SID}.events.jsonl`, `${V3_SID}.events.jsonl`].sort(), 'one file per session, named <session_id>.events.jsonl, and nothing else');
  const dirMode = statSync(box.logDir).mode & 0o777;
  const fileMode = statSync(logPath(box, V2_SID)).mode & 0o777;
  assert.equal(dirMode & 0o077, 0, `the log directory is created with mode 0700, got ${dirMode.toString(8)}`);
  assert.equal(fileMode & 0o077, 0, `the log file is created with mode 0600, got ${fileMode.toString(8)}`);
  assert.equal(statSync(logPath(box, V2_SID)).nlink, 1, 'the log file has one link');
});

// ---- cwd, project and session id ----

test('an event cwd that is not the real working directory is a failure with nothing written elsewhere (R13.10)', POSIX, async () => {
  const box = sandbox();
  const base = v3(box, 'read_file', { path: 'a.py', offset: null, limit: null });
  const bad = [
    ['the victim directory', box.victim],
    ['a prefix sibling', box.sibling],
    ['the home directory', box.home],
    ['a relative cwd', box.name],
    ['a missing directory', join(box.root, `missing-${C.outside}`)],
    ['a file', join(box.project, 'a.py')],
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['a NUL inside', `${box.project}\u0000`],
  ];
  for (const [what, cwd] of bad) {
    await recordFails(box, { ...base, cwd }, 'cwd_mismatch', `cwd ${what}`, V3_SID);
    assertVictim(box, `cwd ${what}`);
  }
  const missing = { ...base };
  delete missing.cwd;
  await recordFails(box, missing, 'cwd_mismatch', 'no cwd', V3_SID);
  const fail = readFileSync(failurePath(box), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(fail.length, bad.length + 1, 'every failure appends one line to recording-failures.jsonl (R13.13)');
  assert.ok(fail.every((f) => f.code === 'cwd_mismatch'), 'each failure line holds its code');
  const same = [`${box.project}/`, `${box.project}/./src/..`, join(box.home, '.', box.name)];
  for (const cwd of same) {
    await recordOne(box, { ...base, cwd }, { tool: 'read_file', paths: ['a.py'], range: {} }, `cwd ${JSON.stringify(cwd.slice(box.root.length))} is the same real directory`);
  }
});

test('a project that is /, the home directory or an ancestor of home is refused and nothing is written (R13.10)', POSIX, async () => {
  const box = sandbox();
  for (const [what, dir] of [['the home directory', box.home], ['an ancestor of home', box.root]]) {
    const before = snapshot(box.root);
    const r = await record(box, { ...v3(box, 'read_file', { path: 'a.py' }), cwd: dir }, { cwd: dir });
    assertFailed(r, 'project_unsafe', what);
    assertNothingChanged(box, before, what);
    assertNoLeak(box, [r], what);
  }
  const homeLink = join(box.root, 'home-link');
  symlinkSync(box.home, homeLink);
  const before = snapshot(box.root);
  const r = await record(box, { ...v3(box, 'read_file', { path: 'a.py' }), cwd: homeLink }, { cwd: homeLink });
  assertFailed(r, 'project_unsafe', 'the home directory through a symlink');
  assertNothingChanged(box, before, 'the home directory through a symlink');
});

test('the file system root is refused as a project (R13.10)', NOT_ROOT, async (t) => {
  if (existsSync('/.session-autopsy')) {
    t.skip('/.session-autopsy already exists on this machine');
    return;
  }
  const box = sandbox();
  const r = await record(box, { ...v3(box, 'read_file', { path: 'a.py' }), cwd: '/' }, { cwd: '/' });
  assertFailed(r, 'project_unsafe', 'the root directory');
  assert.ok(!existsSync('/.session-autopsy'), 'nothing is created in /');
});

test('a session_id outside ^[A-Za-z0-9_-]{1,128}$ is a failure and names no file (R13.12)', POSIX, async () => {
  const box = sandbox();
  const bad = ['', '../x', `../../${C.outside}`, 'a/b', 'a b', 'a.b', 'é', 'x'.repeat(129), 'a\u0000b', 'a\nb', '.', '..', 42, null, ['s'], { id: 's' }];
  for (const sid of bad) {
    await recordFails(box, { ...v3(box, 'read_file', { path: 'a.py' }), session_id: sid }, 'session_id_invalid', `session_id ${JSON.stringify(sid)}`);
  }
  const noSid = v3(box, 'read_file', { path: 'a.py' });
  delete noSid.session_id;
  await recordFails(box, noSid, 'session_id_invalid', 'no session_id');
  assert.deepEqual(readdirSync(box.logDir), ['recording-failures.jsonl'], 'only the failure file exists; no log file is named after a bad session_id');
  assertVictim(box, 'bad session ids');
  await recordOne(box, { ...v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }), session_id: 'x'.repeat(128) }, { tool: 'read_file', paths: ['a.py'], range: {} }, 'a 128-character session_id is valid');
});

// ---- invalid input ----

test('invalid input never exits 2 and prints one fixed failure line (R13.12, R13.13, P21)', POSIX, async () => {
  const box = sandbox();
  const cases = [
    ['empty stdin', '', 'input_invalid'],
    ['whitespace only', '  \n\t', 'input_invalid'],
    ['not JSON', 'hello', 'input_invalid'],
    ['cut JSON', '{"session_id":', 'input_invalid'],
    ['two JSON objects', `${JSON.stringify(v3(box, 'read_file', { path: 'a.py' }))}\n{}`, 'input_invalid'],
    ['an array', '[]', 'input_invalid'],
    ['null', 'null', 'input_invalid'],
    ['a number', '42', 'input_invalid'],
    ['a string', '"x"', 'input_invalid'],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'input_invalid'],
    ['deeply nested arrays', `${'['.repeat(200000)}${']'.repeat(200000)}`, null],
  ];
  for (const [what, input, code] of cases) {
    const before = snapshot(box.root);
    const r = await record(box, input);
    assertFailed(r, code, what);
    assertOnlyLogDirChanged(box, before, what);
  }
  assert.ok(!existsSync(logPath(box, V3_SID)), 'no event line is written for invalid input');
  const fail = readFileSync(failurePath(box), 'utf8').trim().split('\n');
  assert.equal(fail.length, cases.length, 'each failure appends one line to recording-failures.jsonl (R13.13)');
});

test('input above 64 MiB is a failure and is not recorded (R13.12)', POSIX, async () => {
  const box = sandbox();
  const event = JSON.stringify(v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }));
  const pad = 64 * 1024 * 1024 + 1 - Buffer.byteLength(event) + 1;
  const big = `${event.slice(0, -1)},"pad":"${'x'.repeat(pad)}"}`;
  assert.ok(Buffer.byteLength(big) > 64 * 1024 * 1024, 'test setup: the input is above 64 MiB');
  assert.doesNotThrow(() => JSON.parse(big), 'test setup: the input is valid JSON, so only its size can fail it');
  const before = snapshot(box.root);
  const r = await record(box, big, { timeout: 120000 });
  assertFailed(r, 'input_too_large', 'input above 64 MiB');
  assertOnlyLogDirChanged(box, before, 'input above 64 MiB');
  assert.ok(!existsSync(logPath(box, V3_SID)), 'the oversized event is not recorded');
});

/** A logged path is /workspace, /outside-workspace, or a clean relative name. */
const cleanPath = (p) => p === WS || p === OUT
  || (typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..'));
const TOOLS = new Set(['read_file', 'str_replace', 'list_directory', 'search', 'execute_bash', 'unknown_tool']);
const KEYS = new Set(['t', 'hook', 'tool', 'paths', 'range', 'ranges']);

test('seeded garbage never exits 2, prints at most the fixed line, and writes only allow-listed lines (P21, P22, P23)', POSIX, async () => {
  const seed = seedFromEnv();
  const r = gen(rng(seed));
  const box = sandbox();
  const value = () => r.pick([null, true, false, 0, -1, 1.5, 2 ** 60, '', 'x', 'a.py', '../x', '~', '~/x', 'a\u0000b', box.project, [], {}, [1, 'a'], { path: 'a.py' }]);
  const runs = 60;
  for (let i = 0; i < runs; i += 1) {
    let input;
    const kind = r.int(0, 3);
    if (kind === 0) {
      input = Buffer.from(Array.from({ length: r.int(0, 80) }, () => r.int(0, 255)));
    } else if (kind === 1) {
      const ev = {
        session_id: r.pick([V3_SID, V2_SID, value()]),
        cwd: r.pick([box.project, box.project, value()]),
        tool_name: r.pick(['read', 'fs_read', 'read_file', 'write', 'fs_write', 'fs_append', 'str_replace', 'shell', 'grep_search', 'list_directory', value()]),
        tool_input: r.pick([
          value(),
          { path: value(), offset: value(), limit: value() },
          { operations: Array.from({ length: r.int(0, 3) }, () => ({ mode: r.pick(['Line', 'Directory', value()]), path: value(), offset: value(), limit: value() })) },
          { command: r.pick(['create', 'strReplace', 'insert', value()]), path: value(), content: C.content },
        ]),
      };
      if (r.bool(0.2)) delete ev[r.pick(Object.keys(ev))];
      input = JSON.stringify(ev);
    } else if (kind === 2) {
      const s = JSON.stringify(v3(box, 'read_file', { path: 'a.py', offset: 1, limit: 2 }));
      input = s.slice(0, r.int(0, s.length));
    } else {
      const depth = r.int(1000, 50000);
      input = `{"session_id":"${V3_SID}","cwd":${JSON.stringify(box.project)},"tool_name":"read_file","tool_input":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`;
    }
    const res = await record(box, input);
    const what = `garbage case ${i}, seed ${seed} (rerun with SEED=${seed}), input starting ${JSON.stringify(String(input).slice(0, 160))}`;
    assert.equal(res.signal, null, `${what}: the recorder exits by itself`);
    assert.ok(res.code === 0 || res.code === 1, `${what}: exit 0 or 1, never 2; got ${res.code}`);
    assert.equal(res.stdout, '', `${what}: nothing on stdout`);
    if (res.code === 0) assert.equal(res.stderr, '', `${what}: nothing on stderr after a recorded call`);
    else assert.match(res.stderr, FAIL_RE, `${what}: exactly the fixed failure line on stderr`);
  }
  const files = existsSync(box.logDir) ? readdirSync(box.logDir) : [];
  for (const name of files.filter((f) => f.endsWith('.events.jsonl'))) {
    const text = readFileSync(join(box.logDir, name), 'utf8');
    assert.ok(text.endsWith('\n'), `${name}: complete lines only`);
    for (const l of text.slice(0, -1).split('\n')) {
      const o = JSON.parse(l);
      assert.ok(Object.keys(o).every((k) => KEYS.has(k)), `${name}: only allow-listed keys, got ${Object.keys(o).join(', ')}`);
      assert.equal(o.hook, 'pre', `${name}: hook is pre`);
      assert.ok(TOOLS.has(o.tool), `${name}: tool ${JSON.stringify(o.tool)} is one of the fixed names`);
      for (const p of o.paths ?? []) assert.ok(cleanPath(p), `${name}: path ${JSON.stringify(p)} is /workspace, /outside-workspace or a clean relative name (P23)`);
      if (o.ranges !== undefined) assert.equal(o.ranges.length, o.paths.length, `${name}: ranges has the length of paths`);
    }
  }
  assertVictim(box, 'garbage');
});

// ---- write safety ----

test('a symlinked or non-directory log directory is refused and its target stays unchanged (R13.11, P24)', POSIX, async () => {
  const cases = [
    ['a symlink to an outside directory', (b) => symlinkSync(b.victim, b.logDir)],
    ['a symlink to a directory inside the project', (b) => {
      mkdirSync(join(b.project, 'inner'));
      symlinkSync(join(b.project, 'inner'), b.logDir);
    }],
    ['a dangling symlink', (b) => symlinkSync(join(b.victim, 'made-by-recorder'), b.logDir)],
    ['a regular file', (b) => writeFileSync(b.logDir, 'not a directory\n')],
  ];
  for (const [what, setup] of cases) {
    const box = sandbox();
    setup(box);
    const before = snapshot(box.root);
    const r = await record(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }));
    assertFailed(r, 'log_dir_unsafe', what);
    assertNothingChanged(box, before, what);
    assertVictim(box, what);
    const p = await run(box, ['--prompt-check'], { keepOpen: true });
    assert.equal(p.code, 0, `${what}: --prompt-check exits 0`);
    assert.equal(p.stdout, instruction('log_dir_unsafe'), `${what}: --prompt-check prints the fixed instruction when the log directory is not usable (R13.14)`);
    assert.equal(p.stderr, '', `${what}: --prompt-check prints nothing on stderr`);
    const c = await run(box, ['--check'], { keepOpen: true });
    assert.equal(c.code, 1, `${what}: --check exits 1`);
    assert.equal(c.stdout, failLine('log_dir_unsafe'), `${what}: --check prints the failure line on stdout (R13.15)`);
    assertNothingChanged(box, before, `${what}, after both checks`);
  }
});

test('a symlinked, hard-linked or non-regular log file is refused and its victim stays unchanged (R13.11, P24)', POSIX, async () => {
  const cases = [
    ['a symlink to the victim', (b) => symlinkSync(join(b.victim, 'secret.txt'), logPath(b, V3_SID))],
    ['a dangling symlink into the victim directory', (b) => symlinkSync(join(b.victim, 'made-by-recorder.txt'), logPath(b, V3_SID))],
    ['a hard link to the victim', (b) => linkSync(join(b.victim, 'secret.txt'), logPath(b, V3_SID))],
    ['a directory', (b) => mkdirSync(logPath(b, V3_SID))],
  ];
  for (const [what, setup] of cases) {
    const box = sandbox();
    mkdirSync(box.logDir, { mode: 0o700 });
    setup(box);
    const r = await recordFails(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }), 'log_file_unsafe', what);
    assertVictim(box, what);
    assertNoLeak(box, [r], what);
    const fail = readFileSync(failurePath(box), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(fail.map((f) => f.code), ['log_file_unsafe'], `${what}: the failure is recorded in recording-failures.jsonl`);
  }
});

test('a symlinked or hard-linked failure file is refused, the victim stays unchanged and the failure line still appears (R13.13, P24)', POSIX, async () => {
  const cases = [
    ['a symlink to the victim', (b) => symlinkSync(join(b.victim, 'secret.txt'), failurePath(b))],
    ['a dangling symlink into the victim directory', (b) => symlinkSync(join(b.victim, 'made-by-recorder.txt'), failurePath(b))],
    ['a hard link to the victim', (b) => linkSync(join(b.victim, 'secret.txt'), failurePath(b))],
  ];
  const any = /^Session Autopsy recorder: recording of this session failed \(([a-z_]+)\), so its log is incomplete\. Begin your reply with this exact line: Session Autopsy recorder: RECORDING FAILED \(\1\)\n$/;
  for (const [what, setup] of cases) {
    const box = sandbox();
    mkdirSync(box.logDir, { mode: 0o700 });
    setup(box);
    await recordFails(box, { ...v3(box, 'read_file', { path: 'a.py' }), session_id: '../x' }, 'session_id_invalid', what);
    assertVictim(box, what);
    const before = snapshot(box.root);
    const p = await run(box, ['--prompt-check'], { keepOpen: true });
    assert.equal(p.code, 0, `${what}: --prompt-check exits 0`);
    assert.match(p.stdout, any, `${what}: an unsafe failure file is not healthy, so --prompt-check prints the instruction`);
    const c = await run(box, ['--check'], { keepOpen: true });
    assert.equal(c.code, 1, `${what}: --check exits 1`);
    assert.match(c.stdout, FAIL_RE, `${what}: --check prints the failure line`);
    assertNothingChanged(box, before, `${what}: the checks write nothing`);
    assertVictim(box, `${what}, after both checks`);
  }
});

test('an unwritable log directory gives the fixed failure line with no path or error text (R13.8, R13.13)', NOT_ROOT, async () => {
  const box = sandbox();
  mkdirSync(box.logDir, { mode: 0o700 });
  chmodSync(box.logDir, 0o500);
  try {
    const r = await recordFails(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }), null, 'unwritable log directory');
    assertNoLeak(box, [r], 'unwritable log directory');
    assert.ok(!/EACCES|permission denied/i.test(r.stderr), 'no error message reaches stderr');
  } finally {
    chmodSync(box.logDir, 0o700);
  }
});

test('an unwritable log directory, or an unwritable project with no log directory yet, fails record mode and is reported by both check modes, which write nothing (R13.14, R13.15)', NOT_ROOT, async () => {
  const cases = [
    ['an unwritable log directory', (b) => {
      mkdirSync(b.logDir, { mode: 0o700 });
      chmodSync(b.logDir, 0o500);
      return [b.logDir, 0o700];
    }],
    ['an unwritable project with no log directory', (b) => {
      chmodSync(b.project, 0o500);
      return [b.project, 0o755];
    }],
  ];
  for (const [what, setup] of cases) {
    const box = sandbox();
    const [dir, restore] = setup(box);
    try {
      const before = snapshot(box.root);
      const r = await record(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }));
      assertFailed(r, 'write_failed', `${what}: record mode`);
      assertNothingChanged(box, before, `${what}: record mode cannot write there, not even the failure file`);
      const p = await run(box, ['--prompt-check'], { keepOpen: true });
      assert.deepEqual([p.code, p.stdout, p.stderr], [0, instruction('write_failed'), ''],
        `${what}: --prompt-check must print the write_failed instruction, because record mode cannot write there (R13.14)`);
      const c = await run(box, ['--check'], { keepOpen: true });
      assert.deepEqual([c.code, c.stdout, c.stderr], [1, failLine('write_failed'), ''],
        `${what}: --check must not print OK, because record mode cannot write there (R13.15)`);
      assertNothingChanged(box, before, `${what}: the check modes create and write nothing`);
      assertNoLeak(box, [r, p, c], what);
    } finally {
      chmodSync(dir, restore);
    }
  }
});

// ---- failure file and check modes ----

test('a failure appends {time, code} to recording-failures.jsonl and both check modes report it without reading stdin (R13.13 to R13.15)', POSIX, async () => {
  const box = sandbox();
  let before = snapshot(box.root);
  const p0 = await run(box, ['--prompt-check'], { input: JSON.stringify({ prompt: C.prompt }), keepOpen: true });
  assert.deepEqual([p0.code, p0.stdout, p0.stderr], [0, '', ''], '--prompt-check is silent and exits 0 when healthy, also before the log directory exists');
  const c0 = await run(box, ['--check'], { input: C.prompt, keepOpen: true });
  assert.deepEqual([c0.code, c0.stdout, c0.stderr], [0, OK_LINE, ''], '--check prints OK and exits 0 when healthy');
  assertNothingChanged(box, before, 'the check modes write nothing, not even the log directory');

  await recordOne(box, v3(box, 'read_file', { path: 'a.py', offset: null, limit: null }), { tool: 'read_file', paths: ['a.py'], range: {} }, 'a working recording');
  const p1 = await run(box, ['--prompt-check'], { keepOpen: true });
  assert.deepEqual([p1.code, p1.stdout, p1.stderr], [0, '', ''], '--prompt-check stays silent after a working recording');
  const c1 = await run(box, ['--check'], { keepOpen: true });
  assert.deepEqual([c1.code, c1.stdout], [0, OK_LINE], '--check stays OK after a working recording');

  const t0 = Date.now();
  const r = await recordFails(box, { ...v3(box, 'read_file', { path: 'a.py' }), session_id: `${C.session}/x` }, 'session_id_invalid', 'a bad session_id');
  const t1 = Date.now();
  const fail = readFileSync(failurePath(box), 'utf8');
  assert.ok(fail.endsWith('\n'), 'the failure file has complete lines');
  const entries = fail.slice(0, -1).split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 1, 'one failure, one line');
  assert.deepEqual(Object.keys(entries[0]).sort(), ['code', 'time'], 'a failure line holds exactly time and code');
  assert.equal(entries[0].code, 'session_id_invalid');
  assert.match(entries[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/, 'time is an ISO 8601 UTC string');
  const ms = Date.parse(entries[0].time);
  assert.ok(ms >= t0 - 1000 && ms <= t1 + 1000, 'time is the time of the failure');
  const st = statSync(failurePath(box));
  assert.equal(st.mode & 0o077, 0, 'the failure file has mode 0600');
  assert.equal(st.nlink, 1, 'the failure file has one link');

  before = snapshot(box.root);
  const p2 = await run(box, ['--prompt-check'], { input: JSON.stringify({ prompt: C.prompt }), keepOpen: true });
  assert.equal(p2.code, 0, '--prompt-check always exits 0');
  assert.equal(p2.stdout, instruction('session_id_invalid'), '--prompt-check prints the fixed instruction with the code of the last failure');
  assert.equal(p2.stderr, '', '--prompt-check prints nothing on stderr');
  const c2 = await run(box, ['--check'], { keepOpen: true });
  assert.deepEqual([c2.code, c2.stdout, c2.stderr], [1, failLine('session_id_invalid'), ''], '--check prints the failure line on stdout and exits 1');
  assertNothingChanged(box, before, 'the check modes write nothing');
  assertNoLeak(box, [p0, c0, p1, c1, r, p2, c2], 'check modes');

  await recordFails(box, { ...v3(box, 'read_file', { path: 'a.py' }), cwd: box.victim }, 'cwd_mismatch', 'a later failure');
  const p3 = await run(box, ['--prompt-check'], { keepOpen: true });
  assert.equal(p3.stdout, instruction('cwd_mismatch'), 'the code of the last line is reported');
});

test('the check modes report the last code only when it is known, and an empty failure file is a failure with code unknown (R13.14, R13.15)', POSIX, async () => {
  const cases = [
    // Deliberately reversed in run 22: this case used to be healthy. An empty failure file is
    // what remains when the failure file was created but its line could not be written, so it
    // now reports a failure with code unknown. Deleting the file still clears it.
    ['an empty failure file', '', 'unknown'],
    ['a broken line', 'garbage\n', 'unknown'],
    ['a known code', '{"time":"2026-11-22T12:00:00.000Z","code":"write_failed"}\n', 'write_failed'],
    ['an unknown code', '{"time":"2026-11-22T12:00:00.000Z","code":"not_a_known_code"}\n', 'unknown'],
    ['a code with a path', '{"time":"x","code":"/etc/passwd"}\n', 'unknown'],
    ['a known code after a broken one', 'garbage\n{"time":"x","code":"internal"}\n', 'internal'],
  ];
  for (const [what, content, code] of cases) {
    const box = sandbox();
    mkdirSync(box.logDir, { mode: 0o700 });
    writeFileSync(failurePath(box), content, { mode: 0o600 });
    const before = snapshot(box.root);
    const p = await run(box, ['--prompt-check'], { keepOpen: true });
    const c = await run(box, ['--check'], { keepOpen: true });
    assert.equal(p.code, 0, `${what}: --prompt-check exits 0`);
    if (code === null) {
      assert.deepEqual([p.stdout, c.code, c.stdout], ['', 0, OK_LINE], `${what}: healthy`);
    } else {
      assert.equal(p.stdout, instruction(code), `${what}: --prompt-check reports ${code}`);
      assert.deepEqual([c.code, c.stdout], [1, failLine(code)], `${what}: --check reports ${code}`);
    }
    assertNothingChanged(box, before, what);
    assertNoLeak(box, [p, c], what);
  }
});

test('the check modes report an unsafe project and write nothing (R13.10, R13.14, R13.15)', POSIX, async () => {
  const box = sandbox();
  const before = snapshot(box.root);
  const p = await run(box, ['--prompt-check'], { cwd: box.home, keepOpen: true });
  assert.deepEqual([p.code, p.stdout, p.stderr], [0, instruction('project_unsafe'), ''], '--prompt-check in the home directory');
  const c = await run(box, ['--check'], { cwd: box.home, keepOpen: true });
  assert.deepEqual([c.code, c.stdout], [1, failLine('project_unsafe')], '--check in the home directory');
  assertNothingChanged(box, before, 'checks in the home directory');
  assertNoLeak(box, [p, c], 'checks in the home directory');
});

test('the explicit record mode works like the default, and an unknown mode fails without reading on (R13.2)', POSIX, async () => {
  const box = sandbox();
  const before = snapshot(box.root);
  const r = await run(box, ['record'], { input: JSON.stringify(v3(box, 'read_file', { path: 'a.py', offset: 1, limit: 1 })) });
  assertOk(r, 'mode record');
  assertOnlyLogDirChanged(box, before, 'mode record');
  assertLine(readLog(box, V3_SID)[0], { tool: 'read_file', paths: ['a.py'], range: { offset: 1, limit: 1 } }, 'mode record');
  for (const args of [['--record'], ['check'], ['--prompt-check', 'x'], ['record', 'extra']]) {
    const res = await run(box, args, { input: JSON.stringify(v3(box, 'read_file', { path: 'a.py' })), keepOpen: true });
    assertFailed(res, 'mode_unknown', `arguments ${JSON.stringify(args)}`);
  }
  assert.equal(readLog(box, V3_SID).length, 1, 'an unknown mode records nothing');
});

// ---- concurrency ----

test('40 parallel recordings with long paths give 40 complete lines (R13.11, P25)', POSIX, async () => {
  const box = sandbox();
  const pathFor = (i, k) => `w${i}/${k}/${'p'.repeat(240)}/${'q'.repeat(240)}/${'r'.repeat(240)}/${'s'.repeat(200)}.py`;
  const opsFor = (i) => Array.from({ length: 12 }, (_, k) => ({ mode: 'Line', path: pathFor(i, k), offset: k, limit: i + 1 }));
  assert.ok(pathFor(39, 11).length <= 1024, 'test setup: each path is at most 1024 characters');
  const expected = (i) => ({ tool: 'read_file', paths: opsFor(i).map((o) => o.path), ranges: opsFor(i).map((o) => ({ offset: o.offset, limit: o.limit })) });
  const size = Buffer.byteLength(JSON.stringify({ t: 1795277071.645, hook: 'pre', ...expected(39) }));
  assert.ok(size > 4096 && size < 16 * 1024, `test setup: each line (${size} bytes) is above PIPE_BUF and below 16 KiB`);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => record(box, v2(box, 'read', { operations: opsFor(i) }))));
  results.forEach((r, i) => assertOk(r, `parallel process ${i}`));
  const text = readFileSync(logPath(box, V2_SID), 'utf8');
  assert.ok(text.endsWith('\n'), 'the log ends with a complete line');
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, 40, '40 processes, 40 lines');
  const seen = new Set();
  for (const l of lines) {
    let o;
    assert.doesNotThrow(() => {
      o = JSON.parse(l);
    }, 'every line is intact JSON; interleaved writes would break it');
    const m = /^w(\d+)\//.exec(o.paths[0]);
    assert.ok(m, 'every line belongs to one process');
    const i = Number(m[1]);
    seen.add(i);
    assertLine(o, expected(i), `the line of process ${i}`);
  }
  assert.equal(seen.size, 40, 'every process wrote its own line');
  assert.ok(!existsSync(failurePath(box)), 'no process failed, including the ones that raced to create the log directory');
});
