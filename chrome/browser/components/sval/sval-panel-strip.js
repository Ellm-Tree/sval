/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The strip: the Workspace switcher that shows every Workspace in a row, in
 * place of the switcher button, when Settings › Workspaces picks it
 * (`SvalPanelModel.SWITCHER_PREF`). It lists what the switcher's menu lists,
 * in the same order ({@link SvalPanel._switcherList}), and goes to a
 * Workspace through the same switch ({@link SvalPanel._pickWorkspace}).
 *
 * `SvalWindow` loads this as a classic script after `sval-panel-switcher.js`;
 * it adds its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */
/* import-globals-from sval-panel-switcher.js */

{
  /**
   * Each item's size along the strip, in CSS pixels, as `sval-panel.css`
   * (strip) draws it: an item's inline padding, its tile, and the gap between
   * the tile and its name; an icon's width; the gap between items. The
   * strip's place along its track is worked out from these and from each
   * name's width, so it slides to where the items end up while their widths
   * are still animating there.
   */
  const NAMED = { padding: 20, tile: 28, gap: 6 };
  const WIDENED = { padding: 13, tile: 28, gap: 6 };
  const ICON_WIDTH = 34;
  const DIVIDER_WIDTH = 1;
  const NAMED_GAP = 4;
  const ICON_GAP = 3;

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

  Object.assign(SvalPanel, {
    /**
     * The strip's state between renders: where it was last placed
     * (`{ width, total, x, w }`, as `SvalPanelModel.stripTranslate` takes
     * them), the room each Workspace takes along it on average, the wheel's
     * slide, whether the wheel is sliding it now, the
     * slide-back timer, the Workspace the strip was last drawn for, the
     * switching wheel's gesture in progress (`SvalPanelModel.wheelTurn`),
     * and the Workspace the wheel last moved to, until the window shows
     * it.
     */
    _strip: {
      geometry: null,
      pitch: 0,
      offset: 0,
      sliding: false,
      slideBack: null,
      gesture: null,
      placedFor: null,
      pending: null,
      pendingAt: 0,
    },

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
    _buildStrip() {
      const strip = this._html("div");
      strip.className = "sval-strip";
      strip.hidden = true;
      const track = this._html("div");
      track.className = "sval-strip-track";
      const view = this._html("div");
      view.className = "sval-strip-view";
      const row = this._html("div");
      row.className = "sval-strip-row";
      const tabs = this._html("div");
      tabs.className = "sval-strip-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Workspaces");
      const add = this._html("button");
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
      const line = this._html("div");
      line.className = "sval-strip-line";
      line.setAttribute("aria-hidden", "true");
      line.hidden = true;
      line.append(this._html("span"));
      // The current Workspace's name, where the items show none. A tab's
      // accessible name carries it.
      const caption = this._html("div");
      caption.className = "sval-strip-caption";
      caption.setAttribute("aria-hidden", "true");
      caption.hidden = true;
      const dots = this._html("div");
      dots.className = "sval-strip-dots";
      dots.setAttribute("aria-hidden", "true");
      const hairline = this._html("div");
      hairline.className = "sval-strip-hairline";
      strip.append(track, caption, dots, line, hairline);

      tabs.addEventListener("keydown", event => this._onStripKeyDown(event));
      strip.addEventListener("click", event => this._onStripClick(event));
      strip.addEventListener("contextmenu", event =>
        this._onStripContextMenu(event)
      );
      // Not passive: a wheel the strip takes holds the panel still.
      view.addEventListener("wheel", event => this._onStripWheel(event), {
        passive: false,
      });
      // Over and out of the view itself, not each item in it.
      const crossing = event => !view.contains(event.relatedTarget);
      view.addEventListener("mouseover", event => {
        if (crossing(event)) {
          this._holdStrip();
        }
      });
      view.addEventListener("mouseout", event => {
        if (crossing(event)) {
          this._releaseStrip();
        }
      });
      for (const type of [
        "dragstart",
        "dragover",
        "dragleave",
        "drop",
        "dragend",
      ]) {
        tabs.addEventListener(type, event => this._onSwitcherDrag(event));
      }
      this._stripResize?.disconnect();
      this._stripResize = new ResizeObserver(() => this._placeStrip());
      this._stripResize.observe(view);
      Object.assign(this._strip, {
        offset: 0,
        sliding: false,
        pending: null,
      });
      return strip;
    },

    /**
     * Shows the switcher the setting picks: the strip, or the button and its
     * menu. Either way the window stays on its Workspace.
     */
    _applySwitcherKind() {
      const { switcher, strip, switcherMenu } = this._els;
      const { SWITCHER_PREF } = this._modules.SvalPanelModel;
      const useStrip =
        Services.prefs.getStringPref(SWITCHER_PREF, "menu") === "strip";
      if (useStrip && switcherMenu?.state !== "closed") {
        switcherMenu?.hidePopup();
      }
      switcher.hidden = useStrip;
      strip.hidden = !useStrip;
      if (useStrip) {
        this._renderStrip();
      }
    },

    /** @returns {boolean} whether the strip is the switcher shown. */
    _stripShown() {
      return !!this._els?.strip && !this._els.strip.hidden;
    },

    /**
     * @returns {string} what the strip shows of each Workspace's name: one of
     *   `SvalPanelModel.STRIP_NAMES`.
     */
    _stripNames() {
      const { STRIP_NAMES, STRIP_NAMES_PREF } = this._modules.SvalPanelModel;
      const names = Services.prefs.getStringPref(STRIP_NAMES_PREF, "all");
      return STRIP_NAMES.includes(names) ? names : "all";
    },

    /**
     * The strip's layout at the Workspace panel's width: `"wide"`, `"icons"`
     * or `"column"` ({@link WIDE_PANEL_PX}).
     *
     * @returns {string}
     */
    _stripLayout() {
      const width = this._els.container.getBoundingClientRect().width;
      if (width <= NARROW_PANEL_PX) {
        return "column";
      }
      return width < WIDE_PANEL_PX ? "icons" : "wide";
    },

    /**
     * Draws the strip from the document as it stands: one tab per Workspace
     * in the switcher's order, the agents' after a divider, and the current
     * one selected. Items are kept from one render to the next, so a width
     * or a slide animates and focus stays where it is.
     */
    _renderStrip() {
      if (!this._stripShown()) {
        return;
      }
      const strip = this._els.strip;
      const tabs = strip.querySelector(".sval-strip-tabs");
      const layout = this._stripLayout();
      const chosen = this._stripNames();
      // Narrower than the wide layout, an item's name would be cut to a few
      // letters, so the items show icons and the caption the current name.
      const names = layout === "wide" ? chosen : "none";
      const items = this._switcherList();
      const kept = new Map(
        Array.from(tabs.querySelectorAll(":scope > [data-strip-key]"), el => [
          el.dataset.stripKey,
          el,
        ])
      );
      const wanted = [];
      let divider = tabs.querySelector(":scope > .sval-strip-divider");
      for (const entry of this._stripEntries(items)) {
        if (entry.item.agent && !wanted.some(el => el === divider)) {
          divider ??= this._stripDivider();
          wanted.push(divider);
        }
        const el = kept.get(entry.key) ?? this._stripItem(entry.key);
        kept.delete(entry.key);
        this._paintStripItem(el, entry.item, names, entry.app);
        wanted.push(el);
      }
      for (const el of kept.values()) {
        el.remove();
      }
      if (divider && !wanted.includes(divider)) {
        divider.remove();
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
      strip.dataset.layout = layout;
      tabs.setAttribute(
        "aria-orientation",
        layout === "column" ? "vertical" : "horizontal"
      );
      const current = items.find(item => item.current);
      if (
        this._stripAppMenu?.state === "open" &&
        !tabs.querySelector(
          `[data-agent-app="${CSS.escape(this._stripAppMenu.dataset.agentApp)}"]`
        )
      ) {
        this._stripAppMenu.hidePopup();
      }
      const caption = strip.querySelector(".sval-strip-caption");
      caption.hidden = layout !== "icons" || chosen === "none" || !current;
      caption.textContent = current ? this.workspaceName(current) : "";
      // A slide is a look along the strip from the Workspace shown. Once the
      // window shows another, the strip goes straight from where it was slid
      // to the new one, with the slide's own ease.
      if (this._strip.placedFor !== this._currentWorkspaceId) {
        this._strip.placedFor = this._currentWorkspaceId;
        this._strip.offset = 0;
        this._strip.sliding = false;
      }
      if (
        this._strip.pending &&
        this._strip.pending === this._currentWorkspaceId
      ) {
        this._strip.pending = null;
      }
      this._placeStrip();
    },

    /** @returns {Element} the line between the user's and the agents' items. */
    _stripDivider() {
      const el = this._html("div");
      el.className = "sval-strip-divider";
      el.setAttribute("aria-hidden", "true");
      return el;
    },

    /**
     * What the strip draws for `items`: one entry for each of the user's
     * Workspaces, and one for each agent app (`item.agent`), however many
     * Workspaces it has, so every session an agent starts does not lengthen
     * the strip. An app with one Workspace is that Workspace's item. An app
     * with more stands for the Workspace the window shows, when it is one of
     * them, or else the one a session used last, and opens a list of them
     * all ({@link _openStripAppMenu}).
     *
     * @param {object[]} items {@link _switcherList}'s entries.
     * @returns {{key: string, item: object, app: ?{label: string,
     *   ids: string[]}}[]}
     */
    _stripEntries(items) {
      const used = item =>
        this._agentWorkspaceEntry(item.id)?.lastUsed ?? -Infinity;
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
    },

    /**
     * @param {string} key A Workspace id, or an agent app's `app:` key
     *   ({@link _stripEntries}).
     * @returns {Element} an empty `tab` for it, filled by
     *   {@link _paintStripItem}.
     */
    _stripItem(key) {
      const el = this._html("div");
      el.className = "sval-strip-item";
      el.setAttribute("role", "tab");
      el.dataset.stripKey = key;
      const tile = this._html("span");
      tile.className = "sval-strip-tile";
      const face = this._html("span");
      face.className = "sval-strip-face";
      face.setAttribute("aria-hidden", "true");
      const isolated = this._html("span");
      isolated.className = "sval-strip-isolated";
      isolated.setAttribute("aria-hidden", "true");
      // Pressed without picking the Workspace ({@link _onStripClick}); the
      // Workspace's menu has the keyboard's way to the same command.
      const audio = this._html("button");
      audio.className = "sval-strip-audio";
      audio.setAttribute("tabindex", "-1");
      audio.setAttribute("aria-hidden", "true");
      const count = this._html("span");
      count.className = "sval-strip-count";
      count.setAttribute("aria-hidden", "true");
      tile.append(face, isolated, audio, count);
      const name = this._html("span");
      name.className = "sval-strip-name";
      el.append(tile, name);
      return el;
    },

    /**
     * Fills one item from its `switcherItems` entry: its tile, its name, the
     * marks for isolation and sound, and what it says to the pointer and to a
     * screen reader.
     *
     * An agent app's item ({@link _stripEntries}) is named for the app, says
     * how many Workspaces it holds, and opens their list.
     *
     * @param {Element} el
     * @param {object} item
     * @param {string} names What the strip shows of names.
     * @param {?{label: string, ids: string[]}} [app] The agent app the item
     *   stands for, when it stands for more than one Workspace.
     */
    _paintStripItem(el, item, names, app = null) {
      const { SvalWorkspaceJar } = this._modules;
      el.dataset.workspaceId = item.id;
      const name = app ? app.label : this.workspaceName(item);
      const label = app
        ? `${app.label}, ${app.ids.length} Workspaces`
        : this._switcherItemLabel(item);
      const isolated =
        !app && SvalWorkspaceJar.isIsolated(this._nodes, item.id);
      const showsName =
        names === "all" || (names === "current" && item.current);

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
      // list ({@link _openSwitcher}), and on an agent app its own list.
      if (item.current || app) {
        el.setAttribute("aria-haspopup", "menu");
      } else {
        el.removeAttribute("aria-haspopup");
        el.removeAttribute("aria-expanded");
      }
      el.toggleAttribute("data-shows-name", showsName);
      el.toggleAttribute("data-isolated", isolated);
      // The user's own Workspaces are put in order by dragging, as in the
      // menu; the agents' keep theirs.
      el.setAttribute("draggable", String(!item.agent && !this._inMemory));
      el.setAttribute("aria-label", label);
      const described = [
        item.agent ? this._agentText : null,
        isolated ? this._isolatedText : null,
      ].filter(Boolean);
      if (described.length) {
        el.setAttribute("aria-description", described.join(". "));
      } else {
        el.removeAttribute("aria-description");
      }
      // A hidden name is in the tooltip; a shown one needs only the
      // isolation's meaning there.
      const tooltip = [
        showsName ? null : name,
        isolated ? this._isolatedText : null,
      ]
        .filter(Boolean)
        .join("\n");
      if (tooltip) {
        el.title = tooltip;
      } else {
        el.removeAttribute("title");
      }

      const face = el.querySelector(".sval-strip-face");
      const emoji = item.agent ? null : item.emoji;
      face.textContent = emoji ?? "";
      face.classList.toggle("sval-strip-agent", !!item.agent);
      if (item.agent) {
        face.style.setProperty(
          "--sval-agent-mark",
          `url("${this._agentMarkURL(item.brand)}")`
        );
      } else {
        face.style.removeProperty("--sval-agent-mark");
      }
      const color = this.workspaceColor(item.id);
      const tile = el.querySelector(".sval-strip-tile");
      if (color) {
        tile.style.setProperty(
          "--sval-strip-fill",
          this.workspaceSwatch(color)
        );
      } else {
        tile.style.removeProperty("--sval-strip-fill");
      }
      el.querySelector(".sval-strip-name").textContent = name;
      this._paintStripSound(el);
    },

    /**
     * Shows or hides one item's sound badge, as the menu's entries show
     * their media button ({@link _paintEntrySound}).
     *
     * @param {Element} el A strip item.
     */
    _paintStripSound(el) {
      const id = el.dataset.workspaceId;
      const action = this._workspaceMedia(id);
      const audio = el.querySelector(".sval-strip-audio");
      if (action) {
        el.setAttribute("data-media", action);
        audio.title = this._mediaTooltip(this._workspaceTabs(id));
      } else {
        el.removeAttribute("data-media");
        audio.removeAttribute("title");
      }
    },

    /** Paints every item's sound badge while the strip shows. */
    _paintStripSounds() {
      if (!this._stripShown()) {
        return;
      }
      for (const el of this._els.strip.querySelectorAll(".sval-strip-item")) {
        this._paintStripSound(el);
      }
    },

    /**
     * Sizes each item and slides the strip so the current item sits at the
     * track's centre ({@link SvalPanelModel.stripTranslate}), along the row
     * or down the column, with the edges' fade and where it stands among
     * them all while it overflows.
     */
    _placeStrip() {
      if (!this._stripShown()) {
        return;
      }
      const strip = this._els.strip;
      if (strip.dataset.layout !== this._stripLayout()) {
        this._renderStrip();
        return;
      }
      const view = strip.querySelector(".sval-strip-view");
      const row = strip.querySelector(".sval-strip-row");
      const tabs = row.querySelector(".sval-strip-tabs");
      const { names, layout } = strip.dataset;
      const column = layout === "column";
      const gap = names === "all" ? NAMED_GAP : ICON_GAP;
      const width = column ? view.clientHeight : view.clientWidth;
      let x = 0;
      let current = null;
      const workspaces = [];
      for (const el of tabs.children) {
        let size = DIVIDER_WIDTH;
        if (el.classList.contains("sval-strip-item")) {
          size = this._stripItemWidth(el, names, width);
          // A column's items take its width, and their height is the icon's.
          el.style.width = column ? "" : `${size}px`;
          workspaces.push(el);
          if (el.hasAttribute("data-current")) {
            current = { x, w: size };
          }
        }
        x += size + gap;
      }
      const total = x + ICON_WIDTH;
      const overflows = total > width;
      strip.toggleAttribute("data-overflow", overflows);
      strip.toggleAttribute("data-sliding", this._strip.sliding);
      if (!overflows) {
        this._strip.offset = 0;
      }
      this._strip.geometry = current ? { width, total, ...current } : null;
      this._strip.pitch = workspaces.length ? x / workspaces.length : 0;
      // On whole device pixels, where the window draws a translation, so a
      // popover traced from a tile's layout box (`SvalHeader`'s
      // `placeStemOf`) meets the tile as drawn.
      const translate = current
        ? Math.round(
            this._modules.SvalPanelModel.stripTranslate({
              ...this._strip.geometry,
              offset: this._strip.offset,
            }) * window.devicePixelRatio
          ) / window.devicePixelRatio
        : 0;
      row.style.transform = column
        ? `translateY(${translate}px)`
        : `translateX(${translate}px)`;
      this._drawStripPosition(workspaces, overflows);
    },

    /**
     * An item's size along the strip: an icon's, or its tile and name with
     * its padding, up to the track less two icons, where the name is cut
     * short. The cap grows with the panel and leaves a whole icon each side.
     *
     * @param {Element} el A strip item.
     * @param {string} names What the strip shows of names.
     * @param {number} track The track's inner width.
     * @returns {number}
     */
    _stripItemWidth(el, names, track) {
      if (!el.hasAttribute("data-shows-name")) {
        return ICON_WIDTH;
      }
      const size = names === "all" ? NAMED : WIDENED;
      // The text's own width, in fractions of a pixel. `scrollWidth` rounds
      // to the nearest whole one (`Element::ScrollWidth`), and a name a
      // fraction wider than its box is cut by the ellipsis.
      const range = document.createRange();
      range.selectNodeContents(el.querySelector(".sval-strip-name"));
      const text = range.getBoundingClientRect().width;
      return Math.min(
        track - 2 * ICON_WIDTH,
        Math.ceil(size.padding + size.tile + size.gap + text)
      );
    },

    /**
     * Where the current Workspace stands among them all, while the strip
     * overflows: a dot per Workspace, the current one a pill, while the dots
     * fit under the track, and otherwise a line with a thumb. The column
     * has room for neither, and shows neither.
     *
     * @param {Element[]} workspaces The items, in order.
     * @param {boolean} overflows
     */
    _drawStripPosition(workspaces, overflows) {
      const strip = this._els.strip;
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
        dots.append(this._html("span"));
      }
      workspaces.forEach((el, i) =>
        dots.children[i].toggleAttribute(
          "data-current",
          el.hasAttribute("data-current")
        )
      );
    },

    /**
     * A click on the strip: an item goes to its Workspace, or with Shift
     * opens it in a new window, and the current one opens the full list;
     * its sound badge mutes or pauses what plays there. New Workspace… runs
     * through the panel's own command.
     *
     * @param {MouseEvent} event
     */
    _onStripClick(event) {
      const audio = event.target.closest?.(".sval-strip-audio");
      const el = event.target.closest?.(".sval-strip-item");
      if (!el || event.button !== 0) {
        return;
      }
      if (audio) {
        this._modules.SvalFirefox.actOnMedia(
          this._workspaceTabs(el.dataset.workspaceId)
        );
        return;
      }
      if (el.dataset.agentApp && !event.shiftKey) {
        this._openStripAppMenu(el);
        return;
      }
      // The current Workspace's item opens the full list, which names every
      // Workspace, the strip's icons included.
      if (el.hasAttribute("data-current") && !event.shiftKey) {
        this._openSwitcher();
        return;
      }
      this._pickWorkspace(el.dataset.workspaceId, event.shiftKey);
    },

    /**
     * The strip's keys: ← and → move along it and go to the Workspace they
     * land on, wrapping at either end, as ↑ and ↓ do down the column. Home
     * and End go to the first and the last. Enter and Space open the full
     * list ({@link _openSwitcher}). The context-menu key and Shift+F10 open
     * the focused Workspace's menu.
     *
     * @param {KeyboardEvent} event `keydown` in the tablist.
     */
    _onStripKeyDown(event) {
      const el = event.target.closest?.(".sval-strip-item");
      if (!el) {
        return;
      }
      if (
        this._modules.SvalPanelModel.keyCommand(event, {}) === "contextMenu"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this._openWorkspaceMenu(null, el.dataset.workspaceId, el, true);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const items = Array.from(
        this._els.strip.querySelectorAll(".sval-strip-item")
      );
      const at = items.indexOf(el);
      const rtl = window.getComputedStyle(el).direction === "rtl";
      const column = this._els.strip.dataset.layout === "column";
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
            this._openStripAppMenu(el);
          } else {
            this._openSwitcher();
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
      this._pickWorkspace(id, false).then(() =>
        this._els.strip
          .querySelector(
            `.sval-strip-item[data-workspace-id="${CSS.escape(id)}"]`
          )
          ?.focus()
      );
    },

    /**
     * Opens the list of an agent app's Workspaces under its item, the one a
     * session used last first, as the switcher's menu lists them
     * ({@link _appendAgentApps}). Picking one goes to it, and with Shift
     * opens it in a new window.
     *
     * @param {Element} el An agent app's strip item.
     */
    _openStripAppMenu(el) {
      const label = el.dataset.agentApp;
      const items = this._switcherList().filter(item => item.agent === label);
      if (items.length < 2) {
        return;
      }
      this._stripAppMenu?.hidePopup();
      document.getElementById("sval-strip-app-menu")?.remove();
      const menu = document.createXULElement("menupopup");
      // Grows from the app's tile as the Favorites menu does from its button
      // (`SvalHeader`'s attached popups, `sval-header.css`).
      menu.id = "sval-strip-app-menu";
      menu.setAttribute("nonnative", "");
      menu.setAttribute("consumeoutsideclicks", "true");
      menu.classList.add("toolbar-menupopup", "sval-agent-app-popup");
      menu.dataset.agentApp = label;
      this._appendAgentAppEntries(menu, items, item => {
        const entry = document.createXULElement("menuitem");
        entry.dataset.workspaceId = item.id;
        this._labelAgentEntry(entry, item);
        if (item.current) {
          entry.setAttribute("aria-current", "true");
        }
        return entry;
      });
      menu.addEventListener("command", event => {
        const id = event.target.dataset?.workspaceId;
        if (id) {
          this._pickWorkspace(id, event.shiftKey);
        }
      });
      menu.addEventListener("popuphidden", event => {
        if (event.target !== menu) {
          return;
        }
        el.setAttribute("aria-expanded", "false");
        menu.remove();
        if (this._stripAppMenu === menu) {
          this._stripAppMenu = null;
          if (!this._els.strip.querySelector(".sval-strip-view:hover")) {
            this._releaseStrip();
          }
        }
      });
      document.getElementById("mainPopupSet").append(menu);
      this._stripAppMenu = menu;
      this._holdStrip();
      el.setAttribute("aria-expanded", "true");
      // The list's stem is traced from where the tile stands as it opens, so
      // it opens once the strip's slide has come to rest.
      const row = el.closest(".sval-strip-row");
      Promise.allSettled(row.getAnimations().map(a => a.finished)).then(() => {
        if (this._stripAppMenu === menu) {
          menu.openPopup(el.querySelector(".sval-strip-face"), "after_start");
        }
      });
    },

    /**
     * A right-click on an item opens that Workspace's menu, with the names
     * controls under it.
     *
     * @param {MouseEvent} event
     */
    _onStripContextMenu(event) {
      const el = event.target.closest?.(".sval-strip-item");
      event.preventDefault();
      event.stopPropagation();
      if (el) {
        this._openWorkspaceMenu(event, el.dataset.workspaceId, el, true);
      }
    },

    /**
     * The wheel over the strip. With "Slides the strip" it moves the strip
     * along its track without switching, while the strip overflows; a strip
     * that fits leaves the wheel to the panel's swipe
     * ({@link _onPanelWheel}). With "Switches Workspaces" it moves the
     * window one Workspace for each turn of the wheel
     * ({@link _stepStripByWheel}), and stops at either end.
     *
     * @param {WheelEvent} event
     */
    _onStripWheel(event) {
      const { STRIP_WHEEL_PREF } = this._modules.SvalPanelModel;
      const switches =
        Services.prefs.getStringPref(STRIP_WHEEL_PREF, "slide") === "switch";
      const overflows = this._els.strip.hasAttribute("data-overflow");
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
        this._stepStripByWheel(event, delta);
        return;
      }
      // A notched wheel's turn is one event in lines or pages
      // (`_stepStripByWheel`), and how many lines the system makes of it,
      // multiplied on Windows and GTK by
      // `mousewheel.system_scroll_override`, says nothing of the strip.
      // Each turn slides it about one Workspace.
      this._slideStrip(
        event.deltaMode === event.DOM_DELTA_PIXEL
          ? delta
          : Math.sign(delta) * this._strip.pitch
      );
    },

    /**
     * Adds `delta` to the slide, kept within its reach
     * ({@link SvalPanelModel.stripSlideReach}), so a wheel turned past an end
     * has nothing to unwind.
     *
     * @param {number} delta
     */
    _slideStrip(delta) {
      const geometry = this._strip.geometry;
      // An agent app's list grows from its tile, which stays where the list
      // was traced from while it is open.
      if (!geometry || this._stripAppMenu) {
        return;
      }
      const { min, max } =
        this._modules.SvalPanelModel.stripSlideReach(geometry);
      this._strip.offset = Math.max(
        min,
        Math.min(max, this._strip.offset - delta)
      );
      this._strip.sliding = true;
      this._placeStrip();
    },

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
    _stepStripByWheel(event, delta) {
      if (event.deltaMode !== event.DOM_DELTA_PIXEL) {
        this._strip.gesture = null;
        this._stepStrip(Math.sign(delta));
        return;
      }
      const { gesture, step } = this._modules.SvalPanelModel.wheelTurn(
        this._strip.gesture,
        {
          at: event.timeStamp,
          delta,
          momentum: event.isMomentum,
          start: event.isGestureStart,
        },
        { restMs: this._wheelRestMs, stepPx: this._wheelGesturePx }
      );
      this._strip.gesture = gesture;
      this._stepStrip(step);
    },

    /**
     * Moves the window `step` places along the strip, from the Workspace the
     * wheel last moved to while the window has yet to show it, stopping at
     * the ends. The strip glides there as the window switches.
     *
     * @param {number} step 1 or -1.
     */
    _stepStrip(step) {
      if (!step) {
        return;
      }
      const now = Date.now();
      const ids = Array.from(
        this._els.strip.querySelectorAll(".sval-strip-item"),
        el => el.dataset.workspaceId
      );
      const from =
        this._strip.pending && now - this._strip.pendingAt < 1000
          ? this._strip.pending
          : this._currentWorkspaceId;
      const at = ids.indexOf(from);
      const next = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
      if (at === -1 || next === from) {
        return;
      }
      this._strip.pending = next;
      this._strip.pendingAt = now;
      this._pickWorkspace(next, false);
    },

    /**
     * A drag held within {@link DRAG_EDGE_PX} of either end of the strip's
     * track slides the strip that way, so a Workspace can be dropped past
     * the items in view. Gecko sends `dragover` again while the pointer
     * rests, so a held drag goes on sliding.
     *
     * @param {DragEvent} event `dragover` on the switcher's menu or the
     *   strip.
     */
    _scrollStripForDrag(event) {
      const strip = this._els.strip;
      if (!this._stripShown() || !strip.contains(event.currentTarget)) {
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
        this._slideStrip(-DRAG_SCROLL_PX);
      } else if (end - at < DRAG_EDGE_PX) {
        this._slideStrip(DRAG_SCROLL_PX);
      }
    },

    /** The pointer is over the strip: a slide stays where the wheel left it. */
    _holdStrip() {
      window.clearTimeout(this._strip.slideBack);
      this._strip.slideBack = null;
      this._els.strip.removeAttribute("data-returning");
    },

    /**
     * The pointer has left the strip: after {@link SLIDE_BACK_MS} the strip
     * slides back to the current Workspace. An agent app's list keeps it
     * where it is while open, since the pointer leaves the strip for the
     * list and the app's item stays under it.
     */
    _releaseStrip() {
      this._holdStrip();
      if (this._stripAppMenu) {
        return;
      }
      if (!this._strip.offset && !this._strip.sliding) {
        return;
      }
      this._strip.slideBack = window.setTimeout(() => {
        this._strip.slideBack = null;
        this._strip.offset = 0;
        this._strip.sliding = false;
        this._els.strip.setAttribute("data-returning", "true");
        this._placeStrip();
      }, SLIDE_BACK_MS);
    },
  });
}
