// Boundary test: reads site files as text and checks the rules in tech.md and structure.md.
// No site code is imported or run. Reads only; no writes, processes or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Files under a directory, as repo-relative paths with '/' separators. */
const filesUnder = (dir, ext) => readdirSync(join(ROOT, dir), { recursive: true })
  .map((p) => `${dir}/${String(p).split('\\').join('/')}`)
  .filter((p) => ext.some((e) => p.endsWith(e)))
  .sort();

const CORE = filesUnder('src/core', ['.js']);
const UI = filesUnder('src/ui', ['.js']);
const PROVENANCE = filesUnder('src/provenance', ['.js']);
const CSS = filesUnder('src/styles', ['.css']);
const SCRIPTS = [...CORE, ...PROVENANCE, ...UI];
const SITE = [...SCRIPTS, ...CSS, 'index.html'];

/** Removes block comments and line comments that start a line or follow whitespace. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

const importsOf = (src) => [...src.matchAll(/\bimport\s*(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g), ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)]
  .map((m) => m[1]);

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

test('the expected site modules exist', () => {
  for (const f of ['src/ui/main.js', 'src/ui/dom.js', 'src/ui/summary.js', 'src/ui/strip.js', 'src/ui/apparition.js', 'src/ui/plates.js', 'src/ui/notes.js']) {
    assert.ok(UI.includes(f), `expected ${f} to exist, because structure.md lists it as a ui module`);
  }
  for (const f of ['src/styles/tokens.css', 'src/styles/app.css']) {
    assert.ok(CSS.includes(f), `expected ${f} to exist, because structure.md lists it`);
  }
});

test('core is pure: no DOM, network, storage, clock, randomness or node: imports', () => {
  const banned = [
    ['window', /\bwindow\b/],
    ['document', /\bdocument\s*\./],
    ['navigator', /\bnavigator\b/],
    ['globalThis', /\bglobalThis\b/],
    ['fetch', /\bfetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['Date', /\bDate\b/],
    ['performance', /\bperformance\b/],
    ['Math.random', /\bMath\s*\.\s*random\b/],
    ['require', /\brequire\s*\(/],
    ['process', /\bprocess\s*\./],
  ];
  for (const f of [...CORE, ...PROVENANCE]) {
    const src = stripComments(read(f));
    for (const [name, re] of banned) {
      assert.ok(!re.test(src), `expected no ${name} in ${f}, because tech.md says src/core is pure and runs unchanged under node:test`);
    }
    for (const spec of importsOf(src)) {
      assert.ok(!spec.startsWith('node:'), `expected no node: import in ${f} (found ${spec}), because core also runs in the browser`);
      assert.ok(spec.startsWith('./'), `expected ${f} to import only sibling core modules (found ${spec}), because core never imports ui`);
      assert.ok(spec.endsWith('.js'), `expected ${f} to import with a .js extension (found ${spec}), because browsers need full paths`);
    }
  }
});

test('ui imports only relative paths, and only core or ui modules', () => {
  for (const f of UI) {
    for (const spec of importsOf(read(f))) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../core/') || spec.startsWith('../provenance/'), `expected ${f} to import ./, ../core/ or ../provenance/ paths only (found ${spec}), because the page must work from any subpath with no CDN`);
      assert.ok(spec.endsWith('.js'), `expected ${f} to import with a .js extension (found ${spec})`);
    }
  }
});

test('tests never import ui modules', () => {
  const tests = filesUnder('test', ['.mjs']).filter((f) => f !== 'test/boundaries.test.mjs');
  for (const f of tests) {
    for (const spec of importsOf(read(f))) {
      assert.ok(!spec.includes('/ui/'), `expected ${f} not to import ${spec}, because structure.md says tests import core and the hook only`);
    }
  }
});

test('site code has no HTML sinks or dynamic code', () => {
  const banned = [
    ['innerHTML', /\binnerHTML\b/],
    ['outerHTML', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\s*\.\s*write(?:ln)?\b/],
    ['eval', /(?<![\w$.])eval\s*\(/],
    ['new Function', /\bnew\s+Function\b/],
    ['setTimeout with a string', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
    ['DOMParser', /\bDOMParser\b/],
    ['createContextualFragment', /\bcreateContextualFragment\b/],
    ['srcdoc', /\bsrcdoc\b/],
  ];
  for (const f of SCRIPTS) {
    const src = read(f);
    for (const [name, re] of banned) {
      assert.ok(!re.test(src), `expected no ${name} in ${f}, because tech.md bans it in site code; log text reaches the DOM only as text`);
    }
  }
});

test('site scripts never write style attributes', () => {
  for (const f of UI) {
    const src = read(f);
    assert.ok(!/setAttribute\(\s*['"`]style['"`]/.test(src), `expected no setAttribute('style') in ${f}, because the CSP forbids inline styles; use style.setProperty('--name')`);
    assert.ok(!/\.style\s*=(?!=)/.test(src), `expected no .style assignment in ${f}, because the CSP forbids inline styles`);
    assert.ok(!/\bcssText\b/.test(src), `expected no cssText in ${f}, because dynamic values go through custom properties only`);
  }
});

test('no default exports in site code', () => {
  for (const f of SCRIPTS) {
    assert.ok(!/\bexport\s+default\b/.test(read(f)), `expected no export default in ${f}, because tech.md asks for named exports only`);
  }
});

test('index.html has the exact CSP, one module script and no inline styles', () => {
  const html = read('index.html');
  const csp = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
  assert.equal(csp.length, 1, 'expected one CSP meta tag in index.html, because tech.md requires the browser to enforce it');
  assert.equal(csp[0][1], CSP, 'expected the CSP to equal tech.md word for word');
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  assert.equal(scripts.length, 1, 'expected exactly one script tag in index.html');
  assert.equal(scripts[0][0], '<script type="module" src="./src/ui/main.js">', 'expected the one script to be the module entry point with a relative path');
  assert.ok(/<script type="module" src="\.\/src\/ui\/main\.js"><\/script>/.test(html), 'expected the script tag to have no inline content');
  assert.ok(!/<style\b/i.test(html), 'expected no <style> element, because the CSP has no unsafe-inline for styles');
  assert.ok(!/\sstyle\s*=/i.test(html), 'expected no style= attribute, because the CSP has no unsafe-inline for styles');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'expected no inline event handler attribute, because the CSP has no unsafe-inline for scripts');
});

test('every href and src in index.html is relative', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/\s(?:href|src)\s*=\s*"([^"]*)"/gi)) {
    const url = m[1];
    assert.ok(url.startsWith('./') || url.startsWith('#'), `expected ${url} to start with ./ or #, because the page must work from a subpath and from file://`);
  }
});

test('site files contain no remote URL', () => {
  for (const f of SITE) {
    assert.ok(!/(?:https?|wss?):\/\/|['"(]\/\/[\w-]/.test(read(f)), `expected no remote URL in ${f}, because the only network request is a same-origin sample`);
  }
});

test('the only fetch is a same-origin sample', () => {
  let count = 0;
  for (const f of UI) {
    for (const m of read(f).matchAll(/\bfetch\s*\(\s*([^)]*)/g)) {
      count += 1;
      assert.ok(/^(?:'\.\/samples\/'|`\.\/samples\/)/.test(m[1]), `expected fetch in ${f} to start with ./samples/ (found ${m[1].slice(0, 40)}), because tech.md allows only same-origin samples`);
    }
  }
  assert.ok(count >= 1, 'expected at least one fetch of ./samples/, because the sample buttons need it');
});

test('no storage, cookie, service worker or beacon API in site code', () => {
  const banned = /\b(?:localStorage|sessionStorage|indexedDB|serviceWorker|sendBeacon|WebSocket|EventSource)\b|\bdocument\s*\.\s*cookie\b|\bcaches\s*\./;
  for (const f of [...SCRIPTS, 'index.html']) {
    assert.ok(!banned.test(read(f)), `expected no storage, cookie, service worker or extra network API in ${f}, because a log opened by the user stays in the browser`);
  }
});

test('package.json has no dependencies and runs every test file', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies, undefined, 'expected no dependencies, because tech.md forbids them');
  assert.equal(pkg.devDependencies, undefined, 'expected no devDependencies, because tech.md forbids them');
  const files = filesUnder('test', ['.test.mjs']).map((f) => f.slice('test/'.length));
  for (const f of files) {
    assert.ok(pkg.scripts.test.includes(`node --permission --allow-fs-read=. test/${f}`), `expected npm test to run test/${f} with the permission flags`);
  }
});
