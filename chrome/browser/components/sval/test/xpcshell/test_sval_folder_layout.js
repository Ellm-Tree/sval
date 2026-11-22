/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The shared folder's layout and the reading of a pick are the engine's
 * (spec §6.4), so the desktop and the iPhone agree on both. `TOP_DIR` is read
 * where no engine call can be awaited, so it must spell the engine's name.
 */

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine, TOP_DIR } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

add_task(
  async function the_desktop_reads_the_folder_as_the_engine_lays_it_out() {
    const root = await makeTempDir("sval-folder-layout");
    const engine = new SvalEngine({
      root,
      sharedRoot: root,
      keyBytes: crypto.getRandomValues(new Uint8Array(32)),
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => engine.terminate());

    Assert.equal(await engine.topDirName(), TOP_DIR, "one name for sval/");
    Assert.ok(await engine.isTopDirName(TOP_DIR), "a pick of sval/ itself");
    for (const name of ["Sval", "SVAL", "sval ", "ws", ""]) {
      Assert.ok(!(await engine.isTopDirName(name)), `a pick of ${name}`);
    }
  }
);
