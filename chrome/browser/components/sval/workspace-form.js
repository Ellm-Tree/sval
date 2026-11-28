/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The fields a workspace or group is made and edited with: a name, an emoji
 * and a colour. The workspace and group dialog (`new-workspace.js`) and first
 * run's Workspace step (`first-run.js`) draw the same fields, so a first
 * Workspace is named as every later one is. Their look is `new-workspace.css`
 * on `sval-dialog.css`'s field classes.
 *
 * The form only collects what was typed and chosen. What counts as a name, a
 * colour or an emoji is `SvalPanelModel`'s, applied by the caller. A classic
 * script in a chrome document, so the modules come through `ChromeUtils`.
 */

"use strict";

const SvalWorkspaceForm = (() => {
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const { SvalColor } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const { SvalColorPicker } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColorPicker.sys.mjs"
  );

  const HTML_NS = "http://www.w3.org/1999/xhtml";

  function make(doc, tag, attrs = {}, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }
    el.append(...children);
    return el;
  }

  return class {
    /**
     * The fields' markup, in the order the dialog lays them out: the name
     * beside the emoji button, the name's error line, then the colours.
     *
     * @param {Document} doc
     * @returns {Element[]}
     */
    static fields(doc) {
      return [
        make(
          doc,
          "div",
          { class: "sval-nw-row" },
          make(
            doc,
            "div",
            { class: "sval-dialog-field sval-nw-name-field" },
            make(
              doc,
              "label",
              { class: "sval-dialog-label", for: "sval-nw-name" },
              "Name"
            ),
            make(doc, "input", {
              class: "sval-dialog-input sval-nw-name",
              id: "sval-nw-name",
              type: "text",
              autocomplete: "off",
            })
          ),
          make(
            doc,
            "div",
            { class: "sval-dialog-field" },
            make(
              doc,
              "span",
              { class: "sval-dialog-label", id: "sval-nw-emoji-label" },
              "Emoji"
            ),
            make(
              doc,
              "sval-button",
              {
                class: "sval-nw-emoji",
                "aria-labelledby": "sval-nw-emoji-label sval-nw-emoji-value",
              },
              make(doc, "span", {
                class: "sval-nw-emoji-value",
                id: "sval-nw-emoji-value",
              })
            )
          )
        ),
        make(doc, "span", {
          class: "sval-dialog-error",
          id: "sval-nw-name-error",
          "aria-live": "polite",
        }),
        // Filled by the colour section (`SvalColorPicker`).
        make(doc, "div", { class: "sval-dialog-field sval-nw-color" }),
      ];
    }

    /**
     * Binds the fields {@link fields} drew inside `root`.
     *
     * @param {Element} root What holds the fields.
     * @param {object} options
     * @param {boolean} [options.tintsWindow] Whether the colour is a
     *   workspace's, which tints its window: each swatch is then filled with
     *   the window's colour, and otherwise with a group's block.
     * @param {object} [options.blockSurface] The window a group's block sits
     *   on (`SvalColor.groupBlock`); Sval's untinted one when absent.
     * @param {string} [options.name] What the fields start with.
     * @param {string|object|null} [options.color]
     * @param {number} [options.transparency] A Workspace's.
     * @param {string} [options.emoji]
     * @param {Function} [options.onChange] Called with the field that changed,
     *   `name`, `color` or `emoji`, and for `color` whether the change is
     *   done (false while a drag goes on).
     * @param {Function} [options.onPickEmoji] Called when the emoji button is
     *   pressed.
     */
    constructor(
      root,
      {
        tintsWindow = false,
        blockSurface = null,
        name = "",
        color = null,
        transparency = 0,
        emoji = "",
        onChange = () => {},
        onPickEmoji = () => {},
      } = {}
    ) {
      this._onChange = onChange;
      this._doc = root.ownerDocument;
      this.els = {
        name: root.querySelector(".sval-nw-name"),
        emoji: root.querySelector(".sval-nw-emoji"),
        emojiValue: root.querySelector(".sval-nw-emoji-value"),
        nameError: root.querySelector(".sval-dialog-error"),
      };
      this.els.name.value = name;
      /** @type {string} The chosen emoji, or "". */
      this._emoji = emoji;
      const win = this._doc.defaultView;
      this.picker = new SvalColorPicker(root.querySelector(".sval-nw-color"), {
        kind: tintsWindow ? "workspace" : "group",
        color,
        transparency,
        context: () => ({
          scheme: win.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
          more: win.matchMedia("(prefers-contrast: more)").matches,
          on: blockSurface,
          seeThrough: SvalColor.seeThroughMaterial(
            AppConstants.platform,
            query => win.matchMedia(query).matches
          ),
        }),
        onChange: ({ done }) => this._onChange("color", done),
      });
      this.els.colors = root.querySelector(".sval-nw-colors");
      this.els.colorName = root.querySelector(".sval-nw-color-name");
      // The swatches and the wheel are drawn for the appearance, so they
      // follow it.
      for (const query of [
        "(prefers-color-scheme: dark)",
        "(prefers-contrast: more)",
        "(prefers-reduced-transparency: reduce)",
      ]) {
        win
          .matchMedia(query)
          .addEventListener("change", () => this.picker.refresh());
      }
      this._syncEmoji();

      this.els.name.addEventListener("input", () => {
        this.showNameError("");
        this._onChange("name");
      });
      this.els.emoji.addEventListener("click", () => onPickEmoji());
    }

    /** @returns {string} what the name field holds. */
    get name() {
      return this.els.name.value;
    }

    /** @returns {string|object|null} the chosen colour. */
    get color() {
      return this.picker.color;
    }

    /** @returns {number} the chosen transparency, as a save stores it. */
    get transparency() {
      return this.picker.chosenTransparency;
    }

    /** @returns {string} the chosen emoji, or "". */
    get emoji() {
      return this._emoji;
    }

    /** @param {string} value An emoji, or "" for none. */
    set emoji(value) {
      this._emoji = value;
      this._syncEmoji();
      this._onChange("emoji");
    }

    _syncEmoji() {
      this.els.emojiValue.textContent = this._emoji || "Add…";
      this.els.emojiValue.toggleAttribute("data-empty", !this._emoji);
    }

    /**
     * Shows why the fields cannot be taken under the name field, tied to it
     * as its description, or clears both.
     *
     * @param {string} error "" for none.
     */
    showNameError(error) {
      const { name, nameError } = this.els;
      nameError.textContent = error;
      name.setAttribute("aria-invalid", error ? "true" : "false");
      if (error) {
        name.setAttribute("aria-describedby", nameError.id);
      } else {
        name.removeAttribute("aria-describedby");
      }
    }

    /**
     * Refuses a blank name, saying so under the field and putting focus
     * there.
     *
     * @returns {boolean} whether the name is one the caller can take.
     */
    checkName() {
      if (this.els.name.value.trim()) {
        return true;
      }
      this.showNameError("Name can’t be empty.");
      this.els.name.focus();
      return false;
    }
  };
})();
