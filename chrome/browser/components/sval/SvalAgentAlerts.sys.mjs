/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The alerts agents raise (agent-control spec §5.1, §5.2): the Pair/Deny
 * alert a pairing request raises, and a generic alert that asks one question
 * with a choice of answers. Each is a window-modal `gDialogBox` dialog, the
 * same primitive as `SvalNewWorkspace`. `gDialogBox` queues a dialog opened
 * while another is showing, so two questions never draw over each other.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const DIALOG_URL = "chrome://browser/content/sval/agent-pair.xhtml";
const ALERT_URL = "chrome://browser/content/sval/agent-alert.xhtml";

/**
 * How many seconds a tool call waits for the user's answer to an alert, as
 * Settings › Agents sets it (decision 1880). Read as each call first waits.
 */
export const APPROVAL_WAIT_PREF = "browser.sval.agents.approvalWaitSeconds";

/** The wait when the setting holds nothing usable: an hour. */
export const DEFAULT_APPROVAL_WAIT_SECONDS = 3600;

/**
 * @returns {number} How long a call waits for the user, in milliseconds
 *   (`APPROVAL_WAIT_PREF`).
 */
export function approvalWaitMs() {
  const seconds = Services.prefs.getIntPref(
    APPROVAL_WAIT_PREF,
    DEFAULT_APPROVAL_WAIT_SECONDS
  );
  return (seconds > 0 ? seconds : DEFAULT_APPROVAL_WAIT_SECONDS) * 1000;
}

/** How often a waiting call that carries a progress token is told so. */
export const PROGRESS_EVERY_MS = 10_000;

/** What a waiting call's progress says, which the agent's client shows. */
export const WAITING_MESSAGE = "Waiting for you to answer Sval's alert";

/**
 * How many of one connection's calls may wait for the user at once. Each
 * holds an alert open, or a place in one, and the agent can start more while
 * they wait.
 */
export const MAX_WAITING_CALLS = 8;

/** The longest string Sval takes as a progress token. */
const MAX_TOKEN_CHARS = 256;

/**
 * @param {unknown} token A tool call's `params._meta.progressToken`.
 * @returns {boolean} Whether it is a progress token: MCP's are a string or
 *   a number. Sval echoes it in every notification, so a long one is none.
 */
function isProgressToken(token) {
  return (
    (typeof token === "string" && token.length <= MAX_TOKEN_CHARS) ||
    (typeof token === "number" && Number.isFinite(token))
  );
}

/**
 * Something that ends once, such as a connection closing or agent access
 * going off, which every wait listening to it hears at once.
 */
export class Ending {
  #ended = false;
  #listeners = new Set();

  get ended() {
    return this.#ended;
  }

  /** How many are listening, which ends with each wait. */
  get listening() {
    return this.#listeners.size;
  }

  /**
   * @param {() => void} fn Called once, when it ends, or at once if it has.
   * @returns {() => void} Stops listening.
   */
  onEnd(fn) {
    if (this.#ended) {
      fn();
      return () => {};
    }
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  end() {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        SvalLog.warn(`an ending's listener failed: ${SvalLog.errorName(err)}`);
      }
    }
  }
}

/**
 * One tool call's wait for the user's answer to an alert (agent-control spec
 * §5.6). Every alert a call can wait on waits through one of these.
 *
 * The answer ends the wait at once, whatever it is. So does any ending it
 * listens to: the call's connection closing, agent access going off, or the
 * agent cancelling the call (`notifications/cancelled`). A cancelled call
 * gives up every wait at once from then on. Otherwise the call waits until
 * one deadline, `approvalWaitMs()` from when it first waits. A call that
 * carries a progress token is sent `notifications/progress` as each wait
 * begins and every `PROGRESS_EVERY_MS` while it lasts, so the client shows
 * why it is waiting. `progress` rises across every wait of the call, as
 * MCP requires of one token. Nothing is sent once a wait has ended.
 *
 * At most `MAX_WAITING_CALLS` waits that share `slots`, one connection's,
 * run at once. A wait beyond that gives up at once, and `full` lets a caller
 * refuse before it raises an alert.
 *
 * Giving up never closes the alert. The answer goes on being awaited by
 * whoever else holds it, so a retry attaches to the same alert.
 */
export class ApprovalWait {
  #token;
  #notify;
  #progress = 0;
  #deadline = null;
  #ending;
  #cancel = new Ending();
  #answered = new Ending();
  #slots;
  #onWaiting;

  /**
   * @param {object} [options]
   * @param {unknown} [options.progressToken] The call's
   *   `params._meta.progressToken`; anything but a string of at most
   *   `MAX_TOKEN_CHARS` or a finite number counts as none.
   * @param {(notification: object) => void} [options.notify] Sends a
   *   notification to the agent.
   * @param {Ending} [options.ending] Ends when the call's caller is gone.
   * @param {{waiting: number}} [options.slots] How many of the connection's
   *   calls are waiting, shared by all of them.
   * @param {() => void} [options.onWaiting] Told each time a wait begins, so
   *   the connection can go on to the agent's next request meanwhile.
   */
  constructor({
    progressToken,
    notify = () => {},
    ending = null,
    slots = { waiting: 0 },
    onWaiting = () => {},
  } = {}) {
    this.#token = isProgressToken(progressToken) ? progressToken : null;
    this.#notify = notify;
    this.#ending = ending;
    this.#slots = slots;
    this.#onWaiting = onWaiting;
  }

  /** Whether the connection already has as many calls waiting as it may. */
  get full() {
    return this.#slots.waiting >= MAX_WAITING_CALLS;
  }

  get cancelled() {
    return this.#cancel.ended;
  }

  /**
   * Lets the connection go on to the agent's next request while this call
   * waits for something other than the user, such as its turn on a site
   * (`SvalAgentPolite`).
   */
  standAside() {
    try {
      this.#onWaiting();
    } catch (err) {
      SvalLog.warn(`a wait could not say it began: ${SvalLog.errorName(err)}`);
    }
  }

  /** The agent cancelled the call: every wait of it gives up, now and later. */
  cancel() {
    this.#cancel.end();
  }

  /**
   * The call was answered without waiting on its tool, as when the user
   * stops the agent: every wait of it gives up, now and later, and sends no
   * more progress for a call that has had its reply.
   */
  answeredElsewhere() {
    this.#answered.end();
  }

  #report(endings) {
    if (endings.some(e => e.ended)) {
      return;
    }
    this.#progress++;
    try {
      this.#notify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: this.#token,
          progress: this.#progress,
          message: WAITING_MESSAGE,
        },
      });
    } catch (err) {
      SvalLog.warn(
        `agent progress could not be sent: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * @param {Promise<T>} answer
   * @param {() => U} onGiveUp What to settle with when the wait runs out, an
   *   ending ends, or the connection is full. A throw rejects.
   * @param {...Ending} others Endings besides the call's own, such as agent
   *   access going off.
   * @returns {Promise<T|U>}
   * @template T, U
   */
  async until(answer, onGiveUp, ...others) {
    const endings = [
      this.#cancel,
      this.#answered,
      this.#ending,
      ...others,
    ].filter(Boolean);
    if (endings.some(e => e.ended) || this.full) {
      return onGiveUp();
    }
    this.#deadline ??= ChromeUtils.now() + approvalWaitMs();
    this.standAside();
    this.#slots.waiting++;
    const stops = [];
    let timer = null;
    let ticker = null;
    const givenUp = new Promise(resolve => {
      timer = setTimeout(
        resolve,
        Math.max(this.#deadline - ChromeUtils.now(), 0)
      );
      for (const ending of endings) {
        stops.push(ending.onEnd(resolve));
      }
    });
    if (this.#token !== null) {
      this.#report(endings);
      ticker = setInterval(() => this.#report(endings), PROGRESS_EVERY_MS);
    }
    const GAVE_UP = {};
    try {
      const settled = await Promise.race([answer, givenUp.then(() => GAVE_UP)]);
      return settled === GAVE_UP ? onGiveUp() : settled;
    } finally {
      clearTimeout(timer);
      if (ticker !== null) {
        clearInterval(ticker);
      }
      for (const stop of stops) {
        stop();
      }
      this.#slots.waiting--;
    }
  }
}

/**
 * Waits for a dialog `win.gDialogBox` was asked to open, or for `win` to go
 * away first.
 *
 * A dialog queued behind another settles only when the window opens it
 * next (`gDialogBox._openNextDialog`, from a timer of the window's own), so
 * in a window that closes it would never settle. The one showing does
 * settle, as closed any other way, which is not an answer anybody gave.
 * Both are a window that went away.
 *
 * @param {Window} win
 * @param {Promise} closed What `gDialogBox.open` returned.
 * @returns {Promise<boolean>} Whether the dialog was closed in a window that
 *   is still open.
 */
async function closedInPlace(win, closed) {
  let onUnload;
  const gone = new Promise(resolve => {
    onUnload = resolve;
    win.addEventListener("unload", onUnload, { once: true });
  });
  try {
    if ((await Promise.race([closed.then(() => true), gone])) !== true) {
      return false;
    }
  } finally {
    try {
      win.removeEventListener("unload", onUnload);
    } catch {}
  }
  return !win.closed;
}

/**
 * Asks the user whether to pair an agent, and waits for the answer.
 *
 * @param {string} label The agent's name, as its workspace will be named.
 * @param {string[]} [facts] Lines of what Sval knows of the agent beside the
 *   name it gave (`launchLines`).
 * @param {boolean} [isolated] Whether the agent asked for an isolated
 *   workspace, which the alert offers and the user may change.
 * @param {boolean} [again] Whether the app has a pairing on record, whose
 *   policy and workspaces this one keeps (`SvalAgentStore.pair`). The alert
 *   says so.
 * @returns {Promise<{action: "allow"|"deny"|"no_window", isolated?: boolean}>}
 *   `isolated` is the kind the user allowed. A dialog closed any other way
 *   is a deny. With no browser window to show it in, or with the
 *   window closed before the user answered, the user gave no answer, which
 *   is `no_window`.
 */
export async function askToPair(
  label,
  facts = [],
  isolated = false,
  again = false
) {
  // Never over a private window: an agent has no business there. Under
  // permanent private browsing `getTopWindow` ignores `private`
  // (`BrowserWindowTracker.getTopWindow`), so the window is checked too.
  const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
  if (!win?.gDialogBox || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return { action: "no_window" };
  }
  const args = {
    label,
    facts,
    isolated,
    again,
    result: null,
    // While the window is in a modal state, `gDialogBox.open` reads this as
    // an `nsIPropertyBag` and refuses a caller that is not "async", since a
    // synchronous one would deadlock (browser/base/content/browser.js). This
    // caller only awaits the dialog.
    getProperty: name => name === "async",
  };
  const closed = win.gDialogBox.open(DIALOG_URL, args);
  drawAttention(win);
  if (!(await closedInPlace(win, closed))) {
    return { action: "no_window" };
  }
  return args.result ?? { action: "deny" };
}

/**
 * Asks the user one question in `win`, and waits for the answer.
 *
 * Everything shown is set as text, never parsed as markup: a question names
 * an agent and a site, and both come from outside Sval.
 *
 * @param {Window|null} win The browser window to ask in.
 * @param {object} options
 * @param {string} [options.kind] What the alert asks about, set on the form
 *   as `data-kind`.
 * @param {string} options.question
 * @param {string} [options.detail] A line below the question.
 * @param {Array<string|{text: string, data: object}>} [options.items] A
 *   list below the detail. An item's `data` is set on its row as `data-`
 *   attributes.
 * @param {Array<{id: string, label: string}>} options.choices One button
 *   each: the default first, then the others in this order.
 * @param {string} options.defaultChoice The id that has focus, and the answer
 *   when the alert is closed any other way.
 * @param {{label: string, value: string, choices: Array<{id: string, label: string}>}} [options.options]
 *   One radio each above the buttons, `value` checked to begin with. They
 *   grant nothing themselves: the caller reads the one checked with the
 *   choice.
 * @param {{value: string, choices: Array<{id: string, label: string, sub: string}>}} [options.scope]
 *   The "Remember for" menu above the buttons (host-scoped rules spec §4),
 *   `value` picked to begin with. Like `options`, it grants nothing itself.
 * @returns {Promise<string|{choice: string, option: string, scope: string}>}
 *   The id chosen, `defaultChoice` when the alert was dismissed, or
 *   `"no_window"` when there was no window to ask in, or the window closed
 *   before the user answered. With `options` or `scope`, that id as
 *   `choice`, the radio checked as `option` and the menu's pick as `scope`.
 */
export async function ask(
  win,
  { kind, question, detail, items, choices, defaultChoice, options, scope }
) {
  const picked = (given, from) =>
    from?.choices.some(o => o.id === given) ? given : (from?.value ?? null);
  const answer = choice =>
    options || scope
      ? {
          choice,
          option: picked(args?.option, options),
          scope: picked(args?.scope, scope),
        }
      : choice;
  let args = null;
  if (!win || win.closed || !win.gDialogBox) {
    return answer("no_window");
  }
  args = {
    kind,
    question,
    detail,
    items,
    choices,
    defaultChoice,
    options,
    option: options?.value ?? null,
    scopes: scope,
    scope: scope?.value ?? null,
    result: null,
    // See `askToPair`.
    getProperty: name => name === "async",
  };
  const closed = win.gDialogBox.open(ALERT_URL, args);
  drawAttention(win);
  if (!(await closedInPlace(win, closed))) {
    return answer("no_window");
  }
  return answer(
    choices.some(c => c.id === args.result) ? args.result : defaultChoice
  );
}

/**
 * Brings the alert to the user's notice. An agent asks while Sval is usually
 * behind the agent's own app, and an alert nobody sees holds the agent's call.
 * `focus` raises the alert's window. `getAttention` still signals wherever
 * that raise is refused. Neither is worth losing the alert over, so a throw
 * is only logged.
 *
 * @param {Window} win The window the alert is in.
 */
function drawAttention(win) {
  for (const method of ["focus", "getAttention"]) {
    try {
      win[method]();
    } catch (err) {
      SvalLog.warn(`agent alert ${method} failed: ${SvalLog.errorName(err)}`);
    }
  }
}
