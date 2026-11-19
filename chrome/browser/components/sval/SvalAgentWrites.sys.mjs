/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The write half of an agent's gate (agent-control spec §5.3), as
 * `SvalAgentGate`'s header describes it: the action windows an input opens on
 * its tab, the writes they hold and the alerts that answer for them, the
 * late writes of a document an input reached, and the write guards of
 * sites' tools still running.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  answerOf,
  CHOICES,
  scopeMenuOf,
  tooManyWaitingToAct,
} from "moz-src:///browser/components/sval/SvalAgentAsk.sys.mjs";
import {
  isUserInControl,
  refuseIfUserHolds,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  decideLoad,
  defaultLevelOf,
  levelFor,
  hostOf,
  hostOfDocument,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import {
  browserIdOf,
  isUsersTab,
  MAX_OPENER_DEPTH,
} from "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs";
import { onTabGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

/** What a tool answers in a tab where a site's tool it called still runs. */
const pageToolRunning = () =>
  new ToolError(
    "page_tool_running",
    "A site's tool you called is still running in this tab, and nothing else may act in it until it answers. Reload or navigate the tab to end it, or work in another tab."
  );

/**
 * How long a tab's network must be quiet after an input before its action
 * window closes (spec §5.3).
 */
export const QUIET_MS = 500;

/** The longest the window stays open once the input is done (spec §5.3). */
export const CAP_MS = 10_000;

/**
 * The longest a window stays open at all, from when the input starts. An
 * input whose page never answers would otherwise hold the window open, and
 * the writes in it unasked about, for as long as the page likes.
 */
export const OPEN_MAX_MS = 30_000;

/** What the write alert says sent the writes it lists. */
const INPUT_DETAIL =
  "Clicking or typing in the page sent these requests. Allow them?";

const LATE_DETAIL =
  "A page the agent clicked or typed in sent these requests after it was done. Allow them?";

/**
 * The write alert's list for `batch`: the first `MAX_ITEMS` requests, then a
 * count of the rest. Each row carries what it shows as data, for what reads
 * the alert.
 *
 * @param {Array<{method: string, target: string, path: string}>} batch
 * @returns {Array<{text: string, data: object}>}
 */
function itemsOf(batch) {
  const items = batch.slice(0, MAX_ITEMS).map(({ method, target, path }) => ({
    text: `${method} ${target}${path}`,
    data: { method, target, path },
  }));
  if (batch.length > MAX_ITEMS) {
    const more = batch.length - MAX_ITEMS;
    items.push({ text: `and ${more} more`, data: { more } });
  }
  return items;
}

/**
 * Whether a held write the user allowed may still go out under `policy`:
 * its page's site is neither Blocked nor Read only, and its target's site
 * is not Blocked (spec §5.3).
 *
 * @param {object|null} policy The agent's policy now.
 * @param {{site: string|null, target: string}} write
 * @returns {boolean}
 */
function mayStillSend(policy, { site, target }) {
  if (!policy || typeof policy !== "object") {
    return false;
  }
  const level =
    site === null ? defaultLevelOf(policy) : levelFor(policy, site).level;
  return (
    level !== "blocked" &&
    level !== "read-only" &&
    (site === null || decideLoad(policy, site) !== "deny") &&
    decideLoad(policy, target) !== "deny"
  );
}

/**
 * @param {object} policy
 * @param {string} target A host, as `targetOf` names it.
 * @returns {boolean} Whether a rule along the target's scope chain sets it
 *   to Blocked (`levelFor`'s `known`), as the default alone never does.
 */
function blockedByRule(policy, target) {
  const { level, known } = levelFor(policy, target);
  return known && level === "blocked";
}

/** The methods that only read. Every other method is a write. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The writes a page cannot act on the answer to: `navigator.sendBeacon`
 * (Navigator.cpp `SendBeacon`) and `<a ping>` (nsPingListener.cpp). Sites
 * send them for analytics, so an action window never holds one.
 */
const UNANSWERED_TYPES = new Set([
  Ci.nsIContentPolicy.TYPE_BEACON,
  Ci.nsIContentPolicy.TYPE_PING,
]);

/**
 * @param {nsIChannel} channel
 * @returns {boolean} Whether `channel` is a beacon or a ping.
 */
function isUnanswered(channel) {
  try {
    return UNANSWERED_TYPES.has(channel.loadInfo.externalContentPolicyType);
  } catch {
    return false;
  }
}

/**
 * How many held requests the write alert lists one by one. A page can send
 * thousands inside one window, and the rest are counted in a last line.
 */
const MAX_ITEMS = 20;

/**
 * How long one window of a write guard stays open before it is renewed, which
 * is also how often a guard checks its page is still the tab's.
 */
const GUARD_MAX_MS = 30_000;

const REAL_CLOCK = Object.freeze({
  now: () => ChromeUtils.now(),
  setTimeout,
  clearTimeout,
});

/**
 * What the write alert names a request by: the name the agent's rules for
 * where it goes are looked up by (`hostOf`), or its host when it has none,
 * and its path.
 *
 * @param {nsIChannel} channel
 * @returns {{target: string, path: string}}
 */
function targetOf(channel) {
  const uri = channel.URI;
  let target = null;
  try {
    target = hostOf(uri.spec);
  } catch {}
  return { target: target || uri.host, path: uri.filePath };
}

/**
 * `err`, carrying what became of the writes the input that threw it set
 * off. A thrown value that cannot carry them is wrapped in an `Error` that
 * names it as its cause.
 *
 * @param {unknown} err
 * @param {{writes: string, held: number}} outcome
 * @returns {Error|unknown}
 */
function withWrites(err, { writes, held }) {
  try {
    err.writes = writes;
    err.held = held;
    if (err.writes === writes && err.held === held) {
      return err;
    }
  } catch {}
  const wrapped = new Error("The input failed.", { cause: err });
  wrapped.writes = writes;
  wrapped.held = held;
  return wrapped;
}

/**
 * One input's action window on one tab (spec §5.3). It is open from when the
 * input starts until the tab's network has been quiet for `QUIET_MS` after
 * the input is done: no request has started or ended for that long, and
 * none it let through is still in flight. It closes anyway `CAP_MS` after the
 * input is done, and `openMaxMs` after it opened, whichever comes first.
 *
 * Each request the tab starts meanwhile is offered to it. A request already
 * cancelled, by the site half, is left alone. So is one `isAgents` says
 * another document sent, which is neither held nor counted, and does not
 * keep the window open. A read passes. A write is decided by the level of
 * the site the tab's top-level page is on, which `topOf` reads at the moment
 * the write starts:
 *
 * - `full`: passes.
 * - `read-only`: cancelled at once.
 * - `ask-before-writes`: suspended and added to the batch the window hands
 *   back when it closes, unless it is a beacon or a ping, which passes.
 * - anything else, or a level that cannot be read: cancelled, so a write
 *   the window cannot place never goes out unasked.
 *
 * A write to a site a rule sets to Blocked never passes unasked: where it
 * would pass, it is cancelled, and a held one is refused at release
 * (`mayStillSend`), whatever the user answers.
 *
 * After `refuseWrites`, every write is cancelled. Once the window has
 * closed, every request passes.
 */
export class ActionWindow {
  #topOf;
  #isAgents;
  #allowSite;
  #onHold;
  #clock = REAL_CLOCK;
  #open = true;
  #refusing = false;
  #inputDone = false;
  #last;
  #openUntil;
  #capAt = Infinity;
  #timer = null;
  /** Requests it let through that have not ended yet. */
  #inFlight = new Set();
  #held = [];
  #refused = 0;
  #sent = 0;
  #resolve;
  #closed = new Promise(resolve => (this.#resolve = resolve));

  /**
   * @param {object} options
   * @param {(channel: nsIChannel) => {site: string|null, level: string, targetBlocked?: boolean}} options.topOf
   *   The site of the top-level page `channel` was started from, the
   *   agent's level for it, and whether a rule blocks the site `channel`
   *   goes to.
   * @param {?string} [options.allowSite] The site whose writes the user
   *   already allowed with this action, as a page tool's call alert does
   *   (site-tools spec §4.3). Writes to a page on any other site are judged
   *   as usual, and a Read-only site still cancels them.
   * @param {(channel: nsIChannel) => boolean} [options.isAgents] Whether
   *   `channel` was sent by what the agent's input went to, and so is the
   *   window's to judge.
   * @param {(channel: nsIChannel) => void} [options.onHold] Told of each
   *   channel the window suspends.
   * @param {number} [options.openMaxMs]
   */
  constructor({
    topOf,
    isAgents = () => true,
    allowSite = null,
    onHold = () => {},
    openMaxMs = OPEN_MAX_MS,
  }) {
    this.#topOf = topOf;
    this.#isAgents = isAgents;
    this.#allowSite = allowSite;
    this.#onHold = onHold;
    this.#last = this.#clock.now();
    this.#openUntil = this.#last + openMaxMs;
    this.#arm();
  }

  /** Whether requests are still being looked at. */
  get isOpen() {
    return this.#open;
  }

  /**
   * @param {nsIChannel} channel
   * @returns {boolean} Whether `channel` is this window's to judge.
   */
  claims(channel) {
    try {
      return this.#isAgents(channel);
    } catch {
      return false;
    }
  }

  /**
   * @returns {Promise<{held: Array<{channel: nsIChannel, method: string, site: string|null, target: string, path: string}>, refused: number, sent: number}>}
   *   What the window did, once it has closed: the writes it holds, and how
   *   many it cancelled and let through.
   */
  get closed() {
    return this.#closed;
  }

  /** From now on, every write is cancelled whatever the level. */
  refuseWrites() {
    this.#refusing = true;
  }

  /**
   * Looks at a request the tab started.
   *
   * @param {nsIHttpChannel} channel
   * @returns {"pass"|"held"|"refused"}
   */
  offer(channel) {
    if (!this.#open) {
      return "pass";
    }
    try {
      if (!this.#isAgents(channel)) {
        return "pass";
      }
    } catch (err) {
      SvalLog.warn(
        `a request's sender could not be told: ${SvalLog.errorName(err)}`
      );
    }
    this.#last = this.#clock.now();
    try {
      if (!Components.isSuccessCode(channel.status)) {
        return "pass";
      }
    } catch {}
    let method = null;
    try {
      method = channel.requestMethod;
    } catch {}
    if (READS.has(method)) {
      this.#inFlight.add(channel);
      return "pass";
    }
    try {
      if (!this.#refusing) {
        const { site, level, targetBlocked } = this.#topOf(channel);
        const passes =
          level === "full" ||
          (level === "ask-before-writes" &&
            ((site && site === this.#allowSite) || isUnanswered(channel)));
        if (passes && !targetBlocked) {
          this.#sent++;
          this.#inFlight.add(channel);
          return "pass";
        }
        if (!passes && level === "ask-before-writes") {
          channel.suspend();
          this.#held.push({ channel, method, site, ...targetOf(channel) });
          this.#onHold(channel);
          return "held";
        }
      }
    } catch (err) {
      SvalLog.warn(`a write check failed: ${SvalLog.errorName(err)}`);
    }
    try {
      channel.cancel(Cr.NS_ERROR_ABORT);
    } catch (err) {
      SvalLog.warn(`cancelling a write threw ${SvalLog.errorName(err)}`);
    }
    this.#refused++;
    return "refused";
  }

  /**
   * A request ended, or was redirected to a new channel, which is offered
   * in its turn.
   *
   * @param {nsIChannel} channel
   */
  stopped(channel) {
    if (!this.#open || !this.#inFlight.delete(channel)) {
      return;
    }
    this.#last = this.#clock.now();
    if (this.#inputDone && !this.#inFlight.size) {
      this.#arm();
    }
  }

  /**
   * The input is done: the quiet time and the cap run from now.
   *
   * @returns {Promise<object>} {@link closed}.
   */
  inputDone() {
    if (!this.#inputDone && this.#open) {
      this.#inputDone = true;
      const now = this.#clock.now();
      this.#capAt = now + CAP_MS;
      this.#last = now;
      this.#arm();
    }
    return this.#closed;
  }

  /**
   * Drops requests that ended without a stop being seen for them. A
   * redirected or intercepted channel can end that way, and the window
   * must not wait on it until the cap.
   */
  #prune() {
    for (const channel of this.#inFlight) {
      let pending = false;
      try {
        pending = channel.isPending();
      } catch {}
      if (!pending) {
        this.#inFlight.delete(channel);
      }
    }
  }

  /** @returns {number} When the window would close if nothing else happens. */
  #due() {
    const cap = Math.min(this.#capAt, this.#openUntil);
    if (!this.#inputDone) {
      return this.#openUntil;
    }
    if (this.#inFlight.size) {
      // Looked at again after a quiet period, in case a request ended
      // unseen.
      return Math.min(this.#clock.now() + QUIET_MS, cap);
    }
    return Math.min(this.#last + QUIET_MS, cap);
  }

  /**
   * One timer at a time, set for when the window would close if nothing
   * else happens. A request starting only moves `#last`, and the timer sets
   * itself again when it finds the tab was not quiet, so a stream of
   * requests costs no timer each.
   */
  #arm() {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
    }
    const now = this.#clock.now();
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timer = null;
        this.#prune();
        const at = this.#clock.now();
        const cap = Math.min(this.#capAt, this.#openUntil);
        if (
          at >= cap ||
          (this.#inputDone &&
            !this.#inFlight.size &&
            at - this.#last >= QUIET_MS)
        ) {
          this.#close();
        } else {
          this.#arm();
        }
      },
      Math.max(this.#due() - now, 0)
    );
  }

  #close() {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#inFlight.clear();
    this.#resolve({
      held: this.#held,
      refused: this.#refused,
      sent: this.#sent,
    });
  }
}

/**
 * @param {nsIChannel} channel
 * @returns {CanonicalBrowsingContext|null} The top-level context the
 *   request was started from. A worker's fetch the parent creates carries
 *   its window's context as the associated one (nsILoadInfo.idl).
 */
export function topContextOf(channel) {
  const loadInfo = channel.loadInfo;
  return (
    (loadInfo?.browsingContext || loadInfo?.associatedBrowsingContext)?.top ??
    null
  );
}

/**
 * The top-level document `channel` was sent from, or null when that cannot
 * be told.
 *
 * A subresource's or a frame's load carries the inner window of the
 * document that loads it (`nsILoadInfo.innerWindowID`; LoadInfo.cpp sets it
 * from the loading node's document, or from the embedding document for a
 * frame), and that document's top-level document is its window context's
 * `topWindowContext`, which never changes. A top-level document load
 * carries none (LoadInfo.h defaults it to 0, and the top-level
 * constructor leaves it so), nor does a worker's request; for those it is
 * the document the tab shows as the parent opens the request, which for a
 * navigation is the one it is navigating away from, since the new one has
 * not committed yet. `SvalAgentGate`'s header names the race this leaves.
 *
 * @param {nsIChannel} channel
 * @returns {WindowGlobalParent|null}
 */
function senderOf(channel) {
  const id = channel.loadInfo?.innerWindowID;
  if (id) {
    const sender = WindowGlobalParent.getByInnerWindowId(id);
    return sender?.topWindowContext ?? null;
  }
  return topContextOf(channel)?.currentWindowGlobal ?? null;
}

/**
 * @param {nsIChannel} channel
 * @returns {boolean} Whether `channel` is a write that has not already
 *   been cancelled.
 */
function isWrite(channel) {
  return (
    !READS.has(channel.requestMethod) &&
    Components.isSuccessCode(channel.status)
  );
}

/**
 * @param {CanonicalBrowsingContext} top
 * @returns {Set<string>} The site origins of the documents `top` and its
 *   frames show.
 */
function siteOriginsIn(top) {
  return new Set(
    top
      .getAllBrowsingContextsInSubtree()
      .map(bc => bc.currentWindowGlobal?.documentPrincipal?.siteOrigin)
      .filter(Boolean)
  );
}

/**
 * The write half of one gate.
 *
 * @param {object} options
 * @param {{policyOf: Function, setSiteLevels: Function}} options.store
 * @param {Function} options.ask Asks the user in a window, as the gate's.
 * @param {(agent: object) => Promise<Window|null>} options.whereToAsk
 * @param {(task: object) => object} options.waitOf A call's wait for the
 *   user (`ApprovalWait`).
 * @param {object} options.closing Ends with agent access (`Ending`).
 * @param {() => boolean} options.isClosed Whether agent access is off.
 * @param {(browserId: number) => boolean} options.isCallAsking Whether the
 *   tab has a call alert of a site's tool open.
 * @param {(agent: object, browser: object) => true} options.checkPage The
 *   gate's site check of the page a tab shows.
 * @param {() => void} options.onIdle Told when an action window closes
 *   after agent access went off, so the gate can stop looking at requests
 *   once none is open.
 * @returns {object}
 */
export function createWriteGate({
  store,
  ask,
  whereToAsk,
  waitOf,
  closing,
  isClosed,
  isCallAsking,
  checkPage,
  onIdle,
}) {
  /**
   * The write guards of sites' tools still running, by the inner window id of
   * the page each runs in: `{token, documentId, release, settled}`.
   */
  const guards = new Map();

  /** The action windows those guards keep open. */
  const guardWindows = new WeakSet();

  /**
   * The action windows open on each tab, by `browserId`, newest last. `act`
   * runs one input at a time per tab (`acting`), so a tab has at most one.
   *
   * @type {Map<number, ActionWindow[]>}
   */
  const actions = new Map();

  /** Writes suspended until the user answers the write alert. */
  const heldWrites = new Set();

  /**
   * The batches of held writes the user has not answered yet, by the
   * `browserId` of the tab whose input sent them. While a tab has one, an
   * input in it is not performed: a retry would send the same write again.
   *
   * @type {Map<number, Set<Array>>}
   */
  const unanswered = new Map();

  /**
   * The top-level documents an agent's input has gone to, by the tab's
   * `browserId`, then by the document's inner window id, each with the
   * agent the input was for and the site origins of the documents its tab
   * showed (`reacherOf`). A write such a document sends after the action
   * window closed is still the agent's (`lateOwner`). A tab's entry goes
   * when the tab does.
   *
   * @type {Map<number, Map<number, {agent: object, siteOrigins: Set<string>}>>}
   */
  const actedOn = new Map();
  const stopTabGone = onTabGone(browserId => actedOn.delete(browserId));

  /**
   * The window collecting late writes on each tab, by the `browserId` of
   * the tab whose input caused them, so writes a page sends close together
   * make one alert.
   *
   * @type {Map<number, ActionWindow>}
   */
  const lateWindows = new Map();

  /**
   * The tabs with an action in progress, by `browserId`, each until its
   * action window has closed and its held writes are recorded. One action
   * at a time per tab, so one batch never holds another input's writes.
   *
   * @type {Map<number, Promise<void>>}
   */
  const acting = new Map();

  /**
   * The guard of the page `documentId`, while that page exists. A guard whose
   * page is destroyed has nothing left to guard, and ends.
   *
   * @param {number|null} documentId
   * @returns {object|undefined}
   */
  function liveGuard(documentId) {
    const guard = guards.get(documentId);
    if (!guard) {
      return undefined;
    }
    // A page in the back-forward cache can come back and go on running the
    // tool, so only a page that is destroyed ends its guard.
    const page = WindowGlobalParent.getByInnerWindowId(guard.documentId);
    if (!page || page.isClosed) {
      guard.release();
      return undefined;
    }
    return guard;
  }

  /**
   * Waits out the guard of the page `browser` shows if its tool has settled,
   * which ends within an action window's cap.
   *
   * @param {object} browser
   */
  async function settledGuard(browser) {
    const guard = guardShown(browser);
    if (guard?.settling) {
      await guard.done;
    }
  }

  /**
   * The guard of the page the tab shows: only it keeps other actions off the
   * tab.
   *
   * @param {object} browser
   * @returns {object|undefined}
   */
  function guardShown(browser) {
    return liveGuard(
      browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null
    );
  }

  /**
   * Whether the action on tab `browserId`, whose input went to the
   * top-level document `documentId`, is the one to judge `channel` (spec
   * §5.3). From that tab it is unless `channel` is known to come from
   * another top-level document: the page a navigation committed after the
   * input, whose own requests, such as its analytics, are not the agent's.
   * A request from a tab or window the page opened, found through its
   * opener (`actionFor`), is the action's while it comes from the blank
   * document the opened context starts with, or from no document yet, as
   * the load that opens it does, or from a document the acted-on page can
   * script (`reacherOf`). A page of another site that context committed
   * sends its own, as in the tab.
   *
   * @param {nsIChannel} channel
   * @param {number} browserId
   * @param {number} documentId
   * @returns {boolean}
   */
  function sentByAction(channel, browserId, documentId) {
    const sender = senderOf(channel);
    if (topContextOf(channel)?.browserId !== browserId) {
      return (
        !sender ||
        sender.isInitialDocument ||
        reacherOf(channel)?.browserId === browserId
      );
    }
    return !sender || sender.innerWindowId === documentId;
  }

  /**
   * The newest action window open on the tab `channel` was started from, or
   * on the tab whose page opened it, however many openers back. A tab the
   * tree files under a workspace of the user's is never the agent's, whatever
   * opened it. A tab the user has taken control of still has the windows the
   * agent's input opened before the take, which go on judging what that
   * input sets off. A site tool's guard judges nothing sent from a tab in the
   * user's control: there the page's writes and the user's cannot be told
   * apart, and the page is the user's, as a load held for a site alert goes
   * on as theirs (`SvalAgentGate`'s `takes`).
   *
   * @param {nsIChannel} channel
   * @returns {ActionWindow|null}
   */
  function actionFor(channel) {
    let ctx = topContextOf(channel);
    const users = isUserInControl(ctx?.browserId);
    for (let depth = 0; ctx && depth < MAX_OPENER_DEPTH; depth++) {
      if (isUsersTab(ctx.browserId)) {
        return null;
      }
      const open = users
        ? actions.get(ctx.browserId)?.filter(w => !guardWindows.has(w))
        : actions.get(ctx.browserId);
      if (open?.length) {
        // The newest window that claims the request: a site tool's guard
        // beneath newer windows still judges its own page's requests.
        return open.findLast(window => window.claims(channel)) ?? open.at(-1);
      }
      ctx = (ctx.crossGroupOpener ?? ctx.opener)?.top;
    }
    return null;
  }

  /**
   * The site of the top-level page `channel` was started from, and the
   * agent's level for it. The site is the one whose content the page holds,
   * named as the agent's rules are looked up by (`hostOfDocument`): an `about:blank` popup a frame opened and wrote
   * into is the frame's site's. A top-level context with no document yet
   * is the site of the document that opened it. A blank page with no site
   * has the agent's default level. Anything else throws, which the action
   * window takes as a write it cannot place, and refuses.
   *
   * `targetBlocked` says whether the site the request goes to has a rule
   * that blocks it. A site with no rule is left to the page's level, under
   * any default.
   *
   * @param {object} agent
   * @param {nsIChannel} channel
   * @returns {{site: string|null, level: string|undefined, targetBlocked: boolean}}
   */
  function topOf(agent, channel) {
    const top = topContextOf(channel);
    const opener = top?.crossGroupOpener ?? top?.opener;
    const site = hostOfDocument(
      top?.currentWindowGlobal ?? opener?.currentWindowGlobal
    );
    const agentPolicy = store.policyOf(agent.agentId);
    if (!agentPolicy || typeof agentPolicy !== "object") {
      return { site, level: "blocked", targetBlocked: true };
    }
    return {
      site,
      level:
        site === null
          ? defaultLevelOf(agentPolicy)
          : levelFor(agentPolicy, site).level,
      targetBlocked: blockedByRule(agentPolicy, targetOf(channel).target),
    };
  }

  /**
   * The write half: a request from a tab with an action window open is
   * offered to it. Telling which tab a request is from is the one failure
   * that lets it through, as for loads.
   *
   * @param {nsIHttpChannel} channel
   */
  function checkWrite(channel) {
    if (!actions.size && !actedOn.size) {
      return;
    }
    let action;
    let late = null;
    try {
      action = actionFor(channel);
      if (!action?.claims(channel) && isWrite(channel)) {
        late = lateOwner(channel);
      }
    } catch (err) {
      SvalLog.warn(
        `the gate could not tell who a request is for: ${SvalLog.errorName(err)}`
      );
      return;
    }
    if (late) {
      holdLate(channel, late);
    } else {
      action?.offer(channel);
    }
  }

  /**
   * The tab whose acted-on document could have made `channel` in a tab or
   * window it opened, however many openers back, with the agent its input
   * was for, or null. A page can script any document of a window it opened
   * that shares its site origin, and write into one, and a document is out
   * of its reach exactly when the two site origins differ:
   * `document.domain` cannot join them (nsIPrincipal.idl `siteOrigin`). So
   * a request there is the acting page's when the top-level document it is
   * sent from has the site origin of a document the input reached, as in
   * the tab its frames' requests are that document's whatever their own
   * origin, opaque or sandboxed included; or when the principal that
   * triggered it has, as for a navigation the acting page starts there. A
   * document the input reached is compared by the site origins its tab's
   * documents had at the input, and, while the tab still shows it, by
   * theirs now. This holds a page of the acted-on site that a popup loads,
   * its own load-time writes included, for as long as the popup shows it.
   *
   * @param {nsIChannel} channel
   * @returns {{agent: object, browserId: number}|null}
   */
  function reacherOf(channel) {
    const reaches = [
      senderOf(channel)?.documentPrincipal?.siteOrigin,
      channel.loadInfo?.triggeringPrincipal?.siteOrigin,
    ].filter(Boolean);
    let ctx = topContextOf(channel);
    for (
      let depth = 0;
      reaches.length && ctx && depth < MAX_OPENER_DEPTH;
      depth++
    ) {
      const opener = (ctx.crossGroupOpener ?? ctx.opener)?.top;
      if (!opener || isUsersTab(opener.browserId)) {
        return null;
      }
      const shown = opener.currentWindowGlobal?.innerWindowId;
      for (const [docId, entry] of actedOn.get(opener.browserId) ?? []) {
        const origins =
          docId === shown
            ? entry.siteOrigins.union(siteOriginsIn(opener))
            : entry.siteOrigins;
        if (reaches.some(reach => origins.has(reach))) {
          return { agent: entry.agent, browserId: opener.browserId };
        }
      }
      ctx = opener;
    }
    return null;
  }

  /**
   * Whose input caused `channel`, a write no open action window claims, or
   * null when it is not an agent's (spec §5.3). A write sent by a top-level
   * document an agent's input went to, or by one of its frames, is that
   * agent's however long after the input it is sent: a page can delay it by
   * a timer or a promise chain past any window, and nothing in the request
   * says how it began. The same holds in a tab or window that document
   * opened for what the document can script there (`reacherOf`), and for
   * the blank document the opened context starts with (`sentByAction`). A
   * page of another site a navigation committed is a page of its own, which
   * the agent's input never reached, so its writes are not the agent's. A
   * tab the user took, or holds now, sends the user's.
   *
   * @param {nsIChannel} channel
   * @returns {{agent: object, browserId: number}|null}
   */
  function lateOwner(channel) {
    const ctx = topContextOf(channel);
    if (!ctx || isUsersTab(ctx.browserId) || isUserInControl(ctx.browserId)) {
      return null;
    }
    const sender = senderOf(channel);
    const own = sender && actedOn.get(ctx.browserId)?.get(sender.innerWindowId);
    if (own) {
      return { agent: own.agent, browserId: ctx.browserId };
    }
    const reacher = reacherOf(channel);
    if (reacher) {
      return reacher;
    }
    if (sender && !sender.isInitialDocument) {
      return null;
    }
    const opener = (ctx.crossGroupOpener ?? ctx.opener)?.top;
    const openerDoc = opener?.currentWindowGlobal?.innerWindowId;
    const via = openerDoc && actedOn.get(opener.browserId)?.get(openerDoc);
    return via ? { agent: via.agent, browserId: opener.browserId } : null;
  }

  /**
   * Judges a late write as the input that caused it would have, in a window
   * of its own that collects every late write the same tab's input caused
   * until the tab's network is quiet. What it holds waits for the user's
   * answer, with no timeout, since no call waits on it (`askHeld`). The
   * answer is about those writes alone: the page's next late write is
   * asked about again (spec §5.3).
   *
   * @param {nsIHttpChannel} channel
   * @param {{agent: object, browserId: number}} owner
   */
  function holdLate(channel, { agent, browserId }) {
    let late = lateWindows.get(browserId);
    if (!late) {
      late = new ActionWindow({
        topOf: ch => topOf(agent, ch),
        isAgents: ch => lateOwner(ch)?.browserId === browserId,
        onHold: ch => heldWrites.add(ch),
      });
      const collecting = late;
      lateWindows.set(browserId, collecting);
      collecting.inputDone().then(done => {
        if (lateWindows.get(browserId) === collecting) {
          lateWindows.delete(browserId);
        }
        if (isClosed() || !done.held.length) {
          return;
        }
        SvalLog.info(
          `agent ${agent.agentId}: ${done.held.length} late writes wait for the user`
        );
        askHeld(agent, browserId, done.held, LATE_DETAIL);
      });
    }
    late.offer(channel);
  }

  /**
   * Tells the open windows a request ended, so a window waits for the
   * network to go quiet and not only for requests to stop starting. A
   * channel can report its end twice (one cancelled as it starts does), and
   * a window counts each channel once.
   *
   * @param {nsIChannel} channel
   */
  function requestEnded(channel) {
    if (!actions.size) {
      return;
    }
    for (const open of actions.values()) {
      for (const action of open) {
        action.stopped(channel);
      }
    }
  }

  /**
   * Releases a held write: it goes on if `allowed`, and is cancelled
   * otherwise, as WebRequest cancels a suspended channel.
   *
   * @param {nsIChannel} channel
   * @param {boolean} allowed
   */
  function releaseWrite(channel, allowed) {
    if (!heldWrites.delete(channel)) {
      return;
    }
    try {
      channel.resume();
      if (!allowed) {
        channel.cancel(Cr.NS_ERROR_ABORT);
      }
    } catch (err) {
      SvalLog.warn(`releasing a held write threw ${SvalLog.errorName(err)}`);
    }
  }

  /**
   * Asks the user about the writes a closed window holds, and releases them
   * by the answer whenever it comes. A failure to ask is a Deny. Allow and
   * Deny answer for these writes alone; "Always allow" and "Always deny"
   * set the sites' level in the policy, to Full access and Read only.
   *
   * @param {object} agent
   * @param {Array} batch The writes held, from `ActionWindow.inputDone`.
   * @param {string} detail What sent them, for the alert.
   * @returns {Promise<"allowed"|"denied">}
   */
  async function askAboutWrites(agent, batch, detail) {
    const sites = [...new Set(batch.map(w => w.site).filter(Boolean))];
    // Writes from one page can be saved for its host or its whole site. The
    // pages of several hosts each keep their own answer.
    const scope = sites.length === 1 ? scopeMenuOf(sites[0]) : undefined;
    const on = scope ? "" : ` on ${sites.join(", ")}`;
    const choices = CHOICES.map(c => ({ ...c }));
    if (sites.length) {
      choices.push(
        { id: "allow_always", label: `Always allow writes${on}` },
        { id: "deny_always", label: `Always deny writes${on}` }
      );
    }
    let choice;
    let saveFor = sites;
    try {
      const answered = answerOf(
        await ask(await whereToAsk(agent), {
          kind: detail === LATE_DETAIL ? "late-writes" : "writes",
          question: `${agent.label} is about to send:`,
          detail,
          items: itemsOf(batch),
          choices,
          defaultChoice: "deny",
          scope,
        }),
        sites[0]
      );
      choice = answered.choice;
      if (scope) {
        saveFor = [answered.name];
      }
    } catch (err) {
      SvalLog.warn(`the write alert failed: ${SvalLog.errorName(err)}`);
      choice = "deny";
    }
    // Read again: the user can have blocked a site while the alert was open,
    // and an Allow given then must not send its writes, nor turn the block
    // into Full access.
    const blockedNow = sites.some(
      site => decideLoad(store.policyOf(agent.agentId), site) === "deny"
    );
    // With agent access off, `close` has already cancelled every held write.
    const allowed =
      !isClosed() &&
      !blockedNow &&
      (choice === "allow" || choice === "allow_always");
    // Always: the user answers once per site, ever, and only Settings undoes
    // it (spec §5.3). A site blocked while the alert was open stays blocked.
    const level =
      (allowed && choice === "allow_always" && "full") ||
      (choice === "deny_always" && !isClosed() && "read-only") ||
      null;
    if (level) {
      try {
        await store.setSiteLevels(
          agent.agentId,
          saveFor,
          level,
          (policy, site) => decideLoad(policy, site) === "deny"
        );
      } catch (err) {
        SvalLog.warn(
          `recording the sites' level failed: ${SvalLog.errorName(err)}`
        );
      }
    }
    // Each write is judged again by the policy as it is at release: the user
    // can have blocked its target meanwhile, or made its page Read only.
    const policyNow = store.policyOf(agent.agentId);
    for (const write of batch) {
      releaseWrite(write.channel, allowed && mayStillSend(policyNow, write));
    }
    SvalLog.info(
      `agent ${agent.agentId}: ${batch.length} held writes ${allowed ? "allowed" : "denied"}${level ? " for good" : ""}`
    );
    return allowed ? "allowed" : "denied";
  }

  /**
   * Asks the user about `batch`, recorded as unanswered on tab `id` until
   * the answer comes, so no input in that tab is performed meanwhile.
   *
   * @param {object} agent
   * @param {number} id The `browserId` of the tab whose input sent them.
   * @param {Array} batch
   * @param {string} detail
   * @returns {Promise<"allowed"|"denied">}
   */
  function askHeld(agent, id, batch, detail) {
    let batches = unanswered.get(id);
    if (!batches) {
      batches = new Set();
      unanswered.set(id, batches);
    }
    batches.add(batch);
    return askAboutWrites(agent, batch, detail).finally(() => {
      batches.delete(batch);
      if (!batches.size && unanswered.get(id) === batches) {
        unanswered.delete(id);
      }
    });
  }

  /**
   * What became of the writes one input set off.
   *
   * @param {object} agent
   * @param {object} task
   * @param {object} browser
   * @param {{held: Array, refused: number, sent: number}} done
   * @returns {Promise<{writes: string, held: number}>}
   */
  async function settleWrites(
    agent,
    task,
    browser,
    { held: batch, refused, sent }
  ) {
    if (isClosed() && (batch.length || refused)) {
      // `close` cancelled them, and nobody is left to ask.
      return { writes: "denied", held: batch.length };
    }
    if (!batch.length) {
      if (refused) {
        SvalLog.info(`agent ${agent.agentId}: ${refused} writes refused`);
        return { writes: "refused_read_only", held: 0 };
      }
      return { writes: sent ? "allowed" : "none", held: 0 };
    }
    SvalLog.info(
      `agent ${agent.agentId}: ${batch.length} writes wait for the user`
    );
    const answer = askHeld(agent, browserIdOf(browser), batch, INPUT_DETAIL);
    const writes = await waitOf(task).until(
      answer,
      () => "awaiting_approval",
      closing
    );
    return { writes, held: batch.length };
  }

  /**
   * Runs one input in `browser`'s page with an action window open on the
   * tab, and says what became of the writes it set off. Held writes are
   * asked about in one alert once the window closes, and the call waits
   * for the answer as its task says (`ApprovalWait`). If none comes it
   * returns `awaiting_approval`, and the writes stay held until the user
   * answers.
   *
   * An input that throws is settled the same way, and its error is thrown
   * on with `writes` and `held` set on it, so no failure hides a write
   * that was held or let through.
   *
   * @param {object} browser The tab's `<browser>`, from `tabIn`.
   * @param {object} agent
   * @param {object} task The call's task, whose wait the answer is awaited
   *   by.
   * @param {() => Promise<object>} input
   * @param {object} [options]
   * @param {?string} [options.allowSite] The site whose writes the user
   *   already allowed with this action (`ActionWindow`).
   * @param {number} [options.openMaxMs] The longest the window stays open,
   *   for an input that may run longer than a click's (`OPEN_MAX_MS`).
   * @param {object} [options.guard] The token of the tab's write guard
   *   (`guardWrites`), which lets a call act while its own tool runs.
   * @param {boolean} [options.answersDialog] The input answers a page
   *   dialog, which a running tool may be waiting on, so the tab's guard
   *   lets it through. Its own window judges what the answer sets off.
   * @param {Function} [options.onHold] Told when the window holds a write,
   *   so an input that waits on its own writes can end, and the user be
   *   asked about them.
   * @returns {Promise<object>} The input's answer, with `writes` and `held`.
   */
  async function act(browser, agent, task, input, options = {}) {
    if (isClosed()) {
      throw new ToolError("disconnected", "Agent access was switched off.");
    }
    const id = browserIdOf(browser);
    if (!id) {
      throw new ToolError("no_document");
    }
    // An input may hold writes, and asking about them waits for the user.
    if (waitOf(task).full) {
      throw withWrites(tooManyWaitingToAct(), { writes: "none", held: 0 });
    }
    // A settled tool's guard ends within an action window's cap; an input
    // waits for it rather than fail.
    await settledGuard(browser);
    while (acting.has(id)) {
      await acting.get(id);
    }
    if (isClosed()) {
      throw new ToolError("disconnected", "Agent access was switched off.");
    }
    // The tool may have waited a long time to get here, on the user or on
    // the page. A tab the user took meanwhile gets no input, and nor does
    // a page whose site the user blocked or stopped allowing meanwhile:
    // this is the last check before the input, with nothing awaited after.
    refuseIfUserHolds(browser);
    checkPage(agent, browser);
    if (isCallAsking(id)) {
      throw withWrites(
        new ToolError(
          "awaiting_approval",
          "Sval is asking the user about a call of a site's tool in this tab, so this action was not performed. Ask them to answer in Sval."
        ),
        { writes: "none", held: 0 }
      );
    }
    const shown = guardShown(browser);
    if (shown && shown.token !== options.guard && !options.answersDialog) {
      throw withWrites(pageToolRunning(), { writes: "none", held: 0 });
    }
    const { promise: free, resolve: freeTab } = Promise.withResolvers();
    acting.set(id, free);
    let settling;
    let ran;
    try {
      const batches = unanswered.get(id);
      if (batches?.size) {
        const count = [...batches].reduce((n, batch) => n + batch.length, 0);
        throw withWrites(
          new ToolError(
            "awaiting_approval",
            "Sval is still waiting for the user to answer about writes this tab already sent, so this action was not performed. Ask them to answer in Sval, then check the page. Do not repeat the action."
          ),
          { writes: "awaiting_approval", held: count }
        );
      }
      // The document the input goes to. A navigation it starts commits a
      // new one, whose own requests pass.
      const reached = browser.browsingContext?.currentWindowGlobal;
      const documentId = reached?.innerWindowId ?? null;
      if (documentId !== null) {
        const docs = actedOn.get(id) ?? new Map();
        docs.set(documentId, {
          agent,
          siteOrigins: siteOriginsIn(browser.browsingContext),
        });
        actedOn.set(id, docs);
      }
      const action = new ActionWindow({
        topOf: channel => topOf(agent, channel),
        isAgents: channel =>
          documentId === null || sentByAction(channel, id, documentId),
        allowSite: options.allowSite ?? null,
        ...(options.openMaxMs ? { openMaxMs: options.openMaxMs } : {}),
        onHold: channel => {
          heldWrites.add(channel);
          options.onHold?.(channel);
        },
      });
      const open = actions.get(id) ?? [];
      open.push(action);
      actions.set(id, open);
      // The window closes on its own if the input never finishes, and the
      // writes it holds are asked about all the same.
      ran = (async () => {
        try {
          return { result: await input() };
        } catch (err) {
          return { failure: { err } };
        } finally {
          action.inputDone();
        }
      })();
      let done;
      try {
        done = await action.closed;
      } finally {
        const left = (actions.get(id) ?? []).filter(a => a !== action);
        if (left.length) {
          actions.set(id, left);
        } else {
          actions.delete(id);
        }
        if (isClosed()) {
          onIdle();
        }
      }
      // Records the held writes before it first yields, so the next input
      // on the tab, let go below, finds them unanswered.
      settling = settleWrites(agent, task, browser, done);
    } finally {
      if (acting.get(id) === free) {
        acting.delete(id);
      }
      freeTab();
    }
    const outcome = await settling;
    const { result, failure } = await ran;
    if (failure) {
      throw withWrites(failure.err, outcome);
    }
    return { ...result, ...outcome };
  }

  /**
   * Guards the page in `browser` while a site's tool runs in it (site-tools
   * spec §4.3): every write the page sends that no newer action window of
   * the call judges is cancelled, between the call's windows and after the
   * call has answered, until `release`. The tool cannot be stopped, so
   * failing closed is the only safe answer. While a guard is up, no other
   * action may start on the tab, since its window would judge the tool's
   * writes as its own.
   *
   * @param {object} browser
   * @returns {Promise<object>} The guard. Pass its `token` to `act` as
   *   `guard` for the call's own windows, and call `settled` once the tool
   *   has settled.
   */
  async function guardWrites(browser) {
    const id = browserIdOf(browser);
    const documentId =
      browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null;
    await settledGuard(browser);
    if (id && documentId !== null && guardShown(browser)) {
      throw pageToolRunning();
    }
    const token = {};
    let ended = false;
    let action = null;
    const drop = window => {
      const left = (actions.get(id) ?? []).filter(a => a !== window);
      if (left.length) {
        actions.set(id, left);
      } else {
        actions.delete(id);
      }
      if (isClosed()) {
        onIdle();
      }
    };
    const guard = {
      token,
      documentId,
      browser,
      release() {
        if (ended) {
          return;
        }
        ended = true;
        if (guards.get(documentId) === guard) {
          guards.delete(documentId);
        }
        action?.inputDone();
      },
      /** Resolves once the guard has ended. */
      done: null,
      settling: false,
      /**
       * The tool has settled. What it set off as it answered is refused
       * until the page goes quiet, as an action window closes
       * (agent-control spec §5.3), and then the guard ends.
       */
      settled() {
        if (ended || guard.settling) {
          return;
        }
        guard.settling = true;
        const last = action;
        last?.inputDone();
        (last?.closed ?? Promise.resolve()).then(() => guard.release());
      },
    };
    const { promise: done, resolve: markDone } = Promise.withResolvers();
    guard.done = done;
    const end = guard.release;
    guard.release = () => {
      end();
      markDone();
    };
    const arm = () => {
      action = new ActionWindow({
        topOf: () => ({ site: null, level: "read-only" }),
        isAgents: channel =>
          documentId === null || sentByAction(channel, id, documentId),
        openMaxMs: GUARD_MAX_MS,
      });
      action.refuseWrites();
      guardWindows.add(action);
      const open = actions.get(id) ?? [];
      open.unshift(action);
      actions.set(id, open);
      const mine = action;
      mine.closed.then(() => {
        drop(mine);
        // A guard lasts until it is released, or its page is gone.
        // Agent access going off does not stop the tool, so the guard
        // goes on refusing what it sends.
        if (!ended && !guard.settling && liveGuard(documentId) === guard) {
          arm();
        }
      });
    };
    if (id && documentId !== null) {
      guards.set(documentId, guard);
      arm();
    }
    return guard;
  }

  return {
    act,
    guardWrites,
    checkWrite,
    requestEnded,
    actionFor,

    /** @returns {boolean} Whether an action window is open on any tab. */
    hasOpenActions() {
      return actions.size > 0;
    },

    /**
     * Agent access went off: every window still open goes on refusing its
     * tab's writes until it ends, so switching access off never lets one
     * through unasked.
     */
    refuseAll() {
      for (const open of [...actions.values(), [...lateWindows.values()]]) {
        for (const action of open) {
          action.refuseWrites();
        }
      }
    },

    /**
     * Cancels every write held for the user, whom nothing is left to ask.
     * The gate's last call.
     */
    cancelHeld() {
      for (const channel of [...heldWrites]) {
        releaseWrite(channel, false);
      }
      stopTabGone();
    },
  };
}
