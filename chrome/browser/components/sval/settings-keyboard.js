/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings' Keyboard shortcuts pane: Sval's keys and Firefox's, in Sval's
 * words (`SvalShortcuts.arrange`), and the way to change Firefox's.
 *
 * Changing a key is Firefox's own, through its `CustomKeys` actor, which
 * `about:preferences` gets in place of `about:keyboard`: the parent lists
 * the window's keys and changes, clears and resets them in `CustomKeys`,
 * and while a key is being changed it captures the next keystroke on the
 * page's `<browser>`, reserved keys too, and sends it back. The page is
 * privileged, so it talks to the child actor's methods directly.
 *
 * The pane is drawn the first time it shows, and again after a change, so
 * what it says is what the window's `<key>`s say.
 *
 * The click that opens a link in a Quick Peek is a row of its own, changed the way
 * a key is: Change waits for a click on its field, with the modifiers held
 * down, or for Enter pressed with them. The page takes that click itself,
 * since `CustomKeys` captures keys alone. The click is one of
 * `SvalQuickPeek.QUICK_PEEK_CLICKS`; Clear turns Quick Peek off, as Settings › Links' switch
 * does, by writing the same pref.
 */

"use strict";

{
  const PANE = "paneSvalKeyboard";
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
    BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
    arrange: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
    clickModifiers: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    clickText: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
    QUICK_PEEK_CLICK_PREF:
      "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    QUICK_PEEK_CLICKS:
      "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    PANEL_GROUP: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
    QUICK_PEEK_PREF: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    quickPeekClickText:
      "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
    shortcutText: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });

  const SvalKeyboardSettings = {
    _actor: null,
    _editing: null,

    get _chromeDoc() {
      return window.browsingContext.topChromeWindow.document;
    },

    get _list() {
      return document.getElementById("sval-keys-list");
    },

    /** The page's `CustomKeys` child actor, made on first use. */
    get actor() {
      if (!this._actor) {
        this._actor = window.windowGlobalChild.getActor("CustomKeys");
        this._actor.RPMAddMessageListener("CustomKeys:CapturedKey", message =>
          this._onCaptured(message.data).catch(err =>
            lazy.SvalLog.warn(
              `a shortcut was not changed: ${lazy.SvalLog.errorName(err)}`
            )
          )
        );
      }
      return this._actor;
    },

    /**
     * Once the panes' markup is in place. The pane may be showing already,
     * when the page opened on it.
     */
    init() {
      document.l10n.addResourceIds(["browser/customkeys.ftl"]);
      // Ctrl+Tab is Firefox's `ctrlTab`, which no `<key>` names, so the list
      // does not draw it.
      const ctrlTab = lazy.shortcutText({
        modifiers: "control",
        keycode: "VK_TAB",
      });
      for (const el of document.querySelectorAll(".sval-ctrl-tab-key")) {
        el.textContent = ctrlTab;
      }
      const drawOnce = () => {
        if (this._drawn) {
          return;
        }
        this._drawn = true;
        this.draw().catch(err =>
          lazy.SvalLog.warn(
            `the shortcuts did not load: ${lazy.SvalLog.errorName(err)}`
          )
        );
      };
      document.addEventListener("paneshown", event => {
        if (event.detail.category === PANE) {
          drawOnce();
        }
      });
      if (
        document.querySelector(`.sval-pane[data-category="${PANE}"]`)
          ?.hidden === false
      ) {
        drawOnce();
      }
      document
        .getElementById("sval-keys-reset-all")
        .addEventListener("click", () =>
          this._resetAll().catch(err =>
            lazy.SvalLog.warn(
              `the shortcuts were not reset: ${lazy.SvalLog.errorName(err)}`
            )
          )
        );
      this._list.addEventListener("click", event => {
        const button = event.target.closest("button[data-action]");
        if (button?.closest(".sval-keys-quick-peek")) {
          this._actClick(button);
        } else if (button) {
          this._act(button).catch(err =>
            lazy.SvalLog.warn(
              `a shortcut was not changed: ${lazy.SvalLog.errorName(err)}`
            )
          );
        }
      });
      // Pressing Cancel would take the focus from the field, and the field's
      // focusout would end the change and hide Cancel before its click.
      this._list.addEventListener("mousedown", event => {
        if (event.target.closest('button[data-action="cancel"]')) {
          event.preventDefault();
        }
      });
      this._list.addEventListener("focusout", event => {
        if (event.target.classList.contains("sval-keys-new")) {
          this._stopEditing(false);
        }
      });
      const redrawClick = () => {
        const row = this._list.querySelector(".sval-keys-quick-peek");
        if (row) {
          this._updateClick(row);
        }
      };
      for (const pref of [lazy.QUICK_PEEK_PREF, lazy.QUICK_PEEK_CLICK_PREF]) {
        Services.prefs.addObserver(pref, redrawClick);
      }
      window.addEventListener(
        "unload",
        () => {
          for (const pref of [
            lazy.QUICK_PEEK_PREF,
            lazy.QUICK_PEEK_CLICK_PREF,
          ]) {
            Services.prefs.removeObserver(pref, redrawClick);
          }
        },
        { once: true }
      );
    },

    /**
     * `groups` with the titles that are ids in `sval/launcher.ftl`
     * (`SvalShortcuts.SVAL_SHORTCUTS`) in their words.
     *
     * @param {object[]} groups `arrange`'s answer.
     * @returns {Promise<object[]>}
     */
    async _translated(groups) {
      window.MozXULElement.insertFTLIfNeeded("sval/launcher.ftl");
      const isId = title => title.startsWith("launcher-");
      const ids = groups.flatMap(group => [
        group.title,
        ...group.entries.map(entry => entry.title),
      ]);
      const wanted = [...new Set(ids.filter(isId))];
      const values = wanted.length
        ? await document.l10n.formatValues(wanted)
        : [];
      const words = new Map(wanted.map((id, i) => [id, values[i]]));
      const word = title => words.get(title) ?? title;
      return groups.map(group => ({
        ...group,
        title: word(group.title),
        entries: group.entries.map(entry => ({
          ...entry,
          title: word(entry.title),
        })),
      }));
    },

    /** Firefox's keys, their titles translated. */
    async _firefoxKeys() {
      const keys = await this.actor.sendQuery("CustomKeys:GetKeys");
      const ids = [];
      for (const [category, entries] of Object.entries(keys)) {
        if (category.startsWith("customkeys-")) {
          ids.push(category);
        }
        for (const data of Object.values(entries)) {
          if (data.title.startsWith("customkeys-")) {
            ids.push(data.title);
          }
        }
      }
      const values = ids.length ? await document.l10n.formatValues(ids) : [];
      const texts = new Map(ids.map((id, i) => [id, values[i]]));
      const translated = {};
      for (const [category, entries] of Object.entries(keys)) {
        const into = (translated[texts.get(category) ?? category] ??= {});
        for (const [id, data] of Object.entries(entries)) {
          into[id] = { ...data, title: texts.get(data.title) ?? data.title };
        }
      }
      return translated;
    },

    async draw() {
      const arranged = lazy.arrange(await this._firefoxKeys(), this._chromeDoc);
      const panelGroup = arranged.findIndex(
        group => group.title === lazy.PANEL_GROUP
      );
      const groups = await this._translated(arranged);
      const list = this._list;
      const switches = document.getElementById("sval-keys-panel-switches");
      const sections = groups.map((group, g) => {
        const section = document.createElement("section");
        section.className = "sval-card sval-keys-group";
        const heading = document.createElement("h2");
        heading.id = `sval-keys-group-${g}`;
        heading.textContent = group.title;
        section.setAttribute("aria-labelledby", heading.id);
        const table = document.createElement("table");
        table.className = "sval-keys-table";
        table.setAttribute("aria-labelledby", heading.id);
        const body = document.createElement("tbody");
        group.entries.forEach((entry, i) =>
          body.append(this._row(entry, `sval-keys-${g}-${i}`))
        );
        table.append(body);
        section.append(heading);
        // The switches move with each drawing, so a redrawn list keeps them.
        if (g === panelGroup) {
          section.append(switches);
          switches.hidden = false;
        }
        section.append(table);
        return section;
      });
      list.replaceChildren(...sections);
    },

    /**
     * @param {object} entry One of `arrange`'s entries.
     * @param {string} id The row's id, which its controls are described by.
     * @returns {Element} the `<tr>`.
     */
    _row(entry, id) {
      const row = document.createElement("tr");
      row.className = "sval-keys-row";
      const name = document.createElement("th");
      name.scope = "row";
      name.id = `${id}-name`;
      name.textContent = entry.title;
      const shortcut = document.createElement("td");
      shortcut.id = `${id}-key`;
      shortcut.className = "sval-keys-shortcut";
      const actions = document.createElement("td");
      actions.className = "sval-keys-actions";
      row.append(name, shortcut, actions);
      if (entry.quickPeekClick) {
        return this._clickRow(row, entry, id);
      }
      if (!entry.remappable) {
        this._showShortcut(shortcut, entry.shortcut);
        return row;
      }
      row.dataset.id = entry.id;
      const button = (action, label) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sval-button";
        el.dataset.action = action;
        el.textContent = label;
        el.setAttribute("aria-describedby", `${name.id} ${shortcut.id}`);
        return el;
      };
      const input = document.createElement("input");
      input.className = "sval-field sval-keys-new";
      input.readOnly = true;
      input.hidden = true;
      input.setAttribute("aria-label", `New shortcut for ${entry.title}`);
      input.placeholder = "Press the new key";
      // The capture takes every key, so Escape or Tab, or this, ends a change
      // (`_onCaptured`).
      const cancel = button("cancel", "Cancel");
      cancel.hidden = true;
      const buttons = document.createElement("div");
      buttons.className = "sval-keys-buttons";
      buttons.append(
        button("change", "Change"),
        input,
        cancel,
        button("clear", "Clear"),
        button("reset", "Reset")
      );
      actions.append(buttons);
      this._update(row, entry);
      return row;
    },

    /**
     * The Quick Peek's click's row: Change, a field that takes the new click, and
     * Cancel, Clear and Reset, as a key's row has.
     *
     * @param {Element} row
     * @param {object} entry
     * @param {string} id
     * @returns {Element} the row.
     */
    _clickRow(row, entry, id) {
      row.classList.add("sval-keys-quick-peek");
      const button = (action, label) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sval-button";
        el.dataset.action = action;
        el.textContent = label;
        el.setAttribute("aria-describedby", `${id}-name ${id}-key`);
        return el;
      };
      const input = document.createElement("input");
      input.className = "sval-field sval-keys-new";
      input.readOnly = true;
      input.hidden = true;
      input.setAttribute("aria-label", `New click for ${entry.title}`);
      input.placeholder = "Hold the keys and click here";
      input.addEventListener("mousedown", event =>
        this._onClickCaptured(event)
      );
      input.addEventListener("click", event => this._onClickCaptured(event));
      input.addEventListener("contextmenu", event => event.preventDefault());
      input.addEventListener("keydown", event => this._onClickKey(event));
      input.addEventListener("keyup", event => this._onClickKey(event));
      const cancel = button("cancel", "Cancel");
      cancel.hidden = true;
      const buttons = document.createElement("div");
      buttons.className = "sval-keys-buttons";
      buttons.append(
        button("change", "Change"),
        input,
        cancel,
        button("clear", "Clear"),
        button("reset", "Reset")
      );
      row.querySelector(".sval-keys-actions").append(buttons);
      this._updateClick(row);
      return row;
    },

    /**
     * Shows the Quick Peek's click as the prefs have it: "Off" while Quick Peek is off.
     *
     * @param {Element} row
     */
    _updateClick(row) {
      const shortcut = lazy.quickPeekClickText();
      this._showShortcut(
        row.querySelector(".sval-keys-shortcut"),
        shortcut || "Off"
      );
      row.classList.toggle("sval-keys-unassigned", !shortcut);
      row.querySelector('[data-action="reset"]').hidden =
        shortcut === lazy.clickText(lazy.QUICK_PEEK_CLICKS[0]);
      row.querySelector('[data-action="clear"]').hidden = !shortcut;
    },

    /** @param {Element} button One of the Quick Peek's click's row's buttons. */
    _actClick(button) {
      const row = button.closest(".sval-keys-row");
      switch (button.dataset.action) {
        case "change": {
          this._editing = row;
          row.classList.add("sval-keys-editing");
          button.hidden = true;
          const input = row.querySelector(".sval-keys-new");
          input.hidden = false;
          input.value = "";
          delete input.dataset.refusal;
          row.querySelector('[data-action="cancel"]').hidden = false;
          input.focus();
          break;
        }
        case "cancel":
          this._stopEditing(true);
          break;
        case "clear":
          Services.prefs.setBoolPref(lazy.QUICK_PEEK_PREF, false);
          row.querySelector('[data-action="change"]').focus();
          break;
        case "reset":
          this._setClick(lazy.QUICK_PEEK_CLICKS[0]);
          row.querySelector('[data-action="change"]').focus();
          break;
      }
    },

    /**
     * Makes `modifiers` the Quick Peek's click, and turns Quick Peek on.
     *
     * @param {string} modifiers One of `QUICK_PEEK_CLICKS`.
     */
    _setClick(modifiers) {
      if (modifiers === lazy.QUICK_PEEK_CLICKS[0]) {
        Services.prefs.clearUserPref(lazy.QUICK_PEEK_CLICK_PREF);
      } else {
        Services.prefs.setStringPref(lazy.QUICK_PEEK_CLICK_PREF, modifiers);
      }
      Services.prefs.setBoolPref(lazy.QUICK_PEEK_PREF, true);
    },

    /**
     * Why a click cannot be the Quick Peek's, or null when it can: "middle", "menu",
     * "tab", "window" or "other". Firefox answers which clicks open a tab or
     * a window (`BrowserUtils.whereToOpenLink`); the Quick Peek's click takes
     * Firefox's place only for the ones `QUICK_PEEK_CLICKS` lists.
     *
     * @param {MouseEvent|KeyboardEvent} event
     * @param {number} button The button clicked.
     * @returns {?string}
     */
    _clickRefusal(event, button) {
      if (button === 1) {
        return "middle";
      }
      if (
        button === 0 &&
        lazy.QUICK_PEEK_CLICKS.includes(lazy.clickModifiers(event))
      ) {
        return null;
      }
      // Gecko makes a click with Control on macOS a right click
      // (`dom.event.treat_ctrl_click_as_right_click.disabled`).
      if (button === 2) {
        return "menu";
      }
      switch (lazy.BrowserUtils.whereToOpenLink(event)) {
        case "tab":
        case "tabshifted":
          return "tab";
        case "window":
          return "window";
      }
      return "other";
    },

    /**
     * A refusal's words, for a click with `modifiers`.
     *
     * @param {string} refusal As `_clickRefusal` answers.
     * @param {string} modifiers
     * @returns {string}
     */
    _refusalText(refusal, modifiers) {
      const click = lazy.clickText(modifiers);
      switch (refusal) {
        case "middle":
          return "Middle-click opens a new tab";
        case "menu":
          return `${click} opens the context menu`;
        case "tab":
          return `${click} opens a new tab`;
        case "window":
          return `${click} opens a new window`;
      }
      return `${click} can’t open a Quick Peek`;
    },

    /**
     * A press or a click on the field while the Quick Peek's click is being
     * changed. The first button counts as it clicks, so the field it lands
     * on stays until the click is over; the middle button and macOS's
     * Control-click as they press, since no `click` follows them. A plain
     * click, and any other right click, leave the field waiting.
     *
     * @param {MouseEvent} event
     */
    _onClickCaptured(event) {
      const row = event.target.closest(".sval-keys-row");
      if (this._editing !== row) {
        return;
      }
      // Keeps the field's focus, and a middle click from pasting or
      // scrolling.
      event.preventDefault();
      const macRightClick =
        lazy.AppConstants.platform === "macosx" && event.ctrlKey;
      const takes =
        event.type === "click"
          ? event.button === 0 && !!lazy.clickModifiers(event)
          : event.button === 1 || (event.button === 2 && macRightClick);
      if (takes) {
        this._takeClick(row, event, event.button);
      }
    },

    /**
     * A key on the field while the Quick Peek's click is being changed: Escape
     * ends the change, Enter with the modifiers held is the click, and a
     * modifier shows what is held so far. Tab leaves the field, which ends
     * the change (`init`'s `focusout`).
     *
     * @param {KeyboardEvent} event
     */
    _onClickKey(event) {
      const row = event.target.closest(".sval-keys-row");
      if (this._editing !== row) {
        return;
      }
      const input = row.querySelector(".sval-keys-new");
      if (event.type === "keydown" && event.key === "Escape") {
        event.preventDefault();
        this._stopEditing(true);
        return;
      }
      if (event.type === "keydown" && event.key === "Enter") {
        event.preventDefault();
        if (lazy.clickModifiers(event)) {
          this._takeClick(row, event, 0);
        }
        return;
      }
      if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) {
        const modifiers = lazy.clickModifiers(event);
        input.value = modifiers ? lazy.clickText(modifiers) : "";
        delete input.dataset.refusal;
      }
    },

    /**
     * Takes a click as the Quick Peek's, or says in the field why it cannot be.
     *
     * @param {Element} row
     * @param {MouseEvent|KeyboardEvent} event
     * @param {number} button
     */
    _takeClick(row, event, button) {
      const refusal = this._clickRefusal(event, button);
      const input = row.querySelector(".sval-keys-new");
      if (refusal) {
        input.dataset.refusal = refusal;
        input.value = this._refusalText(refusal, lazy.clickModifiers(event));
        input.select();
        return;
      }
      delete input.dataset.refusal;
      this._setClick(lazy.clickModifiers(event));
      this._stopEditing(true);
    },

    /**
     * Writes a shortcut into its cell with a line break allowed after each
     * "+", so a key like Ctrl+Shift+Delete wraps between keys when the
     * window is narrow or the text is large.
     *
     * @param {Element} cell
     * @param {string} text
     */
    _showShortcut(cell, text) {
      cell.replaceChildren();
      text.split(/(?<=\+)/).forEach((part, i) => {
        if (i) {
          cell.append(document.createElement("wbr"));
        }
        cell.append(part);
      });
    },

    /**
     * Shows what a key is now.
     *
     * @param {Element} row
     * @param {object} data `{ shortcut, isCustomized }`.
     */
    _update(row, data) {
      this._showShortcut(
        row.querySelector(".sval-keys-shortcut"),
        data.shortcut || "None"
      );
      row.classList.toggle("sval-keys-unassigned", !data.shortcut);
      row.querySelector('[data-action="reset"]').hidden = !data.isCustomized;
      row.querySelector('[data-action="clear"]').hidden = !data.shortcut;
    },

    _rows() {
      return [...this._list.querySelectorAll(".sval-keys-row[data-id]")];
    },

    async _act(button) {
      const row = button.closest(".sval-keys-row");
      const id = row.dataset.id;
      switch (button.dataset.action) {
        case "change": {
          this._editing = row;
          row.classList.add("sval-keys-editing");
          button.hidden = true;
          const input = row.querySelector(".sval-keys-new");
          input.hidden = false;
          input.value = "";
          row.querySelector('[data-action="cancel"]').hidden = false;
          input.focus();
          // In the parent, so that reserved keys reach it too.
          this.actor.sendAsyncMessage("CustomKeys:CaptureKey", true);
          break;
        }
        case "cancel":
          this._stopEditing(true);
          break;
        case "clear":
          this._update(
            row,
            await this.actor.sendQuery("CustomKeys:ClearKey", id)
          );
          row.querySelector('[data-action="change"]').focus();
          break;
        case "reset": {
          const data = await this.actor.sendQuery(
            "CustomKeys:GetDefaultKey",
            id
          );
          if (await this._handleConflict(row, data.shortcut)) {
            this._update(
              row,
              await this.actor.sendQuery("CustomKeys:ResetKey", id)
            );
          }
          row.querySelector('[data-action="change"]').focus();
          break;
        }
      }
    },

    /**
     * Ends a change: the capture stops and the Change button is back.
     *
     * @param {boolean} focus Whether the Change button takes focus.
     */
    _stopEditing(focus) {
      const row = this._editing;
      if (!row) {
        return;
      }
      this._editing = null;
      if (!row.classList.contains("sval-keys-quick-peek")) {
        this.actor.sendAsyncMessage("CustomKeys:CaptureKey", false);
      }
      row.classList.remove("sval-keys-editing");
      const input = row.querySelector(".sval-keys-new");
      input.hidden = true;
      input.value = "";
      row.querySelector('[data-action="cancel"]').hidden = true;
      const change = row.querySelector('[data-action="change"]');
      change.hidden = false;
      if (focus) {
        change.focus();
      }
    },

    /**
     * Whether `shortcut` may go to `row`'s key. If another key has it, the
     * user is asked, and a yes clears that key, as Firefox's page does.
     *
     * @param {Element} row
     * @param {string} shortcut
     * @returns {Promise<boolean>}
     */
    async _handleConflict(row, shortcut) {
      const other = this._rows().find(
        r =>
          r !== row &&
          r.querySelector(".sval-keys-shortcut").textContent === shortcut
      );
      if (!other) {
        return true;
      }
      const name = other.querySelector("th").textContent;
      if (
        !window.confirm(
          `${shortcut} is already the shortcut for "${name}". Use it here instead?`
        )
      ) {
        return false;
      }
      this._update(
        other,
        await this.actor.sendQuery("CustomKeys:ClearKey", other.dataset.id)
      );
      return true;
    },

    /**
     * A keystroke the parent captured while a key is being changed. Escape,
     * and Tab or Shift+Tab, end the change instead, so the keyboard can
     * always leave the field.
     *
     * @param {object} data `CustomKeysParent.handleEvent`'s message.
     */
    async _onCaptured(data) {
      const row = this._editing;
      if (!row) {
        return;
      }
      const input = row.querySelector(".sval-keys-new");
      if (
        (!data.modifiers && data.keycode === "VK_ESCAPE") ||
        (data.keycode === "VK_TAB" && ["", "shift"].includes(data.modifiers))
      ) {
        this._stopEditing(true);
        return;
      }
      if (data.isModifier) {
        input.value = data.modifierString;
        input.select();
        return;
      }
      if (!data.isValid) {
        input.value = "Not a shortcut key";
        input.select();
        return;
      }
      data.id = row.dataset.id;
      this._editing = null;
      this.actor.sendAsyncMessage("CustomKeys:CaptureKey", false);
      try {
        if (await this._handleConflict(row, data.shortcut)) {
          this._update(
            row,
            await this.actor.sendQuery("CustomKeys:ChangeKey", data)
          );
        }
      } finally {
        this._editing = row;
        this._stopEditing(true);
      }
    },

    async _resetAll() {
      if (!window.confirm("Reset every shortcut to Sval's default?")) {
        return;
      }
      await this.actor.sendQuery("CustomKeys:ResetAll");
      this._setClick(lazy.QUICK_PEEK_CLICKS[0]);
      await this.draw();
    },
  };

  window.SvalKeyboardSettings = SvalKeyboardSettings;
}
