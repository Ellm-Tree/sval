/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's settings page as the one place Sval is configured (spec §10.8): where
 * this device keeps its workspaces, and the page itself.
 *
 * Choosing a folder from this page shares through it and loses no workspace,
 * and a folder Sval cannot reach is kept and explained, with the way back on
 * offer. Driven through the page's own button, because what can break is
 * the wiring between the page and the panel. The
 * page has no engine of its own and must not acquire one: there is one engine
 * per profile, and a second engine for one device loses data.
 *
 * The panel's half is asserted too, negatively: a storage control left behind
 * in the panel would be a second route to the same setting, and the two would
 * disagree the moment one of them was used. Where a plain open lands and the
 * panel's side are here too. "Sync now" and the last-synced line are in
 * `browser_sval_settings_sync_now.js`, the sync key in
 * `browser_sval_settings_sync_key.js`, the sync folder's harder states in
 * `browser_sval_settings_folder.js`, Sval's own folder in it in
 * `browser_sval_settings_sval_folder.js`, and Kagi's sign-in for private
 * windows in
 * `browser_sval_settings_kagi.js`; the helpers the files share are in
 * `head.js`.
 */

/* import-globals-from ../../sval-panel.js */

const MockFilePicker = SpecialPowers.MockFilePicker;
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * Picks one way to sync from the Sync card's Change… dialog, as a user with a
 * folder chosen does.
 *
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string} command `"chooseLocal"`, `"chooseSmb"` or `"chooseDropbox"`.
 */
async function changeTheWay(ui, command) {
  const dialog = ui.page.document.getElementById("sval-location-dialog");
  Assert.ok(
    BrowserTestUtils.isVisible(ui.els.storageChange),
    "the folder can be changed"
  );
  ui.els.storageChange.click();
  Assert.ok(dialog.open, "Change… asks where to sync");
  dialog.querySelector(`button[data-command="${command}"]`).click();
  Assert.ok(!dialog.open, "and closes once a way is picked");
}

add_setup(async function () {
  // The real picker cannot be driven from a test.
  MockFilePicker.init();
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/**
 * The page offers a shared folder, and choosing one publishes this device's
 * workspaces there while the profile keeps its copy (local-copy spec §4.5).
 */
add_task(async function choosing_a_folder_in_settings_publishes_there() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("choose");
  const destination = await device.folder("to");

  const ui = await openSvalSettings();
  Assert.equal(ui.state, "no-folder", "with no folder chosen");
  Assert.ok(
    BrowserTestUtils.isVisible(ui.els.storageChoose),
    "the page offers the ways to choose one"
  );
  Assert.ok(ui.els.storageStop.hidden, "and offers nothing to stop");

  MockFilePicker.useDirectory(destination);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () => ui.els.folderPath.textContent === destination,
    "the page redrew around the folder the user chose"
  );
  Assert.equal(
    device.settings.sharedFolder,
    destination,
    "the setting holds it"
  );
  Assert.equal(
    device.engine.sharedRoot,
    destination,
    "the engine shares there"
  );
  Assert.equal(
    device.engine.root,
    device.root,
    "and keeps its own copy where it was"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(destination, "sval")),
    "choosing the folder made sval/ in it"
  );
  for (const id of [device.workspace, device.tab]) {
    Assert.ok(id in (await nodes(device.engine)), `the task's ${id} is kept`);
  }
  Assert.ok(
    (await IOUtils.getChildren(PathUtils.join(destination, "sval"))).length,
    "the chosen folder received this device's document"
  );
  Assert.equal(ui.els.storageStatus.textContent, "", "with nothing to report");
  Assert.equal(ui.state, "synced", "the page says the folder syncs");
  Assert.ok(
    BrowserTestUtils.isHidden(ui.els.storageChoose) &&
      BrowserTestUtils.isVisible(ui.els.storageChange) &&
      !ui.els.storageReuse,
    "and offers to change the folder that is reached"
  );
  Assert.ok(!ui.els.storageStop.hidden, "and to stop using it");
});

/**
 * A folder Sval cannot reach yet is still the user's choice: the setting is
 * kept, nothing is lost, and the page says what will happen.
 */
add_task(async function a_folder_sval_cannot_reach_yet_is_kept_and_explained() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("not-yet");
  const missing = tempPath("sval-missing");
  const ui = await openSvalSettings();
  MockFilePicker.useDirectory(missing);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageStatus.textContent,
    "the page said something about the folder"
  );
  Assert.ok(
    ui.els.storageStatus.hasAttribute("data-unreachable"),
    "that it can't reach the folder yet"
  );
  Assert.equal(ui.els.folderPath.textContent, missing, "and names it");
  Assert.equal(device.settings.sharedFolder, missing, "the choice is kept");
  Assert.equal(SvalPanel.syncState.folderState, "unreachable");
  Assert.ok(!ui.els.storageChange.disabled, "and the folder can change again");
});

/**
 * A folder on a server is chosen from the server dialog (desktop connectors
 * spec §4): its password is kept with the sync key, the page names the folder
 * without the username, and a server that does not answer leaves the choice
 * kept and explained, as an unmounted share's is.
 */
add_task(async function a_folder_on_a_server_is_chosen_with_its_password() {
  const { SvalRemoteFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
  );
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("server");
  atTaskEnd(() => SvalRemoteFolder.keepOnly(null));
  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  byId("sval-storage-smb").click();
  Assert.ok(byId("sval-server-dialog").open, "the dialog asks");
  // Nothing listens on loopback's port 9, so the server never answers.
  byId("sval-server-host").value = "127.0.0.1:9";
  byId("sval-server-share").value = "Shared";
  byId("sval-server-folder").value = "Sval";
  byId("sval-server-user").value = "me";
  byId("sval-server-password").value = "hunter2";
  byId("sval-server-form").requestSubmit();
  const root = "smb://me@127.0.0.1:9/Shared/Sval";
  await TestUtils.waitForCondition(
    () => ui.els.storageStatus.textContent,
    "the page said something about the folder"
  );
  Assert.ok(!byId("sval-server-dialog").open, "the dialog closed");
  Assert.equal(device.settings.sharedFolder, root, "the choice is kept");
  Assert.deepEqual(
    await SvalRemoteFolder.authFor(root),
    { password: "hunter2" },
    "with its password"
  );
  Assert.equal(
    byId("sval-server-password").value,
    "",
    "which the page no longer holds"
  );
  Assert.ok(
    ui.els.storageStatus.hasAttribute("data-unreachable"),
    "the page says it can't reach the folder yet"
  );
  Assert.equal(
    ui.els.folderPath.textContent,
    "smb://127.0.0.1:9/Shared/Sval",
    "and names it without the username"
  );
  Assert.ok(
    byId("sval-folder-reveal").hidden,
    "with nothing on this computer to show"
  );
  Assert.equal(
    byId("sval-folder-field").dataset.via,
    "smb",
    "and says it syncs through an SMB server"
  );

  await changeTheWay(ui, "chooseSmb");
  Assert.equal(
    byId("sval-server-host").value,
    "127.0.0.1:9",
    "the dialog opens on the folder in use"
  );
  Assert.equal(byId("sval-server-user").value, "me");
  Assert.equal(byId("sval-server-password").value, "", "without its password");
  byId("sval-server-cancel").click();
  Assert.ok(!byId("sval-server-dialog").open, "Cancel closes it");
});

add_task(async function a_dropbox_folder_is_chosen_after_signing_in() {
  const { SvalRemoteFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
  );
  const { SvalDropbox } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDropbox.sys.mjs"
  );
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("dropbox");
  atTaskEnd(() => SvalRemoteFolder.keepOnly(null));

  // Dropbox is never reached: the sign-in gives a token, the browser lists
  // made-up folders, and every other request finds no network.
  const signIn = SvalDropbox.signIn;
  SvalDropbox.signIn = async () => "token";
  const run = SvalSharedFolder._run;
  const listed = [];
  const FOLDERS = { "dropbox:/": ["Apps", "Photos"], "dropbox:/Apps": [] };
  SvalSharedFolder._run = async request => {
    if (request.op === "listFolders") {
      listed.push(request);
      return { reachable: true, folders: FOLDERS[request.root] };
    }
    return { reachable: false, reason: "io-error", error: "NetworkError" };
  };
  atTaskEnd(() => {
    SvalDropbox.signIn = signIn;
    SvalSharedFolder._run = run;
  });

  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  const rows = () => byId("sval-dropbox-folders").querySelectorAll("button");
  byId("sval-storage-dropbox").click();
  await TestUtils.waitForCondition(
    () => rows().length === 2,
    "the Dropbox's folders are listed"
  );
  Assert.ok(byId("sval-dropbox-dialog").open, "in the folder browser");
  Assert.deepEqual(
    listed[0].auth,
    { refreshToken: "token" },
    "signed in with the new token"
  );
  Assert.ok(byId("sval-dropbox-up").disabled, "with nothing above the root");

  rows()[0].click();
  await TestUtils.waitForCondition(
    () => listed.length === 2 && !byId("sval-dropbox-use").disabled,
    "Apps is listed"
  );
  Assert.equal(listed[1].root, "dropbox:/Apps");
  Assert.equal(rows().length, 0, "and holds no folders");
  Assert.ok(!byId("sval-dropbox-up").disabled, "with a way back up");

  byId("sval-dropbox-use").click();
  Assert.ok(
    !byId("sval-storage-working").hidden,
    "the card shows it's working"
  );
  Assert.ok(byId("sval-storage-dropbox").disabled, "and holds its buttons");
  await TestUtils.waitForCondition(
    () => ui.els.storageStatus.textContent,
    "the page said something about the folder"
  );
  Assert.ok(byId("sval-storage-working").hidden, "until the panel answers");
  Assert.ok(!byId("sval-storage-dropbox").disabled);
  Assert.ok(!byId("sval-dropbox-dialog").open, "the dialog closed");
  Assert.equal(
    device.settings.sharedFolder,
    "dropbox:/Apps",
    "the choice is kept"
  );
  Assert.deepEqual(
    await SvalRemoteFolder.authFor("dropbox:/Apps"),
    { refreshToken: "token" },
    "with its sign-in"
  );
  Assert.equal(byId("sval-folder-field").dataset.via, "dropbox");
  Assert.equal(ui.els.folderPath.textContent, "Dropbox/Apps");
  Assert.ok(byId("sval-folder-reveal").hidden, "nothing to show on disk");

  SvalDropbox.signIn = async () => {
    throw new Error("a kept sign-in needs no new one");
  };
  await changeTheWay(ui, "chooseDropbox");
  await TestUtils.waitForCondition(
    () => listed.length === 3,
    "the browser opens again"
  );
  Assert.equal(listed[2].root, "dropbox:/Apps", "on the folder in use");
  byId("sval-dropbox-cancel").click();
  Assert.ok(!byId("sval-dropbox-dialog").open, "Cancel closes it");
});

/**
 * Stands in for Dropbox for one task: `signIn` replaces the sign-in, and
 * `list` answers the browser's listings. Every other helper request finds
 * no network.
 *
 * @param {object} stubs
 * @param {Function} stubs.signIn Replaces `SvalDropbox.signIn`.
 * @param {Function} [stubs.list] Answers a `listFolders` request.
 * @returns {object[]} the `listFolders` requests made.
 */
function stubDropbox({
  signIn,
  list = () => ({ reachable: true, folders: [] }),
}) {
  const { SvalDropbox } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDropbox.sys.mjs"
  );
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  const real = { signIn: SvalDropbox.signIn, run: SvalSharedFolder._run };
  const listed = [];
  SvalDropbox.signIn = signIn;
  SvalSharedFolder._run = async request => {
    if (request.op === "listFolders") {
      listed.push(request);
      return list(request);
    }
    return { reachable: false, reason: "io-error", error: "NetworkError" };
  };
  atTaskEnd(() => {
    SvalDropbox.signIn = real.signIn;
    SvalSharedFolder._run = real.run;
  });
  return listed;
}

function cancelled() {
  const err = new Error("cancelled");
  err.name = "SignInCancelled";
  return err;
}

add_task(
  async function a_failed_dropbox_sign_in_says_so_and_a_given_up_one_does_not() {
    await panelOnAFolder("dropbox-fails");
    let failure = cancelled();
    const listed = stubDropbox({
      signIn: async () => {
        throw failure;
      },
    });
    const ui = await openSvalSettings();
    const byId = id => ui.page.document.getElementById(id);
    const button = byId("sval-storage-dropbox");

    button.click();
    await TestUtils.waitForCondition(
      () => !button.disabled,
      "the sign-in ends"
    );
    Assert.ok(!byId("sval-dropbox-dialog").open, "nothing opens");
    Assert.equal(ui.els.storageStatus.textContent, "", "nor is anything said");

    failure = new Error("Dropbox refused the sign-in: 400");
    button.click();
    await TestUtils.waitForCondition(
      () => ui.els.storageStatus.textContent,
      "the page says the sign-in failed"
    );
    Assert.ok(!byId("sval-dropbox-dialog").open);
    Assert.equal(listed.length, 0, "and nothing was listed");
  }
);

add_task(async function a_token_dropbox_no_longer_takes_is_replaced() {
  await panelOnAFolder("dropbox-stale");
  const tokens = ["first", "second"];
  const listed = stubDropbox({
    signIn: async () => tokens.shift(),
    list: request =>
      request.auth.refreshToken === "first"
        ? { reachable: false, reason: "io-error", error: "SignInError" }
        : { reachable: true, folders: ["Apps"] },
  });
  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  byId("sval-storage-dropbox").click();
  await TestUtils.waitForCondition(
    () => byId("sval-dropbox-folders").querySelectorAll("button").length === 1,
    "the folders are listed after signing in again"
  );
  Assert.deepEqual(
    listed.map(request => request.auth.refreshToken),
    ["first", "second"],
    "the listing is asked again with the new token"
  );
  Assert.ok(!byId("sval-dropbox-use").disabled);
  byId("sval-dropbox-cancel").click();
});

add_task(async function an_unreachable_dropbox_holds_use_this_folder() {
  await panelOnAFolder("dropbox-offline");
  stubDropbox({
    signIn: async () => "token",
    list: () => ({
      reachable: false,
      reason: "io-error",
      error: "NetworkError",
    }),
  });
  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  byId("sval-storage-dropbox").click();
  const status = byId("sval-dropbox-status");
  await TestUtils.waitForCondition(
    () => byId("sval-dropbox-dialog").open && status.textContent,
    "the browser says it can't list"
  );
  Assert.ok(byId("sval-dropbox-use").disabled, "with no folder to use");
  Assert.equal(
    byId("sval-dropbox-folders").children.length,
    0,
    "and none listed"
  );
  byId("sval-dropbox-cancel").click();
});

add_task(async function closing_dropboxs_page_gives_up_the_sign_in() {
  const { SvalDropbox } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDropbox.sys.mjs"
  );
  const real = { open: SvalDropbox._openPage, watch: SvalDropbox._watchPage };
  let page = null;
  SvalDropbox._openPage = () => {
    page = Services.ww.openWindow(
      null,
      "about:blank",
      "_blank",
      "chrome,dialog=no",
      null
    );
    return page;
  };
  SvalDropbox._watchPage = false;
  atTaskEnd(() => {
    SvalDropbox._openPage = real.open;
    SvalDropbox._watchPage = real.watch;
  });
  const signedIn = SvalDropbox.signIn();
  await TestUtils.waitForCondition(() => page, "Dropbox's page opens");
  page.close();
  await Assert.rejects(
    within(signedIn, 10_000, "the sign-in"),
    err => err.name === "SignInCancelled"
  );
});

/**
 * This page's contract is that the panel's words come back for it to render,
 * so the user is never left with a page that says nothing after answering
 * the picker. The panel it asks is a window's whose startup failed, so it
 * has a settings store and no engine: `init` opens the store before `_start`
 * reads the identity file, which is unreadable while that window starts.
 */
add_task(async function choosing_a_folder_with_no_engine_says_so() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const before = SvalPanel.sharedRootSetting();
  const destination = await makeTempDir("sval-settings-engineless");
  const ui = await openSvalSettings();

  const identity = SvalIdentity._identityPath();
  Assert.ok(await IOUtils.exists(identity), "the profile has an identity file");
  SvalIdentity.forgetCachedValues();
  await SvalTestDeny.read(identity);
  let other;
  try {
    other = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      10_000,
      "the new window's opening"
    );
    await within(other.SvalPanel.started, 40_000, "its failed startup");
  } finally {
    await SvalTestDeny.allow(identity);
    SvalIdentity.forgetCachedValues();
  }
  expectWorkspaceTabs(other);
  try {
    Assert.strictEqual(other.SvalPanel.engine, null, "its startup failed");
    Assert.equal(
      ui.settings.panel,
      other.SvalPanel,
      "and the page asks its panel"
    );

    MockFilePicker.useDirectory(destination);
    ui.els.storageChoose.click();
    await TestUtils.waitForCondition(
      () => ui.els.storageStatus.textContent,
      "the page said something rather than nothing"
    );
    Assert.equal(
      other.SvalPanel.sharedRootSetting(),
      before,
      "and the setting is unchanged: a stored root nothing has published to " +
        "is a folder the user has been told holds their workspaces and does not"
    );
    ui.settings._drawSyncPage();
    Assert.ok(
      ui.els.storageStatus.textContent,
      "and the sentence survives the page redrawing around it"
    );
    Assert.ok(
      !ui.els.storageChoose.disabled,
      "with the button back, so a folder can be chosen once sval is running"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the failed window's close"
    );
  }
});

/**
 * `_drawSyncPage` runs on every window `focus` as well as at open, so the
 * state's detail is not a live region: announcing the whole explanation each
 * time is what the title and the status line exist to avoid. The ways to
 * choose a folder are withheld only where no window of the profile runs a
 * panel with a settings store, which the harness's own window always does.
 */
add_task(async function the_storage_section_announces_only_its_outcome() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("hidden");
  const ui = await openSvalSettings();

  Assert.ok(
    !ui.els.syncLast.hasAttribute("aria-live"),
    "the state's detail is not announced on every redraw"
  );
  Assert.equal(
    ui.els.storageStatus.getAttribute("aria-live"),
    "polite",
    "the line that reports an outcome is"
  );

  ui.settings._drawSyncPage();
  Assert.equal(ui.state, "no-folder");
  Assert.ok(
    BrowserTestUtils.isVisible(ui.els.storageChoose),
    "the ways to choose a folder are offered while a panel can"
  );
  Assert.ok(
    ui.els.syncLast.textContent && ui.els.folderField.hidden,
    "beside a state that says the workspaces are on this device only"
  );
});

/**
 * This page reaches Sval through the profile, so it works in whatever window
 * session restore puts it back in (spec §10.8). Panels start per window, and
 * every window's panel is on the profile's one engine and settings store, so
 * the page asks the most recent window's panel, which here is a second
 * window's: it says where the workspaces are, it syncs, and it chooses a
 * shared folder.
 *
 * Neither the page nor this task builds an engine, for the reason the file's
 * top comment gives.
 */
add_task(async function settings_reaches_sval_through_the_profile() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("profile");
  const destination = await device.folder("to");
  const ui = await openSvalSettings();

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the new window's opening"
  );
  expectWorkspaceTabs(other);
  try {
    await within(
      other.SvalPanel.started,
      40_000,
      "the other window's panel startup"
    );
    Assert.equal(
      other.SvalPanel.engine,
      device.engine,
      "both windows are on the profile's one engine"
    );
    Assert.equal(
      ui.settings.panel,
      other.SvalPanel,
      "the page asks the panel that is running, not the window it is in"
    );

    ui.settings._drawSyncPage();
    Assert.equal(
      ui.state,
      "no-folder",
      "it says the workspaces are on this device only"
    );
    Assert.ok(ui.els.folderField.hidden, "naming no folder");
    Assert.ok(
      BrowserTestUtils.isVisible(ui.els.storageChoose),
      "and offers the control that chooses a folder"
    );
    Assert.ok(!ui.els.syncNow, "with no pass to run");
    Assert.equal(
      ui.els.storageStatus.textContent,
      "",
      "and nothing explaining a state the user is not in"
    );

    MockFilePicker.useDirectory(destination);
    ui.els.storageChoose.click();
    await TestUtils.waitForCondition(
      () => ui.els.folderPath.textContent === destination,
      "the page redrew around the folder the user chose"
    );
    Assert.equal(
      device.settings.sharedFolder,
      destination,
      "the setting holds the folder the user chose"
    );
    Assert.equal(
      device.engine.sharedRoot,
      destination,
      "the profile's one engine shares there now"
    );
    for (const id of [device.workspace, device.tab]) {
      Assert.ok(
        id in (await nodes(device.engine)),
        `choosing from another window's page lost none of the task's nodes: ${id}`
      );
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window's close"
    );
  }
});

/**
 * A plain open names no section, so the page chooses where to land. The
 * caret must not go to pairing, the last section and the one most people
 * never use.
 *
 * The named sections are asserted in the same task, as what the plain case
 * must not have cost.
 */
add_task(async function opening_settings_plainly_lands_on_the_page() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("plain");
  const ui = await openSvalSettings();

  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.heading,
    "opening settings with no section named focuses the page itself"
  );

  // With no folder there is no code to enter, so the caret goes to the way
  // forward the state offers.
  ui.settings.focusSection("claim");
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.storageChoose,
    "and a named section still takes the caret"
  );

  ui.settings.focusSection("");
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.heading,
    "while opening settings plainly again lands on the page"
  );
});

/**
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string} name The radio group's `name`.
 * @returns {HTMLInputElement[]} the group's radios, in page order.
 */
function radios(ui, name) {
  return [...ui.page.document.querySelectorAll(`input[name="${name}"]`)];
}

/**
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string} name The radio group's `name`.
 * @returns {string|undefined} the value of the checked radio.
 */
function checkedValue(ui, name) {
  return radios(ui, name).find(radio => radio.checked)?.value;
}

/** The panel side moves the panel in every window and is kept for next time. */
add_task(async function settings_moves_the_panel() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("side");
  const was = device.settings.placement;
  const away = was === "left" ? "right" : "left";
  const placed = side =>
    TestUtils.waitForCondition(
      () =>
        device.settings.placement === side &&
        SvalPanel.container.getAttribute("sval-placement") === side,
      `the panel moves to the ${side} and the side is recorded`
    );

  let ui = await openSvalSettings();
  Assert.equal(checkedValue(ui, "sval-side"), was);

  radios(ui, "sval-side")
    .find(radio => radio.value === away)
    .click();
  await placed(away);

  await closeSvalSettings(ui);
  ui = await openSvalSettings();
  Assert.equal(checkedValue(ui, "sval-side"), away, "kept for next time");

  radios(ui, "sval-side")
    .find(radio => radio.value === was)
    .click();
  await placed(was);
});

/**
 * At both storage states, because a storage control could change its label
 * with the state: a check at one state only would pass against a panel that
 * still offered the other.
 */
add_task(async function the_panel_offers_no_storage_control() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("panel");
  const shared = await device.folder("shared");

  const states = [
    ["a shared folder", shared],
    ["the default", null],
  ];
  for (const [state, root] of states) {
    await SvalPanel.chooseSharedFolder(root);
    Assert.equal(SvalPanel.sharedRootSetting(), root, `${state} is chosen`);
    Assert.equal(
      SvalPanel.container.querySelector('[data-command="chooseFolder"]'),
      null,
      `no folder button in the panel with ${state} configured`
    );
  }
});
