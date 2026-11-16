/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/panel-getter.mjs";
import { passes, ruleTester, task } from "./helpers.mjs";

const fixed = (code, output) => ({
  ...passes(task(code)),
  output: task(output),
  errors: [{ messageId: "getter" }],
});

ruleTester.run("panel-getter", rule, {
  valid: [
    passes(task("Assert.equal(SvalPanel.workspaceId, id);")),
    passes(task("SvalPanel._currentWorkspaceId = id;")),
    passes(task("delete SvalPanel._nodes;")),
    passes(task("await SvalPanel._promptForNewGroup();")),
    passes(task("Assert.equal(other._currentWorkspaceId, id);")),
    passes(task('await within(SvalPanel.started, 10_000, "start");')),
  ],
  invalid: [
    fixed(
      "Assert.equal(SvalPanel._currentWorkspaceId, id);",
      "Assert.equal(SvalPanel.workspaceId, id);"
    ),
    fixed(
      "await win.SvalPanel._engine.tree();",
      "await win.SvalPanel.engine.tree();"
    ),
    fixed(
      "const id = w.SvalPanel?._currentWorkspaceId;",
      "const id = w.SvalPanel?.workspaceId;"
    ),
    fixed(
      'await within(SvalPanel._started.promise, 10_000, "start");',
      'await within(SvalPanel.started, 10_000, "start");'
    ),
  ],
});
