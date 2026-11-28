/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalBlockingLists } from "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs";
import {
  SvalPageRules,
  MAX_GENERIC_NAMES as MAX_NAMES,
} from "moz-src:///browser/components/sval/SvalPageRules.sys.mjs";
import { SvalKeepLinks } from "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs";
import {
  lookShownIn,
  paintWith,
  showIn,
  styleMessage,
} from "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs";

/**
 * @param {?nsIURI} uri
 * @returns {boolean}
 */
function isWeb(uri) {
  return !!uri && (uri.schemeIs("http") || uri.schemeIs("https"));
}

/**
 * The web origin a document runs as: its own principal, or for one without
 * an origin of its own the principal that made it.
 *
 * @param {?nsIPrincipal} principal
 * @returns {?nsIPrincipal} null for a privileged or opaque origin.
 */
function webPrincipal(principal) {
  if (principal?.isNullPrincipal) {
    principal = principal.precursorPrincipal;
  }
  return principal?.isContentPrincipal && isWeb(principal.URI)
    ? principal
    : null;
}

/**
 * Whether the site of a document's top window has protections off, or the top
 * window has no web origin to judge.
 *
 * A frame copies the answer Gecko computed for its top document into its own
 * cookie jar settings, the one ChannelClassifierUtils::IsAllowListed gives its
 * requests, and a top document has it when it loaded from the web. A top
 * document without a web address, a popup's about:blank or a blob: page, takes
 * none from the page that made it (Document::CookieJarSettings), so the
 * allow-list principal Gecko keeps for it (WindowGlobalParent::Init) is
 * checked the way ContentBlockingAllowList::Check checks a loading page's
 * address.
 *
 * @param {WindowGlobalParent} windowGlobal The document asking: a top document
 *   or one of its frames.
 * @returns {boolean}
 */
export function protectionsOff(windowGlobal) {
  const { browsingContext } = windowGlobal;
  const top = browsingContext.parent
    ? browsingContext.top.currentWindowGlobal
    : windowGlobal;
  if (!top) {
    return true;
  }
  if (isWeb(top.documentURI)) {
    return !!windowGlobal.cookieJarSettings?.isOnContentBlockingAllowList;
  }
  const allowList = top.contentBlockingAllowListPrincipal;
  if (!webPrincipal(top.documentPrincipal) || !allowList) {
    return true;
  }
  return (
    Services.perms.testPermissionFromPrincipal(
      allowList,
      browsingContext.usePrivateBrowsing
        ? "trackingprotection-pb"
        : "trackingprotection"
    ) == Services.perms.ALLOW_ACTION
  );
}

/**
 * Answers a document's `SvalPageRulesChild` from Sval's engines. The document's
 * address, window kind and site exception are read here, from the parent's
 * own record of the document, never taken from the content process.
 */
export class SvalPageRulesParent extends JSWindowActorParent {
  /** The document's cosmetic exceptions, which generic lookups leave out. */
  #exceptions = [];
  /** Whether the document takes generic rules. */
  #generic = false;
  /** Whether the document takes only My filters' rules. */
  #ownOnly = false;
  /**
   * Whether the document, under a style with a theme, drew a dark background
   * of its own once asked for that theme, or null before it is measured.
   */
  drawsDark = null;

  receiveMessage(message) {
    switch (message.name) {
      case "SvalPageRules:Document":
        return this.#document();
      case "SvalPageRules:DrawsDark":
        this.#setDrawsDark(!!message.data);
        return null;
      case "SvalPageRules:Generic":
        return this.#genericSelectors(message.data);
    }
    return null;
  }

  get #isPrivate() {
    return this.browsingContext.usePrivateBrowsing;
  }

  #document() {
    // A top document sets its tab's Keep links in this tab site before its
    // page can ask for a tab: the answer and the field travel the one
    // channel to its process, in order.
    if (!this.browsingContext.parent) {
      SvalKeepLinks.applyTo(this.browsingContext, this.manager.documentURI);
    }
    const rules = this.#rules();
    const style = this.#style();
    return rules || style ? { rules, style } : null;
  }

  /**
   * A top-level document's site style (`SvalSiteStyles`), which applies
   * whether or not page rules do. A frame takes none: a site styles its own
   * pages, and a frame shows another document, often another site's.
   *
   * The tab's fields are set before the answer goes, so the document's
   * process has them before the page's first paint: both travel the one
   * channel to that process, in order.
   *
   * @returns {?{sheet: string, dark: boolean}} Null for none.
   */
  #style() {
    const { browsingContext } = this;
    if (browsingContext.parent || !isWeb(this.manager.documentURI)) {
      return null;
    }
    const look = lookShownIn(
      browsingContext.embedderElement,
      this.manager.documentURI
    );
    paintWith(browsingContext, look);
    return look ? styleMessage(look) : null;
  }

  /**
   * The document measured itself under dark (`SvalPageRulesChild`): a page
   * that draws dark keeps its colors, and one that turned light is inverted.
   *
   * @param {boolean} dark
   */
  #setDrawsDark(dark) {
    const browser = this.browsingContext.top.embedderElement;
    if (dark === this.drawsDark || this.browsingContext.parent || !browser) {
      return;
    }
    this.drawsDark = dark;
    if (this.manager === this.browsingContext.currentWindowGlobal) {
      showIn(browser, lookShownIn(browser, this.manager.documentURI));
    }
  }

  #rules() {
    // The document's principal decides, because a document with a web
    // address can run with a privileged principal, as the PDF viewer
    // does, and page rules, scriptlets above all, are for web content only.
    // A document without an origin of its own, sandboxed or data:, is judged
    // by the origin that made it, as DocInfo::PrincipalURL does for
    // WebExtension content scripts; an about:blank, srcdoc or blob: document
    // already carries its creator's principal, a popup's its opener's.
    const principal = webPrincipal(this.manager.documentPrincipal);
    if (!principal) {
      return null;
    }
    // The address, when it is a web one, carries the path the principal's
    // URI may lack.
    let uri = this.manager.documentURI;
    if (!isWeb(uri)) {
      uri = principal.URI;
    }
    // Where the site's protections or ad blocking are off, the user's own
    // rules still apply.
    this.#ownOnly =
      protectionsOff(this.manager) || !SvalBlockingLists.enabledIds().length;
    const rules = SvalPageRules.forDocument(
      uri.spec,
      this.#isPrivate,
      this.#ownOnly
    );
    this.#exceptions = rules?.exceptions ?? [];
    this.#generic = !!rules && !rules.generichide;
    if (!rules) {
      return null;
    }
    const { selectors, procedural, script, generichide } = rules;
    return { selectors, procedural, script, generichide };
  }

  #genericSelectors({ classes, ids } = {}) {
    if (!this.#generic || !Array.isArray(classes) || !Array.isArray(ids)) {
      return [];
    }
    // The child batches its names; a page that sends more cannot hold the
    // engines' lock for longer than one batch takes.
    return SvalPageRules.genericSelectors(
      classes.slice(0, MAX_NAMES).filter(c => typeof c == "string"),
      ids.slice(0, MAX_NAMES).filter(i => typeof i == "string"),
      this.#exceptions,
      this.#isPrivate,
      this.#ownOnly
    );
  }
}
