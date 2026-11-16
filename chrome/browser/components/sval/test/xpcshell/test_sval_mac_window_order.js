/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The widget's window ordering is reachable from the chrome on macOS, and
 * does nothing where there is no window to order.
 */

"use strict";

add_task(function the_widget_offers_window_ordering() {
  const order = Cc["@sval/mac-window-order;1"].getService(
    Ci.nsISvalMacWindowOrder
  );
  // xpcshell has no key window, so there is no app to hand activation to.
  order.passActivationBehind();
  Assert.throws(
    () => order.bringForward(null),
    err => err.result === Cr.NS_ERROR_INVALID_ARG,
    "a window is needed to bring one forward"
  );
});
