/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The frames agents and Sval exchange over the loopback socket
 * (agent-control spec §3.3): a 4-byte big-endian length, then that many bytes
 * of UTF-8 JSON holding one object. Also the proofs each side makes that it
 * can read the port file's token.
 *
 * The length limit is also what keeps web pages out. A page can reach a
 * localhost port only by speaking HTTP or TLS, and their first four bytes,
 * read as a length, are hundreds of megabytes. They are refused before a body
 * is buffered.
 *
 * A proof is the lowercase hex HMAC-SHA256 of a prefix and a nonce, keyed by
 * the UTF-8 of the token's text. Sval answers `sval-mcp`'s nonce with the MAC of
 * `"sval:" + nonce`, and `sval-mcp` answers Sval's with the MAC of
 * `"agent:" + nonce`. The prefixes stop reflection: Sval never makes an
 * `"agent:"` MAC, so nothing it says can be replayed as a client's proof, and
 * the reverse holds in `sval-mcp`. `tools/sval-mcp/src/proof.rs` is the other
 * half, and both test suites pin the same independently computed vectors.
 */

import { ERRORS } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  refusal,
  toMcp,
} from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import { toHex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

export const MAX_FRAME_BYTES = 1024 * 1024;

/** A token, a nonce or a proof: 32 bytes as 64 lowercase hex characters. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** @returns {string} 32 fresh random bytes as 64 lowercase hex characters. */
export function freshNonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The key both proofs are made with.
 *
 * @param {string} token The port file's token.
 * @returns {Promise<CryptoKey>}
 */
export function proofKey(token) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Sval's answer to `sval-mcp`'s challenge.
 *
 * @param {CryptoKey} key From `proofKey`.
 * @param {string} nonce The challenge, already checked against `HEX64`.
 * @returns {Promise<string>} Lowercase hex.
 */
export async function svalProof(key, nonce) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`sval:${nonce}`)
  );
  return toHex(new Uint8Array(mac));
}

/**
 * Whether `proof` is an agent's answer to Sval's challenge `nonce`. Anything
 * but 64 lowercase hex characters fails. `crypto.subtle.verify` compares in
 * constant time (`NSS_SecureMemcmp`, dom/crypto/WebCryptoTask.cpp).
 *
 * @param {CryptoKey} key From `proofKey`.
 * @param {string} nonce The challenge Sval sent.
 * @param {unknown} proof What the agent's handshake carried.
 * @returns {Promise<boolean>}
 */
export function isAgentProof(key, nonce, proof) {
  if (typeof proof !== "string" || !HEX64.test(proof)) {
    return Promise.resolve(false);
  }
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.fromHex(proof),
    new TextEncoder().encode(`agent:${nonce}`)
  );
}

/** Thrown for bytes that are not a well-formed frame. */
export class SvalAgentWireError extends Error {
  constructor(message) {
    super(message);
    this.name = "SvalAgentWireError";
  }
}

/**
 * The reply that stands in for one too large for a frame: the same request
 * answered with `result_too_large`, as a failed tool call when the reply was
 * a tool result and as a JSON-RPC error otherwise. One large result then
 * fails one call and leaves the connection open.
 *
 * @param {object} mcp The JSON-RPC reply that did not fit.
 * @returns {object} A frame.
 */
function tooLarge(mcp) {
  if (Array.isArray(mcp.result?.content)) {
    return {
      mcp: {
        jsonrpc: "2.0",
        id: mcp.id,
        result: toMcp(refusal("result_too_large")),
      },
    };
  }
  return {
    mcp: {
      jsonrpc: "2.0",
      id: mcp.id,
      error: {
        code: -32603,
        message: `result_too_large: ${ERRORS.result_too_large}`,
        data: { error: "result_too_large" },
      },
    },
  };
}

/**
 * @param {object} message
 * @returns {Uint8Array} The frame. A reply to a request that is too large
 *   is replaced by an error reply to that request (`tooLarge`); anything
 *   else too large throws.
 */
export function encodeFrame(message) {
  let body = new TextEncoder().encode(JSON.stringify(message));
  const mcp = message?.mcp;
  if (
    body.length > MAX_FRAME_BYTES &&
    mcp &&
    typeof mcp === "object" &&
    Object.hasOwn(mcp, "id") &&
    !Object.hasOwn(mcp, "method")
  ) {
    body = new TextEncoder().encode(JSON.stringify(tooLarge(mcp)));
  }
  if (body.length > MAX_FRAME_BYTES) {
    throw new SvalAgentWireError(
      `a frame of ${body.length} bytes exceeds the limit`
    );
  }
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
}

/**
 * Turns a byte stream into messages. Holds a partial frame until the rest
 * arrives. After it throws, the connection is to be closed, never fed again.
 */
export class FrameDecoder {
  /** The bytes read since the last whole frame, as they arrived. */
  #chunks = [];
  #buffered = 0;
  /** The declared length of the frame being read, once its prefix is in. */
  #length = null;
  #utf8 = new TextDecoder("utf-8", { fatal: true });

  /**
   * @param {Uint8Array} bytes The next bytes read.
   * @returns {object[]} Every message those bytes completed, in order.
   */
  push(bytes) {
    if (bytes.length) {
      this.#chunks.push(bytes);
      this.#buffered += bytes.length;
    }
    const messages = [];
    for (;;) {
      if (this.#length === null) {
        if (this.#buffered < 4) {
          break;
        }
        const length = new DataView(this.#take(4).buffer).getUint32(0);
        if (length > MAX_FRAME_BYTES) {
          throw new SvalAgentWireError(
            `a declared frame of ${length} bytes exceeds the limit`
          );
        }
        this.#length = length;
      }
      if (this.#buffered < this.#length) {
        break;
      }
      const body = this.#take(this.#length);
      this.#length = null;
      let message;
      try {
        message = JSON.parse(this.#utf8.decode(body));
      } catch {
        throw new SvalAgentWireError("a frame is not UTF-8 JSON");
      }
      if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message)
      ) {
        throw new SvalAgentWireError("a frame is not a JSON object");
      }
      messages.push(message);
    }
    return messages;
  }

  /**
   * The first `count` buffered bytes, in a buffer of their own, copied once.
   *
   * @param {number} count At most what is buffered.
   * @returns {Uint8Array}
   */
  #take(count) {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.#chunks[0];
      const used = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.length) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = chunk.subarray(used);
      }
    }
    this.#buffered -= count;
    return out;
  }
}
