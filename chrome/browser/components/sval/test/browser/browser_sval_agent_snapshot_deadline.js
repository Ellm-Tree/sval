/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A snapshot stops at its deadline as well as at its count of elements, so a
 * page that is slow to read cannot hold an agent's call. No page a test can
 * build is reliably slow, so the outline is taken in the page's own process
 * with its deadline already past.
 */
add_task(async function a_snapshot_stops_at_its_deadline() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the page's tab"
  );
  const outlines = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { RefTable, snapshotOf } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalAgentSnapshot.sys.mjs"
    );
    const doc = content.document;
    for (let i = 0; i < 500; i++) {
      const p = doc.createElement("p");
      p.textContent = `Line ${i}`;
      doc.body.append(p);
    }
    const whole = snapshotOf(doc, new RefTable());
    const late = snapshotOf(doc, new RefTable(), { maxMs: -1 });
    return {
      whole: { truncated: whole.truncated, lines: whole.text.split("\n") },
      late: { truncated: late.truncated, lines: late.text.split("\n") },
    };
  });
  Assert.ok(!outlines.whole.truncated, "in time, the page is read whole");
  Assert.ok(
    outlines.whole.lines.some(line => line.includes("Line 499")),
    "to its last line"
  );
  Assert.ok(outlines.late.truncated, "past the deadline, it is cut short");
  Assert.less(
    outlines.late.lines.length,
    outlines.whole.lines.length,
    "and holds less of the page"
  );
});
