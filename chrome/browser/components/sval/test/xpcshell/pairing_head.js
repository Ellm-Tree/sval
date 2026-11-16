/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * What the pairing test files share. Every pairing call is a request to a
 * helper process, so the tasks are spread over several files for the reason
 * `shared_folder_head.js` gives.
 *
 * The test files that use this name it in an `import-globals-from` comment.
 */

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);

const { SvalEngine, TOP_DIR } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

/**
 * A folder the user chose, which holds `sval/` (`SvalEngine.markSharedRoot`).
 *
 * @returns {Promise<string>}
 */
async function freshRoot() {
  const root = await emptyRoot();
  await IOUtils.makeDirectory(PathUtils.join(root, TOP_DIR));
  return root;
}

/**
 * An empty directory, as a mount point that is not mounted is.
 *
 * @returns {Promise<string>}
 */
function emptyRoot() {
  return makeTempDir("sval-pairing");
}

function pairDir(root) {
  return PathUtils.join(root, "sval", "pair");
}

/**
 * Seals a pairing file directly, bypassing `SvalPairing.offer`'s fixed TTL, so
 * expiry can be tested without waiting an hour. Writes straight into `root`'s
 * pairing folder, where `offer` would have.
 *
 * @param {string} root Absolute path of the storage folder.
 * @param {Uint8Array} keyBytes The key to seal.
 * @param {string} code The code it opens under.
 * @param {number} now Milliseconds since the epoch.
 * @param {number} ttlMs How long the seal stays open; negative or zero makes
 *   an already-expired file.
 * @returns {Promise<string>} The absolute path written.
 */
async function sealDirect(root, keyBytes, code, now, ttlMs) {
  const engine = new SvalEngine({
    root: "",
    keyBytes: new Uint8Array(32),
    deviceId: new Uint8Array(16),
  });
  try {
    const sealed = await engine.sealPairing(keyBytes, code, now, ttlMs);
    const dir = pairDir(root);
    await IOUtils.makeDirectory(dir);
    const target = PathUtils.join(
      dir,
      `${Math.random().toString(36).slice(2)}.json`
    );
    await IOUtils.write(target, sealed);
    return target;
  } finally {
    engine.terminate();
  }
}
