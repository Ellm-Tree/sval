/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The element picker and the snip, from the parent's side (element picker
 * spec §1 to §4). `SvalElementPickerChild` draws the overlay in a top-level
 * document; this module decides where the picker is offered, starts and ends
 * a tab's mode.
 *
 * The picker saves a rule, so it is off where page rules are: in a private
 * window, with ad blocking Off, and on a site with protections off. The
 * snip saves nothing and needs only a website.
 */

import {
  scopeOf,
  siteOf,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";

/** Notified with the browser as subject and the tab's mode, "" when it ends. */
export const MODE_TOPIC = "sval-element-picker-mode";

/** Notified with the browser as subject when its page's snips change. */
export const SNIPS_TOPIC = "sval-element-picker-snips";

const ACTOR = "SvalElementPicker";
const MODES = ["remove", "snip"];

let registered = false;
/** browser -> {mode, actor}: the mode a tab is in, and the actor it runs on. */
const modes = new WeakMap();
/**
 * browser -> how its last mode ended: "left" when the person left it or the
 * page went, "done" when a save or a removal finished it and a toast stays.
 */
const endings = new WeakMap();

/**
 * @param {?BrowsingContext} browsingContext A tab's top-level one.
 * @returns {?string} the tab's site, or null when it has none: an about: or
 *   file: page, a blank tab or a page that has not loaded.
 */
function siteFor(browsingContext) {
  const spec = browsingContext?.currentURI?.spec;
  if (!spec) {
    return null;
  }
  try {
    return siteOf(spec);
  } catch {
    return null;
  }
}

/**
 * Whether a tab's picker is available, which the Save message asks again at
 * the moment it writes.
 *
 * @param {?BrowsingContext} browsingContext A tab's top-level one.
 * @param {?string} [site] The tab's site, as `siteFor` gives it.
 * @returns {"ok"|"private"|"no-site"}
 */
export function availabilityOf(
  browsingContext,
  site = siteFor(browsingContext)
) {
  const windowGlobal = browsingContext?.currentWindowGlobal;
  if (!windowGlobal || !site) {
    return "no-site";
  }
  if (browsingContext.usePrivateBrowsing) {
    return "private";
  }
  return "ok";
}

/** The windows whose tabs' navigations end a mode. */
const watched = new WeakSet();

/**
 * Ends a tab's mode when its top-level document is replaced. A document the
 * back-forward cache keeps is not destroyed, so its actor is not told; the
 * navigation is the signal that always comes. A same-document navigation
 * keeps the document and its overlay.
 *
 * A tab moved to another window is closed in this one (`TabClose`, with the
 * tab that adopted it), and its mode ends with it: the adopting window's
 * browser is a new element that has no record of the mode.
 *
 * @param {Element} browser A tab's browser, whose window is watched.
 */
function watchNavigation(browser) {
  const win = browser.documentGlobal;
  if (watched.has(win) || !win.gBrowser) {
    return;
  }
  watched.add(win);
  win.gBrowser.tabContainer.addEventListener("TabClose", event =>
    SvalElementPicker.stop(event.target.linkedBrowser)
  );
  win.gBrowser.addTabsProgressListener({
    onLocationChange(navigated, webProgress, request, location, flags) {
      if (
        webProgress.isTopLevel &&
        !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)
      ) {
        SvalElementPicker.stop(navigated);
      }
    },
  });
}

/**
 * The chrome's colour scheme and motion preference, which the overlay takes
 * in place of the page's media queries.
 *
 * @param {Element} browser
 * @returns {{scheme: string, reducedMotion: boolean}}
 */
function lookOf(browser) {
  const win = browser.documentGlobal;
  return {
    scheme: win.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark",
    reducedMotion: win.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

/**
 * Records a tab's mode, and announces it.
 *
 * @param {Element} browser
 * @param {?string} mode Null when the mode ends.
 * @param {?JSWindowActorParent} actor
 * @param {"left"|"done"} [ending] How a mode that ends did.
 */
function setMode(browser, mode, actor, ending = "left") {
  if (mode) {
    modes.set(browser, { mode, actor });
  } else {
    modes.delete(browser);
    endings.set(browser, ending);
  }
  Services.obs.notifyObservers(browser, MODE_TOPIC, mode ?? "");
}

export const SvalElementPicker = {
  MODE_TOPIC,

  /** Registers the actor. Runs once, at startup. */
  init() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalElementPickerParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalElementPickerChild.sys.mjs",
      },
      allFrames: false,
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
    });
  },

  /**
   * Whether each mode is offered for the tab, and if not, why: Remove from
   * this site as {@link availabilityOf} answers, and Snip wherever the page
   * has a site.
   *
   * @param {Element} browser A tab's browser.
   * @returns {{remove: "ok"|"private"|"no-site", snip: "ok"|"no-site"}}
   */
  offers(browser) {
    const context = browser.browsingContext;
    const site = siteFor(context);
    return {
      remove: availabilityOf(context, site),
      snip: site ? "ok" : "no-site",
    };
  },

  /**
   * Puts the tab in a mode, leaving the one it was in.
   *
   * @param {Element} browser
   * @param {"remove"|"snip"} mode
   * @throws {Error} "unavailable" where the mode is not offered.
   */
  async start(browser, mode) {
    if (!MODES.includes(mode)) {
      throw new Error("unknown mode");
    }
    if (this.offers(browser)[mode] != "ok") {
      throw new Error("unavailable");
    }
    this.stop(browser);
    watchNavigation(browser);
    const actor = browser.browsingContext.currentWindowGlobal.getActor(ACTOR);
    setMode(browser, mode, actor);
    try {
      const scope = scopeOf(browser.browsingContext.currentURI.spec);
      await actor.sendQuery("SvalElementPicker:Start", {
        mode,
        site: scope.site,
        host: scope.host,
        ...lookOf(browser),
      });
    } catch (err) {
      this.ended(browser, actor);
      throw err;
    }
  },

  /**
   * Leaves the tab's mode.
   *
   * @param {Element} browser
   */
  stop(browser) {
    const entry = modes.get(browser);
    if (!entry) {
      return;
    }
    this.ended(browser, entry.actor);
    try {
      entry.actor.sendAsyncMessage("SvalElementPicker:Stop");
    } catch {
      // The document is gone, and its overlay with it.
    }
  },

  /**
   * @param {?Element} browser
   * @param {JSWindowActorParent} actor
   * @param {"remove"|"snip"} mode
   * @returns {boolean} whether the tab is in `mode`, run by `actor`.
   */
  isRunning(browser, actor, mode) {
    const entry = browser && modes.get(browser);
    return !!entry && entry.actor === actor && entry.mode == mode;
  },

  /**
   * @param {Element} browser
   * @returns {?string} the tab's mode.
   */
  active(browser) {
    return modes.get(browser)?.mode ?? null;
  },

  /**
   * Records that a tab's mode ended, when `actor` is the one running it. The
   * actor calls this when its child reports the end, and when its document is
   * destroyed.
   *
   * @param {?Element} browser
   * @param {JSWindowActorParent} actor
   * @param {"left"|"done"} [ending] "done" when a save or a removal ended
   *   it, which leaves the toast holding the focus.
   */
  ended(browser, actor, ending = "left") {
    if (!browser || modes.get(browser)?.actor !== actor) {
      return;
    }
    setMode(browser, null, null, ending);
  },

  /**
   * @param {Element} browser
   * @returns {"left"|"done"|null} how the tab's last mode ended.
   */
  endedBy(browser) {
    return endings.get(browser) ?? null;
  },

  /**
   * @param {Element} browser
   * @returns {number} how many snips the tab's page holds. The count lives
   *   with the page's actor, so a page the back-forward cache returns keeps
   *   its own and a reload starts at none.
   */
  snippedOn(browser) {
    return (
      browser.browsingContext?.currentWindowGlobal?.getExistingActor(ACTOR)
        ?.snipped ?? 0
    );
  },

  /**
   * @param {?Element} browser A tab whose page's snips changed.
   */
  snipsChanged(browser) {
    if (browser) {
      Services.obs.notifyObservers(browser, SNIPS_TOPIC);
    }
  },

  /**
   * How many elements of the tab's page each selector matches.
   *
   * @param {Element} browser
   * @param {string[]} selectors
   * @returns {Promise<Array<?number>>} a count per selector; null for one
   *   that is not plain CSS or a page that cannot be asked.
   */
  async countOn(browser, selectors) {
    try {
      const actor = browser.browsingContext.currentWindowGlobal.getActor(ACTOR);
      return await actor.sendQuery("SvalElementPicker:Count", { selectors });
    } catch {
      return selectors.map(() => null);
    }
  },
};
