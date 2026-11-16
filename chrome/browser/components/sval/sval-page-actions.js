/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// browser.js defines both as lazy getters on the window.
/* globals PageActions, PanelMultiView */

/**
 * A window's page actions (`PageActions.sys.mjs`), in place of Firefox's
 * `browser-pageActions.js`, which Sval's `jar.mn` overrides with this file.
 * Firefox draws a page action as a button in the address field and lists it
 * in its own panel. Sval draws an extension's page action on the extension's
 * row of the extensions menu (`SvalExtensionsMenu.addPageActions`) and marks
 * the extensions button with `sval-page-action` while one shows for the
 * selected tab.
 *
 * `PageActions` calls the methods below by name in every window, and
 * `ext-pageAction.js` opens an extension's popup through
 * `togglePanelForAction`. An action shows for the selected tab while it is
 * not disabled there: `ext-pageAction.js` disables an extension's action on
 * each tab its `show_matches` and `pageAction.show` leave it off.
 */
var BrowserPageActions = {
  /** Marks the extensions button once the window has loaded. */
  init() {
    this.placeAllActionsInUrlbar();
  },

  placeAllActionsInUrlbar() {
    this.markButton();
  },

  placeAction() {
    this.markButton();
  },

  placeActionInUrlbar() {
    this.markButton();
  },

  /** @param {object} action A `PageActions.Action`. */
  removeAction(action) {
    action.onRemovedFromWindow(window);
    this.markButton();
  },

  /**
   * @param {object} action A `PageActions.Action`.
   * @param {?string} propertyName The property that changed, or null for all.
   */
  updateAction(action, propertyName = null) {
    if (!propertyName || propertyName == "disabled") {
      this.markButton();
    }
  },

  onLocationChange() {
    for (const action of PageActions.actions) {
      action.onLocationChange(window);
    }
  },

  /**
   * @param {object} action A `PageActions.Action`.
   * @param {Event} event The click on its control, which an extension's
   *   action reads its window and modifiers from (`ext-pageAction.js`).
   * @param {Element} buttonNode The control.
   */
  doCommandForAction(action, event, buttonNode) {
    action.onCommand(event, buttonNode);
  },

  /**
   * Opens `panelNode`, an extension's popup, on the action's anchor, or closes
   * it while it is open.
   *
   * @param {object} action A `PageActions.Action`.
   * @param {Element} panelNode
   * @param {?Event} event
   */
  togglePanelForAction(action, panelNode, event = null) {
    if (panelNode.state != "closed") {
      PanelMultiView.hidePopup(panelNode);
      return;
    }
    PanelMultiView.openPopup(panelNode, this.panelAnchorNodeForAction(action), {
      position: "bottomright topright",
      triggerEvent: event,
    }).catch(console.error);
  },

  /**
   * An extension's action anchors on the extensions button, which lists it.
   * The bookmark action, which Firefox's bookmark editor anchors on
   * (`BookmarkingUI.anchor`), anchors on the favorite button.
   *
   * @param {?object} action A `PageActions.Action`.
   * @returns {Element}
   */
  panelAnchorNodeForAction(action) {
    return document.getElementById(
      action?.extensionID ? "unified-extensions-button" : "sval-favorite-button"
    );
  },

  /** The extension actions that show for the selected tab. */
  shownExtensionActions() {
    return PageActions.actions.filter(
      action => action.extensionID && !action.getDisabled(window)
    );
  },

  markButton() {
    document
      .getElementById("unified-extensions-button")
      ?.toggleAttribute(
        "sval-page-action",
        !!this.shownExtensionActions().length
      );
  },
};
