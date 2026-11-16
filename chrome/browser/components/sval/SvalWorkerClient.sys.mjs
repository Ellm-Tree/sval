/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The parent side of an engine worker (`SvalWorkerHost.mjs`).
 */

import { BasePromiseWorker } from "resource://gre/modules/PromiseWorker.sys.mjs";

/** As `SvalWorkerHost.mjs` names it. */
const SVAL_ERROR = "SvalError";

/**
 * A `BasePromiseWorker` that rebuilds the worker's `SvalError`s, code and reason
 * and all.
 * `BasePromiseWorker` looks a serialised exception's name up in
 * `ExceptionHandlers` and calls the result, so a name with no entry there
 * reaches the caller as a TypeError about calling `undefined` rather than as
 * the message.
 */
export class SvalWorkerClient extends BasePromiseWorker {
  /** @param {string} url The worker module. */
  constructor(url) {
    super(url, { type: "module" });
    this.ExceptionHandlers[SVAL_ERROR] = data => {
      const error = new Error(data.message);
      error.name = SVAL_ERROR;
      error.code = data.code ?? null;
      error.reason = data.reason ?? null;
      return error;
    };
  }
}
