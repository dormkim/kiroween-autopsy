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

The three files were hand-picked to show different shapes of session. They are not a representative sample and support no statistical claim.
