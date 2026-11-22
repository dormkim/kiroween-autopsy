// How each bundled sample session ended. This is provenance, not analysis: it comes from
// the earlier benchmark runner's records (see DISCLOSURE.md), never from the event log.
// Only the bundled-sample path of the page uses it. src/core never imports it, and no
// ending is ever inferred from events. Pure: no DOM, no I/O.

/** @typedef {{ kind: 'cut_off'|'crashed'|'exited'|'unknown', label: string, sentence: string }} Ending */

/** @type {Ending} */
export const UNKNOWN_ENDING = Object.freeze({
  kind: 'unknown',
  label: 'Ending unknown',
  sentence: 'Ending unknown: the log does not record how the session ended.',
});

/** Bundled sample file name -> ending, from the runner's result rows and agent log. */
const ENDINGS = new Map([
  ['rich-3480.events.jsonl', Object.freeze({
    kind: 'cut_off',
    label: 'Cut off at the 15-minute limit',
    sentence: 'Cut off: the benchmark runner\'s records show the runner stopped the agent at its 15-minute (900 s) time limit.',
  })],
  ['rich-3506.events.jsonl', Object.freeze({
    kind: 'crashed',
    label: 'Crashed: Kiro\'s server shut down',
    sentence: 'Crashed: the benchmark runner\'s agent log shows Kiro\'s server shut down with an internal error ("RangeError: Invalid string length") about 2 minutes after the last recorded event.',
  })],
  ['requests-6644.events.jsonl', Object.freeze({
    kind: 'exited',
    label: 'Exited normally (exit code 0)',
    sentence: 'Exited normally: the benchmark runner\'s records show the agent process exited with code 0; the log has no outcome.',
  })],
]);

/** File names of the bundled samples that have a recorded ending. */
export const SAMPLE_NAMES = Object.freeze([...ENDINGS.keys()]);

/**
 * The ending to show for an opened log. Only a bundled sample opened through the sample
 * path has a known ending. A file the user opens is always unknown, whatever its name
 * or content.
 * @param {{ source: 'sample'|'file', name: string }} origin
 * @returns {Ending}
 */
export function endingFor(origin) {
  if (origin === null || typeof origin !== 'object' || origin.source !== 'sample') return UNKNOWN_ENDING;
  return ENDINGS.get(origin.name) ?? UNKNOWN_ENDING;
}
