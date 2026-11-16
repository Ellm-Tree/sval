/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * An agent's view of a page (agent-control spec §4.2): an outline of what a
 * person would see, one line per element worth naming, each with a ref the
 * agent can hand back to act on that element.
 *
 *     heading "Sign in" [e1] level=1
 *     form [e2]
 *       textbox "Email" [e3]
 *       textbox "Password" [e4] value="••••"
 *     text "Plain words here."
 *
 * Roles and names come from a walk of the DOM with heuristic rules, without
 * the accessibility service: that service starts in every content process it
 * is asked of and stays there for the life of the process. A password field's
 * value is never read into the outline.
 *
 * The walk follows the flattened tree, so content in shadow roots is read
 * where it renders. Frames are not entered: each has a window global of its
 * own.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const MAX_LINES = 2000;
/**
 * The most refs one snapshot can hand out: one per line, and one more for an
 * element whose line did not fit. The parent reserves this many numbers for
 * each snapshot, so refs never repeat within a tab.
 */
export const MAX_NEW_REFS = MAX_LINES + 1;
/**
 * How many characters of a page's source one `get_page_source` reply holds
 * unless the agent asks for more, and the most it may ask for. A reply must
 * fit the result limit of an MCP client, which a whole page's markup can
 * overflow.
 */
export const SOURCE_CHUNK_DEFAULT = 20_000;
export const SOURCE_CHUNK_MAX = 100_000;
/** Elements one snapshot may visit, names included, before it stops. */
const MAX_VISITS = 50_000;
/** How long one snapshot may run before it stops. */
const MAX_MS = 2000;
/** How deep in the tree a snapshot reads. */
const MAX_DEPTH = 512;
const MAX_CHARS = 200_000;
const MAX_TEXT = 200;
const MAX_NAME = 100;
const MAX_OUTLINE_VALUE = 200;

const VISIBILITY = { checkOpacity: true, checkVisibilityCSS: true };

/** Never read, nor anything inside them. */
const SKIPPED = new Set(["script", "style", "noscript", "template"]);

/** `<input>` types an agent types into. */
const TEXT_INPUTS = new Set([
  "",
  "text",
  "email",
  "password",
  "search",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);

/**
 * What an element is listed as when it has no role of its own but a person
 * could still use it: the keyboard can focus it (a `tabindex` of 0 or more),
 * or the pointer says it is clickable. A page's script is what makes such an
 * element do anything, so its role cannot be known; its name is its text.
 */
const CLICKABLE = "clickable";

/**
 * Roles of elements that are clicked as a whole. Nothing inside one is
 * listed as `CLICKABLE`: a click on the inside is a click on it, and the
 * pointer cursor every child of a link inherits would otherwise list each
 * of them.
 */
const CLICK_TARGETS = new Set([
  CLICKABLE,
  "button",
  "checkbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
]);

/**
 * Roles whose name is the text inside them (WAI-ARIA "name from content"),
 * so that text is their name and not repeated as text lines of its own.
 */
const NAMED_FROM_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  CLICKABLE,
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

/** Explicit roles that say the element is not worth naming. */
const NO_ROLE = new Set(["none", "presentation", "generic"]);

const FORM_CONTROLS = new Set(["input", "select", "textarea", "button"]);

/** `autocomplete` tokens that say a field holds a secret. */
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

export const MASK = "••••";

/**
 * Whether `el` holds a secret whose value an agent must never read: a
 * password field, one that has ever been one (a "show password" toggle turns
 * it into a text field), one whose `autocomplete` names a password or a
 * one-time code, or one the page draws as dots with `-webkit-text-security`.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isSecret(el) {
  const input = el.localName === "input";
  if (!input && el.localName !== "textarea") {
    return false;
  }
  if (input && (el.type === "password" || el.hasBeenTypePassword)) {
    return true;
  }
  const tokens = (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  if (tokens.some(token => SECRET_AUTOCOMPLETE.has(token))) {
    return true;
  }
  const security = el.documentGlobal
    ?.getComputedStyle(el)
    ?.getPropertyValue("-webkit-text-security");
  return !!security && security !== "none";
}

/**
 * What a snapshot may still spend: a count of elements visited and a
 * deadline. Running out of either truncates the outline.
 */
class Budget {
  #left = MAX_VISITS;
  #deadline;
  exhausted = false;

  /** @param {number} ms How long the snapshot may run. */
  constructor(ms) {
    this.#deadline = ChromeUtils.now() + ms;
  }

  /** @returns {boolean} whether one more element may be visited. */
  spend() {
    if (this.exhausted) {
      return false;
    }
    this.#left--;
    if (
      this.#left < 0 ||
      (this.#left % 256 === 0 && ChromeUtils.now() > this.#deadline)
    ) {
      this.exhausted = true;
      return false;
    }
    return true;
  }
}

/**
 * The refs one document's snapshots have handed out. A ref is `"eN"` from a
 * counter that only grows, and an element keeps the ref it was first given,
 * so taking a second snapshot does not change the refs in the first.
 */
export class RefTable {
  /** @type {Map<string, WeakRef<Element>>} */
  #byRef = new Map();
  /** @type {WeakMap<Element, string>} */
  #byElement = new WeakMap();
  #next = 1;

  /** @returns {number} the number the next new ref will get. */
  get next() {
    return this.#next;
  }

  /**
   * Numbers new refs from `first` on, unless this table is already past it.
   *
   * @param {number} first
   */
  startAt(first) {
    this.#next = Math.max(this.#next, first);
  }

  /**
   * @param {Element} element
   * @returns {string}
   */
  refFor(element) {
    let ref = this.#byElement.get(element);
    if (!ref) {
      ref = `e${this.#next++}`;
      this.#byElement.set(element, ref);
      this.#byRef.set(ref, new WeakRef(element));
    }
    return ref;
  }

  /**
   * The element `ref` names, while it is still in `document`.
   *
   * @param {Document} document
   * @param {unknown} ref
   * @returns {Element|null} null for a ref this table never gave, and for one
   *   whose element has been collected or taken out of the document.
   */
  resolve(document, ref) {
    if (typeof ref !== "string") {
      return null;
    }
    const element = this.#byRef.get(ref)?.deref();
    if (!element?.isConnected || element.ownerDocument !== document) {
      return null;
    }
    return element;
  }
}

/**
 * Page text made safe to quote on one line: control characters and every
 * kind of line break become spaces, and runs of whitespace one space. Every
 * piece of page text is then written by `quote`, so nothing the page
 * says can end a line, close a quote or pass for a ref.
 *
 * @param {string} text
 * @returns {string}
 */
function collapse(text) {
  return (
    text
      // Matching control characters is the point here.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * `text` as a JSON string that stays on one line. `JSON.stringify` escapes
 * the C0 controls but leaves U+0085, U+2028 and U+2029 as they are, and some
 * readers end a line at each of them, so a page could start a forged line
 * with one in a field's value.
 *
 * @param {string} text
 * @returns {string}
 */
function quote(text) {
  return JSON.stringify(text).replace(
    /[\u0085\u2028\u2029]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string} `text`, cut to `max` characters with an ellipsis.
 */
export function cap(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * The nodes that render as `node`'s children: a shadow root's in place of
 * the host's own, and a slot's assigned nodes in place of its fallback.
 *
 * A browser's own widget shadow, such as the one `<select>` and `<video>`
 * draw themselves with, is passed over for the element's own children, which
 * are what the page wrote.
 *
 * @param {Node} node
 * @returns {Iterable<Node>}
 */
function childrenOf(node) {
  if (node.nodeType === ELEMENT_NODE) {
    const shadow = node.openOrClosedShadowRoot;
    if (shadow && !shadow.isUAWidget()) {
      return shadow.childNodes;
    }
    if (node.localName === "slot") {
      const assigned = node.assignedNodes();
      if (assigned.length) {
        return assigned;
      }
    }
  }
  return node.childNodes;
}

/**
 * The text inside `root` as a person reads it out: script and style skipped,
 * an image's alt in its place, and `skip`'s subtree left out.
 *
 * @param {Node} root
 * @param {Budget} budget
 * @param {Element|null} [skip]
 * @returns {string} collapsed, at most `MAX_NAME` characters.
 */
function textIn(root, budget, skip = null) {
  const parts = [];
  let length = 0;
  const visit = (node, level) => {
    if (length > MAX_NAME || level > MAX_DEPTH) {
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.data);
      length += node.data.length;
      return;
    }
    if (node.nodeType !== ELEMENT_NODE || !budget.spend()) {
      return;
    }
    if (node === skip || SKIPPED.has(node.localName)) {
      return;
    }
    if (node.localName === "img" || node.localName === "area") {
      const alt = node.getAttribute("alt");
      if (alt) {
        parts.push(` ${alt} `);
        length += alt.length;
      }
      return;
    }
    if (node.localName === "select" || node.localName === "textarea") {
      return;
    }
    for (const child of childrenOf(node)) {
      visit(child, level + 1);
    }
  };
  for (const child of childrenOf(root)) {
    visit(child, 1);
  }
  return cap(collapse(parts.join("")), MAX_NAME);
}

/**
 * @param {Element} el
 * @returns {string|null}
 */
function implicitRole(el) {
  switch (el.localName) {
    case "a":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
    case "summary":
      return "button";
    case "input": {
      const type = el.type;
      if (TEXT_INPUTS.has(type)) {
        return "textbox";
      }
      if (BUTTON_INPUTS.has(type) || type === "file" || type === "color") {
        return "button";
      }
      if (type === "checkbox" || type === "radio") {
        return type;
      }
      if (type === "range") {
        return "slider";
      }
      return null;
    }
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "option":
      return "option";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "img":
      return el.getAttribute("alt") ? "img" : null;
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "form":
      return "form";
    case "table":
      return "table";
    case "li":
      return "listitem";
    case "dialog":
      return "dialog";
  }
  if (
    el.isContentEditable &&
    el.hasAttribute("contenteditable") &&
    !el.parentElement?.isContentEditable
  ) {
    return "textbox";
  }
  return null;
}

/**
 * @param {Element} el
 * @returns {string|null} the role the element is listed under, or null when
 *   it is not worth naming.
 */
function roleOf(el) {
  // A role is printed bare, so only a plain lowercase word is taken from the
  // page; anything else falls back to the element's own role.
  const explicit = el
    .getAttribute("role")
    ?.trim()
    .split(/\s+/)[0]
    .toLowerCase();
  if (explicit && /^[a-z]+$/.test(explicit)) {
    return NO_ROLE.has(explicit) ? null : explicit;
  }
  return implicitRole(el);
}

/**
 * @param {Element} el
 * @param {Budget} budget
 * @returns {string} the text of the elements `aria-labelledby` names.
 */
function labelledByText(el, budget) {
  const ids = el.getAttribute("aria-labelledby")?.trim();
  if (!ids) {
    return "";
  }
  const root = el.getRootNode();
  return collapse(
    ids
      .split(/\s+/)
      .map(id => root.getElementById?.(id))
      .filter(Boolean)
      .map(label => textIn(label, budget, el))
      .join(" ")
  );
}

/**
 * @param {Element} el
 * @param {string} role
 * @param {Budget} budget
 * @returns {string} the element's name, or "" for none.
 */
function nameOf(el, role, budget) {
  const labelledBy = labelledByText(el, budget);
  if (labelledBy) {
    return cap(labelledBy, MAX_NAME);
  }
  const ariaLabel = collapse(el.getAttribute("aria-label") ?? "");
  if (ariaLabel) {
    return cap(ariaLabel, MAX_NAME);
  }
  if (FORM_CONTROLS.has(el.localName)) {
    for (const label of el.labels ?? []) {
      const text = textIn(label, budget, el);
      if (text) {
        return text;
      }
    }
    const placeholder = collapse(el.getAttribute("placeholder") ?? "");
    if (placeholder) {
      return cap(placeholder, MAX_NAME);
    }
    if (el.localName === "input" && BUTTON_INPUTS.has(el.type)) {
      const value = collapse(
        el.type === "image" ? (el.getAttribute("alt") ?? "") : el.value
      );
      if (value) {
        return cap(value, MAX_NAME);
      }
    }
  }
  if (el.localName === "img") {
    return cap(collapse(el.getAttribute("alt") ?? ""), MAX_NAME);
  }
  if (NAMED_FROM_CONTENT.has(role) && el.localName !== "input") {
    const text = textIn(el, budget);
    if (text) {
      return text;
    }
  }
  return cap(collapse(el.getAttribute("title") ?? ""), MAX_NAME);
}

/**
 * @param {Element} el
 * @param {string} role
 * @returns {string|null} the value a person sees in the control, if any. A
 *   secret is never read; a filled one shows as `MASK`.
 */
function controlValue(el, role) {
  if (isSecret(el)) {
    return el.value ? MASK : null;
  }
  if (el.localName === "input") {
    if (role === "textbox" || role === "slider") {
      return el.value || null;
    }
    return null;
  }
  if (el.localName === "textarea") {
    return el.value || null;
  }
  if (el.localName === "select") {
    const selected = el.selectedOptions?.[0];
    return selected ? collapse(selected.label) || null : null;
  }
  return null;
}

/**
 * @param {Element} el
 * @param {string} role
 * @returns {string[]} the line's suffixes after the ref.
 */
function suffixesOf(el, role) {
  const out = [];
  if (role === "heading") {
    const level = /^h([1-6])$/.exec(el.localName)?.[1];
    const aria = parseInt(el.getAttribute("aria-level"), 10);
    if (level || aria > 0) {
      out.push(`level=${level ?? aria}`);
    }
  }
  const isCheckable =
    el.localName === "input" && (el.type === "checkbox" || el.type === "radio");
  if (isCheckable ? el.checked : el.getAttribute("aria-checked") === "true") {
    out.push("[checked]");
  }
  if (
    (FORM_CONTROLS.has(el.localName) && el.matches(":disabled")) ||
    el.getAttribute("aria-disabled") === "true"
  ) {
    out.push("[disabled]");
  }
  const expanded =
    el.getAttribute("aria-expanded") ??
    (el.localName === "summary" && el.parentElement?.localName === "details"
      ? String(el.parentElement.open)
      : null);
  if (expanded === "true" || expanded === "false") {
    out.push(`[expanded=${expanded}]`);
  }
  if (
    el.localName === "option"
      ? el.selected
      : el.getAttribute("aria-selected") === "true"
  ) {
    out.push("[selected]");
  }
  const value = controlValue(el, role);
  if (value !== null) {
    out.push(`value=${quote(cap(value, MAX_OUTLINE_VALUE))}`);
  }
  return out;
}

/** Collects the outline's lines up to its limits. */
class Outline {
  lines = [];
  chars = 0;
  refs = 0;
  truncated = false;
  #text = [];
  #textDepth = 0;

  /**
   * @param {number} depth
   * @param {string} line
   * @returns {boolean} whether the line fit.
   */
  add(depth, line) {
    this.flushText();
    return this.#push(depth, line);
  }

  /**
   * Gathers text read since the last element line into one run.
   *
   * @param {number} depth
   * @param {string} data
   */
  text(depth, data) {
    if (!this.#text.length) {
      this.#textDepth = depth;
    }
    this.#text.push(data);
  }

  flushText() {
    if (!this.#text.length) {
      return;
    }
    const text = collapse(this.#text.join(""));
    this.#text = [];
    if (text) {
      this.#push(this.#textDepth, `text ${quote(cap(text, MAX_TEXT))}`);
    }
  }

  #push(depth, line) {
    if (this.truncated) {
      return false;
    }
    const indented = "  ".repeat(depth) + line;
    if (
      this.lines.length >= MAX_LINES ||
      this.chars + indented.length + 1 > MAX_CHARS
    ) {
      this.truncated = true;
      return false;
    }
    this.lines.push(indented);
    this.chars += indented.length + 1;
    return true;
  }
}

/**
 * @param {Element} el
 * @returns {boolean} whether the page gave `el` a `tabindex` of 0 or more,
 *   which puts it in the keyboard's tab order or at least lets it take focus.
 */
function takesFocus(el) {
  const tabindex = el.getAttribute("tabindex");
  return tabindex !== null && parseInt(tabindex, 10) >= 0;
}

/**
 * @param {Window} win
 * @param {Iterable<DOMRect>} rects
 * @returns {boolean} whether any of `rects` has area inside `win`'s viewport.
 *   A box a scroller of its own clips still counts as inside.
 */
function inViewport(win, rects) {
  for (const r of rects) {
    if (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < win.innerHeight &&
      r.left < win.innerWidth
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Outlines `document` for an agent.
 *
 * @param {Document} document
 * @param {RefTable} refs The document's refs, which this adds to.
 * @param {object} [options]
 * @param {Element} [options.root] Outlines this element and what is inside
 *   it, in place of the page.
 * @param {boolean} [options.viewportOnly] Lists only what shows in the
 *   viewport at its current scroll position.
 * @param {number} [options.maxMs] How long the outline may run. A test sets
 *   it to see the deadline cut an outline short on a page it can build.
 * @returns {{text: string, refs: number, truncated: boolean}} `refs` is how
 *   many elements this outline lists with a ref.
 */
export function snapshotOf(
  document,
  refs,
  { root, viewportOnly, maxMs = MAX_MS } = {}
) {
  const win = document.defaultView;
  const outline = new Outline();
  const budget = new Budget(maxMs);
  let tooDeep = false;

  /**
   * @param {Node} node A text node.
   * @returns {boolean} whether some of its text is in the viewport.
   */
  const textInView = node => {
    if (!viewportOnly) {
      return true;
    }
    if (!node.data.trim() || !budget.spend()) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    return inViewport(win, range.getClientRects());
  };

  /**
   * @param {Node} parent
   * @param {number} depth The indent of the lines its children make.
   * @param {object} context
   * @param {boolean} context.shown Whether `parent` renders its own text.
   * @param {boolean} context.quiet Whether an ancestor has used its text as
   *   its name.
   * @param {boolean} context.inSelect Whether this is inside a `<select>`,
   *   whose options render without boxes of their own.
   * @param {boolean} context.held Whether an ancestor is clicked as a whole
   *   (`CLICK_TARGETS`), so nothing inside it is listed as `CLICKABLE`.
   * @param {boolean} context.pointer Whether `parent` shows the pointer
   *   cursor, which its children inherit.
   * @param {number} level How deep `parent` is in the tree.
   */
  const walk = (parent, depth, context, level) => {
    if (level >= MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    for (const node of childrenOf(parent)) {
      if (outline.truncated) {
        return;
      }
      if (node.nodeType === TEXT_NODE) {
        if (context.shown && !context.quiet && textInView(node)) {
          outline.text(depth, node.data);
        }
      } else if (node.nodeType === ELEMENT_NODE) {
        visit(node, depth, context, level + 1);
      }
    }
  };

  /**
   * @param {Element} el
   * @param {object} context
   * @param {string} display `el`'s computed `display`.
   * @param {string} cursor `el`'s computed `cursor`.
   * @returns {boolean} whether `el`, which has no role, is listed as
   *   `CLICKABLE`: it takes focus, or it is where the pointer cursor starts
   *   and not one of the children that inherit it.
   */
  const isClickable = (el, context, display, cursor) => {
    if (context.held || context.inSelect || display === "contents") {
      return false;
    }
    // A label's click goes to its control, which is listed.
    if (el.localName === "label" && el.control) {
      return false;
    }
    return takesFocus(el) || (cursor === "pointer" && !context.pointer);
  };

  const visit = (el, depth, context, level) => {
    if (!budget.spend()) {
      outline.truncated = true;
      return;
    }
    if (
      SKIPPED.has(el.localName) ||
      el.getAttribute("aria-hidden") === "true"
    ) {
      return;
    }
    const style = win.getComputedStyle(el);
    const display = style?.display ?? "inline";
    if (display === "none") {
      return;
    }
    const cursor = style?.cursor ?? "auto";
    let shown;
    if (context.inSelect) {
      shown = context.shown;
    } else if (display === "contents") {
      shown = context.shown;
    } else {
      shown = el.checkVisibility(VISIBILITY);
    }
    let role = shown ? roleOf(el) : null;
    if (shown && !role && isClickable(el, context, display, cursor)) {
      role = CLICKABLE;
    }
    if (display !== "inline" && display !== "contents") {
      outline.flushText();
    }
    let childDepth = depth;
    let quiet = context.quiet || el.localName === "textarea";
    let held = context.held;
    if (role) {
      held ||= CLICK_TARGETS.has(role);
      const listed =
        !viewportOnly ||
        display === "contents" ||
        context.inSelect ||
        inViewport(win, el.getClientRects());
      const name = listed || role === CLICKABLE ? nameOf(el, role, budget) : "";
      // The text of an element the page gave no role is its name only when
      // the name holds all of it; a container with more text than a name
      // takes keeps its text as lines of its own.
      quiet ||=
        NAMED_FROM_CONTENT.has(role) &&
        (role !== CLICKABLE || name.length < MAX_NAME);
      if (listed) {
        const head = name ? `${role} ${quote(name)}` : role;
        const ref = refs.refFor(el);
        const line = [`${head} [${ref}]`, ...suffixesOf(el, role)].join(" ");
        if (!outline.add(depth, line)) {
          return;
        }
        outline.refs++;
        childDepth = depth + 1;
      }
    }
    // A label's text is the name of the control it labels.
    if (el.localName === "label" && el.control) {
      quiet = true;
    }
    walk(
      el,
      childDepth,
      {
        shown,
        quiet,
        held,
        pointer: cursor === "pointer",
        inSelect: context.inSelect || el.localName === "select",
      },
      level
    );
    if (role) {
      outline.flushText();
    }
  };

  const start = root ?? document.body ?? document.documentElement;
  if (start) {
    const context = {
      shown: true,
      quiet: false,
      held: false,
      pointer: false,
      inSelect: false,
    };
    // A scoped outline reads what its root's ancestors would have told the
    // walk, so the root's subtree lists what the whole page's outline does.
    if (root) {
      const parent = root.flattenedTreeParentNode;
      context.pointer =
        Element.isInstance(parent) &&
        win.getComputedStyle(parent)?.cursor === "pointer";
      for (let up = parent; Element.isInstance(up); ) {
        const role = roleOf(up);
        context.held ||= CLICK_TARGETS.has(role);
        context.quiet ||= NAMED_FROM_CONTENT.has(role);
        context.inSelect ||= up.localName === "select";
        up = up.flattenedTreeParentNode;
      }
    } else {
      context.pointer = win.getComputedStyle(start)?.cursor === "pointer";
    }
    if (root) {
      visit(root, 0, context, 0);
    } else {
      walk(start, 0, context, 0);
    }
    outline.flushText();
  }
  return {
    text: outline.lines.join("\n"),
    refs: outline.refs,
    truncated: outline.truncated || budget.exhausted || tooDeep,
  };
}
