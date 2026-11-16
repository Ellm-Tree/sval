/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * Sval installed again finds its key in the folder and stores it in the new
 * profile. On a Mac each read is a Keychain prompt, so that setup asks once:
 * the first write uses the secret the folder's copy was opened with.
 */
add_task(
  { skip_if: () => skip_if() || !STOPPABLE },
  async function installing_again_reads_the_system_store_once() {
    await withLabel(async () => {
      const key = randomBytes();
      await step(SvalSecretStore.write("sync key", key), "a write");
      const wrapped = await step(SvalSecretStore.wrap(key), "wrapping");

      // A new profile and a new run, with the same user's system store.
      await IOUtils.remove(secretsFile());
      SvalSecretStore.retry();
      const found = await step(SvalSecretStore.unwrap(wrapped), "unwrapping");
      Assert.ok(same(found, key), "the folder's copy opens");

      await control("stop");
      await step(SvalSecretStore.write("sync key", found), "the first write");
      Assert.equal(
        await SvalSecretStore.backend(),
        BACKENDS.system,
        "kept in the system store"
      );
      Assert.ok(
        same(await step(SvalSecretStore.read("sync key"), "a read"), key),
        "stored without asking the store again"
      );
    });
  }
);
