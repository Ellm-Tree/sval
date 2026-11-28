/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's prompt page (`prompt-dialog.xhtml`), which `Prompter` and
 * `PromptParent` open in a modal box in place of toolkit's common dialog.
 * `CommonDialog` does the work for both: it reads the property bag the
 * opener passes, fills the parts this page names by the common dialog's
 * ids, sets the answer on the bag and notifies `common-dialog-loaded`, as
 * the common dialog does. This page gives it `sval-button`s and plain fields
 * in place of the XUL dialog's, and presses them as the XUL dialog does:
 * Enter presses the default button, Escape answers as Cancel, and an
 * aborted box (`SubDialog.abort`) aborts the prompt.
 *
 * Every string is set as text, never parsed as markup: a prompt's title and
 * message are the page's own words.
 */

"use strict";

{
  const { CommonDialog } = ChromeUtils.importESModule(
    "resource://gre/modules/CommonDialog.sys.mjs"
  );
  // Defined before the parser makes the page's elements, so each is
  // upgraded as it is made: `CommonDialog` names each button through its
  // `label`, which an element not yet upgraded keeps as a plain property,
  // and the card fits the box only once this script has filled it.
  for (const tag of ["sval-dialog", "sval-button"]) {
    ChromeUtils.importESModule(
      `chrome://browser/content/sval/elements/${tag}.mjs`,
      { global: "current" }
    );
  }
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    ContentAnalysisUtils: "resource://gre/modules/ContentAnalysisUtils.sys.mjs",
  });

  /** The XUL dialog's button types, by `CommonDialog`'s button number. */
  const TYPES = ["accept", "cancel", "extra1", "extra2"];

  let propBag = null;
  let args = null;
  /**
   * Gives the prompt its default focus, once `CommonDialog` has filled the
   * page: its field, or the default answer. `CommonDialog` gives a question
   * with no field the message's focus on macOS; Sval's dialogs give it to
   * the default answer, and the message never takes the focus.
   *
   * @type {((isInitialFocus: boolean) => void)|null}
   */
  let focusDefault = null;
  /** `SubDialog.focus`'s first call, when it comes before {@link focusDefault}. */
  let earlyFocus = null;

  // `SubDialog.focus` calls this in place of its own first focusable
  // element, as for the common dialog. It is set before the card connects,
  // which keeps a page's own, and can come before `start` has run.
  document.subDialogSetDefaultFocus = isInitialFocus => {
    if (focusDefault) {
      focusDefault(isInitialFocus);
    } else {
      earlyFocus = { isInitialFocus };
    }
  };

  /**
   * Who asks, as the common dialog's header names them: the page's site, an
   * extension, or nobody for a question Sval itself asks
   * (prompt-no-own-origin.patch).
   *
   * @param {object} prompt The prompt's arguments.
   * @param {boolean} [prompt.useTitle]
   * @param {nsIPrincipal} [prompt.promptPrincipal]
   * @param {string} [prompt.authOrigin]
   * @returns {{raw?: string, l10nId?: string}|null}
   */
  const askerOf = ({ useTitle, promptPrincipal, authOrigin }) => {
    if (useTitle) {
      return null;
    }
    if (!promptPrincipal) {
      return authOrigin ? { raw: authOrigin } : null;
    }
    if (promptPrincipal.isNullPrincipal) {
      return { l10nId: "common-dialog-title-null" };
    }
    if (promptPrincipal.isSystemPrincipal) {
      return null;
    }
    if (promptPrincipal.addonPolicy) {
      return { raw: promptPrincipal.addonPolicy.name };
    }
    if (promptPrincipal.isContentPrincipal) {
      let host = "";
      try {
        host = promptPrincipal.URI.displayHostPort;
      } catch {
        // `displayHostPort` throws for an address with no host, such as an
        // about: page.
        host = promptPrincipal.originNoSuffix;
      }
      return { raw: host || promptPrincipal.prePath };
    }
    return { l10nId: "common-dialog-title-unknown" };
  };

  /**
   * A field label's text, which `commonDialog.ftl` keeps as `.value`.
   *
   * @param {string} id The message's Fluent id.
   * @returns {Promise<string>}
   */
  const labelText = async id => {
    const [message] = await document.l10n.formatMessages([{ id }]);
    return message?.attributes?.find(a => a.name === "value")?.value ?? "";
  };

  /**
   * The message's Copy and Select All menu, which the common dialog gives
   * its message (`contentAreaContextMenu` in `commonDialog.xhtml`), with
   * the same strings.
   *
   * @param {Element} infoBody
   */
  const messageMenu = infoBody => {
    const menu = document.createXULElement("menupopup");
    menu.id = "contentAreaContextMenu";
    const item = (id, l10nId, onCommand) => {
      const node = document.createXULElement("menuitem");
      node.id = id;
      document.l10n.setAttributes(node, l10nId);
      node.addEventListener("command", onCommand);
      menu.append(node);
      return node;
    };
    const copy = item("context-copy", "common-dialog-copy-cmd", () => {
      const text = window.getSelection().toString();
      if (text) {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(text);
      }
    });
    item("context-selectall", "common-dialog-select-all-cmd", () =>
      window.getSelection().selectAllChildren(infoBody)
    );
    document.body.append(menu);
    infoBody.addEventListener("contextmenu", event => {
      event.preventDefault();
      copy.disabled = window.getSelection().isCollapsed;
      menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
    });
  };

  const start = () => {
    propBag = window.arguments[0]
      .QueryInterface(Ci.nsIWritablePropertyBag2)
      .QueryInterface(Ci.nsIWritablePropertyBag);
    args = {};
    for (const prop of propBag.enumerator) {
      args[prop.name] = prop.value;
    }

    const dialog = document.getElementById("commonDialog");
    const card = dialog.querySelector("sval-dialog");
    const byId = id => document.getElementById(id);
    const buttons = [0, 1, 2, 3].map(n => byId(`button${n}`));
    const strings = Services.strings.createBundle(
      "chrome://global/locale/dialog.properties"
    );
    buttons[0].label = strings.GetStringFromName("button-accept");
    buttons[1].label = strings.GetStringFromName("button-cancel");

    const checkbox = byId("checkbox");
    // `CommonDialog.setLabelForNode` names a control through its `label`, as
    // a XUL checkbox takes one.
    Object.defineProperty(checkbox, "label", {
      set(text) {
        byId("checkboxLabel").textContent = String(text);
      },
      get() {
        return byId("checkboxLabel").textContent;
      },
    });

    const asker = askerOf(args);
    const origin = byId("titleText");
    if (asker?.raw) {
      origin.textContent = asker.raw;
      origin.hidden = false;
    } else if (asker?.l10nId) {
      document.l10n.setAttributes(origin, asker.l10nId);
      origin.hidden = false;
    }
    if (args.isInsecureAuth) {
      dialog.setAttribute("insecureauth", "true");
    }

    const infoBody = byId("infoBody");
    messageMenu(infoBody);
    const ui = {
      prompt: window,
      loginContainer: byId("loginContainer"),
      loginTextbox: byId("loginTextbox"),
      loginLabel: byId("loginLabel"),
      password1Container: byId("password1Container"),
      password1Textbox: byId("password1Textbox"),
      password1Label: byId("password1Label"),
      // `CommonDialog` shows the row only when there is a message.
      infoRow: infoBody,
      infoBody,
      infoTitle: byId("infoTitle"),
      infoIcon: byId("infoIcon"),
      checkbox,
      checkboxContainer: byId("checkboxContainer"),
      button3: buttons[3],
      button2: buttons[2],
      button1: buttons[1],
      button0: buttons[0],
      focusTarget: window,
    };

    const Dialog = new CommonDialog(args, ui);
    window.Dialog = Dialog;
    const press = n => {
      Dialog[`onButton${n}`]();
      window.close();
    };
    buttons.forEach((button, n) =>
      button.addEventListener("click", () => press(n))
    );
    // What the common dialog's `<dialog>` answers to, for its callers.
    dialog.getButton = type => buttons[TYPES.indexOf(type)] ?? null;
    dialog.acceptDialog = () => press(0);
    dialog.cancelDialog = () => press(1);
    checkbox.addEventListener("change", () => Dialog.onCheckbox());
    window.addEventListener("dialogclosing", event => {
      if (event.detail?.abort) {
        Dialog.abortPrompt();
      }
    });
    document.addEventListener("keydown", event => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        press(1);
        return;
      }
      // A focused button answers Enter itself.
      if (
        event.key === "Enter" &&
        !event.target.closest?.("sval-button, button")
      ) {
        const n = args.defaultButtonNum || 0;
        const button = buttons[n];
        if (!button.hidden && !button.disabled) {
          event.preventDefault();
          press(n);
        }
      }
    });

    const labels = Promise.all(
      [
        ["loginLabel", "common-dialog-username"],
        ["password1Label", "common-dialog-password"],
      ].map(async ([id, l10nId]) => {
        byId(id).textContent = await labelText(l10nId);
      })
    );
    // The card fits the box once the labels are in.
    card.pending = labels;

    Dialog.onLoad(dialog);

    // A text prompt and a password-only prompt name their field through the
    // message, as `CommonDialog` clears the label for.
    if (args.promptType === "prompt") {
      ui.loginLabel.hidden = true;
    } else if (args.promptType === "promptPassword") {
      ui.password1Label.hidden = true;
    }
    ui.infoTitle.hidden = !ui.infoTitle.textContent;
    if (ui.infoIcon.classList.contains("authentication-icon")) {
      card.icon = "key";
    }
    const defaultButton = buttons[args.defaultButtonNum || 0];
    defaultButton.dataset.default = "true";
    dialog.dataset.promptType = args.promptType;
    focusDefault = isInitialFocus => {
      Dialog.setDefaultFocus(isInitialFocus);
      if (!Dialog.hasInputField) {
        defaultButton.focus({ focusVisible: false });
      }
    };
    if (earlyFocus) {
      focusDefault(earlyFocus.isInitialFocus);
    }

    if (args.owningBrowsingContext?.isContent) {
      lazy.ContentAnalysisUtils.setupContentAnalysisEventsForTextElement(
        ui.loginTextbox,
        args.owningBrowsingContext
      );
    }
    window.getAttention();
  };

  window.addEventListener("unload", () => {
    if (!args) {
      return;
    }
    for (const name in args) {
      propBag.setProperty(name, args[name]);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
