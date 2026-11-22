// Tests for src/provenance/sample-endings.js.
// Run: node --permission --allow-fs-read=. test/sample-endings.test.mjs
// Endings come from the benchmark runner's records in DISCLOSURE.md, never from the log.
// Only the bundled-sample path gets a known ending; everything else is unknown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endingFor, SAMPLE_NAMES, UNKNOWN_ENDING } from '../src/provenance/sample-endings.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UNKNOWN = 'Ending unknown: the log does not record how the session ended.';

test('each bundled sample has its ending, word for word', () => {
  const s = (name) => endingFor({ source: 'sample', name });
  assert.deepEqual(s('rich-3480.events.jsonl'), {
    kind: 'cut_off',
    label: 'Cut off at the 15-minute limit',
    sentence: 'Cut off: the benchmark runner\'s records show the runner stopped the agent at its 15-minute (900 s) time limit.',
  }, 'DISCLOSURE.md: agent_rc "timeout" at 900 s');
  assert.deepEqual(s('rich-3506.events.jsonl'), {
    kind: 'crashed',
    label: 'Crashed: Kiro\'s server shut down',
    sentence: 'Crashed: the benchmark runner\'s agent log shows Kiro\'s server shut down with an internal error ("RangeError: Invalid string length"). The time of the crash is not recorded; the runner wrote that log 121 seconds after the last recorded event.',
  }, 'DISCLOSURE.md: Kiro\'s server raised RangeError; 121 s is when the runner wrote its agent log, not the time of the crash; no fault is assigned to the agent');
  assert.deepEqual(s('requests-6644.events.jsonl'), {
    kind: 'exited',
    label: 'Exited normally (exit code 0)',
    sentence: 'Exited normally: the benchmark runner\'s records show the agent process exited with code 0; the log has no outcome.',
  }, 'DISCLOSURE.md: agent_rc 0');
});

test('every file in samples/ has a recorded ending, and every ending names a file in samples/', () => {
  const files = readdirSync(join(ROOT, 'samples')).filter((f) => f.endsWith('.events.jsonl')).sort();
  assert.deepEqual([...SAMPLE_NAMES].sort(), files, 'the module must cover exactly the bundled samples');
  for (const name of files) {
    const e = endingFor({ source: 'sample', name });
    assert.notEqual(e.kind, 'unknown', `${name} must have a known ending, because DISCLOSURE.md records one`);
    assert.ok(e.label.startsWith(e.sentence.split(':')[0]), `${name}: the sentence must start with the words of its short label`);
    assert.ok(/runner's (?:records|agent log)/.test(e.sentence), `${name}: the sentence must say the ending comes from the runner, not the log`);
  }
});

test('a name that is not a bundled sample is unknown', () => {
  for (const name of ['other.events.jsonl', 'rich-3480.jsonl', 'RICH-3480.events.jsonl', '../samples/rich-3480.events.jsonl', '']) {
    assert.equal(endingFor({ source: 'sample', name }), UNKNOWN_ENDING, `"${name}" is not in the bundled list, so its ending is unknown`);
  }
  assert.equal(UNKNOWN_ENDING.sentence, UNKNOWN);
  assert.equal(UNKNOWN_ENDING.label, 'Ending unknown');
});

test('an opened file is unknown even with a bundled name', () => {
  for (const name of SAMPLE_NAMES) {
    assert.equal(endingFor({ source: 'file', name }).sentence, UNKNOWN, `an opened ${name} may not be the bundled recording, so its ending is unknown`);
  }
  assert.equal(endingFor(null).sentence, UNKNOWN, 'no origin is unknown');
  assert.equal(endingFor({ name: 'rich-3480.events.jsonl' }).sentence, UNKNOWN, 'an origin without source "sample" is unknown');
});

test('copy never says solved or unsolved and has no em dash or exclamation mark', () => {
  for (const e of [UNKNOWN_ENDING, ...SAMPLE_NAMES.map((name) => endingFor({ source: 'sample', name }))]) {
    for (const t of [e.label, e.sentence]) {
      assert.ok(!/solved|success|fail|\u2014|!/i.test(t), `"${t}" must not judge the result; the log has no outcome`);
    }
  }
});

test('core never imports the provenance module, so no analysis can read an ending', () => {
  const core = readdirSync(join(ROOT, 'src/core')).filter((f) => f.endsWith('.js'));
  assert.ok(core.length > 0, 'expected core modules');
  for (const f of core) {
    const src = readFileSync(join(ROOT, 'src/core', f), 'utf8');
    assert.ok(!/provenance|sample-endings/.test(src), `src/core/${f} must not mention or import the provenance module, because endings are not in the log`);
  }
});
