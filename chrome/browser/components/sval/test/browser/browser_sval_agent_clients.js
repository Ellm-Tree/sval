/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Agents settings connects an AI app to Sval (sval-mcp-ships-with-sval spec §5):
 * every app Sval knows is listed, one found on the machine can be connected
 * and disconnected, and any other app gets sval-mcp's path and JSON to copy.
 * The machine is a temporary home of this file's own, so no real app's
 * settings are read or changed.
 */

const { SvalAgentClients, shimPath } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentClients.sys.mjs"
);

let home;

add_setup(async function a_machine_with_only_cursor() {
  home = await makeTempDir("sval-clients-ui");
  await IOUtils.makeDirectory(PathUtils.join(home, ".cursor"));
  SvalAgentClients.setEnvForTests({
    platform: AppConstants.platform,
    home,
    appData: PathUtils.join(home, "AppData"),
    codexHome: null,
    shim: shimPath(),
    installShim: async () => true,
    recordPath: PathUtils.join(home, "clients.json"),
    find: async () => null,
    run: async () => ({ exitCode: 0, output: "" }),
  });
  registerCleanupFunction(() => SvalAgentClients.setEnvForTests(null));
});

/**
 * Opens Agents settings and waits for its list of apps.
 *
 * @returns {Promise<{doc: Document, row: Function}>}
 */
async function openClients() {
  const { page } = await openSvalSettings();
  await showPane(page, "svalAgents");
  const doc = page.document;
  const list = doc.getElementById("sval-agent-clients-list");
  await TestUtils.waitForCondition(
    () => list.children.length === 5,
    "every app sval knows is listed"
  );
  const row = label =>
    [...list.children].find(
      r => r.querySelector(".sval-lead")?.textContent === label
    );
  return { doc, row, list };
}

add_task(async function an_app_on_the_machine_connects_and_disconnects() {
  const { doc, row } = await openClients();
  Assert.equal(
    row("Claude Desktop").dataset.state,
    "missing",
    "an app that is not installed says so"
  );
  Assert.ok(
    !row("Claude Desktop").querySelector("button"),
    "and has nothing to press"
  );

  const message = doc.getElementById("sval-agent-clients-message");
  row("Cursor").querySelector("button").click();
  await TestUtils.waitForCondition(
    () =>
      message.dataset.said === "connected" &&
      message.textContent.includes("Cursor"),
    "connecting says to restart the app"
  );
  const file = PathUtils.join(home, ".cursor", "mcp.json");
  Assert.deepEqual(await IOUtils.readJSON(file), {
    mcpServers: { sval: { command: shimPath() } },
  });
  await TestUtils.waitForCondition(
    () => row("Cursor")?.dataset.state === "connected",
    "Cursor is shown connected"
  );

  row("Cursor").querySelector("button").click();
  await TestUtils.waitForCondition(
    () =>
      message.dataset.said === "disconnected" &&
      message.textContent.includes("Cursor"),
    "disconnecting says so"
  );
  Assert.deepEqual(await IOUtils.readJSON(file), { mcpServers: {} });
});

add_task(async function any_other_app_gets_the_path_and_json_to_copy() {
  const { doc } = await openClients();
  Assert.equal(doc.getElementById("sval-agent-clients-path").value, shimPath());
  Assert.deepEqual(
    JSON.parse(doc.getElementById("sval-agent-clients-json").value),
    { mcpServers: { sval: { command: shimPath() } } }
  );
  doc.getElementById("sval-agent-clients-copy-path").click();
  Assert.equal(
    doc.getElementById("sval-agent-clients-message").dataset.said,
    "copied"
  );
});

add_task(async function gnome_on_wayland_is_told_how_to_keep_sval_behind() {
  const real = SvalAgentClients.opensInFrontOnGnome;
  for (const gnome of [false, true]) {
    SvalAgentClients.opensInFrontOnGnome = () => gnome;
    try {
      const { doc } = await openClients();
      const note = doc.getElementById("sval-agent-clients-gnome");
      Assert.equal(BrowserTestUtils.isVisible(note), gnome);
      if (gnome) {
        Assert.stringContains(
          note.textContent.replace(/\s+/g, " "),
          "gsettings set org.gnome.desktop.wm.preferences focus-new-windows strict"
        );
      }
      BrowserTestUtils.removeTab(gBrowser.selectedTab);
    } finally {
      SvalAgentClients.opensInFrontOnGnome = real;
    }
  }
});

/**
 * An entry Sval wrote for an install that has moved is another app's file, so
 * opening Settings, or coming back to it, only says so; Connect rewrites it.
 */
add_task(async function a_moved_entry_changes_only_when_connect_is_pressed() {
  const file = PathUtils.join(home, ".cursor", "mcp.json");
  const recordPath = PathUtils.join(home, "clients.json");
  await IOUtils.writeJSON(file, {
    mcpServers: { sval: { command: "/old/sval-mcp" } },
  });
  await IOUtils.writeJSON(recordPath, { cursor: "/old/sval-mcp" });
  registerCleanupFunction(async () => {
    await IOUtils.remove(file, { ignoreAbsent: true });
    await IOUtils.remove(recordPath, { ignoreAbsent: true });
  });

  const { doc, row } = await openClients();
  await TestUtils.waitForCondition(
    () => row("Cursor")?.dataset.state === "moved",
    "the list says Cursor's entry points at a Sval that has moved"
  );
  doc.defaultView.dispatchEvent(new doc.defaultView.Event("focus"));
  await TestUtils.waitForTick();
  Assert.deepEqual(
    await IOUtils.readJSON(file),
    { mcpServers: { sval: { command: "/old/sval-mcp" } } },
    "opening and coming back to Settings leave Cursor's settings as they are"
  );

  row("Cursor").querySelector("button").click();
  await TestUtils.waitForCondition(
    () =>
      doc.getElementById("sval-agent-clients-message").dataset.said ===
      "connected",
    "Connect says to restart the app"
  );
  Assert.deepEqual(await IOUtils.readJSON(file), {
    mcpServers: { sval: { command: shimPath() } },
  });
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

/**
 * An entry Sval did not write, whose command file is gone, is shown as broken,
 * and only its Fix button points it at this install's shim.
 */
add_task(async function a_broken_entry_changes_only_when_fix_is_pressed() {
  const file = PathUtils.join(home, ".cursor", "mcp.json");
  const gone = PathUtils.join(home, "gone", "sval-mcp");
  await IOUtils.writeJSON(file, { mcpServers: { sval: { command: gone } } });
  registerCleanupFunction(() => IOUtils.remove(file, { ignoreAbsent: true }));

  const { doc, row } = await openClients();
  await TestUtils.waitForCondition(
    () => row("Cursor")?.dataset.state === "broken",
    "the list says Cursor's entry is broken"
  );
  Assert.deepEqual(
    await IOUtils.readJSON(file),
    { mcpServers: { sval: { command: gone } } },
    "opening Settings leaves Cursor's settings as they are"
  );

  row("Cursor").querySelector("button").click();
  await TestUtils.waitForCondition(
    () =>
      doc.getElementById("sval-agent-clients-message").dataset.said ===
      "connected",
    "Fix says to restart the app"
  );
  Assert.deepEqual(await IOUtils.readJSON(file), {
    mcpServers: { sval: { command: shimPath() } },
  });
  await TestUtils.waitForCondition(
    () => row("Cursor")?.dataset.state === "connected",
    "Cursor is shown connected"
  );
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
