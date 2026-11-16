/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * Where secrets are kept is decided for good by the first write, so a store
 * that refused earlier in the run is asked again then.
 */
add_task(
  { skip_if: () => skip_if() || !STOPPABLE },
  async function an_earlier_refusal_does_not_decide_the_backend() {
    await withLabel(async () => {
      await control("stop");
      Assert.equal(
        await step(SvalSecretStore.unwrap("AAAA"), "unwrapping"),
        null,
        "refused"
      );
      await control("start");

      const bytes = randomBytes();
      await step(SvalSecretStore.write("sync key", bytes), "the first write");
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
