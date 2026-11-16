/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What import offers and what the user chose (import spec §5): every browser
 * found on this computer, one row each however many profiles it keeps, what
 * each holds, and for a ticked one the workspaces it brings with their names
 * and contents, where its bookmarks go, and whether its history comes too.
 *
 * Shared by the import page (`import.js`) and first run's import step
 * (`first-run.js`), so both offer the same thing. It writes nothing: `plan()`
 * is what `SvalImport.runImport` takes.
 *
 * A ticked row opens in place, and folds to one line saying what it will
 * import: the names have to be seen before anything is written (0087), and
 * only the browser used last starts ticked, so only one row starts open.
 *
 * A classic script in a chrome document, so the modules come through
 * `ChromeUtils`. Its stylesheet is `import.css`, in the design system's
 * semantic tokens, which each page defines.
 */

"use strict";

const SvalImportPicker = (() => {
  const Color = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const Sources = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
  );
  const Model = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
  );
  const Files = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs"
  );
  const { SvalLog } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLog.sys.mjs"
  );
  const { SvalPasswordManager } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
  );
  const { ARCHIVE_TIMES, DEFAULT_CHOICE, NEVER } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
  );

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const ICONS = "chrome://browser/content/sval/icons/";

  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );

  /**
   * Each browser's logo, beside its name. Firefox ships Chrome's, Opera's,
   * Edge's and Safari's for its own import, Edge's on macOS and Windows and
   * Safari's on macOS alone (its migration `jar.mn`); Sval carries the rest.
   * A logo a platform does not ship is left out, and a URL a build does not
   * register is fatal under test.
   */
  const MIGRATION_BRANDS = "chrome://browser/content/migration/brands/";
  const { platform } = AppConstants;
  const LOGOS = Object.freeze({
    chrome: `${MIGRATION_BRANDS}chrome.png`,
    opera: `${MIGRATION_BRANDS}opera.png`,
    ...((platform === "macosx" || platform === "win") && {
      edge: `${MIGRATION_BRANDS}edge.png`,
    }),
    ...(platform === "macosx" && { safari: `${MIGRATION_BRANDS}safari.png` }),
    brave: "chrome://browser/content/sval/import-brands/brave.png",
    vivaldi: "chrome://browser/content/sval/import-brands/vivaldi.png",
    arc: "chrome://browser/content/sval/import-brands/arc.png",
    dia: "chrome://browser/content/sval/import-brands/dia.png",
    orion: "chrome://browser/content/sval/import-brands/orion.png",
    firefox: "chrome://browser/content/sval/import-brands/firefox.png",
    zen: "chrome://browser/content/sval/import-brands/zen.png",
    html: `${ICONS}folder-open.svg`,
  });

  /** What a logo that is not shipped on this platform falls back to. */
  const NO_LOGO = `${ICONS}globe.svg`;

  const SPACE_UNITS = ["Space", "Spaces"];
  const WORKSPACE_UNITS = ["Workspace", "Workspaces"];

  /** The sources whose profiles each keep cookies of their own. */
  const PROFILE_JARS = new Set([
    "chrome",
    "edge",
    "brave",
    "vivaldi",
    "arc",
    "dia",
  ]);
  /**
   * The sources whose readers never count logins (`harvest.logins` is null),
   * so Sval cannot say whether they hold any (import spec §8).
   */
  const UNCOUNTED_LOGINS = new Set(["safari", "firefox", "zen"]);
  /** What an isolated workspace is, in the panel's words for its mark. */
  const ISOLATED_TEXT =
    "Isolated: sites here can’t see sign-ins from other Workspaces";
  /** A preview lists this many tabs, then says how many more there are. */
  const PREVIEW_TABS = 5;

  const plural = (n, one, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;

  const andList = words =>
    words.length > 1
      ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
      : words[0];

  const capitalized = text => text.charAt(0).toUpperCase() + text.slice(1);

  /**
   * @param {Document} doc
   * @param {string} tag
   * @param {object} [props] Properties to set.
   * @param {object} [props.attrs] Attributes to set.
   * @param {...(Node|string)} children
   * @returns {Element}
   */
  function make(doc, tag, { attrs = {}, ...props } = {}, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    Object.assign(el, props);
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }
    el.append(...children);
    return el;
  }

  /**
   * One of Sval's Lucide glyphs, drawn in its element's `fill`.
   *
   * @param {Document} doc
   * @param {string} name The file name in `icons/`.
   * @param {string} className
   * @returns {Element}
   */
  function glyph(doc, name, className) {
    return make(doc, "img", {
      className,
      src: `${ICONS}${name}.svg`,
      alt: "",
    });
  }

  /**
   * A browser's logo, or a globe where the platform does not ship it.
   *
   * @param {Document} doc
   * @param {string} source A profile's `source`.
   * @param {string} className
   * @returns {Element}
   */
  function logo(doc, source, className) {
    const img = make(doc, "img", {
      className,
      src: LOGOS[source] ?? NO_LOGO,
      alt: "",
    });
    img.addEventListener(
      "error",
      () => {
        img.src = NO_LOGO;
        img.dataset.fallback = "true";
      },
      { once: true }
    );
    return img;
  }

  /** The picker, drawn into one element of a page. */
  class Picker {
    /**
     * @param {Element} root Where the picker draws itself.
     * @param {object} [options]
     * @param {object} [options.roots] Where the readers look, for tests.
     * @param {boolean} [options.logins] Whether to show the logins hand-off
     *   at the picker's foot, folded. First run shows it on its password
     *   manager step instead.
     * @param {boolean} [options.archive] Whether a browser that archived idle
     *   tabs, Arc, offers to keep doing so (idle-tab archive spec §7.5).
     *   First run's import step does.
     * @param {Function} [options.onChange] Called whenever the choices change,
     *   and once the browsers are read.
     */
    constructor(
      root,
      { roots, logins = true, archive = false, onChange = () => {} } = {}
    ) {
      this._root = root;
      this._roots = roots;
      this._showLogins = logins;
      this._offerArchive = archive;
      this._onChange = onChange;
      this._doc = root.ownerDocument;
      /** Whether every browser found has been read. */
      this.loaded = false;
      /**
       * One per browser found: `{ browser, harvest, error, needsAccess,
       * ticked, folded, windows, views, bookmarks, bookmarksName, history,
       * lastUsed, el }`. `windows` is the plan's choices, one per workspace
       * the harvest brings, `{ import, name, isolated }`, where `isolated`
       * is the user's answer on the workspace's line or null while
       * `_isolated` decides it; `views` holds each line's preview state,
       * `{ open, group }`.
       */
      this._rows = [];
      /** @type {Promise|null} The Full Disk Access recheck in flight. */
      this._rechecking = null;
      /** Whether the logins hand-off shows its steps. */
      this._stepsOpen = false;

      const doc = this._doc;
      const status = (className, icon, text) =>
        make(
          doc,
          "p",
          { className: `sval-im-status ${className}` },
          glyph(doc, icon, "sval-im-status-glyph"),
          text
        );
      this._els = {
        // The one live region: what the scan found, a browser Sval can read
        // once access is given, a file added. Its text is changed in place,
        // which a screen reader announces, and a picker on a step not yet
        // shown announces nothing.
        announce: make(doc, "p", {
          className: "sval-visually-hidden",
          attrs: { role: "status" },
        }),
        looking: status(
          "sval-im-looking",
          "loader-circle",
          "Looking for other browsers…"
        ),
        none: status(
          "sval-im-none",
          "badge-info",
          "No other browsers found on this device."
        ),
        sources: make(doc, "ul", {
          className: "sval-im-sources",
          attrs: { "aria-label": "Browsers" },
        }),
        addFile: make(
          doc,
          "button",
          { type: "button", className: "sval-im-pill sval-im-add-file" },
          "Import a bookmarks file…"
        ),
        logins: make(doc, "div", { className: "sval-im-logins", hidden: true }),
      };
      this._els.none.hidden = true;
      const term = (word, rest) => [
        make(doc, "dt", {}, word),
        make(doc, "dd", {}, rest),
      ];
      const defs = make(
        doc,
        "dl",
        { className: "sval-im-defs" },
        ...term(
          "Workspaces",
          "Groups of tabs, like one for work and one for home."
        ),
        ...term("Favorites", "Links you can open from any Workspace.")
      );
      this._els.file = make(
        doc,
        "div",
        { className: "sval-im-file", hidden: true },
        this._els.addFile,
        make(
          doc,
          "p",
          { className: "sval-im-file-hint" },
          "To get a bookmarks file, open your other browser's bookmarks " +
            "manager and choose Export."
        )
      );
      const list = make(
        doc,
        "div",
        { className: "sval-im-list" },
        this._els.looking,
        this._els.none,
        this._els.sources,
        this._els.file
      );
      this._els.addFile.addEventListener("click", () =>
        this._pickFile().catch(err =>
          SvalLog.error(
            `import: could not add a file: ${SvalLog.errorName(err)}`
          )
        )
      );
      root.append(defs, list, this._els.logins, this._els.announce);
      // Full Disk Access is granted in System Settings, outside Sval, so a
      // row waiting on it looks again whenever Sval comes back to the front.
      doc.defaultView.addEventListener("focus", () => this._recheckAccess());
    }

    /**
     * Finds and reads every browser, and draws them.
     *
     * @returns {Promise<void>}
     */
    async load() {
      const browsers = await Sources.findBrowsers(this._roots);
      // A browser read whole and found to hold nothing is not offered.
      this._rows = (await Promise.all(browsers.map(b => this._read(b)))).filter(
        row => !row.harvest || !Model.holdsNothing(row.harvest)
      );
      this._preselect();
      this._els.looking.hidden = true;
      this._els.none.hidden = !!this._rows.length;
      this._els.sources.hidden = !this._rows.length;
      for (const row of this._rows) {
        row.el = this._renderRow(row);
        this._els.sources.append(row.el);
      }
      this.loaded = true;
      // A file's row joins the rows the scan found, so it is offered once
      // they are there.
      this._els.file.hidden = false;
      this._announce(
        this._rows.length
          ? `Found ${plural(this._rows.length, "browser")} to import from.`
          : this._els.none.textContent,
        this._rows.length ? "found" : "none"
      );
      this._sync();
    }

    /**
     * Says `text` through the picker's live region.
     *
     * @param {string} text
     * @param {string} said What it says, as the region's `data-said`: `found`
     *   or `none` for the scan, `unreadable` for a file added, `readable`
     *   for a row access let Sval read.
     */
    _announce(text, said) {
      this._els.announce.dataset.said = said;
      this._els.announce.textContent = text;
    }

    /**
     * Adds a row for a bookmarks HTML file (favorites-native spec §15.3),
     * ticked and open. A file holds bookmarks alone, so its row offers no
     * history and no logins hand-off.
     *
     * @param {string} path
     * @returns {Promise<void>}
     */
    async addFile(path) {
      const already = this._rows.find(
        r => r.browser.source === "html" && r.browser.profiles[0].dir === path
      );
      if (already) {
        already.el.querySelector(".sval-im-tick")?.focus();
        return;
      }
      const name = PathUtils.filename(path);
      const file = Picker.fileBrowser(path);
      const row = await this._read(file.browser);
      row.ticked = !!row.harvest;
      row.history = false;
      row.bookmarksName = file.bookmarksName;
      // In `_rows` before it is drawn: its ids and its radios' group are
      // named by its place there.
      this._rows.push(row);
      row.el = this._renderRow(row);
      this._els.none.hidden = true;
      this._els.sources.hidden = false;
      this._els.sources.append(row.el);
      this._sync();
      // The file picker hands focus back to its button; the new row takes
      // it, or, for a file Sval could not read, the user is told.
      if (row.harvest) {
        row.el.querySelector(".sval-im-tick").focus();
      } else {
        this._announce(`Couldn't read ${name}.`, "unreadable");
      }
    }

    /** Asks for a bookmarks file and adds it. */
    async _pickFile() {
      const path = await Picker.pickBookmarksFile(this._doc.defaultView);
      if (path) {
        await this.addFile(path);
      }
    }

    /** @returns {boolean} whether any browser was found. */
    found() {
      return !!this._rows.length;
    }

    /** @returns {boolean} whether the user's choices import anything. */
    hasChoices() {
      return this._ticked().some(
        row =>
          row.windows.some(w => w.import) ||
          row.bookmarks !== Model.BOOKMARKS_TO.none ||
          row.history
      );
    }

    /** @returns {object[]} what `SvalImport.runImport` takes. */
    plan() {
      return this._ticked().map(row => ({
        browser: row.browser,
        harvest: row.harvest,
        windows: row.windows.map((choice, i) => ({
          import: choice.import,
          name: choice.name,
          isolated: this._windowIsolated(row, i),
        })),
        bookmarks: row.bookmarks,
        bookmarksName: row.bookmarksName,
        history: row.history,
        autoArchive: row.autoArchive?.on ? row.autoArchive.choice : null,
      }));
    }

    /**
     * @returns {string[]} the ticked sources Sval counted no logins in, once
     *   each, so the hand-off can say why they are not on it.
     */
    noLoginSources() {
      const listed = new Set(this.loginSources());
      return [
        ...new Set(
          this._ticked()
            .filter(row => !row.harvest.file)
            .map(row => row.browser.source)
            // A browser with no export steps offers no export at all, so
            // the hand-off neither lists it nor says it has none.
            .filter(
              source => !listed.has(source) && Sources.EXPORT_STEPS[source]
            )
        ),
      ];
    }

    /** @returns {string[]} the ticked sources holding logins, once each. */
    loginSources() {
      return [
        ...new Set(
          this._ticked()
            .filter(row => !row.harvest.file)
            .filter(row => Picker.hasLogins(row.browser.source, row.harvest))
            .map(row => row.browser.source)
        ),
      ];
    }

    /**
     * Whether a source holds logins worth moving: a Chromium source says how
     * many it has, and Safari's, Firefox's and Zen's are never counted, so
     * their hand-off is always offered (import spec §8).
     *
     * @param {string} source A profile's `source`.
     * @param {object} harvest Its harvest.
     * @returns {boolean}
     */
    static hasLogins(source, harvest) {
      return harvest.logins === null
        ? UNCOUNTED_LOGINS.has(source)
        : harvest.logins > 0;
    }

    /**
     * The logins hand-off (import spec §5.1): one notice for every browser
     * being imported. Only exporting differs between browsers, so step 1 has
     * a line for each, and steps 2 and 3 are written once.
     *
     * @param {Document} doc Where to make it.
     * @param {string[]} sources Profile `source`s, once each.
     * @param {object|null} manager The chosen password manager, if any.
     * @param {object} [options]
     * @param {string[]} [options.without] Ticked sources with no saved
     *   logins, named so their absence from the steps is explained.
     * @param {boolean} [options.open] Whether the steps show.
     * @param {Function} [options.onToggle] Given, the notice has a Show steps
     *   button that calls it.
     * @returns {Element} the notice.
     */
    static handoff(
      doc,
      sources,
      manager,
      { without = [], open = true, onToggle } = {}
    ) {
      const names = sources.map(source => Sources.SOURCE_NAMES[source]);
      const noneNames = without.map(w => Sources.SOURCE_NAMES[w]);
      // Every browser ticked has none: the notice says so, and there are no
      // steps to follow.
      if (!sources.length) {
        return make(
          doc,
          "div",
          {
            className: "sval-im-handoff",
            attrs: {
              role: "note",
              "data-logins": "none",
              "data-without": without.join(" "),
            },
          },
          make(
            doc,
            "div",
            { className: "sval-im-handoff-head" },
            glyph(doc, "key-round", "sval-im-handoff-glyph"),
            make(
              doc,
              "div",
              { className: "sval-im-handoff-words" },
              make(
                doc,
                "span",
                { className: "sval-im-handoff-title" },
                "No saved passwords to move"
              ),
              make(
                doc,
                "span",
                { className: "sval-im-handoff-sub" },
                `${andList(noneNames)} ` +
                  `${noneNames.length > 1 ? "have" : "has"} no saved passwords.`
              )
            )
          )
        );
      }
      // Sval can say a browser has logins only when none of the sources
      // is one whose logins are never counted.
      const counted = !sources.some(source => UNCOUNTED_LOGINS.has(source));
      const note = make(doc, "div", {
        className: "sval-im-handoff",
        attrs: {
          role: "note",
          "data-logins": counted ? "counted" : "uncounted",
          "data-without": without.join(" "),
        },
      });
      const words = make(
        doc,
        "div",
        { className: "sval-im-handoff-words" },
        make(
          doc,
          "span",
          { className: "sval-im-handoff-title" },
          "Move your passwords to your password manager"
        ),
        make(
          doc,
          "span",
          { className: "sval-im-handoff-sub" },
          "Sval doesn't import passwords." +
            (counted
              ? ` ${andList(names)} ${names.length > 1 ? "have" : "has"} ` +
                "saved passwords."
              : "") +
            (noneNames.length
              ? ` ${andList(noneNames)} ` +
                `${noneNames.length > 1 ? "have" : "has"} no saved passwords.`
              : "")
        )
      );
      const head = make(
        doc,
        "div",
        { className: "sval-im-handoff-head" },
        glyph(doc, "key-round", "sval-im-handoff-glyph"),
        words
      );
      note.append(head);
      if (onToggle) {
        const toggle = make(
          doc,
          "button",
          {
            type: "button",
            className: "sval-im-pill sval-im-handoff-toggle",
            attrs: { "aria-expanded": String(open) },
          },
          open ? "Hide steps" : "Show steps"
        );
        toggle.addEventListener("click", onToggle);
        head.append(toggle);
      }
      if (!open) {
        return note;
      }

      const step = (n, ...content) =>
        make(
          doc,
          "li",
          {},
          make(
            doc,
            "span",
            {
              className: "sval-im-step-number",
              attrs: { "aria-hidden": "true" },
            },
            String(n)
          ),
          make(doc, "div", { className: "sval-im-step-words" }, ...content)
        );
      const exports = sources.map(source =>
        make(
          doc,
          "div",
          { className: "sval-im-export" },
          logo(doc, source, "sval-im-export-logo"),
          make(
            doc,
            "span",
            {},
            make(doc, "strong", {}, Sources.SOURCE_NAMES[source]),
            ` ${capitalized(Sources.EXPORT_STEPS[source])}`
          )
        )
      );
      const into = manager
        ? [
            `Import the file into ${manager.name}`,
            make(
              doc,
              "span",
              { className: "sval-im-step-detail" },
              `${capitalized(manager.importSteps)}.`
            ),
          ]
        : ["Import the file into the password manager you use."];
      const last = step(
        3,
        "Delete the exported file. Anyone who opens the file can read your passwords."
      );
      last.dataset.tone = "warn";
      const second = step(2, ...into);
      second.dataset.manager = manager?.key ?? "";
      note.append(
        make(
          doc,
          "ol",
          { className: "sval-im-steps" },
          step(
            1,
            names.length > 1
              ? `Export your passwords from ${andList(names)}`
              : `Export your passwords from ${names[0]}`,
            ...exports
          ),
          second,
          last
        )
      );
      return note;
    }

    _ticked() {
      return this._rows.filter(row => row.ticked && row.harvest);
    }

    /**
     * Whether a workspace imports isolated unless the user says otherwise
     * (isolated workspaces spec §8). Each of a Chromium browser's profiles
     * is a cookie jar of its own, so when one import takes workspaces from
     * two or more profiles of one browser, those of every profile but its
     * `Default` keep their accounts apart.
     *
     * @param {object} row
     * @param {number} i The workspace's index.
     * @returns {boolean}
     */
    _isolated(row, i) {
      if (!PROFILE_JARS.has(row.browser.source)) {
        return false;
      }
      const importing = new Set(
        row.harvest.windows
          .filter((win, j) => row.windows[j].import)
          .map(win => win.profile)
      );
      return (
        importing.size > 1 &&
        row.harvest.windows[i].profile !== Model.DEFAULT_PROFILE
      );
    }

    /**
     * Whether one workspace imports isolated: the user's answer on its line,
     * or the default for its profile.
     *
     * @param {object} row
     * @param {number} i The workspace's index.
     * @returns {boolean}
     */
    _windowIsolated(row, i) {
      return row.windows[i].isolated ?? this._isolated(row, i);
    }

    /**
     * Shows each workspace's Isolated switch as it stands: which profiles
     * import can change the default of the others'.
     *
     * @param {object} row
     */
    _showIsolation(row) {
      row.el
        ?.querySelectorAll(".sval-im-window .sval-im-isolate")
        .forEach((button, i) =>
          button.setAttribute(
            "aria-pressed",
            String(this._windowIsolated(row, i))
          )
        );
    }

    /**
     * Reads one browser, all its profiles, so its row can say what it holds.
     *
     * @param {object} browser `{ source, profiles }`.
     * @returns {Promise<object>} the row.
     */
    async _read(browser) {
      const row = {
        browser,
        harvest: null,
        error: false,
        held: false,
        needsAccess: false,
        ticked: false,
        folded: false,
        windows: [],
        views: [],
        bookmarks: Model.BOOKMARKS_TO.favorites,
        bookmarksName: `${Sources.SOURCE_NAMES[browser.source]} Bookmarks`,
        history: true,
        lastUsed: 0,
        el: null,
      };
      const reader = Sources.readerFor(browser.source);
      // Safari's profile directory is the home it was found under.
      if (
        reader.hasFullDiskAccess &&
        !(await reader.hasFullDiskAccess({ home: browser.profiles[0].dir }))
      ) {
        row.needsAccess = true;
        return row;
      }
      try {
        row.harvest = await Sources.harvestBrowser(browser);
      } catch (err) {
        row.error = true;
        row.held = Files.heldOpen(err);
        return row;
      }
      const names = Model.suggestNames(
        row.harvest.windows,
        this._words(browser)
      );
      row.windows = names.map(name => ({ import: true, name, isolated: null }));
      row.views = names.map(() => ({ open: false, group: null }));
      // Checked unless the browser's own choice was never to archive.
      const archived = row.harvest.autoArchive;
      if (this._offerArchive && archived) {
        row.autoArchive = {
          on: archived !== NEVER,
          choice: archived === NEVER ? DEFAULT_CHOICE : archived,
        };
      }
      for (const profile of browser.profiles) {
        try {
          const { lastModified } = await IOUtils.stat(
            profile.lastUsedPath ?? profile.dir
          );
          row.lastUsed = Math.max(row.lastUsed, lastModified);
        } catch {
          // Unreadable: it says nothing about when the browser was used.
        }
      }
      return row;
    }

    /**
     * The suggestions of decision 0087, in this source's name.
     *
     * @param {object} browser `{ source, profiles }`.
     * @returns {{window: Function, workspace: Function}}
     */
    _words(browser) {
      const name = Sources.SOURCE_NAMES[browser.source];
      return {
        window: n => `${name} Window ${n}`,
        workspace: n => `${name} Workspace ${n}`,
      };
    }

    /**
     * Ticks the browser used most recently, which is the one this person is
     * moving from (import spec §11). Every other row starts unticked.
     */
    _preselect() {
      const readable = this._rows.filter(row => row.harvest);
      if (!readable.length) {
        return;
      }
      readable.sort((a, b) => b.lastUsed - a.lastUsed);
      readable[0].ticked = true;
    }

    _el(tag, props, ...children) {
      return make(this._doc, tag, props, ...children);
    }

    /**
     * A row's name: its browser's, or for a bookmarks file, the file's, since
     * two files' rows must be told apart.
     *
     * @param {object} row
     * @returns {string}
     */
    _rowTitle(row) {
      const browser = Sources.SOURCE_NAMES[row.browser.source];
      return row.browser.source === "html"
        ? `${browser} · ${row.browser.profiles[0].name}`
        : browser;
    }

    /**
     * What a row's workspaces are called on it: Spaces when every one is a
     * Space, as Arc's are, and workspaces otherwise.
     *
     * @param {object} row
     * @returns {string[]} singular and plural.
     */
    _units(row) {
      return row.harvest?.windows.length &&
        row.harvest.windows.every(win => win.kind === "space")
        ? SPACE_UNITS
        : WORKSPACE_UNITS;
    }

    /**
     * @param {object} row
     * @returns {boolean} whether this source's groups are folders, as Arc's
     *   and Zen's are.
     */
    _folders(row) {
      return ["arc", "zen"].includes(row.browser.source);
    }

    /**
     * The line under a row's name: what is wrong, what a folded row will
     * import, or what the browser holds.
     *
     * @param {object} row
     * @returns {string}
     */
    _summary(row) {
      if (row.needsAccess) {
        return "To import from Safari, allow Sval in System Settings \u203a Privacy & Security \u203a Full Disk Access.";
      }
      if (row.error) {
        if (row.browser.source === "html") {
          return "Couldn't read this file.";
        }
        return row.browser.source === "arc" || row.held
          ? this._quitFirst(row)
          : "Couldn't read this browser.";
      }
      const c = Model.countHarvest(row.harvest);
      const [unit, units] = this._units(row);
      if (row.ticked && row.folded) {
        const parts = [];
        if (c.windows === 1) {
          parts.push(
            row.windows[0].import ? `“${row.windows[0].name}”` : `no ${unit}`
          );
        } else if (c.windows) {
          const kept = row.windows.filter(w => w.import).length;
          parts.push(`${kept} of ${c.windows} ${units}`);
        }
        if (c.bookmarks) {
          parts.push(
            {
              [Model.BOOKMARKS_TO.favorites]: "bookmarks into Favorites",
              [Model.BOOKMARKS_TO.workspace]:
                `bookmarks into “${row.bookmarksName}”`,
              [Model.BOOKMARKS_TO.none]: "no bookmarks",
            }[row.bookmarks]
          );
        }
        parts.push(row.history ? "history" : "no history");
        return capitalized(parts.join(" · "));
      }
      if (row.harvest.encryptedSession && !c.windows) {
        return `${plural(c.bookmarks, "bookmark")}. Open tabs are encrypted.`;
      }
      const parts = [];
      if (c.windows) {
        parts.push(
          `${plural(c.windows, unit, units)}, ${plural(c.tabs, "tab")}`
        );
      }
      if (c.bookmarks) {
        parts.push(plural(c.bookmarks, "bookmark"));
      }
      let text = parts.length ? parts.join(", ") : "Nothing to import";
      if (row.harvest.unread) {
        text += `. Couldn't read ${plural(row.harvest.unread, "profile")}.`;
      }
      if (row.harvest.held) {
        text += ` Quit ${Sources.SOURCE_NAMES[row.browser.source]}, then try again.`;
      }
      return text;
    }

    /**
     * The line for a browser that cannot be read while it runs.
     *
     * @param {object} row
     * @returns {string}
     */
    _quitFirst(row) {
      const name = Sources.SOURCE_NAMES[row.browser.source];
      return `Can't read ${name} while ${name} is open. Quit ${name}, then try again.`;
    }

    /**
     * Draws a row again, keeping focus on the control that had it.
     *
     * @param {object} row
     * @param {string} [focus] A selector inside the row to focus after.
     */
    _redraw(row, focus) {
      const el = this._renderRow(row);
      row.el.replaceWith(el);
      row.el = el;
      if (focus) {
        el.querySelector(focus)?.focus();
      }
    }

    /**
     * @param {object} row
     * @returns {Element} the `li` for one source row.
     */
    _renderRow(row) {
      const doc = this._doc;
      const problem = !row.harvest;
      const open = row.ticked && !row.folded && !problem;
      const li = this._el("li", { className: "sval-im-source" });
      li.toggleAttribute("data-ticked", row.ticked && !problem);
      li.toggleAttribute("data-problem", problem);
      li.dataset.source = row.browser.source;

      const box = this._el("input", {
        type: "checkbox",
        className: "sval-im-tick",
        checked: row.ticked && !problem,
        disabled: problem,
      });
      box.addEventListener("change", () => {
        row.ticked = box.checked;
        row.folded = false;
        this._redraw(row, ".sval-im-tick");
        this._sync();
      });
      const head = this._el(
        "div",
        { className: "sval-im-source-head" },
        this._el(
          "label",
          { className: "sval-im-source-label" },
          box,
          logo(doc, row.browser.source, "sval-im-logo"),
          this._el(
            "span",
            { className: "sval-im-source-words" },
            this._el(
              "span",
              {
                className: "sval-im-source-name",
                id: this._nameId(row),
              },
              this._rowTitle(row)
            ),
            this._el(
              "span",
              { className: "sval-im-source-summary" },
              this._summary(row)
            )
          )
        )
      );
      if (row.ticked && !problem) {
        const fold = this._el(
          "button",
          {
            type: "button",
            className: "sval-im-fold",
            attrs: {
              "aria-expanded": String(open),
              "aria-label": `${open ? "Hide" : "Show"} ${this._rowTitle(row)} details`,
            },
          },
          glyph(doc, "chevron-down", "sval-im-chevron")
        );
        fold.addEventListener("click", () => {
          row.folded = !row.folded;
          this._redraw(row, ".sval-im-fold");
        });
        head.append(fold);
      }
      li.append(head);

      if (row.needsAccess) {
        const button = this._el(
          "button",
          { type: "button", className: "sval-im-pill sval-im-access-open" },
          "Open System Settings"
        );
        button.addEventListener("click", () => this._openFullDiskAccess());
        li.append(this._el("div", { className: "sval-im-access" }, button));
      }
      if (open) {
        li.append(this._renderDetails(row));
      }
      return li;
    }

    /**
     * @param {object} row
     * @returns {string} the id of the row's name, which names its details.
     */
    _nameId(row) {
      return `sval-im-name-${this._rows.indexOf(row)}`;
    }

    _renderDetails(row) {
      const doc = this._doc;
      const { harvest } = row;
      // A group named for its browser, so two open rows' History boxes say
      // whose they are.
      const details = this._el("div", {
        className: "sval-im-details",
        attrs: { role: "group", "aria-labelledby": this._nameId(row) },
      });
      if (harvest.encryptedSession) {
        const browser = Sources.SOURCE_NAMES[row.browser.source];
        details.append(
          this._el(
            "p",
            { className: "sval-im-note", attrs: { role: "note" } },
            glyph(doc, "badge-info", "sval-im-note-glyph"),
            this._el(
              "span",
              {},
              `${browser} keeps open tabs encrypted, so those tabs don't ` +
                "import. To bring them: in " +
                `${browser}, choose Bookmark All Tabs…, then import that ` +
                "folder into a Workspace."
            )
          )
        );
      }
      if (harvest.windows.length) {
        const [unit] = this._units(row);
        const title =
          unit === WORKSPACE_UNITS[0]
            ? "Workspaces"
            : `Each ${unit} becomes a Workspace`;
        const list = this._el("ul", {
          className: "sval-im-windows",
          attrs: { "aria-label": title },
        });
        harvest.windows.forEach((win, i) => {
          list.append(this._renderWindow(row, win, i));
        });
        details.append(
          this._el(
            "div",
            { className: "sval-im-section" },
            this._el(
              "span",
              { className: "sval-im-label", attrs: { "aria-hidden": "true" } },
              title
            ),
            list,
            this._el(
              "p",
              { className: "sval-im-hint" },
              "Isolated Workspaces have their own sign-ins. A site in one " +
                "doesn’t know you’re signed in to the same site in another."
            )
          )
        );
      }
      if (harvest.bookmarks && Model.countHarvest(harvest).bookmarks) {
        details.append(this._renderBookmarks(row));
      }
      if (harvest.file) {
        return details;
      }
      const historyBox = this._el("input", {
        type: "checkbox",
        checked: row.history,
      });
      historyBox.addEventListener("change", () => {
        row.history = historyBox.checked;
        this._sync();
      });
      details.append(
        this._el(
          "label",
          { className: "sval-im-check" },
          historyBox,
          `Also import history from ${Sources.SOURCE_NAMES[row.browser.source]}`
        )
      );
      if (row.autoArchive) {
        details.append(this._renderAutoArchive(row));
      }
      return details;
    }

    /**
     * "Archive tabs you haven't used, like Arc did", with the time beside it.
     *
     * @param {object} row
     * @returns {Element}
     */
    _renderAutoArchive(row) {
      const box = this._el("input", {
        type: "checkbox",
        className: "sval-im-archive",
        checked: row.autoArchive.on,
      });
      const browser = Sources.SOURCE_NAMES[row.browser.source];
      const after = this._el("select", {
        className: "sval-im-archive-after",
        attrs: { "aria-label": "Archive tabs unused for" },
      });
      for (const time of ARCHIVE_TIMES) {
        const option = this._el("option", { value: time.value }, time.label);
        option.selected = time.value === row.autoArchive.choice;
        after.append(option);
      }
      after.disabled = !row.autoArchive.on;
      box.addEventListener("change", () => {
        row.autoArchive.on = box.checked;
        after.disabled = !box.checked;
        this._sync();
      });
      after.addEventListener("change", () => {
        row.autoArchive.choice = after.value;
        this._sync();
      });
      return this._el(
        "div",
        { className: "sval-im-archive-row" },
        this._el(
          "label",
          { className: "sval-im-check" },
          box,
          `Archive tabs you haven't used, like ${browser} did`
        ),
        after
      );
    }

    _renderWindow(row, win, i) {
      const doc = this._doc;
      const choice = row.windows[i];
      const view = row.views[i];
      const li = this._el("li", { className: "sval-im-window" });
      const box = this._el("input", {
        type: "checkbox",
        checked: choice.import,
      });
      const name = this._el("input", {
        type: "text",
        value: choice.name,
        className: "sval-im-window-name",
        autocomplete: "off",
        spellcheck: false,
        disabled: !choice.import,
        attrs: {
          "aria-label": `Workspace name for ${this._rowTitle(row)} ${this._units(row)[0]} ${i + 1}`,
        },
      });
      box.setAttribute("aria-label", `Import ${choice.name}`);
      box.addEventListener("change", () => {
        choice.import = box.checked;
        name.disabled = !box.checked;
        this._showIsolation(row);
        this._sync();
      });
      name.addEventListener("input", () => {
        choice.name = name.value;
        box.setAttribute("aria-label", `Import ${choice.name}`);
      });
      // The word the panel marks an isolated workspace with, so the user
      // meets it here first (isolated workspaces spec §8, §10).
      const isolate = this._el(
        "button",
        {
          type: "button",
          className: "sval-im-isolate",
          disabled: !choice.import,
          attrs: {
            "aria-pressed": String(this._windowIsolated(row, i)),
            title: ISOLATED_TEXT,
            "aria-description": ISOLATED_TEXT,
          },
        },
        "Isolated"
      );
      isolate.addEventListener("click", () => {
        choice.isolated = !this._windowIsolated(row, i);
        isolate.setAttribute("aria-pressed", String(choice.isolated));
        this._sync();
      });
      box.addEventListener("change", () => {
        isolate.disabled = !box.checked;
      });

      const c = Model.countHarvest({ windows: [win], bookmarks: null });
      const folders = this._folders(row);
      const disclose = this._el(
        "button",
        {
          type: "button",
          className: "sval-im-disclose",
          attrs: { "aria-expanded": String(view.open) },
        },
        plural(c.tabs, "tab") +
          (c.groups
            ? `, ${plural(c.groups, folders ? "folder" : "group")}`
            : ""),
        glyph(doc, "chevron-down", "sval-im-chevron")
      );
      const head = this._el(
        "div",
        { className: "sval-im-window-head" },
        box,
        win.emoji
          ? this._el(
              "span",
              { className: "sval-im-emoji", attrs: { "aria-hidden": "true" } },
              win.emoji
            )
          : "",
        name,
        isolate,
        disclose
      );
      li.append(head);
      let preview = view.open ? this._renderPreview(row, win, view) : null;
      if (preview) {
        li.append(preview);
      }
      disclose.addEventListener("click", () => {
        view.open = !view.open;
        disclose.setAttribute("aria-expanded", String(view.open));
        preview?.remove();
        preview = view.open ? this._renderPreview(row, win, view) : null;
        if (preview) {
          li.append(preview);
        }
      });
      return li;
    }

    /**
     * A read-only picture of a window (import spec §5): its groups as chips,
     * and the tabs of the chip picked, or the tabs in no group when none is.
     * It never scrolls on its own, so it lists a few tabs and counts the rest.
     *
     * @param {object} row
     * @param {object} win A harvest window.
     * @param {{open: boolean, group: number|null}} view Its preview state.
     * @returns {Element}
     */
    _renderPreview(row, win, view) {
      const doc = this._doc;
      const { groups, loose } = Model.windowPreview(win);
      const folders = this._folders(row);
      const box = this._el("div", { className: "sval-im-contents" });
      let list = this._renderTabs(groups, loose, view, folders);
      const chips = groups.map((group, i) => {
        const chip = this._el("button", {
          type: "button",
          className: "sval-im-group",
          attrs: { "aria-pressed": String(view.group === i) },
        });
        if (folders) {
          chip.append(glyph(doc, "folder-open", "sval-im-group-folder"));
        } else if (Color.isPreset(group.color)) {
          chip.dataset.color = group.color;
          const dot = this._el("span", { className: "sval-im-group-dot" });
          dot.style.backgroundColor = Color.markOf(group.color);
          chip.append(dot);
        }
        chip.append(
          group.path.join(" › "),
          this._el(
            "span",
            { className: "sval-im-group-count" },
            String(group.tabs.length)
          )
        );
        chip.addEventListener("click", () => {
          view.group = view.group === i ? null : i;
          chips.forEach((other, j) =>
            other.setAttribute("aria-pressed", String(view.group === j))
          );
          const fresh = this._renderTabs(groups, loose, view, folders);
          list.replaceWith(fresh);
          list = fresh;
        });
        return chip;
      });
      if (chips.length) {
        box.append(
          this._el(
            "div",
            {
              className: "sval-im-nodes",
              attrs: {
                role: "group",
                "aria-label": folders ? "Folders" : "Groups",
              },
            },
            ...chips
          )
        );
      }
      box.append(list);
      return box;
    }

    /**
     * The tabs a preview lists: the picked group's, or those in no group.
     *
     * @param {object[]} groups `windowPreview`'s groups.
     * @param {object[]} loose Its tabs in no group.
     * @param {{group: number|null}} view The preview's state.
     * @param {boolean} folders Whether the groups are folders.
     * @returns {Element}
     */
    _renderTabs(groups, loose, view, folders) {
      const kind = folders ? "folder" : "group";
      const picked = view.group === null ? null : groups[view.group];
      let title;
      let tabs;
      if (picked) {
        title = `${picked.path.join(" › ")} · ${plural(picked.tabs.length, "tab")}`;
        tabs = picked.tabs;
      } else if (loose.length) {
        title = groups.length
          ? `Not in a ${kind} · ${loose.length.toLocaleString()}`
          : plural(loose.length, "tab");
        tabs = loose;
      } else {
        title = `Pick a ${kind} to see its tabs.`;
        tabs = [];
      }
      const list = this._el(
        "div",
        { className: "sval-im-tabs" },
        this._el("span", { className: "sval-im-label" }, title)
      );
      for (const tab of tabs.slice(0, PREVIEW_TABS)) {
        list.append(
          this._el(
            "div",
            { className: "sval-im-tab" },
            this._el("span", {}, tab.title || tab.url)
          )
        );
      }
      if (tabs.length > PREVIEW_TABS) {
        list.append(
          this._el(
            "span",
            { className: "sval-im-more" },
            `and ${(tabs.length - PREVIEW_TABS).toLocaleString()} more`
          )
        );
      }
      return list;
    }

    _renderBookmarks(row) {
      const browser = Sources.SOURCE_NAMES[row.browser.source];
      const fieldset = this._el("fieldset", { className: "sval-im-bookmarks" });
      const count = plural(
        Model.countHarvest(row.harvest).bookmarks,
        "bookmark"
      );
      // A file is named by what it holds; a browser by its own name.
      const whose =
        row.browser.source === "html"
          ? `the file's ${count}`
          : `${browser}'s ${count}`;
      fieldset.append(this._el("legend", {}, `Choose how to import ${whose}:`));
      const group = `sval-im-bm-${this._rows.indexOf(row)}`;
      const name = this._el("input", {
        type: "text",
        value: row.bookmarksName,
        className: "sval-im-bookmarks-name",
        autocomplete: "off",
        spellcheck: false,
        hidden: row.bookmarks !== Model.BOOKMARKS_TO.workspace,
        attrs: { "aria-label": `Workspace name for ${browser} bookmarks` },
      });
      name.addEventListener("input", () => {
        row.bookmarksName = name.value;
      });
      const choices = this._el("div", { className: "sval-im-choices" });
      for (const [value, text] of [
        [Model.BOOKMARKS_TO.favorites, "Into Favorites"],
        [Model.BOOKMARKS_TO.workspace, "Into a Workspace"],
        [Model.BOOKMARKS_TO.none, "Don't import"],
      ]) {
        const radio = this._el("input", {
          type: "radio",
          name: group,
          value,
          checked: row.bookmarks === value,
        });
        radio.addEventListener("change", () => {
          row.bookmarks = value;
          name.hidden = value !== Model.BOOKMARKS_TO.workspace;
          this._sync();
        });
        choices.append(
          this._el("label", { className: "sval-im-check" }, radio, text)
        );
      }
      fieldset.append(choices, name);
      return fieldset;
    }

    /** Brings the logins hand-off in line with the rows, and says so. */
    _sync() {
      const sources = this._showLogins ? this.loginSources() : [];
      const without = this._showLogins ? this.noLoginSources() : [];
      const box = this._els.logins;
      box.hidden = !sources.length && !without.length;
      box.textContent = "";
      if (!box.hidden) {
        const manager = SvalPasswordManager.managerFor(
          SvalPasswordManager.current()
        );
        box.append(
          Picker.handoff(this._doc, sources, manager, {
            without,
            open: this._stepsOpen,
            onToggle: () => {
              this._stepsOpen = !this._stepsOpen;
              this._sync();
              box.querySelector(".sval-im-handoff-toggle")?.focus();
            },
          })
        );
      }
      this._onChange();
    }

    /**
     * Opens System Settings › Privacy & Security › Full Disk Access (spec
     * §4.3), through the macOS shell service Firefox's own Safari import uses.
     */
    _openFullDiskAccess() {
      Cc["@mozilla.org/browser/shell-service;1"]
        .getService(Ci.nsIMacShellService)
        .showSecurityPreferences("Privacy_AllFiles");
    }

    /**
     * Reads again every row still waiting on Full Disk Access. One recheck at
     * a time: two `focus` events while a read is in flight would each replace
     * the row, leaving a checkbox on screen that belongs to a row `_rows` has
     * replaced.
     *
     * @returns {Promise<void>}
     */
    _recheckAccess() {
      this._rechecking ??= this._recheckAccessOnce().finally(() => {
        this._rechecking = null;
      });
      return this._rechecking;
    }

    async _recheckAccessOnce() {
      for (const [i, row] of this._rows.entries()) {
        if (!row.needsAccess) {
          continue;
        }
        const fresh = await this._read(row.browser);
        if (fresh.needsAccess) {
          continue;
        }
        this._rows[i] = fresh;
        fresh.el = row.el;
        // Focus stays on the row as it is drawn again, and what Sval can read
        // with access given is said.
        const focused = row.el.contains(this._doc.activeElement);
        this._redraw(fresh, focused ? ".sval-im-tick" : undefined);
        this._announce(
          `${this._rowTitle(fresh)}: ${this._summary(fresh)}`,
          "readable"
        );
      }
      this._sync();
    }
  }

  /** A browser's logo, for the export page's targets and import's progress. */
  Picker.logo = logo;

  /**
   * Asks, with the native picker, for a bookmarks file to import.
   *
   * @param {Window} win The page's window.
   * @returns {Promise<string|null>} its path, or null when none was chosen.
   */
  Picker.pickBookmarksFile = async win => {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      win.browsingContext,
      "Import a bookmarks file",
      Ci.nsIFilePicker.modeOpen
    );
    picker.appendFilters(Ci.nsIFilePicker.filterHTML);
    picker.appendFilter("Arc export", "*.md");
    const result = await new Promise(resolve => picker.open(resolve));
    return result === Ci.nsIFilePicker.returnOK ? picker.file.path : null;
  };

  /**
   * A bookmarks file as the browser a row reads, and the name its bookmarks
   * are filed under.
   *
   * @param {string} path
   * @returns {{browser: object, bookmarksName: string}}
   */
  Picker.fileBrowser = path => {
    const name = PathUtils.filename(path);
    return {
      browser: {
        source: "html",
        profiles: [{ source: "html", id: path, name, dir: path }],
      },
      bookmarksName: name.replace(/\.(html?|md)$/i, ""),
    };
  };

  /**
   * The name a plan entry's browser goes by: a bookmarks file goes by its
   * file's name, as its picker row does.
   *
   * @param {object} entry A plan entry.
   * @returns {string}
   */
  Picker.entryName = entry => {
    const { source, profiles } = entry.browser;
    return source === "html"
      ? profiles[0].name
      : (Sources.SOURCE_NAMES[source] ?? source);
  };

  /**
   * A run's result lines (messages spec §9.6), as the import page shows
   * them and first run's welcome shows a run that failed: what arrived, when
   * anything did, then a line for each browser that failed, with what can be
   * done about it. With every browser failed and nothing arrived there is
   * nothing to sum up, and each failure has its own line. A browser that
   * failed part way still counts what it brought.
   *
   * @param {Document} doc
   * @param {object[]} items One per entry run, `{ entry, state, kind }`,
   *   `state` being `done` or `failed`.
   * @param {object} report What arrived, summed over the runs.
   * @param {Function} act Called with a line's command, its button and its
   *   item when a button is pressed: `retrySource`, `importBookmarksFile` or
   *   `sendReport`.
   * @returns {Element[]}
   */
  Picker.resultLines = (doc, items, report, act) => {
    const lines = [];
    const { workspaces, favorites } = report;
    if (
      items.some(item => item.state === "done") ||
      workspaces.length ||
      favorites
    ) {
      lines.push(
        resultLine(doc, "success", Model.importReportText(report), [], act)
      );
    }
    for (const item of items) {
      if (item.state === "failed") {
        lines.push(failureLine(doc, item, act));
      }
    }
    return lines;
  };

  /**
   * What Send Report… tells the feedback form of a failed item (feedback
   * spec §2). A bookmarks file is named by the user, often for themselves,
   * so the report names its kind (feedback spec §3.3).
   *
   * @param {object} item A failed item, `{ entry, error }`.
   * @returns {string}
   */
  Picker.reportContext = item =>
    `Import from ${
      item.entry.browser.source === "html"
        ? "a bookmarks file"
        : Picker.entryName(item.entry)
    } failed (${item.error ?? "Error"})`;

  /**
   * @param {Document} doc
   * @param {object} item A failed item.
   * @param {Function} act As {@link Picker.resultLines} takes it.
   * @returns {Element}
   */
  function failureLine(doc, item, act) {
    const name = Picker.entryName(item.entry);
    // A bookmarks file is what every other line suggests, so its own
    // failure says no more than the picker says of a file it cannot read.
    if (item.entry.browser.source === "html") {
      return resultLine(doc, "error", `Couldn't read ${name}.`, [], act);
    }
    const { text, actions } = Model.importFailureLine(name, item.kind);
    const line = resultLine(doc, "error", text, actions, act, item);
    line.dataset.kind = item.kind;
    line.dataset.source = item.entry.browser.source;
    return line;
  }

  /**
   * A result line: a glyph, the sentence, and its buttons on a row beneath.
   *
   * @param {Document} doc
   * @param {"success"|"error"} status
   * @param {string} text
   * @param {object[]} actions `{ label, command }`.
   * @param {Function} act As {@link Picker.resultLines} takes it.
   * @param {object} [item] The item the line is about.
   * @returns {Element}
   */
  function resultLine(doc, status, text, actions, act, item = null) {
    const line = make(doc, "div", { className: "sval-im-result-line" });
    line.dataset.status = status;
    line.append(make(doc, "p", { className: "sval-im-result-text" }, text));
    if (actions.length) {
      const row = make(doc, "div", { className: "sval-im-result-actions" });
      for (const action of actions) {
        const button = make(doc, "button", { type: "button" }, action.label);
        button.dataset.command = action.command;
        button.addEventListener("click", () =>
          Promise.resolve(act(action.command, button, item)).catch(err =>
            SvalLog.error(`import: an action failed: ${SvalLog.errorName(err)}`)
          )
        );
        row.append(button);
      }
      line.append(row);
    }
    return line;
  }

  return Picker;
})();
