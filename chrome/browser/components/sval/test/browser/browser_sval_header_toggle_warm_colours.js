/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's panel toggle and history button in a window of each warm
 * workspace colour: each says whether its panel shows, to a screen reader
 * and to the eye. `browser_sval_header_toggle_cool_colours.js` has the rest
 * of the palette.
 */

/* import-globals-from head.js */
/* import-globals-from sval_header_toggle_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_header_toggle_helpers.js",
  this
);

add_task(async function a_warm_coloured_window_shows_its_toggles_state() {
  await checkColouredWindows(["orange", "yellow", "pink", "red"]);
});
