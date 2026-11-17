/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's cards for how Sval looks and lists: Appearance's panel side and
 * address bar, Search and Launcher's Launcher sections (launcher spec §5),
 * and Workspaces' switcher and pins row line limit.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    DISPLAY_PREF: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
    addressTail: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
    displayDomain: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
    fitAddress: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
    tailChunks: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
    LAUNCHER_PREFS:
      "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
    PINS_LINES_PREF: "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs",
    STRIP_NAMES: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    STRIP_NAMES_PREF:
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    STRIP_WHEELS: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    STRIP_WHEEL_PREF:
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    SWITCHER_KINDS: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    SWITCHER_PREF: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    stripTranslate: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
    SECTION_LIMIT_PREFS:
      "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    launcherLimit:
      "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
    launcherOrder:
      "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
  });

  /** How long each step of a switcher choice's preview shows. */
  const PREVIEW_STEP_MS = 1400;

  /**
   * The Workspaces a switcher choice's preview draws: their colours, the
   * second-to-last none.
   */
  const PREVIEW_COLORS = [
    "#1F6BFF",
    "#FFC22A",
    null,
    "#22C55E",
    "#14B8A6",
    "#EF4444",
    "#F97316",
  ];

  /** The preview's width, and its strip's tiles, named and not, and gap. */
  const PREVIEW = { width: 104, named: 34, icon: 13, gap: 2, rows: 5 };

  /** The page the address bar card shows an example of. */
  const EXAMPLE_ADDRESS =
    "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/?servings=24#reviews";

  const SvalAppearanceSettings = {
    /**
     * Finds and wires the Panel side, Pins and Launcher sections cards.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initAppearance(byId, lifetime) {
      Object.assign(this._els, {
        sideStatus: byId("sval-side-status"),
      });
      for (const radio of document.querySelectorAll(
        'input[name="sval-side"]'
      )) {
        radio.addEventListener("change", () =>
          this.choosePanelSide(radio.value)
        );
      }
      // What the address bar shows, which about:config can move too.
      const example = byId("sval-urlbar-example");
      const [exampleHost, exampleTail] = example.children;
      let exampleChunks = [];
      const fitExample = () =>
        lazy.fitAddress(
          { label: example, tail: exampleTail, key: null },
          exampleChunks
        );
      new ResizeObserver(fitExample).observe(example);
      const showDisplay = () => {
        const mode = Services.prefs.getStringPref(lazy.DISPLAY_PREF, "domain");
        this._selectRadio("sval-urlbar-display", mode);
        const uri = Services.io.newURI(EXAMPLE_ADDRESS);
        exampleHost.textContent = lazy.displayDomain(uri);
        exampleChunks =
          mode === "domain"
            ? []
            : lazy.tailChunks(lazy.addressTail(uri, EXAMPLE_ADDRESS, mode));
        fitExample();
      };
      for (const radio of document.querySelectorAll(
        'input[name="sval-urlbar-display"]'
      )) {
        radio.addEventListener("change", () =>
          Services.prefs.setStringPref(lazy.DISPLAY_PREF, radio.value)
        );
      }
      showDisplay();
      lifetime.pref(lazy.DISPLAY_PREF, showDisplay);
      // The pins row's line limit, which settings sync can move too.
      const pinsLines = document.getElementById("sval-pins-lines");
      const showPinsLines = () => {
        pinsLines.value = String(
          Services.prefs.getIntPref(lazy.PINS_LINES_PREF, 4)
        );
      };
      pinsLines.addEventListener("change", () =>
        Services.prefs.setIntPref(lazy.PINS_LINES_PREF, Number(pinsLines.value))
      );
      showPinsLines();
      lifetime.pref(lazy.PINS_LINES_PREF, showPinsLines);
      this._initSwitcher(lifetime);
      // The Launcher's sections, which settings sync can move too.
      const drawSections = () =>
        this._drawLauncherSections().catch(err =>
          lazy.SvalLog.error(
            `drawing the Launcher's sections failed: ${lazy.describeError(err)}`
          )
        );
      drawSections();
      for (const name of Object.values(lazy.LAUNCHER_PREFS)) {
        lifetime.pref(name, drawSections);
      }
    },

    /**
     * Wires the Workspace switcher card: which switcher the panel shows, and
     * for the strip what it shows and what the wheel does over it. The
     * strip's two groups show only while Strip is chosen. Each choice applies
     * as it is checked, and every window follows the pref.
     *
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initSwitcher(lifetime) {
      const groups = [
        ["sval-switcher", lazy.SWITCHER_PREF, lazy.SWITCHER_KINDS],
        ["sval-strip-names", lazy.STRIP_NAMES_PREF, lazy.STRIP_NAMES],
        ["sval-strip-wheel", lazy.STRIP_WHEEL_PREF, lazy.STRIP_WHEELS],
      ];
      const options = document.getElementById("sval-strip-options");
      for (const [name, pref, values] of groups) {
        const show = () => {
          const value = Services.prefs.getStringPref(pref, values[0]);
          this._selectRadio(name, values.includes(value) ? value : values[0]);
          if (pref === lazy.SWITCHER_PREF) {
            options.hidden = value !== "strip";
          }
        };
        for (const radio of document.querySelectorAll(
          `input[name="${name}"]`
        )) {
          radio.addEventListener("change", () =>
            Services.prefs.setStringPref(pref, radio.value)
          );
        }
        show();
        lifetime.pref(pref, show);
      }
      this._drawSwitcherPreviews();
    },

    /**
     * Draws each switcher choice's preview, and steps it every
     * {@link PREVIEW_STEP_MS}: the menu opening over its button, the strip
     * sliding from one Workspace to the next in each way it shows names, and
     * the wheel sliding the strip or stepping along it. Under reduced motion
     * each shows one still step.
     */
    _drawSwitcherPreviews() {
      const previews = Array.from(
        document.querySelectorAll(".sval-pick-preview"),
        box => ({ box, draw: this._buildSwitcherPreview(box) })
      );
      const still = window.matchMedia("(prefers-reduced-motion: reduce)");
      let step = 1;
      let timer = null;
      const draw = () => {
        for (const { draw: drawOne } of previews) {
          drawOne(step);
        }
      };
      const follow = () => {
        window.clearInterval(timer);
        timer = null;
        step = 1;
        draw();
        if (!still.matches) {
          timer = window.setInterval(() => {
            step++;
            draw();
          }, PREVIEW_STEP_MS);
        }
      };
      still.addEventListener("change", follow);
      follow();
    },

    /**
     * Builds one preview's picture and returns what draws it at a step.
     *
     * @param {Element} box A `.sval-pick-preview`, whose `data-preview` is
     *   the value of its choice.
     * @returns {function(number): void}
     */
    _buildSwitcherPreview(box) {
      const kind = box.dataset.preview;
      const make = (className, parent) => {
        const el = document.createElement("span");
        el.className = className;
        parent.append(el);
        return el;
      };
      const paint = (el, color) => {
        if (color) {
          el.style.backgroundColor = color;
        }
      };
      if (kind === "menu") {
        const current = 2;
        const button = make("sval-pv-button", box);
        paint(make("sval-pv-square", button), PREVIEW_COLORS[current]);
        make("sval-pv-text", button);
        const popup = make("sval-pv-popup", box);
        PREVIEW_COLORS.slice(0, PREVIEW.rows).forEach((color, i) => {
          const row = make("sval-pv-row", popup);
          row.toggleAttribute("data-current", i === current);
          paint(make("sval-pv-square", row), color);
          make("sval-pv-text", row);
        });
        return step => popup.toggleAttribute("data-open", step % 3 !== 0);
      }
      const names = { current: "current", none: "none" }[kind] ?? "all";
      const strip = make("sval-pv-strip", box);
      const tiles = PREVIEW_COLORS.map(color => {
        const tile = make("sval-pv-tile", strip);
        paint(make("sval-pv-square", tile), color);
        make("sval-pv-text", tile);
        return tile;
      });
      const dots = make("sval-pv-dots", box);
      const marks = PREVIEW_COLORS.map(() => make("sval-pv-dot", dots));
      const wheel =
        kind === "slide" || kind === "switch"
          ? make("sval-pv-wheel", make("sval-pv-mouse", box))
          : null;
      const plan = {
        strip: step => ({ current: step % 7 }),
        all: step => ({ current: (step + 2) % 7 }),
        current: step => ({ current: (step + 4) % 7 }),
        none: step => ({ current: (step + 1) % 7 }),
        slide: step => ({
          current: 2,
          offset: [0, -36, -72, 0][step % 4],
          turning: step % 4 === 1 || step % 4 === 2,
        }),
        switch: step => ({
          current: [2, 3, 4, 5, 4, 3][step % 6],
          turning: step % 2 === 1,
        }),
      }[kind];
      return step => {
        const { current, offset = 0, turning = false } = plan(step);
        let x = 0;
        let place = null;
        tiles.forEach((tile, i) => {
          const named =
            names === "all" || (names === "current" && i === current);
          const width = named ? PREVIEW.named : PREVIEW.icon;
          tile.style.width = `${width}px`;
          tile.toggleAttribute("data-named", named);
          tile.toggleAttribute("data-current", i === current);
          if (i === current) {
            place = { x, w: width };
          }
          x += width + PREVIEW.gap;
        });
        const total = x - PREVIEW.gap;
        const translate =
          total <= PREVIEW.width
            ? (PREVIEW.width - total) / 2
            : lazy.stripTranslate({
                width: PREVIEW.width,
                total,
                ...place,
                offset,
              });
        strip.style.transform = `translateX(${translate}px)`;
        dots.hidden = total <= PREVIEW.width;
        marks.forEach((mark, i) =>
          mark.toggleAttribute("data-current", i === current)
        );
        wheel?.toggleAttribute("data-turning", turning);
      };
    },

    _describePanelSide() {
      const placement = this.panel?.settings?.placement ?? null;
      this._selectRadio("sval-side", placement);
      this._disableRadios("sval-side", !placement);
    },

    /**
     * Moves the panel in every window through the panel's `_placePanel`, which
     * first run applies its own answer through.
     *
     * @param {string} side `left` or `right`.
     */
    async choosePanelSide(side) {
      const panel = this.panel;
      if (!panel) {
        this._describePanelSide();
        return;
      }
      this._disableRadios("sval-side", true);
      let said = "";
      try {
        await panel.placePanel(side);
      } catch (err) {
        lazy.SvalLog.warn(
          `the panel was not moved: ${lazy.SvalLog.errorName(err)}`
        );
        said = "Couldn't move the Workspace panel.";
      }
      this._els.sideStatus.textContent = said;
      this._describePanelSide();
    },

    /**
     * Draws the Launcher's sections (launcher spec §5): those
     * `browser.sval.launcher.order` lists, in its order, each with its limit,
     * buttons that move it among them and one that hides it; then those it
     * leaves out, which the address bar does not show, each with a button
     * that shows it, last. Each control writes its pref, whose observer draws
     * the list again, keeping the focus on the control it was on.
     */
    async _drawLauncherSections() {
      window.MozXULElement.insertFTLIfNeeded("sval/launcher.ftl");
      const list = document.getElementById("sval-launcher-sections");
      const shown = lazy.launcherOrder();
      const left = Object.keys(lazy.SECTION_LIMIT_PREFS).filter(
        key => !shown.includes(key)
      );
      // A section's name is its heading in the address bar.
      const headings = await document.l10n.formatMessages(
        [...shown, ...left].map(key => ({ id: `launcher-section-${key}` }))
      );
      const names = new Map(
        [...shown, ...left].map((key, i) => [
          key,
          headings[i]?.attributes?.find(a => a.name === "label")?.value ?? "",
        ])
      );
      const focused = document.activeElement?.closest?.(
        "#sval-launcher-sections [data-key]"
      );
      const refocus = focused && {
        key: focused.dataset.key,
        role: focused.dataset.role,
      };
      const writeOrder = next =>
        Services.prefs.setCharPref(lazy.LAUNCHER_PREFS.order, next.join(","));
      const button = (key, role, l10nId, write) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sval-button sval-agent-small";
        el.dataset.key = key;
        el.dataset.role = role;
        document.l10n.setAttributes(el, l10nId, { section: names.get(key) });
        el.addEventListener("click", write);
        return el;
      };
      const rowFor = key => {
        const row = document.createElement("li");
        row.className = "sval-launcher-section";
        row.dataset.section = key;
        const name = document.createElement("span");
        name.className = "sval-lead";
        name.textContent = names.get(key);
        row.append(name);
        return row;
      };
      const listed = shown.map((key, i) => {
        const row = rowFor(key);
        const limit = document.createElement("select");
        limit.className = "sval-agent-select";
        limit.dataset.key = key;
        limit.dataset.role = "limit";
        document.l10n.setAttributes(limit, "launcher-settings-rows", {
          section: names.get(key),
        });
        const value = lazy.launcherLimit(lazy.SECTION_LIMIT_PREFS[key]);
        for (let n = 0; n <= Math.max(10, value); n++) {
          const option = document.createElement("option");
          option.value = String(n);
          if (n === 0) {
            document.l10n.setAttributes(option, "launcher-settings-none");
          } else {
            option.textContent = String(n);
          }
          limit.append(option);
        }
        limit.value = String(value);
        limit.addEventListener("change", () =>
          Services.prefs.setIntPref(
            lazy.SECTION_LIMIT_PREFS[key],
            Number(limit.value)
          )
        );
        const move = (role, l10nId, by) => {
          const el = button(key, role, l10nId, () => {
            const next = [...shown];
            [next[i], next[i + by]] = [next[i + by], next[i]];
            writeOrder(next);
          });
          el.disabled = !shown[i + by];
          return el;
        };
        row.append(
          limit,
          move("up", "launcher-settings-move-up", -1),
          move("down", "launcher-settings-move-down", 1),
          button(key, "hide", "launcher-settings-hide", () =>
            writeOrder(shown.filter(k => k !== key))
          )
        );
        return row;
      });
      const hidden = left.map(key => {
        const row = rowFor(key);
        row.toggleAttribute("data-not-shown", true);
        const note = document.createElement("span");
        note.className = "sval-status-line";
        document.l10n.setAttributes(note, "launcher-settings-not-shown");
        row.append(
          note,
          button(key, "show", "launcher-settings-show", () =>
            writeOrder([...shown, key])
          )
        );
        return row;
      });
      list.replaceChildren(...listed, ...hidden);
      if (refocus) {
        const again = list.querySelector(
          `[data-key="${refocus.key}"][data-role="${refocus.role}"]`
        );
        (again && !again.disabled
          ? again
          : list.querySelector(`[data-key="${refocus.key}"]`)
        )?.focus();
      }
    },
  };

  Object.assign(window.SvalSettings, SvalAppearanceSettings);
}
