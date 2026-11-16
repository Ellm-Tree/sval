/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import path from "node:path";
import rule from "../lib/rules/numbered-name.mjs";
import { ruleTester } from "./helpers.mjs";

const at = name =>
  path.join("/tree/browser/components/sval/test/browser", name);

ruleTester.run("numbered-name", rule, {
  valid: [
    "browser_sval_panel.js",
    "test_sval_sha256.js",
    "test_sval_2fa_codes.js",
  ].map(name => ({ code: "", filename: at(name) })),
  invalid: ["browser_sval_panel_2.js", "test_sval_sync_10.js"].map(name => ({
    code: "",
    filename: at(name),
    errors: [{ messageId: "numbered" }],
  })),
});
