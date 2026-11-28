/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The switcher's button and the Favorites button: the switcher's button
 * names the Workspace the window shows, with the window's colour and title,
 * and the Favorites button opens its menu. The switcher's menus are
 * `SvalPanelSwitcher`'s.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
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
      label = this._nodes[current]?.content?.name || this._untitled(WORKSPACE);
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
          transparency: preview?.transparency ?? null,
        };
    // An agent's workspace wears the robot face and the agent's hue, never an
    // emoji of its own (`workspaceColor` says the same of its colour).
    const agent = agentLabelOf(this._nodes, current, this.switcher.devices());
    const { mark, emoji } = current
      ? this._modules.SvalWorkspaceEntries.workspaceIcon(this._nodes, current)
      : { mark: null, emoji: stored.emoji };
    this._agentLabel = agent;
    const color = current
      ? this.workspaceColor(current)
      : SvalColor.colorOf(stored.color, "workspace");
    // The Edit Workspace dialog's choice, drawn while it is open.
    // No colour is Sval's own, see-through like any other; an agent's
    // window wears the agent's hue, solid.
    const shownLook = this._colorPreview ?? {
      color,
      transparency: agent ? 0 : SvalColor.transparencyOf(stored.transparency),
    };
    this._shownLook = shownLook;

    switcher.textContent = "";
    // Always present: the stylesheet draws a workspace icon in an empty tile,
    // so a workspace with no emoji still has a tile to carry its colour.
    const tile = this._html("span");
    tile.className = "sval-switcher-emoji";
    if (mark) {
      // The mark is drawn by the stylesheet, and the accessible name below
      // says whose workspace it is.
      tile.classList.add("sval-agent-glyph");
      tile.setAttribute("aria-hidden", "true");
      tile.style.setProperty("--sval-agent-mark", `url("${mark}")`);
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
      switcher.setAttribute(
        "title",
        this._modules.SvalWorkspaceEntries.ISOLATED_TEXT
      );
      switcher.setAttribute(
        "aria-description",
        this._modules.SvalWorkspaceEntries.ISOLATED_TEXT
      );
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
    this._applyAgentMarking(agent, mark);
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
    this.switcher.refillOpen();
    this.strip.render();
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
   * The Favorites menu: the favorites document, from any workspace (import
   * spec §6). A favorite opens in a new tab in this window's workspace, or in
   * the selected tab when it is empty, and a bookmarklet runs on the
   * selected tab's page (`SvalFavorites.open`).
   *
   * `SvalFavoritesView` draws it from the document, and draws it again as
   * Favorites change (favorites-native spec §5.3).
   *
   * It is drawn by Gecko (`nonnative`, which `SvalMenu`'s panel look sets),
   * which is what lets its items carry a context menu (favorites-native
   * spec §15.2), in a panel's look (`sval-menu.css`), as the switcher is.
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
    // Grows up from its button in the panel's footer (`SvalStem`).
    popup.setAttribute("sval-stem-host", "");
    popup.setAttribute("sval-stem-side", "top");
    // A panel's look; `SvalFavoritesView` draws its items.
    this._modules.SvalMenu.fill(popup, [], { look: "panel" });
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

  /** Opens the Favorites menu over its button, in the panel's footer. */
  openFavorites() {
    this._els.favoritesMenu.openPopup(
      this._els.favorites,
      "before_start",
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
});
