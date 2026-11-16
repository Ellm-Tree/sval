/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/** Bytes as hex, compared, and hashed. */

/**
 * @param {ArrayLike<number>} bytes
 * @returns {string} Lowercase hex.
 */
export function toHex(bytes) {
  return Uint8Array.from(bytes).toHex();
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean} whether both hold the same bytes.
 */
export function sameBytes(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * @param {string} text
 * @returns {Promise<string>} The SHA-256 of its UTF-8, as lowercase hex.
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return new Uint8Array(digest).toHex();
}

/**
 * `sha256Hex` for a caller that cannot wait, through `nsICryptoHash`.
 *
 * @param {string} text
 * @returns {string} The SHA-256 of its UTF-8, as lowercase hex.
 */
export function sha256HexSync(text) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  const bytes = new TextEncoder().encode(text);
  hash.update(bytes, bytes.length);
  const digest = hash.finish(false);
  return Uint8Array.from(digest, c => c.charCodeAt(0)).toHex();
}
