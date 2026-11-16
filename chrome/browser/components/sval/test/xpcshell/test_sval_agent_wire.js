/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const {
  svalProof,
  encodeFrame,
  FrameDecoder,
  isAgentProof,
  MAX_FRAME_BYTES,
  SvalAgentWireError,
  proofKey,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs"
);

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

add_task(async function a_frame_round_trips() {
  const decoder = new FrameDecoder();
  const out = decoder.push(encodeFrame({ hello: 1, pair: true }));
  Assert.deepEqual(out, [{ hello: 1, pair: true }]);
});

/** TCP delivers bytes, so a frame may arrive one byte at a time. */
add_task(async function a_frame_split_across_reads_is_decoded_once() {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ mcp: { jsonrpc: "2.0", id: 1, method: "ping" } });
  const seen = [];
  for (const byte of frame) {
    seen.push(...decoder.push(Uint8Array.of(byte)));
  }
  Assert.equal(seen.length, 1, "exactly one message");
  Assert.equal(seen[0].mcp.method, "ping");
});

add_task(async function two_frames_in_one_read_both_decode() {
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  Assert.deepEqual(new FrameDecoder().push(both), [{ n: 1 }, { n: 2 }]);
});

/**
 * A web page can reach a localhost port only with HTTP or TLS. Read as a
 * length, "GET " and a TLS hello are both far past the limit, so neither is
 * ever buffered or parsed.
 */
add_task(async function http_websocket_and_tls_openings_are_refused() {
  for (const opening of [
    bytesOf("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
    bytesOf("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"),
    Uint8Array.of(0x16, 0x03, 0x01, 0x02, 0x00, 0x01),
  ]) {
    Assert.throws(
      () => new FrameDecoder().push(opening),
      e => e instanceof SvalAgentWireError,
      "refused before any body is read"
    );
  }
});

add_task(async function an_oversized_frame_is_refused_both_ways() {
  const big = { pad: "x".repeat(MAX_FRAME_BYTES) };
  Assert.throws(
    () => encodeFrame(big),
    e => e instanceof SvalAgentWireError
  );
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
  Assert.throws(
    () => new FrameDecoder().push(header),
    e => e instanceof SvalAgentWireError
  );
});

/**
 * A reply too large for one frame answers its request with an error, so the
 * connection stays open.
 */
add_task(async function an_oversized_tool_result_becomes_an_error_result() {
  const big = {
    mcp: {
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "image", data: "x".repeat(MAX_FRAME_BYTES) }],
      },
    },
  };
  const [out] = new FrameDecoder().push(encodeFrame(big));
  Assert.equal(out.mcp.id, 7, "it answers the same request");
  Assert.ok(out.mcp.result.isError, "as a failed tool call");
  const body = JSON.parse(out.mcp.result.content[0].text);
  Assert.equal(body.error, "result_too_large");
  Assert.ok(body.message.startsWith("result_too_large: "));
});

add_task(async function an_oversized_reply_becomes_an_error_reply() {
  const big = {
    mcp: {
      jsonrpc: "2.0",
      id: "a",
      result: { pad: "x".repeat(MAX_FRAME_BYTES) },
    },
  };
  const [out] = new FrameDecoder().push(encodeFrame(big));
  Assert.equal(out.mcp.id, "a");
  Assert.equal(out.mcp.result, undefined);
  Assert.equal(out.mcp.error.code, -32603);
  Assert.equal(out.mcp.error.data.error, "result_too_large");
});

add_task(async function a_body_that_is_not_a_json_object_is_refused() {
  for (const body of ["not json", "[1,2]", "null", "42"]) {
    const bytes = bytesOf(body);
    const frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, bytes.length);
    frame.set(bytes, 4);
    Assert.throws(
      () => new FrameDecoder().push(frame),
      e => e instanceof SvalAgentWireError,
      body
    );
  }
});

/**
 * The vectors sval-mcp's Rust tests check, computed independently with
 * Python's hmac module: HMAC-SHA256 keyed by the token's text, over "sval:" or
 * "agent:" followed by the nonce's text. Sval signs and verifies through these
 * functions, so the two sides agree on what a proof is.
 */
const VECTOR = {
  token: "0123456789abcdef".repeat(4),
  nonce: "fedcba9876543210".repeat(4),
  sval: "06bf7a6e23313d6e35442d7ca05118e5206f1511f65e0da0d14c719ea0b109d4",
  agent: "8250d82b0207bd5bf671b20aad92933ab149f5a1fdfa075771a9ba12fea34904",
};

add_task(async function svals_proof_matches_an_independent_hmac() {
  const key = await proofKey(VECTOR.token);
  Assert.equal(await svalProof(key, VECTOR.nonce), VECTOR.sval);
});

add_task(
  async function an_agents_proof_is_checked_against_an_independent_hmac() {
    const key = await proofKey(VECTOR.token);
    Assert.ok(await isAgentProof(key, VECTOR.nonce, VECTOR.agent));
    Assert.ok(
      !(await isAgentProof(key, VECTOR.nonce, VECTOR.sval)),
      "sval's own proof, reflected, is not an agent's"
    );
    Assert.ok(
      !(await isAgentProof(key, "a".repeat(64), VECTOR.agent)),
      "a proof for another nonce"
    );
    Assert.ok(
      !(await isAgentProof(
        await proofKey("b".repeat(64)),
        VECTOR.nonce,
        VECTOR.agent
      )),
      "a proof under another token"
    );
    for (const malformed of [
      VECTOR.agent.toUpperCase(),
      VECTOR.agent.slice(0, 62),
      `${VECTOR.agent}00`,
      `+${VECTOR.agent.slice(1)}`,
      "",
      undefined,
      null,
      7,
      [VECTOR.agent],
    ]) {
      Assert.ok(
        !(await isAgentProof(key, VECTOR.nonce, malformed)),
        `${JSON.stringify(malformed)} is not a proof`
      );
    }
  }
);
