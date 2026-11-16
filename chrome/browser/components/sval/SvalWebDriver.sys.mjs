/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The workspace and cookie jar of what WebDriver opens
 * (docs/webdriver-bidi.md).
 *
 * A WebDriver client runs outside Sval's agent controls, but a window it opens
 * never shares the user's cookies, and never reaches the user's synced
 * document. Each one shows a workspace of its own, named "WebDriver" and
 * isolated, on a tree held in memory as a private window's is
 * (`SvalMemorySession`), and its tabs use that workspace's jar
 * (`SvalWorkspaceJar`). The window closing takes its workspace and jar with
 * it. A run that ends before then, as in a crash, wrote nothing of the
 * workspace, and its jar, which no workspace of the document holds, goes at
 * the next `SvalWorkspaceJar.prune`.
 *
 * The one other jar a WebDriver tab may keep is a user context the client
 * made over BiDi (`browser.createUserContext`), which is apart from the
 * user's cookies already. `webdriver-jar-of-its-own.patch` reports each one
 * here as BiDi makes it, and only those ids, while their identity exists,
 * count. Any other jar a client names, the default one, an id Sval's
 * workspaces use, another identity's or one that is gone, gives way to the
 * jar of the workspace the window shows.
 *
 * A tab a client opens goes to a window of WebDriver's, as an agent's tabs go
 * to the agent's workspace, never into a workspace of the user's: the most
 * recent window of WebDriver's, or a new one
 * ({@link SvalWebDriver.tabTarget}). The user can let it use the workspace
 * of the window it was opened in instead (`WEBDRIVER_COOKIES_PREF`), which
 * is this device's alone.
 *
 * The patch calls {@link SvalWebDriver.openWindow} from the remote agent's
 * `WindowManager.openBrowserWindow`, which classic `WebDriver:NewWindow` and
 * BiDi's `browsingContext.create` both reach, and
 * {@link SvalWebDriver.tabTarget} from `TabManager.addTab` and BiDi's
 * `browsingContext.create`.
 */

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalMemorySession } from "moz-src:///browser/components/sval/SvalPrivateSession.sys.mjs";
import {
  SvalSerialQueue,
  STALL_MS,
} from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import {
  TIMED_OUT,
  raceTimeout,
} from "moz-src:///browser/components/sval/SvalTimeout.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalClock: "moz-src:///browser/components/sval/SvalClock.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SYNC_DOCUMENT: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  UNSAVED_KEY: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
});

/** The name of the workspace a WebDriver window shows. */
export const WORKSPACE_NAME = "WebDriver";

/**
 * Whether a tab WebDriver opens in one of the user's windows stays there, in
 * the jar of the workspace that window shows. Off by default. No sync list
 * names it, so it stays on its device.
 */
export const WEBDRIVER_COOKIES_PREF =
  "browser.sval.webdriver.useWorkspaceCookies";

/** Every WebDriver window's tree, settings and tab ids. */
const session = new SvalMemorySession({
  isPrivate: false,
  workspace: { name: WORKSPACE_NAME, isolated: true },
});

/**
 * Opens WebDriver's windows, and routes its tabs to them, one at a time, so a
 * tab routed while a window of WebDriver's is opening goes to that window
 * rather than opening one of its own ({@link SvalWebDriver.tabTarget}).
 */
const routing = new SvalSerialQueue("WebDriver windows");

/**
 * {@link SvalWebDriver.deleteLeftWorkspaces}, one call at a time, so each
 * window that starts finds the record its predecessor emptied.
 */
const deletingLeft = new SvalSerialQueue("WebDriver's left workspaces");

/**
 * Every user context a client made over BiDi in this run: its
 * `userContextId`, and the identity's name, which BiDi makes unique
 * (`UserContextManager.createContext`). A jar counts as the client's only
 * while an identity with both exists, so an id that comes back for another
 * identity, as after Firefox resets its identities, does not.
 *
 * @type {Map<number, string>}
 */
const clientJars = new Map();

/**
 * Drops a WebDriver window's workspace, or a reservation for one, and its
 * jar with its cookies and site data.
 *
 * @param {Window|object} win A window, or a key from `session.reserve`.
 * @param {object} [options] As `SvalMemorySession.releaseWindow` takes them.
 * @returns {Promise<void>}
 */
async function release(win, options) {
  const workspaceId = await session.releaseWindow(win, options);
  if (workspaceId) {
    lazy.SvalWorkspaceJar.release(workspaceId);
  }
}

/**
 * {@link SvalWebDriver.openWindow}, for a caller already on `routing`.
 *
 * @param {object} options As `openWindow` takes them.
 * @param {boolean} options.isPrivate
 * @param {number|null} options.userContextId
 * @param {(userContextId: number) => Promise<*>} open As `openWindow` takes
 *   it.
 * @returns {Promise<*>} what `open` resolves to.
 */
async function openWindowNow({ isPrivate, userContextId }, open) {
  const named = SvalWebDriver.isClientsJar(userContextId)
    ? userContextId
    : null;
  if (isPrivate) {
    return open(named ?? 0);
  }
  const { key, tree, workspaceId: reserved } = session.reserve();
  let opened = null;
  try {
    const workspaceId = await reserved;
    const workspaceJar = lazy.SvalWorkspaceJar.userContextIdFor(
      (await tree.tree()).nodes ?? {},
      workspaceId
    );
    lazy.SvalWorkspaceJar.hold(workspaceId);
    // nsWindowWatcher notifies this as it adds the window, inside
    // `Services.ww.openWindow`, so the one window it reports during `open` is
    // the one `open` made.
    const observer = subject => {
      opened ??= subject;
    };
    Services.obs.addObserver(observer, "domwindowopened");
    let result;
    try {
      result = open(named ?? workspaceJar);
    } finally {
      Services.obs.removeObserver(observer, "domwindowopened");
    }
    if (!opened) {
      result.then(
        browser => browser?.documentGlobal?.close(),
        () => {}
      );
      throw new Error("WebDriver window was not handed its workspace");
    }
    // Before the window's panel starts, which asks the session for it.
    session.bind(key, opened);
    // The window's own jar for the tabs it opens next, from the moment the
    // client has the window: its panel sets the same one once it has started
    // (`_setJar`), and a tab opened before then would otherwise start in the
    // default jar.
    const browser = await startedWithin(result, opened);
    // Out of every session SessionStore saves, so no restart, crash or
    // reopened closed window brings it back on the user's document
    // (`sessionstore-unsaved-windows.patch`). The session store tracks a
    // window from before its delayed startup, which `open` waits for.
    lazy.SessionStore.setCustomWindowValue(opened, lazy.UNSAVED_KEY, "1");
    browser.documentGlobal.gBrowser.defaultUserContextId = workspaceJar;
    return browser;
  } catch (err) {
    if (opened && !opened.closed) {
      opened.close();
    }
    await release(opened && session.has(opened) ? opened : key);
    throw err;
  }
}

/**
 * `started`, unless it is still pending after
 * {@link SvalWebDriver.windowStartMs}: then `win` is closed and the command
 * fails, so a window that never starts holds back none of the commands
 * queued behind it on `routing`.
 *
 * @param {Promise<*>} started Resolves once the window has started.
 * @param {Window} win The window.
 * @returns {Promise<*>} what `started` resolves to.
 */
async function startedWithin(started, win) {
  try {
    const result = await raceTimeout(started, SvalWebDriver.windowStartMs);
    if (result === TIMED_OUT) {
      throw new Error("WebDriver window did not start");
    }
    return result;
  } catch (err) {
    if (!win.closed) {
      win.close();
    }
    throw err;
  }
}

export const SvalWebDriver = {
  /**
   * How long a window WebDriver opens has to start before its command fails:
   * the time `SvalSerialQueue` lets a task run before it calls it stalled,
   * since every later window and routed tab waits behind it. A test
   * shortens it by replacing it.
   */
  windowStartMs: STALL_MS,

  /**
   * The session a window WebDriver opened runs its panel on, with
   * `SvalPrivateSession`'s `forWindow` and `releaseWindow`.
   *
   * @param {Window} win A browser window.
   * @returns {object|null} the session, or null for a window WebDriver did
   *   not open.
   */
  sessionFor(win) {
    if (!session.has(win)) {
      return null;
    }
    return {
      forWindow: (w, options) => session.forWindow(w, options),
      releaseWindow: (w, options) => release(w, options),
    };
  },

  /**
   * @param {Window} win A browser window.
   * @returns {boolean} Whether WebDriver opened it and it is open.
   */
  isWebDriverWindow(win) {
    return !win.closed && session.has(win);
  },

  /**
   * Deletes from the synced document the workspaces the profile's store
   * records as WebDriver's (`leftWebDriverWorkspaces`), as the user's Delete
   * workspace does (`SvalTabs.removeNodes`), with their jars, and then the
   * record. A workspace a window of the user's shows, or the last one, has
   * become the user's, and stays.
   *
   * @param {object} settings The profile's `SvalLocalSettings` store.
   * @param {object} engine The profile's `SvalEngine`, its tree read.
   * @returns {Promise<void>}
   */
  deleteLeftWorkspaces(settings, engine) {
    return deletingLeft
      .run(async () => {
        const left = settings.leftWebDriverWorkspaces;
        // An empty document is one not read yet, never one with no
        // workspace, so the record waits for a window that has read it.
        if (
          !left.length ||
          !Object.keys((await engine.tree()).nodes ?? {}).length
        ) {
          return;
        }
        for (const id of left) {
          const nodes = (await engine.tree()).nodes ?? {};
          const shown = lazy.BrowserWindowTracker.orderedWindows.some(
            win => !win.closed && win.SvalPanel?.workspaceId === id
          );
          if (nodes[id] && !shown && lazy.workspaceIds(nodes).length > 1) {
            await lazy.SvalTabs.removeNodes(engine, settings, nodes, [id]);
          }
        }
        settings.forgetLeftWebDriverWorkspaces();
        await settings.flush();
        lazy.SvalWorkspaceJar.prune((await engine.tree()).nodes ?? {});
        engine
          .sync(lazy.SYNC_DOCUMENT, lazy.SvalClock.now(), {
            shared: "background",
          })
          .catch(err =>
            SvalLog.warn(
              `sync after removing WebDriver workspaces failed: ${describeError(err)}`
            )
          );
      })
      .catch(err =>
        SvalLog.warn(
          `removing WebDriver workspaces failed: ${describeError(err)}`
        )
      );
  },

  /**
   * Records a user context a client made with `browser.createUserContext`.
   *
   * @param {number} userContextId
   */
  noteClientUserContext(userContextId) {
    const name =
      Number.isInteger(userContextId) && userContextId > 0
        ? lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)
            ?.name
        : null;
    if (name) {
      clientJars.set(userContextId, name);
    }
  },

  /**
   * @param {number} userContextId
   * @returns {boolean} Whether a client made that jar over BiDi and it still
   *   exists, so a tab in it stays there.
   */
  isClientsJar(userContextId) {
    const name = clientJars.get(userContextId);
    return (
      !!name &&
      lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)
        ?.name === name
    );
  },

  /**
   * Opens a browser window for WebDriver in a workspace of its own.
   *
   * The workspace is on WebDriver's tree before the window exists, and the
   * window is bound to it as Services.ww makes it: the window's panel asks
   * for it as it starts ({@link sessionFor}), and `open` resolves only after
   * that window's delayed startup. Its first tab opens in the jar it keeps,
   * so the tab observer never reopens it, which would end the client's
   * browsing context. A window that cannot be given its workspace is closed
   * and the command fails, rather than open on a workspace of the user's.
   *
   * A private window is private browsing's own jar, apart from every other,
   * and is opened as it is, in no user context unless it is the client's.
   *
   * @param {object} options
   * @param {boolean} options.isPrivate Whether the window is private.
   * @param {number|null} options.userContextId The jar of the user context
   *   the client named, or null for none.
   * @param {(userContextId: number) => Promise<*>} open Opens the window
   *   with its first tab in the jar it is given. It must call
   *   `Services.ww.openWindow` before it returns.
   * @returns {Promise<*>} what `open` resolves to.
   */
  openWindow(options, open) {
    return routing.run(() => openWindowNow(options, open));
  },

  /**
   * Where a tab WebDriver opens goes, for a tab it would open in `window`.
   *
   * That window, when it is private, one of WebDriver's, or the user lets
   * WebDriver use their workspaces' cookies. Otherwise the most recent window
   * of WebDriver's. With none open, a window is opened, and its first tab is
   * the tab, so the window holds no blank tab nobody asked for.
   *
   * @param {Window} window The window the client's command names.
   * @param {number|null} userContextId The jar of the user context the
   *   client named, or null for none.
   * @returns {Promise<{window: Window, tab: object|null}>} The window, and
   *   the tab to use when one was opened for it.
   */
  async tabTarget(window, userContextId) {
    if (
      lazy.PrivateBrowsingUtils.isWindowPrivate(window) ||
      this.isWebDriverWindow(window) ||
      Services.prefs.getBoolPref(WEBDRIVER_COOKIES_PREF, false)
    ) {
      return { window, tab: null };
    }
    return routing.run(async () => {
      const found = lazy.BrowserWindowTracker.orderedWindows.find(win =>
        this.isWebDriverWindow(win)
      );
      if (found) {
        return { window: found, tab: null };
      }
      const browser = await openWindowNow(
        { isPrivate: false, userContextId },
        jar =>
          new Promise(resolveOnContentBrowserCreated =>
            lazy.URILoadingHelper.openTrustedLinkIn(
              window,
              "about:blank",
              "window",
              { resolveOnContentBrowserCreated, userContextId: jar }
            )
          )
      );
      const win = browser.documentGlobal;
      return { window: win, tab: win.gBrowser.getTabForBrowser(browser) };
    });
  },
};
