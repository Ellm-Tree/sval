/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The night-sky scenes above the introduction's text in first run: the
 * Workspace panel going through three Workspaces, the Launcher finding an
 * open tab and searching one site, and the protection panel open under the
 * address bar's shield.
 *
 * Each scene is Sval's own component, drawn with its own stylesheets from
 * the markup its scripts make, and fed the canned content first run hands
 * in, so the scenes change when the components do. The panel's rows are
 * built as `sval-panel-rows.js` builds them, the Launcher's as `UrlbarView`
 * lays out the address bar's rows and `SvalLauncherRows` finishes them, and
 * the protection panel by `SvalProtectionButton` itself. A scene is a
 * document of its own (`first-run-intro.xhtml`), because those stylesheets
 * are the browser window's.
 *
 * A classic script in a chrome document, loaded before `first-run.js`, so
 * the modules come through `ChromeUtils` and only `SvalFirstRunIntro` is
 * left on the page.
 */

"use strict";

const SvalFirstRunIntro = (() => {
  const { SvalColor } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const { chipElement, drawFoot, footFor, keycap, rowKey } =
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs"
    );
  const { launcherKeyText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
  );
  const { ProtectionButton, glyph, shieldOf } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
  );
  const { scopeForURI } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSite.sys.mjs"
  );
  const { UrlbarUtils } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs"
  );

  const SCENE_URL = "chrome://browser/content/sval/first-run-intro.xhtml";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  /** How long each Workspace shows (first-run revamp spec §3.1). */
  const WORKSPACE_MS = 2700;
  /** The Launcher's pace: a key typed, and a list held to be read. */
  const KEY_MS = 130;
  const HOLD_MS = 2600;
  const OFFER_MS = 900;

  /** The search glass Firefox's switcher and suggestion rows draw. */
  const SEARCH_ICON = "chrome://global/skin/icons/search-glass.svg";
  /** The `@maps` engine's icon, which Sval ships (`SvalSearchConfig`). */
  const MAPS_ICON =
    "chrome://browser/content/sval/search-icons/openstreetmap.png";

  /**
   * Colours for the favicons a scene's canned pages wear, which stand for
   * the sites' own: a letter on one of the palette's base inks.
   */
  const FAVICON_COLORS = [
    "blue",
    "red",
    "purple",
    "green",
    "orange",
    "cyan",
    "pink",
    "gray",
  ];

  /**
   * The browser window first run opens over (`SvalFirstRun`), whose panel
   * paints accents and whose key element names the Launcher's key.
   *
   * @param {Window} win
   * @returns {Window}
   */
  function browserWindow(win) {
    return win.browsingContext.topChromeWindow;
  }

  /**
   * An element of a scene's document.
   *
   * @param {Document} doc
   * @param {string} tag
   * @param {object} [attrs]
   * @param {...(Node|string)} children
   * @returns {Element}
   */
  function make(doc, tag, attrs = {}, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === true) {
        el.setAttribute(name, "");
      } else if (value !== false && value !== null && value !== undefined) {
        el.setAttribute(name, String(value));
      }
    }
    el.append(...children);
    return el;
  }

  /**
   * A canned page's favicon: its first letter on one of the palette's inks,
   * as a blob the scene's policy lets an image load.
   *
   * @param {Document} doc
   * @param {string} title
   * @returns {Promise<string>} the blob's URL.
   */
  function favicon(doc, title) {
    const canvas = doc.createElementNS(HTML_NS, "canvas");
    const size = 32;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const letter = title.trim().charAt(0).toLocaleUpperCase();
    const style = doc.defaultView.getComputedStyle(doc.documentElement);
    const color =
      FAVICON_COLORS[letter.charCodeAt(0) % FAVICON_COLORS.length] ?? "gray";
    ctx.fillStyle = SvalColor.groupMembers(color).base;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 7);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 19px ${style.getPropertyValue("--sval-font")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size / 2 + 1);
    return new Promise(resolve =>
      canvas.toBlob(blob => resolve(doc.defaultView.URL.createObjectURL(blob)))
    );
  }

  /**
   * Fills every `img[data-favicon]` under `root` with its page's favicon.
   *
   * @param {Element} root
   */
  function fillFavicons(root) {
    const doc = root.ownerDocument;
    for (const img of root.querySelectorAll("img[data-favicon]")) {
      favicon(doc, img.dataset.favicon).then(url =>
        img.setAttribute("src", url)
      );
    }
  }

  /**
   * Runs `steps` one after another, each after its delay, and again from
   * the first once the last has run.
   *
   * @param {Window} win
   * @param {Array<[number, Function]>} steps `[delay, step]`, the delay
   *   before the step runs.
   * @returns {Function} stops the loop.
   */
  function loop(win, steps) {
    let timer = null;
    let index = 0;
    const next = () => {
      const [delay, step] = steps[index];
      timer = win.setTimeout(() => {
        step();
        index = (index + 1) % steps.length;
        next();
      }, delay);
    };
    next();
    return () => win.clearTimeout(timer);
  }

  // ---------------------------------------------------------- Workspaces

  /**
   * The scene's window in `color`, solved in the scene's appearance and
   * contrast as `SvalPanel.windowLookOf` solves a browser window's.
   *
   * @param {Document} doc
   * @param {string} color A preset.
   * @returns {object} `SvalColor.windowLook`'s answer.
   */
  function sceneLook(doc, color) {
    const win = doc.defaultView;
    return SvalColor.windowLook(
      { color },
      {
        scheme: win.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
        more: win.matchMedia("(prefers-contrast: more)").matches,
      }
    );
  }

  /**
   * Gives the scene's window `color`'s look, as `SvalPanel._applyWindowTint`
   * gives a browser window its workspace's.
   *
   * @param {Document} doc
   * @param {string} color A preset.
   */
  function tintWindow(doc, color) {
    const root = doc.documentElement;
    const look = sceneLook(doc, color);
    for (const [name, value] of Object.entries(
      SvalColor.windowProperties(look)
    )) {
      root.style.setProperty(name, value);
    }
    root.setAttribute("data-sval-tint", "true");
    root.setAttribute("data-sval-ink", look.side);
  }

  /**
   * One tab's or group's row, as `SvalPanel._rowElement` builds it and
   * `_paintRowState` paints it, for a page that is loaded here.
   *
   * @param {Document} doc
   * @param {object} panel The browser window's `SvalPanel`.
   * @param {object} row
   * @param {string} row.kind "tab" or "group".
   * @param {string} row.name
   * @param {number} row.depth
   * @param {string|null} row.color A group's own colour.
   * @param {string|null} row.tint The colour of the group a tab is in.
   * @param {object} [row.on] The scene's window, which a block sits on.
   * @param {boolean} [row.selected]
   * @param {boolean} [row.end] The last row of its group's block.
   * @returns {Element}
   */
  function panelRow(doc, panel, row) {
    const group = row.kind === "group";
    const el = make(doc, "div", {
      class: "sval-row",
      role: "treeitem",
      "aria-level": row.depth + 1,
      "data-kind": row.kind,
      "aria-expanded": group ? "true" : null,
      "data-sval-group-end": !!row.end,
      "aria-selected": row.selected ? "true" : "false",
      "data-loaded": group ? null : "true",
    });
    el.style.setProperty("--sval-row-depth", String(row.depth));
    const twisty = make(doc, "button", {
      class: "sval-twisty",
      tabindex: "-1",
      "aria-hidden": "true",
    });
    twisty.hidden = !group;
    el.append(twisty);
    if (group) {
      el.append(
        make(doc, "span", { class: "sval-row-folder", "aria-hidden": "true" })
      );
    }
    const tint = row.color ?? row.tint;
    panel.applyAccent(el, tint, "--sval-accent", row.on);
    if (tint) {
      el.setAttribute("data-sval-fill", row.color ? "own" : "inherited");
    }
    if (!group) {
      el.append(
        make(doc, "img", {
          class: "sval-row-icon",
          alt: "",
          "aria-hidden": "true",
          "data-favicon": row.name,
        })
      );
    }
    el.append(
      make(doc, "span", { class: "sval-row-name" }, row.name),
      make(doc, "button", {
        class: "sval-row-audio",
        tabindex: "-1",
        "aria-hidden": "true",
      })
    );
    if (!group) {
      el.append(
        make(doc, "button", {
          class: "sval-row-close",
          tabindex: "-1",
          "aria-hidden": "true",
        })
      );
    }
    return el;
  }

  /**
   * A split's row, as `SvalPanel._splitRowElement` builds it: the split
   * glyph and a tray with each page as a tile, the first the active one.
   *
   * @param {Document} doc
   * @param {string[]} titles The two pages' titles.
   * @returns {Element}
   */
  function splitRow(doc, titles) {
    const el = make(doc, "div", {
      class: "sval-row",
      role: "treeitem",
      "aria-level": 1,
      "aria-expanded": "true",
      "data-kind": "split",
      tabindex: "-1",
    });
    el.style.setProperty("--sval-row-depth", "0");
    const tray = make(doc, "div", {
      class: "sval-split-tray",
      role: "group",
      "data-panes": titles.length,
    });
    titles.forEach((title, index) => {
      tray.append(
        make(
          doc,
          "div",
          {
            class: "sval-split-pane",
            role: "treeitem",
            "aria-level": 2,
            "aria-selected": "false",
            "data-loaded": "true",
            "data-sval-active": index === 0,
          },
          make(doc, "img", {
            class: "sval-row-icon",
            alt: "",
            "aria-hidden": "true",
            "data-favicon": title,
          }),
          make(doc, "span", { class: "sval-split-title" }, title)
        )
      );
    });
    el.append(
      make(doc, "span", { class: "sval-split-glyph", "aria-hidden": "true" }),
      make(doc, "div", { class: "sval-split-body" }, tray)
    );
    return el;
  }

  /**
   * The panel's rows for one Workspace: its loose tabs, its split if it has
   * one, then its group, whose first tab is the one selected.
   *
   * @param {Document} doc
   * @param {object} panel The browser window's `SvalPanel`.
   * @param {object} workspace From the content's `workspaces`.
   * @returns {Element[]}
   */
  function workspaceRows(doc, panel, workspace) {
    const on = sceneLook(doc, workspace.color).block;
    const rows = workspace.tabs.map(name =>
      panelRow(doc, panel, { kind: "tab", name, depth: 0 })
    );
    if (workspace.split) {
      rows.push(splitRow(doc, workspace.split));
    }
    const { group } = workspace;
    rows.push(
      panelRow(doc, panel, {
        kind: "group",
        name: group.name,
        depth: 0,
        color: group.color,
        on,
      }),
      ...group.tabs.map((name, index) =>
        panelRow(doc, panel, {
          kind: "tab",
          name,
          depth: 1,
          tint: group.color,
          on,
          selected: index === 0,
          end: index === group.tabs.length - 1,
        })
      )
    );
    return rows;
  }

  /**
   * The Workspaces scene: a window whose panel shows each Workspace in turn,
   * the window in its tint.
   *
   * @param {Document} doc The scene's document.
   * @param {object} content
   * @returns {{start: Function, still: Function}}
   */
  function workspacesScene(doc, content) {
    const panel = browserWindow(doc.defaultView).SvalPanel;
    const switcher = make(doc, "button", {
      class: "sval-switcher",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    });
    const tree = make(doc, "div", { class: "sval-tree", role: "tree" });
    const container = make(
      doc,
      "div",
      { id: "sval-panel-container" },
      make(
        doc,
        "div",
        { class: "sval-panel" },
        make(doc, "div", { class: "sval-switcher-bar" }, switcher),
        make(
          doc,
          "div",
          { class: "sval-panel-header sval-edge-above" },
          make(
            doc,
            "button",
            { class: "sval-newtab" },
            make(doc, "span", { class: "sval-label" }, content.newTab)
          )
        ),
        tree
      )
    );
    const page = make(
      doc,
      "div",
      { class: "sval-fr-page" },
      make(doc, "span", { class: "sval-fr-page-title" }),
      make(doc, "span", { class: "sval-fr-page-line" }),
      make(doc, "span", { class: "sval-fr-page-line" }),
      make(doc, "span", { class: "sval-fr-page-block" })
    );
    doc.body.append(
      make(doc, "div", { class: "sval-fr-window" }, container, page)
    );

    // Each Workspace's rows are made once, so a turn only swaps them in.
    const drawn = content.workspaces.map(workspace => {
      const rows = workspaceRows(doc, panel, workspace);
      for (const row of rows) {
        fillFavicons(row);
      }
      return rows;
    });
    const show = index => {
      const workspace = content.workspaces[index];
      // As `SvalPanel._renderSwitcher` draws the switcher.
      const tile = make(doc, "span", { class: "sval-switcher-emoji" });
      tile.textContent = workspace.emoji;
      tile.style.setProperty(
        "--sval-switcher-fill",
        SvalColor.css(sceneLook(doc, workspace.color).tint)
      );
      switcher.replaceChildren(
        tile,
        make(doc, "span", { class: "sval-switcher-name" }, workspace.name)
      );
      switcher.setAttribute("data-sval-color", workspace.color);
      tintWindow(doc, workspace.color);
      tree.replaceChildren(
        make(doc, "div", { class: "sval-tree-edge", "aria-hidden": "true" }),
        ...drawn[index],
        make(doc, "div", { class: "sval-tree-edge", "aria-hidden": "true" })
      );
    };
    return {
      still() {
        show(0);
      },
      start() {
        let index = 0;
        show(index);
        return loop(doc.defaultView, [
          [
            WORKSPACE_MS,
            () => {
              index = (index + 1) % content.workspaces.length;
              show(index);
            },
          ],
        ]);
      },
    };
  }

  // ---------------------------------------------------------- the Launcher

  /**
   * A row of the address bar's view, as `UrlbarView` lays one out.
   *
   * @param {Document} doc
   * @param {object} row
   * @param {string} row.type The row's `type`: "switchtab", "search" or
   *   "history".
   * @param {string} row.icon The favicon's address, or a page's title for
   *   a favicon made from it.
   * @param {Node[]} row.title What the title holds, highlights included.
   * @param {Node[]} [row.url] What its address holds.
   * @param {object} [row.action] The action's Fluent id and arguments.
   * @param {string} [row.label] The section heading drawn above the row.
   * @returns {Element}
   */
  function viewRow(doc, row) {
    const item = make(doc, "div", {
      class: "urlbarView-row",
      role: "presentation",
      type: row.type,
      "row-selectable": true,
      "has-url": !!row.url,
      "has-action": !!row.action,
    });
    if (row.label) {
      item.setAttribute("data-l10n-id", row.label);
      item.setAttribute("data-l10n-attrs", "label");
    }
    const inner = make(doc, "span", {
      class: "urlbarView-row-inner",
      role: "option",
    });
    const icon = make(doc, "img", { class: "urlbarView-favicon" });
    if (row.icon.startsWith("chrome:")) {
      icon.setAttribute("src", row.icon);
    } else {
      icon.dataset.favicon = row.icon;
    }
    const title = make(
      doc,
      "span",
      { class: "urlbarView-title urlbarView-overflowable", dir: "auto" },
      ...row.title
    );
    const action = make(doc, "span", { class: "urlbarView-action" });
    if (row.action) {
      doc.l10n.setAttributes(action, row.action.id, row.action.args);
    }
    inner.append(
      make(
        doc,
        "span",
        { class: "urlbarView-no-wrap" },
        icon,
        make(doc, "span", { class: "urlbarView-type-icon" }),
        title,
        make(doc, "span", { class: "urlbarView-tags urlbarView-overflowable" }),
        make(doc, "span", { class: "urlbarView-title-separator" }),
        action
      ),
      make(doc, "span", { class: "urlbarView-url" }, ...(row.url ?? []))
    );
    item.append(inner);
    return item;
  }

  /**
   * `text` with the parts the urlbar highlights for `query` in bold, as
   * `UrlbarView` writes a title or address.
   *
   * @param {Document} doc
   * @param {string} text
   * @param {string} query
   * @param {number} type A `UrlbarUtils.HIGHLIGHT` value.
   * @returns {Node[]}
   */
  function highlighted(doc, text, query, type) {
    const holder = make(doc, "span");
    const tokens = query
      .split(/\s+/)
      .filter(Boolean)
      .map(value => ({ lowerCaseValue: value.toLocaleLowerCase() }));
    UrlbarUtils.addTextContentWithHighlights(
      holder,
      text,
      UrlbarUtils.getTokenMatches(tokens, text, type)
    );
    return [...holder.childNodes];
  }

  /**
   * Selects a row as `UrlbarView#selectElement` does: the row and the part
   * of it that is selectable.
   *
   * @param {Element} item
   */
  function select(item) {
    item.setAttribute("selected", "");
    item.querySelector(".urlbarView-row-inner").setAttribute("selected", "");
  }

  /**
   * The parts `SvalLauncherRows` adds at a row's end: its Workspace chip,
   * and the hint the selected row shows with Enter's cap.
   *
   * @param {Document} doc
   * @param {Element} item A row from {@link viewRow}.
   * @param {object} described
   * @param {string} described.kind
   * @param {object} described.hint `{ id, args }`
   * @param {object|null} [described.chip]
   */
  function finishRow(doc, item, { kind, hint, chip = null }) {
    item.setAttribute("sval-kind", kind);
    const end = make(doc, "span", {
      class: "sval-launcher-end",
      "aria-hidden": "true",
    });
    if (chip) {
      end.append(chipElement(doc, chip));
    }
    const verb = make(doc, "span", { class: "sval-launcher-hint-verb" });
    doc.l10n.setAttributes(verb, hint.id, hint.args);
    end.append(
      make(
        doc,
        "span",
        { class: "sval-launcher-hint" },
        verb,
        make(doc, "kbd", { class: "sval-keycap" }, keycap("VK_RETURN"))
      )
    );
    item.querySelector(".urlbarView-row-inner").append(end);
  }

  /**
   * The foot's keys for a page's or a search's row in a browser window's
   * tab, as `SvalLauncherRows`' `placesFor` finds them there.
   *
   * @returns {object[]}
   */
  function placesFoot() {
    return [
      rowKey("VK_RETURN", "shift", "launcher-foot-new-tab"),
      rowKey("VK_RETURN", "accel,shift", "launcher-foot-new-window"),
      rowKey("VK_RETURN", "alt", "launcher-foot-split"),
    ];
  }

  /**
   * The Launcher scene: the card floating over the page, typing the
   * content's query, its list answering, then an `@` keyword searching one
   * site.
   *
   * @param {Document} doc The scene's document.
   * @param {object} content
   * @returns {{start: Function, still: Function}}
   */
  function launcherScene(doc, content) {
    const words = content.launcher;
    tintWindow(doc, words.color);
    const input = make(doc, "input", {
      class: "urlbar-input textbox-input",
      "data-l10n-id": "urlbar-placeholder",
      tabindex: "-1",
    });
    const box = doc.createXULElement("moz-input-box");
    box.className = "urlbar-input-box";
    box.setAttribute("flex", "1");
    box.append(input);
    const switcher = make(doc, "moz-button", {
      class: "searchmode-switcher chromeclass-toolbar-additional",
      iconsrc: SEARCH_ICON,
      tabindex: "-1",
      role: "presentation",
    });
    const switcherTitle = make(doc, "span", {
      class: "searchmode-switcher-title",
    });
    switcher.append(
      make(
        doc,
        "span",
        { class: "urlbar-visually-hidden", "aria-hidden": "true" },
        "a"
      ),
      make(
        doc,
        "span",
        { class: "searchmode-switcher-content" },
        switcherTitle,
        make(doc, "button", {
          class: "searchmode-switcher-close toolbarbutton-icon close-button",
          tabindex: "-1",
        })
      )
    );
    const container = make(
      doc,
      "div",
      { class: "urlbar-input-container", pageproxystate: "invalid" },
      switcher,
      box,
      make(doc, "img", { class: "urlbar-icon urlbar-go-button" })
    );
    const results = make(doc, "div", {
      class: "urlbarView-results",
      role: "listbox",
    });
    // One line under the list for each of its states, drawn once.
    const footLine = () =>
      make(doc, "div", {
        class: "sval-launcher-foot",
        "aria-hidden": "true",
      });
    const foots = { list: footLine(), offer: footLine(), site: footLine() };
    const urlbar = make(
      doc,
      "div",
      {
        id: "urlbar",
        class: "urlbar",
        breakout: true,
        "breakout-extend": true,
        "sval-launcher-floating": true,
        focused: true,
        open: true,
      },
      make(doc, "div", { class: "urlbar-background" }),
      container,
      make(
        doc,
        "div",
        { class: "urlbarView", role: "group" },
        make(
          doc,
          "div",
          { class: "urlbarView-body-outer" },
          make(
            doc,
            "div",
            { class: "urlbarView-body-inner" },
            results,
            ...Object.values(foots)
          )
        )
      )
    );
    doc.body.append(make(doc, "div", { class: "sval-fr-launcher" }, urlbar));

    const { HIGHLIGHT } = UrlbarUtils;
    // Every row and every foot is made once and given its favicon before
    // the scene plays, and a keystroke changes only the words typed. A row
    // made per keystroke would show without its translated words or its
    // favicon for a frame, and the list would jump.
    const searchRow = (engine, selected) => {
      const item = viewRow(doc, {
        type: "search",
        icon: SEARCH_ICON,
        title: [],
        action: {
          id: "urlbar-result-action-search-w-engine",
          args: { engine },
        },
      });
      finishRow(doc, item, {
        kind: "search",
        hint: { id: "launcher-hint-search" },
      });
      if (selected) {
        select(item);
      }
      return item;
    };
    const titleOf = item => item.querySelector(".urlbarView-title");
    const urlOf = item => item.querySelector(".urlbarView-url");

    const { tab } = words;
    const top = viewRow(doc, {
      type: "switchtab",
      icon: tab.title,
      title: [],
      url: [],
      label: "launcher-section-tabs",
    });
    top.setAttribute("sval-tab", "");
    finishRow(doc, top, {
      kind: "tab",
      chip: {
        name: tab.workspace,
        color: tab.color,
        emoji: tab.emoji,
        agent: false,
      },
      hint: {
        id: "launcher-hint-switch-to",
        args: { workspace: tab.workspace },
      },
    });
    const webSearch = searchRow(words.engine, true);
    const historyRows = words.history.map((page, index) => {
      const item = viewRow(doc, {
        type: "history",
        icon: page.title,
        title: [],
        url: [],
        label: index ? null : "launcher-section-history",
      });
      finishRow(doc, item, {
        kind: "history",
        hint: { id: "launcher-hint-open" },
      });
      return item;
    });
    const suggestionRows = words.suggestions.map((suggestion, index) => {
      const item = viewRow(doc, {
        type: "search",
        icon: SEARCH_ICON,
        title: [],
        label: index ? null : "launcher-section-suggestions",
      });
      finishRow(doc, item, {
        kind: "suggestion",
        hint: { id: "launcher-hint-search" },
      });
      return item;
    });
    const listRows = [webSearch, top, ...historyRows, ...suggestionRows];

    // The `@` keyword's row, which offers its engine.
    const offerRow = viewRow(doc, {
      type: "search",
      icon: MAPS_ICON,
      title: [],
    });
    doc.l10n.setAttributes(
      titleOf(offerRow),
      "urlbar-result-action-search-w-engine",
      { engine: words.siteEngine }
    );
    finishRow(doc, offerRow, {
      kind: "search",
      hint: { id: "launcher-hint-search" },
    });
    select(offerRow);
    const siteRow = searchRow(words.siteEngine, true);
    const modes = { list: listRows, offer: [offerRow], site: [siteRow] };
    // Every row stays in the list, shown or not, so Fluent translates each
    // once, as it connects, and none shows a frame without its words.
    const allRows = [...listRows, offerRow, siteRow];
    for (const item of allRows) {
      fillFavicons(item);
      item.style.display = "none";
    }
    results.append(...allRows);

    drawFoot(foots.list, footFor({ foot: placesFoot() }, { choosing: false }));
    drawFoot(foots.offer, footFor({ foot: [] }, { choosing: false }));
    drawFoot(foots.site, footFor({ foot: placesFoot() }, { choosing: false }));

    /** Which list shows: `list`, `offer` or `site`. */
    let shown = null;
    const show = mode => {
      if (shown === mode) {
        return;
      }
      shown = mode;
      if (mode === "site") {
        urlbar.setAttribute("searchmode", "");
        switcher.setAttribute("iconsrc", MAPS_ICON);
        switcherTitle.textContent = words.siteEngine;
      } else {
        urlbar.removeAttribute("searchmode");
        switcher.setAttribute("iconsrc", SEARCH_ICON);
        switcherTitle.textContent = "";
      }
      for (const item of allRows) {
        item.style.display = modes[mode].includes(item) ? "" : "none";
      }
      for (const [name, line] of Object.entries(foots)) {
        line.style.display = name === mode ? "" : "none";
      }
    };

    /**
     * The list for `query`: the web search first and selected, then the
     * open tab in another Workspace its strong match moves up, History and
     * Search suggestions, the query's matches in bold.
     *
     * @param {string} query
     */
    const draw = query => {
      input.value = query;
      titleOf(top).replaceChildren(
        ...highlighted(doc, tab.title, query, HIGHLIGHT.TYPED)
      );
      urlOf(top).replaceChildren(
        ...highlighted(doc, tab.url, query, HIGHLIGHT.TYPED)
      );
      titleOf(webSearch).textContent = query;
      words.history.forEach((page, index) => {
        titleOf(historyRows[index]).replaceChildren(
          ...highlighted(doc, page.title, query, HIGHLIGHT.TYPED)
        );
        urlOf(historyRows[index]).replaceChildren(
          ...highlighted(doc, page.url, query, HIGHLIGHT.TYPED)
        );
      });
      words.suggestions.forEach((suggestion, index) => {
        titleOf(suggestionRows[index]).replaceChildren(
          ...highlighted(doc, suggestion, query, HIGHLIGHT.SUGGESTED)
        );
      });
      show("list");
    };

    /**
     * The `@` keyword being typed.
     *
     * @param {string} typed
     */
    const offer = typed => {
      input.value = typed;
      show("offer");
    };

    /**
     * In the keyword's search mode: the engine's chip and its search.
     *
     * @param {string} query
     */
    const searchSite = query => {
      input.value = query;
      titleOf(siteRow).textContent = query;
      show("site");
    };

    const typing = (text, each) =>
      [...text].map((_, index) => [
        KEY_MS,
        () => each(text.slice(0, index + 1)),
      ]);

    return {
      still() {
        draw(words.stillQuery);
      },
      start() {
        draw(words.query.slice(0, 1));
        return loop(doc.defaultView, [
          ...typing(words.query, draw).slice(1),
          ...typing(words.keyword, offer).map(([delay, step], index) => [
            index ? delay : HOLD_MS,
            step,
          ]),
          [OFFER_MS, () => searchSite("")],
          ...typing(words.siteQuery, searchSite),
          [HOLD_MS, () => draw(words.query.slice(0, 1))],
        ]);
      },
    };
  }

  // ---------------------------------------------------------- protection

  /**
   * One of the navigation buttons docked at the pill's start.
   *
   * @param {Document} doc
   * @param {string} id The browser window's id for it.
   * @returns {Element}
   */
  function toolbarButton(doc, id) {
    const button = doc.createXULElement("toolbarbutton");
    button.id = id;
    button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
    return button;
  }

  /**
   * The protection scene: the address bar's pill with the shield pressed,
   * and its panel open under it, as `SvalProtectionButton` draws both for a
   * secure page where it blocked the content's counts.
   *
   * @param {Document} doc The scene's document.
   * @param {object} content
   * @returns {{start: Function, still: Function}}
   */
  function protectionScene(doc, content) {
    const words = content.protection;
    const win = doc.defaultView;
    const scope = scopeForURI(Services.io.newURI(`https://${words.host}/`));
    const log = {
      blocked: words.trackers,
      ads: words.ads,
      fingerprinting: words.fingerprinters,
      canvas: words.fingerprinters > 0,
      fonts: false,
      allowed: 0,
    };
    const state = {
      browser: null,
      site: scope.site,
      host: scope.host,
      scope,
      isPrivate: false,
      session: null,
      connection: { kind: "secure", loaded: true },
      breach: null,
      protections: "on",
      log,
      look: "active",
      compat: false,
    };

    // The button as `ProtectionButton.mount` makes it and `update` paints
    // it, open.
    const count = log.blocked + log.ads + log.fingerprinting;
    const button = make(
      doc,
      "div",
      {
        id: "sval-protection-button",
        role: "button",
        "data-look": state.look,
        "data-tone": "",
        "data-connection": state.connection.kind,
        "data-page": "",
        "sval-count": true,
        "sval-count-wide": count > 9,
        open: true,
        "aria-expanded": "true",
      },
      glyph(doc, shieldOf(state), "sval-prot-shield"),
      make(doc, "span", { class: "sval-prot-dot", "aria-hidden": "true" }),
      make(
        doc,
        "span",
        { class: "sval-prot-count", "aria-hidden": "true" },
        count > 99 ? "99+" : String(count)
      ),
      make(doc, "span", {
        class: "sval-prot-label-word",
        "aria-hidden": "true",
      })
    );

    // The pill, with the page's domain as `SvalHeader` labels it and the
    // Launcher's key at its end.
    const input = make(doc, "input", {
      class: "urlbar-input textbox-input",
      tabindex: "-1",
      value: `https://${words.host}/`,
    });
    const box = doc.createXULElement("moz-input-box");
    box.className = "urlbar-input-box";
    box.setAttribute("flex", "1");
    const key = launcherKeyText(browserWindow(win).document);
    box.append(
      input,
      make(
        doc,
        "span",
        { id: "sval-urlbar-domain", "aria-hidden": "true" },
        make(
          doc,
          "span",
          { class: "sval-urlbar-host" },
          make(doc, "bdi", { dir: "ltr" }, words.host)
        ),
        make(doc, "span", { class: "sval-urlbar-tail" }),
        make(
          doc,
          "kbd",
          { id: "sval-urlbar-key", class: "sval-keycap", hidden: !key },
          key
        )
      )
    );
    const urlbar = make(
      doc,
      "div",
      {
        id: "urlbar",
        class: "urlbar",
        "sval-domain-only": true,
        pageproxystate: "valid",
      },
      make(doc, "div", { class: "urlbar-background" }),
      make(
        doc,
        "div",
        { class: "urlbar-input-container", pageproxystate: "valid" },
        button,
        box
      )
    );

    const panel = make(doc, "div", {
      id: "sval-protection-panel",
      role: "dialog",
    });
    panel.append(new ProtectionButton(win).mainView(state));
    const reloadItem = doc.createXULElement("toolbaritem");
    reloadItem.id = "stop-reload-button";
    reloadItem.append(toolbarButton(doc, "reload-button"));
    doc.body.append(
      make(
        doc,
        "div",
        { class: "sval-fr-protection" },
        make(
          doc,
          "div",
          { id: "nav-bar" },
          make(
            doc,
            "div",
            { id: "nav-bar-customization-target" },
            toolbarButton(doc, "back-button"),
            reloadItem,
            make(doc, "div", { id: "urlbar-container" }, urlbar)
          )
        ),
        panel
      )
    );
    return {
      still() {},
      start() {
        return () => {};
      },
    };
  }

  // ---------------------------------------------------------- the heroes

  const SCENES = [
    ["workspaces", workspacesScene],
    ["launcher", launcherScene],
    ["protection", protectionScene],
  ];

  return {
    /**
     * @param {Document} doc first-run.xhtml's document.
     * @param {object} options
     * @param {object} options.content The canned strings.
     * @returns {{heroes: Element[], show(index: number): void, stop(): void}}
     */
    build(doc, { content }) {
      const win = doc.defaultView;
      const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
      const scenes = [];
      let shown = null;
      let stopShown = null;

      const stop = () => {
        stopShown?.();
        stopShown = null;
      };
      const play = index => {
        stop();
        shown = index;
        const scene = scenes[index];
        if (!scene) {
          // It runs once its document has loaded.
          return;
        }
        if (reduced.matches) {
          scene.still();
        } else {
          stopShown = scene.start();
        }
      };

      const heroes = SCENES.map(([name, makeScene], index) => {
        const frame = doc.createElementNS(HTML_NS, "iframe");
        frame.className = "sval-fr-hero-scene";
        frame.setAttribute("src", SCENE_URL);
        frame.setAttribute("tabindex", "-1");
        // The scene's document says it is ready (`first-run-intro-scene.js`).
        frame.svalSceneReady = sceneDoc => {
          sceneDoc.body.dataset.scene = name;
          scenes[index] = makeScene(sceneDoc, content);
          scenes[index].still();
          if (shown === index) {
            play(index);
          }
        };
        const hero = doc.createElementNS(HTML_NS, "div");
        hero.className = "sval-fr-hero";
        hero.dataset.scene = name;
        hero.setAttribute("aria-hidden", "true");
        hero.inert = true;
        hero.append(frame);
        return hero;
      });

      return {
        heroes,
        show: play,
        stop() {
          stop();
          shown = null;
        },
      };
    },
  };
})();
