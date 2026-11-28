/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * Spec §6.4 and §12 require a visible last-synced time in v1, which means
 * "never" has to be something it can say.
 */
add_task(function the_last_synced_time_can_say_never() {
  const { lastSyncedText } = SvalPanelModel;
  const now = 1_700_000_000_000;

  const never = lastSyncedText(null, now);
  const justNow = lastSyncedText(now - 2_000, now);
  Assert.ok(never, "never is something it can say");
  Assert.ok(!/\d/.test(never), "with no time in it");
  Assert.ok(!/\d/.test(justNow), "a sync seconds ago is told without a count");
  Assert.notEqual(never, justNow, "and is not never");

  const minutes = lastSyncedText(now - 5 * 60_000, now);
  const hours = lastSyncedText(now - 5 * 60 * 60_000, now);
  const days = lastSyncedText(now - 5 * 24 * 60 * 60_000, now);
  for (const text of [minutes, hours, days]) {
    Assert.stringContains(text, "5", "the count is in the text");
  }
  Assert.equal(
    new Set([minutes, hours, days]).size,
    3,
    "minutes, hours and days are each told as such"
  );
  Assert.stringContains(
    lastSyncedText(now - 60 * 60_000, now),
    "1",
    "sixty minutes round to one hour"
  );
  Assert.notEqual(
    lastSyncedText(now - 60 * 60_000, now),
    lastSyncedText(now - 60_000, now),
    "and an hour is not a minute"
  );
  Assert.stringContains(lastSyncedText(now - 48 * 60 * 60_000, now), "2");
});

/**
 * A folder that is there and does not answer shows on the second failed
 * step in a row, a missing one on the first, and a failure someone waited
 * on at once (messages spec §3).
 */
add_task(function an_outage_shows_when_it_repeats() {
  const { showsFolderNotice } = SvalPanelModel;
  Assert.ok(
    !showsFolderNotice({ problem: null, failures: 0 }),
    "not while the folder answers"
  );
  Assert.ok(
    !showsFolderNotice({ problem: "offline", failures: 1 }),
    "not after one blip"
  );
  Assert.ok(
    showsFolderNotice({ problem: "offline", failures: 2 }),
    "from the second failure on"
  );
  Assert.ok(
    showsFolderNotice({ problem: "gone", failures: 1 }),
    "a missing folder at once"
  );
  Assert.ok(
    showsFolderNotice({ problem: "offline", failures: 1, asked: true }),
    "and a failure someone waited on"
  );
  Assert.ok(
    !showsFolderNotice({ problem: "own-file", failures: 0 }),
    "never a folder that answered"
  );
});

add_task(function a_typed_code_is_normalized_or_refused() {
  const { normalizeCode } = SvalPanelModel;
  Assert.equal(normalizeCode("K7Q4-8MTZ-3RJW"), "K7Q4-8MTZ-3RJW", "as shown");
  Assert.equal(
    normalizeCode(" k7q4 8mtz-3rjw "),
    "K7Q4-8MTZ-3RJW",
    "case, spaces and dashes are forgiven"
  );
  Assert.equal(normalizeCode("K7Q4-8MTZ-3RJ"), null, "eleven is not a code");
  Assert.equal(
    normalizeCode("K7Q4-8MTZ-3RJO"),
    "K7Q4-8MTZ-3RJ0",
    "O reads as the zero it looks like"
  );
  Assert.equal(
    normalizeCode("i7q4-8mtz-3rjl"),
    "17Q4-8MTZ-3RJ1",
    "and I and L as one"
  );
  Assert.equal(
    normalizeCode("K7Q4-8MTZ-3RJU"),
    null,
    "a letter the alphabet leaves out, with no digit it looks like, is refused"
  );
  Assert.equal(normalizeCode(undefined), null, "nor nothing");
});

/**
 * A code field groups what is typed or pasted in fours, whatever dashes and
 * spaces came with it, and keeps the caret after the character it followed.
 */
add_task(function a_typed_code_is_grouped_as_it_is_typed() {
  const { groupCodeEntry } = SvalPanelModel;
  const at = (text, caret = text.length) => groupCodeEntry(text, caret);
  Assert.deepEqual(
    at("k7q4"),
    { text: "K7Q4", caret: 4 },
    "one group, no dash yet"
  );
  Assert.deepEqual(
    at("K7Q48"),
    { text: "K7Q4-8", caret: 6 },
    "the next group's first character brings the dash"
  );
  Assert.deepEqual(
    at("K7Q4-8MTZ-3RJW"),
    { text: "K7Q4-8MTZ-3RJW", caret: 14 },
    "a code typed with its dashes stays as it is"
  );
  Assert.deepEqual(
    at("k7q4 8mtz--3rjw"),
    { text: "K7Q4-8MTZ-3RJW", caret: 14 },
    "pasted spaces and doubled dashes become one dash"
  );
  Assert.deepEqual(
    at("K7Q4-"),
    { text: "K7Q4", caret: 4 },
    "a dash typed after a group waits for the next group"
  );
  Assert.deepEqual(
    at("K7QX4-8MTZ", 4),
    { text: "K7QX-48MT-Z", caret: 4 },
    "a character typed mid-code keeps the caret after it"
  );
  Assert.deepEqual(at("", 0), { text: "", caret: 0 }, "an empty field");
});

/**
 * The sync folder's field names the folder the way a person knows it: the
 * cloud service and the folder for the services people sync through, the
 * folder's own name otherwise.
 */
add_task(function the_sync_folder_has_a_friendly_name() {
  const { friendlyFolderName } = SvalPanelModel;
  const cases = [
    [
      "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/sval",
      "iCloud Drive › sval",
    ],
    [
      "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Work/sval",
      "iCloud Drive › sval",
    ],
    ["/Users/a/Library/Mobile Documents/com~apple~CloudDocs", "iCloud Drive"],
    ["/Users/a/Library/CloudStorage/Dropbox/sval", "Dropbox › sval"],
    [
      "/Users/a/Library/CloudStorage/OneDrive-Personal/Sync/sval",
      "OneDrive › sval",
    ],
    [
      "/Users/a/Library/CloudStorage/GoogleDrive-a@example.com/My Drive/sval",
      "Google Drive › sval",
    ],
    ["C:\\Users\\a\\OneDrive\\sval", "OneDrive › sval"],
    ["C:\\Users\\a\\OneDrive - Example Ltd\\sval", "OneDrive › sval"],
    ["/home/a/Dropbox/sval/", "Dropbox › sval"],
    ["/mnt/share/sval-sync", "sval-sync"],
    ["\\\\server\\share\\sval", "sval"],
  ];
  for (const [path, name] of cases) {
    Assert.equal(friendlyFolderName(path), name, path);
  }
});

/** The service that syncs a folder, which first run names while it waits. */
add_task(function a_cloud_folder_names_its_service() {
  const { cloudServiceOf } = SvalPanelModel;
  for (const [path, service] of [
    [
      "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/sval",
      "iCloud Drive",
    ],
    ["/Users/a/Library/CloudStorage/Dropbox/sval", "Dropbox"],
    ["C:\\Users\\a\\OneDrive\\sval", "OneDrive"],
    ["/mnt/share/sval-sync", null],
    ["/Volumes/backup/Sval", null],
  ]) {
    Assert.equal(cloudServiceOf(path), service, path);
  }
});

/**
 * A sync key's backup reads back as the same 32 bytes, forgives how it was
 * typed, and refuses anything that cannot be one.
 */
add_task(function a_backup_code_round_trips_and_refuses_the_rest() {
  const { backupCode, fromBackupCode, BACKUP_LENGTH } = SvalPanelModel;
  for (const fill of [0, 1, 127, 255]) {
    const key = new Uint8Array(32).fill(fill);
    key[0] = 7;
    key[31] = 200;
    const code = backupCode(key);
    Assert.equal(
      code.replaceAll("-", "").length,
      BACKUP_LENGTH,
      `${code} is ${BACKUP_LENGTH} characters`
    );
    Assert.deepEqual(
      Array.from(fromBackupCode(code)),
      Array.from(key),
      "and reads back as the key"
    );
    Assert.deepEqual(
      Array.from(
        fromBackupCode(` ${code.toLowerCase().replaceAll("-", " ")} `)
      ),
      Array.from(key),
      "however it was typed"
    );
  }
  const good = backupCode(new Uint8Array(32).fill(9));
  Assert.equal(fromBackupCode(good.slice(0, -1)), null, "too short");
  Assert.equal(fromBackupCode(`${good}A`), null, "too long");
  Assert.equal(
    fromBackupCode(good.replace(/.$/, "I")),
    null,
    "a letter it lacks"
  );
  Assert.equal(
    fromBackupCode(good.replace(/.$/, "Z")),
    null,
    "a last character whose spare bits are not zero"
  );
});

/**
 * A backup inside the sync folder is refused. One in the same cloud account
 * as the sync folder is saved with a warning, and one in another account, or
 * outside every account, is saved with none.
 */
add_task(function a_backup_beside_its_folder_is_refused() {
  const { SvalBackupKey } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBackupKey.sys.mjs"
  );
  const realRoots = SvalBackupKey.providerRoots;
  const home = PathUtils.tempDir;
  const cloud = PathUtils.join(home, "Cloud");
  const shared = PathUtils.join(cloud, "sval sync");
  const storage = PathUtils.join(home, "CloudStorage");
  const drive = PathUtils.join(storage, "GoogleDrive-a");
  const verdict = (path, root) =>
    SvalBackupKey.checkDestination(path, root).verdict;
  SvalBackupKey.providerRoots = () => [cloud, storage];
  try {
    Assert.equal(
      verdict(PathUtils.join(shared, "key.txt"), shared),
      "refuse",
      "inside the sync folder is refused"
    );
    Assert.equal(
      verdict(PathUtils.join(cloud, "key.txt"), shared),
      "warn",
      "elsewhere in the sync folder's account is warned about"
    );
    Assert.equal(
      verdict(PathUtils.join(`${shared} copy`, "key.txt"), shared),
      "warn",
      "a sibling that only starts with the folder's name is not inside it"
    );
    Assert.equal(
      verdict(PathUtils.join(drive, "key.txt"), shared),
      "ok",
      "another cloud account is fine"
    );
    Assert.equal(
      verdict(PathUtils.join(home, "key.txt"), shared),
      "ok",
      "anywhere else is fine"
    );
    const inDrive = PathUtils.join(drive, "sval sync");
    Assert.equal(
      verdict(PathUtils.join(drive, "Keys", "key.txt"), inDrive),
      "warn",
      "under CloudStorage, the account folder holding the sync folder is warned about"
    );
    Assert.equal(
      verdict(PathUtils.join(storage, "Dropbox-b", "key.txt"), inDrive),
      "ok",
      "and another account folder beside it is fine"
    );
  } finally {
    SvalBackupKey.providerRoots = realRoots;
  }
});

/**
 * A link into the sync folder leads to the sync folder: a backup saved
 * through one would sit beside the files it unlocks all the same. Making a
 * link needs a privilege on Windows, so this skips there.
 */
add_task(
  { skip_if: () => mozinfo.os == "win" },
  async function a_backup_through_a_link_into_its_folder_is_refused() {
    const { SvalBackupKey } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalBackupKey.sys.mjs"
    );
    const { makeTempDir } = ChromeUtils.importESModule(
      "resource://testing-common/SvalTestTemp.sys.mjs"
    ).SvalTestTemp;
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const shared = await makeTempDir("sval-backup-shared");
    const elsewhere = await makeTempDir("sval-backup-elsewhere");
    const link = PathUtils.join(elsewhere, "documents");
    const proc = await Subprocess.call({
      command: await Subprocess.pathSearch("ln"),
      arguments: ["-s", shared, link],
      stderr: "pipe",
    });
    Assert.equal((await proc.wait()).exitCode, 0, "ln made the link");

    Assert.equal(
      SvalBackupKey.checkDestination(PathUtils.join(link, "key.txt"), shared)
        .verdict,
      "refuse",
      "a file saved through the link would be in the sync folder"
    );
    Assert.equal(
      SvalBackupKey.checkDestination(PathUtils.join(shared, "key.txt"), link)
        .verdict,
      "refuse",
      "a sync folder chosen through a link is refused at its own path too"
    );
    Assert.equal(
      SvalBackupKey.checkDestination(PathUtils.join(elsewhere, "key.txt"), link)
        .verdict,
      "ok",
      "and the folder holding the link is not inside the folder it leads to"
    );
  }
);
