// DOM helpers. Text reaches the page only through text nodes. Attribute names come
// from the fixed allowlists below, never from log content.

const HTML_ATTRS = new Set([
  'class', 'id', 'type', 'for', 'min', 'max', 'step', 'value', 'role', 'tabindex', 'scope', 'colspan',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-valuetext', 'aria-pressed', 'aria-selected',
  'aria-expanded', 'aria-controls', 'aria-live', 'aria-hidden', 'aria-current', 'open', 'hidden', 'disabled', 'data-label',
]);

const SVG_ATTRS = new Set([
  'class', 'id', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'viewBox',
  'preserveAspectRatio', 'fill', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'opacity', 'filter', 'mask', 'clip-path',
  'transform', 'role', 'aria-label', 'aria-hidden', 'focusable', 'text-anchor', 'dominant-baseline',
]);

const BOOLEAN_ATTRS = new Set(['open', 'hidden', 'disabled']);

/**
 * The SVG namespace, taken from the parsed <svg id="defs"> in index.html so that
 * no URL string appears in site code.
 */
const svgNamespace = () => {
  const defs = document.getElementById('defs');
  if (defs === null) throw new Error('index.html is missing <svg id="defs">');
  return defs.namespaceURI;
};

/** @param {Element} node @param {Set<string>} allowed @param {Record<string, unknown>} attrs */
const setAttrs = (node, allowed, attrs) => {
  for (const [name, value] of Object.entries(attrs)) {
    if (!allowed.has(name)) throw new Error(`attribute not allowed: ${name}`);
    if (value === null || value === undefined || value === false) continue;
    if (BOOLEAN_ATTRS.has(name)) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
};

/** @param {Node} node @param {unknown[]} children */
const append = (node, children) => {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
};

/**
 * Creates an HTML element. Strings and numbers become text nodes.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, HTML_ATTRS, attrs);
  append(node, children);
  return node;
}

/**
 * Creates an SVG element in the SVG namespace.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNamespace(), tag);
  setAttrs(node, SVG_ATTRS, attrs);
  append(node, children);
  return /** @type {SVGElement} */ (node);
}

/**
 * Sets a numeric CSS custom property. Only `--name` with a finite number is accepted.
 * @param {Element} node
 * @param {string} name
 * @param {number} value
 */
export function setVar(node, name, value) {
  if (!/^--[a-z][a-z0-9-]*$/.test(name)) throw new Error(`bad custom property name: ${name}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`bad custom property value for ${name}`);
  /** @type {HTMLElement} */ (node).style.setProperty(name, String(Math.round(value * 1000) / 1000));
}

/**
 * Removes all children, then appends the given ones.
 * @param {Element} node
 * @param {...unknown} children
 */
export function replace(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

/** Number with thousands separators, for counts of log lines. */
export function grouped(n) {
  return n.toLocaleString('en-US');
}
