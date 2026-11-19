/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Workspace switcher: the menu of Workspaces to go to, the workspace
 * menu that acts on one, the menu bar's Workspaces menu, and going from one
 * Workspace to another by a pick, a swipe over the panel or a drag that
 * reorders them.
 *
 * The switcher's button, which names the Workspace the window shows, is the
 * panel's: it is drawn with the window's colour and title
 * (`SvalPanel._renderSwitcher`).
 *
 * The panel makes one of these for its window.
 */

import * as SvalPanelModel from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import * as SvalTree from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import * as SvalWorkspaceEntries from "moz-src:///browser/components/sval/SvalWorkspaceEntries.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NEW_WORKSPACE_KEY: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  SWIPE_WORKSPACES_PREF: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  SvalDeviceNames: "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  ariaShortcut: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  clickText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  dropSide: "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
  openContextMenu:
    "moz-src:///browser/components/sval/SvalPanelRowMenu.sys.mjs",
  shortcutText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  showDropLine: "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
  tidySeparators: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
});
// A namespace: the module exports functions, and no object of its name.
ChromeUtils.defineLazyGetter(lazy, "SvalAgentControl", () =>
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  )
);

/** A workspace entry of the switcher being dragged, by id. */
const WORKSPACE_DRAG_TYPE = "application/x-sval-workspace";

/**
 * How far a sideways scroll over the panel goes, in CSS pixels, before it
 * moves the window one workspace. A wheel's line or page reaches it at once.
 */
const SWIPE_THRESHOLD_PX = 50;

/**
 * How long the wheel rests before a sideways scroll counts as a new one.
 * A DOM `wheel` event carries no gesture phase, and macOS goes on sending a
 * swipe's momentum as wheel events at the display's rate after the fingers
 * lift, so a rest is the only end of a gesture the panel can see.
 */
const SWIPE_REST_MS = 250;

/**
 * How far a gesture travels, in CSS pixels on either axis, before it is
 * locked sideways or upright (`SvalPanelSwitcher`). A
 * trackpad's first events wander, and a few pixels is enough to read
 * which way the fingers mean to go.
 */
const SWIPE_DEAD_ZONE_PX = 6;

/** The most rows the switcher's menu shows before it scrolls. */
const MENU_ROWS = 12;

/** The narrowest the switcher's menu opens over the strip. */
const STRIP_LIST_MIN_PX = 220;

/**
 * What the switcher reads of its panel, and asks of it: its tree, settings
 * and elements, its strip, and the commands, redraws and media labels the
 * rows share.
 *
 * @typedef {object} PanelView
 * @property {object} nodes The document's `nodes` map as the panel draws it.
 * @property {object} workspace The window's `SvalWindowWorkspace`.
 * @property {object|null} engine The window's engine.
 * @property {object} settings The window's `SvalLocalSettings` store.
 * @property {object|null} pins The window's pins row.
 * @property {object|null} agentMarking The layer over an agent's window.
 * @property {boolean} inMemory Whether the window's tree is in memory.
 * @property {boolean} built Whether the panel's frame is built.
 * @property {object} els The panel's elements.
 * @property {object} strip The window's `SvalPanelStrip`.
 * @property {Function} guard Runs a command, as a key's runs.
 * @property {Function} run Runs a command.
 * @property {Function} refresh Reads the tree again and redraws.
 * @property {Function} render Redraws the rows.
 * @property {Function} mediaLabel What a media action is called.
 * @property {Function} mediaTooltip A media button's tooltip.
 * @property {Function} tabsOfNodes Every window's tabs for nodes.
 */

/** One window's Workspace switcher. */
export class SvalPanelSwitcher {
  /**
   * How long the wheel rests before its next event starts a gesture of its
   * own, and how far a gesture travels before it counts, for the strip's
   * wheel as for the panel's swipe.
   */
  wheelRestMs = SWIPE_REST_MS;
  wheelGesturePx = SWIPE_THRESHOLD_PX;

  #window;

  /** @type {PanelView} */
  #view;

  /**
   * The wheel gesture over the panel in progress, or null:
   * `{ at, axis, held, travelX, travelY, before, turn }`. The `timeStamp`
   * of its last event; `"x"` or `"y"` once locked, null before; whether
   * its first event held the tree still; its travel on each axis and its
   * sideways travel before the lock; and its swipes as
   * `SvalPanelModel.wheelTurn` reads them.
   */
  #swipe = null;

  /** What opened the switcher's menu, when the strip did. */
  #opener = null;

  /** The entry a dragged Workspace would drop beside. */
  #dropOn = null;

  /** The Workspace the workspace menu was last opened on. */
  #menuWorkspace = null;

  /** Whether the workspace menu was last opened on the strip. */
  #menuOnStrip = false;

  /**
   * @param {Window} win The panel's chrome window.
   * @param {PanelView} view
   */
  constructor(win, view) {
    this.#window = win;
    this.#view = view;
  }

  /**
   * Listens on the panel's frame and the switcher's button, once built.
   *
   * @param {Element} root The panel's root, whose wheel a swipe is.
   * @param {Element} switcher The switcher's button.
   */
  listen(root, switcher) {
    // Not passive: a gesture locked sideways holds the tree still.
    root.addEventListener("wheel", event => this.#onPanelWheel(event), {
      passive: false,
    });
    switcher.addEventListener("keydown", event =>
      this.#onSwitcherKeyDown(event)
    );
    switcher.addEventListener("contextmenu", event => {
      if (!this.#workspaceMenuUp()) {
        this.openWorkspaceMenu(event);
      }
    });
  }

  /** @returns {boolean} whether the workspace menu is opening or open. */
  #workspaceMenuUp() {
    const { state } = this.#view.els.workspaceMenu;
    return state === "showing" || state === "open";
  }

  /**
   * A right-click on an entry of the switcher's menu, or inside its submenu,
   * is for its Workspace; elsewhere in the list there is none to act on.
   *
   * @param {MouseEvent} event `contextmenu` in the switcher's menu.
   */
  #onMenuContextMenu(event) {
    if (this.#workspaceMenuUp()) {
      return;
    }
    event.preventDefault();
    const id = event.target.closest("[data-workspace-id]")?.dataset.workspaceId;
    if (id) {
      this.openWorkspaceMenu(event, id);
    }
  }

  /**
   * @param {Event} event `popuphidden` in the switcher's menu.
   */
  #onMenuHidden(event) {
    const menu = this.#view.els.switcherMenu;
    if (event.target !== menu) {
      return;
    }
    (this.#opener ?? this.#view.els.switcher).setAttribute(
      "aria-expanded",
      "false"
    );
    this.#opener = null;
    menu.removeAttribute("sval-keys");
  }

  /**
   * Builds the workspace switcher's popup, parked beside the row menu in
   * `#mainPopupSet` for the same reasons.
   *
   * Its items *are* rebuilt on every `popupshowing`, unlike the row menu's:
   * what a workspace menu offers is one entry per workspace, and that list
   * changes whenever a peer's pass brings one in or takes one away. A fixed
   * set of items toggled by `hidden` would need a cap on how many workspaces
   * a person may own.
   *
   * It is drawn as the Favorites menu is (`SvalPanel._buildFavoritesMenu`).
   *
   * @returns {Element} the `menupopup`.
   */
  buildMenu() {
    const menu = this.#window.document.createXULElement("menupopup");
    menu.id = "sval-workspace-menu";
    this.#window.document.getElementById(menu.id)?.remove();
    // Windows passes on the press that closes a menu in a `popupset`
    // (`nsMenuPopupFrame::ConsumeOutsideClicks`), and that press on the
    // switcher would open it again.
    menu.setAttribute("consumeoutsideclicks", "true");
    menu.setAttribute("nonnative", "");
    menu.classList.add("toolbar-menupopup");
    menu.addEventListener("contextmenu", event =>
      this.#onMenuContextMenu(event)
    );
    menu.addEventListener("popupshowing", event =>
      this.#onSwitcherShowing(event)
    );
    menu.addEventListener("popuphidden", event => this.#onMenuHidden(event));
    menu.addEventListener("command", event => this.#onSwitcherCommand(event));
    menu.addEventListener("mouseup", event => this.#onSwitcherMouseUp(event));
    // The keyboard's ring shows from the first key pressed in the menu,
    // and the pointer takes it away (`sval-panel.css`, menus).
    menu.addEventListener("mousemove", () => menu.removeAttribute("sval-keys"));
    for (const type of [
      "dragstart",
      "dragover",
      "dragleave",
      "drop",
      "dragend",
    ]) {
      menu.addEventListener(type, event => this.onDrag(event));
    }
    this.#window.addEventListener(
      "keydown",
      event => this.#onSwitcherMenuKeyDown(event),
      true
    );
    this.#window.document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  /**
   * Opens the switcher's menu over its button, the menu's top-left corner
   * on the button's and at least as wide, so the list starts where the
   * button is and nothing opens above it: a window at the top of the screen
   * would have the menu over the macOS menu bar, which Gecko does not allow
   * a menu to cover (`MenusCanOverlapOSBar`). Where the strip stands in for
   * the button, the menu opens over the strip's track, at least
   * {@link STRIP_LIST_MIN_PX} wide, since the column's track is narrower
   * than any name.
   */
  open() {
    const { switcher, switcherMenu: menu, strip } = this.#view.els;
    const onStrip = this.#view.strip.shown();
    const anchor = onStrip
      ? strip.querySelector(".sval-strip-track")
      : switcher;
    const width = anchor.getBoundingClientRect().width;
    menu.style.setProperty(
      "--sval-switcher-width",
      `${onStrip ? Math.max(STRIP_LIST_MIN_PX, width) : width}px`
    );
    // What says the list is open: the button, or the current Workspace's
    // tab on the strip.
    this.#opener = onStrip
      ? strip.querySelector(".sval-strip-item[data-current]")
      : switcher;
    menu.openPopup(anchor, "overlap", 0, 0, false, false);
  }

  /**
   * Shows at most {@link MENU_ROWS} of the switcher's menu's rows, scrolled
   * so the current Workspace's is as near their middle as the ends allow.
   * Run on the frame the menu is first drawn, once it has a layout and
   * before it is painted.
   */
  #scrollSwitcherMenu() {
    const menu = this.#view.els.switcherMenu;
    if (menu.state !== "showing" && menu.state !== "open") {
      return;
    }
    const current = menu.querySelector(':scope > menu[aria-current="true"]');
    const entry = current ?? menu.querySelector(":scope > menu");
    const rowHeight = entry?.getBoundingClientRect().height ?? 0;
    if (rowHeight) {
      menu.style.setProperty(
        "--sval-menu-rows-max",
        `${MENU_ROWS * rowHeight}px`
      );
    }
    if (!current) {
      return;
    }
    const scrollbox = menu.scrollBox.scrollbox;
    const view = scrollbox.clientHeight;
    const top =
      current.getBoundingClientRect().top -
      scrollbox.getBoundingClientRect().top +
      scrollbox.scrollTop;
    scrollbox.scrollTop = Math.max(
      0,
      Math.min(scrollbox.scrollHeight - view, top + rowHeight / 2 - view / 2)
    );
  }

  /**
   * Fills the switcher with one entry per workspace, the one the window
   * shows marked `aria-current` in its place.
   *
   * Below the list is "New Workspace…", the one place a workspace is made.
   *
   * **Each entry's submenu acts on its workspace**: "Open in New Window",
   * then the workspace menu's own entries, which the arrow keys reach as the
   * mouse does (spec §10.5). A right-click on an entry opens the workspace
   * menu for it. An entry is a `menu`, which Gecko opens and never runs as a
   * command (`XULButtonElement::PostHandleEventForMenus`,
   * `HandleEnterKeyPress`), so `#onSwitcherMouseUp` and
   * `#onSwitcherMenuKeyDown` give its click and Enter the switch a
   * `menuitem`'s would run. Shift opens the workspace in a new window
   * instead.
   *
   * @param {Event} event `popupshowing` on `#sval-workspace-menu`.
   */
  #onSwitcherShowing(event) {
    const menu = this.#view.els.switcherMenu;
    if (event.target !== menu) {
      return;
    }
    this.fill();
    (this.#opener ?? this.#view.els.switcher).setAttribute(
      "aria-expanded",
      "true"
    );
    this.#window.requestAnimationFrame(() => this.#scrollSwitcherMenu());
  }

  /**
   * Fills the switcher's popup from the document as it stands now.
   *
   * Reached from `popupshowing` and from `SvalPanel._renderSwitcher` while the
   * popup is open, which is what keeps the two in step; see
   * `refillOpen`.
   */
  fill() {
    const menu = this.#view.els.switcherMenu;
    // The window's own workspace keeps its place, so the list reads the same
    // from every window and in the order a swipe goes ({@link
    // _stepWorkspace}).
    const items = this.list();
    menu.textContent = "";
    for (const item of items.filter(entry =>
      SvalWorkspaceEntries.usersOwn(entry)
    )) {
      const el = this.#workspaceEntry(item);
      // The user's own workspaces are put in order by dragging, as
      // Favorites are in theirs; the devices' and agents' lists keep
      // their own order.
      if (!this.#view.inMemory) {
        el.setAttribute("draggable", "true");
      }
      menu.append(el);
    }
    const devices = items.filter(entry => entry.device);
    if (devices.length) {
      SvalWorkspaceEntries.appendDevicesCaption(menu);
    }
    for (const item of devices) {
      const el = this.#workspaceEntry(item);
      SvalWorkspaceEntries.countDeviceTabs(el, item, this.#view.nodes);
      menu.append(el);
    }
    this.#appendSwitcherAgentApps(
      menu,
      items.filter(entry => entry.agent)
    );

    if (menu.firstChild) {
      menu.append(this.#window.document.createXULElement("menuseparator"));
    }
    const addWorkspace = this.#window.document.createXULElement("menuitem");
    SvalWorkspaceEntries.labelMenuEntry(addWorkspace, "New Workspace…");
    addWorkspace.setAttribute("data-sval-new-workspace", "true");
    // Draws nothing until the user gives the key one in Settings.
    addWorkspace.setAttribute("key", lazy.NEW_WORKSPACE_KEY);
    menu.append(addWorkspace);
  }

  /**
   * Rebuilds an open switcher when the document no longer holds the entries it
   * is showing.
   *
   * A popup is a picture of the document as it was when it opened, and a sync
   * pass can take a workspace away while that picture is on screen. Rebuilding
   * on the same redraw that moves the window is what makes a vanished entry
   * unpressable: the entry disappears, which is the answer, and the panel
   * follows the document rather than the click (spec §10.7).
   *
   * **Only when the entries themselves would differ.** Every change the
   * document sees redraws, a tab's title arriving from a peer among them, and
   * rebuilding the popup under someone's cursor takes away whatever they had
   * highlighted. Which workspaces are offered and what each is called is the
   * whole of what a stale entry can be wrong about.
   */
  refillOpen() {
    const menu = this.#view.els.switcherMenu;
    if (menu.state !== "open" && menu.state !== "showing") {
      return;
    }
    const items = this.list();
    const wanted = items.map(
      item =>
        `${item.id}\t${SvalWorkspaceEntries.switcherItemLabel(item)}\t${item.current}`
    );
    const drawn = Array.from(
      menu.querySelectorAll("[data-workspace-id]"),
      el =>
        `${el.dataset.workspaceId}\t${el.dataset.entryName}\t${el.getAttribute("aria-current") === "true"}`
    );
    const wantedOpenable = items
      .filter(item => !item.current && !item.elsewhere)
      .map(item => item.id);
    const drawnOpenable = Array.from(
      menu.querySelectorAll("[data-open-workspace-id]"),
      el => el.dataset.openWorkspaceId
    );
    if (
      wanted.join("\n") !== drawn.join("\n") ||
      wantedOpenable.join("\n") !== drawnOpenable.join("\n")
    ) {
      this.fill();
    }
  }

  /**
   * This device and every device's name, for an agent workspace's label.
   *
   * @returns {object|null} As `SvalPanelModel.agentLabelOf` takes it.
   */
  devices() {
    const self = this.#view.engine?.deviceIdHex;
    if (!self) {
      return null;
    }
    return { self, nameOf: device => lazy.SvalDeviceNames.nameOf(device) };
  }

  /**
   * Shows or hides one switcher entry's media button, for every tab of its
   * workspace (`workspaceMedia`).
   *
   * @param {Element} el A `menu[data-workspace-id]`.
   */
  #paintEntrySound(el) {
    const action = this.workspaceMedia(el.dataset.workspaceId);
    if (action) {
      el.setAttribute("data-media", action);
    } else {
      el.removeAttribute("data-media");
    }
    const button = el.querySelector(":scope > .sval-switcher-audio");
    if (button && action) {
      button.title = this.#view.mediaTooltip(
        this.workspaceTabs(el.dataset.workspaceId)
      );
    }
    const submenu = el.querySelector(":scope > menupopup");
    if (submenu) {
      this.#syncWorkspaceCommands(submenu, el.dataset.workspaceId);
    }
  }

  /**
   * Paints every entry's media button while the switcher is open, and the
   * strip's sound badges.
   */
  paintSound() {
    this.#view.strip.paintSounds();
    const menu = this.#view.els?.switcherMenu;
    if (menu?.state !== "open" && menu?.state !== "showing") {
      return;
    }
    for (const el of menu.querySelectorAll(
      ":scope > menu[data-workspace-id]"
    )) {
      this.#paintEntrySound(el);
    }
  }

  /**
   * The switcher's entries: the user's own workspaces, then the phones'
   * and tablets' (decision 2254), then the agents' (agent-control spec
   * §3.5), each part in sibling order. The devices' and the agents' each
   * come under a caption of their own (`appendDevicesCaption`,
   * `appendAgentsCaption`), so the list the user works from is never
   * interleaved with places another device or an agent works.
   *
   * @returns {object[]} `SvalPanelModel.switcherItems` entries.
   */
  list() {
    const items = SvalPanelModel.switcherItems(
      this.#view.nodes,
      this.#view.workspace.id,
      this.#view.workspace.shownElsewhere(),
      this.devices()
    );
    return [
      ...items.filter(i => SvalWorkspaceEntries.usersOwn(i)),
      ...items.filter(i => i.device),
      ...items.filter(i => i.agent),
    ];
  }

  /**
   * One workspace's entry: a `menu` that goes to the workspace
   * (`#onSwitcherMouseUp`), whose submenu acts on it.
   *
   * @param {object} item Its `switcherItems` entry.
   * @returns {Element}
   */
  #workspaceEntry(item) {
    const el = this.#window.document.createXULElement("menu");
    el.setAttribute("data-workspace-id", item.id);
    // What `refillOpen` compares. An agent's entry is
    // labelled with its last use too (`labelAgentEntry`), which
    // changes as time passes.
    el.dataset.entryName = SvalWorkspaceEntries.switcherItemLabel(item);
    // The emoji leads the label as it leads the switcher's own name, so an
    // entry reads, and is announced, as the button does once chosen.
    SvalWorkspaceEntries.labelWorkspaceEntry(el, item);
    SvalWorkspaceEntries.markAgentItem(el, item);
    SvalWorkspaceEntries.markDeviceItem(el, item, this.#view.nodes);
    SvalWorkspaceEntries.markIsolatedItem(el, item, this.#view.nodes);
    if (item.current) {
      el.setAttribute("aria-current", "true");
    }
    const popup = this.#window.document.createXULElement("menupopup");
    // Drawn as its parent is (`buildMenu`): a submenu left
    // native is drawn by the platform, apart from the switcher's style.
    popup.setAttribute("nonnative", "");
    popup.classList.add("toolbar-menupopup");
    // A workspace has one window (spec §10.7), so only a workspace no
    // window shows is offered a new one.
    if (!item.current && !item.elsewhere) {
      const open = this.#window.document.createXULElement("menuitem");
      open.setAttribute("data-open-workspace-id", item.id);
      SvalWorkspaceEntries.labelMenuEntry(open, "Open in New Window");
      // Shift+Enter and a Shift-click on the workspace's entry do the
      // same (`#onSwitcherMenuKeyDown`, `#onSwitcherMouseUp`).
      const shiftEnter = { keycode: "VK_RETURN", modifiers: "shift" };
      const shiftClick = lazy.clickText("shift");
      open.setAttribute(
        "acceltext",
        `${lazy.shortcutText(shiftEnter)} or ${shiftClick}`
      );
      open.setAttribute("aria-keyshortcuts", lazy.ariaShortcut(shiftEnter));
      popup.append(
        open,
        this.#window.document.createXULElement("menuseparator")
      );
    }
    popup.append(...this.#workspaceCommandItems());
    this.#syncWorkspaceCommands(popup, item.id);
    el.append(popup);
    // Pressed without picking the workspace (`#onSwitcherMouseUp`);
    // the submenu's media entry is the keyboard's way to it.
    const audio = this.#window.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button"
    );
    audio.className = "sval-switcher-audio";
    audio.setAttribute("tabindex", "-1");
    audio.setAttribute("aria-hidden", "true");
    el.append(audio);
    this.#paintEntrySound(el);
    return el;
  }

  /**
   * The agents' workspaces in the switcher, under their caption
   * (`appendAgentApps`). Each is a workspace's entry, as the user's
   * own are (`#agentWorkspaceRow`).
   *
   * @param {Element} menu The switcher's `menupopup`.
   * @param {object[]} items The agents' `switcherItems` entries.
   */
  #appendSwitcherAgentApps(menu, items) {
    if (!items.length) {
      return;
    }
    SvalWorkspaceEntries.appendAgentsCaption(menu, items[0]);
    const apps = SvalWorkspaceEntries.appendAgentApps(menu, items, item =>
      this.#agentWorkspaceRow(item)
    );
    for (const el of apps) {
      // Drawn as the switcher is (`buildMenu`).
      const popup = el.querySelector(":scope > menupopup");
      popup.setAttribute("nonnative", "");
      popup.classList.add("toolbar-menupopup", "sval-agent-app-popup");
    }
  }

  /**
   * One agent workspace's switcher entry (`labelAgentEntry`). It
   * sits in its app's menu, which carries the app's mark, and wears the
   * mark of the model its session said it runs on, when Sval knows it.
   *
   * @param {object} item Its `switcherItems` entry.
   * @returns {Element}
   */
  #agentWorkspaceRow(item) {
    const el = this.#workspaceEntry(item);
    SvalWorkspaceEntries.labelAgentEntry(el, item);
    return el;
  }

  /**
   * @param {Event} event `command` from the switcher: a workspace `menuitem`,
   *   an entry's "Open in New Window", or "New Workspace…".
   */
  #onSwitcherCommand(event) {
    if (this.#view.inMemory) {
      return;
    }
    if (event.target.hasAttribute("data-sval-new-workspace")) {
      this.#view.run("addWorkspace", null);
      return;
    }
    const { workspaceId, openWorkspaceId, command } = event.target.dataset;
    if (openWorkspaceId) {
      this.openInNewWindow(openWorkspaceId);
      return;
    }
    if (command) {
      const id = event.target.closest("menu[data-workspace-id]")?.dataset
        .workspaceId;
      if (id) {
        this.#runWorkspaceCommand(command, id);
      }
      return;
    }
    if (workspaceId) {
      this.pick(workspaceId, event.shiftKey);
    }
  }

  /**
   * A press released on a workspace entry that is a `menu`
   * (`fill`): the switch, or with Shift the new window.
   *
   * @param {MouseEvent} event `mouseup` in the switcher.
   */
  #onSwitcherMouseUp(event) {
    if (event.button !== 0) {
      return;
    }
    const audio = event.target.closest?.(".sval-switcher-audio");
    if (audio) {
      const entry = audio.closest("menu[data-workspace-id]");
      lazy.SvalFirefox.actOnMedia(
        this.workspaceTabs(entry.dataset.workspaceId)
      );
      return;
    }
    // A release inside an entry's submenu is that item's own `command`.
    // An app's menu of agent workspaces holds entries of its own.
    const popup = event.target.closest?.("menupopup");
    if (
      popup !== this.#view.els.switcherMenu &&
      !popup?.classList.contains("sval-agent-app-popup")
    ) {
      return;
    }
    const el = event.target.closest("menu[data-workspace-id]");
    if (!el) {
      return;
    }
    this.#view.els.switcherMenu.hidePopup();
    this.pick(el.dataset.workspaceId, event.shiftKey);
  }

  /**
   * Enter on a workspace entry that is a `menu` (`fill`).
   * Gecko's popup manager takes a menu's keys in the capture phase at the
   * document (`nsXULPopupManager::UpdateKeyboardListeners`), so this listens
   * at the window, ahead of it. An entry whose submenu has an active item
   * leaves Enter to that item.
   *
   * @param {KeyboardEvent} event `keydown` at the window.
   */
  #onSwitcherMenuKeyDown(event) {
    const menu = this.#view.els.switcherMenu;
    if (menu.state === "open") {
      menu.setAttribute("sval-keys", "");
    }
    if (event.key !== "Enter" || menu.state !== "open") {
      return;
    }
    // A popup has no `activeChild` of its own (`XULMenuElement` is a
    // `menu`'s), and Gecko marks its active item `_moz-menuactive`.
    // The innermost active entry: an agent workspace's is inside its app's
    // menu, under the app's own active entry.
    const el = [
      ...menu.querySelectorAll("menu[_moz-menuactive][data-workspace-id]"),
    ].at(-1);
    if (!el || el.activeChild) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    menu.hidePopup();
    this.pick(el.dataset.workspaceId, event.shiftKey);
  }

  /**
   * Goes to a workspace chosen in the switcher, or opens it in a window of
   * its own.
   *
   * @param {string} id
   * @param {boolean} inNewWindow
   * @returns {Promise<void>} settled once the switch has run.
   */
  pick(id, inNewWindow) {
    if (this.#view.inMemory) {
      return Promise.resolve();
    }
    if (inNewWindow) {
      this.openInNewWindow(id);
      return Promise.resolve();
    }
    // Caught here rather than left to float: this is an event handler, so
    // there is nobody above it to reject to, and a switch that fails silently
    // would leave the panel drawing one workspace while the window believed
    // it was in another.
    return this.#view.workspace.switchTo(id).then(
      () => {},
      err => {
        lazy.SvalLog.error(
          `switching workspace failed: ${lazy.describeError(err)}`
        );
      }
    );
  }

  /**
   * A wheel over the panel. A sideways scroll moves the window one place
   * along the switcher's list (`#stepWorkspace`), once per swipe, as
   * `SvalPanelModel.wheelTurn` reads one: the travel adds up to
   * {@link SWIPE_THRESHOLD_PX}, and the rest of the swipe, its momentum
   * included, does nothing more.
   *
   * A positive `deltaX` goes to the next workspace. Firefox's page swipe
   * reads the same sign as `browser.gesture.swipe.right`, Forward
   * (`nsIWidget::SendMayStartSwipe`), and the tree's rows go down for a
   * positive `deltaY`. The page swipe reads the same delta, so a gesture
   * that goes Forward over a page goes to the next workspace over the
   * panel, whichever way the system's scroll direction setting turns it.
   *
   * Where Shift turns a wheel sideways (`mousewheel.with_shift.action` 4,
   * `WheelDeltaHorizontalizer`), the event keeps its vertical delta and
   * only its default action scrolls sideways, so the delta is turned here
   * too. macOS turns Shift with a one-axis wheel sideways itself, and
   * the event arrives with a `deltaX`.
   *
   * **Each gesture is locked to one axis**, so a swipe that drifts upright
   * still moves the window and a scroll that drifts sideways still only
   * scrolls. The first {@link SWIPE_DEAD_ZONE_PX} of travel decide it: a
   * gesture locked sideways holds the tree still with `preventDefault`,
   * and one locked upright scrolls it and moves no workspace. Gecko's own
   * lock (`apz.axis_lock.mode`) picks the dominant axis event by event,
   * which lets a diagonal swipe scroll the tree on its upright events.
   *
   * The listener is not passive, so APZ waits for it before scrolling the
   * tree, and it does no more than add up deltas. APZ takes the first
   * wheel event of a gesture's input block as its answer for the whole
   * block (`CancelableBlockState::SetContentResponse`), so on that event a
   * gesture that starts sideways holds the tree still, before its lock is
   * read. One that goes on upright then leaves the tree where it was until
   * the next gesture. Firefox's swipe gesture listens on `gBrowser.tabbox`
   * alone (`gGestureSupport.init`), which the panel is a sibling of, and
   * the tree never scrolls sideways (`sval-panel.css`).
   *
   * @param {WheelEvent} event
   */
  #onPanelWheel(event) {
    if (
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      !Services.prefs.getBoolPref(lazy.SWIPE_WORKSPACES_PREF)
    ) {
      return;
    }
    const perUnit =
      event.deltaMode === event.DOM_DELTA_PIXEL ? 1 : SWIPE_THRESHOLD_PX;
    let dx = event.deltaX * perUnit;
    let dy = event.deltaY * perUnit;
    if (
      event.shiftKey &&
      Services.prefs.getIntPref("mousewheel.with_shift.action", 0) === 4
    ) {
      [dx, dy] = [dy, dx];
    }
    const at = event.timeStamp;
    let swipe = this.#swipe;
    if (!swipe || at - swipe.at > SWIPE_REST_MS || event.isGestureStart) {
      swipe = this.#swipe = {
        at,
        axis: null,
        held: Math.abs(dx) > Math.abs(dy),
        travelX: 0,
        travelY: 0,
        before: 0,
        turn: null,
      };
    }
    swipe.at = at;
    let delta = dx;
    if (swipe.axis === null) {
      swipe.travelX += Math.abs(dx);
      swipe.travelY += Math.abs(dy);
      swipe.before += dx;
      if (Math.max(swipe.travelX, swipe.travelY) >= SWIPE_DEAD_ZONE_PX) {
        swipe.axis = swipe.travelX > swipe.travelY ? "x" : "y";
      }
      if (swipe.held || swipe.axis === "x") {
        event.preventDefault();
      }
      if (swipe.axis !== "x") {
        return;
      }
      // The travel that decided the lock counts toward the move.
      delta = swipe.before;
    } else {
      if (swipe.axis !== "x") {
        return;
      }
      event.preventDefault();
    }
    const { gesture, step } = SvalPanelModel.wheelTurn(
      swipe.turn,
      {
        at,
        delta,
        momentum: event.isMomentum,
        start: event.isGestureStart,
      },
      { restMs: SWIPE_REST_MS, stepPx: SWIPE_THRESHOLD_PX }
    );
    swipe.turn = gesture;
    if (step) {
      this.#stepWorkspace(step);
    }
  }

  /**
   * Moves the window `step` places along the switcher's list of the user's
   * own workspaces, through the switcher's own switch, wrapping from either
   * end to the other. The devices' and the agents' workspaces are lists of
   * their own in the switcher (`list`), and one an agent
   * controls lays its overlay
   * over the whole window, panel included (`SvalAgentMarking`), so a swipe
   * into it could not swipe back out.
   *
   * A workspace another window shows brings that window forward
   * (`SvalWindowWorkspace.show`), and the gesture's momentum may go on arriving over
   * it, so that window's panel takes the spent gesture
   * (`catchSwipe`).
   *
   * @param {number} step 1 for the next workspace, -1 for the previous.
   */
  #stepWorkspace(step) {
    const items = this.list().filter(item =>
      SvalWorkspaceEntries.usersOwn(item)
    );
    const here = items.findIndex(item => item.current);
    const next =
      here === -1 ? null : items[(here + step + items.length) % items.length];
    if (!next || next.current) {
      return;
    }
    if (next.elsewhere) {
      this.#view.workspace
        .shownElsewhere()
        .get(next.id)
        ?.SvalPanel?.switcher.catchSwipe(step);
    }
    this.pick(next.id, false);
  }

  /**
   * The user's own workspaces in the switcher's order, the one order the
   * switcher, a swipe and the Launcher list them in.
   *
   * @returns {string[]}
   */
  #workspaceOrder() {
    return this.list()
      .filter(item => SvalWorkspaceEntries.usersOwn(item))
      .map(item => item.id);
  }

  /**
   * Moves workspace `id` to `side` of workspace `target` in that order,
   * as one placement change to the document, which syncs as any move
   * does (`SvalPanelModel.moveWorkspaceOp`).
   *
   * @param {string} id
   * @param {string} target
   * @param {string} side `"before"` or `"after"`.
   * @returns {Promise<void>}
   */
  #moveWorkspace(id, target, side) {
    const op = this.#view.inMemory
      ? null
      : SvalPanelModel.moveWorkspaceOp(
          this.#workspaceOrder(),
          id,
          target,
          side
        );
    if (!op) {
      return Promise.resolve();
    }
    return this.#view.guard("moving a workspace", async () => {
      await this.#view.engine.mutate(op);
      await this.#view.refresh();
    });
  }

  /**
   * Drag and drop in the switcher's menu or along the strip, which
   * reorders the user's workspaces as the Favorites menu reorders favorites
   * (`SvalFavoritesView`), with its drop side and its drop line.
   *
   * @param {DragEvent} event On the menu or the strip's tablist.
   */
  onDrag(event) {
    const list = event.currentTarget;
    switch (event.type) {
      case "dragstart": {
        const el = event.target.closest?.("[data-workspace-id]");
        if (el?.getAttribute("draggable") !== "true") {
          return;
        }
        event.dataTransfer.mozSetDataAt(
          WORKSPACE_DRAG_TYPE,
          el.dataset.workspaceId,
          0
        );
        event.dataTransfer.effectAllowed = "move";
        event.stopPropagation();
        break;
      }
      case "dragover": {
        event.stopPropagation();
        this.#view.strip.scrollForDrag(event);
        const point = this.#workspaceDropPoint(event);
        this.#showWorkspaceDrop(point?.el ?? null, point?.side);
        if (point) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
        break;
      }
      case "dragleave":
        if (!event.relatedTarget || !list.contains(event.relatedTarget)) {
          this.#showWorkspaceDrop(null);
        }
        break;
      case "drop": {
        event.stopPropagation();
        const point = this.#workspaceDropPoint(event);
        this.#showWorkspaceDrop(null);
        if (!point) {
          return;
        }
        event.preventDefault();
        this.#moveWorkspace(
          event.dataTransfer.mozGetDataAt(WORKSPACE_DRAG_TYPE, 0),
          point.el.dataset.workspaceId,
          point.side
        );
        break;
      }
      case "dragend":
        this.#showWorkspaceDrop(null);
        if (list !== this.#view.els.switcherMenu) {
          this.#view.strip.release();
        }
        break;
    }
  }

  /**
   * Where a drop at `event` puts the dragged workspace: the entry under
   * the pointer and the side of it by Favorites' rule
   * (`SvalFavoritesView.dropSide`), along the row on the strip. Null for
   * anything but a workspace entry of the user's being dragged over one.
   *
   * @param {DragEvent} event
   * @returns {?{el: Element, side: string}}
   */
  #workspaceDropPoint(event) {
    if (!event.dataTransfer?.types.includes(WORKSPACE_DRAG_TYPE)) {
      return null;
    }
    const el = event.target.closest?.("[data-workspace-id]");
    const onStrip = el?.classList.contains("sval-strip-item");
    // The strip's row is split by halves along it, the column's as the
    // menu's rows are.
    const alongRow =
      onStrip && this.#view.els.strip.dataset.layout !== "column";
    if (
      (el?.parentNode !== this.#view.els.switcherMenu && !onStrip) ||
      el.getAttribute("draggable") !== "true"
    ) {
      return null;
    }
    return {
      el,
      side: lazy.dropSide(el, event.clientY, alongRow ? event.clientX : null),
    };
  }

  /**
   * Draws the drop line on `el`'s `side`, with the Favorites menu's own
   * line (`SvalFavoritesView.showDropLine`).
   *
   * @param {?Element} el
   * @param {string} [side]
   */
  #showWorkspaceDrop(el, side) {
    this.#dropOn = lazy.showDropLine(this.#dropOn, el, side);
  }

  /**
   * Takes a gesture that has already moved by `dir` in another window and
   * brought this one forward, so the rest of it does nothing here either.
   * Each window's `timeStamp`s count from its own time origin, so the
   * gesture's last event is this window's now.
   *
   * @param {number} dir The sign the gesture moved by.
   */
  catchSwipe(dir) {
    const at = this.#window.performance.now();
    this.#swipe = {
      at,
      axis: "x",
      held: true,
      travelX: 0,
      travelY: 0,
      before: 0,
      turn: SvalPanelModel.spentWheelTurn(at, dir),
    };
  }

  /**
   * Tears a workspace off into its own window (spec §10.7): a browser window
   * whose current workspace is `id`.
   *
   * **A workspace has one window.** The switcher offers only workspaces no
   * window shows, and a request for one that a window does show, this one
   * included, brings that window forward and opens nothing. This window does
   * not move, no node moves, no tab is released and nothing is deleted: the
   * new window materialises the workspace's tabs for itself, matching by the
   * node id each tab carries.
   *
   * **The workspace reaches the new window as a hand-off it consumes at
   * startup**, and the new window then records it under the same
   * `CURRENT_WORKSPACE_KEY` a restart reads, so there is one answer to "which
   * workspace does this window show" rather than a second mechanism for a
   * torn-off one, and nothing in the new window's panel needs to know it was
   * torn off. `SvalPanelModel.handWorkspaceTo` carries why it cannot simply be
   * written onto the new window from here.
   *
   * `OpenBrowserWindow` returns before the new window has run any of its own
   * startup: `nsWindowWatcher::OpenWindow` is synchronous, but `SvalPanel.init`
   * runs only once the window's delayed startup has finished
   * (`SvalWindow.delayedStartup`), which waits for its first paint, so the
   * hand-off is in place before anything reads it.
   *
   * @param {string} id A workspace id.
   * @returns {DOMWindow|null} the new window, or null if `id` is not a
   *   workspace this document holds or a window already shows it.
   */
  openInNewWindow(id) {
    if (this.#view.inMemory) {
      return null;
    }
    const { handWorkspaceTo } = SvalPanelModel;
    const { WORKSPACE } = SvalTree;
    if (this.#view.nodes[id]?.kind !== WORKSPACE) {
      // A workspace another device deleted between the menu being built and an
      // entry being pressed. The redraw takes the entry away, which is the
      // answer (spec §10.7).
      this.#view.render();
      return null;
    }
    if (id === this.#view.workspace.id) {
      this.#window.focus();
      return null;
    }
    const shownBy = this.#view.workspace.shownElsewhere().get(id);
    if (shownBy) {
      shownBy.focus();
      return null;
    }

    const opened = this.#window.OpenBrowserWindow();
    handWorkspaceTo(opened, id);
    return opened;
  }

  /**
   * Builds the menu a right-click on the switcher opens: the commands that act
   * on the workspace this window shows, or on the switcher entry it was
   * right-clicked on.
   *
   * The workspace is not a row (spec §10.7), so it has no row menu to
   * right-click; the switcher button is what names it, and so is where its
   * context menu is. A left-click on the same button opens the list of
   * workspaces to go to, which is a different question.
   *
   * Fixed items, built once, like the row menu: the entries do not depend on
   * how many workspaces there are.
   *
   * @returns {Element} the `menupopup`.
   */
  buildWorkspaceMenu() {
    const menu = this.#window.document.createXULElement("menupopup");
    menu.id = "sval-workspace-context-menu";
    this.#window.document.getElementById(menu.id)?.remove();
    // A Workspace no window shows can have one of its own, as the switcher
    // menu's entries offer; `#onWorkspaceMenuShowing` shows it on the
    // strip.
    const open = this.#window.document.createXULElement("menuitem");
    open.setAttribute("data-open-workspace", "true");
    open.setAttribute("label", "Open in New Window");
    menu.append(
      open,
      this.#window.document.createXULElement("menuseparator"),
      ...this.#workspaceCommandItems(),
      ...this.#stripNamesItems()
    );
    menu.addEventListener("popupshowing", event => {
      if (event.target === menu) {
        this.#onWorkspaceMenuShowing();
      }
    });
    menu.addEventListener("command", event =>
      this.#onWorkspaceMenuCommand(event)
    );
    this.#window.document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  /**
   * The strip's names controls, which the Workspace menu shows under its
   * commands when it opens on the strip (`#syncStripNamesItems`).
   * Each sets what Settings › Appearance sets, "The strip shows"
   * (`SvalPanelModel.STRIP_NAMES_PREF`).
   *
   * @returns {Element[]}
   */
  #stripNamesItems() {
    const item = (names, label) => {
      const el = this.#window.document.createXULElement("menuitem");
      el.setAttribute("data-strip-names", names);
      el.setAttribute("label", label);
      return el;
    };
    const separator = this.#window.document.createXULElement("menuseparator");
    separator.setAttribute("data-strip-names-separator", "true");
    const show = this.#window.document.createXULElement("menu");
    show.setAttribute("data-strip-names-menu", "true");
    show.setAttribute("label", "Show Workspace Names");
    const popup = this.#window.document.createXULElement("menupopup");
    popup.append(
      item("all", "On Every Workspace"),
      item("current", "On the Current Workspace")
    );
    show.append(popup);
    return [
      separator,
      item("all", "Show Every Workspace's Name"),
      item("none", "Hide Workspace Names"),
      show,
    ];
  }

  /**
   * Shows the names controls that change what the strip shows now, and
   * only on the strip: names on every Workspace can be hidden; only the
   * current name can be shown on every Workspace or hidden; with none, the
   * submenu offers both ways to show them.
   *
   * @param {boolean} onStrip
   */
  #syncStripNamesItems(onStrip) {
    const menu = this.#view.els.workspaceMenu;
    const names = this.#view.strip.names();
    for (const el of menu.querySelectorAll(
      ":scope > [data-strip-names], :scope > [data-strip-names-separator], :scope > [data-strip-names-menu]"
    )) {
      let shown = onStrip;
      if (el.dataset.stripNames === "all") {
        shown &&= names === "current";
      } else if (el.dataset.stripNames === "none") {
        shown &&= names !== "none";
      } else if (el.hasAttribute("data-strip-names-menu")) {
        shown &&= names === "none";
      }
      el.hidden = !shown;
    }
  }

  /**
   * The entries that act on one workspace, as the workspace menu and each
   * switcher entry's submenu list them. `#syncWorkspaceCommands` shows
   * the ones that apply.
   *
   * @returns {Element[]}
   */
  #workspaceCommandItems() {
    const item = (command, label) => {
      const el = this.#window.document.createXULElement("menuitem");
      el.setAttribute("data-command", command);
      el.setAttribute("label", label);
      return el;
    };
    return [
      // Labelled, and shown only for this device's agents, by
      // `#syncWorkspaceCommands`.
      item("stopAgent", "Stop Agent"),
      // Labelled with the agent's name, and shown with Stop, by
      // `#syncWorkspaceCommands`.
      item("agentPermissions", "Permissions…"),
      this.#window.document.createXULElement("menuseparator"),
      // Labelled, and hidden while nothing plays, by
      // `#syncWorkspaceCommands`.
      item("media", "Pause Media"),
      this.#window.document.createXULElement("menuseparator"),
      item("edit", "Edit…"),
      item("isolateWorkspace", "Isolate Workspace…"),
      item("shareWorkspace", "Stop isolating Workspace…"),
      this.#window.document.createXULElement("menuseparator"),
      item("deleteWorkspace", "Delete Workspace…"),
    ];
  }

  /**
   * Shows the entries of `#workspaceCommandItems` that apply to
   * workspace `id`. "Delete workspace" is offered only where there is one to
   * delete: never in a private window, and never for the last workspace.
   *
   * @param {Element} popup The `menupopup` holding them.
   * @param {string} id A workspace id.
   */
  #syncWorkspaceCommands(popup, id) {
    const command = name => popup.querySelector(`[data-command="${name}"]`);
    // A window's one temporary workspace on a tree in memory is not the
    // user's to delete (`SvalPanelModel.contextMenuItems`).
    const remove = command("deleteWorkspace");
    remove.hidden = !!this.#view.inMemory;
    remove.previousElementSibling.hidden = !!this.#view.inMemory;
    // The last workspace stays: a window always shows one (spec §5.4).
    remove.toggleAttribute(
      "disabled",
      SvalTree.workspaceIds(this.#view.nodes).length < 2
    );
    // A private window's workspace already has a jar of its own, and goes
    // with the window.
    const isolated = lazy.SvalWorkspaceJar.isIsolated(this.#view.nodes, id);
    command("isolateWorkspace").hidden = !!this.#view.inMemory || isolated;
    command("shareWorkspace").hidden = !!this.#view.inMemory || !isolated;
    // A Stop holds where its agent's session runs, so only an agent this
    // device paired is offered one (`SvalAgentControl.stopWorkspace`).
    const stop = command("stopAgent");
    const agent = lazy.SvalAgents.store?.agentOfWorkspace(id);
    stop.hidden = !agent;
    const permissions = command("agentPermissions");
    permissions.hidden = !agent;
    permissions.nextElementSibling.hidden = !agent;
    if (agent) {
      permissions.setAttribute("label", `${agent.label} Permissions…`);
    }
    stop.setAttribute(
      "label",
      this.#view.settings.isAgentStopped(id) ? "Resume Agent" : "Stop Agent"
    );
    const media = command("media");
    const action = this.workspaceMedia(id);
    media.hidden = !action;
    media.nextElementSibling.hidden = !action;
    media.setAttribute("label", this.#view.mediaLabel(action));
  }

  /**
   * Every tab of workspace `id` in any window, its pins' pages in this one
   * included, as the switcher's media button stands for them (spec §10.7).
   *
   * @param {string} id A workspace id.
   * @returns {object[]} Firefox tabs.
   */
  workspaceTabs(id) {
    const { descendantIds } = SvalTree;
    return [
      ...this.#view.tabsOfNodes(descendantIds(this.#view.nodes, id)),
      ...(this.#view.pins?.pages.tabsOfWorkspace(id) ?? []),
    ];
  }

  /**
   * @param {string} id A workspace id.
   * @returns {?string} what its media button offers
   *   (`SvalFirefox.mediaActionOf`).
   */
  workspaceMedia(id) {
    return lazy.SvalFirefox.mediaActionOf(this.workspaceTabs(id));
  }

  /**
   * Opens the workspace menu, for the workspace this window shows or a
   * switcher entry's. Nothing opens when the document holds no workspace,
   * because every entry acts on one.
   *
   * @param {MouseEvent} [event] The `contextmenu` on the switcher or an
   *   entry; none for the context-menu key or Shift+F10 there.
   * @param {string} [id] The workspace it acts on.
   * @param {Element} [anchor] What a key opened it on.
   * @param {boolean} [onStrip] Whether it opened on the strip, which adds
   *   the names controls (`#stripNamesItems`).
   */
  openWorkspaceMenu(
    event,
    id = this.#view.workspace.id,
    anchor = this.#view.els.switcher,
    onStrip = false
  ) {
    if (!id) {
      return;
    }
    this.#menuWorkspace = id;
    this.#menuOnStrip = onStrip;
    lazy.openContextMenu(this.#view.els.workspaceMenu, anchor, event);
  }

  /**
   * The context-menu key and Shift+F10 on the switcher open the workspace
   * menu, for the reason `keyCommand` gives for a row.
   *
   * @param {KeyboardEvent} event `keydown` on the switcher.
   */
  #onSwitcherKeyDown(event) {
    if (SvalPanelModel.keyCommand(event, {}) !== "contextMenu") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.openWorkspaceMenu();
  }

  /**
   * Shows the workspace menu's entries for the workspace it opened on
   * (`openWorkspaceMenu`).
   */
  #onWorkspaceMenuShowing() {
    const menu = this.#view.els.workspaceMenu;
    const id = this.#menuWorkspace;
    this.#syncWorkspaceCommands(menu, id);
    const item = SvalPanelModel.switcherItemOf(
      this.#view.nodes,
      id,
      this.#view.workspace.id
    );
    // A Workspace has one window (spec §10.7). The switcher's menu offers
    // a new one in each entry's submenu, and the strip here.
    const open = menu.querySelector(":scope > [data-open-workspace]");
    open.hidden =
      !this.#menuOnStrip ||
      !!this.#view.inMemory ||
      !item ||
      item.current ||
      this.#view.workspace.shownElsewhere().has(id);
    open.nextElementSibling.hidden = open.hidden;
    // The column shows no names whatever the choice, so it offers no names
    // controls.
    this.#syncStripNamesItems(
      this.#menuOnStrip && this.#view.els.strip.dataset.layout !== "column"
    );
  }

  /**
   * @param {Event} event `command` from the workspace menu.
   */
  #onWorkspaceMenuCommand(event) {
    const { command, stripNames, openWorkspace } = event.target.dataset;
    if (stripNames) {
      Services.prefs.setStringPref(SvalPanelModel.STRIP_NAMES_PREF, stripNames);
      return;
    }
    if (openWorkspace && this.#menuWorkspace) {
      this.openInNewWindow(this.#menuWorkspace);
      return;
    }
    if (command && this.#menuWorkspace) {
      this.#runWorkspaceCommand(command, this.#menuWorkspace);
    }
  }

  /**
   * Runs one of `#workspaceCommandItems` through `run`, closing the
   * switcher first when it is open, since each opens a dialog. Each command
   * reads only the id from its row, and the workspace is not one.
   *
   * @param {string} command
   * @param {string} id A workspace id.
   */
  #runWorkspaceCommand(command, id) {
    if (command === "media") {
      lazy.SvalFirefox.actOnMedia(this.workspaceTabs(id));
      return;
    }
    if (command === "agentPermissions") {
      const agent = lazy.SvalAgents.store?.agentOfWorkspace(id);
      if (agent) {
        this.#view.els.switcherMenu.hidePopup();
        this.#window.openPreferences(
          `paneSvalAgents-agent?${new URLSearchParams({ id: agent.agentId })}`
        );
      }
      return;
    }
    if (command === "stopAgent") {
      lazy.SvalAgentControl.stopWorkspace(
        id,
        !this.#view.settings.isAgentStopped(id)
      );
      return;
    }
    if (
      command !== "edit" &&
      command !== "deleteWorkspace" &&
      command !== "isolateWorkspace" &&
      command !== "shareWorkspace"
    ) {
      return;
    }
    this.#view.els.switcherMenu.hidePopup();
    this.#view.run(command, { id });
  }

  /**
   * Fills "Move to workspace" with every workspace of the user's but this
   * window's, then "New workspace…" (import spec §6), then the devices'
   * workspaces (decision 2254) and the agents' after a caption each, the
   * agents' grouped by app
   * (`appendAgentApps`). A row moved into an agent's workspace is
   * handed to the agent, once the user has agreed (`moveToWorkspace`), so
   * those entries never mix with the user's.
   *
   * The row menu's entries also fill the menu bar's Tab menu
   * (`SvalPanelRowMenu.barItems`), so the caption is the one the menu bar's
   * Workspaces menu draws (`appendAgentsMenuCaption`).
   *
   * @param {Element} popup The submenu's `menupopup`, empty.
   * @param {string[]} ids The rows the menu is for.
   */
  fillMoveToWorkspace(popup, ids) {
    const others = this.list().filter(
      item => !item.current && !ids.includes(item.id)
    );
    const own = others.filter(item => SvalWorkspaceEntries.usersOwn(item));
    for (const item of own) {
      const entry = this.#window.document.createXULElement("menuitem");
      entry.setAttribute("data-move-workspace", item.id);
      SvalWorkspaceEntries.labelWorkspaceEntry(entry, item);
      popup.append(entry);
    }
    if (own.length) {
      popup.append(this.#window.document.createXULElement("menuseparator"));
    }
    const fresh = this.#window.document.createXULElement("menuitem");
    fresh.setAttribute("data-move-workspace", "");
    SvalWorkspaceEntries.labelMenuEntry(fresh, "New Workspace…");
    popup.append(fresh);
    const devices = others.filter(item => item.device);
    if (devices.length) {
      SvalWorkspaceEntries.appendDevicesCaption(popup, {
        native: true,
      });
    }
    for (const item of devices) {
      const entry = this.#window.document.createXULElement("menuitem");
      entry.setAttribute("data-move-workspace", item.id);
      SvalWorkspaceEntries.labelWorkspaceEntry(entry, item);
      SvalWorkspaceEntries.markDeviceItem(entry, item, this.#view.nodes);
      popup.append(entry);
    }
    const agents = others.filter(item => item.agent);
    if (agents.length) {
      SvalWorkspaceEntries.appendAgentsMenuCaption(popup);
    }
    SvalWorkspaceEntries.appendAgentApps(popup, agents, item => {
      const entry = this.#window.document.createXULElement("menuitem");
      entry.setAttribute("data-move-workspace", item.id);
      entry.setAttribute("data-agent", "true");
      SvalWorkspaceEntries.labelAgentEntry(entry, item);
      return entry;
    });
  }

  /**
   * Fills the menu bar's Workspaces menu after its fixed items
   * (`SvalMenuBar`): every workspace the switcher lists, this window's
   * checked, then the workspace menu's commands on this window's workspace.
   *
   * A native menu bar draws no submenu style, so the devices' workspaces
   * follow `appendDevicesCaption`'s caption, and the agents'
   * `appendAgentsMenuCaption`'s, grouped by app
   * (`appendAgentApps`), and entries carry no mark.
   *
   * @param {Element} popup
   */
  fillMenuBar(popup) {
    if (!this.#view.built) {
      return;
    }
    const entry = item => {
      const el = this.#window.document.createXULElement("menuitem");
      el.setAttribute("type", "checkbox");
      el.setAttribute("data-workspace-id", item.id);
      if (item.current) {
        el.setAttribute("checked", "true");
      }
      return el;
    };
    const items = this.list();
    for (const item of items.filter(i => SvalWorkspaceEntries.usersOwn(i))) {
      const el = entry(item);
      SvalWorkspaceEntries.labelWorkspaceEntry(el, item);
      popup.append(el);
    }
    const devices = items.filter(i => i.device);
    if (devices.length) {
      SvalWorkspaceEntries.appendDevicesCaption(popup, {
        native: true,
      });
    }
    for (const item of devices) {
      const el = entry(item);
      SvalWorkspaceEntries.labelWorkspaceEntry(el, item);
      SvalWorkspaceEntries.markDeviceItem(el, item, this.#view.nodes);
      popup.append(el);
    }
    const agents = items.filter(i => i.agent);
    if (agents.length) {
      SvalWorkspaceEntries.appendAgentsMenuCaption(popup);
    }
    SvalWorkspaceEntries.appendAgentApps(popup, agents, item => {
      const el = entry(item);
      SvalWorkspaceEntries.labelAgentEntry(el, item);
      return el;
    });
    const commands = this.#workspaceCommandItems();
    popup.append(
      this.#window.document.createXULElement("menuseparator"),
      ...commands
    );
    this.#syncWorkspaceCommands(popup, this.#view.workspace.id);
    // With no workspace of the person's own, the first caption follows the
    // menu bar's own separator (`SvalMenuBar`).
    lazy.tidySeparators(popup);
  }

  /**
   * @param {Event} event `command` in the menu bar's Workspaces menu.
   */
  runMenuBarCommand(event) {
    if (!this.#view.built) {
      return;
    }
    const { workspaceId, command } = event.target.dataset;
    if (command) {
      this.#runWorkspaceCommand(command, this.#view.workspace.id);
    } else if (workspaceId && workspaceId !== this.#view.workspace.id) {
      // The agent's window stays the agent's while it holds it, so the
      // workspace opens in a window of its own (`SvalAgentMarking`).
      this.pick(workspaceId, !!this.#view.agentMarking?.blocking);
    }
  }
}
