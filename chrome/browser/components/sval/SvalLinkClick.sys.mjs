/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A click on a link that opens in a Quick Peek, read in the page and loaded in the
 * parent as Firefox's `ClickHandlerChild` and `ClickHandlerParent` read and
 * load one: a pin's page's (`SvalPinChild`), and the Quick Peek's own click, which
 * reaches the parent through `ClickHandlerChild` (`SvalQuickPeek.openClick`).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

/**
 * The link a click in a page is on, as `ClickHandlerChild` finds it: none
 * for text being edited or a blocked page's own links, and none for an
 * address the page's principal may not load itself, since what the page may
 * not load it may not Quick Peek at either.
 *
 * @param {MouseEvent} event A trusted click.
 * @returns {{href: string, node: Element|null, doc: Document}|null}
 */
export function linkOfClick(event) {
  const target = event.composedTarget;
  const doc = target?.ownerDocument;
  if (
    !doc ||
    target.isContentEditable ||
    doc.designMode === "on" ||
    ["HTMLInputElement", "HTMLTextAreaElement"].includes(
      ChromeUtils.getClassName(target)
    ) ||
    doc.documentURI.startsWith("about:blocked")
  ) {
    return null;
  }
  const [href, node, principal] =
    lazy.BrowserUtils.hrefAndLinkNodeForClickEvent(event) ?? [];
  if (!href || Services.io.extractScheme(href) === "javascript") {
    return null;
  }
  try {
    Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
      principal,
      href
    );
  } catch {
    return null;
  }
  return { href, node: node ?? null, doc };
}

/**
 * What a child sends the parent for a link `linkOfClick` found: its address,
 * and the referrer and policy container of the document the link is in,
 * serialized.
 *
 * @param {{href: string, node: Element|null, doc: Document}} link
 * @returns {{href: string, referrerInfo: string, policyContainer: string|null}}
 */
export function linkMessage({ href, node, doc }) {
  const linkDoc = node?.ownerDocument ?? doc;
  const referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(
    Ci.nsIReferrerInfo
  );
  if (node) {
    referrerInfo.initWithElement(node);
  } else {
    referrerInfo.initWithDocument(linkDoc);
  }
  const { policyContainer } = linkDoc;
  return {
    href,
    referrerInfo: lazy.E10SUtils.serializeReferrerInfo(referrerInfo),
    policyContainer: policyContainer
      ? lazy.E10SUtils.serializePolicyContainer(policyContainer)
      : null,
  };
}

/**
 * The load a parent opens for a `linkMessage`, deserialized for {@link loadOf}.
 *
 * @param {WindowGlobalParent} wgp The global of the document the click was in.
 * @param {object} data A `linkMessage`.
 * @returns {object|null} the load, or null when the document may not load
 *   the address.
 */
export function linkLoad(wgp, data) {
  if (typeof data?.href !== "string") {
    return null;
  }
  return loadOf(wgp, {
    href: data.href,
    referrerInfo: lazy.E10SUtils.deserializeReferrerInfo(data.referrerInfo),
    policyContainer: data.policyContainer
      ? lazy.E10SUtils.deserializePolicyContainer(data.policyContainer)
      : null,
  });
}

/**
 * The load a parent opens for a link in a document: the address, checked
 * here, and the principals and process from the parent's own record of the
 * document, as `ClickHandlerParent` reads them.
 *
 * @param {WindowGlobalParent} wgp The global of the document the link is in.
 * @param {object} link
 * @param {string} link.href
 * @param {nsIReferrerInfo} link.referrerInfo
 * @param {nsIPolicyContainer|null} link.policyContainer
 * @returns {object|null} the load, or null when the document may not load
 *   the address.
 */
export function loadOf(wgp, { href, referrerInfo, policyContainer }) {
  try {
    Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
      wgp.documentPrincipal,
      href
    );
  } catch {
    return null;
  }
  return {
    href,
    triggeringPrincipal: wgp.documentPrincipal,
    originPrincipal: wgp.documentPrincipal,
    originStoragePrincipal: wgp.documentStoragePrincipal,
    triggeringRemoteType: wgp.domProcess?.remoteType,
    referrerInfo,
    policyContainer,
  };
}
