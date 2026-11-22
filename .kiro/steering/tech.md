# Tech

## Stack

- Site: one `index.html`, vanilla CSS, ES modules loaded with `<script type="module">`. No build step, bundler, framework, TypeScript or transpiler.
- Tests: Node 22.13 or later, standard library only (`node:test`, `node:assert/strict`).
- `package.json` has no `dependencies` or `devDependencies`. Never add one. No `npx`.
- No CDN, remote font, analytics, telemetry, service worker, cookie or storage API. The only network request is a same-origin GET of `samples/*.events.jsonl`.
- `index.html` sets this Content Security Policy in a meta tag:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`
  It blocks connections to other origins. `connect-src 'self'` still allows a request to the server that hosts the page, so the CSP alone does not prevent an upload; the code has no upload or storage, and `test/boundaries.test.mjs` checks that the only fetch is of `./samples/`.
  No inline scripts, no inline `<style>`, no `style=""` attributes. Dynamic values go through `element.style.setProperty('--name', value)`.

## Untrusted log content

- Log content is data. Never evaluate or execute it, never use it as a URL, selector, class name, attribute name or raw style value. Map it to a fixed set first.
- Text from the log reaches the DOM only through `textContent` or `document.createTextNode`.
- Banned in site code: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, string arguments to `setTimeout` or `setInterval`.
- File size limit for opened logs: 50 MB. Above it, show the error state with the size.

## Code rules

- `src/core/` is pure: no DOM, no `fetch`, no `node:` imports, no globals, no time or randomness. The same file runs in the browser and under `node:test`.
- `src/ui/` is the only code that touches the DOM or fetches.
- Unknown is `null`. Never use `undefined`, `0`, `''`, `NaN` or `[]` as a stand-in.
- Every metric is a traced value: `{ value, lines, reason }`. `lines` is a sorted array of 1-based log line numbers that support the value. `reason` is a short code when `value` is `null`, otherwise `null`.
- Parsing: split on `\n`, drop a trailing `\r`, number lines from 1, `JSON.parse` each line inside try/catch. A broken line records its number and a reason code, never its content. Validate types at this boundary. A wrong type on a required field (`hook`, `tool` on a call) breaks the line. A wrong type on any other field, `t` included, makes that field unknown.
- ES2022. Named exports only. `const` by default. Small functions with JSDoc types on exports. No classes unless they hold state. Two-space indent, semicolons, single quotes.

## Tests

- Run each file as `node --permission --allow-fs-read=. test/<name>.test.mjs`. Tests never write files, spawn processes or use the network, except `test/recorder.test.mjs` (below).
- Each core module has a test file. Small hand-written fixtures in `test/fixtures/` cover: empty file, broken lines, all lines broken, truncated `cmd`, `allow: false`, `post` lines, no calls.
- Sample tests check exact numbers and their log lines against `samples/`.
- Kiro has no shell. The reviewer runs the tests, so assertion messages must say what was expected and why.
- One exception: `test/recorder.test.mjs` runs as `node test/recorder.test.mjs`, without the permission model. It must run the real recorder the way Kiro does (a child process with stdin, exit code and stderr), which needs `--allow-child-process`, and that lifts the model for the child. It must also create files, symlinks and hard links, and Node's permission model follows symlinks outside the granted paths, so it would not be a real fence there. The test works only inside fresh `fs.mkdtemp` directories under `os.tmpdir()`, deletes nothing and uses no network.
- The recorder (`recorder/session-autopsy-record.mjs`) runs in a user's project, not in the page: `node:` built-ins only, no child process, no network, no `process.env`.

## Development hook

`scripts/hooks/write-guard.mjs` runs before every `fs_write` (preToolUse). It blocks writes outside the project, secrets and home paths anywhere, and remote loads, HTML sinks and dynamic code in site files. Decisions go to `build-evidence/write-guard.jsonl` without content.

When it blocks a write, fix the content. Do not work around it. Test and script files may assemble secret-shaped fixtures at run time. Site code never splits banned names to get past the guard.

## Local preview

The page needs HTTP. Browsers block ES module scripts from `file://`, so opened from disk the page only shows its static notice "This page needs to be served over HTTP, see README", which `main.js` removes when it loads. Serve the repo root with any static server, for example `python3 -m http.server --bind 127.0.0.1 8000`.
