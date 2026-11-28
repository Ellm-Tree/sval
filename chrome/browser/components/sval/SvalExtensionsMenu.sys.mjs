/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The toolbar's extensions menu (Firefox's unified extensions panel) as Sval
 * shows it. Firefox lists an extension with a toolbar button only while the
 * button sits in the menu (`gUnifiedExtensions.onPanelViewShowing`), so a
 * pinned extension leaves the menu and its controls; Sval lists it there too,
 * as a row of the menu's list (extensions-menu-lists-pinned.patch).
 */

import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OriginControls: "resource://gre/modules/ExtensionPermissions.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalExtensionSites:
    "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
  SvalExtensionWorkspaces:
    "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  MENU_ID_ATTR: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  scopeOf: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  ScopeDropdown: "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs",
  keepsLine: "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs",
  scopeChoices: "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs",
  scopePhrase: "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs",
});

/** The boxes of a "Show in" submenu (`fillShowIn`). */
const SHOW_IN_BOXES = '[data-sval-menu-id^="showIn:"]';

/**
 * @param {Window} win
 * @returns {?{site: string, host: string, choice: boolean}} The scopes of
 *   the selected tab (`scopeOf`), or null where a switch has no place: a
 *   page with no site, or a private window, whose switches would keep a
 *   record of private browsing.
 */
function scopeOfSelectedTab(win) {
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return null;
  }
  return lazy.scopeOf(win.gBrowser.selectedBrowser.currentURI.spec);
}

/**
 * window -> the site its open menu's switches were moved to, picked in the
 * menu's "Run on" dropdown. The menu opens at the host each time.
 */
const pickedSites = new WeakMap();

/**
 * Draws the menu's "Run on" line in `view` on a host with a choice of
 * scope (host-scoped rules spec §4), with the line naming the switches the
 * host keeps at the site's scope.
 *
 * @param {Window} win
 * @param {Element} view The menu's panelview.
 * @param {{site: string, host: string}} scope
 * @param {string} at The scope the switches are saved at.
 * @param {string[]} kept The names of the extensions the host keeps a
 *   switch of its own for.
 */
function drawScopeLine(win, view, scope, at, kept) {
  const doc = win.document;
  const list = view.querySelector(".unified-extensions-list");
  if (!list) {
    return;
  }
  const panel = view.closest("panel");
  if (panel && !panel.svalScopeReset) {
    panel.svalScopeReset = true;
    panel.addEventListener("popuphidden", event => {
      if (event.target === panel) {
        pickedSites.delete(win);
      }
    });
  }
  const html = "http://www.w3.org/1999/xhtml";
  const lead = doc.createElementNS(html, "span");
  lead.className = "sval-ext-scope-lead";
  lead.textContent = "Run on";
  const dropdown = new lazy.ScopeDropdown(doc, {
    id: "sval-ext-scope",
    choices: lazy.scopeChoices(scope),
    current: at,
    look: "pill",
    inline: true,
    labelledBy: [lead],
    onPick: name => {
      if (name === scope.site) {
        pickedSites.set(win, name);
      } else {
        pickedSites.delete(win);
      }
      SvalExtensionsMenu.addSwitches(win, view);
      doc.getElementById("sval-ext-scope-button")?.focus();
    },
  }).listen();
  const line = doc.createElementNS(html, "div");
  line.className = "sval-ext-scope";
  line.append(lead, dropdown.root);
  const keeps = at === scope.site ? lazy.keepsLine(scope.host, kept) : null;
  const box = doc.createElementNS(html, "div");
  box.className = "sval-ext-scope-box";
  box.append(line);
  if (keeps) {
    const note = doc.createElementNS(html, "span");
    note.className = "sval-scope-keeps";
    note.id = "sval-ext-keeps";
    note.textContent = keeps;
    box.append(note);
  }
  list.before(box);
}

/**
 * @param {Element} row A row of the menu.
 * @returns {?string} The id of its extension.
 */
function idOf(row) {
  return (
    row.getAttribute("extension-id") ??
    row.querySelector("[data-extensionid]")?.dataset.extensionid ??
    null
  );
}

/** What an extension can do on a site, in the order a row's message names them. */
const CAPABILITIES = ["pages", "requests", "block", "cookies", "navigation"];

/**
 * @param {string} key A key of `CAPABILITIES`.
 * @param {string} site
 * @returns {string} The phrase a row's message names it by.
 */
function phraseOf(key, site) {
  switch (key) {
    case "pages":
      return `read and change pages on ${site}`;
    case "requests":
      return `see every connection that pages on ${site} make`;
    case "block":
      return `see and block every connection that pages on ${site} make`;
    case "cookies":
      return `read and change cookies from ${site}`;
    default:
      return `see which pages on ${site} you open`;
  }
}

/**
 * What `policy`'s extension can do on the site of `uri`, from what it
 * declares. Its pages, requests and cookies need the site in its host
 * access (`canAccessURI`), or for its pages a content script matching the
 * site; its navigation events need none (`ext-webNavigation.js`).
 *
 * @param {WebExtensionPolicy} policy
 * @param {nsIURI} uri
 * @returns {string[]} Keys of `CAPABILITIES`.
 */
function capabilitiesOn(policy, uri) {
  const host = policy.canAccessURI(uri);
  const has = name => policy.permissions.includes(name);
  const can = new Set();
  if (host || policy.contentScripts.some(cs => cs.matchesURI(uri))) {
    can.add("pages");
  }
  if (host && has("webRequest")) {
    can.add(has("webRequestBlocking") ? "block" : "requests");
  }
  if (host && has("cookies")) {
    can.add("cookies");
  }
  if (has("webNavigation")) {
    can.add("navigation");
  }
  return CAPABILITIES.filter(key => can.has(key));
}

/**
 * @param {string[]} keys Keys of `CAPABILITIES`.
 * @param {string} site
 * @returns {string} The sentence a row's message shows for them.
 */
function sentenceOf(keys, site) {
  if (!keys.length) {
    return `Can't see or change anything on ${site}`;
  }
  const phrases = keys.map(key => phraseOf(key, site));
  const last = phrases.pop();
  const list = phrases.length
    ? `${phrases.join(", ")}${phrases.length > 1 ? "," : ""} and ${last}`
    : last;
  return `Can ${list}`;
}

/**
 * Shows in `row` what its extension can do on the site, in a message of
 * Sval's own under the extension's name, in place of Firefox's, which
 * `sval-header.css` hides. Firefox rewrites its message whenever the
 * extension's button changes (`updateButton`, ext-browserAction.js), and
 * never touches this one. `data-sval-can` names the capabilities shown.
 *
 * @param {Element} row
 * @param {string[]} keys Keys of `CAPABILITIES`; none while it is off.
 * @param {string} site
 */
function showCapabilities(row, keys, site) {
  const contents = row.querySelector(".unified-extensions-item-contents");
  if (!contents) {
    return;
  }
  let message = contents.querySelector(":scope > .sval-site-message");
  if (!message) {
    message = row.ownerDocument.createXULElement("label");
    message.className = "unified-extensions-item-message sval-site-message";
    contents.append(message);
  }
  message.textContent = sentenceOf(keys, site);
  message.dataset.svalCan = keys.join(" ");
}

/**
 * Gives `row` the site menu's pin button (`SvalSiteControls.pinButton`),
 * before its menu button, for an extension with a toolbar button: pressed
 * while the button is on the toolbar. A click pins or unpins it as the row's
 * menu does (`gUnifiedExtensions.onPinToToolbarChange`) and lists the menu
 * again.
 *
 * @param {Window} win
 * @param {Element} list The menu's `.unified-extensions-list`.
 * @param {Element} row
 */
function addPin(win, list, row) {
  const widgetId = row.dataset.widgetId || row.id;
  const placement = widgetId && CustomizableUI.getPlacementOfWidget(widgetId);
  const menuButton = row.querySelector(".unified-extensions-item-menu-button");
  const id = idOf(row);
  if (!placement || !menuButton || !id) {
    return;
  }
  const scopes = lazy.SvalExtensionWorkspaces;
  const ws = scopes.workspaceOfWindow(win);
  const onToolbar = placement.area !== CustomizableUI.AREA_ADDONS;
  // A button on the toolbar of other Workspaces alone reads as unpinned in
  // this window, and pinning it here adds this Workspace (spec §2.4).
  const pinned = onToolbar && scopes.pinShowsIn(id, ws);
  const doc = win.document;
  const title = pinned ? "Unpin from the toolbar" : "Pin to the toolbar";
  const pin = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  pin.type = "button";
  pin.className = "sval-extension-pin";
  pin.title = title;
  pin.setAttribute("aria-label", title);
  pin.setAttribute("aria-pressed", String(pinned));
  const glyph = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  glyph.className = "sval-extension-pin-glyph";
  pin.append(glyph);
  pin.addEventListener("click", () => {
    const { gUnifiedExtensions } = win;
    if (onToolbar && !pinned) {
      scopes.setPinScope(id, [...(scopes.pinScope(id) ?? []), ws]);
    } else {
      if (!pinned) {
        gUnifiedExtensions._maybeMoveWidgetNodeBack(widgetId);
      }
      gUnifiedExtensions.pinToToolbar(widgetId, !pinned);
    }
    const view = list.closest("panelview") ?? list;
    SvalExtensionsMenu.listPinned(win, list);
    SvalExtensionsMenu.addSwitches(win, view);
    SvalExtensionsMenu.addPageActions(win, view);
  });
  menuButton.before(pin);
}

/**
 * Fills the "Show in" submenu of a pinned extension's context menu (spec
 * §2.2): Select all, Deselect all, and a checkbox per Workspace the
 * extension is available in, ticked where its button shows. The items leave
 * the menu open while the user ticks.
 *
 * Each box is `showIn:` and its Workspace's id, the id its data.
 *
 * @param {Element} popup The submenu's `menupopup`.
 * @param {string} id The extension's id.
 */
function fillShowIn(popup, id) {
  const scopes = lazy.SvalExtensionWorkspaces;
  const offered = scopes
    .offered()
    .filter(each => scopes.isAvailableIn(id, each.id));
  const scope = scopes.pinScope(id);
  lazy.SvalMenu.fill(popup, [
    { id: "showInAll", label: "Select all", closemenu: "none" },
    { id: "showInNone", label: "Deselect all", closemenu: "none" },
    "separator",
    ...offered.map(({ id: ws, name, emoji }) => ({
      id: `showIn:${ws}`,
      label: emoji ? `${emoji} ${name}` : name,
      type: "checkbox",
      autocheck: false,
      closemenu: "none",
      checked: !scope || scope.includes(ws),
      data: ws,
    })),
  ]);
}

/**
 * Writes what a "Show in" submenu holds: every Workspace ticked is every
 * Workspace, none ticked drops the change, as a pin's does
 * (`SvalPinsModel.scopeFor`).
 *
 * @param {Element} popup
 * @param {string} id
 */
function applyShowIn(popup, id) {
  const boxes = [...popup.querySelectorAll(SHOW_IN_BOXES)];
  const ticked = boxes
    .filter(box => box.getAttribute("checked") === "true")
    .map(box => lazy.SvalMenu.dataOf(box));
  if (!ticked.length) {
    return;
  }
  lazy.SvalExtensionWorkspaces.setPinScope(
    id,
    ticked.length === boxes.length ? null : ticked
  );
}

/**
 * Shows `row` off, or on again: an extension off for the selected tab's page
 * shows greyed, and its row's button does nothing. A pinned extension's row
 * is Sval's own (`listPinned`), so its button is disabled here; a row
 * Firefox draws takes its state from the browser action
 * (`updateButton`, extension-off-shows-off.patch).
 *
 * @param {Element} row
 * @param {boolean} off
 */
function markOff(row, off) {
  row.toggleAttribute("data-sval-site-off", off);
  if (row.dataset.widgetId) {
    const action = row.querySelector(".unified-extensions-item-action-button");
    if (action) {
      action.disabled = off;
    }
  }
}

export const SvalExtensionsMenu = {
  /**
   * Gives an extension's context menu, its row's in the extensions menu or
   * its toolbar button's, a "Show in" submenu after `after` while the
   * extension is pinned (spec §2.2), and hides it otherwise.
   *
   * @param {Element} menu The context menu's `menupopup`.
   * @param {?string} id The extension's id, if the menu is an extension's.
   * @param {?string} widgetId Its toolbar button's widget id.
   * @param {?Element} after The menu's Pin to Toolbar item.
   */
  updateShowIn(menu, id, widgetId, after) {
    const doc = menu.ownerDocument;
    let showIn = menu.querySelector(":scope > .sval-extension-show-in");
    if (!showIn && after) {
      showIn = doc.createXULElement("menu");
      showIn.className = "sval-extension-show-in";
      showIn.setAttribute("label", "Pin to Toolbar in");
      const popup = doc.createXULElement("menupopup");
      popup.addEventListener("popupshowing", event => {
        if (event.target === popup) {
          fillShowIn(popup, showIn.dataset.extensionId);
        }
      });
      popup.addEventListener("command", event => {
        const item = event.target;
        const command = item.getAttribute(lazy.MENU_ID_ATTR) ?? "";
        if (command.startsWith("showIn:")) {
          if (item.getAttribute("checked") === "true") {
            item.removeAttribute("checked");
          } else {
            item.setAttribute("checked", "true");
          }
        } else if (command === "showInAll" || command === "showInNone") {
          for (const box of popup.querySelectorAll(SHOW_IN_BOXES)) {
            if (command === "showInAll") {
              box.setAttribute("checked", "true");
            } else {
              box.removeAttribute("checked");
            }
          }
        }
        // Each pick is written as it is made: macOS draws the menu natively
        // and may fire an item's command after the menu has hidden.
        applyShowIn(popup, showIn.dataset.extensionId);
      });
      showIn.append(popup);
      after.after(showIn);
    }
    if (!showIn) {
      return;
    }
    const area =
      widgetId && CustomizableUI.getPlacementOfWidget(widgetId)?.area;
    const pinned = !!area && area !== CustomizableUI.AREA_ADDONS;
    const offered = id
      ? lazy.SvalExtensionWorkspaces.offered().filter(each =>
          lazy.SvalExtensionWorkspaces.isAvailableIn(id, each.id)
        )
      : [];
    // One Workspace leaves nothing to choose.
    showIn.hidden = !id || !pinned || offered.length < 2;
    if (id) {
      showIn.dataset.extensionId = id;
    }
  },

  /**
   * Lists the open menu's extensions again after a pin or an unpin moved a
   * button out of the menu's list or into it, as the row's own Pin to
   * Toolbar does (`gUnifiedExtensions.onPinToToolbarChange`).
   *
   * @param {Window} win A browser window.
   */
  redrawOpen(win) {
    const { gUnifiedExtensions } = win;
    const list = win.document.querySelector(
      "#unified-extensions-view .unified-extensions-list"
    );
    if (list && gUnifiedExtensions._panel?.state === "open") {
      this.listPinned(win, list);
      this.addSwitches(win, gUnifiedExtensions._panel);
      this.addPageActions(win, gUnifiedExtensions._panel);
    }
  },

  /**
   * Gives `list` a row for each extension of `win` whose toolbar button is
   * outside the menu, among the rows already there by name. A row names its
   * button in `data-widget-id`, which the row's menu pins and unpins by.
   * Rows from an earlier call go first, so a call after a pin or an unpin
   * leaves the list as a fresh one would be. Clicking a row opens its
   * extension as its toolbar button does. Every row of the menu gets a pin
   * button (`addPin`).
   *
   * @param {Window} win A browser window.
   * @param {Element} list The menu's `.unified-extensions-list`.
   */
  listPinned(win, list) {
    for (const row of list.querySelectorAll(":scope > [data-widget-id]")) {
      row.remove();
    }
    const { gUnifiedExtensions } = win;
    const view = list.closest("panelview") ?? list;
    for (const pin of view.querySelectorAll(".sval-extension-pin")) {
      pin.remove();
    }
    for (const policy of gUnifiedExtensions.getActivePolicies()) {
      const widgetId = gUnifiedExtensions.browserActionFor(policy)?.widget?.id;
      const area =
        widgetId && CustomizableUI.getPlacementOfWidget(widgetId)?.area;
      if (!area || area === CustomizableUI.AREA_ADDONS) {
        continue;
      }
      const row = win.document.createElement("unified-extensions-item");
      row.setExtension(policy.extension);
      row.dataset.widgetId = widgetId;
      const before = [...list.children].find(
        other =>
          other.extension &&
          other.extension.name.localeCompare(policy.extension.name) > 0
      );
      list.insertBefore(row, before ?? null);
      // Firefox's row disables its button where a click would do nothing
      // (`#hasAction`, browser-unified-extensions.js). A pinned extension's
      // row does what its toolbar button does, through the browser action's
      // own `triggerAction`, once the menu has closed.
      const action = row.querySelector(
        ".unified-extensions-item-action-button"
      );
      action.disabled = false;
      action.addEventListener("command", event => {
        event.stopPropagation();
        if (
          lazy.SvalExtensionSites.blockedInTab(
            policy.id,
            win.gBrowser.selectedBrowser
          )
        ) {
          return;
        }
        const panel = action.closest("panel");
        const trigger = () =>
          gUnifiedExtensions.browserActionFor(policy)?.triggerAction(win);
        if (panel?.state === "open") {
          panel.addEventListener("popuphidden", trigger, { once: true });
          win.PanelMultiView.hidePopup(panel);
        } else {
          trigger();
        }
      });
    }
    for (const row of view.querySelectorAll(".unified-extensions-item")) {
      addPin(win, list, row);
    }
  },

  /**
   * Gives each row of the menu in `view` a labelled switch for the selected
   * tab's host, or its site once picked in the menu's "Run on" line, on a
   * line of its own under the extension's name and
   * message, for an extension that can reach the site
   * (`OriginControls.getState`). Turning it hands the change to every
   * process, then reloads the site's tabs, whose pages hold what the
   * extension put there. A row of an extension that is off carries
   * `data-sval-site-off`.
   *
   * @param {Window} win A browser window.
   * @param {Element} view The menu's panelview.
   */
  addSwitches(win, view) {
    const scope = scopeOfSelectedTab(win);
    const at =
      scope && pickedSites.get(win) === scope.site ? scope.site : scope?.host;
    const site = scope && lazy.scopePhrase(scope, at);
    const tab = win.gBrowser.selectedTab;
    view.querySelector(".sval-ext-scope-box")?.remove();
    const kept = [];
    let switches = 0;
    for (const row of view.querySelectorAll(".unified-extensions-item")) {
      row.querySelector(":scope > .sval-site-line")?.remove();
      row.querySelector(".sval-site-message")?.remove();
      row.removeAttribute("data-sval-site-off");
      const id = idOf(row);
      const policy = id && WebExtensionPolicy.getByID(id);
      if (
        !site ||
        !policy ||
        lazy.OriginControls.getState(policy, tab).noAccess
      ) {
        continue;
      }
      const off = lazy.SvalExtensionSites.isOff(id, at);
      if (lazy.SvalExtensionSites.ruleFor(id, scope.host)) {
        kept.push(policy.name);
      }
      switches++;
      markOff(row, off);
      const can = capabilitiesOn(
        policy,
        win.gBrowser.selectedBrowser.currentURI
      );
      showCapabilities(row, off ? [] : can, site);
      const toggle = win.document.createElement("moz-toggle");
      toggle.className = "sval-site-switch";
      toggle.pressed = !off;
      toggle.label = `Run on ${site}`;
      toggle.setAttribute("title", `Run ${policy.name} on ${site}`);
      toggle.addEventListener("toggle", () => {
        markOff(row, !toggle.pressed);
        showCapabilities(row, toggle.pressed ? can : [], site);
        lazy.SvalExtensionSites.setOff(id, at, !toggle.pressed)
          .then(() => lazy.SvalExtensionSites.reloadSite(at))
          .catch(err =>
            lazy.SvalLog.warn(
              `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
            )
          );
      });
      const line = win.document.createElement("div");
      line.className = "sval-site-line";
      line.append(toggle);
      const wrapper = row.querySelector(
        ":scope > .unified-extensions-item-row-wrapper"
      );
      if (wrapper) {
        wrapper.after(line);
      } else {
        row.append(line);
      }
    }
    if (scope?.choice && switches) {
      drawScopeLine(win, view, scope, at, kept);
    }
  },

  /**
   * Gives each row of the menu in `view` its extension's page action for the
   * selected tab, while the action shows there (`sval-page-actions.js`): a
   * button with the action's icon and title before the row's pin. A click
   * closes the menu, then runs the action as Firefox's address field button
   * did, and an action with a popup opens it on the extensions button.
   *
   * @param {Window} win A browser window.
   * @param {Element} view The menu's panelview.
   */
  addPageActions(win, view) {
    const doc = win.document;
    const shown = win.BrowserPageActions.shownExtensionActions();
    for (const row of view.querySelectorAll(".unified-extensions-item")) {
      row.querySelector(".sval-page-action")?.remove();
      const id = idOf(row);
      const action = id && shown.find(each => each.extensionID === id);
      const before =
        row.querySelector(".sval-extension-pin") ??
        row.querySelector(".unified-extensions-item-menu-button");
      if (!action || !before) {
        continue;
      }
      const title = action.getTitle(win);
      const button = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      button.type = "button";
      button.className = "sval-page-action";
      button.title = title;
      button.setAttribute("aria-label", title);
      const glyph = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      glyph.className = "sval-page-action-glyph";
      for (const [prop, value] of Object.entries(
        action.getIconProperties(win)
      )) {
        glyph.style.setProperty(prop, value);
      }
      button.append(glyph);
      button.addEventListener("click", event => {
        const panel = button.closest("panel");
        const run = () =>
          win.BrowserPageActions.doCommandForAction(action, event, button);
        if (panel?.state === "open") {
          panel.addEventListener("popuphidden", run, { once: true });
          win.PanelMultiView.hidePopup(panel);
        } else {
          run();
        }
      });
      before.before(button);
    }
  },
};
