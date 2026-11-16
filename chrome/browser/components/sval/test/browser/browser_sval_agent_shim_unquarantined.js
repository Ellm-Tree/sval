/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The copy of sval-mcp an AI app runs on macOS carries no quarantine, so
 * running it never has Gatekeeper assess anything (decision 2052). It runs in
 * the browser, whose `LSFileQuarantineEnabled` quarantines every file the
 * browser creates, as the bundle's own shim, written here, shows.
 */

const { installShim } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentClients.sys.mjs"
);

const QUARANTINE = "com.apple.quarantine";

add_task(async function the_copy_an_app_runs_is_not_quarantined() {
  const root = await makeTempDir("sval-shim-quarantine");
  const from = PathUtils.join(
    root,
    "Sval.app",
    "Contents",
    "MacOS",
    "sval-mcp"
  );
  await IOUtils.makeDirectory(PathUtils.parent(from), {
    createAncestors: true,
  });
  await IOUtils.writeUTF8(from, "build 1");
  Assert.ok(
    await IOUtils.hasMacXAttr(from, QUARANTINE),
    "a file the browser creates is quarantined"
  );

  const to = PathUtils.join(root, "Application Support", "Sval", "sval-mcp");
  await installShim({ from, to });
  Assert.ok(!(await IOUtils.hasMacXAttr(to, QUARANTINE)), "the copy is not");

  await IOUtils.writeUTF8(from, "build 2");
  await installShim({ from, to });
  Assert.equal(await IOUtils.readUTF8(to), "build 2");
  Assert.ok(
    !(await IOUtils.hasMacXAttr(to, QUARANTINE)),
    "nor is the copy that replaces it"
  );
});
