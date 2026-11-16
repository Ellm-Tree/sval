/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What every engine worker shares: the one error type that crosses
 * `PromiseWorker`, how a failure is described, the engine's loading and the
 * `PromiseWorker` wiring. A plain module beside `SvalDocumentOps.mjs`, because
 * workers import it; it reaches no file, socket or pref, so the private
 * worker may import it (`test_sval_private.js`). The parent side is
 * `SvalWorkerClient.sys.mjs`.
 */

import { PromiseWorker } from "resource://gre/modules/workers/PromiseWorker.mjs";

/**
 * The engine module and its wasm sit beside each other in Sval's own jar
 * entries, so a worker fetches the wasm itself rather than having the parent
 * post bytes in. A ChromeWorker can read a `chrome://` URL directly.
 */
const WASM_URL = "chrome://browser/content/sval/sval_core_bg.wasm";

/**
 * The name the parent's `ExceptionHandlers` entry is keyed on. Every failure
 * a worker reports travels under it.
 */
export const SVAL_ERROR = "SvalError";

/**
 * Every rejection that leaves a worker is one of these.
 *
 * `wasm-bindgen` surfaces a `Result<T, JsValue>` error as a thrown **string
 * primitive**, and `PromiseWorker`'s serialiser evaluates `"toMsg" in exn`
 * while deciding how to send an exception on, which throws a `TypeError` on a
 * primitive. A string out of the engine would therefore reach the caller as a
 * complaint about the `in` operator with the engine's own message nowhere in
 * it. Funnelling everything through one self-serialising type also gives
 * every failure the `sval:` prefix, so a message in a console or a bug report
 * says which component produced it.
 */
export class SvalError extends Error {
  /**
   * @param {string} message What failed, for people.
   * @param {*} [cause] What was caught, if anything. An engine failure carries
   *   a `code`, and an `invalid_argument` a `reason` (`docs/host-contract.md`
   *   §8), which callers branch on and which this keeps.
   */
  constructor(message, cause) {
    super(message);
    this.name = SVAL_ERROR;
    this.code = cause?.code ?? null;
    this.reason = cause?.reason ?? null;
  }

  toMsg() {
    return {
      exn: SVAL_ERROR,
      message: this.message,
      code: this.code,
      reason: this.reason,
    };
  }
}

/**
 * What to hand `SvalError` as the cause so that its `code` names the failure.
 * A `DOMException` from `IOUtils` carries the kind in `.name`
 * (`NotAllowedError`, `NotReadableError`) and a legacy numeric `.code` that
 * is 0 for those, so the name is the only thing that tells them apart. An
 * engine failure keeps its own string `code`.
 *
 * @param {*} err Anything a `throw` or a rejection produced.
 * @returns {{code: string|null}}
 */
export function causeNamed(err) {
  if (typeof err?.code === "string") {
    return { code: err.code };
  }
  const kind = err?.name;
  return { code: kind && kind !== "Error" ? kind : null };
}

/**
 * Turns anything throwable into a message a user could act on. A
 * `DOMException` from `IOUtils` names the failure kind in `.name` and
 * describes it in `.message`, and both are worth keeping. A plain `Error`,
 * which is what the engine throws, says nothing more in its name.
 *
 * @param {*} err Anything a `throw` or a rejection produced.
 * @returns {string} A message naming both what failed and how.
 */
export function describe(err) {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object") {
    const kind = err.name === "Error" ? null : err.name;
    const message = err.message ?? String(err);
    return kind && !message.startsWith(kind) ? `${kind}: ${message}` : message;
  }
  return String(err);
}

/**
 * Loads the engine into this worker.
 *
 * The bytes are fetched here rather than handed to the glue as a URL. Given a
 * URL the glue reaches for `WebAssembly.instantiateStreaming`, which requires
 * the response's Content-Type to be exactly `application/wasm`; the chrome
 * protocol answers `application/wasm;charset=utf-8`, so streaming always
 * fails, the glue warns on every launch, and it falls back to the byte path
 * anyway. Taking the byte path directly is the same work without the failed
 * attempt or the warning.
 *
 * @param {Function} initWasm The engine module's default export.
 * @returns {Promise<void>}
 */
export async function loadEngine(initWasm) {
  const wasmBytes = await (await fetch(WASM_URL)).arrayBuffer();
  await initWasm({ module_or_path: wasmBytes });
}

/**
 * Answers the parent's `BasePromiseWorker` calls.
 *
 * @param {(method: string) => Function|undefined} methodOf The function a
 *   call by that name runs, or undefined for a name the worker does not have.
 */
export function serve(methodOf) {
  const worker = new PromiseWorker.AbstractWorker();
  worker.dispatch = (method, args = []) => {
    const run = methodOf(method);
    if (typeof run !== "function") {
      throw new SvalError(`sval: no such worker method "${method}"`);
    }
    return run(...args);
  };
  worker.close = () => self.close();
  worker.postMessage = (message, ...transfers) => {
    self.postMessage(message, ...transfers);
  };
  self.addEventListener("message", msg => worker.handleMessage(msg));
  self.addEventListener("unhandledrejection", function (error) {
    throw error.reason;
  });
}
