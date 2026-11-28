/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Draws Firefox's own pages in Sval's design. Each page in {@link PAGES}
 * takes `sval-page.css`, which sets Firefox's design tokens to Sval's values,
 * then a sheet of its own for what the tokens do not reach.
 *
 * One window actor carries both sheets into the page, in whichever process
 * the page runs: the parent's pages (about:addons) and the content
 * processes' (an error page, about:reader) alike. Its child loads them as
 * author sheets when the page's root element is inserted, before the first
 * paint. An additional author sheet comes after the page's own sheets in the
 * cascade, and Firefox declares its tokens in cascade layers, so Sval's
 * unlayered values win without `!important` and without editing the page.
 * An actor's `matches` is tested against the document's own address
 * (`JSWindowActorProtocol::Matches`), so an error page matches as
 * `about:neterror` whatever site failed.
 *
 * To restyle another page, add its address and a sheet under `pages/` to
 * {@link PAGES}, and the sheet to `jar.mn`.
 *
 * A document's author sheets do not reach into a component's shadow tree,
 * and a part a component draws with fixed colours rather than tokens stays
 * Firefox's. A page with such parts also takes a sheet in
 * {@link SHADOW_SHEETS}, which the child loads as a user sheet: user rules
 * match in shadow trees (`RuleCollector::collect_user_rules`), and its
 * `!important` declarations win over the component's own.
 */

const ACTOR = "SvalPageStyle";

/** The sheet every page takes: Firefox's tokens at Sval's values. */
export const PAGE_SHEET = "chrome://browser/content/sval/sval-page.css";

const PAGES_DIR = "chrome://browser/content/sval/pages";

/**
 * The sheet Firefox's information and tool pages share. A page with parts
 * of its own takes a sheet that imports it.
 */
const INFO_SHEET = `${PAGES_DIR}/info.css`;

/**
 * Firefox's dialogs that open as windows of their own, where `SubDialog`'s
 * frame does not reach (`styleDialog`). Each takes Sval's dialog palette on
 * a window the system frames.
 */
const WINDOW_DIALOGS = [
  "chrome://browser/content/pageinfo/pageInfo.xhtml",
  "chrome://browser/content/safeMode.xhtml",
  "chrome://browser/content/setDesktopBackground.xhtml",
  "chrome://mozapps/content/downloads/unknownContentType.xhtml",
  "chrome://pippki/content/changepassword.xhtml",
  "chrome://pippki/content/deletecert.xhtml",
  "chrome://pippki/content/downloadcert.xhtml",
  "chrome://pippki/content/editcacert.xhtml",
  "chrome://pippki/content/exceptionDialog.xhtml",
  "chrome://pippki/content/load_device.xhtml",
  "chrome://pippki/content/protectedAuth.xhtml",
  "chrome://pippki/content/setp12password.xhtml",
];

/** The sheet every dialog in {@link WINDOW_DIALOGS} takes. */
const WINDOW_DIALOG_SHEET = `${PAGES_DIR}/window-dialog.css`;

/**
 * Each restyled page's address, without query or fragment, and its own
 * sheet.
 *
 * @type {Map<string, string>}
 */
export const PAGES = new Map([
  ...WINDOW_DIALOGS.map(page => [page, WINDOW_DIALOG_SHEET]),
  [
    "chrome://mozapps/content/update/updateElevation.xhtml",
    `${PAGES_DIR}/update-elevation.css`,
  ],
  ["about:about", INFO_SHEET],
  ["about:addons", `${PAGES_DIR}/addons.css`],
  ["about:agentblocked", `${PAGES_DIR}/error-pages.css`],
  ["about:blocked", `${PAGES_DIR}/blocked.css`],
  ["about:buildconfig", INFO_SHEET],
  ["about:cache", INFO_SHEET],
  ["about:cache-entry", INFO_SHEET],
  ["about:certerror", `${PAGES_DIR}/error-pages.css`],
  ["about:certificate", INFO_SHEET],
  ["about:compat", `${PAGES_DIR}/compat.css`],
  ["about:config", INFO_SHEET],
  ["about:crashes", INFO_SHEET],
  ["about:debugging", `${PAGES_DIR}/devtools.css`],
  ["about:downloads", `${PAGES_DIR}/downloads.css`],
  ["about:framecrashed", `${PAGES_DIR}/error-pages.css`],
  ["about:httpsonlyerror", `${PAGES_DIR}/error-pages.css`],
  ["about:license", `${PAGES_DIR}/license.css`],
  ["about:logging", INFO_SHEET],
  ["about:memory", INFO_SHEET],
  ["about:neterror", `${PAGES_DIR}/error-pages.css`],
  ["about:networking", INFO_SHEET],
  ["about:opentabs", `${PAGES_DIR}/opentabs.css`],
  ["about:policies", INFO_SHEET],
  ["about:processes", INFO_SHEET],
  ["about:reader", `${PAGES_DIR}/reader.css`],
  ["about:restartrequired", `${PAGES_DIR}/error-pages.css`],
  ["about:restricted", `${PAGES_DIR}/error-pages.css`],
  ["about:serviceworkers", INFO_SHEET],
  ["about:support", `${PAGES_DIR}/support.css`],
  ["about:tabcrashed", `${PAGES_DIR}/error-pages.css`],
  ["about:third-party", INFO_SHEET],
  ["about:translations", INFO_SHEET],
  ["about:url-classifier", INFO_SHEET],
  ["about:webauthn", INFO_SHEET],
  ["about:webrtc", INFO_SHEET],
  ["about:windows-messages", INFO_SHEET],
]);

/**
 * Each page whose components' shadow trees take a user sheet, and that
 * sheet.
 *
 * @type {Map<string, string>}
 */
export const SHADOW_SHEETS = new Map([
  ["about:certificate", `${PAGES_DIR}/certificate-shadow.css`],
  ["about:opentabs", `${PAGES_DIR}/opentabs-shadow.css`],
]);

/**
 * The page `url` shows. An about: page's name is matched in lower case, as
 * `NS_GetAboutModuleName` matches it; a chrome: path keeps its case.
 *
 * @param {string} url
 * @returns {string}
 */
function pageOf(url) {
  const page = String(url ?? "").replace(/[?#].*$/, "");
  return /^about:/i.test(page) ? page.toLowerCase() : page;
}

/**
 * The user sheet a document at `url` takes for its shadow trees, if any.
 *
 * @param {string} url A document's address.
 * @returns {string[]}
 */
export function shadowSheetsFor(url) {
  const sheet = SHADOW_SHEETS.get(pageOf(url));
  return sheet ? [sheet] : [];
}

/**
 * The sheets a document at `url` takes, in order, or none.
 *
 * @param {string} url A document's address.
 * @returns {string[]}
 */
export function sheetsFor(url) {
  const own = PAGES.get(pageOf(url));
  return own ? [PAGE_SHEET, own] : [];
}

/**
 * The sheets every Firefox dialog in a modal box takes, in order: the page
 * sheet for Firefox's components, Sval's dialog frame with its palettes, and
 * Firefox's tokens and parts set to that frame.
 */
const DIALOG_SHEETS = [
  PAGE_SHEET,
  "chrome://browser/content/sval/sval-dialog.css",
  `${PAGES_DIR}/dialog.css`,
];

/** Each dialog with parts of its own, and its sheet. */
const DIALOG_PAGES = new Map([
  [
    "chrome://global/content/commonDialog.xhtml",
    `${PAGES_DIR}/common-dialog.css`,
  ],
  [
    "chrome://mozapps/content/update/history.xhtml",
    `${PAGES_DIR}/update-history.css`,
  ],
  [
    "chrome://browser/content/screenshots/screenshots-preview.html",
    `${PAGES_DIR}/screenshots-preview.css`,
  ],
]);

/**
 * Each dialog whose components' shadow trees take a user sheet, and that
 * sheet, as {@link SHADOW_SHEETS} gives a page's.
 */
const DIALOG_SHADOW_SHEETS = new Map([
  [
    "chrome://browser/content/screenshots/screenshots-preview.html",
    `${PAGES_DIR}/screenshots-preview-shadow.css`,
  ],
]);

/**
 * Sval's own dialogs, which draw Sval's dialog frame themselves.
 */
const OWN_DIALOGS = "chrome://browser/content/sval/";

/**
 * The script that fits a page wearing `sval-dialog.css` to its box.
 */
const FRAME_SCRIPT = "chrome://browser/content/sval/sval-dialog-frame.js";

/**
 * The sheets a dialog at `url` takes, in order, or none.
 *
 * @param {string} url A dialog document's address.
 * @returns {string[]}
 */
export function dialogSheetsFor(url) {
  const page = pageOf(url);
  if (page.startsWith(OWN_DIALOGS)) {
    return [];
  }
  const own = DIALOG_PAGES.get(page);
  return own ? [...DIALOG_SHEETS, own] : DIALOG_SHEETS;
}

/**
 * Dresses a dialog `SubDialog` has loaded in Sval's dialog frame, whichever
 * box it is in: Settings', a window's or a tab's. Every Firefox dialog
 * comes through here, so one that is not listed anywhere still looks like
 * Sval's. A `Services.prompt` question in a box is Sval's own prompt page
 * (`prompt-dialog.xhtml`, prompt-sval-dialog.patch).
 * Called from `SubDialog._onContentLoaded`, where Firefox injects its own
 * sheets, before the box is shown.
 *
 * Sval's own dialogs draw their card as `sval-dialog`, which fits the box
 * itself, and take none of Firefox's sheets: `SubDialog` injects
 * `in-content/common.css` into a dialog only where this returns false.
 *
 * @param {Element} frame The box's `dialogFrame`.
 * @returns {boolean} Whether the dialog is one of Sval's own.
 */
export function styleDialog(frame) {
  const win = frame.contentWindow;
  if (pageOf(win.document.documentURI).startsWith(OWN_DIALOGS)) {
    return true;
  }
  const sheets = dialogSheetsFor(win.document.documentURI);
  if (!sheets.length) {
    return false;
  }
  const utils = win.windowUtils;
  for (const sheet of sheets) {
    utils.loadSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
  }
  const shadowSheet = DIALOG_SHADOW_SHEETS.get(
    pageOf(win.document.documentURI)
  );
  if (shadowSheet) {
    utils.loadSheetUsingURIString(shadowSheet, utils.USER_SHEET);
  }
  Services.scriptloader.loadSubScript(FRAME_SCRIPT, win);
  return false;
}

let registered = false;

export const SvalPageStyle = {
  /**
   * Registers the actor. Called once, at `browser-before-ui-startup`, before
   * any page can load.
   */
  registerActor() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalPageStyleChild.sys.mjs",
        events: { DOMDocElementInserted: { capture: true } },
      },
      matches: [...PAGES.keys()].flatMap(page => [
        page,
        `${page}?*`,
        `${page}#*`,
      ]),
      allFrames: true,
      includeChrome: true,
    });
  },
};
