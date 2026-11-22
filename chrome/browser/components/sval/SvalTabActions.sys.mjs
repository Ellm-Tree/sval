/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What a tab's menu and the Launcher do to a tab beyond the panel's own
 * document: copy its address, clean or as it is, or its page as a Markdown
 * link, unload it, and keep it loaded.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
});

/**
 * A Markdown inline link to `url`, its text `title`.
 *
 * A backslash and a bracket in the title are escaped, since either would end
 * or break the link text (CommonMark §6.3). The destination's parentheses
 * are percent-encoded, which leaves the address the same and keeps a `)` from
 * closing the link early. A page with no title links its address as text.
 *
 * @param {string} title
 * @param {string} url
 * @returns {string}
 */
export function markdownLink(title, url) {
  const text = (title || url).replace(/[\\[\]]/g, "\\$&");
  const destination = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${text}](${destination})`;
}

/**
 * Copies `tab`'s page as a Markdown link. A tab restored lazily has no page
 * loaded, and tabbrowser answers its `currentURI` from the session
 * (`SessionStore.getLazyTabValue`), so it copies the same link as a loaded one.
 *
 * The address is the one Copy address copies: `createExposableURI` drops the
 * credentials in it.
 *
 * @param {object} tab A Firefox tab.
 */
export function copyMarkdownLink(tab) {
  const url = Services.io.createExposableURI(tab.linkedBrowser.currentURI).spec;
  Cc["@mozilla.org/widget/clipboardhelper;1"]
    .getService(Ci.nsIClipboardHelper)
    .copyString(markdownLink(tab.label, url));
}

/**
 * The address `uri` without the tracking parameters Firefox's strip-on-share
 * lists name (`nsIURLQueryStringStripper.stripForCopyOrShare`), which take in
 * Mozilla's query-stripping lists and the blocking lists' `$removeparam`
 * rules (`SvalBlocking`). A parameter no list names stays, and so does a
 * nested address's, which the stripper cleans in turn.
 *
 * @param {nsIURI} uri
 * @returns {?nsIURI} Null where no parameter is stripped.
 */
export function cleanAddressOf(uri) {
  try {
    return Cc["@mozilla.org/url-query-string-stripper;1"]
      .getService(Ci.nsIURLQueryStringStripper)
      .stripForCopyOrShare(uri);
  } catch {
    // An address with a query and no host, like a `data:` one, has nothing
    // to strip: the stripper throws reading its host.
    return null;
  }
}

/**
 * Copies `uri`'s address, without the credentials in it
 * (`createExposableURI`), and confirms it with `doneId` in Firefox's
 * `ConfirmationHint` on the address bar, as Sval confirms a favorite
 * (`SvalFavorites`). With the header hidden, the hint opens where
 * `ConfirmationHint.show` puts it with no anchor.
 *
 * @param {Window} win A browser window.
 * @param {string} spec
 * @param {string} doneId The hint's string in `launcher.ftl`.
 */
function copyAndConfirm(win, spec, doneId) {
  Cc["@mozilla.org/widget/clipboardhelper;1"]
    .getService(Ci.nsIClipboardHelper)
    .copyString(spec);
  const anchor = win.document.getElementById("urlbar-container");
  win.MozXULElement.insertFTLIfNeeded("sval/launcher.ftl");
  win.ConfirmationHint.show(anchor?.checkVisibility() ? anchor : null, doneId);
}

/**
 * Copies the address of the page `win` shows (`copyAndConfirm`).
 *
 * @param {Window} win A browser window.
 */
export function copyAddress(win) {
  const uri = win.gBrowser.currentURI;
  if (!uri?.spec) {
    return;
  }
  copyAndConfirm(
    win,
    Services.io.createExposableURI(uri).spec,
    "launcher-command-copy-address-done"
  );
}

/**
 * Copies the address of the page `win` shows without its tracking
 * parameters (`cleanAddressOf`). The hint says whether any came off.
 *
 * @param {Window} win A browser window.
 */
export function copyCleanAddress(win) {
  const uri = win.gBrowser.currentURI;
  if (!uri?.spec) {
    return;
  }
  const exposable = Services.io.createExposableURI(uri);
  const clean = cleanAddressOf(exposable);
  copyAndConfirm(
    win,
    (clean ?? exposable).spec,
    clean
      ? "launcher-command-copy-clean-address-done"
      : "launcher-command-copy-address-done"
  );
}

/**
 * Whether `tab` has a page to unload and the user lets it go. A tab restored
 * lazily or already unloaded has no `linkedPanel`, which is how
 * `explicitUnloadTabs` tells the unloaded tabs apart, and a tab kept loaded
 * ({@link isKeptLoaded}) stays loaded until the user lets it unload.
 *
 * @param {object} tab A Firefox tab.
 * @returns {boolean}
 */
export function canUnload(tab) {
  return !!tab.linkedPanel && !isKeptLoaded(tab);
}

/**
 * Unloads the loaded ones of `tabs` through Firefox's Unload Tab
 * (`gBrowser.explicitUnloadTabs`), which asks a page with unsaved input
 * before it goes and selects another tab first if the selected one is among
 * them. Each tab keeps its place and loads again when it is selected.
 *
 * @param {Window} win The window holding `tabs`.
 * @param {object[]} tabs Firefox tabs.
 * @returns {Promise<void>}
 */
export function unloadTabs(win, tabs) {
  const loaded = tabs.filter(canUnload);
  return loaded.length ? win.gBrowser.explicitUnloadTabs(loaded) : undefined;
}

/**
 * Whether `tab` is kept loaded: Firefox's `undiscardable` mark, which its
 * memory unloader honours (`isNonDiscardable` in `TabUnloader.sys.mjs`) and
 * an extension sets through `tabs.update({ autoDiscardable: false })`. Sval
 * keeps such a tab loaded while its Workspace is hidden too
 * (`SvalFirefox.mustStayLoaded`).
 *
 * @param {object} tab A Firefox tab.
 * @returns {boolean}
 */
export function isKeptLoaded(tab) {
  return tab.undiscardable;
}

/**
 * Marks `tab` kept loaded, loading it if it is unloaded, or clears the mark.
 *
 * An unloaded tab loads its page without being selected. Inserting its
 * browser (`gBrowser._insertBrowser`) has session store put its history in
 * place and leave it pending, and session store restores the page itself on
 * a reload that comes once `SSTabRestoring` has fired
 * (`onHistoryReload` in `SessionStore._restoreHistory`).
 *
 * @param {object} tab A Firefox tab.
 * @param {boolean} keep
 */
export function setKeptLoaded(tab, keep) {
  tab.undiscardable = keep;
  if (!keep || !lazy.SvalFirefox.isLazy(tab)) {
    return;
  }
  const reload = () => tab.linkedBrowser.reload();
  tab.addEventListener("SSTabRestoring", reload, { once: true });
  lazy.SvalFirefox.insertBrowser(tab.documentGlobal, tab);
  if (!lazy.SvalFirefox.isRestoring(tab)) {
    tab.removeEventListener("SSTabRestoring", reload);
  }
}
