/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

// The default storage root is inside the profile directory, and `ProfD` does
// not resolve in xpcshell until a profile is registered: without this,
// `PathUtils.profileDir` throws.
do_get_profile();

/**
 * A fresh temp path per task, so one task's file can never leak into
 * another's.
 *
 * @param {string} name Distinguishes this task's file from the others'.
 * @returns {string}
 */
function settingsFile(name) {
  return tempPath(`sval-local-settings-${name}`, ".json");
}

registerCleanupFunction(() => {
  SvalLocalSettings.forgetCachedValues();
});

/**
 * Spec §5.6: a device syncing for the first time starts with every group
 * collapsed, so a large tree arrives legible. That only holds if an id this
 * store has never seen reads as collapsed, and an explicit expand survives a
 * reload.
 */
add_task(async function collapse_state_is_per_device_and_defaults_closed() {
  const path = settingsFile("defaults");
  const settings = await SvalLocalSettings.open(path);
  Assert.ok(
    settings.isCollapsed("any-unseen-id"),
    "unknown groups default to collapsed"
  );

  settings.setCollapsed("g1", false);
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(!reopened.isCollapsed("g1"), "an explicit expand persists");
  Assert.ok(
    reopened.isCollapsed("g2"),
    "a group never expanded is still collapsed after reload"
  );

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * A burst of changes, such as switching tabs quickly, reaches the file in one
 * write that holds all of them.
 */
add_task(async function changes_made_together_are_written_once() {
  const path = settingsFile("save-soon");
  const settings = await SvalLocalSettings.open(path);

  settings.setSelection("ws", "t1");
  settings.saveSoon();
  settings.setLastActive("t1", 1000);
  settings.saveSoon();
  settings.setCollapsed("g1", false);
  settings.saveSoon();
  Assert.ok(!(await IOUtils.exists(path)), "nothing is written at once");

  await within(
    waitForCondition(() => IOUtils.exists(path), "the file appears"),
    10_000,
    "the settings file being written"
  );
  const saved = await IOUtils.readJSON(path);
  Assert.deepEqual(
    saved.selections,
    { ws: "t1" },
    "the write holds the selection"
  );
  Assert.equal(saved.lastActive.t1, 1000, "and when the tab was looked at");
  Assert.deepEqual(saved.expanded, ["g1"], "and the open group");

  await IOUtils.remove(path);
  await settings.flushPending();
  Assert.ok(
    !(await IOUtils.exists(path)),
    "and the burst left nothing to write again"
  );
});

/**
 * A step that must survive a crash writes at once, and that write carries
 * whatever was waiting to be written beside it.
 */
add_task(async function a_flush_writes_what_was_waiting() {
  const path = settingsFile("flush-now");
  const settings = await SvalLocalSettings.open(path);

  settings.setCollapsed("g1", false);
  settings.saveSoon();
  settings.markFirstRunDone();
  await settings.flush();

  const saved = await IOUtils.readJSON(path);
  Assert.ok(saved.firstRunDone, "the step is on disk when flush returns");
  Assert.deepEqual(saved.expanded, ["g1"], "with the change made before it");

  await IOUtils.remove(path);
  await settings.flushPending();
  Assert.ok(!(await IOUtils.exists(path)), "and nothing was left waiting");
});

/**
 * Re-collapsing an id must be as durable as expanding it, and must not
 * resurrect once the collapse is written.
 */
add_task(async function re_collapsing_an_expanded_id_persists_too() {
  const path = settingsFile("recollapse");
  const settings = await SvalLocalSettings.open(path);
  settings.setCollapsed("g1", false);
  settings.setCollapsed("g1", true);
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(reopened.isCollapsed("g1"), "the later collapse wins");

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * The agent tabs the user has taken control of are kept by node id, so a
 * take outlives the tab's browser: a discard, an undo of a close, a restart
 * (agent-control spec §6). Only node ids are kept.
 */
add_task(async function a_take_is_kept_by_node_and_survives_a_reload() {
  const path = settingsFile("held");
  const settings = await SvalLocalSettings.open(path);
  Assert.ok(!settings.isUserHeld("t1"), "nothing is held at first");
  settings.setUserHeld("t1", true);
  settings.setUserHeld("t2", true);
  settings.setUserHeld("t2", false);
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(reopened.isUserHeld("t1"), "a take persists");
  Assert.ok(!reopened.isUserHeld("t2"), "and so does a give-back");
  Assert.deepEqual(reopened.userHeldIds(), ["t1"], "and lists what is held");

  await IOUtils.writeJSON(path, { userHeld: ["t3", 4, null] });
  SvalLocalSettings.forgetCachedValues();
  const damaged = await SvalLocalSettings.open(path);
  Assert.ok(damaged.isUserHeld("t3"), "a string id loads");
  Assert.ok(!damaged.isUserHeld("4"), "anything else is dropped");

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * The pin looked at last in each workspace survives a restart, since a pin's
 * page is in no session Firefox keeps and a launch lands on it from this
 * alone (pins spec §5).
 */
add_task(async function the_last_pin_of_each_workspace_survives_a_reload() {
  const path = settingsFile("last-pin");
  const settings = await SvalLocalSettings.open(path);
  Assert.equal(settings.lastPin("w1"), null, "no pin at first");
  settings.setLastPin("w1", "g1", 1000);
  settings.setLastPin("w1", "g2", 2000);
  settings.setLastPin("w2", "g3", 3000);
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.deepEqual(
    reopened.lastPin("w1"),
    { guid: "g2", when: 2000 },
    "the later pin of a workspace persists"
  );
  Assert.deepEqual(
    reopened.lastPin("w2"),
    { guid: "g3", when: 3000 },
    "each workspace keeps its own"
  );

  await IOUtils.writeJSON(path, {
    lastPins: { w1: { guid: "g1", when: 5 }, w2: { guid: 4, when: 5 } },
  });
  SvalLocalSettings.forgetCachedValues();
  const damaged = await SvalLocalSettings.open(path);
  Assert.deepEqual(damaged.lastPin("w1"), { guid: "g1", when: 5 }, "loads");
  Assert.equal(damaged.lastPin("w2"), null, "a malformed entry is dropped");

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * A Stop is kept by workspace node id with the takes, so it holds across a
 * restart until the user presses Resume (agent-control spec §6).
 */
add_task(async function a_stop_is_kept_by_node_and_survives_a_reload() {
  const path = settingsFile("stopped");
  const settings = await SvalLocalSettings.open(path);
  Assert.ok(!settings.isAgentStopped("w1"), "nothing is stopped at first");
  settings.setAgentStopped("w1", true);
  settings.setAgentStopped("w2", true);
  settings.setAgentStopped("w2", false);
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(reopened.isAgentStopped("w1"), "a Stop persists");
  Assert.ok(!reopened.isAgentStopped("w2"), "and so does a Resume");
  Assert.deepEqual(reopened.agentStoppedIds(), ["w1"]);
  Assert.ok(
    reopened.forgetAgentTabsOtherThan(new Set()),
    "the Stop of a workspace that is gone is dropped"
  );
  Assert.ok(!reopened.isAgentStopped("w1"));

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/** Takes and user-history marks of tabs that are gone can be dropped. */
add_task(async function takes_of_gone_tabs_are_dropped() {
  const path = settingsFile("prune");
  const settings = await SvalLocalSettings.open(path);
  settings.setUserHeld("live", true);
  settings.setUserHeld("gone", true);
  settings.setUserHistory("live", true);
  settings.setUserHistory("gone-too", true);
  Assert.ok(
    !settings.forgetAgentTabsOtherThan(new Set(["live", "gone", "gone-too"])),
    "nothing is dropped while every id is kept"
  );
  Assert.ok(settings.forgetAgentTabsOtherThan(new Set(["live"])));
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(reopened.isUserHeld("live"), "a kept take stays");
  Assert.ok(reopened.hasUserHistory("live"), "and so does its mark");
  Assert.ok(!reopened.isUserHeld("gone"), "a gone tab's take is dropped");
  Assert.ok(!reopened.hasUserHistory("gone-too"), "and its mark");

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * Placement and the storage root are plain per-device settings; both must
 * round-trip through a flush and reload exactly as written.
 */
add_task(async function placement_and_storage_root_round_trip() {
  const path = settingsFile("roundtrip");
  const settings = await SvalLocalSettings.open(path);
  Assert.equal(settings.placement, "left", "left is the default placement");
  // Spec §6.4: there is one storage location and it has a default. A profile
  // that has configured nothing keeps its workspaces in its own directory, so
  // they persist from the first launch with nothing asked.
  Assert.equal(
    SvalLocalSettings.localRoot(),
    PathUtils.profileDir,
    "this device's own location is the profile directory"
  );
  Assert.equal(
    settings.sharedFolder,
    null,
    "and no shared folder is chosen, which is what lets the panel offer one"
  );

  settings.placement = "right";
  settings.sharedFolder = "/Users/example/sval-workspace";
  await settings.flush();

  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.equal(reopened.placement, "right", "placement persists");
  Assert.equal(
    reopened.sharedFolder,
    "/Users/example/sval-workspace",
    "the shared folder persists"
  );
  Assert.notEqual(
    reopened.sharedFolder,
    null,
    "and is no longer the default once the user has chosen one"
  );

  // The chosen path is what was written. A profile that has chosen nothing
  // must follow its own directory if the profile is ever moved, which baking
  // the resolved default into the file would defeat.
  const stored = await IOUtils.readJSON(path);
  Assert.equal(
    stored.sharedFolder,
    "/Users/example/sval-workspace",
    "the file holds the chosen path"
  );

  Assert.throws(
    () => (reopened.placement = "up"),
    e => e.name === "RangeError",
    "an invalid placement is rejected"
  );

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * The panel's width is this device's: the stylesheet's own until the user
 * drags the panel's edge, then that width, through a flush and reload.
 */
add_task(async function panel_width_round_trips() {
  const path = settingsFile("panel-width");
  const settings = await SvalLocalSettings.open(path);
  Assert.equal(settings.panelWidth, null, "no width until one is chosen");

  settings.panelWidth = 320;
  await settings.flush();
  SvalLocalSettings.forgetCachedValues();
  let reopened = await SvalLocalSettings.open(path);
  Assert.equal(reopened.panelWidth, 320, "the width persists");

  reopened.panelWidth = null;
  await reopened.flush();
  SvalLocalSettings.forgetCachedValues();
  reopened = await SvalLocalSettings.open(path);
  Assert.equal(reopened.panelWidth, null, "and so does going back to none");

  for (const bad of [0, -5, NaN, "320"]) {
    Assert.throws(
      () => (reopened.panelWidth = bad),
      e => e.name === "RangeError",
      `${JSON.stringify(bad)} is rejected`
    );
  }
  await IOUtils.writeJSON(path, { panelWidth: "wide" });
  SvalLocalSettings.forgetCachedValues();
  reopened = await SvalLocalSettings.open(path);
  Assert.equal(reopened.panelWidth, null, "a stored non-number reads as none");

  await IOUtils.remove(path, { ignoreAbsent: true });
});

/**
 * Unlike the identity file, these are preferences: a damaged file must not
 * block startup. It falls back to defaults (collapsed, "left", the profile
 * directory), and the damaged bytes are moved aside as `<name>.corrupt`,
 * where no flush can overwrite them.
 */
add_task(async function a_damaged_settings_file_falls_back_to_defaults() {
  // In a directory of its own, so the copy moved aside goes with it.
  const path = PathUtils.join(
    await makeTempDir("sval-local-settings-damaged"),
    "sval-local-settings.json"
  );
  await IOUtils.writeUTF8(path, "{ this is not json");
  const before = await IOUtils.read(path);

  const settings = await SvalLocalSettings.open(path);
  Assert.equal(
    settings.placement,
    "left",
    "placement falls back to the default"
  );
  Assert.equal(
    settings.sharedFolder,
    null,
    "no shared folder is read from it, so the workspaces are found in the profile"
  );
  Assert.ok(
    settings.isCollapsed("g1"),
    "collapse state falls back to fully collapsed"
  );

  const name = PathUtils.filename(path);
  const aside = (await IOUtils.getChildren(PathUtils.parent(path))).filter(
    child =>
      PathUtils.filename(child).startsWith(name) && child.endsWith(".corrupt")
  );
  Assert.equal(aside.length, 1, "the damaged file was moved aside");
  Assert.equal(
    (await IOUtils.read(aside[0])).join(","),
    before.join(","),
    "exactly as it was"
  );

  await settings.flush();
  const readable = await IOUtils.readJSON(path);
  Assert.equal(
    readable.placement,
    "left",
    "flushing after a damaged read writes valid JSON in its place"
  );
  Assert.ok(await IOUtils.exists(aside[0]), "and leaves the damaged copy");

  await IOUtils.remove(path, { ignoreAbsent: true });
  await IOUtils.remove(aside[0]);
});

/**
 * Two overlapping `open()` calls for the same path must share one store.
 * Each reading the file, mutating independently and writing would let
 * whichever wrote last discard the other's change.
 */
add_task(
  async function concurrent_opens_share_one_store_and_do_not_lose_writes() {
    const path = settingsFile("concurrent");

    const [first, second] = await Promise.all([
      SvalLocalSettings.open(path),
      SvalLocalSettings.open(path),
    ]);
    Assert.equal(
      first,
      second,
      "both callers received the same store instance"
    );

    first.setCollapsed("g1", false);
    second.setCollapsed("g2", false);
    await first.flush();

    SvalLocalSettings.forgetCachedValues();
    const reopened = await SvalLocalSettings.open(path);
    Assert.ok(
      !reopened.isCollapsed("g1"),
      "the first caller's change survived"
    );
    Assert.ok(
      !reopened.isCollapsed("g2"),
      "the second caller's change survived too"
    );

    await IOUtils.remove(path, { ignoreAbsent: true });
  }
);

add_task(async function seeded_settings_persist() {
  const path = settingsFile("settings-seeded");
  const store = await SvalLocalSettings.open(path);
  Assert.ok(
    !store.isSettingSeeded("a.pref"),
    "a new profile has seeded nothing"
  );
  store.markSettingsSeeded(["a.pref"]);
  await store.flush();
  SvalLocalSettings.forgetCachedValues();
  const reopened = await SvalLocalSettings.open(path);
  Assert.ok(reopened.isSettingSeeded("a.pref"), "the key is read back");
  Assert.ok(!reopened.isSettingSeeded("b.pref"), "and no other");
  await IOUtils.remove(path, { ignoreAbsent: true });
});
/**
 * First run's two records survive a restart: that it began, and that it
 * ended. Only `true` in the file counts as either.
 */
add_task(async function first_run_done_persists() {
  const path = settingsFile("first-run-done");
  const store = await SvalLocalSettings.open(path);
  Assert.strictEqual(store.firstRunDone, false, "a new profile has not run it");
  Assert.strictEqual(store.firstRunStarted, false, "nor begun it");
  store.markFirstRunStarted();
  await store.flush();
  SvalLocalSettings.forgetCachedValues();
  const begun = await SvalLocalSettings.open(path);
  Assert.strictEqual(begun.firstRunStarted, true, "the start is read back");
  Assert.strictEqual(begun.firstRunDone, false, "and is not completion");
  begun.markFirstRunDone();
  await begun.flush();
  SvalLocalSettings.forgetCachedValues();
  Assert.strictEqual(
    (await SvalLocalSettings.open(path)).firstRunDone,
    true,
    "completion is read back"
  );

  for (const value of ["yes", 1, null, {}]) {
    await IOUtils.writeJSON(path, {
      firstRunDone: value,
      firstRunStarted: value,
    });
    SvalLocalSettings.forgetCachedValues();
    const store2 = await SvalLocalSettings.open(path);
    Assert.strictEqual(
      store2.firstRunDone,
      false,
      `${JSON.stringify(value)} loads as not done`
    );
    Assert.strictEqual(
      store2.firstRunStarted,
      false,
      `${JSON.stringify(value)} loads as not begun`
    );
  }
  await IOUtils.remove(path, { ignoreAbsent: true });
});

/** A seeded list that is not a list seeds nothing, and only keys count. */
add_task(async function only_keys_in_the_seeded_list_are_seeded() {
  for (const stored of [{ seededSettings: "a.pref" }]) {
    const path = settingsFile("old-seeded");
    await IOUtils.writeJSON(path, stored);
    SvalLocalSettings.forgetCachedValues();
    const store = await SvalLocalSettings.open(path);
    Assert.ok(
      !store.isSettingSeeded("a.pref"),
      `${JSON.stringify(stored)} has not seeded a.pref`
    );
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
  const path = settingsFile("mixed-seeded");
  await IOUtils.writeJSON(path, { seededSettings: [1, null, "b.pref"] });
  SvalLocalSettings.forgetCachedValues();
  Assert.ok(
    (await SvalLocalSettings.open(path)).isSettingSeeded("b.pref"),
    "a key among malformed entries is still read"
  );
  await IOUtils.remove(path, { ignoreAbsent: true });
});
