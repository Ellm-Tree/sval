/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's header: the one toolbar row a Sval window draws, styled by
 * `sval-header.css`.
 *
 * The row is Firefox's `#nav-bar` with a fixed set of widgets in a fixed
 * order, because the stylesheet fuses neighbours into pills by widget id: the
 * panel toggle closes the left pill, the navigation buttons sit directly
 * before `urlbar-container`, and the site controls and the favorite button
 * directly after it, so they all join the address pill. Toolbar
 * customisation is therefore closed, and the order is put back at every
 * startup through `CustomizableUI`, which costs no patch against its default
 * placements.
 */

import {
  SvalFavorites,
  FAVORITE_BUTTON_ID,
} from "moz-src:///browser/components/sval/SvalFavorites.sys.mjs";
import {
  APPLIED_TOPIC,
  SvalJavascript,
  ENABLED_PREF,
  scopeForURI,
} from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";
import { SvalLoadLine } from "moz-src:///browser/components/sval/SvalLoadLine.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { tidySeparators } from "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs";
import {
  MODE_NAMES,
  SvalShortcuts,
} from "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs";
import {
  PANEL_ID as PROTECTION_PANEL_ID,
  SvalProtectionButton,
} from "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs";
import {
  SvalSiteControls,
  LIVE_ID,
  LOCATION_BUTTON_ID,
  MEDIA_BUTTON_ID,
  REMOVE_BUTTON_ID,
  SITE_MENU_BUTTON_ID,
  SITE_MENU_ID,
  SNIP_BUTTON_ID,
  JAVASCRIPT_BUTTON_ID,
} from "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs";
import {
  COLORSHIFT_BUTTON_ID,
  SvalSiteStylePanel,
} from "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs";
import {
  SvalNoticesButton,
  NOTICES_BUTTON_ID,
  NOTICES_PANEL_ID,
} from "moz-src:///browser/components/sval/SvalNoticesButton.sys.mjs";
import { SvalExtensionCompat } from "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs";
import { SvalExtensionNotices } from "moz-src:///browser/components/sval/SvalExtensionNotices.sys.mjs";
import { SvalThemes } from "moz-src:///browser/components/sval/SvalThemes.sys.mjs";
import { SvalReloadMenu } from "moz-src:///browser/components/sval/SvalReloadMenu.sys.mjs";
import { SvalUpdateDelay } from "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs";
import { SvalExtensionSites } from "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs";
import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PanelMultiView:
    "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  launcherKeyText: "moz-src:///browser/components/sval/SvalLauncher.sys.mjs",
  mostSpecificRule:
    "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
});

const HEADER_CSS = "chrome://browser/content/sval/sval-header.css";
export const DISPLAY_PREF = "browser.sval.urlbar.display";
export const URLBAR_KEY_ID = "sval-urlbar-key";

// The panel toggle. Firefox's confirmation hints and full-page translations
// panel open on it in place of the app menu button, which the header does not
// draw; their patches name it by this id.
export const PANEL_BUTTON_ID = "sval-panel-button";
export const PRIVATE_BADGE_ID = "sval-private-badge";
export const HISTORY_BUTTON_ID = "sval-history-button";
export { JAVASCRIPT_BUTTON_ID };
// Firefox's own ids, so its split view and Reader View drive these buttons.
export const SPLIT_BUTTON_ID = "split-view-button";
export const READER_BUTTON_ID = "reader-mode-button";
// Firefox's own id, so its full-page translations panel drives this cell.
export const TRANSLATE_BUTTON_ID = "translations-button";

/**
 * The header's widgets before the extensions, in order. Extension buttons a
 * person pins follow them, then the extensions button, then
 * {@link RECORD_WIDGETS}; nothing else stays in the row.
 *
 * The site controls (`SvalSiteControls`: live devices, the location button
 * while the site asks for location or the tab uses it, media, JavaScript,
 * the element picker's two buttons while pinned, and the site menu's
 * button), then the page's cluster (the translate cell while the page can
 * be translated, the reader button while the page can be read in Reader
 * View, and the favorite button) act on the selected tab's page, so they
 * close the address pill. The
 * split button follows on its own, shown while the selected tab is in a
 * split.
 *
 * A row too narrow for its widgets moves them into the overflow panel in
 * {@link OVERFLOW_ORDER}, passing over each one marked `overflows="false"`.
 */
export const HEADER_WIDGETS = [
  PANEL_BUTTON_ID,
  "back-button",
  "forward-button",
  "stop-reload-button",
  "home-button",
  "urlbar-container",
  LIVE_ID,
  LOCATION_BUTTON_ID,
  MEDIA_BUTTON_ID,
  JAVASCRIPT_BUTTON_ID,
  REMOVE_BUTTON_ID,
  SNIP_BUTTON_ID,
  COLORSHIFT_BUTTON_ID,
  SITE_MENU_BUTTON_ID,
  TRANSLATE_BUTTON_ID,
  READER_BUTTON_ID,
  FAVORITE_BUTTON_ID,
  SPLIT_BUTTON_ID,
];

export const EXTENSIONS_BUTTON_ID = "unified-extensions-button";

/**
 * The row's end, after the extensions: one pill of the browser's records,
 * then the private badge. The pill holds the notices button
 * (`SvalNoticesButton`, messages spec §5) while it shows, Firefox's
 * `downloads-button`, which carries the downloads panel and its progress,
 * and the history button. Downloads shows before the first download too
 * (`browser.download.autohideButton`, `app-sval-firefox-ui.js`). The private
 * badge is drawn only in a private window; Firefox's own indicator sits
 * outside the row's widgets, where it cannot take that place.
 */
export const RECORD_WIDGETS = [
  NOTICES_BUTTON_ID,
  "downloads-button",
  HISTORY_BUTTON_ID,
  PRIVATE_BADGE_ID,
];

/**
 * The header's widgets that overflow, first to leave first: each takes its
 * place here as its `overflowpriority` (`OverflowableToolbar.#onOverflow`),
 * and pinned extension buttons, which have none, leave before them all. The
 * panel toggle, back, the address field, the live devices, the location
 * button, the private badge and the notices button stay in the row, marked `overflows="false"`:
 * they say what the window and its page are in, or are the way back to
 * everything else. The window's minimum width holds them
 * (`sval-header.css`).
 * `CustomizableUIInternal.buildWidgetNode` sets that mark from `overflows`
 * on a button widget only, so a custom widget's builder sets it on its node.
 */
export const OVERFLOW_ORDER = [
  SPLIT_BUTTON_ID,
  HISTORY_BUTTON_ID,
  "downloads-button",
  READER_BUTTON_ID,
  FAVORITE_BUTTON_ID,
  COLORSHIFT_BUTTON_ID,
  SNIP_BUTTON_ID,
  REMOVE_BUTTON_ID,
  JAVASCRIPT_BUTTON_ID,
  TRANSLATE_BUTTON_ID,
  MEDIA_BUTTON_ID,
  SITE_MENU_BUTTON_ID,
  "home-button",
  "stop-reload-button",
  "forward-button",
];

/**
 * Gives `node` its place in {@link OVERFLOW_ORDER}.
 *
 * @param {Element} node A header widget's node.
 */
function markOverflow(node) {
  const at = OVERFLOW_ORDER.indexOf(node.id);
  if (at >= 0) {
    node.setAttribute("overflowpriority", String(at + 1));
  }
}

/**
 * Per element, the `transitionend` listener of the slide under way, dropped
 * when a later slide reverses it.
 *
 * @type {WeakMap<Element, AbortController>}
 */
const slideEnds = new WeakMap();

/**
 * Whether `el` moves when it slides: false where motion is reduced, which
 * `sval-header.css` answers by giving it no transition.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function slides(el) {
  return !!parseFloat(
    el.documentGlobal.getComputedStyle(el).transitionDuration
  );
}

/**
 * Slides the panel or the sidebar in or out, pushing the page along beside it
 * (`sval-header.css`, panel slide), as Firefox's own sidebar pushes it
 * (`SidebarController._animateSidebarContainer`). Hiding lifts the box out of
 * the layout first, so the page widens once, held where the box's edge is,
 * then box and page move together; showing moves them together with the page
 * at its wider width, then puts the box back in the layout, so the page
 * narrows once. Its width is measured as it goes, because a person may have
 * resized it. A slide started mid-slide reverses it.
 *
 * @param {Element} el `#sval-panel-container` or `#sidebar-box`.
 * @param {boolean} shown Whether it ends shown.
 * @param {Function} [onHidden] Called once it has slid out.
 */
export function slide(el, shown, onHidden) {
  slideEnds.get(el)?.abort();
  const end = new AbortController();
  slideEnds.set(el, end);
  const settled = () => {
    end.abort();
    if (el.hasAttribute("sval-collapsed")) {
      onHidden?.();
    } else {
      el.removeAttribute("sval-overlay");
      push(el, false, true);
    }
  };
  if (shown) {
    el.removeAttribute("sval-collapsed");
    push(el, true);
  } else {
    if (!el.hasAttribute("sval-overlay")) {
      lift(el);
      push(el, true, true);
      // The lifted box is drawn in place once, so the slide starts there.
      el.getBoundingClientRect();
    }
    el.setAttribute("sval-collapsed", "true");
    push(el, false);
  }
  // A box already where it is sent starts no transition, and so ends none:
  // a slide reversed before a style flush leaves its style as it was, and a
  // panel slid in over the page (`SvalPanelReveal`) is shown where it stands
  // while the page alone moves aside. Asking for the animations flushes
  // style first.
  const moving = (box, name) =>
    !!box?.getAnimations().some(a => a.transitionProperty === name);
  const page = el.ownerDocument.getElementById("tabbrowser-tabbox");
  let [mover, property] = [null, null];
  if (moving(el, "transform")) {
    [mover, property] = [el, "transform"];
  } else if (moving(page, "translate")) {
    [mover, property] = [page, "translate"];
  }
  if (!slides(el) || !mover) {
    settled();
    return;
  }
  const onEnd = event => {
    if (event.target === mover && event.propertyName === property) {
      settled();
    }
  };
  mover.addEventListener("transitionend", onEnd, { signal: end.signal });
  if (mover === page) {
    // The page's move ends early where `push` puts it in place at once for
    // the other box. A move replaced by a later one, as a reversed slide
    // replaces it, is cancelled too, while the later one still runs.
    page.addEventListener(
      "transitioncancel",
      event => {
        if (!moving(page, "translate")) {
          onEnd(event);
        }
      },
      { signal: end.signal }
    );
  }
}

/**
 * Slides in a box that has just appeared in the layout, from where a slide
 * out would have left it.
 *
 * @param {Element} el
 */
export function slideIn(el) {
  lift(el);
  // Placed out without a transition, and drawn there once, so the slide in
  // starts from outside.
  el.style.transition = "none";
  el.setAttribute("sval-collapsed", "true");
  el.getBoundingClientRect();
  el.style.removeProperty("transition");
  slide(el, true);
}

/**
 * Puts `el` back in the layout where it stands, with the page beside it, for
 * a box hidden without a slide.
 *
 * @param {Element} el
 */
export function settle(el) {
  slideEnds.get(el)?.abort();
  el.removeAttribute("sval-overlay");
  el.removeAttribute("sval-collapsed");
  push(el, false, true);
}

/**
 * Takes `el` out of the layout at the width it has in it, with the gap
 * between it and the page's frame as it stands in the layout
 * (`--sval-slide-gutter`, `sval-header.css`): lifted, it lies over the
 * page, and the page takes the width that opens the gap only once it is
 * back in the layout.
 *
 * @param {Element} el
 */
function lift(el) {
  const win = el.documentGlobal;
  const own = el.getBoundingClientRect();
  const page = win.gBrowser?.selectedBrowser
    ?.closest(".browserSidebarContainer")
    ?.getBoundingClientRect();
  let gutter = 0;
  let toward = 1;
  if (page?.width) {
    const after = own.left >= page.right;
    gutter = Math.max(0, after ? own.left - page.right : page.left - own.right);
    toward = after ? -1 : 1;
  }
  el.style.setProperty("--sval-slide-w", `${own.width}px`);
  el.style.setProperty("--sval-slide-gutter", `${gutter}px`);
  el.style.setProperty(
    "--sval-slide-push",
    `${toward * (own.width + gutter)}px`
  );
  el.setAttribute("sval-overlay", "true");
}

/**
 * Moves the page aside by the room the lifted box `el` takes in the layout,
 * or back. Each box keeps its own share of the page's offset
 * (`--sval-push-<id>`, `sval-header.css`), so the panel and the sidebar can
 * slide at once.
 *
 * @param {Element} el `#sval-panel-container` or `#sidebar-box`.
 * @param {boolean} aside Whether the page ends moved aside.
 * @param {boolean} [now] Whether it gets there without moving, as the layout
 *   changes under it.
 */
function push(el, aside, now = false) {
  const page = el.ownerDocument.getElementById("tabbrowser-tabbox");
  if (!page) {
    return;
  }
  const name = `--sval-push-${el.id}`;
  const by = aside ? el.style.getPropertyValue("--sval-slide-push") : "";
  if (now) {
    page.style.transition = "none";
  }
  if (by) {
    page.style.setProperty(name, by);
  } else {
    page.style.removeProperty(name);
  }
  if (now) {
    page.getBoundingClientRect();
    page.style.removeProperty("transition");
  }
}

/**
 * Entry points to customize mode. `cmd_CustomizeToolbars` is disabled too,
 * which covers its keyboard and command-line routes; the items are hidden so
 * no menu offers a command that does nothing. They take the `hidden` attribute
 * because macOS draws the menu bar natively and reads only that.
 */
const CUSTOMIZE_ENTRY_POINTS = [
  "menu_customizeToolbars",
  "toolbar-context-customize",
  "customizationMenuSeparator",
];

/**
 * The toolbar context menu's items that open customize mode, hidden every
 * time it opens because `ToolbarContextMenu.onViewToolbarsPopupShowing` shows
 * them again.
 */
const CONTEXT_CUSTOMIZE_ITEMS = [
  "toolbar-context-customize",
  "customizationMenuSeparator",
];

/**
 * The context menus of the header's widgets: the toolbar's, and the one
 * `CustomizableUIInternal.ensureButtonContextMenu` gives a widget in the
 * overflow panel.
 */
const WIDGET_CONTEXT_MENUS = new Set([
  "toolbar-context-menu",
  "customizationPanelItemContextMenu",
]);

/**
 * The context menus' items that change the window's layout, hidden on every
 * widget because the layout is fixed: those moving a widget out of the row or
 * the overflow panel, and the toolbar toggles
 * `ToolbarContextMenu.onViewToolbarsPopupShowing` marks with `toolbarId`. An
 * extension's button keeps its pin item.
 */
const CONTEXT_LAYOUT_ITEMS = [
  ".customize-context-moveToPanel",
  ".customize-context-moveToToolbar",
  ".customize-context-removeFromToolbar",
  ".customize-context-removeFromPanel",
  "[toolbarId]",
];

/**
 * `popupshowing` on a widget's context menu: takes out what would change the
 * header's layout. It listens on the window, so it runs after Firefox's own
 * listener on `mainPopupSet`, which sets each item's `hidden` afresh.
 *
 * @param {Event} event
 */
function onToolbarContextMenuShowing(event) {
  const popup = event.target;
  if (!WIDGET_CONTEXT_MENUS.has(popup.id)) {
    return;
  }
  const doc = popup.ownerDocument;
  for (const id of CONTEXT_CUSTOMIZE_ITEMS) {
    doc.getElementById(id)?.setAttribute("hidden", "true");
  }
  for (const item of popup.querySelectorAll(CONTEXT_LAYOUT_ITEMS.join())) {
    item.setAttribute("hidden", "true");
  }
  // Firefox placed the menu's separators for the items it showed
  // (`ToolbarContextMenu.hideLeadingSeparatorIfNeeded`), before this ran.
  tidySeparators(popup);
  // A widget whose only items change the layout, such as Home, has
  // nothing left to offer, and a popup with every item hidden still opens.
  if (![...popup.children].some(child => !child.hidden)) {
    event.preventDefault();
  }
}

/** The class `SidebarController.registerExtension` gives an extension's item. */
export const EXTENSION_ITEM_CLASS = "webextension-menuitem";

/**
 * `popupshowing` on the View menu: View › Toolbars shows only while a toolbar
 * carries `toolbarname`, which is what
 * `ToolbarContextMenu.onViewToolbarsPopupShowing` lists there. Sval takes the
 * bookmarks toolbar's and the menu bar's away, so the submenu would be empty.
 * View › Sidebar shows only while an extension adds a sidebar to it
 * (`SidebarController.createMenuItem`): the History menu and the header's
 * button open History, and Sval hides the other sidebars.
 *
 * @param {Event} event
 */
export function onViewMenuShowing(event) {
  if (event.target.id !== "menu_viewPopup") {
    return;
  }
  const doc = event.target.ownerDocument;
  doc.getElementById("viewToolbarsMenu").hidden = !doc
    .getElementById("navigator-toolbox")
    .querySelector("toolbar[toolbarname]");
  doc.getElementById("viewSidebarMenuMenu").hidden = !doc
    .getElementById("viewSidebarMenu")
    .getElementsByClassName(EXTENSION_ITEM_CLASS).length;
  // With both hidden, the line under them would open the menu.
  tidySeparators(event.target);
}

/**
 * The popovers that grow from the button that opened them (messages spec
 * §9.4): the header's notices, extensions, downloads, site-settings and
 * Privacy and Security panels, the workspace panel's Favorites menu, the
 * pins row's folder popover and the strip's list of an agent app's
 * Workspaces.
 */
const ATTACHED_POPUPS = new Set([
  NOTICES_PANEL_ID,
  PROTECTION_PANEL_ID,
  "unified-extensions-panel",
  "downloadsPanel",
  SITE_MENU_ID,
  "sval-favorites-menu",
  "sval-pins-popover",
  "sval-strip-app-menu",
]);

/**
 * Whether Firefox's doorhanger grows from `root`: the extensions button, and
 * the site controls' media button, location button and asking cell, which
 * the media prompt and a site's permission prompts open from (decision
 * 0132).
 *
 * @param {Element} root
 * @returns {boolean}
 */
function doorhangerGrowsFrom(root) {
  return (
    [EXTENSIONS_BUTTON_ID, MEDIA_BUTTON_ID, LOCATION_BUTTON_ID].includes(
      root.id
    ) || !!root.closest(`#${LIVE_ID}`)
  );
}

/**
 * The element a popover grows from: the toolbarbutton around its anchor, as
 * `panel.js` marks `[open]`, or the anchor itself where it is no
 * toolbarbutton.
 *
 * @param {Element} popup
 * @returns {Element|null}
 */
function stemRootOf(popup) {
  const anchor = popup.anchorNode;
  if (!anchor) {
    return null;
  }
  const root = anchor.closest("toolbarbutton") ?? anchor;
  if (ATTACHED_POPUPS.has(popup.id) && !popup.hasAttribute("sval-beside")) {
    return root;
  }
  if (popup.id === "notification-popup" && doorhangerGrowsFrom(root)) {
    return root;
  }
  return null;
}

/**
 * The part of the button that is drawn as a pill: the icon or badge stack of
 * a toolbarbutton, or the whole of any other button.
 *
 * @param {Element} root
 * @returns {Element}
 */
function stemFaceOf(root) {
  return (
    root.querySelector(
      ":scope > :is(.toolbarbutton-icon, .toolbarbutton-badge-stack)"
    ) ?? root
  );
}

/** The concave fillets' radius where the stem meets the content (§9.4). */
const STEM_FILLET = 12;

const STEM_PROPERTIES = [
  "--sval-fillet-left",
  "--sval-fillet-right",
  "--sval-corner-left",
  "--sval-corner-right",
  "--sval-stem-drop",
  "--sval-stem-face-h",
  "--sval-stem-w",
  "--sval-stem-fill",
  "--sval-stem-room",
  "--sval-stem-top-trim",
  "--sval-stem-body-left",
  "--sval-stem-body-top",
  "--sval-stem-body-width",
  "--sval-stem-body-height",
  "--sval-stem-body-radius",
  "--sval-stem-tab-left",
  "--sval-stem-tab-top",
  "--sval-stem-tab-width",
  "--sval-stem-tab-height",
  "--sval-stem-tab-radius",
];

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The SVG in `popup`'s shadow tree that draws its joined shape
 * (`sval-header.css`, panels), made the first time it is asked for and kept,
 * hidden while no stem is placed. Its first path draws the fill, its second
 * the edge.
 *
 * @param {Element} popup
 * @returns {SVGSVGElement|null} Null where the popup has no content part yet.
 */
function stemOutlineOf(popup) {
  const shadow = popup.shadowRoot;
  if (!shadow?.querySelector('[part~="content"]')) {
    return null;
  }
  let svg = shadow.querySelector('[part~="sval-stem-outline"]');
  if (!svg) {
    const doc = popup.ownerDocument;
    svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("part", "sval-stem-outline");
    svg.setAttribute("aria-hidden", "true");
    for (const part of ["sval-stem-fill", "sval-stem-edge"]) {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("part", part);
      svg.append(path);
    }
    shadow.append(svg);
  }
  return svg;
}

function detachStem(popup) {
  const root = popup._svalStemRoot;
  popup._svalStemRoot = null;
  popup._svalStemMargins = null;
  popup._svalStemShape = null;
  popup._svalStemObserver?.disconnect();
  popup._svalStemObserver = null;
  popup.style.removeProperty("margin-left");
  popup.style.removeProperty("margin-right");
  for (const path of popup.shadowRoot?.querySelectorAll(
    '[part~="sval-stem-outline"] > path'
  ) ?? []) {
    path.removeAttribute("d");
  }
  for (const el of [popup, root]) {
    if (!el) {
      continue;
    }
    el.removeAttribute("sval-stem");
    for (const name of STEM_PROPERTIES) {
      el.style.removeProperty(name);
    }
  }
}

/**
 * Moves `popup` along its button's edge until its content stands
 * `shadowReach` inside `win`'s sides, so its shadow fades out within the
 * window and does not end at its edge. The content never stands further in
 * than its button's own side, which the stem joins: a button nearer the
 * edge than that takes the content's side in line with its own. Gecko keeps a chrome popup on the screen alone
 * (`nsMenuPopupFrame::GetConstraintRect`), widened by its input region
 * margin, so a popover that reaches past its button runs off a window that
 * stops short of the screen's edge. Gecko adds a popup's left margin to its
 * place and takes its right margin away whichever side it is aligned by
 * (`nsMenuPopupFrame::AdjustPositionForAnchorAlign`), so moving both by one
 * length moves the popup by that length. A popover wider than the window
 * keeps its left edge in.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{left: number, right: number}} content The popup's content on the
 *   screen.
 * @param {{left: number, right: number}} face The button on the screen.
 * @returns {boolean} Whether the popup moved.
 */
function keepInWindow(popup, win, content, face) {
  const reach = shadowReach(popup, win);
  const left = Math.min(win.mozInnerScreenX + reach, face.left);
  const right = Math.max(
    win.mozInnerScreenX + win.innerWidth - reach,
    face.right
  );
  const dpr = win.devicePixelRatio;
  // Gecko places a popup on whole device pixels (`nsMenuPopupFrame::GetRects`).
  const slack = 0.5 / dpr;
  let by = 0;
  if (content.right > right + slack) {
    by = -Math.ceil((content.right - right) * dpr) / dpr;
  }
  if (content.left + by < left - slack) {
    by = Math.ceil((left - content.left) * dpr) / dpr;
  }
  if (!by) {
    return false;
  }
  if (!popup._svalStemMargins) {
    const style = win.getComputedStyle(popup);
    popup._svalStemMargins = {
      left: parseFloat(style.marginLeft),
      right: parseFloat(style.marginRight),
      by: 0,
    };
  }
  const margins = popup._svalStemMargins;
  margins.by += by;
  popup.style.marginLeft = `${margins.left + margins.by}px`;
  popup.style.marginRight = `${margins.right - margins.by}px`;
  return true;
}

/**
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @returns {number} How far the popover's shadow reaches past its content
 *   (`--sval-stem-shadow-reach`, `sval-header.css`).
 */
function shadowReach(popup, win) {
  return (
    parseFloat(
      win.getComputedStyle(popup).getPropertyValue("--sval-stem-shadow-reach")
    ) || 0
  );
}

/**
 * Bounds `popup`'s content to the room between its top and `shadowReach`
 * above the foot of `win`, and its content scrolls within that (`sval-header.css`, panels).
 * Gecko keeps a chrome popup on the screen alone
 * (`nsMenuPopupFrame::GetConstraintRect`), so a popover under its button
 * runs past a window that stops short of the screen's foot. The bound is
 * set at `popupshowing` from where the content starts at the nearest, a
 * fillet under the pill, so a menu, which gets no `popuppositioned`, is
 * bounded in its first paint; placing the stem sets it again from where
 * the content stands.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{top: number}} content The popup's content on the screen.
 */
function keepAboveWindowFoot(popup, win, content) {
  // The bound replaces `popup.css`'s, which keeps the content within a
  // popup Gecko has shrunk to the screen, so the screen's foot bounds it too.
  const foot =
    Math.min(
      win.mozInnerScreenY + win.innerHeight,
      win.screen.availTop + win.screen.availHeight
    ) - shadowReach(popup, win);
  const room = foot - content.top;
  const value = `${Math.max(0, Math.floor(room))}px`;
  if (popup.style.getPropertyValue("--sval-stem-room") !== value) {
    popup.style.setProperty("--sval-stem-room", value);
  }
}

/**
 * The corner radii `el` is drawn with: CSS scales all four down by one
 * factor where two on a side add up to more than the side
 * (CSS Backgrounds 3 §5.5), as a pill's 999px radius is.
 *
 * @param {Element} el
 * @param {{width: number, height: number}} rect `el`'s border box.
 * @returns {{tl: number, tr: number, br: number, bl: number}}
 */
function cornerRadii(el, rect) {
  const style = el.documentGlobal.getComputedStyle(el);
  const [tl, tr, br, bl] = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map(value => parseFloat(value) || 0);
  const fit = (length, a, b) => (a + b > length ? length / (a + b) : 1);
  const scale = Math.min(
    fit(rect.width, tl, tr),
    fit(rect.width, bl, br),
    fit(rect.height, tl, bl),
    fit(rect.height, tr, br)
  );
  return { tl: tl * scale, tr: tr * scale, br: br * scale, bl: bl * scale };
}

/**
 * The SVG path of a stemmed popover's joined shape (messages spec §9.4),
 * clockwise from the face's top left, grown outward by `grow`: the face's
 * top corners and sides, the stem, its concave fillets and the body's
 * rounded box. Grown by half the edge's width, the path is where the edge's
 * stroke runs, so the edge lies outside the shape, as a box's border does.
 * Every length is in the popup window's CSS pixels.
 *
 * @param {object} shape
 * @param {{left: number, top: number, right: number, bottom: number}} shape.face
 * @param {{tl: number, tr: number}} shape.faceRadii
 * @param {{left: number, right: number}} shape.stem Within the face.
 * @param {{left: number, top: number, right: number, bottom: number}} shape.body
 * @param {{tl: number, tr: number, br: number, bl: number}} shape.radii The body's.
 * @param {{left: number, right: number}} shape.fillets
 * @param {number} grow
 * @returns {string}
 */
function stemPath({ face, faceRadii, stem, body, radii, fillets }, grow) {
  const o = grow;
  const n = value => Math.round(value * 1000) / 1000;
  const d = [];
  const line = (x, y) => d.push(`L${n(x)} ${n(y)}`);
  const arc = (r, sweep, x, y) =>
    d.push(`A${n(r)} ${n(r)} 0 0 ${sweep} ${n(x)} ${n(y)}`);
  // A square corner, grown, is its corner point: the stroke's miter join
  // keeps it square.
  const convex = (r, x, y, cornerX, cornerY) => {
    if (r > 0) {
      arc(r + o, 1, x, y);
    } else {
      line(cornerX, cornerY);
      line(x, y);
    }
  };
  // Where the body's top corner is narrower than the growth, its grown arc
  // starts or ends inside the stem's grown side, so the path meets the arc
  // where the side crosses it.
  const meet = (cx, r, x) =>
    body.top + r - Math.sqrt(Math.max(0, (r + o) ** 2 - (x - cx) ** 2));
  const apart = 1 / 60;

  d.push(`M${n(face.left - o)} ${n(face.top + faceRadii.tl)}`);
  convex(
    faceRadii.tl,
    face.left + faceRadii.tl,
    face.top - o,
    face.left - o,
    face.top - o
  );
  line(face.right - faceRadii.tr, face.top - o);
  convex(
    faceRadii.tr,
    face.right + o,
    face.top + faceRadii.tr,
    face.right + o,
    face.top - o
  );
  if (face.right - stem.right > apart) {
    line(face.right + o, face.bottom + o);
    line(stem.right + o, face.bottom + o);
  }
  if (body.right - stem.right > apart) {
    const cx = body.right - radii.tr;
    if (fillets.right) {
      line(stem.right + o, body.top - fillets.right);
      arc(fillets.right - o, 0, stem.right + fillets.right, body.top - o);
      line(cx, body.top - o);
      convex(
        radii.tr,
        body.right + o,
        body.top + radii.tr,
        body.right + o,
        body.top - o
      );
    } else if (radii.tr > 0 && cx < stem.right + o) {
      line(stem.right + o, meet(cx, radii.tr, stem.right + o));
      arc(radii.tr + o, 1, body.right + o, body.top + radii.tr);
    } else {
      line(stem.right + o, body.top - o);
      line(cx, body.top - o);
      convex(
        radii.tr,
        body.right + o,
        body.top + radii.tr,
        body.right + o,
        body.top - o
      );
    }
  }
  line(body.right + o, body.bottom - radii.br);
  convex(
    radii.br,
    body.right - radii.br,
    body.bottom + o,
    body.right + o,
    body.bottom + o
  );
  line(body.left + radii.bl, body.bottom + o);
  convex(
    radii.bl,
    body.left - o,
    body.bottom - radii.bl,
    body.left - o,
    body.bottom + o
  );
  if (stem.left - body.left > apart) {
    const cx = body.left + radii.tl;
    line(body.left - o, body.top + radii.tl);
    if (fillets.left) {
      convex(radii.tl, cx, body.top - o, body.left - o, body.top - o);
      line(stem.left - fillets.left, body.top - o);
      arc(fillets.left - o, 0, stem.left - o, body.top - fillets.left);
    } else if (radii.tl > 0 && cx > stem.left - o) {
      arc(radii.tl + o, 1, stem.left - o, meet(cx, radii.tl, stem.left - o));
    } else {
      convex(radii.tl, cx, body.top - o, body.left - o, body.top - o);
      line(stem.left - o, body.top - o);
    }
  }
  if (stem.left - face.left > apart) {
    line(stem.left - o, face.bottom + o);
    line(face.left - o, face.bottom + o);
  }
  d.push("Z");
  return d.join("");
}

/**
 * The face's inside, which the shape's fill leaves out so the button's
 * label shows through the popover's window: the face inset by `inset`, its
 * top corners rounded with it and its foot square, as the stemmed button's
 * is (`sval-header.css`). The fill over the rim it keeps lies on the
 * button's own fill, of the same colour, so where the two windows' pixels
 * fall makes no gap between them.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} face
 * @param {{tl: number, tr: number}} radii
 * @param {number} inset
 * @returns {string}
 */
function facePath(face, radii, inset) {
  const n = value => Math.round(value * 1000) / 1000;
  const left = face.left + inset;
  const right = face.right - inset;
  const top = face.top + inset;
  const bottom = face.bottom - inset;
  const tl = Math.max(0, radii.tl - inset);
  const tr = Math.max(0, radii.tr - inset);
  if (right <= left || bottom <= top) {
    return "";
  }
  return [
    `M${n(left)} ${n(top + tl)}`,
    tl ? `A${n(tl)} ${n(tl)} 0 0 1 ${n(left + tl)} ${n(top)}` : "",
    `L${n(right - tr)} ${n(top)}`,
    tr ? `A${n(tr)} ${n(tr)} 0 0 1 ${n(right)} ${n(top + tr)}` : "",
    `L${n(right)} ${n(bottom)}`,
    `L${n(left)} ${n(bottom)}Z`,
  ].join("");
}

/** The edge's width (`sval-header.css`, panels). */
const STEM_EDGE = 1;

/**
 * Places the stem once the popup has its place. Each XUL popup is a native
 * window of its own (`nsMenuPopupFrame::CreateWidget`), and the popover's
 * window reaches up over its button (`sval-header.css`, panels), so the
 * popover draws the whole shape: its path is traced from the button's face,
 * measured on the screen, and from the content, measured in the popup. A
 * popup that opens above its button has nothing to grow from, and lets go
 * of it while it stays open: letting go gives it back its own margins,
 * which move it.
 *
 * @param {Element} popup
 * @param {boolean} [traceOnly] Whether only to trace the path again where
 *   the popup stands, without moving it or bounding its content, whose size
 *   would change again within the resize observer's own callback.
 */
function placeStemOf(popup, traceOnly = false) {
  const root = popup._svalStemRoot;
  if (!root) {
    return;
  }
  const win = root.documentGlobal;
  const faceEl = stemFaceOf(root);
  const pill = faceEl.getBoundingClientRect();
  const face = {
    left: win.mozInnerScreenX + pill.left,
    right: win.mozInnerScreenX + pill.right,
    top: win.mozInnerScreenY + pill.top,
    bottom: win.mozInnerScreenY + pill.bottom,
  };
  let frame = popup.getBoundingClientRect();
  const atFrame = () => ({
    left: win.mozInnerScreenX + frame.left,
    top: win.mozInnerScreenY + frame.top,
    width: frame.width,
  });
  // An arrow panel's first `popuppositioned` comes before its window is
  // shown (`nsXULPopupPositionedEvent::Run`), so the stem placed there is in
  // the window's first paint; `popupshown` comes after that paint, and after
  // any opening transition. The frame stands at the place `GetRects` chose,
  // against the main window's root (`nsMenuPopupFrame::PerformMove`), and
  // the window follows it at the next paint
  // (`nsMenuPopupFrame::SchedulePendingWidgetMoveResize`). So the window's
  // rect is empty until the popup is open, and an open popup that moves can
  // fire `popuppositioned` before its window has followed
  // (`XULPopupElement::GetOuterScreenRect` reads the window). Where the two
  // differ by more than a pixel the stem is placed by the frame. macOS can
  // put the window half a point from the frame, and there the stem is
  // placed by the window.
  let box = popup.getOuterScreenRect();
  const framed = atFrame();
  if (
    !box.width ||
    Math.abs(box.left - framed.left) > 1 ||
    Math.abs(box.top - framed.top) > 1
  ) {
    box = framed;
  }
  const part = popup.shadowRoot?.querySelector('[part~="content"]');
  const outline = stemOutlineOf(popup);
  if (!box.width || !part || !outline) {
    return;
  }
  const contentOf = () => {
    const r = part.getBoundingClientRect();
    return {
      left: box.left + r.left - frame.left,
      right: box.left + r.right - frame.left,
      top: box.top + r.top - frame.top,
      bottom: box.top + r.bottom - frame.top,
      width: r.width,
      height: r.height,
    };
  };
  let content = contentOf();
  if (!traceOnly && keepInWindow(popup, win, content, face)) {
    // Reading the frame's rect reflows the popup, which moves its frame
    // (`nsMenuPopupFrame::PerformMove`); its window follows at the next
    // paint, so the stem is placed by the frame.
    frame = popup.getBoundingClientRect();
    box = atFrame();
    content = contentOf();
  }
  if (!traceOnly) {
    keepAboveWindowFoot(popup, win, content);
  }
  if (content.top < face.bottom) {
    detachStem(popup);
    return;
  }
  // Gecko places the popup's window on whole device pixels
  // (`nsMenuPopupFrame::GetRects`) and the button stands where the layout
  // puts it, so a content side meant to meet the button's flush lands up to
  // a device pixel off it (`keepInWindow` moves by whole device pixels too).
  // The body is drawn with that side on the button's, so the edge runs
  // down it in one straight line; the content has no fill or edge of its
  // own while the stem is placed (`sval-header.css`).
  const body = { ...content };
  for (const side of ["left", "right"]) {
    if (Math.abs(body[side] - face[side]) < 1 / win.devicePixelRatio) {
      body[side] = face[side];
    }
  }
  // The stem runs under the pill, within the content's top edge: a menu no
  // wider than its button takes the stem along the whole edge. Gecko also
  // slides a popover that would leave the screen back along its edge
  // (`nsMenuPopupFrame::SlideOrResize`), which can bring a corner under the
  // stem. A fillet goes where there is no room for it, and the corner
  // rounds no further than the room left, so the content's side runs into
  // the stem.
  const stemLeft = Math.max(face.left, body.left);
  const stemRight = Math.min(face.right, body.right);
  if (stemRight <= stemLeft) {
    detachStem(popup);
    return;
  }
  const rooms = {
    left: stemLeft - body.left,
    right: body.right - stemRight,
  };
  const fillets = {};
  const px = value => `${value}px`;
  for (const [side, room] of Object.entries(rooms)) {
    fillets[side] = room >= STEM_FILLET ? STEM_FILLET : 0;
    popup.style.setProperty(`--sval-fillet-${side}`, px(fillets[side]));
    popup.style.setProperty(
      `--sval-corner-${side}`,
      px(Math.max(0, room - fillets[side]))
    );
  }
  // The content's top corners follow the corners just set.
  const radii = cornerRadii(part, content);
  const faceRadii = cornerRadii(faceEl, pill);
  // In the popup's window, whose top left is the box's.
  const x = value => value - box.left;
  const y = value => value - box.top;
  const shape = {
    face: {
      left: x(face.left),
      right: x(face.right),
      top: y(face.top),
      bottom: y(face.bottom),
    },
    faceRadii,
    stem: { left: x(stemLeft), right: x(stemRight) },
    body: {
      left: x(body.left),
      right: x(body.right),
      top: y(body.top),
      bottom: y(body.bottom),
    },
    radii,
    fillets,
  };
  const edge = stemPath(shape, STEM_EDGE / 2);
  const [fillPath, edgePath] = outline.children;
  fillPath.setAttribute("d", edge + facePath(shape.face, faceRadii, STEM_EDGE));
  edgePath.setAttribute("d", edge);
  const set = (name, value) => popup.style.setProperty(name, value);
  set("--sval-stem-body-left", px(shape.body.left));
  set("--sval-stem-body-top", px(shape.body.top));
  set("--sval-stem-body-width", px(shape.body.right - shape.body.left));
  set("--sval-stem-body-height", px(shape.body.bottom - shape.body.top));
  set(
    "--sval-stem-body-radius",
    [radii.tl, radii.tr, radii.br, radii.bl].map(px).join(" ")
  );
  set("--sval-stem-tab-left", px(shape.face.left));
  set("--sval-stem-tab-top", px(shape.face.top));
  set("--sval-stem-tab-width", px(shape.face.right - shape.face.left));
  set("--sval-stem-tab-height", px(shape.body.top - shape.face.top));
  set("--sval-stem-tab-radius", `${px(faceRadii.tl)} ${px(faceRadii.tr)} 0 0`);
  popup._svalStemShape = {
    tab: {
      left: shape.face.left,
      right: shape.face.right,
      top: shape.face.top,
      bottom: shape.body.top,
    },
  };
  root.setAttribute("sval-stem", "");
  popup.setAttribute("sval-stem", "placed");
}

/** @param {Event} event `popupshown` or `popuppositioned`. */
function placeStem(event) {
  placeStemOf(event.target);
}

/**
 * `popupshowing`: marks the popover and its button before Gecko positions
 * the popover, so `sval-header.css` has already made room for the stem and,
 * for a header panel, kept it clear of the corners. The button takes the
 * popover's own fill, whatever palette set it. The popover's content is
 * watched for a change of size, which moves its edge: a menu gets no
 * `popuppositioned` (`nsXULPopupPositionedEvent::DispatchIfNeeded`), and a
 * resize observer is heard after layout and before the paint, so the path
 * is traced again in the same frame.
 *
 * @param {Event} event
 */
function onStemPopupShowing(event) {
  const popup = event.target;
  if (event.defaultPrevented || !popup.anchorNode) {
    return;
  }
  const root = stemRootOf(popup);
  if (!root) {
    return;
  }
  detachStem(popup);
  const win = popup.documentGlobal;
  const face = stemFaceOf(root).getBoundingClientRect();
  // Gecko places the popup under its anchor, which can sit inside the pill
  // (the downloads button's indicator, or the first child Gecko anchors to
  // for a button marked `delegatesanchor`, `MaybeDelegatedAnchorFrame`), and
  // the stem then starts lower.
  const anchorEl = popup.anchorNode.hasAttribute("delegatesanchor")
    ? (popup.anchorNode.firstElementChild ?? popup.anchorNode)
    : popup.anchorNode;
  const anchor = anchorEl.getBoundingClientRect();
  popup._svalStemRoot = root;
  popup.style.setProperty(
    "--sval-stem-drop",
    `${Math.max(0, face.bottom - anchor.bottom)}px`
  );
  popup.style.setProperty("--sval-stem-face-h", `${face.height}px`);
  popup.style.setProperty("--sval-stem-w", `${face.width}px`);
  root.style.setProperty(
    "--sval-stem-fill",
    win.getComputedStyle(popup).getPropertyValue("--panel-background-color")
  );
  keepAboveWindowFoot(popup, win, {
    top: win.mozInnerScreenY + face.bottom + STEM_FILLET,
  });
  popup.setAttribute("sval-stem", "");
  root.setAttribute("sval-stem", "");
  // Gecko places the popover's frame its top margin below the anchor, and
  // the margin reaches the shadow's room above the face. macOS keeps a
  // popup's window below the menu bar, at the screen's available top, and
  // moves the window down without moving its frame, so the stem would be
  // drawn that much below the face. The window gives up the room it has no
  // space for and opens where its frame stands.
  const windowTop =
    win.mozInnerScreenY +
    anchor.bottom +
    parseFloat(win.getComputedStyle(popup).marginTop);
  popup.style.setProperty(
    "--sval-stem-top-trim",
    `${Math.max(0, win.screen.availTop - windowTop)}px`
  );
  const part = stemOutlineOf(popup)
    ? popup.shadowRoot.querySelector('[part~="content"]')
    : null;
  if (part) {
    popup._svalStemObserver = new win.ResizeObserver(() =>
      placeStemOf(popup, true)
    );
    popup._svalStemObserver.observe(part);
  }
}

/**
 * `mousedown`: a press on a popover's window outside what it draws, its
 * content, its stem and the face it wraps, closes the popover, as a press
 * outside its window does.
 *
 * The window reaches past the content on every side by its shadow margin,
 * and above it over the button and its neighbours (`sval-header.css`,
 * panels). Windows and GTK let a press in the shadow margin through to the
 * window below (`nsWindow::SetInputRegion`), where Gecko rolls the popover
 * up (`nsXULPopupManager::Rollup`). macOS ignores the margin
 * (`nsCocoaWindow::SetInputRegion`), so there the press reaches the popover
 * itself and nothing rolls it up. A press on the button closes the popover
 * and never reaches the button, so it does not open it again. A `noautohide`
 * popover, which a press outside leaves open, closes only on the button.
 *
 * @param {MouseEvent} event
 */
function onStemPopupPress(event) {
  if (event.button !== 0) {
    return;
  }
  const popup = event.target.closest?.("panel, menupopup");
  const root = popup?._svalStemRoot;
  if (!root || popup.state !== "open") {
    return;
  }
  const win = root.documentGlobal;
  const hits = (rect, left, top) =>
    event.screenX >= left + rect.left &&
    event.screenX < left + rect.right &&
    event.screenY >= top + rect.top &&
    event.screenY < top + rect.bottom;
  const onButton = hits(
    root.getBoundingClientRect(),
    win.mozInnerScreenX,
    win.mozInnerScreenY
  );
  if (!onButton) {
    if (popup.hasAttribute("noautohide")) {
      return;
    }
    const box = popup.getOuterScreenRect();
    const frame = popup.getBoundingClientRect();
    const content = popup.shadowRoot
      ?.querySelector('[part~="content"]')
      ?.getBoundingClientRect();
    if (!content || hits(content, box.left - frame.left, box.top - frame.top)) {
      return;
    }
    const tab = popup._svalStemShape?.tab;
    if (tab && hits(tab, box.left, box.top)) {
      return;
    }
  }
  lazy.PanelMultiView.hidePopup(popup);
}

/**
 * Grows each popover in `win` from its button (messages spec §9.4).
 * `popupshowing` is heard as it bubbles, once the popup's own listeners have
 * had their chance to cancel it. The rest are captured, so the stem is in
 * place before any listener on the popup sees it shown.
 *
 * @param {Window} win A browser window.
 */
function attachPopovers(win) {
  win.addEventListener("popupshowing", onStemPopupShowing);
  win.addEventListener("mousedown", onStemPopupPress, true);
  for (const type of ["popupshown", "popuppositioned"]) {
    win.addEventListener(type, placeStem, true);
  }
  win.addEventListener(
    "popuphiding",
    event => {
      if (event.target._svalStemRoot) {
        detachStem(event.target);
      }
    },
    true
  );
}

/**
 * The history button: shows and hides Firefox's History sidebar, which holds
 * the search, the full history and the way to clear it. It is the sidebar's
 * own toggle (`SidebarController.toggle`), the one its shortcut runs.
 *
 * @param {Document} doc A browser window's document.
 * @returns {Element} the `toolbarbutton`.
 */
function buildHistoryButton(doc) {
  const button = doc.createXULElement("toolbarbutton");
  button.id = HISTORY_BUTTON_ID;
  button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
  button.setAttribute("label", "History");
  SvalShortcuts.keepDescribed(button, "key_gotoHistory", "History");
  button.addEventListener("command", () =>
    doc.defaultView.SidebarController.toggle("viewHistorySidebar").catch(err =>
      SvalLog.error(`could not show history: ${SvalLog.errorName(err)}`)
    )
  );
  return button;
}

/**
 * The split button, under the id of Firefox's own, whose address bar copy
 * Sval's header does not draw. Firefox's split view shows it while the
 * selected tab is in a split (`updateUrlbarButton` in `tabsplitview.js`),
 * and the toolbox's click and keypress handlers open the split-view menu
 * from it (`navigator-toolbox.js`).
 *
 * @param {Document} doc A browser window's document.
 * @returns {Element} the `toolbarbutton`.
 */
function buildSplitButton(doc) {
  const button = doc.createXULElement("toolbarbutton");
  button.id = SPLIT_BUTTON_ID;
  button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
  button.setAttribute("label", "Split View");
  button.setAttribute("tooltiptext", "Split view");
  button.hidden = true;
  return button;
}

/**
 * The translate cell, under the ids of Firefox's own button and its parts,
 * whose address bar copy Sval's header does not draw.
 * `FullPageTranslationsPanel` shows it while the page's language can be
 * translated to the person's or the page is translated, marks it
 * `translationsactive` while translated, shows the target language's code
 * or the loading arrows in it, and opens its panel on it; the toolbox's
 * click and keypress handlers open that panel from it
 * (`navigator-toolbox.js`).
 *
 * @param {Document} doc A browser window's document.
 * @returns {Element} the cell.
 */
function buildTranslateButton(doc) {
  const button = doc.createXULElement("hbox");
  button.id = TRANSLATE_BUTTON_ID;
  button.className = "chromeclass-toolbar-additional";
  button.setAttribute("role", "button");
  // Focusable for the toolbar's arrow keys (`ToolbarKeyboardNavigator`).
  button.setAttribute("tabindex", "-1");
  button.setAttribute("align", "center");
  doc.l10n.setAttributes(button, "urlbar-translations-button2");
  button.hidden = true;
  const icon = doc.createXULElement("image");
  icon.id = "translations-button-icon";
  const arrows = doc.createXULElement("image");
  arrows.id = "translations-button-circle-arrows";
  arrows.hidden = true;
  const locale = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  locale.id = "translations-button-locale";
  locale.setAttribute("aria-hidden", "true");
  locale.hidden = true;
  // The cell is the cluster's slice; the chip inside takes the hover and
  // pressed looks, as a toolbar button's icon does.
  const chip = doc.createXULElement("hbox");
  chip.className = "sval-translate-chip";
  chip.setAttribute("align", "center");
  chip.setAttribute("pack", "center");
  chip.append(icon, arrows, locale);
  button.append(chip);
  return button;
}

/**
 * The location button, which a location prompt opens from;
 * `SvalSiteControls.drawLocation` draws it and
 * `SvalSiteControls.activateLocation` answers a click or Enter.
 *
 * @param {Document} doc A browser window's document.
 * @returns {Element} the button.
 */
function buildLocationButton(doc) {
  const button = doc.createXULElement("hbox");
  button.id = LOCATION_BUTTON_ID;
  button.className = "chromeclass-toolbar-additional";
  button.setAttribute("overflows", "false");
  button.setAttribute("role", "button");
  // Focusable for the toolbar's arrow keys (`ToolbarKeyboardNavigator`).
  button.setAttribute("tabindex", "-1");
  button.setAttribute("align", "center");
  button.setAttribute("pack", "center");
  button.hidden = true;
  const activate = () => SvalSiteControls.activateLocation(doc.defaultView);
  button.addEventListener("click", activate);
  button.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

/**
 * The reader button, under the id of Firefox's own, whose address bar copy
 * Sval's header does not draw. `AboutReaderParent.updateReaderButton` shows
 * it for an article or a page in Reader View and marks it `readeractive`
 * there, and the toolbox's click and keypress handlers toggle Reader View
 * from it (`navigator-toolbox.js`).
 *
 * @param {Document} doc A browser window's document.
 * @returns {Element} the `toolbarbutton`.
 */
function buildReaderButton(doc) {
  const button = doc.createXULElement("toolbarbutton");
  button.id = READER_BUTTON_ID;
  button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
  button.setAttribute("label", "Reader View");
  button.hidden = true;
  // The user may remap the key in settings while the window is open.
  for (const type of ["mouseover", "focus"]) {
    button.addEventListener(type, () =>
      SvalShortcuts.describe(
        button,
        "key_toggleReaderMode",
        button.hasAttribute("readeractive")
          ? "Close Reader View"
          : "Enter Reader View"
      )
    );
  }
  return button;
}

/**
 * The placements the header wants, given the nav-bar's current ones: Sval's
 * widgets in order, then the extension buttons already there in their order,
 * and any widget Firefox will not let go of, then the extensions button and
 * the records.
 *
 * @param {string[]} current The nav-bar's widget ids.
 * @param {(id: string) => boolean} keep Whether a widget outside Sval's list
 *   stays: an extension's button, or one that cannot be removed.
 * @returns {string[]}
 */
export function headerPlacements(current, keep) {
  const kept = current.filter(
    id =>
      !HEADER_WIDGETS.includes(id) &&
      !RECORD_WIDGETS.includes(id) &&
      id !== EXTENSIONS_BUTTON_ID &&
      keep(id)
  );
  const extensions = current.includes(EXTENSIONS_BUTTON_ID)
    ? [EXTENSIONS_BUTTON_ID]
    : [];
  return [...HEADER_WIDGETS, ...kept, ...extensions, ...RECORD_WIDGETS];
}

/**
 * The host the address bar shows while it is not focused, or "" to show the
 * full address. Only web pages are shortened; a leading `www.` is dropped.
 *
 * @param {nsIURI} uri
 * @returns {string}
 */
export function displayDomain(uri) {
  if (!uri || !(uri.schemeIs("https") || uri.schemeIs("http"))) {
    return "";
  }
  try {
    return uri.displayHost.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * What the address bar shows of a web page's address after its host, while
 * the field is not focused: for `DISPLAY_PREF`'s "path" the path alone, for
 * "full" the rest of the address. A bare root is "".
 *
 * A site that routes inside the fragment, as the Azure portal and Gmail do,
 * has the bare root for its path, and its page's own path follows the `#`.
 * So "path" shows a fragment holding a `/` after a bare root, up to the
 * fragment's own `?`. An anchor such as `#top` holds none and stays hidden.
 *
 * `decoded` is the address as the field holds it (`UrlbarInput`'s
 * `untrimmedValue`), which Firefox's `losslessDecodeURI` makes from the
 * exposable URI. That decoding keeps `%23` and `%3F` encoded, so the first
 * `#` and `?` in it start the fragment and the query.
 *
 * @param {nsIURI} uri The page's exposable URI.
 * @param {string} decoded The field's address.
 * @param {"path"|"full"} mode
 * @returns {string}
 */
export function addressTail(uri, decoded, mode) {
  let prefix;
  try {
    prefix = `${uri.scheme}://${uri.displayHostPort}`;
  } catch {
    return "";
  }
  if (!decoded.startsWith(prefix)) {
    return "";
  }
  let tail = decoded.slice(prefix.length);
  if (mode === "path") {
    const path = tail.split(/[?#]/)[0];
    const hash = tail.indexOf("#");
    const route = hash < 0 ? "" : tail.slice(hash + 1).split("?")[0];
    tail = path === "/" && route.includes("/") ? `/#${route}` : path;
  }
  return tail === "/" ? "" : tail;
}

/**
 * Splits an address's tail into the pieces the address bar drops from the
 * left when it runs out of room, each starting at a `/`, `?`, `&` or `#`.
 *
 * @param {string} tail
 * @returns {string[]}
 */
export function tailChunks(tail) {
  return tail.split(/(?=[/?&#])/).filter(Boolean);
}

/**
 * Fits a shortened address into its label, whose host, tail and key cap are
 * a row the label clips. The key cap goes first, then whole pieces of the
 * tail from its left, down to no tail at all: a piece is never cut.
 *
 * @param {{label: Element, tail: Element, key: ?Element}} parts
 * @param {string[]} chunks The tail's pieces ({@link tailChunks}).
 */
export function fitAddress({ label, tail, key }, chunks) {
  // Each read after a write lays the window out again.
  const fits = text => {
    tail.textContent = text;
    return (
      tail.scrollWidth <= tail.clientWidth &&
      label.scrollWidth <= label.clientWidth
    );
  };
  const whole = chunks.join("");
  if (key) {
    key.hidden = !key.textContent;
    if (!key.hidden) {
      if (fits(whole)) {
        return;
      }
      key.hidden = true;
    }
  }
  if (fits(whole)) {
    return;
  }
  // Cut `i` drops the first `i` pieces; the last drops them all. Each cut
  // is narrower than the one before, so halving finds the first that fits.
  const cut = i =>
    i < chunks.length ? "\u2026" + chunks.slice(i).join("") : "";
  let low = 1;
  let high = chunks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (fits(cut(mid))) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  tail.textContent = cut(low);
}

/**
 * Draws the JavaScript button for the selected tab's host: `sval-js` is `on`
 * or `off`, mirrored in `aria-pressed`, and `sval-js-rule` marks a page a
 * rule decides, the host's own or one of a name above it. The look shows on or off alone; the tooltip,
 * and so the button's description, says whether a rule set it (header
 * signals spec §2). A page no rule can cover leaves the button disabled.
 * A private window can't change a rule either: a rule is saved and synced,
 * which would keep a record of the private visit. There the button is
 * `aria-disabled`, so it keeps its focus stop and the reason is heard, not
 * only shown on hover.
 *
 * @param {Window} win A browser window.
 */
function describeJavascript(win) {
  const button = win.document.getElementById(JAVASCRIPT_BUTTON_ID);
  if (!button) {
    return;
  }
  const scope = scopeForURI(win.gBrowser.currentURI);
  if (!scope) {
    button.setAttribute("disabled", "true");
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-pressed");
    button.removeAttribute("sval-js");
    button.removeAttribute("sval-js-rule");
    button.setAttribute("tooltiptext", "JavaScript (only on websites)");
    return;
  }
  const enabled = SvalJavascript.enabledFor(scope.host);
  const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const exception = !!lazy.mostSpecificRule(scope.host, name =>
    SvalJavascript.ruleFor(name)
  );
  const place = scope.choice ? scope.host : "this site";
  button.removeAttribute("disabled");
  if (isPrivate) {
    button.setAttribute("aria-disabled", "true");
  } else {
    button.removeAttribute("aria-disabled");
  }
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("sval-js", enabled ? "on" : "off");
  button.toggleAttribute("sval-js-rule", exception);
  const by = exception ? ` for ${place} by your rule` : "";
  const state = `JavaScript: ${enabled ? "on" : "off"}${by}`;
  let tip;
  if (isPrivate) {
    tip = `${state} (can't change in a private window)`;
  } else if (exception) {
    tip = `${state}. Click to turn it ${enabled ? "off" : "on"} and reload.`;
  } else {
    tip = `${state}. Click to turn it ${enabled ? "off" : "on"} for ${place} and reload.`;
  }
  button.setAttribute("tooltiptext", tip);
}

/**
 * Keeps a toggle's `aria-pressed` on the state it shows: the panel toggle's
 * on while the panel shows, the history button's while the History sidebar
 * does. Each reads the attributes the panel's slide and `SidebarController`
 * keep, so it follows every way the panel or the sidebar opens and closes.
 *
 * @param {Window} win A browser window.
 * @param {string} id The toggle's id.
 * @param {Element|null} source The element whose attributes carry the state.
 * @param {string[]} attributes Those attributes.
 * @param {(source: Element) => boolean} pressed The state they make.
 */
function mirrorPressed(win, id, source, attributes, pressed) {
  if (!source) {
    return;
  }
  mirror(win, source, attributes, () =>
    win.document
      .getElementById(id)
      ?.setAttribute("aria-pressed", String(pressed(source)))
  );
}

/**
 * Runs `update` now, and again whenever one of `source`'s `attributes`
 * changes, until the window unloads.
 *
 * @param {Window} win A browser window.
 * @param {Element} source
 * @param {string[]} attributes
 * @param {Function} update
 */
function mirror(win, source, attributes, update) {
  const observer = new win.MutationObserver(update);
  observer.observe(source, { attributeFilter: attributes });
  win.addEventListener("unload", () => observer.disconnect(), { once: true });
  update();
}

/**
 * The JavaScript button's command: turns script the other way for the
 * selected tab's host, as the site menu opens at it (host-scoped rules spec
 * §4), and reloads the tab, since a page reads the rule only
 * as it loads.
 *
 * @param {Window} win A browser window.
 */
function toggleJavascript(win) {
  const host = scopeForURI(win.gBrowser.currentURI)?.host;
  if (!host || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return;
  }
  SvalJavascript.setEnabled(host, !SvalJavascript.enabledFor(host));
  win.gBrowser.selectedBrowser.reload();
}

export const SvalHeader = {
  _initialized: false,
  _arranging: false,

  /**
   * Registers the panel toggle and holds the default theme, whose colours the
   * header replaces. Once per session, before the first window builds its
   * toolbars.
   */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    SvalThemes.start();
    SvalExtensionCompat.start();
    SvalUpdateDelay.start();
    SvalExtensionSites.start();
    CustomizableUI.createWidget({
      id: PANEL_BUTTON_ID,
      type: "button",
      label: "Workspaces",
      tooltiptext: "Show or hide Workspaces",
      removable: false,
      overflows: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        event.target.documentGlobal.SvalPanel?.toggleVisible();
      },
    });
    CustomizableUI.createWidget({
      id: JAVASCRIPT_BUTTON_ID,
      type: "button",
      label: "JavaScript",
      tooltiptext: "JavaScript",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        toggleJavascript(event.target.documentGlobal);
      },
    });
    CustomizableUI.createWidget({
      id: LIVE_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild(doc) {
        const item = doc.createXULElement("toolbaritem");
        item.id = LIVE_ID;
        item.className = "chromeclass-toolbar-additional";
        item.setAttribute("overflows", "false");
        item.setAttribute("role", "group");
        item.setAttribute("aria-label", "Devices");
        item.hidden = true;
        const cells = doc.createXULElement("hbox");
        cells.className = "sval-live-cells";
        // The cells each are a button (`drawLive`); the asks are one.
        const asks = doc.createXULElement("hbox");
        asks.className = "sval-live-asks";
        asks.setAttribute("role", "button");
        asks.setAttribute("tabindex", "0");
        item.append(cells, asks);
        const activate = event => {
          const keyboard = event.type === "keydown";
          const cell = event.target.closest?.(".sval-live-cell");
          if (cell) {
            SvalSiteControls.activateCell(
              doc.defaultView,
              cell.dataset.kind,
              keyboard
            );
          } else if (event.target.closest?.(".sval-live-asks")) {
            SvalSiteControls.activateLive(doc.defaultView, keyboard);
          }
        };
        item.addEventListener("click", activate);
        item.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate(event);
          }
        });
        return item;
      },
    });
    CustomizableUI.createWidget({
      id: LOCATION_BUTTON_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild: buildLocationButton,
    });
    CustomizableUI.createWidget({
      id: TRANSLATE_BUTTON_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild: buildTranslateButton,
    });
    CustomizableUI.createWidget({
      id: MEDIA_BUTTON_ID,
      type: "button",
      label: "Video and audio",
      tooltiptext: "Video and audio",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        SvalSiteControls.toggleMedia(event.target.documentGlobal);
      },
    });
    for (const [id, label, mode] of [
      [REMOVE_BUTTON_ID, MODE_NAMES.remove, "remove"],
      [SNIP_BUTTON_ID, MODE_NAMES.snip, "snip"],
    ]) {
      CustomizableUI.createWidget({
        id,
        type: "button",
        label,
        tooltiptext: label,
        removable: false,
        defaultArea: CustomizableUI.AREA_NAVBAR,
        onCommand(event) {
          SvalSiteControls.toggleMode(
            event.target.documentGlobal,
            mode,
            event.inputSource ===
              event.target.documentGlobal.MouseEvent.MOZ_SOURCE_KEYBOARD
          );
        },
      });
    }
    CustomizableUI.createWidget({
      id: COLORSHIFT_BUTTON_ID,
      type: "button",
      label: "Colorshift",
      tooltiptext: "Colorshift",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        const win = event.target.documentGlobal;
        SvalSiteControls.openColorshift(
          win,
          event.inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD
        );
      },
    });
    CustomizableUI.createWidget({
      id: SITE_MENU_BUTTON_ID,
      type: "button",
      label: "Site settings",
      tooltiptext: "Site settings",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        const win = event.target.documentGlobal;
        SvalSiteControls.openMenu(win, {
          focus: event.inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD,
        });
      },
    });
    CustomizableUI.createWidget({
      id: READER_BUTTON_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild: buildReaderButton,
    });
    CustomizableUI.createWidget({
      id: FAVORITE_BUTTON_ID,
      type: "button",
      label: "Favorite",
      tooltiptext: "Add to Favorites",
      removable: false,
      // A private window keeps nothing, so it offers no favorite to keep.
      onCreated(node) {
        node.hidden = lazy.PrivateBrowsingUtils.isWindowPrivate(
          node.documentGlobal
        );
      },
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        SvalFavorites.toggle(event.target.documentGlobal).catch(err =>
          SvalLog.error(
            `could not change a favorite: ${SvalLog.errorName(err)}`
          )
        );
      },
    });
    CustomizableUI.createWidget({
      id: SPLIT_BUTTON_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild: buildSplitButton,
    });
    CustomizableUI.createWidget({
      id: HISTORY_BUTTON_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild: buildHistoryButton,
    });
    CustomizableUI.createWidget({
      id: PRIVATE_BADGE_ID,
      type: "custom",
      removable: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onBuild(doc) {
        const item = doc.createXULElement("toolbaritem");
        item.id = PRIVATE_BADGE_ID;
        item.setAttribute("overflows", "false");
        item.setAttribute("align", "center");
        const icon = doc.createXULElement("image");
        icon.className = "sval-private-badge-icon";
        const label = doc.createXULElement("label");
        label.setAttribute("value", "Private");
        item.append(icon, label);
        return item;
      },
    });
    // Hidden until `SvalNoticesButton.update` finds a notice for its window.
    CustomizableUI.createWidget({
      id: NOTICES_BUTTON_ID,
      type: "button",
      label: "Notices",
      tooltiptext: "Notices",
      removable: false,
      overflows: false,
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCreated(node) {
        node.hidden = true;
      },
      onCommand(event) {
        const win = event.target.documentGlobal;
        SvalNoticesButton.open(win, {
          focus: event.inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD,
        });
      },
    });
    // Pinning an extension appends its button to the nav-bar's end;
    // arranging again puts it before the extensions button. A
    // header widget removed or moved is put back the same way, once the
    // change that notified has finished, since a move to another area
    // notifies its removal before it places the widget there.
    const arrangeLater = area => {
      if (area === CustomizableUI.AREA_NAVBAR && !this._arranging) {
        Services.tm.dispatchToMainThread(() => this.arrange());
      }
    };
    CustomizableUI.addListener({
      // Once the nav-bar is built, then for each widget put in it after.
      onAreaNodeRegistered: (area, target) => {
        if (area === CustomizableUI.AREA_NAVBAR) {
          for (const node of target.children) {
            markOverflow(node);
          }
        }
      },
      onWidgetAfterDOMChange: markOverflow,
      onWidgetAdded: (id, area) => {
        if (area === CustomizableUI.AREA_NAVBAR) {
          this.arrange();
        }
      },
      onWidgetRemoved: (id, area) => arrangeLater(area),
      onWidgetMoved: (id, area) => arrangeLater(area),
    });
  },

  /**
   * Puts the nav-bar's widgets into {@link headerPlacements}' order, moving
   * anything else to the palette. A no-op when they are already there.
   *
   * Only once a window has registered the nav-bar: `CustomizableUI` refuses
   * placements for an area it has not restored. The order persists, so only a
   * profile's first window, or one after a reset, draws Firefox's order first.
   */
  arrange() {
    const area = CustomizableUI.AREA_NAVBAR;
    if (this._arranging) {
      return;
    }
    let current;
    try {
      current = CustomizableUI.getWidgetIdsInArea(area);
    } catch {
      // Not restored yet; the first window's `startWindow` arranges it.
      return;
    }
    const wanted = headerPlacements(
      current,
      id =>
        CustomizableUI.isWebExtensionWidget(id) ||
        !CustomizableUI.isWidgetRemovable(id)
    );
    if (wanted.join() === current.join()) {
      return;
    }
    this._arranging = true;
    CustomizableUI.beginBatchUpdate();
    try {
      for (const id of current) {
        if (!wanted.includes(id)) {
          CustomizableUI.removeWidgetFromArea(id);
        }
      }
      wanted.forEach((id, position) =>
        CustomizableUI.addWidgetToArea(id, area, position)
      );
    } finally {
      CustomizableUI.endBatchUpdate();
      this._arranging = false;
    }
  },

  /**
   * `browser-window-before-initial-xul-layout`: the header's stylesheet, as an
   * additional author sheet for the reason `SvalWindow.mount` gives for the
   * panel's, customize mode's entry points closed, confirmation hints
   * anchored where the header draws them, and popovers grown from their
   * buttons.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    win.windowUtils.loadSheetUsingURIString(
      HEADER_CSS,
      win.windowUtils.AUTHOR_SHEET
    );
    this.init();
    SvalThemes.mount(win);
    const doc = win.document;
    doc
      .getElementById("cmd_CustomizeToolbars")
      ?.setAttribute("disabled", "true");
    for (const id of CUSTOMIZE_ENTRY_POINTS) {
      doc.getElementById(id)?.setAttribute("hidden", "true");
    }
    win.addEventListener("popupshowing", onToolbarContextMenuShowing);
    win.addEventListener("popupshowing", onViewMenuShowing);
    SvalReloadMenu.mount(win);
    attachPopovers(win);
    this.showMenuBar(doc);
  },

  /**
   * Shows the menu bar where it is drawn in the window, as a row above the
   * header, always: with no app menu button, it is where the browser's
   * commands are. macOS draws its menu bar natively, so there is nothing to
   * show.
   *
   * It is shown at every startup without persisting, over any `autohide` a
   * profile stored. Its name goes, as the bookmarks toolbar's does
   * (`SvalWindow`), so the toolbar context menu and View › Toolbars offer no
   * toggle to hide it: they list only toolbars carrying `toolbarname`, which
   * Fluent would set from the `data-l10n-id` `gBrowserInit` gives it.
   *
   * @param {Document} doc A browser window's document.
   */
  showMenuBar(doc) {
    if (Services.appinfo.nativeMenubar) {
      return;
    }
    const menubar = doc.getElementById("toolbar-menubar");
    if (!menubar) {
      return;
    }
    for (const name of ["data-l10n-id", "data-l10n-attrs", "toolbarname"]) {
      menubar.removeAttribute(name);
    }
    doc.defaultView.setToolbarVisibility(menubar, true, false);
  },

  /**
   * After the window's delayed startup: the header's widget order, the
   * favorite button's state, the address field's loading line, the translations panel's anchor, and the
   * shortened address display.
   *
   * The address field keeps the full address, so screen readers, copy and
   * editing all see it; an `aria-hidden` label drawn over the field shows the
   * host, and the tail after it that `DISPLAY_PREF` asks for, while the field is not
   * focused, and `sval-header.css` hides the field's text under it.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    this.arrange();
    SvalFavorites.startWindow(win);
    SvalProtectionButton.startWindow(win);
    SvalSiteControls.startWindow(win);
    SvalLoadLine.startWindow(win);
    SvalSiteStylePanel.startWindow(win);
    SvalNoticesButton.startWindow(win);
    SvalExtensionNotices.startWindow(win);
    const doc = win.document;
    // The toggle names its key as the user sees it, which settings can
    // change while the window is open.
    const panelButton = doc.getElementById(PANEL_BUTTON_ID);
    if (panelButton) {
      SvalShortcuts.describeToggle(panelButton);
      for (const type of ["mouseover", "focus"]) {
        panelButton.addEventListener(type, () =>
          SvalShortcuts.describeToggle(panelButton)
        );
      }
    }
    mirrorPressed(
      win,
      PANEL_BUTTON_ID,
      doc.getElementById("sval-panel-container"),
      ["hidden", "sval-collapsed"],
      panel => !panel.hidden && !panel.hasAttribute("sval-collapsed")
    );
    // The View menu's item, which `SidebarController.selectMenuItem` checks
    // while the History sidebar shows.
    mirrorPressed(
      win,
      HISTORY_BUTTON_ID,
      doc.getElementById("menu_historySidebar"),
      ["checked"],
      item => item.getAttribute("checked") === "true"
    );
    const { gBrowser, gURLBar } = win;
    const box = gURLBar.querySelector(".urlbar-input-box");
    if (!box) {
      return;
    }
    const html = "http://www.w3.org/1999/xhtml";
    const label = doc.createElementNS(html, "span");
    label.id = "sval-urlbar-domain";
    label.setAttribute("aria-hidden", "true");
    const hostEl = doc.createElementNS(html, "span");
    hostEl.className = "sval-urlbar-host";
    const hostText = doc.createElementNS(html, "bdi");
    hostText.dir = "ltr";
    hostEl.append(hostText);
    const tailEl = doc.createElementNS(html, "span");
    tailEl.className = "sval-urlbar-tail";
    // The Launcher's key, which `SvalLauncher` writes.
    const keyEl = doc.createElementNS(html, "kbd");
    keyEl.id = URLBAR_KEY_ID;
    keyEl.className = "sval-keycap";
    keyEl.textContent = lazy.launcherKeyText(doc);
    label.append(hostEl, tailEl, keyEl);
    box.append(label);

    // A label that is not shown measures nothing, so the resize observer
    // fits it again once it shows. Its width, host, tail and key cap decide
    // a fit, which lays the window out for each candidate it measures, so a
    // fit none of them changed for is skipped. The width is the one the
    // resize observer reported, which reads no layout.
    let chunks = [];
    let room = 0;
    let fitted = null;
    const fit = () => {
      const inputs = JSON.stringify([
        room,
        hostEl.textContent,
        keyEl.textContent,
        chunks,
      ]);
      if (inputs === fitted) {
        return;
      }
      fitted = inputs;
      fitAddress({ label, tail: tailEl, key: keyEl }, chunks);
    };
    new win.MutationObserver(fit).observe(keyEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const showLabel = () => {
      const mode = Services.prefs.getStringPref(DISPLAY_PREF, "domain");
      let uri = gBrowser.currentURI;
      try {
        uri = Services.io.createExposableURI(uri);
      } catch {}
      const host = displayDomain(uri);
      hostText.textContent = host;
      chunks =
        host && mode !== "domain"
          ? tailChunks(addressTail(uri, gURLBar.untrimmedValue ?? "", mode))
          : [];
      fit();
      gURLBar.toggleAttribute("sval-domain-only", !!host);
    };
    const update = () => {
      showLabel();
      describeJavascript(win);
    };
    const resized = new win.ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === label) {
          room = entry.contentRect.width;
        }
      }
      fit();
    });
    resized.observe(label);
    // `UrlbarInput.setURI` fires this once the field holds the address the
    // tail is read from.
    gURLBar.inputField.addEventListener("SetURI", showLabel);
    // A tab switch calls this too (`tabbrowser.updateCurrentBrowser`).
    const listener = {
      onLocationChange: update,
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };
    gBrowser.addProgressListener(listener);
    Services.prefs.addObserver(DISPLAY_PREF, showLabel);
    // The rules as the policy holds them, which it does only once
    // `SvalJavascript` has applied the branch.
    Services.obs.addObserver(update, APPLIED_TOPIC);
    Services.prefs.addObserver(ENABLED_PREF, update);
    win.addEventListener(
      "unload",
      () => {
        resized.disconnect();
        Services.prefs.removeObserver(DISPLAY_PREF, showLabel);
        Services.obs.removeObserver(update, APPLIED_TOPIC);
        Services.prefs.removeObserver(ENABLED_PREF, update);
        gBrowser.removeProgressListener(listener);
      },
      { once: true }
    );
    update();
  },
};
