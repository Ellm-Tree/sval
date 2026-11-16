/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The cryptography of Kagi's Privacy Pass issuance (Kagi Privacy Pass spec),
 * which the engine does (`docs/host-contract.md` §12).
 *
 * A worker because the engine is WASM, and the parent process's system CSP
 * refuses to compile WASM on the main thread. It is a worker of its own so
 * that the code that sees the client state has no file, sync or tree code in
 * reach, and so that it lives only for one refill: `SvalKagiPrivacyPass`
 * terminates it once the tokens are in.
 */

import initWasm, {
  kagiTokenRequest,
  kagiTokenFinalize,
} from "chrome://browser/content/sval/sval_core.mjs";
import {
  SvalError,
  describe,
  loadEngine,
  serve,
} from "chrome://browser/content/sval/SvalWorkerHost.mjs";

let ready = null;

async function ensureReady() {
  ready ??= loadEngine(initWasm).catch(err => {
    ready = null;
    throw new SvalError(
      `sval: the engine failed to load: ${describe(err)}`,
      err
    );
  });
  await ready;
}

const methods = {
  /** Loads the engine, which says whether this build has one. */
  async ready() {
    await ensureReady();
  },

  /**
   * @param {object} options
   * @param {string} options.challenge Kagi's `WWW-Authenticate` value.
   * @param {number} options.count How many tokens to ask for.
   * @returns {Promise<{body: string, state: string}>}
   */
  async tokenRequest({ challenge, count }) {
    await ensureReady();
    try {
      const request = kagiTokenRequest(challenge, count);
      const answer = { body: request.body, state: request.state };
      request.free();
      return answer;
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  },

  /**
   * @param {object} options
   * @param {string} options.state What `tokenRequest` answered.
   * @param {string} options.response Kagi's answer, as text.
   * @returns {Promise<string[]>} the tokens.
   */
  async finalize({ state, response }) {
    await ensureReady();
    try {
      return kagiTokenFinalize(state, response);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  },
};

// The engine's message never carries a token, a state or a key.
serve(method => (Object.hasOwn(methods, method) ? methods[method] : undefined));
