/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `sval-dialog` fits the window's modal box to itself (`fitFrame`): the
 * frame is as wide as the card and as tall, for a short card, a long one, a
 * wide one and one whose words would overflow it, nothing it holds is cut
 * off or scrolls sideways, and a card that grows or shrinks while it shows
 * takes the frame and the box with it.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);
const { askNewContainer } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalNewWorkspace.sys.mjs"
);

registerCleanupFunction(closeLeftoverDialog);

/**
 * Asserts the frame `doc` is shown in fits its card.
 *
 * @param {Document} doc
 * @param {Element} dialog The card.
 * @param {string} what
 */
async function assertFits(doc, dialog, what) {
  const frame = doc.defaultView.frameElement;
  const box = frame.closest(".dialogBox");
  const height = () => Math.ceil(dialog.getBoundingClientRect().height);
  await TestUtils.waitForCondition(
    () => height() === frame.clientHeight,
    `${what}: the frame is as tall as the card`
  );
  const width = Math.ceil(dialog.getBoundingClientRect().width);
  // `sval-dialog.css`'s width when the page sets none.
  const own =
    doc.defaultView
      .getComputedStyle(dialog)
      .getPropertyValue("--sval-dialog-width")
      .trim() || "400px";
  if (own.endsWith("px")) {
    Assert.greaterOrEqual(
      width,
      parseFloat(own),
      `${what}: the card keeps its own width`
    );
  }
  Assert.greaterOrEqual(
    frame.clientWidth,
    width,
    `${what}: the frame is as wide as the card`
  );
  Assert.lessOrEqual(
    doc.documentElement.scrollWidth,
    frame.clientWidth,
    `${what}: nothing scrolls sideways`
  );
  Assert.lessOrEqual(
    doc.documentElement.scrollHeight,
    frame.clientHeight,
    `${what}: nothing is cut off below`
  );
  Assert.equal(
    parseFloat(doc.documentElement.style.minWidth),
    width,
    `${what}: the card gave the frame its width`
  );
  const boxRect = box.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  Assert.lessOrEqual(
    boxRect.height - frameRect.height,
    2 * parseFloat(getComputedStyle(box).borderTopWidth) + 1,
    `${what}: the box holds the frame and its edge alone`
  );
  for (const el of doc.querySelectorAll("sval-dialog *")) {
    if (!el.checkVisibility()) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (
      rect.right > frame.clientWidth + 0.5 ||
      rect.bottom > frame.clientHeight + 0.5
    ) {
      Assert.ok(false, `${what}: ${el.localName} is cut off`);
    }
  }
}

add_task(async function a_short_card_fits() {
  const answer = openSvalDialog(window, { title: "Close?", primary: "Close" });
  const { doc, dialog } = await openedSvalDialog();
  await assertFits(doc, dialog, "a short card");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});

add_task(async function a_long_card_fits() {
  const answer = openSvalDialog(window, {
    title: "Move these tabs?",
    body: Array(8)
      .fill("Each tab keeps its place in its group and its history.")
      .join(" "),
    details: Array.from({ length: 6 }, (_, i) => [`Tab ${i + 1}`, "Reading"]),
    primary: "Move",
  });
  const { doc, dialog } = await openedSvalDialog();
  await assertFits(doc, dialog, "a long card");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});

add_task(async function words_too_long_for_the_card_wrap_inside_it() {
  const answer = openSvalDialog(window, {
    title: `Rename ${"Workspace".repeat(12)}?`,
    body: `https://example.com/${"a".repeat(200)}`,
    details: [["Address", `https://example.com/${"b".repeat(200)}`]],
    primary: "Rename",
  });
  const { doc, dialog } = await openedSvalDialog();
  await assertFits(doc, dialog, "unbroken words");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});

add_task(async function a_wide_card_widens_the_frame() {
  const answer = askNewContainer(window, {
    title: "New Workspace",
    submitLabel: "Create",
    tintsWindow: true,
    name: "",
    color: null,
    emoji: "",
  });
  const { doc, dialog } = await openedSvalDialog();
  Assert.greater(
    dialog.getBoundingClientRect().width,
    400,
    "the Workspace dialog is wider than the usual card"
  );
  await assertFits(doc, dialog, "a wide card");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});

add_task(async function the_frame_follows_the_card_as_it_changes() {
  let page;
  const answer = openSvalDialog(window, {
    title: "Saving…",
    primary: "OK",
    onOpen: p => (page = p),
  });
  const { doc, dialog } = await openedSvalDialog();
  await assertFits(doc, dialog, "before");
  const before = doc.defaultView.frameElement.clientHeight;
  page.update({
    body: Array(6)
      .fill("Sval keeps trying while this window is open.")
      .join(" "),
  });
  await TestUtils.waitForCondition(
    () => doc.defaultView.frameElement.clientHeight > before,
    "the frame grows with the card"
  );
  await assertFits(doc, dialog, "grown");
  page.update({ body: "" });
  await TestUtils.waitForCondition(
    () => doc.defaultView.frameElement.clientHeight === before,
    "and shrinks back with it"
  );
  await assertFits(doc, dialog, "shrunk");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});
