/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

add_task(function local_cause_names_each_failure() {
  const { localCause, LOCAL_CAUSE_TEXT } = SvalPanelModel;
  const plenty = 10 * 1048576;

  Assert.equal(localCause("NotAllowedError", plenty), "denied");
  Assert.equal(localCause("NotAllowedError", 0), "denied", "space is moot");
  Assert.equal(localCause("NotReadableError", 0), "disk-full");
  Assert.equal(localCause("NotReadableError", 1048575), "disk-full");
  Assert.equal(localCause("NotReadableError", 1048576), "disk");
  Assert.equal(localCause("NotReadableError", plenty), "disk");
  Assert.equal(localCause("no_such_node", plenty), null);
  Assert.equal(localCause(null, 0), null);

  Assert.deepEqual(
    Object.keys(LOCAL_CAUSE_TEXT).sort(),
    ["denied", "disk", "disk-full"],
    "each cause localCause names has a sentence"
  );
  const sentences = Object.values(LOCAL_CAUSE_TEXT);
  Assert.ok(
    sentences.every(text => typeof text === "string" && text),
    "and none is empty"
  );
  Assert.equal(new Set(sentences).size, sentences.length, "or shared");
});

/**
 * Messages spec §4: saves that fail say nothing for a minute, measured by
 * the failing pass's clock from the first failure, and a save between ends
 * the wait.
 */
add_task(function a_save_failure_is_said_after_a_minute() {
  const { SAVE_FAILING_MS, saveFailureDue } = SvalPanelModel;
  const since = 1_700_000_000_000;
  Assert.equal(SAVE_FAILING_MS, 60_000, "the wait is a minute");
  Assert.ok(!saveFailureDue(since, since), "not at the first failure");
  Assert.ok(!saveFailureDue(since, since + 59_000), "not at 59 seconds");
  Assert.ok(saveFailureDue(since, since + 60_000), "at a minute");
  Assert.ok(saveFailureDue(since, since + 65_000), "and past it");
  Assert.ok(
    !saveFailureDue(null, since + 65_000),
    "a save that succeeded leaves nothing failing"
  );
});

const NOW = 1_700_000_000_000;
const formatTime = ms => `t${ms}`;

// A healthy, shared, normal window. A task overrides what it is about.
function indicatorFor(overrides = {}) {
  return SvalPanelModel.syncIndicator({
    window: "normal",
    sharing: true,
    firstPassDone: true,
    folder: { problem: null, since: null },
    lastSynced: NOW - 5000,
    keyState: "present",
    platform: "macosx",
    unpairedDevice: false,
    critical: null,
    now: NOW,
    formatTime,
    ...overrides,
  });
}

/**
 * What an indicator is in: the rule that held, how it is drawn, and the
 * commands its buttons run. Which sentence it says is not part of it; where
 * one is drawn, `said` records that there is one.
 *
 * @param {object} got An indicator from syncIndicator.
 * @returns {object}
 */
function shape(got) {
  const { state, severity, icon, label, tooltip, detail, actions } = got;
  return {
    state,
    severity,
    icon,
    said: { label: !!label, tooltip: !!tooltip, detail: !!detail },
    commands: actions.map(action => action.command),
  };
}

const LONG_AGO = NOW - 10 * 60 * 1000;

add_task(function no_folder_draws_nothing() {
  Assert.equal(indicatorFor({ sharing: false }), null);
});

add_task(function synced() {
  const got = indicatorFor();
  Assert.deepEqual(shape(got), {
    state: "synced",
    severity: "synced",
    icon: "moon",
    said: { label: false, tooltip: true, detail: true },
    commands: [],
  });
  Assert.equal(
    got.tooltip,
    SvalPanelModel.lastSyncedText(NOW - 5000, NOW),
    "the tooltip is how long ago the last sync was"
  );
  Assert.equal(got.detail, got.tooltip);
});

add_task(function first_pass_syncs() {
  const got = indicatorFor({ firstPassDone: false });
  Assert.deepEqual(shape(got), {
    state: "syncing",
    severity: "syncing",
    icon: "moon-syncing",
    said: { label: false, tooltip: true, detail: true },
    commands: [],
  });
  Assert.equal(got.detail, got.tooltip);
});

add_task(function folder_offline() {
  const got = indicatorFor({
    folder: { problem: "offline", since: LONG_AGO },
    lastSynced: LONG_AGO,
  });
  Assert.deepEqual(shape(got), {
    state: "offline",
    severity: "offline",
    icon: "moon-offline",
    said: { label: true, tooltip: true, detail: true },
    commands: [],
  });
  Assert.stringContains(
    got.label,
    formatTime(LONG_AGO),
    "the label gives the time of the last sync"
  );
  Assert.equal(got.detail, got.tooltip);
});

add_task(function offline_before_any_sync_says_so() {
  const got = indicatorFor({
    folder: { problem: "offline", since: LONG_AGO },
    lastSynced: null,
  });
  Assert.equal(got.severity, "offline");
  Assert.equal(got.state, "offline-never-synced");
  Assert.ok(got.label, "the label says there has been no sync");
  Assert.equal(
    got.tooltip,
    indicatorFor({ folder: { problem: "offline", since: LONG_AGO } }).tooltip,
    "the tooltip is the offline one"
  );
});

add_task(function offline_waits_three_minutes() {
  const { FOLDER_UNAVAILABLE_AFTER_MS } = SvalPanelModel;
  Assert.equal(FOLDER_UNAVAILABLE_AFTER_MS, 180000);
  for (const problem of ["offline", "gone"]) {
    const before = indicatorFor({
      folder: { problem, since: NOW - 179999 },
    });
    Assert.equal(before.severity, "synced", `${problem} is not yet shown`);
    Assert.equal(
      indicatorFor({
        folder: { problem, since: NOW - 179999 },
        firstPassDone: false,
      }).severity,
      "syncing",
      `${problem} is not yet shown on the first pass`
    );
  }
  const at = indicatorFor({
    folder: { problem: "offline", since: NOW - 180000 },
    lastSynced: 42,
  });
  Assert.equal(at.severity, "offline");
  Assert.equal(at.state, "offline");
  Assert.stringContains(at.label, formatTime(42));
  Assert.equal(
    indicatorFor({ folder: { problem: "gone", since: NOW - 180000 } }).severity,
    "warning"
  );
});

add_task(function folder_gone() {
  const got = indicatorFor({ folder: { problem: "gone", since: LONG_AGO } });
  Assert.deepEqual(shape(got), {
    state: "folder-gone",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: false },
    commands: ["chooseSharedFolder"],
  });
  Assert.equal(got.tooltip, got.label, "a state with no detail tips its label");
});

add_task(function folder_denied_shows_at_once() {
  const got = indicatorFor({ folder: { problem: "denied", since: NOW } });
  Assert.deepEqual(shape(got), {
    state: "folder-denied",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: false },
    commands: ["chooseSharedFolder"],
  });
  Assert.equal(got.tooltip, got.label);
});

add_task(function unpaired_device() {
  const got = indicatorFor({ unpairedDevice: true });
  Assert.deepEqual(shape(got), {
    state: "unpaired-device",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: true },
    commands: ["pairAgain", "dismissOtherWorkspaces"],
  });
  Assert.equal(got.detail, got.tooltip);
  Assert.ok(got.dismissible);
  Assert.ok(!indicatorFor().dismissible, "only the unpaired state dismisses");
  Assert.ok(got.detailShown, "the footer shows its detail");
  Assert.ok(
    !indicatorFor({ keyState: "missing" }).detailShown,
    "and another state's stays in its tooltip"
  );
});

add_task(function newer_schema() {
  const got = indicatorFor({ newerSchema: ["iPhone"] });
  Assert.deepEqual(shape(got), {
    state: "newer-schema",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: true },
    commands: ["checkForUpdate"],
  });
  Assert.equal(got.detail, got.tooltip);
  Assert.ok(got.detail.includes("iPhone"), "the detail names the device");
  Assert.ok(got.detailShown, "the footer shows its detail");
  Assert.ok(
    !indicatorFor({ newerSchema: [null] }).detail.includes("null"),
    "a device with no name yet is described"
  );
  const several = indicatorFor({ newerSchema: ["iPhone", "Work Laptop"] });
  Assert.ok(
    several.detail.includes("iPhone") && several.detail.includes("Work Laptop"),
    "and several devices are each named"
  );
  Assert.equal(
    indicatorFor({ newerSchemaOwn: true }).state,
    "newer-schema",
    "this device's own file from a newer build warns too"
  );
});

/**
 * Decision 1714: a device whose clock set ahead cost this one something is
 * a warning naming it, never shown on a device with no time reading, whose
 * own clock may be the wrong one.
 */
add_task(function a_clock_that_cost_something_warns_with_a_reading() {
  const got = indicatorFor({
    harmedByClock: ["Work Laptop"],
    hasReading: true,
  });
  Assert.deepEqual(shape(got), {
    state: "clock-harm",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: true },
    commands: [],
  });
  Assert.ok(got.detailShown, "the footer shows its detail");
  Assert.ok(got.detail.includes("Work Laptop"), "naming the device");
  for (const names of [[null], ["A", "B"], ["A", null]]) {
    Assert.equal(
      indicatorFor({ harmedByClock: names }).state,
      "clock-harm",
      `${names.length} devices`
    );
  }
  Assert.equal(
    indicatorFor({ harmedByClock: ["Work Laptop"], hasReading: false }).state,
    "synced",
    "no warning without a reading"
  );
});

add_task(function key_access_wording_follows_the_platform() {
  const got = {};
  for (const platform of ["macosx", "linux", "win"]) {
    got[platform] = indicatorFor({ keyState: "unreadable", platform });
    Assert.deepEqual(
      shape(got[platform]),
      {
        state: "key-unreadable",
        severity: "warning",
        icon: "moon-warning",
        said: { label: true, tooltip: true, detail: true },
        commands: ["retrySyncKey"],
      },
      platform
    );
  }
  const details = Object.values(got).map(each => each.detail);
  Assert.equal(new Set(details).size, 3, "each platform has its own detail");
  Assert.equal(
    got.linux.actions[0].label,
    got.macosx.actions[0].label,
    "macOS and Linux offer the same button"
  );
  Assert.notEqual(
    got.win.actions[0].label,
    got.macosx.actions[0].label,
    "Windows, with no access to allow, offers another"
  );

  const unknown = indicatorFor({ keyState: "unreadable", platform: "freebsd" });
  Assert.equal(
    unknown.tooltip,
    got.linux.tooltip,
    "a platform with no wording of its own gets the Linux sentence"
  );
  Assert.deepEqual(
    unknown.actions,
    got.linux.actions,
    "and the button that is not Windows's"
  );
});

add_task(function folder_too_large() {
  const got = indicatorFor({ folder: { problem: "too-large", since: NOW } });
  Assert.deepEqual(shape(got), {
    state: "too-large",
    severity: "error",
    icon: "moon-error",
    said: { label: true, tooltip: true, detail: true },
    commands: ["openStorageSettings"],
  });
  Assert.equal(got.detail, got.tooltip);
});

add_task(function sync_key_gone() {
  for (const keyState of ["missing", "different"]) {
    const got = indicatorFor({ keyState });
    Assert.deepEqual(
      shape(got),
      {
        state: "key-gone",
        severity: "error",
        icon: "moon-error",
        said: { label: true, tooltip: true, detail: true },
        commands: ["pairAgain"],
      },
      keyState
    );
    Assert.equal(got.detail, got.tooltip, keyState);
  }
});

add_task(function sync_key_store_refusing_keys() {
  const got = indicatorFor({ keyState: "missing", keySealed: true });
  Assert.deepEqual(shape(got), {
    state: "key-sealed",
    severity: "error",
    icon: "moon-error",
    said: { label: true, tooltip: true, detail: true },
    commands: [],
  });
  const line = SvalPanelModel.pairingLine(
    { adopted: false, failure: "key-sealed" },
    "macosx",
    "Setup"
  );
  Assert.deepEqual(lineShape(line), {
    status: "error",
    reason: "key-sealed",
    said: true,
    command: null,
  });
  Assert.ok(
    line.text.endsWith(got.detail),
    "the line says what the indicator says"
  );
});

add_task(function windows_that_do_not_sync() {
  const details = new Set();
  for (const window of ["private", "automated"]) {
    for (const sharing of [true, false]) {
      const got = indicatorFor({ window, sharing });
      Assert.deepEqual(
        shape(got),
        {
          state: `${window}-window`,
          severity: "off",
          icon: "moon-off",
          said: { label: false, tooltip: true, detail: true },
          commands: [],
        },
        `${window}, sharing ${sharing}`
      );
      Assert.equal(got.detail, got.tooltip, `${window}, sharing ${sharing}`);
      details.add(got.detail);
    }
  }
  Assert.equal(details.size, 2, "each kind of window has its own detail");
});

/**
 * A folder chosen with no sync key yet waits for one: no pass can say
 * anything about the folder, so the indicator says what will.
 */
add_task(function a_folder_with_no_key_waits_for_one() {
  const got = indicatorFor({ keyState: "none" });
  Assert.deepEqual(shape(got), {
    state: "joining",
    severity: "warning",
    icon: "moon-warning",
    said: { label: true, tooltip: true, detail: true },
    commands: ["pairAgain"],
  });
  Assert.equal(
    indicatorFor({ keyState: "missing" }).state,
    "key-gone",
    "a key that went is not one never had"
  );
  Assert.equal(
    indicatorFor({ keyState: "none", sharing: false }),
    null,
    "and with no folder there is nothing to wait for"
  );
  Assert.equal(
    indicatorFor({ keyState: "missing" }).actions[0].label,
    got.actions[0].label,
    "both name the act that takes a code the same"
  );
});

add_task(function critical_dialog_dismissed() {
  const title = "critical dialog title";
  const got = indicatorFor({ critical: { title } });
  Assert.deepEqual(shape(got), {
    state: "critical",
    severity: "critical",
    icon: "moon-error",
    said: { label: true, tooltip: true, detail: false },
    commands: [],
  });
  Assert.equal(got.label, title, "the label is the dialog's title");
  Assert.equal(got.tooltip, title, "and so is the tooltip");
});

add_task(function the_most_severe_wins() {
  const offline = { problem: "offline", since: LONG_AGO };
  const got = indicatorFor({ keyState: "missing", folder: offline });
  Assert.equal(got.severity, "error");
  Assert.equal(got.state, "key-gone");

  Assert.equal(
    indicatorFor({
      keyState: "unreadable",
      folder: offline,
      firstPassDone: false,
    }).severity,
    "warning",
    "a warning outranks offline and syncing"
  );
  Assert.equal(
    indicatorFor({ folder: offline, firstPassDone: false }).severity,
    "offline",
    "offline outranks syncing"
  );
  Assert.equal(
    indicatorFor({ keyState: "missing", unpairedDevice: true }).severity,
    "error",
    "an error outranks a warning"
  );

  const critical = { title: "critical dialog title" };
  for (const more of [
    { keyState: "missing" },
    { folder: { problem: "too-large", since: NOW } },
    { window: "private" },
    { sharing: false },
  ]) {
    Assert.equal(
      indicatorFor({ critical, ...more }).severity,
      "critical",
      JSON.stringify(more)
    );
  }
});

/**
 * What a pairing line is in: which line it is, and the command its button
 * runs.
 *
 * @param {object} line A line from pairingLine.
 * @returns {object}
 */
function lineShape(line) {
  return {
    status: line.status,
    reason: line.reason,
    said: !!line.text,
    command: line.action?.command ?? null,
  };
}

add_task(function pairing_line_for_each_failure() {
  const { pairingLine } = SvalPanelModel;
  Assert.deepEqual(
    lineShape(pairingLine({ adopted: true }, "macosx")),
    { status: "success", reason: "joined", said: true, command: null },
    "a pairing that worked"
  );
  const failed = failure => pairingLine({ adopted: false, failure }, "linux");
  Assert.deepEqual(lineShape(failed("folder")), {
    status: "error",
    reason: "folder",
    said: true,
    command: "tryAgain",
  });
  Assert.deepEqual(lineShape(failed("no-folder")), {
    status: "error",
    reason: "no-folder",
    said: true,
    command: "chooseSharedFolder",
  });
  Assert.deepEqual(lineShape(failed("own-unreadable")), {
    status: "error",
    reason: "own-unreadable",
    said: true,
    command: "sendReport",
  });
  Assert.deepEqual(
    failed(undefined),
    failed("own-unreadable"),
    "a failure nothing named sends the report"
  );
  const texts = ["folder", "no-folder", "own-unreadable", "key-store"].map(
    failure => failed(failure).text
  );
  Assert.equal(new Set(texts).size, texts.length, "each failure has its line");

  const keyStore = {};
  for (const platform of ["macosx", "win", "linux"]) {
    keyStore[platform] = pairingLine(
      { adopted: false, failure: "key-store" },
      platform
    );
    Assert.deepEqual(
      lineShape(keyStore[platform]),
      { status: "error", reason: "key-store", said: true, command: "tryAgain" },
      platform
    );
    Assert.equal(
      keyStore[platform].action.label,
      indicatorFor({ keyState: "unreadable", platform }).actions[0].label,
      `${platform}: the button is the indicator's`
    );
  }
  Assert.equal(
    new Set(Object.values(keyStore).map(line => line.text)).size,
    3,
    "each platform names its own key store"
  );

  for (const verb of ["Setup", "Restore"]) {
    for (const failure of ["folder", "key-store"]) {
      const line = pairingLine({ adopted: false, failure }, "macosx", verb);
      Assert.equal(line.reason, failure, `${verb}, ${failure}`);
      Assert.ok(
        line.text.startsWith(verb),
        `${verb}, ${failure}: the line names what failed`
      );
    }
  }
});

add_task(function row_index_finds_a_row_or_the_split_holding_a_pane() {
  const { rowIndexIn } = SvalPanelModel;
  const drawn = [
    { id: "g" },
    { id: "s", panes: [{ id: "a" }, { id: "b" }] },
    { id: "t" },
  ];
  Assert.equal(rowIndexIn(drawn, "g"), 0);
  Assert.equal(rowIndexIn(drawn, "s"), 1, "the split's own row");
  Assert.equal(rowIndexIn(drawn, "b"), 1, "a pane is found in its split's row");
  Assert.equal(rowIndexIn(drawn, "t"), 2);
  Assert.equal(rowIndexIn(drawn, "gone"), -1);
  Assert.equal(rowIndexIn(drawn, null), -1);
});

/** A folder on this computer, an SMB folder and a Dropbox folder. */
const LOCAL_ROOT =
  "/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Sval";
const SMB_ROOT = "smb://someone@nas.local/Shared/Server";
const DROPBOX_ROOT = "dropbox:/Sval";

/**
 * The Sync page for a healthy device syncing through a folder on this
 * computer, with what a task is about overridden.
 *
 * @param {object} [indicator] Overrides of `indicatorState()`'s answer.
 * @param {object} [page] Overrides of the page's own inputs.
 * @returns {object} `syncPage`'s answer.
 */
function pageFor(indicator = {}, page = {}) {
  return SvalPanelModel.syncPage({
    indicator: {
      window: "normal",
      sharing: true,
      firstPassDone: true,
      folder: { problem: null, since: null },
      lastSynced: NOW - 5000,
      keyState: "present",
      platform: "macosx",
      unpairedDevice: false,
      critical: null,
      now: NOW,
      formatTime,
      ...indicator,
    },
    privateOnly: false,
    sharedRoot: LOCAL_ROOT,
    backupSaved: true,
    keyInProfile: false,
    working: null,
    pairing: false,
    outcome: null,
    ...page,
  });
}

/**
 * What a page shows: its state and icon, whether it says a title and a
 * detail, which controls show, and the commands its buttons run. Its words
 * are not part of it.
 *
 * @param {object} got A page from syncPage.
 * @returns {object}
 */
function pageShape(got) {
  return {
    state: got.state,
    tone: got.tone,
    said: { title: !!got.title, detail: !!got.detail },
    via: got.location?.via ?? null,
    shows: [
      "choices",
      "reveal",
      "change",
      "stop",
      "backupNote",
      "addDevice",
      "advanced",
      "keyringNote",
    ].filter(name => got[name]),
    primary: got.primary?.command ?? null,
    secondary: got.secondary.map(action => action.command),
  };
}

const ADVANCED = ["addDevice", "advanced"];
const LONG_OFFLINE = { problem: "offline", since: LONG_AGO };

add_task(function sync_page_with_no_folder_offers_the_ways_to_sync() {
  for (const got of [
    pageFor({ sharing: false }, { sharedRoot: null }),
    pageFor({}, { sharedRoot: null }),
  ]) {
    Assert.deepEqual(pageShape(got), {
      state: "no-folder",
      tone: "local",
      said: { title: true, detail: true },
      via: null,
      shows: ["choices"],
      primary: null,
      secondary: [],
    });
  }
});

add_task(function sync_page_before_sval_runs_and_while_private() {
  Assert.deepEqual(pageShape(SvalPanelModel.syncPage({ indicator: null })), {
    state: "not-ready",
    tone: "local",
    said: { title: true, detail: false },
    via: null,
    shows: [],
    primary: null,
    secondary: [],
  });
  Assert.deepEqual(pageShape(pageFor({}, { privateOnly: true })), {
    state: "private-only",
    tone: "local",
    said: { title: true, detail: false },
    via: null,
    shows: [],
    primary: null,
    secondary: [],
  });
});

add_task(function sync_page_synced() {
  const got = pageFor();
  Assert.deepEqual(pageShape(got), {
    state: "synced",
    tone: "synced",
    said: { title: true, detail: false },
    via: "folder",
    shows: ["reveal", "change", "stop", ...ADVANCED],
    primary: "syncNow",
    secondary: [],
  });
  Assert.equal(
    got.title,
    indicatorFor().tooltip,
    "the title is the footer's last-synced time"
  );
  Assert.equal(
    pageFor({ lastSynced: null }).tone,
    "waiting",
    "a folder never synced waits"
  );
  Assert.deepEqual(
    pageShape(pageFor({}, { backupSaved: false })).shows,
    ["reveal", "change", "stop", "backupNote", ...ADVANCED],
    "a key with no backup says so"
  );
  Assert.ok(
    pageFor({}, { keyInProfile: true }).keyringNote,
    "a key kept in the profile says so"
  );
});

add_task(function sync_page_first_pass_and_sync_now() {
  Assert.deepEqual(pageShape(pageFor({ firstPassDone: false })), {
    state: "syncing",
    tone: "syncing",
    said: { title: true, detail: false },
    via: "folder",
    shows: ["reveal", "change", "stop", ...ADVANCED],
    primary: null,
    secondary: [],
  });
  const running = pageFor({}, { outcome: "syncing" });
  Assert.equal(running.tone, "syncing", "a pass asked for shows as running");
  Assert.ok(running.primary.disabled, "and its button waits for it");
});

add_task(function sync_page_offline_waits_as_the_footer_does() {
  Assert.equal(
    pageFor({ folder: { problem: "offline", since: NOW - 1000 } }).state,
    "synced",
    "a blip says nothing, as the footer says nothing"
  );
  for (const [sharedRoot, via] of [
    [LOCAL_ROOT, "folder"],
    [SMB_ROOT, "smb"],
    [DROPBOX_ROOT, "dropbox"],
  ]) {
    Assert.deepEqual(
      pageShape(pageFor({ folder: LONG_OFFLINE }, { sharedRoot })),
      {
        state: "offline",
        tone: "waiting",
        said: { title: true, detail: true },
        via,
        shows: ["change", "stop", ...ADVANCED],
        primary: "syncNow",
        secondary: [],
      },
      via
    );
  }
  Assert.equal(
    pageFor({ folder: LONG_OFFLINE, lastSynced: null }).state,
    "offline-never-synced"
  );
  const titles = new Set(
    [LOCAL_ROOT, SMB_ROOT, DROPBOX_ROOT].map(
      sharedRoot => pageFor({ folder: LONG_OFFLINE }, { sharedRoot }).title
    )
  );
  Assert.equal(titles.size, 3, "each way says what it can't reach");
});

add_task(function sync_page_folder_problems() {
  Assert.deepEqual(
    pageShape(pageFor({ folder: { problem: "gone", since: LONG_AGO } })),
    {
      state: "folder-gone",
      tone: "problem",
      said: { title: true, detail: true },
      via: "folder",
      shows: ["stop", ...ADVANCED],
      primary: "chooseInUse",
      secondary: ["useFolderAgain"],
    }
  );
  Assert.deepEqual(
    pageShape(pageFor({ folder: { problem: "denied", since: NOW } })),
    {
      state: "folder-denied",
      tone: "problem",
      said: { title: true, detail: true },
      via: "folder",
      shows: ["reveal", "stop", ...ADVANCED],
      primary: "changeLocation",
      secondary: [],
    }
  );
  Assert.deepEqual(
    pageShape(pageFor({ folder: { problem: "too-large", since: NOW } })),
    {
      state: "too-large",
      tone: "problem",
      said: { title: true, detail: true },
      via: "folder",
      shows: ["reveal", "stop", ...ADVANCED],
      primary: "changeLocation",
      secondary: [],
    }
  );
});

add_task(function sync_page_sign_in_is_fixed_where_it_is_kept() {
  const signIn = { folder: { problem: "sign-in", since: NOW } };
  Assert.deepEqual(pageShape(pageFor(signIn, { sharedRoot: SMB_ROOT })), {
    state: "folder-sign-in",
    tone: "problem",
    said: { title: true, detail: true },
    via: "smb",
    shows: ["stop", ...ADVANCED],
    primary: "chooseSmb",
    secondary: [],
  });
  Assert.deepEqual(pageShape(pageFor(signIn, { sharedRoot: DROPBOX_ROOT })), {
    state: "folder-sign-in",
    tone: "problem",
    said: { title: true, detail: true },
    via: "dropbox",
    shows: ["stop", ...ADVANCED],
    primary: "chooseDropbox",
    secondary: [],
  });
});

add_task(function sync_page_remote_folders_have_no_finder() {
  for (const [sharedRoot, via] of [
    [SMB_ROOT, "smb"],
    [DROPBOX_ROOT, "dropbox"],
  ]) {
    const got = pageFor({}, { sharedRoot });
    Assert.deepEqual(
      pageShape(got).shows,
      ["change", "stop", ...ADVANCED],
      via
    );
    Assert.equal(got.location.via, via);
    Assert.ok(!got.location.place.includes("someone@"), "with no username");
  }
});

add_task(function sync_page_with_the_key_gone() {
  for (const keyState of ["missing", "different"]) {
    Assert.deepEqual(
      pageShape(pageFor({ keyState }, { backupSaved: false })),
      {
        state: "key-gone",
        tone: "problem",
        said: { title: true, detail: true },
        via: "folder",
        shows: ["reveal", "stop"],
        primary: "enterCode",
        secondary: ["restore", "startOver"],
      },
      keyState
    );
  }
  const gone = pageFor({ keyState: "missing" });
  Assert.ok(
    gone.title.includes(SvalPanelModel.computerNoun("macosx")) &&
      gone.detail.includes(gone.location.name),
    "naming the Mac and the folder"
  );
});

/**
 * A key the store refused because the profile's other secrets are sealed
 * under a system secret this build cannot open is the page's one state: no
 * code, backup or new key can be saved, so none is offered.
 */
add_task(function sync_page_with_the_key_store_refusing_keys() {
  for (const keyState of ["missing", "different"]) {
    Assert.deepEqual(
      pageShape(pageFor({ keyState, keySealed: true })),
      {
        state: "key-sealed",
        tone: "problem",
        said: { title: true, detail: true },
        via: "folder",
        shows: ["reveal", "stop"],
        primary: null,
        secondary: [],
      },
      keyState
    );
  }
  for (const platform of ["macosx", "win", "linux"]) {
    const got = pageFor({ keyState: "missing", keySealed: true, platform });
    Assert.ok(
      got.title.includes(SvalPanelModel.computerNoun(platform)),
      `${platform}: the title names the computer`
    );
  }
  Assert.equal(
    pageFor({ keyState: "present", keySealed: true }).state,
    "synced",
    "a key present is no refusal"
  );
});

add_task(function sync_page_names_the_folder_and_the_computer() {
  const synced = pageFor();
  Assert.ok(
    synced.stop.title.includes(synced.location.name),
    "stopping names the folder it stops syncing with"
  );
  for (const [platform, noun] of [
    ["macosx", "Mac"],
    ["win", "PC"],
    ["linux", "computer"],
  ]) {
    Assert.equal(SvalPanelModel.computerNoun(platform), noun, platform);
    Assert.ok(
      pageFor({ platform }).stop.body.includes(`this ${noun}`),
      `the stop dialog names this ${noun}`
    );
  }
  Assert.ok(
    pageFor({}, { sharedRoot: SMB_ROOT }).stop.body.includes("SMB"),
    "and the sign-in Sval forgets"
  );
});

add_task(function sync_page_with_the_key_store_refusing() {
  const titles = new Set();
  for (const platform of ["macosx", "win", "linux"]) {
    const got = pageFor({ keyState: "unreadable", platform });
    Assert.deepEqual(
      pageShape(got),
      {
        state: "key-unreadable",
        tone: "problem",
        said: { title: true, detail: true },
        via: "folder",
        shows: ["reveal", "stop"],
        primary: "retryKey",
        secondary: [],
      },
      platform
    );
    titles.add(got.title);
  }
  Assert.equal(titles.size, 3, "each platform names its own store");
});

add_task(function sync_page_joining() {
  Assert.deepEqual(pageShape(pageFor({ keyState: "none" })), {
    state: "joining",
    tone: "waiting",
    said: { title: true, detail: true },
    via: "folder",
    shows: ["reveal", "change", "stop"],
    primary: "enterCode",
    secondary: ["restore"],
  });
});

add_task(function sync_page_footer_warnings() {
  Assert.deepEqual(pageShape(pageFor({ unpairedDevice: true })), {
    state: "unpaired-device",
    tone: "problem",
    said: { title: true, detail: true },
    via: "folder",
    shows: ["reveal", "change", "stop", ...ADVANCED],
    primary: "enterCode",
    secondary: ["dismissOthers"],
  });
  Assert.deepEqual(pageShape(pageFor({ newerSchema: ["Laptop"] })), {
    state: "newer-schema",
    tone: "problem",
    said: { title: true, detail: true },
    via: "folder",
    shows: ["reveal", "change", "stop", ...ADVANCED],
    primary: "checkForUpdate",
    secondary: ["syncNow"],
  });
  Assert.deepEqual(pageShape(pageFor({ harmedByClock: ["Laptop"] })), {
    state: "clock-harm",
    tone: "problem",
    said: { title: true, detail: true },
    via: "folder",
    shows: ["reveal", "change", "stop", ...ADVANCED],
    primary: "syncNow",
    secondary: [],
  });
});

add_task(function sync_page_critical() {
  for (const sharedRoot of [LOCAL_ROOT, null]) {
    Assert.deepEqual(
      pageShape(pageFor({ critical: { title: "t" } }, { sharedRoot })),
      {
        state: "critical",
        tone: "problem",
        said: { title: true, detail: false },
        via: null,
        shows: [],
        primary: "showCritical",
        secondary: [],
      },
      String(sharedRoot)
    );
  }
});

add_task(function sync_page_while_a_folder_or_a_code_is_in_hand() {
  const working = pageFor({}, { working: DROPBOX_ROOT });
  Assert.ok(working.working, "choosing a folder says so");
  Assert.ok(working.locked, "and holds the folder's controls");
  Assert.ok(pageFor({}, { pairing: true }).locked, "as a live code does");
  Assert.ok(!pageFor().locked, "and nothing else does");
});

add_task(function sync_page_describes_the_profile_from_any_window() {
  Assert.equal(
    pageFor({ window: "automated" }).state,
    "synced",
    "an automated window's panel answers for the profile"
  );
});
