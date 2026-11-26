/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Extension notices on the extensions button (messages spec §6). Each line
 * of `SvalAppNotices.noticeLines` is a `moz-message-bar` at the top of
 * Firefox's extensions panel, drawn while the panel shows. The button carries
 * a badge while a line exists that the panel has not shown since it arrived;
 * a line stays until one of its buttons answers it.
 *
 * The bars go in `#unified-extensions-messages-container`, where
 * `gUnifiedExtensions.onPanelViewShowing` puts Firefox's own, and are taken
 * out on `ViewHiding`, as Firefox empties the panel's extension list then.
 */

import {
  noticeLines,
  watchNotices,
} from "moz-src:///browser/components/sval/SvalAppNotices.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  // Lazy, because `SvalHeader` imports this module.
  EXTENSIONS_BUTTON_ID: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
});
const VIEW_ID = "unified-extensions-view";
const CONTAINER_ID = "unified-extensions-messages-container";
const BAR_CLASS = "sval-extension-notice";

/**
 * Per window: `seen`, the keys of the lines the panel has shown, `bars`, the
 * drawn bars by key while the panel shows, and `focusOnShow`, whether the
 * panel is opening from a key press.
 */
const states = new WeakMap();

/**
 * The `addon-installed` notifications the panel has been opened for, so each
 * opens it once however many windows see it.
 */
const openedFor = new WeakSet();

/**
 * The windows whose panel is being opened or closed here. `togglePanel`
 * checks whether the panel is open only after an await, so a second call in
 * that time would undo the first.
 */
const opening = new WeakSet();

function stateFor(win) {
  let state = states.get(win);
  if (!state) {
    state = { seen: new Set(), bars: null, focusOnShow: false };
    states.set(win, state);
  }
  return state;
}

/**
 * What a bar draws, compared to decide whether a drawn bar still says its
 * line. A bar drawn again is announced again, since `moz-message-bar` is an
 * alert.
 *
 * @param {object} line
 * @returns {string}
 */
function signature(line) {
  return JSON.stringify([line.text, line.tone, line.actions.map(a => a.label)]);
}

/**
 * One line's bar. Its text and buttons go in the bar's `message` slot, so
 * the buttons sit on a row beneath the text, aligned with it (messages spec
 * §9.6); the bar's `actions` slot would put them beside the text. An action
 * that opens Firefox's permission prompt closes the panel first, because the
 * prompt anchors to the same button.
 *
 * @param {Window} win
 * @param {object} line From `noticeLines`.
 * @returns {Element}
 */
function drawBar(win, line) {
  const doc = win.document;
  const bar = doc.createElement("moz-message-bar");
  bar.className = BAR_CLASS;
  bar.setAttribute("type", line.tone === "warning" ? "warning" : "info");
  bar.dataset.key = line.key;
  bar.dataset.signature = signature(line);
  if (line.addonId) {
    bar.dataset.addonId = line.addonId;
  }
  const body = doc.createElement("div");
  body.className = "sval-extension-notice-body";
  body.setAttribute("slot", "message");
  if (line.text) {
    const text = doc.createElement("span");
    text.className = "sval-extension-notice-text";
    text.textContent = line.text;
    body.append(text);
  }
  const buttons = doc.createElement("div");
  buttons.className = "sval-extension-notice-buttons";
  body.append(buttons);
  bar.append(body);
  for (const action of line.actions) {
    const button = doc.createElement("button");
    button.className = "footer-button small-button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (line.prompts) {
        win.PanelMultiView.hidePopup(win.gUnifiedExtensions.panel);
      }
      action.run();
    });
    buttons.append(button);
  }
  return bar;
}

/**
 * Draws `lines` into the open panel, keeping each bar that still says its
 * line where it is.
 *
 * @param {Window} win
 * @param {object} state
 * @param {object[]} lines
 */
function render(win, state, lines) {
  const container = win.document.getElementById(CONTAINER_ID);
  if (!container) {
    return;
  }
  const bars = new Map();
  for (const line of lines) {
    const drawn = state.bars.get(line.key);
    bars.set(
      line.key,
      drawn?.dataset.signature === signature(line) ? drawn : drawBar(win, line)
    );
  }
  // The container is the record of what is drawn, so a bar `state.bars` has
  // lost, as a ViewShowing with no ViewHiding before it loses one, goes too.
  const kept = new Set(bars.values());
  for (const bar of container.querySelectorAll(`:scope > .${BAR_CLASS}`)) {
    if (!kept.has(bar)) {
      bar.remove();
    }
  }
  let at = 0;
  for (const bar of bars.values()) {
    if (container.children[at] !== bar) {
      container.insertBefore(bar, container.children[at] ?? null);
    }
    at++;
  }
  state.bars = bars;
}

function onViewShowing(win, event) {
  // `PanelMultiView.#openView` awaits before it dispatches ViewShowing, so a
  // panel hidden in that wait has dispatched ViewHiding already and detached
  // the view (`#closeLatestView`). Drawing then would mark the notices seen
  // in a panel nobody sees.
  if (event.target.id !== VIEW_ID || !event.target.panelMultiView) {
    return;
  }
  const state = stateFor(win);
  state.bars = new Map();
  if (state.focusOnShow) {
    // What `PanelMultiView.openPopup` does for a keyboard `triggerEvent`,
    // which `toggle` cannot pass: the view focuses its first navigable
    // element once it is active.
    win.PanelView.forNode(event.target).focusWhenActive = true;
    state.focusOnShow = false;
  }
  SvalExtensionNotices.update(win);
}

/**
 * A press on the extensions button while a notice exists toggles the panel
 * itself. `gUnifiedExtensions.togglePanel`, given the press, opens
 * about:addons in place of the panel when every extension is pinned and none
 * is turned off, which would leave the badge with nothing to open. The press
 * is taken in the window's capture phase, ahead of `navigator-toolbox.js`'s
 * `mousedown` and capturing `keypress` listeners, and only presses
 * `togglePanel` itself acts on: a primary button without the macOS context
 * menu's Control, or Space or Enter.
 *
 * @param {Window} win
 * @param {Event} event
 */
function onPress(win, event) {
  if (
    !event.target.closest?.(`#${lazy.EXTENSIONS_BUTTON_ID}`) ||
    win.CustomizationHandler.isCustomizing() ||
    !noticeLines(win).length
  ) {
    return;
  }
  const acts =
    event.type === "mousedown"
      ? event.button === 0 &&
        !(AppConstants.platform === "macosx" && event.ctrlKey)
      : event.key === " " || event.key === "Enter";
  if (!acts) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  stateFor(win).focusOnShow =
    event.type !== "mousedown" && !win.gUnifiedExtensions.isPanelOpen();
  toggle(win);
}

/**
 * Opens or closes the panel as `togglePanel` does, without the press that
 * would send it to about:addons.
 *
 * @param {Window} win
 */
function toggle(win) {
  if (opening.has(win)) {
    return;
  }
  opening.add(win);
  win.gUnifiedExtensions
    .togglePanel()
    .catch(err => {
      SvalLog.error(`extensions panel: ${SvalLog.errorName(err)}`);
    })
    .finally(() => opening.delete(win));
}

function onViewHiding(win, event) {
  if (event.target.id !== VIEW_ID) {
    return;
  }
  const state = stateFor(win);
  for (const bar of state.bars?.values() ?? []) {
    bar.remove();
  }
  state.bars = null;
}

export const SvalExtensionNotices = {
  /**
   * After the window's delayed startup: badges the button for the notices
   * already raised, and follows them and the panel from then on. The panel's
   * view events bubble to the window, and listening there needs no panel
   * built.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    const showing = event => onViewShowing(win, event);
    const hiding = event => onViewHiding(win, event);
    const press = event => onPress(win, event);
    win.addEventListener("ViewShowing", showing);
    win.addEventListener("ViewHiding", hiding);
    win.addEventListener("mousedown", press, true);
    win.addEventListener("keypress", press, true);
    const forget = watchNotices(() => this.update(win));
    win.addEventListener("unload", forget, { once: true });
    this.update(win);
  },

  /**
   * Draws the open panel's bars and sets the button's badge. Opens the panel
   * in the top window for an extension just installed, as Firefox's
   * doorhanger would show there.
   *
   * @param {Window} win
   */
  update(win) {
    const state = stateFor(win);
    const lines = noticeLines(win);
    const keys = new Set(lines.map(line => line.key));
    state.seen = new Set([...state.seen].filter(key => keys.has(key)));
    if (state.bars) {
      render(win, state, lines);
      for (const key of keys) {
        state.seen.add(key);
      }
    }
    const unseen = lines.filter(line => !state.seen.has(line.key)).length;
    const button = win.document.getElementById(lazy.EXTENSIONS_BUTTON_ID);
    if (button) {
      button.toggleAttribute("sval-notice", !!unseen);
      if (unseen) {
        button.setAttribute(
          "aria-description",
          unseen === 1 ? "1 notice" : `${unseen} notices`
        );
      } else {
        button.removeAttribute("aria-description");
      }
    }
    const installed = lazy.AppMenuNotifications.notifications.find(
      n => n.id === "addon-installed" && !n.dismissed
    );
    if (
      installed &&
      !openedFor.has(installed) &&
      win === lazy.BrowserWindowTracker.getTopWindow()
    ) {
      openedFor.add(installed);
      this.open(win);
    }
  },

  /**
   * Opens the extensions panel on the button. `openPanel` with no event
   * skips `togglePanel`'s jump to about:addons, which it takes for a click
   * while every extension is pinned, and still sets up the panel's list as a
   * click does. Anything already open on the button is left open.
   *
   * @param {Window} win
   */
  open(win) {
    const { gUnifiedExtensions, CustomizationHandler } = win;
    if (
      opening.has(win) ||
      gUnifiedExtensions.isPanelOpen() ||
      CustomizationHandler.isCustomizing()
    ) {
      return;
    }
    opening.add(win);
    gUnifiedExtensions
      .openPanel()
      .catch(err => {
        SvalLog.error(`extensions panel: ${SvalLog.errorName(err)}`);
      })
      .finally(() => opening.delete(win));
  },
};
