/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * "Email <address>" in the page's context menu, for an email address selected
 * as plain text. It opens a new message to the address in the app the system
 * or the user's settings choose for `mailto:` links.
 *
 * It reads only the selection `nsContextMenu` already holds, when the menu
 * opens, and adds nothing to the page, so a page cannot tell it is there.
 */

export const EMAIL_ITEM_ID = "sval-context-email";

/** RFC 5321's limit on a whole address. */
const MAX_ADDRESS = 254;

const LOCAL_CHAR = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]";
const DOMAIN_LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;

/**
 * A dot-atom local part, then a domain of at least two labels whose last is
 * letters, which keeps out `user@localhost` and IP literals: an address in
 * running text is on the public internet.
 */
const ADDRESS = new RegExp(
  `^${LOCAL_CHAR}+(?:\\.${LOCAL_CHAR}+)*@(?:${DOMAIN_LABEL}\\.)+\\p{L}{2,}$`,
  "u"
);

/**
 * What a selection drags in around an address in prose: quotes, brackets,
 * and the sentence's own punctuation after it.
 */
const WRAPPING = /^[\s<(["'“‘]+|[\s>)\]"'”’.,;:!?]+$/gu;

/**
 * The email address `text` is, once the quotes, brackets and punctuation a
 * selection picks up around one are dropped, or null when it is anything
 * more or less than one address.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function emailAddressIn(text) {
  let address = text.replace(WRAPPING, "");
  if (/^mailto:/i.test(address)) {
    address = address.slice("mailto:".length);
  }
  if (address.length > MAX_ADDRESS || !ADDRESS.test(address)) {
    return null;
  }
  return address;
}

/**
 * The `mailto:` URL that starts a message to `address`. The local part may
 * hold `?`, `#`, `%` or `&`, which a `mailto:` URL reads as its own syntax
 * (RFC 6068 §2), so everything but the `@` is escaped.
 *
 * @param {string} address
 * @returns {string}
 */
export function mailtoFor(address) {
  return `mailto:${encodeURIComponent(address).replace("%40", "@")}`;
}

export const SvalEmailMenu = {
  /**
   * Adds the item to `win`'s page context menu, before its web search item.
   * It shows when the selection is one email address outside a link: a link
   * has Firefox's own items for its address.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    const anchor = doc.getElementById("context-searchselect");
    if (!anchor) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = EMAIL_ITEM_ID;
    item.hidden = true;
    anchor.before(item);
    const addressOf = menu =>
      menu?.isTextSelected && !menu.onLink
        ? emailAddressIn(menu.selectionInfo.fullText)
        : null;
    item.addEventListener("command", () => {
      const menu = win.gContextMenu;
      const address = addressOf(menu);
      if (address) {
        this.compose(address, menu.browser.browsingContext);
      }
    });
    // On the window, so it runs after the menu's own `popupshowing`, which
    // makes `gContextMenu`.
    win.addEventListener("popupshowing", event => {
      if (event.target.id !== "contentAreaContextMenu") {
        return;
      }
      const address = addressOf(win.gContextMenu);
      item.hidden = !address;
      if (address) {
        item.dataset.address = address;
        item.setAttribute("label", `Email ${address}`);
      }
      // Firefox placed the menu's separators for the items it showed
      // (`nsContextMenu.showHideSeparators`), before this ran.
      event.target.showHideSeparators?.();
    });
  },

  /**
   * Hands a message to `address` to the `mailto:` handler, as Firefox's own
   * "Email Link…" does (`MailIntegration`), so the user's choice in Settings
   * and Gecko's ask-first dialog apply. The system principal is the user's
   * own click in the browser's menu; the page asked for nothing.
   *
   * @param {string} address
   * @param {BrowsingContext} browsingContext The page's, where a dialog shows.
   */
  compose(address, browsingContext) {
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(
        Services.io.newURI(mailtoFor(address)),
        Services.scriptSecurityManager.getSystemPrincipal(),
        null,
        browsingContext
      );
  },
};
