/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One local change, applied to a `SvalDocument`.
 *
 * Both documents Sval keeps go through here: the profile's, in
 * `SvalSync.worker.mjs`, and a private browsing session's, in
 * `SvalPrivate.worker.mjs`. So an operation means the same thing in both, and
 * an operation cannot exist in one and not the other.
 *
 * Pure: it touches nothing but the document it is given. The caller mints the
 * id and the time, because the engine mints neither (host contract §3).
 */

/**
 * @param {object} doc A `SvalDocument`.
 * @param {object} op As the engine spells one: `kind` names it, and
 *   `{ kind: "batch", ops }` applies several all together or not at all, so
 *   no sync pass can publish part of one (host contract §3).
 * @param {Uint8Array} op.deviceId Stamped into whichever fact group the change
 *   touches.
 * @param {object} minted
 * @param {string} minted.id The id a node this adds takes.
 * @param {number} minted.now The time the change is stamped with.
 * @returns {string|null} the affected node's id: the node an operation
 *   added, or the one it names.
 */
export function applyOp(doc, op, { id, now }) {
  // The device id crosses as bytes of its own, never inside the JSON.
  // `JSON.stringify` writes NaN and the infinities as `null`, which the
  // engine reads as a field left out, so they cross as strings it refuses.
  const json = JSON.stringify({ ...op, id, deviceId: undefined }, (_, value) =>
    typeof value === "number" && !Number.isFinite(value) ? `${value}` : value
  );
  const applied = JSON.parse(doc.apply(json, op.deviceId, now));
  return applied.id ?? op.id ?? null;
}
