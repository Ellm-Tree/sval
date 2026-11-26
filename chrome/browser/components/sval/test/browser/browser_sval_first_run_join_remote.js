/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A joining device's first run names the other device's folder on an SMB
 * server or in Dropbox, as Settings › Sync and devices does: the SMB panel
 * keeps the password and uses the server's folder, and the Dropbox panel
 * signs in, browses the Dropbox and keeps the sign-in for the folder used.
 * Escape closes a panel and gives focus back to the button that opened it.
 *
 * Nothing reaches a server: Dropbox's sign-in and listings are stubbed, and
 * so is the panel's `chooseSharedFolder`, which would reach the folder.
 */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);

const { SvalRemoteFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
);
const { SignInCancelled, SvalDropbox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDropbox.sys.mjs"
);

/** The folders the stubbed Dropbox holds, by `/`-separated folder. */
const DROPBOX_FOLDERS = {
  "": ["Apps", "Work"],
  Work: ["Sval"],
  "Work/Sval": [],
};

/**
 * Stubs what reaches a server, for the rest of the file.
 *
 * @returns {{used: string[], signIn: object}} the folders the step used, and
 *   what the next Dropbox sign-in does: `{ token }` or `{ cancel: true }`.
 */
function stubServers() {
  const used = [];
  const signIn = { token: "token-1" };
  const real = {
    chooseSharedFolder: SvalPanel.chooseSharedFolder,
    signIn: SvalDropbox.signIn,
    listFolders: SvalSharedFolder.listFolders,
  };
  SvalPanel.chooseSharedFolder = async path => {
    used.push(path);
    return { reached: true };
  };
  SvalDropbox.signIn = async () => {
    if (signIn.cancel) {
      throw new SignInCancelled();
    }
    return signIn.token;
  };
  SvalSharedFolder.listFolders = async ({ root, auth }) => {
    Assert.equal(auth.refreshToken, signIn.token, "listed as signed in");
    const { folder } = SvalRemoteFolder.parseDropboxRoot(root);
    return { reachable: true, folders: DROPBOX_FOLDERS[folder] ?? [] };
  };
  registerCleanupFunction(async () => {
    SvalPanel.chooseSharedFolder = real.chooseSharedFolder;
    SvalDropbox.signIn = real.signIn;
    SvalSharedFolder.listFolders = real.listFolders;
    await SvalRemoteFolder.keepOnly(null);
  });
  return { used, signIn };
}

/**
 * @param {Element} section The folder step.
 * @returns {string[]} the folders the Dropbox panel lists.
 */
function listed(section) {
  return [...section.querySelectorAll(".sval-fr-dropbox-folder")].map(
    row => row.dataset.name
  );
}

add_task(async function a_join_names_an_smb_or_dropbox_folder() {
  keepFirstRunPrefs();
  const { used, signIn } = stubServers();

  const doc = await firstRunShown();
  await choosePath(doc, "join", STEPS.joinFolder);
  const section = shownSection(doc);
  const smbButton = section.querySelector(".sval-fr-connect-smb");
  const dropboxButton = section.querySelector(".sval-fr-connect-dropbox");
  const smb = section.querySelector(".sval-fr-smb");
  const dropbox = section.querySelector(".sval-fr-dropbox");
  for (const way of [
    section.querySelector(".sval-fr-choose-folder"),
    smbButton,
    dropboxButton,
  ]) {
    Assert.ok(!way.hidden && !way.disabled, `${way.className} is offered`);
  }
  Assert.ok(smb.hidden && dropbox.hidden, "no panel is open");

  // The SMB server.
  smbButton.click();
  Assert.equal(section.dataset.connecting, "smb", "the SMB panel opens");
  Assert.ok(!smb.hidden, "and shows");
  const field = name => smb.querySelector(`input[name="${name}"]`);
  Assert.equal(doc.activeElement, field("host"), "focus is on the server");
  field("host").value = "nas.local";
  field("share").value = "Shared";
  field("folder").value = "Sval";
  field("user").value = "me";
  field("password").value = "secret";
  smb.querySelector(".sval-fr-smb-connect").click();
  const smbRoot = SvalRemoteFolder.smbRoot({
    server: "nas.local",
    share: "Shared",
    folder: "Sval",
    username: "me",
  });
  await TestUtils.waitForCondition(
    () => used.includes(smbRoot) && !button(doc, "continue").disabled,
    "the SMB folder is used"
  );
  Assert.ok(smb.hidden, "the SMB panel closes");
  Assert.ok(!section.dataset.connecting, "and the folder zone is back");
  Assert.equal(doc.activeElement, smbButton, "focus goes back to its button");
  Assert.deepEqual(
    await SvalRemoteFolder.authFor(smbRoot),
    { password: "secret" },
    "the password is kept for the folder"
  );

  // The SMB panel opens on the folder in use, and Escape is its Cancel.
  smbButton.click();
  Assert.equal(field("host").value, "nas.local", "the server is filled in");
  Assert.equal(field("password").value, "", "the password is not");
  Assert.equal(doc.activeElement, field("password"), "and takes focus");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.ok(smb.hidden, "Escape closes the panel");
  Assert.equal(shownStep(doc), STEPS.joinFolder, "and keeps the step");
  Assert.equal(doc.activeElement, smbButton, "focus goes back to its button");

  // A Dropbox sign-in the user gives up opens nothing and says nothing.
  signIn.cancel = true;
  dropboxButton.click();
  await TestUtils.waitForCondition(
    () => !dropboxButton.disabled,
    "the sign-in ends"
  );
  Assert.ok(dropbox.hidden, "a cancelled sign-in opens no panel");
  Assert.equal(
    section.querySelector(".sval-fr-status").dataset.said ?? "",
    "",
    "and says nothing"
  );

  // Dropbox.
  delete signIn.cancel;
  dropboxButton.click();
  await TestUtils.waitForCondition(
    () => listed(section).length,
    "the Dropbox's root is listed"
  );
  Assert.equal(section.dataset.connecting, "dropbox", "the panel opens");
  Assert.deepEqual(listed(section), DROPBOX_FOLDERS[""], "with its folders");
  const up = dropbox.querySelector(".sval-fr-dropbox-up");
  const use = dropbox.querySelector(".sval-fr-dropbox-use");
  Assert.ok(up.disabled, "Back waits at the root");
  Assert.ok(!use.disabled, "the root can be used");
  dropbox.querySelector('.sval-fr-dropbox-folder[data-name="Work"]').click();
  await TestUtils.waitForCondition(
    () => !up.disabled && listed(section).includes("Sval"),
    "a folder opens"
  );
  dropbox.querySelector('.sval-fr-dropbox-folder[data-name="Sval"]').click();
  await TestUtils.waitForCondition(
    () => !use.disabled && !listed(section).length,
    "an empty folder opens"
  );
  up.click();
  await TestUtils.waitForCondition(
    () => !use.disabled && listed(section).includes("Sval"),
    "Back goes up one level"
  );
  use.click();
  const working = section.querySelector(".sval-fr-working");
  Assert.ok(!working.hidden, "the step shows it's setting up the folder");
  Assert.ok(dropboxButton.disabled, "and holds the ways to choose another");
  const dropboxRoot = SvalRemoteFolder.dropboxRoot("Work");
  await TestUtils.waitForCondition(
    () => used.includes(dropboxRoot) && !button(doc, "continue").disabled,
    "the Dropbox folder is used"
  );
  Assert.ok(working.hidden, "until Sval has reached it");
  Assert.ok(!dropboxButton.disabled);
  Assert.ok(dropbox.hidden, "the Dropbox panel closes");
  Assert.equal(
    doc.activeElement,
    dropboxButton,
    "focus goes back to its button"
  );
  Assert.deepEqual(
    await SvalRemoteFolder.authFor(dropboxRoot),
    { refreshToken: "token-1" },
    "the sign-in is kept for the folder"
  );

  await endWith(doc, "later");
});
