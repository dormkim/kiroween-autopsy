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
