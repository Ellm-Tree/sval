/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A pin's page's actor (pins spec §5), `SvalPinParent` and `SvalPinChild`:
 * registered here, which also tells each new document of a pin's page that
 * it is one.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalPinPages } from "moz-src:///browser/components/sval/SvalPinPages.sys.mjs";
import {
  PINS_QUICK_PEEK_PREF,
  siteOfPin,
} from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";

const ACTOR = "SvalPin";

let registered = false;

export const SvalPins = {
  /**
   * Registers the actor every web page's frames carry. Called once, at
   * `browser-before-ui-startup`, before any page loads.
   */
  registerActor() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: {
        esModuleURI: "moz-src:///browser/components/sval/SvalPinParent.sys.mjs",
      },
      child: {
        esModuleURI: "moz-src:///browser/components/sval/SvalPinChild.sys.mjs",
        events: {
          mousedown: { capture: true, mozSystemGroup: true },
          keydown: { capture: true, mozSystemGroup: true },
          click: {},
        },
      },
      allFrames: true,
      messageManagerGroups: ["browsers"],
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
    });
    Services.obs.addObserver(tellDocument, "window-global-created");
  },

  /**
   * Tells a page that has become a pin's, by a tab pinned as it was, that it
   * is one (`SvalPinChild`).
   *
   * @param {object} tab The pin's tab.
   */
  tellPage(tab) {
    const page = SvalPinPages.pageOfTab(tab);
    try {
      tab.linkedBrowser?.browsingContext?.currentWindowGlobal
        ?.getActor(ACTOR)
        .sendAsyncMessage("SvalPin:Is", page ? answerFor(page) : null);
    } catch {
      // A page with no actor, such as one of the browser's own: it has no
      // links to Quick Peek at, and nothing to settle.
    }
  },
};

/**
 * Tells each document of a pin's page that it is one as soon as the parent
 * creates its record of it, so its first click is taken as every later one
 * is (`SvalPinChild`). Asked on its first press alone, a document hears the
 * answer only after the click that press begins, which the page follows.
 *
 * @param {WindowGlobalParent} wgp A document the parent has just created.
 */
function tellDocument(wgp) {
  const browser = wgp.browsingContext?.top?.embedderElement;
  const tab = browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser);
  const page = tab ? SvalPinPages.pageOfTab(tab) : null;
  if (!page) {
    return;
  }
  try {
    wgp.getActor(ACTOR).sendAsyncMessage("SvalPin:Is", answerFor(page));
  } catch {
    // A document the actor is not for, such as the initial about:blank.
  }
}

/**
 * What a pin's page is told of itself: whether its links to another site
 * open in Quick Peek, and its site, which is all that decides it. Every frame of
 * the page asks, an advertiser's too, so no frame is told the saved address
 * itself.
 *
 * @param {object} page As `SvalPinPages.pageOfTab` answers it.
 * @returns {object}
 */
export function answerFor(page) {
  return {
    site: siteOfPage(page),
    quickPeek: Services.prefs.getBoolPref(PINS_QUICK_PEEK_PREF, true),
  };
}

/**
 * The site of a pin's page (pins spec §5), from the page a fresh load
 * settles on once known: a pin saved as a bare domain lives on the host it
 * redirects to.
 *
 * @param {object} page As `SvalPinPages.pageOfTab` answers it.
 * @returns {string}
 */
export function siteOfPage(page) {
  return siteOfPin(page.savedPage ?? page.url);
}
