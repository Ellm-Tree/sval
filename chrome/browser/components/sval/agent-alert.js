/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The generic agent alert opened by `SvalAgentAlerts.ask`. It reads
 * `{kind, question, detail, items, options, scopes, choices, defaultChoice}`
 * from `window.arguments[0]` and answers through its `result`: the id of the
 * choice clicked, with the radio of `options` checked then in `option` and
 * the pick of the "Remember for" menu, `scopes`, in `scope`.
 *
 * Every string is set with `textContent`. The question names an agent and a
 * site, and both come from outside Sval, so nothing here is parsed as markup.
 * The default choice has focus, so a stray Enter picks the safe answer. The
 * first grant is the dialog's primary button (`sval-dialog.css`). Two choices
 * share a row, the safe one first and the grant at the end. More than two
 * do not fit a row, so they stack, the grants from the top and the safe
 * answer last.
 *
 * Every other choice grants something, and `sval-dialog-hold.js` holds it
 * through the dialog delay.
 */

"use strict";

const SvalAgentAlert = {
  start() {
    const args = window.arguments?.[0] ?? {};
    if (args.kind) {
      document.querySelector(".sval-aa").dataset.kind = String(args.kind);
    }
    document.getElementById("sval-aa-question").textContent = String(
      args.question ?? ""
    );
    if (args.detail) {
      const detail = document.getElementById("sval-aa-detail");
      detail.textContent = String(args.detail);
      detail.hidden = false;
    }
    const list = document.getElementById("sval-aa-items");
    const showItems = items => {
      list.replaceChildren(
        ...items.map(item => {
          const li = document.createElement("li");
          li.textContent = String(item?.text ?? item);
          for (const [key, value] of Object.entries(item?.data ?? {})) {
            li.dataset[key] = String(value);
          }
          return li;
        })
      );
      list.hidden = !items.length;
    };
    if (Array.isArray(args.items) && args.items.length) {
      showItems(args.items);
    }
    // Radios grant nothing on their own, so the enable delay never holds
    // them: they say what a grant covers.
    const options = args.options;
    if (options && Array.isArray(options.choices)) {
      const group = document.getElementById("sval-aa-options");
      document.getElementById("sval-aa-options-label").textContent = String(
        options.label ?? ""
      );
      for (const { id, label } of options.choices) {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "sval-aa-option";
        radio.value = String(id);
        radio.checked = id === options.value;
        radio.addEventListener("change", () => {
          args.option = id;
        });
        const words = document.createElement("span");
        words.textContent = String(label);
        const row = document.createElement("label");
        row.className = "sval-dialog-check";
        row.append(radio, words);
        group.append(row);
      }
      group.hidden = false;
    }
    const closeMenu = this.showScopes(args);
    const actions = document.querySelector(".sval-aa-actions");
    let fallback = null;
    const grants = [];
    for (const { id, label } of args.choices ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sval-dialog-btn";
      button.dataset.choice = String(id);
      button.textContent = String(label);
      button.addEventListener("click", () => {
        args.result = id;
        window.close();
      });
      if (id === args.defaultChoice) {
        fallback = button;
      } else {
        button.classList.toggle("primary", !grants.length);
        grants.push(button);
      }
    }
    const stacked = grants.length > 1;
    actions.classList.toggle("sval-dialog-actions-stacked", stacked);
    const safe = fallback ? [fallback] : [];
    actions.append(...(stacked ? [...grants, ...safe] : [...safe, ...grants]));
    // The alert's description is what it asks the user to decide on: what
    // the agent would send, and the sites or files. Focus opens on the
    // default choice, so this is what a screen reader reads with the
    // question.
    const form = document.querySelector(".sval-aa");
    form.ariaDescribedByElements = [
      document.getElementById("sval-aa-detail"),
      list,
    ].filter(el => !el.hidden);
    // Escape dismisses, which answers the default, at any time. The delay
    // below swallows keys while it runs, to stop a held key from reaching a
    // grant as it is enabled, and Escape is answered before that.
    window.addEventListener(
      "keydown",
      event => {
        if (event.key === "Escape") {
          // An open menu takes Escape for itself, and the alert stays.
          if (closeMenu?.()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          window.close();
        }
      },
      true
    );
    this._hold = window.svalHoldGrants(grants);
    // Enter in the form submits it; only a click on a choice answers.
    form.addEventListener("submit", event => event.preventDefault());
    if (fallback) {
      // `SubDialog.focus` calls this when the dialog opens, in place of its
      // own move to the first focusable element.
      document.subDialogSetDefaultFocus = () => fallback.focus();
      fallback.focus();
    }
  },
};

/**
 * Shows the "Remember for" menu (host-scoped rules spec §4): a button naming
 * the scope picked, which opens a listbox of the scopes, each with what it
 * covers. Like the radios, it grants nothing and the enable delay never
 * holds it.
 *
 * @param {object} args The alert's arguments, whose `scope` takes the pick.
 * @returns {(() => boolean)|null} Closes the menu, answering whether it was
 *   open; null where the alert has no menu.
 */
SvalAgentAlert.showScopes = function (args) {
  const scopes = args.scopes;
  if (!scopes || !Array.isArray(scopes.choices)) {
    return null;
  }
  const row = document.getElementById("sval-aa-scope");
  const button = document.getElementById("sval-aa-scope-button");
  const value = document.getElementById("sval-aa-scope-value");
  const menu = document.getElementById("sval-aa-scope-menu");
  button.setAttribute(
    "aria-labelledby",
    "sval-aa-scope-label sval-aa-scope-value"
  );
  const options = scopes.choices.map(({ id, label, sub }, index) => {
    const option = document.createElement("div");
    option.className = "sval-dialog-scope-option";
    option.id = `sval-aa-scope-option-${index}`;
    option.setAttribute("role", "option");
    option.dataset.scope = String(id);
    const check = document.createElement("span");
    check.className = "sval-dialog-scope-check";
    check.setAttribute("aria-hidden", "true");
    const words = document.createElement("span");
    words.className = "sval-dialog-scope-words";
    const name = document.createElement("span");
    name.className = "sval-dialog-scope-name";
    name.textContent = String(label);
    const note = document.createElement("span");
    note.className = "sval-dialog-scope-sub";
    note.textContent = String(sub ?? "");
    words.append(name, note);
    option.append(check, words);
    option.addEventListener("click", () => pick(index));
    option.addEventListener("mousemove", () => mark(index));
    return option;
  });
  menu.append(...options);
  let active = 0;
  const show = () => {
    const at = Math.max(
      0,
      options.findIndex(o => o.dataset.scope === args.scope)
    );
    for (const [index, option] of options.entries()) {
      option.setAttribute("aria-selected", String(index === at));
    }
    value.textContent = String(scopes.choices[at]?.label ?? "");
  };
  const mark = index => {
    active = index;
    for (const [each, option] of options.entries()) {
      option.toggleAttribute("data-active", each === index);
    }
    menu.setAttribute("aria-activedescendant", options[index].id);
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    mark(
      Math.max(
        0,
        options.findIndex(o => o.dataset.scope === args.scope)
      )
    );
    menu.focus();
  };
  const close = () => {
    if (menu.hidden) {
      return false;
    }
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.focus();
    return true;
  };
  const pick = index => {
    args.scope = scopes.choices[index].id;
    show();
    close();
  };
  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  button.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", event => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      mark((active + step + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(active);
    } else if (event.key === "Tab") {
      close();
    }
  });
  menu.addEventListener("focusout", event => {
    if (!menu.contains(event.relatedTarget) && event.relatedTarget !== button) {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  });
  show();
  row.hidden = false;
  return close;
};

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => SvalAgentAlert.start(), {
    once: true,
  });
} else {
  SvalAgentAlert.start();
}
