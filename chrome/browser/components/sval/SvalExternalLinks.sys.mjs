/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Where a link from another app opens (link routing spec §3).
 *
 * Every platform hands Sval such a link as a command line, to a running Sval
 * or at a cold start: macOS as `-url <address>` from its Apple Events,
 * Windows as the shell's `-osint -url <address>`, and Linux as the address
 * alone, from `xdg-open` and the desktop entry's `Exec=sval %u`. That holds
 * whether Sval is the default browser or a link router or `open -a` sent it.
 * Firefox's `nsDefaultCommandLineHandler` ("x-default") opens what is left of
 * it as a new tab in the frontmost window, in its workspace's jar
 * (`workspace-jar-for-new-tabs.patch`).
 *
 * This handler runs before Firefox's, under an entry that sorts before
 * "m-browser", and takes each address whose page {@link destinationFor} sends
 * elsewhere, leaving the rest of the command line to Firefox. It is
 * registered at `browser-before-ui-startup`, which runs before the first
 * command line
 * (`final-ui-startup` precedes `nsCommandLine::Run` in `XREMain::XRE_mainRun`).
 * A `components.conf` entry would be compiled into libxul and move the Gecko
 * key for a handler written in JS.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ENABLED_PREF: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SvalLinkDownloads:
    "moz-src:///browser/components/sval/SvalLinkDownloads.sys.mjs",
  SvalLinkRules: "moz-src:///browser/components/sval/SvalLinkRules.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalMacWindowOrder:
    "moz-src:///browser/components/sval/SvalMacWindowOrder.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
});

/** The handler's entry in the `command-line-handler` category. */
export const CATEGORY_ENTRY = "l-sval-external-links";

/**
 * Where a page from another app opens: in a workspace a routing rule names,
 * in a Peek of its own, in the frontmost ordinary window, or, as
 * null, where Firefox opens it. Only a web page goes anywhere but Firefox's
 * way; a file, or anything else a command line can name, is Firefox's.
 *
 * Every decision about a link from another app is made here, once. Rules
 * come first and apply whether the Peek is on or off (link
 * routing spec §2). Which of a match's workspaces still exists is read from the tree
 * as the page opens, so a rule's workspace may turn out to be gone: the page
 * then goes where it would have gone with no rule. With the Peek on,
 * an address whose file extension names a type Gecko does not show is a
 * download, and goes to the frontmost ordinary window, where the Downloads
 * panel announces it (`SvalLinkDownloads`).
 *
 * @param {nsIURI} uri
 * @returns {{kind: "rule", workspaces: string[], quick: boolean}
 *   |{kind: "quick"}|{kind: "window"}|null}
 */
export function destinationFor(uri) {
  if (!uri.schemeIs("https") && !uri.schemeIs("http")) {
    return null;
  }
  const enabled = Services.prefs.getBoolPref(lazy.ENABLED_PREF, false);
  const quick = enabled && lazy.SvalLinkDownloads.rendersInline(uri);
  const workspaces = lazy.SvalLinkRules.workspacesFor(uri);
  if (workspaces.length) {
    return { kind: "rule", workspaces, quick };
  }
  if (quick) {
    return { kind: "quick" };
  }
  return enabled ? { kind: "window" } : null;
}

/**
 * Opens a page as Firefox opens a link from another app with no Peek:
 * a new tab in the frontmost window, in its workspace's jar
 * (`BrowserContentHandler` `handURIToExistingBrowser`).
 *
 * @param {nsIURI} uri
 */
function openAsFirefoxDoes(uri) {
  const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
  if (!win) {
    // With no window open, as macOS allows, the page opens a window of its
    // own, as `handURIToExistingBrowser` opens one.
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString
    );
    args.data = uri.spec;
    lazy.BrowserWindowTracker.openWindow({ private: false, args });
    return;
  }
  lazy.SvalLinkDownloads.opened(
    win.browserDOMWindow.openURI(
      uri,
      null,
      Ci.nsIBrowserDOMWindow.OPEN_DEFAULTWINDOW,
      Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
      Services.scriptSecurityManager.getSystemPrincipal()
    )
  );
  lazy.SvalMacWindowOrder.bringForward(win);
}

/**
 * Opens one page where {@link destinationFor} sent it: in the first of its
 * rules' workspaces still there, or else in a Peek, or else as
 * Firefox does.
 *
 * @param {nsIURI} uri
 * @param {object} destination
 * @returns {Promise<void>}
 */
async function openAt(uri, destination) {
  if (
    destination.kind === "rule" &&
    (await lazy.SvalPeek.openInFirstWorkspace(uri, destination.workspaces))
  ) {
    return;
  }
  if (destination.kind === "quick" || destination.quick) {
    lazy.SvalPeek.open(uri);
    return;
  }
  openAsFirefoxDoes(uri);
}

const handler = {
  classDescription: "Sval: links from other apps",
  contractID: "@sval/external-links-clh;1",
  classID: Components.ID("{7f1d8a52-3c64-4b0e-9a3e-5e0d2c6b8f17}"),
  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),

  createInstance(iid) {
    return this.QueryInterface(iid);
  },

  /**
   * Takes every address whose page goes elsewhere. A cold start leaves the
   * rest to Firefox, which opens the first window as it always does, with the
   * session restored, and the pages open over it once that has happened. A
   * running Sval opens them at once, and Firefox is told it has nothing more
   * to open, which would otherwise be a new window.
   *
   * @param {nsICommandLine} cmdLine
   */
  handle(cmdLine) {
    const taken = [];
    let leftToFirefox = false;
    for (let i = 0; i < cmdLine.length; ) {
      const arg = cmdLine.getArgument(i);
      const flag = arg.startsWith("-");
      const isUrlFlag = arg.toLowerCase() === "-url";
      // `-url <address>`, or an address standing alone, as Linux's desktop
      // entry passes it (`Exec=sval %u`) and `nsDefaultCommandLineHandler`
      // reads any argument that is not a flag's value.
      const before = i ? cmdLine.getArgument(i - 1) : "";
      const alone =
        !flag && (!before.startsWith("-") || before.toLowerCase() === "-osint");
      if (!isUrlFlag && !alone) {
        i++;
        continue;
      }
      const at = isUrlFlag ? i + 1 : i;
      let uri = null;
      try {
        uri =
          at < cmdLine.length
            ? Services.io.newURI(cmdLine.getArgument(at))
            : null;
      } catch {
        // Not an address on its own: Firefox's fix-up has the say.
      }
      const destination = uri && destinationFor(uri);
      if (!destination) {
        leftToFirefox = true;
        i = at + 1;
        continue;
      }
      cmdLine.removeArguments(i, at);
      taken.push([uri, destination]);
    }
    if (!taken.length) {
      if (
        leftToFirefox &&
        cmdLine.state !== Ci.nsICommandLine.STATE_INITIAL_LAUNCH
      ) {
        // Firefox opens the page in its top window and focuses that window
        // (`handURIToExistingBrowser`), which does not bring it forward when
        // it was kept behind as Sval was activated for the page.
        lazy.SvalMacWindowOrder.bringForward(
          lazy.BrowserWindowTracker.getTopWindow({ private: false })
        );
      }
      return;
    }
    // In order, one at a time: a rule's page waits for its window's switch,
    // and the next link's page must not land in the middle of it.
    const open = async () => {
      for (const [uri, destination] of taken) {
        try {
          await openAt(uri, destination);
        } catch (err) {
          lazy.SvalLog.error(
            `could not open a link from another app: ${lazy.SvalLog.errorName(err)}`
          );
        }
      }
    };
    if (cmdLine.state === Ci.nsICommandLine.STATE_INITIAL_LAUNCH) {
      // Once the session is restored and the first window Firefox opens for
      // this command line has started, so the pages open over it: a window
      // shown later comes in front of them where the window manager raises
      // each new window (Windows). Firefox opens that window after this
      // handler, so it is looked for once the command line has run, as
      // `handURIToExistingBrowser` waits for a pending window.
      lazy.SessionStore.promiseAllWindowsRestored
        .then(() => new Promise(r => Services.tm.dispatchToMainThread(r)))
        .then(() =>
          lazy.BrowserWindowTracker.getPendingWindow({ private: false })
        )
        .then(open);
    } else {
      cmdLine.preventDefault = true;
      open();
    }
  },

  helpInfo: "",
};

export const SvalExternalLinks = {
  destinationFor,

  /**
   * `browser-before-ui-startup`: registers the handler, once.
   */
  init() {
    if (Cc[handler.contractID]) {
      return;
    }
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .registerFactory(
        handler.classID,
        handler.classDescription,
        handler.contractID,
        handler
      );
    Services.catMan.addCategoryEntry(
      "command-line-handler",
      CATEGORY_ENTRY,
      handler.contractID,
      false,
      true
    );
  },
};
