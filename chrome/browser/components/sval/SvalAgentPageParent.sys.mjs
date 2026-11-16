/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The parent side of an agent's page actor: what Sval asks of the page in an
 * agent's tab. Each method is one query to `SvalAgentPageChild`, and an error
 * the child answers becomes a `ToolError` with a fixed sentence, so nothing
 * the page says reaches the agent as an error message.
 *
 * `SvalAgents` registers the actor while agent access is on.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import {
  CONTROL_TOPIC,
  isAgentStopped,
  isStopAnswered,
  isUserInControl,
  stoppedByUser,
  untilTaken,
  USER_IN_CONTROL_MESSAGE,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { MAX_NEW_REFS } from "moz-src:///browser/components/sval/SvalAgentSnapshot.sys.mjs";
import { MAX_FRAME_BYTES } from "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

export const PAGE_ACTOR = "SvalAgentPage";

const MESSAGES = {
  stale_ref: "That ref is from an older snapshot or page. Take a new snapshot.",
  no_document: "The tab has no page yet.",
  page_changed:
    "The page changed while Sval was reading it. Take a new snapshot.",
  not_visible:
    "That element takes up no space on the page, so it cannot be clicked. Take a new snapshot.",
  click_intercepted:
    "Something else covers that element where it would be clicked. Take a new snapshot.",
  press_intercepted:
    "Sval pressed the element, but something moved over it before release. Sval released elsewhere. Take a new snapshot before acting again.",
  not_clickable:
    "That element holds another page, so Sval does not click into it. Take a new snapshot.",
  opens_file_picker:
    "That element opens a file chooser, which Sval does not open for agents. Give the file input its files with upload_file.",
  not_file_input: "That element is not a file input.",
  dialog_open:
    "A dialog is open in that tab and the page waits for it. Answer it with answer_dialog first.",
  bad_file:
    "That input takes one file at a time, or a file could not be read. Check the paths and try again.",
  not_editable: "That element cannot be typed into or changed.",
  not_focusable:
    "That field cannot take the keyboard focus, or the page moved focus away from it, so nothing more was typed. Take a new snapshot.",
  not_a_select: "That element is not a list of options.",
  one_option: "That list takes one option at a time.",
  no_such_option: "That list has no option with that value or label.",
  user_in_control: USER_IN_CONTROL_MESSAGE,
  page_unresponsive: "The page did not respond. Take a new snapshot.",
  unknown_key:
    "Each key must be one character or one of Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown or Space.",
};

/**
 * Child answers the agent sees under another code, each with its own
 * explanation: a click refused after the press is still an intercepted
 * click, and an element that opens a file picker is not clickable.
 */
const CODES = {
  press_intercepted: "click_intercepted",
  opens_file_picker: "not_clickable",
};

/**
 * `sendQuery` rejects with these when the page goes away before it answers:
 * `AbortError` when the actor is destroyed with the query pending
 * (`JSActor::AfterDestroy`), `InvalidStateError` when it was already gone.
 */
const PAGE_GONE = new Set(["AbortError", "InvalidStateError"]);

/**
 * Where each tab's ref numbers are up to, by `browserId`, which a tab keeps
 * across navigations and process switches.
 *
 * Every page gets a child actor of its own with its own ref table, so ref
 * numbers would start again on each page, and a ref from an older page could
 * name an element on this one. Each snapshot is given the next free number
 * and reserves `MAX_NEW_REFS` from it, so even a snapshot whose answer never
 * arrives, because its page went away, cannot hand out a number another
 * snapshot also hands out. When the answer does arrive and no later snapshot
 * has reserved past it, the unused part of the reservation is given back.
 *
 * @type {Map<number, number>}
 */
const nextRefs = new Map();

/**
 * How long Sval waits for a page to answer one query, beyond any wait the
 * query asks for itself, before it gives up with `page_unresponsive`. A page
 * whose script never yields never answers, and an agent's connection takes
 * its requests one at a time (`SvalAgents`), so without a deadline that page
 * would hold every later request of the agent's, its cancel included.
 */
export const PAGE_TIMEOUT_MS = 30_000;

let pageTimeoutMs = PAGE_TIMEOUT_MS;

/**
 * Shortens the deadline, for tests of a page that does not answer.
 *
 * @param {number} ms
 * @returns {() => void} Restores `PAGE_TIMEOUT_MS`.
 */
export function setPageTimeoutForTests(ms) {
  pageTimeoutMs = ms;
  return () => {
    pageTimeoutMs = PAGE_TIMEOUT_MS;
  };
}

/**
 * @returns {number} When a query asked now would give up (`Date.now()`
 *   time), for a call of several queries that keeps to one deadline.
 */
export function pageDeadline() {
  return Date.now() + pageTimeoutMs;
}

/**
 * Forgets where a tab that is gone had its ref numbers up to.
 *
 * @param {number} browserId
 */
export function forgetRefs(browserId) {
  nextRefs.delete(browserId);
}

const noDocument = () => new ToolError("no_document", MESSAGES.no_document);

/**
 * The page actor for what `browser` shows now. Ask again after a navigation:
 * an actor belongs to one page.
 *
 * @param {object} browser A `<browser>`.
 * @returns {SvalAgentPageParent}
 */
export function pageActor(browser) {
  tellPagesWhoHolds();
  const windowGlobal = browser.browsingContext?.currentWindowGlobal;
  if (!windowGlobal) {
    throw noDocument();
  }
  try {
    return windowGlobal.getActor(PAGE_ACTOR);
  } catch (err) {
    // The page lives in a process the actor is not registered for: the
    // parent's own, an extension's, or a privileged one.
    if (err.name === "NotSupportedError") {
      throw noDocument();
    }
    throw err;
  }
}

/**
 * Starts the console watch of a page in an agent's tab as the page is
 * created (`SvalAgentConsole`), by creating its actor. A page in a process
 * the actor is not registered for has none.
 *
 * @param {WindowGlobalParent} windowGlobal
 */
export function watchConsole(windowGlobal) {
  try {
    windowGlobal.getActor(PAGE_ACTOR).sendAsyncMessage("watchConsole");
  } catch (err) {
    if (err.name !== "NotSupportedError") {
      SvalLog.warn(
        `a page's console was not watched: ${SvalLog.errorName(err)}`
      );
    }
  }
}

let telling = false;

/**
 * Tells the page actors in a tab when the user takes control of it or stops
 * its agent, and when they give it back or resume the agent, so the page
 * refuses whatever input of the agent's is still to come
 * (`SvalAgentPageChild`), right where it would be dispatched. The query that
 * input belongs to has already been answered with the reason
 * (`untilTaken`).
 * Observed for the life of the process from the first query on: no page
 * actor exists before one.
 */
function tellPagesWhoHolds() {
  if (telling) {
    return;
  }
  telling = true;
  Services.obs.addObserver((_subject, _topic, data) => {
    const id = Number(data);
    const top = BrowsingContext.getCurrentTopByBrowserId(id);
    const held = isUserInControl(id) || isAgentStopped(id);
    for (const bc of top?.getAllBrowsingContextsInSubtree() ?? []) {
      try {
        bc.currentWindowGlobal
          ?.getExistingActor(PAGE_ACTOR)
          ?.sendAsyncMessage("userHeld", { held });
      } catch (err) {
        SvalLog.warn(
          `a page was not told who holds its tab: ${SvalLog.errorName(err)}`
        );
      }
    }
  }, CONTROL_TOPIC);
}

/** What Sval asks of one page in an agent's tab. */
export class SvalAgentPageParent extends JSWindowActorParent {
  /**
   * @param {string} name
   * @param {object} [data]
   * @param {number} [waitMs] How long the query itself waits in the page,
   *   added to the deadline.
   * @param {number} [until] A deadline of the caller's own (`pageDeadline`),
   *   which the query's own never outlasts.
   * @returns {Promise<object>} the child's answer, unless it is an error.
   */
  async #ask(name, data, waitMs = 0, until = Infinity) {
    // A tab the user takes is theirs from that moment, and an agent the user
    // stops acts no more: a query already on its way is given up, and none
    // starts, a call's that Stop answered included after a Resume.
    const id = this.browsingContext.top.browserId;
    if (isUserInControl(id)) {
      throw new ToolError("user_in_control", USER_IN_CONTROL_MESSAGE);
    }
    if (isAgentStopped(id) || isStopAnswered(id)) {
      throw stoppedByUser();
    }
    const taken = untilTaken(id);
    const late = Promise.withResolvers();
    const timer = setTimeout(
      () =>
        late.reject(
          new ToolError("page_unresponsive", MESSAGES.page_unresponsive)
        ),
      Math.max(Math.min(pageTimeoutMs + waitMs, until - Date.now()), 0)
    );
    let answer;
    const query = this.sendQuery(name, data);
    query.catch(() => {});
    try {
      answer = await Promise.race([query, taken.promise, late.promise]);
    } catch (err) {
      if (PAGE_GONE.has(err?.name)) {
        throw new ToolError("page_changed", MESSAGES.page_changed);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      taken.done();
    }
    const code = answer?.error;
    if (code !== undefined) {
      if (!Object.hasOwn(MESSAGES, code)) {
        throw new ToolError("page_failed", "Sval could not read the page.");
      }
      throw new ToolError(
        Object.hasOwn(CODES, code) ? CODES[code] : code,
        MESSAGES[code]
      );
    }
    return answer;
  }

  /**
   * @param {object} [options]
   * @param {string} [options.ref] An element's ref; outlines that element
   *   alone, and the whole document when absent.
   * @param {boolean} [options.viewportOnly] Lists only what shows in the
   *   viewport.
   * @returns {Promise<{text: string, refs: number, truncated: boolean}>}
   */
  async snapshot({ ref, viewportOnly } = {}) {
    const tab = this.browsingContext.browserId;
    const firstRef = nextRefs.get(tab) ?? 1;
    const reserved = firstRef + MAX_NEW_REFS;
    nextRefs.set(tab, reserved);
    const { text, refs, truncated, nextRef } = await this.#ask("snapshot", {
      firstRef,
      ref,
      viewportOnly,
    });
    if (
      nextRefs.get(tab) === reserved &&
      Number.isSafeInteger(nextRef) &&
      nextRef >= firstRef &&
      nextRef <= reserved
    ) {
      nextRefs.set(tab, nextRef);
    }
    return { text, refs, truncated };
  }

  /**
   * @param {object} [options]
   * @param {string} [options.ref] An element's ref; the whole document when
   *   absent.
   * @param {number} [options.offset]
   * @param {number} [options.chunk] At most `SOURCE_CHUNK_MAX` characters;
   *   `SOURCE_CHUNK_DEFAULT` when absent.
   * @returns {Promise<{html: string, offset: number, nextOffset: number|null,
   *   total: number}>}
   */
  source({ ref, offset = 0, chunk } = {}) {
    return this.#ask("source", { ref, offset, chunk });
  }

  /**
   * @param {object} [options]
   * @param {string} [options.ref] An element's ref; the whole document when
   *   absent.
   * @param {number} [options.offset]
   * @param {number} [options.chunk] At most `SOURCE_CHUNK_MAX` characters;
   *   `SOURCE_CHUNK_DEFAULT` when absent.
   * @returns {Promise<{text: string, offset: number, nextOffset: number|null,
   *   total: number}>}
   */
  text({ ref, offset = 0, chunk } = {}) {
    return this.#ask("text", { ref, offset, chunk });
  }

  /**
   * @param {object} options
   * @param {string} options.text
   * @param {number} options.timeoutMs The page clamps it to its
   *   `MAX_WAIT_MS`.
   * @returns {Promise<{found: boolean}>}
   */
  waitForText({ text, timeoutMs }) {
    return this.#ask("waitForText", { text, timeoutMs }, timeoutMs);
  }

  /**
   * Clicks the middle of the element `ref` names, after scrolling it into
   * view.
   *
   * @param {{ref: string}} options
   * @returns {Promise<{ref: string}>}
   */
  click({ ref }) {
    return this.#ask("click", { ref });
  }

  /**
   * @param {{ref: string, text: string, clear?: boolean, until?: number}} options
   *   `until` is a deadline the call keeps across several queries
   *   (`pageDeadline`).
   * @returns {Promise<{value: string}>} what the field holds afterwards, with
   *   a secret one masked.
   */
  type({ ref, text, clear = true, until }) {
    return this.#ask("type", { ref, text, clear }, 0, until);
  }

  /**
   * @param {{ref: string, values: string[]}} options Each value is an
   *   option's value or its label.
   * @returns {Promise<object>}
   */
  select({ ref, values }) {
    return this.#ask("select", { ref, values });
  }

  /**
   * Presses `keys` in order, in whatever has focus.
   *
   * @param {{keys: string[]}} options
   * @returns {Promise<object>}
   */
  press({ keys }) {
    return this.#ask("press", { keys });
  }

  /**
   * Scrolls the element `ref` names into view, or scrolls toward
   * `direction` by `amount` steps (`SvalAgentPageChild`'s `#scroll`).
   *
   * @param {{ref?: string, direction?: string, amount?: number}} options
   * @returns {Promise<object>}
   */
  scroll({ ref, direction, amount }) {
    return this.#ask("scroll", { ref, direction, amount });
  }

  /**
   * Checks that `ref` names a file input that takes `count` files, before
   * anyone is asked about the upload.
   *
   * @param {{ref: string, count: number}} options
   * @returns {Promise<object>}
   */
  fileInput({ ref, count }) {
    return this.#ask("fileInput", { ref, count });
  }

  /**
   * Gives the file input `ref` names `files`, as a person picking them
   * would, and fires its `input` and `change` events. The files are made in
   * the parent from bytes it read (`SvalAgentTools.checkedFiles`) and cross
   * to the page's process with the query, which structured-clones a `File`
   * (JSWindowActor messages carry blobs). The page's process never opens a
   * path: it may not unless `dom.file.createInChild` lets every content
   * process do so, the pref WebDriver turns on
   * (remote/shared/RecommendedPreferences.sys.mjs) and Sval leaves off.
   *
   * @param {{ref: string, files: File[]}} options
   * @returns {Promise<object>}
   */
  upload({ ref, files }) {
    return this.#ask("upload", { ref, files });
  }

  /**
   * What the page wrote to the console after the message `after`
   * (`SvalAgentConsole`).
   *
   * @param {{after: number, limit: number}} options
   * @returns {Promise<{messages: object[], last: number, more: boolean, dropped: number}>}
   */
  consoleMessages({ after, limit }) {
    return this.#ask("console", { after, limit });
  }

  /**
   * What the page shows of a human-verification check (`SvalAgentChallenge`).
   *
   * @returns {Promise<{frames: Array<object>, markers: object}>}
   */
  challenge() {
    return this.#ask("challenge");
  }

  /**
   * Draws what the page shows in its viewport, in its own process.
   *
   * @param {number} scale Pixels drawn per CSS pixel.
   * @returns {Promise<{data: string, frames: number[]}>} A base64 PNG, and
   *   the inner window ids of the frames in the page's process it drew.
   */
  draw(scale) {
    return this.#ask("draw", { scale });
  }
}

/**
 * The most base64 a screenshot may be: what fits in one reply frame
 * (`MAX_FRAME_BYTES`), less room for the reply around it.
 */
export const MAX_SCREENSHOT_BYTES = MAX_FRAME_BYTES - 4096;

/**
 * The scales a screenshot is tried at, in CSS pixels per pixel drawn, in
 * order: full size, then smaller until one fits.
 */
const SCREENSHOT_SCALES = [1, 0.5, 0.25, 0.125];

/**
 * A PNG of what `browser`'s page shows in its viewport, as base64.
 *
 * The page's own process draws it (`SvalAgentPageChild` `#draw`), so a frame
 * in another process is blank in it. A frame in the page's process is drawn,
 * and `checkFrames` is given the documents of those frames, as they were
 * when drawn, to refuse any it may not show. A document gone since it was
 * drawn is null. It is drawn one pixel to a CSS pixel whatever the screen's
 * density, and smaller when that would not fit in `maxBytes`, so one reply
 * always carries it.
 *
 * Drawing in the parent (`WindowGlobalParent.drawSnapshot`) draws every
 * frame in every process (`CrossProcessPaint`), and it has no option to
 * leave any out, so a page could put a frame in front of it for one draw.
 *
 * @param {object} browser A `<browser>` from `tabIn`.
 * @param {object} [options]
 * @param {number} [options.maxBytes] The most base64 it may be.
 * @param {(frames: Array<WindowGlobalParent|null>) => void} [options.checkFrames]
 *   Throws to refuse a drawing holding these frames.
 * @returns {Promise<string>}
 */
export async function screenshot(
  browser,
  { maxBytes = MAX_SCREENSHOT_BYTES, checkFrames = () => {} } = {}
) {
  const actor = pageActor(browser);
  for (const scale of SCREENSHOT_SCALES) {
    let drawn;
    try {
      drawn = await actor.draw(scale);
    } catch (err) {
      if (err instanceof ToolError) {
        throw err;
      }
      SvalLog.warn(`agent screenshot failed: ${describeError(err)}`);
      drawn = null;
    }
    if (
      typeof drawn?.data !== "string" ||
      !Array.isArray(drawn.frames) ||
      !drawn.frames.every(Number.isSafeInteger)
    ) {
      throw new ToolError(
        "screenshot_failed",
        "Sval could not take a screenshot of the page."
      );
    }
    checkFrames(
      drawn.frames.map(id => WindowGlobalParent.getByInnerWindowId(id))
    );
    if (drawn.data.length <= maxBytes) {
      return drawn.data;
    }
  }
  throw new ToolError(
    "screenshot_too_large",
    "The page's screenshot is too large to send, even drawn small. Use get_snapshot instead."
  );
}
