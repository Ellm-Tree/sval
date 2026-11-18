/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The element picker's side in the page (element picker design round 3):
 * the overlay, drawn in the document's anonymous content, where the person
 * points at an element, chooses how much of the page around it to hide, and
 * saves the rule through `SvalElementPickerParent`. The saved rule's sheet is
 * loaded at once, and the toast's Undo takes it out again.
 *
 * The snip is a mode of the same overlay: it removes the element pointed at
 * from the page's tree, saves nothing, and the toast's Undo puts it back.
 *
 * Every event of the page goes through the window root's capturing listener
 * while the picker is up, as Firefox's Screenshots overlay takes them
 * (`ScreenshotsComponentChild.addOverlayEventListeners`), so the page sees
 * no pointer or key event the overlay handles. The window root outlives the
 * document, so the listener is removed on `pagehide`, which the window root
 * hears before any listener of the page can stop it.
 */

import { siteOf } from "moz-src:///browser/components/sval/SvalSite.sys.mjs";
import { hidingSheet } from "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs";
import {
  nameOf,
  selectorFor,
  sourceOf,
  stops as stopsOf,
} from "moz-src:///browser/components/sval/SvalElementCandidates.sys.mjs";
import {
  hideLine,
  networkLine,
} from "moz-src:///browser/components/sval/SvalElementRules.sys.mjs";
import {
  SvalElementPointing,
  h,
  icon,
  placeMark,
  viewportOf,
} from "moz-src:///browser/components/sval/SvalElementPointing.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  ScopeDropdown,
  scopeChoices,
  scopePhrase,
} from "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const STYLESHEET = "chrome://browser/content/sval/sval-element-picker.css";

// The window root's events the overlay takes while the picker is up.
const TAKEN = [
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerover",
  "pointerout",
  "touchstart",
  "touchmove",
  "touchend",
  "keydown",
  "keypress",
  "keyup",
];
// Watched, never taken: whether focus is in the toast, and the document's
// end, scrolls and resizes.
const WATCHED = ["focusin", "focusout", "pagehide", "scroll", "resize"];
// Gecko asserts when a `pointerdown` is cancelled (`WidgetEventImpl.cpp`, as
// Screenshots notes), and the context menu stays the browser's.
const NOT_CANCELLED = new Set(["pointerdown", "contextmenu"]);

// The most selectors one count asks about.
const MAX_COUNTED = 12;

// How long the toast stays, unless the pointer or focus is on it.
const TOAST_MS = 8000;
// The fade of hidden elements and of the overlay's surfaces.
const FADE_MS = 160;
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
// The card's gap from the edges of the page area, and the least it keeps
// where the page area is too small for the gap.
const CARD_GAP = 16;
const CARD_EDGE = 8;
// The most match marks the preview draws. The count says how many match.
const MAX_MATCH_MARKS = 200;

// The share of the viewport a layer covers to be a snipped dialog's backdrop
// (in both directions), and that something removed covers (in area) to have
// held the page's scroll.
const BACKDROP_SHARE = 0.9;
const SCROLL_LOCK_SHARE = 0.5;

const REMOVE_COPY = {
  title: "Click what you want to remove",
  choose: "Choose",
  verb: "Remove",
  icon: "eraser",
};

const SNIP_COPY = {
  title: "Click what you want to snip",
  choose: "Snip",
  verb: "Snip",
  icon: "scissors",
};

const SNIPPED = "Snipped. Reload brings it back.";
const SAVE_REFUSED = {
  other: "Remove from this site is off here.",
};

const DOWNLOAD_SUBS = {
  img: "The image won't load at all on this site.",
  picture: "The image won't load at all on this site.",
  iframe: "The frame won't load at all on this site.",
  video: "The video won't load at all on this site.",
  audio: "The audio won't load at all on this site.",
};

/**
 * @param {number} n
 * @returns {string} the card's count line.
 */
function countText(n) {
  return n == 1
    ? "Removes 1 element on this page"
    : `Removes ${n} elements on this page`;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean} whether two boxes overlap.
 */
function overlaps(a, b) {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * @param {Element} el
 * @param {Window} window
 * @returns {boolean} whether the element, or an ancestor, is `position:fixed`.
 */
function inFixedBox(el, window) {
  for (let node = el; node; node = node.parentElement) {
    if (window.getComputedStyle(node).position == "fixed") {
      return true;
    }
  }
  return false;
}

/**
 * @param {DOMRect} rect
 * @param {{width: number, height: number}} viewport
 * @returns {number} the share of the viewport the box covers.
 */
function areaShare(rect, viewport) {
  const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
  return (
    (Math.max(width, 0) * Math.max(height, 0)) /
    (viewport.width * viewport.height)
  );
}

/**
 * One use of the picker in one document, from Start until the person leaves,
 * and after a save, the toast.
 */
class PickerOverlay {
  #actor;
  #window;
  #document;
  #site;
  #host;
  // The scope the rule is saved at: the host, where every card starts, or
  // the site once picked in the card's title.
  #at;
  #scopeMenu = null;
  #content = null;
  #root = null;
  #overlay;
  #marksLayer;
  #pointing;
  #card;
  #toast = null;
  // "pointing", "card" and "saving" while the person picks; then "toast",
  // "undoing" and "closing"; null once gone.
  #state = null;
  #chosen = null;
  #stops = [];
  #index = 0;
  #selector = "";
  #source = null;
  #network = null;
  #stopDownload = true;
  #matchMarks = [];
  #dragging = false;
  // The pointer's offset in the card while the person moves it by its
  // header, and whether they have moved it since it showed.
  #grip = null;
  #moved = false;
  #resized = false;
  #redrawPending = false;
  #previousFocus = null;
  #sheet = null;
  #lines = null;
  #fading = [];
  #toastTimer = null;
  #toastHovered = false;
  #toastFocused = false;
  #toastFocusPauses = false;
  #focusingToast = false;
  #reducedMotion;
  #scheme;
  #parts = {};
  #windowRoot = null;
  #mode;
  // The snip's removal: each node with the place it left, and the
  // `overflow` values it cleared to let the page scroll.
  #removed = [];
  #unlock = false;
  #cleared = [];
  #settle = null;

  /**
   * @param {JSWindowActorChild} actor
   * @param {object} look What the parent's Start says.
   * @param {string} look.mode "remove" or "snip".
   * @param {string} look.site The page's site, as the parent names it.
   * @param {string} [look.host] The page's host as a rule names it, which
   *   is the site where there is no choice of scope.
   * @param {string} look.scheme The chrome's colour scheme, "light" or
   *   "dark".
   * @param {boolean} look.reducedMotion Whether the chrome asks for reduced
   *   motion. A page's own media query reports no preference under
   *   fingerprinting resistance (`RFPTarget::CSSPrefersReducedMotion`), so
   *   the chrome's answer is used.
   */
  constructor(actor, { mode, site, host, scheme, reducedMotion }) {
    this.#mode = mode;
    this.#actor = actor;
    this.#window = actor.contentWindow;
    this.#document = actor.document;
    this.#site = site;
    this.#host = host || site;
    this.#at = this.#host;
    this.#scheme = scheme == "light" ? "light" : "dark";
    this.#reducedMotion = !!reducedMotion;
  }

  /** @returns {string} "remove" or "snip". */
  get mode() {
    return this.#mode;
  }

  get #snip() {
    return this.#mode == "snip";
  }

  /** @returns {{site: string, host: string, choice: boolean}} */
  get #scope() {
    return {
      site: this.#site,
      host: this.#host,
      choice: this.#host != this.#site,
    };
  }

  /** @returns {?ShadowRoot} the overlay's shadow root while it is drawn. */
  get root() {
    return this.#root;
  }

  /** @returns {boolean} whether the person is still picking. */
  get picking() {
    return ["pointing", "card", "saving"].includes(this.#state);
  }

  /**
   * The overlay's focused element. Its shadow root's `activeElement` stays
   * null, because the anonymous content is outside the document's tree.
   */
  get #focused() {
    const el = Services.focus.focusedElement;
    return el && el.getRootNode() === this.#root ? el : null;
  }

  /** Draws the overlay and starts pointing. */
  show() {
    const doc = this.#document;
    this.#previousFocus = doc.activeElement;
    this.#content = doc.insertAnonymousContent();
    this.#root = this.#content.root;
    this.#overlay = h(doc, "div", {
      class: "overlay",
      mode: this.#mode,
      scheme: this.#scheme,
      "reduced-motion": this.#reducedMotion,
    });
    this.#marksLayer = h(doc, "div");
    this.#overlay.append(this.#marksLayer);
    this.#root.append(
      h(doc, "link", { rel: "stylesheet", href: STYLESHEET }),
      this.#overlay
    );
    this.#pointing = new SvalElementPointing({
      window: this.#window,
      overlay: this.#overlay,
      copy: this.#snip ? SNIP_COPY : REMOVE_COPY,
      snip: this.#snip,
    });
    if (!this.#snip) {
      this.#buildCard();
    }

    this.#windowRoot = this.#actor.docShell.chromeEventHandler;
    for (const type of [...TAKEN, ...WATCHED]) {
      this.#windowRoot.addEventListener(type, this, true);
    }

    this.#state = "pointing";
    this.#overlay.setAttribute("catching", "");
    this.#window.focus();
    this.#pointing.bar.focus();
  }

  #buildCard() {
    const doc = this.#document;
    const p = this.#parts;
    p.depthName = h(doc, "span", { id: "depth-name", class: "depth-name" });
    p.selector = h(doc, "span", { id: "selector", class: "depth-selector" });
    p.fill = h(doc, "div", { class: "fill" });
    p.thumb = h(doc, "div", { class: "thumb" });
    p.track = h(doc, "div", { class: "track" }, p.fill);
    p.slider = h(
      doc,
      "div",
      {
        id: "slider",
        class: "slider",
        role: "slider",
        tabindex: "0",
        "aria-label": "How much to remove",
        "aria-valuemin": "1",
      },
      p.track
    );
    p.count = h(doc, "span", { id: "count", "aria-live": "polite" });
    p.hideRule = h(doc, "div", { class: "rule" });
    p.networkRule = h(doc, "div", { class: "rule" });
    p.box = h(
      doc,
      "div",
      {
        id: "download-box",
        class: "checkbox",
        role: "checkbox",
        tabindex: "0",
        "aria-labelledby": "download-label",
        "aria-describedby": "download-sub",
      },
      icon(doc, "check")
    );
    p.downloadSub = h(doc, "div", {
      id: "download-sub",
      class: "download-sub",
    });
    p.download = h(
      doc,
      "div",
      { id: "download", class: "download" },
      p.box,
      h(
        doc,
        "div",
        {},
        h(
          doc,
          "div",
          { id: "download-label", class: "download-label" },
          "Stop the download too"
        ),
        p.downloadSub
      )
    );
    p.cancel = h(
      doc,
      "button",
      { id: "card-cancel", class: "button secondary", tabindex: "0" },
      "Cancel"
    );
    p.hide = h(
      doc,
      "button",
      { id: "hide", class: "button primary", tabindex: "0" },
      "Remove"
    );
    p.title = h(
      doc,
      "div",
      { id: "card-title", class: "card-title" },
      `Remove from ${this.#site}`
    );
    this.#card = h(
      doc,
      "div",
      {
        id: "card",
        class: "surface card",
        role: "dialog",
        "aria-label": "Remove from this site",
        hidden: true,
      },
      h(
        doc,
        "div",
        { class: "card-header" },
        h(doc, "div", { class: "tile" }, icon(doc, "eraser")),
        p.title,
        h(doc, "kbd", { class: "kbd", "aria-hidden": "true" }, "Esc")
      ),
      h(
        doc,
        "div",
        { class: "depth" },
        h(doc, "div", { class: "depth-line" }, p.depthName, p.selector),
        p.slider,
        h(
          doc,
          "div",
          { class: "ends", "aria-hidden": "true" },
          h(doc, "span", {}, "Narrower"),
          h(doc, "span", {}, "Wider")
        )
      ),
      h(
        doc,
        "div",
        { class: "count" },
        h(doc, "div", { class: "count-line" }, icon(doc, "eye-off"), p.count),
        h(doc, "div", { id: "rules" }, p.hideRule, p.networkRule)
      ),
      p.download,
      h(
        doc,
        "div",
        { class: "footer" },
        h(
          doc,
          "span",
          { class: "footer-note" },
          "Saved to My filters. Syncs to your devices."
        ),
        h(doc, "div", { class: "footer-actions" }, p.cancel, p.hide)
      )
    );
    this.#overlay.append(this.#card);
  }

  handleEvent(event) {
    if (!event.isTrusted || !this.#state) {
      return;
    }
    switch (event.type) {
      case "pagehide":
        if (this.#ours(event)) {
          this.#actor.overlayGone(this, this.picking);
        }
        return;
      case "scroll":
      case "resize":
        if (this.#ours(event)) {
          this.#resized ||= event.type == "resize";
          this.#scheduleRedraw();
        }
        return;
      case "focusin":
      case "focusout":
        if (this.#state == "toast") {
          this.#toastFocused =
            event.type == "focusin" && !!this.#inside(event, this.#toast);
          // Only focus the person moves pauses the timer: the toast takes
          // focus itself when it shows.
          this.#toastFocusPauses = this.#toastFocused && !this.#focusingToast;
          this.#armToast();
        }
        return;
    }
    if (!this.picking) {
      this.#toastEvent(event);
      return;
    }
    event.stopImmediatePropagation();
    const handled = this.#pickingEvent(event);
    if (
      !NOT_CANCELLED.has(event.type) &&
      (handled || !event.type.startsWith("key"))
    ) {
      event.preventDefault();
    }
  }

  /**
   * @param {Event} event
   * @returns {boolean} whether the event is for this document or its window,
   *   which share the window root with the tab's in-process frames.
   */
  #ours(event) {
    const target = event.originalTarget;
    const doc =
      target.nodeType == 9 ? target : (target.ownerDocument ?? target.document);
    return doc === this.#document;
  }

  /**
   * @param {Event} event
   * @param {?Element} [within] An element of the overlay.
   * @returns {?Element} the overlay element the event is for, inside
   *   `within` when it is given.
   */
  #inside(event, within = this.#overlay) {
    let node = event.originalTarget;
    if (node?.nodeType != 1) {
      node = node?.parentElement;
    }
    if (!node || !within || node.getRootNode() !== this.#root) {
      return null;
    }
    return within.contains(node) ? node : null;
  }

  /**
   * An event while the person is picking. The page gets none of them.
   *
   * @param {Event} event
   * @returns {boolean} whether a key event was used.
   */
  #pickingEvent(event) {
    if (this.#state == "saving") {
      return true;
    }
    const card = this.#state == "card";
    switch (event.type) {
      case "pointermove":
        if (card) {
          if (this.#dragging) {
            this.#slideTo(event.clientX);
          } else if (this.#grip && !(event.buttons & 1)) {
            // The button came up outside the window.
            this.#grip = null;
            this.#card.removeAttribute("moving");
          } else if (this.#grip) {
            this.#moveCard(
              event.clientX - this.#grip.x,
              event.clientY - this.#grip.y
            );
          }
        } else {
          this.#pointing.pointerMove(event.clientX, event.clientY);
        }
        break;
      case "pointerdown":
        if (card && this.#inside(event, this.#parts.slider)) {
          this.#dragging = true;
          this.#parts.slider.focus();
          this.#slideTo(event.clientX);
        } else if (card && event.button == 0 && this.#onGrip(event)) {
          const { left, top } = this.#card.getBoundingClientRect();
          this.#grip = { x: event.clientX - left, y: event.clientY - top };
          this.#card.toggleAttribute("moving", true);
        }
        break;
      case "pointerup":
        this.#dragging = false;
        this.#grip = null;
        this.#card?.removeAttribute("moving");
        break;
      case "click":
        if (event.button == 0) {
          this.#click(event);
        }
        break;
      case "keydown":
        return card ? this.#cardKey(event) : this.#pointingKey(event);
    }
    return false;
  }

  #click(event) {
    if (this.#state == "pointing") {
      if (this.#inside(event, this.#pointing.bar)) {
        if (this.#inside(event)?.closest("#bar-cancel")) {
          this.leave();
        }
        return;
      }
      const el = this.#pointing.elementAt(event.clientX, event.clientY);
      if (el) {
        this.#choose(el);
      }
      return;
    }
    const target = this.#inside(event, this.#card);
    if (this.#scopeMenu?.click(target) || !target) {
      return;
    }
    if (target.closest("#hide")) {
      this.#hide();
    } else if (target.closest("#card-cancel")) {
      this.leave();
    } else if (target.closest("#download-box, #download-label")) {
      this.#toggleDownload();
    }
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} whether the key was used.
   */
  #pointingKey(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    switch (event.key) {
      case "Tab":
        this.#pointing.step(event.shiftKey);
        return true;
      case "Enter":
      case " ":
        if (this.#pointing.target) {
          this.#choose(this.#pointing.target);
        }
        return true;
      case "Escape":
        this.leave();
        return true;
    }
    return false;
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} whether the key was used.
   */
  #cardKey(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    if (this.#scopeMenu?.key(event)) {
      return true;
    }
    const onSlider = this.#focused === this.#parts.slider;
    const last = this.#stops.length - 1;
    switch (event.key) {
      case "ArrowUp":
        this.#setStop(this.#index + 1);
        return true;
      case "ArrowDown":
        this.#setStop(this.#index - 1);
        return true;
      case "ArrowRight":
      case "ArrowLeft":
      case "Home":
      case "End":
        if (!onSlider) {
          return false;
        }
        this.#setStop(
          {
            ArrowRight: this.#index + 1,
            ArrowLeft: this.#index - 1,
            Home: 0,
            End: last,
          }[event.key]
        );
        return true;
      case " ":
        if (this.#focused === this.#parts.box) {
          this.#toggleDownload();
        } else if (this.#focused === this.#parts.cancel) {
          this.leave();
        } else if (this.#focused === this.#parts.hide) {
          this.#hide();
        }
        return true;
      case "Enter":
        if (this.#focused === this.#parts.cancel) {
          this.leave();
        } else {
          this.#hide();
        }
        return true;
      case "Escape":
        this.#backToPointing();
        return true;
      case "Tab":
        this.#trapFocus(event.shiftKey);
        return true;
    }
    return false;
  }

  /**
   * Moves focus to the card's next or previous control, round.
   *
   * @param {boolean} backward
   */
  #trapFocus(backward) {
    const p = this.#parts;
    const order = [
      this.#scopeMenu?.button,
      p.slider,
      p.download.hidden ? null : p.box,
      p.cancel,
      p.hide,
    ].filter(Boolean);
    const at = order.indexOf(this.#focused);
    const next =
      at < 0
        ? order.at(backward ? -1 : 0)
        : order[(at + (backward ? -1 : 1) + order.length) % order.length];
    next.focus({ focusVisible: true });
  }

  /**
   * Draws the card for the rule's scope: on a host with a choice, the
   * title's scope dropdown (host-scoped rules spec §4) and the button name
   * it, and the rules shown are the scope's.
   *
   * @param {string} at The host or the site.
   */
  #drawScope(at) {
    const p = this.#parts;
    this.#at = at;
    if (!this.#scope.choice) {
      return;
    }
    const doc = this.#document;
    this.#scopeMenu = new ScopeDropdown(doc, {
      id: "card-scope",
      choices: scopeChoices(this.#scope),
      current: at,
      onPick: name => {
        this.#drawScope(name);
        this.#setStop(this.#index);
        this.#scopeMenu.button.focus({ focusVisible: true });
      },
    });
    p.title.dataset.scope = at;
    p.title.replaceChildren(
      h(doc, "span", { class: "card-title-words" }, "Remove from"),
      this.#scopeMenu.root
    );
    p.hide.textContent = `Remove from ${scopePhrase(this.#scope, at)}`;
  }

  /**
   * Shows the card for the element the person chose; the snip removes it.
   *
   * @param {Element} el
   */
  #choose(el) {
    if (this.#snip) {
      this.#zap(el);
      return;
    }
    this.#chosen = el;
    this.#stops = stopsOf(el);
    if (!this.#stops.length) {
      return;
    }
    this.#stopDownload = true;
    this.#state = "card";
    this.#drawScope(this.#host);
    this.#pointing.showBar(false);
    this.#buildStops();
    this.#setStop(0);
    this.#card.hidden = false;
    this.#moved = false;
    this.#place();
    this.#parts.hide.focus({ focusVisible: true });
  }

  #buildStops() {
    const p = this.#parts;
    for (const old of p.track.querySelectorAll(".stop")) {
      old.remove();
    }
    p.thumb.remove();
    const doc = this.#document;
    const last = Math.max(this.#stops.length - 1, 1);
    p.stops = this.#stops.map((_, i) => {
      const stop = h(doc, "div", { class: "stop" });
      stop.style.left = `${(i / last) * 100}%`;
      return stop;
    });
    p.track.append(...p.stops, p.thumb);
    p.slider.setAttribute("aria-valuemax", String(this.#stops.length));
  }

  /**
   * Selects stop `index`, clamped, and shows what it hides.
   *
   * @param {number} index
   */
  #setStop(index) {
    if (!this.#stops.length) {
      return;
    }
    this.#index = Math.min(Math.max(index, 0), this.#stops.length - 1);
    const el = this.#stops[this.#index];
    const p = this.#parts;
    const name = nameOf(el);
    this.#selector = selectorFor(el);
    p.depthName.textContent = name;
    p.depthName.dataset.element = el.localName;
    p.selector.textContent = this.#selector;
    p.selector.title = this.#selector;
    const at = `${(this.#index / Math.max(this.#stops.length - 1, 1)) * 100}%`;
    p.fill.style.width = at;
    p.thumb.style.left = at;
    p.stops.forEach((stop, i) =>
      stop.toggleAttribute("reached", i <= this.#index)
    );
    p.slider.setAttribute("aria-valuenow", String(this.#index + 1));
    p.slider.setAttribute("aria-valuetext", `${name}, ${this.#selector}`);

    let matches;
    try {
      matches = this.#document.querySelectorAll(this.#selector);
    } catch {
      matches = [el];
    }
    p.count.textContent = countText(matches.length);
    p.count.dataset.matches = String(matches.length);
    p.hideRule.textContent = hideLine(this.#at, this.#selector);

    this.#source = sourceOf(el);
    this.#network =
      this.#source && this.#otherSite(this.#source)
        ? networkLine(this.#at, this.#source)
        : null;
    p.download.hidden = !this.#network;
    if (this.#network) {
      p.downloadSub.textContent = DOWNLOAD_SUBS[el.localName];
    }
    this.#showDownload();

    this.#pointing.pointTo(el);
    this.#drawMatches([...matches].filter(m => m !== el));
  }

  /**
   * Whether a download comes from another site than the page's. A network
   * rule never blocks a page's request to its own site, because the
   * classifier leaves those alone (`ContentClassifierEngine`).
   *
   * @param {string} url
   * @returns {boolean}
   */
  #otherSite(url) {
    const site = siteOf(url);
    return site !== null && site != this.#site;
  }

  #showDownload() {
    const p = this.#parts;
    const on = !!this.#network && this.#stopDownload;
    p.box.setAttribute("aria-checked", String(this.#stopDownload));
    p.networkRule.hidden = !on;
    p.networkRule.textContent = on ? this.#network : "";
  }

  #toggleDownload() {
    if (this.#parts.download.hidden) {
      return;
    }
    this.#stopDownload = !this.#stopDownload;
    this.#showDownload();
  }

  /**
   * Selects the stop nearest a point on the slider's track.
   *
   * @param {number} x
   */
  #slideTo(x) {
    const rect = this.#parts.track.getBoundingClientRect();
    const last = this.#stops.length - 1;
    if (!rect.width || last < 1) {
      return;
    }
    const ratio = Math.min(Math.max((x - rect.left) / rect.width, 0), 1);
    this.#setStop(Math.round(ratio * last));
  }

  /**
   * Marks the other elements the rule would hide.
   *
   * @param {Element[]} elements
   */
  #drawMatches(elements) {
    for (const { mark } of this.#matchMarks) {
      mark.remove();
    }
    const viewport = viewportOf(this.#window);
    this.#matchMarks = [];
    for (const el of elements) {
      if (this.#matchMarks.length >= MAX_MATCH_MARKS) {
        break;
      }
      const mark = h(this.#document, "div", { class: "mark match" });
      if (placeMark(mark, el, viewport)) {
        this.#marksLayer.append(mark);
        this.#matchMarks.push({ el, mark });
      }
    }
  }

  /**
   * Puts the card 16px in from the corner of the page area whose card covers
   * the fewest marks, the one farthest from the chosen element on a tie, or
   * at the bottom centre when every corner covers the chosen element.
   */
  #place() {
    const card = this.#card;
    const { width: vw, height: vh } = this.#overlay.getBoundingClientRect();
    const { width, height } = card.getBoundingClientRect();
    const chosen = this.#pointing.box ?? this.#chosen.getBoundingClientRect();
    const marks = [
      chosen,
      ...this.#matchMarks.map(({ mark }) => mark.getBoundingClientRect()),
    ];
    const cx = chosen.left + chosen.width / 2;
    const cy = chosen.top + chosen.height / 2;
    const corners = [
      { left: CARD_GAP, top: CARD_GAP },
      { left: vw - width - CARD_GAP, top: CARD_GAP },
      { left: CARD_GAP, top: vh - height - CARD_GAP },
      { left: vw - width - CARD_GAP, top: vh - height - CARD_GAP },
    ].map(corner => {
      const box = { ...corner, width, height };
      return {
        box,
        covers: marks.filter(m => overlaps(box, m)).length,
        coversChosen: overlaps(box, chosen),
        distance: Math.hypot(
          corner.left + width / 2 - cx,
          corner.top + height / 2 - cy
        ),
      };
    });
    let best;
    if (corners.every(c => c.coversChosen)) {
      best = { left: (vw - width) / 2, top: vh - height - CARD_GAP };
    } else {
      corners.sort((a, b) => a.covers - b.covers || b.distance - a.distance);
      best = corners[0].box;
    }
    // A card at the bottom keeps its bottom edge as the stops change its
    // height.
    const atBottom = best.top > CARD_GAP;
    card.style.left = `${Math.max(Math.min(best.left, vw - width - CARD_EDGE), CARD_EDGE)}px`;
    card.style.top = atBottom ? "auto" : `${CARD_GAP}px`;
    card.style.bottom = atBottom ? `${CARD_GAP}px` : "auto";
  }

  /**
   * @param {PointerEvent} event
   * @returns {boolean} whether the event is on the card's header outside
   *   its controls, where the person takes hold of the card to move it.
   */
  #onGrip(event) {
    const target = this.#inside(event, this.#card);
    return (
      target == this.#card ||
      (!!target?.closest(".card-header") && !target.closest(".sval-scope"))
    );
  }

  /**
   * Puts the card's top left corner at a point, kept inside the page area.
   * The overlay's box is the card's containing block, which leaves out the
   * page's scrollbars where `innerWidth` counts them.
   *
   * @param {number} left
   * @param {number} top
   */
  #moveCard(left, top) {
    const card = this.#card;
    const { width: vw, height: vh } = this.#overlay.getBoundingClientRect();
    const { width, height } = card.getBoundingClientRect();
    this.#moved = true;
    card.style.left = `${Math.max(Math.min(left, vw - width), 0)}px`;
    card.style.top = `${Math.max(Math.min(top, vh - height), 0)}px`;
    card.style.bottom = "auto";
  }

  /** Esc on the card: pointing again, from the chosen element. */
  #backToPointing() {
    this.#state = "pointing";
    this.#card.hidden = true;
    this.#drawMatches([]);
    this.#pointing.showBar(true);
    this.#pointing.pointTo(this.#chosen);
    this.#pointing.bar.focus();
  }

  #scheduleRedraw() {
    if (this.#redrawPending) {
      return;
    }
    this.#redrawPending = true;
    this.#window.requestAnimationFrame(() => {
      this.#redrawPending = false;
      if (!this.picking) {
        return;
      }
      this.#pointing.redraw();
      const viewport = viewportOf(this.#window);
      for (const { el, mark } of this.#matchMarks) {
        placeMark(mark, el, viewport);
      }
      // A resize places the card afresh, or keeps a card the person moved
      // inside the page area.
      if (this.#resized && this.#state != "pointing") {
        if (this.#moved) {
          const { left, top } = this.#card.getBoundingClientRect();
          this.#moveCard(left, top);
        } else {
          this.#place();
        }
      }
      this.#resized = false;
    });
  }

  /** Saves the rule, hides what it matches, and offers Undo. */
  async #hide() {
    this.#state = "saving";
    const selector = this.#selector;
    const data = { selector, scope: this.#at };
    if (this.#network && this.#stopDownload) {
      data.url = this.#source;
    }
    let answer;
    try {
      answer = await this.#actor.sendQuery("SvalElementPicker:Save", data);
    } catch (err) {
      answer = { ok: false, error: err.name };
    }
    if (this.#state != "saving") {
      return;
    }
    if (!answer?.ok) {
      SvalLog.warn(`element picker: the save was refused: ${answer?.error}`);
      this.#showRefusal("other");
      return;
    }
    // The parent ended the mode with the save; the toast stays for Undo.
    this.#lines = answer.lines;
    this.#overlay.removeAttribute("catching");
    this.#card.hidden = true;
    this.#pointing.pointTo(null);
    this.#pointing.showBar(false);
    this.#drawMatches([]);
    // The toast first: the sheet loads only in its state, and with reduced
    // motion it loads at once.
    this.#showToast();
    this.#fadeOut(selector);
  }

  /**
   * Tells the person a save was refused, in a toast with no Undo. The page
   * stays as it is, and the parent ends the mode as it does for a save.
   *
   * @param {string} reason A key of `SAVE_REFUSED`.
   */
  #showRefusal(reason) {
    this.#actor.sendAsyncMessage("SvalElementPicker:Ended", {
      mode: "remove",
      saved: false,
      removed: true,
    });
    this.#overlay.removeAttribute("catching");
    this.#card.hidden = true;
    this.#pointing.pointTo(null);
    this.#pointing.showBar(false);
    this.#drawMatches([]);
    this.#showToast(reason);
  }

  /**
   * Fades what the rule matches, then loads the rule's sheet, as the page
   * rules child loads one (`SvalPageRulesChild`): a user sheet, which page
   * CSP does not govern.
   *
   * @param {string} selector
   */
  #fadeOut(selector) {
    const elements = [...this.#document.querySelectorAll(selector)].slice(
      0,
      MAX_MATCH_MARKS
    );
    this.#fadeThen(elements, () => {
      const { windowUtils } = this.#window;
      const sheet = hidingSheet(this.#document, [selector]);
      const uri = `data:text/css;charset=utf-8,${encodeURIComponent(sheet)}`;
      try {
        windowUtils.loadSheetUsingURIString(uri, windowUtils.USER_SHEET);
        this.#sheet = uri;
      } catch (err) {
        SvalLog.warn(
          `element picker: loading the sheet failed: ${SvalLog.errorName(err)}`
        );
      }
    });
  }

  /**
   * Fades elements, then runs `apply` while the toast is up or closing, and
   * at once under reduced motion. When the overlay ends before the fades
   * finish, `apply` runs at that point, so a dismissed toast never leaves
   * the removal or the hiding undone. Undo cancels the fades, which rejects
   * `finished`, and `apply` does not run.
   *
   * @param {Element[]} elements
   * @param {Function} apply
   */
  #fadeThen(elements, apply) {
    const run = () => {
      this.#settle = null;
      if (this.#state != "toast" && this.#state != "closing") {
        return;
      }
      apply();
      this.#stopFading();
    };
    if (this.#reducedMotion) {
      run();
      return;
    }
    this.#settle = run;
    this.#fading = elements.map(el =>
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: EASE_IN,
        fill: "forwards",
      })
    );
    Promise.all(this.#fading.map(animation => animation.finished)).then(
      run,
      () => {}
    );
  }

  #stopFading() {
    for (const animation of this.#fading) {
      animation.cancel();
    }
    this.#fading = [];
  }

  /**
   * The backdrop a dialog stands on: the topmost `position:fixed` element
   * behind it that covers the viewport and holds nothing, no element and no
   * text. An ancestor of the dialog is never one.
   *
   * @param {Element} el
   * @param {{width: number, height: number}} viewport
   * @returns {?Element}
   */
  #backdropBehind(el, viewport) {
    const rect = el.getBoundingClientRect();
    const clamp = (value, max) => Math.min(Math.max(value, 0), max - 1);
    const x = clamp(rect.left + rect.width / 2, viewport.width);
    const y = clamp(rect.top + rect.height / 2, viewport.height);
    const stack = this.#pointing.stackAt(x, y);
    const at = stack.indexOf(el);
    if (at < 0) {
      return null;
    }
    return (
      stack.slice(at + 1).find(node => {
        const box = node.getBoundingClientRect();
        return (
          !node.contains(el) &&
          !node.childElementCount &&
          !node.textContent.trim() &&
          this.#window.getComputedStyle(node).position == "fixed" &&
          box.width >= viewport.width * BACKDROP_SHARE &&
          box.height >= viewport.height * BACKDROP_SHARE
        );
      }) ?? null
    );
  }

  /**
   * Removes the element the snip was pointed at, and the backdrop of a
   * dialog, from the page. The mode ends with the removal and the toast
   * offers Undo.
   *
   * @param {Element} el
   */
  #zap(el) {
    const viewport = viewportOf(this.#window);
    const targets = [el];
    if (
      el.localName == "dialog" ||
      el.matches("[role=dialog], [aria-modal=true]")
    ) {
      const backdrop = this.#backdropBehind(el, viewport);
      if (backdrop) {
        targets.push(backdrop);
      }
    }
    // Document order, so that Undo puts adjacent siblings back in theirs.
    const following = this.#window.Node.DOCUMENT_POSITION_FOLLOWING;
    targets.sort((a, b) => (a.compareDocumentPosition(b) & following ? -1 : 1));
    this.#unlock = targets.some(
      node =>
        (inFixedBox(node, this.#window) ||
          this.#window.getComputedStyle(node).position == "sticky") &&
        areaShare(node.getBoundingClientRect(), viewport) >= SCROLL_LOCK_SHARE
    );
    // The next sibling that stays, so that no removed node is the place
    // another goes back to.
    this.#removed = targets.map(node => {
      let next = node.nextSibling;
      while (next && targets.includes(next)) {
        next = next.nextSibling;
      }
      return { node, parent: node.parentNode, next };
    });

    this.#actor.sendAsyncMessage("SvalElementPicker:Ended", {
      mode: "snip",
      saved: false,
      removed: true,
    });
    this.#overlay.removeAttribute("catching");
    this.#pointing.pointTo(null);
    this.#pointing.showBar(false);
    this.#showToast();
    this.#fadeThen(targets, () => {
      for (const { node } of this.#removed) {
        node.remove();
      }
      if (this.#unlock) {
        this.#unlockScroll();
      }
    });
  }

  /** Clears `overflow:hidden` from the root and the body, keeping what was. */
  #unlockScroll() {
    const { documentElement, body } = this.#document;
    for (const el of [documentElement, body]) {
      const style = el && this.#window.getComputedStyle(el);
      if (style?.overflowX == "hidden" || style?.overflowY == "hidden") {
        this.#cleared.push({
          el,
          value: el.style.getPropertyValue("overflow"),
          priority: el.style.getPropertyPriority("overflow"),
        });
        el.style.setProperty("overflow", "visible", "important");
      }
    }
  }

  /**
   * Puts the removed nodes back, each at its old parent before the sibling
   * that followed it, and gives the root and the body the `overflow` they
   * had.
   */
  #putBack() {
    for (const { el, value, priority } of this.#cleared.reverse()) {
      if (value) {
        el.style.setProperty("overflow", value, priority);
      } else {
        el.style.removeProperty("overflow");
      }
    }
    this.#cleared = [];
    for (const { node, parent, next } of this.#removed) {
      if (!node.isConnected) {
        // A sibling the page has moved away counts as none, and the node
        // goes last.
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
      }
    }
  }

  /**
   * @param {string} [refusal] Why a save was refused, a key of
   *   `SAVE_REFUSED`: the toast has no Undo, and focus starts on its Dismiss.
   */
  #showToast(refusal) {
    const doc = this.#document;
    let glyph = this.#snip ? "scissors" : "check";
    let text = this.#snip
      ? SNIPPED
      : `Removed from ${scopePhrase(this.#scope, this.#at)}`;
    const buttons = [];
    if (refusal) {
      glyph = "eraser";
      text = SAVE_REFUSED[refusal];
    } else {
      buttons.push(
        h(
          doc,
          "button",
          { id: "undo", class: "button secondary undo" },
          icon(doc, "undo"),
          "Undo"
        )
      );
    }
    this.#toast = h(
      doc,
      "div",
      {
        id: "toast",
        class: refusal ? "surface toast refused" : "surface toast",
        role: "status",
        "data-refused": refusal ?? "",
      },
      icon(doc, glyph),
      h(doc, "span", { id: "toast-text" }, text),
      ...buttons,
      h(
        doc,
        "button",
        {
          id: "dismiss",
          class: "button secondary dismiss",
          title: "Dismiss",
          "aria-label": "Dismiss",
        },
        icon(doc, "x")
      )
    );
    this.#overlay.append(this.#toast);
    this.#state = "toast";
    // Tab from the page does not reliably reach anonymous content, so a
    // keyboard user starts on the toast's first button. Focus goes back when
    // the toast closes.
    this.#focusingToast = true;
    try {
      this.#root
        .getElementById(refusal ? "dismiss" : "undo")
        .focus({ focusVisible: true });
    } finally {
      this.#focusingToast = false;
    }
    this.#armToast();
  }

  /** Runs the toast's timer, paused while it is hovered or focused. */
  #armToast() {
    clearTimeout(this.#toastTimer);
    this.#toastTimer = null;
    if (
      this.#state == "toast" &&
      !this.#toastHovered &&
      !this.#toastFocusPauses
    ) {
      this.#toastTimer = setTimeout(() => this.#closeToast(), TOAST_MS);
    }
  }

  /**
   * An event after the save: the page keeps all but the toast's.
   *
   * @param {Event} event
   */
  #toastEvent(event) {
    if (this.#state != "toast") {
      return;
    }
    if (event.type == "pointermove") {
      const hovered = !!this.#inside(event, this.#toast);
      if (hovered != this.#toastHovered) {
        this.#toastHovered = hovered;
        this.#armToast();
      }
      return;
    }
    if (event.type.startsWith("key")) {
      // The page keeps its keys unless focus is in the toast.
      if (!this.#toastFocused) {
        return;
      }
      event.stopImmediatePropagation();
      if (event.type == "keydown" && event.key == "Escape") {
        event.preventDefault();
        this.#closeToast();
      }
      return;
    }
    const target = this.#inside(event, this.#toast);
    if (!target) {
      return;
    }
    event.stopImmediatePropagation();
    if (!NOT_CANCELLED.has(event.type)) {
      event.preventDefault();
    }
    if (target.closest("#undo")) {
      this.#undo();
    } else if (target.closest("#dismiss")) {
      this.#closeToast();
    }
  }

  /**
   * Shows the elements again: the snip puts back what it removed, and the
   * picker takes the saved lines out of My filters.
   */
  async #undo() {
    if (this.#state != "toast") {
      return;
    }
    this.#state = "undoing";
    clearTimeout(this.#toastTimer);
    this.#settle = null;
    this.#stopFading();
    if (this.#snip) {
      this.#putBack();
      this.#actor.sendAsyncMessage("SvalElementPicker:Unsnipped");
    } else {
      await this.#undoRule();
    }
    this.#state = "toast";
    this.#closeToast();
  }

  async #undoRule() {
    if (this.#sheet) {
      const { windowUtils } = this.#window;
      try {
        windowUtils.removeSheetUsingURIString(
          this.#sheet,
          windowUtils.USER_SHEET
        );
      } catch {
        // The document took its sheets with it.
      }
      this.#sheet = null;
    }
    try {
      const answer = await this.#actor.sendQuery("SvalElementPicker:Undo", {
        lines: this.#lines,
      });
      if (!answer?.ok) {
        SvalLog.warn(`element picker: undo was refused: ${answer?.error}`);
      }
    } catch (err) {
      SvalLog.warn(`element picker: undo failed: ${SvalLog.errorName(err)}`);
    }
  }

  async #closeToast() {
    if (this.#state != "toast") {
      return;
    }
    this.#state = "closing";
    clearTimeout(this.#toastTimer);
    if (!this.#reducedMotion) {
      const fade = this.#toast.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: EASE_IN,
        fill: "forwards",
      });
      await new Promise(resolve => setTimeout(resolve, FADE_MS));
      fade.cancel();
    }
    this.#actor.overlayGone(this, false);
  }

  #restoreFocus() {
    const previous = this.#previousFocus;
    this.#previousFocus = null;
    if (previous?.isConnected && previous !== this.#document.body) {
      previous.focus();
    } else {
      this.#focused?.blur();
    }
  }

  /** The person leaves the picker without saving. */
  leave() {
    this.#actor.overlayGone(this, true);
  }

  /** Takes the overlay and its listeners away. */
  destroy() {
    if (!this.#state) {
      return;
    }
    this.#settle?.();
    const giveFocusBack = this.picking || !!this.#focused;
    this.#state = null;
    clearTimeout(this.#toastTimer);
    this.#stopFading();
    for (const type of [...TAKEN, ...WATCHED]) {
      this.#windowRoot?.removeEventListener(type, this, true);
    }
    this.#windowRoot = null;
    try {
      if (giveFocusBack) {
        this.#restoreFocus();
      }
      this.#document.removeAnonymousContent(this.#content);
    } catch {
      // The document went, and took its anonymous content.
    }
    this.#root = null;
  }
}

/** The child of the element picker's actor pair, in the top document. */
export class SvalElementPickerChild extends JSWindowActorChild {
  #overlay = null;

  /** @returns {?ShadowRoot} the picker's overlay while it is drawn. */
  get overlay() {
    return this.#overlay?.root ?? null;
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "SvalElementPicker:Start":
        return this.#start(message.data);
      case "SvalElementPicker:Stop":
        if (this.#overlay?.picking) {
          this.overlayGone(this.#overlay, false);
        }
        break;
      case "SvalElementPicker:Count":
        return this.#count(message.data);
    }
    return null;
  }

  /**
   * @param {{selectors: string[]}} data
   * @returns {Array<?number>} how many elements each selector matches here;
   *   null for one the page's parser refuses, such as a procedural filter.
   */
  #count({ selectors } = {}) {
    if (!Array.isArray(selectors) || !this.document) {
      return [];
    }
    return selectors.slice(0, MAX_COUNTED).map(selector => {
      try {
        return this.document.querySelectorAll(String(selector)).length;
      } catch {
        return null;
      }
    });
  }

  async #start({ mode, site, host, scheme, reducedMotion } = {}) {
    this.#overlay?.destroy();
    this.#overlay = null;
    if (!["remove", "snip"].includes(mode) || !site) {
      return;
    }
    const document = this.document;
    if (document.readyState == "loading") {
      await new Promise(resolve =>
        this.contentWindow.addEventListener("DOMContentLoaded", resolve, {
          once: true,
        })
      );
    }
    if (!this.contentWindow || this.#overlay) {
      return;
    }
    const overlay = new PickerOverlay(this, {
      mode,
      site,
      host,
      scheme,
      reducedMotion,
    });
    this.#overlay = overlay;
    overlay.show();
  }

  /**
   * Takes an overlay away, telling the parent the mode ended when the person
   * left it. A save ends the mode in the parent itself.
   *
   * @param {PickerOverlay} overlay
   * @param {boolean} left Whether the person left the picker.
   */
  overlayGone(overlay, left) {
    if (overlay !== this.#overlay) {
      return;
    }
    const picking = overlay.picking;
    overlay.destroy();
    this.#overlay = null;
    if (left && picking) {
      this.sendAsyncMessage("SvalElementPicker:Ended", {
        mode: overlay.mode,
        saved: false,
      });
    }
  }

  didDestroy() {
    this.#overlay?.destroy();
    this.#overlay = null;
  }
}
