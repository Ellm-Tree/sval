/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What the element picker offers for the element a person pointed at: its
 * name, the selector of a hiding rule, the depth stops, the media source of
 * the download it could stop, and whether it can be pointed at (element
 * picker spec §3).
 *
 * `pointable` takes the rect it is judged by, so a test document without
 * layout can supply sizes.
 */

import { usableSelector } from "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs";

const NAMES = {
  img: "Image",
  picture: "Image",
  a: "Link",
  iframe: "Frame",
  video: "Video",
  audio: "Audio",
  aside: "Sidebar",
  nav: "Navigation",
  header: "Header",
  footer: "Footer",
  section: "Section",
  article: "Section",
  button: "Button",
  dialog: "Dialog",
};

const MIN_SIDE = 8;
const MAX_STOPS = 6;
const MAX_VALUE_LENGTH = 40;
const DOCUMENT_FRAGMENT_NODE = 11;

// Attributes that describe a role, a size or a state shared by unrelated
// elements, or that carry a URL or an identity of their own, so a selector
// built on them would hide the wrong things or nothing.
const NOT_IDENTIFYING = new Set([
  "class",
  "id",
  "style",
  "role",
  "tabindex",
  "type",
  "width",
  "height",
  "href",
  "src",
  "srcset",
  "alt",
  "title",
  "value",
  "content",
  "xmlns",
]);

/**
 * The name the label and the slider show for an element.
 *
 * @param {Element} el
 * @returns {string}
 */
export function nameOf(el) {
  if (el.getAttribute("role") === "dialog") {
    return "Dialog";
  }
  return Object.hasOwn(NAMES, el.localName) ? NAMES[el.localName] : "Box";
}

function classSelector(el) {
  return [...el.classList].map(name => `.${CSS.escape(name)}`).join("");
}

function quoted(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\a ")}"`;
}

// Data attributes come first because pages mark what they are for there. An
// event handler attribute is one the element has a property for, such as
// `onclick`; a page's own name that starts with "on" can identify it.
function identifyingAttributes(el) {
  let names = el
    .getAttributeNames()
    .filter(
      name =>
        !NOT_IDENTIFYING.has(name) &&
        !(name.startsWith("on") && name in el) &&
        !name.startsWith("aria-")
    );
  return [
    ...names.filter(name => name.startsWith("data-")),
    ...names.filter(name => !name.startsWith("data-")),
  ];
}

// Whether the page-rules child accepts the selector and it matches `el`.
function usable(el, selector) {
  return usableSelector(el.ownerDocument, selector) && el.matches(selector);
}

function countOf(root, selector) {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return Infinity;
  }
}

function attributeSelector(el) {
  let root = el.getRootNode();
  let tag = CSS.escape(el.localName);
  for (let name of identifyingAttributes(el)) {
    let bare = `${tag}[${CSS.escape(name)}]`;
    if (!usable(el, bare)) {
      continue;
    }
    let value = el.getAttribute(name);
    if (!value || value.length > MAX_VALUE_LENGTH) {
      return bare;
    }
    let withValue = `${tag}[${CSS.escape(name)}=${quoted(value)}]`;
    if (!usable(el, withValue)) {
      return bare;
    }
    return countOf(root, bare) > countOf(root, withValue) ? withValue : bare;
  }
  return null;
}

function anchorSelector(el) {
  for (let candidate of [
    el.classList.length ? classSelector(el) : null,
    el.id ? `#${CSS.escape(el.id)}` : null,
  ]) {
    if (candidate && usableSelector(el.ownerDocument, candidate)) {
      return candidate;
    }
  }
  return null;
}

function positionSelector(el) {
  let index = 1;
  for (let node = el.previousElementSibling; node; ) {
    if (node.localName === el.localName) {
      index++;
    }
    node = node.previousElementSibling;
  }
  return `${CSS.escape(el.localName)}:nth-of-type(${index})`;
}

// Walks up from the element to the nearest ancestor that has a class or an
// id, or to the body, and counts each level in between. The walk ends at a
// shadow root, whose selectors cannot reach past it.
function pathSelector(el) {
  let parts = [];
  for (let node = el; node; node = node.parentElement) {
    let anchor = node === el ? null : anchorSelector(node);
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    if (node !== el && node.localName === "body") {
      parts.unshift("body");
      break;
    }
    parts.unshift(positionSelector(node));
  }
  return parts.join(" > ");
}

/**
 * The selector of the rule that hides this element, built from what the page
 * has on it, in this order: its class names as they stand, its id, a short
 * attribute under its tag, and last a path of `tag:nth-of-type` under the
 * nearest ancestor with a class or an id. A strategy whose result the
 * page-rules child would refuse is skipped. The result matches `el`.
 *
 * @param {Element} el
 * @returns {string}
 */
export function selectorFor(el) {
  let strategies = [
    () => (el.classList.length ? classSelector(el) : null),
    () => (el.id ? `#${CSS.escape(el.id)}` : null),
    () => attributeSelector(el),
  ];
  for (let strategy of strategies) {
    let selector = strategy();
    if (selector && usable(el, selector)) {
      return selector;
    }
  }
  return pathSelector(el);
}

function isRoot(el) {
  return el.localName === "html" || el.localName === "body";
}

/**
 * The depth stops: the element, then its ancestors, nearest first. They end
 * before `body`, and hold at most six.
 *
 * @param {Element} el
 * @returns {Element[]}
 */
export function stops(el) {
  if (isRoot(el)) {
    return [];
  }
  let result = [el];
  for (
    let node = el.parentElement;
    node && result.length < MAX_STOPS && !isRoot(node);
    node = node.parentElement
  ) {
    result.push(node);
  }
  return result;
}

function httpUrl(value) {
  if (!value) {
    return null;
  }
  try {
    let url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The address a download of this element comes from, for the picker to offer
 * to stop it, or null when it has none a network rule could name.
 *
 * @param {Element} el
 * @returns {?string}
 */
export function sourceOf(el) {
  switch (el.localName) {
    case "picture": {
      let img = el.querySelector("img");
      return img ? sourceOf(img) : null;
    }
    case "img":
      return httpUrl(el.currentSrc || el.src);
    case "iframe":
      return httpUrl(el.src);
    case "video":
    case "audio":
      return httpUrl(
        el.currentSrc || el.src || el.querySelector("source")?.src
      );
    default:
      return null;
  }
}

/**
 * Whether the picker and the snip let the person point at this element.
 * Neither takes `html` or `body`.
 *
 * @param {Element} el
 * @param {{width: number, height: number}} rect
 * @returns {boolean}
 */
export function pointable(el, rect) {
  return !isRoot(el) && rect.width >= MIN_SIDE && rect.height >= MIN_SIDE;
}

/**
 * The outermost shadow host above an element, or the element itself when it
 * is in the page's own tree. A selector built from the page's tree matches
 * nothing across a shadow boundary, so the host is what such a rule names.
 *
 * @param {Element} el
 * @returns {Element}
 */
export function hostOf(el) {
  let node = el;
  for (
    let root = node.getRootNode();
    root.nodeType === DOCUMENT_FRAGMENT_NODE && root.host;
    root = node.getRootNode()
  ) {
    node = root.host;
  }
  return node;
}
