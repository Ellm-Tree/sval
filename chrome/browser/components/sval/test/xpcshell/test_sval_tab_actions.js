/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { markdownLink } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabActions.sys.mjs"
);

/** A Markdown link keeps its text and its destination whole. */
add_task(function a_markdown_link_escapes_what_would_break_it() {
  Assert.equal(
    markdownLink("Plain", "https://example.com/"),
    "[Plain](https://example.com/)"
  );
  Assert.equal(
    markdownLink("A [draft] \\ note", "https://example.com/"),
    "[A \\[draft\\] \\\\ note](https://example.com/)",
    "brackets and backslashes in the title are escaped"
  );
  Assert.equal(
    markdownLink("Wiki", "https://en.wikipedia.org/wiki/Gecko_(software)"),
    "[Wiki](https://en.wikipedia.org/wiki/Gecko_%28software%29)",
    "parentheses in the address are percent-encoded"
  );
  Assert.equal(
    markdownLink("", "https://example.com/"),
    "[https://example.com/](https://example.com/)",
    "a page with no title links its address"
  );
});
