// The replay stage: spirit photograph, live line, Play, compact contact strip and playhead,
// sized to fit one viewport. Frames: one per call, edge codes, fog, unexposed frames,
// torn frames, cut mark, ectoplasm threads and the unknown tail.

import { formatTime } from '../core/findings.js';
import { el, svg } from './dom.js';
import { describeRequest, rawText, wordFor } from './notes.js';
import { apparition } from './apparition.js';

const THREAD_H = 28;
const REBATE = 16;
const FRAME_H = 40;
const HEIGHT = THREAD_H + REBATE + FRAME_H + REBATE;
const FRAME_Y = THREAD_H + REBATE;
const PAD = 12;
const MIN_W = 4;
const UNKNOWN_W = 12;
const TAIL_W = 104;
const CODE_GAP = 34;
const STEP_MS = 120;
/** Containers at least this wide put the photograph and the controls side by side. */
export const WIDE = 1040;
/** The hatch pattern defined in index.html. */
const FOG = 'url(#fog)';

/** Pixels per second: the whole session spans about 1,600px, within 1.2 to 8 px/s. */
const scaleFor = (span) => (span === null || span <= 0 ? 4 : Math.min(8, Math.max(1.2, 1600 / span)));

/** Frame positions from the time until the next call. */
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

/** Arc from an earlier frame to the frame that asked again for its lines. */
const threadPath = (x1, x2) => {
  const lift = Math.min(THREAD_H - 4, 6 + Math.abs(x2 - x1) / 10);
  return `M ${x1.toFixed(1)} ${THREAD_H} Q ${((x1 + x2) / 2).toFixed(1)} ${(THREAD_H - lift * 2).toFixed(1)} ${x2.toFixed(1)} ${THREAD_H}`;
};

/** Builds the strip SVG and returns handles for step and selection updates. */
const drawStrip = (ctx) => {
  const { frames } = ctx;
  const { boxes, tailX, width } = layout(frames, ctx.analysis.time.span.value);
  const indexByLine = new Map(frames.map((f, i) => [f.n, i]));
  const root = svg('svg', {
    class: 'strip-svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`,
    role: 'img', 'aria-label': `Contact strip with ${frames.length} frames, one per call. Use the replay slider to move through it.`,
  });
  root.append(
    svg('rect', { class: 'rebate', x: 0, y: THREAD_H, width, height: REBATE }),
    svg('rect', { class: 'rebate', x: 0, y: FRAME_Y + FRAME_H, width, height: REBATE }));

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
      svg('text', { class: cls, x: b.x + 1, y: THREAD_H + 12 }, String(f.index)),
      svg('text', { class: cls, x: b.x + 1, y: FRAME_Y + FRAME_H + 12 }, `L${f.n}`));
  });

  // Torn frames: a notch where a broken log line sits between calls.
  const tears = svg('g', { 'aria-hidden': 'true' });
  for (const b of ctx.analysis.totals.broken) {
    const next = frames.findIndex((f) => f.n > b.n);
    const x = next === -1 ? tailX : boxes[next].x;
    tears.append(
      svg('path', { class: 'frame-torn', d: `M ${x - 5} ${FRAME_Y} L ${x} ${FRAME_Y + 12} L ${x + 5} ${FRAME_Y} Z` }),
      svg('path', { class: 'frame-torn', d: `M ${x - 5} ${FRAME_Y + FRAME_H} L ${x} ${FRAME_Y + FRAME_H - 12} L ${x + 5} ${FRAME_Y + FRAME_H} Z` }));
  }

  const tail = svg('g', { 'aria-hidden': 'true' },
    svg('rect', { class: 'tail', fill: FOG, x: tailX + 2, y: FRAME_Y, width: TAIL_W - 4, height: FRAME_H }),
    svg('text', { class: 'tail-label', x: tailX + 8, y: FRAME_Y + FRAME_H / 2 + 4 }, 'unknown tail'));

  // Cut mark: the first source edit attempt, across the whole strip.
  const cutLayer = svg('g', { 'aria-hidden': 'true' });
  const cutIndex = frames.findIndex((f) => f.cut);
  if (cutIndex !== -1) {
    const x = boxes[cutIndex].x;
    const label = `first source edit, call ${frames[cutIndex].index}`;
    const right = x + 8 + label.length * 7.3 < width;
    cutLayer.append(
      svg('line', { class: 'cut-mark', x1: x, y1: 0, x2: x, y2: HEIGHT }),
      svg('text', { class: 'cut-label', x: right ? x + 4 : x - 4, y: 12, 'text-anchor': right ? 'start' : 'end' }, label));
  }

  const playhead = svg('line', { class: 'playhead', x1: PAD, y1: 0, x2: PAD, y2: HEIGHT });
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
  el('li', {}, swatch(svg('path', { class: 'thread', d: 'M 1 15 Q 10 -5 19 15' })), 'thread: asked again for lines of an earlier frame'));

// ---- live line ----

const timesWord = (c) => (c === 1 ? 'once' : `${c} times`);

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
  if (k === 0) return { head: `0:00, before call 1 of ${total}`, main: 'Nothing exposed yet.', raw: '' };
  const entry = ctx.analysis.calls[k - 1];
  const frame = ctx.frames[k - 1];
  const { effect, call } = entry;
  const time = entry.offset === null ? 'time unknown' : formatTime(entry.offset);
  const said = [];
  if (effect.category === 'blocked') {
    said.push('blocked by the recording hook, so it did not run');
  } else {
    effect.requests.slice(0, 2).forEach((r, i) => {
      const again = entry.marks[i] !== null && entry.marks[i].kind === 'repeat' ? ' again' : '';
      let count = '';
      if (r.kind === 'range') {
        const c = countAt(exposures, r.file, r.from, r.to);
        const lower = ctx.analysis.calls.slice(0, k).some((e) => e.effect.requests.some((q) => q.file === r.file && q.kind !== 'range'));
        if (c !== null) count = `, now ${lower ? 'at least ' : ''}${timesWord(c)}`;
      }
      said.push(`requested ${describeRequest(r)}${again}${count}`);
    });
    if (effect.requests.length > 2) said.push(`and ${effect.requests.length - 2} more requests`);
    for (const e of effect.edits.slice(0, 2)) said.push(`edit attempt on ${e.file === null ? 'an unknown target' : e.file}`);
    if (said.length === 0) said.push(wordFor(OTHER_ACTIONS, effect.category));
  }
  let main = `${said.join('; ')}.`;
  main = main[0].toUpperCase() + main.slice(1);
  if (frame.cut) main = `First source edit attempt. ${main}`;
  if (frame.fog) main += ' Some effects unknown.';
  const raw = rawText(call);
  return { head: `${time}, call ${k} of ${total}`, main, raw: `${call.tool}: ${raw.length > 140 ? `${raw.slice(0, 140)}...` : raw}` };
};

// ---- stage ----

/**
 * The replay stage. Photograph, controls and strip fit one viewport.
 * @param {object} ctx
 * @param {number} width available px for the stage
 * @returns {HTMLElement}
 */
export function stage(ctx, width) {
  const total = ctx.frames.length;
  const a = ctx.analysis;
  const wide = width >= WIDE;
  let timer = null;

  const top = a.top.value;
  const photo = apparition(a, {
    width: wide ? 560 : width,
    name: ctx.name,
    onPick: top === null ? null : () => {
      const row = ctx.repeated.find((r) => r.file === top.file && r.from === top.from);
      ctx.select(row !== undefined ? { kind: 'interval', ...row } : { kind: 'interval', ...top, lines: a.top.lines }, { reveal: true, origin: null });
    },
  });

  const playLabel = el('span', {}, 'Play');
  const play = el('button', { class: 'button button-primary play', type: 'button', 'aria-controls': 'scrub' },
    el('span', { class: 'play-icon', 'aria-hidden': 'true' }), playLabel);
  const liveHead = el('p', { class: 'live-head' });
  const liveMain = el('p', { class: 'live-main' });
  const liveRaw = el('p', { class: 'live-cmd' });
  const live = el('div', { class: 'live', 'aria-live': 'polite' }, liveHead, liveMain, liveRaw);
  const hint = el('p', { class: 'stage-hint' });

  const scrub = el('input', {
    class: 'scrub', id: 'scrub', type: 'range', min: 0, max: total, step: 1, value: ctx.step,
    'aria-label': 'Replay position, one call per step',
  });
  const strip = drawStrip(ctx);
  const box = el('div', { class: 'strip-box' }, strip.root);

  const section = el('section', { class: wide ? 'stage stage-wide' : 'stage', 'aria-labelledby': 'replay-head' });

  const label = () => {
    if (timer !== null) {
      playLabel.textContent = 'Pause';
      hint.textContent = 'Each request of the brightest lines adds one exposure.';
      return;
    }
    const atEnd = ctx.step >= total;
    if (ctx.reduced()) playLabel.textContent = atEnd ? 'Start again' : 'Next call';
    else playLabel.textContent = atEnd ? 'Replay from call 1' : 'Play';
    if (atEnd) hint.textContent = 'Fully developed. Replay to watch the figure form.';
    else if (ctx.step === 0) hint.textContent = 'Each request of the brightest lines adds one exposure.';
    else hint.textContent = 'Paused. Arrow keys on the slider step one call.';
  };

  /** Keeps the playhead inside the visible part of the strip. */
  const follow = (x, always) => {
    const w = box.clientWidth;
    if (w === 0) return;
    const left = box.scrollLeft;
    if (!always && x >= left + w * 0.1 && x <= left + w * 0.85) return;
    box.scrollLeft = Math.max(0, Math.min(box.scrollWidth - w, x - w * 0.6));
  };

  /** Brings the whole stage into view when it is not. */
  const showStage = () => {
    const r = section.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) section.scrollIntoView({ block: 'start', behavior: ctx.reduced() ? 'auto' : 'smooth' });
  };

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    play.classList.remove('is-playing');
    live.setAttribute('aria-live', 'polite');
    label();
  };

  const start = () => {
    if (ctx.reduced()) {
      ctx.setStep(ctx.step >= total ? 0 : ctx.step + 1, { source: 'user' });
      return;
    }
    showStage();
    if (ctx.step >= total) ctx.setStep(0, { source: 'play' });
    play.classList.add('is-playing');
    live.setAttribute('aria-live', 'off');
    timer = setInterval(() => {
      ctx.setStep(ctx.step + 1, { source: 'play' });
      if (ctx.step >= total) stop();
    }, STEP_MS);
    label();
  };

  const toggle = () => (timer === null ? start() : stop());
  ctx.pick = (k) => {
    stop();
    ctx.setStep(k, { source: 'user' });
  };
  ctx.playFromStart = () => {
    stop();
    showStage();
    ctx.setStep(0, { source: 'user' });
    if (ctx.reduced()) scrub.focus({ preventScroll: true });
    else start();
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

  const file = top === null ? null : top.file;
  let current = null;
  ctx.onStep((k, exposures, opts) => {
    if (Number(scrub.value) !== k) scrub.value = String(k);
    const t = liveText(ctx, k, exposures);
    liveHead.textContent = t.head;
    liveMain.textContent = t.main;
    liveRaw.textContent = t.raw;
    scrub.setAttribute('aria-valuetext', k === 0 ? 'Before the first call' : t.head);
    if (photo !== null) photo.update(k, exposures.get(file) ?? []);
    strip.frameEls.forEach((rect, i) => rect.classList.toggle('frame-dark', i >= k));
    for (const th of strip.threads) th.path.classList.toggle('thread-off', th.i >= k);
    if (current !== null) current.classList.remove('frame-current');
    current = k > 0 ? strip.frameEls[k - 1] : null;
    if (current !== null) current.classList.add('frame-current');
    const x = k > 0 ? strip.boxes[k - 1].cx : PAD;
    strip.playhead.setAttribute('x1', String(x));
    strip.playhead.setAttribute('x2', String(x));
    if (opts.source === 'init') window.requestAnimationFrame(() => follow(x, true));
    else follow(x, opts.source === 'play');
    if (timer === null) label();
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

  const photoBox = el('div', { class: 'stage-photo' },
    photo !== null ? photo.node : el('p', { class: 'section-note' }, 'No line range was requested, so no figure formed. The strip below still replays every call.'));
  const how = el('details', { class: 'how' },
    el('summary', {}, 'How to read the replay'),
    el('div', { class: 'how-body' },
      el('p', {}, 'The photograph shows the most requested lines of the session. Each request of those lines adds one offset exposure to the figure, so it is invisible before the first request and denser with each one. The column on its left is the file, lines from top to bottom; the bright band is where the figure comes from.'),
      el('p', {}, 'Each frame of the strip is one call. Frame width is the time until the next call. Edge codes: call number above, log line (L) below. Arrow keys on the slider step one call, Home and End jump to the ends, Space plays and pauses.'),
      legend()));
  section.append(
    el('h2', { class: 'section-head stage-title', id: 'replay-head' }, 'Replay'),
    el('div', { class: 'stage-grid' }, photoBox,
      el('div', { class: 'stage-side' }, el('div', { class: 'stage-controls' }, play), live, hint)),
    box, scrub, how);
  ctx.onDispose(stop);
  return section;
}
