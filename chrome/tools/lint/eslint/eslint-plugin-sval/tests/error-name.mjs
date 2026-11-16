/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/error-name.mjs";
import { ruleTester } from "./helpers.mjs";

const MODULE = "/tree/browser/components/sval/SvalExample.sys.mjs";
const ok = code => ({ code, filename: MODULE });
const bad = (code, output, count = 1) => ({
  code,
  output,
  filename: MODULE,
  errors: Array.from({ length: count }, () => ({ messageId: "bare" })),
});

ruleTester.run("error-name", rule, {
  valid: [
    ok("SvalLog.warn(`x: ${SvalLog.errorName(err)}`);"),
    ok("SvalLog.warn(`x: ${describeError(err)}`);"),
    // A name that is not an error's.
    ok("SvalLog.info(`tool ${tool.name} ran`);"),
    // A comparison reads the name without logging it.
    ok("SvalLog.warn(err?.name === 'AbortError' ? 'stopped' : 'failed');"),
    // Not Sval's log.
    ok("console.warn(`x: ${err?.name}`);"),
    ok("other.warn(`x: ${err?.name}`);"),
  ],
  invalid: [
    bad(
      "SvalLog.warn(`x: ${err?.name}`);",
      "SvalLog.warn(`x: ${SvalLog.errorName(err)}`);"
    ),
    bad(
      'lazy.SvalLog.error(`x: ${e.name ?? "Error"}`);',
      "lazy.SvalLog.error(`x: ${lazy.SvalLog.errorName(e)}`);"
    ),
    bad(
      'this._modules.SvalLog.warn("x: " + error.name);',
      'this._modules.SvalLog.warn("x: " + this._modules.SvalLog.errorName(error));'
    ),
    bad(
      "SvalLog.debug(`x: ${err.cause?.name}`);",
      "SvalLog.debug(`x: ${SvalLog.errorName(err.cause)}`);"
    ),
    bad(
      'SvalLog.warn(`a ${readError?.name || "Error"} b ${ex.name}`);',
      "SvalLog.warn(`a ${SvalLog.errorName(readError)} b ${SvalLog.errorName(ex)}`);",
      2
    ),
  ],
});
