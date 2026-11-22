# Product: Session Autopsy

Session Autopsy is a static web page. It opens the event log (`*.events.jsonl`) of a finished coding-agent session and shows:

- which file lines were requested again, and how many times;
- when the first source edit was attempted;
- where the time went between logged events;
- all of it replayed on a timeline.

It is a Kiroween 2026 Costume Contest entry. The haunting look is how the data is drawn (see `design.md`). It is never decoration on top of the data.

Audience: people who build or study coding agents and want to look closely at one recorded session after it ended.

## Claims

The product does not fix agents, improve solve rates, save credits, or predict failure, live or afterwards. It cannot say whether a session succeeded, because the log has no outcome. It reads a recording after the session ended and never intervenes.

The first screen says this in one short paragraph, in these words or very close:

> In three comparisons of interventions, we did not confirm that more issues were solved. So Session Autopsy only reads recordings after a session has ended. It never intervenes.

Never write, in copy, code comments, docs or commit text:
- "found it but did not fix it" or any variant;
- benchmark percentages, solve rates, or comparisons between agents or models;
- prediction or verdict words about a session: "would have failed", "early warning", "stuck", "wasted", "doomed", "healthy", "struggling".

Repeated reading is described with counts and line numbers. It is never judged.

## Words

| Use | For | Never |
|---|---|---|
| requested | a read. The hook logs before the tool runs, so we only know it was asked for. | read, viewed, saw |
| edit attempt | a write or edit call | edited, changed, fixed |
| call | one logged tool call (a `"hook": "pre"` line) | step, action, turn |
| log line 47 | a 1-based physical line in the opened log file | line 47 (ambiguous with file lines) |
| unknown | any value the log cannot give | 0, none, n/a, -, blank |
| session | one recorded agent session | run, episode, trace |

## Reading the log

1. Ignore the logged `kind` and `spans` fields completely. Classify every call again from `tool`, `cmd` and `range`. `paths` counts only as the argument of a file tool (`read_file`, `str_replace` and similar). For shell calls, targets come from `cmd`.
2. `cmd` is cut at 200 characters when `cmd_truncated` is true. The visible part can still set the category, but anything the cut part could have done (more target files, a file write) is unknown.
3. Each call has two separate results: a category (what kind of call it is) and a file effect (`none`, `requested`, `edit attempt`, or `unknown`). Starting categories: file request, search, run, edit attempt, version control, blocked, unknown. The spec lists the tools and command patterns seen in `samples/`.
4. A read with an empty `range` requests the whole file. Its length is unknown. A `limit` without an `offset` starts at the file start. The offset base (0 or 1) is not documented, so the detail view shows ranges as logged ("offset 360, limit 50"). Overlap counts do not depend on the base.
5. The first source edit attempt is the first call with an edit attempt on a source file: inside the workspace, code extension, not a test file, not a scratch script, not under a dot-directory (the spec's edit classes). Edit attempts on other files are listed separately by class. Earlier calls that could have edited files (possible hidden edits, and edit attempts with an unknown target) are counted and listed with it: "First recognised source edit attempt: call 46, log line 46. 13 earlier calls could have changed files: unknown." If none is recognised, the screen says "No source edit attempt recognised", never that the agent did not edit.
6. `"allow": false` means the recording hook blocked the call. Show it as blocked, never as run.
7. Lines that are not `"hook": "pre"` (for example `"hook": "post"`) are not calls. They are counted and listed by log line.

## Unknown, failure, empty

- Unknown is `null` in code and the word "unknown" on screen. A failure is never shown as 0 or as an empty list.
- A 0 or an empty list appears only when the log proves it.
- These are different states with different messages:
  - the file could not be opened or fetched (error);
  - the file is empty (0 bytes or whitespace only);
  - some lines are broken: show how many and their log line numbers, compute from the rest, and mark every result as partial;
  - every line is broken (error: not a session log);
  - the log is valid but has no calls (empty result).

## Traceability

Every number on screen can be traced to raw log line numbers. Focus or click on it and the screen shows the lines, for example "log lines 5, 7, 16". A duration shows the log lines of both ends.

## Time

`t` is the time in epoch seconds when the hook ran, before the tool ran. The time of a call is the time until the next call, labelled "time until the next call (tool, model and waiting together)". Notes do not split it. The last call's time runs to the last valid event. The total is first call to last valid event "plus an unknown tail". Times on screen are relative to the first call, as m:ss.

## Privacy and copy

- A log opened by the user stays in the browser. No upload, no storage, no network request except same-origin sample files.
- Screen copy is plain English in sentence case. No hype, no emoji, no em dashes, no exclamation marks.
- The repo contains no absolute home paths, personal data, secrets, or personal operations scripts.
