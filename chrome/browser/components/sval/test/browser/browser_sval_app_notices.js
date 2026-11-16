/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's update notices on the header's notices button (`SvalNoticesButton`,
 * messages spec §5): the button shows, badged, while a notice exists, its
 * popover lists each with its buttons and opens itself once for a notice
 * not yet dismissed, and Firefox opens no doorhanger or badge on the app
 * menu button the header does not draw.
 */

ChromeUtils.defineESModuleGetters(this, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

registerCleanupFunction(() => AppMenuNotifications.removeNotification(/.*/));

const noticesButton = (win = window) =>
  win.document.getElementById("sval-notices-button");
const noticesPanel = (win = window) =>
  win.document.getElementById("sval-notices-panel");
const notices = (win = window) => [
  ...noticesPanel(win).querySelectorAll(".sval-notice"),
];
const buttons = notice => [...notice.querySelectorAll("button")];

// The Fluent files `SvalAppNotices` words Firefox's update notices from, so
// a test compares a line with the message it should come from.
const firefoxStrings = new Localization(
  [
    "branding/brand.ftl",
    "browser/appmenu.ftl",
    "browser/appMenuNotifications.ftl",
    "toolkit/global/popupnotification.ftl",
  ],
  true
);
const attributeOf = (message, name) =>
  message.attributes.find(a => a.name === name).value;

// Firefox's own doorhanger and badge for a notice, counted: neither has a
// button to show on.
const firefoxShown = { doorhanger: 0, badge: 0 };
const { _showNotificationPanel, _showBadge } = PanelUI;
PanelUI._showNotificationPanel = function (...args) {
  firefoxShown.doorhanger++;
  return _showNotificationPanel.apply(this, args);
};
PanelUI._showBadge = function (...args) {
  firefoxShown.badge++;
  return _showBadge.apply(this, args);
};
registerCleanupFunction(() => {
  PanelUI._showNotificationPanel = _showNotificationPanel;
  PanelUI._showBadge = _showBadge;
});

function assertNoAppMenuNotice() {
  Assert.equal(firefoxShown.doorhanger, 0, "Firefox opens no doorhanger");
  Assert.equal(firefoxShown.badge, 0, "nor badges its menu button");
}

async function buttonShown(shown, win = window) {
  await within(
    TestUtils.waitForCondition(
      () => noticesButton(win).hidden === !shown,
      "the notices button follows the notices"
    ),
    10_000,
    shown ? "the notices button showing" : "the notices button hiding"
  );
}

function popoverShown(what, win = window) {
  return within(
    BrowserTestUtils.waitForEvent(
      win.document,
      "popupshown",
      false,
      event => event.target.id === "sval-notices-panel"
    ),
    10_000,
    what
  );
}

async function openPopover(win = window) {
  const shown = popoverShown("the notices popover opening", win);
  noticesButton(win).click();
  await shown;
  return noticesPanel(win);
}

/**
 * Raises an undismissed notice and waits for the popover to open itself.
 *
 * @param {...any} args `AppMenuNotifications.showNotification`'s.
 */
async function raiseNotice(...args) {
  const shown = popoverShown("the notices popover opening itself");
  AppMenuNotifications.showNotification(...args);
  await shown;
}

async function closePopover(win = window) {
  const panel = noticesPanel(win);
  if (panel?.state === "open") {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await within(hidden, 10_000, "the notices popover closing");
  }
}

add_task(async function an_update_shows_the_button_and_badge() {
  Assert.ok(noticesButton().hidden, "no notice, no button");
  Assert.ok(!noticesButton().hasAttribute("badged"), "and no badge");
  AppMenuNotifications.showNotification(
    "update-restart",
    { callback() {} },
    { callback() {}, dismiss: true },
    { dismissed: true }
  );
  await buttonShown(true);
  Assert.ok(noticesButton().hasAttribute("badged"), "badged while shown");
  Assert.equal(
    noticesPanel()?.state ?? "closed",
    "closed",
    "a dismissed notice opens no popover"
  );
  assertNoAppMenuNotice();
  AppMenuNotifications.removeNotification(/.*/);
  await buttonShown(false);
  Assert.ok(!noticesButton().hasAttribute("badged"), "and the badge goes");
});

add_task(async function the_popover_lists_the_update_with_its_buttons() {
  let downloads = 0;
  const url = "https://example.com/release-notes";
  await raiseNotice(
    "update-available",
    { callback: () => downloads++ },
    { callback() {}, dismiss: true },
    { learnMoreURL: url }
  );
  const [notice] = notices();
  Assert.equal(notices().length, 1, "one notice");
  const [labels, text] = firefoxStrings.formatMessagesSync([
    "appmenu-update-available2",
    "appmenu-update-available-message2",
  ]);
  Assert.stringContains(
    notice.querySelector(".sval-notice-text").textContent,
    text.value,
    "in Firefox's words"
  );
  const [dismiss, download] = [
    ...notice.querySelectorAll(".sval-notice-buttons > button"),
  ];
  Assert.deepEqual(
    [dismiss.textContent, download.textContent],
    [
      attributeOf(labels, "secondarybuttonlabel"),
      attributeOf(labels, "buttonlabel"),
    ],
    "Firefox's buttons, secondary then primary"
  );
  Assert.ok(download.classList.contains("primary"), "Download is primary");
  const learnMore = notice.querySelector(".sval-notice-text .sval-notice-link");
  Assert.ok(learnMore, "the notice has the doorhanger's Learn more");
  const hidden = BrowserTestUtils.waitForPopupEvent(noticesPanel(), "hidden");
  download.click();
  await within(hidden, 10_000, "an answer closes the popover");
  Assert.equal(downloads, 1, "Download runs the update's action");
  await buttonShown(false);
  assertNoAppMenuNotice();
});

add_task(async function the_longest_notices_keep_their_buttons_on_one_row() {
  for (const id of ["update-manual", "update-other-instance"]) {
    await raiseNotice(id, { callback() {} }, { callback() {}, dismiss: true });
    const [secondary, main] = [
      ...notices()[0].querySelectorAll(".sval-notice-buttons > button"),
    ];
    Assert.equal(
      secondary.getBoundingClientRect().top,
      main.getBoundingClientRect().top,
      `${secondary.textContent} and ${main.textContent} sit side by side`
    );
    await closePopover();
    AppMenuNotifications.removeNotification(/.*/);
    await buttonShown(false);
  }
});

add_task(async function a_dismissed_update_is_one_row() {
  let restarts = 0;
  await raiseNotice(
    "update-restart",
    { callback: () => restarts++ },
    { callback() {}, dismiss: true }
  );
  const [dismiss] = notices()[0].querySelectorAll(
    ".sval-notice-buttons > button"
  );
  const [labels] = firefoxStrings.formatMessagesSync([
    "appmenu-update-restart2",
  ]);
  Assert.equal(
    dismiss.textContent,
    attributeOf(labels, "secondarybuttonlabel"),
    "the secondary button is Firefox's dismissing one"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(noticesPanel(), "hidden");
  dismiss.click();
  await within(hidden, 10_000, "an answer closes the popover");
  await TestUtils.waitForCondition(
    () => AppMenuNotifications.notifications[0]?.dismissed,
    "Dismiss dismisses the notice"
  );
  Assert.ok(!noticesButton().hidden, "a dismissed update keeps the button");
  await openPopover();
  const [row] = notices();
  Assert.ok(row.classList.contains("sval-notice-row"), "as one row");
  Assert.equal(row.localName, "button", "that is a button");
  const [banner] = firefoxStrings.formatMessagesSync([
    "appmenuitem-banner-update-restart",
  ]);
  Assert.equal(
    row.textContent,
    attributeOf(banner, "label"),
    "Firefox's banner, as its app menu keeps it"
  );
  row.click();
  Assert.equal(restarts, 1, "the row runs the update's main action");
  await buttonShown(false);
  await closePopover();
});

add_task(async function another_copy_uses_svals_sentence() {
  await raiseNotice(
    "update-other-instance",
    { callback() {} },
    { callback() {}, dismiss: true }
  );
  const [notice] = notices();
  const [firefoxText] = firefoxStrings.formatValuesSync([
    "appmenu-update-other-instance-message",
  ]);
  const text = notice.querySelector(".sval-notice-text").textContent;
  Assert.ok(text, "the notice says something");
  Assert.notEqual(text, firefoxText, "in Sval's own words");
  const labels = [
    ...notice.querySelectorAll(".sval-notice-buttons > button"),
  ].map(b => b.textContent);
  Assert.equal(labels.length, 2, "with two buttons");
  Assert.ok(labels.every(Boolean), "each labelled");
  await closePopover();
  AppMenuNotifications.removeNotification(/.*/);
  await buttonShown(false);
});

add_task(async function the_other_copy_quitting_turns_the_notice_to_restart() {
  const { UpdateListener } = ChromeUtils.importESModule(
    "resource://gre/modules/UpdateListener.sys.mjs"
  );
  // The other copy is a lock another process holds, so the service's own
  // answer stands in for it.
  const service =
    Cc["@mozilla.org/updates/update-service;1"].getService().wrappedJSObject;
  let otherCopy = true;
  Object.defineProperty(service, "isOtherInstanceHandlingUpdates", {
    configurable: true,
    get: () => otherCopy,
  });
  registerCleanupFunction(() => {
    delete service.isOtherInstanceHandlingUpdates;
    UpdateListener.reset();
  });
  const asked = popoverShown("the notices popover opening for the other copy");
  UpdateListener.showRestartNotification({}, false);
  await asked;
  Assert.deepEqual(
    notices().map(n => n.querySelector(".sval-notice-text").textContent),
    ["Close the other copy of Sval to finish updating."],
    "the notice asks for the other copy to close"
  );
  await closePopover();
  // The service looks again every app.update.checkOnlyInstance.interval.
  const restart = BrowserTestUtils.waitForEvent(
    document,
    "popupshown",
    false,
    event => event.target.id === "sval-notices-panel"
  );
  otherCopy = false;
  await within(restart, 30_000, "the restart notice replacing it");
  Assert.deepEqual(
    AppMenuNotifications.notifications.map(n => n.id),
    ["update-restart"],
    "the restart notice takes the other copy's place"
  );
  await closePopover();
  UpdateListener.reset();
  await buttonShown(false);
});

add_task(async function answering_hides_the_button_in_every_window() {
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    30_000,
    "a second window opening"
  );
  const shown = popoverShown(
    "the active window's popover opening itself",
    other
  );
  AppMenuNotifications.showNotification(
    "update-manual",
    { callback() {} },
    { callback() {}, dismiss: true }
  );
  await shown;
  await buttonShown(true);
  Assert.equal(
    noticesPanel()?.state ?? "closed",
    "closed",
    "the window behind opens no popover"
  );
  const download = notices(other)[0].querySelector(
    ".sval-notice-buttons > button.primary"
  );
  download.click();
  await buttonShown(false, other);
  await buttonShown(false);
  await within(
    BrowserTestUtils.closeWindow(other),
    30_000,
    "the second window closing"
  );
});

add_task(
  async function the_popover_it_opens_stays_until_the_button_is_clicked() {
    await raiseNotice(
      "update-restart",
      { callback() {} },
      { callback() {}, dismiss: true }
    );
    await moveWindowOnScreen();
    // Just below what the popover draws, in its window's shadow margin,
    // where macOS hands the press to the popover and other platforms to the
    // page.
    const panel = noticesPanel();
    const box = panel.getOuterScreenRect();
    const frame = panel.getBoundingClientRect();
    const content = panel.shadowRoot
      .querySelector('[part~="content"]')
      .getBoundingClientRect();
    const point = {
      screenX: Math.round(
        box.left - frame.left + (content.left + content.right) / 2
      ),
      screenY: Math.round(box.top - frame.top + content.bottom + 4),
    };
    // The click lands on the popover's window or the page, neither of which
    // the click is meant to operate.
    AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
    await nativeMouse({
      type: "mousemove",
      target: document.documentElement,
      ...point,
      eventTargetToListen: window,
    });
    for (const type of ["mousedown", "mouseup"]) {
      await nativeMouse({ type, target: document.documentElement, ...point });
    }
    // The platform hands input over in order, so once a later move reaches
    // the window, the click before it has been handled.
    await nativeMouse({
      type: "mousemove",
      target: document.documentElement,
      screenX: point.screenX + 1,
      screenY: point.screenY,
      eventTargetToListen: window,
    });
    AccessibilityUtils.resetEnv();
    Assert.equal(noticesPanel().state, "open", "a click elsewhere leaves it");
    const hidden = BrowserTestUtils.waitForPopupEvent(noticesPanel(), "hidden");
    noticesButton().click();
    await within(hidden, 10_000, "the button closing the popover");
    Assert.ok(
      !AppMenuNotifications.notifications[0].dismissed,
      "closing it leaves the notice undismissed"
    );
    // Another window activating is where a notice would open again.
    const other = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      30_000,
      "a second window opening"
    );
    await within(
      BrowserTestUtils.closeWindow(other),
      30_000,
      "the second window closing"
    );
    await buttonShown(true);
    Assert.equal(noticesPanel().state, "closed", "the popover stays closed");
    await openPopover();
    Assert.ok(
      !notices()[0].classList.contains("sval-notice-row"),
      "and lists the notice whole"
    );
    await closePopover();
    AppMenuNotifications.removeNotification(/.*/);
    await buttonShown(false);
  }
);

add_task(async function the_header_order_puts_notices_before_downloads() {
  const placements = CustomizableUI.getWidgetIdsInArea(
    CustomizableUI.AREA_NAVBAR
  );
  const at = placements.indexOf("sval-notices-button");
  Assert.deepEqual(
    placements.slice(at - 1, at + 2),
    ["unified-extensions-button", "sval-notices-button", "downloads-button"],
    "the notices button sits between the extensions button and downloads"
  );
});
