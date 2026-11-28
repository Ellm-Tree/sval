/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's popovers: XUL `panel`s a caller fills with its own content, made in
 * the document's popupset and styled by `sval-popover.css`, so no sheet of
 * Firefox's decides how one looks.
 *
 * They stay in the light DOM, as `SvalMenu`'s menus do, for the same
 * reasons: Gecko's popups inside a shadow root lose their positioning and
 * hiding, and the window's listeners and sheets (`SvalStem`) do not reach
 * into one.
 *
 * A popover grows from its button with a stem (`SvalStem`) when it is made
 * with `stem`, and opens without one in a see-through window. Its button,
 * when it has one, carries `open` while it shows, and `aria-expanded` says
 * so where the button keeps one.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
});

export const POPOVER_CSS = "chrome://browser/content/sval/sval-popover.css";

/** The attribute every popover carries, which its sheet keys on. */
const POPOVER_ATTR = "sval-popover";

/** @type {WeakSet<Window>} Windows `sval-popover.css` is loaded in. */
const sheeted = new WeakSet();

/**
 * @param {Window} win
 * @returns {void}
 */
function loadSheet(win) {
  if (sheeted.has(win)) {
    return;
  }
  sheeted.add(win);
  win.windowUtils.loadSheetUsingURIString(
    POPOVER_CSS,
    win.windowUtils.AUTHOR_SHEET
  );
}

export const SvalPopover = {
  loadSheet,

  /**
   * Draws a panel Firefox makes as one of Sval's popovers: its sheet in
   * place of Firefox's popup styles, and a see-through window's backdrop.
   *
   * @param {Element} panel
   */
  adopt(panel) {
    loadSheet(panel.documentGlobal);
    panel.setAttribute(POPOVER_ATTR, "");
  },

  /**
   * Makes a popover in `doc`'s popupset.
   *
   * @param {Document} doc
   * @param {object} options
   * @param {string} [options.name] Its id, in place of any element holding
   *   it.
   * @param {boolean} [options.arrow] Whether it is placed as an arrow panel
   *   (`type="arrow"`, `panel.js`); a plain one stays where it is put.
   * @param {string} [options.label] Its accessible name.
   * @param {string} [options.labelledBy] The id of what names it.
   * @param {string} [options.role] Its role, a dialog where none is given.
   * @param {string} [options.className]
   * @param {object} [options.attributes] More attributes, such as `flip`,
   *   `orient`, `noautohide` or `noautofocus`.
   * @param {{side?: string, hang?: boolean}} [options.stem] Grows from its
   *   button (`SvalStem`).
   * @param {(event: Event) => void} [options.onShowing]
   * @param {(event: Event) => void} [options.onShown]
   * @param {(event: Event) => void} [options.onHidden]
   * @param {boolean} [options.transient] Removes it once it hides.
   * @returns {{popup: Element, openFrom: Function, openAt: Function,
   *   close: Function, isOpen: Function, button: ?Element}}
   */
  create(
    doc,
    {
      name,
      arrow = true,
      label,
      labelledBy,
      role = "dialog",
      className,
      attributes = {},
      stem,
      onShowing,
      onShown,
      onHidden,
      transient = false,
    } = {}
  ) {
    loadSheet(doc.defaultView);
    const popup = doc.createXULElement("panel");
    popup.setAttribute(POPOVER_ATTR, "");
    if (name) {
      doc.getElementById(name)?.remove();
      popup.id = name;
    }
    if (arrow) {
      popup.setAttribute("type", "arrow");
    }
    popup.setAttribute("role", role);
    if (label) {
      popup.setAttribute("aria-label", label);
    }
    if (labelledBy) {
      popup.setAttribute("aria-labelledby", labelledBy);
    }
    if (className) {
      popup.className = className;
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (value != null) {
        popup.setAttribute(key, value);
      }
    }
    if (stem) {
      popup.setAttribute("sval-stem-host", "");
      if (stem.side) {
        popup.setAttribute("sval-stem-side", stem.side);
      }
      popup.toggleAttribute("sval-stem-hang", !!stem.hang);
    }
    let focusOnShow = false;
    const handle = {
      popup,
      /** The button it last opened from, while it shows. */
      button: null,
      /**
       * Opens it from `anchor`, at the one distance from it every popover
       * keeps: a popover takes no offset of its own, so every stem is as
       * long as every other.
       *
       * @param {Element} anchor
       * @param {string} [position] An `openPopup` position.
       * @param {object} [options]
       * @param {boolean} [options.focus] Moves the keyboard into it once it
       *   shows, as a key that opens it does.
       * @param {?Element} [options.button] What it opens from, which carries
       *   `open` and `aria-expanded` while it shows: `anchor` where none is
       *   given, and nothing for null.
       */
      openFrom(anchor, position = "bottomleft topleft", options = {}) {
        focusOnShow = !!options.focus;
        handle.button = "button" in options ? options.button : anchor;
        popup.openPopup(anchor, position);
      },
      /**
       * Opens it at a point on the screen, with no button.
       *
       * @param {number} screenX In CSS pixels.
       * @param {number} screenY
       * @param {object} [options]
       * @param {boolean} [options.focus]
       */
      openAt(screenX, screenY, options = {}) {
        focusOnShow = !!options.focus;
        handle.button = null;
        popup.openPopupAtScreen(screenX, screenY, false);
      },
      close() {
        popup.hidePopup();
      },
      /** @returns {boolean} whether it is opening or open. */
      isOpen() {
        return popup.state === "showing" || popup.state === "open";
      },
    };
    // A popup it holds, a `SvalMenu` or a `select`'s, sends its own events
    // through it, so each handler looks at its own.
    popup.addEventListener("popupshowing", event => {
      if (event.target === popup) {
        onShowing?.(event);
      }
    });
    popup.addEventListener("popupshown", event => {
      if (event.target !== popup) {
        return;
      }
      handle.button?.setAttribute("open", "true");
      if (handle.button?.hasAttribute("aria-expanded")) {
        handle.button.setAttribute("aria-expanded", "true");
      }
      if (focusOnShow) {
        focusOnShow = false;
        popup.ownerDocument.commandDispatcher.advanceFocusIntoSubtree(popup);
      }
      onShown?.(event);
    });
    // A popover opens at its top. Gecko keeps a scrolled box's place when
    // its frames go as the popup hides, and gives it to the box at the same
    // place in the tree as the popup shows again (`nsILayoutHistoryState`),
    // even a box drawn afresh, so each one is put back to its top first.
    popup.addEventListener("popuphiding", event => {
      if (event.target !== popup) {
        return;
      }
      for (const el of popup.querySelectorAll("*")) {
        if (el.scrollTop) {
          el.scrollTop = 0;
        }
      }
    });
    popup.addEventListener("popuphidden", event => {
      if (event.target !== popup) {
        return;
      }
      handle.button?.removeAttribute("open");
      if (handle.button?.hasAttribute("aria-expanded")) {
        handle.button.setAttribute("aria-expanded", "false");
      }
      handle.button = null;
      onHidden?.(event);
      if (transient) {
        popup.remove();
      }
    });
    // A menu it opens takes Sval's look in its window too.
    lazy.SvalMenu.loadSheet(doc.defaultView);
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(popup);
    return handle;
  },
};
