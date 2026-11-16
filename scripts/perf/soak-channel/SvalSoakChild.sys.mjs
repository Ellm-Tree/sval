/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Runs a soak script in a page, in a sandbox with the page's principal and
// X-rays to its objects, as Marionette's content scripts run. The script gets
// arguments[0], the callback that answers, and click(selectors), which
// presses the first visible match with mouse events the page sees as trusted
// (nsIDOMWindowUtils.sendMouseEvent), as a person's click would be.
export class SvalSoakChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name != "run") {
      return undefined;
    }
    const win = this.contentWindow;
    const sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      wantXrays: true,
      sandboxName: "sval-soak-content",
    });
    const click = selectors => {
      for (const selector of selectors) {
        const el = win.document.querySelector(selector);
        const box = el?.getBoundingClientRect();
        if (!box || !box.width || !box.height) {
          continue;
        }
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const utils = win.windowUtils;
        utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
        utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
        utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
        return selector;
      }
      return null;
    };
    sandbox.click = Cu.exportFunction(click, sandbox);
    return new Promise((resolve, reject) => {
      try {
        const fn = Cu.evalInSandbox(
          `(function () {\n${message.data.script}\n})`,
          sandbox
        );
        fn(Cu.exportFunction(value => resolve(value), sandbox));
      } catch (e) {
        reject(e);
      }
    });
  }
}
