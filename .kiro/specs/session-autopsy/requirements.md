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
- R9.5 THE screen SHALL meet the steering accessibility rules: 44px targets, visible focus, color never alone, no page-level horizontal scroll at 360, 768 and 1280px. Every control SHALL be at least 44 by 44px, traced number buttons in table cells included. Open limit, not compliance: traced number buttons inside running text are smaller (measured as small as 11 by 38px); each finding has a 44px "Show log lines" button that shows the same log lines.
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
- R12.5 Shares, totals and absence claims SHALL be worded as about the recording: "{share}% of the recording had passed before the first recognised source edit attempt", "{share}% into the recording", "{pct}% of the recorded time came after {category}", "The largest share of the recording", "No source edit attempt recognised in this recording", and the duration labelled "Recorded time". The end of the replay SHALL read "End of the recording". WHEN the recording has fewer than 5 calls, THE second and third headlines SHALL use counts instead of shares: "First recognised source edit attempt at call K of N" (or "No source edit attempt recognised in this recording") and "Only N calls recorded, too few to say where the time went" ("1 call" for one); the finding sentences stay unchanged.
- R12.6 THE screen SHALL NOT show solved or unsolved and SHALL NOT link repeated requests to an ending.
- R12.7 A test SHALL check the exact ending copy, that every bundled sample has an ending, that a name outside the bundled list and an opened file with a bundled name get "unknown", and that `src/core` does not import the provenance module.

# Phase 2: recorder

Measured facts behind these requirements are in the "Phase 2" section of BUILD_LOG.md. Anything not measured there is treated as unknown.

## Terms, phase 2

- **Project**: the real directory the recorder runs in (`process.cwd()`, symlinks resolved).
- **Log directory**: `<project>/.session-autopsy/`.
- **Engine**: Kiro CLI 3.5.0 runs two engines, V2 and V3, with different tool names and input shapes.
- **Failure code**: one of the fixed codes in design.md "Recorder failure codes".

## R13. Recorder

As someone who runs Kiro CLI on my own project, I want a recorder I can copy in, so that my sessions produce logs this page can open, without recording what my files or prompts contain.

- R13.1 THE recorder SHALL be one file, `recorder/session-autopsy-record.mjs`, using only `node:` built-ins, with no network access, no child process and no read of the environment beyond what `node:os` needs for the home directory. A user installs it by copying it to `<project>/.kiro/session-autopsy/` and registering it in a Kiro CLI custom agent, as in `examples/recorder-agent.json`.
- R13.2 WHEN run with no argument or with `record`, as a preToolUse hook with matcher `*`, THE recorder SHALL read one event on stdin and append exactly one line to `<project>/.session-autopsy/<session_id>.events.jsonl`, of the form `{t, hook: "pre", tool, paths?, range?, ranges?}`.
- R13.3 THE recorder SHALL write `tool` only as one of `read_file`, `str_replace`, `list_directory`, `search`, `execute_bash` or `unknown_tool`, chosen by the tool table in design.md. It SHALL NOT copy a tool name from the event. Unknown tool names, unknown input shapes, unknown commands and unknown modes SHALL give `unknown_tool`.
- R13.4 WHEN the event is a shell tool (`shell`, `execute_bash`, `execute_cmd`, `controlBashProcess`), THE recorder SHALL write `execute_bash` with no `cmd`, `paths` or range field.
- R13.5 WHEN a V2 read has several `Line` operations, THE recorder SHALL write one line with `paths` and `ranges` of the same length, `{}` for a whole-file operation. WHEN it has one, THE recorder SHALL write `paths` with one entry and `range`. WHEN a V2 read mixes `Line` and `Directory` operations, THE recorder SHALL write one `read_file` line of only the `Line` operations, in order, by the same two rules, and SHALL drop the `Directory` operations, which have no file effect. WHEN every operation is `Directory`, THE recorder SHALL write `list_directory`. IF any operation has another mode, no mode or no string `path`, THEN THE recorder SHALL write `unknown_tool` for the whole call.
- R13.6 THE recorder SHALL copy `offset` only as a safe integer of at least 0 and `limit` only as a safe integer of at least 1, and SHALL treat `null` or absence as not given. IF either has any other value, THEN THE recorder SHALL write `unknown_tool`. A wrong type SHALL NOT become a whole-file request.
- R13.7 THE recorder SHALL NOT write `allow`, because preToolUse runs before the permission check (measured on both engines).
- R13.8 THE recorder SHALL build every output line from an allow-list of fields. File content, old and new text, tool output, the prompt, `__tool_use_purpose`, commands, values of unknown fields, home paths and absolute paths SHALL NOT appear in the log, on stdout, on stderr or in a file name. There SHALL be no option to record commands. File names inside the project are recorded, and the documentation SHALL say so.
- R13.9 THE recorder SHALL turn each path into exactly one of: a name relative to the project with `/` separators and symlinks resolved, also for a file that does not exist yet and for a project reached through a symlink; `/workspace` for the project itself or an unknown target (not a string, empty, NUL or another control character, longer than 1024 characters); `/outside-workspace` for anything outside the project, including `~` paths outside it, `../`, a symlink leading out, a dangling symlink and a sibling whose name starts with the project's name. An outside path SHALL carry no name.
- R13.10 IF the event's `cwd` is not the same real directory as `process.cwd()`, THEN THE recorder SHALL fail with nothing written outside the log directory. IF the project is `/`, the home directory or an ancestor of it, THEN THE recorder SHALL fail and write nothing, because relative names would reveal the home.
- R13.11 THE recorder SHALL write nothing outside the log directory. It SHALL refuse a symlinked log directory, a symlinked log file, a log file with more than one hard link and a log file that is not a regular file. It SHALL change into the log directory, verify the working directory, open the bare file name with `O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK` and mode 0600, check it with `fstat`, and write one complete line of at most 16 KiB in one write. A longer line SHALL be written as `unknown_tool`, never cut.
- R13.12 THE recorder SHALL fail IF `session_id` does not match `^[A-Za-z0-9_-]{1,128}$` or the input is larger than 64 MiB. It SHALL take `t` as `Date.now() / 1000` immediately before the write.
- R13.13 IF recording fails, THEN THE recorder SHALL exit 1, never 2, under any input, and print exactly one line `session-autopsy-recorder: RECORDING FAILED (<code>)` on stderr. WHERE the log directory is usable, it SHALL also append `{time, code}` to `.session-autopsy/recording-failures.jsonl` with the same write safety.
- R13.14 WHEN run with `--prompt-check` as a userPromptSubmit hook, THE recorder SHALL NOT read or store stdin, SHALL create and write no file, SHALL print nothing when healthy, and WHEN it is not healthy SHALL print the fixed instruction from design.md on stdout and exit 0. Healthy means all of: the project is safe; WHEN the log directory is missing, the project directory is writable and searchable (`accessSync` with `W_OK|X_OK`), else `write_failed`; WHEN it exists, it is a real directory (else `log_dir_unsafe`) that is writable and searchable, else `write_failed`; `statfsSync` on that directory does not show zero available blocks with more than zero blocks, else `write_failed` (IF `statfsSync` throws, THEN this check is skipped); and `recording-failures.jsonl` does not exist. An existing empty failure file SHALL be a failure with code `unknown`, because it is what remains when the failure line could not be written. Deleting the file clears a reported failure.
- R13.15 WHEN run with `--check`, THE recorder SHALL create and write no file and, by the same health rule as R13.14, print `session-autopsy-recorder: OK` with exit 0, or the failure line with exit 1, on stdout.
- R13.15a THE documentation SHALL NOT say that every recording failure is reported. A failure that leaves no file and has cleared, or that these checks cannot see (quota, inode limit, a file size limit before the file could be created, a transient error), can be missed. The acceptance criterion that the recorder never hides a failure is NOT met.
- R13.16 THE documentation SHALL state the limits: stderr of a preToolUse hook is not shown by Kiro (measured); the prompt check works only when the agent relays it and cannot see a failure after the last prompt; a missing `node` cannot report itself; the recorder sees attempts, not whether they were allowed or ran. It SHALL also state two limits measured in the live recordings (BUILD_LOG.md, "Live recordings"):
  - Calls sent in parallel in one response are logged in the order their hooks happened to start, so the order inside such a batch, including which file is the first source edit, can differ from the session. The hook input has no sequence number, so a preToolUse hook cannot restore the order. This is open. The live check that the log names the same first source edit as the session failed for this reason.
  - A call rejected by the agent's `deniedPaths` never reaches the hook, other calls of the same response can be cancelled before their hooks run, and a call to a tool the agent does not have ("is not available", measured on V3 with `generate_codebase_overview`) never reaches the hook either. None of them is in the log, so call numbers in the log can differ from the session. The documentation SHALL say the log can include denied calls and some rejected calls never appear, and SHALL NOT say that all denied calls are included.
  - The acceptance criterion that the log names the same first source edit as the session is NOT met.
- R13.17 `test/recorder.test.mjs` SHALL run the real script as a child process in fresh directories under `os.tmpdir()`, delete nothing, and cover both engines' measured shapes, every privacy item with canary strings, every path case, symlink and hard-link attacks with unchanged victims, invalid inputs, both check modes, a project not named `workspace`, 40 parallel processes and a static import check.

## R14. Reading recorder logs

As a viewer, I want recorder logs to be read as honestly as the samples, so that a call whose permission was not recorded is never shown as allowed.

- R14.1 THE parser SHALL keep apart an absent `allow` (permission `not_recorded`), `true` (`allowed`), `false` (`blocked`) and a wrong type (`unknown`, listed as malformed).
- R14.2 WHEN `allow` is absent, THE classifier SHALL classify the call from `tool`, `cmd`, `paths`, `range` and `ranges` as if it had run, and mark its permission `not_recorded`. THE screen SHALL NOT describe such a call as allowed. A malformed `allow` SHALL stay unknown with hidden effects, and `false` SHALL stay blocked.
- R14.3 THE analysis SHALL export a traced count of calls whose permission was not recorded. WHEN it is above 0, THE screen SHALL show "Whether N calls were allowed or ran was not recorded. They count as attempts and can include denied calls." or, for one call, "Whether 1 call was allowed or ran was not recorded. It counts as an attempt and can be a denied call." Directly after that note, and exactly when it is shown, THE screen SHALL show the static sentence "Calls sent in parallel may be logged out of order, so the first edit can be another call of the same batch."
- R14.4 WHEN `ranges` is an array of the same length as `paths` whose entries are valid ranges, THE classifier SHALL give one request per path, each by the `read_file` range rules. IF `ranges` is present and invalid, THEN THE classifier SHALL give a request with unknown lines on each usable path and SHALL NOT invent ranges.
- R14.5 THE path `/outside-workspace` SHALL never be a file key for requests or line counts and SHALL never be a repeat. A write there SHALL have class `outside`. It SHALL NOT be a source edit or count among the calls that might have changed files earlier.
- R14.6 THE classifier SHALL treat `list_directory` as a search with no effects, `search` as a search with possible hidden requests, and `unknown_tool` and `execute_bash` without `cmd` as unknown with possible hidden edits and requests.
- R14.7 Other absolute paths SHALL keep the phase 1 rule: only `/workspace` is the project.
- R14.8 These changes SHALL NOT change any number for the three bundled samples.
- R14.9 `test/recorder-format.test.mjs` SHALL check R14.1 to R14.7 end to end through `parse` and `analyse`, including the first source edit attempt and repeats, with a seeded property that no path outside the project becomes a source edit, under the permission model.
