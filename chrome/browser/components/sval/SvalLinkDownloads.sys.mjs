/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A link from another app whose address is a file to download (link
 * routing spec §4): the file goes to Firefox's downloads, announced in an ordinary
 * window's header, and no peek or empty tab is left behind.
 *
 * Only the response says for sure whether a load is a download: Gecko hands
 * a top-level load it will not show to the external helper app service
 * (`nsDocumentOpenInfo::DispatchContent`), which makes it a download whose
 * source names the browsing context it was loading in
 * (`DownloadLegacyTransfer`). Two checks follow from that:
 *
 * - Before a peek opens, {@link rendersInline} asks Gecko about the type of
 *   the address's file extension, and a link to a type Gecko would not show
 *   opens in an ordinary window instead, so it never flashes a peek.
 * - When a download starts, {@link handOver} closes the peek, or the tab Sval
 *   opened for the link, whose first load became it. Gecko closes such a
 *   window itself only when it has an opener to fall back to
 *   (`MaybeCloseWindowHelper::ChooseNewBrowsingContext`), which a link from
 *   another app never has.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
});
XPCOMUtils.defineLazyServiceGetters(lazy, {
  mime: ["@mozilla.org/mime;1", Ci.nsIMIMEService],
  streamConverters: [
    "@mozilla.org/streamConverters;1",
    Ci.nsIStreamConverterService,
  ],
  webNavigationInfo: [
    "@mozilla.org/webnavigation-info;1",
    Ci.nsIWebNavigationInfo,
  ],
});

/**
 * The browsers of the tabs Sval opened in an ordinary window for a link from
 * another app.
 *
 * @type {WeakSet<Element>}
 */
const openedForLinks = new WeakSet();

/**
 * Whether Gecko would show a page of the type the address's file extension
 * names, as `nsDocumentOpenInfo::DispatchContent` decides for a response of
 * that type: a document viewer takes it (`nsWebNavigationInfo`), or a stream
 * converter turns it into one, as pdf.js does for a PDF. An address with no
 * extension, or one the MIME service has no type for, is left to its
 * response.
 *
 * @param {nsIURI} uri
 * @returns {boolean}
 */
export function rendersInline(uri) {
  let type;
  try {
    type = lazy.mime.getTypeFromURI(uri);
  } catch {
    return true;
  }
  return (
    lazy.webNavigationInfo.isTypeSupported(type) !==
      Ci.nsIWebNavigationInfo.UNSUPPORTED ||
    lazy.streamConverters.canConvert(type, "*/*")
  );
}

/**
 * Notes a tab opened in an ordinary window for a link from another app, from
 * the browsing context `nsIBrowserDOMWindow.openURI` answers.
 *
 * @param {BrowsingContext|null} context
 */
export function opened(context) {
  const browser = context?.embedderElement;
  if (browser) {
    openedForLinks.add(browser);
  }
}

/**
 * As a download starts, before the Downloads panel announces it: the peek
 * whose first load became `download` closes, and an ordinary window is
 * brought to the front for the announcement; a tab Sval opened for a link
 * from another app whose first load became it closes. A peek or tab that has
 * shown a page stays: the download is that page's.
 *
 * @param {object} download
 * @returns {Promise<void>|null} What the announcement waits for, or null when
 *   it goes ahead at once.
 */
export function handOver(download) {
  const id = download.source?.browsingContextId;
  const top = id ? BrowsingContext.get(id)?.top : null;
  const browser = top?.embedderElement;
  const win = top?.topChromeWindow;
  const tab = browser && win?.gBrowser?.getTabForBrowser(browser);
  // A tab is still busy with the load that became the download as the
  // download starts, so `isEmpty` says no: what tells is that it has
  // committed no page, and holds the initial `about:blank`.
  if (
    !tab ||
    browser.currentURI.spec !== "about:blank" ||
    browser.canGoBack ||
    browser.canGoForward
  ) {
    return null;
  }
  if (lazy.SvalPeek.isPeek(win)) {
    return lazy.SvalPeek.handOver(win, download);
  }
  if (openedForLinks.has(browser)) {
    win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
  }
  return null;
}

export const SvalLinkDownloads = { rendersInline, opened, handOver };
