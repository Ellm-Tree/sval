/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The window wearing the workspace it shows: the accent and tint of its
 * colour, an agent's marking, and the workspace's name in the window title.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /** Every custom property `applyAccent` sets under its prefix, "" the prefix itself. */
  _accentMembers: [
    "",
    "invert",
    "h",
    "bh",
    "bc",
    "bd",
    "bdd",
    "bdir",
    "lmin",
    "lmax",
    "text",
    "muted",
  ],

  /**
   * The Workspace colour the window wears ({@link _applyWindowTint}), or
   * null: Sval's dialogs over the window solve their card from it
   * (`SvalDialogBox.fitFrame`).
   *
   * @type {string|object|null}
   */
  windowColor: null,

  /** What the window's title was last prefaced from (`_applyWindowTitle`). */
  _titleArgs: null,

  /**
   * The workspace, colour and transparency {@link _renderSwitcher} last
   * announced on `WINDOW_WORKSPACE_TOPIC`, so a redraw that changes none
   * stays quiet.
   */
  _shownWorkspace: null,

  /**
   * The colour and transparency the window shows: the Edit dialog's choice
   * while it is open, else the workspace's own ({@link _renderSwitcher}).
   */
  _shownLook: null,

  /**
   * The colour and transparency workspace `id` is drawn in: for the one this
   * window shows, what the window shows, the Edit dialog's choice included,
   * so its home page follows each choice as the window does; for another,
   * its own.
   *
   * @param {string|null} id A workspace id.
   * @returns {{color: string|object|null, transparency: number}}
   */
  shownLookOf(id) {
    if (id && id === this._workspace.id && this._shownLook) {
      return this._shownLook;
    }
    return {
      color: this.workspaceColor(id),
      transparency: this.workspaceTransparency(id),
    };
  },

  /**
   * Paints `element`'s accent from a group colour, or clears it: the
   * colour's ink on light and dark surfaces, which `sval-panel.css` picks
   * between with `light-dark()`, its block members, from which
   * `sval-panel.css` draws a group's block, how far the block may step off
   * this window (`SvalColor.groupBounds`), and the text solved on that block
   * (`SvalColor.groupInk`).
   *
   * `data-sval-color` is what the stylesheet keys on: the preset's name, or
   * `custom`. A node with no colour, or one this build cannot draw (which
   * `SvalColor.colorOf` has already turned into null), draws with no accent.
   *
   * @param {Element} element
   * @param {string|object|null} color A group colour, already filtered.
   * @param {string} [prefix] The custom-property family to set: the row's own
   *   accent, or `--sval-base` for the outermost colour a nested group sits in.
   * @param {{l: number, surfaceDark: boolean, dir: number}} [on] The window
   *   the block sits on; this one when absent.
   */
  applyAccent(element, color, prefix = "--sval-accent", on = null) {
    const { SvalColor } = this._modules;
    let set = {};
    if (color) {
      const surface = on ?? this.windowBlockSurface();
      const more = this._moreContrast();
      const { text, muted } = SvalColor.groupInk(color, surface, more);
      set = {
        ...SvalColor.groupProperties(color, prefix),
        ...SvalColor.groupBoundProperties(color, surface, more, prefix),
        [`${prefix}-text`]: text,
        [`${prefix}-muted`]: muted,
      };
    }
    for (const member of this._accentMembers) {
      const name = member ? `${prefix}-${member}` : prefix;
      if (name in set) {
        element.style.setProperty(name, set[name]);
      } else {
        element.style.removeProperty(name);
      }
    }
    if (prefix !== "--sval-accent") {
      return;
    }
    if (color) {
      element.setAttribute(
        "data-sval-color",
        SvalColor.isPreset(color) ? color : "custom"
      );
    } else {
      element.removeAttribute("data-sval-color");
    }
  },

  /**
   * The colour a workspace marks its window with: its own, filtered, or none
   * for an agent's. An agent's workspace wears the agent's hue, never a colour
   * of its own: colours are how the user marks their own places, and an
   * agent's must not pass for one (agent-control spec §6).
   *
   * @param {string|null} id A workspace id.
   * @returns {string|object|null} a Workspace colour.
   */
  workspaceColor(id) {
    const { agentLabelOf } = this._modules.SvalPanelModel;
    const { appearanceOf } = this._modules.SvalTree;
    if (!id || agentLabelOf(this._nodes, id, this.switcher.devices())) {
      return null;
    }
    return this._modules.SvalColor.colorOf(
      appearanceOf(this._nodes, id).color,
      "workspace"
    );
  },

  /**
   * How see-through a workspace asks its window to be, as stored or Sval's
   * default when it holds none (`SvalColor.transparencyOf`), with no colour
   * too, since no colour is Sval's own (`SvalColor.windowLook`): 0 for an
   * agent's, which wears the agent's hue ({@link workspaceColor}).
   *
   * @param {string|null} id A workspace id.
   * @returns {number}
   */
  workspaceTransparency(id) {
    const { agentLabelOf } = this._modules.SvalPanelModel;
    const { appearanceOf } = this._modules.SvalTree;
    if (!id || agentLabelOf(this._nodes, id, this.switcher.devices())) {
      return 0;
    }
    return this._modules.SvalColor.transparencyOf(
      appearanceOf(this._nodes, id).transparency
    );
  },

  /**
   * The colour a Workspace colour's window is in this appearance, opaque, as
   * a tile or a dot that stands for the Workspace.
   *
   * @param {string|object} color A Workspace colour, already filtered.
   * @returns {string} a CSS colour.
   */
  workspaceSwatch(color) {
    return this._modules.SvalColor.swatchOf(color, "workspace", {
      scheme: this._scheme(),
      more: this._moreContrast(),
    });
  },

  /** @returns {"dark"|"light"} the system appearance this window follows. */
  _scheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  },

  /** @returns {boolean} whether this window asks for more contrast. */
  _moreContrast() {
    return window.matchMedia("(prefers-contrast: more)").matches;
  },

  /**
   * The material this window shows what is behind it through, or null for
   * a window that draws its colour solid (`SvalColor.seeThroughMaterial`,
   * decision 0057).
   *
   * @returns {"hud"|"acrylic"|"blur"|null}
   */
  seeThrough() {
    return this._modules.SvalColor.seeThroughMaterial(
      this._modules.AppConstants.platform,
      query => window.matchMedia(query).matches
    );
  },

  /**
   * The window's look in the current appearance for `color` at
   * `transparency` (`SvalColor.windowLook`), or null for none.
   *
   * @param {string|object|null} color
   * @param {number} [transparency]
   * @returns {object|null}
   */
  windowLookOf(color, transparency = 0) {
    return this._modules.SvalColor.windowLook(
      { color, transparency },
      {
        scheme: this._scheme(),
        more: this._moreContrast(),
        seeThrough: this.seeThrough(),
      }
    );
  },

  /**
   * Tints the whole window with the workspace's colour, or clears the tint:
   * every colour `SvalColor` solves for it, as custom properties, the side
   * its ink is on as `data-sval-ink`, and on a window that can see through
   * `data-sval-see-through` with the colour at its share as
   * `--sval-tint-accent`. A see-through window on Windows and Linux also
   * carries `windowsmica`, which puts the system's backdrop behind it:
   * Acrylic on Windows (`nsWindow::UpdateMicaBackdrop`), the compositor's
   * blur on Linux (`nsWindow::SetMicaBackdrop`). Without it the window's
   * clear parts show what is behind them sharp.
   * The stylesheets key on `data-sval-tint`.
   *
   * The look follows the system's appearance, its contrast and its
   * transparency setting ({@link _watchAppearance}).
   *
   * @param {string|object|null} color A Workspace colour, already filtered.
   * @param {number} [transparency] As stored.
   */
  _applyWindowTint(color, transparency = 0) {
    this._tintArgs = [color, transparency];
    this._watchAppearance();
    const root = document.documentElement;
    const look = this.windowLookOf(color, transparency);
    this.windowLook = look;
    this.windowColor = look ? color : null;
    for (const name of this._tintProperties ?? []) {
      root.style.removeProperty(name);
    }
    this._tintProperties = [];
    if (!look) {
      root.removeAttribute("data-sval-tint");
      root.removeAttribute("data-sval-ink");
      root.removeAttribute("data-sval-see-through");
      root.removeAttribute("data-sval-translucent");
      root.removeAttribute("windowsmica");
      return;
    }
    const properties = this._modules.SvalColor.windowProperties(look);
    if (look.accent) {
      properties["--sval-tint-accent"] = look.accent;
    }
    for (const [name, value] of Object.entries(properties)) {
      root.style.setProperty(name, value);
      this._tintProperties.push(name);
    }
    root.setAttribute("data-sval-tint", "true");
    root.setAttribute("data-sval-ink", look.side);
    root.toggleAttribute("data-sval-see-through", !!look.accent);
    // Some of what is behind the window shows, which the window's menus
    // follow (`sval-menu.css`); at no transparency the window is opaque.
    root.toggleAttribute("data-sval-translucent", look.transparency > 0);
    root.toggleAttribute(
      "windowsmica",
      look.material === "acrylic" || look.material === "blur"
    );
  },

  /**
   * The window a group's block sits on, as `SvalColor.groupBlock` takes it:
   * this window's colour, or Sval's untinted window, which is dark in both
   * appearances for a private or an agent's window (`sval-panel.css`).
   *
   * @returns {{l: number, surfaceDark: boolean, dir: number}}
   */
  windowBlockSurface() {
    if (this.windowLook) {
      return this.windowLook.block;
    }
    const root = document.documentElement;
    const alwaysDark =
      root.hasAttribute("privatebrowsingmode") ||
      root.hasAttribute("data-sval-agent");
    return this._modules.SvalColor.untintedSurface(
      alwaysDark ? "dark" : this._scheme()
    );
  },

  /**
   * What the rows' group blocks are measured from, for a row's signature: a
   * row whose window changed under it is drawn again with its text solved
   * on the new one.
   *
   * @returns {string}
   */
  _blockSurfaceKey() {
    const on = this.windowLook?.block;
    return [
      on ? `${on.l}|${on.surfaceDark}|${on.dir}` : this._scheme(),
      this._moreContrast(),
    ].join("|");
  },

  /**
   * Listens, once per window, for the system changes the window's look
   * depends on, and draws the window again on each.
   */
  _watchAppearance() {
    if (this._watchingAppearance) {
      return;
    }
    this._watchingAppearance = true;
    for (const query of [
      "(prefers-color-scheme: dark)",
      "(prefers-contrast: more)",
      "(prefers-reduced-transparency: reduce)",
    ]) {
      window.matchMedia(query).addEventListener("change", () => {
        if (this._nodes) {
          this.render();
        } else if (this._tintArgs) {
          this._applyWindowTint(...this._tintArgs);
        }
      });
    }
  },

  /**
   * The colour the Edit Workspace dialog is trying on this window, `{color,
   * transparency}`, which the window wears in place of the workspace's own
   * (`_renderSwitcher`); null when no dialog is.
   *
   * @type {?object}
   */
  _colorPreview: null,

  /**
   * Wears `look` on the window while the Edit Workspace dialog is open, so
   * each change shows on the real window, or puts the workspace's own colour
   * back with null. The dialog's backdrop is cleared while it does, so the
   * window is seen as it will be (`sval-header.css`).
   *
   * @param {?{color: (string|object|null), transparency: number}} look
   * @param {boolean} [done] False while a drag goes on, when only the window
   *   and its switcher are drawn again; the rows follow when it ends.
   */
  previewColor(look, done = true) {
    this._colorPreview = look;
    document.documentElement.toggleAttribute("data-sval-color-preview", !!look);
    if (done) {
      this.render();
    } else {
      this._renderSwitcher();
    }
  },

  /**
   * Marks the window as an agent's, or clears the mark: the striped band and
   * the agent hue `sval-panel.css` draws on `data-sval-agent`, and the overlay
   * over the window (`SvalAgentMarking`) (agent-control spec §6).
   *
   * @param {string|null} agent The agent's label, or null for a window that
   *   shows one of the user's workspaces.
   * @param {string|null} mark The URL of the agent's mark, its app's or the
   *   robot.
   */
  _applyAgentMarking(agent, mark) {
    const root = document.documentElement;
    root.toggleAttribute("data-sval-agent", !!agent);
    // The window's marks, its tab rows' and its agent bar's, draw this.
    if (mark) {
      root.style.setProperty("--sval-agent-mark", `url("${mark}")`);
    } else {
      root.style.removeProperty("--sval-agent-mark");
    }
    // What a screen reader says of the window as it enters the panel. The
    // window's own accessible is named by its title, which starts with the
    // agent's label, and takes no description from the document's markup
    // (the root chrome document reports no `aria-describedby`).
    if (agent) {
      this._els.tree.setAttribute("aria-description", `controlled by ${agent}`);
    } else {
      this._els.tree.removeAttribute("aria-description");
    }
    if (agent && !this._agentMarking) {
      this._agentMarking = new this._modules.AgentWindowMarking(window);
    }
    this._agentMarking?.update(agent);
  },

  /**
   * Prefaces the window's title with the workspace it shows.
   *
   * `titlepreface` on the document element is Firefox's own hook for this
   * (`tabbrowser.js`'s `#determineContentTitle` reads it, and `ext-browser.js`'s
   * `setTitlePreface` is the WebExtension route to the same attribute), so this
   * needs no patch, and `updateTitlebar` makes it take effect at once rather
   * than at the next tab switch.
   *
   * Every window does this, not only a torn-off one. A window that was torn off
   * is deliberately indistinguishable from any other afterwards: the hand-off
   * is consumed at startup and the workspace is kept where a restart reads it
   * (`SvalPanelSwitcher.openInNewWindow`), so there is no flag to branch on, and a title
   * that named the workspace in some windows and not others would be the odd
   * behaviour.
   *
   * @param {string|null} emoji
   * @param {string} name The label the switcher drew, placeholder included.
   * @param {string} [placeholder] The name of a nameless workspace.
   */
  _applyWindowTitle(emoji, name, placeholder) {
    this._titleArgs = [emoji, name, placeholder];
    const { windowTitlePreface } = this._modules.SvalPanelModel;
    let preface = windowTitlePreface(emoji, name, placeholder);
    // A pin's page is titled for its pin, before its page's own title.
    const pin = this._pins?.selectedPin;
    if (pin) {
      preface += `${pin.name} / `;
    }
    const root = document.documentElement;
    if (preface) {
      root.setAttribute("titlepreface", preface);
    } else {
      root.removeAttribute("titlepreface");
    }
    window.gBrowser?.updateTitlebar();
  },
});
