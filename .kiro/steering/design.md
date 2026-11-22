# Design: double exposure

## Concept

The session is developed like a Victorian spirit photograph.

Each file the agent requested is a photographic plate, its lines running top to bottom. Every read request exposes its line range once, as a pale band. Exposures stack, so a range requested five times glows far brighter than one requested once. The ghost appears exactly where reading repeated, and its brightness is the count.

Under the plates runs the contact strip: the session as a strip of film, one frame per call. A frame's width is the time until the next event. The film margin carries printed edge codes with the call number and log line, so every frame points back to the raw log. Replay develops the plates: as the playhead moves along the strip, exposures land on the plates in recorded order.

The ghost is the measurement. No mascots, bats, cobwebs, skulls, dripping type or glow effects.

## Data mapping

| Element | Data | Encoding | Also shown as |
|---|---|---|---|
| Plate | one file with at least one requested range | vertical axis is line offset; height scales to the largest requested end | path caption in data type |
| Exposure band | lines covered by n requests | opacity `0.25 + 0.75 * (1 - 0.8^(n - 1))`: n=1 0.25, 2 0.40, 3 0.52, 5 0.69, 8 0.85. 1px edge in `--c-exposure-edge` on every band | "requested 5 times" label and table row with log lines |
| Brightest band | highest n on the plate | caption beside it | text with log lines |
| Overexposed edge | whole-file request, length unknown | band runs off the plate bottom with a ragged edge | "whole file, length unknown" |
| Frame | one call | width proportional to seconds until the next event, minimum 4px; the strip scrolls inside its own box | edge code |
| Edge code | call number and log line | `--font-data` 12px in the margin | is the text |
| Fogged frame | category or file effect unknown | diagonal hatch in `--c-unknown` | "unknown" |
| Unexposed frame | `allow: false`, blocked by the recording hook | solid `--c-rebate` frame with a cross | "blocked" |
| Torn frame | broken log line | notch cut through the strip | "log line 37 could not be read" |
| Cut mark | first edit attempt | full-height line across strip and plates in `--c-edit` | "First edit attempt: call 46, log line 47" plus the unknown count before it |
| Exposure meter | time per category | one horizontal bar, segment length proportional to seconds | label with seconds and share; table |
| Playhead | replay position | accent line over the strip | native range input with value text |

Color never carries meaning alone. Every semantic color comes with a pattern, a shape and a word.

## Tokens

```css
/* color: fixer black ground, ectoplasm data, one amber safelight accent */
--c-ground: #0d0f0c;        /* page */
--c-plate: #161a15;         /* plate and strip surface */
--c-rebate: #050605;        /* film margin, unexposed frame */
--c-rule: #2d332b;          /* hairlines, never text */
--c-text: #e6eae1;          /* about 16:1 on ground */
--c-text-dim: #a3ab9c;      /* about 8:1 on ground */
--c-accent: #f0a93b;        /* about 9.6:1; focus, playhead, selection, primary button */

/* semantic, separate from the accent */
--c-exposure: #dcefe2;      /* requested lines */
--c-exposure-edge: #7f9886; /* band outline, 3:1 on plate */
--c-edit: #7fd0e6;          /* edit attempt, cut mark */
--c-unknown: #b4b8c9;       /* fog hatch, "unknown" */
--c-blocked: #c7c2b0;       /* blocked by the recording hook */
--c-error: #ff8f80;         /* broken lines, load errors */

/* spacing: 4px scale */
--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px;
--s-6: 24px; --s-8: 32px; --s-12: 48px; --s-16: 64px;

/* shape */
--radius-control: 2px;      /* plates, frames and panels have square corners */
--border: 1px solid var(--c-rule);
--focus: 2px solid var(--c-accent); /* with 2px offset */
--target: 44px;             /* minimum touch target */
```

Text colors meet 4.5:1 on `--c-ground` and `--c-plate`. Check every new pair before use.

## Type

| Role | Stack | Size / line height | Use |
|---|---|---|---|
| display | `ui-serif, "New York", "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif` | 40 / 1.1 | page title only |
| heading | display stack | 28 / 1.2 | session name |
| caption | display stack | 20 / 1.3 | plate captions, panel heads |
| body | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | 16 / 1.5 | prose, claims paragraph |
| small | body stack | 14 / 1.45 | controls, tables, notes |
| data | `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` | 12 / 1.3, and 14 in tables | edge codes, paths, commands, numbers |

Six sizes total: 12, 14, 16, 20, 28, 40. Weights 400 and 600 only. Numbers use `font-variant-numeric: tabular-nums`. Prose is at most 64ch wide. Paths and commands wrap with `overflow-wrap: anywhere`.

## Layout

- Left-aligned and asymmetric. Nothing is centered except numbers inside table cells.
- First screen: title, one-line purpose, the claims paragraph, then "Open a log file" (file input with label) and one button per sample file name.
- After loading: a case line (file name, calls, duration plus unknown tail, broken line count), the contact strip at full width, the plates, the exposure meter, and the notes panel for the selected call or range.
- 360px: single column. The strip scrolls horizontally inside its own box. Plates stack.
- 768px: plates in two columns, notes below.
- 1280px: plates take two thirds, notes stay beside them in a sticky third.
- No page-level horizontal scroll at any width. Grid children get `min-width: 0`.

## States

- Loading: the plate area says "Developing: 1,200 of 3,400 log lines". Text only, no spinner.
- Empty file, some lines broken, all lines broken, no calls, load error: each has its own message naming what happened, the log lines involved, and an "Open another file" action.
- Normal: as above.

## Interaction and motion

- Every control is at least 44 by 44px and reachable with Tab, with the visible `--focus` ring.
- The strip has one tab stop: the playhead range input. Arrow keys step one call, Home and End jump to the ends, Space plays and pauses.
- The repeated-requests table is the keyboard path to the bands. Selecting a row highlights its band and lights its frames on the strip. Clicking a band selects the same row.
- Replay: one frame per 120ms. A new exposure appears over 160ms.
- `prefers-reduced-motion: reduce`: no autoplay and no transitions. Play steps one call per press and plates update at once.
- No entrance animation on sections.

## Do not

Purple or blue gradients, gradient text, everything centered, rows of identical rounded cards, cards inside cards, eyebrow labels above headings, numbered section headings, fade-up on scroll, glassmorphism, neon glow, emoji, decorative ghosts that carry no data.
