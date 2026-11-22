// Tests for scripts/hooks/write-guard.mjs.
// Run: node --permission --allow-fs-read=. test/write-guard.test.mjs
// No files are written, no processes spawned, no network used.
// Secret-shaped and home-path fixtures are assembled at run time so this
// file never contains them literally and does not trip the guard itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, logEntry } from '../scripts/hooks/write-guard.mjs';

const CWD = '/work/proj';

const event = (toolInput, extra = {}) => JSON.stringify({
  hook_event_name: 'preToolUse',
  cwd: CWD,
  tool_name: 'fs_write',
  tool_input: toolInput,
  ...extra,
});
const create = (path, text) => event({ command: 'create', path, file_text: text });

const expectBlock = (raw, rule, why, options) => {
  const d = decide(raw, options);
  assert.equal(d.decision, 'block', `expected a block with rule ${rule} because ${why}; got ${d.decision} (${d.rule})`);
  assert.equal(d.rule, rule, `expected rule ${rule} because ${why}; got ${d.rule}`);
  return d;
};
const expectAllow = (raw, why, options) => {
  const d = decide(raw, options);
  assert.equal(d.decision, 'allow', `expected allow because ${why}; got block (${d.rule}: ${d.reason})`);
  return d;
};

// Fake file system for symlink tests: known paths resolve, others are missing.
const fakeRealpath = (known) => (p) => {
  if (Object.hasOwn(known, p)) {
    const v = known[p];
    if (v instanceof Error) throw v;
    return v;
  }
  const err = new Error('missing');
  err.code = 'ENOENT';
  throw err;
};
const withCode = (code) => Object.assign(new Error(code), { code });

const linuxHome = ['', 'home', 'alice', 'code', 'app.js'].join('/');
const macHome = ['', 'Users', 'bob', 'Desktop'].join('/');
const dashes = '-'.repeat(5);
const keyBlock = dashes + 'BEGIN ' + 'OPENSSH ' + 'PRIVATE ' + 'KEY' + dashes;
const rsaKeyBlock = dashes + 'BEGIN ' + 'RSA ' + 'PRIVATE ' + 'KEY' + dashes;
const tokens = {
  'AWS access key': 'AK' + 'IA' + 'Q'.repeat(16),
  'GitHub classic token': 'gh' + 'p_' + 'a1'.repeat(18),
  'GitHub fine-grained token': 'github' + '_pat_' + 'B'.repeat(30),
  'Slack token': 'xo' + 'xb-' + '1234567890-abc',
  'OpenAI project key': 'sk' + '-proj-' + 'x'.repeat(30),
  'Anthropic key': 'sk' + '-ant-' + 'api03-' + 'y'.repeat(30),
  'Google API key': 'AI' + 'za' + 'C'.repeat(35),
  'Stripe live key': 'sk' + '_live_' + 'D'.repeat(24),
  'JSON web token': ['ey' + 'J' + 'h'.repeat(12), 'ey' + 'J' + 'p'.repeat(12), 's'.repeat(16)].join('.'),
};

// ---- allowed writes ----

test('allows a plain write inside the project and reports a project-relative path', () => {
  const d = expectAllow(create('docs/notes.md', 'Plain text.'), 'docs/notes.md is inside cwd and has no banned content');
  assert.equal(d.path, 'docs/notes.md', 'path should be relative to cwd with / separators');
  assert.equal(d.rule, 'ok');
});

test('allows an absolute target inside the project', () => {
  const d = expectAllow(create('/work/proj/src/core/parse.js', 'export const a = 1;'), 'the absolute path is inside cwd');
  assert.equal(d.path, 'src/core/parse.js');
});

test('allows an empty file', () => {
  expectAllow(create('src/core/empty.js', ''), 'empty content has nothing to scan');
});

// ---- fail closed on bad input ----

test('blocks input that cannot be parsed or is incomplete', () => {
  expectBlock('not json', 'input-invalid', 'stdin is not JSON');
  expectBlock('', 'input-invalid', 'stdin is empty');
  expectBlock(null, 'input-invalid', 'stdin could not be read');
  expectBlock('[]', 'input-invalid', 'the event is an array, not an object');
  expectBlock(JSON.stringify({ tool_input: { path: 'a.md', file_text: 'x' } }), 'input-invalid', 'cwd is missing');
  expectBlock(JSON.stringify({ cwd: 'work/proj', tool_input: { path: 'a.md' } }), 'input-invalid', 'cwd is relative');
  expectBlock(JSON.stringify({ cwd: CWD, tool_name: 'fs_write' }), 'input-invalid', 'tool_input is missing');
  expectBlock(event({ command: 'create', file_text: 'x' }), 'input-invalid', 'there is no target path');
  expectBlock(event({ path: '  ', file_text: 'x' }), 'input-invalid', 'the target path is blank');
  expectBlock(event({ path: 'a.md', file_path: 'b.md', file_text: 'x' }), 'input-invalid', 'two different target paths are given');
  expectBlock(event({ path: 'a.md', file_text: ['x'] }), 'input-invalid', 'a content field is an array and cannot be scanned');
  expectBlock(event({ path: 'a\0.md', file_text: 'x' }), 'input-invalid', 'the path contains NUL');
  expectBlock(event({ path: '.', file_text: 'x' }), 'input-invalid', 'the target is cwd itself');
});

// ---- target outside cwd ----

test('blocks targets outside the project directory', () => {
  expectBlock(create('../other/x.md', 'x'), 'outside-cwd', '../ leaves cwd');
  expectBlock(create('/etc/hosts', 'x'), 'outside-cwd', 'an absolute path outside cwd');
  expectBlock(create('/work/proj-other/x.md', 'x'), 'outside-cwd', 'a sibling folder sharing the cwd prefix is still outside');
  expectBlock(create('src/../../x.md', 'x'), 'outside-cwd', 'the path normalizes to outside cwd');
  expectBlock(create('~/x.md', 'x'), 'outside-cwd', 'a ~ path points at a home directory');
});

test('reports no path for blocked outside targets', () => {
  const d = decide(create('/etc/hosts', 'x'));
  assert.equal(d.path, null, 'outside targets must not be logged, so path should be null');
});

test('blocks a symlink inside the project that leads outside', () => {
  const realpath = fakeRealpath({ [CWD]: CWD, [CWD + '/link']: '/outside/dir' });
  expectBlock(create('link/new.md', 'x'), 'outside-cwd', 'link resolves to /outside/dir', { realpath });
});

test('blocks when the target cannot be resolved', () => {
  const denied = fakeRealpath({ [CWD]: CWD, [CWD + '/src']: withCode('ERR_ACCESS_DENIED') });
  expectBlock(create('src/a.js', 'x'), 'path-unresolved', 'realpath was denied', { realpath: denied });
  const dangling = fakeRealpath({ [CWD]: CWD, [CWD + '/out.md']: withCode('EDANGLING') });
  expectBlock(create('out.md', 'x'), 'path-unresolved', 'out.md is a dangling symlink', { realpath: dangling });
});

test('resolves a new file below an existing real directory', () => {
  const realpath = fakeRealpath({ [CWD]: CWD, [CWD + '/src']: CWD + '/src' });
  const d = expectAllow(create('src/ui/new.js', 'export const x = 1;'), 'src exists inside cwd and the rest is new', { realpath });
  assert.equal(d.path, 'src/ui/new.js');
});

test('blocks writes into build-evidence, which only hooks write', () => {
  expectBlock(create('build-evidence/write-guard.jsonl', '{}'), 'protected-path', 'an agent must not edit decision logs');
});

// ---- home paths, keys and tokens in any file ----

test('blocks absolute home paths in new text', () => {
  expectBlock(create('docs/a.md', 'See ' + linuxHome), 'home-path', 'a Linux home path is personal data');
  expectBlock(create('docs/a.md', 'cd ' + macHome), 'home-path', 'a macOS home path is personal data');
  expectBlock(create('docs/a.md', '"' + linuxHome + '"'), 'home-path', 'a quoted home path is still a home path');
  expectBlock(create('test/fixtures/a.jsonl', 'file:/' + linuxHome), 'home-path', 'test files are scanned for home paths too');
});

test('allows paths that only look similar to home paths', () => {
  expectAllow(create('docs/a.md', 'The samples use /workspace, /lab and /redacted-home.'), 'these are the sanitized placeholders');
  expectAllow(create('docs/a.md', 'https://example.com/home/docs'), 'a URL path segment named home is not a home directory');
  expectAllow(create('docs/a.md', './home/x and api/Users/1'), 'relative paths are not absolute home paths');
});

test('blocks private key blocks', () => {
  expectBlock(create('notes.txt', keyBlock + '\nabc'), 'private-key', 'an OpenSSH private key header');
  expectBlock(create('notes.txt', rsaKeyBlock), 'private-key', 'an RSA private key header');
});

test('blocks common API token shapes', () => {
  for (const [name, value] of Object.entries(tokens)) {
    expectBlock(create('config.txt', 'token = ' + value), 'api-token', `the value is shaped like a ${name}`);
  }
});

test('allows text that is close to a token shape but is not one', () => {
  expectAllow(create('docs/a.md', 'task-' + 'z'.repeat(30)), 'sk- inside a word is not a key prefix');
  expectAllow(create('docs/a.md', 'AK' + 'IA' + 'short'), 'too short for an AWS key');
});

// ---- site files ----

test('blocks remote loads in site files', () => {
  expectBlock(create('index.html', '<script type="module" src="https://cdn.example.com/x.js"></script>'), 'remote-load', 'a remote script tag');
  expectBlock(create('index.html', '<link rel="stylesheet" href="//fonts.example.com/css">'), 'remote-load', 'a protocol-relative stylesheet');
  expectBlock(create('src/styles/app.css', '@import url("https://cdn.example.com/a.css");'), 'remote-load', 'a remote @import');
  expectBlock(create('src/styles/app.css', '@import "https://cdn.example.com/a.css";'), 'remote-load', 'a remote @import without url()');
  expectBlock(create('src/styles/tokens.css', '@font-face { src: url(https://fonts.example.com/a.woff2); }'), 'remote-load', 'a remote font');
  expectBlock(create('src/ui/main.js', "fetch('https://api.example.com/log');"), 'remote-load', 'a remote fetch');
  expectBlock(create('src/ui/main.js', "import { a } from 'https://cdn.example.com/a.js';"), 'remote-load', 'a remote static import');
  expectBlock(create('src/ui/main.js', "const m = await import('//cdn.example.com/a.js');"), 'remote-load', 'a remote dynamic import');
  expectBlock(create('src/ui/main.js', "const u = `https://api.example.com`; fetch(u);"), 'remote-load', 'a remote URL held in a variable');
  expectBlock(create('src/ui/main.js', "new WebSocket('wss://x.example');"), 'remote-load', 'a remote socket');
  expectBlock(create('src/ui/main.js', "xhr.open('GET', 'https://x.example/a');"), 'remote-load', 'a remote XHR');
});

test('allows local loads and plain links in site files', () => {
  expectAllow(create('index.html', [
    '<link rel="stylesheet" href="./src/styles/app.css">',
    '<script type="module" src="./src/ui/main.js"></script>',
    '<a href="https://github.com/example/session-autopsy">Source</a>',
  ].join('\n')), 'local assets and a navigation link load nothing remote');
  expectAllow(create('src/ui/main.js', "const res = await fetch('./samples/' + name);\n// see https://developer.mozilla.org/"), 'a same-origin fetch and a URL in a comment');
  expectAllow(create('src/styles/app.css', '.x { background: url("./img/a.png"); }'), 'a local url()');
});

test('blocks HTML sinks and dynamic code in site files', () => {
  expectBlock(create('src/ui/dom.js', 'node.innerHTML = text;'), 'html-sink', 'innerHTML parses HTML');
  expectBlock(create('src/ui/dom.js', 'node.outerHTML = text;'), 'html-sink', 'outerHTML parses HTML');
  expectBlock(create('src/ui/dom.js', "node.insertAdjacentHTML('beforeend', text);"), 'html-sink', 'insertAdjacentHTML parses HTML');
  expectBlock(create('src/ui/dom.js', 'document.write(text);'), 'html-sink', 'document.write parses HTML');
  expectBlock(create('src/core/x.mjs', 'node.innerHTML = text;'), 'html-sink', '.mjs outside test/ and scripts/ is a site file');
  expectBlock(create('src/ui/x.js', 'eval(text);'), 'dynamic-code', 'eval runs text as code');
  expectBlock(create('src/ui/x.js', 'const f = (0, eval)(text);'), 'dynamic-code', 'indirect eval runs text as code');
  expectBlock(create('src/ui/x.js', "const f = new Function('a', 'return a');"), 'dynamic-code', 'the Function constructor runs text as code');
  expectBlock(create('src/ui/x.js', "setTimeout('tick()', 10);"), 'dynamic-code', 'a string timer runs text as code');
  expectBlock(create('index.html', '<button onclick="eval(x)">x</button>'), 'dynamic-code', 'eval inside HTML');
});

test('allows code that only resembles sinks or dynamic code', () => {
  expectAllow(create('src/ui/dom.js', 'node.textContent = text;'), 'textContent is the allowed sink');
  expectAllow(create('src/ui/strip.js', 'setTimeout(tick, 120);'), 'a function timer is fine');
  expectAllow(create('src/core/classify.js', 'const SHELL_EVAL = /^\\s*(?:eval|exec|source)\\b/;'), 'a regex that recognizes eval in logged shell commands');
  expectAllow(create('src/core/x.js', 'retrieval(x); evaluate(y); /** @param {Function} f */'), 'words containing eval and a Function type annotation');
});

test('does not apply site rules to tests, scripts or docs', () => {
  const text = "node.innerHTML = x; eval(y); fetch('https://x.example');";
  expectAllow(create('test/dom.test.mjs', text), 'test/ is not part of the site');
  expectAllow(create('scripts/serve.mjs', text), 'scripts/ is not part of the site');
  expectAllow(create('.kiro/steering/tech.md', text), 'markdown is not a site file');
});

test('classifies site files by the resolved path, not the symlink name', () => {
  const realpath = fakeRealpath({ [CWD]: CWD, [CWD + '/test/link']: CWD + '/src/ui' });
  const d = expectBlock(create('test/link/x.js', 'node.innerHTML = t;'), 'html-sink', 'test/link points into src/ui', { realpath });
  assert.equal(d.path, 'src/ui/x.js');
});

// ---- only new text is scanned ----

test('ignores replaced text and scans only new text', () => {
  expectAllow(event({ command: 'str_replace', path: 'src/ui/dom.js', old_str: 'node.innerHTML = t;', new_str: 'node.textContent = t;' }), 'innerHTML is being removed, not added');
  expectAllow(event({ command: 'str_replace', path: 'docs/a.md', oldStr: 'was ' + linuxHome, newStr: 'was /redacted-home' }), 'the home path is being removed (camelCase fields)');
  expectBlock(event({ command: 'str_replace', path: 'src/ui/dom.js', oldStr: 'x', newStr: 'node.innerHTML = t;' }), 'html-sink', 'newStr adds innerHTML');
  expectBlock(event({ command: 'insert', path: 'docs/a.md', insert_line: 3, new_str: linuxHome }), 'home-path', 'insert adds a home path');
  expectBlock(event({ path: 'docs/a.md', content: keyBlock }), 'private-key', 'content is new text');
  expectBlock(event({ path: 'docs/a.md', unexpected_field: tokens['AWS access key'] }), 'api-token', 'unknown string fields are scanned too');
});

// ---- log line ----

test('log entry has only time, path, decision and rule, and no content', () => {
  const d = decide(create('src/ui/x.js', 'el.innerHTML = privateMarkerText;'));
  const line = logEntry(d, '2026-11-22T00:00:00.000Z');
  assert.ok(line.endsWith('\n'), 'each entry should be one JSONL line');
  assert.deepEqual(JSON.parse(line), {
    time: '2026-11-22T00:00:00.000Z',
    path: 'src/ui/x.js',
    decision: 'block',
    rule: 'html-sink',
  }, 'entry should carry exactly these four fields');
  assert.ok(!line.includes('privateMarkerText'), 'content must never be logged');
});

test('log entry for an outside target has a null path', () => {
  const line = logEntry(decide(create('../x.md', 'x')), '2026-11-22T00:00:00.000Z');
  assert.equal(JSON.parse(line).path, null, 'paths outside the project are not logged');
});
