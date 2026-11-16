/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* `SvalPanel` is a global of the chrome window, declared by a classic script
 * the window loads. */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The tab on screen's name stays readable on its row in the panel, in every
 * theme and workspace colour, loose or in a coloured group.
 */

/**
 * Four real tabs in the window's workspace, two loose and two in an orange
 * group, each loaded here as the tab on screen always is.
 *
 * @returns {Promise<object>} `{ engine, workspace, tabs, ids }`, where `ids`
 *   holds each tab's node id by name.
 */
async function fourTabs() {
  const engine = SvalPanel.engine;
  const workspace = SvalPanel.workspaceId;
  const names = ["looseA", "looseB", "groupedA", "groupedB"];
  const tabs = {};
  for (const name of names) {
    tabs[name] = await within(
      BrowserTestUtils.openNewForegroundTab(
        gBrowser,
        `https://example.com/${name}`
      ),
      15_000,
      "a tab opening and loading"
    );
  }
  registerCleanupFunction(() => {
    for (const tab of Object.values(tabs)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const ids = {};
  for (const name of names) {
    ids[name] = SvalPanel.observer.nodeIdFor(tabs[name]);
  }
  const now = Date.now();
  const group = await engine.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Orange",
    id: crypto.randomUUID(),
    now,
  });
  registerCleanupFunction(() =>
    engine.mutate({ kind: "remove", id: group, now: Date.now() })
  );
  await setColor(group, "orange");
  for (const id of [ids.groupedA, ids.groupedB]) {
    await engine.mutate({
      kind: "moveNode",
      id,
      newParent: group,
      before: null,
      after: null,
      now,
    });
  }
  SvalPanel.settings.setCollapsed(group, false);
  await SvalPanel.refresh();
  return { engine, workspace, tabs, ids };
}

/**
 * @param {string} id A workspace or group.
 * @param {string|null} color A colour token, or none.
 * @returns {Promise<void>}
 */
function setColor(id, color) {
  return SvalPanel.engine.mutate({
    kind: "setAppearance",
    id,
    color,
    emoji: null,
    now: Date.now(),
  });
}

/**
 * @param {string} id A node id.
 * @returns {Element} its row.
 */
function row(id) {
  return SvalPanel._rowElementFor(id);
}

/**
 * Shows a tab, as clicking it in the panel does, and waits for its row to
 * say so.
 *
 * @param {MozTabbrowserTab} tab
 * @param {string} id Its node id.
 */
async function show(tab, id) {
  await selectTab(tab);
  await TestUtils.waitForCondition(
    () => row(id)?.getAttribute("aria-selected") === "true",
    "the tab's row is selected"
  );
}

/**
 * @param {string} id A tab's node id.
 * @returns {{r: number, g: number, b: number}} what its name is drawn on.
 */
function fill(id) {
  return drawnBehind(row(id).querySelector(".sval-row-name"));
}

/**
 * @param {string} id A tab's node id.
 * @returns {number} its name's contrast ratio on its row.
 */
function nameContrast(id) {
  const name = row(id).querySelector(".sval-row-name");
  const behind = fill(id);
  const ink = paintedOver(rgbaOf(getComputedStyle(name).color), behind);
  return contrastRatio(ink, behind);
}

/**
 * Hovers `id`'s row, or with no id moves the pointer into the page.
 *
 * @param {string} [id]
 */
async function pointAt(id) {
  const target = id ? row(id) : gBrowser.selectedBrowser;
  EventUtils.synthesizeMouseAtCenter(target, { type: "mousemove" });
  await TestUtils.waitForCondition(
    () =>
      id ? row(id).matches(":hover") : !SvalPanel._els.tree.matches(":hover"),
    id ? "the row is hovered" : "the pointer is off the panel"
  );
}

/**
 * The selected tab's name reads at AA contrast or better on its row (WCAG
 * 1.4.3), in the light and dark themes, untinted and in workspace colours,
 * loose and in a coloured group, and while it is hovered.
 */
add_task(async function the_selected_tabs_name_is_readable() {
  const { workspace, tabs, ids } = await fourTabs();
  const failing = [];
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    await TestUtils.waitForCondition(
      () => matchMedia("(prefers-color-scheme: dark)").matches === !!dark,
      "the theme changes"
    );
    for (const tint of [null, "blue", "yellow", "red"]) {
      await setColor(workspace, tint);
      await SvalPanel.refresh();
      for (const name of ["looseA", "groupedA"]) {
        const where = `${name}, ${tint ?? "no tint"}, ${dark ? "dark" : "light"}`;
        const id = ids[name];
        await pointAt();
        await show(tabs[name], id);
        if (nameContrast(id) < 4.5) {
          failing.push(`${where}: ${nameContrast(id).toFixed(2)}:1`);
        }
        await pointAt(id);
        if (nameContrast(id) < 4.5) {
          failing.push(`${where}: hovered, ${nameContrast(id).toFixed(2)}:1`);
        }
      }
    }
    await pointAt();
    await SpecialPowers.popPrefEnv();
  }
  await setColor(workspace, null);
  Assert.deepEqual(failing, [], "the selection is readable");
});
