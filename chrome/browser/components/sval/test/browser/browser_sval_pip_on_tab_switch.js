/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pip_helpers.js */
/* import-globals-from sval_preferences_helpers.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A video playing in a tab the user leaves, for another tab or another
 * Workspace, goes on in a Picture-in-Picture window, and the window closes
 * when they come back to the tab. Settings › General › Media turns it off. A
 * video the media gate stopped is not playing, so it opens no window.
 */

for (const helpers of [
  "sval_pip_helpers.js",
  "sval_preferences_helpers.js",
  "sval_switcher_helpers.js",
]) {
  Services.scriptloader.loadSubScript(
    getRootDirectory(gTestPath) + helpers,
    this
  );
}

const SWITCHING_PREF =
  "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";
const VIDEO_PAGE = ROOT + "sval_media_gate_page.html";

add_setup(async function () {
  failOnConsoleErrors();
  await within(SvalPanel.started, 10_000, "the panel's startup");
  // Opening picture-in-picture records that its toggle was used
  // (`PictureInPictureChild.sys.mjs`). Undone when the file ends.
  await SpecialPowers.pushPrefEnv({
    clear: [["media.videocontrols.picture-in-picture.video-toggle.has-used"]],
  });
});

add_task(async function leaving_a_tab_takes_its_video_into_a_window() {
  Assert.ok(
    Services.prefs.getDefaultBranch("").getBoolPref(SWITCHING_PREF),
    "Sval turns it on by default"
  );
  allowMediaOn(VIDEO_PAGE);
  const first = gBrowser.selectedTab;
  const tab = await openPage(VIDEO_PAGE);
  Assert.equal(await startVideo(tab.linkedBrowser), "playing");

  const player = await leaveOpensPlayer(tab.linkedBrowser, () =>
    selectTab(first)
  );
  await returnClosesPlayer(player, () => selectTab(tab));
});

add_task(async function leaving_a_workspace_takes_its_video_into_a_window() {
  const { ids, observer } = await withSwitcherTabs();
  const [home, away] = ids.workspaces;
  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  // Allowed before the page loads, so its process has the permission.
  allowMediaOn(VIDEO_PAGE);
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    VIDEO_PAGE
  );
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, VIDEO_PAGE);
  await within(loaded, 10_000, "the video's page loading");
  Assert.equal(await startVideo(tab.linkedBrowser), "playing");

  const player = await leaveOpensPlayer(tab.linkedBrowser, async () => {
    Assert.ok(
      await SvalWindowWorkspace.of(window).switchTo(away),
      "switched away"
    );
    await switchDone();
  });
  Assert.ok(tab.hidden && tab.linkedPanel, "the video's tab is kept");
  await returnClosesPlayer(player, async () => {
    Assert.ok(
      await SvalWindowWorkspace.of(window).switchTo(home),
      "switched back"
    );
    await switchDone();
  });
  Assert.equal(gBrowser.selectedTab, tab, "the video's tab is shown");
});

add_task(async function the_settings_switch_turns_it_off() {
  keepPrefs(SWITCHING_PREF);
  let group;
  const control = () =>
    group?.querySelector(
      "#setting-control-pictureInPictureEnableWhenSwitchingTabs"
    );
  await openPane(
    "paneSync",
    ({ page }) => {
      group = page.document.querySelector('setting-group[groupid="media"]');
      return control()?.controlEl?.checkVisibility();
    },
    "the switch showing in General's Media group"
  );
  const input = control().controlEl;
  Assert.ok(input.checked, "the switch is on");
  Assert.ok(!input.disabled, "and can be turned off");
  input.click();
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref(SWITCHING_PREF),
    "the switch turning the pref off"
  );
  closeSettings();

  allowMediaOn(VIDEO_PAGE);
  const first = gBrowser.selectedTab;
  const tab = await openPage(VIDEO_PAGE);
  Assert.equal(await startVideo(tab.linkedBrowser), "playing");
  await leaveOpensNothing(
    tab.linkedBrowser,
    () => selectTab(first),
    "no Picture-in-Picture window opens with the switch off"
  );
});

add_task(async function a_video_the_media_gate_stopped_stays_in_its_tab() {
  const first = gBrowser.selectedTab;
  const tab = await openPage(VIDEO_PAGE);
  Assert.equal(
    await startVideo(tab.linkedBrowser),
    "NotAllowedError",
    "the media gate stops the video on a site with no choice of its own"
  );
  await leaveOpensNothing(
    tab.linkedBrowser,
    () => selectTab(first),
    "no Picture-in-Picture window opens for a stopped video"
  );
});
