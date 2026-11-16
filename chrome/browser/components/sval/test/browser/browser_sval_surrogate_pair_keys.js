/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A character outside the Basic Multilingual Plane, typed into a page, reaches
 * it as well-formed UTF-16. `EventUtils.synthesizeKey` dispatches through
 * `TextEventDispatcher`, as the platforms' native key handling does, and it
 * sends a keypress for each UTF-16 unit of the key's value.
 */

const FIELD_PAGE =
  "data:text/html,<!DOCTYPE html><meta charset=utf-8><textarea></textarea>";

add_task(async function a_surrogate_pair_reaches_the_page_well_formed() {
  const tab = await openPage(FIELD_PAGE);
  const browser = tab.linkedBrowser;
  // The listeners keep what they see on the field, where a later spawn's
  // sandbox can read it.
  await SpecialPowers.spawn(browser, [], () => {
    const field = content.document.querySelector("textarea");
    const record = (name, value) => {
      const list = JSON.parse(field.dataset[name] ?? "[]");
      list.push(value);
      field.dataset[name] = JSON.stringify(list);
    };
    field.addEventListener("keypress", e => record("keys", e.key));
    field.addEventListener("input", e => record("data", e.data));
    field.focus();
  });
  await within(
    SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          content.document.activeElement ===
          content.document.querySelector("textarea"),
        "the field has focus"
      )
    ),
    5_000,
    "the field taking focus"
  );

  const typed = "\u{1F600}";
  EventUtils.synthesizeKey(typed, {}, window);

  const { keys, data, value } = await within(
    SpecialPowers.spawn(browser, [typed], async text => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector("textarea").value === text,
        "the field holds the character"
      );
      const field = content.document.querySelector("textarea");
      return {
        keys: JSON.parse(field.dataset.keys ?? "[]"),
        data: JSON.parse(field.dataset.data ?? "[]"),
        value: field.value,
      };
    }),
    5_000,
    "the character reaching the field"
  );

  Assert.equal(value, typed, "the field holds the whole character");
  Assert.ok(keys.length, "the page saw a keypress");
  for (const key of keys) {
    Assert.ok(key.isWellFormed(), `keypress key ${escape(key)} is well-formed`);
  }
  Assert.ok(keys.includes(typed), "a keypress carries the whole character");
  for (const d of data) {
    Assert.ok(d?.isWellFormed(), `input data ${escape(d)} is well-formed`);
  }
});
