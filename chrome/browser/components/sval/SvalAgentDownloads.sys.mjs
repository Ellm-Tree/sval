/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Downloads a page starts in an agent's tab (agent-control spec §5.2). They
 * are a per-site permission, decided by the site of the top-level page that
 * started them, named as the agent's rules are looked up by (`hostOf`), so a file the page generated as a `blob:` or `data:` address
 * counts as that page's site. The first download from an undecided site is
 * held and the user is asked; Allow saves it, Deny cancels it, and later
 * downloads from the site follow the answer unasked. A Blocked site
 * downloads nothing. An agent's download is saved to the user's download
 * folder, under the name Firefox picks, with no dialog of any kind, and is
 * never opened.
 *
 * **A refused download is refused before Firefox gives it a name, a place
 * or a listing.** Every download a page starts reaches the parent's external
 * helper app handler (`nsExternalAppHandler`, uriloader/exthandler), for
 * http, `blob:` and `data:` alike. Gecko asks Sval for two components the
 * handler uses (`sval-agent-files.patch`, `SvalAgentFiles.h`), and Sval hands
 * out its own while an agent works in the download's tab, and Firefox's
 * otherwise:
 *
 * - `@mozilla.org/helperapplauncherdialog;1`, which the handler asks where
 *   to save every download it saves (`promptForSaveToFileAsync`, from
 *   `RequestSaveDestination`), and whether to save it at all when the user
 *   is to be asked (`show`). An agent's download is decided as the handler
 *   asks where, for the site of the page that triggered its load
 *   (`createLoadStarts`), or failing that the site the file itself comes
 *   from, which is then asked about even if its downloads were allowed, and
 *   never the page the tab shows by then. A refused one is cancelled there,
 *   an undecided one waits there for the user, and only an allowed one is
 *   given its path in the download folder, under the name Firefox's own
 *   dialog would pick. No window opens.
 * - `@mozilla.org/transfer;1`, the `nsITransfer` every download is handed to
 *   once its destination is known (`nsExternalAppHandler::CreateTransfer`),
 *   which makes the download Firefox lists and notes in history
 *   (`DownloadLegacyTransfer`). A file type Firefox opens itself, such as a
 *   PDF, never asks where (`nsExternalAppHandler::SetDownloadToLaunch`), so
 *   such a download is decided here, for the site of the page that
 *   triggered the request (its `loadInfo.triggeringPrincipal`), or failing
 *   that, as for the dialog, the file's own site. Firefox's transfer is made
 *   only once the download is allowed, with what this one was told
 *   meanwhile, so a refused download is never listed or noted.
 *
 * Before either is asked, as the response starts, the handler has made its
 * own temporary `.part` file in the download folder
 * (`nsExternalAppHandler::SetUpTempFile`), and the data goes on arriving into
 * it while the user is asked, as it does under Firefox's own dialog. A
 * refused download's file is removed by its handler, or by Sval where the
 * handler keeps it (`removeHandlersFile`).
 *
 * The hold has no timeout, like a page-started load, because no tool call
 * waits on it. The downloads panel does not open for an agent's download in
 * the user's window.
 *
 * Who a download is for is the gates' answer (`addDownloadHolder`). Working
 * that out is allowed to fail open, as it is for loads, so a bug in Sval
 * cannot break the user's own downloads.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  hostOf,
  hostOfPrincipal,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

/**
 * The components Firefox's own downloads use, which Sval's hand every
 * download no agent works on to.
 */
const DIALOG_CONTRACT = "@mozilla.org/helperapplauncherdialog;1";
const TRANSFER_CONTRACT = "@mozilla.org/transfer;1";

/**
 * One function per open gate, each answering for a browsing context whether
 * it is in a tab an agent works in, and how to decide its downloads, with
 * that gate's record of where its agents' loads started
 * (`createLoadStarts`).
 *
 * @type {Map<(bc: BrowsingContext) => object|null, (id: number) => object|null>}
 */
const holders = new Map();

/**
 * The agents' downloads that wait for the user, each with the holder whose
 * gate decides it, by the function that refuses it.
 *
 * @type {Map<Function, Function>}
 */
const heldDownloads = new Map();

/**
 * The agent's record of each download decided as its handler asked where to
 * save it, by its launcher, which the transfer is later handed as its
 * `nsICancelable` (`nsExternalAppHandler::CreateTransfer`).
 *
 * @type {WeakMap<object, object>}
 */
const decided = new WeakMap();

/**
 * @param {BrowsingContext|null} bc
 * @param {string|null} [startSite] The site the download started on, when
 *   it was recorded.
 * @returns {{handler: object, holder: Function}|null} The download handler
 *   of the gate whose agent works in the tab `bc` is in.
 */
function handlerFor(bc, startSite) {
  try {
    if (!bc) {
      return null;
    }
    for (const holder of holders.keys()) {
      const handler = holder(bc, startSite);
      if (handler) {
        return { handler, holder };
      }
    }
  } catch (err) {
    SvalLog.warn(
      `the gate could not tell who a download is for: ${SvalLog.errorName(err)}`
    );
  }
  return null;
}

/**
 * @param {nsIHelperAppLauncher} launcher
 * @returns {{handler: object, holder: Function, unsure: boolean}|null} The
 *   handler for the tab the download started in, deciding for the site of
 *   the page that started it. When that cannot be told, it decides for the
 *   site the file itself comes from, and is `unsure`; a file with no site of
 *   its own is refused. It is never credited to whatever page the tab shows
 *   by then.
 */
function foundForLauncher(launcher) {
  let bc = null;
  let id = 0;
  let spec = null;
  try {
    id = launcher.browsingContextId;
    bc = BrowsingContext.get(id);
    spec = launcher.source.spec;
  } catch {}
  if (!bc) {
    return null;
  }
  try {
    for (const [holder, startOf] of holders) {
      const started = startOf(id);
      const known = started?.spec === spec && !!started.site;
      const handler = holder(
        bc,
        known ? started.site : sourceSiteOf(launcher.source)
      );
      if (handler) {
        return { handler, holder, unsure: !known };
      }
    }
  } catch (err) {
    SvalLog.warn(
      `the gate could not tell who a download is for: ${SvalLog.errorName(err)}`
    );
  }
  return null;
}

/**
 * @param {nsIURI|null} uri A download's address.
 * @returns {string|null} The site it is at, or null for one with none, such
 *   as a `blob:` or `data:` address, which only a page that made it can be.
 */
function sourceSiteOf(uri) {
  try {
    return uri ? hostOf(uri.spec) : null;
  } catch {
    return null;
  }
}

/**
 * @param {nsILoadInfo} loadInfo
 * @returns {boolean} Whether it is a document's load, the whole tab's or a
 *   frame's.
 */
function isDocumentLoad(loadInfo) {
  const type = loadInfo.externalContentPolicyType;
  return (
    type === Ci.nsIContentPolicy.TYPE_DOCUMENT ||
    type === Ci.nsIContentPolicy.TYPE_SUBDOCUMENT
  );
}

/**
 * @param {nsILoadInfo} loadInfo A document load's.
 * @returns {number} The browsing context the document loads in: for a
 *   frame's own load, the frame, which `frameBrowsingContextID` names while
 *   `browsingContextID` names its parent (nsILoadInfo.idl).
 */
function loadedIn(loadInfo) {
  return (
    (loadInfo.externalContentPolicyType ===
      Ci.nsIContentPolicy.TYPE_SUBDOCUMENT &&
      loadInfo.frameBrowsingContextID) ||
    loadInfo.browsingContextID
  );
}

/**
 * One gate's record of the last document load in each browsing context of
 * its agents' tabs, by the context's id: its address, and the site of the
 * page that triggered it. The gate's content policy shows it every load
 * (`nsContentSecurityManager::doContentSecurityCheck`), whatever its scheme,
 * and its channel sink every redirect. The site is recorded as the load
 * starts and kept through its redirects, which move only its address. The
 * handler names neither its channel nor its triggering principal
 * (nsIHelperAppLauncher), only the context it loads in and its address, so
 * the start of a download it asks about is the load recorded there for the
 * same address. A frame's download is the frame's site's, and a load
 * another site started in the tab is that site's.
 *
 * A context holds one entry, its latest load, until the gate is told it is
 * discarded (`forget`), so the record is bounded by the contexts open now.
 *
 * @returns {object}
 */
export function createLoadStarts() {
  /** @type {Map<number, {spec: string, site: string|null}>} */
  const started = new Map();

  /**
   * Moves the recorded start in browsing context `id` from address `from` to
   * `to`, as a redirect moves its load, and keeps who started it. A record
   * of another address is not this context's load, and goes, so a
   * download it ends in is one whose start cannot be told.
   *
   * @param {number} id
   * @param {string} from
   * @param {string} to
   */
  function carry(id, from, to) {
    const start = started.get(id);
    if (!start || start.spec === to) {
      return;
    }
    if (start.spec === from) {
      start.spec = to;
    } else {
      started.delete(id);
    }
  }

  return {
    /**
     * Records a document load as the gate's content policy sees it.
     *
     * @param {nsIURI} location
     * @param {nsILoadInfo} loadInfo
     * @param {(bc: BrowsingContext) => boolean} isAgents Whether a context
     *   is in one of the gate's agents' tabs.
     */
    record(location, loadInfo, isAgents) {
      try {
        if (!isDocumentLoad(loadInfo)) {
          return;
        }
        const id = loadedIn(loadInfo);
        const chain = loadInfo.redirectChain;
        if (chain.length) {
          carry(id, chain[chain.length - 1].principal.spec, location.spec);
        } else if (isAgents(BrowsingContext.get(id))) {
          let site = null;
          try {
            site = hostOfPrincipal(loadInfo.triggeringPrincipal, null);
          } catch {}
          started.set(id, { spec: location.spec, site });
        }
      } catch {}
    },

    /**
     * Carries a recorded start through a redirect, as the gate's channel
     * sink sees it. A page's own fetch redirects too, in the same context.
     *
     * @param {nsIChannel} oldChannel
     * @param {nsIChannel} newChannel
     */
    redirect(oldChannel, newChannel) {
      try {
        if (isDocumentLoad(newChannel.loadInfo)) {
          carry(
            loadedIn(newChannel.loadInfo),
            oldChannel.URI.spec,
            newChannel.URI.spec
          );
        }
      } catch {}
    },

    /**
     * @param {number} id A browsing context's id.
     * @returns {{spec: string, site: string|null}|null} Its latest load.
     */
    startOf(id) {
      return started.get(id) ?? null;
    },

    /**
     * Forgets a browsing context that is gone. One replaced is kept, as the
     * gate keeps its own records of one: the load that replaced it can still
     * be under way.
     *
     * @param {number} id
     */
    forget(id) {
      started.delete(id);
    },

    /** @returns {number} How many contexts' loads are recorded. */
    get size() {
      return started.size;
    },
  };
}

/**
 * The file an agent's download is saved to: the user's download folder and
 * the name Firefox's own dialog picks (`HelperAppDlg.validateLeafName`, as
 * WebDriver BiDi's `computeTargetFile` follows it), made unique and created
 * empty to reserve the name.
 *
 * @param {string} defaultName
 * @param {string} extension
 * @returns {Promise<nsIFile>}
 */
async function downloadTarget(defaultName, extension) {
  const dir = new lazy.FileUtils.File(
    await lazy.Downloads.getPreferredDownloadsDirectory()
  );
  const leafName =
    (defaultName &&
      lazy.DownloadPaths.sanitize(defaultName, {
        compressWhitespaces: true,
      })) ||
    "unnamed" + (extension || "");
  dir.append(leafName);
  return lazy.DownloadPaths.createNiceUniqueFile(dir);
}

/**
 * Saves `url` to the user's download folder under `fileName`, made unique,
 * with no dialog, and lists it in Firefox's downloads: how an agent's PDF.js
 * Save is carried out once it is allowed (`SvalAgentGate`), and how Settings
 * saves the user's card. Firefox's own `saveURL` asks where to save whenever
 * the user's "always ask" setting is on, which no agent's save may.
 *
 * @param {string} url
 * @param {string} fileName
 * @param {boolean} isPrivate
 * @param {number} [browsingContextId] The agent's tab the save is for, which
 *   makes it a download of the agent's workspace (`SvalDownloadWorkspaces`).
 * @returns {Promise<Download>} The download, once it has finished or failed.
 */
export async function saveToDownloads(
  url,
  fileName,
  isPrivate,
  browsingContextId
) {
  const file = await downloadTarget(fileName, "");
  const download = await lazy.Downloads.createDownload({
    source: { url, isPrivate, browsingContextId },
    target: file.path,
  });
  const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
  await list.add(download);
  try {
    await download.start();
  } catch (err) {
    SvalLog.warn(`a save to downloads failed: ${SvalLog.errorName(err)}`);
  }
  return download;
}

/**
 * Decides an agent's download whose handler asks where to save it, and
 * answers with its path only once it is allowed.
 *
 * @param {nsIHelperAppLauncher} launcher
 * @param {{handler: object, holder: Function}} found The gate's handler for
 *   the tab, and its holder.
 * @param {string} defaultName
 * @param {string} extension
 */
function decideAtPrompt(launcher, found, defaultName, extension) {
  const { handler } = found;
  const entry = handler.track({
    fileName: defaultName || launcher.suggestedFileName || null,
    path: null,
    state: "awaiting_approval",
    bytes: 0,
    download: null,
  });
  const save = () => {
    entry.state = "in_progress";
    downloadTarget(defaultName, extension).then(
      file => {
        entry.fileName = file.leafName;
        entry.path = file.path;
        decided.set(launcher, entry);
        launcher.saveDestinationAvailable(file);
      },
      err => {
        SvalLog.warn(
          `an agent's download has nowhere to go: ${SvalLog.errorName(err)}`
        );
        entry.state = "failed";
        launcher.saveDestinationAvailable(null);
      }
    );
  };
  const refuse = state => {
    entry.state = state;
    SvalLog.info(`an agent's download was ${state}`);
    let temp = null;
    try {
      temp = launcher.targetFile?.path ?? null;
      launcher.cancel(Cr.NS_BINDING_ABORTED);
    } catch {}
    removeHandlersFile(temp);
  };
  let decision;
  try {
    decision = handler.decide();
  } catch (err) {
    SvalLog.warn(
      `deciding an agent's download failed: ${SvalLog.errorName(err)}`
    );
    decision = "deny";
  }
  if (found.unsure && decision === "allow") {
    decision = "ask";
  }
  if (decision === "allow") {
    save();
    return;
  }
  if (decision !== "ask") {
    refuse("denied");
    return;
  }
  hold(found, refuse, answer => {
    if (answer === "allow") {
      save();
    } else {
      // A window that closed under the alert is no answer, and the download
      // is not kept for one either.
      refuse(answer === "no_window" ? "cancelled" : "denied");
    }
  });
}

/**
 * How long to wait before each further try at removing a refused download's
 * file, while its handler's saver still holds it open, as Windows refuses
 * to remove an open file.
 */
const REMOVE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Removes the file a refused download's handler wrote, if it is still
 * there. Cancelling removes it in most cases, but not one whose data had
 * all arrived: the handler's saver is then already finishing, and finishes
 * as it began, keeping the file (`nsExternalAppHandler::Cancel`,
 * `BackgroundFileSaver`). The file has a random name of the handler's
 * making, so nothing else of the user's can be at its path.
 *
 * @param {string|null} path
 */
async function removeHandlersFile(path) {
  if (!path) {
    return;
  }
  for (const delay of [0, ...REMOVE_RETRY_DELAYS_MS]) {
    if (delay) {
      await new Promise(resolve => lazy.setTimeout(resolve, delay));
    }
    try {
      await IOUtils.remove(path, { ignoreAbsent: true });
      return;
    } catch {}
  }
  SvalLog.warn("a refused download's file could not be removed");
}

/**
 * Holds an agent's download for the user's answer.
 *
 * @param {{handler: object, holder: Function}} found The gate's handler for
 *   the tab, and its holder.
 * @param {Function} refuse Refuses the download, with the state to list.
 * @param {Function} answered Told the user's answer, unless the download was
 *   refused first.
 */
function hold({ handler, holder }, refuse, answered) {
  let settled = false;
  const refuseHeld = () => {
    if (!settled) {
      settled = true;
      heldDownloads.delete(refuseHeld);
      refuse("cancelled");
    }
  };
  heldDownloads.set(refuseHeld, holder);
  handler
    .ask()
    .catch(err => {
      SvalLog.warn(`the download alert failed: ${SvalLog.errorName(err)}`);
      return "deny";
    })
    .then(answer => {
      if (settled) {
        return;
      }
      settled = true;
      heldDownloads.delete(refuseHeld);
      answered(answer);
    });
}

/**
 * The helper app dialog for an agent's download: no dialog at all. Every
 * other download gets Firefox's own.
 */
class GuardedLauncherDialog {
  #inner = null;

  QueryInterface = ChromeUtils.generateQI(["nsIHelperAppLauncherDialog"]);

  get #firefox() {
    this.#inner ??= Cc[DIALOG_CONTRACT].createInstance(
      Ci.nsIHelperAppLauncherDialog
    );
    return this.#inner;
  }

  show(launcher, context, reason) {
    if (!foundForLauncher(launcher)) {
      this.#firefox.show(launcher, context, reason);
      return;
    }
    // Saved, never opened. The handler asks this same object where, and the
    // download is decided then.
    try {
      launcher.MIMEInfo.preferredAction = Ci.nsIMIMEInfo.saveToDisk;
    } catch {}
    Services.tm.dispatchToMainThread(() => {
      try {
        launcher.promptForSaveDestination();
      } catch (err) {
        SvalLog.warn(
          `saving an agent's download failed: ${SvalLog.errorName(err)}`
        );
        launcher.cancel(Cr.NS_BINDING_ABORTED);
      }
    });
  }

  promptForSaveToFileAsync(launcher, context, defaultName, extension, force) {
    const found = foundForLauncher(launcher);
    if (!found) {
      this.#firefox.promptForSaveToFileAsync(
        launcher,
        context,
        defaultName,
        extension,
        force
      );
      return;
    }
    decideAtPrompt(launcher, found, defaultName, extension);
  }
}

/**
 * The `nsITransfer` of a download. An agent's download decided where it was
 * asked a path goes to Firefox's transfer with the downloads panel kept
 * shut; one that never asked is decided here first; every other download is
 * Firefox's own, untouched.
 */
class GuardedTransfer {
  /** Firefox's transfer, once the download may be listed. */
  #inner = null;
  /** The agent's record of the download, while it is an agent's. */
  #entry = null;
  /** What `initWithBrowsingContext` was given, until Firefox's is made. */
  #deferred = null;
  #holding = false;
  /** Whether the download was refused: nothing more reaches Firefox's. */
  #refused = false;
  /** What the handler told this transfer while it was held, in order. */
  #told = [];
  /** Whether the handler has told this transfer the download ended. */
  #ended = false;

  QueryInterface = ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsIWebProgressListener2",
    "nsITransfer",
  ]);

  #firefox() {
    this.#inner ??= Cc[TRANSFER_CONTRACT].createInstance(Ci.nsITransfer);
    return this.#inner;
  }

  init(...args) {
    return this.#firefox().init(...args);
  }

  initWithBrowsingContext(...args) {
    const [, , , mimeInfo, , , cancelable, , , , , browsingContext] = args;
    const entry = decided.get(cancelable);
    if (entry) {
      this.#entry = entry;
      this.#makeFirefox(args, mimeInfo);
      return undefined;
    }
    if (!handlerFor(browsingContext)) {
      return this.#firefox().initWithBrowsingContext(...args);
    }
    // The decision waits for the request: the handler hands it over with the
    // `STATE_START` that follows at once
    // (`nsExternalAppHandler::CreateTransfer`), and the page that started the
    // download is its triggering principal.
    this.#deferred = args;
    return undefined;
  }

  /**
   * Makes Firefox's transfer for an agent's download that may go ahead: saved,
   * never opened, with the downloads panel kept shut in the user's window.
   *
   * @param {Array} args What `initWithBrowsingContext` was given.
   * @param {nsIMIMEInfo} mimeInfo
   */
  #makeFirefox(args, mimeInfo) {
    // Launching a file, or showing it in a tab of the user's window, is a
    // side effect of its own (`DownloadIntegration.launchDownload`).
    try {
      mimeInfo.preferredAction = Ci.nsIMIMEInfo.saveToDisk;
    } catch {}
    const made = [...args];
    made[10] = false; // openDownloadsListOnStart
    made[12] = false; // handleInternally
    const firefox = this.#firefox();
    firefox.initWithBrowsingContext(...made);
    this.#entry.state = "in_progress";
    firefox.downloadPromise.then(
      download => {
        this.#entry.download = download;
      },
      () => {}
    );
  }

  /**
   * Decides an agent's download that never asked where to save it, for the
   * site it started on.
   *
   * @param {Array} args What `initWithBrowsingContext` was given.
   * @param {string|null} startSite The site the download is decided for: of
   *   the page that started it, or the file's own when that cannot be told.
   *   Null refuses it.
   * @param {boolean} unsure Whether it is the file's own, so that an allowed
   *   site is asked about rather than trusted.
   */
  #decide(args, startSite, unsure) {
    const [, target, , mimeInfo, , , cancelable, , , , , browsingContext] =
      args;
    const found = handlerFor(browsingContext, startSite);
    if (!found) {
      this.#firefox().initWithBrowsingContext(...args);
      return;
    }
    const { handler } = found;
    const file = target.QueryInterface(Ci.nsIFileURL).file;
    this.#entry = handler.track({
      fileName: file.leafName,
      path: file.path,
      state: "awaiting_approval",
      bytes: 0,
      download: null,
    });
    let decision;
    try {
      decision = handler.decide();
    } catch (err) {
      SvalLog.warn(
        `deciding an agent's download failed: ${SvalLog.errorName(err)}`
      );
      decision = "deny";
    }
    if (unsure && decision === "allow") {
      decision = "ask";
    }
    const refuse = state => {
      this.#refused = true;
      this.#entry.state = state;
      SvalLog.info(`an agent's download was ${state}`);
      try {
        cancelable.cancel(Cr.NS_BINDING_ABORTED);
      } catch {}
      // A handler whose data had all arrived has handed its file to this
      // transfer to move, and Firefox's, which would have, was never made.
      if (this.#ended) {
        removeHandlersFile(args[5]?.path ?? null);
      }
      this.#told = [];
    };
    if (decision === "allow") {
      this.#makeFirefox(args, mimeInfo);
      return;
    }
    if (decision !== "ask") {
      // Cancelled inside this `STATE_START`, the handler would never take the
      // transfer (`nsExternalAppHandler::CreateTransfer`).
      Services.tm.dispatchToMainThread(() => refuse("denied"));
      return;
    }
    this.#holding = true;
    hold(found, refuse, answer => {
      if (answer !== "allow") {
        refuse(answer === "no_window" ? "cancelled" : "denied");
        return;
      }
      this.#holding = false;
      this.#makeFirefox(args, mimeInfo);
      const told = this.#told;
      this.#told = [];
      for (const [method, callArgs] of told) {
        this.#inner[method](...callArgs);
      }
    });
  }

  /**
   * Passes a notice from the handler to Firefox's transfer, or keeps it while
   * the download is held.
   *
   * @param {string} method
   * @param {Array} args
   */
  #tell(method, args) {
    if (this.#refused) {
      return;
    }
    if (this.#holding) {
      this.#told.push([method, args]);
      return;
    }
    this.#inner?.[method](...args);
  }

  onStateChange(webProgress, request, flags, status) {
    const deferred = this.#deferred;
    if (deferred) {
      this.#deferred = null;
      let startSite;
      try {
        startSite = hostOfPrincipal(
          request.QueryInterface(Ci.nsIChannel).loadInfo.triggeringPrincipal,
          null
        );
      } catch {}
      // A principal that names no site, as an agent's own load carries,
      // leaves the site the file itself comes from, which is asked about
      // rather than trusted, and never the page the tab shows by then.
      if (startSite) {
        this.#decide(deferred, startSite, false);
      } else {
        this.#decide(deferred, sourceSiteOf(deferred[0]), true);
      }
    }
    const stop =
      flags & Ci.nsIWebProgressListener.STATE_STOP &&
      flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK;
    if (stop) {
      this.#ended = true;
      if (this.#entry && !Components.isSuccessCode(status) && !this.#refused) {
        this.#entry.state = "failed";
      }
    }
    this.#tell("onStateChange", [webProgress, request, flags, status]);
  }

  onProgressChange(webProgress, request, curSelf, maxSelf, curTotal, maxTotal) {
    this.onProgressChange64(
      webProgress,
      request,
      curSelf,
      maxSelf,
      curTotal,
      maxTotal
    );
  }

  onProgressChange64(...args) {
    if (this.#entry) {
      this.#entry.bytes = args[4];
    }
    this.#tell("onProgressChange64", args);
  }

  onStatusChange(webProgress, request, status, message) {
    if (this.#entry && !Components.isSuccessCode(status) && !this.#refused) {
      this.#entry.state = "failed";
    }
    this.#tell("onStatusChange", [webProgress, request, status, message]);
  }

  onLocationChange(...args) {
    this.#tell("onLocationChange", args);
  }

  onSecurityChange(...args) {
    this.#tell("onSecurityChange", args);
  }

  onContentBlockingEvent(...args) {
    this.#tell("onContentBlockingEvent", args);
  }

  onRefreshAttempted(...args) {
    return this.#inner?.onRefreshAttempted(...args) ?? true;
  }

  /**
   * Firefox's transfer's download (`nsITransfer.downloadPromise`), which
   * `saveURL` waits on. A refused download has none.
   */
  get downloadPromise() {
    return this.#inner?.downloadPromise ?? Promise.resolve(null);
  }

  setSha256Hash(hash) {
    this.#tell("setSha256Hash", [hash]);
  }

  setSignatureInfo(info) {
    this.#tell("setSignatureInfo", [info]);
  }

  setRedirects(redirects) {
    this.#tell("setRedirects", [redirects]);
  }
}

/**
 * @param {BrowsingContext} bc Where a download's page is.
 * @returns {nsIHelperAppLauncherDialog|null} Sval's dialog for it while an
 *   agent works in its tab, or null for Firefox's.
 */
export function downloadDialogFor(bc) {
  return handlerFor(bc) ? new GuardedLauncherDialog() : null;
}

/**
 * @param {BrowsingContext} bc Where a download's page is.
 * @returns {nsITransfer|null} Sval's transfer for it while an agent works in
 *   its tab, or null for Firefox's.
 */
export function downloadTransferFor(bc) {
  return handlerFor(bc) ? new GuardedTransfer() : null;
}

/**
 * Starts deciding the downloads in the tabs `holder` answers for.
 *
 * @param {(bc: BrowsingContext, startSite?: string|null) => object|null} holder
 *   Answers, for a browsing context, the download handler of the agent
 *   working in its tab, deciding for `startSite` when it is given:
 *   `{site, decide(): "allow"|"deny"|"ask", ask(): Promise<string>, track(entry)}`.
 * @param {(id: number) => object|null} startOf The latest load the gate
 *   recorded in a browsing context (`createLoadStarts`).
 */
export function addDownloadHolder(holder, startOf) {
  holders.set(holder, startOf);
}

/**
 * Stops deciding the downloads `holder` answered for. The ones it still holds
 * for the user are cancelled: with no gate left, nobody can allow them.
 *
 * @param {Function} holder What `addDownloadHolder` was given.
 */
export function removeDownloadHolder(holder) {
  holders.delete(holder);
  for (const [refuse, heldBy] of [...heldDownloads]) {
    if (heldBy === holder) {
      refuse();
    }
  }
}

// A held download must not outlive the session either: the next start
// would find it neither allowed nor refused.
Services.obs.addObserver(() => {
  for (const refuse of [...heldDownloads.keys()]) {
    refuse();
  }
}, "quit-application-granted");
