# Design: Session Autopsy, phase 1

Smallest design that meets `requirements.md`. Steering (`.kiro/steering/`) still applies. Where this spec and steering differ, this spec wins and the difference is listed in "Decisions".

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Call number | Ordinal of `pre` lines, blocked included. Logged `call` is ignored. | Blocked lines have no `call` field, so logged numbers skip them. |
| Interval | Call to next call; last call to last valid event. Notes do not split intervals. | R7.1. |
| Missing `t` on a call | Call kept, time unknown, anomaly listed. | R7.6. |
| Re-read | Called "repeat request" on screen, `repeat` in code. | Steering bans "read" for a request. |
| Repeat overlap | Only two explicit ranges can prove a repeat. Open-ended and unknown-line requests make it "could not be checked". | File length is not logged, so overlap with an open-ended request is not provable. |
| Line numbers | Requested line numbers, 1-based, even past the end of the file. | The request is what the log shows. |
| Shell working directory | Each shell call starts at `/workspace`. `cd` is tracked within one call. | All samples either `cd /workspace` or use root-relative paths. A wrong guess here would misname files, so an unresolvable `cd` makes later relative paths unknown. |
| Dot-directories | Paths with a segment starting with `.` are never source. | `rich-3480` requests `.kiro/exorcist/...`, the old recorder's own code. |
| Extra modules | `core/shell.js`, `core/lines.js`, `core/findings.js`, `ui/summary.js`. | One concern each. Listed in steering `structure.md`. |
| First edit example | In `requests-6644` the first edit attempt is call 46 on log line 46; log line 47 is a note. | Copy uses the computed values. |

## Modules

```
index.html            shell, CSP meta, loads ./src/ui/main.js
src/core/parse.js     text -> lines (call | note | broken | blank)
src/core/shell.js     cmd string -> segments (words, redirects, flags)
src/core/classify.js  call -> Effect
src/core/lines.js     requests -> merged count intervals
src/core/metrics.js   analyse(): repeats, first source edit, time, assembles Analysis
src/core/timeline.js  Analysis -> frames and exposures for replay step k
src/core/findings.js  Analysis -> three finding sentences with traced parts
src/ui/main.js        state machine, sample buttons, file input, chunked parse
src/ui/dom.js         el(), svg() on createElement(NS) + textContent
src/ui/summary.js     case line, findings, exposure meter
src/ui/strip.js       contact strip, playhead, ectoplasm threads
src/ui/plates.js      plates and exposure bands
src/ui/notes.js       evidence panel and tables
src/styles/tokens.css, src/styles/app.css
```

`ui` imports `core`; `core` imports only `core`. Sample names are a fixed array in `main.js`; fetch URLs are `./samples/` plus a name from that array.

Constants (in `metrics.js`, exported): `MAX_BYTES = 50 * 1024 * 1024`, `MAX_LINE = 10_000_000`, `T_MIN = 946684800` (2000-01-01), `T_MAX = 4102444800` (2100-01-01), `CUT_LEN = 200`, `ROOT = '/workspace'`, `LONGEST = 5`.

## Data shapes

```js
// Traced: { value, lines: number[] /* sorted, unique, 1-based */, reason: string|null }

// parse.js
Line   = { n, kind: 'call', call: Call } | { n, kind: 'note', t: number|null, hook: string }
       | { n, kind: 'broken', reason: 'json' | 'not_object' | 'no_hook' | 'no_tool' }
       | { n, kind: 'blank' }
Call   = { n, index, t: number|null, tool, cmd: string|null, truncated: boolean|null,
           allow: boolean|null, paths: string[]|null, range: Range|null, malformed: string[] }
Range  = { offset: number|null, limit: number|null }   // null field = absent; whole Range null = wrong type

// classify.js
Request = { file, call, n, kind: 'range', from, to } | { file, call, n, kind: 'open', from }
        | { file, call, n, kind: 'unlocated' }
Edit    = { file: string|null, call, n, cls: 'source'|'test'|'scratch'|'other'|'outside'|'unknown' }
Effect  = { category, requests: Request[], edits: Edit[],
            hiddenEdit: boolean, hiddenRequest: boolean, reasons: string[] }
// category: 'request'|'search'|'edit'|'test'|'run'|'vcs'|'other'|'blocked'|'unknown'

// metrics.js
Analysis = {
  totals: { lines, calls, notes, blank: number[], broken: {n, reason}[], partial: boolean },
  calls: { call: Call, effect: Effect, repeat: RepeatMark|null, interval: Traced }[],
  files: Map<file, { counts: Interval[], open: Request[], unlocated: Request[],
                     top: Interval|null, lowerBound: boolean }>,
  top: Traced,              // value { file, from, to, count }
  requests: Traced, repeats: Traced, unchecked: Traced,
  firstSource: Traced,      // value { call, n, offset, share } or null, reason 'none_recognised'
  possibleEarlier: Traced,  // value: count, lines: those calls
  otherEdits: Edit[],
  time: { span: Traced, byCategory: Map<category|'unknown_time', Traced>,
          longest: Traced[], afterRepeats: Traced, anomalies: { n, reason }[] }
}
Interval   = { from, to, count, lines }       // lines: log lines of covering requests
RepeatMark = { kind: 'repeat' | 'unchecked', earlier: number[] }   // log lines
```

File keys are workspace-relative (`rich/text.py`) inside the workspace and absolute (`/tmp/x`) outside it.

## Algorithms

### Parse (parse.js)

`splitLines(text)` returns raw strings; `parseLine(raw, n, index)` handles one line, so the UI can parse in chunks of 2,000 lines and update "Developing: X of Y log lines" between chunks. A final empty string after the last `\n` is not a line.

Field validation: `t` must be a finite number, otherwise `null` plus `malformed: ['t']`. Range checks (`T_MIN`, `T_MAX`, order) happen in metrics. `cmd` string, `cmd_truncated` boolean, `allow` boolean, `paths` array of strings, `range` object whose `offset` is an integer ≥ 0 and `limit` an integer ≥ 1. Any other type gives `null` and a `malformed` entry. `truncated` = `cmd_truncated` when boolean, else `cmd.length >= CUT_LEN`, else `null`.

### Shell lexing (shell.js)

`lex(cmd, truncated) -> { segments, cutAt: number|null }`. One left-to-right pass, states: normal, single quote, double quote, backslash, heredoc body.

- Operators outside quotes end a segment: `&&`, `||`, `;`, `|`, `|&`, `&`, newline. Each segment stores the operator that ended it, or `null` if the text ended first.
- Redirects: `[n]>`, `[n]>>`, `>|`, `&>`, `&>>`, `[n]<`, `[n]>&m`, `[n]<&m`, `<<<` with one target word. `<<` and `<<-` read a delimiter (quotes removed); after the current line ends, lines are skipped until one equals the delimiter (leading tabs removed for `<<-`).
- `#` at the start of a word starts a comment to the end of the line.
- Word flags: `dynamic` for an unquoted or double-quoted `$NAME` or `${`; `glob` for unquoted `*`, `?`, `[`. Segment flags: `exec` for `$(`, backtick, `<(`, `>(` outside single quotes; `group` for a word `(`, `)`, `{`, `}` in command position.
- Truncated: the segment with operator `null` is `cut`. A segment whose operator lies before the cut is complete, including a heredoc line whose redirect is visible before its body.

### Classify (classify.js)

By tool:

| Tool | Result |
|---|---|
| any, `allow === false` | category `blocked`, no effects |
| any, `allow === null` | `unknown`, hiddenEdit, hiddenRequest |
| `read_file` | one usable path: request per range rules below. `/workspace`, none, or several paths: `request`, hiddenRequest |
| `str_replace` | one usable path: edit attempt on it. Otherwise: edit with `file: null`, `cls: 'unknown'` |
| `web_fetch` | `other`, no effects |
| `execute_bash` | shell rules below |
| other tools | `unknown`, hiddenEdit, hiddenRequest |

`read_file` range: `range` absent or `{}`: open from 1. `offset` only: open from `offset + 1`. `limit` present: range `offset + 1 .. offset + limit` (`offset` defaults to 0). Range of wrong type, or an end above `MAX_LINE`: unlocated.

Shell, per segment, with `cwd` starting at `/workspace`:

1. Drop leading `NAME=value` words, then `env [NAME=value]...`, then `timeout [options] DURATION`.
2. If the program word is dynamic or glob, or the segment has `group`: `unknown`, hiddenEdit, hiddenRequest. If the segment has `exec`: keep the category, set hiddenEdit and hiddenRequest, keep no requests or edits from it.
3. Look up the program basename:

| Program | Category | Effect |
|---|---|---|
| `cat`, `nl` with file operands | request | open from 1 per file |
| `head` with files | request | `-n N`, `-nN`, `-N`: range 1..N; no count: 1..10; `-c` or unparsed option: unlocated |
| `sed -n 'A,Bp' F`, `sed -n 'Ap' F` | request | range A..B. Any other `sed`: `unknown`, hiddenEdit |
| `tail`, `wc` with files | request | unlocated |
| `grep`, `egrep`, `fgrep` | search | without `-r`/`-R`: each file operand unlocated. With `-r`, or no file operand: none. Unparsed option: hiddenRequest, no named files |
| `rg` | search | hiddenRequest (roots, not files) |
| `ls`, `find`, `pwd`, `which` | search | none. `find` with `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`: hiddenEdit |
| `echo`, `printf`, `true`, `sort` (no `-o`), `cut`, `tr`, filters with no file operand | none (neutral) | none |
| `cd DIR` | neutral | `cwd = resolve(DIR)`. Dynamic, `-`, no argument, or `cd` inside a pipeline: `cwd = null` |
| `git` read-only: `log`, `show`, `diff`, `status`, `rev-parse`, `blame`, `ls-files`, `grep`, `stash list`, `stash show`, `branch` with only options or `--list` | vcs | none. An `--output` option: hiddenEdit |
| other `git` subcommands (`stash`, `stash pop`, `checkout`, `apply`, `reset`, `restore`, ...) | vcs | hiddenEdit |
| `pytest`, `py.test`, `python* -m pytest\|unittest` | test | hiddenEdit, hiddenRequest |
| `python*`, `node`, `bash`, `sh`, `zsh`, `perl`, `ruby`, `php`, `eval`, `exec`, `source`, `.` | run | hiddenEdit, hiddenRequest |
| `xargs CMD`, `find ... -exec CMD` | category of CMD | hiddenEdit, hiddenRequest |
| anything else | unknown | hiddenEdit, hiddenRequest |

A file operand that is dynamic or glob is not recorded; it sets hiddenRequest instead. A relative operand while `cwd` is `null` does the same.

4. Redirects: target `/dev/null` or an fd copy: nothing. `<` with a static target: unlocated request. Write redirect with a static target: edit attempt on `resolve(target)`. Write redirect with a dynamic or glob target: edit with `file: null` and hiddenEdit.
5. A cut segment adds nothing except its category, and only if its program word was followed by whitespace before the cut. A truncated call always gets hiddenEdit and hiddenRequest.

`resolve(p)` joins `cwd` and `p`, then normalises `.`, `..` and repeated `/`. A result under `/workspace/` becomes a relative key; `/workspace` itself is not a file (target unknown); anything else stays absolute.

Edit class, in order: `null` file is `unknown`; outside the workspace is `outside`; a segment starting with `.` is `other`; a directory segment `test`, `tests`, `testing`, `__tests__` or `spec`, or a basename `test_*`, `*_test.*`, `*.test.*`, `*.spec.*` or `conftest.py` is `test`; a basename starting with `repro`, `scratch`, `debug`, `tmp` or `temp` (any case) is `scratch`; an extension in `py js mjs cjs ts tsx jsx go rs java kt c h cc cpp hpp cs rb php swift scala` is `source`; everything else is `other`.

Call category is the highest among its segments: `edit` (any edit inside the workspace) > `test` > `run` > `unknown` > `request` > `search` > `vcs` > `other`. All-neutral segments give `other`. `blocked` overrides everything.

### Line counts (lines.js)

`countLines(ranges) -> Interval[]`: sweep over `(from, +req)` and `(to + 1, -req)` sorted by position, keeping the active set of requests. Emit an interval wherever the active set is not empty; merge neighbours with the same active set. The cost is O(r log r) for r ranges, never one entry per line. `top` takes the largest count, then the longer interval, then the smaller `from`. The overall `top` adds path order as a tie-break. Line counts cover all requests in the session; edits do not reset them.

### Repeat requests (metrics.js)

For each file F, keep `since[F]`: the requests on F since the last edit attempt with `file === F`. Process calls in log order; within a call, requests come before edits.

- A `range` request R is a `repeat` if it intersects a `range` in `since[F]`. `earlier` holds those log lines.
- Otherwise, R is `unchecked` if `since[F]` holds an open request whose `from <= R.to`, or any unlocated request.
- An `open` or `unlocated` request is `unchecked` if `since[F]` is not empty.
- Then R is added to `since[F]`. An edit attempt on F clears `since[F]`. No other event clears it.

`requests` counts request entries, `repeats` counts `repeat` marks, and `unchecked` counts `unchecked` marks, each traced to its log lines. A call is a repeat-request call if any of its requests is a `repeat`.

### First source edit attempt (metrics.js)

The first source edit attempt is the first call with an edit of class `source`. `possibleEarlier` counts the earlier calls with `hiddenEdit` or an edit of class `unknown`. `offset` is its `t` minus the first valid call time. `share` is `offset / span.value`; either is `null` if a time is unknown. If no call qualifies: `value: null`, `reason: 'none_recognised'`, and `possibleEarlier` covers the whole session. `otherEdits` lists every edit not of class `source`, plus the source edits after the first.

### Time (metrics.js)

1. Accept times in log order: `t` not null, `T_MIN <= t <= T_MAX`, and `t >=` the last accepted time. Every other time becomes an anomaly (`missing`, `out_of_range`, `backwards`) with time `null`. Lines are never reordered.
2. `start` is the first accepted call time. `end` is the last accepted time of any event, call or note. `span = end - start`, traced to both log lines.
3. For a call with accepted time whose next call also has accepted time: `interval = next.t - t`, lines `[n, next.n]`. The last call with accepted time, if no later call exists: `end - t`. In every other case the interval is `null` with reason `time_anomaly`.
4. An unknown gap is the time between two accepted calls that are not neighbours. It is shown as `unknown_time` in the meter, with the lines in between.
5. `byCategory` sums known intervals. `longest` holds the top `LONGEST` known intervals. `afterRepeats` sums the intervals of repeat-request calls and gives the count of those with `null`.

Time on screen is m:ss from `start`, rounded to the nearest second; minutes can pass 59. The notes panel shows seconds with one decimal.

### Replay (timeline.js)

`frames(analysis)` returns one frame per call: `{ index, n, start: number|null, seconds: number|null, category, fog, blocked, cut, repeat }`. `fog` is set by hiddenEdit or hiddenRequest, and `cut` is set on the first source edit attempt. `exposuresAt(analysis, k)` returns the per-file `countLines` of requests from calls `<= k`. The strip shows the unknown tail as a fogged end piece with no width claim.

### Findings (findings.js)

`findings(analysis)` returns three sentences, each a list of parts: either a string or `{ text, traced }`. Templates, with every number as a traced part:

1. "Lines {from} to {to} of {file} were requested {count} times. {repeats} of {requests} requests asked again for lines already requested since the last edit attempt on that file; {unchecked} could not be checked." When no explicit range exists: "No line ranges were requested. {requests} requests had unknown or open-ended lines."
2. "First source edit attempt: call {call} at {m:ss}, {share}% into the session (log line {n}). {k} earlier calls could have changed files: unknown." When there is none: "No source edit attempt recognised. {k} calls could have changed files: unknown."
3. "Most time until the next call followed {category} calls: {m:ss} of {span} ({pct}%). Longest: {m:ss} after call {call} (log lines {a} and {b})."

When `totals.partial` is true, each sentence ends with "Partial: {b} log lines could not be read."

## Screen

Order after load: case line ("Developed from {file}: {calls} calls over {span} plus an unknown tail; {b} broken log lines"), the three findings, contact strip, plates, exposure meter, evidence (notes panel and tables). Layout breakpoints, tokens and type follow steering `design.md`.

Haunted at a glance. Every element below is data:

- **Plates** are SVG columns on fixer black, one per file, captioned like a cabinet card: "Plate II. rich/text.py". The vertical axis is the requested line number.
- **Exposure bands** use the steering opacity formula, per merged interval. Bright bands are the ghost.
- **Misregistration**: each request also draws a 1px outline, shifted right by 2px times its order on that plate (capped at 24px). A range requested 8 times shows 8 staggered outlines, the double exposure of a spirit photograph. The number of outlines is the count, and the shift is the order.
- **Apparition caption**: next to the brightest band, "Apparition: lines 1007 to 1010, requested 8 times", in the caption face.
- **Overexposed edge**: an open-ended request runs off the plate bottom with a ragged edge, labelled "whole file, length unknown".
- **Ectoplasm threads**: a pale arc above the strip joins each repeat-request frame to the earlier frames it overlaps. The threads come from `RepeatMark.earlier`.
- **Fog** hatches frames with possible hidden effects and the unknown tail. **Unexposed frames** with a cross are blocked calls. The **cut mark** is the first source edit attempt, drawn across the strip and plates.

Interaction follows steering: the playhead range input is the strip's tab stop; the repeated-requests table is the keyboard path to the bands. Every traced number is a `<button>` that opens its log lines in the notes panel.

## States

| State | Trigger | Message (plus "Open another file") |
|---|---|---|
| loading | parse running | "Developing: X of Y log lines" |
| load error | fetch or FileReader failure, size above `MAX_BYTES` | "Could not open {name}: {cause}" or "{name} is {size} MB; the limit is 50 MB" |
| empty file | 0 bytes or whitespace only | "{name} is empty." |
| not a log | every non-blank line broken | "{name} is not a session log: no log line could be read (log lines ...)." |
| no calls | valid lines, 0 calls | "{name} has {k} notes and no calls." |
| partial | some lines broken | normal screen, a "Partial" marker on each finding and table, and a broken-lines list |
| normal | otherwise | autopsy |

## Correctness properties

Each property is a test. "Gen" means a seeded generated input.

- **P1** Every log line is exactly one of call, note, broken or blank, and the numbers are 1..N in order. Validates R2.1, R2.2, R2.3, R2.5.
- **P2** `parseLine` never throws for any string (gen: random bytes, JSON fragments, wrong field types). A broken entry holds only `n` and `reason`. Validates R2.3, R2.4, R8.5.
- **P3** Changing `kind`, `spans`, `call`, or `paths` on shell calls changes no result. Validates R2.6.
- **P4** A call with `allow: false` is `blocked`, with no requests, no edits and no hidden flags. Validates R3.2.
- **P5** For gen `offset` and `limit`, the range is `offset+1 .. offset+limit`. Without `limit`, the request is open and adds nothing to counts. An end above `MAX_LINE` is unlocated. Validates R3.3, R3.4, R8.6.
- **P6** `/workspace`, no path, or several paths never produce a file key; for `str_replace` the edit class is `unknown`. Validates R3.5.
- **P7** The four R3.11 cases hold for gen file names, directories, quoting styles, `NAME=value` and `timeout` prefixes, and harmless suffixes (`2>&1`, `| head -n K`, `; echo x`, `&& echo done`). Validates R3.6, R3.7, R3.11.
- **P8** Operator and redirect characters inside quotes, comments or heredoc bodies never create segments, requests or edits (gen: bodies containing `> src/a.py; rm x`). Validates R3.6.
- **P9** Appending an unknown segment (`| python3`, `; eval x`, `$(x)`) or marking a command truncated never adds requests or edits and never clears `hiddenEdit`. The requests and edits of a truncated command are a subset of the untruncated result. Validates R3.9, R3.10.
- **P10** Requests from `grep`, `rg`, `tail` and `wc` never carry line numbers. Validates R3.8.
- **P11** `/dev/null` and fd-copy redirects never create an edit. A static write redirect into the workspace always creates an edit on the resolved path. Validates R3.7, R3.12.
- **P12** `countLines` equals a naive per-line count on gen ranges. Intervals are sorted, disjoint and have count ≥ 1, and their `lines` equal the covering requests. Validates R4.1.
- **P13** `top` is a maximum of P12's counts, with the documented tie-break. Validates R4.2.
- **P14** Inserting an edit on file G never changes the marks of requests on file F ≠ G. Repeating an explicit range with no edit on F in between always gives `repeat`. A request right after an edit on F is never `repeat`. `repeats + unchecked <= requests`. Validates R5.1, R5.2, R5.3.
- **P15** No call before `firstSource` has a source edit. `possibleEarlier` equals the number of earlier calls with `hiddenEdit` or an unknown-target edit. If none is found, the value is `null` with reason `none_recognised`, never 0. Validates R6.1, R6.2, R6.3.
- **P16** Known intervals plus unknown gaps equal `span`, and so do the `byCategory` totals (to 1e-6 s). Every known interval is ≥ 0. Validates R7.1, R7.3.
- **P17** Gen: replacing one `t` with a missing, NaN, huge, negative or earlier value gives an anomaly and `null` for the affected intervals, never 0, and keeps call order. Validates R7.6.
- **P18** Every traced value with a non-null value has non-empty, sorted, unique `lines` within 1..N. Every null value has a `reason`. Validates R9.2, R4.3.
- **P19** No `findings` output (gen analyses) contains a banned word from product.md, an em dash, an exclamation mark, or "the agent did not edit". Validates R6.3, R9.6.
- **P20** `partial` is true exactly when some line is broken, and every broken line number appears in the state output. Validates R8.3, R8.5.

## Tests

Files in `test/`: `gen.mjs` (helper), `parse`, `shell`, `classify`, `classify.property`, `lines`, `metrics`, `timeline`, `findings`, `samples`, `samples-invariants`, `boundaries`, each ending in `.test.mjs`. Fixtures in `test/fixtures/` follow steering: empty, whitespace only, some broken, all broken, truncated `cmd`, `allow: false`, `post` only, bad field types, time anomalies.

`gen.mjs` exports `rng(seed)` (mulberry32) and `check(name, { seed, runs }, genFn, propFn)`. The default seed is fixed, and the `SEED` environment variable overrides it. On failure it throws with the seed, the case index and the generated input. It has no dependencies, writes nothing and spawns nothing.

`boundaries.test.mjs` reads `src/` as text and asserts that `core` has no DOM, `fetch` or `node:` reference, that `core` never imports `ui`, and that site code has none of the sinks banned in tech.md.

`samples-invariants.test.mjs` (R11.4) parses each sample with plain `JSON.parse` in the test, independent of `parse.js`. It checks that the call count equals the number of `pre` lines, that blocked calls equal the `allow: false` lines, and that `span` equals the last minus the first raw `t`. It then runs P1, P12, P15, P16, P18 and P20 on the analysis.

`samples.test.mjs` (R11.3): these values were derived by hand from the log text. If the implementation disagrees, re-check the log before changing either side.

| | requests-6644 | rich-3506 | rich-3480 |
|---|---|---|---|
| log lines, calls, notes, blocked | 72, 71, 1 (47), 0 | 78, 78, 0, 2 (4, 27) | 172, 171, 1 (163), 2 (2, 37) |
| span (s) | 456.932 (lines 1, 72) | 351.992 (1, 78) | 887.957 (1, 172) |
| first source edit attempt | call 46, log line 46, `src/requests/models.py`, 177.800 s, share 0.389 | none recognised | call 162, log line 162, `rich/text.py`, 801.497 s, share 0.903 |
| calls that could have changed files | 13 before it (4, 8, 21, 32, 33, 34, 35, 36, 39, 40, 41, 42, 44) | 23 in the session | 35 before it |
| most requested | `src/requests/models.py` 81 to 100, 3 times (20, 45, 67) | `rich/segment.py` 110 to 120, 6 times (20, 21, 39, 56, 66, 67) | `rich/text.py` 1007 to 1010, 8 times (8, 30, 86, 99, 118, 127, 164, 172) |
| requests, repeats | 13, 1 (45) | 19, 7 (21, 39, 55, 56, 66, 67, 77) | 69, 27 |
| longest interval | 69.441 s, call 65, log lines 66 and 67 | 17.612 s, call 71, log lines 71 and 72 | 18.299 s, call 144, log lines 144 and 145 |

Pinned details in those logs: `requests-6644` log line 67 (call 66) requests `models.py` after the edit attempt on log line 46, so it is not a repeat. `rich-3506` log lines 41 and 42 (`offset 530, limit 100` and `offset 630, limit 50`) do not overlap. `rich-3480` log line 172 is not a repeat, because the edit attempt on log line 165 reset `rich/text.py`. Log line 80 (`tail -50 tests/test_text.py`) is a request with unknown lines.
