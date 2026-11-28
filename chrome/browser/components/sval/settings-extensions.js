/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings' Extensions category: the installed extensions,
 * each with its on/off switch, and an extension's page at
 * `about:preferences#svalExtensions-extension?id=<id>`, which holds what
 * about:addons' detail view shows: the extension's own settings page, its
 * shortcuts, its updates and what it is. `&card=<key>` scrolls the page to
 * one card. Every way into about:addons lands here
 * (`SvalAddonsNav.openInSettings`). The Keyboard shortcuts category lists
 * extensions' shortcuts and leads to each extension's card for them.
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
    AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
    Extension: "resource://gre/modules/Extension.sys.mjs",
    ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
    ExtensionShortcutKeyMap:
      "resource://gre/modules/ExtensionShortcuts.sys.mjs",
    ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalScope: "moz-src:///browser/components/sval/SvalScope.sys.mjs",
    SvalUpdateDelay:
      "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs",
    SvalExtensionSites:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    SITE_BRANCH:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    DEFAULT_BRANCH:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    AVAILABLE_BRANCH:
      "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs",
    SvalExtensionWorkspaces:
      "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs",
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
   * @param {string} [card] The card the page scrolls to.
   * @returns {string} The subcategory that shows the extension's page.
   */
  const subcategoryOf = (id, card) =>
    `${SUBCATEGORY}${new URLSearchParams(card ? { id, card } : { id })}`;

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
     * them, and Sval's nav leaves it out.
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
        facts: byId("sval-extension-facts"),
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
      byId("sval-extensions-find").addEventListener("click", () =>
        window.browsingContext.topChromeWindow.openTrustedLinkIn(
          Services.urlFormatter.formatURLPref("extensions.getAddons.link.url"),
          "tab"
        )
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
      lifetime.pref(lazy.DEFAULT_BRANCH, redraw);
      lifetime.pref(lazy.AVAILABLE_BRANCH, redraw);
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
        ui._keepFocus(els.cards, () => this._placeCards(cards));
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
      this._placeCards(await this._pageCards(addon));
      const card = new URLSearchParams(
        subcategory.slice(SUBCATEGORY.length)
      ).get("card");
      const title = card
        ? els.cards.querySelector(
            `[data-extension-card="${CSS.escape(card)}"] .sval-site-card-title`
          )
        : null;
      if (title) {
        // An extension that asks for its settings gets them shown.
        const details = title.closest("details");
        if (details) {
          details.open = true;
        }
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
        title.closest("section").scrollIntoView({ block: "start" });
        return;
      }
      els.title.focus({ preventScroll: true });
      els.page.scrollIntoView({ block: "start" });
    },

    /**
     * Puts the page's cards in place. The card that holds the extension's
     * own settings page stays where it is when the new cards keep it:
     * taking its `<browser>` out of the document would reload the
     * extension's page and lose what the user typed there.
     *
     * @param {Element[]} cards
     */
    _placeCards(cards) {
      const container = this._els.cards;
      const kept = cards.find(card => card.parentNode === container);
      if (!kept) {
        container.replaceChildren(...cards);
        return;
      }
      for (const child of [...container.children]) {
        if (child !== kept) {
          child.remove();
        }
      }
      const at = cards.indexOf(kept);
      kept.before(...cards.slice(0, at));
      kept.after(...cards.slice(at + 1));
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
      this._options = null;
      this._sitesMode = null;
      this._stopEditing(false);
      els.cards.replaceChildren();
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
      this._drawFacts(addon);
    },

    /**
     * @param {object} addon
     * @returns {Promise<Element[]>} The page's cards, top to bottom.
     */
    async _pageCards(addon) {
      return [
        await this._generalCard(addon),
        this._optionsCard(addon),
        await this._permissionsCard(addon),
        this._sitesCard(addon),
        await this._shortcutsCard(addon),
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
          "",
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
            `${addon.name} needs to run in private windows`,
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
            `${addon.name} can see what you do in private windows`,
            input
          )
        );
      }

      const workspaces = this._workspacesRow(addon);
      if (workspaces) {
        rows.push(workspaces);
      }

      const waiting = lazy.SvalUpdateDelay.waiting(addon.id);
      if (waiting) {
        const button = ui._el(
          "sval-button",
          {
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

      if (
        addon.optionsURL &&
        addon.isActive &&
        addon.optionsType !== AddonManager.OPTIONS_TYPE_INLINE_BROWSER
      ) {
        const button = ui._el(
          "sval-button",
          {
            dataset: { svalKey: "page-options" },
          },
          "Open"
        );
        button.addEventListener("click", () => this.openOptions(addon));
        rows.push(
          ui._sitePageRow("extension-options", "Extension Settings", "", button)
        );
      }
      if (can(addon, AddonManager.PERM_CAN_UPGRADE)) {
        rows.push(this._autoUpdateRow(addon));
        if (!waiting) {
          rows.push(this._checkRow(addon));
        }
      }
      return this._card("general", "Extension", ...rows);
    },

    /**
     * Whether a background check installs this extension's updates, as
     * about:addons' Allow automatic updates sets it.
     *
     * @param {object} addon
     * @returns {Element}
     */
    _autoUpdateRow(addon) {
      const ui = this._ui;
      const { AddonManager } = lazy;
      // The default follows `extensions.update.autoUpdateDefault`, which no
      // control in Sval changes, so the switch shows what it means.
      const on =
        addon.applyBackgroundUpdates == AddonManager.AUTOUPDATE_DEFAULT
          ? AddonManager.autoUpdateDefault
          : addon.applyBackgroundUpdates == AddonManager.AUTOUPDATE_ENABLE;
      const input = ui._el("input", {
        type: "checkbox",
        className: "sval-switch",
        role: "switch",
        checked: on,
        disabled: ui._privateWindow,
        dataset: { svalKey: "page-auto-update" },
      });
      input.addEventListener("change", () => {
        addon.applyBackgroundUpdates = input.checked
          ? AddonManager.AUTOUPDATE_ENABLE
          : AddonManager.AUTOUPDATE_DISABLE;
      });
      return ui._sitePageRow(
        "extension-auto-update",
        this._label(input, "Update this extension automatically"),
        "",
        input
      );
    },

    /** The last Check for updates' outcome, by extension id. */
    _checked: new Map(),

    /**
     * Looks for a newer version now and installs one it finds, as
     * about:addons' Check for Updates does when the user asks. A check the
     * user asks for never waits (`SvalUpdateDelay` holds background ones).
     *
     * @param {object} addon
     * @returns {Element}
     */
    _checkRow(addon) {
      const ui = this._ui;
      const button = ui._el(
        "sval-button",
        {
          dataset: { svalKey: "page-check-updates" },
        },
        "Check now"
      );
      const outcome = this._checked.get(addon.id);
      const sub =
        {
          checking: "Checking…",
          installed: `Sval installed version ${addon.version}`,
          none: `Version ${addon.version} is the newest`,
          failed:
            "Sval couldn't check for or install an update. Try again later.",
        }[outcome] ?? "";
      button.disabled = outcome === "checking";
      button.addEventListener("click", () => {
        this._checked.set(addon.id, "checking");
        this.draw();
        lazy.SvalUpdateDelay.updateNow(addon)
          .then(
            result => this._checked.set(addon.id, result),
            err => {
              this._checked.set(addon.id, "failed");
              lazy.SvalLog.warn(
                `an extension update check failed: ${lazy.SvalLog.errorName(err)}`
              );
            }
          )
          .finally(() => this.draw());
      });
      const row = ui._sitePageRow(
        "extension-check-updates",
        "Look for a newer version of this extension",
        sub,
        button
      );
      if (outcome === "failed") {
        row.dataset.state = "failed";
      }
      return row;
    },

    /** The options card on show, with the extension instance it loaded. */
    _options: null,

    /**
     * The extension's own settings page, inside the card as about:addons
     * shows it (`inline-options-browser`), or an Open button for a page
     * the extension asks to open in a tab. The same card returns while the
     * same running extension shows, so a redraw keeps its page.
     *
     * @param {object} addon
     * @returns {?Element}
     */
    _optionsCard(addon) {
      if (
        !addon.optionsURL ||
        !addon.isActive ||
        addon.optionsType !== lazy.AddonManager.OPTIONS_TYPE_INLINE_BROWSER
      ) {
        return null;
      }
      const ui = this._ui;
      const instance = WebExtensionPolicy.getByID(addon.id)?.instanceId;
      if (
        this._options?.id === addon.id &&
        this._options.instance === instance
      ) {
        return this._options.card;
      }
      // Settings' collapsed disclosure (`.sval-advanced`), whose body loads
      // the extension's page the first time it opens.
      const body = ui._el("div", {
        className: "sval-advanced-body sval-extension-options",
      });
      const details = ui._el(
        "details",
        { className: "sval-advanced" },
        ui._el(
          "summary",
          { className: "sval-advanced-summary" },
          ui._el(
            "span",
            {
              className: "sval-advanced-label sval-site-card-title",
              id: "sval-extension-settings-title",
            },
            "Extension Settings"
          ),
          ui._glyph("chevron-down")
        ),
        body
      );
      const card = ui._el(
        "section",
        {
          className: "sval-card sval-site-card sval-extension-options-card",
          ariaLabelledby: "sval-extension-settings-title",
          dataset: { extensionCard: "settings" },
        },
        details
      );
      this._options = { id: addon.id, instance, card };
      if (ui._privateWindow && addon.incognito === "not_allowed") {
        body.append(
          ui._el(
            "p",
            { className: "sval-agents-note" },
            `${addon.name} can't run in private windows, so the extension's settings show only when you open Settings in a window that isn't private.`
          )
        );
        return card;
      }
      details.addEventListener("toggle", () => {
        if (!details.open || body.firstChild) {
          return;
        }
        // about:addons' own element for an extension's options page, which
        // loads the page in the extension's process and sizes itself to it.
        import("chrome://mozapps/content/extensions/components/inline-options-browser.mjs")
          .then(() => {
            const options = document.createElement("inline-options-browser");
            options.setAddon(addon);
            body.append(options);
            return options.render();
          })
          .catch(err =>
            lazy.SvalLog.warn(
              `an extension's settings did not load: ${lazy.SvalLog.errorName(err)}`
            )
          );
      });
      return card;
    },

    /**
     * Who made the extension, its version, when it last changed here and its
     * homepage, from what the add-on manager keeps, under its description.
     *
     * @param {object} addon
     */
    _drawFacts(addon) {
      const ui = this._ui;
      const facts = [];
      const fact = (key, label, value) =>
        facts.push(
          ui._el(
            "div",
            { className: "sval-extension-fact", dataset: { fact: key } },
            ui._el("dt", {}, label),
            ui._el("dd", {}, value)
          )
        );
      if (addon.creator?.name) {
        fact("author", "Author", addon.creator.name);
      }
      if (addon.version) {
        fact("version", "Version", addon.version);
      }
      if (addon.updateDate) {
        fact(
          "updated",
          "Last updated",
          new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
            addon.updateDate
          )
        );
      }
      const homepage = this._webURL(addon.homepageURL);
      if (homepage) {
        const link = ui._el(
          "a",
          {
            className: "sval-link",
            href: homepage,
            dataset: { svalKey: "page-homepage" },
          },
          new URL(homepage).host
        );
        link.addEventListener("click", event => {
          event.preventDefault();
          window.browsingContext.topChromeWindow.openTrustedLinkIn(
            homepage,
            "tab"
          );
        });
        fact("homepage", "Homepage", link);
      }
      this._els.facts.replaceChildren(...facts);
      this._els.facts.hidden = !facts.length;
    },

    /**
     * @param {?string} url As the extension's manifest gives it.
     * @returns {?string} The URL, when it is a web page's.
     */
    _webURL(url) {
      try {
        const parsed = new URL(url);
        return ["http:", "https:"].includes(parsed.protocol) ? url : null;
      } catch {
        return null;
      }
    },

    /**
     * The Workspaces the extension is available in (extension Workspaces
     * spec §1.9), checked in a list. Every one checked is every Workspace,
     * a Workspace made later included.
     *
     * @param {object} addon
     * @returns {?Element} None before any Workspace is known.
     */
    _workspacesRow(addon) {
      const ui = this._ui;
      const scopes = lazy.SvalExtensionWorkspaces;
      const offered = scopes.offered();
      if (!offered.length) {
        return null;
      }
      const ids = offered.map(each => each.id);
      const scope = scopes.availableIn(addon.id) ?? ids;
      // The export dialog's list of Workspaces (`export.js`): a checkbox,
      // the Workspace's emoji and its name on each line.
      const list = ui._el("ul", {
        className: "sval-im-windows",
        ariaLabel: "Run in these Workspaces",
      });
      for (const { id, name, emoji } of offered) {
        const on = scope.includes(id);
        const box = ui._el("input", {
          type: "checkbox",
          checked: on,
          // The last Workspace left can't be unchecked, so the scope never
          // names none.
          disabled: ui._privateWindow || (on && scope.length === 1),
          dataset: { svalKey: `page-workspace-${id}` },
        });
        box.addEventListener("change", () => {
          const next = box.checked
            ? [...scope, id]
            : scope.filter(each => each !== id);
          lazy.SvalExtensionSites.changeAndReload(addon.id, () =>
            scopes.setAvailableIn(
              addon.id,
              next.length === ids.length ? null : next
            )
          ).catch(err =>
            lazy.SvalLog.warn(
              `an extension's Workspaces did not apply: ${lazy.SvalLog.errorName(err)}`
            )
          );
        });
        list.append(
          ui._el(
            "li",
            { className: "sval-im-window" },
            ui._el(
              "label",
              { className: "sval-im-check" },
              box,
              ...(emoji
                ? [ui._el("span", { className: "sval-im-emoji" }, emoji)]
                : []),
              name
            )
          )
        );
      }
      return ui._sitePageRow(
        "extension-workspaces",
        "Run in these Workspaces",
        `${addon.name} can read and change the pages in your tabs only in the Workspaces you check`,
        list
      );
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
     * Where the extension runs, as one choice of three, and under the last
     * two the sites it names, each with its remove button, and a field that
     * adds one (`SvalExtensionSites`; extension Workspaces spec §3.6). Every
     * site and Every site except these share one stored default, so the page
     * keeps the second chosen while its list is empty. A switch is saved and
     * synced, so a private window shows the choice and the sites alone.
     *
     * @param {object} addon
     * @returns {Element}
     */
    _sitesCard(addon) {
      const ui = this._ui;
      const sites = lazy.SvalExtensionSites;
      const offByDefault = sites.offByDefault(addon.id);
      const named = offByDefault
        ? sites.sitesOn(addon.id)
        : sites.sitesOff(addon.id);
      let mode = "only";
      if (!offByDefault) {
        const kept =
          this._sitesMode?.id === addon.id ? this._sitesMode.mode : "every";
        mode = named.length || kept === "except" ? "except" : "every";
      }
      this._sitesMode = { id: addon.id, mode };
      const choices = [
        ["every", "Every site"],
        ["except", "Every site except these"],
        ["only", "Only these sites"],
      ];
      const title = `Sites ${addon.name} runs on`;
      const list = ui._el("div", {
        className: "sval-blocking-list",
        role: "list",
      });
      const listRow = (site, remove) => {
        const row = ui._el(
          "div",
          {
            className: "sval-fp-item sval-blocking-row",
            role: "listitem",
            dataset: { extensionSite: site },
          },
          ui._el(
            "span",
            { className: "sval-fp-words" },
            ui._el("span", { className: "sval-agent-site", title: site }, site)
          )
        );
        if (remove) {
          row.append(remove);
        }
        list.append(row);
      };
      if (ui._privateWindow) {
        named.forEach(site => listRow(site, null));
        return this._card(
          "sites",
          title,
          ui._sitePageValue(
            "extension-sites-mode",
            choices.find(([value]) => value === mode)[1],
            mode
          ),
          ...(mode === "every" ? [] : [list]),
          ui._el(
            "p",
            { className: "sval-agents-note" },
            "You can't change these sites in a private window."
          )
        );
      }
      const warn = err =>
        lazy.SvalLog.warn(
          `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
        );
      const switchOff = (site, off) =>
        sites
          .setOff(addon.id, site, off)
          .then(() => sites.reloadSite(site))
          .catch(warn);
      const choice = ui._sitePageSelect(
        "extension-sites-mode",
        choices,
        mode,
        chosen => {
          this._sitesMode = { id: addon.id, mode: chosen };
          sites
            .changeAndReload(addon.id, async () => {
              await sites.setOffByDefault(addon.id, chosen === "only");
              if (chosen === "every") {
                for (const site of sites.sitesOff(addon.id)) {
                  await sites.setOff(addon.id, site, false);
                }
              }
            })
            .catch(warn)
            .finally(() => this.draw());
        }
      );
      choice.dataset.svalKey = "sites-mode";
      choice.setAttribute("label", title);
      const rows = [choice];
      if (mode !== "every") {
        named.forEach((site, i) => {
          // Settings' remove button for an entry in a list (Allowed sites in
          // `settings-blocking.js`).
          const remove = ui._el(
            "button",
            {
              type: "button",
              className: "sval-agent-remove",
              ariaLabel: `Remove ${site}`,
              title: "Remove",
              dataset: { svalKey: `sites-remove-${i}` },
            },
            ui._glyph("x")
          );
          remove.addEventListener("click", () => switchOff(site, offByDefault));
          listRow(site, remove);
        });
        const entry = ui._el("input", {
          type: "text",
          className: "sval-agent-add-input",
          placeholder: "example.com",
          spellcheck: false,
          ariaLabel:
            mode === "only"
              ? `A site ${addon.name} runs on`
              : `A site ${addon.name} doesn't run on`,
          dataset: { svalKey: "sites-entry" },
        });
        const add = ui._el(
          "sval-button",
          {
            dataset: { svalKey: "sites-add" },
          },
          "Add"
        );
        const addSite = () => {
          const { site } = lazy.siteOfEntry(entry.value);
          entry.toggleAttribute("aria-invalid", !site);
          if (site) {
            switchOff(site, !offByDefault);
          }
        };
        add.addEventListener("click", addSite);
        entry.addEventListener("keydown", event => {
          if (event.key === "Enter") {
            addSite();
          }
        });
        rows.push(
          list,
          ui._el("div", { className: "sval-site-entry" }, entry, add)
        );
      }
      return this._card("sites", title, ...rows);
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
      // The agent page's Unpair card (`settings-agents.js`): a line on what
      // removing does, and a button that names the extension.
      const button = ui._el(
        "sval-button",
        {
          type: "danger",
          dataset: { svalKey: "page-remove" },
        },
        `Remove ${addon.name}`
      );
      button.addEventListener("click", () => this.askToRemove(addon));
      return ui._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabel: "Remove",
          dataset: { extensionCard: "remove" },
        },
        ui._el(
          "p",
          { className: "sval-agents-note" },
          `Removing ${addon.name} deletes the extension and its data from this device.`
        ),
        button
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
     * An extension's commands, each with its name in about:addons' words
     * when the extension gives none (`addon-shortcuts.mjs`).
     *
     * @param {object} addon
     * @returns {Promise<?Array<{name: string, title: string, shortcut: string, default: string}>>}
     *   None when the extension isn't running or has no commands.
     */
    async _commands(addon) {
      const shortcuts = WebExtensionPolicy.getByID(addon.id)?.extension
        ?.shortcuts;
      if (!shortcuts) {
        return null;
      }
      const commands = await shortcuts.allCommands();
      if (!commands.length) {
        return null;
      }
      const ids = commands.map(c =>
        c.description ? null : BUILT_IN_COMMANDS.get(c.name)
      );
      const wanted = ids.filter(Boolean);
      const values = wanted.length
        ? await document.l10n.formatValues(wanted)
        : [];
      const word = new Map(wanted.map((id, i) => [id, values[i]]));
      return commands.map((command, i) => ({
        name: command.name,
        title: word.get(ids[i]) || command.description || command.name,
        shortcut: command.shortcut ?? "",
        default: shortcuts.manifestCommands?.get(command.name)?.shortcut ?? "",
      }));
    },

    /**
     * A table of commands and their shortcuts, as the Keyboard shortcuts
     * category draws Firefox's.
     *
     * @param {string} headingId
     * @param {object[]} commands `_commands`' answer.
     * @param {?object} addon The extension whose shortcuts the table
     *   changes, or null for a table that only shows them.
     * @returns {Element}
     */
    _commandTable(headingId, commands, addon) {
      const ui = this._ui;
      return ui._el(
        "table",
        { className: "sval-keys-table", ariaLabelledby: headingId },
        ui._el(
          "tbody",
          {},
          ...commands.map((command, i) => {
            const id = `${headingId}-${i}`;
            const row = ui._el(
              "tr",
              {
                className: `sval-keys-row${command.shortcut ? "" : " sval-keys-unassigned"}`,
              },
              ui._el("th", { scope: "row", id: `${id}-name` }, command.title),
              ui._el(
                "td",
                { className: "sval-keys-shortcut", id: `${id}-key` },
                command.shortcut ? shortcutText(command.shortcut) : "None"
              ),
              ui._el("td", { className: "sval-keys-actions" })
            );
            if (addon && !ui._privateWindow) {
              this._editableRow(row, id, addon, command);
            }
            return row;
          })
        )
      );
    },

    /**
     * The extension's commands, each with Change, Clear and Reset, as the
     * Keyboard shortcuts category changes Firefox's keys.
     *
     * @param {object} addon
     * @returns {Promise<?Element>}
     */
    async _shortcutsCard(addon) {
      const commands = await this._commands(addon);
      if (!commands) {
        return null;
      }
      const headingId = "sval-extension-shortcuts-title";
      const card = this._card(
        "shortcuts",
        "Keyboard shortcuts for this extension",
        this._commandTable(`${headingId}-rows`, commands, addon)
      );
      return card;
    },

    /** The row whose shortcut is being changed, or null. */
    _editing: null,

    /**
     * Gives `row` its Change, Clear and Reset buttons, and the field that
     * takes a new shortcut.
     *
     * @param {Element} row
     * @param {string} id
     * @param {object} addon
     * @param {object} command One of `_commands`' answers.
     */
    _editableRow(row, id, addon, command) {
      const ui = this._ui;
      const button = (action, label) =>
        ui._el(
          "sval-button",
          {
            dataset: { action },
            ariaDescribedby: `${id}-name ${id}-key`,
          },
          label
        );
      const input = ui._el("input", {
        className: "sval-field sval-keys-new",
        readOnly: true,
        hidden: true,
        ariaLabel: `New shortcut for ${command.title}`,
        placeholder: "Press the new shortcut",
      });
      const change = button("change", "Change");
      const cancel = button("cancel", "Cancel");
      cancel.hidden = true;
      const clear = button("clear", "Clear");
      clear.hidden = !command.shortcut;
      const reset = button("reset", "Reset");
      reset.hidden = command.shortcut === command.default;
      const warn = err =>
        lazy.SvalLog.warn(
          `an extension's shortcut was not changed: ${lazy.SvalLog.errorName(err)}`
        );
      const shortcuts = () =>
        WebExtensionPolicy.getByID(addon.id)?.extension?.shortcuts;
      change.addEventListener("click", () => {
        this._stopEditing(false);
        this._editing = row;
        row.classList.add("sval-keys-editing");
        change.hidden = true;
        cancel.hidden = false;
        input.hidden = false;
        input.value = "";
        input.focus();
      });
      // Pressing Cancel would take the focus from the field, whose focusout
      // ends the change and hides Cancel before its click.
      cancel.addEventListener("mousedown", event => event.preventDefault());
      cancel.addEventListener("click", () => this._stopEditing(true));
      input.addEventListener("focusout", () => this._stopEditing(false));
      input.addEventListener("keydown", event =>
        this._onShortcutKey(event, addon, command).catch(warn)
      );
      clear.addEventListener("click", () =>
        shortcuts()
          ?.updateCommand({ name: command.name, shortcut: "" })
          .then(() => this.draw(), warn)
      );
      reset.addEventListener("click", () =>
        shortcuts()
          ?.resetCommand(command.name)
          .then(() => this.draw(), warn)
      );
      row.dataset.command = command.name;
      row
        .querySelector(".sval-keys-actions")
        .append(
          ui._el(
            "div",
            { className: "sval-keys-buttons" },
            change,
            input,
            cancel,
            clear,
            reset
          )
        );
    },

    /**
     * Ends a change: the field goes and the Change button is back.
     *
     * @param {boolean} focus Whether the Change button takes focus.
     */
    _stopEditing(focus) {
      const row = this._editing;
      if (!row) {
        return;
      }
      this._editing = null;
      row.classList.remove("sval-keys-editing");
      const input = row.querySelector(".sval-keys-new");
      input.hidden = true;
      input.value = "";
      row.querySelector('[data-action="cancel"]').hidden = true;
      const change = row.querySelector('[data-action="change"]');
      change.hidden = false;
      if (focus) {
        change.focus();
      }
    },

    /**
     * A key pressed in a shortcut's field. A valid shortcut no other
     * extension or Sval uses is saved; any other says why in the field, as
     * about:addons' editor checks it (`onShortcutChange`).
     *
     * @param {KeyboardEvent} event
     * @param {object} addon
     * @param {object} command
     */
    async _onShortcutKey(event, addon, command) {
      const input = event.target;
      if (event.key === "Tab") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        this._stopEditing(true);
        return;
      }
      const { ShortcutUtils } = lazy;
      const refuse = text => {
        input.value = text;
        input.select();
      };
      const { getShortcutForEvent } = await import(
        // about:addons' shortcut editor.
        "chrome://mozapps/content/extensions/components/addon-shortcuts.mjs"
      );
      const shortcut = getShortcutForEvent(event);
      if (ShortcutUtils.getSystemActionForEvent(event)) {
        refuse(`Sval uses ${shortcutText(shortcut)}`);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
        // Modifiers alone, `Command+Shift+`, shown as they are held.
        input.value = shortcutText(shortcut);
        return;
      }
      const chrome = window.browsingContext.topChromeWindow;
      switch (ShortcutUtils.validate(shortcut)) {
        case ShortcutUtils.IS_VALID:
          break;
        case ShortcutUtils.MODIFIER_REQUIRED:
          refuse(
            lazy.AppConstants.platform == "macosx"
              ? "Hold ⌘, ⌥, or ⌃ while you press the key"
              : "Hold Ctrl or Alt while you press the key"
          );
          return;
        default:
          refuse("Sval can't use that key in a shortcut");
          return;
      }
      if (ShortcutUtils.isSystem(chrome, shortcut)) {
        refuse(`Sval uses ${shortcutText(shortcut)}`);
        return;
      }
      const taken = new lazy.ExtensionShortcutKeyMap();
      await taken.buildForAddonIds(
        (await this._extensions()).map(each => each.id)
      );
      const users = [...(taken.get(shortcut) ?? [])].filter(
        user =>
          !(user.addonName === addon.name && user.commandName === command.name)
      );
      if (users.length) {
        refuse(`${users[0].addonName} uses ${shortcutText(shortcut)}`);
        return;
      }
      await WebExtensionPolicy.getByID(
        addon.id
      )?.extension?.shortcuts?.updateCommand({ name: command.name, shortcut });
      this._stopEditing(true);
      this.draw();
    },

    /**
     * One card per extension that has commands, as the Keyboard shortcuts
     * category draws Firefox's groups, each with a button to the
     * extension's own card, where they change.
     *
     * @param {object[]} extensions
     * @returns {Promise<Element[]>}
     */
    async _shortcutCards(extensions) {
      const ui = this._ui;
      const cards = [];
      for (const addon of extensions) {
        const commands = await this._commands(addon);
        if (!commands) {
          continue;
        }
        const headingId = `sval-keys-extension-${cards.length}`;
        const change = ui._el(
          "sval-button",
          {
            ariaDescribedby: headingId,
            dataset: { svalKey: `keys-change:${addon.id}` },
          },
          "Change"
        );
        change.addEventListener("click", () =>
          window.gotoPref(`${CATEGORY}-${subcategoryOf(addon.id, "shortcuts")}`)
        );
        cards.push(
          ui._el(
            "section",
            {
              className: "sval-card sval-keys-group",
              ariaLabelledby: headingId,
              dataset: { extensionId: addon.id },
            },
            ui._el(
              "div",
              { className: "sval-keys-group-head" },
              ui._el("h2", { id: headingId }, addon.name),
              change
            ),
            this._commandTable(`${headingId}-rows`, commands, null)
          )
        );
      }
      return cards;
    },
  };

  window.SvalExtensionsSettings = SvalExtensionsSettings;
}
