// session-autopsy-record.mjs: a Kiro CLI hook that records which tools a coding agent asked for,
// so that Session Autopsy can open the session afterwards.
//
// Install: copy this file to <project>/.kiro/session-autopsy/ and register it in a custom agent,
// as in examples/recorder-agent.json of the Session Autopsy repository:
//   preToolUse, matcher "*":  node .kiro/session-autopsy/session-autopsy-record.mjs
//   userPromptSubmit:         node .kiro/session-autopsy/session-autopsy-record.mjs --prompt-check
// Check by hand:              node .kiro/session-autopsy/session-autopsy-record.mjs --check
//
// What it writes: one JSON line per tool call to <project>/.session-autopsy/<session_id>.events.jsonl,
//   {"t": epoch seconds, "hook": "pre", "tool": fixed name, "paths": [...], "range" or "ranges": ...}
// "tool" is one of read_file, str_replace, list_directory, search, execute_bash, unknown_tool.
// File names inside the project ARE recorded, relative to the project. A path outside the project
// is recorded as "/outside-workspace" with no name. The project itself and targets that cannot be
// read are "/workspace".
// Never recorded: file contents, old or new text, tool output, prompts, tool-use purposes,
// commands, unknown fields, absolute paths, home paths. There is no option to record commands.
//
// Limits:
// - preToolUse runs before the permission check, so the log holds attempts. It cannot say whether
//   a call was allowed, denied or ran, and no permission field is written.
// - Kiro does not show a preToolUse hook's stderr. A failure exits 1 (never 2, which would block
//   the tool), prints one fixed line on stderr and appends {time, code} to
//   .session-autopsy/recording-failures.jsonl.
// - --prompt-check asks the agent, at the next prompt, to begin its reply with the failure line.
//   That works only when the agent relays it, and it cannot see a failure after the last prompt.
// - If node is missing, the hook cannot run and cannot report itself.
// - Delete recording-failures.jsonl to clear a reported failure.
//
// Node built-ins only. No network, no child process, and no environment read except the home
// directory through node:os.

import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const WORKSPACE = '/workspace';
const OUTSIDE = '/outside-workspace';
const LOG_DIR = '.session-autopsy';
const FAILURES = 'recording-failures.jsonl';
const MAX_INPUT = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_FAILURE_READ = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CODES = new Set([
  'input_too_large', 'input_invalid', 'session_id_invalid', 'cwd_mismatch', 'project_unsafe',
  'log_dir_unsafe', 'log_file_unsafe', 'write_failed', 'mode_unknown', 'internal',
]);
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const OK_LINE = 'session-autopsy-recorder: OK\n';
const failLine = (code) => `session-autopsy-recorder: RECORDING FAILED (${code})\n`;
const instruction = (code) => `Session Autopsy recorder: recording of this session failed (${code}), `
  + 'so its log is incomplete. Begin your reply with this exact line: '
  + `Session Autopsy recorder: RECORDING FAILED (${code})\n`;

/** An error that carries one fixed failure code and nothing else. */
const failure = (code) => Object.assign(new Error(code), { recorderCode: code });
const codeOf = (err) => (err && typeof err.recorderCode === 'string' ? err.recorderCode : 'internal');
const errno = (err) => (err && typeof err.code === 'string' ? err.code : '');

/** Writes fixed text to stdout (1) or stderr (2). Nothing else can report a failure here. */
const say = (fd, text) => {
  try {
    writeSync(fd, text);
  } catch {
    // ignored: there is no other channel
  }
};

/** True when p is strictly inside root. Both are absolute, real paths. */
const isInside = (root, p) => {
  const rel = relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The real home directory, or null when it cannot be known. */
const realHome = () => {
  let h;
  try {
    h = homedir();
  } catch {
    return null;
  }
  if (typeof h !== 'string' || !isAbsolute(h)) return null;
  try {
    return realpathSync(h);
  } catch {
    return resolve(h);
  }
};

/**
 * The real project directory. Fails when it is /, the home directory or an ancestor of it,
 * because names relative to it would reveal the home.
 */
const safeProject = () => {
  let project;
  try {
    project = realpathSync(process.cwd());
  } catch {
    throw failure('project_unsafe');
  }
  const home = realHome();
  if (project === '/' || home === null || project === home || isInside(project, home)) throw failure('project_unsafe');
  return project;
};

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch (err) {
    if (errno(err) === 'ENOENT') return null;
    throw failure('log_dir_unsafe');
  }
};

/**
 * Changes into <project>/.session-autopsy and verifies it, so only bare names are opened after.
 * Refuses a symlink or a non-directory. Returns false when it is missing and create is false.
 */
const enterLogDir = (project, create) => {
  const dir = join(project, LOG_DIR);
  let st = lstatOrNull(dir);
  if (st === null) {
    if (!create) return false;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (errno(err) !== 'EEXIST') throw failure('write_failed');
    }
    st = lstatOrNull(dir);
  }
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) throw failure('log_dir_unsafe');
  try {
    process.chdir(dir);
  } catch {
    throw failure('log_dir_unsafe');
  }
  let here;
  try {
    here = realpathSync(process.cwd());
  } catch {
    throw failure('log_dir_unsafe');
  }
  if (here !== dir) throw failure('log_dir_unsafe');
  return true;
};

const OPEN_UNSAFE = new Set(['ELOOP', 'EMLINK', 'EISDIR', 'ENXIO', 'EFTYPE']);

/**
 * Appends one complete line to a bare file name inside the log directory, in one write.
 * build() runs after the checks, immediately before the write, and returns the bytes.
 */
const appendLine = (project, name, build) => {
  enterLogDir(project, true);
  let fd;
  try {
    fd = openSync(name, APPEND_FLAGS, 0o600);
  } catch (err) {
    throw failure(OPEN_UNSAFE.has(errno(err)) ? 'log_file_unsafe' : 'write_failed');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw failure('log_file_unsafe');
    const buf = build();
    let written;
    try {
      written = writeSync(fd, buf);
    } catch {
      throw failure('write_failed');
    }
    if (written !== buf.length) throw failure('write_failed');
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignored: the line is written or the failure is already known
    }
  }
};

/** Appends {time, code} to the failure file. A failure here changes nothing else. */
const recordFailure = (project, code) => {
  if (project === null) return;
  try {
    appendLine(project, FAILURES, () => Buffer.from(`${JSON.stringify({ time: new Date().toISOString(), code })}\n`, 'utf8'));
  } catch {
    // ignored: the stderr line and exit 1 still report the failure
  }
};

/** Reports a failure and exits 1. Never exits with any other code. */
const fail = (project, code) => {
  recordFailure(project, code);
  say(2, failLine(code));
  process.exit(1);
};

/** The code of the last line of the failure file, or 'unknown'. */
const lastCode = (text) => {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'unknown';
  try {
    const o = JSON.parse(lines[lines.length - 1]);
    if (o !== null && typeof o === 'object' && typeof o.code === 'string' && CODES.has(o.code)) return o.code;
  } catch {
    // a broken line gives unknown
  }
  return 'unknown';
};

/**
 * null when healthy, else a failure code. Reads no stdin and writes nothing.
 * Healthy: a safe project, a log directory that is missing or a real directory, and a failure
 * file that is missing or empty.
 */
const health = () => {
  let project;
  try {
    project = safeProject();
    if (!enterLogDir(project, false)) return null;
  } catch (err) {
    return codeOf(err);
  }
  let fd;
  try {
    fd = openSync(FAILURES, READ_FLAGS);
  } catch (err) {
    return errno(err) === 'ENOENT' ? null : 'log_file_unsafe';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return 'log_file_unsafe';
    if (st.size === 0) return null;
    const len = Math.min(st.size, MAX_FAILURE_READ);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, st.size - len);
    return lastCode(buf.subarray(0, n).toString('utf8'));
  } catch {
    return 'log_file_unsafe';
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignored
    }
  }
};

// ---- paths ----

/**
 * Follows an absolute path component by component on the real file system. Missing components
 * are kept as written (they cannot be symlinks); '..' after a real directory goes to its real parent.
 * @returns {{ kind: 'path', path: string } | { kind: 'dangling' } | { kind: 'unknown' }}
 */
const realTarget = (abs) => {
  let cur = '/';
  const missing = [];
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue;
    if (missing.length > 0) {
      if (part === '..') missing.pop();
      else missing.push(part);
      continue;
    }
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let st;
    try {
      st = lstatSync(next);
    } catch (err) {
      const c = errno(err);
      if (c === 'ENOENT' || c === 'ENOTDIR') {
        missing.push(part);
        continue;
      }
      return { kind: 'unknown' };
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    try {
      cur = realpathSync(next);
    } catch (err) {
      const c = errno(err);
      return c === 'ENOENT' || c === 'ENOTDIR' ? { kind: 'dangling' } : { kind: 'unknown' };
    }
  }
  return { kind: 'path', path: join(cur, ...missing) };
};

/**
 * The logged form of one path: a name relative to the project with '/', WORKSPACE for the
 * project itself or an unknown target, OUTSIDE for anything outside, with no name.
 */
const pathName = (p, project, home) => {
  if (p === '' || p.length > MAX_PATH_CHARS || CONTROL.test(p)) return WORKSPACE;
  let abs;
  if (p === '~' || p.startsWith('~/')) {
    if (home === null) return OUTSIDE;
    abs = home + p.slice(1);
  } else if (p.startsWith('~')) {
    return OUTSIDE;
  } else {
    abs = isAbsolute(p) ? p : `${project}/${p}`;
  }
  const r = realTarget(abs);
  if (r.kind === 'dangling') return OUTSIDE;
  if (r.kind === 'unknown') return WORKSPACE;
  if (r.path === project) return WORKSPACE;
  if (!isInside(project, r.path)) return OUTSIDE;
  return relative(project, r.path).split(sep).join('/');
};

// ---- tools ----

const SHELL_TOOLS = new Set(['shell', 'execute_bash', 'execute_cmd', 'controlBashProcess']);
const WRITE_COMMANDS = new Set(['create', 'strReplace', 'insert']);
const UNKNOWN = { tool: 'unknown_tool' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const stringField = (o, k) => (has(o, k) && typeof o[k] === 'string' ? o[k] : null);

/** {offset?, limit?} of one read, or null when either holds a value that is not allowed. */
const rangeOf = (input) => {
  const out = {};
  const offset = has(input, 'offset') ? input.offset : null;
  const limit = has(input, 'limit') ? input.limit : null;
  if (offset !== null) {
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    out.offset = offset;
  }
  if (limit !== null) {
    if (!Number.isSafeInteger(limit) || limit < 1) return null;
    out.limit = limit;
  }
  return out;
};

/** V2 read: every operation Line (a file read) or every one Directory (a listing). */
const v2Read = (input) => {
  const ops = has(input, 'operations') ? input.operations : null;
  if (!Array.isArray(ops) || ops.length === 0) return UNKNOWN;
  if (!ops.every((op) => isObject(op) && stringField(op, 'path') !== null)) return UNKNOWN;
  const paths = ops.map((op) => op.path);
  if (ops.every((op) => op.mode === 'Directory')) return { tool: 'list_directory', paths };
  if (!ops.every((op) => op.mode === 'Line')) return UNKNOWN;
  const ranges = ops.map(rangeOf);
  if (ranges.includes(null)) return UNKNOWN;
  return ops.length === 1 ? { tool: 'read_file', paths, range: ranges[0] } : { tool: 'read_file', paths, ranges };
};

const writeOf = (input) => {
  const path = stringField(input, 'path');
  return path === null ? UNKNOWN : { tool: 'str_replace', paths: [path] };
};

/**
 * The fixed tool name and the raw path strings to log. Tool names are compared, never copied.
 * @returns {{ tool: string, paths?: string[], range?: object, ranges?: object[] }}
 */
const describe = (name, input) => {
  if (typeof name !== 'string') return UNKNOWN;
  if (SHELL_TOOLS.has(name)) return { tool: 'execute_bash' };
  if (name === 'grep_search' || name === 'file_search') return { tool: 'search' };
  if (!isObject(input)) return UNKNOWN;
  switch (name) {
    case 'read':
    case 'fs_read':
      return v2Read(input);
    case 'read_file': {
      const path = stringField(input, 'path');
      const range = rangeOf(input);
      return path === null || range === null ? UNKNOWN : { tool: 'read_file', paths: [path], range };
    }
    case 'write':
    case 'fs_write':
      if (name === 'write' || has(input, 'command')) {
        return typeof input.command === 'string' && WRITE_COMMANDS.has(input.command) ? writeOf(input) : UNKNOWN;
      }
      return writeOf(input);
    case 'fs_append':
    case 'str_replace':
      return writeOf(input);
    case 'list_directory': {
      const path = stringField(input, 'path');
      return path === null ? { tool: 'list_directory' } : { tool: 'list_directory', paths: [path] };
    }
    default:
      return UNKNOWN;
  }
};

/** The bytes of one log line, built from the allow-listed fields only. */
const lineBytes = (desc, paths) => {
  const t = Date.now() / 1000;
  const obj = { t, hook: 'pre', tool: desc.tool };
  if (paths !== null) obj.paths = paths;
  if (desc.range !== undefined) obj.range = desc.range;
  if (desc.ranges !== undefined) obj.ranges = desc.ranges;
  const buf = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
  if (buf.length <= MAX_LINE_BYTES) return buf;
  return Buffer.from(`${JSON.stringify({ t, hook: 'pre', tool: 'unknown_tool' })}\n`, 'utf8');
};

// ---- modes ----

/** stdin as bytes, or null as soon as it passes MAX_INPUT. */
const readInput = () => new Promise((done, reject) => {
  const chunks = [];
  let total = 0;
  let finished = false;
  const stdin = process.stdin;
  stdin.on('data', (chunk) => {
    if (finished) return;
    total += chunk.length;
    if (total > MAX_INPUT) {
      finished = true;
      stdin.destroy();
      done(null);
      return;
    }
    chunks.push(chunk);
  });
  stdin.on('end', () => {
    if (finished) return;
    finished = true;
    done(Buffer.concat(chunks, total));
  });
  stdin.on('error', () => {
    if (finished) return;
    finished = true;
    reject(failure('input_invalid'));
  });
});

/** The event's cwd must be the same real directory as the project. */
const sameDir = (cwd, project) => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || CONTROL.test(cwd)) return false;
  try {
    return realpathSync(cwd) === project;
  } catch {
    return false;
  }
};

/** preToolUse: one line per tool call. Order: project, size, JSON, session_id, cwd, line, write. */
const recordMode = async () => {
  let project = null;
  try {
    project = safeProject();
    const raw = await readInput();
    if (raw === null) throw failure('input_too_large');
    let event;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      throw failure('input_invalid');
    }
    if (!isObject(event)) throw failure('input_invalid');
    const sid = has(event, 'session_id') ? event.session_id : null;
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) throw failure('session_id_invalid');
    if (!sameDir(has(event, 'cwd') ? event.cwd : null, project)) throw failure('cwd_mismatch');
    const desc = describe(has(event, 'tool_name') ? event.tool_name : null, has(event, 'tool_input') ? event.tool_input : null);
    const home = realHome();
    const paths = desc.paths === undefined ? null : desc.paths.map((p) => pathName(p, project, home));
    appendLine(project, `${sid}.events.jsonl`, () => lineBytes(desc, paths));
  } catch (err) {
    fail(project, codeOf(err));
    return;
  }
  process.exit(0);
};

/** userPromptSubmit: silent when healthy, else one fixed instruction. Never reads stdin, always exit 0. */
const promptCheck = () => {
  let code;
  try {
    code = health();
  } catch {
    code = 'internal';
  }
  if (code !== null) say(1, instruction(code));
  process.exit(0);
};

/** For a human: OK and exit 0, or the failure line and exit 1, on stdout. */
const humanCheck = () => {
  let code;
  try {
    code = health();
  } catch {
    code = 'internal';
  }
  say(1, code === null ? OK_LINE : failLine(code));
  process.exit(code === null ? 0 : 1);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === 'record')) return recordMode();
  if (args.length === 1 && args[0] === '--prompt-check') return promptCheck();
  if (args.length === 1 && args[0] === '--check') return humanCheck();
  let project = null;
  try {
    project = safeProject();
  } catch {
    project = null;
  }
  return fail(project, 'mode_unknown');
};

main().catch(() => {
  say(2, failLine('internal'));
  process.exit(1);
});
