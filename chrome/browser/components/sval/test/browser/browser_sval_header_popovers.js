/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The popovers that grow from the button that opened them (messages spec
 * §9.4, `SvalStem` and `sval-stem.css`): the header's
 * notices, extensions, downloads and site-settings panels, the workspace
 * panel's Favorites menu, the refused-install doorhanger on the extensions
 * button, and the media prompt on the media button. The Workspace menu
 * opens over its button instead (`browser_sval_switcher_menu.js`).
 */

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  REFUSED_NOTIFICATION:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  SITE_BRANCH: "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
  SvalSiteProtections:
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
});

registerCleanupFunction(() => AppMenuNotifications.removeNotification(/.*/));

// A click on the downloads button's foot reaches the button where the
// platform passes a press in the popover's shadow to the window below, and
// pressing it records that it was used (`SET_USAGE_PREF_BUTTONS` in
// BrowserUsageTelemetry.sys.mjs). Undone when the file ends, so no later
// file starts with it set.
add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.engagement.downloads-button.has-used"]],
  });
});

/** Where `sval-stem.css` draws no stem inside the popup. */
const OPAQUE_POPUPS = window.matchMedia(
  "(-moz-platform: linux) and (not (-moz-gtk-csd-transparency-available))"
).matches;

const px = value => parseFloat(value);

/**
 * How far two measures of one edge may differ: Gecko rounds a popup's place
 * to the nearest device pixel (`nsMenuPopupFrame::GetRects`), and keeps
 * lengths in app units, 60 to the CSS pixel.
 */
const TOLERANCE = 0.5 / window.devicePixelRatio + 1 / 60;

/**
 * @param {Element} root The element the popover grows from.
 * @returns {Element} Its pill.
 */
function faceOf(root) {
  return (
    root.querySelector(
      ":scope > :is(.toolbarbutton-icon, .toolbarbutton-badge-stack)"
    ) ?? root
  );
}

/**
 * The popup and its button are in different windows, so they are compared
 * on the screen.
 *
 * @param {Element} el An element of the browser window.
 * @returns {{left: number, top: number, right: number, bottom: number, width: number}}
 */
function onScreen(el) {
  const r = el.getBoundingClientRect();
  return {
    left: window.mozInnerScreenX + r.left,
    right: window.mozInnerScreenX + r.right,
    top: window.mozInnerScreenY + r.top,
    bottom: window.mozInnerScreenY + r.bottom,
    width: r.width,
  };
}

/**
 * @param {Element} popup
 * @returns {{left: number, top: number, right: number, width: number}} The popup's drawn
 *   content on the screen.
 */
function contentOf(popup) {
  const box = popup.getOuterScreenRect();
  const own = popup.getBoundingClientRect();
  const r = popup.shadowRoot
    .querySelector('[part~="content"]')
    .getBoundingClientRect();
  return {
    left: box.left + r.left - own.left,
    right: box.left + r.right - own.left,
    top: box.top + r.top - own.top,
    width: r.width,
  };
}

function near(actual, expected, message) {
  Assert.lessOrEqual(
    Math.abs(actual - expected),
    TOLERANCE,
    `${message}: ${actual} near ${expected}`
  );
}

/**
 * How far a side of the drawn shape may stand from the content's: a side
 * meant to meet the button's flush is drawn on the button's, and Gecko
 * places the popup's window on whole device pixels (`SvalHeader`,
 * `placeStemOf`).
 */
const FLUSH = 1 / window.devicePixelRatio + 1 / 60;

/**
 * @param {Element} popup
 * @returns {{outline: Element, fill: Element, edge: Element}|null} The SVG
 *   in the popover's shadow tree that draws its shape, and its two paths.
 */
function outlineOf(popup) {
  const outline = popup.shadowRoot?.querySelector(
    '[part~="sval-stem-outline"]'
  );
  if (!outline) {
    return null;
  }
  return {
    outline,
    fill: outline.querySelector('[part~="sval-stem-fill"]'),
    edge: outline.querySelector('[part~="sval-stem-edge"]'),
  };
}

/**
 * Checks the button `root` wears the fill `popup` draws its shape in.
 *
 * @param {Element} popup
 * @param {Element} root
 */
function checkSameFill(popup, root) {
  const rgba = color => {
    const { r, g, b, a } = InspectorUtils.colorToRGBA(color);
    return [r, g, b].map(Math.round).concat(+a.toFixed(3));
  };
  Assert.deepEqual(
    rgba(getComputedStyle(faceOf(root)).backgroundColor),
    rgba(getComputedStyle(outlineOf(popup).fill).fill),
    "the button takes the popover's fill"
  );
}

/**
 * Waits for the button `root`'s pill to finish fading to its fill.
 *
 * @param {Element} root
 */
async function settled(root) {
  await within(
    Promise.all(
      faceOf(root)
        .getAnimations()
        .map(a => a.finished)
    ),
    10_000,
    "the button's fill settling"
  );
}

/**
 * Checks `popup`, open, grows from `root`: the button wears its fill and
 * draws nothing else, and the popover's window draws the whole shape, from
 * the button's top to the content's foot, as one path with one edge.
 *
 * @param {Element} popup
 * @param {Element} root
 */
function checkGrows(popup, root) {
  Assert.equal(popup.getAttribute("sval-stem"), "placed", "the stem is placed");
  Assert.ok(root.hasAttribute("sval-stem"), "on the button that opened it");
  Assert.ok(
    !popup.shadowRoot?.querySelector(".panel-arrow, .panel-arrowcontainer"),
    "no arrow"
  );
  const face = onScreen(faceOf(root));
  const box = popup.getOuterScreenRect();
  const content = contentOf(popup);
  // A popover grows down from its button, or up from it where it names
  // that side (`sval-stem-side`).
  const up = popup.getAttribute("sval-stem-side") === "top";
  const part = popup.shadowRoot.querySelector('[part~="content"]');
  const contentFoot = content.top + px(getComputedStyle(part).height);
  if (up) {
    Assert.lessOrEqual(
      contentFoot,
      face.top + TOLERANCE,
      "the popover stands above its button"
    );
  } else {
    Assert.greaterOrEqual(
      content.top,
      face.bottom - TOLERANCE,
      "the popover hangs below its button"
    );
  }
  const drawn = outlineOf(popup);
  if (OPAQUE_POPUPS) {
    Assert.ok(
      !drawn || getComputedStyle(drawn.outline).visibility === "hidden",
      "an opaque popup draws no stem"
    );
    return;
  }

  // Each side of the content stands on its button's, in one straight edge,
  // or a fillet's room from it, so the stem's foot curves into it
  // (`SvalStem`, 12px fillets).
  const width = px(getComputedStyle(part).width);
  for (const room of [
    face.left - content.left,
    content.left + width - face.right,
  ]) {
    if (Math.abs(room) > TOLERANCE && room < 12 - TOLERANCE) {
      Assert.ok(false, `the content steps ${room}px out from the stem`);
    }
  }

  checkSameFill(popup, root);
  for (const el of new Set([root, faceOf(root)])) {
    Assert.equal(
      getComputedStyle(el).filter,
      "none",
      `the button's ${el.className || el.localName} draws no edge`
    );
  }
  Assert.ok(drawn, "the popover's window holds the outline");
  Assert.equal(
    getComputedStyle(drawn.outline).visibility,
    "visible",
    "and draws it"
  );
  const edge = drawn.edge.getAttribute("d");
  Assert.equal(edge.match(/M/g)?.length, 1, "the edge is one closed path");
  Assert.ok(
    drawn.fill.getAttribute("d").startsWith(edge),
    "and the fill is that path's shape"
  );
  Assert.equal(
    px(getComputedStyle(drawn.edge).strokeWidth),
    1,
    "stroked 1px wide"
  );
  Assert.notEqual(getComputedStyle(drawn.edge).stroke, "none");
  Assert.equal(
    getComputedStyle(part).backgroundColor,
    "rgba(0, 0, 0, 0)",
    "the content leaves its fill to the path"
  );
  Assert.equal(getComputedStyle(part).boxShadow, "none", "and its edge");

  // The edge runs half its width outside the shape.
  const bbox = drawn.edge.getBBox();
  // The shape's far ends: the button's and the content's.
  const [shapeTop, shapeFoot] = up
    ? [content.top, face.bottom]
    : [face.top, contentFoot];
  near(box.top + bbox.y, shapeTop - 0.5, "the edge runs over the shape's top");
  near(
    box.top + bbox.y + bbox.height,
    shapeFoot + 0.5,
    "down to the shape's foot"
  );
  Assert.lessOrEqual(
    Math.abs(box.left + bbox.x - (Math.min(face.left, content.left) - 0.5)),
    FLUSH,
    "from the shape's left"
  );
  Assert.lessOrEqual(
    Math.abs(
      box.left +
        bbox.x +
        bbox.width -
        (Math.max(face.right, content.right) + 0.5)
    ),
    FLUSH,
    "to its right"
  );

  const prop = name => px(popup.style.getPropertyValue(name));
  const tabTop = box.top + prop("--sval-stem-tab-top");
  const tabFoot = tabTop + prop("--sval-stem-tab-height");
  near(
    up ? tabFoot : tabTop,
    up ? face.bottom : face.top,
    "the stem's shadow box starts at the button's far edge"
  );
  near(
    up ? tabTop : tabFoot,
    up ? contentFoot : content.top,
    "and reaches the content"
  );

  const start = Math.max(face.left, content.left);
  const end = Math.min(face.right, content.right);
  for (const [side, room] of [
    ["left", start - content.left],
    ["right", content.right - end],
  ]) {
    const fillet = prop(`--sval-fillet-${side}`);
    const corner = prop(`--sval-corner-${side}`);
    Assert.equal(fillet, room >= 12 ? 12 : 0, `a ${side} fillet fits`);
    Assert.lessOrEqual(
      Math.abs(fillet + corner - room),
      FLUSH,
      `and the ${side} corner takes the rest: ${fillet + corner} near ${room}`
    );
  }
  Assert.greaterOrEqual(
    up ? face.top - contentFoot : content.top - face.bottom,
    12 - TOLERANCE,
    "the stem is tall enough for its fillets"
  );
}

/**
 * Checks `root` keeps nothing of the stem once `popup` has closed.
 *
 * @param {Element} popup
 * @param {Element} root
 */
function checkLetGo(popup, root) {
  Assert.ok(!popup.hasAttribute("sval-stem"), "the popover lets go");
  Assert.ok(!root.hasAttribute("sval-stem"), "and so does its button");
}

/**
 * Opens the popup `id` with `open`, runs `check` on it, and closes it.
 *
 * @param {string} id
 * @param {Function} open
 * @param {Function} check Given the popup and the element it grows from.
 * @param {Function} [close] Given the popup.
 */
async function whileOpen(id, open, check, close = popup => popup.hidePopup()) {
  let popup = null;
  atTaskEnd(async () => {
    if (popup && popup.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      close(popup);
      await within(hidden, 10_000, `${id} closing at task end`);
    }
  });
  const shown = BrowserTestUtils.waitForEvent(
    document,
    "popupshown",
    false,
    event => event.target.id === id
  );
  // An arrow panel's first `popuppositioned` comes before its window is
  // shown, so a stem placed by then is in the window's first paint. A menu
  // gets no `popuppositioned` (`nsXULPopupPositionedEvent::DispatchIfNeeded`).
  let firstPlaced = null;
  const positioned = event => {
    if (event.target.id === id && firstPlaced === null) {
      firstPlaced = {
        state: event.target.state,
        stem: event.target.getAttribute("sval-stem"),
        transitions: event.target.getAnimations().length,
      };
    }
  };
  document.addEventListener("popuppositioned", positioned, true);
  atTaskEnd(() =>
    document.removeEventListener("popuppositioned", positioned, true)
  );
  await open();
  popup = (await within(shown, 10_000, `${id} opening`)).target;
  if (!OPAQUE_POPUPS && popup.getAttribute("type") === "arrow") {
    Assert.deepEqual(
      firstPlaced,
      { state: "showing", stem: "placed", transitions: 0 },
      "the stem is placed before the popover is first drawn, in its place"
    );
  }
  const root = popup.anchorNode.closest("toolbarbutton") ?? popup.anchorNode;
  // A popover moved inside its window (`keepInWindow`, `SvalHeader`) moves
  // its frame, and its window follows at the next paint
  // (`nsMenuPopupFrame::SchedulePendingWidgetMoveResize`).
  await within(
    TestUtils.waitForCondition(() => {
      const box = popup.getOuterScreenRect();
      const own = popup.getBoundingClientRect();
      return (
        Math.abs(box.left - (window.mozInnerScreenX + own.left)) <= 1 &&
        Math.abs(box.top - (window.mozInnerScreenY + own.top)) <= 1
      );
    }, `${id}'s window at its frame`),
    10_000,
    `${id}'s window following its frame`
  );
  // The test hears `popupshown` after the popover's own listeners, which
  // can change its content in the same task: PanelMultiView's shows its main
  // view (`#activateView`). The stem's resize observer traces such a change
  // at the next rendering, before it is painted (`SvalHeader`,
  // `onStemPopupShowing`), so the shape is checked once the stem's foot has
  // followed the content's.
  await within(
    TestUtils.waitForCondition(() => {
      const drawn = outlineOf(popup);
      const part = popup.shadowRoot?.querySelector('[part~="content"]');
      if (
        OPAQUE_POPUPS ||
        !drawn ||
        !part ||
        popup.getAttribute("sval-stem") !== "placed"
      ) {
        return true;
      }
      const bbox = drawn.edge.getBBox();
      const top = popup.getOuterScreenRect().top;
      // The content's far edge from the button: its foot, or its top for a
      // popover above its button.
      if (popup.getAttribute("sval-stem-side") === "top") {
        return (
          Math.abs(top + bbox.y - (contentOf(popup).top - 0.5)) <= TOLERANCE
        );
      }
      const foot =
        contentOf(popup).top + px(getComputedStyle(part).height) + 0.5;
      return Math.abs(top + bbox.y + bbox.height - foot) <= TOLERANCE;
    }, `${id}'s stem at its content's far edge`),
    10_000,
    `${id}'s stem following its content`
  );
  await settled(root);
  await check(popup, root);
  if (popup.state !== "closed") {
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    close(popup);
    await within(hidden, 10_000, `${id} closing`);
  }
  checkLetGo(popup, root);
}

add_task(async function the_notices_popover_grows_from_its_button() {
  const button = document.getElementById("sval-notices-button");
  // An undismissed notice opens the popover itself.
  await whileOpen(
    "sval-notices-panel",
    () =>
      AppMenuNotifications.showNotification(
        "update-available",
        { callback() {} },
        { callback() {}, dismiss: true }
      ),
    (panel, root) => {
      Assert.equal(root, button, "the notices button");
      Assert.ok(root.hasAttribute("open"), "open");
      checkGrows(panel, root);
    }
  );
  AppMenuNotifications.removeNotification(/.*/);
});

// An update notice opens the popover at startup, before the Workspace's
// colours reach the window.
add_task(async function the_button_follows_the_window_colour_while_open() {
  if (OPAQUE_POPUPS) {
    return;
  }
  const rootStyle = document.documentElement.style;
  atTaskEnd(() => rootStyle.removeProperty("--sval-window-color"));
  await whileOpen(
    "sval-notices-panel",
    () =>
      AppMenuNotifications.showNotification(
        "update-available",
        { callback() {} },
        { callback() {}, dismiss: true }
      ),
    async (panel, root) => {
      const before = getComputedStyle(faceOf(root)).backgroundColor;
      rootStyle.setProperty("--sval-window-color", "rgb(120, 30, 90)");
      await settled(root);
      Assert.notEqual(
        getComputedStyle(faceOf(root)).backgroundColor,
        before,
        "the button's fill changes with the window's colour"
      );
      checkSameFill(panel, root);
    }
  );
  AppMenuNotifications.removeNotification(/.*/);
});

add_task(async function the_extensions_panel_grows_from_its_button() {
  await whileOpen(
    "unified-extensions-panel",
    () => gUnifiedExtensions.openPanel(),
    (panel, root) => {
      Assert.equal(root.id, "unified-extensions-button");
      Assert.ok(root.hasAttribute("open"), "open");
      checkGrows(panel, root);
    },
    panel => PanelMultiView.hidePopup(panel)
  );
});

/**
 * Resizes the browser window to `width` and waits for it.
 *
 * @param {number} width
 */
async function resizeWindow(width) {
  if (window.outerWidth === width) {
    return;
  }
  const resized = BrowserTestUtils.waitForEvent(window, "resize");
  window.resizeTo(width, window.outerHeight);
  await within(resized, 10_000, "the window resizing");
}

add_task(async function a_popover_at_the_window_edge_stays_in_the_window() {
  // Gecko keeps a popup on the screen, so the window stops short of the
  // screen's edge for the popover to have room to leave it.
  const width = window.outerWidth;
  atTaskEnd(() => resizeWindow(width));
  await resizeWindow(Math.min(width, screen.availWidth) - 200);
  const right = window.mozInnerScreenX + window.innerWidth;
  Assert.greaterOrEqual(
    screen.availLeft + screen.availWidth - right,
    32,
    "the screen reaches past the window"
  );
  await whileOpen(
    "downloadsPanel",
    () => DownloadsPanel.showPanel(),
    (panel, root) => {
      const face = onScreen(faceOf(root));
      // The content reaches 32px past its button, and its shadow
      // `--sval-stem-shadow-reach` further.
      Assert.less(
        right - face.right,
        32 + 15,
        "the downloads button is nearer the window's edge than the popover reaches past it"
      );
      checkGrows(panel, root);
      const content = contentOf(panel);
      Assert.lessOrEqual(
        content.right,
        right + TOLERANCE,
        "the popover stays inside the window"
      );
      Assert.greaterOrEqual(
        content.left,
        window.mozInnerScreenX - TOLERANCE,
        "on both sides"
      );
      Assert.greaterOrEqual(
        content.right,
        face.right - TOLERANCE,
        "and still reaches the end of its button"
      );
    },
    () => DownloadsPanel.hidePanel()
  );
  const panel = document.getElementById("downloadsPanel");
  Assert.equal(panel.style.marginLeft, "", "the popover lets go of its move");
  Assert.equal(panel.style.marginRight, "");
});

/**
 * Each popover a header button grows reaches past its button, so where it
 * reaches past the screen Gecko moves it whole with `flip="slide"`
 * (`nsMenuPopupFrame::SlideOrResize`); the default narrows it to the screen
 * and cuts off its side.
 */
add_task(async function each_header_popover_slides_along_the_screen() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    for (const { id, open, close } of stemPopovers()) {
      if (id.startsWith("sval-workspace") || id.startsWith("sval-favorites")) {
        continue;
      }
      await whileOpen(
        id,
        open,
        popup =>
          Assert.equal(popup.getAttribute("flip"), "slide", `${id} slides`),
        close
      );
    }
  });
});

add_task(async function a_popover_at_the_screen_edge_stays_in_the_window() {
  const width = window.outerWidth;
  const was = { x: window.screenX, y: window.screenY };
  atTaskEnd(async () => {
    await resizeWindow(width);
    window.moveTo(was.x, was.y);
    await within(
      TestUtils.waitForCondition(
        () => window.screenX === was.x && window.screenY === was.y,
        "the window back"
      ),
      10_000,
      "the window going back"
    );
  });
  await resizeWindow(Math.min(width, screen.availWidth) - 200);
  // Windows gives a window an invisible resize border outside what it
  // draws, so the drawn edge is placed at the screen's edge and the border
  // runs past it, as it does for a window snapped there.
  const border =
    window.screenX +
    window.outerWidth -
    (window.mozInnerScreenX + window.innerWidth);
  const x = screen.availLeft + screen.availWidth - window.outerWidth + border;
  window.moveTo(x, window.screenY);
  await within(
    TestUtils.waitForCondition(() => window.screenX === x, "the window moved"),
    10_000,
    "the window moving to the screen's edge"
  );
  const right = window.mozInnerScreenX + window.innerWidth;
  near(
    right,
    screen.availLeft + screen.availWidth,
    "the window meets the screen's edge"
  );
  await whileOpen(
    "unified-extensions-panel",
    () => gUnifiedExtensions.openPanel(),
    panel => {
      Assert.lessOrEqual(
        contentOf(panel).right,
        right + TOLERANCE,
        "the popover stays inside the window"
      );
    },
    panel => PanelMultiView.hidePopup(panel)
  );
});

add_task(async function the_downloads_panel_grows_from_its_button() {
  await whileOpen(
    "downloadsPanel",
    () => DownloadsPanel.showPanel(),
    (panel, root) => {
      Assert.equal(root.id, "downloads-button");
      Assert.ok(root.hasAttribute("open"), "open");
      checkGrows(panel, root);
    },
    () => DownloadsPanel.hidePanel()
  );
});

add_task(async function the_site_settings_grow_from_their_button() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("sval-site-menu-button");
    await whileOpen(
      "sval-site-menu",
      () => button.click(),
      (panel, root) => {
        Assert.equal(root, button, "the site menu's chevron");
        Assert.ok(root.hasAttribute("open"), "open");
        checkGrows(panel, root);
      }
    );
  });
});

add_task(async function the_protection_panel_grows_from_the_panels_address() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    // Firefox marks Home as taken out of `#nav-bar` once it moves
    // (`BrowserUsageTelemetry`), which the file puts back.
    set: [
      ["browser.sval.toolbar.inPanel", true],
      ["browser.engagement.home-button.has-removed", false],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("sval-protection-button");
    await TestUtils.waitForCondition(
      () => button.checkVisibility(),
      "Privacy and Security in the panel's address"
    );
    await whileOpen(
      "sval-protection-panel",
      () => button.click(),
      (panel, root) => checkGrows(panel, root)
    );
  });
});

add_task(async function the_favorites_menu_grows_from_its_button() {
  const button = SvalPanel._els.favorites;
  const popup = SvalPanel._els.favoritesMenu;
  await whileOpen(
    popup.id,
    () => button.click(),
    (_, root) => {
      Assert.equal(root, button, `${popup.id} hangs from its button`);
      Assert.equal(root.getAttribute("aria-expanded"), "true", "expanded");
      checkGrows(popup, root);
    }
  );
});

add_task(async function a_menu_on_the_other_side_lets_go() {
  const button = SvalPanel._els.favorites;
  const popup = SvalPanel._els.favoritesMenu;
  // Gecko flips a popup only where it has no room, which a test cannot
  // count on. The menu asked to grow down from its button and opened above
  // it lands where a flipped one would.
  popup.setAttribute("sval-stem-side", "bottom");
  atTaskEnd(() => popup.setAttribute("sval-stem-side", "top"));
  await whileOpen(
    popup.id,
    () => popup.openPopup(button, "before_start"),
    () => {
      Assert.less(
        popup.getOuterScreenRect().top,
        onScreen(button).top,
        "the menu is above its button"
      );
      Assert.ok(!popup.hasAttribute("sval-stem"), "the menu lets go");
      Assert.ok(!button.hasAttribute("sval-stem"), "and so does its button");
    }
  );
});

add_task(async function a_refused_install_grows_from_the_extensions_button() {
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      browser_specific_settings: { gecko: { id: "theme@sval.invalid" } },
      name: "Red",
      theme: { colors: { frame: "#ff0000", tab_background_text: "#000" } },
    },
  });
  registerCleanupFunction(() => xpi.remove(false));
  const install = await AddonManager.getInstallForFile(xpi);
  const browser = gBrowser.selectedBrowser;
  await whileOpen(
    "notification-popup",
    () => {
      install.install().catch(() => {});
    },
    (popup, root) => {
      Assert.ok(
        PopupNotifications.getNotification(REFUSED_NOTIFICATION, browser),
        "the refusal's doorhanger"
      );
      Assert.equal(root.id, "unified-extensions-button");
      checkGrows(popup, root);
    },
    () =>
      PopupNotifications.getNotification(
        REFUSED_NOTIFICATION,
        browser
      )?.remove()
  );
});

add_task(async function the_media_prompt_grows_from_the_media_button() {
  await SpecialPowers.pushPrefEnv({
    // Sval's default, Gecko's own; the harness allows autoplay.
    set: [["media.autoplay.default", Ci.nsIAutoplay.BLOCKED]],
  });
  SvalSiteProtections.setMediaDefault("ask");
  atTaskEnd(() => {
    clearPrefBranches(SITE_BRANCH);
    SvalSiteProtections.setMediaDefault("ask");
    Services.perms.removeAll();
  });
  const tab = await openPage(ROOT + "sval_media_gate_page.html");
  await whileOpen(
    "notification-popup",
    () =>
      asPage(tab.linkedBrowser, () => {
        const canvas = document.createElement("canvas");
        canvas.getContext("2d").fillRect(0, 0, 1, 1);
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = canvas.captureStream();
        document.body.append(video);
        return video.play().catch(() => {});
      }),
    (popup, root) => {
      Assert.equal(root.id, "sval-media-button");
      checkGrows(popup, root);
    },
    () =>
      PopupNotifications.getNotification(
        "sval-media",
        tab.linkedBrowser
      )?.remove()
  );
  BrowserTestUtils.removeTab(tab);
});

/**
 * Where the window, the screen and `popup` are, for the log of a click that
 * did not do what it should.
 *
 * @param {Element} popup
 * @returns {string}
 */
function geometryOf(popup) {
  const rect = r => r && [r.left, r.top, r.width, r.height].map(Math.round);
  const bbox = outlineOf(popup)?.edge.getBBox();
  return JSON.stringify({
    window: [
      window.screenX,
      window.screenY,
      window.outerWidth,
      window.outerHeight,
    ],
    inner: [
      window.mozInnerScreenX,
      window.mozInnerScreenY,
      window.innerWidth,
      window.innerHeight,
    ],
    screen: [screen.left, screen.top, screen.width, screen.height],
    popup: popup.state,
    box: rect(popup.getOuterScreenRect()),
    frame: rect(popup.getBoundingClientRect()),
    content: rect(
      popup.shadowRoot
        ?.querySelector('[part~="content"]')
        ?.getBoundingClientRect()
    ),
    stem: [
      popup.getAttribute("sval-stem"),
      rect(
        bbox && {
          left: bbox.x,
          top: bbox.y,
          width: bbox.width,
          height: bbox.height,
        }
      ),
    ],
    occluded: window.isFullyOccluded,
    hidden: document.hidden,
    focused: Services.focus.activeWindow === window,
    windows: Array.from(Services.wm.getEnumerator(null), win => [
      win.document.documentElement.getAttribute("windowtype") ||
        win.location.href,
      win.screenX,
      win.screenY,
      win.outerWidth,
      win.outerHeight,
      win.windowState,
    ]),
  });
}

/**
 * Waits for `popup`'s window to stand where its frame does. A popover that
 * moves while open, as `keepInWindow` moves one, has its frame in place at
 * once and its window there at its next paint
 * (`nsMenuPopupFrame::SchedulePendingWidgetMoveResize`). A press is read
 * where the window is, so one aimed by the frame before then lands
 * elsewhere.
 *
 * @param {Element} popup
 */
async function windowFollows(popup) {
  await within(
    TestUtils.waitForCondition(() => {
      const box = popup.getOuterScreenRect();
      const frame = popup.getBoundingClientRect();
      return (
        Math.abs(box.left - (window.mozInnerScreenX + frame.left)) <= 1 &&
        Math.abs(box.top - (window.mozInnerScreenY + frame.top)) <= 1 &&
        Math.abs(box.width - frame.width) <= 1
      );
    }, "the popover's window at its frame"),
    10_000,
    `${popup.id}'s window following its frame`
  );
}

/**
 * Clicks at `point` on the screen through the platform, as a person's click
 * arrives, with `popup` open, and checks the click closed it and left it
 * closed. The press and the release go to the browser window, so the
 * caller shows no popup's window covers `point`.
 *
 * @param {Element} popup
 * @param {{x: number, y: number}} point On the screen.
 * @param {string} what
 */
async function clickCloses(popup, point, what) {
  info(`clicking at ${JSON.stringify(point)}: ${geometryOf(popup)}`);
  Assert.equal(popup.state, "open", `${popup.id} is open before the click`);
  Assert.equal(Services.focus.activeWindow, window, "in the window in front");
  const seen = [];
  const onMouse = event =>
    seen.push(
      `${event.type} on ${event.target.id || event.target.localName} at ${event.screenX},${event.screenY}`
    );
  for (const type of ["mousedown", "mouseup", "mousemove"]) {
    window.addEventListener(type, onMouse, true);
    atTaskEnd(() => window.removeEventListener(type, onMouse, true));
  }
  atTaskEnd(() => info(`what the window saw: ${seen.join("; ")}`));
  const opened = [];
  const onShowing = event => opened.push(event.target);
  popup.addEventListener("popupshowing", onShowing);
  atTaskEnd(() => popup.removeEventListener("popupshowing", onShowing));
  // The click lands on the popover's own element or on the page, neither of
  // which the click is meant to operate.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  atTaskEnd(() => AccessibilityUtils.resetEnv());
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  // GTK synthesizes a press with no move of its own, so the pointer moves to
  // the point first, and the move is heard before the press is sent
  // (`nsWindow::SynthesizeNativeMouseEvent`).
  await nativeMouse({
    type: "mousemove",
    target: document.documentElement,
    screenX: point.x,
    screenY: point.y,
    eventTargetToListen: window,
  });
  for (const type of ["mousedown", "mouseup"]) {
    await nativeMouse({
      type,
      target: document.documentElement,
      screenX: point.x,
      screenY: point.y,
    });
  }
  await within(hidden, 10_000, `a click ${what} closing ${popup.id}`);
  // The platform hands input over in order, so once a later move reaches
  // the window, the click before it has been handled, and anything it
  // opened is opening.
  await nativeMouse({
    type: "mousemove",
    target: document.documentElement,
    screenX: point.x + 1,
    screenY: point.y,
    eventTargetToListen: window,
  });
  AccessibilityUtils.resetEnv();
  Assert.equal(popup.state, "closed", `a click ${what} closes ${popup.id}`);
  Assert.deepEqual(opened, [], "and does not open it again");
}

/**
 * Presses `popup` at `x`, `y` on the screen with the `mousedown` the
 * product hears (`onStemPopupPress`, `SvalHeader`), the press macOS
 * delivers, since there the popover's window takes its whole rect. Windows
 * and GTK leave the shadow margin out of the input region and pass a press
 * there to the browser window, where it is a click outside the popover,
 * which `a_click_outside_a_popover_closes_it` makes.
 *
 * @param {Element} popup
 * @param {number} x
 * @param {number} y
 */
function pressPopover(popup, x, y) {
  popup.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      screenX: x,
      screenY: y,
    })
  );
}

/**
 * Presses `popup` at `point`, which its window covers, and checks the press
 * closed it and did not open it again.
 *
 * @param {Element} popup
 * @param {{x: number, y: number}} point On the screen.
 * @param {string} what
 */
async function pressCloses(popup, point, what) {
  const box = popup.getOuterScreenRect();
  Assert.ok(
    point.x >= box.left &&
      point.x < box.right &&
      point.y >= box.top &&
      point.y < box.bottom,
    `${popup.id}'s window covers the press ${what}`
  );
  Assert.equal(popup.state, "open", `${popup.id} is open before the press`);
  const opened = [];
  const onShowing = event => opened.push(event.target);
  popup.addEventListener("popupshowing", onShowing);
  atTaskEnd(() => popup.removeEventListener("popupshowing", onShowing));
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  pressPopover(popup, point.x, point.y);
  await within(hidden, 10_000, `a press ${what} closing ${popup.id}`);
  Assert.equal(popup.state, "closed", `a press ${what} closes ${popup.id}`);
  Assert.deepEqual(opened, [], "and does not open it again");
}

/** The stem popovers, each with how it opens and closes. */
function stemPopovers() {
  const siteMenuButton = document.getElementById("sval-site-menu-button");
  return [
    {
      id: "unified-extensions-panel",
      open: () => gUnifiedExtensions.openPanel(),
      close: panel => PanelMultiView.hidePopup(panel),
    },
    {
      id: "downloadsPanel",
      open: () => DownloadsPanel.showPanel(),
      close: () => DownloadsPanel.hidePanel(),
    },
    { id: "sval-site-menu", open: () => siteMenuButton.click() },
    {
      id: "sval-protection-panel",
      open: () => document.getElementById("sval-protection-button").click(),
    },
    {
      id: SvalPanel._els.favoritesMenu.id,
      open: () => SvalPanel._els.favorites.click(),
    },
  ];
}

/**
 * A press on the button a popover grew from closes the popover. The
 * popover's window reaches over the button's foot, so the press there is
 * the popover's. An opaque popup's window stops below its button, and
 * there the press is a click outside the popover.
 */
add_task(async function a_press_on_its_button_closes_each_popover() {
  await moveWindowOnScreen();
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    for (const { id, open, close } of stemPopovers()) {
      await whileOpen(
        id,
        open,
        async (popup, root) => {
          await windowFollows(popup);
          const button = onScreen(root);
          const foot = {
            x: Math.round((button.left + button.right) / 2),
            y: Math.ceil(button.bottom) - 1,
          };
          if (!OPAQUE_POPUPS) {
            await pressCloses(popup, foot, "on its button");
            return;
          }
          Assert.less(
            foot.y,
            popup.getOuterScreenRect().top,
            "the popover's window stops below the button"
          );
          await clickCloses(popup, foot, "on its button");
        },
        close
      );
    }
  });
});

/**
 * A press on a popover's window outside what it draws, its shadow, closes
 * it; a press on its content or its stem leaves it open
 * (`pressPopover`).
 */
add_task(async function a_press_on_a_popovers_shadow_closes_it() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    for (const { id, open, close } of stemPopovers()) {
      await whileOpen(
        id,
        open,
        async (popup, root) => {
          await windowFollows(popup);
          const box = popup.getOuterScreenRect();
          const content = contentOf(popup);
          const own = popup.getBoundingClientRect();
          const drawn = popup.shadowRoot
            .querySelector('[part~="content"]')
            .getBoundingClientRect();
          const middle = Math.round(
            box.top + (drawn.top + drawn.bottom) / 2 - own.top
          );
          pressPopover(popup, Math.round(content.right) - 8, middle);
          Assert.equal(popup.state, "open", "a press on its content keeps it");
          // `nsXULElement::Click` presses its element at the screen's corner.
          popup.firstElementChild.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, button: 0 })
          );
          Assert.equal(
            popup.state,
            "open",
            "and so does a press on its own element, wherever it says it was"
          );
          if (OPAQUE_POPUPS) {
            return;
          }
          const face = onScreen(faceOf(root));
          info(`pressing the stem: ${geometryOf(popup)}`);
          // Between the content and the button, on whichever side it grows.
          const up = popup.getAttribute("sval-stem-side") === "top";
          pressPopover(
            popup,
            Math.round((face.left + face.right) / 2),
            up
              ? Math.round(content.top + drawn.height) + 4
              : Math.round(content.top) - 4
          );
          Assert.equal(popup.state, "open", "and so does one on its stem");
          const shadow = { x: Math.ceil(content.right) + 8, y: middle };
          // The window's room around its content is the margin the input
          // region leaves out (`--sval-stem-shadow-room`, `sval-stem.css`).
          const margin = px(
            getComputedStyle(
              popup.shadowRoot.querySelector('[part~="content"]')
            ).marginRight
          );
          Assert.ok(
            shadow.x < box.right && shadow.x >= box.right - margin,
            `the press is in the popover's window, in its shadow margin: ${shadow.x} in ${box.right - margin}..${box.right}`
          );
          await pressCloses(popup, shadow, "on its shadow");
        },
        close
      );
    }
  });
});

// `scripts/test.sh` runs macOS headless through `MOZ_HEADLESS`, which the
// manifest's `headless` does not see.
const headless = Cc["@mozilla.org/gfx/info;1"].getService(
  Ci.nsIGfxInfo
).isHeadless;

/**
 * A click on the page, outside a popover's window, closes the popover:
 * Gecko rolls up an open popup on a press outside it
 * (`nsXULPopupManager::Rollup`). A headless widget rolls nothing up, since
 * `HeadlessWidget::SynthesizeNativeMouseEvent` dispatches the press straight
 * to Gecko.
 */
add_task(
  { skip_if: () => headless },
  async function a_click_outside_a_popover_closes_it() {
    await moveWindowOnScreen();
    // A page with nothing to press: the server's root lists its files as
    // links, and a click on one starts a download, whose panel opens over
    // the popover (`browser.download.alwaysOpenPanel`) and is the popup the
    // next press rolls up.
    const plain = ROOT + "sval_agent_red.html";
    await BrowserTestUtils.withNewTab(plain, async browser => {
      for (const [index, { id, open, close }] of stemPopovers().entries()) {
        await whileOpen(
          id,
          open,
          async popup => {
            await windowFollows(popup);
            const page = onScreen(browser);
            // Windows reads a second press near the first within the
            // double-click time as a double click (`CS_DBLCLKS`), and
            // `nsWindow::DealWithPopups` rolls a popup up only on a
            // button-down message, so each popover is clicked at its own
            // point, well apart from the one before.
            const point = {
              x: Math.round(page.left) + 16 + 48 * index,
              y: Math.round(page.bottom) - 16,
            };
            const outside = el => {
              const r = el.getOuterScreenRect();
              return (
                point.x < r.left ||
                point.x >= r.right ||
                point.y < r.top ||
                point.y >= r.bottom
              );
            };
            const shown = [
              ...document.querySelectorAll("panel, menupopup"),
            ].filter(p => p.state !== "closed");
            Assert.deepEqual(
              shown.filter(p => !outside(p)).map(p => p.id),
              [],
              "no open popup's window covers the point"
            );
            Assert.equal(
              document.elementFromPoint(
                point.x - window.mozInnerScreenX,
                point.y - window.mozInnerScreenY
              ),
              browser,
              "the page lies under the point"
            );
            const onBackground = await SpecialPowers.spawn(
              browser,
              [point.x - page.left, point.y - page.top],
              (x, y) => {
                const doc = content.document;
                const el = doc.elementFromPoint(x, y);
                return el === doc.documentElement || el === doc.body;
              }
            );
            Assert.ok(onBackground, "and the press lands on its background");
            await clickCloses(popup, point, "on the page");
          },
          close
        );
      }
    });
  }
);

/**
 * A popover that changes size while open moves along its button
 * (`nsMenuPopupFrame::PerformMove`), and its stem follows it under the pill
 * once its window has moved.
 */
add_task(async function a_popover_that_grows_while_open_keeps_its_stem() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("sval-site-menu-button");
    await whileOpen(
      "sval-site-menu",
      () => button.click(),
      async (panel, root) => {
        const before = panel.getOuterScreenRect();
        const positioned = BrowserTestUtils.waitForEvent(
          panel,
          "popuppositioned"
        );
        const width = Math.round(
          parseFloat(getComputedStyle(panel).getPropertyValue("--panel-width"))
        );
        panel.style.setProperty("--panel-width", `${width + 120}px`);
        atTaskEnd(() => panel.style.removeProperty("--panel-width"));
        await within(positioned, 10_000, "the popover moving as it grows");
        await within(
          TestUtils.waitForCondition(
            () => panel.getOuterScreenRect().left !== before.left,
            "the popover's window following it"
          ),
          10_000,
          "the popover's window moving"
        );
        checkGrows(panel, root);
      }
    );
  });
});

/**
 * Resizes the browser window to `height` and waits for it.
 *
 * @param {number} height
 */
async function resizeWindowHeight(height) {
  if (window.outerHeight === height) {
    return;
  }
  const resized = BrowserTestUtils.waitForEvent(window, "resize");
  window.resizeTo(window.outerWidth, height);
  await within(resized, 10_000, "the window resizing");
}

/**
 * A popover taller than the room under its button in a short window stays
 * inside the window, still under its button.
 */
add_task(async function a_popover_in_a_short_window_stays_inside_it() {
  if (OPAQUE_POPUPS) {
    return;
  }
  const height = window.outerHeight;
  atTaskEnd(() => resizeWindowHeight(height));
  await resizeWindowHeight(
    Math.round(window.outerHeight - window.innerHeight + 260)
  );
  const foot = window.mozInnerScreenY + window.innerHeight;
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    for (const { id, open, close } of stemPopovers()) {
      await whileOpen(
        id,
        open,
        popup => {
          const content = contentOf(popup);
          const drawn = popup.shadowRoot
            .querySelector('[part~="content"]')
            .getBoundingClientRect();
          Assert.lessOrEqual(
            content.top + drawn.height,
            foot + TOLERANCE,
            `${id} stays inside the window`
          );
          Assert.equal(
            popup.getAttribute("sval-stem"),
            "placed",
            "and hangs from its button"
          );
        },
        close
      );
    }
  });
});

/**
 * Rasterizes `popup`'s edge path as its window does, at the window's device
 * scale from its top left, which Gecko puts on a whole device pixel
 * (`nsMenuPopupFrame::GetRects`), and checks the shape's left side where it
 * runs straight: from the face's top corner down the stem to its fillet, or
 * to the content's foot where the side runs flush. Every device row there
 * carries the same stroke in the same column.
 *
 * @param {Element} popup
 * @param {Element} root
 */
function checkEdgeColumn(popup, root) {
  const dpr = window.devicePixelRatio;
  const box = popup.getOuterScreenRect();
  const face = onScreen(faceOf(root));
  const content = contentOf(popup);
  const part = popup.shadowRoot.querySelector('[part~="content"]');
  const prop = name => px(popup.style.getPropertyValue(name));
  // The tab's radii, top left first: a popover above its button rounds the
  // face's foot, and the side runs from the content's foot down to it.
  const tabRadii = popup.style
    .getPropertyValue("--sval-stem-tab-radius")
    .split(" ")
    .map(px);
  const up = popup.getAttribute("sval-stem-side") === "top";
  const x = face.left - box.left;
  const contentTop = content.top - box.top;
  const contentFoot = contentTop + px(getComputedStyle(part).height);
  let from;
  let to;
  if (up) {
    from = contentFoot + 1;
    to = face.bottom - box.top - tabRadii[3] - 1;
    if (prop("--sval-fillet-left")) {
      from += 12;
    } else if (Math.abs(content.left - face.left) < FLUSH) {
      from = contentTop + px(getComputedStyle(part).borderTopLeftRadius) + 1;
    }
  } else {
    from = face.top - box.top + tabRadii[0] + 1;
    to = contentTop - 1;
    if (prop("--sval-fillet-left")) {
      to -= 12;
    } else if (Math.abs(content.left - face.left) < FLUSH) {
      to = contentFoot - px(getComputedStyle(part).borderBottomLeftRadius) - 1;
    }
  }
  Assert.greater(to - from, 4, "the side runs straight for some length");
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = Math.ceil((x + 8) * dpr);
  canvas.height = Math.ceil((to + 2) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.stroke(new Path2D(outlineOf(popup).edge.getAttribute("d")));
  const x0 = Math.max(0, Math.floor((x - 3) * dpr));
  const x1 = Math.ceil((x + 3) * dpr);
  const rows = [];
  for (let row = Math.ceil(from * dpr); row <= Math.floor(to * dpr); row++) {
    const { data } = ctx.getImageData(x0, row, x1 - x0, 1);
    let sum = 0;
    let moment = 0;
    for (let i = 0; i < x1 - x0; i++) {
      const alpha = data[i * 4 + 3];
      sum += alpha;
      moment += alpha * i;
    }
    rows.push({ sum, centre: moment / sum });
  }
  const sums = rows.map(r => r.sum);
  const centres = rows.map(r => r.centre);
  const spread = list => Math.max(...list) - Math.min(...list);
  info(
    `edge column at ${dpr}: ${rows.length} rows, coverage ${Math.min(...sums)}..${Math.max(...sums)}, centre ${Math.min(...centres)}..${Math.max(...centres)}`
  );
  Assert.lessOrEqual(
    Math.abs(Math.min(...sums) - 255 * dpr),
    0.03 * 255 * dpr,
    "every row carries one CSS pixel of edge"
  );
  Assert.lessOrEqual(
    spread(sums),
    0.02 * 255 * dpr,
    "the edge is one width along the side"
  );
  Assert.lessOrEqual(
    spread(centres),
    0.05,
    "and runs in one column, with no step where the button meets the popover"
  );
}

/**
 * At a fractional display scale the button stands on fractions of a device
 * pixel and the popover's window on whole ones; the popover's window draws
 * the whole outline, so its edge keeps one width and one line along the
 * button and the stem.
 */
add_task(async function each_popover_draws_one_outline_at_a_fractional_scale() {
  if (OPAQUE_POPUPS) {
    return;
  }
  const was = window.devicePixelRatio;
  await SpecialPowers.pushPrefEnv({
    set: [["layout.css.devPixelsPerPx", "1.37"]],
  });
  atTaskEnd(async () => {
    await SpecialPowers.popPrefEnv();
    await within(
      TestUtils.waitForCondition(
        () => window.devicePixelRatio === was,
        "the display scale back"
      ),
      10_000,
      "the display scale going back"
    );
  });
  await within(
    TestUtils.waitForCondition(
      () => window.devicePixelRatio !== was,
      "the fractional display scale"
    ),
    10_000,
    "the display scale changing"
  );
  Assert.notEqual(
    Math.round(window.devicePixelRatio),
    window.devicePixelRatio,
    "the scale is fractional"
  );
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    for (const { id, open, close } of stemPopovers()) {
      await whileOpen(
        id,
        open,
        (popup, root) => {
          checkGrows(popup, root);
          checkEdgeColumn(popup, root);
        },
        close
      );
    }
  });
});
