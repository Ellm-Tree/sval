/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * A first write a locked Keychain refuses, as a denied prompt does, is an
 * unreadable store and writes nothing, and the next write asks the store
 * again: that second ask is what shows the user the prompt again. Linux
 * takes a refusal there for a machine with no keyring (below).
 */
add_task(
  { skip_if: () => skip_if() || AppConstants.platform !== "macosx" },
  async function a_refused_first_write_asks_again_next_time() {
    await withLabel(async label => {
      // An item an earlier install left, which a Mac asks before reading.
      await step(keyStore.asyncGenerateSecret(label), "making the item");
      await control("stop");
      const bytes = randomBytes();
      await Assert.rejects(
        step(SvalSecretStore.write("sync key", bytes), "the first write"),
        e => e instanceof SvalSecretStore.UnreadableError,
        "a refusal is an unreadable store"
      );
      Assert.ok(!(await IOUtils.exists(secretsFile())), "nothing is written");

      await control("start");
      await step(SvalSecretStore.write("sync key", bytes), "the next write");
      Assert.equal(
        await SvalSecretStore.backend(),
        BACKENDS.system,
        "kept in the system store"
      );
      Assert.ok(
        same(await step(SvalSecretStore.read("sync key"), "a read"), bytes),
        "and reads back"
      );
    });
  }
);
