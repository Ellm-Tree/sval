/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A native mouse event sent through `EventUtils` directly. It goes to
 * a point on the screen, through the platform, and each platform treats a
 * point the window does not cover in its own way: Windows moves a point off
 * the screen to the screen's edge (`SetCursorPos`), and Windows and GTK pass
 * a press in a popup's shadow margin to the window below. The browser tests'
 * head.js has `nativeMouse(options)`, which checks the point lies on the
 * screen and over the window before it sends, and `moveWindowOnScreen(win)`.
 */

import { isQualified } from "../ast.mjs";

/** `EventUtils`' native mouse senders. */
const SENDERS = [
  "promiseNativeMouseEvent",
  "promiseNativeMouseEventAndWaitForEvent",
  "synthesizeNativeMouseEvent",
  "synthesizeNativeMouseEventAndWaitForEvent",
];

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires native mouse events to go through head.js",
    },
    messages: {
      native:
        "a native mouse event goes to a point on the screen, which each platform clamps or passes through in its own way; use nativeMouse(options) after moveWindowOnScreen(win)",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          SENDERS.some(name => isQualified(node.callee, "EventUtils", name))
        ) {
          context.report({ node: node.callee.property, messageId: "native" });
        }
      },
    };
  },
};
