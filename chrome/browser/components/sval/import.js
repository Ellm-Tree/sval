/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's import page (import spec §5), opened by `SvalImport.askImport`.
 *
 * The page is `SvalImportPicker` (`import-picker.js`) with Import and Cancel,
 * or a single Close when no browser is found. Import runs the choices through
 * `window.arguments[0].run`, which the opener gives, and the page stays open
 * through the import (messages spec §7): one row per browser, an overall bar,
 * then the result and Done. Given `window.arguments[0].plan`, the page skips
 * the picker and runs that plan as it opens. What arrived is summed by the
 * opener, from each run's own report.
 */

/* import-globals-from import-picker.js */

"use strict";

/**
 * How long the dialog waits for the browsers to be read before it shows
 * anyway, as first run waits for its engines.
 */
const IMPORT_READ_WAIT_MS = 2000;

const { raceTimeout } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTimeout.sys.mjs"
);
const { importFailureKind } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { BOOKMARKS_TO } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
);
const { harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { SvalLog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { readCard } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCard.sys.mjs"
);
const { renderCard } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
);

/** What a row's state is called, for a screen reader reading the list. */
const ROW_STATES = {
  running: "Importing",
  done: "Imported",
  failed: "Failed",
};

const SvalImportPage = {
  start() {
    this._args = window.arguments?.[0] ?? {};
    this._els = {
      form: document.querySelector("form"),
      dialog: document.querySelector("sval-dialog"),
      picker: document.querySelector(".sval-im-picker"),
      run: document.querySelector(".sval-im-run"),
      rows: document.querySelector(".sval-im-progress"),
      bar: document.querySelector(".sval-im-bar"),
      result: document.querySelector(".sval-im-result"),
      card: document.querySelector(".sval-im-card"),
      said: document.querySelector(".sval-im-said"),
      import: document.querySelector(".sval-im-import"),
      cancel: document.querySelector(".sval-im-cancel"),
      done: document.querySelector(".sval-im-done"),
    };
    /** One per entry the page has run: `{ entry, row, state, kind }`. */
    this._items = [];
    this._report = {
      workspaces: [],
      tabs: 0,
      favorites: 0,
      history: 0,
      failed: [],
    };
    this._busy = false;

    this._els.cancel.addEventListener("click", () => window.close());
    this._els.done.addEventListener("click", () => window.close());
    // While a run is under way the page holds the only view of it, so
    // Escape, which `SubDialog` takes as closing, waits for Done.
    window.addEventListener("keydown", event => {
      if (this._busy && event.key === "Escape") {
        event.preventDefault();
      }
    });

    // Only first run hands the page a plan, and its Done is where first run
    // ends.
    if (this._args.plan?.length) {
      this._els.done.textContent = "Start browsing";
      this._els.done.dataset.ends = "first-run";
      this._showRun();
      this._els.picker.hidden = true;
      this._els.dialog.pending = Promise.resolve().then(() => this._fix());
      return this._run(this._args.plan.map(entry => this._addItem(entry)));
    }
    return this._startPicker();
  },

  /**
   * Draws the picker, and on Import runs what it holds.
   *
   * @returns {Promise<void>} The browsers being read.
   */
  _startPicker() {
    const { import: importButton, cancel } = this._els;
    const picker = new SvalImportPicker(this._els.picker, {
      roots: this._args.roots,
      onChange: () => {
        importButton.disabled = !picker.hasChoices();
        const nothing = picker.loaded && !picker.found();
        importButton.hidden = nothing;
        cancel.textContent = nothing ? "Close" : "Cancel";
      },
    });
    this._els.form.addEventListener("submit", event => {
      event.preventDefault();
      const plan = picker.plan();
      if (!plan.length) {
        return;
      }
      this._els.picker.hidden = true;
      this._showRun();
      this._run(plan.map(entry => this._addItem(entry)));
    });

    // The dialog is sized once, when it is ready, so it waits for the
    // browsers to be drawn if they come in time. The page is then fixed at
    // that height, and a row opened later scrolls inside the list.
    const reading = picker.load();
    this._els.dialog.pending = raceTimeout(
      reading.catch(() => {}),
      IMPORT_READ_WAIT_MS,
      window
    ).then(() => this._fix());
    return reading;
  },

  /** Fixes the page at its height now, which `SubDialog` sizes the box to. */
  _fix() {
    const root = document.documentElement;
    root.style.height = `${Math.ceil(this._els.dialog.getBoundingClientRect().height)}px`;
    root.toggleAttribute("data-sized", true);
  },

  /** Swaps the choosing buttons for Done. */
  _showRun() {
    this._els.run.hidden = false;
    this._els.import.hidden = true;
    this._els.cancel.hidden = true;
    this._els.done.hidden = false;
  },

  /**
   * Adds a progress row for a plan entry.
   *
   * @param {object} entry
   * @returns {object} The item.
   */
  _addItem(entry) {
    const row = document.createElement("li");
    row.className = "sval-im-progress-row";
    const glyph = document.createElement("span");
    glyph.className = "sval-im-progress-glyph";
    glyph.setAttribute("aria-hidden", "true");
    const logo = SvalImportPicker.logo(
      document,
      entry.browser.source,
      "sval-im-progress-logo"
    );
    const name = document.createElement("span");
    name.className = "sval-im-progress-name";
    name.textContent = SvalImportPicker.entryName(entry);
    const state = document.createElement("span");
    state.className = "sval-im-progress-state sval-visually-hidden";
    row.append(glyph, logo, name, state);
    this._els.rows.append(row);
    const item = { entry, row, state: "running", kind: null };
    this._items.push(item);
    return item;
  },

  /**
   * @param {object} item
   * @param {string} state One of {@link ROW_STATES}' keys.
   */
  _setState(item, state) {
    item.state = state;
    item.row.dataset.state = state;
    item.row.querySelector(".sval-im-progress-state").textContent =
      `, ${ROW_STATES[state]}`;
  },

  /**
   * Runs `items`' entries through the opener, ticking each row as its
   * browser finishes, then shows the result.
   *
   * @param {object[]} items
   * @returns {Promise<void>}
   */
  _run(items) {
    const { bar, done, result, said, run } = this._els;
    this._busy = true;
    done.disabled = true;
    run.setAttribute("aria-busy", "true");
    result.replaceChildren();
    said.textContent = "";
    bar.max = items.length;
    bar.value = 0;
    for (const item of items) {
      this._setState(item, "running");
    }
    return (async () => {
      let report = null;
      try {
        report = await this._args.run(
          items.map(item => item.entry),
          progress => {
            const item = items[progress.done - 1];
            if (item) {
              item.kind = progress.kind;
              item.error = progress.error;
              this._setState(item, progress.ok ? "done" : "failed");
            }
            bar.value = progress.done;
          }
        );
      } catch (err) {
        SvalLog.error(`import: the run stopped: ${SvalLog.errorName(err)}`);
        // The run stopped short: what it did not finish did not arrive.
        for (const item of items) {
          if (item.state === "running") {
            item.kind = importFailureKind(err);
            item.error = err?.name ?? "Error";
            this._setState(item, "failed");
          }
        }
        bar.value = items.length;
      }
      if (report) {
        this._report.workspaces.push(...report.workspaces);
        this._report.tabs += report.tabs;
        this._report.favorites += report.favorites;
        this._report.history += report.history;
        this._report.card ||= !!report.card;
      }
      this._showResult();
      this._busy = false;
      run.removeAttribute("aria-busy");
      done.disabled = false;
      done.focus();
      if (this._report.card && this._els.card.hidden) {
        await this._showCard();
      }
    })();
  },

  /**
   * Shows the card Arc gave its user, arriving with its reveal, and grows
   * the dialog to hold it.
   *
   * @returns {Promise<void>}
   */
  async _showCard() {
    const card = readCard();
    if (!card) {
      return;
    }
    let box;
    try {
      box = await renderCard(document, card, { reveal: true });
    } catch (err) {
      SvalLog.warn(
        `import: the card could not be drawn: ${SvalLog.errorName(err)}`
      );
      return;
    }
    const { card: holder, said, done } = this._els;
    holder.prepend(box);
    holder.hidden = false;
    said.textContent += ` ${holder.querySelector(".sval-im-card-note").textContent.trim().replace(/\s+/g, " ")}`;
    // `_fix` pinned the page at the height its dialog opened at, with the
    // run scrolling inside. With the card in, the page drops the pin and
    // `SubDialog` sizes the frame to its natural height, once it is laid
    // out; `resizeDialog` also moves focus to the page's default, so Done
    // gets it back.
    const root = document.documentElement;
    root.style.height = "";
    root.removeAttribute("data-sized");
    window.requestAnimationFrame(() => {
      window.resizeDialog?.();
      done.focus();
    });
  },

  /** Writes the result lines and says them, and answers what arrived. */
  _showResult() {
    this._report.failed = this._items
      .filter(item => item.state === "failed")
      .map(item => item.entry.browser.source);
    const lines = SvalImportPicker.resultLines(
      document,
      this._items,
      this._report,
      (command, button, item) => this._act(command, button, item)
    );
    this._els.result.replaceChildren(...lines);
    this._els.said.textContent = lines
      .map(line => line.querySelector(".sval-im-result-text").textContent)
      .join(" ");
  },

  /**
   * Acts on a result line's button.
   *
   * @param {string} command
   * @param {Element} button
   * @param {object} item
   */
  async _act(command, button, item) {
    if (this._busy) {
      return;
    }
    switch (command) {
      case "retrySource":
        await this._run([item]);
        return;
      case "importBookmarksFile":
        await this._importFile();
        return;
      case "sendReport":
        this._sendReport(item);
    }
  },

  /**
   * Asks for a bookmarks file and imports it to Favorites, where a picker
   * row's bookmarks go unless the user chooses otherwise.
   */
  async _importFile() {
    // Another button pressed while the native picker is up would start a
    // second run beside this one.
    this._busy = true;
    try {
      await this._pickAndImport();
    } finally {
      this._busy = false;
    }
  },

  /** {@link _importFile}'s work. */
  async _pickAndImport() {
    const path = await SvalImportPicker.pickBookmarksFile(window);
    if (!path) {
      return;
    }
    const { browser, bookmarksName } = SvalImportPicker.fileBrowser(path);
    const entry = {
      browser,
      harvest: null,
      windows: [],
      bookmarks: BOOKMARKS_TO.favorites,
      bookmarksName,
      history: false,
      autoArchive: null,
    };
    const item = this._addItem(entry);
    try {
      entry.harvest = await harvestBrowser(browser);
    } catch (err) {
      SvalLog.warn(
        `import: a bookmarks file failed: ${SvalLog.errorName(err)}`
      );
      item.kind = importFailureKind(err);
      item.error = err?.name ?? "Error";
      this._setState(item, "failed");
      this._showResult();
      return;
    }
    await this._run([item]);
  },

  /**
   * Send Report…: closes the page, and the feedback form opens in its place
   * with the failure as its context (feedback spec §2).
   *
   * @param {object} item The failed item.
   */
  _sendReport(item) {
    this._args.sendReport?.(SvalImportPicker.reportContext(item));
    window.close();
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => SvalImportPage.start(), {
    once: true,
  });
} else {
  SvalImportPage.start();
}
