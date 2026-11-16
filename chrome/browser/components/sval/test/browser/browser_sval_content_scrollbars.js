/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A web page that does not style its scrollbars scrolls with the workspace
 * panel's thin scrollbar on a clear track, and a page's own scrollbar styles
 * win over that default. Every task runs with classic scrollbars, which take
 * layout space, so a strip's width can be measured.
 */

const TALL = "<div style='height: 5000px'></div>";

/**
 * A page whose content overflows.
 *
 * @param {string} [head] markup for the page's head
 * @returns {string} its data: URL
 */
function tallPage(head = "") {
  return `data:text/html,<!DOCTYPE html><html><head>${encodeURIComponent(
    head
  )}</head><body>${encodeURIComponent(TALL)}</body></html>`;
}

const CLEAR = "rgba(0, 0, 0, 0)";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useOverlayScrollbars", 0]] });
});

/**
 * The page's scrollbar: its root's computed scrollbar styles, the width of
 * the viewport's strip, and an unstyled inner scroller's scrollbar-width.
 *
 * @param {MozBrowser} browser
 */
function pageScrollbar(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const root = content.document.documentElement;
    const style = content.getComputedStyle(root);
    const inner = content.document.createElement("div");
    inner.style.overflow = "auto";
    content.document.body.append(inner);
    const innerWidth = content.getComputedStyle(inner).scrollbarWidth;
    inner.remove();
    return {
      width: style.scrollbarWidth,
      color: style.scrollbarColor,
      strip: content.innerWidth - root.clientWidth,
      innerWidth,
    };
  });
}

/** The panel's tree's scrollbar, as {@link pageScrollbar} reports a page's. */
async function panelScrollbar() {
  const tree = await scrollingTree();
  const bar = nativePart(
    tree,
    el => el.localName === "scrollbar" && el.hasAttribute("vertical")
  );
  const style = getComputedStyle(tree);
  return {
    width: style.scrollbarWidth,
    color: style.scrollbarColor,
    strip: bar.getBoundingClientRect().width,
  };
}

add_task(async function an_unstyled_page_scrolls_like_the_panel() {
  const tab = await openPage(tallPage());
  const page = await pageScrollbar(tab.linkedBrowser);
  const panel = await panelScrollbar();
  Assert.equal(page.width, "thin", "the page's scrollbar is thin");
  Assert.equal(page.width, panel.width, "as the panel's is");
  Assert.equal(page.innerWidth, "thin", "so is an inner scroller's");
  Assert.greater(page.strip, 0, "the page's strip takes layout space");
  Assert.lessOrEqual(
    Math.abs(page.strip - panel.strip),
    1,
    `the page's strip (${page.strip}px) is the panel's (${panel.strip}px)`
  );
  Assert.ok(page.color.endsWith(CLEAR), "the page's track is clear");
  Assert.ok(panel.color.endsWith(CLEAR), "as the panel's is");
});

add_task(async function a_pages_own_scrollbar_styles_win() {
  const thin = await pageScrollbar((await openPage(tallPage())).linkedBrowser);
  const own = "rgb(255, 0, 0) rgb(0, 0, 255)";
  const tab = await openPage(
    tallPage(
      `<style>:root { scrollbar-color: ${own}; scrollbar-width: auto }</style>`
    )
  );
  const page = await pageScrollbar(tab.linkedBrowser);
  Assert.equal(page.color, own, "the page's colors are its own");
  Assert.equal(page.width, "auto", "and so is its width");
  Assert.greater(page.strip, thin.strip, "whose strip is the wider one");
});

add_task(async function forced_colors_keep_the_systems_scrollbar() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.display.document_color_use", 2]],
  });
  const tab = await openPage(tallPage());
  const page = await pageScrollbar(tab.linkedBrowser);
  Assert.equal(page.color, "auto", "the page's scrollbar takes no colors");
  await SpecialPowers.popPrefEnv();
});
