/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Pointing at an element of the page, which the element picker and the
 * snip share (element picker spec §10): the outline and its label, the bar,
 * and what the pointer and Tab land on. It draws into a layer of the
 * overlay's anonymous content and never changes the page.
 *
 * The owner routes events to it and decides what choosing an element does.
 */

import {
  hostOf,
  nameOf,
  pointable,
} from "moz-src:///browser/components/sval/SvalElementCandidates.sys.mjs";
import { keycap } from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

// How far outside the element's border box the outline is drawn.
const OUTSET = 2;
// The label goes inside the outline when the element's top is this close to
// the top of the viewport.
const LABEL_ROOM = 24;
// The bar's gap from the bottom (or the top) of the page area.
const BAR_GAP = 16;
const SHOW_ELEMENT = 1;

/**
 * Makes an element of the overlay in the page's document. An attribute whose
 * value is `true` is set empty, and one whose value is null or false is left
 * out; a string child becomes text.
 *
 * @param {Document} document
 * @param {string} tag
 * @param {object} [attributes]
 * @param {...(Node|string)} children
 * @returns {Element}
 */
export function h(document, tag, attributes = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) {
      el.setAttribute(name, "");
    } else if (value != null && value !== false) {
      el.setAttribute(name, String(value));
    }
  }
  el.append(...children);
  return el;
}

/**
 * @param {Document} document
 * @param {string} name The icon's class, after `icon-`.
 * @returns {Element} a decorative icon, drawn by the overlay's stylesheet.
 */
export function icon(document, name) {
  return h(document, "span", {
    class: `icon icon-${name}`,
    "aria-hidden": "true",
  });
}

/**
 * @param {Window} window
 * @returns {{width: number, height: number}} the page area.
 */
export function viewportOf(window) {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The box a mark is drawn in: the element's border box grown by the outline's
 * outset, clamped to the viewport.
 *
 * @param {DOMRect} rect
 * @param {{width: number, height: number}} viewport
 * @returns {{left: number, top: number, width: number, height: number}}
 *   empty when the element is outside the viewport.
 */
export function markBox(rect, viewport) {
  const left = Math.max(rect.left - OUTSET, 0);
  const top = Math.max(rect.top - OUTSET, 0);
  const right = Math.min(rect.right + OUTSET, viewport.width);
  const bottom = Math.min(rect.bottom + OUTSET, viewport.height);
  return {
    left,
    top,
    width: Math.max(right - left, 0),
    height: Math.max(bottom - top, 0),
  };
}

/**
 * Draws a mark over an element, or hides it when the element is out of view.
 *
 * @param {Element} mark
 * @param {Element} el
 * @param {{width: number, height: number}} viewport
 * @returns {?object} the mark's box, or null when it is hidden.
 */
export function placeMark(mark, el, viewport) {
  const box = markBox(el.getBoundingClientRect(), viewport);
  mark.hidden = !box.width || !box.height;
  if (mark.hidden) {
    return null;
  }
  mark.style.left = `${box.left}px`;
  mark.style.top = `${box.top}px`;
  mark.style.width = `${box.width}px`;
  mark.style.height = `${box.height}px`;
  return box;
}

/**
 * @param {Element} el
 * @returns {string} its size in CSS pixels, as the label shows it.
 */
export function sizeOf(el) {
  const rect = el.getBoundingClientRect();
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

/** The outline, label and bar the picker and the snip point with. */
export class SvalElementPointing {
  #window;
  #document;
  #verb;
  #outline;
  #name;
  #size;
  #label;
  #bar;
  #live;
  #target = null;
  #probe;

  /**
   * @param {object} options
   * @param {Window} options.window The page's window.
   * @param {Element} options.overlay The overlay's container, which the
   *   bar and the outline are added to.
   * @param {object} options.copy The bar's words: `title`, `choose` (the
   *   Enter hint), `verb`, which the label puts before the element's name
   *   to say what choosing it does, and `icon`, the icon's class.
   * @param {boolean} [options.snip] Whether the label carries the
   *   snip's scissors.
   */
  constructor({ window, overlay, copy, snip = false }) {
    this.#window = window;
    this.#document = window.document;
    this.#verb = copy.verb;
    this.#probe = overlay;
    const doc = this.#document;

    this.#name = h(doc, "span", { class: "label-name" });
    this.#size = h(doc, "span", { class: "label-size" });
    this.#label = h(
      doc,
      "div",
      { id: "label", class: "label" },
      ...(snip ? [icon(doc, "scissors")] : []),
      this.#name,
      this.#size
    );
    this.#outline = h(
      doc,
      "div",
      { id: "outline", class: "mark", hidden: true },
      this.#label
    );

    const hint = (key, word) =>
      h(
        doc,
        "span",
        { class: "hint" },
        h(doc, "kbd", { class: "kbd" }, key),
        word
      );
    this.#bar = h(
      doc,
      "div",
      {
        id: "bar",
        class: "surface bar",
        role: "toolbar",
        "aria-label": copy.title,
        tabindex: "-1",
      },
      icon(doc, copy.icon),
      h(doc, "span", { id: "bar-title", class: "bar-title" }, copy.title),
      h(
        doc,
        "span",
        { class: "hints", "aria-hidden": "true" },
        hint(keycap("VK_TAB"), "Move"),
        hint(keycap("VK_RETURN"), copy.choose),
        hint(keycap("VK_ESCAPE"), "Leave")
      ),
      h(
        doc,
        "button",
        { id: "bar-cancel", class: "button secondary", tabindex: "-1" },
        "Cancel"
      )
    );
    this.#live = h(doc, "div", {
      id: "live",
      class: "visually-hidden",
      "aria-live": "polite",
    });
    overlay.append(this.#outline, this.#bar, this.#live);
  }

  /** @returns {Element} the pointing bar. */
  get bar() {
    return this.#bar;
  }

  /** @returns {?Element} the element the outline is on. */
  get target() {
    return this.#target?.isConnected ? this.#target : null;
  }

  /** @returns {?object} the outline's box, or null when it is not drawn. */
  get box() {
    if (this.#outline.hidden) {
      return null;
    }
    return this.#outline.getBoundingClientRect();
  }

  /**
   * Shows or hides the bar.
   *
   * @param {boolean} shown
   */
  showBar(shown) {
    this.#bar.hidden = !shown;
    if (!shown) {
      this.#bar.removeAttribute("at-top");
    }
  }

  /**
   * Whether an element can be pointed at as it is drawn now.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  #pointable(el) {
    return (
      pointable(el, el.getBoundingClientRect()) &&
      el.checkVisibility({ visibilityProperty: true })
    );
  }

  /**
   * Runs `ask` with the overlay out of hit testing, as Firefox's Screenshots
   * overlay does (`ScreenshotsOverlay.setPointerEventsNone`).
   *
   * @param {Function} ask
   * @returns {*} what `ask` returns.
   */
  #probing(ask) {
    this.#probe.setAttribute("probing", "");
    try {
      return ask();
    } finally {
      this.#probe.removeAttribute("probing");
    }
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {Element[]} every element of the page at a point of the
   *   viewport, the topmost first, ancestors included.
   */
  stackAt(x, y) {
    return this.#probing(() => this.#document.elementsFromPoint(x, y));
  }

  /**
   * The element under a point of the viewport that can be pointed at: the
   * one hit, or its nearest ancestor that can.
   *
   * @param {number} x
   * @param {number} y
   * @returns {?Element}
   */
  elementAt(x, y) {
    const hit = this.#probing(() => this.#document.elementFromPoint(x, y));
    for (let el = hit && hostOf(hit); el; el = el.parentElement) {
      if (el.localName == "body" || el.localName == "html") {
        return null;
      }
      if (this.#pointable(el)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Puts the outline on an element, or takes it away.
   *
   * @param {?Element} el
   */
  pointTo(el) {
    const moved = el !== this.#target;
    this.#target = el;
    this.redraw();
    if (el && moved) {
      this.#live.textContent = `${nameOf(el)}, ${sizeOf(el)}`;
    }
  }

  /** Draws the outline where its element is now. */
  redraw() {
    const el = this.target;
    if (!el) {
      this.#outline.hidden = true;
      return;
    }
    const viewport = viewportOf(this.#window);
    if (!placeMark(this.#outline, el, viewport)) {
      return;
    }
    this.#name.textContent = `${this.#verb} ${nameOf(el)}`;
    this.#size.textContent = sizeOf(el);
    this.#label.dataset.element = el.localName;
    this.#label.toggleAttribute(
      "inside",
      el.getBoundingClientRect().top < LABEL_ROOM
    );
  }

  /**
   * Follows the pointer: the bar moves to the top while the pointer is over
   * its place at the bottom, and the outline goes to what is under it.
   *
   * @param {number} x
   * @param {number} y
   */
  pointerMove(x, y) {
    if (!this.#bar.hidden) {
      const rect = this.#bar.getBoundingClientRect();
      const bottom = this.#window.innerHeight - BAR_GAP;
      const over =
        x >= rect.left &&
        x <= rect.right &&
        y >= bottom - rect.height &&
        y <= bottom;
      this.#bar.toggleAttribute("at-top", over);
    }
    this.pointTo(this.elementAt(x, y));
  }

  /**
   * Moves the outline to the next element that can be pointed at, in
   * document order, scrolling it into view.
   *
   * @param {boolean} backward
   */
  step(backward) {
    const root = this.#document.body ?? this.#document.documentElement;
    if (!root) {
      return;
    }
    const walker = this.#document.createTreeWalker(root, SHOW_ELEMENT);
    const from = this.target;
    let node;
    if (from && root.contains(from)) {
      walker.currentNode = from;
      node = backward ? walker.previousNode() : walker.nextNode();
    } else if (backward) {
      while (walker.lastChild()) {
        // Down to the last element in document order.
      }
      node = walker.currentNode;
    } else {
      node = walker.nextNode();
    }
    for (; node; node = backward ? walker.previousNode() : walker.nextNode()) {
      if (this.#pointable(node)) {
        break;
      }
    }
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const viewport = viewportOf(this.#window);
    if (
      rect.top < 0 ||
      rect.left < 0 ||
      rect.bottom > viewport.height ||
      rect.right > viewport.width
    ) {
      node.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
    }
    this.pointTo(node);
  }
}
