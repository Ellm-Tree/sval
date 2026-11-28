/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's panels Firefox makes, the overflow », the extensions panel,
 * the downloads panel and the doorhangers, drawn as Sval's popovers
 * (`SvalPopover.adopt`): in a solid window each grows from its button with
 * its stem in the window's popup colours, and in a see-through window each
 * keeps its stem and wears the window's colour over the system's backdrop,
 * which takes the stem's shape.
 */

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  REFUSED_NOTIFICATION:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
});

/** Where `sval-stem.css` draws no stem inside the popup. */
const OPAQUE_POPUPS = window.matchMedia(
  "(-moz-platform: linux) and (not (-moz-gtk-csd-transparency-available))"
).matches;

/**
 * @param {Element} popup
 * @returns {Element} its content box, which draws its fill and edge.
 */
function contentOf(popup) {
  return popup.shadowRoot.querySelector('[part~="content"]');
}

/**
 * @param {string} color
 * @returns {number[]} its channels, rounded, to compare colours however
 *   each was written.
 */
function rgba(color) {
  const { r, g, b, a } = InspectorUtils.colorToRGBA(color);
  return [r, g, b].map(Math.round).concat(+a.toFixed(3));
}

/**
 * @param {Element} popup
 * @param {string} name A colour role, a custom property.
 * @returns {number[]} the role's colour on `popup`.
 */
function role(popup, name) {
  const doc = popup.ownerDocument;
  const probe = doc.createElement("div");
  probe.style.color = popup.documentGlobal
    .getComputedStyle(popup)
    .getPropertyValue(name);
  doc.documentElement.append(probe);
  const color = popup.documentGlobal.getComputedStyle(probe).color;
  probe.remove();
  return rgba(color);
}

/**
 * @param {Element} popup
 * @returns {string} where `popup`, its content, the face it grows from and
 *   its window stood, for a stem that never grows.
 */
function stoodAt(popup) {
  const win = popup.documentGlobal;
  const face = win.document.querySelector("[sval-stem-anchor]");
  const at = el => el && JSON.stringify(el.getBoundingClientRect());
  return JSON.stringify({
    stem: popup.getAttribute("sval-stem"),
    side: popup.getAttribute("sval-stem-side"),
    pending: popup.hasAttribute("sval-stem-pending"),
    state: popup.state,
    anchor: popup.anchorNode?.id || popup.anchorNode?.className,
    anchorAt: at(popup.anchorNode),
    button: at(popup.anchorNode?.closest("toolbarbutton")),
    face: at(face),
    outer: popup.getOuterScreenRect(),
    frame: at(popup),
    content: at(contentOf(popup)),
    margin: win.getComputedStyle(popup).margin,
    window: [
      win.mozInnerScreenX,
      win.mozInnerScreenY,
      win.innerWidth,
      win.innerHeight,
    ],
    screen: [
      win.screen.availLeft,
      win.screen.availTop,
      win.screen.availWidth,
      win.screen.availHeight,
    ],
  });
}

/**
 * Asserts `popup`, open in a solid window, is drawn by Sval's sheet with its
 * stem from its button, in its panel colours.
 *
 * @param {Element} popup
 * @param {string} what
 */
async function checkSolid(popup, what) {
  const win = popup.documentGlobal;
  Assert.ok(popup.hasAttribute("sval-popover"), `${what} is Sval's popover`);
  const style = win.getComputedStyle(popup);
  Assert.equal(style.appearance, "none", `${what} has no system look`);
  Assert.equal(
    style.backgroundColor,
    "rgba(0, 0, 0, 0)",
    `${what}'s popup window has no fill of its own`
  );
  // Firefox's popup tokens decide nothing on it.
  popup.style.setProperty("--arrowpanel-background", "rgb(255, 0, 0)");
  popup.style.setProperty("--background-color-canvas", "rgb(255, 0, 0)");
  atTaskEnd(() => {
    popup.style.removeProperty("--arrowpanel-background");
    popup.style.removeProperty("--background-color-canvas");
  });
  if (OPAQUE_POPUPS) {
    Assert.deepEqual(
      rgba(win.getComputedStyle(contentOf(popup)).backgroundColor),
      role(popup, "--panel-background-color"),
      `${what} is filled in its panel colour`
    );
    return;
  }
  await TestUtils.waitForCondition(
    () => popup.getAttribute("sval-stem") === "placed",
    `${what} grows its stem`
  ).catch(error => {
    throw new Error(`${error.message}: ${stoodAt(popup)}`);
  });
  Assert.deepEqual(
    rgba(
      win.getComputedStyle(
        popup.shadowRoot.querySelector('[part~="sval-stem-fill"]')
      ).fill
    ),
    role(popup, "--panel-background-color"),
    `${what}'s shape is filled in its panel colour`
  );
  Assert.deepEqual(
    rgba(win.getComputedStyle(contentOf(popup)).color),
    role(popup, "--panel-text-color"),
    `${what}'s text is its panel text`
  );
}

/**
 * Asserts `popup`, open in a see-through window, keeps its stem and wears
 * the window's colour over the system's backdrop in the stem's shape.
 *
 * @param {Element} popup
 * @param {string} what
 */
async function checkSeeThrough(popup, what) {
  const win = popup.documentGlobal;
  const root = win.document.documentElement;
  const accent = win
    .getComputedStyle(root)
    .getPropertyValue("--sval-tint-accent");
  Assert.ok(accent, "the window wears a colour over its backdrop");
  await checkSeeThroughLook(popup, accent, what);
}

/**
 * Opens `id` with `open` in `win`, runs `check` on it, and closes it with
 * `close`.
 *
 * @param {Window} win
 * @param {string} id
 * @param {() => any} open
 * @param {(popup: Element) => any} check
 * @param {(popup: Element) => void} close
 */
async function whileOpen(win, id, open, check, close) {
  const shown = BrowserTestUtils.waitForEvent(
    win.document,
    "popupshown",
    false,
    event => event.target.id === id
  );
  await open();
  const popup = (await within(shown, 10_000, `${id} opening`)).target;
  await check(popup);
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  close(popup);
  await within(hidden, 10_000, `${id} closing`);
}

/**
 * Checks the panel `id` in a solid window, then in a see-through one.
 *
 * @param {Window} win
 * @param {string} id
 * @param {() => any} open
 * @param {(popup: Element) => void} close
 * @param {string} what
 */
async function solidThenSeeThrough(win, id, open, close, what) {
  await windowSeeThrough(false, win);
  await whileOpen(win, id, open, popup => checkSolid(popup, what), close);
  await windowSeeThrough(true, win);
  if (!seeThroughWindow(win)) {
    Assert.ok(true, "this window cannot be see-through");
    return;
  }
  await whileOpen(win, id, open, popup => checkSeeThrough(popup, what), close);
}

add_task(async function the_overflow_panel() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a window opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  // Narrow enough that the header's controls overflow into the » panel.
  const button = win.document.getElementById("nav-bar-overflow-button");
  const resized = BrowserTestUtils.waitForEvent(win, "resize");
  win.resizeTo(1, win.outerHeight);
  await within(resized, 10_000, "the window narrowing");
  await TestUtils.waitForCondition(
    () => button.checkVisibility(),
    "the » button shows"
  );
  await windowStill(win);
  const navbar = win.document.getElementById("nav-bar");
  await solidThenSeeThrough(
    win,
    "widget-overflow",
    () => navbar.overflowable.show(),
    popup => win.PanelMultiView.hidePopup(popup),
    "the » panel"
  );
});

add_task(async function the_extensions_panel() {
  await solidThenSeeThrough(
    window,
    "unified-extensions-panel",
    () => gUnifiedExtensions.openPanel(),
    popup => PanelMultiView.hidePopup(popup),
    "the extensions panel"
  );
});

add_task(async function the_downloads_panel() {
  await solidThenSeeThrough(
    window,
    "downloadsPanel",
    () => DownloadsPanel.showPanel(),
    () => DownloadsPanel.hidePanel(),
    "the downloads panel"
  );
});

add_task(async function a_doorhanger() {
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      browser_specific_settings: { gecko: { id: "theme@sval.invalid" } },
      name: "Red",
      theme: { colors: { frame: "#ff0000", tab_background_text: "#000" } },
    },
  });
  registerCleanupFunction(() => xpi.remove(false));
  const browser = gBrowser.selectedBrowser;
  await solidThenSeeThrough(
    window,
    "notification-popup",
    async () => {
      const install = await AddonManager.getInstallForFile(xpi);
      install.install().catch(() => {});
    },
    () =>
      PopupNotifications.getNotification(
        REFUSED_NOTIFICATION,
        browser
      )?.remove(),
    "a doorhanger"
  );
});

/** What decides how a popup's window is filled, popup and content box. */
const FILL_PROPS = [
  "appearance",
  "-moz-default-appearance",
  "-moz-window-shadow",
  "-moz-window-opacity",
  "opacity",
  "color-scheme",
  "background-color",
];

/**
 * @param {Element} popup
 * @returns {object} how `popup` and its content box are filled.
 */
function fillOf(popup) {
  const of = el => {
    const style = getComputedStyle(el);
    return Object.fromEntries(
      FILL_PROPS.map(name => [name, style.getPropertyValue(name)])
    );
  };
  return { popup: of(popup), content: of(contentOf(popup)) };
}

add_task(async function each_firefox_panel_is_filled_as_a_popover_is() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    // A dark Workspace's colour, some of what is behind the window showing.
    if (!seeThroughWindow(window)) {
      // Where the window cannot see through, nothing shows behind it.
      Assert.ok(true, "this window cannot be see-through");
      return;
    }
    const siteMenu = document.getElementById("sval-site-menu");
    const shown = BrowserTestUtils.waitForPopupEvent(siteMenu, "shown");
    document.getElementById("sval-site-menu-button").click();
    await within(shown, 10_000, "the site menu opening");
    const popover = fillOf(siteMenu);
    const hidden = BrowserTestUtils.waitForPopupEvent(siteMenu, "hidden");
    siteMenu.hidePopup();
    await within(hidden, 10_000, "the site menu closing");

    for (const [id, open, close] of [
      [
        "unified-extensions-panel",
        () => gUnifiedExtensions.openPanel(),
        popup => PanelMultiView.hidePopup(popup),
      ],
      [
        "downloadsPanel",
        () => DownloadsPanel.showPanel(),
        () => DownloadsPanel.hidePanel(),
      ],
    ]) {
      await whileOpen(
        window,
        id,
        open,
        popup =>
          Assert.deepEqual(
            fillOf(popup),
            popover,
            `${id} is filled as the site menu, a SvalPopover, is`
          ),
        close
      );
    }
  });
});
