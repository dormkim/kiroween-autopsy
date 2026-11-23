# Session Autopsy

A static web page that opens the event log of a recorded coding-agent session and develops it like a spirit photograph. Each requested file is a plate. Every request exposes its lines once, so lines requested again come out brighter. The figure appears with the first request of the most requested lines and gains one exposure each time they are requested again.

It shows:

- which file lines were requested again, and how many times;
- when the first source edit was attempted;
- where the time went between logged events;
- a replay of all of it, one call at a time.

Numbers counted from a log link back to its lines. How a bundled sample ended comes from separate records, not from the log.

You can record your own Kiro CLI session with the bundled hook (see "Record your own session"). Such a log draws a figure only when the agent requested explicit line ranges, and neither live test recording did.

## How Kiro was used

Kiro CLI wrote the spec, code, tests and this README, in runs numbered as in [BUILD_LOG.md](BUILD_LOG.md). Claude Code was the reviewer: it wrote the prompts, which sometimes dictated README sentences, ran the tests and committed. CLI agents keep hooks in the agent file, so the build hooks are registered in `.kiro/agents/autopsy-builder.json`. [DISCLOSURE.md](DISCLOSURE.md) says who made what and where the sample logs come from.

| Feature | What it did | Evidence |
|---|---|---|
| Steering | Product rules, words, tech limits, structure and the visual concept, in `.kiro/steering/` | BUILD_LOG run 1, updated in later runs |
| Spec | Requirements with EARS criteria, design with correctness properties, tasks in increments, in `.kiro/specs/session-autopsy/` | runs 2 and 3; recorder added in run 15 |
| Custom agent | `autopsy-builder`: read and write tools only, paths limited to the project, no shell. Its boundary was tested in 23 probe sessions before any code | run 0 |
| Agent hook: write guard | `scripts/hooks/write-guard.mjs` checked the Kiro writes after run 1. Its one block was the deliberate live test | runs 1 and 1b, `build-evidence/write-guard.jsonl` |
| Agent hook: recorder | `recorder/session-autopsy-record.mjs`, the preToolUse and userPromptSubmit hook this project ships | runs 15 to 17, "Live recordings" |
| Property-based tests | Seeded generators pin the four shell regression cases. Seeds 7, 12345 and 987654321 found no failure. They did not find the `sed -i` and `tee` gap, which a reviewer's probe found | runs 5 and 6, "Verification" sections |
| Headless CLI | Build runs used `chat --v2 --no-interactive`. The recorder probes ran headless on both the V2 and V3 engines | run 1 onward, "Probe sessions before the spec" |

Not used: Kiro IDE, Kiro Web, Crew, MCP, powers, and a shell for Kiro.

What failed:

- Run 4 exited with code 0 and wrote nothing: it ran out of output while planning. Run 5 resumed it in smaller steps.
- Run 6 stopped after writing failing tests. Run 7 resumed it.
- Run 7 left two `tee` tests failing. Run 8 fixed them.
- Review found false claims: that `file://` works (fixed in run 12), that the samples were finished sessions, while two did not end normally and the page did not show how any of them ended (runs 13 and 14), and more from an outside review (run 17).
- The live check that the log names the same first source edit as the session was not met, because parallel calls are logged in the order their hooks started ("Live recordings").
- An independent check found recording failures that the recorder's checks hid, and a wrong count in the V3 live result (13 of 13 tool calls, where the session had 14). Run 22 fixed these as far as stated in "Limits". Two acceptance criteria are NOT met: that the log names the same first source edit as the session, and that the recorder never hides a failure.

## What it does not claim

In three comparisons of interventions we did not confirm more issues solved, so this page only reads recordings after a session ends. It never intervenes.

The recorder that writes the logs never blocks or steers the agent, with one exception: when recording fails, its prompt check asks the agent to say so.

It does not fix agents, save credits or predict anything. It cannot say whether a session succeeded, because the log has no outcome. Repeated requests are shown as counts and line numbers, never as a judgement.

## Record your own session

The recorder is one file, `recorder/session-autopsy-record.mjs`. It runs as a Kiro CLI hook and needs Node. It was measured on Kiro CLI 3.5.0 only. In your project directory:

1. Copy `recorder/session-autopsy-record.mjs` to `.kiro/session-autopsy/session-autopsy-record.mjs`.
2. Copy `examples/recorder-agent.json` to `.kiro/agents/recorder-agent.json`. It defines an agent named `recorded` that can read and write files inside the project, with no shell, no web and no MCP.
3. Add `.session-autopsy/` to your `.gitignore`. The logs hold file names from your project.
4. Check the setup:

   ```sh
   node .kiro/session-autopsy/session-autopsy-record.mjs --check
   ```

   It prints `session-autopsy-recorder: OK`, or a line with `RECORDING FAILED` and a code.

The example agent writes files inside the project without asking you, because its `allowedPaths` pre-approve them, and it reads them without asking too. Use it only in a project under version control, or add the hooks to your own agent instead (below).

5. Start a session with the agent on the V2 engine:

   ```sh
   kiro-cli chat --v2 --agent recorded
   ```

   Interactive `kiro-cli chat` uses the V3 engine by default, which gives this agent more tools, including `delete_file` (see below). Start it from the project directory. The recorder refuses to record when that directory is /, your home directory or above it, and it was tested on Linux (live sessions) and macOS (test file only).

6. Afterwards, open `.session-autopsy/<session_id>.events.jsonl` with "Open a log file" on the page.

To record with an agent you already have, add the two hook entries from `examples/recorder-agent.json` to the `hooks` object of your agent file, next to any hooks it has:

```json
"preToolUse": [
  { "matcher": "*", "command": "node .kiro/session-autopsy/session-autopsy-record.mjs" }
],
"userPromptSubmit": [
  { "command": "node .kiro/session-autopsy/session-autopsy-record.mjs --prompt-check" }
]
```

If your agent already has a `preToolUse` or `userPromptSubmit` list, add the entry to that list instead of adding a second key.

If you start an agent on the V3 engine, Kiro CLI may rewrite the agent file into its own format and keep the original as a `.bak` copy. This was seen in a probe. Check that both hook entries are still there after the first start.

On the V2 engine the example agent has exactly two tools, read and write. On V3 the same read and write capabilities expanded in a probe to more tools, including `delete_file`, `code` and `grep_search`. There was still no shell, and reads and writes outside the project were denied. Deleting, the `code` tool and the denied paths inside the project were not tested on V3. That is why step 5 starts the example agent with `kiro-cli chat --v2 --agent recorded`; do not start it without `--v2`.

### What it records

One line per tool call: the time, a fixed tool name, file names relative to the project, and line ranges for reads.

- File names inside the project are recorded. They can be sensitive.
- A path outside the project is written as `/outside-workspace`, with no name. The project itself, and a target that cannot be read, is `/workspace`.
- Every call that reaches the hook is recorded as an attempt. The hook runs before Kiro's permission check, so the log cannot say whether a call was allowed, denied or ran. The log can include denied calls, and some rejected calls never appear: a call rejected by the agent's `deniedPaths` never reaches the hook, other calls of the same response can be cancelled before their hooks run, and a call to a tool the agent does not have ("is not available") never reaches the hook either. The page says how many calls have no recorded permission.
- Calls sent in parallel in one response are logged in the order their hooks happened to start. Inside such a batch the log order can differ from the session, including which file is the first source edit. The hook input has no sequence number, so a preToolUse hook cannot restore the order.

What it never records: commands, file contents, old or new text of an edit, tool output, prompts, tool-use purposes, values of unknown fields, absolute paths and home paths. Commands are never recorded, and there is no option to record them, because they can hold secrets. A shell call is logged only as `execute_bash`, so the page shows its effect as unknown.

### When recording fails

Kiro does not show the stderr of a failing preToolUse hook. When the recorder fails, it exits with code 1 (never 2, which would block the tool), so the tool still runs and that call is missing from the log. It also tries to append the time and a failure code to `.session-autopsy/recording-failures.jsonl`. When that directory cannot be written, nothing is appended.

- `--check` and the prompt check create and write nothing. They report a failure when the project or the log directory is unsafe, the log directory is not writable or not searchable, the project is not writable while the log directory does not exist yet, the file system shows no available blocks, or `recording-failures.jsonl` exists. An empty failure file is reported with the code `unknown`, because it is what remains when the failure line could not be written.
- `--check` tells you about the state right now. It cannot tell you whether Kiro actually runs the hook, and it cannot see a failure that happens later.
- The prompt check runs at each prompt. When it finds a failure, it asks the agent to begin its reply with `Session Autopsy recorder: RECORDING FAILED (<code>)`. This works only when the agent relays the line, and it cannot see a failure after the last prompt.
- Not every failure is reported. A failure that leaves no file and has cleared before the next check, or that these checks cannot see (a disk quota, an inode limit, a file size limit before the file could be created, a transient error), can be missed.
- If `node` is missing, the hook cannot run and nothing reports it.

Delete `recording-failures.jsonl` to clear a reported failure.

## Run it

The page has no build step and no dependencies, but it needs an HTTP server: browsers block ES module scripts opened from `file://`, so opening `index.html` from disk only shows a message saying so. From the repository root:

```sh
python3 -m http.server --bind 127.0.0.1 8000
```

Then open `http://127.0.0.1:8000/`. Any static server works, also under a subpath, because every path in the page is relative. "Open a log file" and the sample buttons both work there.

## Test it

Node 22.13 or later, standard library only:

```sh
npm test
```

Each file also runs on its own, for example `node --permission --allow-fs-read=. test/parse.test.mjs`. Property tests accept `SEED=<n>`. These tests read files and never write, spawn processes or use the network.

One file is the exception: `test/recorder.test.mjs` runs as `node test/recorder.test.mjs`, without the permission model. It runs the real recorder as child processes and writes fresh temporary directories under the system's temporary directory. It never deletes them and uses no network.

## Log format

One JSON object per line (`*.events.jsonl`), as written by a pre-tool hook:

- `"hook": "pre"` lines are calls. They need a string `tool`. Optional fields: `t` (epoch seconds), `cmd`, `cmd_truncated`, `allow`, `paths`, `range` (`offset`, `limit`) and `ranges`.
- `tool` is one of the names the page knows: `read_file`, `str_replace`, `list_directory`, `search`, `execute_bash`, `unknown_tool`, and `web_fetch` from the samples. Any other name is a call with unknown effect.
- `allow` is optional. Absent means the permission was not recorded: the call counts as an attempt, its requests and edits are counted as attempted, and the page says that permission is unknown. It is never shown as allowed. `false` means the recording hook blocked it, and it is shown as blocked. `true` means allowed. Any other value is malformed, and the call's effect is unknown.
- `ranges` is an array with one range per entry of `paths`, for a read of several files in one call. If it is malformed or of another length, the lines of those requests are unknown.
- `/outside-workspace` stands for a path outside the project. It is never counted as requested lines and is never a source edit.
- Lines with any other `hook` (for example `"post"`) are notes. They are counted and listed, never treated as calls.
- The logged `kind`, `spans` and `call` fields are ignored. Every call is classified again from `tool`, `cmd`, `paths`, `range`, `ranges` and `allow`.
- Lines that cannot be read are listed by log line number, and every result is marked partial.

The page does not read raw Kiro events, and it does not know Kiro's own tool names such as `read`, `write`, `fs_read`, `fs_write` or `shell`. The recorder converts them to the names above. In a log from another source, only `/workspace` and paths under it, or relative paths, count as the project. Any other absolute path is outside the project and is never a source edit.

## Privacy

A log you open is read in your browser and stays there. The code has no upload and no storage: the only network requests are for the page's own files and the bundled samples in `samples/`, and log text is only ever inserted as text. The Content Security Policy in `index.html` blocks connections to other origins, but it does not by itself prevent a request to the server that hosts the page.

## Limits

- The hook logs before a tool runs, so a request means the lines were asked for. The log does not show what came back.
- File lengths are not logged. A request without a line range counts as "whole file, length unknown" and does not add to line counts.
- Shell commands are read with a small, conservative parser. Interpreters, inline scripts, unknown programs and commands cut at 200 characters may have touched files the log does not show. They are marked as unknown, never as zero.
- Time per call is the time until the next call: tool, model and waiting together. The time after the last event is unknown.
- Order of parallel calls: recorded logs keep the order in which the hooks of parallel calls started, not the session's order. In the V2 live recording three edits sent in one response were logged in another order, so the log named `orchard/report.py` as the first source edit where the session's was `orchard/units.py`. That acceptance check failed and stays open: the hook input has no sequence number.
- Missing calls: calls rejected by `deniedPaths`, calls of the same response cancelled before their hooks ran, and calls to a tool the agent does not have are not in a recorded log. Call numbers in the log can therefore differ from the session. In the V3 live recording Kiro's session store has 14 tool calls and the log 13: the missing one was a call to `generate_codebase_overview`, which the agent does not have, so the first source edit is call 12 in the session and call 11 in the log.
- Recording failures: the recorder's checks report the failures listed in "When recording fails". A failure that leaves no file and has cleared, or that the checks cannot see, can be missed. The acceptance criterion that the recorder never hides a failure is NOT met.
- Opened files are limited to 50 MB.
- Touch targets: every control is at least 44 by 44px, except numbers inside running text (finding sentences and notes), which are buttons as small as 11 by 38px. This is an open limit, not compliance. Each finding has a 44px "Show log lines" button that shows the same log lines.
- The three sample logs were hand-picked to show different session shapes. They support no statistical claim.

### Not verified for the recorder

- The input of Kiro's shell tool was not measured. A shell call is recorded only as `execute_bash`, and what it did, including any file it changed, is unknown.
- MCP tools and other tools not listed in the recorder were not measured. They are recorded as `unknown_tool`.
- Windows was not tested. The recorder tests skip there.
- Kiro CLI versions other than 3.5.0 were not tested.
- Whether a recorded edit attempt really changed a file was not measured for any tool.

## How the samples ended

The event logs do not record how a session ended, so every share and total on the page is about the recording, from the first event to the last. For the bundled samples the ending comes from the earlier benchmark runner's records and is shown as text:

- `rich-3480`: cut off. The runner stopped the agent at its 15-minute (900 s) time limit.
- `rich-3506`: crashed. The benchmark runner's agent log shows Kiro's server shut down with an internal error (`RangeError: Invalid string length`). The time of the crash is not recorded; the runner wrote that log 121 seconds after the last recorded event. No fault is assigned to the agent.
- `requests-6644`: exited normally, with exit code 0. The log has no outcome.

A file you open yourself, even one with a sample's name, shows "Ending unknown". Sources and line references are in [DISCLOSURE.md](DISCLOSURE.md).

## License

MIT. See [LICENSE](LICENSE).
