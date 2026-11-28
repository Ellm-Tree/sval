/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The scope dropdown (host-scoped rules spec §4): where a choice made on a
 * page is saved, the page's host or its whole site. A button
 * names the scope, and opens a listbox of the two, each with what it covers.
 * The site menu, the Privacy and Security panel, the extensions menu and the
 * element picker's card draw it, each starting at the host.
 *
 * The picker's overlay takes every event at the window root before any
 * element of it hears one (`SvalElementPickerChild`), so the dropdown acts on
 * keys and clicks through `key` and `click`, which a surface hands it, and
 * `listen` hands them over in a document whose events reach their targets.
 * Its look is in `sval-scope.css`.
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

/**
 * @param {{site: string, host: string, choice: boolean}} scope As
 *   `scopeOfHost` gives it.
 * @param {string} name The host or the site.
 * @returns {string} The scope's name as a title or an option shows it.
 */
export function scopeLabel(scope, name) {
  return scope.choice && name === scope.site ? `All of ${scope.site}` : name;
}

/**
 * @param {{site: string, host: string, choice: boolean}} scope
 * @param {string} name The host or the site.
 * @returns {string} The scope's name inside a sentence.
 */
export function scopePhrase(scope, name) {
  return scope.choice && name === scope.site ? `all of ${scope.site}` : name;
}

/**
 * @param {{site: string, host: string, choice: boolean}} scope
 * @returns {Array<{name: string, label: string, sub: string}>} The
 *   dropdown's options, host first.
 */
export function scopeChoices(scope) {
  return [
    { name: scope.host, label: scope.host, sub: `Only on ${scope.host}` },
    {
      name: scope.site,
      label: scopeLabel(scope, scope.site),
      sub: `Everywhere on ${scope.site}`,
    },
  ];
}

/**
 * The one line a surface shows at the site's scope while the host holds
 * choices of its own, which the site's choice does not reach.
 *
 * @param {string} host
 * @param {string[]} kinds What the host holds, each as a sentence names it.
 * @returns {?string} Null where it holds none.
 */
export function keepsLine(host, kinds) {
  if (!kinds.length) {
    return null;
  }
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(kinds);
  return `${host} keeps its own ${list} ${kinds.length > 1 ? "choices" : "choice"}.`;
}

/**
 * The dropdown's elements and what they do. `root` is what a surface places.
 */
export class ScopeDropdown {
  /** @type {Element} */
  root;
  /** @type {Element} */
  button;
  /** @type {Element} */
  menu;
  #doc;
  #choices;
  #options;
  #value;
  #active = 0;
  #onPick;
  #escape = null;

  /**
   * @param {Document} doc
   * @param {object} options
   * @param {string} options.id Prefix of the elements' ids, which stay the
   *   same across a surface's redraws, so focus can find the button again.
   * @param {Array<{name: string, label: string, sub: string}>}
   *   options.choices From `scopeChoices`.
   * @param {string} options.current The name of the scope shown.
   * @param {"title"|"pill"} [options.look] A surface's title, or a pill
   *   that finishes a line's words.
   * @param {boolean} [options.inline] Opens the menu in the surface's flow,
   *   where the surface would clip a menu drawn over it.
   * @param {Element[]} [options.labelledBy] What names the button before
   *   its value; the value alone otherwise.
   * @param {(name: string) => void} options.onPick Called with the name of
   *   a scope picked other than the current one.
   */
  constructor(
    doc,
    {
      id,
      choices,
      current,
      look = "title",
      inline = false,
      labelledBy = [],
      onPick,
    }
  ) {
    this.#doc = doc;
    this.#choices = choices;
    this.#onPick = onPick;
    this.#value = htmlElement(doc, "span", {
      className: "sval-scope-value",
      id: `${id}-value`,
    });
    this.button = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-scope-button",
        id: `${id}-button`,
        attrs: {
          "aria-haspopup": "listbox",
          "aria-expanded": "false",
          "aria-controls": `${id}-menu`,
        },
      },
      this.#value,
      htmlElement(doc, "span", {
        className: "sval-scope-chevron",
        attrs: { "aria-hidden": "true" },
      })
    );
    this.button.ariaLabelledByElements = [...labelledBy, this.#value];
    this.#options = choices.map(({ name, label, sub }, index) =>
      htmlElement(
        doc,
        "div",
        {
          className: "sval-scope-option",
          id: `${id}-option-${index}`,
          dataset: { scope: name },
          attrs: { role: "option" },
        },
        htmlElement(doc, "span", {
          className: "sval-scope-check",
          attrs: { "aria-hidden": "true" },
        }),
        htmlElement(
          doc,
          "span",
          { className: "sval-scope-words" },
          htmlElement(doc, "span", { className: "sval-scope-name" }, label),
          htmlElement(doc, "span", { className: "sval-scope-sub" }, sub)
        )
      )
    );
    this.menu = htmlElement(
      doc,
      "div",
      {
        className: "sval-scope-menu",
        id: `${id}-menu`,
        // The listbox holds the focus and names its option through
        // `aria-activedescendant`. Hidden while closed, it is never a tab
        // stop then.
        tabIndex: 0,
        hidden: true,
        attrs: { role: "listbox" },
      },
      ...this.#options
    );
    this.menu.ariaLabelledByElements = [this.#value];
    this.root = htmlElement(
      doc,
      "div",
      {
        className: "sval-scope",
        dataset: { look, flow: inline ? "inline" : "over" },
      },
      this.button,
      this.menu
    );
    this.#show(current);
  }

  /** @returns {string} The name of the scope shown. */
  get current() {
    return this.#choices[this.#currentIndex].name;
  }

  /** @returns {boolean} Whether the menu is open. */
  get isOpen() {
    return !this.menu.hidden;
  }

  get #currentIndex() {
    return Math.max(
      0,
      this.#options.findIndex(o => o.getAttribute("aria-selected") === "true")
    );
  }

  /** @param {string} name */
  #show(name) {
    const at = Math.max(
      0,
      this.#choices.findIndex(c => c.name === name)
    );
    for (const [index, option] of this.#options.entries()) {
      option.setAttribute("aria-selected", String(index === at));
    }
    this.#value.textContent = this.#choices[at].label;
    this.root.dataset.scope = this.#choices[at].name;
  }

  /** @param {number} index */
  #mark(index) {
    this.#active = index;
    for (const [each, option] of this.#options.entries()) {
      option.toggleAttribute("data-active", each === index);
    }
    this.menu.setAttribute("aria-activedescendant", this.#options[index].id);
  }

  /** Opens the menu on the current scope and gives it the focus. */
  open() {
    if (this.isOpen) {
      return;
    }
    this.menu.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.#mark(this.#currentIndex);
    this.menu.focus({ focusVisible: true });
    if (this.#escape) {
      this.#doc.defaultView.addEventListener("keydown", this.#escape, true);
    }
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.focus] Gives the button the focus back.
   */
  close({ focus = false } = {}) {
    if (this.#escape) {
      this.#doc.defaultView?.removeEventListener("keydown", this.#escape, true);
    }
    if (!this.isOpen) {
      return;
    }
    this.menu.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (focus) {
      this.button.focus({ focusVisible: true });
    }
  }

  /** @param {number} index */
  #pick(index) {
    const { name } = this.#choices[index];
    const changed = name !== this.current;
    this.#show(name);
    this.close({ focus: true });
    if (changed) {
      this.#onPick(name);
    }
  }

  /**
   * Acts on a key pressed on the button or in the menu: Enter, Space or
   * Down opens it, Up and Down move, Enter and Space pick, Escape closes it
   * and Tab leaves it.
   *
   * @param {KeyboardEvent} event
   * @returns {boolean} Whether the dropdown used the key, which the caller
   *   then keeps from the page and the surface. Tab is never used.
   */
  key(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    const target = event.originalTarget;
    if (!this.isOpen) {
      if (
        target === this.button &&
        ["Enter", " ", "ArrowDown"].includes(event.key)
      ) {
        this.open();
        return true;
      }
      return false;
    }
    if (target !== this.button && !this.menu.contains(target)) {
      return false;
    }
    const last = this.#options.length - 1;
    switch (event.key) {
      case "ArrowDown":
        this.#mark(Math.min(this.#active + 1, last));
        return true;
      case "ArrowUp":
        this.#mark(Math.max(this.#active - 1, 0));
        return true;
      case "Home":
        this.#mark(0);
        return true;
      case "End":
        this.#mark(last);
        return true;
      case "Enter":
      case " ":
        this.#pick(this.#active);
        return true;
      case "Escape":
        this.close({ focus: true });
        return true;
      case "Tab":
        this.close();
        return false;
    }
    return false;
  }

  /**
   * Acts on a click: the button opens or closes the menu, an option picks
   * its scope, and a click anywhere else closes an open menu.
   *
   * @param {?Node} target What was clicked.
   * @returns {boolean} Whether the click was on the dropdown.
   */
  click(target) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    if (node && this.button.contains(node)) {
      if (this.isOpen) {
        this.close({ focus: true });
      } else {
        this.open();
      }
      return true;
    }
    const option = node?.closest?.(".sval-scope-option");
    if (option && this.menu.contains(option)) {
      this.#pick(this.#options.indexOf(option));
      return true;
    }
    this.close();
    return false;
  }

  /**
   * Hands the dropdown its own events, in a document whose events reach
   * their targets. Escape is taken at the window, ahead of a panel's popup
   * manager, which closes the whole panel on it (`nsXULPopupManager`'s
   * capturing key listener on the document), while the menu is open.
   *
   * @returns {this}
   */
  listen() {
    this.#escape = event => {
      if (!this.root.isConnected) {
        this.close();
        return;
      }
      if (
        event.key === "Escape" &&
        this.isOpen &&
        this.root.contains(event.originalTarget)
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.close({ focus: true });
      }
    };
    this.root.addEventListener("click", event => {
      this.click(event.originalTarget);
    });
    this.root.addEventListener("keydown", event => {
      if (this.key(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.menu.addEventListener("focusout", event => {
      if (
        !this.menu.contains(event.relatedTarget) &&
        event.relatedTarget !== this.button
      ) {
        this.close();
      }
    });
    return this;
  }
}
