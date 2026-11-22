// cmd string -> segments with words, redirects and flags.
// One left-to-right pass. Pure: no DOM, no I/O.
//
// Beyond design.md: an unquoted ( or ) word anywhere sets `group`, because a
// bare parenthesis is never an ordinary argument and the subshell's cd and
// effects cannot be followed.

/**
 * @typedef {{ text: string, dynamic: boolean, glob: boolean, quoted: boolean, start: number, end: number }} Word
 * @typedef {{ op: string, fd: number|null, target: Word|null, dup: boolean }} Redirect
 * @typedef {{ words: Word[], redirects: Redirect[], op: string|null, exec: boolean, group: boolean, cut: boolean }} Segment
 */

const GROUP_WORDS = new Set(['(', ')', '{', '}']);
const SPECIAL_PARAMS = '@*#?$!-0123456789';

/**
 * From index j (just past an opening paren), returns the index after the
 * matching close paren, skipping quoted text. Returns cmd.length if unclosed.
 */
const skipParens = (cmd, j) => {
  let depth = 1;
  while (j < cmd.length && depth > 0) {
    const ch = cmd[j];
    if (ch === '\\') j += 2;
    else if (ch === "'") {
      const close = cmd.indexOf("'", j + 1);
      j = close === -1 ? cmd.length : close + 1;
    } else if (ch === '"') {
      j += 1;
      while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === '\\' ? 2 : 1;
      j += 1;
    } else {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }
  }
  return Math.min(j, cmd.length);
};

/** From index j (just past an opening backtick), returns the index after the closing one. */
const skipBacktick = (cmd, j) => {
  while (j < cmd.length && cmd[j] !== '`') j += cmd[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, cmd.length);
};

/**
 * Splits a shell command into segments.
 * @param {string} cmd
 * @param {boolean|null} truncated true when the visible text was cut
 * @returns {{ segments: Segment[], cutAt: number|null }}
 */
export function lex(cmd, truncated) {
  const len = cmd.length;
  /** @type {Segment[]} */
  const segments = [];
  const newSegment = () => ({ words: [], redirects: [], op: null, exec: false, group: false, cut: false });
  let seg = newSegment();
  /** @type {Word|null} */
  let word = null;
  /** @type {Redirect|null} */
  let pendingRedirect = null;
  /** @type {{ delim: string, strip: boolean }[]} */
  let heredocs = [];
  let i = 0;

  const startWord = (at) => {
    if (word === null) word = { text: '', dynamic: false, glob: false, quoted: false, start: at, end: at };
    return word;
  };

  const finishWord = (at) => {
    if (word === null) return;
    const w = word;
    word = null;
    w.end = at;
    if (pendingRedirect !== null) {
      const r = pendingRedirect;
      pendingRedirect = null;
      r.target = w;
      if ((r.op === '>&' || r.op === '<&') && !w.quoted && /^(\d+|-)$/.test(w.text)) r.dup = true;
      if (r.op === '<<' || r.op === '<<-') heredocs.push({ delim: w.text, strip: r.op === '<<-' });
      return;
    }
    if (!w.quoted && GROUP_WORDS.has(w.text) && (seg.words.length === 0 || w.text === '(' || w.text === ')')) seg.group = true;
    seg.words.push(w);
  };

  const endSegment = (op) => {
    finishWord(i);
    pendingRedirect = null;
    if (seg.words.length > 0 || seg.redirects.length > 0) {
      seg.op = op;
      segments.push(seg);
    }
    seg = newSegment();
  };

  const skipHeredocBodies = () => {
    for (const { delim, strip } of heredocs) {
      while (i < len) {
        const nl = cmd.indexOf('\n', i);
        const lineEnd = nl === -1 ? len : nl;
        let line = cmd.slice(i, lineEnd);
        if (strip) line = line.replace(/^\t+/, '');
        i = nl === -1 ? len : nl + 1;
        if (line === delim) break;
      }
    }
    heredocs = [];
  };

  // $ at index i. Appends to the current word and returns the next index.
  const readDollar = (w) => {
    const next = cmd[i + 1];
    if (next === '(') {
      seg.exec = true;
      w.dynamic = true;
      const end = skipParens(cmd, i + 2);
      w.text += cmd.slice(i, end);
      return end;
    }
    if (next === '{') {
      w.dynamic = true;
      const close = cmd.indexOf('}', i + 2);
      const end = close === -1 ? len : close + 1;
      w.text += cmd.slice(i, end);
      return end;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      w.dynamic = true;
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(cmd[j])) j += 1;
      w.text += cmd.slice(i, j);
      return j;
    }
    if (next !== undefined && SPECIAL_PARAMS.includes(next)) {
      w.dynamic = true;
      w.text += cmd.slice(i, i + 2);
      return i + 2;
    }
    w.text += '$';
    return i + 1;
  };

  const readBacktick = (w) => {
    seg.exec = true;
    w.dynamic = true;
    const end = skipBacktick(cmd, i + 1);
    w.text += cmd.slice(i, end);
    return end;
  };

  const readDoubleQuoted = (w) => {
    w.quoted = true;
    i += 1;
    while (i < len && cmd[i] !== '"') {
      const ch = cmd[i];
      if (ch === '\\' && i + 1 < len && '$`"\\\n'.includes(cmd[i + 1])) {
        if (cmd[i + 1] !== '\n') w.text += cmd[i + 1];
        i += 2;
      } else if (ch === '$') {
        i = readDollar(w);
      } else if (ch === '`') {
        i = readBacktick(w);
      } else {
        w.text += ch;
        i += 1;
      }
    }
    i = Math.min(i + 1, len);
  };

  const addRedirect = (op, width) => {
    let fd = null;
    if (word !== null && !word.quoted && /^\d+$/.test(word.text)) {
      fd = Number(word.text);
      word = null;
    } else {
      finishWord(i);
    }
    pendingRedirect = null;
    const r = { op, fd, target: null, dup: false };
    seg.redirects.push(r);
    pendingRedirect = r;
    i += width;
  };

  const readProcessSubstitution = () => {
    finishWord(i);
    const w = startWord(i);
    seg.exec = true;
    w.dynamic = true;
    const end = skipParens(cmd, i + 2);
    w.text += cmd.slice(i, end);
    i = end;
  };

  while (i < len) {
    const c = cmd[i];
    const n1 = cmd[i + 1];
    if (c === ' ' || c === '\t') {
      finishWord(i);
      i += 1;
    } else if (c === '\n') {
      endSegment('\n');
      i += 1;
      skipHeredocBodies();
    } else if (c === '\\') {
      if (n1 === '\n') {
        i += 2;
      } else if (n1 === undefined) {
        i += 1;
      } else {
        const w = startWord(i);
        w.quoted = true;
        w.text += n1;
        i += 2;
      }
    } else if (c === "'") {
      const w = startWord(i);
      w.quoted = true;
      const close = cmd.indexOf("'", i + 1);
      const end = close === -1 ? len : close;
      w.text += cmd.slice(i + 1, end);
      i = close === -1 ? len : close + 1;
    } else if (c === '"') {
      readDoubleQuoted(startWord(i));
    } else if (c === '$') {
      i = readDollar(startWord(i));
    } else if (c === '`') {
      i = readBacktick(startWord(i));
    } else if (c === '#' && word === null) {
      const nl = cmd.indexOf('\n', i);
      i = nl === -1 ? len : nl;
    } else if (c === '(' || c === ')') {
      finishWord(i);
      startWord(i).text = c;
      finishWord(i + 1);
      i += 1;
    } else if (c === ';') {
      endSegment(';');
      i += 1;
    } else if (c === '&') {
      if (n1 === '&') {
        endSegment('&&');
        i += 2;
      } else if (n1 === '>') {
        if (cmd[i + 2] === '>') addRedirect('&>>', 3);
        else addRedirect('&>', 2);
      } else {
        endSegment('&');
        i += 1;
      }
    } else if (c === '|') {
      if (n1 === '|') {
        endSegment('||');
        i += 2;
      } else if (n1 === '&') {
        endSegment('|&');
        i += 2;
      } else {
        endSegment('|');
        i += 1;
      }
    } else if (c === '>') {
      if (n1 === '(') readProcessSubstitution();
      else if (n1 === '>') addRedirect('>>', 2);
      else if (n1 === '|') addRedirect('>|', 2);
      else if (n1 === '&') addRedirect('>&', 2);
      else addRedirect('>', 1);
    } else if (c === '<') {
      if (n1 === '(') readProcessSubstitution();
      else if (n1 === '<') {
        if (cmd[i + 2] === '<') addRedirect('<<<', 3);
        else if (cmd[i + 2] === '-') addRedirect('<<-', 3);
        else addRedirect('<<', 2);
      } else if (n1 === '&') addRedirect('<&', 2);
      else if (n1 === '>') addRedirect('<>', 2);
      else addRedirect('<', 1);
    } else {
      const w = startWord(i);
      if (c === '~' && w.text === '' && !w.quoted) w.dynamic = true;
      if (c === '*' || c === '?' || c === '[') w.glob = true;
      w.text += c;
      i += 1;
    }
  }

  finishWord(len);
  if (seg.words.length > 0 || seg.redirects.length > 0) {
    seg.op = null;
    seg.cut = truncated === true;
    segments.push(seg);
  }
  return { segments, cutAt: truncated === true ? len : null };
}
