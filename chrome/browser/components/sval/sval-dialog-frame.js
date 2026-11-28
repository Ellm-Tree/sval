/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Fits one of Firefox's dialogs, dressed in Sval's design by
 * `SvalPageStyle.styleDialog`, to the browser window's modal box, with the
 * window's palette (`SvalDialogBox.fitFrame`). Sval's own dialogs draw their
 * card as `sval-dialog`, which fits the box itself.
 */

"use strict";

{
  const start = () => {
    const { fitFrame } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
    );
    fitFrame(document);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
