/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The parent of a pin's page's actor (`SvalPins`, pins spec §5): answers
 * whether a page is a pin's, settles its saved page when the user first
 * touches it, and opens a link to another site in a Quick Peek over the pin.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalPinPages } from "moz-src:///browser/components/sval/SvalPinPages.sys.mjs";
import { PINS_QUICK_PEEK_PREF } from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";
import { answerFor } from "moz-src:///browser/components/sval/SvalPins.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  linkLoad: "moz-src:///browser/components/sval/SvalLinkClick.sys.mjs",
  SvalQuickPeek: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
});

/** One frame of a page, as its pin sees it. */
export class SvalPinParent extends JSWindowActorParent {
  get #tab() {
    const browser = this.browsingContext.top.embedderElement;
    return browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser) ?? null;
  }

  receiveMessage({ name, data }) {
    const tab = this.#tab;
    const page = tab ? SvalPinPages.pageOfTab(tab) : null;
    switch (name) {
      case "SvalPin:Which":
        return page ? answerFor(page) : null;
      case "SvalPin:Touched":
        // Where the pin's page is settles only by the page's own document.
        if (page && this.browsingContext === this.browsingContext.top) {
          SvalPinPages.touched(tab);
        }
        return null;
      case "SvalPin:QuickPeek":
        if (tab && typeof data?.href === "string") {
          this.#quickPeek(tab, page, data);
        }
        return null;
    }
    return null;
  }

  /**
   * Opens a link to another site in a Quick Peek over the pin, checked again
   * against the parent's own record of the document, as `SvalQuickPeek.openClick`
   * does.
   *
   * @param {object} tab
   * @param {object} page
   * @param {object} data
   */
  #quickPeek(tab, page, data) {
    const load = lazy.linkLoad(this.manager, data);
    if (!load) {
      return;
    }
    const quickPeeked =
      !!page &&
      Services.prefs.getBoolPref(PINS_QUICK_PEEK_PREF, true) &&
      lazy.SvalQuickPeek.open(tab.linkedBrowser, load, {
        from: {
          name: page.name || "",
          icon: tab.getAttribute("image") || null,
        },
      });
    if (quickPeeked) {
      return;
    }
    // The page held the click back for a Quick Peek that cannot open: the tab is
    // no pin's any more, or quick-peeking was turned off since the page was told.
    // The link goes where it was going.
    const win = tab.documentGlobal;
    if (data.blank) {
      win.openLinkIn(data.href, "tab", {
        triggeringPrincipal: load.triggeringPrincipal,
        referrerInfo: load.referrerInfo,
        policyContainer: load.policyContainer,
        userContextId: tab.userContextId,
      });
      return;
    }
    tab.linkedBrowser.fixupAndLoadURIString(data.href, {
      triggeringPrincipal: load.triggeringPrincipal,
      referrerInfo: load.referrerInfo,
      policyContainer: load.policyContainer,
      hasValidUserGestureActivation: true,
    });
  }
}
