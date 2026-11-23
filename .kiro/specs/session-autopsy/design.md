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
| Session ending | Endings of the bundled samples live in `src/provenance/sample-endings.js`, from the runner's records. Only the sample-button path uses them; an opened file is "Ending unknown". Shares and totals say "recording". | The log has no ending, and two of the three samples did not end normally (DISCLOSURE.md). R12. |

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
src/provenance/sample-endings.js  endingFor({ source, name }) -> { kind, label, sentence }; bundled samples only
src/ui/main.js        state machine, sample buttons, file input, chunked parse
src/ui/dom.js         el(), svg() on createElement(NS) + textContent
src/ui/summary.js     case line, findings, exposure meter
src/ui/strip.js       replay stage: contact strip, playhead, live line, ectoplasm threads
src/ui/apparition.js  spirit photograph of the most requested lines, one exposure per request
src/ui/plates.js      plates and exposure bands
src/ui/notes.js       evidence panel and tables
src/styles/tokens.css, src/styles/app.css
```

`ui` imports `core` and `provenance`; `core` imports only `core`; `provenance` imports nothing. Sample names are a fixed array in `main.js`; fetch URLs are `./samples/` plus a name from that array.

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
| `sed -i`, `-iSUFFIX`, `--in-place[=SUFFIX]` with static file operands; `tee`, `tee -a` with static file operands (also after a pipe) | edit (if a target is in the workspace) | edit attempt on each file operand, never on the sed script (the first operand unless `-e` gave one). A suffix adds an edit attempt on the backup, or hiddenEdit if it holds `*` or `/`. sed `w`, `W`, `e` or a dynamic script: hiddenEdit. Dynamic, glob, `-` or unresolvable operand: edit with `file: null`. Ambiguous forms stay `unknown` with hiddenEdit and hiddenRequest: bare `-i` before `''` or `.SUFFIX`, `-f`, unparsed options, no file operand |
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

1. "Lines {from} to {to} of {file} were requested {count} times. {repeats} of {requests} requests asked again for lines already requested since the last edit attempt on that file; {unchecked} could not be checked." When that file has open-ended or unlocated requests, its count is a lower bound: "were requested at least {count} times". When no explicit range exists: "No line ranges were requested in this recording. {requests} requests had unknown or open-ended lines."
2. "First recognised source edit attempt: call {call} at {m:ss}, {share}% into the recording (log line {n}). {k} earlier calls might also have changed files; the log cannot tell." When there is none: "No source edit attempt recognised in this recording. {k} calls might have changed files; the log cannot tell." When {k} is 0: "0 earlier calls could have changed files."
3. "The largest share of the recording, {m:ss} of {span} ({pct}%), came after {category}. That includes the tool, the model and waiting. The longest time until the next call was {m:ss}, after call {call} (log lines {a} and {b})." Unknown gaps add "Times are unknown for {m:ss} of the recording."

Singular forms ("once", "1 request", "1 earlier call") are used for a count of 1. Category names on screen are plain words: file requests, searches, edit attempts, test runs, code runs, version control calls, other calls, blocked calls, calls with unknown effect.

When `totals.partial` is true, each sentence ends with "Partial: {b} log lines could not be read."

`headlines(analysis)` returns the plain answer that leads each finding, with the traced value its "Show log lines" control opens. Same numbers as the sentences:

1. "{count} requests for the same {n} lines" ("the same line" for one line), "At least {count} requests..." when the file's count is a lower bound, "No line was requested twice in this recording" when the top count is 1, "No line ranges requested in this recording" or "No file requests recognised in this recording" when there is no explicit range.
2. "{share}% of the recording had passed before the first recognised source edit attempt"; "First recognised source edit attempt at call {call}, time unknown" when the share is unknown; "No source edit attempt recognised in this recording" (traced to the calls that could have changed files).
3. "{pct}% of the recorded time came after {category}"; "Where the time went is unknown" when the span is unknown or 0.

With fewer than `FEW_CALLS = 5` calls (`totals.calls`), a share says nothing (one read then one edit gives 100% twice), so headline 2 reads "First recognised source edit attempt at call {call} of {calls}" when there is one, and headline 3 reads "Only {calls} calls recorded, too few to say where the time went" ("1 call"), traced to the call log lines; the sentences do not change.

### Session ending (provenance/sample-endings.js)

`endingFor({ source: 'sample' | 'file', name })` returns `{ kind, label, sentence }`. Only `source: 'sample'` with a name in the bundled list has a known ending; everything else returns the unknown ending. `ui/main.js` passes `{ source: 'sample' }` only from the sample buttons and `{ source: 'file' }` from the file input. No core module reads it.

| Sample | Label (first screen) | Sentence (under the session title) |
|---|---|---|
| `rich-3480` | "Cut off at the 15-minute limit" | "Cut off: the benchmark runner's records show the runner stopped the agent at its 15-minute (900 s) time limit." |
| `rich-3506` | "Crashed: Kiro's server shut down" | "Crashed: the benchmark runner's agent log shows Kiro's server shut down with an internal error ("RangeError: Invalid string length"). The time of the crash is not recorded; the runner wrote that log 121 seconds after the last recorded event." |
| `requests-6644` | "Exited normally (exit code 0)" | "Exited normally: the benchmark runner's records show the agent process exited with code 0; the log has no outcome." |
| opened file, any name | "Ending unknown" | "Ending unknown: the log does not record how the session ended." |

The case line labels the span "Recorded time". At the end of the replay the hint reads "End of the recording. Replay to watch the figure form."

## Screen

Order after load: session name, the ending sentence, case line ("Developed from {file}", then calls, recorded time plus an unknown tail and broken log lines as 44px buttons, and "Replay from the first call"), the three findings (headline, sentence, "Show log lines"), the replay stage, plates with the notes panel, exposure meter, evidence (collapsible tables). Layout breakpoints, tokens and type follow steering `design.md`.

The first screen shows, before anything is opened, the apparition of `rich-3480` developing once from its own data, with one primary button "Open the autopsy of rich-3480". From 1000px it takes the right column.

The replay stage holds the apparition, Play, the live line ("{m:ss}, call {k} of {total}", then the plain action, file and count, then the raw command), the compact strip and the slider, and fits one viewport at 1280x800 and 360x740. After load the playhead is at the end and the strip is scrolled to it; Play at the end restarts from call 1. The strip keeps the playhead in view while playing and scrubbing.

Haunted at a glance. Every element below is data:

- **Apparition**: a cabinet-card photograph of the most requested range. The figure is exactly one offset, translucent copy of a veiled figure with hollow eyes per request (explicit range) covering those lines, up to the playhead: none at 0, faint at 1, dense at 8. Older copies lean further back, like a long exposure. Beside it, the file's line plate is the exact reading, and one strand per exposure runs from that request's lines into the figure. Caption: "The figure is {n} superimposed exposures, one per request of lines {from} to {to} so far", plus "Requested at least {n} times; open-ended requests are not drawn." when the file has open-ended or unlocated requests.

- **Plates** are SVG columns on fixer black, one per file, captioned like a cabinet card: "Plate II. rich/text.py". The vertical axis is the requested line number.
- **Exposure bands** use the steering opacity formula, per merged interval. Bright bands are the ghost.
- **Misregistration**: each request also draws a 1px outline, shifted right by 2px times its order on that plate (capped at 24px). A range requested 8 times shows 8 staggered outlines, the double exposure of a spirit photograph. The number of outlines is the count, and the shift is the order.
- **Brightest band caption**: next to the brightest band of the hero plate, "Brightest: lines 1007 to 1010, requested at least 8 times" ("at least" only when the file has open-ended or unlocated requests).
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

Files in `test/`: `gen.mjs` (helper), `parse`, `shell`, `classify`, `classify.property`, `lines`, `metrics`, `timeline`, `findings`, `sample-endings`, `samples`, `samples-invariants`, `boundaries`, each ending in `.test.mjs`. Fixtures in `test/fixtures/` follow steering: empty, whitespace only, some broken, all broken, truncated `cmd`, `allow: false`, `post` only, bad field types, time anomalies.

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

# Design: phase 2, recorder

Input facts come only from the "Phase 2" section of BUILD_LOG.md. Shapes not listed there (shell tool input, V3 `list_directory`, `grep_search`, `file_search` input) are not measured, so the recorder copies nothing from them except what the tables below allow.

## Decisions, phase 2

| Topic | Decision | Why |
|---|---|---|
| New folders | `recorder/` holds the one file a user copies. `examples/` holds `recorder-agent.json`. Neither is loaded by the page. | R13.1. The recorder runs in a user's project, so it cannot live in `scripts/` (development only) or `src/` (site). |
| No `allow` | The recorder never writes `allow`. | preToolUse runs before the permission check on both engines, and denied attempts reach the hook (measured). Calls rejected by `deniedPaths` do not, and can cancel other calls of the same response (live recordings). Calls to a tool the agent does not have do not reach it either (V3 live recording). |
| Parallel order | Lines are written in the order the hooks start. No reordering. | The hook input has no sequence number (live recordings), so the order inside a batch of parallel calls can differ from the session. Open. |
| Absent `allow` | Parsed as permission `not_recorded`, classified like an allowed call, counted and stated on screen. | Phase 1 treated absent like malformed (unknown, hidden effects). That would make every recorder call unknown. Malformed stays unknown. |
| Tool names | Mapped to a fixed set by the table below. Never copied. | Tool names are text from the event and can be anything. |
| Shell | `execute_bash` with no `cmd`, always. No option records commands. | Commands can hold secrets and paths. Shell input shape is not measured. |
| Several reads | One line with `paths` and `ranges`. | V2 reads several files in one call (measured). One line keeps one call per log line. |
| Outside | `/outside-workspace`, never a name. Not a request, not a line count, never a repeat, edit class `outside`. | An outside name can reveal the home or other projects. |
| Unknown target | `/workspace`, the phase 1 sentinel for "target unknown". | The classifier already treats it so (R3.5). |
| Failure signal | Exit 1, one fixed stderr line, `recording-failures.jsonl`, and a userPromptSubmit check that asks the agent to relay it. | Exit 2 would block the tool. Kiro does not show preToolUse stderr, and `/dev/tty` output is not shown (measured). userPromptSubmit stdout reaches the agent (measured). stop must not be used: on V3 its stderr starts another agent turn (measured). |
| Recorder test | Runs the real script as a child process, without the permission model. | See steering tech.md. |

## Recorder (recorder/session-autopsy-record.mjs)

Node built-ins only: `node:fs`, `node:path`, `node:os`, `node:process`, `node:buffer`. No `child_process`, network module, `fetch`, `process.env`, dynamic `import()`, `eval` or `new Function`. Named functions, no exports needed.

### Modes

| argv after the script | Hook | Reads stdin | Writes | stdout | Exit |
|---|---|---|---|---|---|
| none or `record` | preToolUse, matcher `*` | yes, at most 64 MiB | one log line, or one failure line | nothing | 0, or 1 on failure |
| `--prompt-check` | userPromptSubmit | never | nothing | nothing when healthy, else the instruction below | 0 |
| `--check` | none, for a human | never | nothing | `session-autopsy-recorder: OK`, or the failure line | 0 or 1 |
| anything else | | no | failure line if the directory is usable | nothing | 1, code `mode_unknown` |

Fixed text, with `<code>` from the failure codes:

- stderr on failure, record mode: `session-autopsy-recorder: RECORDING FAILED (<code>)`
- `--check` on failure, stdout: the same line.
- `--prompt-check` when unhealthy, stdout, one line: `Session Autopsy recorder: recording of this session failed (<code>), so its log is incomplete. Begin your reply with this exact line: Session Autopsy recorder: RECORDING FAILED (<code>)`

Healthy for both checks, which create and write nothing:

- the project is safe;
- when the log directory is missing: the project directory passes `accessSync(W_OK|X_OK)`, else `write_failed`. A missing log directory is otherwise healthy, because the first prompt comes before the first tool call;
- when it exists: it is a real directory (not a symlink) inside the project, else `log_dir_unsafe`, and it passes `accessSync(W_OK|X_OK)`, else `write_failed`;
- `statfsSync` on that directory does not show `bavail === 0` with `blocks > 0`, else `write_failed`. If `statfsSync` throws, this check is skipped;
- `recording-failures.jsonl` does not exist. An existing empty failure file is a failure with code `unknown`: it is what remains when the file was created but the failure line could not be written. (Until run 22 an empty file counted as healthy; that was reversed.)

When the failure file is not empty, `<code>` is the code of its last line if that is a known code, else `unknown`. The failure file is read only after the same checks as a log file (not a symlink, regular, one link). A user clears the state by deleting `recording-failures.jsonl`.

Not every failure is reported. A failure that leaves no file and has cleared, or that these checks cannot see (quota, inode limit, a file size limit before the file could be created, a transient error), can be missed. The criterion that the recorder never hides a failure is NOT met.

### Failure codes

`input_too_large`, `input_invalid` (not UTF-8 JSON, or not an object), `session_id_invalid`, `cwd_mismatch` (missing, not absolute, not resolvable, or not the same real directory as `process.cwd()`), `project_unsafe` (`/`, the home directory or an ancestor of it), `log_dir_unsafe` (a symlink, not a directory, or `process.cwd()` after `chdir` differs), `log_file_unsafe` (symlink, `ELOOP`, `EISDIR`, not regular, more than one link), `write_failed`, `mode_unknown`, `internal`. Codes never contain paths or event text.

Order in record mode: mode, project safety, stdin size, JSON, `session_id`, `cwd`, then the line, then the write. Every failure after project safety appends `{time, code}` (`time` an ISO 8601 UTC string) to `<project>/.session-autopsy/recording-failures.jsonl` when the directory is usable, with the write procedure below. A failure to record the failure changes nothing else: the stderr line and exit 1 stay. The whole run is inside one try/catch that maps any exception to `internal`, so no input gives exit 2.

### Tool table

The event is `{ session_id, cwd, tool_name, tool_input, ... }`. Only these keys are read. A `tool_name` that is not a string or a `tool_input` that is not an object gives `unknown_tool`.

| `tool_name` | `tool_input` (measured) | Logged |
|---|---|---|
| `read`, `fs_read` | `operations[]`, every one `{mode: "Line", path, offset?, limit?}` | `read_file`, `paths`, and `range` (one operation) or `ranges` (several) |
| `read`, `fs_read` | `operations[]`, every one `{mode: "Directory", path}` | `list_directory`, `paths` |
| `read`, `fs_read` | `operations[]` mixing `Line` and `Directory` (measured in a probe: six files and a directory in one call) | `read_file` of only the `Line` operations, in order: `paths` and `range` (one) or `ranges` (several). `Directory` operations have no file effect and are dropped |
| `read`, `fs_read` | empty, any mode other than `Line` or `Directory`, an operation with no mode, an operation that is not an object or whose `path` is not a string | `unknown_tool` |
| `read_file` | `{path, offset, limit}`, null when absent | `read_file`, `paths` with one entry, `range` |
| `write`, `fs_write` with `command` | `create`, `strReplace`, `insert`, with a string `path` | `str_replace`, `paths` with one entry |
| `write`, `fs_write` with `command` | any other command | `unknown_tool` |
| `fs_write` without `command`, `fs_append`, `str_replace` | string `path` | `str_replace`, `paths` with one entry |
| `list_directory` | string `path`: `paths` with one entry; else no `paths` | `list_directory` |
| `grep_search`, `file_search` | not read | `search` |
| `shell`, `execute_bash`, `execute_cmd`, `controlBashProcess` | not read | `execute_bash` |
| anything else | not read | `unknown_tool` |

Range fields: `offset` is copied when it is a safe integer ≥ 0, `limit` when it is a safe integer ≥ 1. `null` and absence mean not given. Any other value, in any operation, makes the whole call `unknown_tool`. A whole-file operation is `{}`. Other keys of an operation are ignored and never copied.

Output keys by tool: `read_file` has `t, hook, tool, paths` and exactly one of `range` or `ranges`; `str_replace` and `list_directory` with a path have `t, hook, tool, paths`; `search`, `execute_bash`, `unknown_tool` and `list_directory` without a path have `t, hook, tool`. `hook` is always `"pre"`. `t` is `Date.now() / 1000`, taken immediately before the write.

### Paths

`project` is `realpath(process.cwd())`. `home` is `realpath(os.homedir())` when it resolves, else `os.homedir()` normalised.

1. Project safety: fail with `project_unsafe` when `project` is `/`, equals `home`, or is an ancestor of `home`. Nothing is written.
2. `cwd`: a string, absolute, and `realpath(cwd) === project`; else `cwd_mismatch`.
3. Each path string `p`:
   - not a string: the call is `unknown_tool` (unknown shape);
   - empty, containing NUL or another control character (U+0000 to U+001F, U+007F), or longer than 1024 characters: `/workspace`;
   - `~` or `~/...`: joined to `home`; `~name...`: `/outside-workspace`;
   - else resolved against `cwd` and normalised.
4. Real resolution: walk from the full path up to the deepest existing ancestor with `lstat`. If any existing component on the way is a symlink whose target does not exist (dangling), the result is `/outside-workspace`. Otherwise `realpath` of that ancestor, plus the missing rest. An error other than `ENOENT` or `ENOTDIR` gives `/workspace`.
5. Result equal to `project`: `/workspace`. Strictly inside `project` (by `path.relative`, so `project-evil` is outside): the relative name with `/` separators. Anything else: `/outside-workspace`.

File names inside the project are written to the log. A file named `outside-workspace` inside the project is logged as `outside-workspace`, without the leading `/`.

### Writes

1. `session_id` must match `^[A-Za-z0-9_-]{1,128}$`, else `session_id_invalid`. The log name is `<session_id>.events.jsonl`.
2. Log directory `<project>/.session-autopsy`: `lstat`; when missing, `mkdir` with mode 0700 and `lstat` again. It must be a directory and not a symlink, else `log_dir_unsafe`.
3. `process.chdir` into it, then `realpath(process.cwd())` must equal `<project>/.session-autopsy`, else `log_dir_unsafe`. From here only bare file names are opened, so a swapped directory cannot redirect the write.
4. `openSync(name, O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK, 0o600)`. `ELOOP` and `EISDIR` give `log_file_unsafe`. `fstat` on the descriptor: regular file and `nlink === 1`, else `log_file_unsafe`, closing without writing.
5. The line is `JSON.stringify(obj) + '\n'`. Above 16 KiB in UTF-8 bytes, it is rebuilt as `{t, hook: "pre", tool: "unknown_tool"}`. One `writeSync` of the whole buffer; a short write gives `write_failed`. Then `closeSync`.
6. The failure file uses steps 2 to 5 with the name `recording-failures.jsonl`.

### Limits, stated in the recorder's header and the README

- Kiro does not show preToolUse stderr, so a failure reaches the user only through the prompt check, `--check` or the failure file.
- The prompt check works only when the agent relays the instruction, and cannot see a failure after the last prompt.
- If `node` is missing, the hook cannot run and cannot report itself.
- The log records attempts. It cannot say whether a call was allowed, denied or ran.
- The log can include denied calls, and some rejected calls never appear. A call rejected by the agent's `deniedPaths` never reaches preToolUse, and other calls of the same response can be cancelled before their hooks run (measured in the live recordings). A call to a tool the agent does not have ("is not available") never reaches preToolUse either: in the V3 live recording Kiro's session store has 14 tool calls and the log 13, the missing one a call to `generate_codebase_overview`, so the first source edit is call 12 in the session and call 11 in the log. Call numbers in the log can therefore differ from the session.
- Calls sent in parallel in one response are logged in the order their hooks happened to start, so the order inside such a batch, including which file is the first source edit, can differ from the session. The hook input has no call id or sequence number, so preToolUse cannot restore it. Open. The live first-source-edit check failed for this reason (BUILD_LOG.md, "Live recordings"); that criterion is NOT met.
- Not every recording failure is reported (see "Modes"). The criterion that the recorder never hides a failure is NOT met.
- File names inside the project are recorded. Commands, contents and outside names are not.

## Reading recorder logs

### Parse

`Call` gains two fields:

```js
Call = { ...phase 1, permission: 'allowed' | 'blocked' | 'not_recorded' | 'unknown',
         ranges: Range[] | null }
```

`allow` absent: `allow: null`, `permission: 'not_recorded'`, not malformed. `true`: `allowed`. `false`: `blocked`. Any other type: `allow: null`, `permission: 'unknown'`, `malformed` has `allow`. `ranges` absent: `null`. An array whose entries all pass the `range` rules: that array. Anything else: `null` and `malformed` has `ranges`.

### Classify

`OUTSIDE = '/outside-workspace'`, exported from `classify.js` and re-exported by `metrics.js`. `Effect` gains `permission`, copied from the call.

| Case | Result |
|---|---|
| `permission === 'blocked'` | `blocked`, as phase 1 |
| `permission === 'unknown'` | `unknown`, hiddenEdit, hiddenRequest, as phase 1 |
| `permission === 'not_recorded'` or `'allowed'` | by tool below |
| `list_directory` | `search`, no requests, no edits, no hidden flags |
| `search` | `search`, hiddenRequest |
| `unknown_tool`, `execute_bash` without `cmd` | `unknown`, hiddenEdit, hiddenRequest |
| `read_file` with `ranges` valid and of the same length as `paths` (and no `range` field) | one request per path by the phase 1 range rules |
| `read_file` with `ranges` present but malformed, of another length, or beside a `range` field | one unlocated request per usable path, no lines |
| `read_file` with one path and no `ranges` | phase 1 |

Per path in a `read_file`: `/workspace`, no path or an unresolvable path gives no request and hiddenRequest. `OUTSIDE` gives no request and no hidden flag. `str_replace` on `OUTSIDE`: an edit `{ file: OUTSIDE, cls: 'outside' }`. A request whose key would be `OUTSIDE` is dropped wherever it comes from, shell included. Other absolute paths keep the phase 1 rule.

### Metrics and findings

`analysis.notRecorded`: traced count of calls with `permission === 'not_recorded'`, built like the other counts (0 traced to all call lines, `null` with `no_calls` when there are none). `couldEdit` is unchanged: an `outside` edit is neither `unknown` nor hidden, so it is never possibly earlier.

`permissionNote(analysis)` in `findings.js` returns parts, or `null` when the count is 0 or unknown:

- 1: "Whether 1 call was allowed or ran was not recorded. It counts as an attempt and can be a denied call."
- N > 1: "Whether N calls were allowed or ran was not recorded. They count as attempts and can include denied calls."

The number is a traced part. The UI shows it in the case line. No screen copy describes a `not_recorded` call as allowed.

Directly after the permission note, and exactly when it is shown, `ui/summary.js` adds one static sentence: "Calls sent in parallel may be logged out of order, so the first edit can be another call of the same batch." It is not part of `permissionNote`, has no number and is not traced.

## Correctness properties, phase 2

- **P21** For every event, record mode exits 0 or 1, never 2. On exit 1, stderr is exactly one failure line and stdout is empty. Validates R13.13.
- **P22** No canary placed in content, old or new text, tool output, prompt, `__tool_use_purpose`, commands, unknown field names or values, tool names, modes, outside paths, the home path or the environment appears in any log, failure file, file name, stdout or stderr. Neither do the project's absolute path and the home path. Validates R13.3, R13.4, R13.8.
- **P23** Every logged path is `/workspace`, `/outside-workspace` or a relative name that resolves inside the project. An outside path never yields a name. Validates R13.9.
- **P24** With a symlinked or non-directory log directory, a symlinked, hard-linked or non-regular log or failure file, every victim outside the log directory keeps its content and listing. Validates R13.11.
- **P25** 40 parallel recordings into one log give exactly 40 complete lines. A line above 16 KiB is never written cut. Validates R13.11.
- **P26** Absent `allow` is `not_recorded` and is classified as if the call ran; malformed is unknown; false is blocked. Validates R14.1, R14.2.
- **P27** A valid `ranges` gives exactly one request per path. An invalid one never yields a `range` or `open` request. Validates R14.4.
- **P28** Gen recorder logs: no request, line count or repeat has the file `/outside-workspace`; no edit on it or on any absolute path has class `source`; every call counted in `possibleEarlier` has hiddenEdit or an `unknown`-class edit. Validates R14.5, R14.7.
- **P29** The three samples give the phase 1 numbers and `notRecorded` 0. Validates R14.8.

## Tests, phase 2

- `test/recorder.test.mjs`: P21 to P25 and R13.14, R13.15, R13.17. Runs as `node test/recorder.test.mjs`. Children get a minimal environment: a fake `HOME` inside the test's temporary root (so `~` cases do not depend on the machine) and one canary variable. POSIX only; it skips on Windows.
- `test/recorder-format.test.mjs`: P26 to P29 through `parse`, `classify`, `analyse` and `findings`. Runs under the permission model.
