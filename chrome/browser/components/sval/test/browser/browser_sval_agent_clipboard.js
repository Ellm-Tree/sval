/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */
/* globals browser */

/**
 * A page in a tab an agent controls does not write the system clipboard
 * (agent-control spec §4.1): the agent's click gives the page user
 * activation, which it could otherwise spend replacing what the user later
 * pastes elsewhere. Once the user takes control, the page writes as in any
 * tab.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Makes the page's Press button write the clipboard every way a page can:
 * a copy whose event handler sets the data, then `navigator.clipboard`.
 * The page records how the last write ended.
 *
 * @param {object} browser
 */
function pageWritesOnPress(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.eval(`
      document.addEventListener("copy", event => {
        event.clipboardData.setData("text/plain", "copied by the page");
        event.preventDefault();
      });
      document.getElementById("press").onclick = () => {
        delete document.body.dataset.wrote;
        document.execCommand("copy");
        navigator.clipboard.writeText("written by the page").then(
          () => { document.body.dataset.wrote = "written"; },
          error => { document.body.dataset.wrote = error.name; }
        );
      };
    `);
  });
}

/**
 * @param {object} browser
 * @returns {Promise<string>} How the page's last write ended, once it has.
 */
async function wroteIn(browser) {
  let wrote;
  await TestUtils.waitForCondition(async () => {
    wrote = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.wrote
    );
    return wrote !== undefined;
  }, "the page's write ended");
  return wrote;
}

add_task(async function a_page_writes_no_clipboard_while_the_agent_works() {
  const { call, tab, win, browser } = await layerSetup();
  await pageWritesOnPress(browser);
  SpecialPowers.clipboardCopyString("the user's own");

  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Press" \[(e\d+)\]/)[1];
  await call("click_element", { tab, ref });
  Assert.equal(
    await wroteIn(browser),
    "NotAllowedError",
    "the page's write is refused"
  );
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "the user's own",
    "the clipboard keeps what the user put there"
  );

  await takeControlOf(win, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter("#press", {}, browser);
  Assert.equal(await wroteIn(browser), "written", "once the user has control");
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "written by the page",
    "the page writes the clipboard as in any tab"
  );
});

/**
 * A write that names no window skips the check by the tab it came from, so
 * one from a process that hosts the agent's tab is refused. A content
 * process can send such a write itself, which the clipboard helper used
 * without a window does here. Once the user takes control, the process
 * writes as any other.
 */
add_task(async function a_write_naming_no_window_is_refused_beside_an_agent() {
  const { win, browser } = await layerSetup();
  const writeWithNoWindow = text =>
    SpecialPowers.spawn(browser, [text], value => {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(value);
    });
  SpecialPowers.clipboardCopyString("the user's own");

  // The write reaches the parent before the spawn's answer, on one channel.
  await writeWithNoWindow("written with no window");
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "the user's own",
    "the clipboard keeps what the user put there"
  );

  await takeControlOf(win, browser);
  await writeWithNoWindow("written once the user has control");
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "written once the user has control",
    "the process writes as any other"
  );
});

/**
 * An extension's popup is in no tab, so no agent works in it, and it writes
 * the clipboard while an agent works elsewhere.
 */
add_task(async function an_extension_popup_writes_while_an_agent_works() {
  await layerSetup();
  await within(SimpleTest.promiseFocus(window), 10_000, "the user's window");
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.openPopupWithoutUserGesture.enabled", true]],
  });
  const ext = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["clipboardWrite"],
      browser_action: { default_popup: "popup.html" },
    },
    files: {
      "popup.html": `<!DOCTYPE html><meta charset="utf-8"><script src="popup.js"></script>`,
      "popup.js": () => {
        navigator.clipboard.writeText("written by the popup").then(
          () => browser.test.sendMessage("wrote", "written"),
          error => browser.test.sendMessage("wrote", error.name)
        );
      },
    },
    background() {
      browser.test.onMessage.addListener(() =>
        browser.browserAction.openPopup()
      );
    },
  });
  await ext.startup();
  SpecialPowers.clipboardCopyString("the user's own");
  ext.sendMessage("open");
  Assert.equal(await ext.awaitMessage("wrote"), "written", "the popup writes");
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "written by the popup",
    "the clipboard holds what the popup wrote"
  );
  await ext.unload();
});
