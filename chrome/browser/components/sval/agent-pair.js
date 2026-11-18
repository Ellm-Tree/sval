/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The pairing alert opened by `SvalAgentAlerts.sys.mjs`. Answers through
 * `window.arguments[0].result`: `{action: "allow"|"deny", isolated}`, where
 * `isolated` is the kind of workspace the user allowed: the kind the agent
 * asked for, unless the user ticked the box that overrides it (isolated
 * workspaces spec §7). Pair is the default button and has focus once the
 * alert is in front. Until then Pair is disabled, the alert itself has
 * focus and no key reaches Pair, so a stray Enter never pairs an agent.
 *
 * Pairing grants an agent control of a workspace, and a shared one the user's
 * signed-in sessions, so Pair stays disabled until the alert has been shown
 * and focused for `security.dialog_enable_delay`, as in `agent-alert.js`.
 */

"use strict";

const { EnableDelayHelper } = ChromeUtils.importESModule(
  "resource://gre/modules/PromptUtils.sys.mjs"
);

const SvalAgentPair = {
  start() {
    const args = window.arguments?.[0] ?? {};
    const question = document.getElementById("sval-ap-question");
    question.textContent = `Pair “${args.label}” with Sval?`;
    // What Sval knows of the agent beside the name it gave, so the user can
    // tell which agent is asking.
    const facts = Array.isArray(args.facts) ? args.facts : [];
    const list = document.getElementById("sval-ap-facts");
    for (const line of facts) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    // Pairing again gives the app what its earlier pairing was allowed,
    // which the question alone would not say.
    if (args.again === true) {
      const item = document.createElement("li");
      item.dataset.again = "true";
      item.textContent = `“${args.label}” was paired before. Workspaces and permissions are kept from previous sessions.`;
      list.prepend(item);
    }
    list.hidden = !list.children.length;
    // The request line says what the agent asked for and never changes. The
    // box overrides it, and the pill shows whenever the answer isolates.
    const asked = args.isolated === true;
    const agent = args.label;
    const request = document.getElementById("sval-ap-request");
    request.dataset.asked = asked ? "isolated" : "shared";
    request.textContent = asked
      ? `${agent} asked for an isolated Workspace. It starts signed out of every site.`
      : `${agent} asked for a shared Workspace. It can use your sign-ins on every site.`;
    document.getElementById("sval-ap-override").textContent = asked
      ? "Let it use my sign-ins instead"
      : "Isolate it instead, so it starts signed out";
    const override = document.querySelector(".sval-ap-override input");
    const pill = document.querySelector(
      ".sval-ap-request .sval-dialog-iso-pill"
    );
    const isolated = () => asked !== override.checked;
    const showKind = () => (pill.hidden = !isolated());
    override.addEventListener("change", showKind);
    showKind();
    const finish = action => {
      args.result =
        action === "allow" ? { action, isolated: isolated() } : { action };
      window.close();
    };

    const deny = document.querySelector(".sval-ap-deny");
    deny.addEventListener("click", () => finish("deny"));
    // As in `agent-alert.js`: the line keeps its space when it goes, so
    // Pair never moves under a click aimed at it.
    const allow = document.querySelector(".sval-ap-allow");
    const delayLine = document.getElementById("sval-ap-delay");
    delayLine.textContent =
      "The Pair button turns on a moment after this window comes to the front.";
    // The description is what the user decides on: what pairing gives, who
    // is asking, what kind of workspace it asked for, and, while Pair waits
    // out the delay, why it cannot be pressed.
    const form = document.querySelector(".sval-ap");
    const describe = delaying => {
      form.ariaDescribedByElements = [
        document.getElementById("sval-ap-detail"),
        list,
        document.getElementById("sval-ap-request"),
        ...(delaying ? [delayLine] : []),
      ].filter(el => !el.hidden);
    };
    // Until Pair can take focus the alert itself holds it, so a screen
    // reader reads the alert.
    const placeFocus = () => (allow.disabled ? form : allow).focus();
    const setAllowDisabled = disabled => {
      allow.disabled = disabled;
      delayLine.style.visibility = disabled ? "visible" : "hidden";
      describe(disabled);
      // Pair takes focus as it enables, unless the user has moved to another
      // control meanwhile.
      const focused = document.activeElement;
      if (
        !disabled &&
        (!focused || focused === document.body || focused === form)
      ) {
        allow.focus();
      }
    };
    // Escape dismisses, which denies, at any time. The delay swallows keys
    // while it runs, so Escape is answered before it.
    window.addEventListener(
      "keydown",
      event => {
        if (event.key === "Escape") {
          window.close();
        }
      },
      true
    );
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!allow.disabled) {
        finish("allow");
      }
    });
    this._delay = new EnableDelayHelper({
      disableDialog: () => setAllowDisabled(true),
      enableDialog: () => setAllowDisabled(false),
      focusTarget: window,
    });
    // `SubDialog.focus` calls this when the dialog opens, in place of its own
    // move to the first focusable element.
    document.subDialogSetDefaultFocus = placeFocus;
    placeFocus();
  },
};

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => SvalAgentPair.start(), {
    once: true,
  });
} else {
  SvalAgentPair.start();
}
