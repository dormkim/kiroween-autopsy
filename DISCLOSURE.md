# Disclosure

## Who made what
- **Claude Code (Anthropic) directed and verified this project. Kiro CLI wrote the code.**
- Kiro CLI wrote the steering documents, the spec, the application, the tests and the hook script. The session for each change is in [BUILD_LOG.md](BUILD_LOG.md) and in the commit message.
- Claude Code wrote this file, `BUILD_LOG.md`, the prompts given to Kiro, the Kiro agent permission file (`.kiro/agents/autopsy-builder.json`) and the git commits. It also prepared the sanitized sample copies described below and ran tests, checks and screenshots, because Kiro had no shell.
- The prompts were detailed. Much of the product definition, such as the metric rules and the safety limits, came from those prompts, and Kiro turned them into spec and code.
- A human (the entrant) chose this direction and owns the submission.

## Relation to earlier work
- The entrant earlier built a separate prototype, `loop-exorcist`, mostly with Claude Code. **None of its code was copied into this project.**
- What was reused is listed here: the idea of looking at repeated reads, the lessons from its experiments, its event log format, and three of the logs it recorded.
- Its classifier labels (`kind`, `spans`) are still present in the sample logs. This project does not trust them and classifies again from `tool`, `cmd` and `range`.
- In three comparisons of interventions, that earlier work did not confirm an improvement in issues solved. This project does not claim to fix agents or to predict failure.

## Pre-existing data in `samples/`
These are event logs of Kiro CLI sessions (model `qwen3-coder-next`) on public issues, recorded in November 2026 by the earlier prototype's hook in observe mode. A benchmark rule blocked web lookups, so some calls have `"allow": false`. The logs contain no file contents or tool outputs. Commands are cut at 200 characters by the recorder and can contain short fragments written by the agent.

| File | Task origin | Base commit | Upstream license |
|---|---|---|---|
| `rich-3480.events.jsonl` | [Textualize/rich](https://github.com/Textualize/rich), task 3480 | `9ec419154102acce7363e3958bec6c261864d7fb` | MIT, Copyright (c) 2020 Will McGugan |
| `rich-3506.events.jsonl` | [Textualize/rich](https://github.com/Textualize/rich), task 3506 | `4101991898ee7a09fe1706daca24af5e1e054862` | MIT, Copyright (c) 2020 Will McGugan |
| `requests-6644.events.jsonl` | [psf/requests](https://github.com/psf/requests), task 6644 | `382fc2c0c6c0ef0874bc65bc1175f97c073e5086` | Apache-2.0 |

Changes made to the copies:
1. The run directory was replaced with `/workspace`, the lab directory with `/lab`, and any other home path with `/redacted-home`.
2. `cmd_truncated` was added to each event with a command. It is true when the original command field was 200 characters or longer, which can no longer be measured after step 1.
3. The copies were scanned for key, token, email and IP patterns (no match), and every distinct command was read once by Claude Code. The original files were left unchanged.

The task prompts and base commits belong to the upstream projects; only the event logs are here. In `rich-3480` the agent also requested two files of the recorder hook installed in its workspace (`.kiro/exorcist/...`), so that session was not free of the recorder's influence.

## How each sample recording ended

**Two of the three recordings did not end normally.** The event logs do not contain this. It comes from the earlier runner's result rows and, for the crash, its agent log. Those files are not in this repository. Paths below are relative to the earlier `loop-exorcist` repository (commit `97aa34f` for the result files) or, for the agent log, to that benchmark's run directory.

| Sample | How it ended | Runner's `agent_rc`, `seconds` | Source |
|---|---|---|---|
| `rich-3480` | **Cut off.** The runner killed the agent at its 900 second time limit. | `"timeout"`, 900.0 | `bench/results/dev_digest_1.jsonl` line 3. The limit and the kill are in `bench/run_real.py` lines 69 to 72 and 93. |
| `rich-3506` | **Crashed.** Kiro's server shut down with `RangeError: Invalid string length`. The runner wrote its log 121 seconds after the last recorded event. | `1`, 477.9 | `bench/results/dev_digest_2.jsonl` line 7, and `runs/rich_3506-observe-qwen3-coder-next.agent.log` lines 568 to 581. |
| `requests-6644` | **Exited normally.** The agent process exited with code 0. | `0`, 473.3 | `bench/results/dev_digest_2.jsonl` line 15. |

What this means for the numbers:
- Every percentage is a share of the recording, from the first event to the last one. For the two recordings that did not end normally it is not a share of a finished session.
- In `rich-3480`, "90%" is 90% of a recording that was cut off. The recording covers 888.0 of the 900 seconds before the kill.
- In `rich-3506`, "no source edit attempt recognised" describes a recording that ends in a crash. It does not show what the agent would have done next. The error was raised inside Kiro's server, and no fault is assigned to the agent.
- "Exited normally" does not mean that the task was solved. The runner's test verdicts are not used in this project, and three sessions cannot link repeated reads to success or failure.

How the rows were matched to the files: task, mode, number of calls that were not blocked and number of blocked calls are equal, and only one of the two benchmark rounds matches each file. The round 1 agent log for `rich-3480` no longer exists: round 1 was kept as hard links and round 2 wrote over the same files. Its ending therefore rests on the result row and the runner's code only. The event files were not affected.

These sessions were recorded by the earlier benchmark with `--trust-all-tools`. That flag was not used to build this project.

## Why these three

They were picked by Claude Code, by hand, from a scan of the 24 observe-mode recordings in two benchmark rounds. The scan showed call counts, duration, the most read files and the first edit call. It did not show how the sessions ended, and that was not checked until after the first version was built.
- `rich-3480`: many repeated requests on one file and a very late first edit, which makes the replay vivid.
- `rich-3506`: no recognised source edit, to exercise that state.
- `requests-6644`: shorter, from another repository, with an edit in the middle and a long test run.

This choice favours striking examples. Of those 24 recordings, 13 hit the time limit, 1 exited with an error and 10 exited with code 0. The three samples are not representative and support no statistical claim.
