// Seeded property test helper. No dependencies, no writes, no processes, no network.
// SEED=<n> overrides the default seed for every check() in the run.

export const DEFAULT_SEED = 20261122;

/**
 * mulberry32: returns a function giving floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {number} */
export function seedFromEnv() {
  const raw = typeof process !== 'undefined' ? process.env.SEED : undefined;
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`SEED must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

const show = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Runs propFn on `runs` generated cases. propFn fails by throwing or returning false.
 * The error names the seed, the case index and the generated input.
 * @param {string} name
 * @param {{ seed?: number, runs?: number }} options
 * @param {(r: Gen) => unknown} genFn
 * @param {(input: any) => unknown} propFn
 */
export function check(name, options, genFn, propFn) {
  const seed = options.seed ?? seedFromEnv();
  const runs = options.runs ?? 200;
  const r = gen(rng(seed));
  for (let i = 0; i < runs; i += 1) {
    const input = genFn(r);
    let failure = null;
    try {
      if (propFn(input) === false) failure = 'property returned false';
    } catch (err) {
      failure = err && err.message ? err.message : String(err);
    }
    if (failure !== null) {
      throw new Error(`property "${name}" failed with seed ${seed} at case ${i}; rerun with SEED=${seed}\ninput: ${show(input)}\n${failure}`);
    }
  }
}

/**
 * @typedef {object} Gen
 * @property {() => number} next
 * @property {(lo: number, hi: number) => number} int  inclusive
 * @property {<T>(items: T[]) => T} pick
 * @property {(p?: number) => boolean} bool
 */

/**
 * Wraps a float source with small helpers.
 * @param {() => number} next
 * @returns {Gen}
 */
export function gen(next) {
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    bool: (p = 0.5) => next() < p,
  };
}

// ---- shared generators ----

// Source-class names only: no test_, repro, scratch, debug, tmp or temp prefix.
const STEMS = ['models', 'text', 'segment', 'adapters', 'cells', 'core', 'util', 'a', 'main_mod', 'x9'];
const EXTS = ['py', 'js', 'ts', 'go', 'rs'];
const DIRS = ['pkg', 'src', 'rich', 'lib', 'app', 'src/inner', 'deep/er/dir'];

/** @param {Gen} r @returns {string} a source-class basename such as "models.py" */
export const fileName = (r) => `${r.pick(STEMS)}.${r.pick(EXTS)}`;

/** @param {Gen} r @returns {string} a relative directory, no dot segments */
export const dirName = (r) => r.pick(DIRS);

/** @param {Gen} r @returns {'bare'|'single'|'double'} */
export const quoteStyle = (r) => r.pick(['bare', 'single', 'double']);

/**
 * Quotes a word that has no quotes, `$`, backslash or whitespace in it.
 * @param {string} word
 * @param {'bare'|'single'|'double'} style
 */
export const quote = (word, style) => {
  if (style === 'single') return `'${word}'`;
  if (style === 'double') return `"${word}"`;
  return word;
};

/** @param {Gen} r */
export const offset = (r) => r.pick([0, 1, r.int(0, 2000), r.int(0, 50)]);

/** @param {Gen} r */
export const limit = (r) => r.pick([1, 2, r.int(1, 300), r.int(1, 20)]);

/** @param {Gen} r @returns {number} epoch seconds in 2026 with a fraction */
export const time = (r) => 1795200000 + r.int(0, 100000) + r.next();
