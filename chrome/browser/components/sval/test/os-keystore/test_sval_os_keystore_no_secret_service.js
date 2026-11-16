/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert */
/* import-globals-from head_os_keystore.js */

/**
 * A Linux machine whose Secret Service does not answer at the first write
 * keeps the secrets in the profile, readable by its owner alone, and keeps
 * them there once a keyring appears. It has no system secret to wrap a copy
 * with.
 */
add_task(
  { skip_if: () => skip_if() || AppConstants.platform !== "linux" },
  async function a_linux_machine_with_no_secret_service_keeps_them_in_the_profile() {
    await withLabel(async label => {
      const bytes = randomBytes();
      await control("stop");
      await step(SvalSecretStore.write("a-secret", bytes), "the first write");
      Assert.equal(
        await SvalSecretStore.backend(),
        BACKENDS.profile,
        "kept in the profile"
      );
      Assert.ok(
        same(await step(SvalSecretStore.read("a-secret"), "a read"), bytes),
        "reads back"
      );
      const { permissions } = await IOUtils.stat(secretsFile());
      Assert.equal(
        permissions & 0o777,
        0o600,
        `the secrets file is mode 0600, not ${(permissions & 0o777).toString(8)}`
      );
      Assert.equal(
        await step(SvalSecretStore.wrap(bytes), "wrapping"),
        null,
        "nothing to wrap a copy with"
      );

      await control("start");
      SvalSecretStore.retry();
      await step(SvalSecretStore.write("another", randomBytes()), "a write");
      Assert.equal(
        await SvalSecretStore.backend(),
        BACKENDS.profile,
        "still kept in the profile"
      );
      Assert.ok(
        !(await step(keyStore.asyncSecretAvailable(label), "asking the store")),
        "no system secret was made"
      );
    });
  }
);
