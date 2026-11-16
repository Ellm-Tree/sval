/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * A store that stops answering, a locked Keychain or a Secret Service that
 * has gone, makes the secrets unreadable until it answers again. Credential
 * Manager has no such state.
 */
add_task(
  { skip_if: () => skip_if() || !STOPPABLE },
  async function a_store_that_stops_answering_is_unreadable_until_it_returns() {
    await withLabel(async () => {
      const bytes = randomBytes();
      await step(SvalSecretStore.write("a-secret", bytes), "a write");
      const before = await IOUtils.readUTF8(secretsFile());

      await control("stop");
      SvalSecretStore.retry();
      await Assert.rejects(
        step(SvalSecretStore.read("a-secret"), "a read"),
        e => e instanceof SvalSecretStore.UnreadableError,
        "a read is refused as unreadable"
      );
      await Assert.rejects(
        step(SvalSecretStore.write("another", randomBytes()), "a write"),
        e => e instanceof SvalSecretStore.UnreadableError,
        "a write is refused as unreadable"
      );
      Assert.equal(
        await IOUtils.readUTF8(secretsFile()),
        before,
        "the refused write left the file as it was"
      );

      await control("start");
      await Assert.rejects(
        step(SvalSecretStore.read("a-secret"), "a read"),
        e => e instanceof SvalSecretStore.UnreadableError,
        "the refusal stands for the run, so the user is not asked again"
      );
      SvalSecretStore.retry();
      Assert.ok(
        same(await step(SvalSecretStore.read("a-secret"), "a read"), bytes),
        "the secret reads back once the store answers"
      );
    });
  }
);
