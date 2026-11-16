/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Send Feedback form (feedback spec §2, §4, §5): a popover out of the
 * feedback button at the end of the workspace panel's footer, one per
 * window. It is not modal. Esc, a click outside it or the button again close
 * it and keep the draft (the message, the email, the ticks and the context)
 * in this process until Sval quits; Cancel drops the draft.
 *
 * The popover is drawn in the window's own document, over the page, so the
 * tab that covers the button, the concave corner above the tab and the box
 * are one painted shape, and one filter (`sval-header.css`, the popovers'
 * edge and shadow) gives them one outline and one shadow.
 *
 * The report is `SvalFeedback`'s: built once as the form opens, viewed and
 * posted as built (spec §4).
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
  MIN_DESCRIPTION: "moz-src:///browser/components/sval/SvalFeedback.sys.mjs",
  SvalFeedback: "moz-src:///browser/components/sval/SvalFeedback.sys.mjs",
  crashTime: "moz-src:///browser/components/sval/SvalFeedback.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  slides: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
});

/** The footer's feedback button (`sval-panel.js`). */
export const FEEDBACK_BUTTON_CLASS = "sval-feedback-button";

/** What a report button says (spec §2), and says once the form has sent. */
export const SEND_REPORT_LABEL = "Send Report…";
export const REPORT_SENT_LABEL = "Report Sent";

const POPOVER_CLASS = "sval-feedback";
const HELP_MENU_ITEM_ID = "sval-help-send-feedback";
const HELP_COMMAND_ID = "Sval:SendFeedback";

/** How far the tab reaches past the button on its outer side (to-code). */
const TAB_REACH = 4;
const TAB_HEIGHT = 36;
/** Between the panel's edge and the popover's. */
const POPOVER_GAP = 8;
/** The least room the popover keeps from the window's far edge. */
const EDGE_ROOM = 12;

const PRIVACY_NOTE =
  "Sval sends only what's listed here. Sval's server doesn't keep your IP " +
  "address or anything that identifies you. Add your email only if you want " +
  "a reply.";
const MESSAGE_PLACEHOLDER =
  "A problem, an idea, anything. If something went wrong, what were you doing?";
const CRASH_EXPLANATION =
  "A crash snapshot is binary, so this shows what's in it. If it's sent, " +
  "it's sent exactly as it is on disk.";

/**
 * What the form says for each way a send can fail (spec §5). `{status}` is
 * the server's answer.
 */
const FAILURES = {
  unreachable: {
    title: "Couldn't reach Sval's feedback server",
    body:
      "Sval couldn't connect to feedback.sval.app. Check your internet " +
      "connection and any proxy or firewall settings, then send again.",
  },
  offline: {
    title: "You're offline",
    body: "Connect to the internet, then send again. Your message and choices are kept.",
  },
  server: {
    title: "Sval's feedback server had a problem",
    body:
      "feedback.sval.app answered with error {status}. This is on Sval's " +
      "side. Try again in a few minutes.",
    // No answer within a minute of connecting has no status to give.
    bodyWithoutStatus:
      "feedback.sval.app didn't answer. This is on Sval's side. Try again " +
      "in a few minutes.",
  },
  rejected: {
    title: "Sval's feedback server didn't accept the report",
    body: "It answered with error {status}.",
    bodyWithoutStatus: "It didn't accept the report.",
  },
};

const COLLECT_FAILURE = {
  title: "Couldn't gather the report",
  body: "Sval couldn't put together what's sent with your feedback.",
};

/**
 * The draft, kept across closes and windows until Sval quits (spec §2), or
 * null once Cancel or a send has ended it. `ticks` holds the boxes the user
 * changed, by part id; every other part keeps its default.
 *
 * @type {{ message: string, email: string, context: string|null,
 *   ticks: Map<string, boolean> }|null}
 */
let draft = null;

/** Per window, its form once built. */
const forms = new WeakMap();

function bytes(size) {
  return lazy.DownloadUtils.convertByteUnits(size).join(" ");
}

function button(doc, className, label, onClick) {
  const node = htmlElement(doc, "button", { className }, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/**
 * The window's feedback button, while its panel draws one.
 *
 * @param {Window} win
 * @returns {Element|null}
 */
function buttonIn(win) {
  return (
    win.document?.querySelector(
      `#sval-panel-container:not([hidden]) .${FEEDBACK_BUTTON_CLASS}`
    ) ?? null
  );
}

/**
 * The window the form opens in: `win`, or, for a window with no panel (a
 * Peek), the most recent one with a panel.
 *
 * @param {Window} win
 * @returns {Window|null}
 */
function windowFor(win) {
  if (buttonIn(win)) {
    return win;
  }
  return lazy.BrowserWindowTracker.orderedWindows.find(buttonIn) ?? null;
}

/**
 * Brings a slid-away panel back, so the popover can grow from its button.
 *
 * @param {Window} win
 * @returns {Promise<void>} settled once the panel is in place.
 */
function showPanel(win) {
  const container = win.document.getElementById("sval-panel-container");
  if (!container?.hasAttribute("sval-collapsed")) {
    return Promise.resolve();
  }
  const shown = lazy.slides(container)
    ? new Promise(resolve => {
        const done = event => {
          if (
            event.target === container &&
            event.propertyName === "transform"
          ) {
            container.removeEventListener("transitionend", done);
            resolve();
          }
        };
        container.addEventListener("transitionend", done);
      })
    : Promise.resolve();
  win.SvalPanel.toggleVisible();
  return shown;
}

/** One window's popover. */
class FeedbackForm {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    /** `"form"`, `"view"`, `"sending"`, `"sent"` or `"failed"`. */
    this.state = "form";
    this.report = null;
    /** The `collect` whose answer the form is waiting for. */
    this.collecting = null;
    /** Whether the last `collect` threw, which leaves no report to send. */
    this.collectFailed = false;
    this.failure = null;
    this.reference = "";
    this.sending = null;
    /** Resolves the open that showed the form, with whether it sent. */
    this.settle = null;
    this.listening = null;
    /** Whether View shows a part in place of the list. */
    this.viewing = false;
    this.build();
  }

  get open() {
    return !this.root.hidden;
  }

  build() {
    const { doc } = this;
    const root = htmlElement(doc, "div", { className: POPOVER_CLASS });
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-labelledby", "sval-feedback-title");

    const tab = htmlElement(doc, "div", { className: "sval-feedback-tab" });
    tab.setAttribute("aria-hidden", "true");
    const corner = htmlElement(doc, "div", {
      className: "sval-feedback-corner",
    });
    corner.setAttribute("aria-hidden", "true");

    const box = htmlElement(doc, "div", { className: "sval-feedback-box" });
    const title = htmlElement(
      doc,
      "h2",
      { className: "sval-feedback-title" },
      "Send Feedback"
    );
    title.id = "sval-feedback-title";
    const context = htmlElement(doc, "p", {
      className: "sval-feedback-context",
    });
    const head = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-head" },
      title,
      context
    );

    const message = htmlElement(doc, "textarea", {
      className: "sval-feedback-message",
    });
    message.placeholder = MESSAGE_PLACEHOLDER;
    message.setAttribute("aria-label", "Message");
    message.addEventListener("input", () => {
      this.keep();
      this.drawSend();
    });
    const email = htmlElement(doc, "input", {
      className: "sval-feedback-email",
    });
    email.type = "email";
    email.placeholder = "Email (optional)";
    email.setAttribute("aria-label", "Email (optional)");
    email.addEventListener("input", () => this.keep());
    const note = htmlElement(
      doc,
      "p",
      { className: "sval-feedback-note" },
      PRIVACY_NOTE
    );
    const left = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-left" },
      message,
      email,
      note
    );

    const listTitle = htmlElement(
      doc,
      "span",
      { className: "sval-feedback-list-title" },
      "Sent with your feedback"
    );
    const listMeta = htmlElement(doc, "span", {
      className: "sval-feedback-list-meta",
    });
    const list = htmlElement(doc, "div", { className: "sval-feedback-list" });
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Sent with your feedback");
    const listing = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-listing" },
      htmlElement(
        doc,
        "div",
        { className: "sval-feedback-list-head" },
        listTitle,
        listMeta
      ),
      list
    );
    const viewer = htmlElement(doc, "div", {
      className: "sval-feedback-viewer",
    });
    viewer.hidden = true;
    const right = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-right" },
      listing,
      viewer
    );
    const grid = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-grid" },
      left,
      right
    );

    const failure = htmlElement(doc, "div", {
      className: "sval-feedback-failure",
    });
    failure.setAttribute("role", "alert");
    failure.hidden = true;

    const thanks = htmlElement(
      doc,
      "p",
      { className: "sval-feedback-thanks" },
      "Thanks, your feedback was sent."
    );
    const reference = htmlElement(doc, "p", {
      className: "sval-feedback-reference",
    });
    const sent = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-sent" },
      thanks,
      reference
    );
    sent.hidden = true;

    const cancel = button(doc, "sval-feedback-action", "Cancel", () =>
      this.cancel()
    );
    const send = button(
      doc,
      "sval-feedback-action sval-feedback-primary sval-feedback-send",
      "",
      () => this.send()
    );
    const close = button(
      doc,
      "sval-feedback-action sval-feedback-primary",
      "Close",
      () => this.close()
    );
    const actions = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-actions" },
      cancel,
      send,
      close
    );

    box.append(head, grid, sent, failure, actions);
    root.append(tab, corner, box);
    root.addEventListener("keydown", event => this.onKey(event));
    doc.body.append(root);

    this.root = root;
    this.els = {
      box,
      context,
      message,
      email,
      left,
      grid,
      listing,
      listMeta,
      list,
      viewer,
      failure,
      sent,
      reference,
      cancel,
      send,
      close,
    };
  }

  /**
   * Shows the form, from the draft when there is one.
   *
   * @param {string|null} context
   * @returns {Promise<boolean>} whether this opening sent a report, settled
   *   when the form closes or sends.
   */
  show(context) {
    this.settle?.(false);
    const settled = new Promise(resolve => {
      this.settle = resolve;
    });
    const wasOpen = this.open;
    if (!wasOpen) {
      draft ??= { message: "", email: "", context: null, ticks: new Map() };
      if (context) {
        draft.context = context;
      }
      this.els.message.value = draft.message;
      this.els.email.value = draft.email;
      this.root.hidden = false;
      this.listen();
    } else if (context && draft) {
      draft.context = context;
    }
    this.place();
    // Built as the form opens (spec §4), and again when a Send Report…
    // brings another context to an open form. A send under way or done
    // keeps the report it posted.
    const busy = this.state === "sending" || this.state === "sent";
    if (
      !busy &&
      (!wasOpen || this.report?.context !== (draft?.context ?? null))
    ) {
      this.collect();
    }
    this.draw();
    if (this.state === "form" || this.state === "failed") {
      this.els.message.focus();
    }
    return settled;
  }

  /** Back to an empty form, once a report has been sent. */
  reset() {
    this.state = "form";
    this.report = null;
    this.failure = null;
    this.reference = "";
  }

  /** Builds the report for the draft's context (spec §4). */
  collect() {
    const context = draft?.context ?? null;
    this.report = null;
    this.collectFailed = false;
    const collecting = lazy.SvalFeedback.collect(context ? { context } : {});
    this.collecting = collecting;
    collecting.then(
      report => {
        if (this.collecting === collecting) {
          this.collecting = null;
          this.report = report;
          this.draw();
        }
      },
      err => {
        lazy.SvalLog.error(
          `feedback: the report could not be built: ${lazy.SvalLog.errorName(err)}`
        );
        if (this.collecting === collecting) {
          this.collecting = null;
          this.collectFailed = true;
          this.draw();
        }
      }
    );
  }

  /** Writes the form's fields back to the draft. */
  keep() {
    if (draft) {
      draft.message = this.els.message.value;
      draft.email = this.els.email.value;
    }
  }

  ticked(part) {
    if (part.locked) {
      return true;
    }
    if (part.sent || part.tooLarge) {
      return false;
    }
    return draft?.ticks.get(part.id) ?? part.checked;
  }

  /** @returns {Set<string>} the ids of the parts that will be sent. */
  checked() {
    return new Set(
      (this.report?.parts ?? [])
        .filter(part => this.ticked(part))
        .map(part => part.id)
    );
  }

  draw() {
    const { els, state } = this;
    const sending = state === "sending";
    const sent = state === "sent";
    this.root.dataset.state = state;
    els.context.textContent = draft?.context ?? "";
    els.context.hidden = sent || !draft?.context;
    els.grid.hidden = sent;
    els.sent.hidden = !sent;
    els.left.inert = sending;
    els.listing.inert = sending;
    els.viewer.inert = sending;
    els.cancel.hidden = sent;
    els.send.hidden = sent;
    els.close.hidden = !sent;
    const sendLabels = { sending: "Sending…", failed: "Send Again" };
    els.send.textContent = sendLabels[state] ?? "Send";
    els.send.toggleAttribute("busy", sending);
    els.reference.textContent = sent ? `Reference: ${this.reference}` : "";
    this.drawFailure();
    this.drawList();
    this.drawSend();
  }

  drawSend() {
    const { message, send } = this.els;
    send.disabled =
      this.state === "sending" ||
      !this.report ||
      message.value.trim().length < lazy.MIN_DESCRIPTION;
  }

  drawFailure() {
    const { failure } = this.els;
    const shown = this.collectFailed
      ? COLLECT_FAILURE
      : this.state === "failed" && FAILURES[this.failure?.cause];
    failure.hidden = !shown;
    if (!shown) {
      delete failure.dataset.cause;
      failure.replaceChildren();
      return;
    }
    failure.dataset.cause = this.collectFailed ? "collect" : this.failure.cause;
    const status = this.collectFailed ? null : this.failure.status;
    const body =
      status || !shown.bodyWithoutStatus
        ? shown.body.replace("{status}", status)
        : shown.bodyWithoutStatus;
    const { doc } = this;
    failure.replaceChildren(
      htmlElement(doc, "span", { className: "sval-feedback-failure-icon" }),
      htmlElement(
        doc,
        "div",
        { className: "sval-feedback-failure-text" },
        htmlElement(
          doc,
          "p",
          { className: "sval-feedback-failure-title" },
          shown.title
        ),
        htmlElement(doc, "p", { className: "sval-feedback-failure-body" }, body)
      )
    );
    if (this.collectFailed) {
      failure.append(
        button(
          doc,
          "sval-feedback-action sval-feedback-retry",
          "Try Again",
          () => {
            this.collect();
            this.draw();
          }
        )
      );
    }
  }

  drawList() {
    const { list, listMeta } = this.els;
    const { doc, report } = this;
    if (!report) {
      list.replaceChildren();
      listMeta.textContent = "";
      return;
    }
    const checked = this.checked();
    const count = checked.size;
    listMeta.textContent = `${count} ${count === 1 ? "item" : "items"} · ${bytes(
      lazy.SvalFeedback.totalSize(report, checked)
    )}`;
    const focused = doc.activeElement?.closest?.(".sval-feedback-row");
    const focusedId = focused?.dataset.part;
    const focusedView =
      doc.activeElement?.classList.contains("sval-feedback-view");
    list.replaceChildren(
      ...report.parts.map(part => this.drawRow(part, checked.has(part.id)))
    );
    if (focusedId) {
      const row = list.querySelector(`[data-part="${CSS.escape(focusedId)}"]`);
      row
        ?.querySelector(
          focusedView ? ".sval-feedback-view" : ".sval-feedback-tick"
        )
        ?.focus();
    }
  }

  drawRow(part, ticked) {
    const { doc } = this;
    const row = htmlElement(doc, "div", { className: "sval-feedback-row" });
    row.setAttribute("role", "listitem");
    row.dataset.part = part.id;
    row.toggleAttribute("too-large", !!part.tooLarge);
    const titleId = `sval-feedback-part-${CSS.escape(part.id)}`;

    let tick;
    if (part.locked || part.sent) {
      tick = htmlElement(doc, "span", {
        className: "sval-feedback-tick-space",
      });
    } else {
      tick = htmlElement(doc, "input", { className: "sval-feedback-tick" });
      tick.type = "checkbox";
      tick.checked = ticked;
      tick.disabled = !!part.tooLarge;
      tick.setAttribute("aria-labelledby", titleId);
      tick.addEventListener("change", () => {
        draft?.ticks.set(part.id, tick.checked);
        this.drawList();
      });
    }

    const title = htmlElement(
      doc,
      "span",
      { className: "sval-feedback-part-title" },
      part.title
    );
    title.id = titleId;
    const titleRow = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-part-head" },
      title
    );
    if (part.locked) {
      titleRow.append(
        htmlElement(
          doc,
          "span",
          { className: "sval-feedback-tag" },
          "Always sent"
        )
      );
    } else if (part.sent) {
      titleRow.append(
        htmlElement(
          doc,
          "span",
          { className: "sval-feedback-tag sval-feedback-tag-sent" },
          "Sent"
        )
      );
    }
    const text = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-part-text" },
      titleRow,
      htmlElement(
        doc,
        "p",
        { className: "sval-feedback-part-description" },
        part.description
      )
    );
    if (part.tooLarge) {
      text.append(
        htmlElement(
          doc,
          "p",
          { className: "sval-feedback-part-note" },
          "Too large to send"
        )
      );
    } else if (ticked && part.warning) {
      text.append(
        htmlElement(
          doc,
          "p",
          { className: "sval-feedback-part-warning" },
          part.warning
        )
      );
    }
    const view = button(doc, "sval-feedback-view", "View", () =>
      this.view(part)
    );
    view.setAttribute("aria-describedby", titleId);
    row.append(
      tick,
      text,
      htmlElement(
        doc,
        "span",
        { className: "sval-feedback-part-size" },
        bytes(part.size)
      ),
      view
    );
    return row;
  }

  /**
   * View: the part as it will be sent, in place of the list (spec §4).
   *
   * @param {object} part
   */
  async view(part) {
    let shown;
    try {
      shown = await part.view();
    } catch (err) {
      lazy.SvalLog.error(
        `feedback: a part could not be viewed: ${lazy.SvalLog.errorName(err)}`
      );
      return;
    }
    if (!this.open || this.report?.parts.includes(part) !== true) {
      return;
    }
    const { doc } = this;
    const { viewer, listing } = this.els;
    const back = button(doc, "sval-feedback-back", "Back", () => this.back());
    const meta = part.tooLarge
      ? `${bytes(part.size)} · too large to send`
      : `${bytes(part.size)} · exactly as sent`;
    const head = htmlElement(
      doc,
      "div",
      { className: "sval-feedback-viewer-head" },
      back,
      htmlElement(
        doc,
        "div",
        { className: "sval-feedback-viewer-titles" },
        htmlElement(
          doc,
          "p",
          { className: "sval-feedback-viewer-title" },
          part.title
        ),
        htmlElement(doc, "p", { className: "sval-feedback-viewer-meta" }, meta)
      )
    );
    let body;
    if (shown.kind === "crash") {
      body = this.crashView(shown);
    } else {
      body = htmlElement(
        doc,
        "pre",
        { className: "sval-feedback-text" },
        shown.text
      );
      body.tabIndex = 0;
      body.setAttribute("aria-label", part.title);
    }
    viewer.replaceChildren(head, body);
    viewer.dataset.part = part.id;
    viewer.hidden = false;
    listing.hidden = true;
    this.viewing = true;
    back.focus();
  }

  crashView(crash) {
    const { doc } = this;
    const details = htmlElement(doc, "dl", {
      className: "sval-feedback-crash-details",
    });
    const time = lazy.crashTime(new Date(crash.time));
    for (const [key, value] of [
      ["Size", bytes(crash.size)],
      ["Time", time],
      ["Process", crash.processType],
      ["Crash id", crash.crashID],
    ]) {
      details.append(
        htmlElement(doc, "dt", {}, key),
        htmlElement(doc, "dd", {}, value)
      );
    }
    const libraries = htmlElement(doc, "ul", {
      className: "sval-feedback-libraries",
    });
    libraries.tabIndex = 0;
    libraries.setAttribute("aria-label", "Libraries it had loaded");
    libraries.append(
      ...crash.libraries.map(name => htmlElement(doc, "li", {}, name))
    );
    return htmlElement(
      doc,
      "div",
      { className: "sval-feedback-crash" },
      htmlElement(
        doc,
        "p",
        { className: "sval-feedback-crash-explanation" },
        CRASH_EXPLANATION
      ),
      details,
      htmlElement(
        doc,
        "p",
        { className: "sval-feedback-list-title" },
        `Libraries it had loaded · ${crash.libraries.length}`
      ),
      libraries,
      htmlElement(
        doc,
        "p",
        { className: "sval-feedback-list-title" },
        "Its annotations, sent with it as extra.json"
      ),
      htmlElement(
        doc,
        "pre",
        { className: "sval-feedback-text" },
        crash.annotations
      )
    );
  }

  /** Back from View to the list, with focus on the row's View. */
  back() {
    const { viewer, listing, list } = this.els;
    const id = viewer.dataset.part;
    viewer.hidden = true;
    viewer.replaceChildren();
    listing.hidden = false;
    this.viewing = false;
    list
      .querySelector(
        `[data-part="${CSS.escape(id ?? "")}"] .sval-feedback-view`
      )
      ?.focus();
  }

  async send() {
    if (this.els.send.disabled) {
      return;
    }
    this.keep();
    const controller = new AbortController();
    this.sending = controller;
    this.state = "sending";
    this.failure = null;
    this.draw();
    let answer;
    try {
      answer = await lazy.SvalFeedback.send(
        this.report,
        {
          description: this.els.message.value,
          email: this.els.email.value.trim(),
          checked: this.checked(),
        },
        { signal: controller.signal }
      );
    } catch (err) {
      lazy.SvalLog.error(
        `feedback: the send failed: ${lazy.SvalLog.errorName(err)}`
      );
      answer = { ok: false, cause: "unreachable" };
    }
    if (this.sending !== controller) {
      return;
    }
    this.sending = null;
    if (answer.ok) {
      draft = null;
      this.state = "sent";
      this.reference = answer.reference;
      if (this.viewing) {
        this.back();
      }
    } else {
      this.state = "failed";
      this.failure = answer;
    }
    this.draw();
    if (this.open) {
      (answer.ok ? this.els.close : this.els.send).focus();
    }
    this.settle?.(answer.ok);
    this.settle = null;
  }

  /** Cancel: stops a send under way, closes and drops the draft. */
  cancel() {
    this.sending?.abort();
    this.sending = null;
    draft = null;
    this.reset();
    this.close();
  }

  /** Closes the form; the draft stays (spec §2). */
  close() {
    if (!this.open) {
      return;
    }
    this.keep();
    const hadFocus = this.root.contains(this.doc.activeElement);
    this.unlisten();
    if (this.viewing) {
      this.back();
    }
    // Sent, once seen, gives way to an empty form. A send that ends while
    // the form is closed is shown when it opens.
    if (this.state === "sent") {
      this.reset();
    }
    this.root.hidden = true;
    if (hadFocus) {
      buttonIn(this.win)?.focus();
    }
    // A send under way goes on, and its answer is what the form shows when
    // it opens again, and what the opening that started it hears.
    if (!this.sending) {
      this.settle?.(false);
      this.settle = null;
    }
  }

  onKey(event) {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (this.viewing) {
      this.back();
    } else {
      this.close();
    }
  }

  /**
   * While open: a press outside the popover closes it, and the window's size
   * or the panel's width moving places it again. A press on a page arrives
   * here as one on its `<browser>` (`PresShell::HandleEvent` dispatches in
   * the parent before forwarding to the content process).
   */
  listen() {
    const { win } = this;
    const controller = new AbortController();
    this.listening = controller;
    const { signal } = controller;
    win.addEventListener(
      "mousedown",
      event => {
        const { target } = event;
        if (this.root.contains(target) || buttonIn(win)?.contains(target)) {
          return;
        }
        this.close();
      },
      { capture: true, signal }
    );
    win.addEventListener("resize", () => this.place(), { signal });
    const container = this.doc.getElementById("sval-panel-container");
    if (container) {
      const observer = new win.ResizeObserver(() => this.place());
      observer.observe(container);
      signal.addEventListener("abort", () => observer.disconnect());
    }
  }

  unlisten() {
    this.listening?.abort();
    this.listening = null;
  }

  /**
   * Places the popover beside the panel, its tab over the button (to-code,
   * Button): the box starts 8px past the panel's edge, the tab reaches 4px
   * past the button's outer side, and the box's foot is the tab's.
   */
  place() {
    const anchor = buttonIn(this.win);
    const container = this.doc.getElementById("sval-panel-container");
    if (!anchor || !container) {
      return;
    }
    const b = anchor.getBoundingClientRect();
    const panel = container.getBoundingClientRect();
    const width = this.win.innerWidth;
    const right = panel.left + panel.width / 2 > width / 2;
    const tabBottom = b.top + b.height / 2 + TAB_HEIGHT / 2;
    const style = this.root.style;
    style.setProperty(
      "--sval-feedback-bottom",
      `${this.win.innerHeight - tabBottom}px`
    );
    if (right) {
      const tabStart = width - (b.right + TAB_REACH);
      const boxEdge = width - (panel.left - POPOVER_GAP);
      style.setProperty("--sval-feedback-start", `${tabStart}px`);
      style.setProperty("--sval-feedback-reach", `${boxEdge - tabStart}px`);
      style.setProperty(
        "--sval-feedback-room",
        `${width - boxEdge - EDGE_ROOM}px`
      );
    } else {
      const tabStart = b.left - TAB_REACH;
      const boxEdge = panel.right + POPOVER_GAP;
      style.setProperty("--sval-feedback-start", `${tabStart}px`);
      style.setProperty("--sval-feedback-reach", `${boxEdge - tabStart}px`);
      style.setProperty(
        "--sval-feedback-room",
        `${width - boxEdge - EDGE_ROOM}px`
      );
    }
    this.root.dataset.side = right ? "right" : "left";
  }
}

export const SvalFeedbackForm = {
  /**
   * Opens the popover from the window's footer button, with an optional
   * context line (spec §2). A window with no panel opens it in the most
   * recent window that has one, and a slid-away panel slides back first.
   *
   * @param {Window} win A browser window.
   * @param {object} [options]
   * @param {string} [options.context] The context line a Send Report button
   *   gives.
   * @returns {Promise<boolean>} whether this opening sent a report, settled
   *   when it sends or the form closes.
   */
  async open(win, { context } = {}) {
    const target = windowFor(win);
    if (!target) {
      return false;
    }
    if (target !== win) {
      target.focus();
    }
    await showPanel(target);
    let form = forms.get(target);
    if (!form) {
      form = new FeedbackForm(target);
      forms.set(target, form);
    }
    return form.show(context ?? null);
  },

  /**
   * The footer button: opens the form, or closes it, keeping the draft.
   *
   * @param {Window} win
   */
  toggle(win) {
    const form = forms.get(win);
    if (form?.open) {
      form.close();
      return;
    }
    this.open(win);
  },

  /**
   * A Send Report… button (spec §2): opens the form with `context`, and once
   * the form has sent, says so and is done.
   *
   * @param {Element} reportButton
   * @param {Window} win The browser window the page is in.
   * @param {string} context
   */
  async report(reportButton, win, context) {
    if (await this.open(win, { context })) {
      reportButton.textContent = REPORT_SENT_LABEL;
      reportButton.disabled = true;
    }
  },

  /**
   * Help › Send Feedback… in the menu bar, which the app menu's Help copies
   * (`PanelUI._onHelpViewShow`, `command` and `label` included), so one
   * command serves both.
   *
   * @param {Window} win A browser window, before its first layout.
   */
  mountWindow(win) {
    const doc = win.document;
    const commands = doc.getElementById("mainCommandSet");
    const after = doc.getElementById("feedbackPage");
    if (!commands || !after) {
      return;
    }
    const command = doc.createXULElement("command");
    command.id = HELP_COMMAND_ID;
    command.addEventListener("command", () => this.open(win));
    commands.append(command);
    const item = doc.createXULElement("menuitem");
    item.id = HELP_MENU_ITEM_ID;
    item.setAttribute("label", "Send Feedback…");
    item.setAttribute("command", HELP_COMMAND_ID);
    after.after(item);
  },
};
