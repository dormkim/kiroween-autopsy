// Contact strip: one frame per call, edge codes, fog, unexposed frames, cut mark,
// ectoplasm threads, playhead, and the replay controls with the live line.

import { formatTime } from '../core/findings.js';
import { el, svg } from './dom.js';
import { CATEGORY_WORDS, describeRequest, rawText, wordFor } from './notes.js';

const THREAD_H = 44;
const REBATE = 24;
const FRAME_H = 56;
const HEIGHT = THREAD_H + REBATE + FRAME_H + REBATE;
const FRAME_Y = THREAD_H + REBATE;
const PAD = 12;
const MIN_W = 4;
const UNKNOWN_W = 12;
const TAIL_W = 104;
const CODE_GAP = 34;
const STEP_MS = 120;
/** The hatch pattern defined in index.html. */
const FOG = 'url(#fog)';

/** Pixels per second: the whole session spans about 1,600px, within 1.2 to 8 px/s. */
const scaleFor = (span) => (span === null || span <= 0 ? 4 : Math.min(8, Math.max(1.2, 1600 / span)));

/**
 * Frame positions: x, width, and centre, from the time until the next call.
 * @param {import('../core/timeline.js').Frame[]} frames
 * @param {number|null} span
 */
const layout = (frames, span) => {
  const pps = scaleFor(span);
  let x = PAD;
  const boxes = frames.map((f) => {
    const w = f.seconds === null ? UNKNOWN_W : Math.max(MIN_W, f.seconds * pps);
    const box = { x, w, cx: x + w / 2 };
    x += w;
    return box;
  });
  return { boxes, tailX: x, width: x + TAIL_W + PAD };
};

const frameClass = (f) => {
  if (f.blocked) return 'frame frame-blocked';
  if (f.repeat !== null && f.repeat.kind === 'repeat') return 'frame frame-repeat';
  if (f.category === 'edit') return 'frame frame-edit';
  if (f.category === 'request') return 'frame frame-request';
  return 'frame';
};

/** Sprocket holes along one rebate row. */
const sprockets = (width, y) => {
  const out = [];
  for (let x = 6; x < width - 8; x += 14) out.push(svg('rect', { class: 'sprocket', x, y, width: 7, height: 5 }));
  return out;
};

/** Arc from an earlier frame to the frame that asked again for its lines. */
const threadPath = (x1, x2) => {
  const lift = Math.min(THREAD_H - 6, 8 + Math.abs(x2 - x1) / 8);
  const y = THREAD_H;
  return `M ${x1.toFixed(1)} ${y} Q ${((x1 + x2) / 2).toFixed(1)} ${(y - lift * 2).toFixed(1)} ${x2.toFixed(1)} ${y}`;
};

/**
 * Builds the strip SVG and returns handles for the step and selection updates.
 * @param {object} ctx
 */
const drawStrip = (ctx) => {
  const { frames } = ctx;
  const { boxes, tailX, width } = layout(frames, ctx.analysis.time.span.value);
  const indexByLine = new Map(frames.map((f, i) => [f.n, i]));
  const root = svg('svg', {
    class: 'strip-svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`,
    role: 'img', 'aria-label': `Contact strip with ${frames.length} frames, one per call. Use the replay slider below to move through it.`,
  });

  root.append(
    svg('rect', { class: 'rebate', x: 0, y: THREAD_H, width, height: REBATE }),
    svg('rect', { class: 'rebate', x: 0, y: FRAME_Y + FRAME_H, width, height: REBATE }),
    ...sprockets(width, THREAD_H + 3),
    ...sprockets(width, FRAME_Y + FRAME_H + REBATE - 8),
  );

  const threads = [];
  const threadLayer = svg('g', { 'aria-hidden': 'true' });
  frames.forEach((f, i) => {
    if (f.repeat === null || f.repeat.kind !== 'repeat') return;
    for (const n of f.repeat.earlier) {
      const j = indexByLine.get(n);
      if (j === undefined || j === i) continue;
      const path = svg('path', { class: 'thread', d: threadPath(boxes[j].cx, boxes[i].cx) });
      threads.push({ path, i, from: f.n, to: n });
      threadLayer.append(path);
    }
  });

  const frameEls = [];
  const frameLayer = svg('g', {});
  frames.forEach((f, i) => {
    const b = boxes[i];
    const rect = svg('rect', { class: frameClass(f), x: b.x, y: FRAME_Y, width: b.w, height: FRAME_H });
    rect.addEventListener('click', () => ctx.pick(i + 1));
    frameLayer.append(rect);
    if (f.fog) frameLayer.append(svg('rect', { class: 'frame-fog', fill: FOG, x: b.x, y: FRAME_Y, width: b.w, height: FRAME_H }));
    if (f.blocked) {
      frameLayer.append(
        svg('line', { class: 'frame-cross', x1: b.x, y1: FRAME_Y, x2: b.x + b.w, y2: FRAME_Y + FRAME_H }),
        svg('line', { class: 'frame-cross', x1: b.x + b.w, y1: FRAME_Y, x2: b.x, y2: FRAME_Y + FRAME_H }));
    }
    frameEls.push(rect);
  });

  // Edge codes: call number in the top margin, log line in the bottom margin, where they fit.
  const codes = svg('g', { 'aria-hidden': 'true' });
  let lastCode = -Infinity;
  frames.forEach((f, i) => {
    const b = boxes[i];
    if (!f.cut && b.x - lastCode < CODE_GAP) return;
    lastCode = b.x;
    const cls = f.cut ? 'edge-code edge-code-cut' : 'edge-code';
    codes.append(
      svg('text', { class: cls, x: b.x + 1, y: THREAD_H + REBATE - 5 }, String(f.index)),
      svg('text', { class: cls, x: b.x + 1, y: FRAME_Y + FRAME_H + 13 }, `L${f.n}`));
  });

  // Torn frames: a notch where a broken log line sits between calls.
  const tears = svg('g', { 'aria-hidden': 'true' });
  for (const b of ctx.analysis.totals.broken) {
    const next = frames.findIndex((f) => f.n > b.n);
    const x = next === -1 ? tailX : boxes[next].x;
    tears.append(
      svg('path', { class: 'frame-torn', d: `M ${x - 5} ${FRAME_Y} L ${x} ${FRAME_Y + 14} L ${x + 5} ${FRAME_Y} Z` }),
      svg('path', { class: 'frame-torn', d: `M ${x - 5} ${FRAME_Y + FRAME_H} L ${x} ${FRAME_Y + FRAME_H - 14} L ${x + 5} ${FRAME_Y + FRAME_H} Z` }));
  }

  // Unknown tail: fogged end piece with no width claim.
  const tail = svg('g', { 'aria-hidden': 'true' },
    svg('rect', { class: 'tail', fill: FOG, x: tailX + 2, y: FRAME_Y, width: TAIL_W - 4, height: FRAME_H }),
    svg('text', { class: 'tail-label', x: tailX + 8, y: FRAME_Y + FRAME_H / 2 + 4 }, 'unknown tail'));

  // Cut mark: first source edit attempt, across the whole strip.
  const cutLayer = svg('g', { 'aria-hidden': 'true' });
  const cutIndex = frames.findIndex((f) => f.cut);
  if (cutIndex !== -1) {
    const x = boxes[cutIndex].x;
    const labelX = Math.min(x + 4, width - 150);
    cutLayer.append(
      svg('line', { class: 'cut-mark', x1: x, y1: 2, x2: x, y2: HEIGHT }),
      svg('text', { class: 'cut-label', x: labelX, y: 14 }, `first source edit, call ${frames[cutIndex].index}`));
  }

  const playhead = svg('line', { class: 'playhead', x1: PAD, y1: THREAD_H - 4, x2: PAD, y2: HEIGHT });
  root.append(threadLayer, frameLayer, tears, tail, codes, cutLayer, playhead);
  return { root, boxes, frameEls, threads, playhead };
};

/** Small swatches for the legend, drawn with the same classes as the strip. */
const swatch = (...children) => svg('svg', { width: 20, height: 16, viewBox: '0 0 20 16', 'aria-hidden': 'true' }, ...children);

const legend = () => el('ul', { class: 'legend' },
  el('li', {}, swatch(svg('rect', { class: 'frame frame-request', x: 1, y: 1, width: 18, height: 14 })), 'file request'),
  el('li', {}, swatch(svg('rect', { class: 'frame frame-repeat', x: 1, y: 1, width: 18, height: 14 })), 'repeat request'),
  el('li', {}, swatch(svg('rect', { class: 'frame frame-edit', x: 1, y: 1, width: 18, height: 14 })), 'edit attempt'),
  el('li', {}, swatch(svg('rect', { class: 'frame', x: 1, y: 1, width: 18, height: 14 }),
    svg('rect', { class: 'frame-fog', fill: FOG, x: 1, y: 1, width: 18, height: 14 })), 'fog: effect could be hidden'),
  el('li', {}, swatch(svg('rect', { class: 'frame frame-blocked', x: 1, y: 1, width: 18, height: 14 }),
    svg('line', { class: 'frame-cross', x1: 1, y1: 1, x2: 19, y2: 15 }), svg('line', { class: 'frame-cross', x1: 19, y1: 1, x2: 1, y2: 15 })), 'unexposed: blocked'),
  el('li', {}, swatch(svg('line', { class: 'cut-mark', x1: 10, y1: 0, x2: 10, y2: 16 })), 'cut: first source edit attempt'),
  el('li', {}, swatch(svg('path', { class: 'thread', d: 'M 1 15 Q 10 -5 19 15' })), 'thread: asked again for lines of an earlier frame'),
  el('li', {}, 'Frame width is the time until the next call. Edge codes: call number above, log line (L) below.'));

// ---- live line ----

const times = (c) => (c === 1 ? 'once' : `${c} times`);

/** Highest count among the intervals of `file` that overlap from..to at this step. */
const countAt = (exposures, file, from, to) => {
  const list = exposures.get(file);
  if (list === undefined) return null;
  let best = null;
  for (const iv of list) if (iv.from <= to && from <= iv.to && (best === null || iv.count > best)) best = iv.count;
  return best;
};

const OTHER_ACTIONS = {
  search: 'a search',
  test: 'a test run',
  run: 'a code run',
  vcs: 'a version control call',
  other: 'another kind of call',
  unknown: 'a call with unknown effect',
  request: 'a file request',
  edit: 'an edit attempt',
};

/** What happened at call k, in plain words, from the analysis and the exposures at k. */
const liveText = (ctx, k, exposures) => {
  const total = ctx.frames.length;
  if (k === 0) return { time: '0:00', main: `Before the first call. Press Play to develop all ${total} calls in order.`, raw: '' };
  const entry = ctx.analysis.calls[k - 1];
  const frame = ctx.frames[k - 1];
  const { effect, call } = entry;
  const time = entry.offset === null ? 'time unknown' : formatTime(entry.offset);
  const said = [];
  if (effect.category === 'blocked') {
    said.push('blocked by the recording hook, so it did not run.');
  } else {
    effect.requests.slice(0, 2).forEach((r, i) => {
      const again = entry.marks[i] !== null && entry.marks[i].kind === 'repeat' ? ' again' : '';
      let count = '';
      if (r.kind === 'range') {
        const c = countAt(exposures, r.file, r.from, r.to);
        if (c !== null) count = `, now requested up to ${times(c)}`;
      }
      said.push(`requested ${describeRequest(r)}${again}${count}`);
    });
    if (effect.requests.length > 2) said.push(`and ${effect.requests.length - 2} more requests`);
    for (const e of effect.edits.slice(0, 2)) said.push(`edit attempt on ${e.file === null ? 'an unknown target' : e.file}`);
    if (said.length === 0) said.push(wordFor(OTHER_ACTIONS, effect.category));
    said[said.length - 1] += '.';
  }
  let main = `Call ${k} of ${total}: ${said.join('; ')}`;
  if (frame.cut) main += ' First source edit attempt.';
  if (frame.fog) main += ' The log cannot show everything this call touched.';
  const raw = rawText(call);
  return { time, main, raw: `${call.tool}: ${raw.length > 160 ? `${raw.slice(0, 160)}...` : raw}` };
};

/**
 * The replay section: Play button, live line, contact strip, playhead slider, legend.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function replay(ctx) {
  const total = ctx.frames.length;
  const reduced = ctx.reduced();
  let timer = null;

  const playLabel = el('span', {}, reduced ? 'Next call' : 'Play');
  const play = el('button', { class: 'button button-primary play', type: 'button', 'aria-controls': 'scrub' },
    el('span', { class: 'play-icon', 'aria-hidden': 'true' }), playLabel);
  const liveTime = el('span', { class: 'live-time' });
  const liveMain = el('span', {});
  const liveRaw = el('p', { class: 'live-cmd' });
  const live = el('div', { class: 'live', 'aria-live': 'polite' }, el('p', { class: 'live-main' }, liveTime, ' ', liveMain), liveRaw);

  const scrub = el('input', {
    class: 'scrub', id: 'scrub', type: 'range', min: 0, max: total, step: 1, value: ctx.step,
    'aria-label': 'Replay position, one call per step',
  });

  const strip = drawStrip(ctx);
  const box = el('div', { class: 'strip-box' }, strip.root);

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    play.classList.remove('is-playing');
    playLabel.textContent = 'Play';
    live.setAttribute('aria-live', 'polite');
  };

  const start = () => {
    if (ctx.reduced()) {
      ctx.setStep(ctx.step >= total ? 0 : ctx.step + 1, { source: 'user' });
      return;
    }
    if (ctx.step >= total) ctx.setStep(0, { source: 'play' });
    play.classList.add('is-playing');
    playLabel.textContent = 'Pause';
    live.setAttribute('aria-live', 'off');
    timer = setInterval(() => {
      ctx.setStep(ctx.step + 1, { source: 'play' });
      if (ctx.step >= total) stop();
    }, STEP_MS);
  };

  const toggle = () => (timer === null ? start() : stop());
  ctx.pick = (k) => {
    stop();
    ctx.setStep(k, { source: 'user' });
  };

  play.addEventListener('click', toggle);
  scrub.addEventListener('input', () => {
    stop();
    ctx.setStep(Number(scrub.value), { source: 'user' });
  });
  scrub.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      toggle();
    }
  });

  const keepInView = (x) => {
    const left = box.scrollLeft;
    const w = box.clientWidth;
    if (x < left + 24 || x > left + w - 48) box.scrollLeft = Math.max(0, x - w / 3);
  };

  let current = null;
  ctx.onStep((k, exposures, opts) => {
    if (Number(scrub.value) !== k) scrub.value = String(k);
    const t = liveText(ctx, k, exposures);
    liveTime.textContent = t.time;
    liveMain.textContent = t.main;
    liveRaw.textContent = t.raw;
    scrub.setAttribute('aria-valuetext', k === 0 ? 'Before the first call' : `Call ${k} of ${total}, at ${t.time}`);
    strip.frameEls.forEach((rect, i) => rect.classList.toggle('frame-dark', i >= k));
    for (const th of strip.threads) th.path.classList.toggle('thread-off', th.i >= k);
    if (current !== null) current.classList.remove('frame-current');
    current = k > 0 ? strip.frameEls[k - 1] : null;
    if (current !== null) current.classList.add('frame-current');
    const x = k > 0 ? strip.boxes[k - 1].cx : PAD;
    strip.playhead.setAttribute('x1', String(x));
    strip.playhead.setAttribute('x2', String(x));
    if (opts.source !== 'init') keepInView(x);
    if (opts.source === 'user' && k > 0) ctx.select({ kind: 'call', index: k }, { reveal: false, origin: null });
  });

  ctx.onSelect((sel) => {
    let lit = new Set();
    if (sel.kind === 'interval') lit = new Set(sel.lines);
    else if (sel.kind === 'traced') lit = new Set(sel.traced.lines);
    else if (sel.kind === 'call') lit = new Set([ctx.frames[sel.index - 1].n]);
    ctx.frames.forEach((f, i) => strip.frameEls[i].classList.toggle('frame-lit', lit.has(f.n)));
    for (const th of strip.threads) th.path.classList.toggle('thread-lit', sel.kind === 'interval' && lit.has(th.from) && lit.has(th.to));
  });

  const head = el('h2', { class: 'section-head', id: 'replay-head' }, 'Replay');
  const note = el('p', { class: 'section-note' },
    'Each frame is one call. Play develops the plates below in recorded order; requested lines appear and grow brighter each time they are requested. Arrow keys on the slider step one call, Home and End jump to the ends, Space plays and pauses.');
  ctx.onDispose(stop);
  return el('section', { class: 'replay', 'aria-labelledby': 'replay-head' },
    head, note, el('div', { class: 'replay-bar' }, play, live), box, scrub, legend());
}
