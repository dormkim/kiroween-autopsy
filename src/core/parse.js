// Log text -> lines (call | note | broken | blank), each with its 1-based log line.
// Pure: no DOM, no I/O, no time. Runs in the browser and under node:test.

/** Visible length of a cut `cmd`. */
export const CUT_LEN = 200;

/**
 * @typedef {{ offset: number|null, limit: number|null }} Range
 * @typedef {{ n: number, index: number, t: number|null, tool: string, cmd: string|null,
 *   truncated: boolean|null, allow: boolean|null, paths: string[]|null, range: Range|null,
 *   malformed: string[] }} Call
 * @typedef {{ n: number, kind: 'call', call: Call }
 *   | { n: number, kind: 'note', t: number|null, hook: string }
 *   | { n: number, kind: 'broken', reason: 'json'|'not_object'|'no_hook'|'no_tool' }
 *   | { n: number, kind: 'blank' }} Line
 */

/**
 * Splits text into raw lines: on \n, one trailing \r dropped from each.
 * A final empty string after the last \n is not a line.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/** @returns {{ value: Range|null, ok: boolean }} */
const readRange = (raw) => {
  if (!isObject(raw)) return { value: null, ok: false };
  let offset = null;
  let limit = null;
  if (has(raw, 'offset')) {
    if (!Number.isSafeInteger(raw.offset) || raw.offset < 0) return { value: null, ok: false };
    offset = raw.offset;
  }
  if (has(raw, 'limit')) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1) return { value: null, ok: false };
    limit = raw.limit;
  }
  return { value: { offset, limit }, ok: true };
};

/**
 * Validates the optional fields of a pre line. A wrong type gives null and
 * names the field; an absent field gives null and is not malformed.
 * @param {Record<string, unknown>} obj
 * @param {number} n
 * @param {number} index
 * @returns {Call}
 */
const readCall = (obj, n, index) => {
  const malformed = [];
  const field = (key, valid) => {
    if (!has(obj, key)) return null;
    if (valid(obj[key])) return obj[key];
    malformed.push(key);
    return null;
  };
  const t = field('t', isTime);
  const cmd = field('cmd', (v) => typeof v === 'string');
  const cutFlag = field('cmd_truncated', (v) => typeof v === 'boolean');
  const allow = field('allow', (v) => typeof v === 'boolean');
  const paths = field('paths', (v) => Array.isArray(v) && v.every((p) => typeof p === 'string'));
  let range = { offset: null, limit: null };
  if (has(obj, 'range')) {
    const r = readRange(obj.range);
    if (!r.ok) malformed.push('range');
    range = r.value;
  }
  let truncated = null;
  if (cutFlag !== null) truncated = cutFlag;
  else if (cmd !== null) truncated = cmd.length >= CUT_LEN;
  return {
    n,
    index,
    t,
    tool: /** @type {string} */ (obj.tool),
    cmd,
    truncated,
    allow,
    paths: paths === null ? null : [...paths],
    range,
    malformed,
  };
};

/**
 * Parses one raw line. `index` is the call number this line gets if it is a call.
 * Never throws. A broken line keeps only its number and a reason code.
 * @param {string} raw
 * @param {number} n 1-based log line
 * @param {number} index 1-based call number for a call on this line
 * @returns {Line}
 */
export function parseLine(raw, n, index) {
  if (raw.trim() === '') return { n, kind: 'blank' };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { n, kind: 'broken', reason: 'json' };
  }
  if (!isObject(obj)) return { n, kind: 'broken', reason: 'not_object' };
  if (typeof obj.hook !== 'string') return { n, kind: 'broken', reason: 'no_hook' };
  if (obj.hook === 'pre') {
    if (typeof obj.tool !== 'string') return { n, kind: 'broken', reason: 'no_tool' };
    return { n, kind: 'call', call: readCall(obj, n, index) };
  }
  const t = has(obj, 't') && isTime(obj.t) ? obj.t : null;
  return { n, kind: 'note', t, hook: obj.hook };
}

/**
 * Parses a whole log in one pass.
 * @param {string} text
 * @returns {{ lines: Line[], calls: Call[], notes: Line[], broken: { n: number, reason: string }[], blank: number[] }}
 */
export function parse(text) {
  const lines = [];
  const calls = [];
  const notes = [];
  const broken = [];
  const blank = [];
  splitLines(text).forEach((raw, i) => {
    const line = parseLine(raw, i + 1, calls.length + 1);
    lines.push(line);
    if (line.kind === 'call') calls.push(line.call);
    else if (line.kind === 'note') notes.push(line);
    else if (line.kind === 'broken') broken.push({ n: line.n, reason: line.reason });
    else blank.push(line.n);
  });
  return { lines, calls, notes, broken, blank };
}
