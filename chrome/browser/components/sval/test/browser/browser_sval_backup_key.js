/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalBackupKey } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBackupKey.sys.mjs"
);
const { backupCode } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 255);

/**
 * Opens the backup sheet in this window's dialog box, and waits for its
 * script to have drawn the key.
 *
 * @param {object} [options]
 * @param {string} [options.sharedRoot] The sync folder the key opens.
 * @returns {Promise<object>} `{ shown, doc }`, where `shown` settles to
 *   whether the user saved a copy.
 */
async function openSheet({
  sharedRoot = PathUtils.join(PathUtils.tempDir, "sval-sync-folder"),
} = {}) {
  // A task that fails leaves its sheet open, and the next sheet would wait
  // behind it.
  atTaskEnd(closeLeftoverDialog);
  const shown = SvalBackupKey.show(window, {
    keyBytes: KEY,
    fingerprint: "0123456789abcdef0123",
    sharedRoot,
  });
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the sheet opens");
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = gDialogBox.dialog._frame.contentDocument;
    return doc?.querySelector(".sval-backup-code")?.textContent;
  }, "the key is drawn");
  return { shown, doc };
}

/**
 * The sheet shows the key as a code, with nothing to scan, tells the user
 * how to keep it in a password manager, and Copy puts the code on the
 * clipboard and counts as a backup.
 */
add_task(async function the_sheet_shows_the_key_and_how_to_keep_it() {
  const { shown, doc } = await openSheet();
  const code = backupCode(KEY);
  Assert.equal(
    doc.querySelector(".sval-backup-code").textContent,
    code,
    "the code is the key"
  );
  Assert.ok(
    !doc.querySelector("img, canvas"),
    "with no QR code, which nothing reads back into sval"
  );
  Assert.ok(
    doc.querySelector(".sval-backup-steps ol > li"),
    "and the steps to keep it in a password manager and restore it"
  );
  Assert.equal(
    doc.querySelector(".sval-backup-done").type,
    "primary",
    "Done is the dialog's primary action, as in Sval's other dialogs"
  );

  doc.querySelector(".sval-backup-copy").click();
  await TestUtils.waitForCondition(
    () => SpecialPowers.getClipboardData("text/plain") === code,
    "Copy put the code on the clipboard"
  );
  Assert.equal(
    doc.querySelector(".sval-backup-status").dataset.state,
    "copied",
    "and says so"
  );
  doc.querySelector(".sval-backup-done").click();
  Assert.ok(
    await within(shown, 10_000, "the sheet closing"),
    "a copied key counts as backed up"
  );
});

/**
 * The sheet fits its box with nothing to scroll: the code wraps between its
 * groups, and the box takes the card's height.
 */
add_task(async function the_sheet_fits_its_box() {
  const { shown, doc } = await openSheet();
  const root = doc.documentElement;
  await TestUtils.waitForCondition(
    () =>
      root.scrollWidth <= root.clientWidth &&
      root.scrollHeight <= root.clientHeight,
    "the sheet has nothing to scroll"
  );
  const code = doc.querySelector(".sval-backup-code");
  Assert.lessOrEqual(
    code.scrollWidth,
    code.clientWidth,
    "the code wraps within the card"
  );
  doc.querySelector(".sval-backup-done").click();
  await within(shown, 10_000, "the sheet closing");
});

/**
 * Closing the sheet without copying, saving or printing leaves the key with
 * no backup, so Settings goes on saying so.
 */
add_task(async function done_without_a_copy_is_no_backup() {
  const { shown, doc } = await openSheet();
  doc.querySelector(".sval-backup-done").click();
  Assert.ok(
    !(await within(shown, 10_000, "the sheet closing")),
    "nothing was backed up"
  );
});

/** A save inside the sync folder is refused, and nothing is written. */
add_task(async function a_save_into_the_sync_folder_is_refused() {
  const { shown, doc } = await openSheet();
  const sheet = gDialogBox.dialog._frame.contentWindow.SvalBackupSheet;
  const inside = PathUtils.join(
    PathUtils.tempDir,
    "sval-sync-folder",
    "Sval sync key.txt"
  );
  await sheet.saveTo(inside);
  Assert.ok(!(await IOUtils.exists(inside)), "nothing was written there");
  const status = doc.querySelector(".sval-backup-status");
  Assert.equal(status.dataset.state, "refused", "the sheet refuses the place");
  doc.querySelector(".sval-backup-done").click();
  Assert.ok(
    !(await within(shown, 10_000, "the sheet closing")),
    "and no backup is counted"
  );
});

/**
 * A saved backup holds the code, and only its owner can read it, wherever the
 * user put it. Windows keeps other users out through the folder's access
 * list instead (`writePrivateFile`), so the mode is checked elsewhere.
 */
add_task(async function a_saved_backup_is_its_owners_alone() {
  const { shown } = await openSheet();
  const sheet = gDialogBox.dialog._frame.contentWindow.SvalBackupSheet;
  const path = PathUtils.join(
    await makeTempDir("sval-backup-save"),
    "Sval sync key.txt"
  );
  await sheet.saveTo(path);
  Assert.ok(
    await within(shown, 10_000, "the sheet closing once saved"),
    "a saved key counts as backed up"
  );
  Assert.ok(
    (await IOUtils.readUTF8(path)).includes(backupCode(KEY)),
    "the file holds the code"
  );
  if (AppConstants.platform != "win") {
    Assert.equal(
      (await IOUtils.stat(path)).permissions,
      0o600,
      "and only its owner can read it"
    );
  }
});

/**
 * Save asks where to put the backup in a save picker that offers Sval's own
 * name for the file, and writes the backup where the user picks.
 */
add_task(async function save_writes_where_the_picker_says() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  const target = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  target.initWithPath(
    PathUtils.join(await makeTempDir("sval-backup-picked"), "picked.txt")
  );
  const asked = [];
  MockFilePicker.showCallback = picker => {
    asked.push({ mode: picker.mode, name: picker.defaultString });
  };
  MockFilePicker.setFiles([target]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;

  const { shown, doc } = await openSheet();
  const save = doc.querySelector(".sval-backup-save");
  Assert.ok(save, "the sheet has a Save button");
  Assert.ok(save.checkVisibility(), "which shows");
  Assert.ok(!save.disabled, "and takes a press");
  const rect = save.getBoundingClientRect();
  Assert.equal(
    doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    save,
    "nothing covers it"
  );
  EventUtils.synthesizeMouseAtCenter(save, {}, doc.defaultView);

  Assert.ok(
    await within(shown, 10_000, "the sheet closing once saved"),
    "a saved key counts as backed up"
  );
  Assert.deepEqual(
    asked,
    [{ mode: Ci.nsIFilePicker.modeSave, name: "Sval sync key.txt" }],
    "the press opened one save picker with Sval's name for the file"
  );
  Assert.ok(
    (await IOUtils.readUTF8(target.path)).includes(backupCode(KEY)),
    "the backup is in the file the user picked"
  );
});

/**
 * A save the disk refuses leaves the sheet open and says the key was not
 * saved, and no backup is counted.
 */
add_task(async function a_failed_save_says_so_and_counts_no_backup() {
  const { shown, doc } = await openSheet();
  const sheet = gDialogBox.dialog._frame.contentWindow.SvalBackupSheet;
  const dir = await makeTempDir("sval-backup-fail");
  // A file where the folder should be refuses the write on every platform.
  const notADir = PathUtils.join(dir, "not-a-folder");
  await IOUtils.writeUTF8(notADir, "");
  await sheet.saveTo(PathUtils.join(notADir, "Sval sync key.txt"));
  Assert.ok(gDialogBox.isOpen, "the sheet stays open");
  Assert.equal(
    doc.querySelector(".sval-backup-status").dataset.state,
    "failed",
    "and says the key was not saved"
  );
  doc.querySelector(".sval-backup-done").click();
  Assert.ok(
    !(await within(shown, 10_000, "the sheet closing")),
    "and no backup is counted"
  );
});

/**
 * A save in the sync folder's cloud account is written at once, and the
 * sheet stays open to say why that place is risky.
 */
add_task(async function a_save_in_the_sync_account_saves_and_warns() {
  // OneDrive's client names the folder it syncs in the environment, which
  // SvalBackupKey.providerRoots reads on every platform.
  const account = await makeTempDir("sval-backup-account");
  const hadOneDrive = Services.env.exists("OneDrive");
  const oneDrive = Services.env.get("OneDrive");
  Services.env.set("OneDrive", account);
  registerCleanupFunction(() => {
    Services.env.set("OneDrive", hadOneDrive ? oneDrive : "");
  });
  // The sync folder is in that account, beside the place the key is saved.
  const { shown, doc } = await openSheet({
    sharedRoot: PathUtils.join(account, "sval-sync-folder"),
  });
  const sheet = gDialogBox.dialog._frame.contentWindow.SvalBackupSheet;
  const path = PathUtils.join(account, "Sval sync key.txt");
  await sheet.saveTo(path);
  Assert.ok(
    (await IOUtils.readUTF8(path)).includes(backupCode(KEY)),
    "the first choice saves the file"
  );
  Assert.ok(gDialogBox.isOpen, "the sheet stays open");
  Assert.equal(
    doc.querySelector(".sval-backup-status").dataset.state,
    "saved-warned",
    "and says the place is risky"
  );
  doc.querySelector(".sval-backup-done").click();
  Assert.ok(
    await within(shown, 10_000, "the sheet closing"),
    "a saved key counts as backed up"
  );
});
