// Analysis -> the three finding sentences and the state messages, as lists of parts.
// A part is fixed copy (a string) or a value { text, traced }: every number is a value part
// carrying the traced value behind it, so the screen can show its log lines.
// Pure: no DOM, no I/O.

import { MAX_BYTES } from './metrics.js';

/**
 * @typedef {import('./metrics.js').Traced} Traced
 * @typedef {string | { text: string, traced: Traced|null }} Part
 */

const val = (text, traced) => ({ text: String(text), traced });
const num = (t) => val(t.value === null ? 'unknown' : t.value, t);
const many = (count, one, more) => (count === 1 ? one : more);

/**
 * Seconds as m:ss, rounded to the nearest second. Minutes can pass 59.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (seconds === null) return 'unknown';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LABELS = {
  request: 'file requests',
  search: 'searches',
  edit: 'edit attempts',
  test: 'test runs',
  run: 'code runs',
  vcs: 'version control calls',
  other: 'other calls',
  blocked: 'blocked calls',
  unknown: 'calls with unknown effect',
};

/** Finding 1: most requested lines and repeat requests. */
const requested = (a) => {
  const top = a.top.value;
  const k = a.requests.value;
  if (top === null) {
    if (k === 0) return ['No file requests were recognised.'];
    return ['No line ranges were requested. ', num(a.requests), many(k, ' request had', ' requests had'), ' unknown or open-ended lines.'];
  }
  const single = top.from === top.to;
  const lower = a.files instanceof Map && a.files.get(top.file)?.lowerBound === true;
  return [
    ...(single ? ['Line ', val(top.from, a.top)] : ['Lines ', val(top.from, a.top), ' to ', val(top.to, a.top)]),
    ' of ', val(top.file, a.top), single ? ' was requested ' : ' were requested ', ...(lower ? ['at least '] : []),
    val(top.count, a.top), many(top.count, ' time. ', ' times. '),
    num(a.repeats), ' of ', num(a.requests), many(k, ' request', ' requests'),
    ' asked again for lines already requested since the last edit attempt on that file; ', num(a.unchecked), ' could not be checked.',
  ];
};

/** Finding 2: first source edit attempt and the calls before it that could have changed files. */
const firstEdit = (a) => {
  const fs = a.firstSource.value;
  const k = a.possibleEarlier.value;
  const could = (earlier) => {
    const noun = many(k, ` ${earlier}call`, ` ${earlier}calls`);
    if (k === 0) return [' ', num(a.possibleEarlier), noun, ' could have changed files.'];
    return [' ', num(a.possibleEarlier), noun, earlier === '' ? ' might have' : ' might also have', ' changed files; the log cannot tell.'];
  };
  if (fs === null) return ['No source edit attempt recognised.', ...could('')];
  let when = [' at an unknown time'];
  if (fs.offset !== null) {
    when = [' at ', val(formatTime(fs.offset), a.firstSource)];
    if (fs.share !== null) when.push(', ', val(`${Math.round(fs.share * 100)}%`, a.firstSource), ' into the session');
  }
  return ['First source edit attempt: call ', val(fs.call, a.firstSource), ...when, ' (log line ', val(fs.n, a.firstSource), ').', ...could('earlier ')];
};

/** The category with the most time after it, as [key, traced], or null. */
const largest = (a) => {
  let best = null;
  for (const [key, t] of a.time.byCategory) {
    if (Object.hasOwn(LABELS, key) && (best === null || t.value > best[1].value)) best = [key, t];
  }
  return best;
};

/** Finding 3: where the time went. */
const timeSpent = (a) => {
  const span = a.time.span;
  if (span.value === null) return ['No call has a usable time, so where the time went is unknown.'];
  const best = largest(a);
  const parts = [];
  if (best === null) {
    parts.push('The time until the next call is unknown for every call.');
  } else {
    const [key, t] = best;
    const pct = span.value > 0 ? `${Math.round((t.value / span.value) * 100)}%` : 'unknown';
    parts.push('The largest share of the session, ', val(formatTime(t.value), t), ' of ', val(formatTime(span.value), span), ' (', val(pct, t),
      `), came after ${LABELS[key]}. That includes the tool, the model and waiting.`);
  }
  const top = a.time.longest[0];
  if (top !== undefined) {
    const [first, second] = top.lines;
    parts.push(' The longest time until the next call was ', val(formatTime(top.value.seconds), top), ', after call ', val(top.value.call, top));
    if (second === undefined) parts.push(' (log line ', val(first, top), ').');
    else parts.push(' (log lines ', val(first, top), ' and ', val(second, top), ').');
  }
  const gaps = a.time.byCategory.get('unknown_time');
  if (gaps !== undefined) parts.push(' Times are unknown for ', val(formatTime(gaps.value), gaps), ' of the session.');
  return parts;
};

const brokenTraced = (broken) => ({ value: broken.length, lines: broken.map((b) => b.n), reason: null });

const partialSuffix = (broken) => [
  ' Partial: ', val(broken.length, brokenTraced(broken)), many(broken.length, ' log line could not be read.', ' log lines could not be read.'),
];

/**
 * The three findings, each a list of parts. When the log has broken lines, each ends
 * with the partial note.
 * @param {ReturnType<typeof import('./metrics.js').analyse>} a
 * @returns {Part[][]}
 */
export function findings(a) {
  const out = [requested(a), firstEdit(a), timeSpent(a)];
  return a.totals.partial ? out.map((s) => [...s, ...partialSuffix(a.totals.broken)]) : out;
}

const isLowerBound = (a, file) => a.files instanceof Map && a.files.get(file)?.lowerBound === true;

/**
 * The plain answer that leads each finding, readable in two seconds. Each carries the
 * traced value its "Show log lines" control opens, and a label for that value.
 * Same numbers as findings(); only shorter words.
 * @param {ReturnType<typeof import('./metrics.js').analyse>} a
 * @returns {{ text: string, traced: Traced, label: string }[]}
 */
export function headlines(a) {
  const out = [];

  const top = a.top.value;
  if (top === null) {
    out.push({ text: a.requests.value === 0 ? 'No file requests recognised' : 'No line ranges requested', traced: a.requests, label: 'Requests' });
  } else if (top.count < 2) {
    out.push({ text: 'No line was requested twice', traced: a.top, label: 'Most requested lines' });
  } else {
    const n = top.to - top.from + 1;
    const lines = n === 1 ? 'the same line' : `the same ${n} lines`;
    const text = isLowerBound(a, top.file) ? `At least ${top.count} requests for ${lines}` : `${top.count} requests for ${lines}`;
    out.push({ text, traced: a.top, label: 'Most requested lines' });
  }

  const fs = a.firstSource.value;
  if (fs === null) {
    out.push({ text: 'No source edit attempt recognised', traced: a.possibleEarlier, label: 'Calls that could have changed files' });
  } else if (fs.share === null) {
    out.push({ text: `First source edit attempt at call ${fs.call}, time unknown`, traced: a.firstSource, label: 'First source edit attempt' });
  } else {
    out.push({ text: `${Math.round(fs.share * 100)}% of the session passed before the first source edit attempt`, traced: a.firstSource, label: 'First source edit attempt' });
  }

  const span = a.time.span;
  const best = largest(a);
  if (span.value === null || span.value <= 0 || best === null) {
    out.push({ text: 'Where the time went is unknown', traced: span, label: 'Time from the first call to the last valid event' });
  } else {
    const [key, t] = best;
    out.push({ text: `${Math.round((t.value / span.value) * 100)}% of the time came after ${LABELS[key]}`, traced: t, label: `Time after ${LABELS[key]}` });
  }
  return out;
}

/** "1 to 3, 5": runs of three or more consecutive numbers are shortened. */
const lineList = (ns) => {
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
};

const brokenList = (broken) => {
  const ns = broken.map((b) => b.n);
  return [' (', many(ns.length, 'log line ', 'log lines '), val(lineList(ns), brokenTraced(broken)), ').'];
};

/**
 * Message for a non-normal state, as a list of parts. The file name and the cause are
 * value parts, shown as given.
 * @param {{ state: 'load_error'|'too_large'|'empty'|'not_a_log'|'no_calls'|'partial', name: string,
 *   cause?: string, bytes?: number, broken?: { n: number }[], notes?: number[] }} input
 * @returns {Part[]}
 */
export function stateMessage(input) {
  const name = val(input.name, null);
  switch (input.state) {
    case 'load_error':
      return ['Could not open ', name, ': ', val(input.cause, null), '.'];
    case 'too_large':
      return [name, ' is ', val((input.bytes / (1024 * 1024)).toFixed(1), null), ` MB; the limit is ${MAX_BYTES / (1024 * 1024)} MB.`];
    case 'empty':
      return [name, ' is empty.'];
    case 'not_a_log':
      return [name, ' is not a session log: no log line could be read', ...brokenList(input.broken)];
    case 'no_calls': {
      const k = input.notes.length;
      return [name, ' has ', val(k, { value: k, lines: [...input.notes], reason: null }), many(k, ' note', ' notes'), ' and no calls.'];
    }
    case 'partial': {
      const b = input.broken.length;
      return ['Partial: ', val(b, brokenTraced(input.broken)), many(b, ' log line could not be read', ' log lines could not be read'), ...brokenList(input.broken)];
    }
    default:
      throw new Error(`unknown state ${String(input.state)}`);
  }
}
