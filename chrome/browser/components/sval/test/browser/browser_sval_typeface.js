/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Outfit, the face `sval-type.css` sets the browser window's chrome in, is
 * loaded in the window.
 */

const OUTFIT = "Outfit";

add_task(async function test_outfit_has_loaded() {
  await within(document.fonts.ready, 10_000, "the window's fonts");
  Assert.ok(
    [...document.fonts].some(
      face =>
        face.family.replaceAll('"', "") === OUTFIT && face.status === "loaded"
    ),
    "the window has Outfit loaded"
  );
});
