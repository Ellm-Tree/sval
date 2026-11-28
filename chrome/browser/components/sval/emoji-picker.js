/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's emoji picker page: a search field, a skin-tone control and every emoji
 * in one scrolling grid, opened by `SvalEmojiPicker.sys.mjs`.
 *
 * It answers through `window.arguments[0]`, which the opener reads once the
 * dialog has closed: `result` is `{ ok, value }` and `tone` is the skin tone
 * left selected. A dialog closed any other way leaves `result` null, which the
 * opener reads as a dismissal.
 *
 * First run's Workspace step shows the same page in a frame of its own sheet
 * (`SvalEmojiPicker.sys.mjs`'s `showInline`), since a dialog cannot open over
 * the sheet. There the arguments are the frame's, its `answer` is called in
 * place of the window closing, and Escape is the page's own Cancel: the
 * sheet never hears a key pressed in the frame.
 *
 * Every emoji is a button made once and filtered by `hidden`. The grid is an
 * ARIA grid: each group a row group, its emoji laid out in rows of
 * `COLUMNS` cells, so a screen reader says where in it the user is. Rows
 * are regrouped from the emoji on show after each search. A classic script
 * in a chrome document, like `settings.js`, so the modules come through
 * `ChromeUtils`.
 */

"use strict";

const { EMOJI_GROUPS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs"
);
const { SKIN_TONE_LABELS, emojiAtTone, searchEmoji } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
const { shadeScrollEdges } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDom.sys.mjs"
);
const { drawableEmojiGroups } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs"
);

/** The hand shown on each tone swatch, default first. */
const SWATCHES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/** Cells in a row of the grid; `emoji-picker.css` lays them out from it. */
const COLUMNS = 9;

const SvalEmojiPicker = {
  /** What the opener passed in: `{ initial, tone, result }`. */
  _args: null,

  /** @type {Array<{entry: Array, button: Element, section: Element}>} */
  _records: [],

  /** @type {Map<Element, Element>} Each group's stash of hidden emoji. */
  _stashes: new Map(),

  /** @type {number|null} The selected skin tone, 0 (light) to 4 (dark). */
  _tone: null,

  /** The emoji on offer: those this system can draw. */
  _groups: [],

  start() {
    this._args = window.arguments?.[0] ??
      window.frameElement?.svalEmojiArgs ?? { initial: "", tone: null };
    this._inline = !!window.frameElement?.svalEmojiArgs;
    document.documentElement.toggleAttribute("data-inline", this._inline);
    this._groups = drawableEmojiGroups(EMOJI_GROUPS, document);
    this._els = {
      picker: document.querySelector(".sval-emoji-picker"),
      search: document.querySelector(".sval-emoji-search"),
      tones: document.querySelector(".sval-emoji-tones"),
      grid: document.querySelector(".sval-emoji-grid"),
      empty: document.querySelector(".sval-emoji-empty"),
      none: document.querySelector(".sval-emoji-none"),
    };
    this._buildTones();
    this._buildGrid();
    // "No emoji" is only there to remove one, so a node with none has no use
    // for it.
    this._els.none.hidden = !this._args.initial;
    this._setTone(this._args.tone ?? null);
    this._filter("");

    this._els.search.addEventListener("input", this);
    this._els.picker.addEventListener("click", this);
    this._els.picker.addEventListener("keydown", this);
    // In a frame, the frame takes focus first, so keys reach the picker.
    if (this._inline) {
      window.focus();
    }
    this._els.search.focus();
  },

  _element(tag, attrs = {}) {
    const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }
    return el;
  },

  _buildTones() {
    SWATCHES.forEach((swatch, i) => {
      const label = i === 0 ? "Default" : SKIN_TONE_LABELS[i - 1];
      const button = this._element("button", {
        class: "sval-emoji-tone",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "aria-label": `${label} skin tone`,
        title: label,
        "data-tone": i === 0 ? "" : String(i - 1),
      });
      button.textContent = swatch;
      this._els.tones.append(button);
    });
  },

  _toneButtons() {
    return [...this._els.tones.children];
  },

  _buildGrid() {
    this._els.grid.style.setProperty("--sval-emoji-columns", String(COLUMNS));
    for (const group of this._groups) {
      const section = this._element("div", {
        class: "sval-emoji-group",
        role: "rowgroup",
        "aria-label": group.name,
      });
      const heading = this._element("div", {
        class: "sval-emoji-heading",
        "aria-hidden": "true",
      });
      heading.textContent = group.name;
      // The emoji a search hides; `_layRows` puts the rest in rows before it.
      const stash = this._element("div", { hidden: "hidden" });
      section.append(heading, stash);
      for (const entry of group.emoji) {
        const button = this._element("button", {
          class: "sval-emoji-choice",
          type: "button",
          role: "gridcell",
          tabindex: "-1",
          "aria-label": entry[1],
          title: entry[1],
        });
        button.textContent = entry[0];
        stash.append(button);
        this._records.push({ entry, button, section });
      }
      this._stashes.set(section, stash);
      this._els.grid.append(section);
    }
    // Marks at the grid's two ends. While one is out of view, emoji lie past
    // that edge, and the part across it casts a shadow over them.
    const topMarker = this._element("div", {
      class: "sval-emoji-edge",
      "aria-hidden": "true",
    });
    const bottomMarker = this._element("div", {
      class: "sval-emoji-edge",
      "aria-hidden": "true",
    });
    this._els.grid.prepend(topMarker);
    this._els.grid.append(bottomMarker);
    shadeScrollEdges(this._els.grid, {
      topMarker,
      bottomMarker,
      top: this._els.tones,
      bottom: this._els.picker.querySelector(".sval-emoji-foot"),
    });
  },

  /**
   * Lays each group's emoji on show into rows of `COLUMNS`, and moves the
   * rest out of the grid's rows.
   */
  _layRows() {
    const shown = new Map();
    for (const { button, section } of this._records) {
      if (button.hidden) {
        this._stashes.get(section).append(button);
      } else if (shown.has(section)) {
        shown.get(section).push(button);
      } else {
        shown.set(section, [button]);
      }
    }
    for (const [section, stash] of this._stashes) {
      for (const row of section.querySelectorAll(".sval-emoji-row")) {
        row.remove();
      }
      const buttons = shown.get(section) ?? [];
      for (let i = 0; i < buttons.length; i += COLUMNS) {
        const row = this._element("div", {
          class: "sval-emoji-row",
          role: "row",
        });
        row.append(...buttons.slice(i, i + COLUMNS));
        stash.before(row);
      }
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "input":
        this._filter(this._els.search.value);
        break;
      case "click":
        this._onClick(event);
        break;
      case "keydown":
        this._onKeyDown(event);
        break;
    }
  },

  /**
   * Shows the emoji whose names match, and the groups that still have one.
   *
   * @param {string} query What was typed.
   */
  _filter(query) {
    const matches = new Set(searchEmoji(this._groups, query));
    const shown = new Set();
    for (const { entry, button, section } of this._records) {
      const visible = matches.has(entry);
      button.hidden = !visible;
      if (visible) {
        shown.add(section);
      }
    }
    for (const section of this._stashes.keys()) {
      section.hidden = !shown.has(section);
    }
    this._els.empty.hidden = shown.size > 0;
    this._layRows();
    this._els.grid.scrollTop = 0;
    this._setRoving(this._visible()[0]?.button ?? null);
  },

  /**
   * @returns {Array<{entry: Array, button: Element}>} the emoji on show.
   */
  _visible() {
    return this._records.filter(r => !r.button.hidden);
  },

  /**
   * Makes one grid button the one Tab reaches, as in any grid: the rest are
   * reached by arrow keys, so a keyboard user does not tab through every
   * emoji to leave the dialog.
   *
   * @param {Element|null} button
   */
  _setRoving(button) {
    for (const { button: other } of this._records) {
      other.setAttribute("tabindex", other === button ? "0" : "-1");
    }
  },

  /**
   * Answers and closes the dialog.
   *
   * @param {string} value The emoji, or "" for none.
   */
  _choose(value) {
    this._args.result = { ok: true, value };
    this._close();
  },

  _close() {
    this._args.tone = this._tone;
    if (this._inline) {
      this._args.answer();
      return;
    }
    window.close();
  },

  _onClick(event) {
    const target = event.target.closest?.("button, sval-button");
    if (!target) {
      return;
    }
    if (target.classList.contains("sval-emoji-choice")) {
      const record = this._records.find(r => r.button === target);
      this._choose(emojiAtTone(record.entry, this._tone));
    } else if (target.classList.contains("sval-emoji-none")) {
      this._choose("");
    } else if (target.classList.contains("sval-emoji-cancel")) {
      this._close();
    } else if (target.classList.contains("sval-emoji-tone")) {
      this._setTone(target.dataset.tone === "" ? null : +target.dataset.tone);
    }
  },

  /**
   * Re-draws the emoji that have tones at the chosen one.
   *
   * @param {number|null} tone 0 to 4, or null for the default.
   */
  _setTone(tone) {
    this._tone = tone;
    // A radio group: the chosen tone is the one Tab reaches, and the arrow
    // keys move the choice (`_onToneKeyDown`).
    for (const button of this._toneButtons()) {
      const own = button.dataset.tone === "" ? null : +button.dataset.tone;
      button.setAttribute("aria-checked", String(own === tone));
      button.setAttribute("tabindex", own === tone ? "0" : "-1");
    }
    for (const { entry, button } of this._records) {
      if (entry[2]) {
        button.textContent = emojiAtTone(entry, tone);
      }
    }
  },

  _onKeyDown(event) {
    const { search } = this._els;
    if (this._inline && event.key === "Escape") {
      event.preventDefault();
      this._close();
      return;
    }
    if (event.target === search) {
      if (event.key === "ArrowDown") {
        this._focusButton(this._visible()[0]?.button);
        event.preventDefault();
      } else if (event.key === "Enter") {
        const first = this._visible()[0];
        if (first) {
          this._choose(emojiAtTone(first.entry, this._tone));
        }
        event.preventDefault();
      }
      return;
    }
    if (event.target.classList?.contains("sval-emoji-tone")) {
      this._onToneKeyDown(event);
      return;
    }
    if (!event.target.classList?.contains("sval-emoji-choice")) {
      return;
    }
    const visible = this._visible().map(r => r.button);
    const at = visible.indexOf(event.target);
    let next;
    switch (event.key) {
      case "ArrowRight":
        next = visible[at + 1];
        break;
      case "ArrowLeft":
        next = visible[at - 1];
        break;
      case "ArrowDown":
        next = this._neighbourRow(visible, event.target, 1);
        break;
      case "ArrowUp":
        next = this._neighbourRow(visible, event.target, -1);
        if (!next) {
          search.focus();
          event.preventDefault();
          return;
        }
        break;
      case "Home":
        next = visible[0];
        break;
      case "End":
        next = visible[visible.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    this._focusButton(next);
  },

  _onToneKeyDown(event) {
    const tones = this._toneButtons();
    const at = tones.indexOf(event.target);
    let next;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = tones[(at + 1) % tones.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = tones[(at - 1 + tones.length) % tones.length];
        break;
      default:
        return;
    }
    event.preventDefault();
    this._setTone(next.dataset.tone === "" ? null : +next.dataset.tone);
    next.focus();
  },

  /**
   * The button in the next row up or down that sits nearest across. Rows are
   * found from where the buttons are drawn, because each group starts a new
   * row and a group's last row can be short, so the row above or below may
   * belong to another group and hold fewer cells.
   *
   * @param {Element[]} visible The buttons on show.
   * @param {Element} from The focused button.
   * @param {number} direction 1 for down, -1 for up.
   * @returns {Element|undefined}
   */
  _neighbourRow(visible, from, direction) {
    const origin = from.getBoundingClientRect();
    let rowTop = null;
    let best;
    let bestDistance = Infinity;
    for (const button of visible) {
      const rect = button.getBoundingClientRect();
      const dy = rect.top - origin.top;
      if (direction * dy < 1) {
        continue;
      }
      if (rowTop === null || Math.abs(dy) < Math.abs(rowTop - origin.top)) {
        rowTop = rect.top;
        bestDistance = Infinity;
      }
      if (rect.top !== rowTop) {
        continue;
      }
      const distance = Math.abs(rect.left - origin.left);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = button;
      }
    }
    return best;
  },

  _focusButton(button) {
    if (!button) {
      return;
    }
    this._setRoving(button);
    button.focus();
    button.scrollIntoView({ block: "nearest" });
  },
};

// Not `defer`: a chrome page served as XHTML runs its scripts as the parser
// reaches them, so this script runs before the body exists.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => SvalEmojiPicker.start(), {
    once: true,
  });
} else {
  SvalEmojiPicker.start();
}
