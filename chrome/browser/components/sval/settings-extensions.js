/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings' Extensions category (decision 1479): the installed extensions,
 * each with its on/off switch, and an extension's page at
 * `about:preferences#svalExtensions-extension?id=<id>`, which holds what
 * about:addons' detail view changes. It also lists extensions' shortcuts in
 * the Keyboard shortcuts category.
 *
 * Every change goes through the add-on manager as about:addons makes it
 * (`addon-card.mjs`, `addon-details.mjs`, `addon-permissions-list.mjs`), and
 * the page redraws from the add-on manager's and `ExtensionPermissions`'
 * notifications, so it shows what about:addons shows.
 *
 * An extension's page follows the site page's address handling
 * (`settings-site-page.js`): `gotoPref` hands `extension?id=…` to the
 * category, then rewrites the hash, so the page writes its address back,
 * and follows `hashchange` for the browser's Back.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
    Extension: "resource://gre/modules/Extension.sys.mjs",
    ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
    ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
    SvalAddonsNav: "moz-src:///browser/components/sval/SvalAddonsNav.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalScope: "moz-src:///browser/components/sval/SvalScope.sys.mjs",
    SvalUpdateDelay:
      "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs",
    SvalExtensionSites:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    SITE_BRANCH:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    siteOfEntry: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  });
  const { DEFAULT_WAIT_DAYS, MAX_WAIT_DAYS, WAIT_PREF } =
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs"
    );

  const CATEGORY = "svalExtensions";
  const SUBCATEGORY = "extension?";
  const KEYBOARD_PANE = "paneSvalKeyboard";

  /** about:addons' `PRIVATE_BROWSING_PERMS` (`addon-card.mjs`). */
  const PRIVATE_BROWSING = {
    permissions: ["internal:privateBrowsingAllowed"],
    origins: [],
  };

  /** about:addons' icon for an extension without one (`addon-card.mjs`). */
  const GENERIC_ICON = "chrome://mozapps/skin/extensions/extensionGeneric.svg";

  /**
   * The commands Firefox names for an extension that gives them no
   * description, with about:addons' words for them (`addon-shortcuts.mjs`).
   */
  const BUILT_IN_COMMANDS = new Map([
    ["_execute_action", "shortcuts-browserAction2"],
    ["_execute_browser_action", "shortcuts-browserAction2"],
    ["_execute_page_action", "shortcuts-pageAction"],
    ["_execute_sidebar_action", "shortcuts-sidebarAction"],
  ]);

  /**
   * @param {string} id
   * @returns {string} The subcategory that shows the extension's page.
   */
  const subcategoryOf = id => `${SUBCATEGORY}${new URLSearchParams({ id })}`;

  /**
   * @param {string} hash An address's hash, with its `#`.
   * @returns {boolean} Whether it is an extension page's.
   */
  const isPageHash = hash => hash.startsWith(`#${CATEGORY}-${SUBCATEGORY}`);

  /**
   * @param {object} addon
   * @param {number} perm One of `AddonManager.PERM_CAN_…`.
   * @returns {boolean}
   */
  const can = (addon, perm) => !!(addon.permissions & perm);

  /**
   * What the category lists: about:addons' list view's filter for its
   * extension sections (`aboutaddons.mjs`), which leaves out hidden add-ons
   * and those about to be uninstalled.
   *
   * @param {object} addon
   * @returns {boolean}
   */
  const listed = addon =>
    !addon.hidden &&
    !(addon.pendingOperations & lazy.AddonManager.PENDING_UNINSTALL);

  /**
   * A command's shortcut as about:addons writes it (`getShortcutValue` in
   * `addon-shortcuts.mjs`).
   *
   * @param {string} shortcut As the manifest writes it, `Ctrl+Shift+Y`.
   * @returns {string}
   */
  function shortcutText(shortcut) {
    const modifiers = shortcut.split("+");
    const key = modifiers.pop();
    if (!modifiers.length) {
      return key;
    }
    return (
      lazy.ShortcutUtils.getModifierString(
        lazy.ShortcutUtils.getModifiersAttribute(modifiers)
      ) + key
    );
  }

  const SvalExtensionsSettings = {
    /** The extension whose page shows, or null. */
    _shown: null,

    /** The address before `showExtension`, while `gotoPref` runs. */
    _from: null,

    /** Bumped by each draw, so an older one that finishes later is dropped. */
    _drawn: 0,

    /** Whether the Keyboard shortcuts category has shown. */
    _keysShown: false,

    get _ui() {
      return window.SvalSettings;
    },

    /** The group of Firefox's settings for sites that install extensions. */
    INSTALL_GROUP_ID: "svalExtensionInstall",

    /**
     * Registers the group that asks before a site installs an extension:
     * Firefox's own `warnAddonInstall` and `addonExceptions` settings from
     * `config/permissions-data.mjs`. Firefox's Site permissions category holds
     * them, and Sval's nav leaves it out (decision 1484).
     */
    registerInstall() {
      const { SettingGroupManager } = window;
      SettingGroupManager.registerGroups({
        [this.INSTALL_GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: { label: "Installing from websites" },
          items: [
            {
              id: "warnAddonInstall",
              l10nId: "permissions-addon-install-warning3",
              items: [
                {
                  id: "addonExceptions",
                  l10nId: "permissions-addon-exceptions2",
                  control: "moz-box-button",
                },
              ],
            },
          ],
        },
      });
    },

    /** The group that sets how long extension updates wait. */
    UPDATES_GROUP_ID: "svalExtensionUpdates",

    /** Registers the update wait (SvalUpdateDelay). */
    registerUpdates() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting("svalExtensionUpdateWait")) {
        return;
      }
      Preferences.addAll([{ id: WAIT_PREF, type: "int" }]);
      Preferences.addSetting({
        id: "svalExtensionUpdateWait",
        pref: WAIT_PREF,
        get: days => String(days),
        // A field the user cleared or filled with something that is not a
        // count of days falls back to the default.
        set: value => {
          const days = Math.round(Number(value));
          return value !== "" && Number.isFinite(days) && days >= 0
            ? Math.min(days, MAX_WAIT_DAYS)
            : DEFAULT_WAIT_DAYS;
        },
      });
      SettingGroupManager.registerGroups({
        [this.UPDATES_GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Extension updates",
            searchkeywords: "extension update wait delay days",
          },
          items: [
            {
              id: "svalExtensionUpdateWait",
              control: "moz-input-number",
              controlAttrs: {
                label: "Days to wait before installing extension updates",
                description:
                  "An extension can change hands or start doing harm through an update. Waiting gives Mozilla time to find a harmful update and turn it off before it reaches you. Set 0 to install updates right away.",
              },
            },
          ],
        },
      });
    },

    /**
     * Installs the update a background check holds for `addon`
     * (`SvalUpdateDelay.updateNow`), then redraws. The waiting row says
     * when it failed.
     *
     * @param {object} addon
     * @returns {Promise<void>}
     */
    async updateNow(addon) {
      const outcome = await lazy.SvalUpdateDelay.updateNow(addon);
      if (outcome === "failed") {
        this._updateFailed.add(addon.id);
      } else {
        this._updateFailed.delete(addon.id);
      }
      this.draw();
    },

    /** Extensions whose last Update now failed, by id. */
    _updateFailed: new Set(),

    /** Once the panes' markup is in place. */
    init() {
      const byId = id => document.getElementById(id);
      this._els = {
        pane: byId("sval-extensions").closest("[data-sval-pane]"),
        list: byId("sval-extensions-list"),
        empty: byId("sval-extensions-empty"),
        message: byId("sval-extensions-message"),
        page: byId("sval-extension-page"),
        back: byId("sval-extension-back"),
        crumb: byId("sval-extension-crumb"),
        icon: byId("sval-extension-icon"),
        title: byId("sval-extension-title"),
        description: byId("sval-extension-description"),
        cards: byId("sval-extension-cards"),
        status: byId("sval-extension-status"),
        dialog: byId("sval-extension-dialog"),
        dialogTitle: byId("sval-extension-dialog-title"),
        dialogBody: byId("sval-extension-dialog-body"),
        dialogCancel: byId("sval-extension-dialog-cancel"),
        dialogConfirm: byId("sval-extension-dialog-confirm"),
        keys: byId("sval-keys-extensions"),
        keysList: byId("sval-keys-extensions-list"),
      };
      document.l10n.addResourceIds(["toolkit/about/aboutAddons.ftl"]);

      byId("sval-extensions-install").addEventListener("click", () =>
        this.installFromFile()
      );
      byId("sval-extensions-full").addEventListener("click", () =>
        lazy.SvalAddonsNav.openInTab(window, "addons://list/extension")
      );
      byId("sval-keys-extensions-change").addEventListener("click", () =>
        lazy.SvalAddonsNav.openInTab(window, "addons://shortcuts/shortcuts")
      );

      this._els.back.addEventListener("click", () => this._backToList());
      this._els.crumb.addEventListener("click", event => {
        event.preventDefault();
        this._backToList();
      });
      this._els.dialogCancel.addEventListener("click", () =>
        this._els.dialog.close()
      );
      this._els.dialogConfirm.addEventListener("click", () =>
        this._confirmRemove().catch(err =>
          lazy.SvalLog.warn(
            `an extension was not removed: ${lazy.SvalLog.errorName(err)}`
          )
        )
      );
      // A click on the dialog itself is a click on the dimmed page around it.
      this._els.dialog.addEventListener("click", event => {
        if (event.target === this._els.dialog) {
          this._els.dialog.close();
        }
      });

      window.addEventListener("hashchange", event => {
        if (this._shown && !isPageHash(new URL(event.newURL).hash)) {
          this._showList(this._leavePage());
        }
      });
      document.addEventListener("paneshown", event => {
        if (
          event.detail.category !==
            window.SvalSettingsHelpers.paneName(CATEGORY) ||
          !event.detail.subcategory?.startsWith(SUBCATEGORY)
        ) {
          this._leavePage();
        }
        if (event.detail.category === KEYBOARD_PANE) {
          this._keysShown = true;
          this.draw();
        }
      });
      // The category's button pressed while a page shows asks for the
      // category already current, which `gotoPref` ignores.
      byId(`category-${CATEGORY}`)?.addEventListener("change-view", () => {
        if (this._shown) {
          this._showList(this._leavePage());
        }
      });

      const redraw = () => this.draw();
      const listener = {
        onEnabled: redraw,
        onDisabled: redraw,
        onInstalled: redraw,
        onUninstalled: redraw,
        onUninstalling: redraw,
        onOperationCancelled: redraw,
        onPropertyChanged: redraw,
      };
      const permissions = type => {
        if (type === "change-permissions") {
          redraw();
        }
      };
      const lifetime = new lazy.SvalScope();
      lazy.AddonManager.addAddonListener(listener);
      lifetime.add(() => lazy.AddonManager.removeAddonListener(listener));
      lazy.ExtensionPermissions.addListener(permissions);
      lifetime.add(() => lazy.ExtensionPermissions.removeListener(permissions));
      lifetime.pref(lazy.SITE_BRANCH, redraw);
      window.addEventListener("pagehide", () => lifetime.end());

      if (
        document.querySelector(`.sval-pane[data-category="${KEYBOARD_PANE}"]`)
          ?.hidden === false
      ) {
        this._keysShown = true;
      }
      this.draw();
    },

    /** The extensions the category lists, by name. */
    async _extensions() {
      const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
      return addons.filter(listed).sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Redraws the list, the page that shows, and the shortcuts. */
    draw() {
      this._draw().catch(err =>
        lazy.SvalLog.warn(
          `the extensions did not load: ${lazy.SvalLog.errorName(err)}`
        )
      );
    },

    async _draw() {
      const ticket = ++this._drawn;
      const extensions = await this._extensions();
      const shown = this._shown
        ? (extensions.find(addon => addon.id === this._shown) ?? null)
        : null;
      const cards = shown ? await this._pageCards(shown) : null;
      const keys = this._keysShown
        ? await this._shortcutCards(extensions)
        : null;
      if (ticket !== this._drawn) {
        return;
      }
      const { _ui: ui, _els: els } = this;
      els.empty.hidden = !!extensions.length;
      ui._keepFocus(els.list, () =>
        els.list.replaceChildren(...extensions.map(addon => this._row(addon)))
      );
      if (this._shown && !shown) {
        // Removed from elsewhere while its page showed.
        this._showList(this._leavePage());
      } else if (shown) {
        this._drawHead(shown);
        ui._keepFocus(els.cards, () => els.cards.replaceChildren(...cards));
      }
      if (keys) {
        els.keys.hidden = !keys.length;
        els.keysList.replaceChildren(...keys);
      }
    },

    /**
     * @param {object} addon
     * @param {number} size In CSS pixels.
     * @returns {Element} The extension's icon, or the generic one.
     */
    _icon(addon, size) {
      return this._ui._el("img", {
        src:
          lazy.AddonManager.getPreferredIconURL(addon, size, window) ||
          GENERIC_ICON,
        alt: "",
      });
    },

    /**
     * The extension's on/off switch, which follows the add-on's state.
     *
     * @param {object} addon
     * @param {string} key The switch's `data-sval-key`.
     * @param {string} [label] Its accessible name, when no label names it.
     * @returns {HTMLInputElement}
     */
    _enabledSwitch(addon, key, label) {
      const { AddonManager } = lazy;
      const input = this._ui._el("input", {
        type: "checkbox",
        className: "sval-switch",
        role: "switch",
        checked: !addon.userDisabled,
        disabled: !can(
          addon,
          addon.userDisabled
            ? AddonManager.PERM_CAN_ENABLE
            : AddonManager.PERM_CAN_DISABLE
        ),
        dataset: { svalKey: key },
        ...(label ? { ariaLabel: label } : {}),
      });
      input.addEventListener("change", () => {
        // The switch shows the add-on's state until it changes.
        input.checked = !addon.userDisabled;
        this.setEnabled(addon, addon.userDisabled).catch(err =>
          lazy.SvalLog.warn(
            `an extension was not switched: ${lazy.SvalLog.errorName(err)}`
          )
        );
      });
      return input;
    },

    /**
     * @param {object} addon
     * @returns {Element} The extension's row in the list.
     */
    _row(addon) {
      const ui = this._ui;
      const link = ui._el(
        "a",
        {
          className: "sval-sites-link sval-extension-link",
          href: `#${CATEGORY}-${subcategoryOf(addon.id)}`,
          dataset: { svalKey: `extension:${addon.id}` },
        },
        ui._el("span", { className: "sval-agent-site" }, addon.name)
      );
      link.addEventListener("click", event => {
        event.preventDefault();
        this.showExtension(addon.id);
      });
      const row = ui._el(
        "div",
        {
          className: "sval-agent sval-extension",
          dataset: { extensionId: addon.id },
        },
        ui._el(
          "div",
          { className: "sval-agent-head" },
          ui._el(
            "span",
            { className: "sval-agent-tile sval-extension-tile" },
            this._icon(addon, 18)
          ),
          ui._el(
            "span",
            { className: "sval-agent-words" },
            link,
            ...(addon.description
              ? [
                  ui._el(
                    "span",
                    { className: "sval-agents-note sval-extension-line" },
                    addon.description
                  ),
                ]
              : [])
          ),
          this._enabledSwitch(addon, `enabled:${addon.id}`, addon.name)
        )
      );
      // The row opens the page, apart from its switch.
      row.addEventListener("click", event => {
        if (!event.target.closest("input, a")) {
          this.showExtension(addon.id);
        }
      });
      return row;
    },

    /**
     * Turns an extension on or off as about:addons' switch does: an
     * extension installed by another program asks for its permissions first
     * (`showPermissionsPrompt` in `aboutaddons-utils.mjs`).
     *
     * @param {object} addon
     * @param {boolean} on
     */
    async setEnabled(addon, on) {
      if (!on) {
        await addon.disable();
        return;
      }
      const perms = addon.installPermissions;
      if (
        addon.isWebExtension &&
        !addon.seen &&
        (perms?.origins.length || perms?.permissions.length)
      ) {
        Services.obs.notifyObservers(
          {
            wrappedJSObject: {
              target: window.docShell.chromeEventHandler,
              info: {
                type: "sideload",
                addon,
                icon: addon.iconURL,
                permissions: perms,
                resolve() {
                  addon.markAsSeen();
                  addon.enable();
                },
                reject() {},
              },
            },
          },
          "webextension-permission-prompt"
        );
        return;
      }
      await addon.enable();
    },

    /**
     * Lets an extension run in private windows or stops it, as about:addons
     * does: the permission changes, then a running extension reloads to take
     * it up (`addon-card.mjs`).
     *
     * @param {object} addon
     * @param {boolean} allowed
     */
    async setPrivateBrowsing(addon, allowed) {
      const extension = WebExtensionPolicy.getByID(addon.id)?.extension;
      await lazy.ExtensionPermissions[allowed ? "add" : "remove"](
        addon.id,
        PRIVATE_BROWSING,
        extension
      );
      if (addon.isActive) {
        await addon.reload();
      }
      this.draw();
    },

    /**
     * Grants or revokes one of an extension's optional permissions, as
     * about:addons' `setAddonPermission` does.
     *
     * @param {object} addon
     * @param {string} permission
     * @param {"permission"|"origin"|"data_collection"} type
     * @param {boolean} granted
     */
    async setOptionalPermission(addon, permission, type, granted) {
      const perms = { origins: [], permissions: [] };
      if (type === "origin") {
        perms.origins = [permission];
      } else if (type === "data_collection") {
        perms.data_collection = [permission];
      } else {
        perms.permissions = [permission];
      }
      const normalized = lazy.ExtensionPermissions.normalizeOptional(
        perms,
        addon.optionalPermissions
      );
      const extension = WebExtensionPolicy.getByID(addon.id)?.extension;
      await lazy.ExtensionPermissions[granted ? "add" : "remove"](
        addon.id,
        normalized,
        extension
      );
    },

    /**
     * Opens the extension's options in a tab, where about:addons opens an
     * options page of the tab kind (`openOptionsInTab`).
     *
     * @param {object} addon
     */
    openOptions(addon) {
      window.browsingContext.topChromeWindow.switchToTabHavingURI(
        addon.optionsURL,
        true,
        {
          relatedToCurrent: true,
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        }
      );
    },

    /**
     * Installs extensions from files the user picks, as about:addons'
     * "Install Add-on From File" does (`installAddonsFromFilePicker`): the
     * add-on manager asks for each one's permissions.
     */
    installFromFile() {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker
      );
      picker.init(
        window.browsingContext,
        "Install an extension from a file",
        Ci.nsIFilePicker.modeOpenMultiple
      );
      picker.appendFilter("Extensions", "*.xpi;*.jar;*.zip");
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      picker.open(async result => {
        if (result !== Ci.nsIFilePicker.returnOK) {
          return;
        }
        for (const file of picker.files) {
          try {
            const install = await lazy.AddonManager.getInstallForFile(
              file,
              null,
              { source: "sval-settings", method: "install-from-file" }
            );
            lazy.AddonManager.installAddonFromAOMWithOptions(
              window.docShell.chromeEventHandler,
              document.documentURIObject,
              install,
              {}
            );
          } catch (err) {
            lazy.SvalLog.warn(
              `an extension file did not open: ${lazy.SvalLog.errorName(err)}`
            );
          }
        }
      });
    },

    /**
     * Shows an extension's page from inside Settings, as a new history
     * entry.
     *
     * @param {string} id
     */
    showExtension(id) {
      if (this._shown === id) {
        return;
      }
      const from = location.href;
      this._from = from;
      window.gotoPref(`${CATEGORY}-${subcategoryOf(id)}`).finally(() => {
        if (this._from === from) {
          this._from = null;
        }
      });
    },

    /**
     * Opens the page `gotoPref` was asked for, after it rewrote the hash.
     * Any other subcategory, or an extension the category doesn't list,
     * shows the list.
     *
     * @param {string} subcategory `extension?id=…`.
     */
    showSubcategory(subcategory) {
      this._open(subcategory).catch(err =>
        lazy.SvalLog.warn(
          `an extension's page did not open: ${lazy.SvalLog.errorName(err)}`
        )
      );
    },

    async _open(subcategory) {
      const from = this._from;
      this._from = null;
      const id = subcategory.startsWith(SUBCATEGORY)
        ? new URLSearchParams(subcategory.slice(SUBCATEGORY.length)).get("id")
        : null;
      const addon = id && (await lazy.AddonManager.getAddonByID(id));
      if (!addon || addon.type !== "extension" || !listed(addon)) {
        this._showList(this._leavePage());
        return;
      }
      const hash = `#${CATEGORY}-${subcategoryOf(id)}`;
      if (location.hash !== hash) {
        // `gotoPref` leaves the address alone when the category is already
        // showing; then the page is a step of its own for Back.
        if (from !== null && from === location.href) {
          history.pushState(
            { ...history.state, svalExtensionPage: true },
            "",
            hash
          );
        } else {
          history.replaceState(history.state, "", hash);
        }
      }
      this._shown = id;
      const els = this._els;
      els.page.hidden = false;
      els.pane.dataset.sitePage = "";
      document.querySelector("title").removeAttribute("data-l10n-id");
      document.title = `${addon.name} · Settings`;
      this._drawHead(addon);
      els.cards.replaceChildren(...(await this._pageCards(addon)));
      els.title.focus({ preventScroll: true });
      els.page.scrollIntoView({ block: "start" });
    },

    /**
     * Hides the page, if it shows, and gives the category its list back.
     *
     * @returns {?string} The extension the page showed.
     */
    _leavePage() {
      const els = this._els;
      const id = this._shown;
      if (!els || !id) {
        return null;
      }
      this._shown = null;
      els.page.hidden = true;
      delete els.pane.dataset.sitePage;
      if (els.dialog.open) {
        els.dialog.close();
      }
      if (isPageHash(location.hash)) {
        history.replaceState(history.state, "", `#${CATEGORY}`);
      }
      document.l10n.setAttributes(
        document.querySelector("title"),
        "settings-page-title"
      );
      return id;
    },

    /**
     * Back, from the button or the breadcrumb: to the entry before when the
     * page made one, whose `hashchange` leaves the page; otherwise straight
     * to the list.
     */
    _backToList() {
      if (history.state?.svalExtensionPage) {
        history.back();
        return;
      }
      this._showList(this._leavePage());
    },

    /**
     * The list, with focus on the extension's link when it still lists it.
     *
     * @param {?string} id The extension the page showed.
     */
    _showList(id) {
      const els = this._els;
      (
        (id &&
          els.list.querySelector(
            `[data-extension-id="${CSS.escape(id)}"] .sval-extension-link`
          )) ||
        els.pane.querySelector(".sval-pane-title")
      )?.focus();
    },

    /** @param {object} addon */
    _drawHead(addon) {
      const els = this._els;
      this._ui._setText(els.title, addon.name);
      this._ui._setText(els.description, addon.description ?? "");
      els.description.hidden = !addon.description;
      const src =
        lazy.AddonManager.getPreferredIconURL(addon, 22, window) ||
        GENERIC_ICON;
      if (els.icon.firstChild?.getAttribute("src") !== src) {
        els.icon.replaceChildren(this._icon(addon, 22));
      }
    },

    /**
     * @param {object} addon
     * @returns {Promise<Element[]>} The page's cards, top to bottom.
     */
    async _pageCards(addon) {
      return [
        await this._generalCard(addon),
        await this._permissionsCard(addon),
        this._sitesCard(addon),
        this._removeCard(addon),
      ].filter(Boolean);
    },

    /**
     * @param {string} key The card's name.
     * @param {string} title
     * @param {...Element} rows
     * @returns {Element}
     */
    _card(key, title, ...rows) {
      const ui = this._ui;
      const id = `sval-extension-${key}-title`;
      return ui._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: id,
          dataset: { extensionCard: key },
        },
        ui._el(
          "div",
          { className: "sval-site-card-head" },
          ui._el("h2", { className: "sval-site-card-title", id }, title)
        ),
        ...rows
      );
    },

    /**
     * On or off, private windows, and options.
     *
     * @param {object} addon
     * @returns {Promise<Element>}
     */
    async _generalCard(addon) {
      const ui = this._ui;
      const rows = [];
      const enabled = this._enabledSwitch(addon, "page-enabled");
      rows.push(
        ui._sitePageRow(
          "extension-enabled",
          this._label(enabled, "On"),
          addon.version ? `Version ${addon.version}` : "",
          enabled
        )
      );

      const { AddonManager } = lazy;
      if (addon.incognito === "not_allowed") {
        rows.push(
          ui._sitePageRow(
            "extension-private",
            "Run in private windows",
            "This extension can't run in private windows",
            ui._sitePageValue("extension-private", "Never")
          )
        );
      } else if (
        !can(addon, AddonManager.PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS)
      ) {
        rows.push(
          ui._sitePageRow(
            "extension-private",
            "Run in private windows",
            "Required, so it can't be changed",
            ui._sitePageValue("extension-private", "Always")
          )
        );
      } else {
        const perms = await lazy.ExtensionPermissions.get(addon.id);
        const allowed = perms.permissions.includes(
          PRIVATE_BROWSING.permissions[0]
        );
        const input = ui._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: allowed,
          dataset: { svalKey: "page-private" },
        });
        input.addEventListener("change", () =>
          this.setPrivateBrowsing(addon, input.checked).catch(err =>
            lazy.SvalLog.warn(
              `an extension's private windows access was not changed: ${lazy.SvalLog.errorName(err)}`
            )
          )
        );
        rows.push(
          ui._sitePageRow(
            "extension-private",
            this._label(input, "Run in private windows"),
            "It can see what you do in private windows",
            input
          )
        );
      }

      const waiting = lazy.SvalUpdateDelay.waiting(addon.id);
      if (waiting) {
        const button = ui._el(
          "button",
          {
            type: "button",
            className: "sval-button",
            dataset: { svalKey: "page-update-now" },
          },
          "Update now"
        );
        button.addEventListener("click", () =>
          this.updateNow(addon).catch(err =>
            lazy.SvalLog.warn(
              `an extension update did not install: ${lazy.SvalLog.errorName(err)}`
            )
          )
        );
        const on = new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
        }).format(waiting.installsOn);
        const failed = this._updateFailed.has(addon.id);
        const row = ui._sitePageRow(
          "extension-update-waiting",
          "Update waiting",
          failed
            ? "Sval couldn't install the update. Try again later."
            : `Version ${waiting.version} installs on ${on}`,
          button
        );
        if (failed) {
          row.dataset.state = "failed";
        }
        rows.push(row);
      }

      if (addon.optionsURL && addon.isActive) {
        const button = ui._el(
          "button",
          {
            type: "button",
            className: "sval-button",
            dataset: { svalKey: "page-options" },
          },
          "Options"
        );
        button.addEventListener("click", () => this.openOptions(addon));
        rows.push(
          ui._sitePageRow(
            "extension-options",
            "Its own settings",
            "Open in a new tab",
            button
          )
        );
      }
      return this._card("general", "Extension", ...rows);
    },

    /**
     * A label that names `control`, for a row whose words are its label.
     *
     * @param {HTMLInputElement} control
     * @param {string} text
     * @returns {HTMLLabelElement}
     */
    _label(control, text) {
      control.id = `sval-extension-${control.dataset.svalKey}`;
      return this._ui._el(
        "label",
        { className: "sval-site-row-label", htmlFor: control.id },
        text
      );
    },

    /**
     * What the extension may do, in Mozilla's words for its install prompt
     * (`Extension.formatPermissionStrings`, as about:addons' permissions
     * list calls it), and a switch for each optional permission.
     *
     * @param {object} addon
     * @returns {Promise<Element>}
     */
    async _permissionsCard(addon) {
      const ui = this._ui;
      const empty = { origins: [], permissions: [], data_collection: [] };
      const required = { ...(addon.userPermissions ?? empty) };
      const optional = { ...(addon.optionalPermissions ?? empty) };
      const granted = await lazy.ExtensionPermissions.get(addon.id);
      optional.origins = [
        ...new Set([
          ...(addon.optionalOriginsNormalized ?? []),
          ...granted.origins.filter(o => !required.origins.includes(o)),
        ]),
      ];
      const words = lazy.Extension.formatPermissionStrings(
        { permissions: required, optionalPermissions: optional },
        { buildOptionalOrigins: true }
      );

      const lines = [...words.msgs];
      const collection = words.dataCollectionPermissions;
      if (collection?.msg && !collection.hasNone) {
        lines.push(collection.msg);
      }
      const rows = [];
      if (lines.length) {
        rows.push(
          ui._el(
            "ul",
            { className: "sval-extension-permissions" },
            ...lines.map(line => ui._el("li", {}, line))
          )
        );
      }

      const allSitesGranted = granted.origins.some(origin =>
        lazy.Extension.isAllSitesPermission(origin)
      );
      const optionalEntries = [
        ...Object.entries(words.optionalPermissions).map(e => [
          ...e,
          "permission",
        ]),
        ...Object.entries(words.optionalOrigins).map(e => [...e, "origin"]),
        ...Object.entries(words.optionalDataCollectionPermissions ?? {}).map(
          e => [...e, "data_collection"]
        ),
      ];
      optionalEntries.forEach(([perm, text, type], i) => {
        const input = ui._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: lazy.Extension.isAllSitesPermission(perm)
            ? allSitesGranted
            : granted.permissions.includes(perm) ||
              granted.origins.includes(perm) ||
              !!granted.data_collection?.includes(perm),
          dataset: { svalKey: `page-optional-${i}` },
        });
        input.addEventListener("change", () =>
          this.setOptionalPermission(addon, perm, type, input.checked).catch(
            err =>
              lazy.SvalLog.warn(
                `an extension's permission was not changed: ${lazy.SvalLog.errorName(err)}`
              )
          )
        );
        rows.push(
          ui._sitePageRow(
            `extension-optional-${i}`,
            this._label(input, text),
            "Optional",
            input
          )
        );
      });

      if (!rows.length) {
        rows.push(
          ui._el(
            "p",
            { className: "sval-agents-note" },
            "It asks for no permissions"
          )
        );
      }
      return this._card("permissions", "Permissions", ...rows);
    },

    /**
     * The sites the extension is off on, each with its switch, and a field
     * that turns it off on one more (`SvalExtensionSites`). A switch is saved
     * and synced, so a private window lists the sites alone.
     *
     * @param {object} addon
     * @returns {Element}
     */
    _sitesCard(addon) {
      const ui = this._ui;
      if (ui._privateWindow) {
        const sites = lazy.SvalExtensionSites.sitesOff(addon.id);
        return this._card(
          "sites",
          "Sites where this extension is off",
          ...sites.map((site, i) => {
            const row = ui._sitePageRow(
              `extension-site-${i}`,
              site,
              "",
              ui._sitePageValue(`extension-site-${i}`, "Off", "off")
            );
            row.dataset.extensionSite = site;
            return row;
          }),
          ui._el(
            "p",
            { className: "sval-agents-note" },
            "A private window can't change these."
          )
        );
      }
      const switchOff = (site, off) =>
        lazy.SvalExtensionSites.setOff(addon.id, site, off)
          .then(() => lazy.SvalExtensionSites.reloadSite(site))
          .catch(err =>
            lazy.SvalLog.warn(
              `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
            )
          );
      const rows = lazy.SvalExtensionSites.sitesOff(addon.id).map((site, i) => {
        const input = ui._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: false,
          dataset: { svalKey: `sites-${i}` },
        });
        input.addEventListener("change", () => switchOff(site, !input.checked));
        const row = ui._sitePageRow(
          `extension-site-${i}`,
          this._label(input, site),
          "",
          input
        );
        row.dataset.extensionSite = site;
        return row;
      });
      const entry = ui._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        placeholder: "example.com",
        spellcheck: false,
        dataset: { svalKey: "sites-entry" },
      });
      const add = ui._el(
        "button",
        {
          type: "button",
          className: "sval-button",
          dataset: { svalKey: "sites-add" },
        },
        "Turn off"
      );
      const turnOff = () => {
        const { site } = lazy.siteOfEntry(entry.value);
        entry.toggleAttribute("aria-invalid", !site);
        if (site) {
          switchOff(site, true);
        }
      };
      add.addEventListener("click", turnOff);
      entry.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          turnOff();
        }
      });
      const controls = ui._el(
        "div",
        { className: "sval-site-entry" },
        entry,
        add
      );
      rows.push(
        ui._sitePageRow(
          "extension-sites-entry",
          this._label(entry, "Turn it off on a site"),
          "",
          controls
        )
      );
      return this._card("sites", "Sites where this extension is off", ...rows);
    },

    /**
     * @param {object} addon
     * @returns {?Element} The card that removes the extension, when it can
     *   be removed.
     */
    _removeCard(addon) {
      if (!can(addon, lazy.AddonManager.PERM_CAN_UNINSTALL)) {
        return null;
      }
      const ui = this._ui;
      const button = ui._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-danger",
          dataset: { svalKey: "page-remove" },
        },
        "Remove"
      );
      button.addEventListener("click", () => this.askToRemove(addon));
      return this._card(
        "remove",
        "Remove",
        ui._sitePageRow(
          "extension-remove",
          "Remove from Sval",
          "Deletes the extension and its data",
          button
        )
      );
    },

    /**
     * Asks, in the modal dialog, whether to remove `addon`. Cancel has the
     * focus.
     *
     * @param {object} addon
     */
    askToRemove(addon) {
      const els = this._els;
      this._removing = addon;
      els.dialogTitle.textContent = `Remove ${addon.name}?`;
      els.dialogBody.textContent = `Sval deletes ${addon.name} and its data from this device.`;
      els.dialog.showModal();
      els.dialogCancel.focus();
    },

    /** Removes the extension the dialog asked about, at once. */
    async _confirmRemove() {
      const addon = this._removing;
      this._removing = null;
      this._els.dialog.close();
      if (!addon) {
        return;
      }
      await addon.uninstall();
      this._els.message.textContent = `Removed ${addon.name}.`;
      if (this._shown === addon.id) {
        this._backToList();
      }
    },

    /**
     * One card per extension that has commands, as the Keyboard shortcuts
     * category draws Firefox's groups, read-only: about:addons changes them.
     *
     * @param {object[]} extensions
     * @returns {Promise<Element[]>}
     */
    async _shortcutCards(extensions) {
      const ui = this._ui;
      const cards = [];
      for (const addon of extensions) {
        const shortcuts = WebExtensionPolicy.getByID(addon.id)?.extension
          ?.shortcuts;
        if (!shortcuts) {
          continue;
        }
        const commands = await shortcuts.allCommands();
        if (!commands.length) {
          continue;
        }
        const ids = commands.map(c =>
          c.description ? null : BUILT_IN_COMMANDS.get(c.name)
        );
        const wanted = ids.filter(Boolean);
        const values = wanted.length
          ? await document.l10n.formatValues(wanted)
          : [];
        const word = new Map(wanted.map((id, i) => [id, values[i]]));
        const headingId = `sval-keys-extension-${cards.length}`;
        cards.push(
          ui._el(
            "section",
            {
              className: "sval-card sval-keys-group",
              ariaLabelledby: headingId,
              dataset: { extensionId: addon.id },
            },
            ui._el("h2", { id: headingId }, addon.name),
            ui._el(
              "table",
              { className: "sval-keys-table", ariaLabelledby: headingId },
              ui._el(
                "tbody",
                {},
                ...commands.map((command, i) =>
                  ui._el(
                    "tr",
                    {
                      className: `sval-keys-row${command.shortcut ? "" : " sval-keys-unassigned"}`,
                    },
                    ui._el(
                      "th",
                      { scope: "row" },
                      word.get(ids[i]) || command.description || command.name
                    ),
                    ui._el(
                      "td",
                      { className: "sval-keys-shortcut" },
                      command.shortcut ? shortcutText(command.shortcut) : "None"
                    ),
                    ui._el("td", { className: "sval-keys-actions" })
                  )
                )
              )
            )
          )
        );
      }
      return cards;
    },
  };

  window.SvalExtensionsSettings = SvalExtensionsSettings;
}
