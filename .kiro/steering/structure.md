# Structure

```
index.html                 page shell, CSP meta, loads src/ui/main.js
src/
  core/                    pure logic, runs in the browser and under node:test
    parse.js               text -> calls, other lines, broken lines, all with log line numbers
    shell.js               cmd string -> segments, redirects, flags
    classify.js            call -> category and file effect, from tool, cmd, range
    lines.js               requested ranges -> merged count intervals
    metrics.js             repeated requests, first edit attempt, time per category
    timeline.js            frames for the replay
    findings.js            finding sentences and state messages
  ui/                      the only code that touches the DOM or fetches
    main.js                entry point and state machine (loading, empty, error, normal)
    dom.js                 el(tag, attrs, text) helper built on createElement and textContent
    summary.js             case line, findings, exposure meter
    strip.js               replay stage: contact strip, playhead, live line
    apparition.js          spirit photograph of the most requested lines
    plates.js              exposure plates
    notes.js               detail panel for the selected call or range
  styles/
    tokens.css             design tokens only (see design.md)
    app.css                layout and components
samples/                   three sanitized session logs, read-only
test/                      *.test.mjs files and fixtures/
scripts/                   Node-only development scripts, never loaded by the page
  hooks/write-guard.mjs    preToolUse guard for fs_write
build-evidence/            generated hook decision logs
.kiro/steering/            these documents
.kiro/specs/               feature specs
```

## Rules

- Dependencies go one way: `ui` imports `core`. `core` never imports `ui`. Tests import `core` and the hook, never `ui`.
- Site files use `.js`. Node-only files use `.mjs` and live in `test/` or `scripts/`.
- File names are kebab-case. One concern per module.
- All paths in the site are relative (`./src/ui/main.js`) so the page works from a subpath.
- New top-level folders need a reason in the spec.

## Do not edit

`DISCLOSURE.md`, `BUILD_LOG.md`, `.kiro/agents/`, `.kiro/hooks/`, `.kiro/settings/` and `samples/*.events.jsonl` belong to the reviewer. Read them, never write them.
