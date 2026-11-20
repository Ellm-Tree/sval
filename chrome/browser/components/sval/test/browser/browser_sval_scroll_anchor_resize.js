/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A page that gets narrower keeps the reader's place
 * (`scroll-anchor-on-resize.patch`): its text rewraps taller, and scroll
 * anchoring keeps the paragraph at the top of the view where it was, as a
 * Split narrowing a tab does.
 */

const PARAGRAPH =
  "The kingdom made several advancements in nautical science and maritime " +
  "exploration, and its sailors reached new territories and sea routes. ";
const LONG_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    "<!doctype html><body style='margin:0;font:16px/1.5 sans-serif'>" +
      Array.from(
        { length: 80 },
        (_, i) => `<p id="p${i}">${PARAGRAPH.repeat(4)}</p>`
      ).join("") +
      "</body>"
  );

add_task(async function a_narrower_page_keeps_the_top_paragraph_in_place() {
  const tab = await openPage(LONG_PAGE);
  const browser = tab.linkedBrowser;

  // Paragraph 40 first in the view, the one before it and its margin above
  // the top: the paragraph anchoring picks (css-scroll-anchoring §2.2).
  // Reading a rect flushes layout, which applies a pending anchor adjustment
  // too (`PresShell::FlushPendingScrollAnchorAdjustments`).
  const before = await SpecialPowers.spawn(browser, [], () => {
    const p = content.document.getElementById("p40");
    content.scrollTo(0, p.offsetTop - 4);
    return {
      top: p.getBoundingClientRect().top,
      width: content.innerWidth,
    };
  });

  browser.style.marginInlineEnd = `${Math.round(before.width / 2)}px`;
  await within(
    SpecialPowers.spawn(browser, [before.width], width =>
      ContentTaskUtils.waitForCondition(
        () => content.innerWidth < width * 0.75,
        "the page gets narrower"
      )
    ),
    10_000,
    "the page narrowing"
  );

  const after = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("p40").getBoundingClientRect().top
  );
  Assert.lessOrEqual(
    Math.abs(after - before.top),
    1,
    `the paragraph stays where the reader left it (${before.top} then ${after})`
  );
});
