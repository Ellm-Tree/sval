/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

const { tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);

/**
 * The panel's collapse state is `SvalLocalSettings`' collapse state alone,
 * so an expand made through the panel's own predicate has to survive the
 * store being reopened, which is what a restart is.
 */
add_task(async function collapse_state_round_trips_through_local_settings() {
  const path = tempPath("sval-panel-collapse", ".json");
  registerCleanupFunction(async () => {
    SvalLocalSettings.forgetCachedValues();
    await IOUtils.remove(path, { ignoreAbsent: true });
  });

  const nodes = nestedDocument();
  const settings = await SvalLocalSettings.open(path);
  const draw = store =>
    SvalPanelModel.rows(nodes, {
      isCollapsed: id => store.isCollapsed(id),
      root: "ws",
    }).map(row => row.id);

  Assert.deepEqual(
    draw(settings),
    ["g-a", "g-b"],
    "spec §5.6: a device that has seen nothing draws every group collapsed"
  );

  settings.setCollapsed("g-b", false);
  await settings.flush();

  Assert.deepEqual(
    draw(settings),
    ["g-a", "g-b", "t-4"],
    "expanding the second group draws exactly its child"
  );

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.deepEqual(
    draw(reopened),
    ["g-a", "g-b", "t-4"],
    "and the same tree is drawn after a restart"
  );

  reopened.setCollapsed("g-b", true);
  await reopened.flush();
  SvalLocalSettings.forgetCachedValues();
  Assert.deepEqual(
    draw(await SvalLocalSettings.open(path)),
    ["g-a", "g-b"],
    "re-collapsing is as durable as expanding"
  );
});

/**
 * Selection decides where a new tab is filed, so it has to outlive a restart.
 * It is device-local, so it is kept here and the document never holds it
 * (spec §5.6). Each workspace has its own, because each window shows one
 * workspace and every window shares this store (spec §10.7).
 */
add_task(async function selection_is_device_local_and_persists() {
  const path = tempPath("sval-panel-selection", ".json");
  registerCleanupFunction(async () => {
    SvalLocalSettings.forgetCachedValues();
    await IOUtils.remove(path, { ignoreAbsent: true });
  });

  const settings = await SvalLocalSettings.open(path);
  Assert.equal(
    settings.selectionIn("ws-a"),
    null,
    "nothing is selected to begin with"
  );

  settings.setSelection("ws-a", "g-a");
  settings.setSelection("ws-b", "t-b");
  Assert.equal(
    settings.selectionIn("ws-a"),
    "g-a",
    "one workspace's selection is not another's"
  );
  await settings.flush();
  SvalLocalSettings.forgetCachedValues();

  const reopened = await SvalLocalSettings.open(path);
  Assert.equal(
    reopened.selectionIn("ws-a"),
    "g-a",
    "the selected node survives a restart"
  );
  Assert.equal(reopened.selectionIn("ws-b"), "t-b", "for each workspace");
  reopened.setSelection("ws-b", null);
  Assert.equal(reopened.selectionIn("ws-b"), null, "and can be cleared");

  Assert.throws(
    () => {
      settings.setSelection("ws-a", 42);
    },
    e => e.name === "TypeError",
    "a selection that is not a node id is refused rather than stored"
  );
});
