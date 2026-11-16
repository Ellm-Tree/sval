/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Tab hover previews in the Workspace panel: Firefox's own tab preview
 * (`tab-hover-preview.mjs`, the tab strip's `previewPanel`), shown beside a
 * tab's row when the pointer rests on it or keyboard focus moves to it
 * (`tab-hover-preview-anchor.patch`). Firefox's pref turns it on and off
 * (`browser.tabs.hoverPreview.enabled`), and its delay is Firefox's.
 *
 * - **It opens beside the panel.** The preview anchors to the row and sits
 *   past the panel's outer edge, on whichever side the panel is, so it never
 *   covers the panel.
 * - **The picture is the Ctrl+Tab switcher's** (`SvalTabSwitcher`), kept in
 *   memory and drawn at the switcher's own moments, and the tab on screen is
 *   drawn afresh as its preview opens. A tab with no picture yet shows the
 *   panel's title and address alone.
 * - **It goes as Firefox's does:** when the pointer or focus leaves the row,
 *   on a click, as the panel scrolls, and on Escape. While it shows, Escape
 *   hides it and does nothing else.
 * - **The row's own tooltip stays away** while previews are on, as Firefox
 *   keeps its tab tooltip away (`tabbrowser`'s `_showTabCardPreview`).
 *
 * Only tab rows have a preview: groups, Splits, pins and Favorites do not.
 */

import {
  draw,
  keptPreview,
} from "moz-src:///browser/components/sval/SvalTabSwitcher.sys.mjs";

/** Firefox's switch for its tab hover preview, which Sval's Settings show. */
export const HOVER_PREVIEW_PREF = "browser.tabs.hoverPreview.enabled";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** A tab's row in the Workspace panel's tree. */
const TAB_ROW = '.sval-row[data-kind="tab"]';

/** Between the panel's edge and the preview, and down from the row's top. */
const GAP_X = 6;
const GAP_Y = 3;

/**
 * @returns {boolean} whether previews are on.
 */
function enabled() {
  return Services.prefs.getBoolPref(HOVER_PREVIEW_PREF, false);
}

export const SvalTabHoverPreview = {
  /**
   * Listens on a window's Workspace panel for what shows and hides a tab's
   * preview, once the panel's container exists.
   *
   * @param {Window} win A browser window with a Workspace panel.
   */
  mount(win) {
    const doc = win.document;
    const container = doc.getElementById("sval-panel-container");
    if (!container) {
      return;
    }
    const tabContainer = () => win.gBrowser.tabContainer;
    /** The row a preview is for, shown or waiting for the delay. */
    let current = null;

    const tabOf = row => win.SvalPanel?.observer?.tabFor(row.dataset.nodeId);

    // The tab on screen is drawn as its preview opens, since its page is in
    // front of the user; every other tab shows the picture kept for it.
    const show = async row => {
      const tab = tabOf(row);
      if (!tab || !enabled()) {
        return;
      }
      current = row;
      const thumbnail = tab.selected ? await draw(tab) : keptPicture(tab);
      if (current !== row || !enabled()) {
        return;
      }
      tabContainer().ensureTabPreviewPanelLoaded();
      tabContainer().previewPanel.activate(tab, sourceFor(row, thumbnail));
    };

    const keptPicture = tab => {
      const url = keptPreview(tab);
      if (!url) {
        return null;
      }
      const img = doc.createElementNS(HTML_NS, "img");
      img.className = "sval-hover-picture";
      img.setAttribute("alt", "");
      img.src = url;
      return img;
    };

    const sourceFor = (row, thumbnail) => {
      const rowRect = row.getBoundingClientRect();
      const panelRect = container.getBoundingClientRect();
      const panelAtStart =
        panelRect.left + panelRect.width / 2 < win.innerWidth / 2;
      return {
        anchor: row,
        position: panelAtStart ? "topright topleft" : "topleft topright",
        x: panelAtStart
          ? panelRect.right - rowRect.right + GAP_X
          : panelRect.left - rowRect.left - GAP_X,
        y: GAP_Y,
        thumbnail,
      };
    };

    // As the tab strip does: leaving a row lets the preview linger for the
    // pointer to come back (`TabHoverPanelSet.requestDeactivate`), and a
    // forced hide is at once. Either ends a wait for the delay.
    const hide = ({ force = false } = {}) => {
      const row = current;
      current = null;
      const panelSet = tabContainer().previewPanel;
      if (!panelSet || !row) {
        return;
      }
      if (force) {
        panelSet.deactivate(null, { force: true });
      } else {
        panelSet.deactivate(tabOf(row) ?? null);
      }
    };

    const isOpen = () =>
      ["open", "showing"].includes(
        tabContainer().previewPanel?.tabPanel.panelElement.state
      );

    // Firefox also hides the preview itself, on a tab switch among others
    // (`TabPanel.handleEvent`), and the row stays `current` under the
    // pointer. The pointer crossing into another part of the row shows it
    // again; a repeat during the delay keeps the delay
    // (`TabPreviewPanelTimedFunction.execute`).
    container.addEventListener("mouseover", event => {
      const row = event.target.closest?.(TAB_ROW);
      if (row && (row !== current || !isOpen())) {
        show(row);
      }
    });
    container.addEventListener("mouseout", event => {
      if (current && !current.contains(event.relatedTarget)) {
        hide();
      }
    });
    container.addEventListener("mouseleave", () => hide());
    container.addEventListener("focusin", event => {
      const row = event.target;
      if (row.matches?.(TAB_ROW) && row.matches(":focus-visible")) {
        show(row);
      }
    });
    container.addEventListener("focusout", event => {
      if (current && event.target === current) {
        hide();
      }
    });
    // A row the panel draws anew is a new element, and the old one leaves the
    // document. A preview anchored to the old one is placed with no anchor,
    // away from the row and over whatever is there, so it goes at once.
    new win.MutationObserver(() => {
      const panel = tabContainer().previewPanel?.tabPanel.panelElement;
      const stranded =
        panel?.state === "open" && !panel.anchorNode?.isConnected;
      if (stranded || (current && !current.isConnected)) {
        current = null;
        tabContainer().previewPanel?.deactivate(null, { force: true });
      }
    }).observe(container, { childList: true, subtree: true });
    container.addEventListener("mousedown", () => hide({ force: true }), true);
    container.addEventListener("scroll", () => hide({ force: true }), true);
    // Ahead of the tree's own keys, where Escape clears the selection.
    container.addEventListener(
      "keydown",
      event => {
        if (event.key !== "Escape" || !current) {
          return;
        }
        const open = isOpen();
        hide({ force: true });
        if (open) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );

    // A tab row's name carries its title and address as a tooltip, which the
    // preview shows itself.
    win.addEventListener(
      "popupshowing",
      event => {
        const tooltip = event.target;
        if (
          tooltip.localName === "tooltip" &&
          enabled() &&
          tooltip.triggerNode?.closest?.(TAB_ROW) &&
          container.contains(tooltip.triggerNode)
        ) {
          event.preventDefault();
        }
      },
      true
    );
  },
};
