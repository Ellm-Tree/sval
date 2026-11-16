/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A loopback agent client for the listener's tests, in both suites, speaking
 * the wire as sval-mcp does (agent-control spec §3.2):
 *
 *   const { SvalTestAgentClient } = ChromeUtils.importESModule(
 *     "resource://testing-common/SvalTestAgentClient.sys.mjs"
 *   );
 *
 * Its HMAC is computed here with WebCrypto, apart from `SvalAgentWire`'s
 * proofs, so a test checks Sval's proof against an answer Sval did not make.
 * The nonce and hex encoding are `SvalAgentWire`'s own.
 */

import {
  encodeFrame,
  FrameDecoder,
  freshNonce,
} from "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs";
import { toHex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";
import { within } from "resource://testing-common/SvalTestWait.sys.mjs";

/** How long a task waits for a frame from Sval, or for Sval to hang up. */
const FRAME_MS = 10_000;

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream"
);
const BinaryOutputStream = Components.Constructor(
  "@mozilla.org/binaryoutputstream;1",
  "nsIBinaryOutputStream",
  "setOutputStream"
);

export const SvalTestAgentClient = {
  /**
   * Opens a connection to `port` and decodes what Sval sends. Every frame is
   * kept in `frames`; `next()` hands them out in order, and `waitFor` finds
   * one by what it holds, each as soon as the frame arrives.
   *
   * @param {number} port
   * @returns {object} `send(bytes)`, `sendFrame(message)`, `next()`,
   *   `waitFor(match, ms)`, `frames`, `unread()`, `onFrame(fn)`, which tells
   *   `fn` of each frame from then on, `closed`, which settles once Sval has
   *   closed the connection, `ended`, the same unbounded, for a wait that
   *   races it, and `close()`.
   */
  connectRaw(port) {
    const sts = Cc[
      "@mozilla.org/network/socket-transport-service;1"
    ].getService(Ci.nsISocketTransportService);
    const transport = sts.createTransport([], "127.0.0.1", port, null, null);
    const out = new BinaryOutputStream(transport.openOutputStream(0, 0, 0));
    const input = transport.openInputStream(0, 0, 0);
    const decoder = new FrameDecoder();
    const frames = [];
    let read = 0;
    // Each waiter answers with what it waited for, or undefined to wait on.
    // They are asked in the order they came, so `next()` keeps frame order.
    const waiters = [];
    const listeners = new Set();
    const until = answer => {
      const now = answer();
      if (now !== undefined) {
        return Promise.resolve(now);
      }
      const { promise, resolve } = Promise.withResolvers();
      waiters.push({ answer, resolve });
      return promise;
    };
    const { promise: closed, resolve: onClosed } = Promise.withResolvers();
    const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    pump.init(input, 0, 0, false);
    pump.asyncRead({
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
      ]),
      onStartRequest() {},
      onDataAvailable(_request, stream, _offset, count) {
        const buffer = new ArrayBuffer(count);
        new BinaryInputStream(stream).readArrayBuffer(count, buffer);
        const arrived = decoder.push(new Uint8Array(buffer));
        frames.push(...arrived);
        for (const frame of arrived) {
          for (const listener of listeners) {
            listener(frame);
          }
        }
        for (const waiter of [...waiters]) {
          const value = waiter.answer();
          if (value !== undefined) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(value);
          }
        }
      },
      onStopRequest() {
        onClosed();
      },
    });
    const send = bytes => out.writeByteArray(Array.from(bytes));
    return {
      frames,
      send,
      sendFrame: message => send(encodeFrame(message)),
      /** @returns {Promise<object>} The next frame `next` has not given. */
      next: () =>
        within(
          until(() => (read < frames.length ? frames[read++] : undefined)),
          FRAME_MS,
          "the next frame from Sval"
        ),
      /**
       * @param {Function} match Takes a frame.
       * @param {number} [ms] How long to wait for it, `FRAME_MS` unless the
       *   frame answers a call that may wait for the user.
       * @returns {Promise<object>} The first frame `match` is true of.
       */
      waitFor: (match, ms = FRAME_MS) =>
        within(
          until(() => frames.find(match)),
          ms,
          "the frame waited for from Sval"
        ),
      /** @param {Function} fn Takes each frame that arrives from now on. */
      onFrame: fn => listeners.add(fn),
      /** @returns {number} How many frames `next` has not given yet. */
      unread: () => frames.length - read,
      // A getter, so the bound starts when a task waits, not at connection.
      get closed() {
        return within(closed, FRAME_MS, "Sval closing the connection");
      },
      ended: closed,
      close: () => transport.close(Cr.NS_OK),
    };
  },

  /**
   * Connects to `port` and challenges Sval as sval-mcp does, with a fresh
   * nonce, before anything else is sent. Whether Sval's answer is right is
   * the test's to check, against `mac(token, "sval:" + nonce)`.
   *
   * @param {number} port
   * @param {string} token The port file's token.
   * @returns {Promise<object>} The client, as `connectRaw` returns it, with
   *   the `nonce` it sent, Sval's answer `ctl`, Sval's `challenge`, and
   *   `proof`, the agent's answer to that challenge.
   */
  async connect(port, token) {
    const c = this.connectRaw(port);
    c.nonce = freshNonce();
    c.sendFrame({ challenge: c.nonce });
    const { ctl } = await c.next();
    c.ctl = ctl;
    c.challenge = ctl.challenge;
    c.proof = await this.mac(token, `agent:${ctl.challenge}`);
    return c;
  },

  /**
   * The hex HMAC-SHA256 of `message`'s text, keyed by the token's text. Sval
   * answers a nonce with the MAC of `"sval:" + nonce`, and an agent answers
   * Sval's with the MAC of `"agent:" + nonce`.
   *
   * @param {string} token
   * @param {string} message
   * @returns {Promise<string>}
   */
  async mac(token, message) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const bytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    );
    return toHex(new Uint8Array(bytes));
  },
};
