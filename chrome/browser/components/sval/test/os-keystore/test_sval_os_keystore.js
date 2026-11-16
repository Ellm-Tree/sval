/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * A secret is sealed under a system secret the platform's store holds, reads
 * back once the store is asked again, is replaced and is removed. Removing it
 * leaves the system secret, which every profile of the user shares.
 */
add_task(
  { skip_if },
  async function a_secret_round_trips_through_the_system_store() {
    await withLabel(async label => {
      const first = randomBytes();
      const second = randomBytes();

      await step(SvalSecretStore.write("a-secret", first), "the first write");
      Assert.equal(
        await SvalSecretStore.backend(),
        BACKENDS.system,
        "kept in the system store"
      );
      Assert.ok(
        await step(keyStore.asyncSecretAvailable(label), "asking the store"),
        "the platform's store holds the label's secret"
      );
      const file = await IOUtils.readJSON(secretsFile());
      Assert.equal(file.label, label, "the file names the label");
      Assert.notEqual(
        file.secrets["a-secret"],
        first.toBase64(),
        "the file does not hold the secret as written"
      );

      SvalSecretStore.retry();
      Assert.ok(
        same(await step(SvalSecretStore.read("a-secret"), "a read"), first),
        "reads back through a fresh read of the system secret"
      );
      Assert.equal(
        await step(SvalSecretStore.read("another"), "a read"),
        null,
        "a name never written is absent"
      );

      await step(SvalSecretStore.write("a-secret", second), "the replacement");
      SvalSecretStore.retry();
      Assert.ok(
        same(await step(SvalSecretStore.read("a-secret"), "a read"), second),
        "the replacement reads back"
      );

      await step(SvalSecretStore.remove("a-secret"), "the removal");
      Assert.equal(
        await step(SvalSecretStore.read("a-secret"), "a read"),
        null,
        "a removed secret is absent"
      );
      Assert.ok(
        await step(keyStore.asyncSecretAvailable(label), "asking the store"),
        "the system secret stays"
      );
    });
  }
);

/**
 * A copy wrapped for the shared folder opens with this user's system secret,
 * and not with another label's.
 */
add_task(
  { skip_if },
  async function a_wrapped_copy_opens_only_under_its_label() {
    await withLabel(async label => {
      const bytes = randomBytes();
      const wrapped = await step(SvalSecretStore.wrap(bytes), "wrapping");
      Assert.equal(typeof wrapped, "string", "wrapped under the system secret");
      Assert.ok(
        await step(keyStore.asyncSecretAvailable(label), "asking the store"),
        "wrapping made the system secret"
      );
      SvalSecretStore.retry();
      Assert.ok(
        same(await step(SvalSecretStore.unwrap(wrapped), "unwrapping"), bytes),
        "unwraps through a fresh read of the system secret"
      );

      const other = `${label} other`;
      labels.push(other);
      Services.prefs.setStringPref(TEST_LABEL_PREF, other);
      SvalSecretStore.retry();
      Assert.equal(
        await step(SvalSecretStore.unwrap(wrapped), "unwrapping"),
        null,
        "another label's system secret does not open it"
      );
      Assert.equal(
        await step(SvalSecretStore.unwrap("not a sealed copy"), "unwrapping"),
        null,
        "nothing that is not a sealed copy opens"
      );
    });
  }
);

/**
 * A store that no longer holds the label's secret, as on a new computer or
 * after a Windows password reset, leaves the secrets lost. A write beside them
 * refuses to make a new system secret, which would leave them unopenable for
 * good and turn a key pairing can bring back into one that reads as a store
 * refusing. Replacing the one secret that depends on it is what pairing does.
 */
add_task(
  { skip_if },
  async function a_secret_whose_system_secret_is_gone_is_lost() {
    await withLabel(async label => {
      await step(SvalSecretStore.write("a-secret", randomBytes()), "a write");
      await step(
        keyStore.asyncDeleteSecret(label),
        "removing the system secret"
      );
      Assert.ok(
        !(await step(keyStore.asyncSecretAvailable(label), "asking the store")),
        "the store holds no secret for the label"
      );

      SvalSecretStore.retry();
      await Assert.rejects(
        step(SvalSecretStore.read("a-secret"), "a read"),
        e => e instanceof SvalSecretStore.LostError,
        "a read finds the secret lost"
      );
      await Assert.rejects(
        step(SvalSecretStore.write("another", randomBytes()), "a write"),
        e => e instanceof SvalSecretStore.LostError,
        "a write beside it is refused"
      );
      Assert.ok(
        !(await step(keyStore.asyncSecretAvailable(label), "asking the store")),
        "no new system secret was made"
      );

      const paired = randomBytes();
      await step(SvalSecretStore.write("a-secret", paired), "a write");
      Assert.ok(
        same(await step(SvalSecretStore.read("a-secret"), "a read"), paired),
        "the secret itself can be written again"
      );
    });
  }
);
