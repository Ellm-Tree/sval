/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the secret store decides before it asks the system store. Everything
 * that reaches the system store is tested against the platform's own, in
 * test/os-keystore/test_sval_os_keystore.js.
 */

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

do_get_profile();

function secretsFile() {
  return PathUtils.join(PathUtils.profileDir, "sval-secrets.json");
}

/**
 * Runs `work` in a profile with no secrets file, and removes the file after.
 *
 * @param {Function} work
 */
async function withNoFile(work) {
  await IOUtils.remove(secretsFile(), { ignoreAbsent: true });
  SvalSecretStore.retry();
  try {
    await work(secretsFile());
  } finally {
    await IOUtils.remove(secretsFile(), { ignoreAbsent: true });
    SvalSecretStore.retry();
  }
}

function same(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * A file that exists and cannot be read is a throw, never "nothing stored": a
 * caller may replace what it thinks is absent.
 */
add_task(async function a_damaged_file_is_never_read_as_empty() {
  await withNoFile(async path => {
    await IOUtils.writeUTF8(path, "{ not json");
    await Assert.rejects(
      SvalSecretStore.read("key"),
      err => err.code === "file_unreadable",
      "a damaged file is refused"
    );
    await Assert.rejects(
      SvalSecretStore.write("key", new Uint8Array(1)),
      err => err.code === "file_unreadable",
      "and is not written over"
    );
    Assert.equal(await IOUtils.readUTF8(path), "{ not json", "left alone");
  });
});

/**
 * Sval keeps nothing in Firefox's login store, so nothing that lists or removes
 * saved logins can reach Sval's secrets: about:logins lists
 * `getAllLogins`, and removing every login is what "Remove all logins" and an
 * extension's `browsingData.removePasswords` do.
 */
add_task(async function removing_logins_reaches_no_sval_secret() {
  const { SvalKagi } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
  );
  await withNoFile(async () => {
    const identityPath = SvalIdentity.path;
    const localKeyPath = SvalIdentity.localKeyPath;
    const dir = await makeTempDir("sval-logins");
    SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
    SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
    SvalIdentity.forgetCachedValues();
    try {
      await SvalIdentity.localKey();
      const syncKey = await SvalIdentity.mintSyncKey();
      await SvalKagi._adopt("a-kagi-token", "link");

      await Services.logins.initializationPromise;
      const logins = await Services.logins.getAllLogins();
      Assert.deepEqual(
        logins.filter(login => login.origin.startsWith("chrome://sval")),
        [],
        "the login store holds no sval entry"
      );

      await Services.logins.removeAllLoginsAsync();
      SvalIdentity.forgetCachedValues();
      const sync = await SvalIdentity.syncKey();
      Assert.ok(same(sync.bytes, syncKey), "the sync key survives");
      const kagi = await SvalKagi._stored();
      Assert.equal(kagi?.token, "a-kagi-token", "the Kagi token survives");
    } finally {
      await SvalKagi._adopt(null, null);
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
      SvalIdentity.path = identityPath;
      SvalIdentity.localKeyPath = localKeyPath;
      SvalIdentity.forgetCachedValues();
    }
  });
});

/**
 * A Mac dev build, whose bundle carries the dev identity in place of the
 * release's compiled-in one (`scripts/build.sh`), keeps its own system
 * secret: a file sealed under the installed Sval's label is lost to it, and
 * is neither read nor resealed. The store is never asked, since the label
 * decides it first.
 */
add_task(
  { skip_if: () => AppConstants.platform !== "macosx" },
  async function a_dev_build_never_reads_the_installed_secret() {
    Assert.notEqual(
      SvalSecretStore.bundleIdentifier(),
      AppConstants.MOZ_MACBUNDLE_ID,
      "the build under test carries the dev identity"
    );
    const release = "Sval secrets";
    Assert.notEqual(
      SvalSecretStore.userLabel(),
      release,
      "the dev build has a label of its own"
    );

    await withNoFile(async path => {
      const installed = {
        backend: "system",
        label: release,
        secrets: { "sync key": "AAAA", kagi: "AAAA" },
      };
      await IOUtils.writeJSON(path, installed);
      await Assert.rejects(
        SvalSecretStore.read("sync key"),
        SvalSecretStore.LostError,
        "a file sealed under the installed Sval's secret is lost"
      );
      await Assert.rejects(
        SvalSecretStore.write("sync key", new Uint8Array(32).fill(8)),
        SvalSecretStore.LostError,
        "and is not resealed while another secret depends on it"
      );
      Assert.deepEqual(
        await IOUtils.readJSON(path),
        installed,
        "the file is left as it was"
      );
    });
  }
);
