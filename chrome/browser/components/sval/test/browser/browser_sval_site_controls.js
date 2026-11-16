/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The site controls (decision 0132): the media button's states, its
 * allowance and its stop for a visit, which end when the tab leaves the
 * site; the site menu's saved media choice, its JavaScript switch and the
 * site's permissions; a device in use shown in the address pill; and the
 * sharing indicator opening the site menu.
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { SvalJavascript } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { mediaOf, mediaNameOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);

const SC_PAGE = "https://example.com/";
const SITE = "example.com";
const SC_OTHER = "https://example.org/";

function byId(id, win = window) {
  return win.document.getElementById(id);
}

function mediaButton(win = window) {
  return byId("sval-media-button", win);
}

function menuIn(win = window) {
  return byId("sval-site-menu", win);
}

/**
 * @returns {object} The selected page's media state, from `mediaOf`, once
 *   the button's tooltip is checked to name that state.
 */
function mediaShown() {
  const media = mediaOf(window);
  Assert.equal(
    mediaButton().getAttribute("tooltiptext"),
    mediaNameOf(media),
    "the media button's tooltip names its state"
  );
  return media;
}

async function openMenu(win = window) {
  const shown = BrowserTestUtils.waitForEvent(menuIn(win), "popupshown");
  byId("sval-site-menu-button", win).click();
  await within(shown, 5_000, "the site menu's popupshown");
}

async function closeMenu(win = window) {
  if (menuIn(win).state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menuIn(win), "popuphidden");
  menuIn(win).hidePopup();
  await within(hidden, 5_000, "the site menu's popuphidden");
}

/**
 * Runs the video probe as the page and waits for a blocked attempt to be
 * reported to the tab.
 *
 * @param {Element} browser
 * @returns {Promise<string>}
 */
async function tryToPlay(browser) {
  const blocked = BrowserTestUtils.waitForEvent(
    gBrowser,
    "GloballyAutoplayBlocked"
  );
  const play = await asPage(browser, videoProbe);
  await within(blocked, 10_000, "the tab's GloballyAutoplayBlocked");
  return play;
}

function reset() {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  SvalJavascript.removeRule(SITE);
  Services.perms.removeAll();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Sval's default, Gecko's own; the harness allows autoplay.
      ["media.autoplay.default", Ci.nsIAutoplay.BLOCKED],
    ],
  });
  registerCleanupFunction(reset);
});

add_task(async function the_button_lights_when_a_page_on_ask_tries_to_play() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "blocked",
      "media starts blocked"
    );
    Assert.equal(await tryToPlay(browser), "NotAllowedError", "blocked");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "the button lights up"
    );
    Assert.ok(mediaShown().tried, "and says the page tried to play");
    Assert.equal(menuIn().state, "closed", "nothing opens on its own");
  });
  reset();
});

add_task(async function a_never_site_stays_quiet() {
  reset();
  SvalSiteProtections.setMedia(SITE, "block");
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    await tryToPlay(browser);
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "refused",
      "a Never site is blocked without the light"
    );
    mediaShown();
    Assert.equal(
      SvalSiteProtections.ruleFor(SITE).media,
      "block",
      "and says it was the person's choice"
    );
  });
  reset();
});

add_task(async function a_visit_allowance_plays_until_the_tab_leaves() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    mediaButton().click();
    await within(reloaded, 10_000, "the reload allowing media");
    Assert.equal(mediaButton().getAttribute("sval-media"), "visit");
    Assert.equal(
      await asPage(browser, videoProbe),
      "resolved",
      "the page plays for the visit"
    );
    Assert.equal(
      SvalSiteProtections.mediaFor(SITE),
      "ask",
      "and nothing is saved"
    );

    const reloadedAgain = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await within(reloadedAgain, 10_000, "a reload on the same site");
    Assert.equal(
      await asPage(browser, videoProbe),
      "resolved",
      "the visit outlasts a reload"
    );

    const left = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, SC_OTHER);
    await within(left, 10_000, "leaving for another site");
    const back = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, SC_PAGE);
    await within(back, 10_000, "coming back");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "blocked",
      "the visit ended with leaving the site"
    );
    Assert.equal(await asPage(browser, videoProbe), "NotAllowedError");
  });
  reset();
});

add_task(async function a_page_using_a_device_shows_media_playing() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    Assert.equal(await tryToPlay(browser), "NotAllowedError", "blocked");
    Assert.equal(mediaButton().getAttribute("sval-media"), "asked");
    Assert.ok(
      getComputedStyle(mediaButton()).listStyleImage.endsWith('/media.svg")'),
      "the plain glyph, which the dot marks, with no slash"
    );
    // As webrtcUI reports a capture to the tab browser.
    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "camera", camera: 1, microphone: 1 },
    });
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "allowed",
      "a capture lets the page play"
    );
    Assert.equal(mediaShown().capture, "device", "playing for a device");
    Assert.equal(mediaButton().getAttribute("aria-disabled"), "true");
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.svalStillLoaded = true;
    });
    // The click is on a control the accessibility API reports as disabled,
    // which is the state under test.
    AccessibilityUtils.setEnv({ mustBeEnabled: false });
    mediaButton().click();
    AccessibilityUtils.resetEnv();
    Assert.ok(
      await SpecialPowers.spawn(
        browser,
        [],
        () => !!content.wrappedJSObject.svalStillLoaded
      ),
      "a click reloads nothing"
    );
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "allowed",
      "and changes nothing"
    );

    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "screen", screen: "Screen" },
    });
    Assert.equal(mediaShown().capture, "screen", "playing for a screen");

    gBrowser.updateBrowserSharing(browser, { webRTC: null });
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "the block shows again once the capture ends"
    );
    Assert.ok(!mediaButton().hasAttribute("aria-disabled"));
  });
  reset();
});

add_task(async function stopping_media_needs_no_reload() {
  reset();
  SvalSiteProtections.setMedia(SITE, "allow");
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    Assert.equal(mediaButton().getAttribute("sval-media"), "allowed");
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.svalStillLoaded = true;
    });
    mediaButton().click();
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "blocked",
      "a click stops media"
    );
    Assert.equal(
      await asPage(browser, videoProbe),
      "NotAllowedError",
      "for the rest of the visit"
    );
    Assert.ok(
      await SpecialPowers.spawn(
        browser,
        [],
        () => !!content.wrappedJSObject.svalStillLoaded
      ),
      "without reloading the page"
    );
    Assert.equal(
      SvalSiteProtections.mediaFor(SITE),
      "allow",
      "and the saved choice stays"
    );
  });
  reset();
});

add_task(async function the_site_menu_saves_the_media_choice() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    await openMenu();
    try {
      Assert.equal(
        menuIn().querySelector(".sval-prot-domain").textContent,
        SITE,
        "the menu names the site"
      );
      menuIn().querySelector('[data-value="block"]').click();
      Assert.equal(SvalSiteProtections.mediaFor(SITE), "block", "Never saved");
      menuIn().querySelector('[data-value="allow"]').click();
      Assert.equal(SvalSiteProtections.mediaFor(SITE), "allow", "Always saved");
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      await closeMenu();
      await within(reloaded, 10_000, "Always reloading once the menu closes");
      Assert.equal(await asPage(browser, videoProbe), "resolved", "plays");
    } finally {
      await closeMenu();
    }
  });
  reset();
});

function checkedMedia() {
  return menuIn().querySelector('[role="radiogroup"] input:checked')?.value;
}

/**
 * Makes the default for every site Always allow, as Settings › Sites does,
 * and returns what puts Sval's default back.
 */
function playEverywhere() {
  SvalSiteProtections.setMediaDefault("allow");
  return () => SvalSiteProtections.setMediaDefault("ask");
}

/**
 * The site menu's media control as a person sees it.
 *
 * @param {string} [page]
 * @returns {Promise<{choices: string[], checked: string}>}
 */
async function mediaControlOnSite(page = SC_PAGE) {
  return BrowserTestUtils.withNewTab(page, async () => {
    await openMenu();
    try {
      const group = menuIn().querySelector('[role="radiogroup"]');
      return {
        choices: [...group.querySelectorAll("label")].map(
          label => label.dataset.value
        ),
        checked: checkedMedia(),
      };
    } finally {
      await closeMenu();
    }
  });
}

/**
 * The site menu offers the default's three choices in the same order as
 * Settings › Sites, and checks what the site gets: the
 * default's choice where it has none, its own where it has one.
 */
add_task(async function the_site_menu_checks_what_the_site_gets() {
  for (const fallback of ["allow", "ask", "block"]) {
    for (const choice of ["", "allow", "ask", "block"]) {
      reset();
      SvalSiteProtections.setMediaDefault(fallback);
      SvalSiteProtections.setMedia(SITE, choice);
      const where = `default ${fallback}, site ${choice || "unset"}`;
      const control = await mediaControlOnSite();
      Assert.deepEqual(
        control.choices,
        ["allow", "ask", "block"],
        `${where}: the three choices`
      );
      Assert.equal(control.checked, choice || fallback, `${where}: checked`);
    }
  }
  reset();
});

add_task(async function ask_holds_a_site_where_the_default_plays() {
  reset();
  const restore = playEverywhere();
  try {
    await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
      Assert.equal(
        await asPage(browser, videoProbe),
        "resolved",
        "the default plays media"
      );
      await openMenu();
      try {
        menuIn().querySelector('[data-value="ask"]').click();
      } finally {
        await closeMenu();
      }
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      browser.reload();
      await within(reloaded, 10_000, "a fresh load of the page");
      Assert.equal(
        await tryToPlay(browser),
        "NotAllowedError",
        "the site's media waits"
      );
      Assert.equal(
        mediaButton().getAttribute("sval-media"),
        "asked",
        "and the button lights up as on Ask"
      );
      Assert.equal(
        await asPage(browser, videoProbe, { gesture: true }),
        "NotAllowedError",
        "a click on the page does not let it play"
      );
      const allowed = BrowserTestUtils.browserLoaded(browser);
      mediaButton().click();
      await within(allowed, 10_000, "the reload allowing media for the visit");
      Assert.equal(
        await asPage(browser, videoProbe),
        "resolved",
        "until the media button allows it"
      );
    });
    await BrowserTestUtils.withNewTab(SC_OTHER, async browser => {
      Assert.equal(
        await asPage(browser, videoProbe),
        "resolved",
        "and other sites still follow the default"
      );
    });
  } finally {
    restore();
  }
  reset();
});

add_task(async function choosing_the_media_choice_in_force_changes_nothing() {
  reset();
  SvalSiteProtections.setMedia(SITE, "ask");
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    let writes = 0;
    const counted = () => writes++;
    Services.prefs.addObserver(SITE_BRANCH, counted);
    let loads = 0;
    const { STATE_START, STATE_IS_DOCUMENT } = Ci.nsIWebProgressListener;
    const progress = {
      onStateChange(b, webProgress, request, flags) {
        if (
          b === browser &&
          webProgress.isTopLevel &&
          flags & STATE_START &&
          flags & STATE_IS_DOCUMENT
        ) {
          loads++;
        }
      },
    };
    gBrowser.addTabsProgressListener(progress);
    try {
      await openMenu();
      Assert.equal(checkedMedia(), "ask");
      menuIn().querySelector('[data-value="ask"]').click();
      Assert.equal(writes, 0, "the checked choice saves nothing");
      menuIn().querySelector('[data-value="allow"]').click();
      menuIn().querySelector('[data-value="ask"]').click();
      Assert.equal(
        SvalSiteProtections.mediaFor(SITE),
        "ask",
        "coming back to Ask saves Ask"
      );
      await closeMenu();
      // A reload the menu started reaches the content process before this
      // round trip does, and its load starts in the parent on the way.
      await SpecialPowers.spawn(browser, [], () => {});
      Assert.equal(loads, 0, "and the menu closes without reloading the page");

      await openMenu();
      const radio = menuIn().querySelector('[data-value="ask"] > input');
      radio.focus();
      // Always allow sits before Ask first.
      EventUtils.synthesizeKey("KEY_ArrowLeft");
      Assert.equal(checkedMedia(), "allow", "an arrow key moves the choice");
      Assert.equal(SvalSiteProtections.mediaFor(SITE), "allow", "and saves it");
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      await closeMenu();
      await within(reloaded, 10_000, "Always reloading once the menu closes");
    } finally {
      gBrowser.removeTabsProgressListener(progress);
      Services.prefs.removeObserver(SITE_BRANCH, counted);
      await closeMenu();
    }
  });
  reset();
});

add_task(async function the_site_menu_turns_javascript_off_for_the_site() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    await openMenu();
    try {
      const toggle = byId("sval-site-js");
      Assert.equal(toggle.getAttribute("aria-checked"), "true");
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      toggle.click();
      await within(reloaded, 10_000, "the reload turning JavaScript off");
      Assert.ok(!SvalJavascript.enabledFor(SITE), "saved for the site");
      Assert.equal(
        byId("sval-javascript-button").getAttribute("sval-js"),
        "off",
        "and the toolbar's button agrees"
      );
    } finally {
      await closeMenu();
    }
  });
  reset();
});

add_task(async function clearing_site_data_asks_then_clears() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      content.localStorage.setItem("sval-test", "kept");
    });
    await openMenu();
    try {
      byId("sval-site-data-clear").click();
      Assert.equal(
        document.activeElement,
        byId("sval-site-data-clear-go"),
        "the confirm takes the focus"
      );
      byId("sval-site-data-clear-cancel").click();
      Assert.ok(byId("sval-site-data-clear"), "Cancel puts the row back");
      byId("sval-site-data-clear").click();
      EventUtils.synthesizeKey("KEY_Escape", {}, window);
      Assert.ok(byId("sval-site-data-clear"), "so does Esc");
      Assert.equal(menuIn().state, "open", "which leaves the menu open");
      byId("sval-site-data-clear").click();
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      byId("sval-site-data-clear-go").click();
      await within(reloaded, 10_000, "the tab reloading");
      const kept = await SpecialPowers.spawn(browser, [], () =>
        content.localStorage.getItem("sval-test")
      );
      Assert.equal(kept, null, "the site's storage is gone");
      Assert.equal(menuIn().state, "open", "and the menu stays open");
    } finally {
      await closeMenu();
    }
  });
  reset();
});

add_task(async function the_site_menu_lists_and_changes_permissions() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    SitePermissions.setForPrincipal(
      browser.contentPrincipal,
      "geo",
      SitePermissions.ALLOW
    );
    await openMenu();
    try {
      for (const id of ["camera", "microphone", "geo", "popup"]) {
        Assert.ok(byId(`sval-site-perm-${id}`), `${id} is listed`);
      }
      Assert.equal(
        byId("sval-site-perm-geo").dataset.state,
        String(SitePermissions.ALLOW)
      );
      Assert.ok(
        !byId("sval-site-clear-geo").inert,
        "a saved permission can be cleared"
      );
      Assert.ok(byId("sval-site-clear-camera").inert, "one left to ask cannot");
      byId("sval-site-clear-geo").click();
      Assert.equal(
        SitePermissions.getForPrincipal(browser.contentPrincipal, "geo").state,
        SitePermissions.UNKNOWN,
        "clearing puts it back to ask"
      );
      Assert.equal(
        byId("sval-site-perm-geo").dataset.state,
        String(SitePermissions.UNKNOWN)
      );
      // The page keeps what it was granted until it loads again.
      const reloaded = BrowserTestUtils.browserLoaded(browser);
      await closeMenu();
      await within(reloaded, 10_000, "the reload once the menu closes");
    } finally {
      await closeMenu();
    }
  });
  reset();
});

add_task(async function the_popups_row_counts_what_the_page_was_denied() {
  reset();
  await SpecialPowers.pushPrefEnv({
    // Firefox's default, which the harness's profile turns off.
    set: [["dom.disable_open_during_load", true]],
  });
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const blocked = BrowserTestUtils.waitForEvent(
      gBrowser,
      "DOMUpdateBlockedPopups"
    );
    await asPage(browser, function openWithoutAClick() {
      return window.open("about:blank") === null;
    });
    await within(blocked, 10_000, "the tab's DOMUpdateBlockedPopups");
    await openMenu();
    try {
      const sub = byId("sval-site-perm-popup")
        .closest(".sval-site-perm")
        .querySelector(".sval-prot-sub");
      Assert.equal(sub?.dataset.why, "popups-blocked", "a blocked popup");
      Assert.equal(sub.textContent.match(/\d+/)?.[0], "1", "counted once");
    } finally {
      await closeMenu();
    }
  });
  await SpecialPowers.popPrefEnv();
  reset();
});

add_task(async function a_device_in_use_shows_in_the_pill() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const live = byId("sval-live-devices");
    Assert.ok(live.hidden, "no segment with nothing in use");
    // As webrtcUI reports a capture to the tab browser.
    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "camera", camera: 1, microphone: 1 },
    });
    Assert.ok(!live.hidden, "a segment while in use");
    const names = () =>
      [...live.querySelectorAll(".sval-live-cell")].map(cell => [
        cell.dataset.kind,
        cell.hasAttribute("sval-muted"),
        !!cell.getAttribute("aria-label"),
      ]);
    Assert.deepEqual(
      names(),
      [
        ["camera", false, true],
        ["microphone", false, true],
      ],
      "a named button for each device, in use"
    );
    // A muted camera, as MediaManager reports it disabled.
    gBrowser.updateBrowserSharing(browser, {
      webRTC: {
        sharing: "microphone",
        camera: Ci.nsIMediaManagerService.STATE_CAPTURE_DISABLED,
        microphone: 1,
      },
    });
    Assert.deepEqual(names(), [
      ["camera", true, true],
      ["microphone", false, true],
    ]);
    Assert.equal(
      live.querySelector('[data-kind="camera"] .sval-header-glyph').dataset
        .icon,
      "camera-off",
      "a muted camera crossed"
    );
    // Both muted: webrtcUI calls the capture paused.
    gBrowser.updateBrowserSharing(browser, {
      webRTC: {
        sharing: "camera",
        paused: true,
        camera: Ci.nsIMediaManagerService.STATE_CAPTURE_DISABLED,
        microphone: Ci.nsIMediaManagerService.STATE_CAPTURE_DISABLED,
      },
    });
    Assert.equal(names().length, 2, "muted devices keep their buttons");
    gBrowser.updateBrowserSharing(browser, { webRTC: null });
    Assert.ok(live.hidden, "gone once the capture ends");
  });
  reset();
});

/**
 * The sharing indicator, and on macOS the menu bar's sharing menu, bring a
 * capturing tab forward with its site menu open (`webrtcUI.showSharingDoorhanger`).
 * Firefox's permission panel would open at an anchor Sval hides.
 */
add_task(async function the_sharing_indicator_opens_the_site_menu() {
  reset();
  const { webrtcUI } = ChromeUtils.importESModule(
    "resource:///modules/webrtcUI.sys.mjs"
  );
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const sharing = gBrowser.getTabForBrowser(browser);
    await BrowserTestUtils.withNewTab(SC_OTHER, async () => {
      const shown = BrowserTestUtils.waitForEvent(menuIn(), "popupshown");
      webrtcUI.showSharingDoorhanger({ browser, tab: sharing }, null);
      await within(shown, 5_000, "the site menu's popupshown");
      await switchDone();
      Assert.equal(gBrowser.selectedTab, sharing, "the sharing tab is forward");
      Assert.notEqual(
        byId("permission-popup")?.state,
        "open",
        "Firefox's permission panel stays closed"
      );
      await closeMenu();
    });
  });
  reset();
});

add_task(async function a_private_window_keeps_its_own_media_choice() {
  reset();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  try {
    const browser = win.gBrowser.selectedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, SC_PAGE);
    await within(loaded, 15_000, "the page loading in the private window");
    await openMenu(win);
    menuIn(win).querySelector('[data-value="block"]').click();
    Assert.equal(
      SvalSiteProtections.mediaFor(SITE, win.gBrowser.defaultUserContextId),
      "block"
    );
    Assert.equal(
      SvalSiteProtections.mediaFor(SITE),
      "ask",
      "the normal window's choice is untouched"
    );
    Assert.ok(
      menuIn(win).querySelector(".sval-prot-footer") &&
        !menuIn(win).querySelector(".sval-prot-footer a"),
      "the private footer, which syncs nothing and links nowhere"
    );
    await closeMenu(win);
  } finally {
    await within(BrowserTestUtils.closeWindow(win), 10_000, "closing");
  }
  reset();
});

add_task(async function a_permission_prompt_opens_from_the_site_controls() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const popup = byId("notification-popup");
    const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
    // As PermissionUI shows a site's notifications prompt.
    const notification = PopupNotifications.show(
      browser,
      "web-notifications",
      "Allow example.com to send notifications?",
      "web-notifications-notification-icon",
      { label: "Allow", accessKey: "A", callback() {} },
      [{ label: "Block", accessKey: "B", callback() {} }]
    );
    await within(shown, 5_000, "the prompt's popupshown");
    const cell = byId("sval-live-devices").querySelector(
      '.sval-live-ask[data-state="asking"]'
    );
    Assert.ok(cell?.checkVisibility(), "the site controls show what it asks");
    Assert.equal(popup.anchorNode, cell, "and the prompt opens from there");
    // A page that tries to play while media is blocked redraws the site
    // controls on each try, as a call page does while it asks.
    let closed = false;
    const onHidden = () => (closed = true);
    popup.addEventListener("popuphidden", onHidden);
    Assert.equal(await tryToPlay(browser), "NotAllowedError", "blocked");
    Assert.equal(await tryToPlay(browser), "NotAllowedError", "again");
    popup.removeEventListener("popuphidden", onHidden);
    Assert.ok(!closed, "the prompt stays open");
    Assert.equal(popup.anchorNode, cell, "on the same cell");
    const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
    PopupNotifications.remove(notification);
    await within(hidden, 5_000, "the prompt's popuphidden");
    Assert.ok(byId("sval-live-devices").hidden, "the cell goes with it");
  });
  reset();
});

add_task(async function a_prompt_closed_unanswered_waits_with_the_dot() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const popup = byId("notification-popup");
    const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
    // As PermissionUI shows a site's notifications prompt.
    const notification = PopupNotifications.show(
      browser,
      "web-notifications",
      "Allow example.com to send notifications?",
      "web-notifications-notification-icon",
      { label: "Allow", accessKey: "A", callback() {} },
      [{ label: "Block", accessKey: "B", callback() {} }]
    );
    await within(shown, 5_000, "the prompt's popupshown");
    const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
    popup.hidePopup();
    await within(hidden, 5_000, "the prompt closing unanswered");
    const live = byId("sval-live-devices");
    await within(
      TestUtils.waitForCondition(
        () => live.querySelector(".sval-live-ask")?.dataset.state === "waiting",
        "the cell waiting"
      ),
      5_000,
      "the cell waiting"
    );
    const asks = live.querySelector(".sval-live-asks");
    Assert.equal(
      asks.dataset.says,
      "desktop-notification:waiting",
      "the site is asking"
    );
    Assert.ok(asks.getAttribute("aria-label"), "and the cell says so");
    const again = BrowserTestUtils.waitForEvent(popup, "popupshown");
    asks.click();
    await within(again, 5_000, "a click opening the prompt again");
    Assert.equal(menuIn().state, "closed", "in place of the site menu");
    const gone = BrowserTestUtils.waitForEvent(popup, "popuphidden");
    PopupNotifications.remove(notification);
    await within(gone, 5_000, "the prompt's popuphidden");
    Assert.ok(live.hidden, "the cell goes with the prompt");
  });
  reset();
});

add_task(async function a_blocked_device_the_page_tried_shows_crossed() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    const live = byId("sval-live-devices");
    // As WebRTCParent's prompt notifies a request the site's block denied.
    Services.obs.notifyObservers(browser, "sval-webrtc-blocked", "camera");
    const cell = live.querySelector(".sval-live-ask");
    Assert.ok(!live.hidden, "the segment shows the attempt");
    Assert.equal(cell?.dataset.state, "blocked", "as a blocked cell");
    Assert.equal(
      cell.querySelector(".sval-header-glyph").dataset.icon,
      "camera-off",
      "with the crossed camera"
    );
    Assert.equal(
      getComputedStyle(cell, "::after").content,
      "none",
      "and no dot"
    );
    Assert.equal(
      live.querySelector(".sval-live-asks").dataset.says,
      "camera:blocked",
      "the cell names the site's block"
    );
    const loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, SC_OTHER);
    await within(loaded, 10_000, "a navigation");
    Assert.ok(live.hidden, "the next page starts without it");
  });
  reset();
});

add_task(async function the_site_menu_lists_each_live_device() {
  reset();
  await BrowserTestUtils.withNewTab(SC_PAGE, async browser => {
    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "camera", camera: 1, microphone: 1 },
    });
    await openMenu();
    try {
      const section = byId("sval-site-in-use");
      Assert.ok(section, "an In use now section");
      Assert.strictEqual(
        section,
        menuIn().querySelector(".sval-site-section"),
        "first in the menu"
      );
      Assert.deepEqual(
        [...section.querySelectorAll(".sval-site-live")].map(
          row => row.dataset.kind
        ),
        ["camera", "microphone"]
      );
      for (const kind of ["camera", "microphone"]) {
        Assert.ok(
          byId(`sval-site-mute-${kind}`).getAttribute("aria-label"),
          `the ${kind}'s Mute is named`
        );
        Assert.ok(!byId(`sval-site-stop-${kind}`), `the ${kind} has no Stop`);
      }
    } finally {
      await closeMenu();
    }
    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "screen", screen: "Screen" },
    });
    await openMenu();
    try {
      Assert.ok(byId("sval-site-stop-screen"), "a shared screen has a Stop");
      Assert.ok(!byId("sval-site-mute-screen"), "and no Mute");
    } finally {
      await closeMenu();
    }
    gBrowser.updateBrowserSharing(browser, { webRTC: null });
    await openMenu();
    try {
      Assert.ok(!byId("sval-site-in-use"), "nothing live has no section");
      Assert.deepEqual(
        [...menuIn().querySelector(".sval-site-menu").childNodes]
          .filter(node => node.nodeType == Node.TEXT_NODE)
          .map(node => node.textContent),
        [],
        "and leaves no text in its place"
      );
    } finally {
      await closeMenu();
    }
  });
  reset();
});
