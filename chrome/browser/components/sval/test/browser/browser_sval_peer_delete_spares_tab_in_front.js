/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Another device's close never takes away a tab the user has in front of
 * them, and a tab in a call stays on this device (decision 2237).
 *
 * Device A is this window's panel on a shared folder, and device B an engine
 * that keeps that folder as its own location, as in
 * `browser_sval_two_devices.js`.
 */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SYNC_DOCUMENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const CALL_PAGE = ROOT + "sval_capture_page.html";

/**
 * This window as device A on a shared folder, and device B on it.
 *
 * @param {string} label Distinguishes this task's temporary paths.
 * @returns {Promise<object>} `{ a, b, workspace, publishA, sync }`, where
 *   `sync()` runs B's pass and then A's, so each has the other's last file.
 */
async function twoDevices(label) {
  const device = await panelOnAFolder(label, { shared: true });
  const keys = await svalKeys();
  const b = new SvalEngine({
    root: SvalPanel.sharedRootSetting(),
    keyBytes: keys.syncKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(b));
  const publishA = async () => {
    await within(SvalPanel.observer.settled(), 10_000, "A's observer");
    await TestUtils.waitForCondition(
      async () => (await SvalPanel.syncWithFolder()) === "reached",
      "A's pass reached the folder"
    );
  };
  return { a: device.engine, b, workspace: device.workspace, publishA };
}

/**
 * Opens `url` in a tab of A's that B has too.
 *
 * @param {object} devices As `twoDevices` returns them.
 * @param {string} url
 * @returns {Promise<{tab: object, id: string}>}
 */
async function sharedTab(devices, url) {
  const { a, b, publishA } = devices;
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the tab's load"
  );
  const id = taggedId(tab);
  Assert.ok(id, "the tab was tagged");
  await TestUtils.waitForCondition(
    async () => id in (await nodes(a)),
    "the tab reached A's document"
  );
  await publishA();
  await b.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(id in (await nodes(b)), "and reached B");
  return { tab, id };
}

/**
 * B closes `id` and publishes it, and A's pass brings the close in.
 *
 * @param {object} devices As `twoDevices` returns them.
 * @param {string} id
 */
async function closeOnB(devices, id) {
  const { b, publishA } = devices;
  await b.mutate({ kind: "remove", id, now: Date.now() });
  await b.sync(SYNC_DOCUMENT, Date.now());
  await publishA();
  await within(SvalPanel.observer.settled(), 10_000, "A's observer");
}

add_task(async function a_peer_close_of_the_selected_tab_keeps_it_open() {
  const devices = await twoDevices("selected");
  const { tab, id } = await sharedTab(devices, "https://example.com/front");
  Assert.ok(tab.selected, "the tab is the one A's window shows");

  await closeOnB(devices, id);

  Assert.ok(!tab.closing && tab.isConnected, "A's tab is still open");
  Assert.equal(gBrowser.selectedTab, tab, "and still in front");
  Assert.equal(taggedId(tab), id, "under its own id");
  Assert.ok(id in (await nodes(devices.a)), "A put its node back");

  await devices.publishA();
  await devices.b.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(id in (await nodes(devices.b)), "and the tab came back on B");
});

add_task(async function a_peer_close_of_a_tab_behind_closes_it() {
  const devices = await twoDevices("behind");
  const { tab, id } = await sharedTab(devices, "https://example.com/behind");
  const front = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.org/front"
    ),
    10_000,
    "the load of the tab in front"
  );
  Assert.ok(!tab.selected && front.selected, "the shared tab is behind");

  const closed = BrowserTestUtils.waitForEvent(tab, "TabClose");
  await closeOnB(devices, id);
  await within(closed, 10_000, "A closing the tab behind");
  Assert.ok(!(id in (await nodes(devices.a))), "its node stays deleted");
});

add_task(async function a_tab_in_a_call_stays_on_this_device() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      // Without it a fake device never counts as capturing
      // (`DeviceListener::CapturingAudio`), so the tab shares nothing.
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
    ],
  });
  const devices = await twoDevices("call");
  const { tab, id } = await sharedTab(devices, CALL_PAGE);
  const browser = tab.linkedBrowser;
  const shown = BrowserTestUtils.waitForEvent(
    PopupNotifications.panel,
    "popupshown"
  );
  const started = SpecialPowers.spawn(browser, [], async () => {
    await content.wrappedJSObject.start();
    return content.wrappedJSObject.state;
  });
  await within(shown, 10_000, "the camera prompt");
  PopupNotifications.panel.firstElementChild.button.click();
  Assert.equal(await within(started, 10_000, "the call"), "started");
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("sharing"),
    "Firefox shows the tab sharing"
  );
  await TestUtils.waitForCondition(
    async () => (await nodes(devices.a))[id]?.content.local === true,
    "A kept the call's tab on this device"
  );
  await devices.publishA();
  await devices.b.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(!(id in (await nodes(devices.b))), "B no longer has the tab");
  Assert.ok(tab.isConnected && !tab.closing, "A's tab is still in the call");

  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.hangUp();
  });
  await TestUtils.waitForCondition(
    async () => (await nodes(devices.a))[id]?.content.local !== true,
    "hanging up published the tab again"
  );
  await devices.publishA();
  await devices.b.sync(SYNC_DOCUMENT, Date.now());
  const onB = (await nodes(devices.b))[id];
  Assert.ok(onB, "B has the tab again, under its own id");
  Assert.equal(onB.content.url, CALL_PAGE, "at the call's address");
});

add_task(
  async function a_peer_tab_closed_unopened_comes_back_with_undo_close() {
    const devices = await twoDevices("undo");
    const id = crypto.randomUUID();
    await devices.b.sync(SYNC_DOCUMENT, Date.now());
    await devices.b.mutate({
      kind: "addTab",
      parent: devices.workspace,
      name: "From B",
      url: "https://example.com/from-b",
      id,
      now: Date.now(),
    });
    await devices.b.sync(SYNC_DOCUMENT, Date.now());
    await devices.publishA();
    await TestUtils.waitForCondition(
      () => SvalPanel._rows.some(row => row.id === id),
      "A's panel shows B's tab"
    );
    Assert.ok(!SvalPanel.observer.tabFor(id), "and A has never opened it");

    await SvalPanel._close(id);
    Assert.ok(!(id in (await nodes(devices.a))), "closing its row deleted it");

    const reopened = SvalPanel.observer.reopenClosedTab();
    Assert.ok(reopened, "Undo Close Tab reopened it");
    expectOpened(reopened);
    await TestUtils.waitForCondition(
      async () => id in (await nodes(devices.a)),
      "under its own id"
    );
  }
);
