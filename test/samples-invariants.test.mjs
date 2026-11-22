// Sample invariants (R11.4): analyse every bundled sample and check invariants only.
// Calls, blocked calls and the span are recounted here with plain JSON.parse, not parse.js.
// No number is copied from module output.
// Run: node --permission --allow-fs-read=. test/samples-invariants.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from '../src/core/parse.js';
import { analyse } from '../src/core/metrics.js';
import {
  checkLineKinds, checkFileCounts, checkFirstSource, checkTime, checkTraced, checkPartial,
} from './invariants.mjs';

const dir = new URL('../samples/', import.meta.url);
const names = readdirSync(dir).filter((f) => f.endsWith('.events.jsonl')).sort();

test('there are bundled samples to check', () => {
  assert.ok(names.length >= 3, `expected the three bundled samples, found ${names.length}`);
});

for (const name of names) {
  const text = readFileSync(new URL(name, dir), 'utf8');
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const objs = raw.map((line) => JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line));
  const parsed = parse(text);
  const a = analyse(parsed);

  test(`${name}: call and blocked counts match an independent recount`, () => {
    const pre = objs.filter((o) => o.hook === 'pre');
    assert.equal(a.totals.calls, pre.length, `${name}: one call per "hook": "pre" line`);
    const blocked = objs.map((o, i) => [o, i + 1]).filter(([o]) => o.hook === 'pre' && o.allow === false).map(([, n]) => n);
    assert.deepEqual(a.totals.blocked, blocked, `${name}: blocked calls are the "allow": false lines`);
    assert.ok(a.calls.filter((c) => c.effect.category === 'blocked').every((c) => blocked.includes(c.call.n)), `${name}: blocked only where allow is false`);
  });

  test(`${name}: span equals the last minus the first raw t`, () => {
    const span = objs[objs.length - 1].t - objs[0].t;
    assert.ok(Math.abs(a.time.span.value - span) < 1e-6, `${name}: span ${a.time.span.value} must equal ${span}`);
    assert.deepEqual(a.time.span.lines, [1, objs.length], `${name}: span traced to the first and the last log line`);
  });

  test(`${name}: P1, P12, P15, P16, P18, P20`, () => {
    checkLineKinds(parsed, raw.length);
    checkFileCounts(a);
    checkFirstSource(a);
    checkTime(a);
    checkTraced(a, raw.length);
    checkPartial(a);
  });
}
