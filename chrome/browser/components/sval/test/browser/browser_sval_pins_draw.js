/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * A selected pin's page loads and is drawn (pins spec §5): its address alone
 * is not the page. Pins and a pinned folder's pins, chosen in turn and again,
 * each show their own document, active, and follow a link in their site. A
 * link to another site draws in Quick Peek (§12.6), as an Alt-clicked link in an
 * ordinary tab does. Agent access is on, as it is for a user with an agent
 * paired: its gate holds a tab's loads until the tree has the tab, and
 * neither a pin's page nor an open Quick Peek is in the tree.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);

add_setup(pinsSetup);

add_setup(async function agentAccessIsOn() {
  const { SvalAgentStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentStore.sys.mjs"
  );
  const { createAgentGate } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs"
  );
  const path = tempPath("sval-pins-agents", ".json");
  const gate = createAgentGate({ store: await SvalAgentStore.open(path) });
  registerCleanupFunction(async () => {
    gate.close();
    await IOUtils.remove(path, { ignoreAbsent: true });
  });
});

/**
 * Waits until the selected tab's page is the document at `url`, shown.
 *
 * @param {string} url
 * @param {string} what
 */
async function untilDrawn(url, what) {
  await TestUtils.waitForCondition(
    () =>
      gBrowser.selectedBrowser.currentURI.spec === url &&
      !gBrowser.selectedTab.hasAttribute("busy") &&
      gBrowser.selectedBrowser.docShellIsActive,
    `${what}: the tab shows its page`
  );
  await switchDone();
  const seen = await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => ({
    href: content.location.href,
    visible: content.document.visibilityState,
  }));
  Assert.equal(seen.href, url, `${what}: its own document`);
  Assert.equal(seen.visible, "visible", `${what}: shown`);
}

add_task(async function every_pin_and_folder_pin_draws_its_page() {
  const errors = [];
  const listener = {
    observe(message) {
      if (message instanceof Ci.nsIScriptError && message.flags === 0) {
        errors.push(`${message.errorMessage} @ ${message.sourceName}`);
      }
    },
  };
  Services.console.registerListener(listener);
  registerCleanupFunction(() => Services.console.unregisterListener(listener));

  const { store } = pinsFixture;
  const plain = [];
  for (const [n, url] of [PAGE, PAGE2, LINKS_PAGE].entries()) {
    plain.push({ guid: await pinFavorite(url, `Pin ${n}`), url });
  }
  const folder = { guid: await pinsFolder("Folder") };
  const inner = [];
  for (const [n, url] of [`${PAGE}?inner=1`, `${PAGE2}?inner=2`].entries()) {
    inner.push({
      guid: await pinFavorite(url, `Inner ${n}`, {
        parentGuid: folder.guid,
        pin: false,
      }),
      url,
    });
  }
  await within(store.whenIdle(), 10_000, "store going idle");
  await untilPinShows(folder.guid);

  const pickInner = async ({ guid, url }) => {
    EventUtils.synthesizeMouseAtCenter(tileOf(folder.guid), {});
    const panel = await TestUtils.waitForCondition(() => {
      const p = document.getElementById("sval-pins-popover");
      return p?.state === "open" ? p : null;
    }, "the folder's popover opens");
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeMouseAtCenter(
      panel.querySelector(`button[data-guid="${guid}"]`),
      {}
    );
    await within(hidden, 10_000, "picking a pin closes the popover");
    await untilDrawn(url, `folder pin ${url}`);
  };

  for (let round = 0; round < 2; round++) {
    for (const { guid, url } of plain) {
      EventUtils.synthesizeMouseAtCenter(await untilPinShows(guid), {});
      await untilDrawn(url, `round ${round}, pin ${url}`);
    }
    for (const pin of inner) {
      await pickInner(pin);
    }
  }
  // A link within its site loads in the pin.
  EventUtils.synthesizeMouseAtCenter(await untilPinShows(plain[2].guid), {});
  await untilDrawn(LINKS_PAGE, "the links pin");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    {},
    gBrowser.selectedBrowser
  );
  await untilDrawn(PAGE2, "a link within its site");

  info(`console errors: ${JSON.stringify(errors, null, 1)}`);
  Assert.deepEqual(
    errors.filter(e => /sval/i.test(e)),
    [],
    "no Sval error"
  );
});

/**
 * Two pins of one address are two pins (pins spec §6): a pin's page is keyed
 * by its guid, so the one in a pinned folder shows its own page.
 */
add_task(async function two_pins_of_one_address_are_two_pages() {
  const { store } = pinsFixture;
  const url = `${PAGE}?same=1`;
  const top = await pinFavorite(url, "Top");
  const folder = { guid: await pinsFolder("Same") };
  const inner = await pinFavorite(url, "Inner", {
    parentGuid: folder.guid,
    pin: false,
  });
  await within(store.whenIdle(), 10_000, "store going idle");

  EventUtils.synthesizeMouseAtCenter(await untilPinShows(top), {});
  await untilDrawn(url, "the top-level pin");
  const topTab = gBrowser.selectedTab;

  EventUtils.synthesizeMouseAtCenter(await untilPinShows(folder.guid), {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById("sval-pins-popover");
    return p?.state === "open" ? p : null;
  }, "the folder's popover opens");
  Assert.ok(
    tileOf(folder.guid).hasAttribute("sval-stem"),
    "the popover grows from the folder's tile"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(
    panel.querySelector(`button[data-guid="${inner}"]`),
    {}
  );
  await within(hidden, 10_000, "picking a pin closes the popover");
  await TestUtils.waitForCondition(
    () => selectedPinGuid() === inner,
    "the folder's pin is the one selected"
  );
  Assert.notEqual(gBrowser.selectedTab, topTab, "on a page of its own");
  Assert.ok(
    tileOf(folder.guid).closest(".sval-pin-slot").hasAttribute("data-wide"),
    "and its folder, not the other pin, widens"
  );
  Assert.equal(
    tileOf(folder.guid).querySelector(".sval-pin-folder-name")?.textContent,
    "Same",
    "naming the folder over its pin"
  );
});

/**
 * Waits until the window's Quick Peek shows the document at `url`, loaded.
 *
 * @param {string} url
 * @param {string} what
 * @returns {Promise<object>} the Quick Peek's tab.
 */
async function untilQuickPeekDrawn(url, what) {
  const quickPeek = await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    `${what}: a Quick Peek opens`
  );
  await TestUtils.waitForCondition(
    () =>
      quickPeek.linkedBrowser.currentURI.spec === url &&
      !quickPeek.hasAttribute("busy"),
    `${what}: the Quick Peek's page loads`
  );
  const seen = await SpecialPowers.spawn(quickPeek.linkedBrowser, [], () => ({
    href: content.location.href,
    ready: content.document.readyState,
    heading: content.document.querySelector("h1, title")?.textContent ?? "",
  }));
  Assert.equal(seen.href, url, `${what}: its own document`);
  Assert.equal(seen.ready, "complete", `${what}: loaded`);
  Assert.ok(seen.heading, `${what}: with the page's content`);
  return quickPeek;
}

/**
 * Closes the window's Quick Peek with its close button, and waits for it to go.
 *
 * @param {object} quickPeek The Quick Peek's tab.
 */
async function closeQuickPeek(quickPeek) {
  document
    .getElementById(quickPeek.linkedPanel)
    .querySelector(".sval-quick-peek-close")
    .click();
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.isConnected,
    "the Quick Peek closes"
  );
}

add_task(async function a_link_to_another_host_draws_in_quick_peek() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await clickTile(guid, LINKS_PAGE);
  const page = gBrowser.selectedTab;
  await BrowserTestUtils.synthesizeMouseAtCenter("h1", {}, page.linkedBrowser);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#elsewhere",
    {},
    page.linkedBrowser
  );
  const quickPeek = await untilQuickPeekDrawn(
    ORG_PAGE,
    "a Quick Peek from a pin"
  );
  await closeQuickPeek(quickPeek);
});

add_task(async function an_alt_click_in_a_tab_draws_in_quick_peek() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "a tab opening"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { altKey: true },
    tab.linkedBrowser
  );
  const quickPeek = await untilQuickPeekDrawn(PAGE2, "a Quick Peek from a tab");
  await closeQuickPeek(quickPeek);
  BrowserTestUtils.removeTab(tab);
});
