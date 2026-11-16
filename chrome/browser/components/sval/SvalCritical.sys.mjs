/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The critical dialog (messages spec §4): this device's own copy, in the
 * profile, cannot be saved or cannot be opened. Sval works from that copy
 * whether or not a sync folder is chosen, so this is the one fault that loses
 * the user's work, and the one message that interrupts.
 *
 * One state per window. While it holds, the window's footer indicator shows
 * its title (`SvalPanelModel.syncIndicator`, read through {@link
 * SvalCritical.current}); a dismissed dialog comes back only from there, so a
 * failing pass every few seconds cannot keep reopening it.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  LOCAL_CAUSE_TEXT: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  REPORT_SENT_LABEL:
    "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
  SEND_REPORT_LABEL:
    "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
  SvalFeedbackForm:
    "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
});

/** Spec §4's two dialogs. */
const KINDS = {
  save: {
    title: "Sval can't save your changes",
    warning: "Sval won't keep the changes you make.",
    primary: "Try Again",
  },
  open: {
    title: "Sval can't open your Workspaces",
    warning: "",
    primary: "Restart",
  },
};

/**
 * Each window's state: `{ kind, cause, retry, report, open, page }`, where
 * `report` is `"sent"` once the feedback form it opened has sent one.
 */
const states = new WeakMap();

export const SvalCritical = {
  /**
   * Shows the dialog in `win`, or brings an open one up to date. A state the
   * user dismissed is updated and stays in the footer.
   *
   * @param {Window} win A browser window.
   * @param {object} options
   * @param {"save"|"open"} options.kind
   * @param {"disk-full"|"denied"|"disk"|null} [options.cause] From
   *   `SvalPanelModel.localCause`.
   * @param {Function} [options.retry] What Try Again runs: a pass.
   */
  show(win, { kind, cause = null, retry = null }) {
    let state = states.get(win);
    if (state) {
      Object.assign(state, { kind, cause, retry });
      state.page?.update(this._text(state));
      state.page?.setButton("ok", { label: KINDS[kind].primary });
      return;
    }
    state = { kind, cause, retry, report: "idle", open: false, page: null };
    states.set(win, state);
    this._open(win, state);
  },

  /**
   * Opens the dismissed dialog again; the footer's critical indicator does.
   *
   * @param {Window} win
   */
  reopen(win) {
    const state = states.get(win);
    if (state && !state.open) {
      this._open(win, state);
    }
  },

  /**
   * Ends the state in `win` and closes its dialog: what failed works again.
   *
   * @param {Window} win
   */
  clear(win) {
    const state = states.get(win);
    states.delete(win);
    state?.page?.close();
  },

  /**
   * @param {Window} win
   * @returns {{ kind: string, cause: ?string, title: string }|null} the
   *   state, open or dismissed, with the title the footer shows.
   */
  current(win) {
    const state = states.get(win);
    return state
      ? { kind: state.kind, cause: state.cause, title: KINDS[state.kind].title }
      : null;
  },

  _text({ kind, cause }) {
    return {
      title: KINDS[kind].title,
      body: (cause && lazy.LOCAL_CAUSE_TEXT[cause]) || "",
      warning: KINDS[kind].warning,
    };
  },

  _open(win, state) {
    state.open = true;
    lazy
      .openSvalDialog(win, {
        icon: "critical",
        tone: "critical",
        ...this._text(state),
        closeButton: true,
        primary: KINDS[state.kind].primary,
        secondary: null,
        extra:
          state.report === "sent"
            ? lazy.REPORT_SENT_LABEL
            : lazy.SEND_REPORT_LABEL,
        onOpen: page => {
          // A state cleared while its dialog waited in the window's queue.
          if (states.get(win) !== state) {
            page.close();
            return;
          }
          state.page = page;
          // A `show` while the dialog waited in the queue changed the state
          // after the dialog's arguments were made.
          page.update(this._text(state));
          page.setButton("ok", { label: KINDS[state.kind].primary });
          if (state.report === "sent") {
            page.setButton("extra", { disabled: true });
          }
        },
        onButton: (id, page) => {
          // Send Report… answers, which closes the dialog: the form takes
          // its place (feedback spec §2).
          if (id === "extra") {
            return false;
          }
          this._act(state, page);
          return true;
        },
      })
      .then(answer => {
        if (answer?.extra) {
          this._report(win, state);
        }
      })
      .finally(() => {
        state.open = false;
        state.page = null;
      });
  },

  /**
   * Try Again runs a pass, whose success clears the state; Restart quits.
   *
   * @param {object} state
   * @param {object} page The dialog's handle.
   */
  async _act(state, page) {
    if (state.kind === "open") {
      this._restart();
      return;
    }
    page.setButton("ok", { disabled: true });
    try {
      await state.retry?.();
    } finally {
      state.page?.setButton("ok", { disabled: false });
    }
  },

  /**
   * Restarts as Firefox's About dialog does
   * (`gAppUpdater.buttonRestartAfterDownload`): an observer of
   * `quit-application-requested` may veto it first.
   */
  _restart() {
    const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
      Ci.nsISupportsPRBool
    );
    Services.obs.notifyObservers(
      cancel,
      "quit-application-requested",
      "restart"
    );
    if (!cancel.data) {
      Services.startup.quit(
        Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
      );
    }
  },

  /**
   * Send Report…: the feedback form, with the dialog's title and cause as
   * its context (feedback spec §2). Closing it leaves the state in the
   * footer, as dismissing the dialog does.
   *
   * @param {Window} win
   * @param {object} state
   */
  async _report(win, state) {
    const { title } = KINDS[state.kind];
    const context = state.cause ? `${title} (${state.cause})` : title;
    if (await lazy.SvalFeedbackForm.open(win, { context })) {
      state.report = "sent";
    }
  },
};
