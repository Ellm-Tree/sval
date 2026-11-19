/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The agent workspaces the user has taken control of (agent-control spec §6,
 * as decision 0107 has it).
 *
 * An agent's workspace is the agent's until the user presses Take control in
 * its window. That pauses the agent across the whole workspace, every tab in
 * it and every tab opened in it until the user gives it back, whoever opens
 * it: every tool that acts there fails with `user_in_control`, and each tab
 * behaves as one of the user's. Each gate answers "not the agent's" for its
 * tabs (`SvalAgentGate`): their loads are not checked against site policy,
 * what the user sends is not held, their dialogs are not answered, their file
 * pickers open and their downloads are the user's. Only the user's Give back
 * restores every rule; no tool reaches it. A tab the user drags out of the
 * agent's workspace is the user's once the tree files it under their own,
 * whatever state it was in (`SvalAgentTabRegistry`).
 *
 * The record is kept twice. By workspace node id, in the device's local
 * settings (`SvalLocalSettings`), so the take outlives every tab's content: a
 * discarded tab, a closed tab brought back, a crash and a restart find the
 * workspace still the user's, and the tools refuse it before any tab has a
 * browser (`isWorkspaceHeld`). And by `browserId`, for each tab's content in
 * a window showing the workspace, which stays with the content as it moves
 * between `<browser>` elements and windows and is never reused, for the
 * gates' checks, which see only browsing contexts. The gates read the first
 * through the tree: a tab filed under a held workspace is in the user's
 * control because of where it is, every tab opened there included
 * (`isUserInControl`). A window's marking keeps the second to the first as
 * each tab's content goes in (`SvalAgentMarking`). Both are shared by every
 * gate and every window, so they hold across agent access being switched off
 * and on.
 *
 * Taking control wins over a tool already running in the workspace. Its
 * pending page queries reject with `user_in_control` (`untilTaken`, which
 * `SvalAgentPageParent` races every query against), a load it started is
 * stopped (`SvalAgentTabs.navigate`), the page actor refuses any input still
 * to come (`SvalAgentPageChild`), and every input or load is checked again
 * just before it is dispatched (`refuseIfUserHolds`), however long the tool
 * waited before it.
 *
 * Stop is the user's other way to halt an agent (spec §6): it refuses every
 * call the agent makes with `stopped_by_user` until the user presses Resume,
 * and leaves the workspace the agent's. It is kept by workspace node id in
 * the same settings as a take, so it holds across a restart, and covers each
 * agent paired with the workspace. It ends what the agent has under way as a
 * take does, through the same waits (`untilTaken`) and checks
 * (`refuseIfUserHolds`, `refuseIfWorkspaceHeld`), with its own code, and the
 * agent's session answers a call still running with it at once
 * (`untilStopped`, which `SvalAgentSession` races every call against).
 *
 * Taking control changes who owns the input from then on, and nothing the
 * agent's input already set off. An action window the agent's input opened
 * before the take goes on judging the writes it would have held until it
 * closes, and writes already held wait for their alert (`SvalAgentGate`). The
 * gate's other checks answer for each tab as the user's, and a page load
 * held for a site alert when the user takes control goes on as theirs.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import { onTabGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { WORKSPACE } from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

/**
 * Notified with a tab content's `browserId` as data whenever it changes
 * hands, so every window redraws the tab's layer wherever the tab is, and
 * with "0" when a workspace does, for what has no content.
 */
export const CONTROL_TOPIC = "sval-agent-control-changed";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  agentHomeOfId:
    "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
});

/** The `browserId`s of the tab contents in the user's control. */
const taken = new Set();

/**
 * The device's local settings, where takes are kept by workspace node id.
 * Handed over by the first window's panel (`useSettings`); every window
 * shares the one store (`SvalLocalSettings.open`).
 *
 * @type {object|null}
 */
let settings = null;

/**
 * For each tab the user holds, the history entries there were when they
 * took it, by `browserId`; and for each tab given back, the entries the user
 * made while holding it, which `navigate_tab` never goes back or forward to
 * (`isUserEntry`).
 *
 * @type {Map<number, Set<number>>}
 */
const entriesAtTake = new Map();
/** @type {Map<number, Set<number>>} */
const userEntries = new Map();
/**
 * The history entries the agent's own navigations made, by `browserId`:
 * what the agent may step into in a tab whose record of the user's entries
 * is gone (`isUserEntry`).
 *
 * @type {Map<number, Set<number>>}
 */
const agentEntries = new Map();

/**
 * The loads of the agent's under way (`navigate`), by `browserId`: how many
 * calls are waiting on one. Two calls can navigate one tab at once, as one
 * waits its turn or on the user while the other loads, and each ends only
 * its own mark.
 *
 * @type {Map<number, number>}
 */
const navigating = new Map();

let dispatchingAgentLoad = false;

/**
 * Keeps takes in `store` by workspace node id from now on.
 *
 * @param {object} store A `SvalLocalSettings` store.
 */
export function useSettings(store) {
  settings = store;
}

/**
 * Forgets the takes of workspaces that are gone, and the user-history marks
 * of tabs that cannot come back: not in the document, and not in any of
 * Firefox's lists of closed tabs and windows, from which a tab returns as the
 * same node. Takes are kept by workspace, so a take kept under any other
 * node is dropped: the user takes the workspace again if they want it.
 *
 * @param {object} nodes The document's nodes, by id.
 * @returns {boolean} Whether anything changed.
 */
export function forgetGoneTabs(nodes) {
  if (!settings) {
    return false;
  }
  let dropped = false;
  for (const id of settings.userHeldIds()) {
    if (nodes[id]?.kind !== WORKSPACE) {
      settings.setUserHeld(id, false);
      dropped = true;
    }
  }
  for (const id of settings.agentStoppedIds()) {
    if (nodes[id]?.kind !== WORKSPACE) {
      settings.setAgentStopped(id, false);
      dropped = true;
    }
  }
  const keep = new Set(Object.keys(nodes));
  for (const id of closedTabNodeIds()) {
    keep.add(id);
  }
  return settings.forgetAgentTabsOtherThan(keep) || dropped;
}

/**
 * @returns {string[]} The node ids of the tabs Firefox could reopen.
 */
function closedTabNodeIds() {
  const states = [
    ...lazy.SessionStore.getClosedTabData({
      closedTabsFromAllWindows: true,
    }).map(t => t.state),
    ...lazy.SessionStore.getClosedTabDataFromClosedWindows().map(t => t.state),
    ...lazy.SessionStore.getClosedWindowData().flatMap(w => w.tabs ?? []),
  ];
  return states
    .map(state => state?.extData?.[lazy.SvalTabs.NODE_ID_KEY])
    .filter(Boolean);
}

/**
 * @param {string} workspaceId An agent's workspace node id.
 * @returns {boolean} Whether the user has taken control of that workspace.
 *   Before the settings that keep takes are read every workspace counts as
 *   taken, so nothing is let through on a record not yet known. Every
 *   window's panel hands them over before it starts agent access or draws a
 *   layer (`SvalPanel.init`).
 */
export function isWorkspaceHeld(workspaceId) {
  if (!workspaceId) {
    return false;
  }
  return settings ? settings.isUserHeld(workspaceId) : true;
}

/**
 * Records, or drops, a take of a workspace, writes it down at once, since a
 * take must survive the browser quitting straight after, and tells every
 * window (`CONTROL_TOPIC`).
 *
 * @param {string} workspaceId
 * @param {boolean} held
 * @throws {Error} When there are no settings to keep the take in. A take
 *   that cannot be kept is not made.
 */
export function holdWorkspace(workspaceId, held) {
  if (!workspaceId) {
    return;
  }
  if (!settings) {
    throw new Error("the settings that keep takes are not read yet");
  }
  if (settings.isUserHeld(workspaceId) === held) {
    return;
  }
  settings.setUserHeld(workspaceId, held);
  settings
    .flush()
    .catch(err =>
      SvalLog.warn(`a take was not written down: ${SvalLog.errorName(err)}`)
    );
  SvalLog.info(
    held
      ? "the user took control of an agent's workspace"
      : "the user gave an agent's workspace back"
  );
  Services.obs.notifyObservers(null, CONTROL_TOPIC, "0");
}

/**
 * @param {number} browserId
 * @returns {Set<number>} The ids of the history entries the tab has now.
 */
function entryIds(browserId) {
  const ids = new Set();
  try {
    const history =
      BrowsingContext.getCurrentTopByBrowserId(browserId)?.sessionHistory;
    for (let i = 0; i < (history?.count ?? 0); i++) {
      ids.add(history.getEntryAtIndex(i).ID);
    }
  } catch (err) {
    SvalLog.warn(
      `a tab's history could not be read: ${SvalLog.errorName(err)}`
    );
  }
  return ids;
}

/**
 * Records the entry `browserId`'s tab shows now as one the agent's own
 * navigation made.
 *
 * @param {number} browserId
 */
export function recordAgentEntry(browserId) {
  try {
    const history =
      BrowsingContext.getCurrentTopByBrowserId(browserId)?.sessionHistory;
    if (!history || history.index < 0) {
      return;
    }
    let ids = agentEntries.get(browserId);
    if (!ids) {
      ids = new Set();
      agentEntries.set(browserId, ids);
    }
    ids.add(history.getEntryAtIndex(history.index).ID);
  } catch (err) {
    SvalLog.warn(
      `a tab's history could not be read: ${SvalLog.errorName(err)}`
    );
  }
}

/**
 * Whether the agent must not step into a history entry, as one the user may
 * have made while holding the tab. The entries the user made are known by
 * the tab's content; a tab whose content has gone since, by a discard or a
 * restart, and that held any (`SvalLocalSettings.hasUserHistory`), lets the
 * agent into only the entries its own navigations made since.
 *
 * @param {number} browserId
 * @param {number} entryId A session history entry's `ID`.
 * @param {string|null} nodeId The tab's node id.
 * @returns {boolean}
 */
export function isUserEntry(browserId, entryId, nodeId) {
  if (userEntries.get(browserId)?.has(entryId)) {
    return true;
  }
  if (!nodeId) {
    return false;
  }
  if (!settings) {
    return true;
  }
  if (!settings.hasUserHistory(nodeId) || userEntries.has(browserId)) {
    return false;
  }
  return !agentEntries.get(browserId)?.has(entryId);
}

/**
 * Marks a load of the agent's under way in the tab until the function it
 * returns is called. The gate attributes a load it holds for its site to
 * whoever started it (`SvalAgentGate`'s `hold`), and a take cancels the
 * agent's.
 *
 * @param {number} browserId
 * @returns {Function} `done`.
 */
export function beginAgentNavigation(browserId) {
  navigating.set(browserId, (navigating.get(browserId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    const left = navigating.get(browserId) - 1;
    if (left > 0) {
      navigating.set(browserId, left);
    } else {
      navigating.delete(browserId);
    }
  };
}

/**
 * @param {number} browserId
 * @returns {boolean} Whether a load of the agent's is under way in the tab.
 */
export function isAgentNavigating(browserId) {
  return navigating.has(browserId);
}

/**
 * Runs `load`, a call that starts or stops a load of the agent's, with the
 * agent's tab letting it through: under the layer the tab refuses every
 * load, stop and history step the browser chrome asks of it
 * (`SvalAgentMarking`), and passes only those made inside this.
 *
 * @param {Function} load Called synchronously.
 * @returns {*} What `load` returned.
 */
export function asAgentLoad(load) {
  const before = dispatchingAgentLoad;
  dispatchingAgentLoad = true;
  let result;
  try {
    result = load();
  } finally {
    dispatchingAgentLoad = before;
  }
  // The flag is down again whatever `load` is, but a `load` that does its
  // loading later would do it unmarked: every caller's must be synchronous.
  if (typeof result?.then === "function") {
    throw new TypeError("asAgentLoad takes a load that runs synchronously");
  }
  return result;
}

/**
 * @returns {boolean} Whether the agent's own load is being dispatched now.
 */
export function isAgentLoadDispatch() {
  return dispatchingAgentLoad;
}

/**
 * Notified with a `<browser>` as subject as an agent's tool starts acting in
 * its tab, with data the line the window's overlay shows for it
 * (`activityText`).
 */
export const AGENT_ACTIVITY_TOPIC = "sval-agent-activity";

/**
 * The overlay's line for a tool acting on a page: what it is doing, and the
 * site, so the user sees where as well as what.
 *
 * @param {string} doing What the tool is doing (its `activity`,
 *   `SvalAgentToolTable`).
 * @param {string} [site] The page's host and port, if it has one.
 * @returns {string}
 */
export function activityText(doing, site) {
  return site ? `${doing} · ${site}` : doing;
}

/**
 * Tells `browser`'s window what an agent's tool is doing in it.
 *
 * @param {Element} browser
 * @param {string} doing The tool's `activity`.
 * @param {string} [site] The site it acts on, when that is not the page's
 *   own, as for a load.
 */
export function reportActivity(browser, doing, site) {
  let host = site;
  if (host === undefined) {
    try {
      host = browser.currentURI?.hostPort || "";
    } catch {
      host = "";
    }
  }
  Services.obs.notifyObservers(
    browser,
    AGENT_ACTIVITY_TOPIC,
    activityText(doing, host)
  );
}

/**
 * What waits on each tab being taken or its agent stopped, by `browserId`:
 * for each wait, what it does at once, then the rejection of the promise
 * `untilTaken` handed out, with the error it is called with.
 *
 * @type {Map<number, Set<Function>>}
 */
const waiting = new Map();

/**
 * Ends every wait on the tab whose content is `browserId` with `err`.
 *
 * @param {number} browserId
 * @param {ToolError} err
 */
function endWaits(browserId, err) {
  for (const stop of waiting.get(browserId) ?? []) {
    stop(err);
  }
  waiting.delete(browserId);
}

/**
 * @param {number} browserId
 */
function changed(browserId) {
  if (taken.has(browserId)) {
    endWaits(browserId, userInControl());
  }
  Services.obs.notifyObservers(null, CONTROL_TOPIC, String(browserId));
}

/**
 * @param {Element} browser A `<browser>`.
 * @returns {number} Its content's `browserId`, or 0 for one with no content.
 */
function contentIdOf(browser) {
  try {
    return browser?.browsingContext?.browserId ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Refuses an agent's input or load in `browser` the user has taken control
 * of. Called just before the input or load is dispatched.
 *
 * @param {Element} browser A `<browser>`.
 */
export function refuseIfUserHolds(browser) {
  const id = contentIdOf(browser);
  if (isUserInControl(id)) {
    throw userInControl();
  }
  if (isAgentStopped(id)) {
    throw stoppedByUser();
  }
}

let givingBack = null;

/**
 * The user gives the agent's workspace back: the one way a take ends. Every
 * window showing it gives each tab's content back as it hears of it
 * (`CONTROL_TOPIC`, `isGivingBack`).
 *
 * @param {string} workspaceId
 * @throws {Error} When there are no settings to keep the give-back in, which
 *   leaves the workspace the user's.
 */
export function giveBackWorkspace(workspaceId) {
  givingBack = workspaceId;
  try {
    holdWorkspace(workspaceId, false);
  } finally {
    givingBack = null;
  }
}

/**
 * @param {string} workspaceId
 * @returns {boolean} Whether the user's Give back of that workspace is under
 *   way, which is the only time content in the user's control in it goes
 *   back to the agent.
 */
export function isGivingBack(workspaceId) {
  return !!workspaceId && givingBack === workspaceId;
}

/**
 * @param {string} workspaceId
 */
export function refuseIfWorkspaceHeld(workspaceId) {
  if (isWorkspaceHeld(workspaceId)) {
    throw userInControl();
  }
  if (isWorkspaceStopped(workspaceId) || stoppedCalls.has(workspaceId)) {
    throw stoppedByUser();
  }
}

/**
 * A promise that rejects with `user_in_control` once the user takes control
 * of the tab whose content is `browserId`, or with `stopped_by_user` once
 * they stop its agent, and never settles otherwise. `done` stops the wait.
 *
 * @param {number} browserId
 * @param {Function} [onTaken] Called the moment the tab is taken or its
 *   agent stopped, before anything else hears of it: before the gates
 *   release what they hold for the tab (`CONTROL_TOPIC`), and before the
 *   promise's own handlers run.
 * @returns {{promise: Promise<never>, done: Function}}
 */
export function untilTaken(browserId, onTaken) {
  const { promise, reject: rejectWith } = Promise.withResolvers();
  promise.catch(() => {});
  const reject = err => {
    onTaken?.();
    rejectWith(err);
  };
  if (isUserInControl(browserId)) {
    reject(userInControl());
    return { promise, done() {} };
  }
  if (isAgentStopped(browserId)) {
    reject(stoppedByUser());
    return { promise, done() {} };
  }
  let set = waiting.get(browserId);
  if (!set) {
    set = new Set();
    waiting.set(browserId, set);
  }
  set.add(reject);
  return {
    promise,
    done() {
      set.delete(reject);
      if (!set.size && waiting.get(browserId) === set) {
        waiting.delete(browserId);
      }
    },
  };
}

/**
 * @param {number} browserId
 * @returns {boolean} Whether the tab whose content is `browserId` is in the
 *   user's control: it is filed under an agent's workspace the user holds,
 *   as the tree says (`SvalAgentTabRegistry`), so every tab there is, the
 *   ones opened since included; or its content was taken with its
 *   workspace and has not been given back.
 */
export function isUserInControl(browserId) {
  return (
    !!browserId &&
    (taken.has(browserId) || isWorkspaceHeld(lazy.agentHomeOfId(browserId)))
  );
}

/**
 * Puts the tab whose content is `browserId` in the user's control: a tab in
 * a workspace the user holds (`SvalAgentMarking`), or one a page in such a tab
 * opened (`SvalAgentGate`).
 *
 * @param {number} browserId
 * @returns {boolean} Whether this changed anything.
 */
export function takeControl(browserId) {
  if (!browserId || taken.has(browserId)) {
    return false;
  }
  taken.add(browserId);
  entriesAtTake.set(browserId, entryIds(browserId));
  SvalLog.info(`tab content ${browserId} is in the user's control`);
  changed(browserId);
  return true;
}

/**
 * Gives the tab whose content is `browserId` back to its agent, and notes
 * that its history holds entries the user made, if it does.
 *
 * @param {number} browserId
 * @param {string} [nodeId] The tab's node id.
 * @returns {boolean} Whether this changed anything.
 */
export function giveBack(browserId, nodeId) {
  if (!taken.delete(browserId)) {
    return false;
  }
  const before = entriesAtTake.get(browserId) ?? new Set();
  entriesAtTake.delete(browserId);
  const made = userEntries.get(browserId) ?? new Set();
  for (const id of entryIds(browserId)) {
    if (!before.has(id)) {
      made.add(id);
    }
  }
  userEntries.set(browserId, made);
  if (made.size && nodeId && settings && !settings.hasUserHistory(nodeId)) {
    settings.setUserHistory(nodeId, true);
    settings
      .flush()
      .catch(err =>
        SvalLog.warn(`a tab's history was not noted: ${SvalLog.errorName(err)}`)
      );
  }
  SvalLog.info(`tab content ${browserId} is back with its agent`);
  changed(browserId);
  return true;
}

/**
 * Carries the mark that a tab holds history entries the user made
 * (`isUserEntry`) onto a copy of it filed under node `toNodeId`. The copy's
 * history is its original's, and its content is new, so only the mark kept
 * by node can keep the agent out of those entries in it.
 *
 * @param {number} fromBrowserId The original's content, or 0 when it is gone.
 * @param {string} fromNodeId The original's node id.
 * @param {string} toNodeId The copy's node id.
 */
export function inheritUserHistory(fromBrowserId, fromNodeId, toNodeId) {
  if (!toNodeId || !settings || settings.hasUserHistory(toNodeId)) {
    return;
  }
  const made =
    !!userEntries.get(fromBrowserId)?.size ||
    (!!fromNodeId && settings.hasUserHistory(fromNodeId));
  if (made) {
    markUserHistory(toNodeId);
  }
}

/**
 * Notes that the tab filed under node `nodeId` holds history entries the
 * user made, so the agent steps only into entries its own navigations make
 * from here on (`isUserEntry`). A tab the user hands to an agent with its
 * history kept from it is marked so (agent-control spec §5.4).
 *
 * @param {string} nodeId
 */
export function markUserHistory(nodeId) {
  if (!nodeId || !settings || settings.hasUserHistory(nodeId)) {
    return;
  }
  settings.setUserHistory(nodeId, true);
  settings
    .flush()
    .catch(err =>
      SvalLog.warn(`a tab's history was not noted: ${SvalLog.errorName(err)}`)
    );
}

/**
 * Drops the record for a tab that is gone, or that the user took out of the
 * agent's workspace for good, which no gate watches again.
 *
 * @param {number} browserId
 */
export function forgetControl(browserId) {
  entriesAtTake.delete(browserId);
  userEntries.delete(browserId);
  agentEntries.delete(browserId);
  if (taken.delete(browserId)) {
    changed(browserId);
  }
}
onTabGone(forgetControl);

/**
 * @returns {ToolError} The refusal every tool in a workspace the user has
 *   taken answers.
 */
export function userInControl() {
  return new ToolError("user_in_control");
}

/**
 * @returns {ToolError} The refusal every call of an agent the user has
 *   stopped answers.
 */
export function stoppedByUser() {
  return new ToolError("stopped_by_user");
}

/**
 * @param {string} workspaceId An agent's workspace node id.
 * @returns {boolean} Whether the user has stopped the agent working there.
 *   Before the settings that keep Stops are read every workspace counts as
 *   stopped, as it counts as taken (`isWorkspaceHeld`).
 */
export function isWorkspaceStopped(workspaceId) {
  if (!workspaceId) {
    return false;
  }
  return settings ? settings.isAgentStopped(workspaceId) : true;
}

/**
 * @param {number} browserId
 * @returns {boolean} Whether the tab whose content is `browserId` is filed
 *   under an agent's workspace whose agent the user has stopped.
 */
export function isAgentStopped(browserId) {
  return !!browserId && isWorkspaceStopped(lazy.agentHomeOfId(browserId));
}

/**
 * The calls Stop answered whose tools are still running, by workspace node
 * id (`untilStopped`'s `keepStopped`). The agent has been told each one
 * stopped, so none may act from then on, a Resume meanwhile included: the
 * workspace is refused at every step (`refuseIfWorkspaceHeld`,
 * `isStopAnswered`) until they have all ended.
 *
 * @type {Map<string, Set<Promise>>}
 */
const stoppedCalls = new Map();

/**
 * @param {number} browserId
 * @returns {boolean} Whether a call Stop answered is still running in the
 *   workspace the tab whose content is `browserId` is filed under.
 */
export function isStopAnswered(browserId) {
  return !!browserId && stoppedCalls.has(lazy.agentHomeOfId(browserId));
}

/**
 * What waits on a workspace's agent being stopped, by workspace node id
 * (`untilStopped`).
 *
 * @type {Map<string, Set<Function>>}
 */
const stopWaits = new Map();

/**
 * @param {string} workspaceId
 * @returns {number[]} The `browserId`s of the tabs filed under the workspace
 *   in every window, peeks included.
 */
function contentIdsIn(workspaceId) {
  const ids = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const browser of win.gBrowser?.browsers ?? []) {
      const id = contentIdOf(browser);
      if (id && lazy.agentHomeOfId(id) === workspaceId) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The user presses Stop, or Resume, for the agent working in a workspace.
 * Stop is written down at once, as a take is, and ends what the agent has
 * under way there before any window hears of it: every call its session
 * runs (`untilStopped`), and every page query and load in its tabs
 * (`untilTaken`). Each tab's pages and gates then hear of it
 * (`CONTROL_TOPIC`), and every window redraws its card.
 *
 * @param {string} workspaceId
 * @param {boolean} stopped
 * @throws {Error} When there are no settings to keep the Stop in. A Stop
 *   that cannot be kept is not made.
 */
export function stopWorkspace(workspaceId, stopped) {
  if (!workspaceId) {
    return;
  }
  if (!settings) {
    throw new Error("the settings that keep Stops are not read yet");
  }
  if (settings.isAgentStopped(workspaceId) === stopped) {
    return;
  }
  settings.setAgentStopped(workspaceId, stopped);
  settings
    .flush()
    .catch(err =>
      SvalLog.warn(`a Stop was not written down: ${SvalLog.errorName(err)}`)
    );
  SvalLog.info(
    stopped ? "the user stopped an agent" : "the user let a stopped agent go on"
  );
  const ids = contentIdsIn(workspaceId);
  if (stopped) {
    for (const stop of stopWaits.get(workspaceId) ?? []) {
      stop();
    }
    stopWaits.delete(workspaceId);
    for (const id of ids) {
      endWaits(id, stoppedByUser());
    }
  }
  for (const id of ids) {
    Services.obs.notifyObservers(null, CONTROL_TOPIC, String(id));
  }
  Services.obs.notifyObservers(null, CONTROL_TOPIC, "0");
}

/**
 * A promise that rejects with `stopped_by_user` once the user stops the
 * agent working in `workspaceId`, at once if they have, and never settles
 * otherwise. `done` stops the wait.
 *
 * @param {string} workspaceId
 * @returns {{stopped: boolean, promise: Promise<never>, done: Function,
 *   drained: Promise|null, keepStopped: Function}} `stopped` says the agent
 *   is stopped already, so nothing should start. `drained` settles once
 *   every call Stop answered in the workspace has ended, and is null when
 *   none is running: a call starts only then, or its every step is refused.
 *   `keepStopped(running)` holds the workspace refused until `running`, the
 *   tool of a call Stop answered, has ended.
 */
export function untilStopped(workspaceId) {
  const { promise, reject } = Promise.withResolvers();
  promise.catch(() => {});
  const stop = () => reject(stoppedByUser());
  if (isWorkspaceStopped(workspaceId)) {
    stop();
    return { stopped: true, promise, done() {} };
  }
  if (!workspaceId) {
    return { stopped: false, promise, done() {} };
  }
  let set = stopWaits.get(workspaceId);
  if (!set) {
    set = new Set();
    stopWaits.set(workspaceId, set);
  }
  set.add(stop);
  const answered = stoppedCalls.get(workspaceId);
  return {
    stopped: false,
    promise,
    drained: answered ? Promise.allSettled(answered) : null,
    keepStopped(running) {
      let calls = stoppedCalls.get(workspaceId);
      if (!calls) {
        calls = new Set();
        stoppedCalls.set(workspaceId, calls);
      }
      calls.add(running);
      const ended = () => {
        calls.delete(running);
        if (!calls.size && stoppedCalls.get(workspaceId) === calls) {
          stoppedCalls.delete(workspaceId);
        }
      };
      running.then(ended, ended);
    },
    done() {
      set.delete(stop);
      if (!set.size && stopWaits.get(workspaceId) === set) {
        stopWaits.delete(workspaceId);
      }
    },
  };
}
