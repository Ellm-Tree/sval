/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Orders Sval's windows among other apps' on macOS, through the widget's
 * nsISvalMacWindowOrder (widget/cocoa/SvalMacWindowOrder.mm, which describes
 * when Sval keeps its windows behind another app's). Elsewhere each call
 * does nothing.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
});

function service() {
  return AppConstants.platform === "macosx"
    ? Cc["@sval/mac-window-order;1"].getService(Ci.nsISvalMacWindowOrder)
    : null;
}

/**
 * Brings `win` in front of the other apps' windows when Sval is the active
 * app and another app's window covers it, as one does after Sval kept its
 * windows behind on being activated to open something.
 *
 * @param {Window|null} win A browser window.
 */
export function bringForward(win) {
  const order = service();
  if (!order || !win) {
    return;
  }
  try {
    order.bringForward(win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow));
  } catch (err) {
    lazy.SvalLog.error(
      `could not bring a window forward: ${lazy.describeError(err)}`
    );
  }
}

/**
 * As the key window closes, hands activation to the app whose window is just
 * behind it, when that is not Sval.
 */
export function passActivationBehind() {
  const order = service();
  if (!order) {
    return;
  }
  try {
    order.passActivationBehind();
  } catch (err) {
    lazy.SvalLog.error(
      `could not hand activation to another app: ${lazy.describeError(err)}`
    );
  }
}

export const SvalMacWindowOrder = {
  bringForward,
  passActivationBehind,
};
