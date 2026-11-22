// Case line, the three findings and the exposure meter.

import { findings, headlines, formatTime, permissionNote, shareText, stateMessage } from '../core/findings.js';
import { el, setVar } from './dom.js';
import { renderParts, tracedButton } from './notes.js';

/** Fixed order and words for the meter. Keys come from the analysis, classes from this table only. */
const METER = [
  ['request', 'file requests', 'seg-request'],
  ['search', 'searches', 'seg-search'],
  ['edit', 'edit attempts', 'seg-edit'],
  ['test', 'test runs', 'seg-test'],
  ['run', 'code runs', 'seg-run'],
  ['vcs', 'version control calls', 'seg-vcs'],
  ['other', 'other calls', 'seg-other'],
  ['blocked', 'blocked calls', 'seg-blocked'],
  ['unknown', 'calls with unknown effect', 'seg-unknown'],
  ['unknown_time', 'unknown times between calls', 'seg-gap'],
];

/** Session name: the file name without .events.jsonl or .jsonl. */
export const sessionName = (name) => name.replace(/\.events\.jsonl$|\.jsonl$/i, '') || name;

/** Shown exactly when the permission note is shown. Static text, no number, so nothing to trace. */
const PARALLEL_NOTE = 'Calls sent in parallel may be logged out of order, so the first edit can be another call of the same batch.';

/** A number outside running text: a full 44px button. */
const statButton = (ctx, text, traced, label) => {
  const b = tracedButton(ctx, text, traced, label);
  b.classList.remove('traced');
  b.classList.add('button', 'stat-value');
  return b;
};

/**
 * Heading, ending, case line (file, calls, recorded time plus unknown tail, broken lines) and the replay action.
 * @param {object} ctx
 */
export function caseLine(ctx) {
  const a = ctx.analysis;
  const callLines = a.calls.map((e) => e.call.n);
  const calls = { value: callLines.length, lines: callLines, reason: null };
  const span = a.time.span;
  const broken = a.totals.broken.map((b) => b.n);
  const stat = (label, value, after = null) => el('li', { class: 'stat' }, el('span', { class: 'stat-label' }, label), value, after);
  const stats = el('ul', { class: 'stats' },
    stat('Calls', statButton(ctx, String(calls.value), calls, 'Calls in this recording')),
    stat('Recorded time', span.value === null ? el('span', { class: 'stat-plain' }, 'unknown')
      : statButton(ctx, formatTime(span.value), span, 'Time from the first call to the last valid event'),
    el('span', { class: 'stat-after' }, 'plus an unknown tail')),
    stat('Broken log lines', broken.length === 0 ? el('span', { class: 'stat-plain' }, '0')
      : statButton(ctx, String(broken.length), { value: broken.length, lines: broken, reason: null }, 'Log lines that could not be read')));
  const replayButton = el('button', { class: 'button button-primary', type: 'button' }, 'Replay from the first call');
  replayButton.addEventListener('click', () => ctx.playFromStart());
  const head = el('h2', { class: 'case-name', tabindex: '-1', id: 'case-head' }, sessionName(ctx.name));
  // How the session ended is provenance for bundled samples only; an opened file is unknown.
  // Recorder logs do not record permission: say so before the headlines, never call them allowed.
  // Recorder logs also keep parallel calls in hook start order, not session order (measured live).
  const note = permissionNote(a);
  const out = el('header', { class: 'case' }, head,
    el('p', { class: 'case-ending' }, ctx.ending.sentence),
    note === null ? null : el('p', { class: 'case-permission', role: 'note' }, renderParts(ctx, note, 'Calls whose permission was not recorded'),
      ' ', el('span', { class: 'case-parallel' }, PARALLEL_NOTE)),
    el('p', { class: 'case-line' }, 'Developed from ', el('span', { class: 'data' }, ctx.name), '.'),
    el('div', { class: 'case-row' }, stats, replayButton));
  if (a.totals.partial) {
    const msg = stateMessage({ state: 'partial', name: ctx.name, broken: a.totals.broken });
    out.append(el('p', { class: 'partial-banner', role: 'note' }, renderParts(ctx, msg, 'Log lines that could not be read'),
      ' Every result below comes from the other lines.'));
  }
  return out;
}

const FINDING_LABELS = ['Most requested lines', 'First recognised source edit attempt', 'Where the time went'];

/**
 * The three findings: a plain answer, the full sentence as detail, and one control for the log lines.
 * @param {object} ctx
 */
export function findingsBlock(ctx) {
  const sentences = findings(ctx.analysis);
  const heads = headlines(ctx.analysis);
  const fog = ctx.frames.filter((f) => f.fog).map((f) => f.n);
  const items = sentences.map((parts, i) => {
    const h = heads[i];
    const show = el('button', { class: 'button finding-show', type: 'button' }, 'Show log lines');
    show.addEventListener('click', () => ctx.select({ kind: 'traced', label: h.label, text: h.text, traced: h.traced }, { reveal: true, origin: show }));
    return el('li', { class: 'finding' },
      el('h3', { class: 'finding-kind' }, FINDING_LABELS[i]),
      el('p', { class: 'finding-head' }, h.text),
      el('p', { class: 'finding-detail' }, renderParts(ctx, parts, FINDING_LABELS[i])),
      show);
  });
  return el('section', { class: 'findings-block', 'aria-label': 'Findings' },
    el('ul', { class: 'findings' }, items),
    el('p', { class: 'finding-note' },
      'Calls with unknown effect may have requested or changed files that are not counted: ',
      tracedButton(ctx, String(fog.length), { value: fog.length, lines: fog, reason: null }, 'Calls with unknown effect'),
      fog.length === 1 ? ' call.' : ' calls.'));
}

/**
 * Exposure meter: one bar, a segment per category with length proportional to seconds,
 * then the unknown tail with no width claim. The list below carries the same numbers as text.
 * @param {object} ctx
 */
export function meter(ctx) {
  const a = ctx.analysis;
  const span = a.time.span;
  const bar = el('div', { class: 'meter-bar', 'aria-hidden': 'true' });
  const list = el('ul', { class: 'meter-list' });
  for (const [key, words, cls] of METER) {
    const t = a.time.byCategory.get(key);
    if (t === undefined) continue;
    if (t.value > 0) {
      const seg = el('div', { class: `meter-seg ${cls}` });
      setVar(seg, '--w', t.value);
      bar.append(seg);
    }
    const share = span.value !== null && span.value > 0 ? `(${shareText(t.value / span.value)})` : null;
    list.append(el('li', { class: 'meter-item' },
      el('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }),
      el('span', {}, `${words}: `, el('span', { class: 'nowrap' }, tracedButton(ctx, formatTime(t.value), t, `Time after ${words}`), share === null ? null : `\u00a0${share}`))));
  }
  bar.append(el('div', { class: 'meter-tail' }));
  list.append(el('li', { class: 'meter-item' },
    el('span', { class: 'swatch meter-tail', 'aria-hidden': 'true' }),
    el('span', {}, 'after the last event: unknown tail')));
  const body = span.value === null
    ? [el('p', { class: 'section-note' }, 'No call has a usable time, so where the time went is unknown.')]
    : [bar, list];
  return el('section', { class: 'meter', 'aria-labelledby': 'meter-head' },
    el('h2', { class: 'section-head', id: 'meter-head' }, 'Exposure meter'),
    el('p', { class: 'section-note' }, 'Where the time went, by the kind of call before it. Each part is the time until the next call (tool, model and waiting together).'),
    ...body);
}
