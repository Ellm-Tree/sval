/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The code behind private windows (private-windows spec) can reach nothing
 * that writes. `test/browser/browser_sval_private_tree.js` covers what it
 * holds and drops in real private windows, and
 * `browser_sval_private_writes_nothing.js` proves the same guarantee from the
 * other side, by searching the disk after a real private session.
 */

/** The private code, and the only modules each may import. */
const PRIVATE_SOURCES = {
  "moz-src:///browser/components/sval/SvalPrivateSession.sys.mjs": [
    "moz-src:///browser/components/sval/SvalWorkerClient.sys.mjs",
    // Keeps the latest tree in memory, weakly keyed by its engine, for the
    // tab observer's synchronous reads; it writes nothing.
    "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs",
  ],
  "moz-src:///browser/components/sval/SvalWorkerClient.sys.mjs": [
    "resource://gre/modules/PromiseWorker.sys.mjs",
  ],
  "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs": [
    // Answers whether every window is private; it writes nothing.
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ],
  "moz-src:///browser/components/sval/SvalPrivateZoom.sys.mjs": [],
  "chrome://browser/content/sval/SvalPrivate.worker.mjs": [
    "chrome://browser/content/sval/sval_core.mjs",
    "chrome://browser/content/sval/SvalDocumentOps.mjs",
    "chrome://browser/content/sval/SvalWorkerHost.mjs",
  ],
  "chrome://browser/content/sval/SvalWorkerHost.mjs": [
    "resource://gre/modules/workers/PromiseWorker.mjs",
  ],
  "chrome://browser/content/sval/SvalDocumentOps.mjs": [],
};

/**
 * Names the private code may never mention outside a comment: anything that
 * reads or writes a file, opens a socket, reaches the session store, xulStore,
 * prefs or logins, or touches Sval's saved state.
 */
const FORBIDDEN = [
  "IOUtils",
  "PathUtils",
  "OS.File",
  "nsIFile",
  "Subprocess",
  "ctypes",
  "XMLHttpRequest",
  "WebSocket",
  "indexedDB",
  "localStorage",
  "SessionStore",
  "xulStore",
  "Services.prefs",
  "Services.logins",
  "SvalEngine",
  "SvalLocalSettings",
  "SvalSharedFolder",
  "SvalIdentity",
  "SvalRestore",
  "SvalAgents",
  "SvalSettingsSync",
  "SvalLog",
  "console.",
  "importESModule",
  "defineESModuleGetters",
  "import(",
];

/**
 * `source` with comments taken out, so that a comment naming what the code
 * must not do is not read as the code doing it.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

async function sourceOf(url) {
  const response = await fetch(url);
  Assert.ok(response.ok, `${url} is where it is expected to be`);
  return response.text();
}

/**
 * The private code imports exactly its allowlist, and names nothing that
 * could write.
 */
add_task(async function the_private_code_can_reach_nothing_that_writes() {
  for (const [url, allowed] of Object.entries(PRIVATE_SOURCES)) {
    const code = withoutComments(await sourceOf(url));
    const imported = [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map(m => m[1]);
    for (const module of imported) {
      Assert.ok(allowed.includes(module), `${url} may import ${module}`);
    }
    for (const name of FORBIDDEN) {
      Assert.ok(!code.includes(name), `${url} never mentions ${name}`);
    }
    // The worker fetches the engine's own wasm, and nothing else.
    const fetches = [...code.matchAll(/\bfetch\(([^)]*)\)/g)].map(m => m[1]);
    Assert.ok(
      fetches.every(arg => arg.trim() === "WASM_URL"),
      `${url} fetches nothing but the engine`
    );
  }
});
