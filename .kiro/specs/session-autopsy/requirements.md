# Requirements: Session Autopsy, phase 1

A static page that opens the event log of a recorded coding-agent session and shows which file lines were requested again, when the first source edit was attempted, and where the recorded time went, with a replay. It reads recordings only. It never intervenes and cannot say whether a session succeeded. The log does not record how a session ended, so every share and total is of the recording.

## Terms

- **Log line N**: the Nth physical line of the opened file, counted from 1.
- **Call**: a line with `"hook": "pre"`. Calls are numbered 1, 2, 3 in log order, blocked calls included. The logged `call` field is ignored because blocked lines have none.
- **Note**: any other valid line, for example `"hook": "post"`.
- **Request**: a call asked for file lines. The hook logs before the tool runs, so we only know it was asked for.
- **Edit attempt**: a call asked to write a file.
- **Unknown**: a value the log cannot give. `null` in code, the word "unknown" on screen.
- **Workspace**: `/workspace`, the sanitized working directory.
- **Source file**: inside the workspace, code extension, not a test file, not a scratch script, not under a dot-directory (rule in design.md).
- **Traced value**: `{ value, lines, reason }`, where `lines` are the log lines that support it.

## R1. Open a log

As someone studying agents, I want to open a recorded session in one click, so that I can look at it without setup.

- R1.1 THE page SHALL show the limit statement from product.md on the first screen, before any log is open.
- R1.2 THE page SHALL show one button per bundled sample. WHEN one is pressed, THE page SHALL load and show its autopsy with no further input.
- R1.3 THE page SHALL offer a file input for a local `.jsonl` file and SHALL read it in the browser, with no upload and no storage.
- R1.4 IF the chosen file is larger than 50 MB, THEN THE page SHALL show the error state with the file size and SHALL NOT parse it.
- R1.5 THE page SHALL work from any static HTTP host at any subpath, with no build step, dependency, server code, or network request except same-origin samples. WHEN opened from `file://`, where browsers block module scripts, THE page SHALL show a plain message that it needs to be served over HTTP.
- R1.6 WHILE a log is being parsed, THE page SHALL show "Developing: X of Y log lines".

## R2. Parse

- R2.1 THE parser SHALL split on `\n`, drop one trailing `\r`, and number lines from 1.
- R2.2 THE parser SHALL treat a JSON object with `hook: "pre"` and a string `tool` as a call, and any other JSON object with a string `hook` as a note.
- R2.3 IF a line is not a JSON object, has no string `hook`, or is a `pre` line without a string `tool`, THEN THE parser SHALL record it as broken with its log line and a reason code, never its content.
- R2.4 IF an optional field has the wrong type, THEN THE parser SHALL keep the call, set that field to unknown, and record the field name.
- R2.5 THE parser SHALL skip whitespace-only lines and list them by log line.
- R2.6 THE analysis SHALL ignore the logged `kind`, `spans` and `call` fields, and `paths` on shell calls.

## R3. Classify each call

- R3.1 THE classifier SHALL give each call a category (file request, search, edit attempt, test run, code run, version control, other, blocked, unknown) and a file effect (requests, edit attempts, and whether hidden edits or requests are possible), from `tool`, `cmd`, `range` and `allow` only.
- R3.2 WHEN `allow` is `false`, THE classifier SHALL mark the call blocked, with no request and no edit attempt.
- R3.3 WHEN `read_file` has a `limit`, THE classifier SHALL record lines `offset + 1` to `offset + limit`, with `offset` 0 when absent.
- R3.4 WHEN `read_file` has no `limit`, THE classifier SHALL record an open-ended request from line `offset + 1` and SHALL NOT turn it into counted lines.
- R3.5 WHEN `read_file` or `str_replace` has the path `/workspace` or no single usable path, THE classifier SHALL treat the target as unknown.
- R3.6 THE shell reader SHALL split commands on `&&`, `||`, `;`, `|`, `&` and newline outside quotes, skip heredoc bodies and comments, skip `NAME=value` prefixes, `env` and `timeout`, and track `cd` within the call, starting from the workspace root.
- R3.7 THE classifier SHALL treat redirects to `/dev/null` and file-descriptor copies (`2>&1`) as no write, a write redirect into the workspace as an edit attempt on that file, and one outside the workspace as a scratch write.
- R3.8 WHEN a call runs `grep`, `rg`, `tail` or `wc` on a named file, THE classifier SHALL record a request with unknown lines. WHEN it runs `head -n N`, `sed -n 'A,Bp'` or `cat` on a named file, THE classifier SHALL record lines 1 to N, lines A to B, or an open-ended request from line 1.
- R3.9 THE classifier SHALL mark possible hidden edits for interpreters, inline scripts, heredocs to interpreters, `eval`, command or process substitution, `xargs`, `find` with `-exec` or `-delete`, test runners, git commands that change files, unknown programs and unknown tools.
- R3.10 WHEN `cmd_truncated` is true, or is absent and `cmd` has 200 or more characters, THE classifier SHALL keep only effects of segments that ended before the cut and SHALL mark possible hidden edits and requests.
- R3.11 THE classifier SHALL give these results: `grep x a.py 2> /dev/null` requests `a.py` and edits nothing; `cat a.py > /tmp/x` requests `a.py` and makes a scratch write, not a source edit; `cd pkg && cat a.py` requests `pkg/a.py`; `cat a.py; echo` requests `a.py`.
- R3.12 THE classifier SHALL sort edit attempts into source, test, scratch, other, outside workspace, and unknown target.

## R4. Lines requested

- R4.1 THE analysis SHALL count, per file, how many requests covered each line, stored as merged intervals with the log lines of the covering requests.
- R4.2 THE analysis SHALL report the most requested range per file and overall, with its count and log lines.
- R4.3 THE analysis SHALL count open-ended and unknown-line requests per file beside the line counts. WHEN a file has any, THE screen SHALL say its line counts are a lower bound.

## R5. Repeat requests

- R5.1 THE analysis SHALL mark a request as a repeat request WHEN it contains a line already requested on that file with no recognised edit attempt on that file in between.
- R5.2 THE analysis SHALL reset a file only on an edit attempt with that exact file as target. Edits to other files, unknown targets and unknown effects SHALL NOT reset it.
- R5.3 THE screen SHALL show the number of requests and the number of repeat requests as two separate numbers, plus the number of requests that could not be checked because lines were open-ended or unknown.
- R5.4 THE screen SHALL state that calls with unknown effect may have requested or changed files that are not counted.

## R6. First source edit attempt

- R6.1 THE analysis SHALL report the first call with an edit attempt on a source file: call number, log line, time from start, and share of the recording.
- R6.2 THE analysis SHALL report, with log lines, how many earlier calls could have edited files: possible hidden edits and edit attempts with unknown target.
- R6.3 IF no source edit attempt is recognised, THEN THE screen SHALL say "No source edit attempt recognised in this recording" and the recording-wide count of calls that could have edited files. It SHALL NOT say the agent did not edit.
- R6.4 THE screen SHALL list other edit attempts separately by class.

## R7. Time

- R7.1 THE analysis SHALL give each call the time from its `t` to the next call's `t`, and the last call the time to the last valid event, labelled "time until the next call (tool, model and waiting together)".
- R7.2 THE screen SHALL show time after the last event as an unknown tail.
- R7.3 THE known intervals plus unknown gaps SHALL sum to the span from the first call to the last valid event, and per-category totals SHALL sum to the same span.
- R7.4 THE screen SHALL show the five longest intervals, each with both log lines.
- R7.5 THE screen SHALL show the total time after repeat-request calls.
- R7.6 IF `t` is missing, not a finite number, outside the years 2000 to 2100, or earlier than the previous valid time, THEN THE analysis SHALL mark that time unknown, list it as an anomaly, show the affected time as unknown, and keep log order.

## R8. States

- R8.1 IF the file cannot be read or fetched, THEN THE page SHALL show a load error naming the file and the cause.
- R8.2 IF the file is empty or whitespace only, THEN THE page SHALL show the empty-file state.
- R8.3 IF every non-blank line is broken, THEN THE page SHALL show "not a session log" with the broken log lines.
- R8.4 IF the log is valid but has no calls, THEN THE page SHALL show the no-calls state with the note count.
- R8.5 IF some lines are broken, THEN THE page SHALL analyse the rest, mark every finding and table as partial, and make every broken log line number reachable.
- R8.6 THE page SHALL treat line numbers above 10,000,000 in a range as unknown lines.
- R8.7 Every non-normal state SHALL offer "Open another file".

## R9. Autopsy screen

As a first-time viewer, I want to understand the session in 20 seconds, so that I can decide where to look.

- R9.1 WHEN a log is open, THE screen SHALL first show three findings as plain sentences (most requested lines, first source edit attempt, where the time went), then the evidence.
- R9.2 WHEN a number on screen is focused or clicked, THE screen SHALL show the log lines behind it.
- R9.3 THE screen SHALL read as a Victorian spirit photograph at a glance, and every haunted element SHALL encode data. Decorative ghosts are not allowed.
- R9.4 THE replay SHALL run from the first to the last call, one tab stop, with arrow keys, Home, End and Space. WHILE `prefers-reduced-motion: reduce` is set, it SHALL not autoplay or animate.
- R9.5 THE screen SHALL meet the steering accessibility rules: 44px targets, visible focus, color never alone, no page-level horizontal scroll at 360, 768 and 1280px.
- R9.6 Screen copy SHALL use the steering words and SHALL NOT contain verdict or prediction words, em dashes, emoji or exclamation marks.

## R10. Safety

- R10.1 THE page SHALL insert log text only through `textContent` and SHALL never use it as HTML, URL, selector, class, attribute name or style value.
- R10.2 THE page SHALL set the CSP from tech.md and SHALL make no network request except same-origin sample files.

## R11. Tests

- R11.1 Each core module SHALL have a test file that runs as `node --permission --allow-fs-read=. test/<file>.test.mjs`, with no writes, child processes or network.
- R11.2 Property tests SHALL use a hand-written seeded generator and SHALL print the seed and case on failure. The four cases in R3.11 SHALL be pinned by unit and property tests.
- R11.3 A sample test SHALL check numbers derived by hand from the log text.
- R11.4 A further test SHALL analyse every bundled sample and check invariants only, never numbers copied from the parser's output.

## R12. How a session ended

As a viewer, I want to know whether a recording stopped early, so that I do not read a share of a cut-off recording as a share of a finished session.

- R12.1 THE page SHALL hold the ending of each bundled sample in one pure module, `src/provenance/sample-endings.js`, taken from the benchmark runner's records in DISCLOSURE.md, each with a short label and one sentence that names that source. `src/core` SHALL NOT import it, and no analysis SHALL infer an ending from events.
- R12.2 WHEN a bundled sample is opened through a sample button, THE screen SHALL show its ending sentence directly under the session title and before the headlines, visible in the first viewport at 360x740.
- R12.3 WHEN the user opens a file, whatever its name or content, THE screen SHALL show "Ending unknown: the log does not record how the session ended." in the same place.
- R12.4 THE first screen SHALL show each sample's short ending as text next to its button, including directly below the primary rich-3480 button (within the first 740px at 360 wide) and under the first-screen photograph, and SHALL include it in each button's accessible name or description. Color SHALL NOT carry it alone.
- R12.5 Shares, totals and absence claims SHALL be worded as about the recording: "{share}% of the recording had passed before the first recognised source edit attempt", "{share}% into the recording", "{pct}% of the recorded time came after {category}", "The largest share of the recording", "No source edit attempt recognised in this recording", and the duration labelled "Recorded time". The end of the replay SHALL read "End of the recording".
- R12.6 THE screen SHALL NOT show solved or unsolved and SHALL NOT link repeated requests to an ending.
- R12.7 A test SHALL check the exact ending copy, that every bundled sample has an ending, that a name outside the bundled list and an opened file with a bundled name get "unknown", and that `src/core` does not import the provenance module.
