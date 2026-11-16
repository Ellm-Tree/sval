/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A scene of first run's introduction (`first-run-intro.xhtml`) hands its
 * document to the page that framed it (`first-run-intro.js`), which draws
 * the scene there. The frame's own `load` and `DOMFrameContentLoaded` never
 * reach a frame of first run's sheet in the window's dialog box, so the
 * scene says itself when its document is ready.
 */

"use strict";

window.addEventListener(
  "DOMContentLoaded",
  () => window.frameElement?.svalSceneReady?.(document),
  { once: true }
);
