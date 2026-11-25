/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The Firefox Bridge, which wrote a native messaging manifest into Chrome's
 * folders for Mozilla's extension there, is not built, and no pref of its
 * own is left.
 */

add_task(function the_bridge_does_not_ship() {
  Assert.ok(
    !packaged("resource:///modules/FirefoxBridgeExtensionUtils.sys.mjs"),
    "FirefoxBridgeExtensionUtils is not in the package"
  );
  Assert.deepEqual(
    Services.prefs.getDefaultBranch("").getChildList("browser.firefoxbridge."),
    [],
    "no Firefox Bridge pref"
  );
});
