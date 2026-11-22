# Build log

Claude Code directed and verified. Kiro CLI wrote the code and the spec. Claude Code writes this log.
Entries are appended when a run happens and are not rewritten afterwards.

- Tool: Kiro CLI 3.5.0, V2 engine, headless (`chat --v2 --no-interactive --agent autopsy-builder`).
- Never used: `--trust-all-tools`, `-a`, a shell tool for Kiro, web tools, MCP.
- The earlier prototype's warning hook was not installed or enabled during this build.
- "Account meter" is the account-wide `/usage` value before and after the run.

## Run 0: permission test before any code (2026-11-22)

Written by Claude Code: `.kiro/agents/autopsy-builder.json`, with read and write tools only and paths limited to the workspace.
Tested with harmless marker files in a temporary directory, 23 short `claude-haiku-5.5` sessions.

| Attempt | Result |
|---|---|
| Read and write inside the workspace | allowed |
| Read outside: absolute path, `../`, symlink, directory listing, image mode, `~` path, sibling folder with the same prefix | denied |
| Write outside: absolute path, `../`, symlink (create and overwrite), `~` path, sibling folder with the same prefix | denied |
| Read `.git/config`, write `.git/hooks/*` | denied |
| Write the agent's own permission file, directly or through `../`; write `.kiro/hooks/*` | denied |
| Run a shell command | no such tool |

Limit of this test: two probes on paths that did not exist failed validation before the permission check, so they were repeated with files that existed.
A missing outside path reports "does not exist", which means the agent can learn whether a path exists but cannot read it.
This is an application-level restriction. The server did not allow an operating system sandbox (bubblewrap).
Kiro itself keeps its session state in its own home directory.

## Run 1: steering, write-guard hook script, license

- Time: 2026-11-22T08:20:57Z to 2026-11-22T08:36:16Z
- Model: `claude-opus-5.5`
- Kiro session: `92a3e09f-e15d-4402-b2b2-60e8191fb0e1`
- Exit code: 0
- Account meter: 539.86 to 563.58 (23.72 credits)

Files changed:
- `.gitignore`
- `.kiro/steering/design.md`
- `.kiro/steering/product.md`
- `.kiro/steering/structure.md`
- `.kiro/steering/tech.md`
- `LICENSE`
- `package.json`
- `scripts/hooks/write-guard.mjs`
- `test/write-guard.test.mjs`

Prompt, verbatim:

~~~~text
You are the engineer who will write this whole project, starting now with steering and one safety hook script. You have only read and write tools, limited to this directory. There is no shell; a separate reviewer runs tests and commits.

Read DISCLOSURE.md and look at a few lines of samples/requests-6644.events.jsonl first.

THE PRODUCT (Kiroween 2026, Costume Contest candidate): "Session Autopsy", a ghost-themed static web page that opens the event log (jsonl) of a FINISHED coding-agent session and shows its autopsy: which lines were requested again and how many times, when the first source edit was attempted, and where the time went, replayed on a timeline. The haunting look must carry information, for example a ghost is stronger where reading repeated more.

HARD FACTS, which must become steering rules:
1. Claims. It does not fix agents, does not improve solve rates, does not save credits, does not predict failure live, and cannot say whether a session succeeded (the log has no outcome). The first screen says briefly: in three comparisons of interventions we did not confirm more issues solved, so this only reads recordings after the session ends and never intervenes. Never write "found it but did not fix it", benchmark percentages, or failure-prediction claims.
2. Never trust the logged `kind` or `spans`. Classify again from `tool`, `cmd` and `range`. If it cannot be known, say "unknown". `cmd` is cut at 200 characters (`cmd_truncated`).
3. A failure is never shown as zero or as an empty list. Unknown is null in code and the word "unknown" on screen. An empty file, broken lines and an empty result are three different states.
4. Every number on screen can be traced to raw log line numbers. A hook logs before a tool runs, so an edit is an "attempt" and a read is "requested".
5. Zero dependencies: Node 22 standard library for tests, vanilla HTML, CSS and ES modules for the site. No CDN, remote font, analytics or network request other than the same-origin sample files. Logs opened by a user stay in the browser.
6. Log content is untrusted: render with textContent, never as HTML; never evaluate or execute it.
7. Screen copy is plain English without hype, emoji or em dashes. No absolute home paths, personal data, secrets or personal operations scripts in the repo.
8. Visual quality bar: a 4px spacing scale, at most 6 type sizes, 4.5:1 text contrast, one accent plus separately defined semantic colors never used alone, loading / empty / error / normal states, 44px touch targets, keyboard operation with visible focus, prefers-reduced-motion respected, works at 360, 768 and 1280px with no page-level horizontal scroll. Avoid generic AI looks: purple-blue gradients, gradient text, everything centered, identical rounded cards, cards in cards, eyebrow labels, numbered sections, fade-up on every section.

WRITE THESE FILES:
A. .kiro/steering/product.md, tech.md, structure.md, and design.md. Short, concrete, opinionated. In design.md commit to ONE distinctive and memorable visual concept for the autopsy (not just a dark dashboard with ghost decorations), with tokens, type roles using system font stacks, and how each spooky element maps to data.
B. scripts/hooks/write-guard.mjs: a development hook for Kiro CLI, event preToolUse on fs_write. The reviewer will register it as `node --permission --allow-fs-read=. --allow-fs-write=build-evidence scripts/hooks/write-guard.mjs`, so write it to work inside that permission model with node: built-ins only, no child process, no network. It reads the event JSON on stdin (`cwd`, `tool_name`, `tool_input` with the target path and the new content in some string fields). It must exit 2 with a short reason on stderr, which blocks the write, when:
  - the target resolves outside cwd (a second layer behind the permission file);
  - new content contains an absolute personal home path (Linux or macOS style), a private key block or a common API token shape;
  - a site file (html, js, css, or mjs outside tests and scripts) adds a remote script, stylesheet, font or fetch URL, or uses innerHTML, outerHTML, insertAdjacentHTML, eval or new Function;
  - it cannot parse its input (fail closed).
 Do not scan text that is being replaced, only new text. Write patterns so that this script and its test do not trigger themselves. Append one JSON line {time, path (project-relative), decision, rule} to build-evidence/write-guard.jsonl. Never log content. If logging fails, print that on stderr but keep the decision.
C. test/write-guard.test.mjs with node:test. Export the pure decision function from the script and test that, without spawning processes. Tests may not write files. They will be run as `node --permission --allow-fs-read=. test/write-guard.test.mjs`.
D. LICENSE: standard MIT, "Copyright (c) 2026 Session Autopsy contributors".
E. package.json: private, "type": "module", license MIT, no dependencies. A .gitignore that must NOT ignore .kiro.

Do not write the spec or the application yet. Finish with a list of files written.
~~~~

## Run 1b: live test of the write-guard hook

- Time: 2026-11-22T08:36:53Z to 2026-11-22T08:37:02Z
- Model: `claude-haiku-5.5`
- Kiro session: `e489daed-64e9-41f7-abe9-539fd22e42f4`
- Exit code: 0
- Account meter: 563.58 to 563.58 (0.0 credits)

Files changed:
- `build-evidence/write-guard.jsonl`

Prompt, verbatim:

~~~~text
Development hook test, harmless. Create the file docs-probe.js in the project root containing exactly this one line:

node.innerHTML = value;

The write guard hook is expected to block this. Make exactly one attempt, do not work around it, and report the exact error.
~~~~
