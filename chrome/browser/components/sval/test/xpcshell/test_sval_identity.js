/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalIdentity, fingerprintOf, machineFingerprintOf, readMachineId } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
const { SvalSecretStore, MemoryKeyStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const { SYNC_KEY_STATES } = SvalIdentity;

/**
 * Points `SvalIdentity` at its own identity file for one task, so a test that
 * damages the file cannot affect any other.
 *
 * @param {string} name Distinguishes this task's file from the others'.
 * @param {Function} work Called with the file's path.
 */
async function withIdentityFile(name, work) {
  const previous = {
    path: SvalIdentity.path,
    localKeyPath: SvalIdentity.localKeyPath,
    secrets: SvalSecretStore.path,
    keyStore: SvalSecretStore.keyStore,
  };
  const dir = await makeTempDir(`sval-identity-${name}`);
  SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
  SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
  SvalSecretStore.path = PathUtils.join(dir, "sval-secrets.json");
  const keyStore = new MemoryKeyStore();
  SvalSecretStore.keyStore = keyStore;
  SvalIdentity.forgetCachedValues();
  try {
    await work(SvalIdentity.path, { dir, keyStore });
  } finally {
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    SvalIdentity.path = previous.path;
    SvalIdentity.localKeyPath = previous.localKeyPath;
    SvalSecretStore.path = previous.secrets;
    SvalSecretStore.keyStore = previous.keyStore;
    SvalIdentity.forgetCachedValues();
  }
}

function toHexString(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The device id must be generated once and then never change: two devices
 * sharing one id would write the same path, and a device that changes its own
 * abandons every watermark its peers hold for the old one, so deletions of its
 * earlier writes stop propagating (host contract §5).
 */
add_task(async function the_device_id_is_generated_once_and_persists() {
  do_get_profile();

  const first = await SvalIdentity.deviceId();
  Assert.equal(first.length, 16, "the device id is exactly 16 bytes");

  const identityFile = PathUtils.join(
    PathUtils.profileDir,
    "sval-identity.json"
  );
  Assert.ok(
    await IOUtils.exists(identityFile),
    "the id reached disk before it was handed out"
  );

  // A restart reads the file back.
  SvalIdentity.forgetCachedValues();
  const afterReload = await SvalIdentity.deviceId();
  Assert.equal(
    afterReload.join(","),
    first.join(","),
    "the same id comes back from disk"
  );
});

/**
 * An identity file that exists but cannot be read must never be treated as
 * absent. "Absent" means first run and licenses a new id; a damaged file may
 * still be hiding an id that has already published files, and a second id
 * orphans every one of them.
 */
add_task(async function a_damaged_identity_file_generates_nothing() {
  await withIdentityFile("damaged", async path => {
    await IOUtils.writeUTF8(path, "{ this is not json");
    const before = await IOUtils.read(path);

    await Assert.rejects(
      SvalIdentity.deviceId(),
      err => err.code === "identity_unreadable",
      "deviceId rejected rather than generating one"
    );

    const after = await IOUtils.read(path);
    Assert.equal(
      after.join(","),
      before.join(","),
      "the damaged file was left exactly as it was"
    );
  });

  // A file that parses but does not hold a 16-byte id is the same situation.
  await withIdentityFile("wrong-length", async path => {
    await IOUtils.writeJSON(path, { deviceId: "abcd" });

    await Assert.rejects(
      SvalIdentity.deviceId(),
      err => err.code === "bad_device_id",
      "a short id is not silently replaced"
    );
  });
});

/**
 * Two callers racing for the id must get one id. Only one of them could
 * persist its own, and the other would hand the engine bytes that never
 * reached disk.
 */
add_task(async function concurrent_callers_share_one_generated_id() {
  await withIdentityFile("concurrent", async () => {
    const [first, second] = await Promise.all([
      SvalIdentity.deviceId(),
      SvalIdentity.deviceId(),
    ]);
    Assert.equal(
      first.join(","),
      second.join(","),
      "both callers got the same id"
    );
  });
});

/**
 * The device id the identity file at `path` holds for the computer whose
 * fingerprint is `fingerprint`.
 *
 * @param {string} path
 * @param {string} fingerprint
 * @returns {Promise<string|undefined>} the id as hex.
 */
async function idOn(path, fingerprint) {
  const { devices } = await IOUtils.readJSON(path);
  return devices?.[fingerprint];
}

/**
 * What a restart reads: the device id, from disk. A restart that asked
 * whether Sval moved here would answer a new device, since xpcshell has no
 * browser window to ask in, and the id would change.
 * `browser_sval_identity_moved.js` answers that question.
 */
async function restart() {
  SvalIdentity.forgetCachedValues();
  return SvalIdentity.deviceId();
}

/**
 * This computer's machine id reads, and a new profile records it only as a
 * hash.
 */
add_task(async function a_new_profile_records_its_computer() {
  const id = await readMachineId();
  Assert.equal(typeof id, "string", "this computer's machine id reads");
  Assert.ok(id.length, "and is not empty");
  if (AppConstants.platform === "macosx") {
    Assert.ok(
      /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(id),
      "a Mac's is its IOPlatformUUID's shape"
    );
  }

  await withIdentityFile("machine-new", async path => {
    const first = await SvalIdentity.deviceId();
    const stored = await IOUtils.readJSON(path);
    Assert.equal(
      await idOn(path, await machineFingerprintOf(id)),
      stored.deviceId,
      "the computer is recorded by its fingerprint, with its id"
    );
    Assert.ok(
      !JSON.stringify(stored).includes(id),
      "and never as the machine id itself"
    );
    Assert.ok(same(await restart(), first), "the same computer keeps its id");
    Assert.deepEqual(
      await IOUtils.readJSON(path),
      stored,
      "and the file is as it was"
    );
  });
});

/**
 * A profile from before the identity file kept a map of computers records
 * this one for the id it holds, without asking, and drops the single
 * fingerprint an older file kept.
 */
add_task(async function an_older_profile_records_its_computer_silently() {
  const machineId = await readMachineId();
  Assert.notEqual(machineId, null, "this computer's id reads");
  const here = await machineFingerprintOf(machineId);
  const id = new Uint8Array(16).fill(7);
  const hex = "07".repeat(16);
  for (const older of [
    { deviceId: hex },
    {
      deviceId: hex,
      machineFingerprint: await machineFingerprintOf("another computer"),
    },
  ]) {
    await withIdentityFile("machine-older", async path => {
      await IOUtils.writeJSON(path, older);
      Assert.ok(same(await restart(), id), "the id is kept");
      Assert.equal(
        await idOn(path, here),
        hex,
        "this computer is recorded with the id"
      );
      Assert.equal(
        (await IOUtils.readJSON(path)).machineFingerprint,
        undefined,
        "in the map alone"
      );
    });
  }
});

/**
 * A profile in a synced folder, opened on two computers in turn, is a device
 * on each. Back on this computer after the other ran it, the profile takes
 * this computer's own id without asking, and starts with it.
 */
add_task(async function a_profile_back_from_the_other_computer_keeps_its_id() {
  const machineId = await readMachineId();
  Assert.notEqual(machineId, null, "this computer's id reads");
  const here = await machineFingerprintOf(machineId);
  const there = await machineFingerprintOf("another computer");
  const mine = "11".repeat(16);
  const theirs = "22".repeat(16);
  await withIdentityFile("machine-alternating", async path => {
    // What the other computer leaves: its id last used.
    await IOUtils.writeJSON(path, {
      deviceId: theirs,
      devices: { [here]: mine, [there]: theirs },
    });
    Assert.equal(toHexString(await restart()), mine, "this computer's id");
    const stored = await IOUtils.readJSON(path);
    Assert.equal(stored.deviceId, mine, "is the one used last");
    Assert.deepEqual(
      stored.devices,
      { [here]: mine, [there]: theirs },
      "and each computer keeps its own"
    );
  });
});

/**
 * The local key is raw key material, so its file is readable by its owner
 * alone, and stays so in a copy of the profile made by a tool that keeps
 * modes. Windows has no such mode; the profile's DACL covers it there.
 */
add_task(async function the_local_key_file_is_readable_by_its_owner_only() {
  if (AppConstants.platform == "win") {
    return;
  }
  await withIdentityFile("local-mode", async () => {
    await SvalIdentity.localKey();
    const { permissions } = await IOUtils.stat(SvalIdentity.localKeyPath);
    Assert.equal(
      permissions & 0o777,
      0o600,
      `the key file is mode 0600, not ${(permissions & 0o777).toString(8)}`
    );
  });
});

/**
 * The local key is made once and read after. A second one would hide this
 * device's own copy, which only the first opens.
 */
add_task(async function the_local_key_is_made_once_and_read_after() {
  await withIdentityFile("local-once", async path => {
    const first = await SvalIdentity.localKey();
    Assert.equal(first.length, 32, "the local key is 32 bytes");
    Assert.ok(
      same(await IOUtils.read(SvalIdentity.localKeyPath), first),
      "the key reached its file before it was handed out"
    );
    const recorded = (await IOUtils.readJSON(path)).localKeyFingerprint;
    Assert.equal(
      recorded,
      await fingerprintOf(first),
      "its fingerprint is recorded"
    );

    SvalIdentity.forgetCachedValues();
    Assert.ok(
      same(await SvalIdentity.localKey(), first),
      "a restart reads the same key"
    );
  });
});

/**
 * A local key that is recorded and gone, damaged or replaced stops startup
 * rather than being replaced: a new one would open nothing this device wrote.
 */
add_task(async function a_lost_or_changed_local_key_makes_nothing() {
  await withIdentityFile("local-missing", async () => {
    await SvalIdentity.localKey();
    await IOUtils.remove(SvalIdentity.localKeyPath);
    SvalIdentity.forgetCachedValues();
    await Assert.rejects(
      SvalIdentity.localKey(),
      err => err.code === "key_missing",
      "a recorded key that is gone is refused"
    );
    Assert.ok(
      !(await IOUtils.exists(SvalIdentity.localKeyPath)),
      "no replacement was written"
    );
  });

  await withIdentityFile("local-short", async () => {
    await SvalIdentity.localKey();
    await IOUtils.write(SvalIdentity.localKeyPath, new Uint8Array(31));
    SvalIdentity.forgetCachedValues();
    await Assert.rejects(
      SvalIdentity.localKey(),
      err => err.code === "bad_key_length",
      "a damaged key is refused"
    );
  });

  await withIdentityFile("local-other", async () => {
    await SvalIdentity.localKey();
    const other = new Uint8Array(32).fill(7);
    await IOUtils.write(SvalIdentity.localKeyPath, other);
    SvalIdentity.forgetCachedValues();
    await Assert.rejects(
      SvalIdentity.localKey(),
      err => err.code === "wrong_key",
      "a replaced key is refused"
    );
  });
});

/**
 * A key written and not yet recorded is a first launch that stopped between
 * the two, and is the key: it may already have encrypted the profile copy.
 */
add_task(async function an_unrecorded_local_key_is_kept_and_recorded() {
  await withIdentityFile("local-unrecorded", async path => {
    await SvalIdentity.deviceId();
    const written = new Uint8Array(32).fill(3);
    await IOUtils.write(SvalIdentity.localKeyPath, written);
    Assert.ok(same(await SvalIdentity.localKey(), written), "it is used");
    Assert.equal(
      (await IOUtils.readJSON(path)).localKeyFingerprint,
      await fingerprintOf(written),
      "and recorded"
    );
  });
});

/**
 * A device that was never set up to share holds no sync key, and asking makes
 * none: holding a key never decides whether the user has workspaces.
 */
add_task(async function a_device_that_never_shared_has_no_sync_key() {
  await withIdentityFile("sync-none", async (path, { dir }) => {
    await SvalIdentity.localKey();
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.none, "there is none");
    Assert.equal(sync.bytes, null, "and no bytes");
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(dir, "sval-secrets.json"))),
      "asking stored nothing"
    );
    Assert.equal(
      (await IOUtils.readJSON(path)).syncKeyFingerprint,
      undefined,
      "and recorded nothing"
    );
  });
});

/**
 * Setting up to share makes the sync key, stores it outside the profile copy,
 * and reads it back on every later start. It is not the local key.
 */
add_task(async function minting_stores_a_sync_key_that_reads_back() {
  await withIdentityFile("sync-mint", async (path, { dir }) => {
    const local = await SvalIdentity.localKey();
    const minted = await SvalIdentity.mintSyncKey();
    Assert.equal(minted.length, 32, "the sync key is 32 bytes");
    Assert.ok(!same(minted, local), "it is not the local key");

    const secrets = await IOUtils.readUTF8(
      PathUtils.join(dir, "sval-secrets.json")
    );
    const base64 = btoa(String.fromCharCode(...minted));
    Assert.ok(
      !secrets.includes(base64),
      "the profile holds the sync key only encrypted"
    );

    SvalIdentity.forgetCachedValues();
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "it is present");
    Assert.ok(same(sync.bytes, minted), "it is the key that was made");
    Assert.equal(
      (await IOUtils.readJSON(path)).syncKeyFingerprint,
      await fingerprintOf(minted),
      "its fingerprint is recorded"
    );

    await Assert.rejects(
      SvalIdentity.mintSyncKey(),
      err => err.code === "has_sync_key",
      "a second key is refused"
    );
  });
});

/**
 * A store that will not answer is `unreadable`, and one that has lost what
 * unlocks the key is `missing`. Neither mints a replacement, and neither
 * touches the local key, so this device's own workspaces still open.
 */
add_task(async function an_unusable_store_stops_only_syncing() {
  await withIdentityFile("sync-unreadable", async (path, { keyStore }) => {
    const local = await SvalIdentity.localKey();
    const minted = await SvalIdentity.mintSyncKey();

    SvalSecretStore.retry();
    keyStore.failing.asyncGetRecoveryPhrase = new Error(
      "the keychain is locked"
    );
    let sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.unreadable, "unreadable");
    Assert.ok(sync.reason.includes("locked"), "the reason is kept");
    SvalIdentity.forgetCachedValues();
    Assert.ok(
      same(await SvalIdentity.localKey(), local),
      "the local key opens"
    );

    delete keyStore.failing.asyncGetRecoveryPhrase;
    SvalSecretStore.retry();
    sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "trying again works");
    Assert.ok(same(sync.bytes, minted), "with the same key");
  });

  await withIdentityFile("sync-lost", async (path, { keyStore }) => {
    await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    keyStore.secrets.clear();
    SvalSecretStore.retry();
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.missing, "the key is missing");
    await Assert.rejects(
      SvalIdentity.mintSyncKey(),
      err => err.code === "has_sync_key",
      "and nothing mints a replacement for it"
    );
  });

  await withIdentityFile("sync-removed", async (path, { dir }) => {
    await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    await IOUtils.remove(PathUtils.join(dir, "sval-secrets.json"));
    const sync = await SvalIdentity.syncKey();
    Assert.equal(
      sync.state,
      SYNC_KEY_STATES.missing,
      "a deleted file is missing"
    );
  });
});

/**
 * A stored key that is not the one recorded is `different`, and is not used:
 * it names another document's directory.
 */
add_task(async function a_sync_key_that_is_not_ours_is_not_used() {
  await withIdentityFile("sync-different", async () => {
    await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    await SvalSecretStore.write("sync key", new Uint8Array(32).fill(9));
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.different, "different");
    Assert.equal(sync.bytes, null, "and not handed out");
  });
});

/**
 * Adopting a received key replaces the stored one, records it, and leaves the
 * local key alone: joining another device's workspaces does not re-encrypt
 * this device's own copy.
 */
add_task(async function adopting_replaces_only_the_sync_key() {
  await withIdentityFile("adopt", async path => {
    const local = await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    const received = new Uint8Array(32).fill(5);

    Assert.ok(await SvalIdentity.adoptSyncKey(received), "the key changed");
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "it is present");
    Assert.ok(same(sync.bytes, received), "and is the received key");
    SvalIdentity.forgetCachedValues();
    Assert.ok(
      same(await SvalIdentity.localKey(), local),
      "the local key stays"
    );
    const identity = await IOUtils.readJSON(path);
    Assert.equal(
      identity.syncKeyFingerprint,
      await fingerprintOf(received),
      "the received key is recorded"
    );
    Assert.equal(
      identity.adoptingSyncKeyFingerprint,
      undefined,
      "and the adoption is finished"
    );

    Assert.ok(
      !(await SvalIdentity.adoptSyncKey(received)),
      "adopting the same key again writes nothing"
    );
  });

  // A device that never shared adopts too: that is joining.
  await withIdentityFile("adopt-first", async () => {
    await SvalIdentity.localKey();
    const received = new Uint8Array(32).fill(6);
    await SvalIdentity.adoptSyncKey(received);
    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "joining stores it");
    Assert.ok(same(sync.bytes, received), "the received key");
  });

  await withIdentityFile("adopt-short", async () => {
    await Assert.rejects(
      SvalIdentity.adoptSyncKey(new Uint8Array(31)),
      err => err.code === "bad_key_length",
      "a short key is refused"
    );
  });
});

/**
 * A window that reads the sync key while a pairing stores another is told
 * the key the pairing stored, and the read leaves the adoption whole.
 */
add_task(async function a_read_during_an_adoption_answers_after_it() {
  await withIdentityFile("adopt-read", async path => {
    await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    const received = new Uint8Array(32).fill(7);

    const adopting = SvalIdentity.adoptSyncKey(received);
    const read = await SvalIdentity.syncKey();
    await adopting;
    Assert.equal(read.state, SYNC_KEY_STATES.present, "the read finds a key");
    Assert.ok(same(read.bytes, received), "and it is the one being adopted");
    const identity = await IOUtils.readJSON(path);
    Assert.equal(
      identity.syncKeyFingerprint,
      await fingerprintOf(received),
      "the identity names the stored key"
    );
  });
});

/**
 * An adoption that stopped after naming the new key and before recording it
 * settles on whichever key the store holds, so a crash between the two never
 * leaves the device refusing both.
 */
add_task(async function an_interrupted_adoption_settles_on_the_stored_key() {
  // Stopped before the write: the store still holds the old key.
  await withIdentityFile("adopt-before", async path => {
    await SvalIdentity.localKey();
    const old = await SvalIdentity.mintSyncKey();
    const received = new Uint8Array(32).fill(4);
    const identity = await IOUtils.readJSON(path);
    identity.adoptingSyncKeyFingerprint = await fingerprintOf(received);
    await IOUtils.writeJSON(path, identity);

    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "the old key is used");
    Assert.ok(same(sync.bytes, old), "it is the old key");
    Assert.equal(
      (await IOUtils.readJSON(path)).adoptingSyncKeyFingerprint,
      undefined,
      "the unfinished adoption is forgotten"
    );
  });

  // Stopped after the write: the store holds the new key.
  await withIdentityFile("adopt-after", async path => {
    await SvalIdentity.localKey();
    await SvalIdentity.mintSyncKey();
    const received = new Uint8Array(32).fill(4);
    const identity = await IOUtils.readJSON(path);
    identity.adoptingSyncKeyFingerprint = await fingerprintOf(received);
    await IOUtils.writeJSON(path, identity);
    await SvalSecretStore.write("sync key", received);

    const sync = await SvalIdentity.syncKey();
    Assert.equal(sync.state, SYNC_KEY_STATES.present, "the new key is used");
    Assert.ok(same(sync.bytes, received), "it is the received key");
    Assert.equal(
      (await IOUtils.readJSON(path)).syncKeyFingerprint,
      await fingerprintOf(received),
      "and recorded"
    );
  });
});

/**
 * Every stored sync key also goes to iCloud Keychain, where a signed build
 * can reach it, and the key is stored whatever that answers (decision 0084).
 */
add_task(async function a_stored_key_also_goes_to_icloud_keychain() {
  const { SvalICloudKeychain } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalICloudKeychain.sys.mjs"
  );
  const realStore = SvalICloudKeychain.store;
  const stored = [];
  SvalICloudKeychain.store = bytes => {
    stored.push(Array.from(bytes));
    return SvalICloudKeychain.STATUS.missingEntitlement;
  };
  try {
    await withIdentityFile("icloud", async () => {
      await SvalIdentity.localKey();
      const minted = await SvalIdentity.mintSyncKey();
      const received = new Uint8Array(32).fill(4);
      await SvalIdentity.adoptSyncKey(received);
      Assert.deepEqual(
        stored,
        [Array.from(minted), Array.from(received)],
        "the made key and the received one both went"
      );
      Assert.ok(
        same((await SvalIdentity.syncKey()).bytes, received),
        "and a refusal there kept nothing from being stored"
      );
    });
  } finally {
    SvalICloudKeychain.store = realStore;
  }
});
