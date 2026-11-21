/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The strip: the Workspace switcher that shows every Workspace in a row, in
 * place of the switcher button, when Settings › Workspaces picks it
 * (`SvalPanelModel.SWITCHER_PREF`). It lists what the switcher's menu lists,
 * in the same order, and goes to a Workspace through the same switch, both
 * of which the panel hands over (`PanelView`).
 *
 * The panel makes one of these for its window.
 */

import {
  STRIP_FOLDED_PREF,
  STRIP_NAMES,
  STRIP_NAMES_AT,
  STRIP_NAMES_AT_PREF,
  STRIP_NAMES_PREF,
  STRIP_WHEEL_PREF,
  SWITCHER_PREF,
  keyCommand,
  stripSlideReach,
  stripTranslate,
  wheelTurn,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  AGENT_TEXT,
  ISOLATED_TEXT,
  agentMarkURL,
  agentWorkspaceEntry,
  appendAgentAppEntries,
  deviceMarkURL,
  labelAgentEntry,
  switcherItemLabel,
  usersOwn,
  workspaceName,
} from "moz-src:///browser/components/sval/SvalWorkspaceEntries.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
});

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * Each item's size along the strip, in CSS pixels, as `sval-panel.css`
 * (strip) draws it, for each way the strip shows names. `icon` is an item
 * that shows no name, and New Workspace…'s; `gap` is the room between
 * items. A name below its tile makes the item `below` wide. A name beside
 * its tile makes the item its inline padding, the tile, the gap after the
 * tile and the name, up to `max`. The strip's place along its track is
 * worked out from these and from each name's width, so it slides to where
 * the items end up while their widths are still animating there.
 */
const SIZES = {
  narrow: { icon: 34, gap: 3 },
  none: { icon: 42, gap: 3 },
  "below-all": { icon: 44, gap: 2, below: 92 },
  "below-current": { icon: 44, gap: 2, below: 92 },
  "beside-all": { icon: 42, gap: 4, padding: 20, tile: 30, after: 8 },
  "beside-current": { icon: 42, gap: 3, padding: 14, tile: 30, after: 8 },
};
const BESIDE_MAX = 160;
const DIVIDER_WIDTH = 1;

/**
 * The Workspace panel's widths the strip changes layout at
 * (`sval-panel.css`, strip): from {@link WIDE_PANEL_PX} it shows names as
 * Settings says; below it, icons only with the current name in a caption;
 * at {@link NARROW_PANEL_PX} and below, a column of icons. At
 * {@link WIDE_PANEL_PX} a named item, capped at the track less two icons,
 * still leaves a whole icon each side of it.
 */
const WIDE_PANEL_PX = 222;
const NARROW_PANEL_PX = 72;

/** Each dot's room under the track, and the room around them. */
const DOT_PX = 9;

/**
 * How near either end of the track a drag scrolls the strip, and how far
 * each `dragover` there moves it.
 */
const DRAG_EDGE_PX = 24;
const DRAG_SCROLL_PX = 8;

/** How long the strip waits after the pointer leaves it to slide back. */
const SLIDE_BACK_MS = 3000;

/**
 * What the strip reads of its panel, and asks of it: its tree and elements,
 * and the switcher's list of Workspaces, its switch, its menus and its drag.
 *
 * @typedef {object} PanelView
 * @property {object} nodes The document's `nodes` map as the panel draws it.
 * @property {object} workspace The window's `SvalWindowWorkspace`.
 * @property {boolean} inMemory Whether the window's tree is in memory.
 * @property {object} els The panel's elements.
 * @property {number} wheelRestMs How long the wheel rests between gestures.
 * @property {number} wheelGesturePx How far a wheel gesture travels to count.
 * @property {Function} switcherList The Workspaces, as the switcher lists
 *   them.
 * @property {Function} pickWorkspace Goes to a Workspace.
 * @property {Function} openSwitcher Opens the switcher's menu.
 * @property {Function} openWorkspaceMenu Opens the workspace menu.
 * @property {Function} onSwitcherDrag Handles a drag of a Workspace.
 * @property {Function} workspaceMedia What a Workspace's media button does.
 * @property {Function} workspaceTabs A Workspace's tabs in this window.
 * @property {Function} mediaTooltip A media button's tooltip.
 * @property {Function} workspaceColor A Workspace's colour.
 * @property {Function} workspaceSwatch A Workspace's swatch.
 */

/** One window's strip of Workspaces. */
export class SvalPanelStrip {
  #window;

  /** @type {PanelView} */
  #view;

  /** The strip's element, once built. */
  #el = null;

  /** An agent app's menu of Workspaces, opened from the strip. */
  #appMenu = null;

  /** Watches the strip's view for a change of width. */
  #resize = null;

  /**
   * @param {Window} win The panel's chrome window.
   * @param {PanelView} view
   */
  constructor(win, view) {
    this.#window = win;
    this.#view = view;
  }

  /** An agent app's menu of Workspaces, once the strip has opened one. */
  get appMenu() {
    return this.#appMenu;
  }

  /**
   * @param {string} tag
   * @returns {Element} An HTML element.
   */
  #html(tag) {
    return this.#window.document.createElementNS(XHTML, tag);
  }

  /**
   * The strip's state between renders: where it was last placed
   * (`{ width, total, first, last, items, x, w }`, as `stripTranslate` takes
   * them), the room each Workspace takes along it on average, the wheel's
   * slide, whether the wheel is sliding it now, the
   * slide-back timer, the Workspace the strip was last drawn for, the
   * switching wheel's gesture in progress (`SvalPanelModel.wheelTurn`),
   * and the Workspace the wheel last moved to, until the window shows
   * it.
   */
  #state = {
    geometry: null,
    pitch: 0,
    offset: 0,
    sliding: false,
    slideBack: null,
    gesture: null,
    placedFor: null,
    pending: null,
    pendingAt: 0,
  };

  /**
   * Builds the strip, hidden until the setting picks it.
   *
   * The Workspaces are a `tablist`, each one a `tab`, the current one
   * selected. The list is one tab stop, and the arrow keys move along it
   * (roving `tabindex`). New Workspace… ends the strip and is reached by the
   * pointer or the arrow keys' wrap, so the strip stays one stop.
   *
   * @returns {Element}
   */
  build() {
    const strip = this.#html("div");
    strip.className = "sval-strip";
    this.#el = strip;
    strip.hidden = true;
    const track = this.#html("div");
    track.className = "sval-strip-track";
    const view = this.#html("div");
    view.className = "sval-strip-view";
    const row = this.#html("div");
    row.className = "sval-strip-row";
    const tabs = this.#html("div");
    tabs.className = "sval-strip-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Workspaces");
    const add = this.#html("button");
    add.className = "sval-strip-add";
    add.dataset.command = "addWorkspace";
    add.setAttribute("tabindex", "-1");
    add.title = "New Workspace…";
    add.setAttribute("aria-label", "New Workspace…");
    row.append(tabs, add);
    view.append(row);
    track.append(view);
    // Where the current Workspace stands among them all, where dots don't
    // fit: a line with a thumb, under the track.
    const line = this.#html("div");
    line.className = "sval-strip-line";
    line.setAttribute("aria-hidden", "true");
    line.hidden = true;
    line.append(this.#html("span"));
    // The current Workspace's name, where the items show none. A tab's
    // accessible name carries it.
    const caption = this.#html("div");
    caption.className = "sval-strip-caption";
    caption.setAttribute("aria-hidden", "true");
    caption.hidden = true;
    const dots = this.#html("div");
    dots.className = "sval-strip-dots";
    dots.setAttribute("aria-hidden", "true");
    const hairline = this.#html("div");
    hairline.className = "sval-strip-hairline";
    strip.append(this.#buildLabel(), track, caption, dots, line, hairline);

    tabs.addEventListener("keydown", event => this.#onKeyDown(event));
    strip.addEventListener("click", event => this.#onClick(event));
    strip.addEventListener("contextmenu", event => this.#onContextMenu(event));
    // Not passive: a wheel the strip takes holds the panel still.
    view.addEventListener("wheel", event => this.#onWheel(event), {
      passive: false,
    });
    // Over and out of the view itself, not each item in it.
    const crossing = event => !view.contains(event.relatedTarget);
    view.addEventListener("mouseover", event => {
      if (crossing(event)) {
        this.#hold();
      }
    });
    view.addEventListener("mouseout", event => {
      if (crossing(event)) {
        this.release();
      }
    });
    for (const type of [
      "dragstart",
      "dragover",
      "dragleave",
      "drop",
      "dragend",
    ]) {
      tabs.addEventListener(type, event => this.#view.onSwitcherDrag(event));
    }
    this.#resize?.disconnect();
    // The view has no size while the strip is folded, and the strip's own
    // width still crosses the widths its layout changes at.
    this.#resize = new this.#window.ResizeObserver(() => this.#place());
    this.#resize.observe(view);
    this.#resize.observe(strip);
    Object.assign(this.#state, {
      offset: 0,
      sliding: false,
      pending: null,
    });
    return strip;
  }

  /**
   * The row over the strip: its name, the Workspace you're in while the
   * strip is folded, and the button that folds and unfolds it
   * (`SvalPanelModel.STRIP_FOLDED_PREF`).
   *
   * @returns {Element}
   */
  #buildLabel() {
    const label = this.#html("div");
    label.className = "sval-strip-label";
    const heading = this.#html("span");
    heading.className = "sval-strip-heading";
    heading.textContent = "Workspaces";
    const peek = this.#html("span");
    peek.className = "sval-strip-peek";
    const tile = this.#html("span");
    tile.className = "sval-strip-peek-tile";
    const face = this.#html("span");
    face.className = "sval-strip-face";
    face.setAttribute("aria-hidden", "true");
    tile.append(face);
    const name = this.#html("span");
    name.className = "sval-strip-peek-name";
    peek.append(tile, name);
    const fold = this.#html("button");
    fold.className = "sval-strip-fold";
    fold.addEventListener("click", () => {
      Services.prefs.setBoolPref(
        STRIP_FOLDED_PREF,
        !Services.prefs.getBoolPref(STRIP_FOLDED_PREF, false)
      );
    });
    label.append(heading, peek, fold);
    return label;
  }

  /**
   * Shows the switcher the setting picks: the strip, or the button and its
   * menu. Either way the window stays on its Workspace.
   */
  applyKind() {
    const { switcher, strip, switcherMenu } = this.#view.els;
    const useStrip =
      Services.prefs.getStringPref(SWITCHER_PREF, "menu") === "strip";
    if (useStrip && switcherMenu?.state !== "closed") {
      switcherMenu?.hidePopup();
    }
    switcher.hidden = useStrip;
    strip.hidden = !useStrip;
    if (useStrip) {
      this.render();
    }
  }

  /** @returns {boolean} whether the strip is the switcher shown. */
  shown() {
    return !!this.#el && !this.#el.hidden;
  }

  /**
   * @returns {string} what the strip shows of each Workspace's name: one of
   *   `SvalPanelModel.STRIP_NAMES`.
   */
  names() {
    const names = Services.prefs.getStringPref(STRIP_NAMES_PREF, "all");
    return STRIP_NAMES.includes(names) ? names : "all";
  }

  /**
   * @returns {string} where the strip puts a shown name: one of
   *   `SvalPanelModel.STRIP_NAMES_AT`.
   */
  #namesAt() {
    const at = Services.prefs.getStringPref(STRIP_NAMES_AT_PREF, "below");
    return STRIP_NAMES_AT.includes(at) ? at : "below";
  }

  /**
   * The strip's sizes for how it shows names now ({@link SIZES}).
   *
   * @returns {object}
   */
  #sizes() {
    const { layout, names, at } = this.#el.dataset;
    if (layout !== "wide") {
      return SIZES.narrow;
    }
    return names === "none" ? SIZES.none : SIZES[`${at}-${names}`];
  }

  /**
   * The strip's layout at the Workspace panel's width: `"wide"`, `"icons"`
   * or `"column"` ({@link WIDE_PANEL_PX}).
   *
   * @returns {string}
   */
  #layout() {
    const width = this.#view.els.container.getBoundingClientRect().width;
    if (width <= NARROW_PANEL_PX) {
      return "column";
    }
    return width < WIDE_PANEL_PX ? "icons" : "wide";
  }

  /**
   * Draws the strip from the document as it stands: one tab per Workspace
   * in the switcher's order, the devices' and the agents' each after a
   * divider, and the current one selected. Items are kept from one render to the next, so a width
   * or a slide animates and focus stays where it is.
   */
  render() {
    if (!this.shown()) {
      return;
    }
    const strip = this.#el;
    const tabs = strip.querySelector(".sval-strip-tabs");
    const layout = this.#layout();
    const chosen = this.names();
    // Narrower than the wide layout, an item's name would be cut to a few
    // letters, so the items show icons and the caption the current name.
    const names = layout === "wide" ? chosen : "none";
    const items = this.#view.switcherList();
    const kept = new Map(
      Array.from(tabs.querySelectorAll(":scope > [data-strip-key]"), el => [
        el.dataset.stripKey,
        el,
      ])
    );
    const wanted = [];
    const dividers = new Map(
      Array.from(tabs.querySelectorAll(":scope > .sval-strip-divider"), el => [
        el.dataset.divider,
        el,
      ])
    );
    let part = null;
    for (const entry of this.#entries(items)) {
      const its = this.#part(entry.item);
      if (its !== part) {
        part = its;
        if (!dividers.has(part)) {
          dividers.set(part, this.#divider(part));
        }
        wanted.push(dividers.get(part));
      }
      const el = kept.get(entry.key) ?? this.#item(entry.key);
      kept.delete(entry.key);
      this.#paintItem(el, entry.item, names, entry.app);
      wanted.push(el);
    }
    for (const el of kept.values()) {
      el.remove();
    }
    for (const divider of dividers.values()) {
      if (!wanted.includes(divider)) {
        divider.remove();
      }
    }
    // Moved only when the order changed: a focused element moved in the
    // document loses focus.
    const order = Array.from(tabs.children);
    if (
      order.length !== wanted.length ||
      order.some((el, i) => el !== wanted[i])
    ) {
      tabs.append(...wanted);
    }
    strip.dataset.names = names;
    strip.dataset.at = this.#namesAt();
    strip.dataset.layout = layout;
    tabs.setAttribute(
      "aria-orientation",
      layout === "column" ? "vertical" : "horizontal"
    );
    const current = items.find(item => item.current);
    if (
      this.#appMenu?.state === "open" &&
      !tabs.querySelector(
        `[data-agent-app="${CSS.escape(this.#appMenu.dataset.agentApp)}"]`
      )
    ) {
      this.#appMenu.hidePopup();
    }
    const caption = strip.querySelector(".sval-strip-caption");
    caption.hidden = layout !== "icons" || chosen === "none" || !current;
    caption.textContent = current ? workspaceName(current) : "";
    this.#paintLabel(current, layout);
    // A slide is a look along the strip from the Workspace shown. Once the
    // window shows another, the strip goes straight from where it was slid
    // to the new one, with the slide's own ease.
    if (this.#state.placedFor !== this.#view.workspace.id) {
      this.#state.placedFor = this.#view.workspace.id;
      this.#state.offset = 0;
      this.#state.sliding = false;
    }
    if (
      this.#state.pending &&
      this.#state.pending === this.#view.workspace.id
    ) {
      this.#state.pending = null;
    }
    this.#place();
  }

  /**
   * Folds or unfolds the strip as its pref says, and names the Workspace
   * you're in on the label row while it is folded. The column at 72px and
   * below has no room for the row, and always shows the strip.
   *
   * @param {?object} current The current Workspace's `switcherItems` entry.
   * @param {string} layout `#layout`.
   */
  #paintLabel(current, layout) {
    const strip = this.#el;
    const folded =
      layout !== "column" &&
      Services.prefs.getBoolPref(STRIP_FOLDED_PREF, false);
    strip.toggleAttribute("data-folded", folded);
    const fold = strip.querySelector(".sval-strip-fold");
    const action = folded ? "Show the strip" : "Hide the strip";
    fold.setAttribute("aria-expanded", String(!folded));
    fold.setAttribute("aria-label", action);
    fold.title = action;
    const tile = strip.querySelector(".sval-strip-peek-tile");
    strip.querySelector(".sval-strip-peek-name").textContent = current
      ? workspaceName(current)
      : "";
    if (current) {
      this.#paintFace(tile, current);
    }
  }

  /**
   * Fills a Workspace's tile: its emoji, or the Workspace glyph or its
   * agent's or device's mark, on its colour.
   *
   * @param {Element} tile Holds a `.sval-strip-face`.
   * @param {object} item A `switcherItems` entry.
   */
  #paintFace(tile, item) {
    const face = tile.querySelector(".sval-strip-face");
    const marked = !!(item.agent || item.device);
    face.textContent = marked ? "" : (item.emoji ?? "");
    face.classList.toggle("sval-strip-agent", marked);
    if (marked) {
      face.style.setProperty(
        "--sval-agent-mark",
        `url("${item.agent ? agentMarkURL(item.brand) : deviceMarkURL(this.#view.nodes, item.id)}")`
      );
    } else {
      face.style.removeProperty("--sval-agent-mark");
    }
    const color = this.#view.workspaceColor(item.id);
    if (color) {
      tile.style.setProperty(
        "--sval-strip-fill",
        this.#view.workspaceSwatch(color)
      );
    } else {
      tile.style.removeProperty("--sval-strip-fill");
    }
  }

  /**
   * Which part of the strip an item is in, each after a divider of its own
   * but the user's, which comes first.
   *
   * @param {object} item A `switcherItems` entry.
   * @returns {?string} `"devices"`, `"agents"`, or null for the user's own.
   */
  #part(item) {
    if (item.agent) {
      return "agents";
    }
    return item.device ? "devices" : null;
  }

  /**
   * @param {string} part What the divider starts (`#part`).
   * @returns {Element} the line before that part's items.
   */
  #divider(part) {
    const el = this.#html("div");
    el.className = "sval-strip-divider";
    el.dataset.divider = part;
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  /**
   * What the strip draws for `items`: one entry for each of the user's
   * and the devices' Workspaces, and one for each agent app (`item.agent`), however many
   * Workspaces it has, so every session an agent starts does not lengthen
   * the strip. An app with one Workspace is that Workspace's item. An app
   * with more stands for the Workspace the window shows, when it is one of
   * them, or else the one a session used last, and opens a list of them
   * all (`#openAppMenu`).
   *
   * @param {object[]} items {@link switcherList}'s entries.
   * @returns {{key: string, item: object, app: ?{label: string,
   *   ids: string[]}}[]}
   */
  #entries(items) {
    const used = item => agentWorkspaceEntry(item.id)?.lastUsed ?? -Infinity;
    const entries = items
      .filter(item => !item.agent)
      .map(item => ({ key: item.id, item, app: null }));
    const apps = Map.groupBy(
      items.filter(item => item.agent),
      item => item.agent
    );
    for (const [label, members] of apps) {
      if (members.length === 1) {
        entries.push({ key: members[0].id, item: members[0], app: null });
        continue;
      }
      const sorted = members.toSorted((a, b) => used(b) - used(a));
      entries.push({
        key: `app:${label}`,
        item: sorted.find(item => item.current) ?? sorted[0],
        app: { label, ids: sorted.map(item => item.id) },
      });
    }
    return entries;
  }

  /**
   * @param {string} key A Workspace id, or an agent app's `app:` key
   *   (`#entries`).
   * @returns {Element} an empty `tab` for it, filled by
   *   `#paintItem`.
   */
  #item(key) {
    const el = this.#html("div");
    el.className = "sval-strip-item";
    el.setAttribute("role", "tab");
    el.dataset.stripKey = key;
    const tile = this.#html("span");
    tile.className = "sval-strip-tile";
    const face = this.#html("span");
    face.className = "sval-strip-face";
    face.setAttribute("aria-hidden", "true");
    const isolated = this.#html("span");
    isolated.className = "sval-strip-isolated";
    isolated.setAttribute("aria-hidden", "true");
    // Pressed without picking the Workspace (`#onClick`); the
    // Workspace's menu has the keyboard's way to the same command.
    const audio = this.#html("button");
    audio.className = "sval-strip-audio";
    audio.setAttribute("tabindex", "-1");
    audio.setAttribute("aria-hidden", "true");
    const count = this.#html("span");
    count.className = "sval-strip-count";
    count.setAttribute("aria-hidden", "true");
    tile.append(face, isolated, audio, count);
    const name = this.#html("span");
    name.className = "sval-strip-name";
    el.append(tile, name);
    return el;
  }

  /**
   * Fills one item from its `switcherItems` entry: its tile, its name, the
   * marks for isolation and sound, and what it says to the pointer and to a
   * screen reader.
   *
   * An agent app's item (`#entries`) is named for the app, says
   * how many Workspaces it holds, and opens their list.
   *
   * @param {Element} el
   * @param {object} item
   * @param {string} names What the strip shows of names.
   * @param {?{label: string, ids: string[]}} [app] The agent app the item
   *   stands for, when it stands for more than one Workspace.
   */
  #paintItem(el, item, names, app = null) {
    el.dataset.workspaceId = item.id;
    const name = app ? app.label : workspaceName(item);
    const label = app
      ? `${app.label}, ${app.ids.length} Workspaces`
      : switcherItemLabel(item);
    const isolated =
      !app && lazy.SvalWorkspaceJar.isIsolated(this.#view.nodes, item.id);
    const showsName = names === "all" || (names === "current" && item.current);

    el.toggleAttribute("data-current", item.current);
    el.setAttribute("aria-selected", String(item.current));
    el.setAttribute("tabindex", item.current ? "0" : "-1");
    if (app) {
      el.dataset.agentApp = app.label;
      el.querySelector(".sval-strip-count").textContent = String(
        app.ids.length
      );
    } else {
      delete el.dataset.agentApp;
      el.querySelector(".sval-strip-count").textContent = "";
    }
    // A click, Enter or Space on the current Workspace opens the full
    // list (`openSwitcher`), and on an agent app its own list.
    if (item.current || app) {
      el.setAttribute("aria-haspopup", "menu");
    } else {
      el.removeAttribute("aria-haspopup");
      el.removeAttribute("aria-expanded");
    }
    el.toggleAttribute("data-shows-name", showsName);
    el.toggleAttribute("data-isolated", isolated);
    // The user's own Workspaces are put in order by dragging, as in the
    // menu; the devices' and the agents' keep theirs.
    el.setAttribute(
      "draggable",
      String(usersOwn(item) && !this.#view.inMemory)
    );
    el.setAttribute("aria-label", label);
    const described = [
      item.agent ? AGENT_TEXT : null,
      isolated ? ISOLATED_TEXT : null,
    ].filter(Boolean);
    if (described.length) {
      el.setAttribute("aria-description", described.join(". "));
    } else {
      el.removeAttribute("aria-description");
    }
    // A hidden name is in the tooltip; a shown one needs only the
    // isolation's meaning there.
    const tooltip = [showsName ? null : name, isolated ? ISOLATED_TEXT : null]
      .filter(Boolean)
      .join("\n");
    if (tooltip) {
      el.title = tooltip;
    } else {
      el.removeAttribute("title");
    }

    this.#paintFace(el.querySelector(".sval-strip-tile"), item);
    el.querySelector(".sval-strip-name").textContent = name;
    this.#paintSound(el);
  }

  /**
   * Shows or hides one item's sound badge, as the menu's entries show
   * their media button (the switcher).
   *
   * @param {Element} el A strip item.
   */
  #paintSound(el) {
    const id = el.dataset.workspaceId;
    const action = this.#view.workspaceMedia(id);
    const audio = el.querySelector(".sval-strip-audio");
    if (action) {
      el.setAttribute("data-media", action);
      audio.title = this.#view.mediaTooltip(this.#view.workspaceTabs(id));
    } else {
      el.removeAttribute("data-media");
      audio.removeAttribute("title");
    }
  }

  /** Paints every item's sound badge while the strip shows. */
  paintSounds() {
    if (!this.shown()) {
      return;
    }
    for (const el of this.#el.querySelectorAll(".sval-strip-item")) {
      this.#paintSound(el);
    }
  }

  /**
   * Sizes each item and slides the strip so the current item sits at the
   * track's centre ({@link SvalPanelModel.stripTranslate}), along the row
   * or down the column, with the edges' fade and where it stands among
   * them all while it overflows.
   */
  #place() {
    if (!this.shown()) {
      return;
    }
    const strip = this.#el;
    if (strip.dataset.layout !== this.#layout()) {
      this.render();
      return;
    }
    if (strip.hasAttribute("data-folded")) {
      return;
    }
    const view = strip.querySelector(".sval-strip-view");
    const row = strip.querySelector(".sval-strip-row");
    const tabs = row.querySelector(".sval-strip-tabs");
    const column = strip.dataset.layout === "column";
    const sizes = this.#sizes();
    const width = column ? view.clientHeight : view.clientWidth;
    let x = 0;
    let first = null;
    const items = { start: null, end: null };
    let current = null;
    const workspaces = [];
    for (const el of tabs.children) {
      let size = DIVIDER_WIDTH;
      if (el.classList.contains("sval-strip-item")) {
        size = this.#itemWidth(el, sizes, width);
        // A column's items take its width, and their height is the icon's.
        el.style.width = column ? "" : `${size}px`;
        workspaces.push(el);
        first ??= x + size / 2;
        items.start ??= x;
        items.end = x + size;
        if (el.hasAttribute("data-current")) {
          current = { x, w: size };
        }
      }
      x += size + sizes.gap;
    }
    const total = x + sizes.icon;
    const overflows = total > width;
    strip.toggleAttribute("data-overflow", overflows);
    strip.toggleAttribute("data-sliding", this.#state.sliding);
    if (!overflows) {
      this.#state.offset = 0;
    }
    this.#state.geometry = current
      ? {
          width,
          total,
          first,
          // The add button closes the row.
          last: total - sizes.icon / 2,
          items,
          ...current,
        }
      : null;
    this.#state.pitch = workspaces.length ? x / workspaces.length : 0;
    // On whole device pixels, where the window draws a translation, so a
    // popover traced from a tile's layout box (`SvalHeader`'s
    // `placeStemOf`) meets the tile as drawn.
    const translate = current
      ? Math.round(
          stripTranslate({
            ...this.#state.geometry,
            offset: this.#state.offset,
          }) * this.#window.devicePixelRatio
        ) / this.#window.devicePixelRatio
      : 0;
    row.style.transform = column
      ? `translateY(${translate}px)`
      : `translateX(${translate}px)`;
    this.#drawPosition(workspaces, overflows);
  }

  /**
   * An item's size along the strip: an icon's; a fixed width with its name
   * below its tile; or its tile and name beside it with its padding, up to
   * {@link BESIDE_MAX} and the track less two icons, where the name is cut
   * short. The track's cap leaves a whole icon each side.
   *
   * @param {Element} el A strip item.
   * @param {object} sizes `#sizes`.
   * @param {number} track The track's inner width.
   * @returns {number}
   */
  #itemWidth(el, sizes, track) {
    if (!el.hasAttribute("data-shows-name")) {
      return sizes.icon;
    }
    if (sizes.below) {
      return sizes.below;
    }
    // The text's own width, in fractions of a pixel. `scrollWidth` rounds
    // to the nearest whole one (`Element::ScrollWidth`), and a name a
    // fraction wider than its box is cut by the ellipsis.
    const range = this.#window.document.createRange();
    range.selectNodeContents(el.querySelector(".sval-strip-name"));
    const text = range.getBoundingClientRect().width;
    return Math.min(
      BESIDE_MAX,
      track - 2 * sizes.icon,
      Math.ceil(sizes.padding + sizes.tile + sizes.after + text)
    );
  }

  /**
   * Where the current Workspace stands among them all, while the strip
   * overflows: a dot per Workspace, the current one a pill, while the dots
   * fit under the track, and otherwise a line with a thumb. The column
   * has room for neither, and shows neither.
   *
   * @param {Element[]} workspaces The items, in order.
   * @param {boolean} overflows
   */
  #drawPosition(workspaces, overflows) {
    const strip = this.#el;
    const dots = strip.querySelector(".sval-strip-dots");
    const line = strip.querySelector(".sval-strip-line");
    const track = strip.querySelector(".sval-strip-view").clientWidth;
    const { layout } = strip.dataset;
    const dotsFit =
      layout === "wide" ||
      (layout === "icons" && workspaces.length * DOT_PX + DOT_PX <= track);
    dots.hidden = !overflows || !dotsFit;
    line.hidden = !overflows || dotsFit || layout === "column";
    const at = workspaces.findIndex(el => el.hasAttribute("data-current"));
    line.style.setProperty(
      "--sval-strip-at",
      String(
        workspaces.length > 1 ? Math.max(0, at) / (workspaces.length - 1) : 0
      )
    );
    if (dots.hidden) {
      return;
    }
    while (dots.childElementCount > workspaces.length) {
      dots.lastElementChild.remove();
    }
    while (dots.childElementCount < workspaces.length) {
      dots.append(this.#html("span"));
    }
    workspaces.forEach((el, i) =>
      dots.children[i].toggleAttribute(
        "data-current",
        el.hasAttribute("data-current")
      )
    );
  }

  /**
   * A click on the strip: an item goes to its Workspace, or with Shift
   * opens it in a new window, and the current one opens the full list;
   * its sound badge mutes or pauses what plays there. New Workspace… runs
   * through the panel's own command.
   *
   * @param {MouseEvent} event
   */
  #onClick(event) {
    const audio = event.target.closest?.(".sval-strip-audio");
    const el = event.target.closest?.(".sval-strip-item");
    if (!el || event.button !== 0) {
      return;
    }
    if (audio) {
      lazy.SvalFirefox.actOnMedia(
        this.#view.workspaceTabs(el.dataset.workspaceId)
      );
      return;
    }
    if (el.dataset.agentApp && !event.shiftKey) {
      this.#openAppMenu(el);
      return;
    }
    // The current Workspace's item opens the full list, which names every
    // Workspace, the strip's icons included.
    if (el.hasAttribute("data-current") && !event.shiftKey) {
      this.#view.openSwitcher();
      return;
    }
    this.#view.pickWorkspace(el.dataset.workspaceId, event.shiftKey);
  }

  /**
   * The strip's keys: ← and → move along it and go to the Workspace they
   * land on, wrapping at either end, as ↑ and ↓ do down the column. Home
   * and End go to the first and the last. Enter and Space open the full
   * list (`openSwitcher`). The context-menu key and Shift+F10 open
   * the focused Workspace's menu.
   *
   * @param {KeyboardEvent} event `keydown` in the tablist.
   */
  #onKeyDown(event) {
    const el = event.target.closest?.(".sval-strip-item");
    if (!el) {
      return;
    }
    if (keyCommand(event, {}) === "contextMenu") {
      event.preventDefault();
      event.stopPropagation();
      this.#view.openWorkspaceMenu(null, el.dataset.workspaceId, el, true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const items = Array.from(this.#el.querySelectorAll(".sval-strip-item"));
    const at = items.indexOf(el);
    const rtl = this.#window.getComputedStyle(el).direction === "rtl";
    const column = this.#el.dataset.layout === "column";
    const wrap = step => (at + step + items.length) % items.length;
    let to = null;
    switch (event.key) {
      case "ArrowRight":
        to = wrap(rtl ? -1 : 1);
        break;
      case "ArrowLeft":
        to = wrap(rtl ? 1 : -1);
        break;
      case "ArrowDown":
        to = column ? wrap(1) : null;
        break;
      case "ArrowUp":
        to = column ? wrap(-1) : null;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = items.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        event.stopPropagation();
        if (el.dataset.agentApp) {
          this.#openAppMenu(el);
        } else {
          this.#view.openSwitcher();
        }
        return;
    }
    if (to === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = items[to];
    if (next === el) {
      return;
    }
    for (const item of items) {
      item.setAttribute("tabindex", item === next ? "0" : "-1");
    }
    next.focus();
    // Firefox's tab switch takes the focus from where it was
    // (`_adjustFocusBeforeTabSwitch`), and gives it to the page unless
    // something took it first (`_adjustFocusAfterTabSwitch`), so the strip
    // takes it back for the next key.
    const id = next.dataset.workspaceId;
    this.#view
      .pickWorkspace(id, false)
      .then(() =>
        this.#el
          .querySelector(
            `.sval-strip-item[data-workspace-id="${CSS.escape(id)}"]`
          )
          ?.focus()
      );
  }

  /**
   * Opens the list of an agent app's Workspaces under its item, the one a
   * session used last first, as the switcher's menu lists them
   * (`appendAgentApps`). Picking one goes to it, and with Shift
   * opens it in a new window.
   *
   * @param {Element} el An agent app's strip item.
   */
  #openAppMenu(el) {
    const label = el.dataset.agentApp;
    const items = this.#view
      .switcherList()
      .filter(item => item.agent === label);
    if (items.length < 2) {
      return;
    }
    this.#appMenu?.hidePopup();
    this.#window.document.getElementById("sval-strip-app-menu")?.remove();
    const menu = this.#window.document.createXULElement("menupopup");
    // Grows from the app's tile, reaching past it as the header's
    // popovers do (`SvalStem`).
    menu.id = "sval-strip-app-menu";
    menu.setAttribute("nonnative", "");
    menu.setAttribute("consumeoutsideclicks", "true");
    menu.setAttribute("sval-stem-host", "");
    menu.setAttribute("sval-stem-hang", "");
    menu.classList.add("toolbar-menupopup", "sval-agent-app-popup");
    menu.dataset.agentApp = label;
    appendAgentAppEntries(menu, items, item => {
      const entry = this.#window.document.createXULElement("menuitem");
      entry.dataset.workspaceId = item.id;
      labelAgentEntry(entry, item);
      if (item.current) {
        entry.setAttribute("aria-current", "true");
      }
      return entry;
    });
    menu.addEventListener("command", event => {
      const id = event.target.dataset?.workspaceId;
      if (id) {
        this.#view.pickWorkspace(id, event.shiftKey);
      }
    });
    menu.addEventListener("popuphidden", event => {
      if (event.target !== menu) {
        return;
      }
      el.setAttribute("aria-expanded", "false");
      menu.remove();
      if (this.#appMenu === menu) {
        this.#appMenu = null;
        if (!this.#el.querySelector(".sval-strip-view:hover")) {
          this.release();
        }
      }
    });
    this.#window.document.getElementById("mainPopupSet").append(menu);
    this.#appMenu = menu;
    this.#hold();
    el.setAttribute("aria-expanded", "true");
    // The list's stem is traced from where the tile stands as it opens, so
    // it opens once the strip's slide has come to rest.
    const row = el.closest(".sval-strip-row");
    Promise.allSettled(row.getAnimations().map(a => a.finished)).then(() => {
      if (this.#appMenu === menu) {
        menu.openPopup(el.querySelector(".sval-strip-face"), "after_start");
      }
    });
  }

  /**
   * A right-click on an item opens that Workspace's menu, with the names
   * controls under it.
   *
   * @param {MouseEvent} event
   */
  #onContextMenu(event) {
    const el = event.target.closest?.(".sval-strip-item");
    event.preventDefault();
    event.stopPropagation();
    if (el) {
      this.#view.openWorkspaceMenu(event, el.dataset.workspaceId, el, true);
    }
  }

  /**
   * The wheel over the strip. With "Slides the strip" it moves the strip
   * along its track without switching, while the strip overflows; a strip
   * that fits leaves the wheel to the panel's swipe
   * (the panel). With "Switches Workspaces" it moves the
   * window one Workspace for each turn of the wheel
   * (`#stepByWheel`), and stops at either end.
   *
   * @param {WheelEvent} event
   */
  #onWheel(event) {
    const switches =
      Services.prefs.getStringPref(STRIP_WHEEL_PREF, "slide") === "switch";
    const overflows = this.#el.hasAttribute("data-overflow");
    if (
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      (!switches && !overflows)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (switches) {
      this.#stepByWheel(event, delta);
      return;
    }
    // A notched wheel's turn is one event in lines or pages
    // (`#stepByWheel`), and how many lines the system makes of it,
    // multiplied on Windows and GTK by
    // `mousewheel.system_scroll_override`, says nothing of the strip.
    // Each turn slides it about one Workspace.
    this.#slide(
      event.deltaMode === event.DOM_DELTA_PIXEL
        ? delta
        : Math.sign(delta) * this.#state.pitch
    );
  }

  /**
   * Adds `delta` to the slide, kept within its reach
   * ({@link SvalPanelModel.stripSlideReach}), so a wheel turned past an end
   * has nothing to unwind.
   *
   * @param {number} delta
   */
  #slide(delta) {
    const geometry = this.#state.geometry;
    // An agent app's list grows from its tile, which stays where the list
    // was traced from while it is open.
    if (!geometry || this.#appMenu) {
      return;
    }
    const { min, max } = stripSlideReach(geometry);
    this.#state.offset = Math.max(
      min,
      Math.min(max, this.#state.offset - delta)
    );
    this.#state.sliding = true;
    this.#place();
  }

  /**
   * Moves the window one Workspace along the strip for each turn of the
   * wheel, stopping at the ends. Gecko gives a notched wheel's turn as one
   * `wheel` event in lines or pages (`scrollWheel:` in nsCocoaWindow.mm,
   * `SCROLLDELTA_LINE`), so each such event is one turn. A turn in pixels
   * is read as the panel's swipe reads one (`SvalPanelModel.wheelTurn`).
   *
   * @param {WheelEvent} event
   * @param {number} delta Its travel, in its `deltaMode`'s units.
   */
  #stepByWheel(event, delta) {
    if (event.deltaMode !== event.DOM_DELTA_PIXEL) {
      this.#state.gesture = null;
      this.#step(Math.sign(delta));
      return;
    }
    const { gesture, step } = wheelTurn(
      this.#state.gesture,
      {
        at: event.timeStamp,
        delta,
        momentum: event.isMomentum,
        start: event.isGestureStart,
      },
      { restMs: this.#view.wheelRestMs, stepPx: this.#view.wheelGesturePx }
    );
    this.#state.gesture = gesture;
    this.#step(step);
  }

  /**
   * Moves the window `step` places along the strip, from the Workspace the
   * wheel last moved to while the window has yet to show it, stopping at
   * the ends. The strip glides there as the window switches.
   *
   * @param {number} step 1 or -1.
   */
  #step(step) {
    if (!step) {
      return;
    }
    const now = Date.now();
    const ids = Array.from(
      this.#el.querySelectorAll(".sval-strip-item"),
      el => el.dataset.workspaceId
    );
    const from =
      this.#state.pending && now - this.#state.pendingAt < 1000
        ? this.#state.pending
        : this.#view.workspace.id;
    const at = ids.indexOf(from);
    const next = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
    if (at === -1 || next === from) {
      return;
    }
    this.#state.pending = next;
    this.#state.pendingAt = now;
    this.#view.pickWorkspace(next, false);
  }

  /**
   * A drag held within {@link DRAG_EDGE_PX} of either end of the strip's
   * track slides the strip that way, so a Workspace can be dropped past
   * the items in view. Gecko sends `dragover` again while the pointer
   * rests, so a held drag goes on sliding.
   *
   * @param {DragEvent} event `dragover` on the switcher's menu or the
   *   strip.
   */
  scrollForDrag(event) {
    const strip = this.#el;
    if (!this.shown() || !strip.contains(event.currentTarget)) {
      return;
    }
    const view = strip
      .querySelector(".sval-strip-view")
      .getBoundingClientRect();
    const column = strip.dataset.layout === "column";
    const at = column ? event.clientY : event.clientX;
    const start = column ? view.top : view.left;
    const end = column ? view.bottom : view.right;
    if (at - start < DRAG_EDGE_PX) {
      this.#slide(-DRAG_SCROLL_PX);
    } else if (end - at < DRAG_EDGE_PX) {
      this.#slide(DRAG_SCROLL_PX);
    }
  }

  /** The pointer is over the strip: a slide stays where the wheel left it. */
  #hold() {
    this.#window.clearTimeout(this.#state.slideBack);
    this.#state.slideBack = null;
    this.#el.removeAttribute("data-returning");
  }

  /**
   * The pointer has left the strip: after {@link SLIDE_BACK_MS} the strip
   * slides back to the current Workspace. An agent app's list keeps it
   * where it is while open, since the pointer leaves the strip for the
   * list and the app's item stays under it.
   */
  release() {
    this.#hold();
    if (this.#appMenu) {
      return;
    }
    if (!this.#state.offset && !this.#state.sliding) {
      return;
    }
    this.#state.slideBack = this.#window.setTimeout(() => {
      this.#state.slideBack = null;
      this.#state.offset = 0;
      this.#state.sliding = false;
      this.#el.setAttribute("data-returning", "true");
      this.#place();
    }, SLIDE_BACK_MS);
  }
}
