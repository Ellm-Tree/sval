/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Where an agent may go (agent-control spec §5.2). Site policy is checked
 * twice over. A `site` here is the name the agent's rules are looked up by,
 * `hostOf`'s: a host under its site where it offers a choice of scope
 * (decision 1980), which the policy's lookups walk up to its site. Every
 * alert names it, and an answer the user gives is saved for it or, where its
 * "Remember for" menu offers one, for its whole site (`scopeMenuOf`).
 *
 * - `allowLoad` checks a load a tool is about to start, and answers the tool
 *   call with a reason when it refuses.
 * - Every top-level document load in a tab the gate watches is checked as it
 *   starts, whoever started it: the page, the user, a redirect, or a timer
 *   that fires long after the tool call returned. A tab is watched while it
 *   is the agent's, which the tree says (`SvalAgentTabRegistry`): its node
 *   is filed under the agent's workspace. The first load of a tab that could
 *   be an agent's waits until its window has filed it (`holdForFiling`), so
 *   a tab or window an agent's page opens is checked from its first load.
 * - `checkPage` refuses a tool that would read or act in a page whose site
 *   the agent may not open now, however the page came to be there: a site
 *   can be blocked after its page loaded.
 * - A back or forward into the back-forward cache opens no channel, so the
 *   pages an agent's tabs keep there are dropped whenever one may hold a
 *   page the agent's rules would refuse: when the gate opens, when the
 *   agent's site rules change, when the user gives a tab back, and when a
 *   tab joins an agent's workspace (`SvalAgentTabRegistry`). A back or
 *   forward is then a load, checked as any other.
 *
 * The second check runs in the parent process, where every top-level load
 * opens its real channel (`DocumentLoadListener`). Two hooks cover it:
 *
 * - A content policy refuses a load outright. The channel's own open runs it
 *   (`nsContentSecurityManager::doContentSecurityCheck`), whatever the
 *   scheme, so it refuses the loads that open no HTTP channel, to any scheme
 *   `agentSiteOf` refuses. An http(s) load it leaves to the next hook. A page's own load of a `blob:` or `data:`
 *   address is the exception: it may be the download of a file the page
 *   made, which a content policy cannot tell from a page, so it goes ahead,
 *   and a page at such an address is never the agent's (`siteOfPrincipal`).
 *   It is synchronous, so it can only allow or refuse. Firefox's own site
 *   blocklist uses the same pair of hooks (`WebsiteFilter.sys.mjs`), and the
 *   same object, registered as a channel event sink, refuses a redirect to
 *   such a scheme.
 * - `http-on-modify-request` refuses an http(s) load to a site the user
 *   blocked for the agent, with `NS_ERROR_BLOCKED_BY_USER`, whose error page
 *   is about:agentblocked, and holds one whose site the user has not been
 *   asked about. The parent's `nsHttpChannel` fires it for every
 *   load and every redirect before it connects (`ContinuePrepareToConnect`),
 *   and a channel suspended there waits until it is resumed. The gate
 *   suspends it, asks, then resumes it or cancels it, as WebRequest does
 *   (WebRequest.sys.mjs `channel.suspend`, then `resume` and `cancel`). A
 *   held load has no timeout: no tool call is waiting on it, and it waits
 *   only as long as the user takes to answer.
 *
 * Agent content belongs to the agent's workspace. A watched tab is gated
 * exactly while it is filed under the agent's workspace:
 *
 * - Content a watched page opens lands there from the start, and never in a
 *   window or workspace of the user's, not even for a moment. A new tab a
 *   watched page or popup asks for, and a window it asks for without window
 *   features, as it does while the user holds Shift, opens in the agent's
 *   own window, in the background (`SvalAgentRouting`), or, while the agent
 *   has no full window open, in a new window that becomes its own. A popup,
 *   which opens with no JS on the way, stays a popup and is
 *   handed the agent's workspace before its panel starts
 *   (`onWindowBeforeShow`).
 * - Only the user's own move takes a tab out: once the tree files it under
 *   a workspace of the user's, it is the user's, and so is what it opens.
 * - A tab the user has taken control of (`SvalAgentControl`) stays watched
 *   but is answered for as the user's: no site check, dialog, picker,
 *   download or route here treats it as the agent's until the user gives it
 *   back, and every tab filed in a workspace the user holds is in their
 *   control because of where it is, the ones opened meanwhile included. A
 *   page load held for a site alert when the user takes the tab goes on as
 *   theirs. The write half is the exception: taking control changes who owns
 *   input from then on, so an action window the agent's input opened before
 *   the take goes on holding what that input sets off until it closes, and a
 *   held batch still waits for its alert. Once those are done, nothing the
 *   tab sends is held, because no action opens on a tab the user holds
 *   (`act`).
 *
 * The gate fails closed. A check on a load an agent is watched for that
 * throws refuses the load: Gecko accepts a load whose content policy throws
 * (`nsContentPolicy::CheckPolicy`), and swallows an observer's exception.
 * Only working out whether any agent watches the load is allowed to fail
 * open, so a bug in Sval cannot break the user's own browsing.
 *
 * Whose a tab is is one record, `SvalAgentTabRegistry`, which every part of
 * the gate asks, and the agent tools and WebMCP's mark too. The site half is
 * here, and the write half is `SvalAgentWrites`. Asking the user once per
 * question, and waiting for the answer, is `SvalAgentAsk`.
 *
 * The write half (spec §5.3) holds the writes an agent's input sets off.
 * `act` opens an action window on the tab for the length of one input and
 * until the tab's network has been quiet for a while after it
 * (`ActionWindow`); `http-on-stop-request` tells it when requests end. The
 * same `http-on-modify-request` observer offers the window every request the
 * tab starts, from any frame, and from any tab or window its pages opened.
 * Only the agent's are judged: those sent by the document the input went
 * to, its frames, what it opened, and any document there it can script
 * (`reacherOf`). Once a navigation commits a new top-level document in the
 * tab, or one of another site in a tab or window the input opened, what
 * that document sends is the new page's own, such as its analytics, and
 * passes (`sentByAction`). A request whose method is not GET, HEAD or
 * OPTIONS is a write, and the level of the site the tab's top-level page is
 * on decides it (`ActionWindow`). When the window closes, one alert lists
 * everything suspended, and the answer resumes or cancels the lot, and the
 * next write is asked about again. "Always allow writes on this site" sets
 * the site to `full` in the policy, and "Always deny writes on this site" to
 * `read-only`. While that answer is outstanding, an input in the same tab is
 * not performed, so a retry never sends a write twice.
 * One input runs at a time in a tab: the next waits until the last one's
 * window has closed and its writes are recorded, so one alert never lists
 * two inputs' writes. A write the page sends after the window has closed
 * is still the agent's if the document the input went to sends it, since
 * nothing tells a write a page delayed by a timer from one it sends on its
 * own: it is judged the same way, and what is suspended is asked about in
 * an alert of its own, which waits for the user with no timeout
 * (`lateOwner`). Every other request outside a window passes: a page the
 * agent never acted in sends its own. Agent access switched off
 * mid-action cancels every write already held, and every write the open
 * windows judge from then until they close; what they let pass as another
 * document's, and every read, still goes out.
 *
 * What this mechanism cannot gate:
 *
 * - A GET that changes state, such as an unsubscribe link.
 * - A service worker's or shared worker's own fetches. They carry no
 *   associated browsing context, which only a dedicated worker's window
 *   gives (`WorkerPrivate`'s `mAssociatedBrowsingContextID`), so they
 *   cannot be traced to a tab. A page's own request that a service worker
 *   answers is still seen: `nsHttpChannel` notifies
 *   `http-on-modify-request` before it hands the request to the worker
 *   (`ContinuePrepareToConnect`, then `OnBeforeConnect`'s
 *   `RedirectToInterceptedChannel`).
 * - Frames sent on a WebSocket or WebTransport that is already open. They
 *   open no channel, and the upgrade itself is a GET.
 * - A write relayed to another tab, through `BroadcastChannel` or a storage
 *   event, and sent from there.
 * - A write from the input's document that the parent opens with no inner
 *   window id (`senderOf` falls back to the tab's current document), such
 *   as a keepalive fetch the parent builds itself (`FetchService`'s
 *   main-thread fetch opens its channel from a principal and no document,
 *   `FetchDriver`'s `NS_NewChannel`), once a navigation has committed the
 *   next document before the parent opens it: a fast back-forward cache
 *   commit can do that. It is then taken for the new
 *   page's own, and passes.
 *
 * And what it holds that is not the agent's: every write the document an
 * input went to sends from then until the tab leaves it, such as its own
 * periodic analytics that are not beacons, or a draft it saves, is held as
 * the agent's. A page that moves to another route without loading a new
 * document (`history.pushState`, as single-page apps do) is still that
 * document. A page of the acted-on site in a window that document opened
 * is held the same way, its own load-time analytics included, since the
 * document can script it.
 *
 * Files are per-site permissions of their own (spec §5.2), beside the level:
 *
 * - A download a page in a watched tab starts is decided by the site of the
 *   tab's top-level page, held until the user answers about an undecided
 *   site, and saved with no dialog and never opened (`SvalAgentDownloads`,
 *   which asks `downloadHandler`). `listDownloads` lists the agent's.
 * - `allowUpload` decides whether `upload_file` may give a page on a site
 *   files, asking the first time, with the files of that call named.
 *
 * Both ask once per site, and a Blocked site does neither.
 *
 * Reading a site's console is a per-site permission of its own too (spec
 * §4.5): `allowConsole` asks the first time an agent asks for a page's
 * console messages on a site, and records the answer for the site. Each
 * page in a watched tab has its console watched from its creation
 * (`watchConsole`), so a grant given later still covers what the page
 * logged before.
 *
 * Apps are a per-site permission of their own too, by scheme (spec §5.2):
 * `mayOpenApp` decides an address a page in a watched tab hands to another
 * application, where Gecko's dispatcher is about to handle it
 * (`nsContentDispatchChooser.handleURI`, `sval-agent-apps.patch`). Every way
 * a page opens an app ends there in the parent, so the content policy lets
 * those loads through to it.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  inUploadFolders,
  markProfile,
} from "moz-src:///browser/components/sval/SvalAgentUploads.sys.mjs";
import {
  CONTROL_TOPIC,
  isAgentNavigating,
  isAgentStopped,
  isUserInControl,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  ask as askUser,
  Ending,
} from "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs";
import {
  decideLoad,
  hostOf,
  hostOfDocument,
  hostOfPrincipal,
  localPlaceOf,
  uploadFoldersFor,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import {
  endPdfSave,
  pdfSavers,
  tabRouters,
} from "moz-src:///browser/components/sval/SvalAgentRouting.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  addDownloadHolder,
  createLoadStarts,
  removeDownloadHolder,
  saveToDownloads,
} from "moz-src:///browser/components/sval/SvalAgentDownloads.sys.mjs";
import {
  awaitsFiling,
  browserIdOf,
  createTabRegistry,
  fileBeforeLoad,
} from "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs";
import {
  ActionWindow,
  CAP_MS,
  createWriteGate,
  OPEN_MAX_MS,
  QUIET_MS,
  topContextOf,
} from "moz-src:///browser/components/sval/SvalAgentWrites.sys.mjs";
import { onContextGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { awaitAnswer } from "moz-src:///browser/components/sval/SvalAgentAsk.sys.mjs";
import {
  APP,
  CONSOLE,
  createAsker,
  decideSiteToolCall,
  DOWNLOADS,
  SITE,
  SITE_TOOL_CALL,
  SITE_TOOLS,
  UPLOADS,
} from "moz-src:///browser/components/sval/SvalAgentPermissions.sys.mjs";

export { ActionWindow, CAP_MS, decideLoad, OPEN_MAX_MS, QUIET_MS };
export { releaseAgentTab } from "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  recordResponse:
    "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs",
  watchConsole:
    "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs",
  fullWindowShowing: "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs",
  windowForWorkspace:
    "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs",
});

const MODIFY_REQUEST_TOPIC = "http-on-modify-request";
const STOP_REQUEST_TOPIC = "http-on-stop-request";
const BEFORE_SHOW_TOPIC = "browser-window-before-show";
const GLOBAL_CREATED_TOPIC = "window-global-created";

/** How many of an agent's downloads `list_downloads` keeps. */
const MAX_DOWNLOADS_LISTED = 100;

/**
 * The most characters of a call's arguments, as formatted JSON, a call alert
 * shows. A call whose arguments are longer is not asked about, because Allow
 * must cover only what the user was shown.
 */
const MAX_INPUT_SHOWN = 2000;

/**
 * @param {nsIURI} uri
 * @returns {boolean} Whether Gecko hands `uri` to another application: its
 *   protocol's handler is `nsIExternalProtocolHandler`.
 */
function isAppAddress(uri) {
  return (
    Services.io.getProtocolHandler(uri.scheme) instanceof
    Ci.nsIExternalProtocolHandler
  );
}

/**
 * @param {nsILoadInfo} loadInfo
 * @returns {boolean} Whether the load is a document in a top-level browsing
 *   context.
 */
function isTopLevelDocument(loadInfo) {
  if (
    loadInfo?.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT
  ) {
    return false;
  }
  const bc = loadInfo.browsingContext;
  return !!bc && bc.top === bc;
}

/**
 * Adds a saver to the ones PDF.js's saves are put to, for a test of what a
 * failing one does.
 *
 * @param {Function} saver
 * @returns {Function} Removes it.
 */
export function addPdfSaverForTests(saver) {
  pdfSavers.add(saver);
  return () => pdfSavers.delete(saver);
}

/**
 * Whether each open gate holds a browsing context: one function per gate.
 *
 * @type {Set<(bc: BrowsingContext) => boolean>}
 */
const tabHolders = new Set();

/**
 * Whether an open gate holds the tab of `bc`: its agent controls it, and the
 * user has not taken control. Gecko asks about every content tab, and whose
 * tab it is is the tab record's answer (`SvalAgentTabRegistry`); when working
 * that out fails, this throws, and Gecko's helpers in `SvalAgentFiles.h`
 * refuse a tab that record marks as an agent's (`svalAgentTab`).
 *
 * @param {BrowsingContext|null} bc
 * @param {string} what What is refused, for the log.
 * @returns {boolean}
 */
function heldByAgent(bc, what) {
  try {
    const top = bc?.top;
    if (!top?.isContent) {
      return false;
    }
    for (const holds of tabHolders) {
      if (holds(top)) {
        SvalLog.info(`${what} in an agent's tab was refused`);
        return true;
      }
    }
  } catch (err) {
    SvalLog.warn(
      `the gate could not tell whose tab ${what} is for: ${SvalLog.errorName(err)}`
    );
    throw err;
  }
  return false;
}

/**
 * Whether a file picker a page in `bc` asks for is refused: one is, in a
 * tab an agent controls. A picker is a dialog the agent cannot see or
 * answer, so files reach an agent's page only through `upload_file`
 * (agent-control spec §4.4).
 *
 * Gecko asks this in the parent, before it makes the picker
 * (`FilePickerParent::RecvOpen`, through `SvalAgentFiles`), so it holds
 * however the page asks: a click on a file input or a label for one, a
 * page's own `click()` on the activation an agent's click gave it, and
 * `showPicker()`, which opens a picker with no click event at all
 * (`HTMLInputElement::ShowPicker`). A refused picker comes back to the page
 * as one cancelled with nothing chosen.
 *
 * @param {BrowsingContext|null} bc
 * @returns {boolean}
 */
export function refusesFilePicker(bc) {
  return heldByAgent(bc, "a file picker");
}

/**
 * Whether a page in `bc` may not write the system clipboard: it may not, in
 * a tab an agent controls (agent-control spec §4.1). The agent's input gives
 * the page user activation, which would otherwise let it replace what the
 * user later pastes elsewhere. None of the user's input reaches such a tab
 * (spec §6), so every write from it is the page's or the agent's; once the
 * user takes control, the tab writes as any tab does.
 *
 * Gecko asks this in the parent, where every clipboard write from content
 * arrives with the window it came from (`nsBaseClipboard::SetData`, through
 * `SvalAgentFiles`): `navigator.clipboard`, `execCommand("copy")` and a copy
 * event's own data alike. A refused write fails, and the clipboard keeps
 * what it held.
 *
 * @param {BrowsingContext|null} bc
 * @returns {boolean}
 */
export function refusesClipboardWrite(bc) {
  return heldByAgent(bc, "a clipboard write");
}

/**
 * One function per open gate, each answering whether a page may hand an
 * address to another application, or null when its agent works in no tab
 * the address is for.
 *
 * @type {Set<(uri: nsIURI, principal: nsIPrincipal|null, bc: BrowsingContext, appName: string|null) => Promise<boolean>|null>}
 */
const appDeciders = new Set();

/**
 * Whether Gecko's dispatcher may go on with an address a page in `bc` hands
 * to another application (agent-control spec §5.2). In a tab an agent
 * controls the apps permission decides, asking the user about a scheme the
 * page's site has no answer for; anywhere else it may, and Gecko's own
 * permission and handler checks decide as ever. They run after this in
 * every tab (`nsContentDispatchChooser.handleURI`).
 *
 * Every page-started launch reaches the dispatcher in the parent
 * (`nsExternalHelperAppService::LoadURI`): a link click to a scheme Gecko does
 * not expose (`nsDocShell::OnLinkClickSync`), a load of a document or a frame
 * (`nsExtProtocolChannel::OpenURL`), and a content process's request
 * (`ContentParent::RecvLoadURIExternal`).
 *
 * @param {nsIURI} uri
 * @param {nsIPrincipal|null} principal The principal that asked: the
 *   redirect's for a redirect.
 * @param {BrowsingContext|null} bc The context the address is for.
 * @param {string|null} appName The application Gecko would open it with,
 *   when it knows one.
 * @returns {Promise<boolean>}
 */
export async function mayOpenApp(uri, principal, bc, appName) {
  if (!bc) {
    return true;
  }
  for (const decide of appDeciders) {
    const answer = decide(uri, principal, bc, appName);
    if (answer) {
      return answer;
    }
  }
  return true;
}

const denied = site =>
  new ToolError(
    "policy_denied",
    `${site} is blocked for this agent. Tell the user, and don't look for another way to reach it.`,
    {
      reason: "blocked",
    }
  );

/**
 * The site half of the gate, for one listen.
 *
 * @param {object} options
 * @param {{policyOf: Function, setDefault: Function, setSiteLevel: Function, setFilePermission: Function}} options.store
 * @param {Function} [options.ask] Asks the user in a window:
 *   `SvalAgentAlerts.ask`'s shape. Tests supply their own.
 * @param {(workspaceId: string) => Promise<Window|null>} [options.agentWindow]
 *   The agent's own full window, opened if there is none: where every alert
 *   is asked. Tests supply their own.
 * @returns {object}
 */
export function createAgentGate({
  store,
  ask = askUser,
  agentWindow = workspaceId =>
    lazy.windowForWorkspace(workspaceId, { open: true }),
}) {
  // Before any upload can be asked for, so Sval's own profile is known by
  // what it holds (`SvalAgentUploads`, `inAProfile`).
  markProfile();
  let closed = false;
  /** Each agent workspace's agent, by workspace id, as `pairedWith` answers it. */
  const paired = new Map();
  /**
   * @param {string} workspaceId An agent's workspace.
   * @returns {object|null} The agent whose workspace it is in the store, the
   *   same object each time while its pairing is unchanged.
   */
  function pairedWith(workspaceId) {
    const record = store.agentOfWorkspace?.(workspaceId);
    if (!record) {
      paired.delete(workspaceId);
      return null;
    }
    let agent = paired.get(workspaceId);
    if (agent?.agentId !== record.agentId || agent.label !== record.label) {
      agent = { agentId: record.agentId, label: record.label, workspaceId };
      paired.set(workspaceId, agent);
    }
    return agent;
  }
  const registry = createTabRegistry({
    isClosed: () => closed,
    agentFor: pairedWith,
  });
  /** First loads waiting for their tab to be filed (`holdForFiling`). */
  const filing = new Set();
  /** Where the loads in the agents' tabs started, for their downloads. */
  const starts = createLoadStarts();
  /** The downloads asked about so far, which names each one's alert. */
  let downloadsAsked = 0;
  /** The tabs with a call alert open, by browser id. */
  const callAsking = new Set();
  /**
   * Calls the user allowed once after their call had stopped waiting, kept
   * for the agent's next identical call: a site tool's on the same page, or
   * an upload of the same files to the same site.
   */
  const lateAllows = new Set();

  /**
   * Each agent's downloads, by agent id, oldest first (`list_downloads`).
   *
   * @type {Map<string, object[]>}
   */
  const downloads = new Map();
  const held = new Set();
  /**
   * The held loads the agent set off, which a take cancels where it lets
   * the page's own go on as the user's (`hold`).
   *
   * @type {WeakSet<nsIChannel>}
   */
  const agentLoads = new WeakSet();
  /**
   * The `browserId`s with a page-started load waiting on an alert. One per
   * tab, so a page cannot fill the screen with alerts.
   */
  const pageAsking = new Set();
  /**
   * The `browserId`s with an apps alert open. One per tab, so a page cannot
   * fill the screen with alerts (spec §5.2).
   */
  const appAsking = new Set();
  let observing = true;
  /** Ends with agent access, which ends every call's wait for the user. */
  const closing = new Ending();

  /**
   * @param {object} task A call's task.
   * @returns {ApprovalWait} The call's own wait for the user.
   */
  function waitOf(task) {
    return task.wait;
  }

  const writes = createWriteGate({
    store,
    ask,
    whereToAsk,
    waitOf,
    closing,
    isClosed: () => closed,
    isCallAsking: id => callAsking.has(id),
    checkPage,
    onIdle: () => stopObserving(),
  });
  const asker = createAsker({
    store,
    ask,
    whereToAsk,
    isClosed: () => closed,
    closing,
  });

  /**
   * @param {nsIURI} uri
   * @param {object} agent
   * @returns {{site: string|null, decision: string}}
   */
  function decide(uri, agent) {
    let site;
    try {
      site = hostOf(uri.spec);
    } catch {
      return { site: null, decision: "deny" };
    }
    if (site === null) {
      return { site, decision: "allow" };
    }
    return { site, decision: decideLoad(store.policyOf(agent.agentId), site) };
  }

  /**
   * The agent watching a top-level load, or null for a load no agent
   * watches. Failing to tell is the one failure that lets a load through.
   *
   * @param {nsILoadInfo} loadInfo
   * @returns {object|null}
   */
  function watcherOf(loadInfo) {
    try {
      if (closed || !isTopLevelDocument(loadInfo)) {
        return null;
      }
      return registry.agentForLoad(loadInfo.browsingContext);
    } catch (err) {
      SvalLog.warn(
        `the gate could not tell who a load is for: ${SvalLog.errorName(err)}`
      );
      return null;
    }
  }

  /**
   * @param {nsIURI} uri
   * @param {nsILoadInfo} loadInfo
   * @param {object} [options]
   * @param {boolean} [options.redirect] Whether the load is a redirect.
   * @returns {boolean} Whether to refuse the load outright.
   */
  function refuses(uri, loadInfo, { redirect = false } = {}) {
    const agent = watcherOf(loadInfo);
    if (!agent) {
      return false;
    }
    try {
      // An error page is docshell's own report on a load that failed, and
      // can only follow a load the gate has already seen.
      if (loadInfo.loadErrorPage) {
        return false;
      }
      // A page's own load of a `blob:` or `data:` address may be how it
      // downloads a file it made. The download attribute is on the channel
      // (`nsDocShell::DoURILoad` sets its content disposition), which a
      // content policy never sees, and the type is known only once the
      // response is in, so the load goes ahead (the file's header says what
      // decides it then). A redirect to one is no download a page made, and
      // is refused.
      if (!redirect && (uri.schemeIs("blob") || uri.schemeIs("data"))) {
        return false;
      }
      // An address another application handles opens no page: the apps
      // permission decides it where Gecko hands it on (`mayOpenApp`).
      if (isAppAddress(uri)) {
        return false;
      }
      // An http(s) load is decided at `http-on-modify-request`, before it
      // connects (`checkLoad`), which refuses it with the status that shows
      // about:agentblocked. A content policy refuses only with a status
      // Gecko picks (`nsContentSecurityManager::doContentSecurityCheck`),
      // which shows nothing.
      if (uri.schemeIs("http") || uri.schemeIs("https")) {
        return false;
      }
      if (decide(uri, agent).decision !== "deny") {
        return false;
      }
    } catch (err) {
      SvalLog.warn(
        `agent ${agent.agentId}: a page check failed: ${SvalLog.errorName(err)}`
      );
    }
    SvalLog.info(`agent ${agent.agentId}: a page load was refused`);
    return true;
  }

  const classID = Components.ID(Services.uuid.generateUUID().toString());
  const contractID = `@sval/agent-gate;1?${classID}`;
  const policy = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIContentPolicy",
      "nsIChannelEventSink",
      "nsIFactory",
    ]),
    createInstance(iid) {
      return this.QueryInterface(iid);
    },
    shouldLoad(location, loadInfo) {
      // A tab the tree does not hold yet may be an agent's once it is
      // filed (`awaitsFiling`), which its first load waits for, so its
      // loads are recorded too.
      starts.record(
        location,
        loadInfo,
        bc =>
          !closed &&
          (!!registry.agentForLoad(bc) ||
            (!!bc?.top?.embedderElement &&
              awaitsFiling(bc.top.embedderElement)))
      );
      return refuses(location, loadInfo)
        ? Ci.nsIContentPolicy.REJECT_REQUEST
        : Ci.nsIContentPolicy.ACCEPT;
    },
    shouldProcess() {
      return Ci.nsIContentPolicy.ACCEPT;
    },
    asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
      // The old channel ends here, and the new one is offered in its turn.
      writes.requestEnded(oldChannel);
      starts.redirect(oldChannel, newChannel);
      if (refuses(newChannel.URI, newChannel.loadInfo, { redirect: true })) {
        oldChannel.cancel(Cr.NS_ERROR_ABORT);
        callback.onRedirectVerifyCallback(Cr.NS_ERROR_ABORT);
        return;
      }
      callback.onRedirectVerifyCallback(Cr.NS_OK);
    },
  };

  /**
   * @param {nsIChannel} channel
   * @param {boolean} allowed
   * @param {nsresult} [refusal] What a refused load is cancelled with.
   */
  function release(channel, allowed, refusal = Cr.NS_ERROR_ABORT) {
    if (!held.delete(channel)) {
      return;
    }
    try {
      channel.resume();
      if (!allowed) {
        channel.cancel(refusal);
      }
    } catch (err) {
      SvalLog.warn(
        `releasing a held page load threw ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Where to ask about a page load or a write: always the agent's own full
   * window. The window a page's content is in can be a popup the page can
   * move, resize or close, which would take the alert with it.
   *
   * @param {object} agent
   * @returns {Promise<Window|null>}
   */
  function whereToAsk(agent) {
    return Promise.resolve()
      .then(() => agentWindow(agent.workspaceId))
      .catch(err => {
        SvalLog.warn(
          `no window to ask for agent ${agent.agentId}: ${SvalLog.errorName(err)}`
        );
        return null;
      });
  }

  /**
   * Holds `channel` until the user answers about `site`. A tab already
   * waiting on an alert has this load refused without another.
   *
   * @param {nsIHttpChannel} channel
   * @param {object} agent
   * @param {string} site
   * @param {CanonicalBrowsingContext} bc
   * @param {"computer"|"network"|null} place Where a local site is
   *   (`SITE`).
   */
  function hold(channel, agent, site, bc, place) {
    const id = bc.browserId;
    if (pageAsking.has(id)) {
      SvalLog.info(`agent ${agent.agentId}: a page load was refused unasked`);
      channel.cancel(Cr.NS_ERROR_ABORT);
      return;
    }
    const alert = asker.alert(SITE, agent, { site, place });
    // Whose load this is, told now, while it is known: one the agent started
    // carries a null principal (`SvalAgentTabs.freshLoad`), and so does a
    // redirect of one; one under way while a navigation of the agent's is
    // waited on is that navigation; one an action window is open for is what
    // the agent's input set off, as a link it clicked.
    if (
      channel.loadInfo.triggeringPrincipal?.isNullPrincipal !== false ||
      writes.actionFor(channel) !== null ||
      isAgentNavigating(id)
    ) {
      agentLoads.add(channel);
    }
    channel.suspend();
    held.add(channel);
    pageAsking.add(id);
    SvalLog.info(`agent ${agent.agentId}: a page load waits for the user`);
    alert.answer
      .catch(err => {
        SvalLog.warn(`the site alert failed: ${SvalLog.errorName(err)}`);
        return null;
      })
      .then(answer => {
        pageAsking.delete(id);
        // A load the user refused shows that it was the user's refusal
        // (about:agentblocked). One the alert could not ask about shows
        // nothing.
        release(
          channel,
          answer === "allow",
          answer === "deny" ? Cr.NS_ERROR_BLOCKED_BY_USER : Cr.NS_ERROR_ABORT
        );
      });
  }

  /**
   * The site half: a top-level load in a watched tab goes on, waits for the
   * user, or is refused. A load in a tab that could be an agent's once the
   * tree holds it waits for the tab's filing first (`holdForFiling`).
   *
   * @param {nsIHttpChannel} channel
   */
  function checkLoad(channel) {
    const loadInfo = channel.loadInfo;
    const browser =
      !closed && isTopLevelDocument(loadInfo)
        ? loadInfo.browsingContext.embedderElement
        : null;
    if (browser && awaitsFiling(browser)) {
      holdForFiling(channel, loadInfo.browsingContext);
      return;
    }
    decideTopLoad(channel);
  }

  /**
   * Holds a load in a tab that could be an agent's (`awaitsFiling`) until
   * the tab's window has filed it, then decides it as the tab's owner's
   * (`decideTopLoad`): the tree is what says whose a tab is, so nothing
   * loads in such a tab before the tree has it. The channel waits suspended at `http-on-modify-request`,
   * as `hold` holds one for an alert (WebRequest.sys.mjs `channel.suspend`).
   * A filing that fails, as in a window with no tab observer to file it,
   * refuses the load (`fileBeforeLoad`) with `NS_ERROR_TAB_NOT_FILED`,
   * whose error page, about:agentblocked, the docshell shows at the load's
   * address (`nsDocShell::DisplayLoadError`). The tab keeps the address, and
   * a reload asks for the filing again. A load cancelled with
   * `NS_ERROR_ABORT` shows nothing, and leaves the tab at `about:blank`.
   *
   * Only http(s) loads open a channel that can be held there. The other
   * first loads a page can start reach no site but its own, so there is
   * nothing to decide for them: `about:blank` takes its opener's principal,
   * a `blob:` address loads only in documents its creator's principal
   * subsumes (`URI_LOADABLE_BY_SUBSUMERS`), a
   * `javascript:` address runs in the document it is loaded into, and a
   * top-level `data:` navigation from a page is refused by Gecko
   * (`nsContentSecurityManager::AllowTopLevelNavigationToDataURI`).
   *
   * @param {nsIHttpChannel} channel
   * @param {CanonicalBrowsingContext} bc Its tab's top-level context.
   */
  function holdForFiling(channel, bc) {
    const started = ChromeUtils.now();
    const id = bc.browserId;
    channel.suspend();
    filing.add(channel);
    fileBeforeLoad(bc)
      .catch(err => {
        SvalLog.warn(
          `filing a tab before its first load failed: ${SvalLog.errorName(err)}`
        );
        return "failed";
      })
      .then(outcome => {
        if (!filing.delete(channel)) {
          return;
        }
        SvalLog.debug(
          `a first load waited ${Math.round(ChromeUtils.now() - started)} ms for its tab's filing`
        );
        try {
          // Decided for the context the filing was for, and only while the
          // load is still that tab's: one discarded or replaced meanwhile
          // is not the tab the tree now answers for.
          const current = BrowsingContext.getCurrentTopByBrowserId(id);
          if (
            outcome === "failed" ||
            bc.isDiscarded ||
            current !== channel.loadInfo.browsingContext
          ) {
            SvalLog.warn(
              "a tab could not be filed, so its first load is refused"
            );
            channel.cancel(Cr.NS_ERROR_TAB_NOT_FILED);
          } else if (!closed && outcome === "filed") {
            decideTopLoad(channel);
          }
        } catch (err) {
          SvalLog.warn(
            `a load held for its tab's filing failed: ${SvalLog.errorName(err)}`
          );
          try {
            channel.cancel(Cr.NS_ERROR_ABORT);
          } catch {}
        } finally {
          try {
            channel.resume();
          } catch {}
        }
      });
  }

  /**
   * @param {nsIHttpChannel} channel
   */
  function decideTopLoad(channel) {
    const agent = watcherOf(channel.loadInfo);
    if (!agent) {
      return;
    }
    try {
      const { site, decision } = decide(channel.URI, agent);
      if (decision === "allow") {
        return;
      }
      if (decision === "ask") {
        hold(
          channel,
          agent,
          site,
          channel.loadInfo.browsingContext.top,
          localPlaceOf(site)
        );
        return;
      }
    } catch (err) {
      SvalLog.warn(
        `agent ${agent.agentId}: a page check failed: ${SvalLog.errorName(err)}`
      );
      if (held.has(channel)) {
        release(channel, false);
        return;
      }
      refuse(channel, Cr.NS_ERROR_ABORT);
      return;
    }
    SvalLog.info(`agent ${agent.agentId}: a page load was refused`);
    refuse(channel, Cr.NS_ERROR_BLOCKED_BY_USER);
  }

  /**
   * @param {nsIChannel} channel
   * @param {nsresult} status `NS_ERROR_BLOCKED_BY_USER` for a site the
   *   user blocked for the agent, which shows about:agentblocked; anything
   *   else shows nothing.
   */
  function refuse(channel, status) {
    try {
      channel.cancel(status);
    } catch (err) {
      SvalLog.warn(`cancelling a page load threw ${SvalLog.errorName(err)}`);
    }
  }

  /**
   * Hands the response of a top-level document load in a watched tab to
   * `SvalAgentChallenge`, which reads the headers that mark a
   * human-verification page. They are read here, in the parent, and never
   * reach the page or the agent.
   *
   * @param {nsIChannel} channel
   */
  function noteResponse(channel) {
    try {
      const loadInfo = channel.loadInfo;
      if (closed || !isTopLevelDocument(loadInfo)) {
        return;
      }
      const id = loadInfo.browsingContext.browserId;
      if (id && registry.agentWatching(id)) {
        lazy.recordResponse(id, channel);
      }
    } catch (err) {
      SvalLog.warn(
        `the gate could not read a page's response: ${SvalLog.errorName(err)}`
      );
    }
  }

  const stops = {
    observe(subject) {
      let channel;
      try {
        channel = subject.QueryInterface(Ci.nsIChannel);
      } catch {
        return;
      }
      noteResponse(channel);
      try {
        writes.requestEnded(channel);
      } catch {}
    },
  };

  /**
   * Stops looking at requests. With agent access off, this waits until no
   * action is open, so an action's writes stay refused until it ends.
   */
  function stopObserving() {
    if (!observing || writes.hasOpenActions()) {
      return;
    }
    observing = false;
    Services.obs.removeObserver(requests, MODIFY_REQUEST_TOPIC);
    Services.obs.removeObserver(stops, STOP_REQUEST_TOPIC);
  }

  const requests = {
    observe(subject) {
      let channel;
      try {
        channel = subject.QueryInterface(Ci.nsIHttpChannel);
      } catch {
        return;
      }
      checkLoad(channel);
      // A load the site half held is suspended once for each half, and goes
      // on only when both have resumed it.
      writes.checkWrite(channel);
    },
  };

  /**
   * The user took control of a tab: a page load in it held for a site alert
   * goes on as the user's. The alert stays up and still records the answer
   * for the agent. A load the agent set off (`hold` tells which) is never
   * let through and is cancelled here: a navigation of the agent's was also
   * stopped by its tool the moment the tab was taken
   * (`SvalAgentTabs.navigate`), but that stop reaches the channel only once
   * the page's process has passed it on. Stopping the tab's agent cancels
   * the agent's loads the same way, and leaves the page's own held, since
   * the tab stays the agent's.
   *
   * A give back hands the agent a tab whose history holds pages the user
   * loaded unchecked, so its cached pages are dropped. "0" names a
   * workspace and no tab, so every agent tab's are.
   */
  const takes = {
    observe(_subject, _topic, data) {
      const id = Number(data);
      if (closed) {
        return;
      }
      const users = isUserInControl(id);
      if (!users) {
        forgetCachedPages(browser => !id || browserIdOf(browser) === id);
        if (!isAgentStopped(id)) {
          return;
        }
      }
      for (const channel of [...held]) {
        try {
          if (topContextOf(channel)?.browserId !== id) {
            continue;
          }
          const agents = agentLoads.has(channel);
          if (!users && !agents) {
            continue;
          }
          SvalLog.info(
            agents
              ? "a load of the agent's held for a site alert was cancelled"
              : "a page load held for a site alert is the user's"
          );
          release(channel, !agents);
        } catch (err) {
          SvalLog.warn(`a held load was not let go: ${SvalLog.errorName(err)}`);
        }
      }
    },
  };
  Services.obs.addObserver(takes, CONTROL_TOPIC);

  /**
   * Drops the pages the back-forward cache keeps for each tab the gate
   * answers as an agent's and `which` picks. A back or forward into a cached
   * page opens no channel, so no load check here sees it; with the cache
   * gone it is a load, checked as any other. A tab in the user's control is
   * left alone, since its give back drops them (`takes`). A lazy tab has no
   * content, and reading its context would insert it
   * (`Tabbrowser._createLazyBrowser`).
   *
   * @param {(browser: object, agent: object) => boolean} which
   */
  function forgetCachedPages(which) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser?.tabs ?? []) {
        if (!tab.linkedPanel) {
          continue;
        }
        const browser = tab.linkedBrowser;
        try {
          const agent = registry.agentOf(browser);
          if (
            agent &&
            !isUserInControl(browserIdOf(browser)) &&
            which(browser, agent)
          ) {
            browser.browsingContext?.sessionHistory?.evictAllDocumentViewers();
          }
        } catch (err) {
          SvalLog.warn(
            `an agent tab's cached pages were not dropped: ${SvalLog.errorName(err)}`
          );
        }
      }
    }
  }

  /**
   * @param {string} agentId
   * @returns {string} What decides which sites the agent may open
   *   (`decideLoad`): its policy's default and per-site levels.
   */
  function siteRulesOf(agentId) {
    const current = store.policyOf(agentId);
    return JSON.stringify([current?.default ?? null, current?.sites ?? null]);
  }

  /** Each agent's site rules as the gate last saw them, by agent id. */
  const rulesSeen = new Map();
  /**
   * A change to an agent's site rules can block a site its tabs keep cached
   * pages of, so they are dropped. `SvalAgents` notifies
   * `STATE_TOPIC` after every change to the store.
   */
  const rules = {
    observe() {
      if (closed) {
        return;
      }
      const changed = new Set();
      const listed = new Set();
      try {
        for (const { agentId } of store.agents?.() ?? []) {
          listed.add(agentId);
          const now = siteRulesOf(agentId);
          if (rulesSeen.get(agentId) !== now) {
            rulesSeen.set(agentId, now);
            changed.add(agentId);
          }
        }
      } catch (err) {
        SvalLog.warn(
          `the gate could not read the site rules: ${SvalLog.errorName(err)}`
        );
        forgetCachedPages(() => true);
        return;
      }
      // An unpaired agent's tabs are refused every site (`decideLoad`).
      for (const agentId of [...rulesSeen.keys()]) {
        if (!listed.has(agentId)) {
          rulesSeen.delete(agentId);
          changed.add(agentId);
        }
      }
      if (changed.size) {
        forgetCachedPages((_browser, agent) => changed.has(agent.agentId));
      }
    },
  };

  const contexts = {
    observe(subject, topic) {
      try {
        if (topic === BEFORE_SHOW_TOPIC) {
          registry.onWindowBeforeShow(subject);
        } else if (topic === GLOBAL_CREATED_TOPIC) {
          // Every page an agent's tab shows has its console watched, whether
          // or not the agent ever asks for it, so that what the page logged
          // before a grant is there once the user allows it.
          const windowGlobal = subject;
          if (
            !windowGlobal.browsingContext?.parent &&
            registry.agentForLoad(windowGlobal.browsingContext)
          ) {
            lazy.watchConsole(windowGlobal);
          }
        }
      } catch (err) {
        SvalLog.warn(
          `the gate missed a browsing context: ${SvalLog.errorName(err)}`
        );
      }
    },
  };

  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  registrar.registerFactory(classID, "sval agent gate", contractID, policy);
  for (const category of ["content-policy", "net-channel-event-sinks"]) {
    Services.catMan.addCategoryEntry(
      category,
      contractID,
      contractID,
      false,
      true
    );
  }
  Services.obs.addObserver(requests, MODIFY_REQUEST_TOPIC);
  Services.obs.addObserver(stops, STOP_REQUEST_TOPIC);
  const stopContextGone = onContextGone(id => starts.forget(id));
  Services.obs.addObserver(contexts, BEFORE_SHOW_TOPIC);
  Services.obs.addObserver(contexts, GLOBAL_CREATED_TOPIC);
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    registry.hookWindow(win);
  }
  // With no gate open, the loads in an agent's tabs went unchecked.
  for (const { agentId } of store.agents?.() ?? []) {
    rulesSeen.set(agentId, siteRulesOf(agentId));
  }
  forgetCachedPages(() => true);
  Services.obs.addObserver(rules, lazy.SvalAgents.STATE_TOPIC);
  /**
   * The site that decides a download a page in `top` started: the site of
   * the page it shows (spec §5.2), or, for a tab with no page of its own
   * yet, as a link that opened a new tab to download leaves it, of the page
   * that opened it, as `SvalAgentWrites`' `topOf` reads it for a write.
   *
   * @param {CanonicalBrowsingContext} top
   * @returns {string|null} The site, or null when there is none to decide on.
   */
  function downloadSiteOf(top) {
    try {
      const site = hostOfDocument(top.currentWindowGlobal);
      if (site !== null) {
        return site;
      }
      const opener = (top.crossGroupOpener ?? top.opener)?.top;
      return opener ? hostOfDocument(opener.currentWindowGlobal) : null;
    } catch {
      return null;
    }
  }

  /**
   * How a download a page in `bc`'s tab started is decided, if an agent
   * works in that tab.
   *
   * @param {BrowsingContext} bc
   * @param {string|null} [startSite] The site of the page that started the
   *   download, when it is known.
   * @returns {object|null}
   */
  function downloadHandler(bc, startSite) {
    if (closed) {
      return null;
    }
    const top = bc.top;
    if (top.embedderElement && awaitsFiling(top.embedderElement)) {
      // Nothing is decided in a tab that waits for its filing, and only a
      // load that opens a channel can wait for its filing (`holdForFiling`),
      // which a whole-tab http download already has. What reaches here is a
      // page's own file or a frame's, and it is refused.
      return {
        site: null,
        agentId: "",
        decide: () => "deny",
        ask: async () => "deny",
        track: entry => entry,
      };
    }
    const agent = registry.agentForLoad(top);
    if (!agent) {
      return null;
    }
    // The site the download started on, when it was recorded then
    // (`SvalAgentDownloads`); the page the tab shows now otherwise.
    const site = startSite !== undefined ? startSite : downloadSiteOf(top);
    return {
      site,
      agentId: agent.agentId,
      decide: () =>
        site === null ? "deny" : asker.decision(DOWNLOADS, agent, { site }),
      ask: () =>
        asker.alert(DOWNLOADS, agent, { site, action: ++downloadsAsked })
          .answer,
      track(entry) {
        entry.site = site;
        let list = downloads.get(agent.agentId);
        if (!list) {
          list = [];
          downloads.set(agent.agentId, list);
        }
        list.push(entry);
        if (list.length > MAX_DOWNLOADS_LISTED) {
          list.shift();
        }
        return entry;
      },
    };
  }
  addDownloadHolder(downloadHandler, starts.startOf);

  /**
   * Saves, or refuses, a PDF the viewer in an agent's tab asks to save, by
   * the download permission of the PDF's site: saved to the download folder
   * with no dialog, listed in `list_downloads`, asked about first on an
   * undecided site.
   *
   * @param {Element} browser
   * @returns {Function|null} What to do with the viewer's message, if an
   *   agent works in the tab.
   */
  function pdfSaver(browser) {
    const bc = browser?.browsingContext;
    const handler = bc && downloadHandler(bc);
    if (!handler) {
      return null;
    }
    return async (actor, message) => {
      const { blobUrl, filename } = message.data;
      const done = () => endPdfSave(message);
      const entry = handler.track({
        fileName: filename,
        path: null,
        state: "awaiting_approval",
        bytes: 0,
        download: null,
      });
      let decision;
      try {
        decision = handler.decide();
      } catch (err) {
        SvalLog.warn(`deciding a PDF save failed: ${SvalLog.errorName(err)}`);
        decision = "deny";
      }
      if (decision === "ask") {
        try {
          decision = await handler.ask();
        } catch (err) {
          SvalLog.warn(`the download alert failed: ${SvalLog.errorName(err)}`);
          decision = "deny";
        }
      }
      if (decision !== "allow") {
        entry.state = decision === "no_window" ? "cancelled" : "denied";
        SvalLog.info(`agent ${handler.agentId}: a PDF save was ${entry.state}`);
        done();
        return;
      }
      entry.state = "in_progress";
      try {
        const download = await saveToDownloads(
          blobUrl,
          filename,
          lazy.PrivateBrowsingUtils.isBrowserPrivate(actor.browser),
          actor.browser.browsingContext.id
        );
        entry.download = download;
        entry.path = download.target.path;
      } catch (err) {
        entry.state = "failed";
        SvalLog.warn(`an agent's PDF save failed: ${SvalLog.errorName(err)}`);
      } finally {
        done();
      }
    };
  }
  pdfSavers.add(pdfSaver);

  /**
   * Where a tab a page in `opener` asks for opens: in the agent's workspace
   * whenever the tab is watched, in the user's control or not, since a
   * workspace the user holds is still the agent's (spec §6).
   *
   * @param {Element} opener The `<browser>` of a page asking for a new tab.
   * @returns {{window: Window|null, open: () => Promise<Window>}|null} When
   *   the tab is an agent's, the agent's full window, if one is open, and
   *   how to open one.
   */
  function routeTab(opener) {
    if (closed) {
      return null;
    }
    const agent = registry.agentOpening(opener);
    return agent
      ? {
          window: lazy.fullWindowShowing(agent.workspaceId),
          open: () =>
            lazy.windowForWorkspace(agent.workspaceId, { open: true }),
        }
      : null;
  }
  tabRouters.add(routeTab);

  // A tab waiting for its filing is no one's to open a picker in or write
  // the clipboard from, as nothing is decided there before it is filed.
  const holdsTab = bc =>
    !closed &&
    ((!!registry.agentWatching(bc.browserId) &&
      !isUserInControl(bc.browserId)) ||
      (!!bc.embedderElement && awaitsFiling(bc.embedderElement)));
  tabHolders.add(holdsTab);
  appDeciders.add(appDecider);

  /**
   * Refuses to let the agent read what a page on `site` shows, unless it may
   * open the site now.
   *
   * @param {object} agent
   * @param {string|null} site A site from `hostOf`; null for about:blank.
   * @returns {true}
   */
  function checkSite(agent, site) {
    if (site === null) {
      return true;
    }
    const decision = decideLoad(store.policyOf(agent.agentId), site);
    if (decision === "allow") {
      return true;
    }
    if (decision === "deny") {
      throw denied(site);
    }
    throw new ToolError(
      "policy_denied",
      `${site} has not been allowed for this agent. Tell the user, and don't look for another way to reach it.`,
      { reason: "not_allowed" }
    );
  }

  /**
   * Refuses a tool that would read or act in what `browser` shows, unless
   * the agent may open its site now.
   *
   * @param {object} agent
   * @param {object} browser
   * @returns {true}
   */
  function checkPage(agent, browser) {
    const windowGlobal = browser.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      throw new ToolError("no_document");
    }
    return checkSite(agent, hostOfDocument(windowGlobal));
  }

  /**
   * The site of the document that hands an address to another application:
   * its principal's, as `hostOfPrincipal` reads a document's. The document's
   * own address is passed when `bc` holds the document with that principal,
   * which PDF.js's needs.
   *
   * @param {nsIPrincipal|null} principal
   * @param {BrowsingContext} bc
   * @returns {string}
   */
  function launcherSiteOf(principal, bc) {
    const wgp = bc.currentWindowGlobal;
    const own =
      !!principal && !!wgp?.documentPrincipal?.equals(principal)
        ? wgp.documentURI
        : null;
    const site = hostOfPrincipal(principal, own);
    if (site === null) {
      throw new Error("no site");
    }
    return site;
  }

  /**
   * Decides an address a page in the agent's tab hands to another
   * application, asking the user about a scheme its site has no answer for.
   * A tab holds one apps alert; a further launch in it while that is up
   * opens nothing. Closing the window under the alert, or agent access
   * closing, opens nothing and records nothing.
   *
   * @param {object} agent
   * @param {nsIURI} uri
   * @param {nsIPrincipal|null} principal
   * @param {BrowsingContext} bc
   * @param {string|null} appName
   * @returns {Promise<boolean>}
   */
  async function decideApp(agent, uri, principal, bc, appName) {
    const subject = {
      site: launcherSiteOf(principal, bc),
      topSite: hostOfDocument(bc.top.currentWindowGlobal),
      scheme: uri.scheme,
      uri,
      appName,
    };
    const decision = asker.decision(APP, agent, subject);
    if (decision !== "ask") {
      SvalLog.info(
        `agent ${agent.agentId}: an app launch was ${decision === "allow" ? "allowed" : "refused"} by policy`
      );
      return decision === "allow";
    }
    const id = bc.top.browserId;
    if (appAsking.has(id)) {
      SvalLog.info(`agent ${agent.agentId}: an app launch was refused unasked`);
      return false;
    }
    appAsking.add(id);
    try {
      return (await asker.alert(APP, agent, subject).answer) === "allow";
    } finally {
      appAsking.delete(id);
    }
  }

  /**
   * This gate's answer for `mayOpenApp`: null when no agent of its works in
   * the tab of `bc`. A tab the tree holds no node for yet, as one a page's
   * `window.open` made, is the agent's its openers are
   * (`registry.agentOpening`), where it is filed: Gecko closes such a tab
   * once it hands the address on (`MaybeCloseWindowHelper`), so it is often
   * never filed. Failing to tell refuses the launch in a tab marked as an
   * agent's (`svalAgentTab`), or when even the mark cannot be read.
   *
   * @param {nsIURI} uri
   * @param {nsIPrincipal|null} principal
   * @param {BrowsingContext} bc
   * @param {string|null} appName
   * @returns {Promise<boolean>|null}
   */
  function appDecider(uri, principal, bc, appName) {
    if (closed) {
      return null;
    }
    const failed = err => {
      SvalLog.warn(
        `an app launch in an agent's tab failed: ${SvalLog.errorName(err)}`
      );
      return false;
    };
    let top = null;
    try {
      top = bc.top;
      const browser = top.embedderElement;
      const agent =
        browser && awaitsFiling(browser)
          ? registry.agentOpening(browser)
          : registry.agentForLoad(bc);
      if (!agent) {
        return null;
      }
      return decideApp(agent, uri, principal, bc, appName).catch(failed);
    } catch (err) {
      let marked = true;
      try {
        marked = !!top?.svalAgentTab;
      } catch {}
      if (!marked) {
        return null;
      }
      return Promise.resolve(failed(err));
    }
  }

  return {
    /**
     * Whether the agent may see `site`'s tools, asking the user about a site
     * they have not decided on (site-tools spec §4.2). A page that offers no
     * tools is never asked about: the caller passes its names.
     *
     * @param {object} agent
     * @param {string} site
     * @param {string[]} names The tools the page offers.
     * @param {object} [task] The call's task, carrying its wait.
     * @returns {Promise<void>} Resolves when allowed. Every refusal throws a
     *   `ToolError`.
     */
    async allowPageTools(agent, site, names, task) {
      await asker.permit(SITE_TOOLS, agent, { site, names }, waitOf(task));
    },

    /**
     * What a call of one of `site`'s tools does (site-tools spec §4.3), from
     * the agent's setting, the site's level and the grants.
     *
     * @param {object} agent
     * @param {string} site
     * @param {{name: string, read_only: boolean}} tool
     * @param {string} hash The tool's definition hash.
     * @returns {{action: string, always?: boolean}} As `decideCall`.
     */
    decidePageToolCall(agent, site, tool, hash) {
      return decideSiteToolCall(store.policyOf(agent.agentId), {
        site,
        tool,
        hash,
      });
    },

    /**
     * @param {object} agent
     * @param {string} site
     * @returns {boolean} Whether `site`'s tools are allowed for the agent now,
     *   read again just before a call runs.
     */
    pageToolsAllowed(agent, site) {
      return asker.decision(SITE_TOOLS, agent, { site }) === "allow";
    },

    /**
     * Asks the user about one call of a site's tool (site-tools spec §4.3):
     * the tool, what it says it does, and the arguments it would send.
     * Allow and Deny answer for this call. "Always allow" records a grant for
     * this definition of the tool, offered only when `always` is true, so a
     * tool the site registers or changes later asks again; "Always deny"
     * blocks the site's tools (layer C).
     *
     * @param {object} agent
     * @param {object} browser The tab the call is for.
     * @param {object} call
     * @param {string} call.site
     * @param {{name: string, description: string}} call.tool
     * @param {object} call.input
     * @param {boolean} call.always
     * @param {string} call.hash The definition's hash, which the grant
     *   holds and which tells a repeated call from another.
     * @param {object} [task] The call's task, carrying its wait.
     * @returns {Promise<"allow"|"allow_always">} Every refusal throws a
     *   `ToolError`.
     */
    async allowPageToolCall(
      agent,
      browser,
      { site, tool, input, always, hash },
      task
    ) {
      const id = browserIdOf(browser);
      const documentId =
        browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null;
      // An Allow once the user gave after this call had stopped waiting is
      // this call's, once.
      const lateKey = JSON.stringify([
        agent.agentId,
        documentId,
        site,
        tool.name,
        hash,
        input,
      ]);
      if (lateAllows.delete(lateKey)) {
        return "allow";
      }
      if (callAsking.has(id)) {
        throw new ToolError(
          "awaiting_approval",
          "Sval is already asking the user about a call of a site's tool in this tab. Ask them to answer in Sval."
        );
      }
      const sent = JSON.stringify(input, null, 2) ?? "{}";
      if (sent.length > MAX_INPUT_SHOWN) {
        throw new ToolError(
          "invalid_arguments",
          `This call needs the user's approval, and its input is too long for Sval to show them in full: ${sent.length} characters as formatted JSON, over ${MAX_INPUT_SHOWN}. Nothing ran. Send a shorter input.`
        );
      }
      let gaveUp = false;
      const asked = async () => {
        callAsking.add(id);
        try {
          const given = await asker.alert(SITE_TOOL_CALL, agent, {
            site,
            tool,
            hash,
            sent,
            always,
          }).answer;
          if (given === "allow" && gaveUp) {
            lateAllows.add(lateKey);
          }
          return given;
        } finally {
          callAsking.delete(id);
        }
      };
      const answer = await awaitAnswer({
        wait: waitOf(task),
        answer: asked,
        awaiting: `Sval is asking the user whether this agent may run ${site}'s tool "${tool.name}". Nothing ran. Ask them to answer in Sval, then make the same call again.`,
        closing,
        onGiveUp: () => {
          gaveUp = true;
        },
      });
      if (answer === "allow" || (answer === "allow_always" && always)) {
        return answer;
      }
      throw new ToolError(
        "policy_denied",
        `The user did not allow this call of ${site}'s tool "${tool.name}".`
      );
    },

    /**
     * @param {object} agent
     * @param {string} site
     * @returns {boolean} Whether files the user allowed may still go to
     *   `site`: read again just before they are sent, since the user can
     *   block the site, or deny its uploads, while the agent works.
     */
    uploadAllowed(agent, site) {
      return asker.decision(UPLOADS, agent, { site }) !== "deny";
    },

    /**
     * Whether the agent may read the console of pages on `site`, asking the
     * user the first time (spec §4.5). A call that stops waiting
     * (`ApprovalWait`) answers `awaiting_approval` and leaves the alert up;
     * the answer is recorded for the site, so the agent's retry reads it.
     *
     * @param {object} agent
     * @param {string} site
     * @param {object} [task] The call's task, carrying its wait.
     * @returns {Promise<void>} Every refusal throws a `ToolError`.
     */
    async allowConsole(agent, site, task) {
      await asker.permit(CONSOLE, agent, { site }, waitOf(task));
    },

    /**
     * @param {object} agent
     * @param {string} site
     * @returns {boolean} Whether the agent may read the console of pages on
     *   `site` now: read again as the messages come back, since the user can
     *   deny it, or block the site, while the agent works.
     */
    consoleAllowed(agent, site) {
      return asker.decision(CONSOLE, agent, { site }) === "allow";
    },

    /**
     * The agent's downloads, the ones its tabs started, oldest first. The
     * user's own downloads are never among them.
     *
     * @param {object} agent
     * @returns {Array<{file_name: string, path: string, state: string, bytes: number}>}
     */
    listDownloads(agent) {
      return (downloads.get(agent.agentId) ?? []).map(entry => {
        const { download } = entry;
        let state = entry.state;
        let bytes = entry.bytes;
        let path = entry.path;
        if (download && state === "in_progress") {
          if (download.succeeded) {
            state = "done";
          } else if (download.canceled) {
            state = "cancelled";
          } else if (download.error) {
            state = "failed";
          }
          bytes = download.currentBytes;
          path = download.target.path;
        }
        // A download is named only while the agent may read the site it
        // came from, as a tab is.
        let readable = false;
        try {
          readable = checkSite(agent, entry.site) === true;
        } catch {}
        let fileName = null;
        if (readable) {
          fileName = path ? PathUtils.filename(path) : entry.fileName;
        }
        return {
          file_name: fileName,
          path: readable ? path : null,
          state,
          bytes,
        };
      });
    },

    /**
     * Whether the agent may upload files to the site of the page `browser`
     * shows, asking the user unless the site's uploads are denied, or every
     * file lies in a folder the user allowed it with "Always allow" and none
     * is hidden (`inUploadFolders`, spec §5.2). A call that stops waiting (`ApprovalWait`) answers
     * `awaiting_approval` and leaves the alert up; an Allow given then is
     * kept for the agent's retry of the same files.
     *
     * @param {object} agent
     * @param {object} browser
     * @param {string[]} filePaths Resolved full paths.
     * @param {object} [task] The call's task, carrying its wait.
     * @returns {Promise<string>} The site the upload was allowed for, which
     *   the caller must find the tab still on (`uploadAllowed`). Every
     *   refusal throws a `ToolError`.
     */
    async allowUpload(agent, browser, filePaths, task) {
      const site = hostOfDocument(browser.browsingContext?.currentWindowGlobal);
      if (site === null) {
        throw new ToolError(
          "policy_denied",
          "This page has no site for the user to allow uploads to."
        );
      }
      const refused = () => UPLOADS.refused({ site });
      const lateKey = JSON.stringify([
        "upload",
        agent.agentId,
        site,
        filePaths,
      ]);
      const decision = asker.decision(UPLOADS, agent, { site });
      if (decision === "deny") {
        throw refused();
      }
      if (
        (decision === "allow" &&
          inUploadFolders(
            filePaths,
            uploadFoldersFor(store.policyOf(agent.agentId), site)
          )) ||
        lateAllows.delete(lateKey)
      ) {
        return site;
      }
      // Always allow adds only the folders of files no folder allows yet,
      // so it never narrows a folder the user allowed before.
      const granted = uploadFoldersFor(store.policyOf(agent.agentId), site);
      const folders = [
        ...new Set(
          filePaths
            .filter(p => !inUploadFolders([p], granted))
            .map(p => PathUtils.parent(p))
        ),
      ];
      let gaveUp = false;
      const answer = await awaitAnswer({
        wait: waitOf(task),
        answer: () =>
          asker
            .alert(UPLOADS, agent, { site, filePaths, folders })
            .answer.then(given => {
              if (given === "allow" && gaveUp) {
                lateAllows.add(lateKey);
              }
              return given;
            }),
        awaiting: UPLOADS.awaiting({ site }),
        closing,
        onGiveUp: () => {
          gaveUp = true;
        },
      });
      if (answer === "allow") {
        // A retry that waited on the same alert takes the answer itself.
        lateAllows.delete(lateKey);
        return site;
      }
      throw refused();
    },

    /**
     * Whether the agent may load `url`, asking the user about a site they
     * have not decided on. The user is asked in the agent's own full window
     * (`whereToAsk`), never in the window the tab is in, which can be a
     * popup the page controls.
     *
     * A site the user blocked for the agent answers "blocked": the tool
     * loads it only to show about:agentblocked, which the load check in the
     * tab refuses it with (`decideTopLoad`), as for a link the agent clicked,
     * and the tool's load refuses itself too (`SvalAgentTabs.navigate`).
     *
     * @param {object} agent
     * @param {object} task
     * @param {string} url
     * @returns {Promise<true|"blocked">} Every other refusal throws a
     *   `ToolError`.
     */
    async allowLoad(agent, task, url) {
      const site = hostOf(url);
      if (site === null) {
        return true;
      }
      if (decideLoad(store.policyOf(agent.agentId), site) === "ask") {
        const answer = await awaitAnswer({
          wait: waitOf(task),
          answer: () =>
            asker.alert(SITE, agent, { site, place: localPlaceOf(site) })
              .answer,
          awaiting: SITE.awaiting({ site }),
          closing,
        });
        if (answer === "allow") {
          return true;
        }
      }
      // Read again: a refusal at the alert is recorded as the site blocked,
      // and a policy gone with the agent unpaired is no block to show.
      const current = store.policyOf(agent.agentId);
      const decision = decideLoad(current, site);
      if (decision === "allow") {
        return true;
      }
      if (decision === "deny" && current && !closed) {
        return "blocked";
      }
      throw denied(site);
    },

    checkPage,

    checkSite,

    watch: registry.watch,

    act: writes.act,

    guardWrites: writes.guardWrites,

    /**
     * @param {object} browser
     * @returns {object|null} The agent whose tab `browser` is, or null
     *   while the user has taken control of it.
     */
    agentOf(browser) {
      const id = browserIdOf(browser);
      if (isUserInControl(id)) {
        return null;
      }
      return registry.agentOf(browser);
    },

    /**
     * @returns {number}
     */
    loadsRecordedForTests() {
      return starts.size;
    },

    /**
     * Stops checking loads. A load still waiting on the user is cancelled:
     * with agent access closed, nothing is left to allow it.
     */
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closing.end();
      tabHolders.delete(holdsTab);
      appDeciders.delete(appDecider);
      removeDownloadHolder(downloadHandler);
      pdfSavers.delete(pdfSaver);
      tabRouters.delete(routeTab);
      writes.refuseAll();
      stopObserving();
      stopContextGone();
      Services.obs.removeObserver(contexts, BEFORE_SHOW_TOPIC);
      Services.obs.removeObserver(contexts, GLOBAL_CREATED_TOPIC);
      Services.obs.removeObserver(takes, CONTROL_TOPIC);
      Services.obs.removeObserver(rules, lazy.SvalAgents.STATE_TOPIC);
      for (const category of ["content-policy", "net-channel-event-sinks"]) {
        Services.catMan.deleteCategoryEntry(category, contractID, false);
      }
      registrar.unregisterFactory(classID, policy);
      for (const channel of [...held]) {
        release(channel, false);
      }
      // With agent access off no agent's tab is left to decide for.
      for (const channel of [...filing]) {
        filing.delete(channel);
        try {
          channel.resume();
        } catch {}
      }
      writes.cancelHeld();
      registry.close();
    },
  };
}
