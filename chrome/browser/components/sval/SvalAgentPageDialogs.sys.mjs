/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Page dialogs in an agent's tab (agent-control spec §4.1). A page's
 * `alert`, `confirm`, `prompt` or `beforeunload` dialog holds the page until
 * someone answers it. In a tab the gate watches for an agent:
 *
 * - `alert` is accepted at once, which is all it can be;
 * - `beforeunload` is accepted at once, so the agent's navigation goes on.
 *   Only an agent's own tab is answered for, so this never lets a page the
 *   user is editing in their own tab go. PDF.js asks with Save, Cancel and
 *   Don't save, Save as the accepting button
 *   (`PromptCollection.asyncBeforeUnloadCheck`); there the page is left
 *   through Don't save, so leaving never writes a file;
 * - `confirm` and `prompt` stay open for the agent, which answers them with
 *   `answer`. The answer is the page's question to the agent, so a default
 *   would turn "Delete this item?" into a silent no. The checkbox some carry
 *   ("Don't allow this site to prompt you again") is never ticked. One
 *   nobody answers stays up, and the user can answer it in the agent's
 *   window.
 *
 * What a dialog Sval answered said is kept for the tab until it closes, with
 * the sites of the tab's page and of the frame that raised it (`sitesOf`),
 * and the next tool result for it carries it (`takeReport`). An open
 * `confirm` or `prompt` is reported while it is open (`openDialog`). The
 * message is the page's own text, so it reaches the agent as page content
 * does, cut to `MAX_MESSAGE` characters, and only when the agent may read
 * both sites (`SvalAgentToolCall`, `dialogFor`): a frame from a site the agent may not read
 * must not speak through a page it may.
 * A user's own tab, and a tab the user took from an agent, keep their
 * dialogs: whether a tab is an agent's is the gate's answer (`agentOf`).
 *
 * Every content dialog opens `commonDialog.xhtml`, which notifies
 * `common-dialog-loaded` with its window once it is ready
 * (`CommonDialog.onLoad`), and the window's `args.owningBrowsingContext`
 * is the context the page called from (`PromptParent`). The dialog is
 * answered through its own buttons by `modal.Dialog`, as WebDriver's
 * prompt handling answers it (remote/shared/Prompt.sys.mjs). While it is up,
 * the page's script is stopped inside the call, in a nested event loop with
 * the document's event handling suppressed
 * (`nsGlobalWindowOuter::EnterModalState`), so the page can be neither read
 * nor driven.
 *
 * WebDriver's `PromptListener` does not fit: it reads
 * `args.owningBrowsingContext.embedderElement` for every common dialog, so it
 * throws for a window-modal prompt of Sval's own chrome, which has no owning
 * context, and fails for a frame's dialog, whose context has no embedder
 * element in the parent.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { onTabGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { hostOfDocument } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  modal: "chrome://remote/content/shared/Prompt.sys.mjs",
});

const LOADED_TOPIC = "common-dialog-loaded";

/** The longest dialog message a tool result carries, in characters. */
export const MAX_MESSAGE = 500;

/**
 * How each dialog type a page can open is reported and answered: by Sval at
 * once, or by the agent. A page's `alert` is `alertCheck`, and its `confirm`
 * `confirmCheck`, once Firefox offers to silence the page's further dialogs
 * (`dom.successive_dialog_time_limit`).
 */
const HANDLING = {
  alert: { type: "alert", byAgent: false },
  alertCheck: { type: "alert", byAgent: false },
  confirm: { type: "confirm", byAgent: true },
  confirmCheck: { type: "confirm", byAgent: true },
  prompt: { type: "prompt", byAgent: true },
  beforeunload: { type: "beforeunload", byAgent: false },
};

/** What answering a dialog says when the tab has none open. */
export const noDialog = () => new ToolError("no_dialog");

/**
 * @param {string} text
 * @returns {string} `text` cut to `MAX_MESSAGE` characters, never through
 *   the middle of a surrogate pair.
 */
function capped(text) {
  const chars = Array.from(text);
  return chars.length <= MAX_MESSAGE
    ? text
    : chars.slice(0, MAX_MESSAGE).join("");
}

/**
 * @param {WindowContext|null|undefined} windowGlobal
 * @returns {string|null|undefined} The site of the document it holds, by its
 *   principal, named as the agent's rules are looked up by
 *   (`hostOfDocument`), or undefined, a site no agent may read,
 *   for one that has none or is refused.
 */
function siteIn(windowGlobal) {
  try {
    return hostOfDocument(windowGlobal);
  } catch {
    return undefined;
  }
}

/**
 * The sites behind a dialog: of the tab's page and of the frame that raised
 * it. The dialog opens after its document asked, and its context may show
 * another document by then, as when a navigation commits meanwhile. So the
 * frame is the window global its context shows only while that holds the
 * principal the dialog was raised with (`args.promptPrincipal`, which
 * `Prompter` takes from the asking document), and the page is that window
 * global's own top. Any other dialog is from no document Sval can name, and
 * both sites are undefined.
 *
 * @param {object} args The dialog's arguments.
 * @returns {Array<string|null|undefined>}
 */
function sitesOf(args) {
  const raiser = args.owningBrowsingContext?.currentWindowGlobal;
  const asked = args.promptPrincipal;
  if (!raiser || !asked || !raiser.documentPrincipal?.equals(asked)) {
    return [undefined, undefined];
  }
  return [siteIn(raiser.topWindowContext), siteIn(raiser)];
}

/**
 * Answers the page dialogs in the tabs `gate` watches for agents, and keeps
 * the `confirm` and `prompt` dialogs open there for the agent, from now until
 * `close`.
 *
 * @param {object} options
 * @param {{agentOf: Function}} options.gate
 * @returns {object}
 */
export function createAgentDialogs({ gate }) {
  /** The last dialog each tab saw since it was last reported, by `browserId`. */
  const reports = new Map();
  /**
   * The `confirm` or `prompt` open in each tab, by `browserId`. A tab shows
   * one content dialog at a time; a second waits behind the first in the
   * tab's dialog box and loads when it closes.
   *
   * @type {Map<number, {dialog: object, win: Window, report: object}>}
   */
  const open = new Map();
  /** Who waits for a `confirm` or `prompt` to open, by `browserId`. */
  const waiters = new Map();
  let closed = false;

  /**
   * @param {number} id A `browserId`.
   * @returns {object|null} The tab's open dialog, if it is still up.
   */
  function openEntry(id) {
    const entry = open.get(id);
    if (!entry) {
      return null;
    }
    if (entry.win.closed || !entry.dialog.ui) {
      open.delete(id);
      return null;
    }
    return entry;
  }

  /**
   * @param {Window} win A `commonDialog.xhtml` window.
   */
  function handle(win) {
    const args = win.Dialog?.args;
    if (args?.modalType !== Services.prompt.MODAL_TYPE_CONTENT) {
      return;
    }
    const browser = args.owningBrowsingContext?.top?.embedderElement;
    if (!browser || !gate.agentOf(browser)) {
      return;
    }
    const dialog = new lazy.modal.Dialog(win);
    const handling = HANDLING[dialog.promptType];
    if (!handling) {
      return;
    }
    const message = capped(String(dialog.ui?.infoBody?.textContent ?? ""));
    const sites = sitesOf(args);
    const report = { type: handling.type, message, sites };
    const id = browser.browserId;
    if (handling.byAgent) {
      open.set(id, { dialog, win, report });
      win.addEventListener(
        "unload",
        () => {
          if (open.get(id)?.win === win) {
            open.delete(id);
          }
        },
        { once: true }
      );
      for (const resolve of waiters.get(id) ?? []) {
        resolve(report);
      }
      waiters.delete(id);
      SvalLog.debug(`a page ${handling.type} waits for an agent`);
      return;
    }
    reports.set(id, report);
    const dontSave = dialog.ui?.button2;
    if (handling.type === "beforeunload" && dontSave && !dontSave.hidden) {
      dontSave.click();
    } else {
      dialog.accept();
    }
    SvalLog.debug(`answered a page ${handling.type} in an agent's tab`);
  }

  const observer = {
    observe(subject) {
      if (closed) {
        return;
      }
      try {
        handle(subject);
      } catch (err) {
        SvalLog.warn(`answering a page dialog failed: ${describeError(err)}`);
      }
    },
  };
  Services.obs.addObserver(observer, LOADED_TOPIC);

  const stopTabGone = onTabGone(id => {
    reports.delete(id);
    open.delete(id);
    waiters.delete(id);
  });

  return {
    /**
     * Hands over what the last dialog Sval answered in `browser`'s tab said
     * since the last call, once, with the sites of the tab's page and of the
     * frame that raised it.
     *
     * @param {object} browser
     * @returns {{type: string, message: string, sites: Array<string|null|undefined>}|null}
     */
    takeReport(browser) {
      const id = browser?.browserId;
      const report = reports.get(id) ?? null;
      reports.delete(id);
      return report;
    },

    /**
     * @param {object} browser
     * @returns {{type: string, message: string, sites: Array<string|null|undefined>}|null}
     *   The `confirm` or `prompt` open in `browser`'s tab, as `takeReport`
     *   gives a dialog, or null.
     */
    openDialog(browser) {
      return openEntry(browser?.browserId)?.report ?? null;
    },

    /**
     * Waits for a `confirm` or `prompt` to open in `browser`'s tab.
     *
     * @param {object} browser
     * @returns {{opened: Promise<object>, stop: Function}} `opened` resolves
     *   with the dialog's report, at once if one is open already, and never
     *   if none opens. `stop` lets the wait go.
     */
    waitForOpen(browser) {
      const id = browser?.browserId;
      const already = openEntry(id);
      if (already) {
        return { opened: Promise.resolve(already.report), stop() {} };
      }
      let resolve;
      const opened = new Promise(r => (resolve = r));
      let set = waiters.get(id);
      if (!set) {
        set = new Set();
        waiters.set(id, set);
      }
      set.add(resolve);
      return {
        opened,
        stop() {
          set.delete(resolve);
          if (!set.size && waiters.get(id) === set) {
            waiters.delete(id);
          }
        },
      };
    },

    /**
     * Answers the `confirm` or `prompt` open in `browser`'s tab, as the agent
     * said. The silencing checkbox is left unticked, whatever its state.
     *
     * @param {object} browser
     * @param {object} answer
     * @param {boolean} answer.accept
     * @param {string} [answer.text] What a prompt is answered with; the
     *   page's own default when absent. A confirm has no text.
     * @returns {string} The type of the dialog answered.
     */
    answer(browser, { accept, text }) {
      const id = browser?.browserId;
      const entry = openEntry(id);
      if (!entry) {
        throw noDialog();
      }
      const { dialog, report } = entry;
      open.delete(id);
      const checkbox = dialog.ui.checkbox;
      if (checkbox) {
        checkbox.checked = false;
      }
      if (accept) {
        if (report.type === "prompt" && typeof text === "string") {
          dialog.text = text;
        }
        dialog.accept();
      } else {
        dialog.dismiss();
      }
      SvalLog.debug(`an agent answered a page ${report.type}`);
      return report.type;
    },

    /**
     * Stops answering dialogs. A dialog open for the agent stays up, for the
     * user to answer.
     */
    close() {
      if (closed) {
        return;
      }
      closed = true;
      Services.obs.removeObserver(observer, LOADED_TOPIC);
      stopTabGone();
      reports.clear();
      open.clear();
      waiters.clear();
    },
  };
}
