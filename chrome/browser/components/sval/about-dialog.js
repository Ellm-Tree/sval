/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The About dialog's card (`aboutDialog.xhtml`): the user's card in place of
 * the globe, its name under it, and a click that opens Your Sval Card in a
 * browser window. With no card yet, the globe stays.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
    cardName: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    openCardDialog: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    renderCard: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });

  const { readCard } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalCard.sys.mjs"
  );
  const card = readCard();
  if (card) {
    const html = tag =>
      document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    // Placed before the window first lays out, at the card's own size
    // (`about-dialog.css`), because the window takes its size from that
    // layout and never again.
    const button = html("button");
    button.id = "svalCard";
    button.type = "button";
    button.title = "Your Sval Card";
    button.setAttribute("aria-label", "Your Sval Card");
    const name = html("p");
    name.id = "svalCardName";
    name.textContent = lazy.cardName(card);
    document.getElementById("leftBox").append(button, name);

    button.addEventListener("click", async () => {
      const win =
        lazy.BrowserWindowTracker.getTopWindow() ??
        (await lazy.BrowserWindowTracker.promiseOpenWindow());
      win.focus();
      lazy.openCardDialog(win);
    });

    // The glow's canvas takes its size from `card.css`, which must apply
    // before the card is drawn (`renderCard`).
    window.addEventListener(
      "load",
      async () => {
        try {
          button.append(await lazy.renderCard(document, card));
        } catch (err) {
          lazy.SvalLog.warn(
            `about dialog: the card could not be drawn: ${lazy.SvalLog.errorName(err)}`
          );
        }
      },
      { once: true }
    );
  }
}
