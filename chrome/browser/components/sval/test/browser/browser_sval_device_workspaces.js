/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A phone's or tablet's own Workspace on the desktop (decision 2254): the
 * switcher lists it under Devices with its tab count, the strip draws it
 * after a divider, a new window never takes it while the user has a
 * Workspace of their own, and it opens as any Workspace does.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/**
 * The test profile opens a new window on `about:blank`
 * (`browser.startup.page` 0). Sval's default opens it on the home page, as a
 * user's new window does.
 */
add_setup(async function new_windows_open_on_the_home_page() {
  await SpecialPowers.pushPrefEnv({ clear: [["browser.startup.page"]] });
});

/**
 * Adds a device's Workspace holding `tabs` tabs, deleted when the task ends.
 * A desktop never makes one, so it goes in through a batch, which takes
 * every operation the engine knows, as a phone's would.
 *
 * @param {object} engine
 * @param {number} tabs
 * @returns {Promise<string>} its id.
 */
async function addDeviceWorkspace(engine, tabs) {
  const id = crypto.randomUUID();
  leftWhenTheTaskEnds([id]);
  await engine.mutate({
    kind: "batch",
    ops: [
      { kind: "addDeviceWorkspace", name: "iPhone", id },
      ...Array.from({ length: tabs }, (_, i) => ({
        kind: "addTab",
        parent: id,
        name: `Phone tab ${i + 1}`,
        url: `https://example.com/phone/${i + 1}`,
        id: crypto.randomUUID(),
      })),
    ],
    now: Date.now(),
  });
  return id;
}

/**
 * A Workspace of the user's made last, after the device's in sibling order,
 * so the Devices part is a regrouping of the document's order.
 *
 * @param {object} engine
 * @returns {Promise<string>} its id.
 */
async function addLaterWorkspace(engine) {
  const id = await engine.mutate({
    kind: "addWorkspace",
    name: "Workspace 3",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([id]);
  return id;
}

add_task(async function devices_workspaces_have_their_own_section() {
  const { ids, engine } = await withSwitcherPanel();
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  const phone = await addDeviceWorkspace(engine, 2);
  const third = await addLaterWorkspace(engine);
  const agent = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([agent]);
  await SvalPanel.refresh();

  const menu = await openSwitcher();
  try {
    Assert.deepEqual(
      Array.from(
        menu.querySelectorAll(":scope > [data-workspace-id]"),
        el => el.dataset.workspaceId
      ),
      [home, ...ids.workspaces, third, phone],
      "the user's Workspaces first, then the device's"
    );
    const caption = menu.querySelector(":scope > [data-devices-caption]");
    Assert.ok(caption, "the device's are under a caption");
    Assert.equal(caption.localName, "menucaption", "a menu's own heading");
    Assert.equal(
      caption.previousElementSibling.localName,
      "menuseparator",
      "set apart from the user's Workspaces"
    );
    const entry = caption.nextElementSibling;
    Assert.equal(entry.dataset.workspaceId, phone, "heading the device's");
    Assert.stringContains(
      entry.getAttribute("acceltext"),
      "2",
      "which says how many tabs it holds"
    );
    Assert.stringContains(
      entry.getAttribute("description"),
      "2",
      "to a screen reader too"
    );
    Assert.ok(
      !entry.hasAttribute("draggable"),
      "it keeps its place among the devices'"
    );
    const agents = menu.querySelector(":scope > .sval-agents-caption");
    Assert.ok(
      caption.compareDocumentPosition(agents) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "and the agents' come after the devices'"
    );
    await activateWorkspace(menu, phone);
    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      phone,
      "it opens as any Workspace"
    );
  } finally {
    if (menu.state !== "closed") {
      await closeSwitcher(menu);
    }
  }
});

add_task(async function the_strip_draws_devices_after_a_divider() {
  const { ids, engine } = await withSwitcherPanel();
  const phone = await addDeviceWorkspace(engine, 1);
  const third = await addLaterWorkspace(engine);
  await SvalPanel.refresh();
  await SpecialPowers.pushPrefEnv({
    set: [[SvalPanelModel.SWITCHER_PREF, "strip"]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const strip = SvalPanel._els.strip;
  await TestUtils.waitForCondition(
    () => strip.checkVisibility(),
    "the strip showing"
  );

  const tabs = strip.querySelector(".sval-strip-tabs");
  const order = Array.from(tabs.children, el =>
    el.classList.contains("sval-strip-divider")
      ? `divider:${el.dataset.divider}`
      : el.dataset.workspaceId
  );
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  Assert.deepEqual(
    order,
    [home, ...ids.workspaces, third, "divider:devices", phone],
    "the device's Workspace comes after a divider, past the user's own"
  );
  const item = tabs.querySelector(
    `.sval-strip-item[data-workspace-id="${CSS.escape(phone)}"]`
  );
  Assert.equal(
    item.getAttribute("draggable"),
    "false",
    "and keeps its place there"
  );
});

/**
 * A device's Workspace wears the phone until its device says it is a tablet
 * in the settings document, then the tablet, in the switcher and the strip
 * alike.
 */
add_task(async function a_tablets_workspace_wears_the_tablet() {
  const { engine } = await withSwitcherPanel();
  const device = await addDeviceWorkspace(engine, 1);
  await SvalPanel.refresh();
  const PHONE = "chrome://browser/content/sval/device-phone.svg";
  const TABLET = "chrome://browser/content/sval/device-tablet.svg";
  const imageOf = async () => {
    const menu = await openSwitcher();
    try {
      return menu
        .querySelector(`:scope > [data-workspace-id="${CSS.escape(device)}"]`)
        .getAttribute("image");
    } finally {
      await closeSwitcher(menu);
    }
  };
  Assert.equal(await imageOf(), PHONE, "the phone, while its kind is unsaid");

  // The device in the mark is the engine's own, which wrote it.
  const { SETTINGS_DOCUMENT } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  ).SvalSettingsRegistry;
  const { SvalDeviceNames } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs"
  );
  const key = `sval.device.kind.${engine.deviceIdHex}`;
  await engine.mutate({
    kind: "setSetting",
    document: SETTINGS_DOCUMENT,
    key,
    valueJson: JSON.stringify("tablet"),
    now: Date.now(),
  });
  atTaskEnd(() =>
    engine.mutate({
      kind: "setSetting",
      document: SETTINGS_DOCUMENT,
      key,
      now: Date.now(),
    })
  );
  // A kind arrives by a pass, and names are read again as they start.
  SvalDeviceNames.stop();
  await SvalDeviceNames.startFor(engine);
  Assert.equal(
    SvalDeviceNames.kindOf(engine.deviceIdHex),
    "tablet",
    "the kind is read"
  );
  await SvalPanel.refresh();
  Assert.equal(await imageOf(), TABLET, "the tablet in the switcher");

  await SpecialPowers.pushPrefEnv({
    set: [[SvalPanelModel.SWITCHER_PREF, "strip"]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const face = SvalPanel._els.strip.querySelector(
    `.sval-strip-item[data-workspace-id="${CSS.escape(device)}"] .sval-strip-face`
  );
  Assert.equal(
    face.style.getPropertyValue("--sval-agent-mark"),
    `url("${TABLET}")`,
    "and in the strip"
  );
});

/**
 * A new window with every one of the user's Workspaces open never takes a
 * device's Workspace that has no window: it gets a new, nameless one of the
 * user's own, as it does beside an agent's.
 */
add_task(async function a_new_window_never_takes_a_devices_workspace() {
  const { ids, engine } = await withSwitcherPanel();
  const [, second] = ids.workspaces;
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  const phone = await addDeviceWorkspace(engine, 1);
  await SvalPanel.refresh();

  const torn = await tearOff(second);
  const tornHome = await tearOff(home);
  let win;
  try {
    win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a new window's opening"
    );
    await within(
      win.SvalPanel.started,
      20_000,
      "the new window's panel starting"
    );
    const shown = SvalWindowWorkspace.of(win).id;
    leftWhenTheTaskEnds([shown]);
    Assert.notEqual(shown, phone, "the device's Workspace is not taken");
    const nodes = JSON.parse(await treeJson(engine));
    Assert.equal(nodes[shown]?.kind, "workspace", "a real one");
    Assert.ok(!nodes[shown].device_home, "the user's own");
  } finally {
    if (win) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
    for (const each of [tornHome, torn]) {
      await within(
        BrowserTestUtils.closeWindow(each),
        10_000,
        "the torn-off window closing"
      );
    }
  }
});
