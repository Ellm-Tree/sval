/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Every popup a window opens stays inside that window
 * (`popups-stay-in-window.patch`): Sval's popovers and menus, and Firefox's
 * panels drawn as popovers, each opened in a small window, from its button
 * or at a point near the window's far corner, lie inside the window, and
 * what does not fit scrolls.
 */

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  REFUSED_NOTIFICATION:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  SvalBatterySaver:
    "moz-src:///browser/components/sval/SvalBatterySaver.sys.mjs",
  MODE_PREF: "moz-src:///browser/components/sval/SvalBatterySaver.sys.mjs",
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  SvalNoticesButton:
    "moz-src:///browser/components/sval/SvalNoticesButton.sys.mjs",
  SvalPopover: "moz-src:///browser/components/sval/SvalPopover.sys.mjs",
  SvalProtectionButton:
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs",
  SvalSiteStylePanel:
    "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
});

/**
 * The small window's size: wide enough for the header to keep its
 * buttons, and shorter than the site menu.
 */
const WIDTH = 900;
const HEIGHT = 420;

/** A Gecko rect may round to the device pixel on either side. */
const SLACK = 1;

/**
 * A small browser window on a page, closed when the task ends.
 *
 * @returns {Promise<Window>}
 */
async function smallWindow() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a window opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  const resized = BrowserTestUtils.waitForEvent(win, "resize");
  win.resizeTo(WIDTH, HEIGHT);
  await within(resized, 10_000, "the window shrinking");
  await windowStill(win);
  // Sval's default window is see-through where the system allows it: each
  // task checks a solid window, and makes it see-through where it checks
  // that look.
  await windowSeeThrough(false, win);
  await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.com/"),
    10_000,
    "a page opening"
  );
  return win;
}

/**
 * @param {Element} popup
 * @returns {DOMRect} where on the screen `popup` draws its content box.
 */
function contentOnScreen(popup) {
  // The popup's window, less the room its negative margin keeps around the
  // content for a shadow (`popup.css`, `sval-stem.css`).
  const outer = popup.getOuterScreenRect();
  const style = popup.documentGlobal.getComputedStyle(popup);
  const room = side => -parseFloat(style[`margin${side}`]);
  return new DOMRect(
    outer.x + room("Left"),
    outer.y + room("Top"),
    outer.width - room("Left") - room("Right"),
    outer.height - room("Top") - room("Bottom")
  );
}

/**
 * @param {Element} popup
 * @returns {DOMRect} where on the screen `popup`'s content box, its
 *   visible frame, is laid out.
 */
function frameOnScreen(popup) {
  const content = popup.shadowRoot.querySelector('[part~="content"]');
  const outer = popup.getOuterScreenRect();
  const box = popup.getBoundingClientRect();
  const inner = content.getBoundingClientRect();
  return new DOMRect(
    outer.x + inner.x - box.x,
    outer.y + inner.y - box.y,
    inner.width,
    inner.height
  );
}

/**
 * @param {Element} popup
 * @returns {boolean} whether the system draws `popup`'s corners: over its
 *   backdrop everywhere but macOS, whose see-through popups keep their own
 *   (`sval-popover.css`, `sval-menu.css`).
 */
function systemCorners(popup) {
  const win = popup.documentGlobal;
  return (
    win.getComputedStyle(popup).appearance === "auto" &&
    !win.matchMedia("(-moz-platform: macos)").matches
  );
}

/** How far in from each window edge every popup stays. */
function windowInset() {
  return Services.prefs.getIntPref("ui.popup.window_inset");
}

/**
 * Asserts the content `popup` draws lies inside its window, inset from each
 * of its edges, clear of what it opened from, and whole: its frame inside
 * its popup window, so its rounded corners show.
 *
 * @param {Element} popup
 * @param {string} what
 */
async function checkInside(popup, what) {
  const win = popup.documentGlobal;
  // A menu's window takes its place and size just after it shows.
  await TestUtils.waitForCondition(() => {
    const outer = popup.getOuterScreenRect();
    const box = popup.getBoundingClientRect();
    return (
      Math.abs(outer.width - box.width) <= SLACK &&
      Math.abs(outer.height - box.height) <= SLACK
    );
  }, `${what}'s window takes its size`);
  const rect = contentOnScreen(popup);
  const inset = windowInset();
  let left = win.mozInnerScreenX + inset;
  let top = win.mozInnerScreenY + inset;
  let right = win.mozInnerScreenX + win.innerWidth - inset;
  let bottom = win.mozInnerScreenY + win.innerHeight - inset;
  // A popup may reach as far as the button it grows from does, to line up
  // with it.
  if (popup.anchorNode?.checkVisibility()) {
    const a = popup.anchorNode.getBoundingClientRect();
    left = Math.min(left, win.mozInnerScreenX + a.left);
    top = Math.min(top, win.mozInnerScreenY + a.top);
    right = Math.max(right, win.mozInnerScreenX + a.right);
    bottom = Math.max(bottom, win.mozInnerScreenY + a.bottom);
  }
  Assert.greater(rect.width, 0, `${what} shows`);
  // Each edge's message carries where the popup and its window stood.
  const stood = JSON.stringify({
    outer: popup.getOuterScreenRect(),
    box: popup.getBoundingClientRect(),
    margin: win.getComputedStyle(popup).margin,
    window: [
      win.mozInnerScreenX,
      win.mozInnerScreenY,
      win.innerWidth,
      win.innerHeight,
    ],
    scale: win.devicePixelRatio,
  });
  Assert.greaterOrEqual(
    rect.left,
    left - SLACK,
    `${what}'s left edge is in: ${stood}`
  );
  Assert.greaterOrEqual(
    rect.top,
    top - SLACK,
    `${what}'s top edge is in: ${stood}`
  );
  Assert.lessOrEqual(
    rect.right,
    right + SLACK,
    `${what}'s right edge is in: ${stood}`
  );
  Assert.lessOrEqual(
    rect.bottom,
    bottom + SLACK,
    `${what}'s bottom edge is in: ${stood}`
  );

  const frame = frameOnScreen(popup);
  const outer = popup.getOuterScreenRect();
  Assert.ok(
    frame.top >= outer.top - SLACK &&
      frame.bottom <= outer.bottom + SLACK &&
      frame.left >= outer.left - SLACK &&
      frame.right <= outer.right + SLACK,
    `${what}'s frame is whole inside its popup window: ${stood}`
  );
  const content = popup.shadowRoot.querySelector('[part~="content"]');
  const style = win.getComputedStyle(content);
  for (const corner of [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
  ]) {
    // A stem's side follows the stem (`sval-stem.css`), so the corners
    // need not match.
    if (!systemCorners(popup)) {
      Assert.greater(
        parseFloat(style[corner]),
        0,
        `${what} keeps its ${corner}`
      );
    }
  }
  // What a person reads first is in the frame.
  const first = [...popup.querySelectorAll("*")].find(
    el => el.checkVisibility() && !el.children.length && el.textContent.trim()
  );
  if (first) {
    const at = first.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    Assert.greaterOrEqual(
      at.top,
      inner.top - SLACK,
      `${what}'s first line shows whole`
    );
  }
  const anchor = popup.anchorNode;
  if (anchor?.checkVisibility()) {
    const a = anchor.getBoundingClientRect();
    const onScreen = new DOMRect(
      win.mozInnerScreenX + a.x,
      win.mozInnerScreenY + a.y,
      a.width,
      a.height
    );
    const overlaps =
      frame.left < onScreen.right - SLACK &&
      frame.right > onScreen.left + SLACK &&
      frame.top < onScreen.bottom - SLACK &&
      frame.bottom > onScreen.top + SLACK;
    Assert.ok(!overlaps, `${what} leaves ${anchor.id || "its anchor"} clear`);
  }
}

/**
 * Opens a popup with `open`, checks it, and closes it with `close`.
 *
 * @param {Element} popup
 * @param {() => any} open
 * @param {string} what
 * @param {(popup: Element) => void} [close]
 * @returns {Promise<void>}
 */
async function whileOpen(popup, open, what, close = p => p.hidePopup()) {
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  await open();
  await within(shown, 10_000, `${what} opening`);
  await checkInside(popup, what);
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  close(popup);
  await within(hidden, 10_000, `${what} closing`);
}

/**
 * Waits for the popup `id` of `win` to show, as Firefox makes some only
 * as they first open.
 *
 * @param {Window} win
 * @param {string} id
 * @param {() => any} open
 * @param {(popup: Element) => void} close
 * @param {string} what
 */
async function whileOpenById(win, id, open, close, what) {
  const shown = BrowserTestUtils.waitForEvent(
    win.document,
    "popupshown",
    false,
    event => event.target.id === id
  );
  await open();
  const popup = (await within(shown, 10_000, `${what} opening`)).target;
  await checkInside(popup, what);
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  close(popup);
  await within(hidden, 10_000, `${what} closing`);
}

/**
 * Whether the point `x`, `y` lies inside `rect` with its corners rounded by
 * `radii`, as `getComputedStyle` gives each corner's radius.
 *
 * @param {DOMRect} rect
 * @param {{tl: number, tr: number, br: number, bl: number}} radii
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function inRounded(rect, radii, x, y) {
  if (
    x < rect.left - SLACK ||
    x > rect.right + SLACK ||
    y < rect.top - SLACK ||
    y > rect.bottom + SLACK
  ) {
    return false;
  }
  const corners = [
    [radii.tl, rect.left + radii.tl, rect.top + radii.tl],
    [radii.tr, rect.right - radii.tr, rect.top + radii.tr],
    [radii.br, rect.right - radii.br, rect.bottom - radii.br],
    [radii.bl, rect.left + radii.bl, rect.bottom - radii.bl],
  ];
  return corners.every(([r, cx, cy], i) => {
    const pastX = i === 0 || i === 3 ? x < cx : x > cx;
    const pastY = i < 2 ? y < cy : y > cy;
    return !(pastX && pastY) || Math.hypot(x - cx, y - cy) <= r + SLACK;
  });
}

/**
 * Asserts what scrolls in `popup` scrolls inside its content box, which
 * clips it to its rounded corners, and that each scroller's scrollbar
 * keeps out of those corners, with the content scrolled part way.
 *
 * @param {Element} popup
 * @param {string} what
 */
function checkScrollCorners(popup, what) {
  const win = popup.documentGlobal;
  const content = popup.shadowRoot.querySelector('[part~="content"]');
  const box = win.getComputedStyle(content);
  const scrolls = el =>
    el.scrollHeight > el.clientHeight + SLACK &&
    ["auto", "scroll"].includes(win.getComputedStyle(el).overflowY);
  Assert.ok(!scrolls(content), `${what}'s content box is no scroller`);
  Assert.ok(
    ["clip", "hidden"].includes(box.overflowY),
    `${what}'s content box clips what it holds`
  );
  const radii = {
    tl: parseFloat(box.borderTopLeftRadius),
    tr: parseFloat(box.borderTopRightRadius),
    br: parseFloat(box.borderBottomRightRadius),
    bl: parseFloat(box.borderBottomLeftRadius),
  };
  if (!systemCorners(popup)) {
    for (const [corner, r] of Object.entries(radii)) {
      Assert.greater(r, 0, `${what}'s ${corner} corner is rounded`);
    }
  }
  const scrollers = [...popup.querySelectorAll("*")].filter(scrolls);
  Assert.greater(scrollers.length, 0, `${what} scrolls what does not fit`);
  const frame = content.getBoundingClientRect();
  for (const scroller of scrollers) {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    Assert.ok(
      scroller.scrollTop > 0 || scroller.scrollHeight <= scroller.clientHeight,
      `${what} scrolls part way`
    );
    const rect = scroller.getBoundingClientRect();
    // The scrollbar stands at the scroller's end side, the width its
    // client box leaves.
    const bar = rect.width - scroller.clientWidth;
    const left = rect.right - Math.max(bar, 0);
    for (const [x, y, name] of [
      [left, rect.top, "top start"],
      [rect.right, rect.top, "top end"],
      [rect.right, rect.bottom, "bottom end"],
      [left, rect.bottom, "bottom start"],
      [rect.left, rect.top, "top-left"],
      [rect.left, rect.bottom, "bottom-left"],
    ]) {
      Assert.ok(
        inRounded(frame, radii, x, y),
        `${what}'s scroller's ${name} corner, scrollbar included, keeps inside the frame's rounded corners`
      );
    }
  }
}

add_task(async function the_site_menu_shrinks_and_scrolls() {
  const win = await smallWindow();
  const button = win.document.getElementById("sval-site-menu-button");
  const popup = win.document.getElementById("sval-site-menu");
  for (const look of ["solid", "see-through"]) {
    // A see-through window's popovers open with no stem, whose placing
    // keeps a stemmed one inside the window (`SvalStem`).
    if (look === "see-through") {
      await windowSeeThrough(true, win);
      if (!seeThroughWindow(win)) {
        return;
      }
    }
    const what = `the site menu in a ${look} window`;
    const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    button.click();
    await within(shown, 10_000, `${what} opening`);
    // In the see-through window it opens at its top, though the solid
    // window's open left it scrolled part way (`checkScrollCorners`).
    await checkInside(popup, what);
    checkScrollCorners(popup, what);
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await within(hidden, 10_000, `${what} closing`);
  }
});

add_task(async function sval_popovers_stay_inside() {
  const win = await smallWindow();
  const protection = SvalProtectionButton.forWindow(win);
  await whileOpen(
    protection.popover.popup,
    () => protection.open(),
    "Protections"
  );

  const stand = new EventTarget();
  stand.charging = false;
  atTaskEnd(SvalBatterySaver.useBatteryForTests(stand));
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, "unplugged"]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await whileOpen(
    SvalBatterySaver.popoverOf(win).popup,
    () => SvalBatterySaver.open(win),
    "Battery Saver"
  );

  atTaskEnd(() => AppMenuNotifications.removeNotification(/.*/));
  const notices = SvalNoticesButton.popoverOf(win);
  AppMenuNotifications.showNotification(
    "update-available",
    { callback() {} },
    { callback() {}, dismiss: true }
  );
  await TestUtils.waitForCondition(
    () => !win.document.getElementById("sval-notices-button").hidden,
    "the notices button shows"
  );
  if (notices.isOpen()) {
    await closePopover(notices);
  }
  await whileOpen(
    notices.popup,
    () => SvalNoticesButton.open(win),
    "the notices"
  );

  SvalSiteStylePanel.open(win);
  const colorshift = SvalSiteStylePanel.popoverOf(win);
  await TestUtils.waitForCondition(
    () => colorshift.popup.state === "open",
    "Colorshift showing"
  );
  await checkInside(colorshift.popup, "Colorshift");
  await closePopover(colorshift);
});

add_task(async function a_popover_at_the_far_corner_stays_inside() {
  const win = await smallWindow();
  const handle = SvalPopover.create(win.document, {
    label: "Tall",
    arrow: false,
  });
  atTaskEnd(() => handle.popup.remove());
  const tall = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div"
  );
  tall.style.cssText = "width: 400px; height: 900px";
  handle.popup.append(tall);
  await whileOpen(
    handle.popup,
    () =>
      handle.openAt(
        win.mozInnerScreenX + win.innerWidth - 20,
        win.mozInnerScreenY + win.innerHeight - 20
      ),
    "a tall popover put at the window's corner"
  );
});

add_task(async function a_long_menu_stays_inside() {
  const win = await smallWindow();
  const items = Array.from({ length: 60 }, (_, i) => ({
    id: `item${i}`,
    label: `Item ${i}`,
  }));
  const handle = SvalMenu.create(win.document, { items });
  atTaskEnd(() => handle.popup.remove());
  // The toolbar shows Stop in Reload's place while a page loads, and a menu
  // from a button that is not drawn has nowhere to grow from.
  const reload = win.document.getElementById("reload-button");
  await TestUtils.waitForCondition(
    () => reload.checkVisibility(),
    "the Reload button showing"
  );
  for (const look of ["solid", "see-through"]) {
    if (look === "see-through") {
      await windowSeeThrough(true, win);
      if (!seeThroughWindow(win)) {
        return;
      }
    }
    await whileOpen(
      handle.popup,
      () => handle.openFrom(win.document.getElementById("reload-button")),
      `a long menu from a button in a ${look} window`
    );
    await whileOpen(
      handle.popup,
      () =>
        handle.popup.openPopupAtScreen(
          win.mozInnerScreenX + win.innerWidth - 10,
          win.mozInnerScreenY + win.innerHeight - 10,
          true
        ),
      `a long menu at the window's corner in a ${look} window`
    );
  }
});

add_task(async function firefoxs_panels_stay_inside() {
  const win = await smallWindow();
  await whileOpenById(
    win,
    "unified-extensions-panel",
    () => win.gUnifiedExtensions.openPanel(),
    popup => win.PanelMultiView.hidePopup(popup),
    "the extensions panel"
  );
  await whileOpenById(
    win,
    "downloadsPanel",
    () => win.DownloadsPanel.showPanel(),
    () => win.DownloadsPanel.hidePanel(),
    "the downloads panel"
  );
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      browser_specific_settings: { gecko: { id: "theme@sval.invalid" } },
      name: "Red",
      theme: { colors: { frame: "#ff0000", tab_background_text: "#000" } },
    },
  });
  registerCleanupFunction(() => xpi.remove(false));
  const browser = win.gBrowser.selectedBrowser;
  await whileOpenById(
    win,
    "notification-popup",
    async () => {
      const install = await AddonManager.getInstallForFile(xpi);
      install.install().catch(() => {});
    },
    () =>
      win.PopupNotifications.getNotification(
        REFUSED_NOTIFICATION,
        browser
      )?.remove(),
    "a doorhanger"
  );
});
