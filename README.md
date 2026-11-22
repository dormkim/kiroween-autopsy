# Session Autopsy

A static web page that opens the event log of a recorded coding-agent session and develops it like a spirit photograph. Each requested file is a plate. Every request exposes its lines once, so lines requested again come out brighter. The figure appears with the first request of the most requested lines and gains one exposure each time they are requested again.

It shows:

- which file lines were requested again, and how many times;
- when the first source edit was attempted;
- where the time went between logged events;
- a replay of all of it, one call at a time.

Numbers counted from a log link back to its lines. How a bundled sample ended comes from separate records, not from the log.

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
5. Start a session with the agent:

   ```sh
   kiro-cli chat --agent recorded
   ```

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

The V3 engine of Kiro CLI may rewrite the agent file into its own format and keep the original as a `.bak` copy. This was seen in a probe. Check that both hook entries are still there after the first start.

### What it records

One line per tool call: the time, a fixed tool name, file names relative to the project, and line ranges for reads.

- File names inside the project are recorded. They can be sensitive.
- A path outside the project is written as `/outside-workspace`, with no name. The project itself, and a target that cannot be read, is `/workspace`.
- Every call the agent asks for is recorded as an attempt. The hook runs before Kiro's permission check, so the log cannot say whether a call was allowed, denied or ran. Denied calls are included, and the page says how many calls have no recorded permission.

What it never records: commands, file contents, old or new text of an edit, tool output, prompts, tool-use purposes, values of unknown fields, absolute paths and home paths. Commands are never recorded, and there is no option to record them, because they can hold secrets. A shell call is logged only as `execute_bash`, so the page shows its effect as unknown.

### When recording fails

Kiro does not show the stderr of a failing preToolUse hook. When the recorder fails, it exits with code 1 (never 2, which would block the tool), so the tool still runs and that call is missing from the log. It also appends the time and a failure code to `.session-autopsy/recording-failures.jsonl` when that directory is usable.

- `--check` tells you whether the project, the log directory and the failure file are in order right now. It cannot tell you whether Kiro actually runs the hook, and it cannot see a failure that happens later.
- The prompt check runs at each prompt. When the failure file is not empty, it asks the agent to begin its reply with `Session Autopsy recorder: RECORDING FAILED (<code>)`. This works only when the agent relays the line, and it cannot see a failure after the last prompt.
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
- `allow` is optional. Absent means the permission was not recorded: the call counts as an attempt and is classified as if it ran. `false` means the recording hook blocked it, and it is shown as blocked. `true` means allowed. Any other value is malformed, and the call's effect is unknown.
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

## How it was built

Claude Code directed and verified the work, and Kiro CLI wrote the code: the steering documents, the spec, the page, the tests and the write-guard hook. Kiro had no shell, so Claude Code ran the tests and checks. See [DISCLOSURE.md](DISCLOSURE.md) for who made what and where the sample logs come from, and [BUILD_LOG.md](BUILD_LOG.md) for each session.

## License

MIT. See [LICENSE](LICENSE).
