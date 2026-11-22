// Tests for src/core/shell.js (lex).
// Run: node --permission --allow-fs-read=. test/shell.test.mjs
// Expected values follow design "Shell lexing" and bash quoting rules.
//
// Shape under test:
//   lex(cmd, truncated) -> { segments, cutAt }
//   Segment  = { words: Word[], redirects: Redirect[], op: string|null, exec, group, cut }
//   Word     = { text, dynamic, glob, quoted, start, end }   // text has quotes removed; end is the index after the word
//   Redirect = { op, fd: number|null, target: Word|null, dup: boolean }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/core/shell.js';
import { check } from './gen.mjs';

const words = (seg) => seg.words.map((w) => w.text);
const shape = (cmd, truncated = false) => lex(cmd, truncated).segments.map((s) => ({ words: words(s), op: s.op }));
const one = (cmd) => {
  const { segments } = lex(cmd, false);
  assert.equal(segments.length, 1, `${JSON.stringify(cmd)} must be one segment; got ${segments.length}`);
  return segments[0];
};
const redir = (r) => ({ op: r.op, fd: r.fd, target: r.target ? r.target.text : null, dup: r.dup });

// ---- operators ----

test('each operator ends a segment and is stored on it', () => {
  assert.deepEqual(shape('a && b || c ; d | e |& f & g\nh'), [
    { words: ['a'], op: '&&' },
    { words: ['b'], op: '||' },
    { words: ['c'], op: ';' },
    { words: ['d'], op: '|' },
    { words: ['e'], op: '|&' },
    { words: ['f'], op: '&' },
    { words: ['g'], op: '\n' },
    { words: ['h'], op: null },
  ], 'operators with spaces; the last segment ended with the text, so op is null');
  assert.deepEqual(shape('a&&b;c|d'), [
    { words: ['a'], op: '&&' },
    { words: ['b'], op: ';' },
    { words: ['c'], op: '|' },
    { words: ['d'], op: null },
  ], 'operators need no spaces around them');
});

test('empty segments are dropped and a line continuation joins lines', () => {
  assert.deepEqual(shape(';; ls'), [{ words: ['ls'], op: null }], 'nothing before ; gives no segment');
  assert.deepEqual(shape('ls \\\n -la'), [{ words: ['ls', '-la'], op: null }], 'backslash-newline is removed, not an operator');
  assert.deepEqual(shape('ls &&\n\npwd'), [{ words: ['ls'], op: '&&' }, { words: ['pwd'], op: null }], 'blank lines make no segment');
});

// ---- quoting ----

test('single quotes, double quotes and backslash keep operators inside one word', () => {
  const seg = one(`echo 'a && b' "c; d" e\\ f g\\;h`);
  assert.deepEqual(words(seg), ['echo', 'a && b', 'c; d', 'e f', 'g;h']);
  assert.deepEqual(seg.words.map((w) => w.quoted), [false, true, true, true, true], 'a backslash-escaped character counts as quoted');
  const dq = one('echo "a \\"b\\" \\$x \\q"');
  assert.deepEqual(words(dq), ['echo', 'a "b" $x \\q'], 'inside double quotes \\" and \\$ are escapes; \\q keeps its backslash');
  assert.equal(dq.words[1].dynamic, false, 'an escaped $ is not dynamic');
  assert.deepEqual(words(one(`echo ab'cd'"ef"`)), ['echo', 'abcdef'], 'adjacent quoted parts join into one word');
  assert.deepEqual(words(one(`echo ''`)), ['echo', ''], 'an empty quoted string is a word');
});

test('word positions: start and end index into cmd', () => {
  const seg = one('cat  a.py');
  assert.deepEqual(seg.words.map((w) => [w.start, w.end]), [[0, 3], [5, 9]]);
});

// ---- flags ----

test('dynamic flag: unquoted or double-quoted $NAME or ${, and a leading ~', () => {
  const seg = one(`cat $F "\${G}" '$H' "$I" x$J ~/k plain a=b`);
  assert.deepEqual(seg.words.map((w) => w.dynamic),
    [false, true, true, false, true, true, true, false, false],
    'cat no, $F yes, "${G}" yes, single-quoted $H no, "$I" yes, x$J yes, ~/k yes, plain no, a=b no');
});

test('glob flag: unquoted *, ? or [ only', () => {
  const seg = one(`ls *.py 'x*' "y?" a[1] b\\*`);
  assert.deepEqual(seg.words.map((w) => w.glob), [false, true, false, false, true, false]);
});

test('exec flag: $(, backtick, <( and >( outside single quotes; their contents make no segments', () => {
  const a = one('echo $(cat a.py; rm b > c)');
  assert.equal(a.exec, true, '$( sets exec');
  assert.deepEqual(a.redirects, [], 'a redirect inside $( ) is not a redirect of the segment');
  assert.equal(one('echo `ls; pwd`').exec, true, 'backtick sets exec');
  assert.equal(one('diff <(ls) >(cat)').exec, true, 'process substitution sets exec');
  assert.equal(one(`echo "$(ls)"`).exec, true, '$( inside double quotes still runs');
  assert.equal(one(`echo '$(ls)' '\`x\`'`).exec, false, 'inside single quotes nothing runs');
  assert.equal(one('echo $HOME').exec, false, 'a plain variable is not exec');
  assert.deepEqual(shape('echo $(a && (b; c)) && ls'), [
    { words: ['echo', '$(a && (b; c))'], op: '&&' },
    { words: ['ls'], op: null },
  ], 'nested parentheses inside $( ) are skipped as one word');
});

test('group flag: a word (, ), { or } in command position', () => {
  const g = lex('{ ls; }', false).segments;
  assert.equal(g[0].group, true, '{ in command position');
  assert.equal(lex('(cd x; ls)', false).segments[0].group, true, '( in command position');
  assert.equal(one('find . -exec grep -l x {} \\;').group, false, '{} as an argument is not a group');
  assert.equal(one('echo "(" ")"').group, false, 'quoted parentheses are not a group');
});

// ---- redirects ----

test('every redirect form in design.md, with its fd and target', () => {
  const cases = [
    ['cmd > out', { op: '>', fd: null, target: 'out', dup: false }],
    ['cmd>out', { op: '>', fd: null, target: 'out', dup: false }],
    ['cmd 2> err', { op: '>', fd: 2, target: 'err', dup: false }],
    ['cmd 2>/dev/null', { op: '>', fd: 2, target: '/dev/null', dup: false }],
    ['cmd >> out', { op: '>>', fd: null, target: 'out', dup: false }],
    ['cmd 1>> out', { op: '>>', fd: 1, target: 'out', dup: false }],
    ['cmd >| out', { op: '>|', fd: null, target: 'out', dup: false }],
    ['cmd &> out', { op: '&>', fd: null, target: 'out', dup: false }],
    ['cmd &>> out', { op: '&>>', fd: null, target: 'out', dup: false }],
    ['cmd < in', { op: '<', fd: null, target: 'in', dup: false }],
    ['cmd 0< in', { op: '<', fd: 0, target: 'in', dup: false }],
    ['cmd 2>&1', { op: '>&', fd: 2, target: '1', dup: true }],
    ['cmd >&2', { op: '>&', fd: null, target: '2', dup: true }],
    ['cmd 2>&-', { op: '>&', fd: 2, target: '-', dup: true }],
    ['cmd <&3', { op: '<&', fd: null, target: '3', dup: true }],
    ['cmd >&out', { op: '>&', fd: null, target: 'out', dup: false }],
    ['cmd <<< "a > b"', { op: '<<<', fd: null, target: 'a > b', dup: false }],
  ];
  for (const [cmd, expected] of cases) {
    const seg = one(cmd);
    assert.deepEqual(words(seg), ['cmd'], `${cmd}: the redirect and its target are not words`);
    assert.deepEqual(seg.redirects.map(redir), [expected], `${cmd}: redirect`);
  }
  const notFd = one('cmd a2>x');
  assert.deepEqual(words(notFd), ['cmd', 'a2'], 'a2>x: a2 is a word because it is not only digits');
  assert.equal(notFd.redirects[0].fd, null);
  const quotedTarget = one('cmd > "$OUT"');
  assert.equal(quotedTarget.redirects[0].target.dynamic, true, 'a redirect target keeps its word flags');
});

test('a redirect between words: words and redirects are kept apart', () => {
  const seg = one('grep x a.py 2> /dev/null b.py');
  assert.deepEqual(words(seg), ['grep', 'x', 'a.py', 'b.py']);
  assert.deepEqual(seg.redirects.map(redir), [{ op: '>', fd: 2, target: '/dev/null', dup: false }]);
});

// ---- heredocs ----

test('<< skips the body after the current line, up to the delimiter line', () => {
  const { segments } = lex('cat << EOF > out.py\nline; rm x > y\nEOF\necho done', false);
  assert.deepEqual(segments.map((s) => ({ words: words(s), op: s.op })), [
    { words: ['cat'], op: '\n' },
    { words: ['echo', 'done'], op: null },
  ], 'the body line "line; rm x > y" makes no segment');
  assert.deepEqual(segments[0].redirects.map(redir), [
    { op: '<<', fd: null, target: 'EOF', dup: false },
    { op: '>', fd: null, target: 'out.py', dup: false },
  ]);
});

test('<<- strips leading tabs before matching the delimiter; a quoted delimiter loses its quotes', () => {
  assert.deepEqual(shape("cat <<- 'END'\n\tbody > z; q\n\tEND\nls"), [
    { words: ['cat'], op: '\n' },
    { words: ['ls'], op: null },
  ], '<<- with a tab-indented END');
  assert.deepEqual(shape('cat << END\n\tEND\nx\nEND\nls'), [
    { words: ['cat'], op: '\n' },
    { words: ['ls'], op: null },
  ], 'plain << does not strip tabs, so "\\tEND" is body');
  const q = lex('python3 << "EOF"\nimport os; os.remove(\'a\')\nEOF', false).segments;
  assert.deepEqual(q.map(words), [['python3']], 'double-quoted delimiter');
  assert.equal(q[0].redirects[0].target.text, 'EOF');
  assert.deepEqual(shape("python3 << 'EOF' | head -5\nbody; x\nEOF"), [
    { words: ['python3'], op: '|' },
    { words: ['head', '-5'], op: '\n' },
  ], 'the rest of the heredoc line is lexed before the body');
  assert.deepEqual(shape("python3 << 'EOF'\nnever; closed > x"), [{ words: ['python3'], op: '\n' }], 'an unclosed body runs to the end');
});

// ---- comments ----

test('# at the start of a word comments to the end of the line', () => {
  assert.deepEqual(shape('ls # a; b > c\npwd'), [
    { words: ['ls'], op: '\n' },
    { words: ['pwd'], op: null },
  ]);
  assert.deepEqual(words(one('echo a#b')), ['echo', 'a#b'], '# inside a word is not a comment');
  assert.deepEqual(words(one(`echo '#x'`)), ['echo', '#x'], 'a quoted # is not a comment');
  assert.deepEqual(one('ls # > out').redirects, [], 'a redirect inside a comment is ignored');
});

// ---- truncation ----

test('cutAt and the cut segment', () => {
  const t = lex('cat a.py; grep x b', true);
  assert.equal(t.cutAt, 'cat a.py; grep x b'.length, 'cutAt is the length of the visible cmd');
  assert.deepEqual(t.segments.map((s) => s.cut), [false, true], 'only the segment that ended with the text is cut');
  const f = lex('cat a.py; grep x b', false);
  assert.equal(f.cutAt, null, 'not truncated: cutAt null');
  assert.deepEqual(f.segments.map((s) => s.cut), [false, false]);
  const ends = lex('ls && ', true);
  assert.deepEqual(ends.segments.map((s) => [words(s), s.op, s.cut]), [[['ls'], '&&', false]], 'an operator before the cut completes its segment');
  assert.deepEqual(lex('cat a', true).segments[0].words.map((w) => w.end), [3, 5], '"cat" ends before the cut at 5; "a" ends at the cut');
});

test('a heredoc whose redirect is visible before the cut keeps its segment complete', () => {
  const { segments, cutAt } = lex("cd /workspace && python3 << 'EOF'\nimport x", true);
  assert.equal(cutAt, "cd /workspace && python3 << 'EOF'\nimport x".length);
  assert.deepEqual(segments.map((s) => [words(s), s.op, s.cut]), [
    [['cd', '/workspace'], '&&', false],
    [['python3'], '\n', false],
  ], 'the cut falls inside the heredoc body, after the python3 line ended');
});

// ---- P8 ----

const PIECES = ['> src/a.py', ';', 'rm x', '&&', '||', '|', '&', '>>', '2>&1', '<', 'a.py', '<<', 'b', '#c', '(', ')'];

test('P8: operators and redirects inside quotes, comments or heredoc bodies make no segments, words or redirects', () => {
  check('P8', { runs: 300 }, (r) => {
    const body = Array.from({ length: r.int(1, 8) }, () => r.pick(PIECES)).join(r.pick([' ', '']));
    return { body, where: r.pick(['single', 'double', 'comment', 'heredoc', 'heredoc-dash']) };
  }, ({ body, where }) => {
    let cmd;
    if (where === 'single') cmd = `echo '${body}'`;
    else if (where === 'double') cmd = `echo "${body}"`;
    else if (where === 'comment') cmd = `echo ok # ${body}`;
    else if (where === 'heredoc') cmd = `cat << 'EOF'\n${body}\n${body}\nEOF`;
    else cmd = `cat <<- EOF\n\t${body}\n\tEOF`;
    const { segments } = lex(cmd, false);
    assert.equal(segments.length, 1, `${where}: exactly one segment`);
    const seg = segments[0];
    if (where === 'single' || where === 'double') {
      assert.deepEqual(words(seg), ['echo', body], `${where}: the body is one word`);
      assert.deepEqual(seg.redirects, [], `${where}: no redirects`);
    } else if (where === 'comment') {
      assert.deepEqual(words(seg), ['echo', 'ok']);
      assert.deepEqual(seg.redirects, [], 'comment: no redirects');
    } else {
      assert.deepEqual(words(seg), ['cat']);
      assert.deepEqual(seg.redirects.map((x) => x.op), [where === 'heredoc' ? '<<' : '<<-'], 'only the heredoc redirect');
    }
    assert.equal(seg.exec, false, 'nothing here runs a substitution');
  });
});
