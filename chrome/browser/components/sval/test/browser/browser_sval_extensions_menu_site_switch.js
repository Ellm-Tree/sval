/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* globals browser */

/**
 * Each extension's row in the toolbar's extensions menu has a switch for the
 * site in the current tab (`SvalExtensionsMenu`), which replaces Firefox's
 * site access items in the row's menu.
 */

const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);

const ID = "site-switch@sval.invalid";
const COM = `https://example.com/document-builder.sjs?html=${encodeURIComponent(
  "<p>com</p>"
)}`;

async function loadExtension({
  incognitoOverride,
  manifestVersion = 2,
  permissions = [],
  background,
} = {}) {
  const manifest = {
    manifest_version: manifestVersion,
    name: "Site switch test extension",
    browser_specific_settings: { gecko: { id: ID } },
    content_scripts: [
      { matches: ["<all_urls>"], js: ["cs.js"], run_at: "document_end" },
    ],
  };
  if (manifestVersion >= 3) {
    manifest.host_permissions = ["<all_urls>"];
    manifest.action = { default_area: "menupanel" };
  } else {
    manifest.permissions = [...permissions, "<all_urls>"];
    manifest.browser_action = { default_area: "menupanel" };
  }
  const extension = ExtensionTestUtils.loadExtension({
    manifest,
    files: {
      "cs.js": () => {
        document.documentElement.setAttribute("data-sval-cs", "ran");
      },
    },
    incognitoOverride,
    background,
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(async () => {
    await SvalExtensionSites.setOff(ID, "example.com", false);
    await extension.unload();
  });
  return extension;
}

function openLoaded(url, win = window) {
  return within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "the page loading"
  );
}

async function openMenu(win = window) {
  const panel = win.document.getElementById("unified-extensions-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  win.gUnifiedExtensions.openPanel();
  await within(shown, 10_000, "the extensions menu opening");
  atTaskEnd(async () => {
    if (panel.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      win.PanelMultiView.hidePopup(panel);
      await within(hidden, 10_000, "the extensions menu closing");
    }
  });
  return panel;
}

/**
 * @param {Element} panel
 * @returns {Element|null} The extension's row in the open menu.
 */
function rowOf(panel) {
  return [...panel.querySelectorAll(".unified-extensions-item")].find(
    row =>
      row.getAttribute("extension-id") === ID ||
      row.querySelector(`[data-extensionid="${ID}"]`)
  );
}

function switchOf(panel) {
  return rowOf(panel)?.querySelector("moz-toggle.sval-site-switch") ?? null;
}

add_task(async function test_switch_shows_state() {
  await loadExtension();
  await openLoaded(COM);
  let panel = await openMenu();
  Assert.ok(switchOf(panel), "the row has a switch");
  Assert.ok(switchOf(panel).pressed, "on by default");
  Assert.ok(!rowOf(panel).hasAttribute("data-sval-site-off"));
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  PanelMultiView.hidePopup(panel);
  await within(hidden, 10_000, "the extensions menu closing");

  await SvalExtensionSites.setOff(ID, "example.com", true);
  panel = await openMenu();
  Assert.ok(!switchOf(panel).pressed, "off once turned off");
  Assert.ok(rowOf(panel).hasAttribute("data-sval-site-off"));
});

add_task(async function test_switch_has_its_own_labelled_line() {
  await loadExtension();
  await openLoaded(COM);
  const panel = await openMenu();
  const toggle = switchOf(panel);
  Assert.ok(toggle.label.includes("example.com"), "its label names the site");
  await TestUtils.waitForCondition(
    () => toggle.labelEl?.getBoundingClientRect().width > 0,
    "the label showing"
  );
  const line = toggle.closest(".sval-site-line");
  Assert.ok(line, "the switch has a line of its own");
  const wrapper = rowOf(panel).querySelector(
    ".unified-extensions-item-row-wrapper"
  );
  Assert.greaterOrEqual(
    line.getBoundingClientRect().top,
    wrapper.getBoundingClientRect().bottom - 0.5,
    "under the extension's name and message"
  );
  const name = rowOf(panel).querySelector(".unified-extensions-item-name");
  const nameStyle = getComputedStyle(name);
  const nameStart =
    name.getBoundingClientRect().left + parseFloat(nameStyle.paddingLeft);
  Assert.lessOrEqual(
    Math.abs(toggle.buttonEl.getBoundingClientRect().left - nameStart),
    1,
    "and lined up with the extension's name"
  );
});

/**
 * @param {Element} panel
 * @returns {Element} The extension's row's message.
 */
function messageOf(panel) {
  return rowOf(panel).querySelector(".sval-site-message");
}

/**
 * @param {Element} panel
 * @returns {boolean} Whether Firefox's message in the extension's row shows.
 */
function firefoxMessageShows(panel) {
  return rowOf(panel)
    .querySelector(".unified-extensions-item-message-deck")
    .checkVisibility();
}

add_task(async function test_message_says_what_it_can_do() {
  await loadExtension({
    permissions: [
      "webRequest",
      "webRequestBlocking",
      "cookies",
      "webNavigation",
    ],
  });
  await openLoaded(COM);
  const panel = await openMenu();
  const message = messageOf(panel);
  Assert.equal(
    message.dataset.svalCan,
    "pages block cookies navigation",
    "the message lists what the extension can do on the site"
  );
  Assert.ok(message.checkVisibility(), "and says it");
  Assert.ok(!firefoxMessageShows(panel), "in place of Firefox's message");
  switchOf(panel).buttonEl.click();
  await TestUtils.waitForCondition(
    () => message.dataset.svalCan === "",
    "the message saying it can't reach the site once off"
  );
});

add_task(async function test_message_stays_when_the_button_changes() {
  const extension = await loadExtension({
    background() {
      browser.test.onMessage.addListener(async () => {
        await browser.browserAction.setBadgeText({ text: "7" });
        browser.test.sendMessage("badged");
      });
    },
  });
  await openLoaded(COM);
  const panel = await openMenu();
  extension.sendMessage("badge");
  await within(extension.awaitMessage("badged"), 10_000, "the badge set");
  // The row redraws its button on a later frame (updateButton in
  // ext-browserAction.js), so the badge reaching it is the redraw done.
  const action = rowOf(panel).querySelector(
    ".unified-extensions-item-action-button"
  );
  await within(
    TestUtils.waitForCondition(
      () => action.getAttribute("badge") === "7",
      "the row's button redrawn with the badge"
    ),
    10_000,
    "the row's redraw"
  );
  Assert.ok(messageOf(panel).checkVisibility(), "Sval's message still shows");
  Assert.ok(!firefoxMessageShows(panel), "and Firefox's does not");
});

add_task(async function test_message_lists_only_what_it_declares() {
  await loadExtension();
  await openLoaded(COM);
  const panel = await openMenu();
  Assert.equal(messageOf(panel).dataset.svalCan, "pages");
});

add_task(async function test_switch_turns_off_and_reloads() {
  await loadExtension();
  const tab = await openLoaded(COM);
  const panel = await openMenu();
  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  switchOf(panel).buttonEl.click();
  await within(reloaded, 10_000, "the site's tab reloading");
  Assert.ok(SvalExtensionSites.isOff(ID, "example.com"), "stored as off");
  Assert.ok(!switchOf(panel).pressed, "the switch shows off");
  Assert.ok(
    !(await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      content.document.documentElement.hasAttribute("data-sval-cs")
    )),
    "and the reloaded page has none of its scripts"
  );
  Assert.ok(rowOf(panel).hasAttribute("data-sval-site-off"), "the row says so");
});

add_task(async function test_a_host_switch_leaves_its_site_and_siblings() {
  await loadExtension();
  atTaskEnd(() => SvalExtensionSites.removeAll("test1.example.com"));
  const tab = await openLoaded(COM.replace("example.com", "test1.example.com"));
  const panel = await openMenu();
  const scope = panel.querySelector(".sval-ext-scope .sval-scope");
  Assert.equal(
    scope?.dataset.scope,
    "test1.example.com",
    "it opens at the host"
  );
  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  switchOf(panel).buttonEl.click();
  await within(reloaded, 10_000, "the host's tab reloading");
  Assert.ok(
    SvalExtensionSites.isOff(ID, "test1.example.com"),
    "off on the host"
  );
  Assert.ok(!SvalExtensionSites.isOff(ID, "example.com"), "on for the site");
  Assert.ok(
    !SvalExtensionSites.isOff(ID, "test2.example.com"),
    "on for another host"
  );

  panel.querySelector("#sval-ext-scope-button").click();
  panel
    .querySelector("#sval-ext-scope-menu [data-scope='example.com']")
    .click();
  Assert.equal(
    panel.querySelector(".sval-ext-scope .sval-scope").dataset.scope,
    "example.com",
    "picking the site moves the switches there"
  );
  Assert.ok(switchOf(panel).pressed, "which shows the site's state");
  Assert.ok(panel.querySelector("#sval-ext-keeps"), "and what the host keeps");
});

add_task(async function test_no_scope_on_a_plain_site() {
  await loadExtension();
  await openLoaded(COM);
  const panel = await openMenu();
  Assert.ok(switchOf(panel), "the row has a switch");
  Assert.ok(!panel.querySelector(".sval-ext-scope"), "and no scope line");
});

add_task(async function test_no_switch_without_site() {
  await loadExtension();
  await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "a blank tab"
  );
  const panel = await openMenu();
  Assert.ok(!switchOf(panel), "no switch where the tab has no site");
});

add_task(async function test_no_switch_in_private_window() {
  await loadExtension({ incognitoOverride: "spanning" });
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    10_000,
    "a private window opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  await openLoaded(COM, win);
  const panel = await openMenu(win);
  Assert.ok(rowOf(panel), "the extension is listed");
  Assert.ok(!switchOf(panel), "with no switch in a private window");
});

add_task(async function test_no_origin_controls_items() {
  // Firefox gives an MV3 extension's row site access items.
  await loadExtension({ manifestVersion: 3 });
  await openLoaded(COM);
  const panel = await openMenu();
  const menu = document.getElementById("unified-extensions-context-menu");
  // Firefox's items, without Sval's Pin to Toolbar in, which the menu's
  // first opening adds (`SvalExtensionsMenu.updateShowIn`).
  const firefoxItems = () =>
    [...menu.children].filter(
      el => !el.classList.contains("sval-extension-show-in")
    ).length;
  const before = firefoxItems();
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(
    rowOf(panel).querySelector(".unified-extensions-item-menu-button"),
    {}
  );
  await within(shown, 10_000, "the row's menu opening");
  Assert.equal(firefoxItems(), before, "no site access items added");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the row's menu closing");
});

add_task(async function test_pinned_row_takes_no_switch_to_toolbar() {
  await loadExtension();
  await openLoaded(COM);
  await openMenu();
  const widgetId = gUnifiedExtensions.browserActionFor(
    WebExtensionPolicy.getByID(ID)
  ).widget.id;
  atTaskEnd(() => gUnifiedExtensions.pinToToolbar(widgetId, false));
  gUnifiedExtensions.pinToToolbar(widgetId, true);
  const toggle = document
    .getElementById(widgetId)
    .querySelector("moz-toggle.sval-site-switch");
  Assert.ok(
    !toggle?.checkVisibility(),
    "the toolbar shows no switch on the pinned button"
  );
});
