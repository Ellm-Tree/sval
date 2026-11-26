/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A folder on an SMB server (`SvalRemoteFolder`): the root Sval keeps for
 * it, the names it is shown by, and the password kept with the sync key.
 */

const { tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { SvalSecretStore, MemoryKeyStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalRemoteFolder, SIGN_INS_SECRET } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
);
const { folderProblem } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { friendlyFolderName } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

do_get_profile();

add_task(function a_root_is_built_from_what_the_user_typed() {
  const root = SvalRemoteFolder.smbRoot;
  Assert.equal(
    root({ server: "nas.local", share: "Shared", folder: "Sval Sync" }),
    "smb://nas.local/Shared/Sval%20Sync"
  );
  Assert.equal(
    root({
      server: " smb://nas.local:4445/ignored ",
      share: "Shared",
      folder: "\\a\\b\\",
      username: "me@home",
    }),
    "smb://me%40home@nas.local:4445/Shared/a/b",
    "a pasted address, backslashes and an @ in the name all read"
  );
  Assert.equal(root({ server: "", share: "Shared" }), null, "a server");
  Assert.equal(root({ server: "nas", share: " " }), null, "and a share");
  Assert.equal(
    root({ server: "nas", share: "s", folder: "a/../b" }),
    null,
    "and no step up"
  );
});

add_task(function a_root_reads_back_into_its_parts() {
  const parts = SvalRemoteFolder.parseSmbRoot(
    "smb://me%40home@nas.local:4445/Shared/a%20b/c"
  );
  Assert.deepEqual(parts, {
    host: "nas.local",
    port: 4445,
    share: "Shared",
    folder: "a b/c",
    username: "me@home",
  });
  Assert.equal(SvalRemoteFolder.parseSmbRoot("/Volumes/Shared"), null);
  Assert.equal(SvalRemoteFolder.parseSmbRoot("smb://nas"), null);
});

add_task(function a_remote_folder_is_named_without_its_username() {
  const at = "smb://me@nas.local/Shared/Sync/Sval%20Folder";
  Assert.equal(friendlyFolderName(at), "Sval Folder");
  Assert.equal(friendlyFolderName("smb://nas/Shared"), "Shared");
  Assert.equal(
    SvalRemoteFolder.remoteFolderPlace(at),
    "smb://nas.local/Shared/Sync/Sval Folder"
  );
  Assert.equal(
    SvalRemoteFolder.remoteFolderPlace("smb://nas:4445/Shared"),
    "smb://nas:4445/Shared"
  );
});

add_task(function the_folder_above_is_its_parent() {
  Assert.equal(SvalRemoteFolder.remoteFilename("smb://u@nas/s/a/sval"), "sval");
  Assert.equal(
    SvalRemoteFolder.remoteParent("smb://u@nas/s/a/sval"),
    "smb://u@nas/s/a"
  );
  Assert.equal(SvalRemoteFolder.remoteFilename("smb://nas/s"), null);
  Assert.equal(SvalRemoteFolder.remoteParent("smb://nas/s"), null);
});

add_task(function a_refused_sign_in_is_its_own_problem() {
  Assert.equal(folderProblem("io-error", "SignInError"), "sign-in");
  Assert.equal(folderProblem("io-error", "NetworkError"), "offline");
  Assert.equal(folderProblem("io-error", "NotAllowedError"), "denied");
});

add_task(async function a_password_is_kept_only_for_the_folder_in_use() {
  const keyStore = new MemoryKeyStore();
  await keyStore.asyncGenerateSecret(SvalSecretStore.userLabel());
  SvalSecretStore.path = tempPath("sval-secrets", ".json");
  SvalSecretStore.keyStore = keyStore;
  SvalSecretStore.systemStoreUsable = true;
  SvalRemoteFolder._reset();

  const a = "smb://u@nas/s/a";
  const b = "smb://u@nas/s/b";
  Assert.equal(await SvalRemoteFolder.authFor(a), null, "none at first");
  await SvalRemoteFolder.keepPassword(a, "pa");
  await SvalRemoteFolder.keepPassword(b, "pb");
  Assert.deepEqual(await SvalRemoteFolder.authFor(a), { password: "pa" });
  Assert.equal(
    await SvalRemoteFolder.authFor("/Volumes/s"),
    null,
    "a local folder has none"
  );

  SvalRemoteFolder._reset();
  Assert.deepEqual(
    await SvalRemoteFolder.authFor(b),
    { password: "pb" },
    "read back from the secret store"
  );

  await SvalRemoteFolder.moveSignIn(b, "smb://u@nas/s");
  Assert.equal(await SvalRemoteFolder.authFor(b), null);
  Assert.deepEqual(await SvalRemoteFolder.authFor("smb://u@nas/s"), {
    password: "pb",
  });

  await SvalRemoteFolder.keepOnly("smb://u@nas/s");
  Assert.equal(await SvalRemoteFolder.authFor(a), null, "the other is gone");
  await SvalRemoteFolder.keepOnly(null);
  Assert.equal(
    await SvalSecretStore.read(SIGN_INS_SECRET),
    null,
    "and with no remote folder, the secret is too"
  );
});
