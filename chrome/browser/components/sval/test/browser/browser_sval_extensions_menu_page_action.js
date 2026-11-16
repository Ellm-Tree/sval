/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * An extension's page action shows on its row of the extensions menu while
 * the selected tab's page has it, and the extensions button carries the dot
 * then (`sval-page-actions.js`, `SvalExtensionsMenu.addPageActions`). The
 * address field holds none.
 */

const ID = "page-action@sval.invalid";

/**
 * A page action shown on example.com's pages, whose popup says it opened.
 *
 * @returns {Promise<object>} The extension, unloaded when the task ends.
 */
async function loadExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Page action test extension",
      browser_specific_settings: { gecko: { id: ID } },
      page_action: {
        default_title: "Page action test",
        default_popup: "popup.html",
        show_matches: ["https://example.com/*"],
      },
    },
    files: {
      "popup.html": `<!DOCTYPE html><meta charset="utf-8"><script src="popup.js"></script>`,
      "popup.js": () => {
        // eslint-disable-next-line no-undef -- the extension page's API
        browser.test.sendMessage("popup-opened");
      },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
  return extension;
}

function extensionsButton() {
  return document.getElementById("unified-extensions-button");
}

async function openMenu() {
  const panel = document.getElementById("unified-extensions-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  gUnifiedExtensions.openPanel();
  await within(shown, 10_000, "the extensions menu opening");
  atTaskEnd(async () => {
    if (panel.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      PanelMultiView.hidePopup(panel);
      await within(hidden, 10_000, "the extensions menu closing");
    }
  });
  return panel;
}

/**
 * @param {Element} panel The extensions menu.
 * @returns {?Element} The extension's page action control in its row.
 */
function actionIn(panel) {
  return (
    panel
      .querySelector(`.unified-extensions-item[extension-id="${ID}"]`)
      ?.querySelector(".sval-page-action") ?? null
  );
}

add_task(async function a_page_with_the_action_marks_the_extensions_button() {
  await loadExtension();
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    await within(
      TestUtils.waitForCondition(() =>
        extensionsButton().hasAttribute("sval-page-action")
      ),
      10_000,
      "the extensions button taking the dot"
    );
    Assert.equal(
      document.querySelector("#page-action-buttons [id^='pageAction-urlbar-']"),
      null,
      "the address field holds no page action"
    );
    const panel = await openMenu();
    const control = actionIn(panel);
    Assert.ok(control, "the extension's row shows its action");
    Assert.equal(
      control.getAttribute("aria-label"),
      "Page action test",
      "named by the extension's title"
    );
  });
  await within(
    TestUtils.waitForCondition(
      () => !extensionsButton().hasAttribute("sval-page-action")
    ),
    10_000,
    "the dot going with the page"
  );
});

add_task(async function a_page_without_the_action_shows_none() {
  await loadExtension();
  await BrowserTestUtils.withNewTab("https://example.org/", async () => {
    Assert.ok(
      !extensionsButton().hasAttribute("sval-page-action"),
      "the extensions button has no dot"
    );
    const panel = await openMenu();
    Assert.ok(
      panel.querySelector(`.unified-extensions-item[extension-id="${ID}"]`),
      "the extension has its row"
    );
    Assert.equal(actionIn(panel), null, "with no action on it");
  });
});

add_task(async function the_action_opens_its_popup_on_the_extensions_button() {
  const extension = await loadExtension();
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    await within(
      TestUtils.waitForCondition(() =>
        extensionsButton().hasAttribute("sval-page-action")
      ),
      10_000,
      "the extensions button taking the dot"
    );
    const panel = await openMenu();
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    const popupShown = BrowserTestUtils.waitForEvent(
      document,
      "popupshown",
      false,
      event => event.target.id.endsWith("-panel")
    );
    actionIn(panel).click();
    await within(hidden, 10_000, "the extensions menu closing");
    const { target: popup } = await within(
      popupShown,
      10_000,
      "the action's popup opening"
    );
    await within(
      extension.awaitMessage("popup-opened"),
      10_000,
      "the popup's page loading"
    );
    Assert.equal(
      popup.anchorNode,
      extensionsButton(),
      "the popup is on the extensions button"
    );
    const popupHidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    PanelMultiView.hidePopup(popup);
    await within(popupHidden, 10_000, "the action's popup closing");
  });
});
