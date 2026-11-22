// Call -> Effect: a category and the file effects, from tool, cmd, range and allow only.
// The logged kind, spans and call fields are never read, and paths only for file tools.
// Pure: no DOM, no I/O.

import { lex } from './shell.js';

/** The sanitized working directory. */
export const ROOT = '/workspace';
/** What the recorder writes for any path outside the project. Never a file key for requests. */
export const OUTSIDE = '/outside-workspace';
/** Requested line numbers above this are treated as unknown lines. */
export const MAX_LINE = 10_000_000;

/**
 * @typedef {import('./parse.js').Call} Call
 * @typedef {{ file: string, call: number, n: number, kind: 'range', from: number, to: number }
 *   | { file: string, call: number, n: number, kind: 'open', from: number }
 *   | { file: string, call: number, n: number, kind: 'unlocated' }} Request
 * @typedef {'source'|'test'|'scratch'|'other'|'outside'|'unknown'} EditClass
 * @typedef {{ file: string|null, call: number, n: number, cls: EditClass }} Edit
 * @typedef {'request'|'search'|'edit'|'test'|'run'|'vcs'|'other'|'blocked'|'unknown'} Category
 * @typedef {{ category: Category, requests: Request[], edits: Edit[],
 *   hiddenEdit: boolean, hiddenRequest: boolean, reasons: string[],
 *   permission?: 'allowed'|'blocked'|'not_recorded'|'unknown' }} Effect
 */

// Lowest to highest. 'blocked' is outside the order and overrides everything.
const RANK = ['other', 'vcs', 'search', 'request', 'unknown', 'run', 'test', 'edit'];
const higher = (a, b) => {
  if (a === null) return b;
  if (b === null) return a;
  return RANK.indexOf(a) >= RANK.indexOf(b) ? a : b;
};

const TEST_DIRS = new Set(['test', 'tests', 'testing', '__tests__', 'spec']);
const SOURCE_EXT = new Set('py js mjs cjs ts tsx jsx go rs java kt c h cc cpp hpp cs rb php swift scala'.split(' '));

/** Normalises an absolute path: removes '.', empty segments and resolves '..'. */
const normalize = (abs) => {
  const out = [];
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
};

/** @returns {string|null} absolute normalised path, null when cwd is unknown and p is relative */
const absolute = (p, cwd) => {
  if (p.startsWith('/')) return normalize(p);
  if (cwd === null) return null;
  return normalize(cwd + '/' + p);
};

/**
 * Joins cwd and p and gives the file key: relative inside the workspace,
 * absolute outside it. The workspace directory itself is not a file.
 * @param {string} p
 * @param {string|null} [cwd]
 * @returns {string|null}
 */
export function resolve(p, cwd = ROOT) {
  if (typeof p !== 'string' || p === '') return null;
  const abs = absolute(p, cwd);
  if (abs === null || abs === ROOT) return null;
  if (abs.startsWith(ROOT + '/')) return abs.slice(ROOT.length + 1);
  return abs;
}

/**
 * Class of an edit target, checked in the documented order.
 * @param {string|null} key file key from resolve()
 * @returns {EditClass}
 */
export function editClass(key) {
  if (key === null) return 'unknown';
  if (key.startsWith('/')) return 'outside';
  const parts = key.split('/');
  if (parts.some((p) => p.startsWith('.'))) return 'other';
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => TEST_DIRS.has(d))
    || base.startsWith('test_') || /_test\./.test(base) || /\.test\./.test(base) || /\.spec\./.test(base)
    || base === 'conftest.py') return 'test';
  if (/^(repro|scratch|debug|tmp|temp)/i.test(base)) return 'scratch';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (SOURCE_EXT.has(ext)) return 'source';
  return 'other';
}

/** @returns {Effect} */
const result = (category, extra = {}) => ({
  category,
  requests: [],
  edits: [],
  hiddenEdit: false,
  hiddenRequest: false,
  reasons: [],
  ...extra,
});

const unknownEffect = (reason) => result('unknown', { hiddenEdit: true, hiddenRequest: true, reasons: [reason] });

/** The one usable path of a file tool, as a key, or null. */
const singlePath = (call) => {
  if (!Array.isArray(call.paths) || call.paths.length !== 1) return null;
  return resolve(call.paths[0], ROOT);
};

const mkRequest = (call, file, kind, from = null, to = null) => {
  if (kind === 'range') return { file, call: call.index, n: call.n, kind, from, to };
  if (kind === 'open') return { file, call: call.index, n: call.n, kind, from };
  return { file, call: call.index, n: call.n, kind: 'unlocated' };
};

/** A request for lines from..to (to null: open-ended), unlocated above MAX_LINE. */
const lineRequest = (call, file, from, to) => {
  if (to === null) return from > MAX_LINE ? mkRequest(call, file, 'unlocated') : mkRequest(call, file, 'open', from);
  return to > MAX_LINE ? mkRequest(call, file, 'unlocated') : mkRequest(call, file, 'range', from, to);
};

const readFileEffect = (call) => {
  const rangesBad = Array.isArray(call.malformed) && call.malformed.includes('ranges');
  const ranges = call.ranges ?? null;
  if (ranges !== null || rangesBad) return multiReadEffect(call, rangesBad ? null : ranges);
  if (Array.isArray(call.paths) && call.paths.length === 1 && resolve(call.paths[0], ROOT) === OUTSIDE) {
    return result('request', { reasons: ['outside'] });
  }
  const file = singlePath(call);
  if (file === null) return result('request', { hiddenRequest: true, reasons: ['no_single_path'] });
  return result('request', { requests: [rangeRequest(call, file, call.range)] });
};

/** One request by the read_file range rules; a Range of wrong type (null) is unlocated. */
const rangeRequest = (call, file, r) => {
  if (r === null) return mkRequest(call, file, 'unlocated');
  const off = r.offset ?? 0;
  return r.limit === null ? lineRequest(call, file, off + 1, null) : lineRequest(call, file, off + 1, off + r.limit);
};

/**
 * A recorder read of several files: one request per path. With ranges of the same length as
 * paths each path gets its range; otherwise lines are unknown, never invented.
 */
const multiReadEffect = (call, ranges) => {
  if (!Array.isArray(call.paths)) return result('request', { hiddenRequest: true, reasons: ['no_paths'] });
  const valid = ranges !== null && ranges.length === call.paths.length;
  const out = result('request', { reasons: valid ? [] : ['ranges_unknown'] });
  call.paths.forEach((p, i) => {
    const key = resolve(p, ROOT);
    if (key === OUTSIDE) return;
    if (key === null) {
      out.hiddenRequest = true;
      out.reasons.push('unknown_target');
      return;
    }
    out.requests.push(valid ? rangeRequest(call, key, ranges[i]) : mkRequest(call, key, 'unlocated'));
  });
  out.reasons = [...new Set(out.reasons)];
  return out;
};

const strReplaceEffect = (call) => {
  const file = singlePath(call);
  const reasons = file === null ? ['no_single_path'] : [];
  return result('edit', { edits: [{ file, call: call.index, n: call.n, cls: editClass(file) }], reasons });
};

/** Permission of a call; calls built without the parser's field fall back to allow. */
const permissionOf = (call) => {
  if (typeof call.permission === 'string') return call.permission;
  if (call.allow === true) return 'allowed';
  if (call.allow === false) return 'blocked';
  return 'unknown';
};

const byTool = (call, permission) => {
  if (permission === 'blocked') return result('blocked', { reasons: ['blocked'] });
  if (permission !== 'allowed' && permission !== 'not_recorded') return unknownEffect('allow_unknown');
  switch (call.tool) {
    case 'read_file': return readFileEffect(call);
    case 'str_replace': return strReplaceEffect(call);
    case 'web_fetch': return result('other');
    case 'list_directory': return result('search');
    case 'search': return result('search', { hiddenRequest: true, reasons: ['search_tool'] });
    case 'execute_bash': return call.cmd === null ? unknownEffect('cmd_unknown') : shellEffect(call);
    default: return unknownEffect('unknown_tool');
  }
};

/**
 * Classifies one call. An absent allow (permission not_recorded) is classified as an attempt,
 * like an allowed call; a malformed allow stays unknown. Requests on OUTSIDE are dropped.
 * @param {Call} call
 * @returns {Effect}
 */
export function classify(call) {
  const permission = permissionOf(call);
  const e = byTool(call, permission);
  e.requests = e.requests.filter((r) => r.file !== OUTSIDE);
  e.permission = permission;
  return e;
}

// ---- shell ----

const NEUTRAL = new Set(['echo', 'printf', 'true', 'false', 'sort', 'cut', 'tr', 'uniq']);
const RUNNERS = new Set(['node', 'bash', 'sh', 'zsh', 'perl', 'ruby', 'php', 'eval', 'exec', 'source', '.']);
const REQUEST_PROGRAMS = new Set(['cat', 'nl', 'head', 'tail', 'wc', 'sed']);
const SEARCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ls', 'find', 'pwd', 'which']);
const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const NO_WRITE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PIPE_OPS = new Set(['|', '|&']);

const isPython = (name) => /^python[0-9.]*$/.test(name);
const basename = (text) => text.slice(text.lastIndexOf('/') + 1);
const isOption = (w) => w.text.startsWith('-') && w.text !== '-';
const isStatic = (w) => !w.dynamic && !w.glob;

/** Segment accumulator. category null means neutral. */
const blank = () => ({ category: null, requests: [], edits: [], hiddenEdit: false, hiddenRequest: false, reasons: [] });

const hide = (acc, reason, edit = true, request = true) => {
  if (edit) acc.hiddenEdit = true;
  if (request) acc.hiddenRequest = true;
  acc.reasons.push(reason);
};

/** Index of the program word after NAME=value, env and timeout prefixes. */
const stripPrefixes = (words) => {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i].text)) i += 1;
  if (i < words.length && words[i].text === 'env') {
    i += 1;
    while (i < words.length) {
      const t = words[i].text;
      if (t === '-u') i += 2;
      else if (t.startsWith('-') || ASSIGNMENT.test(t)) i += 1;
      else break;
    }
  }
  if (i < words.length && words[i].text === 'timeout') {
    i += 1;
    while (i < words.length && words[i].text.startsWith('-')) {
      const t = words[i].text;
      i += t === '-s' || t === '-k' ? 2 : 1;
    }
    i += 1;
  }
  return i;
};

/** File key of an operand, or null with hiddenRequest set. */
const fileKey = (acc, w, cwd) => {
  if (!isStatic(w)) {
    hide(acc, 'dynamic_operand', false, true);
    return null;
  }
  const key = resolve(w.text, cwd);
  if (key === null) hide(acc, 'unresolved_path', false, true);
  return key;
};

/** Module run by `python -m`, or null. Stops at -c, which runs inline code. */
const pythonModule = (args, cutAt) => {
  for (let k = 0; k < args.length && isOption(args[k]); k += 1) {
    if (args[k].text === '-c') return null;
    if (args[k].text === '-m') {
      const mod = args[k + 1];
      if (!mod || (cutAt !== null && mod.end >= cutAt)) return null;
      return mod.text;
    }
  }
  return null;
};

/**
 * Category of a program word alone, for xargs, find -exec and cut segments.
 * Neutral programs give 'other'.
 */
const categoryOf = (prog, args = [], cutAt = null) => {
  if (!prog || !isStatic(prog)) return 'unknown';
  const name = basename(prog.text);
  if (REQUEST_PROGRAMS.has(name)) return 'request';
  if (SEARCH_PROGRAMS.has(name)) return 'search';
  if (name === 'git') return 'vcs';
  if (name === 'pytest' || name === 'py.test') return 'test';
  if (isPython(name)) {
    const mod = pythonModule(args, cutAt);
    return mod === 'pytest' || mod === 'unittest' ? 'test' : 'run';
  }
  if (RUNNERS.has(name)) return 'run';
  if (NEUTRAL.has(name) || name === 'cd') return 'other';
  return 'unknown';
};

const catLike = (acc, args, cwd, call) => {
  const files = args.filter((w) => !isOption(w) && w.text !== '-');
  if (files.length === 0) return;
  acc.category = 'request';
  for (const w of files) {
    const key = fileKey(acc, w, cwd);
    if (key !== null) acc.requests.push(lineRequest(call, key, 1, null));
  }
};

const parseCount = (s) => (typeof s === 'string' && /^\d+$/.test(s) && Number(s) >= 1 ? Number(s) : null);

const head = (acc, args, cwd, call) => {
  let count = 10;
  let locate = true;
  const files = [];
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k].text;
    let m;
    if (t === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (t === '-n' || t === '--lines') {
      const c = parseCount(args[k + 1]?.text);
      k += 1;
      if (c === null) locate = false;
      else count = c;
    } else if ((m = /^-n(.+)$/.exec(t)) || (m = /^--lines=(.+)$/.exec(t)) || (m = /^-(\d+)$/.exec(t))) {
      const c = parseCount(m[1]);
      if (c === null) locate = false;
      else count = c;
    } else if (t === '-c' || t === '--bytes') {
      k += 1;
      locate = false;
    } else if (isOption(args[k])) {
      locate = false;
    } else {
      files.push(args[k]);
    }
  }
  if (files.length === 0) return;
  acc.category = 'request';
  for (const w of files) {
    const key = fileKey(acc, w, cwd);
    if (key !== null) acc.requests.push(locate ? lineRequest(call, key, 1, count) : mkRequest(call, key, 'unlocated'));
  }
};

/** tail and wc: every file operand is a request with unknown lines. */
const unlocatedFiles = (acc, args, cwd, call, argOptions) => {
  const files = [];
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k].text;
    if (t === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (argOptions.has(t)) k += 1;
    else if (isOption(args[k]) || /^\+\d+$/.test(t)) continue;
    else files.push(args[k]);
  }
  if (files.length === 0) return;
  acc.category = 'request';
  for (const w of files) {
    const key = fileKey(acc, w, cwd);
    if (key !== null) acc.requests.push(mkRequest(call, key, 'unlocated'));
  }
};

const find = (acc, args) => {
  let category = null;
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k].text;
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      hide(acc, 'find_exec');
      category = higher(category, categoryOf(args[k + 1]));
    } else if (t === '-delete' || t.startsWith('-fprint') || t === '-fls') {
      hide(acc, 'find_write', true, false);
    }
  }
  acc.category = category ?? 'search';
};

const XARGS_ARG_OPTIONS = new Set(['-I', '-n', '-L', '-P', '-d', '-s', '-E', '-a']);

const xargs = (acc, args) => {
  let k = 0;
  while (k < args.length && isOption(args[k])) k += XARGS_ARG_OPTIONS.has(args[k].text) ? 2 : 1;
  acc.category = k < args.length ? categoryOf(args[k], args.slice(k + 1)) : 'other';
  hide(acc, 'xargs');
};

const neutral = (acc, name, args) => {
  if (name === 'sort' && args.some((w) => /^-o/.test(w.text) || w.text.startsWith('--output'))) {
    acc.category = 'unknown';
    hide(acc, 'sort_output');
    return;
  }
  if ((name === 'sort' || name === 'cut' || name === 'uniq') && args.some((w) => !isOption(w))) {
    hide(acc, 'filter_operand', false, true);
  }
};

/** New cwd after `cd`; null when it cannot be followed. */
const cdTarget = (args, cwd, piped) => {
  if (piped || args.length !== 1) return null;
  const w = args[0];
  if (w.text === '-' || !isStatic(w) || isOption(w)) return null;
  return absolute(w.text, cwd);
};

const GREP_FLAGS = new Set('nilLcvwxohHsqEFGPrRaIzZUTbu0123456789'.split(''));
const GREP_ARG = new Set(['e', 'A', 'B', 'C', 'm', 'd', 'D']);
const GREP_LONG_FLAGS = new Set(['line-number', 'ignore-case', 'files-with-matches', 'files-without-match', 'count',
  'invert-match', 'word-regexp', 'line-regexp', 'only-matching', 'no-filename', 'with-filename', 'no-messages',
  'quiet', 'silent', 'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'recursive',
  'dereference-recursive', 'text', 'null', 'color', 'colour', 'byte-offset', 'initial-tab', 'null-data']);
const GREP_LONG_ARG = new Set(['regexp', 'include', 'exclude', 'exclude-dir', 'context', 'after-context',
  'before-context', 'max-count', 'color', 'colour', 'binary-files', 'devices', 'directories', 'label']);

const grep = (acc, args, cwd, call) => {
  acc.category = 'search';
  let recursive = false;
  let patternGiven = false;
  const operands = [];
  const unparsed = () => hide(acc, 'grep_option', false, true);
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k];
    const t = w.text;
    if (t === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
      const value = eq === -1 ? null : t.slice(eq + 1);
      if (name === 'recursive' || name === 'dereference-recursive') recursive = true;
      if (eq === -1 && GREP_LONG_FLAGS.has(name)) continue;
      if (!GREP_LONG_ARG.has(name)) return unparsed();
      const v = eq === -1 ? args[k + 1]?.text : value;
      if (eq === -1) k += 1;
      if (name === 'regexp') patternGiven = true;
      if (name === 'directories' && v === 'recurse') recursive = true;
      continue;
    }
    if (isOption(w)) {
      for (let j = 1; j < t.length; j += 1) {
        const ch = t[j];
        if (GREP_FLAGS.has(ch)) {
          if (ch === 'r' || ch === 'R') recursive = true;
          continue;
        }
        if (!GREP_ARG.has(ch)) return unparsed();
        let v = t.slice(j + 1);
        if (v === '') {
          v = args[k + 1]?.text;
          k += 1;
        }
        if (ch === 'e') patternGiven = true;
        if (ch === 'd' && v === 'recurse') recursive = true;
        break;
      }
      continue;
    }
    operands.push(w);
  }
  const files = patternGiven ? operands : operands.slice(1);
  if (recursive || files.length === 0) return;
  for (const w of files) {
    const key = fileKey(acc, w, cwd);
    if (key !== null) acc.requests.push(mkRequest(call, key, 'unlocated'));
  }
};

/**
 * An edit attempt by a write program (sed -i, tee) on one operand key.
 * A null key is an unknown target and sets hiddenEdit.
 */
const writeTarget = (acc, key, call, reason) => {
  acc.edits.push({ file: key, call: call.index, n: call.n, cls: editClass(key) });
  if (key === null) {
    hide(acc, reason, true, false);
    acc.category = higher(acc.category, 'unknown');
  } else if (!key.startsWith('/')) {
    acc.category = higher(acc.category, 'edit');
  }
};

/** Key of a write operand, or null when it is dynamic, a glob, `-` or unresolvable. */
const writeKey = (w, cwd) => (isStatic(w) && w.text !== '-' ? resolve(w.text, cwd) : null);

const SED_SHORT_FLAGS = new Set(['n', 'E', 'r', 's', 'u', 'z']);
const SED_LONG_FLAGS = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data']);
const SED_PLAIN = new Set('=dDgGhHnNpPxzF'.split(''));
const SED_COUNTED = new Set(['q', 'Q', 'l', 'L']);

/**
 * Scans a static sed script for commands that touch files the operands do not name:
 * `w`, `W`, `e` and the `w`/`e` flags of `s` write or run; `r`, `R` read.
 * A script it cannot follow counts as both.
 * @param {string} s
 * @returns {{ write: boolean, read: boolean }}
 */
const sedScriptEffects = (s) => {
  const len = s.length;
  const fail = { write: true, read: true };
  let i = 0;
  let write = false;
  let read = false;
  const digits = () => {
    const from = i;
    while (i < len && s[i] >= '0' && s[i] <= '9') i += 1;
    return i > from;
  };
  const spaces = () => {
    while (i < len && (s[i] === ' ' || s[i] === '\t')) i += 1;
  };
  const toLineEnd = () => {
    while (i < len && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
  };
  const toLabelEnd = () => {
    while (i < len && s[i] !== ';' && s[i] !== '\n') i += 1;
  };
  // Reads up to and past delimiter d. False when unclosed.
  const part = (d) => {
    while (i < len) {
      const ch = s[i];
      if (ch === '\\') i += 2;
      else if (ch === '\n') return false;
      else {
        i += 1;
        if (ch === d) return true;
      }
    }
    return false;
  };
  // true: an address was read; false: none here; null: malformed.
  const address = () => {
    if (digits()) {
      if (s[i] === '~') {
        i += 1;
        if (!digits()) return null;
      }
      return true;
    }
    if (s[i] === '$') {
      i += 1;
      return true;
    }
    if (s[i] === '/' || s[i] === '\\') {
      const d = s[i] === '\\' ? s[i + 1] : '/';
      i += s[i] === '\\' ? 2 : 1;
      if (d === undefined || d === '\n' || !part(d)) return null;
      while (s[i] === 'I' || s[i] === 'M') i += 1;
      return true;
    }
    return false;
  };
  // After a command: only blanks, then ; newline } or the end.
  const ended = () => {
    spaces();
    return i >= len || s[i] === ';' || s[i] === '\n' || s[i] === '}';
  };
  while (i < len) {
    while (i < len && (s[i] === ' ' || s[i] === '\t' || s[i] === ';' || s[i] === '\n')) i += 1;
    if (i >= len) break;
    const a = address();
    if (a === null) return fail;
    if (a) {
      spaces();
      if (s[i] === ',') {
        i += 1;
        spaces();
        if (s[i] === '+' || s[i] === '~') {
          i += 1;
          if (!digits()) return fail;
        } else if (address() !== true) return fail;
      }
    }
    spaces();
    while (s[i] === '!') {
      i += 1;
      spaces();
    }
    const c = s[i];
    i += 1;
    if (c === '{') continue;
    if (c === '#') {
      toLineEnd();
      continue;
    }
    if (c === '}' || SED_PLAIN.has(c)) {
      if (!ended()) return fail;
    } else if (SED_COUNTED.has(c)) {
      spaces();
      digits();
      if (!ended()) return fail;
    } else if (c === 's' || c === 'y') {
      const d = s[i];
      if (d === undefined || d === '\n' || d === '\\' || d === ' ') return fail;
      i += 1;
      if (!part(d) || !part(d)) return fail;
      if (c === 's') {
        while (i < len && /[0-9gpiImMe]/.test(s[i])) {
          if (s[i] === 'e') write = true;
          i += 1;
        }
        if (s[i] === 'w') {
          write = true;
          toLineEnd();
          continue;
        }
      }
      if (!ended()) return fail;
    } else if (c === 'w' || c === 'W' || c === 'e') {
      write = true;
      toLineEnd();
    } else if (c === 'r' || c === 'R') {
      read = true;
      toLineEnd();
    } else if (c === 'a' || c === 'i' || c === 'c') {
      toLineEnd();
    } else if (c === 'b' || c === 't' || c === 'T' || c === ':' || c === 'v') {
      toLabelEnd();
    } else {
      return fail;
    }
  }
  return { write, read };
};

/**
 * Reads sed options. `inplace` is null when not in place, else the backup suffix ('' for none).
 * `ambiguous` is set for a bare -i followed by '' or a word starting with '.', which BSD sed
 * reads as a suffix and GNU sed as the script.
 */
const sedOptions = (args) => {
  const o = { quiet: false, inplace: null, ambiguous: false, unparsed: false, scripts: [], operands: [] };
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k];
    const t = w.text;
    if (t === '--') {
      o.operands.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith('--')) {
      if (t === '--quiet' || t === '--silent') o.quiet = true;
      else if (SED_LONG_FLAGS.has(t)) continue;
      else if (t === '--in-place') o.inplace = '';
      else if (t.startsWith('--in-place=')) o.inplace = t.slice('--in-place='.length);
      else if (t === '--expression') {
        o.scripts.push(args[k + 1] ?? null);
        k += 1;
      } else if (t.startsWith('--expression=')) o.scripts.push({ ...w, text: t.slice('--expression='.length) });
      else o.unparsed = true;
      continue;
    }
    if (!isOption(w)) {
      o.operands.push(w);
      continue;
    }
    for (let j = 1; j < t.length; j += 1) {
      const ch = t[j];
      if (SED_SHORT_FLAGS.has(ch)) {
        if (ch === 'n') o.quiet = true;
        continue;
      }
      if (ch === 'i') {
        o.inplace = t.slice(j + 1);
        const nx = args[k + 1];
        if (o.inplace === '' && nx && !isOption(nx) && (nx.text === '' || nx.text.startsWith('.'))) o.ambiguous = true;
      } else if (ch === 'e') {
        const rest = t.slice(j + 1);
        if (rest === '') {
          o.scripts.push(args[k + 1] ?? null);
          k += 1;
        } else o.scripts.push({ ...w, text: rest });
      } else {
        o.unparsed = true;
      }
      break;
    }
  }
  if (o.scripts.includes(null)) o.unparsed = true;
  return o;
};

/** sed -i: an edit attempt on each file operand, plus its backup when a suffix is given. */
const sedInPlace = (acc, o, scripts, operands, cwd, call) => {
  if (o.unparsed || o.ambiguous || scripts.length === 0 || operands.length === 0) {
    acc.category = 'unknown';
    hide(acc, 'sed');
    return;
  }
  for (const s of scripts) {
    if (!isStatic(s)) {
      hide(acc, 'sed_script', true, false);
      continue;
    }
    const fx = sedScriptEffects(s.text);
    if (fx.write) hide(acc, 'sed_script', true, false);
    if (fx.read) hide(acc, 'sed_script', false, true);
  }
  const template = /[*/]/.test(o.inplace);
  if (template) hide(acc, 'sed_backup', true, false);
  for (const w of operands) {
    const key = writeKey(w, cwd);
    writeTarget(acc, key, call, 'sed_target');
    if (key !== null && o.inplace !== '' && !template) writeTarget(acc, key + o.inplace, call, 'sed_target');
  }
};

const TEE_LONG_FLAGS = new Set(['--append', '--ignore-interrupts', '--output-error']);

/** tee: an edit attempt on each file operand. */
const tee = (acc, args, cwd, call) => {
  const files = [];
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k];
    const t = w.text;
    if (t === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (TEE_LONG_FLAGS.has(t) || t.startsWith('--output-error=') || /^-[aip]+$/.test(t)) continue;
    if (isOption(w)) {
      acc.category = 'unknown';
      hide(acc, 'tee_option');
      return;
    }
    files.push(w);
  }
  for (const w of files) {
    if (isStatic(w) && NO_WRITE_TARGETS.has(w.text)) continue;
    writeTarget(acc, writeKey(w, cwd), call, 'tee_target');
  }
};

const sed = (acc, args, cwd, call) => {
  const o = sedOptions(args);
  const scripts = [...o.scripts];
  const operands = [...o.operands];
  if (scripts.length === 0 && operands.length > 0) scripts.push(operands.shift());
  if (o.inplace !== null) {
    sedInPlace(acc, o, scripts, operands, cwd, call);
    return;
  }
  const { quiet, unparsed } = o;
  if (operands.length === 0 && !unparsed) return;
  const m = scripts.length === 1 ? /^(\d+)(?:,(\d+))?p$/.exec(scripts[0].text) : null;
  if (quiet && !unparsed && m && operands.length > 0) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a >= 1 && b >= a) {
      acc.category = 'request';
      for (const w of operands) {
        const key = fileKey(acc, w, cwd);
        if (key !== null) acc.requests.push(lineRequest(call, key, a, b));
      }
      return;
    }
  }
  acc.category = 'unknown';
  hide(acc, 'sed');
};

const GIT_READ_ONLY = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'blame', 'ls-files', 'grep']);

const git = (acc, args) => {
  acc.category = 'vcs';
  if (args.some((w) => w.text.startsWith('--output'))) hide(acc, 'git_output', true, false);
  let k = 0;
  while (k < args.length && args[k].text.startsWith('-')) k += args[k].text === '-C' || args[k].text === '-c' ? 2 : 1;
  const sub = args[k];
  if (!sub) return;
  const rest = args.slice(k + 1);
  if (isStatic(sub) && GIT_READ_ONLY.has(sub.text)) return;
  if (sub.text === 'stash' && rest.length > 0 && (rest[0].text === 'list' || rest[0].text === 'show')) return;
  if (sub.text === 'branch' && (rest.some((w) => w.text === '--list' || w.text === '-l') || rest.every(isOption))) return;
  hide(acc, 'git_write', true, false);
};

/** Fills acc for one program. `cd` is handled by the caller. */
const runProgram = (acc, prog, args, cwd, call) => {
  const name = basename(prog.text);
  if (name === 'cat' || name === 'nl') catLike(acc, args, cwd, call);
  else if (name === 'head') head(acc, args, cwd, call);
  else if (name === 'sed') sed(acc, args, cwd, call);
  else if (name === 'tee') tee(acc, args, cwd, call);
  else if (name === 'tail') unlocatedFiles(acc, args, cwd, call, new Set(['-n', '-c', '--lines', '--bytes']));
  else if (name === 'wc') unlocatedFiles(acc, args, cwd, call, new Set());
  else if (name === 'grep' || name === 'egrep' || name === 'fgrep') grep(acc, args, cwd, call);
  else if (name === 'rg') {
    acc.category = 'search';
    hide(acc, 'rg', false, true);
  } else if (name === 'find') find(acc, args);
  else if (name === 'ls' || name === 'pwd' || name === 'which') acc.category = 'search';
  else if (NEUTRAL.has(name)) neutral(acc, name, args);
  else if (name === 'git') git(acc, args);
  else if (name === 'xargs') xargs(acc, args);
  else {
    const category = categoryOf(prog, args);
    acc.category = category;
    hide(acc, category === 'test' ? 'test_runner' : category === 'run' ? 'interpreter' : 'unknown_program');
  }
};

const applyRedirects = (acc, seg, cwd, call) => {
  for (const r of seg.redirects) {
    if (r.dup || r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue;
    const t = r.target;
    if (t !== null && isStatic(t) && NO_WRITE_TARGETS.has(t.text)) continue;
    if (!WRITE_OPS.has(r.op)) {
      if (t === null) {
        hide(acc, 'redirect_target', false, true);
        continue;
      }
      const key = fileKey(acc, t, cwd);
      if (key !== null) {
        acc.requests.push(mkRequest(call, key, 'unlocated'));
        acc.category = higher(acc.category, 'request');
      }
      continue;
    }
    const key = t !== null && isStatic(t) ? resolve(t.text, cwd) : null;
    if (key === null) hide(acc, 'redirect_target', true, false);
    acc.edits.push({ file: key, call: call.index, n: call.n, cls: editClass(key) });
    if (key !== null && !key.startsWith('/')) acc.category = higher(acc.category, 'edit');
  }
};

/** Effect of one complete segment and the cwd after it. */
const segmentEffect = (seg, k, segments, cwd, call) => {
  const acc = blank();
  const prev = k > 0 ? segments[k - 1] : null;
  const piped = PIPE_OPS.has(seg.op) || seg.op === '&' || (prev !== null && PIPE_OPS.has(prev.op));
  const start = stripPrefixes(seg.words);
  const prog = start < seg.words.length ? seg.words[start] : null;
  const args = seg.words.slice(start + 1);
  if (seg.group || (prog !== null && !isStatic(prog))) {
    acc.category = 'unknown';
    hide(acc, seg.group ? 'group' : 'dynamic_program');
    return { acc, cwd: null };
  }
  const isCd = prog !== null && prog.text === 'cd';
  let next = cwd;
  if (isCd) next = cdTarget(args, cwd, piped);
  else if (prog !== null) runProgram(acc, prog, args, cwd, call);
  if (seg.exec) {
    acc.requests = [];
    acc.edits = [];
    hide(acc, 'substitution');
    return { acc, cwd: isCd ? null : next };
  }
  applyRedirects(acc, seg, cwd, call);
  return { acc, cwd: next };
};

/** Category a cut segment may add: only when its program word ended before the cut. */
const cutCategory = (seg, cutAt) => {
  if (seg.group) return 'unknown';
  const start = stripPrefixes(seg.words);
  const prog = seg.words[start];
  if (!prog || prog.end >= cutAt) return null;
  const category = categoryOf(prog, seg.words.slice(start + 1), cutAt);
  return category === 'other' ? null : category;
};

function shellEffect(call) {
  const { segments, cutAt } = lex(call.cmd, call.truncated);
  const out = result('other');
  let cwd = ROOT;
  let category = null;
  segments.forEach((seg, k) => {
    if (seg.cut) {
      category = higher(category, cutCategory(seg, cutAt));
      return;
    }
    const { acc, cwd: next } = segmentEffect(seg, k, segments, cwd, call);
    cwd = next;
    category = higher(category, acc.category);
    out.requests.push(...acc.requests);
    out.edits.push(...acc.edits);
    out.hiddenEdit = out.hiddenEdit || acc.hiddenEdit;
    out.hiddenRequest = out.hiddenRequest || acc.hiddenRequest;
    out.reasons.push(...acc.reasons);
  });
  if (call.truncated === true) {
    out.hiddenEdit = true;
    out.hiddenRequest = true;
    out.reasons.push('truncated');
  }
  out.category = category ?? (call.truncated === true ? 'unknown' : 'other');
  out.reasons = [...new Set(out.reasons)];
  return out;
}
