# Session Autopsy

A static web page that opens the event log of a recorded coding-agent session and develops it like a spirit photograph. Each requested file is a plate. Every request exposes its lines once, so lines requested again come out brighter, and the ghost forms exactly where requests repeated.

It shows:

- which file lines were requested again, and how many times;
- when the first source edit was attempted;
- where the time went between logged events;
- a replay of all of it, one call at a time.

Every number on the page links back to the log lines it was counted from.

## What it does not claim

In three comparisons of interventions we did not confirm more issues solved, so this only reads recordings after a session ends. It never intervenes.

It does not fix agents, save credits or predict anything. It cannot say whether a session succeeded, because the log has no outcome. Repeated requests are shown as counts and line numbers, never as a judgement.

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

Each file also runs on its own, for example `node --permission --allow-fs-read=. test/parse.test.mjs`. Property tests accept `SEED=<n>`. The tests read files and never write, spawn processes or use the network.

## Log format

One JSON object per line (`*.events.jsonl`), as written by a pre-tool hook:

- `"hook": "pre"` lines are calls. They need a string `tool`. Optional fields: `t` (epoch seconds), `cmd`, `cmd_truncated`, `allow`, `paths`, `range` (`offset`, `limit`).
- Lines with any other `hook` (for example `"post"`) are notes. They are counted and listed, never treated as calls.
- The logged `kind`, `spans` and `call` fields are ignored. Every call is classified again from `tool`, `cmd`, `range` and `allow`.
- `"allow": false` is shown as blocked by the recording hook.
- Lines that cannot be read are listed by log line number, and every result is marked partial.

## Privacy

A log you open is read in your browser and stays there. Nothing is uploaded or stored. The only network requests are for the page's own files and the bundled samples in `samples/`. A Content Security Policy in `index.html` enforces this, and log text is only ever inserted as text.

## Limits

- The hook logs before a tool runs, so a request means the lines were asked for. The log does not show what came back.
- File lengths are not logged. A request without a line range counts as "whole file, length unknown" and does not add to line counts.
- Shell commands are read with a small, conservative parser. Interpreters, inline scripts, unknown programs and commands cut at 200 characters may have touched files the log does not show. They are marked as unknown, never as zero.
- Time per call is the time until the next call: tool, model and waiting together. The time after the last event is unknown.
- Opened files are limited to 50 MB.
- The three sample logs were hand-picked to show different session shapes. They support no statistical claim.

## How the samples ended

The event logs do not record how a session ended, so every share and total on the page is about the recording, from the first event to the last. For the bundled samples the ending comes from the earlier benchmark runner's records and is shown as text:

- `rich-3480`: cut off. The runner stopped the agent at its 15-minute (900 s) time limit.
- `rich-3506`: crashed. Kiro's server shut down with `RangeError: Invalid string length`, about 2 minutes after the last recorded event. No fault is assigned to the agent.
- `requests-6644`: exited normally, with exit code 0. The log has no outcome.

A file you open yourself, even one with a sample's name, shows "Ending unknown". Sources and line references are in [DISCLOSURE.md](DISCLOSURE.md).

## How it was built

Claude Code directed and verified the work, and Kiro CLI wrote the code: the steering documents, the spec, the page, the tests and the write-guard hook. Kiro had no shell, so Claude Code ran the tests and checks. See [DISCLOSURE.md](DISCLOSURE.md) for who made what and where the sample logs come from, and [BUILD_LOG.md](BUILD_LOG.md) for each session.

## License

MIT. See [LICENSE](LICENSE).
