/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Each private window is a browsing session of its own (private-windows
 * spec): its tabs use a cookie jar, a `userContextId`, that no other window
 * uses, and the jar's data goes once no tab uses it any more.
 *
 * A private tab's origin attributes are `{privateBrowsingId: 1,
 * userContextId: N}`, so everything Gecko keys on them, cookies, storage,
 * caches, connections, HSTS (`hsts-private-jar.patch`) and permissions
 * (`permissions-private-jar.patch`), is the window's alone. A window a page
 * opens, such as a sign-in popup, shares its opener's jar, which Gecko gives
 * it through the opener's origin attributes; every other private window gets
 * a fresh one as its first tab is made (`private-window-sessions.patch`),
 * and its new tabs follow it (`gBrowser.defaultUserContextId`,
 * `workspace-jar-for-new-tabs.patch`). A tab never moves between private
 * windows, a tab opened in one is given its jar whatever jar was asked for,
 * and a popup's links open in the window whose session it shares, so a
 * window's tabs are always in its jar.
 *
 * The ids come from a counter in memory, from 2^30 up, which
 * `ContextualIdentityService` never reaches and below 2^31, which Gecko
 * reads as a signed 32-bit number (`nsFrameLoader`'s `usercontextid`). No
 * identity is made for one, so `containers.json` never learns that a private
 * window existed. An id is never handed out twice while Sval runs, so a clear
 * still under way never meets a window that took the same id; a restart
 * ends every private session, so the counter can start again.
 *
 * Nothing here is written anywhere, and this module imports only what
 * `test_sval_private.js` allows.
 */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

/** The first id a private jar gets. */
const FIRST = 2 ** 30;

/** One past the last id a private jar can get. */
const END = 2 ** 31;

let next = FIRST;

/** Each jar not yet cleared, to the window it was made for. */
const live = new Map();

/** Windows that are closing, whose tabs hold no jar. */
const closing = new WeakSet();

/** The clears under way, for tests that wait for them. */
const clearing = new Set();

/** Whether a check of the jars is queued. */
let checkQueued = false;

/**
 * @param {number} id
 * @returns {boolean} whether `id` is a private window's jar.
 */
function isPrivateJar(id) {
  return Number.isInteger(id) && id >= FIRST && id < END;
}

/**
 * @param {Window} win
 * @returns {boolean} whether `win` is open and staying so.
 */
function isOpen(win) {
  return !!win && !win.closed && !closing.has(win);
}

/** @returns {Set<number>} the jars an open tab uses. */
function jarsInUse() {
  const used = new Set();
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!isOpen(win)) {
      continue;
    }
    // A popup still opening has no tabs yet, and holds its opener's jar.
    const opening = win.docShell?.treeOwner
      ?.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow).initialOpenWindowInfo;
    if (opening) {
      used.add(opening.originAttributes.userContextId);
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      if (!tab.closing) {
        used.add(tab.userContextId);
      }
    }
  }
  return used;
}

/**
 * Clears every jar whose window has closed and that no open tab uses, as
 * `SvalWorkspaceJar.removeUnused` keeps a jar while a page on screen uses it:
 * a popup a window opened keeps the window's jar until it closes too.
 *
 * The pattern names `privateBrowsingId`, which `CookieService::PickStorage`
 * needs to look in the private cookies. The same call tells everything that
 * follows `clear-origin-attributes-data`, Sval's private choices among them
 * (`SvalSiteProtections`).
 */
function check() {
  checkQueued = false;
  const used = jarsInUse();
  for (const [jar, owner] of live) {
    if (used.has(jar) || isOpen(owner.deref())) {
      continue;
    }
    live.delete(jar);
    const done = new Promise(resolve =>
      Services.clearData.deleteDataFromOriginAttributesPattern(
        { privateBrowsingId: 1, userContextId: jar },
        { onDataDeleted: () => resolve() }
      )
    );
    clearing.add(done);
    done.then(() => clearing.delete(done));
  }
  endIfNoneLeft();
}

/**
 * Under "Always use private browsing mode" Gecko never says private browsing
 * ended (`CanonicalBrowsingContext`'s `DecreasePrivateCount`), so what it
 * holds in memory for every private session, image and font caches and TLS
 * session tickets among it, would stay until Sval quits. Once the last
 * window has closed, it is cleared as Gecko clears it in a normal session.
 */
function endIfNoneLeft() {
  if (
    !PrivateBrowsingUtils.permanentPrivateBrowsing ||
    Services.startup.shuttingDown
  ) {
    return;
  }
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (isOpen(win)) {
      return;
    }
  }
  const done = new Promise(resolve => {
    try {
      Services.clearData.clearPrivateBrowsingData({
        onDataDeleted: () => resolve(),
      });
    } catch {
      // One already under way clears the same.
      resolve();
    }
  });
  clearing.add(done);
  done.then(() => clearing.delete(done));
}

/** Checks the jars once the event that may have freed one has finished. */
function queueCheck() {
  if (checkQueued) {
    return;
  }
  checkQueued = true;
  Services.tm.dispatchToMainThread(check);
}

/**
 * Follows `win`'s tabs closing and the window itself, which may each leave
 * a jar unused.
 *
 * @param {Window} win A private browser window.
 */
function watch(win) {
  win.addEventListener("TabClose", queueCheck);
  win.addEventListener(
    "unload",
    () => {
      closing.add(win);
      queueCheck();
    },
    { once: true }
  );
}

export const SvalPrivateJars = {
  FIRST,
  END,
  isPrivateJar,

  /**
   * The jar a private window's first tab opens in, and the window's own
   * jar for the tabs it opens later. Called by tabbrowser as that tab is
   * made, which every private window reaches, the first one under "Always
   * use private browsing mode" included.
   *
   * A window a page opened keeps the jar Gecko gave it, and so does one
   * taking another window's tab or opened in a WebDriver client's own user
   * context (`SvalWebDriver.isClientsJar`): the caller says so with `keep`.
   * Every other window gets a fresh jar, whatever was asked for: a link
   * opened in a new private window from an isolated workspace asks for that
   * workspace's jar.
   *
   * @param {Window} win A private browser window.
   * @param {number|null|undefined} requested The jar asked for.
   * @param {object} options
   * @param {boolean} options.keep Whether the window keeps `requested`.
   * @returns {number}
   */
  jarForWindow(win, requested, { keep }) {
    watch(win);
    if (keep) {
      return requested ?? 0;
    }
    if (next >= END) {
      throw new Error("sval: no private jar is left");
    }
    const jar = next++;
    live.set(jar, new WeakRef(win));
    return jar;
  },

  /**
   * The window a private jar was made for, while it is open: where a link
   * from a popup sharing that window's session opens.
   *
   * @param {number} jar
   * @returns {Window|null}
   */
  windowOf(jar) {
    const win = live.get(jar)?.deref();
    return isOpen(win) ? win : null;
  },

  /**
   * A load context of a private session, for a service that keys what it
   * keeps by one (the content pref service), while a tab of it is open.
   *
   * @param {number} jar
   * @returns {nsILoadContext|null}
   */
  loadContextOf(jar) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of isOpen(win) ? (win.gBrowser?.tabs ?? []) : []) {
        if (tab.userContextId === jar && tab.linkedBrowser?.loadContext) {
          return tab.linkedBrowser.loadContext;
        }
      }
    }
    return null;
  },

  /**
   * @param {object} originAttributes A principal's or browsing context's.
   * @returns {number|null} the private session they belong to, as its jar,
   *   or null outside private browsing.
   */
  sessionOf(originAttributes) {
    return originAttributes?.privateBrowsingId > 0
      ? (originAttributes.userContextId ?? 0)
      : null;
  },

  /**
   * @param {Element} browser A tab's browser.
   * @returns {number|null} the private session its page is in, as its jar,
   *   or null outside private browsing. A page with no origin of its own, a
   *   settings page in a private window among them, is in its tab's.
   */
  sessionOfBrowser(browser) {
    return this.sessionOf(
      browser.browsingContext?.originAttributes ??
        browser.contentPrincipal?.originAttributes
    );
  },

  /**
   * Settles once every clear under way has finished. For tests.
   *
   * @returns {Promise<void>}
   */
  async _clearedForTests() {
    if (checkQueued) {
      await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
    }
    await Promise.all([...clearing]);
  },

  /** The jars not yet cleared. For tests. */
  get _liveForTests() {
    return [...live.keys()];
  },
};
