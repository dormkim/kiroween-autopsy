// Entry point and state machine: loading, load error, empty, not a log, no calls, partial, normal.
// A file opened by the user is read in the browser and never leaves it.

import { splitLines, parseLine } from '../core/parse.js';
import { analyse, MAX_BYTES } from '../core/metrics.js';
import { frames, exposuresAt } from '../core/timeline.js';
import { stateMessage } from '../core/findings.js';
import { endingFor } from '../provenance/sample-endings.js';
import { el, replace, grouped } from './dom.js';
import { caseLine, findingsBlock, meter } from './summary.js';
import { stage, WIDE } from './strip.js';
import { plates } from './plates.js';
import { apparition, photoSize } from './apparition.js';
import { notesPanel, evidence, renderParts, tracedButton } from './notes.js';

/** Bundled samples. Fetch URLs are './samples/' plus a name from this list only. */
const SAMPLES = ['rich-3480.events.jsonl', 'rich-3506.events.jsonl', 'requests-6644.events.jsonl'];
const SPECIMEN = SAMPLES[0];
const CHUNK = 2000;
const DEVELOP_MS = 220;

const $ = (id) => document.getElementById(id);
// The module loaded, so the page is served over HTTP: remove the static notice.
$('needs-http')?.remove();
const ui = {
  intro: $('intro'),
  primary: $('open-specimen'),
  primaryEnding: $('specimen-ending'),
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
const makeContext = (name, parsed, analysis, ending) => {
  const selectSubs = [];
  const stepSubs = [];
  const disposers = [];
  const total = analysis.calls.length;
  let k = total;
  return {
    name,
    ending,
    parsed,
    analysis,
    frames: frames(analysis),
    lineMap: new Map(parsed.lines.map((l) => [l.n, l])),
    callByLine: new Map(analysis.calls.map((e) => [e.call.n, e])),
    repeated: repeatedIntervals(analysis),
    reduced: () => reducedQuery.matches,
    get step() { return k; },
    pick: () => {},
    playFromStart: () => {},
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
let shown = null;
let generation = 0;
let specimenTimer = null;

const stopSpecimen = () => {
  if (specimenTimer !== null) clearInterval(specimenTimer);
  specimenTimer = null;
};

const reset = () => {
  if (current !== null) current.dispose();
  current = null;
  shown = null;
  ui.autopsy.hidden = true;
  replace(ui.autopsy);
  stopSpecimen();
  ui.specimen.hidden = true;
  ui.intro.classList.add('intro-compact');
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

/** Geometry key of the stage: the stage is rebuilt only when this changes. */
const stageKey = (w) => (w >= WIDE ? 'wide' : `${photoSize(w).W}x${photoSize(w).H}`);

/**
 * The normal screen: case line, findings, replay stage, plates with notes, meter, evidence.
 * @param {number|null} step replay step to keep after a rebuild, null for a fresh load (the end)
 * @param {boolean} first true on a fresh load
 * @param {import('../provenance/sample-endings.js').Ending} ending how the session ended, from provenance only
 */
const render = (name, parsed, analysis, step, first, ending) => {
  if (current !== null) current.dispose();
  stopSpecimen();
  ui.status.hidden = true;
  replace(ui.status);
  replace(ui.autopsy);
  ui.specimen.hidden = true;
  ui.intro.classList.add('intro-compact');
  ui.autopsy.hidden = false;
  const width = ui.autopsy.clientWidth;
  const ctx = makeContext(name, parsed, analysis, ending);
  current = ctx;
  shown = { name, parsed, analysis, ending, key: stageKey(width) };
  const bench = el('div', { class: 'bench' }, plates(ctx, tracedButton), notesPanel(ctx));
  ui.autopsy.append(caseLine(ctx), findingsBlock(ctx), stage(ctx, width), bench, meter(ctx), evidence(ctx));
  ctx.setStep(step ?? analysis.calls.length, { source: 'init' });
  if (ctx.repeated.length > 0) ctx.select({ kind: 'interval', ...ctx.repeated[0] });
  if (first) {
    const head = $('case-head');
    head.focus({ preventScroll: true });
    head.scrollIntoView({ block: 'start', behavior: ctx.reduced() ? 'auto' : 'smooth' });
  }
};

/** Decides the state for a loaded text and shows it. */
const develop = async (name, text, stale, ending) => {
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
  render(name, parsed, analyse(parsed), null, true, ending);
};

/**
 * Runs one load. `getText` resolves to { text } or { fail } with a state input.
 * `origin` says whether this is a bundled sample or a file the user opened; only the
 * bundled-sample path can have a known ending.
 * A newer load makes an older one stop quietly.
 */
const load = async (name, getText, origin) => {
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
  await develop(name, result.text, stale, endingFor(origin));
};

const cache = new Map();

const fetchSample = async (name) => {
  if (!SAMPLES.includes(name)) return { fail: { state: 'load_error', name, cause: 'it is not a bundled sample' } };
  if (cache.has(name)) return { text: cache.get(name) };
  let res;
  try {
    res = await fetch(`./samples/${name}`, { credentials: 'same-origin', cache: 'no-cache' });
  } catch {
    return { fail: { state: 'load_error', name, cause: 'the request failed; the page and its samples must be served over HTTP from the repository root' } };
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

const openSample = (name) => load(name, () => fetchSample(name), { source: 'sample', name });

// ---- first screen ----

const shortName = (name) => name.replace(/\.events\.jsonl$/, '');
const sampleEnding = (name) => endingFor({ source: 'sample', name });

for (const name of SAMPLES) {
  const ending = sampleEnding(name);
  const button = el('button', { class: 'button sample-button', type: 'button', 'aria-label': `Open the recorded session ${shortName(name)}. ${ending.label}` },
    el('span', { class: 'data' }, shortName(name)),
    el('span', { class: 'sample-ending' }, ending.label));
  button.addEventListener('click', () => openSample(name));
  ui.samples.append(button);
}

ui.primaryEnding.textContent = sampleEnding(SPECIMEN).label;
ui.primary.addEventListener('click', () => openSample(SPECIMEN));

ui.file.addEventListener('change', () => {
  const file = ui.file.files !== null && ui.file.files.length > 0 ? ui.file.files[0] : null;
  if (file === null) return;
  load(file.name, () => readFile(file), { source: 'file', name: file.name });
});

let specimenData = null;

/**
 * Draws the spirit photograph of the first sample on the first screen. Unless reduced motion
 * is set, it develops once: one exposure per request of the most requested lines.
 */
const drawSpecimen = (animate) => {
  stopSpecimen();
  const a = specimenData;
  ui.specimen.hidden = false;
  const photo = apparition(a, { width: ui.specimenBody.clientWidth, name: SPECIMEN, onPick: null });
  if (photo === null) {
    ui.specimen.hidden = true;
    return;
  }
  replace(ui.specimenBody, photo.node, el('p', { class: 'ending-note' }, sampleEnding(SPECIMEN).sentence));
  ui.specimenBody.dataset.key = stageKey(ui.specimenBody.clientWidth);
  const file = a.top.value.file;
  const show = (k) => photo.update(k, exposuresAt(a, k).get(file) ?? []);
  const total = a.calls.length;
  if (!animate || reducedQuery.matches) {
    show(total);
    return;
  }
  const steps = [0];
  for (let k = 1; k <= total; k += 1) if (photo.countAt(k) > photo.countAt(k - 1)) steps.push(k);
  steps.push(total);
  let i = 0;
  show(steps[0]);
  specimenTimer = setInterval(() => {
    i += 1;
    show(steps[i]);
    if (i >= steps.length - 1) stopSpecimen();
  }, DEVELOP_MS);
};

const showSpecimen = async () => {
  const result = await fetchSample(SPECIMEN);
  if (result.text === undefined || generation > 0) return;
  const parsed = await parseChunked(result.text, () => {}, () => generation > 0);
  if (parsed === null || parsed.calls.length === 0 || generation > 0) return;
  const a = analyse(parsed);
  if (a.top.value === null) return;
  specimenData = a;
  ui.intro.classList.add('intro-has-photo');
  drawSpecimen(true);
};

// Rebuild the photograph and the stage when the available width changes their geometry.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (shown !== null && current !== null && stageKey(ui.autopsy.clientWidth) !== shown.key) {
      render(shown.name, shown.parsed, shown.analysis, current.step, false, shown.ending);
    } else if (shown === null && specimenData !== null && !ui.specimen.hidden
      && stageKey(ui.specimenBody.clientWidth) !== ui.specimenBody.dataset.key) {
      drawSpecimen(false);
    }
  }, 200);
});

showSpecimen();
