/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The workspace switcher and the Favorites button above the tree, and the
 * menus they open: the workspaces to go to, how each is named and marked, and
 * opening one in a window of its own.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

{
  /** The robot face that marks an agent's workspace (agent-control spec §6). */
  const AGENT_ROBOT_URL = "chrome://browser/content/sval/agent-robot.svg";

  /** The box that marks an isolated workspace (isolated workspaces spec §10). */
  const ISOLATED_BOX_URL =
    "chrome://browser/content/sval/workspace-isolated.svg";

  /** What an isolated workspace's mark means, for its tooltip and description. */
  const ISOLATED_TEXT =
    "Isolated: sites here can’t see sign-ins from other Workspaces";

  /** What an agent's mark means, for its tooltip and description. */
  const AGENT_TEXT = "Agent Workspace";

  /**
   * The phone that marks a phone's own workspace (decision 2254), and the
   * devices' heading. A tablet's wears {@link DEVICE_TABLET_URL}.
   */
  const DEVICE_PHONE_URL = "chrome://browser/content/sval/device-phone.svg";
  const DEVICE_TABLET_URL = "chrome://browser/content/sval/device-tablet.svg";

  /**
   * The heading over the agents' part of a workspace list. It wears the
   * robot, the face each entry under it wears.
   */
  const AGENTS_CAPTION = "Agent Workspaces";

  /**
   * The heading over the phones' and tablets' own workspaces. It wears the
   * phone, as each entry under it does.
   */
  const DEVICES_CAPTION = "Devices";

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
   * locked sideways or upright ({@link SvalPanel._onPanelWheel}). A
   * trackpad's first events wander, and a few pixels is enough to read
   * which way the fingers mean to go.
   */
  const SWIPE_DEAD_ZONE_PX = 6;

  /** The most rows the switcher's menu shows before it scrolls. */
  const MENU_ROWS = 12;

  /** The narrowest the switcher's menu opens over the strip. */
  const STRIP_LIST_MIN_PX = 220;

  Object.assign(SvalPanel, {
    /** What an isolated Workspace's mark means, for the strip as the menu. */
    _isolatedText: ISOLATED_TEXT,

    /** What an agent's mark means, for the strip as the menu. */
    _agentText: AGENT_TEXT,

    /**
     * How long the wheel rests before its next event starts a gesture of its
     * own, and how far a gesture travels before it counts, for the strip's
     * wheel as for the panel's swipe ({@link _onPanelWheel}).
     */
    _wheelRestMs: SWIPE_REST_MS,
    _wheelGesturePx: SWIPE_THRESHOLD_PX,

    /**
     * The wheel gesture over the panel in progress, or null:
     * `{ at, axis, held, travelX, travelY, before, turn }`. The `timeStamp`
     * of its last event; `"x"` or `"y"` once locked, null before; whether
     * its first event held the tree still; its travel on each axis and its
     * sideways travel before the lock; and its swipes as
     * `SvalPanelModel.wheelTurn` reads them.
     */
    _swipe: null,

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
     * It is drawn as the Favorites menu is ({@link _buildFavoritesMenu}).
     *
     * @returns {Element} the `menupopup`.
     */
    _buildSwitcherMenu() {
      const menu = document.createXULElement("menupopup");
      menu.id = "sval-workspace-menu";
      document.getElementById(menu.id)?.remove();
      // Windows passes on the press that closes a menu in a `popupset`
      // (`nsMenuPopupFrame::ConsumeOutsideClicks`), and that press on the
      // switcher would open it again.
      menu.setAttribute("consumeoutsideclicks", "true");
      menu.setAttribute("nonnative", "");
      menu.classList.add("toolbar-menupopup");
      menu.addEventListener("contextmenu", this);
      menu.addEventListener("popupshowing", this);
      menu.addEventListener("popuphidden", this);
      menu.addEventListener("command", this);
      menu.addEventListener("mouseup", this);
      // The keyboard's ring shows from the first key pressed in the menu,
      // and the pointer takes it away (`sval-panel.css`, menus).
      menu.addEventListener("mousemove", () =>
        menu.removeAttribute("sval-keys")
      );
      for (const type of [
        "dragstart",
        "dragover",
        "dragleave",
        "drop",
        "dragend",
      ]) {
        menu.addEventListener(type, event => this._onSwitcherDrag(event));
      }
      window.addEventListener("keydown", this, true);
      document.getElementById("mainPopupSet").append(menu);
      return menu;
    },

    /**
     * Names the current workspace on the switcher, with its emoji and colour.
     *
     * The switcher is where a workspace is named, since the workspace itself
     * is not a row (spec §10.7), so this is where §10.7's "colour and emoji are
     * shown wherever a workspace is named" lands for the workspace, and it is also
     * where the window's title is set from, because both are a function of the
     * same two facts.
     */
    _renderSwitcher() {
      const { WORKSPACE } = this._modules.SvalTree;
      const switcher = this._els.switcher;
      const current = this._workspace.id;
      // First run's Workspace step, before the Workspace exists: what its
      // fields hold as the user fills them (`_previewFirstWorkspace`).
      const preview = current ? null : this._switcherPreview;
      let label = "No Workspace yet";
      if (current) {
        label =
          this._nodes[current]?.content?.name || this._untitled(WORKSPACE);
      } else if (preview) {
        label = preview.name.trim() || this._untitled(WORKSPACE);
      }
      const { AGENT_EMOJI, agentLabelOf, WINDOW_WORKSPACE_TOPIC } =
        this._modules.SvalPanelModel;
      const { appearanceOf } = this._modules.SvalTree;
      const { SvalColor } = this._modules;
      const stored = current
        ? appearanceOf(this._nodes, current)
        : {
            color: preview?.color ?? null,
            emoji: preview?.emoji || null,
            transparency: preview?.transparency ?? 0,
          };
      // An agent's workspace wears the robot face and the agent's hue, never an
      // emoji of its own (`workspaceColor` says the same of its colour).
      const agent = agentLabelOf(this._nodes, current, this.devices());
      // A phone's or tablet's workspace wears its device's mark in place of
      // an emoji, as it does in the strip and the menus.
      const agentMark = agent
        ? this._agentMarkURL(
            this._modules.agentBrandOf(this._nodes[current]?.agent?.label)
          )
        : this._deviceMarkURL(current);
      this._agentLabel = agent;
      const color = current
        ? this.workspaceColor(current)
        : SvalColor.colorOf(stored.color, "workspace");
      // The Edit Workspace dialog's choice, drawn while it is open.
      // No colour is Sval's own, see-through like any other; an agent's
      // window wears the agent's hue, solid.
      const shownLook = this._colorPreview ?? {
        color,
        transparency: agent ? 0 : (stored.transparency ?? 0),
      };
      this._shownLook = shownLook;
      const emoji = agentMark ? null : stored.emoji;

      switcher.textContent = "";
      // Always present: the stylesheet draws a workspace icon in an empty tile,
      // so a workspace with no emoji still has a tile to carry its colour.
      const tile = this._html("span");
      tile.className = "sval-switcher-emoji";
      if (agentMark) {
        // The mark is drawn by the stylesheet, and the accessible name below
        // says whose workspace it is.
        tile.classList.add("sval-agent-glyph");
        tile.setAttribute("aria-hidden", "true");
        tile.style.setProperty("--sval-agent-mark", `url("${agentMark}")`);
      } else if (emoji) {
        tile.textContent = emoji;
      }
      switcher.append(tile);
      const name = this._html("span");
      name.className = "sval-switcher-name";
      name.textContent = label;
      switcher.append(name);
      // An isolated workspace says so beside its name while it is the one
      // shown (isolated workspaces spec §10). The description carries the
      // meaning, so the pill is hidden from the accessibility tree.
      const isolated =
        !!current &&
        this._modules.SvalWorkspaceJar.isIsolated(this._nodes, current);
      if (isolated) {
        const pill = this._html("span");
        pill.className = "sval-iso-pill";
        pill.setAttribute("aria-hidden", "true");
        pill.textContent = "Isolated";
        switcher.append(pill);
        switcher.setAttribute("title", ISOLATED_TEXT);
        switcher.setAttribute("aria-description", ISOLATED_TEXT);
      } else {
        switcher.removeAttribute("title");
        switcher.removeAttribute("aria-description");
      }
      this._applyWindowTint(shownLook.color, shownLook.transparency);
      if (shownLook.color) {
        switcher.setAttribute(
          "data-sval-color",
          SvalColor.isPreset(shownLook.color) ? shownLook.color : "custom"
        );
        tile.style.setProperty(
          "--sval-switcher-fill",
          SvalColor.css(this.windowLook.tint)
        );
      } else {
        switcher.removeAttribute("data-sval-color");
      }
      this._applyAgentMarking(agent, agentMark);
      // The home page takes the colour of the workspace its tab is in
      // (pins spec §9), so it hears whenever this window's changes.
      const shown = `${current}|${SvalColor.colorKey(shownLook.color)}|${shownLook.transparency}|${this._blockSurfaceKey()}`;
      if (shown !== this._shownWorkspace) {
        this._shownWorkspace = shown;
        Services.obs.notifyObservers(window, WINDOW_WORKSPACE_TOPIC);
      }

      // The visible text is the workspace's own name, which says where the user
      // is but not what pressing it does; the accessible name says both, and
      // contains the visible one so the two do not disagree.
      switcher.setAttribute(
        "aria-label",
        agent
          ? `Current Workspace: ${label}, controlled by ${agent}`
          : `Current Workspace: ${label}`
      );
      // The tree holds this workspace's groups and tabs, so it is named for
      // the workspace rather than for workspaces in general.
      const treeLabel = current ? `Tabs in ${label}` : "Tabs";
      this._els.tree.setAttribute("aria-label", treeLabel);
      // Nothing to switch between, and a menu that opens empty is a dead end.
      switcher.disabled = !current;

      if (agent) {
        this._applyWindowTitle(AGENT_EMOJI, label);
      } else {
        // Always prefaced, "No Workspace yet" included, so a page's own title
        // never starts a user's window title, as an agent's robot would.
        this._applyWindowTitle(
          current ? emoji : null,
          label,
          this._untitled(WORKSPACE)
        );
      }
      // The popup, if one is open, is part of what the switcher is showing,
      // and so is the strip when it stands in for the switcher.
      this._refillOpenSwitcher();
      this._renderStrip();
    },

    /**
     * One emoji, in its own element so the name beside it stays elidable and so
     * a test can read back exactly what was stored.
     *
     * Not `aria-hidden`: an emoji is part of how a person identifies a place
     * (two workspaces may share a name and differ only here), and the platform
     * announces it by its Unicode name, which is the same information a sighted
     * user gets.
     *
     * @param {string} emoji The grapheme cluster the document holds, unmodified.
     * @param {string} className
     * @returns {Element}
     */
    _emojiElement(emoji, className) {
      const el = this._html("span");
      el.className = className;
      el.textContent = emoji;
      return el;
    },

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
    _openSwitcher() {
      const { switcher, switcherMenu: menu, strip } = this._els;
      const onStrip = this._stripShown();
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
      this._switcherOpener = onStrip
        ? strip.querySelector(".sval-strip-item[data-current]")
        : switcher;
      menu.openPopup(anchor, "overlap", 0, 0, false, false);
    },

    /**
     * Shows at most {@link MENU_ROWS} of the switcher's menu's rows, scrolled
     * so the current Workspace's is as near their middle as the ends allow.
     * Run on the frame the menu is first drawn, once it has a layout and
     * before it is painted.
     */
    _scrollSwitcherMenu() {
      const menu = this._els.switcherMenu;
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
    },

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
     * `HandleEnterKeyPress`), so {@link _onSwitcherMouseUp} and
     * {@link _onSwitcherMenuKeyDown} give its click and Enter the switch a
     * `menuitem`'s would run. Shift opens the workspace in a new window
     * instead.
     *
     * @param {Event} event `popupshowing` on `#sval-workspace-menu`.
     */
    _onSwitcherShowing(event) {
      const menu = this._els.switcherMenu;
      if (event.target !== menu) {
        return;
      }
      this._fillSwitcherMenu();
      (this._switcherOpener ?? this._els.switcher).setAttribute(
        "aria-expanded",
        "true"
      );
      window.requestAnimationFrame(() => this._scrollSwitcherMenu());
    },

    /**
     * Fills the switcher's popup from the document as it stands now.
     *
     * Reached from `popupshowing` and from {@link _renderSwitcher} while the
     * popup is open, which is what keeps the two in step; see
     * {@link _refillOpenSwitcher}.
     */
    _fillSwitcherMenu() {
      const menu = this._els.switcherMenu;
      // The window's own workspace keeps its place, so the list reads the same
      // from every window and in the order a swipe goes ({@link
      // _stepWorkspace}).
      const items = this.switcherList();
      menu.textContent = "";
      for (const item of items.filter(entry => this._usersOwn(entry))) {
        const el = this._workspaceEntry(item);
        // The user's own workspaces are put in order by dragging, as
        // Favorites are in theirs; the devices' and agents' lists keep
        // their own order.
        if (!this._inMemory) {
          el.setAttribute("draggable", "true");
        }
        menu.append(el);
      }
      const devices = items.filter(entry => entry.device);
      if (devices.length) {
        this._appendDevicesCaption(menu);
      }
      for (const item of devices) {
        const el = this._workspaceEntry(item);
        this._countDeviceTabs(el, item);
        menu.append(el);
      }
      this._appendSwitcherAgentApps(
        menu,
        items.filter(entry => entry.agent)
      );

      if (menu.firstChild) {
        menu.append(document.createXULElement("menuseparator"));
      }
      const addWorkspace = document.createXULElement("menuitem");
      this._labelMenuEntry(addWorkspace, "New Workspace…");
      addWorkspace.setAttribute("data-sval-new-workspace", "true");
      // Draws nothing until the user gives the key one in Settings.
      addWorkspace.setAttribute("key", this._modules.NEW_WORKSPACE_KEY);
      menu.append(addWorkspace);
    },

    /**
     * The Favorites menu: the favorites document, from any workspace (import
     * spec §6). A favorite opens in a new tab in this window's workspace, or in
     * the selected tab when it is empty, and a bookmarklet runs on the
     * selected tab's page (`SvalFavorites.open`).
     *
     * `SvalFavoritesView` draws it from the document, and draws it again as
     * Favorites change (favorites-native spec §5.3).
     *
     * It is drawn as Firefox's bookmarks menus are: by Gecko (`nonnative`),
     * which is what lets its items carry a context menu (favorites-native
     * spec §15.2), and as a `toolbar-menupopup`, which takes the window's popup
     * colours (`sval-header.css`) on every platform. The switcher is drawn the
     * same way; `sval-panel.css` (menus) holds what both add.
     *
     * @param {Element} bar The favorites bar.
     * @returns {Element} the `menupopup`.
     */
    _buildFavoritesMenu(bar) {
      const { FAVORITES_ROOT } = this._modules;
      const host = document.createXULElement("box");
      host.className = "sval-favorites-host";
      const popup = document.createXULElement("menupopup");
      popup.id = "sval-favorites-menu";
      popup.setAttribute("nonnative", "");
      popup.classList.add("toolbar-menupopup");
      popup.addEventListener("popupshowing", event => {
        if (event.target === popup) {
          this._els.favorites.setAttribute("aria-expanded", "true");
        }
      });
      popup.addEventListener("popuphidden", event => {
        if (event.target === popup) {
          this._els.favorites.setAttribute("aria-expanded", "false");
        }
      });
      host.append(popup);
      bar.append(host);
      // The panel builds itself again when its document changes, and the
      // menu it drew before stops following Favorites.
      this._favoritesView?.destroy();
      this._favoritesView = new this._modules.SvalFavoritesView(
        popup,
        FAVORITES_ROOT,
        {
          onPick: (row, event) => this._onFavoritesCommand(row, event),
        }
      );
      this._modules.SvalFavoritesMenu.attach(window, popup);
      return popup;
    },

    /** Opens the Favorites menu under its button. */
    openFavorites() {
      this._els.favoritesMenu.openPopup(
        this._els.favorites,
        "after_start",
        0,
        0,
        false,
        false
      );
    },

    /**
     * @param {object} favorite The favorite chosen in the Favorites menu.
     * @param {Event} event Its `command`.
     */
    _onFavoritesCommand(favorite, event) {
      this._modules.SvalFavorites.open(window, favorite, { event });
    },

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
    _refillOpenSwitcher() {
      const menu = this._els.switcherMenu;
      if (menu.state !== "open" && menu.state !== "showing") {
        return;
      }
      const items = this.switcherList();
      const wanted = items.map(
        item => `${item.id}\t${this.switcherItemLabel(item)}\t${item.current}`
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
        this._fillSwitcherMenu();
      }
    },

    /**
     * This device and every device's name, for an agent workspace's label.
     *
     * @returns {object|null} As `SvalPanelModel.agentLabelOf` takes it.
     */
    devices() {
      const self = this._engine?.deviceIdHex;
      if (!self) {
        return null;
      }
      const { SvalDeviceNames } = this._modules;
      return { self, nameOf: device => SvalDeviceNames.nameOf(device) };
    },

    /**
     * Shows or hides one switcher entry's media button, for every tab of its
     * workspace ({@link _workspaceMedia}).
     *
     * @param {Element} el A `menu[data-workspace-id]`.
     */
    _paintEntrySound(el) {
      const action = this._workspaceMedia(el.dataset.workspaceId);
      if (action) {
        el.setAttribute("data-media", action);
      } else {
        el.removeAttribute("data-media");
      }
      const button = el.querySelector(":scope > .sval-switcher-audio");
      if (button && action) {
        button.title = this._mediaTooltip(
          this._workspaceTabs(el.dataset.workspaceId)
        );
      }
      const submenu = el.querySelector(":scope > menupopup");
      if (submenu) {
        this._syncWorkspaceCommands(submenu, el.dataset.workspaceId);
      }
    },

    /**
     * Paints every entry's media button while the switcher is open, and the
     * strip's sound badges.
     */
    _paintSwitcherSound() {
      this._paintStripSounds();
      const menu = this._els?.switcherMenu;
      if (menu?.state !== "open" && menu?.state !== "showing") {
        return;
      }
      for (const el of menu.querySelectorAll(
        ":scope > menu[data-workspace-id]"
      )) {
        this._paintEntrySound(el);
      }
    },

    /**
     * The switcher's entries: the user's own workspaces, then the phones'
     * and tablets' (decision 2254), then the agents' (agent-control spec
     * §3.5), each part in sibling order. The devices' and the agents' each
     * come under a caption of their own ({@link _appendDevicesCaption},
     * {@link _appendAgentsCaption}), so the list the user works from is never
     * interleaved with places another device or an agent works.
     *
     * @returns {object[]} `SvalPanelModel.switcherItems` entries.
     */
    switcherList() {
      const items = this._modules.SvalPanelModel.switcherItems(
        this._nodes,
        this._workspace.id,
        this._workspace.shownElsewhere(),
        this.devices()
      );
      return [
        ...items.filter(i => this._usersOwn(i)),
        ...items.filter(i => i.device),
        ...items.filter(i => i.agent),
      ];
    },

    /**
     * Whether a `switcherItems` entry is one of the user's own workspaces:
     * neither a device's nor an agent's.
     *
     * @param {object} item
     * @returns {boolean}
     */
    _usersOwn(item) {
      return !item.agent && !item.device;
    },

    /**
     * Starts the devices' part of a workspace list: a separator after any of
     * the user's entries, then {@link DEVICES_CAPTION}. A `menucaption` in a
     * menu Gecko draws, which the arrow keys pass over, and a disabled item
     * in one a native menu bar can show, which draws no `menucaption`.
     *
     * @param {Element} popup The `menupopup` being filled.
     * @param {object} [options]
     * @param {boolean} [options.native] Whether a native menu bar shows it.
     */
    _appendDevicesCaption(popup, { native = false } = {}) {
      if (native || popup.querySelector(":scope > [data-workspace-id]")) {
        popup.append(document.createXULElement("menuseparator"));
      }
      const caption = document.createXULElement(
        native ? "menuitem" : "menucaption"
      );
      caption.setAttribute("label", DEVICES_CAPTION);
      caption.setAttribute("data-devices-caption", "true");
      if (native) {
        caption.setAttribute("disabled", "true");
        caption.classList.add("menuitem-iconic", "sval-device-menuitem");
        caption.setAttribute("image", DEVICE_PHONE_URL);
      } else {
        caption.className = "sval-devices-caption";
      }
      popup.append(caption);
    },

    /**
     * Says how many tabs a device's workspace holds, beside its name and in
     * its accessible description. Its tabs are open on that device and none
     * of them in a window here, so the count is the tree's.
     *
     * @param {Element} el A workspace `menu` or `menuitem`.
     * @param {object} item Its `switcherItems` entry.
     */
    _countDeviceTabs(el, item) {
      const count = this._modules.SvalPanelModel.descendantTabCount(
        this._nodes,
        item.id
      );
      const text = count === 1 ? "1 tab" : `${count} tabs`;
      el.setAttribute("acceltext", text);
      const described = el.getAttribute("description");
      el.setAttribute(
        "description",
        described ? `${text}. ${described}` : text
      );
    },

    /**
     * Starts the agents' part of a switcher list before its first agent entry:
     * a separator after any of the user's entries, then
     * {@link AGENTS_CAPTION}. A `menucaption`, a menu's own heading, which the
     * arrow keys pass over.
     * Each entry under it keeps its robot face, so the marking never rests on
     * the heading alone.
     *
     * @param {Element} popup The `menupopup` being filled.
     * @param {object} item The entry about to be appended.
     */
    _appendAgentsCaption(popup, item) {
      if (!item.agent || popup.querySelector(".sval-agents-caption")) {
        return;
      }
      if (popup.querySelector(":scope > [data-workspace-id]")) {
        popup.append(document.createXULElement("menuseparator"));
      }
      const caption = document.createXULElement("menucaption");
      caption.className = "sval-agents-caption";
      caption.setAttribute("label", AGENTS_CAPTION);
      popup.append(caption);
    },

    /**
     * Starts the agents' part of a menu a native menu bar can show: a
     * separator, then a disabled item that names them. A native menu bar draws
     * no `menucaption`.
     *
     * @param {Element} popup
     */
    _appendAgentsMenuCaption(popup) {
      const caption = document.createXULElement("menuitem");
      caption.setAttribute("label", AGENTS_CAPTION);
      caption.setAttribute("disabled", "true");
      caption.setAttribute("data-agents-caption", "true");
      caption.classList.add("menuitem-iconic", "sval-agent-menuitem");
      caption.setAttribute("image", AGENT_ROBOT_URL);
      popup.append(document.createXULElement("menuseparator"), caption);
    },

    /**
     * One workspace's entry: a `menu` that goes to the workspace
     * ({@link _onSwitcherMouseUp}), whose submenu acts on it.
     *
     * @param {object} item Its `switcherItems` entry.
     * @returns {Element}
     */
    _workspaceEntry(item) {
      const el = document.createXULElement("menu");
      el.setAttribute("data-workspace-id", item.id);
      // What {@link _refillOpenSwitcher} compares. An agent's entry is
      // labelled with its last use too ({@link _labelAgentEntry}), which
      // changes as time passes.
      el.dataset.entryName = this.switcherItemLabel(item);
      // The emoji leads the label as it leads the switcher's own name, so an
      // entry reads, and is announced, as the button does once chosen.
      this._labelWorkspaceEntry(el, item);
      this._markAgentItem(el, item);
      this._markDeviceItem(el, item);
      this._markIsolatedItem(el, item);
      if (item.current) {
        el.setAttribute("aria-current", "true");
      }
      const popup = document.createXULElement("menupopup");
      // Drawn as its parent is ({@link _buildSwitcherMenu}): a submenu left
      // native is drawn by the platform, apart from the switcher's style.
      popup.setAttribute("nonnative", "");
      popup.classList.add("toolbar-menupopup");
      // A workspace has one window (spec §10.7), so only a workspace no
      // window shows is offered a new one.
      if (!item.current && !item.elsewhere) {
        const open = document.createXULElement("menuitem");
        open.setAttribute("data-open-workspace-id", item.id);
        this._labelMenuEntry(open, "Open in New Window");
        // Shift+Enter and a Shift-click on the workspace's entry do the
        // same (`_onSwitcherMenuKeyDown`, `_onSwitcherMouseUp`).
        const shiftEnter = { keycode: "VK_RETURN", modifiers: "shift" };
        const shiftClick = this._modules.clickText("shift");
        open.setAttribute(
          "acceltext",
          `${this._modules.shortcutText(shiftEnter)} or ${shiftClick}`
        );
        open.setAttribute(
          "aria-keyshortcuts",
          this._modules.ariaShortcut(shiftEnter)
        );
        popup.append(open, document.createXULElement("menuseparator"));
      }
      popup.append(...this._workspaceCommandItems());
      this._syncWorkspaceCommands(popup, item.id);
      el.append(popup);
      // Pressed without picking the workspace ({@link _onSwitcherMouseUp});
      // the submenu's media entry is the keyboard's way to it.
      const audio = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      audio.className = "sval-switcher-audio";
      audio.setAttribute("tabindex", "-1");
      audio.setAttribute("aria-hidden", "true");
      el.append(audio);
      this._paintEntrySound(el);
      return el;
    },

    /**
     * The agents' workspaces in the switcher, under their caption
     * ({@link _appendAgentApps}). Each is a workspace's entry, as the user's
     * own are ({@link _agentWorkspaceRow}).
     *
     * @param {Element} menu The switcher's `menupopup`.
     * @param {object[]} items The agents' `switcherItems` entries.
     */
    _appendSwitcherAgentApps(menu, items) {
      if (!items.length) {
        return;
      }
      this._appendAgentsCaption(menu, items[0]);
      const apps = this._appendAgentApps(menu, items, item =>
        this._agentWorkspaceRow(item)
      );
      for (const el of apps) {
        // Drawn as the switcher is ({@link _buildSwitcherMenu}).
        const popup = el.querySelector(":scope > menupopup");
        popup.setAttribute("nonnative", "");
        popup.classList.add("toolbar-menupopup", "sval-agent-app-popup");
      }
    },

    /**
     * Appends the agents' workspaces to `popup`: one menu for each app, the
     * agent's name and its app's mark ({@link _markAgentItem}), holding its
     * workspaces ({@link _appendAgentAppEntries}). Every menu that lists the
     * agents' workspaces draws them this way, because every workspace of an
     * app carries the app's name, and only the task tells them apart.
     *
     * @param {Element} popup
     * @param {object[]} items The agents' `switcherItems` entries.
     * @param {function(object): Element} entryFor Draws one workspace's entry.
     * @returns {Element[]} Each app's `menu`.
     */
    _appendAgentApps(popup, items, entryFor) {
      const apps = [];
      for (const [app, entries] of Map.groupBy(items, item => item.agent)) {
        const el = document.createXULElement("menu");
        el.setAttribute("data-agent-app", app);
        this._labelMenuEntry(el, app);
        this._markAgentItem(el, { agent: app, brand: entries[0].brand });
        const appPopup = document.createXULElement("menupopup");
        this._appendAgentAppEntries(appPopup, entries, entryFor);
        el.append(appPopup);
        popup.append(el);
        apps.push(el);
      }
      return apps;
    },

    /**
     * Appends one agent app's workspaces to `popup`, the one a session used
     * last first (decision 1998), each wearing its model's mark
     * ({@link _markAgentModel}). The app's menus and the strip's list of an
     * app ({@link _openStripAppMenu}) both draw them this way.
     *
     * @param {Element} popup
     * @param {object[]} entries The app's `switcherItems` entries.
     * @param {function(object): Element} entryFor Draws one workspace's entry.
     */
    _appendAgentAppEntries(popup, entries, entryFor) {
      const used = item =>
        this._agentWorkspaceEntry(item.id)?.lastUsed ?? -Infinity;
      for (const item of entries.toSorted((a, b) => used(b) - used(a))) {
        const el = entryFor(item);
        this._markAgentModel(el, item.id);
        popup.append(el);
      }
    },

    /**
     * What this device's agents file says of an agent workspace: its folder,
     * model and last use. A workspace another device's agent works in has
     * none here.
     *
     * @param {string} id
     * @returns {object|null}
     */
    _agentWorkspaceEntry(id) {
      const store = this._modules.SvalAgents.store;
      const agent = store?.agentOfWorkspace(id);
      return agent ? store.workspaceOf(agent.agentId, id) : null;
    },

    /**
     * One agent workspace's switcher entry ({@link _labelAgentEntry}). It
     * sits in its app's menu, which carries the app's mark, and wears the
     * mark of the model its session said it runs on, when Sval knows it.
     *
     * @param {object} item Its `switcherItems` entry.
     * @returns {Element}
     */
    _agentWorkspaceRow(item) {
      const el = this._workspaceEntry(item);
      this._labelAgentEntry(el, item);
      return el;
    },

    /**
     * Gives an agent workspace's entry its model's mark as its image, or
     * none when its session named no model Sval knows.
     *
     * @param {Element} el A workspace `menu` or `menuitem`.
     * @param {string} id
     */
    _markAgentModel(el, id) {
      const { brandURL, modelBrandOf } = this._modules;
      const url = brandURL(modelBrandOf(this._agentWorkspaceEntry(id)?.model));
      if (url) {
        el.classList.add(this._iconicClass(el), "sval-agent-menuitem");
        el.setAttribute("image", url);
      } else {
        el.removeAttribute("image");
        el.classList.remove(this._iconicClass(el), "sval-agent-menuitem");
      }
    },

    /**
     * The mark an agent's Workspace wears: its app's, or the robot.
     *
     * @param {string|null} brand `SvalAgentBrands.agentBrandOf`'s answer.
     * @returns {string}
     */
    _agentMarkURL(brand) {
      return this._modules.brandURL(brand) ?? AGENT_ROBOT_URL;
    },

    /**
     * The mark a phone's or tablet's Workspace wears: the tablet for a
     * device that says it is one (`SvalDeviceNames.kindOf`), else the phone.
     *
     * @param {string} id A workspace's id.
     * @returns {string|null} null for a workspace that is no device's.
     */
    _deviceMarkURL(id) {
      const device = this._nodes[id]?.device_home?.device;
      if (!device) {
        return null;
      }
      return this._modules.SvalDeviceNames.kindOf(device) === "tablet"
        ? DEVICE_TABLET_URL
        : DEVICE_PHONE_URL;
    },

    /**
     * Labels an agent workspace's entry in its app's menu: its task, then
     * where its session ran, the model, and when a session last used it.
     *
     * @param {Element} el A `menu` or `menuitem`.
     * @param {object} item Its `switcherItems` entry.
     */
    _labelAgentEntry(el, item) {
      const task = this.workspaceName(item);
      const entry = this._agentWorkspaceEntry(item.id);
      const detail = [
        entry?.dir ? this._folderName(entry.dir) : "",
        entry?.model ?? "",
        entry?.lastUsed ? this._usedAgo(entry.lastUsed) : "",
      ].filter(Boolean);
      this._labelMenuEntry(el, [task, ...detail].join(" · "), task);
    },

    /**
     * The last folder of `dir`, a path the agent's session reported. It is
     * split by hand: the agent may spell it with either separator, and on
     * Windows `PathUtils` throws on a forward slash, or crashes in a debug or
     * automated build (`PathUtils::InitFileWithPath`).
     *
     * @param {string} dir
     * @returns {string}
     */
    _folderName(dir) {
      return dir.split(/[\\/]+/).findLast(Boolean) ?? "";
    },

    /**
     * When a session last used an agent workspace, as people say it.
     *
     * @param {number} when Milliseconds since the epoch.
     * @returns {string}
     */
    _usedAgo(when) {
      const minutes = Math.round((Date.now() - when) / 60_000);
      const say = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      if (minutes < 1) {
        return "just now";
      }
      if (minutes < 60) {
        return say.format(-minutes, "minute");
      }
      if (minutes < 24 * 60) {
        return say.format(-Math.round(minutes / 60), "hour");
      }
      return say.format(-Math.round(minutes / (24 * 60)), "day");
    },

    /**
     * One menu label for a `switcherItems` entry: its emoji, then its name.
     *
     * @param {object} item
     * @returns {string}
     */
    switcherItemLabel(item) {
      const name = this.workspaceName(item);
      return item.emoji && !item.agent ? `${item.emoji} ${name}` : name;
    },

    /**
     * What a `switcherItems` entry is called: the workspace's own name, which
     * for an agent's workspace is its task (decision 0125). An app's
     * sessions each have a workspace (decision 1998), so the app's name
     * tells them apart nowhere.
     *
     * @param {object} item
     * @returns {string}
     */
    workspaceName(item) {
      const { WORKSPACE } = this._modules.SvalTree;
      return item.name || this._untitled(WORKSPACE);
    },

    /**
     * Labels a workspace's menu entry ({@link switcherItemLabel}), keyed by
     * its name, which is what type-ahead finds it by.
     *
     * @param {Element} el A `menuitem`.
     * @param {object} item Its `switcherItems` entry.
     */
    _labelWorkspaceEntry(el, item) {
      this._labelMenuEntry(
        el,
        this.switcherItemLabel(item),
        this.workspaceName(item)
      );
    },

    /**
     * Labels a menu entry and gives it the first letter or digit of `name` as
     * its access key, the first thing in it that can be typed.
     *
     * Gecko's menu type-ahead matches an entry's `accesskey` when it has one
     * and the start of its `label` otherwise
     * (`XULMenuParentElement::FindMenuWithShortcut`), so the key is what lets a
     * label that leads with an emoji be reached by its name's first letter.
     * Every entry of a menu that keys one is keyed: a letter that only one
     * keyed entry starts with chooses that entry outright, even when an
     * unkeyed entry's label starts with it too.
     *
     * @param {Element} el A `menuitem` or `menu`.
     * @param {string} label
     * @param {string} [name] The part of `label` that names the entry.
     */
    _labelMenuEntry(el, label, name = label) {
      el.setAttribute("label", label);
      const key = name.match(/[\p{L}\p{N}]/u)?.[0];
      if (key) {
        el.setAttribute("accesskey", key);
      }
    },

    /**
     * Gives an agent's workspace entry its app's mark ({@link _agentMarkURL}),
     * as the item's image, and
     * says what it means ({@link _describeMenuEntry}), so the mark does not
     * rest on the image alone (agent-control spec §6).
     *
     * @param {Element} el A workspace `menu` or `menuitem`.
     * @param {object} item Its `switcherItems` entry.
     */
    _markAgentItem(el, item) {
      if (!item.agent) {
        return;
      }
      el.classList.add(this._iconicClass(el), "sval-agent-menuitem");
      el.setAttribute("image", this._agentMarkURL(item.brand));
      this._describeMenuEntry(el, AGENT_TEXT);
    },

    /**
     * Gives a phone's or tablet's workspace entry its device's mark, as its
     * image, as {@link _markAgentItem} gives an agent's the robot.
     *
     * @param {Element} el A workspace `menu` or `menuitem`.
     * @param {object} item Its `switcherItems` entry.
     */
    _markDeviceItem(el, item) {
      if (!item.device) {
        return;
      }
      el.classList.add(this._iconicClass(el), "sval-device-menuitem");
      el.setAttribute("image", this._deviceMarkURL(item.id));
    },

    /**
     * The class that shows an entry's `image`: Firefox's `menu.css` keys a
     * `menu`'s icon on `menu-iconic` and a `menuitem`'s on `menuitem-iconic`.
     *
     * @param {Element} el A `menu` or `menuitem`.
     * @returns {string}
     */
    _iconicClass(el) {
      return el.localName === "menu" ? "menu-iconic" : "menuitem-iconic";
    },

    /**
     * Says what a menu entry's mark means: in its tooltip, to the eye, and in
     * its `description`, which is what Gecko exposes as a menu item's
     * accessible description (`XULMenuitemAccessible::Description`); a menu
     * item's tooltip reaches no screen reader.
     *
     * @param {Element} el A `menuitem`.
     * @param {string} text
     */
    _describeMenuEntry(el, text) {
      el.setAttribute("tooltiptext", text);
      el.setAttribute("description", text);
    },

    /**
     * Gives an isolated workspace's entry the box (isolated workspaces spec
     * §10), as its image, as {@link _markAgentItem} does. An agent's entry
     * keeps its robot and a device's its phone, the one image an item has,
     * and its description says it is isolated.
     *
     * @param {Element} el A workspace `menu` or `menuitem`.
     * @param {object} item The entry it draws.
     */
    _markIsolatedItem(el, item) {
      if (!this._modules.SvalWorkspaceJar.isIsolated(this._nodes, item.id)) {
        return;
      }
      this._describeMenuEntry(
        el,
        item.agent ? `${AGENT_TEXT}. ${ISOLATED_TEXT}` : ISOLATED_TEXT
      );
      if (!item.agent && !item.device) {
        el.classList.add(this._iconicClass(el), "sval-isolated-menuitem");
        el.setAttribute("image", ISOLATED_BOX_URL);
      }
    },

    /**
     * @param {Event} event `command` from the switcher: a workspace `menuitem`,
     *   an entry's "Open in New Window", or "New Workspace…".
     */
    _onSwitcherCommand(event) {
      if (this._inMemory) {
        return;
      }
      if (event.target.hasAttribute("data-sval-new-workspace")) {
        this.run("addWorkspace", null);
        return;
      }
      const { workspaceId, openWorkspaceId, command } = event.target.dataset;
      if (openWorkspaceId) {
        this._openWorkspaceInNewWindow(openWorkspaceId);
        return;
      }
      if (command) {
        const id = event.target.closest("menu[data-workspace-id]")?.dataset
          .workspaceId;
        if (id) {
          this._runWorkspaceCommand(command, id);
        }
        return;
      }
      if (workspaceId) {
        this.pickWorkspace(workspaceId, event.shiftKey);
      }
    },

    /**
     * A press released on a workspace entry that is a `menu`
     * ({@link _fillSwitcherMenu}): the switch, or with Shift the new window.
     *
     * @param {MouseEvent} event `mouseup` in the switcher.
     */
    _onSwitcherMouseUp(event) {
      if (event.button !== 0) {
        return;
      }
      const audio = event.target.closest?.(".sval-switcher-audio");
      if (audio) {
        const entry = audio.closest("menu[data-workspace-id]");
        this._modules.SvalFirefox.actOnMedia(
          this._workspaceTabs(entry.dataset.workspaceId)
        );
        return;
      }
      // A release inside an entry's submenu is that item's own `command`.
      // An app's menu of agent workspaces holds entries of its own.
      const popup = event.target.closest?.("menupopup");
      if (
        popup !== this._els.switcherMenu &&
        !popup?.classList.contains("sval-agent-app-popup")
      ) {
        return;
      }
      const el = event.target.closest("menu[data-workspace-id]");
      if (!el) {
        return;
      }
      this._els.switcherMenu.hidePopup();
      this.pickWorkspace(el.dataset.workspaceId, event.shiftKey);
    },

    /**
     * Enter on a workspace entry that is a `menu` ({@link _fillSwitcherMenu}).
     * Gecko's popup manager takes a menu's keys in the capture phase at the
     * document (`nsXULPopupManager::UpdateKeyboardListeners`), so this listens
     * at the window, ahead of it. An entry whose submenu has an active item
     * leaves Enter to that item.
     *
     * @param {KeyboardEvent} event `keydown` at the window.
     */
    _onSwitcherMenuKeyDown(event) {
      const menu = this._els.switcherMenu;
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
      this.pickWorkspace(el.dataset.workspaceId, event.shiftKey);
    },

    /**
     * Goes to a workspace chosen in the switcher, or opens it in a window of
     * its own.
     *
     * @param {string} id
     * @param {boolean} inNewWindow
     * @returns {Promise<void>} settled once the switch has run.
     */
    pickWorkspace(id, inNewWindow) {
      if (this._inMemory) {
        return Promise.resolve();
      }
      if (inNewWindow) {
        this._openWorkspaceInNewWindow(id);
        return Promise.resolve();
      }
      // Caught here rather than left to float: this is an event handler, so
      // there is nobody above it to reject to, and a switch that fails silently
      // would leave the panel drawing one workspace while the window believed
      // it was in another.
      return this._workspace.switchTo(id).then(
        () => {},
        err => {
          this._modules.SvalLog.error(
            `switching workspace failed: ${this._modules.describeError(err)}`
          );
        }
      );
    },

    /**
     * A wheel over the panel. A sideways scroll moves the window one place
     * along the switcher's list ({@link _stepWorkspace}), once per swipe, as
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
    _onPanelWheel(event) {
      if (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !Services.prefs.getBoolPref(this._modules.SWIPE_WORKSPACES_PREF)
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
      let swipe = this._swipe;
      if (!swipe || at - swipe.at > SWIPE_REST_MS || event.isGestureStart) {
        swipe = this._swipe = {
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
      const { gesture, step } = this._modules.SvalPanelModel.wheelTurn(
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
        this._stepWorkspace(step);
      }
    },

    /**
     * Moves the window `step` places along the switcher's list of the user's
     * own workspaces, through the switcher's own switch, wrapping from either
     * end to the other. The devices' and the agents' workspaces are lists of
     * their own in the switcher ({@link switcherList}), and one an agent
     * controls lays its overlay
     * over the whole window, panel included (`SvalAgentMarking`), so a swipe
     * into it could not swipe back out.
     *
     * A workspace another window shows brings that window forward
     * (`SvalWindowWorkspace.show`), and the gesture's momentum may go on arriving over
     * it, so that window's panel takes the spent gesture
     * ({@link catchSwipe}).
     *
     * @param {number} step 1 for the next workspace, -1 for the previous.
     */
    _stepWorkspace(step) {
      const items = this.switcherList().filter(item => this._usersOwn(item));
      const here = items.findIndex(item => item.current);
      const next =
        here === -1 ? null : items[(here + step + items.length) % items.length];
      if (!next || next.current) {
        return;
      }
      if (next.elsewhere) {
        this._workspace
          .shownElsewhere()
          .get(next.id)
          ?.SvalPanel?.catchSwipe(step);
      }
      this.pickWorkspace(next.id, false);
    },

    /**
     * The user's own workspaces in the switcher's order, the one order the
     * switcher, a swipe and the Launcher list them in.
     *
     * @returns {string[]}
     */
    _workspaceOrder() {
      return this.switcherList()
        .filter(item => this._usersOwn(item))
        .map(item => item.id);
    },

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
    _moveWorkspace(id, target, side) {
      const op = this._inMemory
        ? null
        : this._modules.SvalPanelModel.moveWorkspaceOp(
            this._workspaceOrder(),
            id,
            target,
            side
          );
      if (!op) {
        return Promise.resolve();
      }
      return this._guard("moving a workspace", async () => {
        await this._engine.mutate(op);
        await this.refresh();
      });
    },

    /**
     * Drag and drop in the switcher's menu or along the strip, which
     * reorders the user's workspaces as the Favorites menu reorders favorites
     * (`SvalFavoritesView`), with its drop side and its drop line.
     *
     * @param {DragEvent} event On the menu or the strip's tablist.
     */
    _onSwitcherDrag(event) {
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
          this._scrollStripForDrag(event);
          const point = this._workspaceDropPoint(event);
          this._showWorkspaceDrop(point?.el ?? null, point?.side);
          if (point) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
          break;
        }
        case "dragleave":
          if (!event.relatedTarget || !list.contains(event.relatedTarget)) {
            this._showWorkspaceDrop(null);
          }
          break;
        case "drop": {
          event.stopPropagation();
          const point = this._workspaceDropPoint(event);
          this._showWorkspaceDrop(null);
          if (!point) {
            return;
          }
          event.preventDefault();
          this._moveWorkspace(
            event.dataTransfer.mozGetDataAt(WORKSPACE_DRAG_TYPE, 0),
            point.el.dataset.workspaceId,
            point.side
          );
          break;
        }
        case "dragend":
          this._showWorkspaceDrop(null);
          if (list !== this._els.switcherMenu) {
            this._releaseStrip();
          }
          break;
      }
    },

    /**
     * Where a drop at `event` puts the dragged workspace: the entry under
     * the pointer and the side of it by Favorites' rule
     * (`SvalFavoritesView.dropSide`), along the row on the strip. Null for
     * anything but a workspace entry of the user's being dragged over one.
     *
     * @param {DragEvent} event
     * @returns {?{el: Element, side: string}}
     */
    _workspaceDropPoint(event) {
      if (!event.dataTransfer?.types.includes(WORKSPACE_DRAG_TYPE)) {
        return null;
      }
      const el = event.target.closest?.("[data-workspace-id]");
      const onStrip = el?.classList.contains("sval-strip-item");
      // The strip's row is split by halves along it, the column's as the
      // menu's rows are.
      const alongRow = onStrip && this._els.strip.dataset.layout !== "column";
      if (
        (el?.parentNode !== this._els.switcherMenu && !onStrip) ||
        el.getAttribute("draggable") !== "true"
      ) {
        return null;
      }
      return {
        el,
        side: this._modules.dropSide(
          el,
          event.clientY,
          alongRow ? event.clientX : null
        ),
      };
    },

    /**
     * Draws the drop line on `el`'s `side`, with the Favorites menu's own
     * line (`SvalFavoritesView.showDropLine`).
     *
     * @param {?Element} el
     * @param {string} [side]
     */
    _showWorkspaceDrop(el, side) {
      this._workspaceDropOn = this._modules.showDropLine(
        this._workspaceDropOn,
        el,
        side
      );
    },

    /**
     * Takes a gesture that has already moved by `dir` in another window and
     * brought this one forward, so the rest of it does nothing here either.
     * Each window's `timeStamp`s count from its own time origin, so the
     * gesture's last event is this window's now.
     *
     * @param {number} dir The sign the gesture moved by.
     */
    catchSwipe(dir) {
      const at = window.performance.now();
      this._swipe = {
        at,
        axis: "x",
        held: true,
        travelX: 0,
        travelY: 0,
        before: 0,
        turn: this._modules.SvalPanelModel.spentWheelTurn(at, dir),
      };
    },

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
    _openWorkspaceInNewWindow(id) {
      if (this._inMemory) {
        return null;
      }
      const { handWorkspaceTo } = this._modules.SvalPanelModel;
      const { WORKSPACE } = this._modules.SvalTree;
      if (this._nodes[id]?.kind !== WORKSPACE) {
        // A workspace another device deleted between the menu being built and an
        // entry being pressed. The redraw takes the entry away, which is the
        // answer (spec §10.7).
        this.render();
        return null;
      }
      if (id === this._workspace.id) {
        window.focus();
        return null;
      }
      const shownBy = this._workspace.shownElsewhere().get(id);
      if (shownBy) {
        shownBy.focus();
        return null;
      }

      const opened = window.OpenBrowserWindow();
      handWorkspaceTo(opened, id);
      return opened;
    },
  });
}
