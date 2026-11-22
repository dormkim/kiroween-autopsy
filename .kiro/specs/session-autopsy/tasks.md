# Tasks: Session Autopsy, phase 1

Plan for `requirements.md` and `design.md`. Increments A, B and C are each implemented in one session and committed on their own. Increment D is run by the reviewer.

Kiro has no shell. At the end of each increment the reviewer runs that increment's tests and commits only when they pass. Every test file runs as `node --permission --allow-fs-read=. test/<name>.test.mjs`. Property tests accept `SEED=<n>` to change the seed.

R-numbers refer to `requirements.md`. P-numbers refer to "Correctness properties" in `design.md`.

## Notes for implementers

- Constants. `design.md` exports them from `metrics.js`, but `parse.js` and `classify.js` need some of them in increment A, and `classify.js` importing `metrics.js` would create a cycle. Define `CUT_LEN` in `parse.js` and `ROOT` and `MAX_LINE` in `classify.js`. `metrics.js` defines the rest and re-exports these three, so every constant is still importable from `metrics.js`.
- State messages (empty file, not a log, no calls, partial, load error) are screen copy. Their text comes from a pure `stateMessage()` in `findings.js`, so P19 and P20 can test it. `main.js` only decides which state applies and renders it.
- The R3.11 case `cat a.py > /tmp/x` is pinned as an edit on `/tmp/x` with class `outside`. That is the design's class for what R3.7 calls a scratch write outside the workspace. It is never `source`.
- Tests first means: within a session, write the test file before the module it tests, with expected values taken from the spec or from the log text, never from the module's output.

## Increment A: parsing and shell classification

Tests first, then `parse.js`, `shell.js`, `classify.js`. Commit: "Add log parsing and call classification with tests".

- [x] A1. Seeded property test helper
  - Files: `test/gen.mjs`
  - `rng(seed)` (mulberry32) and `check(name, { seed, runs }, genFn, propFn)`. Fixed default seed, `SEED` overrides it. On failure it throws with the seed, the case index and the generated input. Shared generators: file names, directory names, quoting styles (bare, single, double), offsets, limits, times. No writes, no child processes, no network.
  - Requirements: R11.2
  - Proof: `test/parse.test.mjs` checks that one seed gives the same sequence twice and that a failing property's message contains the seed, the case index and the input.

- [x] A2. Fixtures (the file tools cannot write a literal CR, so `some-broken.jsonl` is LF; `parse.test.mjs` converts it to CRLF at run time and expects the same result)
  - Files in `test/fixtures/`: `empty.jsonl` (0 bytes), `whitespace.jsonl`, `some-broken.jsonl` (includes a CRLF line), `all-broken.jsonl`, `truncated-cmd.jsonl`, `blocked.jsonl` (`allow: false`), `post-only.jsonl` (notes, no calls), `bad-types.jsonl` (wrong type on each optional field), `time-anomalies.jsonl` (missing, NaN-like string, out of range, backwards `t`).
  - Hand-written, under 20 lines each, paths under `/workspace` or `/tmp` only. Expected values live in the tests, with the log line numbers.
  - Requirements: R2.1 to R2.5, R3.2, R3.10, R7.6, R8.2 to R8.5
  - Proof: used by `parse.test.mjs` and `classify.test.mjs` here, and by `metrics.test.mjs` and `findings.test.mjs` in B.

- [x] A3. Parse tests
  - Files: `test/parse.test.mjs`
  - Unit: one trailing `\r` dropped, a final empty string after the last `\n` is not a line; call, note, blank, and each broken reason (`json`, `not_object`, `no_hook`, `no_tool`); a broken entry has only `n` and `reason`; each optional field with a wrong type becomes `null` with its name in `malformed` (`t`, `cmd`, `cmd_truncated`, `allow`, `paths`, `range`, negative or fractional `offset`, `limit` 0); `truncated` from a boolean `cmd_truncated`, else from `cmd.length >= CUT_LEN`, else `null`; `index` counts `pre` lines with blocked calls included and ignores the logged `call`; parsing in chunks of 2,000 lines equals one pass. Each fixture's counts and log line numbers.
  - Properties: P1, P2, P3 (changing `kind`, `spans` or `call` leaves the parsed `Call` unchanged)
  - Requirements: R2.1 to R2.6, R8.2, R8.3, R11.1, R11.2

- [x] A4. Shell lexer tests
  - Files: `test/shell.test.mjs`
  - Unit: each operator (`&&`, `||`, `;`, `|`, `|&`, `&`, newline) and the operator stored on its segment; single and double quotes and backslash; every redirect form in design.md; `<<`, `<<-` and a quoted delimiter, with the body skipped; `#` comments; `dynamic`, `glob`, `exec` and `group` flags; `cutAt`, the `cut` segment, and a heredoc whose redirect is visible before the cut.
  - Properties: P8
  - Requirements: R3.6, R3.10

- [x] A5. Classify unit tests, including the four regression cases
  - Files: `test/classify.test.mjs`
  - Regression cases as four named tests, each asserting category, requests (file key and kind) and edits:
    - `grep x a.py 2> /dev/null`: search, one unlocated request on `a.py`, no edits.
    - `cat a.py > /tmp/x`: request, open request on `a.py` from line 1, one edit on `/tmp/x` with class `outside`, no source edit.
    - `cd pkg && cat a.py`: request, open request on `pkg/a.py`.
    - `cat a.py; echo`: request, open request on `a.py`.
  - Unit: every row of the tool table; `read_file` range rules including `{}`, `offset` only, `limit` only, wrong type, and an end above `MAX_LINE`; `/workspace`, no path and several paths; every row of the shell program table; `NAME=value`, `env` and `timeout` prefixes; `cd` tracking and every case that sets `cwd` to `null`; each redirect rule; one example per edit class in the documented order; category precedence; `blocked` overriding everything; a truncated command keeping only segments before the cut. Pinned from `rich-3480` log line 80: `tail -50 tests/test_text.py` is an unlocated request on `tests/test_text.py`.
  - Requirements: R3.1 to R3.12, R8.6, R11.2

- [x] A6. Classify property tests
  - Files: `test/classify.property.test.mjs`
  - Properties: P3 (changing `paths` on shell calls changes no effect), P4, P5, P6, P7 (the four regression cases with generated names, directories, quoting, prefixes and harmless suffixes), P9, P10, P11
  - Requirements: R2.6, R3.2 to R3.11, R8.6, R11.2

- [x] A7. Parser
  - Files: `src/core/parse.js` (exports `splitLines`, `parseLine`, `parse`, `CUT_LEN`)
  - Requirements: R2.1 to R2.6
  - Proof: `test/parse.test.mjs`

- [x] A8. Shell lexer
  - Files: `src/core/shell.js` (exports `lex`)
  - Requirements: R3.6, R3.10
  - Proof: `test/shell.test.mjs`

- [x] A9. Classifier
  - Files: `src/core/classify.js` (exports `classify`, `resolve`, `editClass`, `ROOT`, `MAX_LINE`)
  - Requirements: R3.1 to R3.12, R8.6
  - Proof: `test/classify.test.mjs`, `test/classify.property.test.mjs`

- [x] A10. Test script
  - Files: `package.json` (`scripts.test` runs `write-guard`, `parse`, `shell`, `classify` and `classify.property` one after another with `&&`, each with `--permission --allow-fs-read=.`). No dependencies.
  - Proof: the reviewer runs `npm test`.

- [x] A11. Checkpoint: the reviewer runs the five test files, once with the default seed and once with another `SEED`, then commits increment A.

## Increment B: metrics, lines, timeline, findings

Tests first, including the sample tests, then the modules. Commit: "Add line counts, repeat requests, time, replay frames and findings with sample tests".

- [x] B1. Line count tests
  - Files: `test/lines.test.mjs`
  - Unit: one range, nested, overlapping, touching (`1..5` and `6..10` stay separate), neighbours with the same active set merged; a range up to `MAX_LINE` yields at most `2r` intervals, never one per line; tie-breaks for `top` (count, then length, then smaller `from`, then path order overall).
  - Properties: P12, P13
  - Requirements: R4.1, R4.2

- [x] B2. Metrics tests
  - Files: `test/metrics.test.mjs`
  - Unit, on fixtures and small hand-built logs: open and unlocated requests per file and `lowerBound`; `repeat` and `unchecked` marks for each rule in "Repeat requests", including requests before edits within one call; reset only on an edit with that exact file; `firstSource` with `offset` and `share`, and `null` with reason `none_recognised`; `possibleEarlier`; `otherEdits`; intervals call to next call, with notes not splitting them; last call to last valid event; unknown gaps; anomalies `missing`, `out_of_range`, `backwards` from `time-anomalies.jsonl`; `longest` capped at `LONGEST`; `afterRepeats` with its null count; `totals.partial`; exported constants.
  - Properties: P3 (on the whole analysis), P14, P15, P16, P17, P18, P20 (the `partial` part)
  - Requirements: R4.3, R5.1 to R5.3, R6.1 to R6.4, R7.1 to R7.6, R8.5

- [x] B3. Timeline tests
  - Files: `test/timeline.test.mjs`
  - Checks: one frame per call in order; `fog` exactly when `hiddenEdit` or `hiddenRequest`; `blocked` matches the effect; `cut` on the first source edit attempt only, and on no frame when there is none; `seconds` equals the call's interval, `null` when unknown; `exposuresAt(a, last)` equals `countLines` of every request per file; counts never drop as `k` grows (generated logs).
  - Requirements: R9.4, R7.2

- [x] B4. Findings tests
  - Files: `test/findings.test.mjs`
  - Unit: the three templates rendered word for word from a hand-built analysis; the "No line ranges were requested" and "No source edit attempt recognised" variants; the partial suffix; m:ss rounding and minutes past 59; every number is a traced part; `stateMessage()` text for each state in the States table, with the file name and log lines.
  - Properties: P19 (generated analyses and every `stateMessage()` output), P20 (every broken line number appears in the state output)
  - Requirements: R5.4, R6.3, R8.1 to R8.5, R9.1, R9.2, R9.6

- [x] B5. Sample tests
  - Files: `test/samples.test.mjs`
  - Every value in the `samples.test.mjs` table in design.md, with its log lines, plus the pinned details below the table (`requests-6644` log line 67 not a repeat, `rich-3506` log lines 41 and 42 not overlapping, `rich-3480` log line 172 not a repeat and log line 80 unlocated). Times compared to 1e-3 s, shares to 1e-3. Assertion messages name the sample, the expected value, the log lines it was derived from, and repeat the rule: re-check the log before changing either side.
  - Requirements: R11.3

- [x] B6. Sample invariant tests
  - Files: `test/samples-invariants.test.mjs`
  - Parses each sample with plain `JSON.parse` inside the test, independent of `parse.js`, and checks the call count, blocked count and span against it. Then runs P1, P12, P15, P16, P18 and P20 on each analysis. No number copied from module output.
  - Requirements: R11.4

- [x] B7. Line counts
  - Files: `src/core/lines.js` (exports `countLines`, `topInterval`)
  - Requirements: R4.1, R4.2
  - Proof: `test/lines.test.mjs`

- [x] B8. Analysis
  - Files: `src/core/metrics.js` (exports `analyse` and every constant listed in design.md)
  - Requirements: R4 to R7, R8.5
  - Proof: `test/metrics.test.mjs`, `test/samples.test.mjs`, `test/samples-invariants.test.mjs`

- [x] B9. Replay frames
  - Files: `src/core/timeline.js` (exports `frames`, `exposuresAt`)
  - Requirements: R9.4
  - Proof: `test/timeline.test.mjs`

- [x] B10. Findings and state copy
  - Files: `src/core/findings.js` (exports `findings`, `stateMessage`, `formatTime`)
  - Requirements: R6.3, R8.1 to R8.5, R9.1, R9.6
  - Proof: `test/findings.test.mjs`

- [x] B11. Test script: add `lines`, `metrics`, `timeline`, `findings`, `samples` and `samples-invariants` to `scripts.test` in `package.json`.

- [x] B12. Checkpoint: the reviewer runs all test files, once with another `SEED`. If a sample test fails, the next session re-checks the log text before changing the test or the code. Then commit increment B.

## Increment C: site, boundary test, README

Boundary test first, then the page. UI code is not imported by tests. It is proven by the boundary test and by increment D. Commit: "Add the autopsy page, boundary test and README".

- [x] C1. Boundary test
  - Files: `test/boundaries.test.mjs`
  - Reads `index.html`, `src/` and `package.json` as text and asserts: `src/core/` has no DOM globals, `fetch`, storage APIs, `node:` imports, `Date`, `Math.random` or `performance`; `core` never imports `ui`; `ui` imports only relative paths; no site file contains the sinks banned in tech.md; no `export default`; `index.html` has the exact CSP from tech.md, one `<script type="module" src="./src/ui/main.js">`, no inline script, no `<style>` and no `style=` attribute; every `href` and `src` is relative; the only `fetch` URL prefix is `./samples/`; no storage, cookie or service worker API; `package.json` has no `dependencies` or `devDependencies`.
  - Requirements: R1.5, R10.1, R10.2, R11.1

- [x] C2. Page shell and styles
  - Files: `index.html`, `src/styles/tokens.css` (tokens from steering design.md, nothing else), `src/styles/app.css`
  - First screen: title, one-line purpose, the limit statement from product.md, file input with label, one button per sample. Breakpoints 360, 768 and 1280, `min-width: 0` on grid children, focus ring, 44px targets, reduced-motion rules.
  - Requirements: R1.1, R1.5, R9.3, R9.5, R10.2
  - Proof: `test/boundaries.test.mjs`, D3

- [x] C3. DOM helper
  - Files: `src/ui/dom.js` (exports `el`, `svg`, `setVar`, `replace`, `grouped`)
  - Text only through `textContent`. Attribute names come from a fixed allowlist in the module, never from log content.
  - Requirements: R10.1
  - Proof: `test/boundaries.test.mjs`

- [x] C4. Entry point and states
  - Files: `src/ui/main.js`
  - Fixed sample name array; fetch `./samples/` plus a name from it; file input read in the browser; size check against `MAX_BYTES` before reading; parse in chunks of 2,000 lines with "Developing: X of Y log lines" between chunks; state machine for loading, load error, empty file, not a log, no calls, partial and normal, each non-normal state with "Open another file".
  - Requirements: R1.2 to R1.6, R8.1 to R8.5, R8.7
  - Proof: `test/boundaries.test.mjs`, D3 and the state screenshots

- [x] C5. Case line, findings and exposure meter
  - Files: `src/ui/summary.js`
  - Case line, the three findings with every traced part as a `<button>`, the meter with per-category segments, the unknown gaps and the unknown tail.
  - Requirements: R7.2, R7.3, R9.1, R9.2
  - Proof: D2, D3

- [x] C6. Contact strip and playhead
  - Files: `src/ui/strip.js`
  - Frames with width from `seconds` (minimum 4px), edge codes, fog, unexposed frames with a cross, cut mark, ectoplasm threads from `RepeatMark.earlier`, fogged unknown tail; the range input as the one tab stop, with arrow keys, Home, End and Space; 120ms per frame; no autoplay or transitions under `prefers-reduced-motion: reduce`.
  - Requirements: R7.2, R9.3, R9.4, R9.5
  - Proof: D3

- [x] C7. Plates
  - Files: `src/ui/plates.js`
  - One SVG plate per file with its cabinet-card caption, exposure bands with the steering opacity formula, misregistration outlines, apparition caption, overexposed edge for open requests, lower-bound note when the file has open or unlocated requests. Clicking a band selects its table row.
  - Requirements: R4.1 to R4.3, R9.3
  - Proof: D3

- [x] C8. Evidence panel
  - Files: `src/ui/notes.js`
  - Log lines for the selected traced value; the repeated-requests table as the keyboard path to bands and frames; request, repeat and unchecked counts (R5.3) with the unknown-effect statement (R5.4); the five longest intervals with both log lines; time after repeat-request calls; other edit attempts by class; broken lines, blank lines, notes and time anomalies by log line; "Partial" markers.
  - Requirements: R5.3, R5.4, R6.4, R7.4 to R7.6, R8.5, R9.2
  - Proof: D2, D3

- [x] C9. README
  - Files: `README.md`
  - What the page shows, the limit statement, how to open a log (an HTTP server is required; `file://` only shows the notice), privacy (nothing leaves the browser), how to run the tests, the repo layout. Steering words only, no banned words, no em dashes, no exclamation marks.
  - Requirements: R1.5, R9.6
  - Proof: D4

- [x] C10. Test script: add `boundaries` to `scripts.test` in `package.json`.

- [x] C11. Checkpoint: the reviewer runs all test files, then commits increment C.

### Increment C, review fixes (after the first screenshots)

- [x] C12. Headlines: `headlines()` in `findings.js` with tests in `findings.test.mjs` (word for word, "At least", null forms, sample values from the design.md table, copy rules). Each finding shows headline, sentence, and one 44px "Show log lines" control.
- [x] C13. Apparition: `src/ui/apparition.js`, one offset veiled figure per covering request up to the playhead, cabinet-card mount, vignette, grain, hollow eyes, strands from the line plate, caption with "at least" when the count is a lower bound. Steering now bans only ghosts that carry no data.
- [x] C14. Replay stage: apparition, Play, live line, compact strip and slider in one viewport at 1280x800 and 360x740; explanations and legend in "How to read the replay". The strip follows the playhead while playing, scrubbing and after load; after load the playhead is at the end with "Replay from call 1"; Play at the end restarts.
- [x] C15. First screen: two columns from 1000px with the developing apparition of rich-3480, one primary "Open the autopsy of rich-3480", sample line with a relative link to DISCLOSURE.md.
- [x] C16. Copy and type: "at least" on every lower-bound count (headline, sentence, caption, plate labels, table, notes); six font sizes (12, 14, 16, 20, 28, 40); case-line numbers as 44px buttons; space above the unknown-effect note.
- [x] C17. Narrow tables: below 600px evidence tables become stacked rows with a label per cell; headers never break inside words.
- [x] C18. Checkpoint: the reviewer runs all tests and the 360, 768 and 1280 screenshots again, then commits.
- [x] C19. Final pass: "first recognised source edit attempt" in the headline, its label, the sentence, notes and evidence, "first recognised edit" on the strip, with tests and spec templates updated; threads hidden until the playhead reaches their repeat, even when selected; short session name fitted on the card; "at least once"; no stray space before the meter share; 44px DISCLOSURE.md link; figure redrawn as a veiled person with sunken sockets, cheek shadow, torn hem and displaced exposures, still one per request.
- [x] C20. Checkpoint: the reviewer runs all tests and screenshots this pass, then commits.
- [ ] C21. Correction, session endings (R12): `src/provenance/sample-endings.js` with the ending of each bundled sample from the runner's records (DISCLOSURE.md); short label beside each sample button, below the primary button and under the first-screen photograph, in accessible names; full sentence under the session title before the headlines; "Ending unknown: the log does not record how the session ended." for every opened file; shares, totals and absence claims worded as of the recording, "Recorded time", "End of the recording"; `test/sample-endings.test.mjs` added to `npm test`; boundary test covers `src/provenance/`. The reviewer runs the tests and the 360x740 screenshots, then commits.
- [ ] Open: the inline number buttons in running text are 42px high and down to 12px wide, below the 44px rule. Enlarging them in running text would overlap neighbouring lines, so they are left as they are for now.

## Increment D: verification (reviewer)

Not implemented by Kiro. The reviewer runs it after C and records the results.

- [x] D1. Tests
  - Run every test file with the default seed, then with three other `SEED` values. All pass.

- [ ] D2. Independent recount
  - For each sample, recount from the raw log text without project code: log lines, calls, notes, blocked calls, span, first source edit attempt, the earlier calls that could have changed files, most requested range, requests and repeats, longest interval. Compare with the table in design.md and with the screen.
  - On screen, open at least three traced numbers per sample and confirm the log lines shown contain what the number claims.
  - Status: numbers verified; click-through of three traced numbers per sample not done.

- [ ] D3. Screenshots at 360, 768 and 1280
  - Serve the repo from 127.0.0.1 with any static server, for example `python3 -m http.server --bind 127.0.0.1 8000`. Also open `index.html` from `file://` and check that it shows "This page needs to be served over HTTP, see README".
  - Capture each sample at 360, 768 and 1280px, the first screen at 360, and the loading, load error (a file above 50 MB), empty, not a log, no calls and partial states at 360 using the fixtures.
  - At each width check: no page-level horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), the strip scrolls inside its box, plates follow the layout rules, Tab reaches every control with a visible focus ring, targets are at least 44px, replay works with arrow keys, Home, End and Space, and reduced motion disables autoplay and transitions.
  - Console shows no CSP violations. The network panel shows only same-origin GETs of `samples/*.events.jsonl` besides the page's own files.
  - Status: screenshots and keyboard done; the over 50 MB, loading and no-calls screens not exercised.

- [ ] D4. Copy check
  - Search the screen text, `README.md`, code comments and commit messages for the banned words in product.md, em dashes, emoji and exclamation marks. None found.
  - Status: partly done (screen, README, home paths, secrets).

- [ ] D5. Record the results and the screenshot file names, then commit or report the failures as tasks for a new session.
  - Status: recorded in BUILD_LOG.md.

## Increment E: recorder (phase 2)

Three sessions: E1 to E4 (tests and spec, this run), E5 to E10 (implementation), E11 to E13 (reviewer). The tests written in E2 and E3 must fail before E5 and must not be weakened afterwards. If one turns out to be wrong, the reviewer decides, and the change is recorded in BUILD_LOG.md.

- [x] E1. Spec: R13 and R14 in `requirements.md`; phase 2 decisions, recorder, reading recorder logs and P21 to P29 in `design.md`; why the recorder test runs without the permission model in steering `tech.md`.

- [x] E2. Recorder tests
  - Files: `test/recorder.test.mjs`
  - Runs the real script as a child process in fresh `fs.mkdtemp` directories under `os.tmpdir()`, deletes nothing. Both engines' measured shapes; canaries for every privacy item, searched in every file under the temporary root (names and contents) and in both streams; every path case; symlink and hard-link attacks with unchanged victims; invalid inputs and sizes, never exit 2; `--prompt-check` and `--check`; a project not named `workspace`; 40 parallel processes with long paths; a static check of imports and calls.
  - Properties: P21 to P25
  - Requirements: R13.1 to R13.17

- [x] E3. Format tests
  - Files: `test/recorder-format.test.mjs`
  - Permission states, `ranges`, `/outside-workspace`, the new tools, `notRecorded` and `permissionNote` copy, end to end through `parse`, `analyse` and `findings`, a seeded property that no outside path becomes a source edit, and `notRecorded` 0 on the samples.
  - Properties: P26 to P29
  - Requirements: R14.1 to R14.9

- [x] E4. Test script: `package.json` runs `node test/recorder.test.mjs` and `node --permission --allow-fs-read=. test/recorder-format.test.mjs` after the existing files.

- [x] E5. Parser: `permission` and `ranges` on `Call` (design "Reading recorder logs").
  - Files: `src/core/parse.js`
  - Existing assertions that pin an absent `allow` as malformed or unknown change with R14.1. List each one changed in the session summary; do not change any other assertion.
  - Proof: `test/recorder-format.test.mjs`, `test/parse.test.mjs`
  - Changed older assertions, all because of R14.1 (absent `allow` is `not_recorded` and classified as an attempt):
    - `test/classify.test.mjs`, "allow unknown (absent or wrong type): unknown with both hidden flags": the absent case is removed from it, and the test is renamed "allow of wrong type: unknown with both hidden flags". The wrong-type case (`allow: 'yes'`) is unchanged. A new test, "allow absent: permission not_recorded, classified as an attempt (R14.1)", pins the absent case.
    - `test/boundaries.test.mjs`, "package.json has no dependencies and runs every test file": `test/recorder.test.mjs` is the one named exception from tech.md and must run as `node test/recorder.test.mjs`. Every other file still needs the permission flags, and no other command may run without them. This is task 5 of the run, not R14.1.
  - Unchanged: `test/parse.test.mjs` asserts only `allow === null` for an absent `allow`, which still holds. Every fixture, `gen.mjs` and the other tests build calls with `allow: true` or `false`.

- [x] E6. Classifier: permission cases, `list_directory`, `search`, `ranges`, `OUTSIDE`.
  - Files: `src/core/classify.js`
  - Proof: `test/recorder-format.test.mjs`, `test/classify.test.mjs`, `test/classify.property.test.mjs`

- [x] E7. Metrics and findings: `notRecorded`, `OUTSIDE` re-export, `permissionNote()`.
  - Files: `src/core/metrics.js`, `src/core/findings.js`
  - Proof: `test/recorder-format.test.mjs`, `test/samples.test.mjs` unchanged

- [x] E8. Recorder
  - Files: `recorder/session-autopsy-record.mjs`, with the limits from design.md in its header comment
  - Proof: `test/recorder.test.mjs`

- [ ] E9. Install example and docs
  - Files: `examples/recorder-agent.json` (preToolUse matcher `*` running `node .kiro/session-autopsy/session-autopsy-record.mjs`, userPromptSubmit running it with `--prompt-check`), README section "Record your own session" (copy, register, `--check`, what is recorded including file names inside the project, the limits), steering `structure.md` tree with `recorder/` and `examples/`, the case-line note from `permissionNote()` in `src/ui/summary.js`.
  - Proof: `test/boundaries.test.mjs`, E12
  - Status: example agent, structure.md, the case-line note (`summary.js`, `.case-permission` in `app.css`) and "Attempt, permission not recorded." in the live line (`strip.js`) are written. The README section is left for the next run.

- [ ] E10. Checkpoint: the reviewer runs `npm test` and the property seeds, then commits.

- [ ] E11. Live recording on V2 (reviewer): a harmless session in a scratch project with the example agent; the log opens in the page; every line matches the session's tool calls; no content, command or outside name in it.

- [ ] E12. Live recording on V3 (reviewer): the same, plus one forced failure (for example a symlinked `.session-autopsy`) and a check that the next prompt's reply begins with the failure line.

- [ ] E13. Record sessions, credits and results in BUILD_LOG.md.
