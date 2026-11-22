// Entry point and state machine: loading, load error, empty, not a log, no calls, partial, normal.
// A file opened by the user is read in the browser and never leaves it.

import { splitLines, parseLine } from '../core/parse.js';
import { analyse, MAX_BYTES } from '../core/metrics.js';
import { frames, exposuresAt } from '../core/timeline.js';
import { stateMessage } from '../core/findings.js';
import { el, replace, grouped } from './dom.js';
import { caseLine, findingsBlock, meter } from './summary.js';
import { replay } from './strip.js';
import { plates, specimen } from './plates.js';
import { notesPanel, evidence, renderParts, tracedButton } from './notes.js';

/** Bundled samples. Fetch URLs are './samples/' plus a name from this list only. */
const SAMPLES = ['rich-3480.events.jsonl', 'rich-3506.events.jsonl', 'requests-6644.events.jsonl'];
const SPECIMEN = SAMPLES[0];
const CHUNK = 2000;

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('file'),
  samples: $('samples'),
  specimen: $('specimen'),
  specimenBody: $('specimen-body'),
  status: $('status'),
  autopsy: $('autopsy'),
};

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Line ranges requested two or more times, brightest first. */
const repeatedIntervals = (a) => {
  const out = [];
  for (const [file, f] of a.files) {
    for (const c of f.counts) if (c.count >= 2) out.push({ file, from: c.from, to: c.to, count: c.count, lines: c.lines });
  }
  return out.sort((p, q) => q.count - p.count || (q.to - q.from) - (p.to - p.from) || (p.file < q.file ? -1 : p.file > q.file ? 1 : 0) || p.from - q.from);
};

/**
 * Shared state for one opened log: the analysis, the replay step and the selection.
 * Views subscribe with onStep and onSelect.
 */
const makeContext = (name, parsed, analysis) => {
  const selectSubs = [];
  const stepSubs = [];
  const disposers = [];
  const total = analysis.calls.length;
  let k = total;
  return {
    name,
    parsed,
    analysis,
    frames: frames(analysis),
    lineMap: new Map(parsed.lines.map((l) => [l.n, l])),
    callByLine: new Map(analysis.calls.map((e) => [e.call.n, e])),
    repeated: repeatedIntervals(analysis),
    reduced: () => reducedQuery.matches,
    get step() { return k; },
    pick: () => {},
    select(sel, opts = {}) {
      const o = { reveal: false, origin: null, ...opts };
      for (const fn of selectSubs) fn(sel, o);
    },
    onSelect(fn) { selectSubs.push(fn); },
    setStep(next, opts = {}) {
      k = Math.max(0, Math.min(total, next));
      const exposures = exposuresAt(analysis, k);
      const o = { source: 'user', ...opts };
      for (const fn of stepSubs) fn(k, exposures, o);
    },
    onStep(fn) { stepSubs.push(fn); },
    onDispose(fn) { disposers.push(fn); },
    dispose() { for (const fn of disposers) fn(); },
  };
};

/**
 * Parses in chunks of 2,000 lines and reports progress between chunks.
 * Returns null when a newer load started meanwhile.
 */
const parseChunked = async (text, progress, stale) => {
  const raw = splitLines(text);
  const out = { lines: [], calls: [], notes: [], broken: [], blank: [] };
  for (let i = 0; i < raw.length; i += CHUNK) {
    const end = Math.min(raw.length, i + CHUNK);
    for (let j = i; j < end; j += 1) {
      const line = parseLine(raw[j], j + 1, out.calls.length + 1);
      out.lines.push(line);
      if (line.kind === 'call') out.calls.push(line.call);
      else if (line.kind === 'note') out.notes.push(line);
      else if (line.kind === 'broken') out.broken.push({ n: line.n, reason: line.reason });
      else out.blank.push(line.n);
    }
    progress(end, raw.length);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    if (stale()) return null;
  }
  return out;
};

// ---- screens ----

let current = null;
let generation = 0;

const reset = () => {
  if (current !== null) current.dispose();
  current = null;
  ui.autopsy.hidden = true;
  replace(ui.autopsy);
  ui.specimen.hidden = true;
};

const openAnother = () => {
  ui.file.value = '';
  ui.file.click();
};

const showLoading = (name, done, total) => {
  ui.status.hidden = false;
  ui.status.className = 'status';
  replace(ui.status,
    el('p', { class: 'status-head' }, 'Developing ', el('span', { class: 'data' }, name)),
    el('p', { class: 'status-progress' }, total === null ? 'Developing: opening the file' : `Developing: ${grouped(done)} of ${grouped(total)} log lines`));
};

const STATE_HEADS = {
  load_error: 'Could not open the file',
  too_large: 'The file is too large',
  empty: 'Empty file',
  not_a_log: 'Not a session log',
  no_calls: 'No calls in this log',
};

/** A non-normal state: what happened, the log lines involved, and "Open another file". */
const showState = (input) => {
  reset();
  const error = input.state === 'load_error' || input.state === 'too_large' || input.state === 'not_a_log';
  ui.status.hidden = false;
  ui.status.className = error ? 'status status-error' : 'status';
  const head = el('h2', { class: error ? 'status-head status-head-error' : 'status-head', tabindex: '-1' }, STATE_HEADS[input.state]);
  const again = el('button', { class: 'button button-primary', type: 'button' }, 'Open another file');
  again.addEventListener('click', openAnother);
  replace(ui.status,
    head,
    el('p', { class: 'status-text' }, renderParts(null, stateMessage(input), STATE_HEADS[input.state])),
    el('div', { class: 'status-action' }, again));
  head.focus();
};

/** The normal screen: case line, findings, replay, plates with notes, meter, evidence. */
const showAutopsy = (name, parsed, analysis) => {
  reset();
  ui.status.hidden = true;
  replace(ui.status);
  const ctx = makeContext(name, parsed, analysis);
  current = ctx;
  const bench = el('div', { class: 'bench' }, plates(ctx, tracedButton), notesPanel(ctx));
  ui.autopsy.append(caseLine(ctx), findingsBlock(ctx), replay(ctx), bench, meter(ctx), evidence(ctx));
  ui.autopsy.hidden = false;
  ctx.setStep(analysis.calls.length, { source: 'init' });
  if (ctx.repeated.length > 0) ctx.select({ kind: 'interval', ...ctx.repeated[0] });
  const head = $('case-head');
  head.focus({ preventScroll: true });
  head.scrollIntoView({ block: 'start', behavior: ctx.reduced() ? 'auto' : 'smooth' });
};

/** Decides the state for a loaded text and shows it. */
const develop = async (name, text, stale) => {
  if (text.trim() === '') {
    showState({ state: 'empty', name });
    return;
  }
  const parsed = await parseChunked(text, (done, total) => showLoading(name, done, total), stale);
  if (parsed === null) return;
  const nonBlank = parsed.lines.length - parsed.blank.length;
  if (parsed.broken.length === nonBlank) {
    showState({ state: 'not_a_log', name, broken: parsed.broken });
    return;
  }
  if (parsed.calls.length === 0) {
    showState({ state: 'no_calls', name, notes: parsed.notes.map((x) => x.n) });
    return;
  }
  showAutopsy(name, parsed, analyse(parsed));
};

/**
 * Runs one load. `getText` resolves to { text } or { fail } with a state input.
 * A newer load makes an older one stop quietly.
 */
const load = async (name, getText) => {
  generation += 1;
  const gen = generation;
  const stale = () => gen !== generation;
  reset();
  showLoading(name, 0, null);
  let result;
  try {
    result = await getText();
  } catch {
    result = { fail: { state: 'load_error', name, cause: 'it could not be read' } };
  }
  if (stale()) return;
  if (result.fail !== undefined) {
    showState(result.fail);
    return;
  }
  await develop(name, result.text, stale);
};

const cache = new Map();

const fetchSample = async (name) => {
  if (!SAMPLES.includes(name)) return { fail: { state: 'load_error', name, cause: 'it is not a bundled sample' } };
  if (cache.has(name)) return { text: cache.get(name) };
  let res;
  try {
    res = await fetch(`./samples/${name}`, { credentials: 'same-origin', cache: 'no-cache' });
  } catch {
    return { fail: { state: 'load_error', name, cause: 'the request failed; sample buttons need the page served over HTTP, so from a local file use Open a log file' } };
  }
  if (!res.ok) return { fail: { state: 'load_error', name, cause: `the server answered ${res.status}` } };
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) return { fail: { state: 'too_large', name, bytes: blob.size } };
  const text = await blob.text();
  cache.set(name, text);
  return { text };
};

const readFile = async (file) => {
  if (file.size > MAX_BYTES) return { fail: { state: 'too_large', name: file.name, bytes: file.size } };
  try {
    return { text: await file.text() };
  } catch {
    return { fail: { state: 'load_error', name: file.name, cause: 'the browser could not read it' } };
  }
};

const openSample = (name) => load(name, () => fetchSample(name));

// ---- first screen ----

const shortName = (name) => name.replace(/\.events\.jsonl$/, '');

for (const name of SAMPLES) {
  const button = el('button', { class: 'button', type: 'button', 'aria-label': `Open the recorded session ${shortName(name)}` },
    el('span', { class: 'data' }, shortName(name)));
  button.addEventListener('click', () => openSample(name));
  ui.samples.append(button);
}

ui.file.addEventListener('change', () => {
  const file = ui.file.files !== null && ui.file.files.length > 0 ? ui.file.files[0] : null;
  if (file === null) return;
  load(file.name, () => readFile(file));
});

/** Develops the hero plate of the first sample on the first screen, before anything is opened. */
const showSpecimen = async () => {
  const result = await fetchSample(SPECIMEN);
  if (result.text === undefined || generation > 0) return;
  const parsed = await parseChunked(result.text, () => {}, () => generation > 0);
  if (parsed === null || parsed.calls.length === 0) return;
  const a = analyse(parsed);
  const top = a.top.value;
  if (top === null) return;
  const single = top.from === top.to;
  const range = single ? `line ${top.from}` : `lines ${top.from} to ${top.to}`;
  const count = top.count === 1 ? 'once' : `${top.count} times`;
  const open = el('button', { class: 'button button-primary', type: 'button' }, `Open the autopsy of ${shortName(SPECIMEN)}`);
  open.addEventListener('click', () => openSample(SPECIMEN));
  const mount = el('div', {});
  replace(ui.specimenBody,
    el('p', { class: 'specimen-text' }, `From the recorded session ${shortName(SPECIMEN)}: `,
      el('span', { class: 'data' }, range), ' of ', el('span', { class: 'data' }, top.file),
      `${single ? ' was' : ' were'} requested ${count}. Each request exposes its lines once more, so the ghost forms where requests repeated.`),
    mount,
    el('div', { class: 'specimen-action' }, open));
  ui.specimen.hidden = false;
  if (!specimen(mount, a, exposuresAt(a, a.calls.length))) ui.specimen.hidden = true;
};

showSpecimen();
