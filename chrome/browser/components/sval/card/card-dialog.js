/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The card dialog (`card-dialog.xhtml`): the user's card, the days it counts
 * from and its next star, and Save image.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    cardImage: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    cardName: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    cardStats: "moz-src:///browser/components/sval/SvalCardStats.sys.mjs",
    cardYears: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
    parseDay: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
    readCard: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
    renderCard: "moz-src:///browser/components/sval/SvalCardArt.sys.mjs",
    saveToDownloads:
      "moz-src:///browser/components/sval/SvalAgentDownloads.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });

  const day = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

  const start = async () => {
    const $ = selector => document.querySelector(selector);
    const done = $(".sval-card-dialog-done");
    done.addEventListener("click", () => window.close());
    const card = lazy.readCard();
    if (!card) {
      window.close();
      return;
    }

    const save = $(".sval-card-dialog-save");
    const status = $(".sval-card-dialog-status");
    save.addEventListener("click", async () => {
      save.disabled = true;
      status.textContent = "";
      try {
        const download = await lazy.saveToDownloads(
          // Drawn in the browser window, whose CSP lets it load the card
          // as a `data:` image, which this page's does not.
          await lazy.cardImage(window.browsingContext.topChromeWindow, card),
          "Sval card.png",
          false
        );
        status.textContent = download.succeeded
          ? `Saved to your downloads folder as ${PathUtils.filename(download.target.path)}.`
          : "Couldn't save the image.";
      } catch (err) {
        lazy.SvalLog.warn(
          `card dialog: the image could not be saved: ${lazy.SvalLog.errorName(err)}`
        );
        status.textContent = "Couldn't save the image.";
      } finally {
        save.disabled = false;
      }
    });

    $("#sval-card-dialog-title").textContent = lazy.cardName(card);
    const fact = (name, date) => {
      const row = $(`[data-fact="${name}"]`);
      row.hidden = !date;
      if (date) {
        row.querySelector("dd").textContent = day.format(date);
      }
    };
    fact("arc", card.arc && lazy.parseDay(card.since));
    fact("sval", lazy.parseDay(card.svalSince));
    const next = lazy.cardYears(card).find(y => y.next);
    const since = lazy.parseDay(card.since);
    fact("next", new Date(next.year, since.getMonth(), since.getDate()));

    try {
      $(".sval-card-dialog-holder").append(
        await lazy.renderCard(document, card)
      );
    } catch (err) {
      lazy.SvalLog.warn(
        `card dialog: the card could not be drawn: ${lazy.SvalLog.errorName(err)}`
      );
    }
    const counts = await lazy.cardStats(
      window.browsingContext.topChromeWindow?.SvalPanel?.engine ?? null
    );
    const number = new Intl.NumberFormat();
    for (const [name, value] of Object.entries(counts)) {
      const row = $(`[data-stat="${name}"]`);
      if (row && Number.isFinite(value)) {
        row.querySelector("dd").textContent = number.format(value);
        row.hidden = false;
      }
    }
    // `SubDialog` measured the page before the card and its counts arrived.
    window.resizeDialog?.();
    done.focus();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
