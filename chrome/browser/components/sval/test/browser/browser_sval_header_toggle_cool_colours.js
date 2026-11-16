/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's panel toggle and history button in a window of each cool
 * workspace colour: each says whether its panel shows, to a screen reader
 * and to the eye. `browser_sval_header_toggle_warm_colours.js` has the rest
 * of the palette.
 */

/* import-globals-from head.js */
/* import-globals-from sval_header_toggle_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_header_toggle_helpers.js",
  this
);

/** The toolbar wears each cool colour's tint in turn. */
add_task(async function a_cool_coloured_window_shows_its_toggles_state() {
  await checkColouredWindows(["blue", "purple", "cyan", "green", "gray"]);
});
