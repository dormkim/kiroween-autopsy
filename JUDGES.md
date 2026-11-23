# For judges

Category: Costume Contest. Written by Claude Code, the project's reviewer; Kiro CLI wrote the application (see [DISCLOSURE.md](DISCLOSURE.md)).

## Five minutes, no install

1. Open the live page: [APP_URL]. Nothing to sign in to, and nothing you open leaves your browser.
2. Press "Open the autopsy of rich-3480". This is a real 15-minute Kiro CLI session on a public Rich issue, cut off at its time limit.
3. Read the three headlines. The first says how often the same lines were requested. Click its "Show log lines" button: the numbers point to the log lines they were counted from.
4. Press replay. The figure gains one exposure each time those lines are requested again.
5. Open a log of your own with "Open a log file", or one of the other two samples. One crashed and one exited normally; the page says which, and where that fact comes from.

Without a browser: the video ([VIDEO_URL]) shows the same steps, and `npm test` runs 290 tests with Node 22.13 or later (it leaves small test folders in the system temp directory).

To run the page locally instead: `python3 -m http.server --bind 127.0.0.1 8000` in the repository root, then open `http://127.0.0.1:8000`.

## Criteria and where to look

| Criterion | Where | What it shows |
|---|---|---|
| Potential impact | rich-3480 on the page; README "Record your own session" | A 172-line log turned into three headlines that link back to their lines. The recorder lets anyone with Kiro CLI record a session for it |
| Technological implementation | [BUILD_LOG.md](BUILD_LOG.md); `.kiro/steering/`, `.kiro/specs/session-autopsy/`, `.kiro/agents/autopsy-builder.json` | Every Kiro run with its prompt, files, session id and credits. Run 0 tested the agent's boundary in 23 sessions before any code. Two hooks: a write guard during the build and the recorder this project ships |
| Design | the page at 360 and 1280 px; `.kiro/steering/design.md` | The spirit-photograph concept: one plate per file, one exposure per request. Every count on screen is a button to its log lines (how a session ended, such as the 900 s limit, comes from the runner's records and is labelled as such) |
| Innovation | README opening and "What it records"; `recorder/session-autopsy-record.mjs` | Reading an agent session as a photograph that develops with repetition. A recorder that writes no commands, contents or prompts |
| Presentation | the video; [README.md](README.md) | Problem, the page working on a real session, and a live Kiro CLI session recorded with the shipped hook |

## What we claim, and how sure we are

| Claim | Grade | How to check |
|---|---|---|
| In rich-3480 the same four lines (lines 1007 to 1010 of one file) were requested 8 times, 6 of them before the first recognised edit attempt at 13:21 of 14:48 | Reproducible | Open the sample, click the numbers |
| The page uploads nothing | Reproducible | Content Security Policy in `index.html`; README "Privacy" |
| 290 tests pass | Reproducible | `npm test` |
| Kiro CLI wrote the spec, steering, application, tests and both hooks | Recorded | BUILD_LOG runs 1 to 25, commit messages |
| The recorder never hides a failure | **Not met** | README "When recording fails" |
| The log order matches the session order | **Not met** | README "Limits", parallel calls |
| The page makes agents better, saves credits or predicts failure | Not claimed | README "What it does not claim" |

The three bundled logs were picked by hand to show different session shapes. They support no statistical claim.
