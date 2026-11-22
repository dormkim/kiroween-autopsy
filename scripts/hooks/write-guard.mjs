// write-guard: Kiro CLI preToolUse hook for fs_write.
//
// Reads one hook event as JSON on stdin: { cwd, tool_name, tool_input }.
// Exit 0 allows the write. Exit 2 blocks it, with a short reason on stderr.
// Every decision is appended to build-evidence/write-guard.jsonl as
// { time, path, decision, rule }. Content is never logged.
//
// Registered as:
//   node --permission --allow-fs-read=. --allow-fs-write=build-evidence scripts/hooks/write-guard.mjs
// Uses node: built-ins only. No child process, no network.
//
// Only new text is scanned (file_text, content, new_str, newStr and any other
// string field that is not a path, the replaced text or a control field).
// Patterns are written so that this file and its test do not match themselves.
// Limit: a str_replace whose new text joins with untouched surrounding text to
// form a banned token is not detected. The page's Content Security Policy is
// the run-time layer behind this check.

import { appendFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} Decision
 * @property {'allow' | 'block'} decision
 * @property {string} rule    short code, 'ok' when allowed
 * @property {string} reason  one sentence for stderr, never contains content
 * @property {string | null} path  project-relative target with '/' separators, null when outside or unknown
 */

const PATH_KEYS = new Set(['path', 'file_path', 'filePath']);

// Fields that are not new file text. Everything else that is a string is scanned.
const IGNORED_KEYS = new Set([
  'old_str', 'oldStr', 'old_text', 'oldText',
  'command', 'insert_line', 'insertLine', 'summary', '__tool_use_purpose',
]);

const SITE_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.svg']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const NON_SITE_ROOTS = new Set(['test', 'scripts']);
const PROTECTED_ROOT = 'build-evidence';

// Rules for every file.
const CONTENT_RULES = [
  {
    rule: 'home-path',
    reason: 'new text contains an absolute Linux or macOS home directory path',
    re: /(?<![\w.~-])\/(?:home|Users)\/[A-Za-z0-9._-]+/,
  },
  {
    rule: 'private-key',
    reason: 'new text contains a private key block',
    re: /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-{5}/,
  },
  { rule: 'api-token', reason: 'new text contains a value shaped like an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like an OpenAI or Anthropic key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a Stripe key', re: /\b[rs]k_live_[0-9A-Za-z]{16,}/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a Hugging Face token', re: /\bhf_[A-Za-z]{34}\b/ },
  { rule: 'api-token', reason: 'new text contains a value shaped like a JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

// A remote target: http, https, ws, wss or protocol-relative, followed by a host character.
const REMOTE = String.raw`(?:(?:https?|wss?):)?\/\/[\w-]`;
const QUOTE = '["\'`]';

// Rules for site files (html, js, mjs, css, svg outside test/ and scripts/).
const SITE_RULES = [
  {
    rule: 'remote-load',
    reason: 'site file loads a remote resource through an HTML tag',
    re: new RegExp(String.raw`<(?:script|link|img|iframe|frame|source|video|audio|track|embed|object|base|use|image)\b[^>]*?\s(?:src|href|srcset|data|poster|xlink:href)\s*=\s*["']?\s*` + REMOTE, 'i'),
  },
  {
    rule: 'remote-load',
    reason: 'site file loads a remote stylesheet',
    re: new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?\s*` + REMOTE, 'i'),
  },
  {
    rule: 'remote-load',
    reason: 'site file loads a remote font or image through url()',
    re: new RegExp(String.raw`url\(\s*["']?\s*` + REMOTE, 'i'),
  },
  {
    rule: 'remote-load',
    reason: 'site file fetches or imports a remote URL',
    re: new RegExp(String.raw`\b(?:fetch|import|importScripts|sendBeacon|open|WebSocket|EventSource|Worker|SharedWorker)\s*\(\s*(?:` + QUOTE + String.raw`[A-Za-z]+` + QUOTE + String.raw`\s*,\s*)?` + QUOTE + String.raw`\s*` + REMOTE),
  },
  { rule: 'html-sink', reason: 'site file uses an HTML string sink; use textContent or createElement', re: /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/ },
  { rule: 'html-sink', reason: 'site file uses document.write', re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/ },
  { rule: 'dynamic-code', reason: 'site file calls eval', re: /(?<![\w$])eval\s*(?:\(|\?\.\s*\()|[(,]\s*eval\s*\)/ },
  { rule: 'dynamic-code', reason: 'site file builds code with the Function constructor', re: /\bnew\s+Function\b|(?<![\w$.])Function\s*\(/ },
  { rule: 'dynamic-code', reason: 'site file passes a string to setTimeout or setInterval', re: new RegExp(String.raw`\bset(?:Timeout|Interval)\s*\(\s*` + QUOTE) },
];

// Extra rule for site scripts: any quoted remote URL, so a URL held in a variable is caught too.
const SCRIPT_RULES = [
  {
    rule: 'remote-load',
    reason: 'site script contains a remote URL string',
    re: new RegExp(QUOTE + String.raw`\s*` + REMOTE),
  },
];

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {string} rule
 * @param {string} reason
 * @param {string | null} [path]
 * @returns {Decision}
 */
const block = (rule, reason, path = null) => ({ decision: 'block', rule, reason, path });

/**
 * True when `target` is strictly inside `root`.
 * @param {string} root
 * @param {string} target
 */
const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

/**
 * Resolves symlinks for a path that may not exist yet: resolves the deepest
 * existing ancestor and appends the rest.
 * @param {string} target absolute, already normalized
 * @param {(p: string) => string} realpath throws an error with code ENOENT or ENOTDIR for missing paths
 */
const resolveExisting = (target, realpath) => {
  const rest = [];
  let current = target;
  for (;;) {
    try {
      return join(realpath(current), ...rest);
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : null;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      rest.unshift(basename(current));
      current = parent;
    }
  }
};

/** @param {string} rel project-relative path with '/' separators */
const isSiteFile = (rel) => {
  const root = rel.split('/')[0];
  return SITE_EXTENSIONS.has(extname(rel).toLowerCase()) && !NON_SITE_ROOTS.has(root);
};

/** @param {string} rel */
const isSiteScript = (rel) => SCRIPT_EXTENSIONS.has(extname(rel).toLowerCase());

/**
 * Decides whether one fs_write event may proceed. Pure apart from the
 * injected `realpath`; the default resolves nothing and checks paths lexically.
 *
 * @param {unknown} raw the hook event as received on stdin
 * @param {{ realpath?: (p: string) => string }} [options]
 * @returns {Decision}
 */
export function decide(raw, options = {}) {
  const realpath = options.realpath ?? ((p) => p);

  if (typeof raw !== 'string') return block('input-invalid', 'hook input is not text');
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return block('input-invalid', 'hook input is not valid JSON');
  }
  if (!isPlainObject(event)) return block('input-invalid', 'hook input is not a JSON object');

  const { cwd, tool_input: input } = event;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return block('input-invalid', 'cwd is missing or not an absolute path');
  if (!isPlainObject(input)) return block('input-invalid', 'tool_input is missing or not an object');

  const targets = [];
  const texts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof value !== 'string') return block('input-invalid', 'tool_input has a field that is not text, a number or a boolean');
    if (PATH_KEYS.has(key)) targets.push(value);
    else if (!IGNORED_KEYS.has(key)) texts.push(value);
  }

  const distinct = [...new Set(targets)];
  if (distinct.length !== 1 || distinct[0].trim() === '') return block('input-invalid', 'tool_input does not name exactly one target path');
  const target = distinct[0];
  if (target.includes('\0')) return block('input-invalid', 'target path contains a NUL character');
  if (target.startsWith('~')) return block('outside-cwd', 'target path starts with ~ and is outside the project directory');

  const lexicalRoot = resolve(cwd);
  const lexicalTarget = resolve(lexicalRoot, target);
  if (lexicalTarget === lexicalRoot) return block('input-invalid', 'target path is the project directory itself');
  if (!isInside(lexicalRoot, lexicalTarget)) return block('outside-cwd', 'target path is outside the project directory');

  let realRoot;
  let realTarget;
  try {
    realRoot = realpath(lexicalRoot);
    realTarget = resolveExisting(lexicalTarget, realpath);
  } catch {
    return block('path-unresolved', 'target path could not be resolved inside the project directory');
  }
  if (!isInside(realRoot, realTarget)) return block('outside-cwd', 'target path resolves outside the project directory through a symlink');

  const rel = relative(realRoot, realTarget).split(sep).join('/');
  if (rel === PROTECTED_ROOT || rel.startsWith(PROTECTED_ROOT + '/')) {
    return block('protected-path', 'build-evidence/ is written only by hooks', rel);
  }

  const text = texts.join('\n');
  for (const { rule, reason, re } of CONTENT_RULES) {
    if (re.test(text)) return block(rule, reason, rel);
  }
  if (isSiteFile(rel)) {
    const rules = isSiteScript(rel) ? [...SITE_RULES, ...SCRIPT_RULES] : SITE_RULES;
    for (const { rule, reason, re } of rules) {
      if (re.test(text)) return block(rule, reason, rel);
    }
  }
  return { decision: 'allow', rule: 'ok', reason: 'allowed', path: rel };
}

/**
 * One JSON line for build-evidence/write-guard.jsonl. Never includes content.
 * @param {Decision} result
 * @param {string} time ISO 8601
 * @returns {string}
 */
export function logEntry(result, time) {
  return JSON.stringify({ time, path: result.path, decision: result.decision, rule: result.rule }) + '\n';
}

// ---- process wiring below; not used by tests ----

/** realpathSync that refuses dangling symlinks, so a write cannot follow one out of the project. */
const realpathForHook = (p) => {
  try {
    return realpathSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      let isLink = false;
      try {
        isLink = lstatSync(p).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (isLink) {
        const dangling = new Error('dangling symlink');
        dangling.code = 'EDANGLING';
        throw dangling;
      }
    }
    throw err;
  }
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/** @param {string} line */
const writeLog = (line) => {
  const dir = resolve(process.cwd(), PROTECTED_ROOT);
  const file = join(dir, 'write-guard.jsonl');
  try {
    appendFileSync(file, line);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    mkdirSync(dir);
    appendFileSync(file, line);
  }
};

const main = async () => {
  let raw = null;
  try {
    raw = await readStdin();
  } catch {
    raw = null;
  }

  let result;
  try {
    result = decide(raw, { realpath: realpathForHook });
  } catch {
    result = block('internal-error', 'write guard failed while deciding, so the write is blocked');
  }

  try {
    writeLog(logEntry(result, new Date().toISOString()));
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'error';
    process.stderr.write(`write-guard: could not append to build-evidence/write-guard.jsonl (${code}); decision kept\n`);
  }

  if (result.decision === 'block') {
    process.stderr.write(`write-guard: blocked (${result.rule}): ${result.reason}\n`);
    process.exitCode = 2;
  }
};

const invokedDirectly = typeof process.argv[1] === 'string'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write('write-guard: internal error, write blocked\n');
    process.exitCode = 2;
  });
}
