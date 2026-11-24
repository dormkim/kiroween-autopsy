// Notes panel for the selected number, range or call, and the evidence tables.
// Every value from the log reaches the page as text through dom.js.

import { formatTime } from '../core/findings.js';
import { el, replace } from './dom.js';

/** Plain words per category, for one call. */
export const CATEGORY_WORDS = {
  request: 'file request',
  search: 'search',
  edit: 'edit attempt',
  test: 'test run',
  run: 'code run',
  vcs: 'version control',
  other: 'other call',
  blocked: 'blocked by the recording hook',
  unknown: 'unknown effect',
};

/** Plain words per edit class. */
export const CLASS_WORDS = {
  source: 'source file',
  test: 'test file',
  scratch: 'scratch script',
  other: 'other file',
  outside: 'outside the workspace',
  unknown: 'unknown target',
};

const BROKEN_WORDS = {
  json: 'not valid JSON',
  not_object: 'not a JSON object',
  no_hook: 'no hook field',
  no_tool: 'a pre line without a tool',
};

const ANOMALY_WORDS = {
  missing: 'time missing',
  not_a_number: 'time is not a number',
  out_of_range: 'time outside the years 2000 to 2100',
  backwards: 'time earlier than the previous one',
};

const REASON_WORDS = {
  no_calls: 'the log has no calls',
  no_time: 'no call has a usable time',
  time_anomaly: 'a time on this call or the next one is missing or out of order',
  no_ranges: 'no explicit line range was requested',
  no_whole_file: 'no file was requested whole',
  none_recognised: 'no source edit attempt was recognised',
  no_repeats: 'no repeat request was found',
};

export const wordFor = (table, key) => (Object.hasOwn(table, key) ? table[key] : 'unknown');

/**
 * "1 to 3, 5": runs of three or more consecutive numbers are shortened.
 * @param {number[]} ns sorted
 */
export function lineList(ns) {
  const out = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j += 1;
    if (j - i >= 2) {
      out.push(`${ns[i]} to ${ns[j]}`);
      i = j + 1;
    } else {
      out.push(String(ns[i]));
      i += 1;
    }
  }
  return out.join(', ');
}

/** "log line 5" or "log lines 5, 7 and 3 more". */
export function linesLabel(ns, max = 6) {
  if (ns.length === 0) return 'no log lines';
  if (ns.length === 1) return `log line ${ns[0]}`;
  const head = lineList(ns.slice(0, max));
  return ns.length > max ? `log lines ${head} and ${ns.length - max} more` : `log lines ${head}`;
}

export const seconds = (v) => (v === null ? 'unknown' : `${v.toFixed(1)} s`);

/** Range as logged, never converted: "offset 360, limit 50". */
export function rangeAsLogged(range) {
  if (range === null) return 'range of an unexpected type';
  const parts = [];
  if (range.offset !== null) parts.push(`offset ${range.offset}`);
  if (range.limit !== null) parts.push(`limit ${range.limit}`);
  return parts.length === 0 ? 'no range, whole file' : parts.join(', ');
}

/** One request in plain words. */
export function describeRequest(r) {
  if (r.kind === 'range') {
    return r.from === r.to ? `line ${r.from} of ${r.file}` : `lines ${r.from} to ${r.to} of ${r.file}`;
  }
  if (r.kind === 'open') return `${r.file} from line ${r.from}, length unknown`;
  return `${r.file}, lines unknown`;
}

/** The raw part of a call: its command, or its paths and range as logged. */
export function rawText(call) {
  if (call.cmd !== null && call.cmd !== '') {
    return call.truncated === true ? `${call.cmd} [cut at 200 characters by the recorder]` : call.cmd;
  }
  const paths = call.paths === null ? 'paths unknown' : call.paths.length === 0 ? 'no path' : call.paths.join(', ');
  return call.tool === 'read_file' ? `${paths} (${rangeAsLogged(call.range)})` : paths;
}

// ---- traced numbers ----

/** @type {HTMLElement|null} */
let pressed = null;

const press = (button) => {
  if (pressed !== null && pressed !== button) pressed.setAttribute('aria-pressed', 'false');
  pressed = button;
  if (button !== null) button.setAttribute('aria-pressed', 'true');
};

/**
 * A number with its log lines behind it. Focus shows the lines in the notes panel;
 * a click also brings the panel into view.
 * @param {object} ctx
 * @param {string} text
 * @param {{ value: unknown, lines: number[], reason: string|null }|null} traced
 * @param {string} label what the number is, for the notes heading
 */
export function tracedButton(ctx, text, traced, label) {
  if (traced === null || traced === undefined) return el('span', { class: 'value-plain' }, text);
  const button = el('button', { class: 'traced', type: 'button', 'aria-pressed': 'false' }, text);
  const sel = { kind: 'traced', label, text, traced };
  button.addEventListener('focus', () => {
    press(button);
    ctx.select(sel, { reveal: false, origin: button });
  });
  button.addEventListener('click', () => {
    press(button);
    ctx.select(sel, { reveal: true, origin: button });
  });
  return button;
}

/**
 * Renders finding or state parts: strings as text, values as traced buttons.
 * @param {object} ctx null when nothing can be traced (state screens)
 * @param {(string | { text: string, traced: object|null })[]} parts
 * @param {string} label
 */
export function renderParts(ctx, parts, label) {
  return parts.map((p) => {
    if (typeof p === 'string') return p;
    if (ctx === null || p.traced === null) return el('span', { class: 'value-plain data' }, p.text);
    return tracedButton(ctx, p.text, p.traced, label);
  });
}

// ---- rows of log lines ----

/** One log line as a row: what the line is, and its raw command or path. */
export function lineRow(ctx, n) {
  const line = ctx.lineMap.get(n);
  const head = el('span', { class: 'row-n' }, `log line ${n}`);
  if (line === undefined) return el('li', { class: 'row' }, head, ', not in this file');
  if (line.kind === 'call') {
    const entry = ctx.callByLine.get(n);
    const call = entry.call;
    const when = entry.offset === null ? 'time unknown' : `at ${formatTime(entry.offset)}`;
    return el('li', { class: 'row' }, head,
      `, call ${call.index}, ${wordFor(CATEGORY_WORDS, entry.effect.category)}, ${when}, `,
      el('span', { class: 'data' }, call.tool),
      el('span', { class: 'row-cmd' }, rawText(call)));
  }
  if (line.kind === 'note') return el('li', { class: 'row' }, head, ', a note, not a call (hook ', el('span', { class: 'data' }, line.hook), ')');
  if (line.kind === 'broken') return el('li', { class: 'row' }, head, `, could not be read: ${wordFor(BROKEN_WORDS, line.reason)}`);
  return el('li', { class: 'row' }, head, ', blank');
}

const FIRST_ROWS = 12;

/** A list of log line rows; long lists show the first rows and a button for the rest. */
export function lineRows(ctx, ns) {
  const list = el('ul', { class: 'rows' }, ns.slice(0, FIRST_ROWS).map((n) => lineRow(ctx, n)));
  if (ns.length <= FIRST_ROWS) return list;
  const more = el('button', { class: 'button show-all', type: 'button' }, `Show all ${ns.length} log lines`);
  more.addEventListener('click', () => {
    list.append(...ns.slice(FIRST_ROWS).map((n) => lineRow(ctx, n)));
    more.remove();
  });
  return el('div', {}, list, more);
}

// ---- notes panel ----

const callDetail = (ctx, index) => {
  const entry = ctx.analysis.calls[index - 1];
  const { call, effect } = entry;
  const out = [];
  const iv = entry.interval;
  const at = entry.offset === null ? 'At an unknown time.' : `At ${formatTime(entry.offset)} from the first call.`;
  const until = iv.value === null
    ? ' Time until the next call: unknown.'
    : ` ${seconds(iv.value)} until the next call (tool, model and waiting together), ${linesLabel(iv.lines)}.`;
  out.push(el('p', { class: 'notes-text' }, at, until));
  out.push(el('p', { class: 'notes-text' }, `Kind: ${wordFor(CATEGORY_WORDS, effect.category)}.`));
  effect.requests.forEach((r, i) => {
    const mark = entry.marks[i];
    let tail = '';
    if (mark !== null && mark.kind === 'repeat') tail = ` Asked again for lines already requested at ${linesLabel(mark.earlier)}.`;
    if (mark !== null && mark.kind === 'unchecked') tail = ` Could not be checked against ${linesLabel(mark.earlier)}, because some lines are unknown.`;
    out.push(el('p', { class: 'notes-text' }, 'Requested ', el('span', { class: 'data' }, describeRequest(r)), `.${tail}`));
  });
  for (const e of effect.edits) {
    out.push(el('p', { class: 'notes-text' }, 'Edit attempt on ',
      el('span', { class: 'data' }, e.file === null ? 'an unknown target' : e.file), ` (${wordFor(CLASS_WORDS, e.cls)}).`));
  }
  const first = ctx.analysis.firstSource.value;
  if (first !== null && first.call === index) out.push(el('p', { class: 'notes-text' }, 'This is the first recognised source edit attempt. Earlier calls with unknown effect might also have changed files.'));
  if (effect.category === 'blocked') out.push(el('p', { class: 'notes-text' }, 'The recording hook blocked this call, so it did not run.'));
  if (effect.hiddenEdit) out.push(el('p', { class: 'notes-text notes-dim' }, 'This call could have changed files that the log does not show.'));
  if (effect.hiddenRequest) out.push(el('p', { class: 'notes-text notes-dim' }, 'It could have requested files that the log does not show.'));
  out.push(lineRows(ctx, [call.n]));
  return { head: `Call ${call.index}, log line ${call.n}`, body: out };
};

const tracedDetail = (ctx, sel) => {
  const t = sel.traced;
  const body = [];
  if (t.value === null) {
    body.push(el('p', { class: 'notes-text' }, `Unknown: ${wordFor(REASON_WORDS, t.reason)}.`));
  } else {
    body.push(el('p', { class: 'notes-text' }, el('span', { class: 'data' }, sel.text), `, from ${linesLabel(t.lines)}.`));
  }
  if (t.lines.length > 0) body.push(lineRows(ctx, t.lines));
  return { head: sel.label, body };
};

const intervalDetail = (ctx, sel) => {
  const lines = sel.from === sel.to ? `Line ${sel.from}` : `Lines ${sel.from} to ${sel.to}`;
  const f = ctx.analysis.files.get(sel.file);
  const lower = f !== undefined && f.lowerBound;
  const body = [
    el('p', { class: 'notes-text' }, `Requested ${lower ? 'at least ' : ''}${sel.count === 1 ? 'once' : `${sel.count} times`}, by ${linesLabel(sel.lines)}.`),
    lineRows(ctx, sel.lines),
  ];
  if (lower) {
    body.splice(1, 0, el('p', { class: 'notes-text notes-dim' }, 'This file also has requests with open-ended or unknown lines, so this count is a lower bound.'));
  }
  return { head: `${lines} of ${sel.file}`, body };
};

/**
 * The notes panel. It follows ctx selections.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function notesPanel(ctx) {
  const head = el('h2', { class: 'notes-head', tabindex: '-1', id: 'notes-head' }, 'Evidence for a number');
  const body = el('div', {}, el('p', { class: 'notes-text notes-dim' }, 'Choose a number, a table row or a frame to see the log lines behind it.'));
  const actions = el('div', { class: 'notes-actions' });
  const panel = el('aside', { class: 'notes', 'aria-labelledby': 'notes-head', id: 'notes' }, head, body, actions);

  ctx.onSelect((sel, opts) => {
    if (opts.origin !== pressed) press(null);
    let detail;
    if (sel.kind === 'call') detail = callDetail(ctx, sel.index);
    else if (sel.kind === 'interval') detail = intervalDetail(ctx, sel);
    else detail = tracedDetail(ctx, sel);
    head.textContent = detail.head;
    replace(body, detail.body);
    replace(actions);
    if (opts.reveal) {
      const origin = opts.origin;
      if (origin instanceof HTMLElement) {
        const back = el('button', { class: 'button', type: 'button' }, 'Back to where you were');
        back.addEventListener('click', () => origin.focus());
        actions.append(back);
      }
      head.focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'nearest', behavior: ctx.reduced() ? 'auto' : 'smooth' });
    }
  });
  return panel;
}

// ---- evidence tables ----

const partialMark = (ctx) => (ctx.analysis.totals.partial ? el('span', { class: 'partial-mark' }, 'Partial') : null);

const section = (ctx, title, open, ...body) => el('details', { class: 'ev', open },
  el('summary', {}, title, partialMark(ctx)), el('div', { class: 'ev-body' }, ...body));

/** Same key for a band on a plate and its table row. */
export const intervalKey = (file, from) => `${from}:${file}`;

const FIRST_TABLE_ROWS = 8;

/** The repeated-lines table: the keyboard path to the bands and their frames. */
const repeatedTable = (ctx) => {
  const rows = ctx.repeated;
  if (rows.length === 0) {
    const text = ctx.analysis.top.value === null ? 'No explicit line range was requested.' : 'No line was requested more than once.';
    return section(ctx, 'Repeated lines', true, el('p', {}, text));
  }
  const byKey = new Map();
  const tbody = el('tbody');
  const trs = rows.map((r) => {
    const select = el('button', { class: 'button row-select data', type: 'button' }, r.from === r.to ? `${r.from}` : `${r.from} to ${r.to}`);
    const lower = ctx.analysis.files.get(r.file)?.lowerBound === true;
    const tr = el('tr', { 'aria-selected': 'false' },
      el('td', { 'data-label': 'Lines' }, select),
      el('td', { class: 'path', 'data-label': 'File' }, r.file),
      el('td', { class: 'num', 'data-label': 'Times' }, lower ? `at least ${r.count}` : String(r.count)),
      el('td', { 'data-label': 'Requests' }, tracedButton(ctx, linesLabel(r.lines, 4), { value: r.count, lines: r.lines, reason: null },
        `Requests of lines ${r.from} to ${r.to} of ${r.file}`)));
    select.addEventListener('click', () => ctx.select({ kind: 'interval', ...r }, { reveal: false, origin: select }));
    byKey.set(intervalKey(r.file, r.from), tr);
    return tr;
  });
  tbody.append(...trs.slice(0, FIRST_TABLE_ROWS));
  const table = el('table', { class: 'ev-table' },
    el('caption', {}, 'Line ranges requested two or more times, brightest first. Choose a range to light its band and frames.'),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Lines'), el('th', { scope: 'col' }, 'File'),
      el('th', { scope: 'col', class: 'num' }, 'Times'), el('th', { scope: 'col' }, 'Requests'))),
    tbody);
  let more = null;
  const showAll = () => {
    if (more === null) return;
    tbody.append(...trs.slice(FIRST_TABLE_ROWS));
    more.remove();
    more = null;
  };
  if (trs.length > FIRST_TABLE_ROWS) {
    more = el('button', { class: 'button show-all', type: 'button' }, `Show all ${trs.length} ranges`);
    more.addEventListener('click', showAll);
  }
  let current = null;
  ctx.onSelect((sel) => {
    if (current !== null) current.setAttribute('aria-selected', 'false');
    current = sel.kind === 'interval' ? byKey.get(intervalKey(sel.file, sel.from)) ?? null : null;
    if (current === null) return;
    if (!current.isConnected) showAll();
    current.setAttribute('aria-selected', 'true');
  });
  return section(ctx, `Repeated lines (${rows.length} ${rows.length === 1 ? 'range' : 'ranges'})`, true, table, more);
};

const countsSection = (ctx) => {
  const a = ctx.analysis;
  const fog = ctx.frames.filter((f) => f.fog).map((f) => f.n);
  const fogTraced = { value: fog.length, lines: fog, reason: null };
  const num = (t, label) => tracedButton(ctx, t.value === null ? 'unknown' : String(t.value), t, label);
  return section(ctx, 'Requests and repeat requests', false,
    el('p', {}, 'Requests: ', num(a.requests, 'Requests'), '. Repeat requests: ', num(a.repeats, 'Repeat requests'),
      '. Could not be checked, because lines were open-ended or unknown: ', num(a.unchecked, 'Requests that could not be checked'), '.'),
    el('p', {}, 'Calls with unknown effect may have requested or changed files that are not counted here: ',
      tracedButton(ctx, String(fog.length), fogTraced, 'Calls with unknown effect'), fog.length === 1 ? ' call.' : ' calls.'));
};

const timeSection = (ctx) => {
  const a = ctx.analysis;
  const rows = a.time.longest.map((t) => el('tr', {},
    el('td', { class: 'num', 'data-label': 'Call' }, String(t.value.call)),
    el('td', { class: 'num', 'data-label': 'Time' }, seconds(t.value.seconds)),
    el('td', { 'data-label': 'From and to' }, tracedButton(ctx, linesLabel(t.lines), t, `Time until the next call after call ${t.value.call}`))));
  const body = [];
  if (rows.length === 0) {
    body.push(el('p', {}, 'No time until the next call is known.'));
  } else {
    body.push(el('table', { class: 'ev-table' },
      el('caption', {}, 'Time until the next call (tool, model and waiting together), longest first.'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', class: 'num' }, 'Call'), el('th', { scope: 'col', class: 'num' }, 'Time'),
        el('th', { scope: 'col' }, 'From and to'))),
      el('tbody', {}, rows)));
  }
  const ar = a.time.afterRepeats;
  if (ar.value === null) {
    body.push(el('p', {}, 'Time after repeat-request calls: none, because no repeat request was found.'));
  } else {
    body.push(el('p', {}, 'Time after repeat-request calls: ',
      tracedButton(ctx, formatTime(ar.value.seconds), ar, 'Time after repeat-request calls'),
      ` over ${ar.value.calls} ${ar.value.calls === 1 ? 'call' : 'calls'}`,
      ar.value.unknown > 0 ? `, ${ar.value.unknown} of them with unknown time.` : '.'));
  }
  return section(ctx, 'Longest times until the next call', false, ...body);
};

const editsSection = (ctx) => {
  const a = ctx.analysis;
  const body = [];
  const fs = a.firstSource.value;
  if (fs === null) body.push(el('p', {}, 'No source edit attempt recognised.'));
  else {
    body.push(el('p', {}, 'First recognised source edit attempt: call ', tracedButton(ctx, String(fs.call), a.firstSource, 'First recognised source edit attempt'),
      ' on ', el('span', { class: 'data' }, fs.file), '.'));
  }
  body.push(el('p', {}, 'Earlier calls that could have changed files: ',
    tracedButton(ctx, a.possibleEarlier.value === null ? 'unknown' : String(a.possibleEarlier.value), a.possibleEarlier,
      'Calls that could have changed files'), '.'));
  if (a.otherEdits.length === 0) {
    body.push(el('p', {}, 'No other edit attempt was recognised.'));
  } else {
    const rows = a.otherEdits.map((e) => el('tr', {},
      el('td', { 'data-label': 'Class' }, wordFor(CLASS_WORDS, e.cls)),
      el('td', { class: 'path', 'data-label': 'Target' }, e.file === null ? 'unknown' : e.file),
      el('td', { 'data-label': 'Call' }, tracedButton(ctx, `call ${e.call}`, { value: e.call, lines: [e.n], reason: null }, `Edit attempt in call ${e.call}`))));
    body.push(el('table', { class: 'ev-table' },
      el('caption', {}, 'Other edit attempts, by class.'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Class'), el('th', { scope: 'col' }, 'Target'), el('th', { scope: 'col' }, 'Call'))),
      el('tbody', {}, rows)));
  }
  return section(ctx, 'Edit attempts', false, ...body);
};

const linesSection = (ctx) => {
  const t = ctx.analysis.totals;
  const item = (label, ns) => el('p', {}, `${label}: `,
    ns.length === 0 ? '0' : tracedButton(ctx, `${ns.length}`, { value: ns.length, lines: ns, reason: null }, label),
    ns.length === 0 ? '.' : ` (${linesLabel(ns)}).`);
  const broken = t.broken.map((b) => b.n);
  const anomalies = ctx.analysis.time.anomalies;
  const body = [
    item('Log lines that could not be read', broken),
    item('Notes, lines that are not calls', t.noteLines),
    item('Blank lines', t.blank),
    item('Calls blocked by the recording hook', t.blocked),
    item('Times that could not be used', anomalies.map((x) => x.n)),
  ];
  if (anomalies.length > 0) {
    body.push(el('ul', { class: 'rows' }, anomalies.map((x) => el('li', { class: 'row' },
      el('span', { class: 'row-n' }, `log line ${x.n}`), `, ${wordFor(ANOMALY_WORDS, x.reason)}`))));
  }
  return section(ctx, 'Log lines that are not ordinary calls', false, ...body);
};

/**
 * The evidence tables, each in a collapsible section.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function evidence(ctx) {
  return el('section', { class: 'evidence', 'aria-labelledby': 'evidence-head' },
    el('h2', { class: 'section-head', id: 'evidence-head' }, 'Evidence'),
    el('p', { class: 'section-note' }, 'The log lines behind the counted numbers. Open a section to see its rows.'),
    repeatedTable(ctx), countsSection(ctx), timeSection(ctx), editsSection(ctx), linesSection(ctx));
}
