/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The header's notices button and its popover (messages spec §5): Sval's
 * update notices, which Firefox shows on the app menu button Sval's header
 * does not draw. The button shows, badged, only while a notice exists, and
 * the popover lists each notice with its buttons. A dismissed notice is one
 * row that runs its main action, as Firefox's app menu keeps it as a banner.
 *
 * The lines are `SvalAppNotices.updateLines`', drawn as the popover shows and
 * again whenever `watchNotices` reports a change.
 *
 * The popover opens itself once for each notice not yet dismissed, in the
 * active window, as Firefox opens its doorhanger
 * (`PanelUI.updateNotifications`). Opened so, it stays until the button is
 * clicked or a notice's button is, as the doorhanger is `noautohide`: a
 * click elsewhere, or a window resized as it opens, would close it unseen.
 */

import {
  updateLines,
  watchNotices,
} from "moz-src:///browser/components/sval/SvalAppNotices.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import { SvalPopover } from "moz-src:///browser/components/sval/SvalPopover.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
});

export const NOTICES_BUTTON_ID = "sval-notices-button";
export const NOTICES_PANEL_ID = "sval-notices-panel";

/** Per window, its popover once built. */
const panels = new WeakMap();

/** The `AppMenuNotifications` notices the popover has opened itself for. */
const opened = new WeakSet();

/**
 * A button that closes the popover, then runs `action`. It closes first
 * because an action can raise or remove a notice, and so redraw or hide the
 * popover it was clicked in.
 *
 * @param {Element} panel
 * @param {object} action `{ label, run }`.
 * @param {string} className
 * @returns {Element}
 */
function actionButton(panel, action, className) {
  const button = htmlElement(
    panel.ownerDocument,
    "button",
    { className },
    action.label
  );
  button.type = "button";
  button.addEventListener("click", () => {
    panel.hidePopup();
    action.run();
  });
  return button;
}

/**
 * One line: a notice's tile, sentence and buttons, secondary then primary,
 * or a banner's one row.
 *
 * @param {Element} panel
 * @param {object} line From `updateLines`.
 * @returns {Element}
 */
function drawLine(panel, line) {
  const doc = panel.ownerDocument;
  const tile = htmlElement(doc, "span", { className: "sval-notice-tile" });
  tile.setAttribute("aria-hidden", "true");
  if (line.banner) {
    const row = actionButton(
      panel,
      { label: "", run: line.run },
      "sval-notice sval-notice-row"
    );
    row.append(
      tile,
      htmlElement(doc, "span", { className: "sval-notice-text" }, line.banner)
    );
    return row;
  }
  const [main, secondary, ...links] = line.actions;
  const text = htmlElement(
    doc,
    "p",
    { className: "sval-notice-text" },
    line.text
  );
  for (const link of links) {
    text.append(" ", actionButton(panel, link, "sval-notice-link text-link"));
  }
  const buttons = htmlElement(
    doc,
    "div",
    { className: "sval-notice-buttons" },
    actionButton(panel, secondary, "footer-button small-button"),
    actionButton(panel, main, "footer-button small-button primary")
  );
  return htmlElement(
    doc,
    "div",
    { className: "sval-notice" },
    tile,
    htmlElement(doc, "div", { className: "sval-notice-body" }, text, buttons)
  );
}

function fill(panel, lines) {
  const list = htmlElement(
    panel.ownerDocument,
    "div",
    {},
    ...lines.map(line => drawLine(panel, line))
  );
  // Drawn again as a notice comes or goes while open, the list keeps its
  // place; it opens at its top.
  const scrolled =
    panel.state === "open" ? (panel.firstElementChild?.scrollTop ?? 0) : 0;
  panel.replaceChildren(list);
  list.scrollTop = scrolled;
}

/**
 * The window's popover, built on first use.
 *
 * @param {Window} win
 * @returns {object} the popover, as `SvalPopover.create` gave it.
 */
function panelFor(win) {
  let handle = panels.get(win);
  if (handle) {
    return handle;
  }
  handle = SvalPopover.create(win.document, {
    name: NOTICES_PANEL_ID,
    label: "Notices",
    // An arrow panel's default flip shrinks a popover that reaches past the
    // screen (`nsMenuPopupFrame::FlipOrResize`), cutting off its content; a
    // slide moves it whole (`nsMenuPopupFrame::SlideOrResize`).
    attributes: { flip: "slide", orient: "vertical" },
    // Grows from its button, reaching past it as the header's popovers do.
    stem: { hang: true },
    onShowing: () => fill(handle.popup, updateLines(win)),
    onHidden: () => handle.popup.removeAttribute("noautohide"),
  });
  panels.set(win, handle);
  return handle;
}

export const SvalNoticesButton = {
  /**
   * After the window's delayed startup, once the header holds the button:
   * shows it for the notices already raised, and follows them from then on.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    const update = () => this.update(win);
    const forget = watchNotices(update);
    // A notice raised while no window was active opens on the next one.
    win.addEventListener("activate", update);
    win.addEventListener("unload", forget, { once: true });
    this.update(win);
  },

  /**
   * Shows the button, badged, while the window has a notice, and redraws an
   * open popover, closing it once nothing is left. Opens the popover for an
   * undismissed notice it has not opened for, while the window is active.
   *
   * @param {Window} win
   */
  update(win) {
    const lines = updateLines(win);
    const button = win.document.getElementById(NOTICES_BUTTON_ID);
    if (button) {
      button.hidden = !lines.length;
      button.toggleAttribute("badged", !!lines.length);
    }
    const panel = panels.get(win)?.popup;
    if (!panel || panel.state === "closed" || panel.state === "hiding") {
      const fresh = lazy.AppMenuNotifications.notifications.filter(
        notice =>
          !opened.has(notice) &&
          lines.some(line => line.key === notice.id && !line.banner)
      );
      if (
        fresh.length &&
        Services.focus.activeWindow === win &&
        button?.checkVisibility()
      ) {
        fresh.forEach(notice => opened.add(notice));
        panelFor(win).popup.setAttribute("noautohide", "true");
        this.open(win);
      }
      return;
    }
    if (lines.length) {
      fill(panel, lines);
    } else {
      panel.hidePopup();
    }
  },

  /**
   * Opens the popover under the button, or closes it if it is open.
   *
   * @param {Window} win
   * @param {object} [options]
   * @param {boolean} [options.focus] Whether the popover takes the focus, as
   *   it does when opened from the keyboard.
   */
  open(win, { focus = false } = {}) {
    const button = win.document.getElementById(NOTICES_BUTTON_ID);
    if (!button || button.hidden) {
      return;
    }
    const handle = panelFor(win);
    if (handle.isOpen()) {
      handle.close();
      return;
    }
    handle.openFrom(button, "bottomright topright", { focus });
  },

  /**
   * @param {Window} win A browser window.
   * @returns {object} its popover, as `SvalPopover.create` gave it.
   */
  popoverOf(win) {
    return panelFor(win);
  },
};
