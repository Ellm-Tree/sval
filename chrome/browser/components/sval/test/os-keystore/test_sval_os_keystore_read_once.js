/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * On macOS each read of the system store by a build the Keychain does not
 * trust is a prompt, so a run reads it once however many secrets it keeps:
 * with the store stopped after that read, every secret still opens.
 */
add_task(
  { skip_if: () => skip_if() || !STOPPABLE },
  async function the_system_store_is_read_once_per_run() {
    await withLabel(async () => {
      await step(SvalSecretStore.write("one", randomBytes()), "a write");
      const two = randomBytes();
      await step(SvalSecretStore.write("two", two), "a write");
      SvalSecretStore.retry();
      await step(SvalSecretStore.read("one"), "the run's one read");

      await control("stop");
      Assert.ok(
        same(await step(SvalSecretStore.read("two"), "a read"), two),
        "another secret opens"
      );
      const three = randomBytes();
      await step(SvalSecretStore.write("two", three), "a write");
      Assert.ok(
        same(await step(SvalSecretStore.read("two"), "a read"), three),
        "a replacement is sealed and opens"
      );
      const wrapped = await step(SvalSecretStore.wrap(three), "wrapping");
      Assert.ok(
        same(await step(SvalSecretStore.unwrap(wrapped), "unwrapping"), three),
        "and a copy is wrapped and opens"
      );
    });
  }
);
