/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The media button shows wherever sound can be heard from (spec §10.7): a
 * tab's row, a collapsed group's row, and a workspace's entry in the
 * switcher. It pauses media the tab's media controller can pause and plays
 * it again, and mutes and unmutes sound with nothing to pause.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * Plays a looping media element with sound in `tab`'s page, and waits for
 * Firefox to mark the tab audible. Its five seconds of tone are made in the
 * page as a WAV file: the media controller takes only media longer than
 * `media.mediacontrol.eligible.media.duration.s`.
 *
 * @param {Element} tab A loaded tab.
 */
async function playVideo(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const rate = 8000;
    const samples = rate * 5;
    const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at, value) =>
      [...value].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    bytes.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVEfmt ");
    bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true);
    bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true);
    bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true);
    bytes.setUint16(34, 16, true);
    text(36, "data");
    bytes.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
      const value = Math.sin((2 * Math.PI * 440 * i) / rate) * 8000;
      bytes.setInt16(44 + i * 2, value, true);
    }
    const blob = new content.Blob([bytes.buffer], { type: "audio/wav" });
    const video = content.document.createElement("video");
    video.src = content.URL.createObjectURL(blob);
    video.loop = true;
    content.document.body.append(video);
    await video.play();
    // A player that declares its state, as YouTube does, and keeps declaring
    // "playing" after a pause: Gecko takes that over what the media does.
    content.navigator.mediaSession.playbackState = "playing";
  });
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("soundplaying"),
    "the tab is playing sound"
  );
}

/**
 * Starts a Web Audio tone in `tab`'s page, which no media controller sees.
 *
 * @param {Element} tab A loaded tab.
 */
async function playTone(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const context = new content.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    await context.resume();
  });
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("soundplaying"),
    "the tab is playing sound"
  );
}

/**
 * @param {Element} tab A tab playing {@link playVideo}'s video.
 * @returns {Promise<boolean>} whether the video is paused.
 */
function videoPaused(tab) {
  return SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.querySelector("video").paused
  );
}

/**
 * @param {string} id A node id.
 * @returns {string|null} the `data-media` its row carries.
 */
function rowMedia(id) {
  return SvalPanel._rowElementFor(id)?.getAttribute("data-media") ?? null;
}

/**
 * Records every value `id`'s row's `data-media` takes until `stop` is
 * called, so a task can see the button never pass through another state.
 *
 * @param {string} id A node id.
 * @returns {Function} stop, which answers the values in order.
 */
function recordRowMedia(id) {
  const el = SvalPanel._rowElementFor(id);
  const seen = [];
  const observer = new MutationObserver(() =>
    seen.push(el.getAttribute("data-media"))
  );
  observer.observe(el, { attributeFilter: ["data-media"] });
  return () => {
    observer.disconnect();
    return seen;
  };
}

/** @param {string} id A node id. */
function pressRowButton(id) {
  EventUtils.synthesizeMouseAtCenter(
    SvalPanel._rowElementFor(id).querySelector(".sval-row-audio"),
    {}
  );
}

add_setup(failOnConsoleErrors);

add_setup(async function media_plays_without_asking() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.site-permission-only.default", 1],
      // Firefox's own delay before it takes `soundplaying` off a tab, which
      // the test profile sets to nothing: the button must not wait for it.
      ["browser.tabs.delayHidingAudioPlayingIconMS", 3000],
    ],
  });
});

add_task(async function a_video_pauses_and_plays_again() {
  const { ids, observer } = await withSwitcherTabs();
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  Assert.equal(rowMedia(id), null, "a silent tab shows no button");

  await playVideo(tab);
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "pause",
    "a playing video offers to pause"
  );

  const stop = recordRowMedia(id);
  pressRowButton(id);
  await TestUtils.waitForCondition(() => videoPaused(tab), "the video pauses");
  Assert.ok(!tab.muted, "rather than playing on muted");
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "play",
    "and the row offers to play it again"
  );
  Assert.ok(
    tab.linkedBrowser.browsingContext.mediaController.isPlaying,
    "while the page still declares it playing: the button follows the media"
  );
  Assert.ok(
    tab.hasAttribute("soundplaying"),
    "and before Firefox stops counting the tab as playing sound"
  );
  await TestUtils.waitForCondition(
    () => !tab.hasAttribute("soundplaying"),
    "the tab stops counting as playing sound"
  );
  // A redraw writes the attribute again with the value it holds.
  const seen = stop().filter((value, i, all) => value !== all[i - 1]);
  Assert.deepEqual(
    seen.slice(seen.indexOf("play")),
    ["play"],
    "the row went to play and stayed there"
  );
  Assert.ok(!seen.includes("mute"), "never passing through mute");

  pressRowButton(id);
  await TestUtils.waitForCondition(
    async () => !(await videoPaused(tab)),
    "the video plays again"
  );
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "pause",
    "with the row offering to pause"
  );
});

add_task(async function the_row_follows_the_pages_own_player() {
  const { ids, observer } = await withSwitcherTabs();
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  await playVideo(tab);
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "pause",
    "the row offers to pause"
  );

  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.querySelector("video").pause()
  );
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "play",
    "paused in the page, the row offers to play"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.querySelector("video").play()
  );
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "pause",
    "played in the page, the row offers to pause"
  );
});

add_task(async function the_button_names_what_plays() {
  const { ids, observer } = await withSwitcherTabs();
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  await playVideo(tab);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.mediaSession.metadata = new content.MediaMetadata({
      title: "Hello Music Video",
      artist: "Some Artist",
    });
  });
  const tooltip = () =>
    SvalPanel._rowElementFor(id).querySelector(".sval-row-audio").title;
  await TestUtils.waitForCondition(
    () => tooltip().includes("Hello Music Video by Some Artist"),
    "the button names the page's media"
  );

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.mediaSession.metadata = new content.MediaMetadata({
      title: "The Next Song",
    });
  });
  await TestUtils.waitForCondition(
    () => tooltip().includes("The Next Song"),
    "and follows it to the next"
  );
});

add_task(async function sound_with_nothing_to_pause_mutes() {
  const { ids, observer } = await withSwitcherTabs();
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  await playTone(tab);
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "mute",
    "sound no controller holds offers to mute"
  );

  pressRowButton(id);
  await TestUtils.waitForCondition(() => tab.muted, "the tab is muted");
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "unmute",
    "and the row offers to unmute"
  );

  pressRowButton(id);
  await TestUtils.waitForCondition(() => !tab.muted, "the tab is unmuted");
  await TestUtils.waitForCondition(
    () => rowMedia(id) === "mute",
    "and the row offers to mute again"
  );
});

add_task(async function a_collapsed_group_stands_for_its_tabs() {
  const { ids, engine, observer } = await withSwitcherTabs();
  const [first] = ids.workspaces;
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  const group = crypto.randomUUID();
  await engine.mutate({
    kind: "addGroup",
    parent: first,
    name: "Music",
    id: group,
    now: Date.now(),
  });
  const { moveIntoTarget } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  await engine.mutate({
    kind: "moveNode",
    ...moveIntoTarget((await engine.tree()).nodes, id, group),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await playVideo(tab);

  Assert.equal(rowMedia(group), null, "an open group leaves it to its tab");
  await SvalPanel._setCollapsed(group, true);
  await TestUtils.waitForCondition(
    () => rowMedia(group) === "pause",
    "collapsed, the group offers to pause"
  );

  pressRowButton(group);
  await TestUtils.waitForCondition(() => videoPaused(tab), "its video pauses");
});

add_task(
  async function a_hidden_workspace_pauses_and_plays_from_the_switcher() {
    const { ids, observer } = await withSwitcherTabs();
    const [first, second] = ids.workspaces;
    const tab = observer.tabFor(ids.tabs[0]);
    await untilRestored(tab);
    await playVideo(tab);
    Assert.ok(
      await SvalWindowWorkspace.of(window).switchTo(second),
      "the window switched"
    );

    const menu = await openSwitcher();
    const [entry] = switcherEntries(menu, [first]);
    Assert.equal(
      entry.getAttribute("data-media"),
      "pause",
      "the entry of the workspace left offers to pause"
    );
    const press = () =>
      EventUtils.synthesizeMouseAtCenter(
        entry.querySelector(".sval-switcher-audio"),
        {}
      );
    press();
    await TestUtils.waitForCondition(
      () => videoPaused(tab),
      "its video pauses"
    );
    Assert.equal(menu.state, "open", "the switcher stays open");
    await TestUtils.waitForCondition(
      () => entry.getAttribute("data-media") === "play",
      "and the entry offers to play"
    );

    press();
    await TestUtils.waitForCondition(
      async () => !(await videoPaused(tab)),
      "the video plays again"
    );
    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      second,
      "all without switching"
    );
    await closeSwitcher(menu);
  }
);

add_task(async function the_footer_controls_what_plays_last() {
  const { ids, observer } = await withSwitcherTabs();
  const [, second] = ids.workspaces;
  const bar = SvalPanel._els.mediaBar;
  const [previous, back, toggle, , next] = bar.children;
  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  Assert.ok(bar.hidden, "with nothing playing the footer shows no controls");

  await playVideo(tab);
  await TestUtils.waitForCondition(() => !bar.hidden, "the controls show");
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched"
  );
  Assert.ok(!bar.hidden, "and stay for the workspace left playing");
  Assert.equal(bar.getAttribute("data-media"), "pause", "offering to pause");

  EventUtils.synthesizeMouseAtCenter(toggle, {});
  await TestUtils.waitForCondition(() => videoPaused(tab), "its video pauses");
  await TestUtils.waitForCondition(
    () => bar.getAttribute("data-media") === "play",
    "and the footer offers to play"
  );
  EventUtils.synthesizeMouseAtCenter(toggle, {});
  await TestUtils.waitForCondition(
    async () => !(await videoPaused(tab)),
    "the footer plays it again"
  );

  // Back seeks, and a page with no tracks shows no track buttons.
  Assert.ok(previous.hidden && next.hidden, "no tracks, no track buttons");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("video").currentTime = 4;
  });
  EventUtils.synthesizeMouseAtCenter(back, {});
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.querySelector("video").currentTime < 2
      ),
    "back went back ten seconds"
  );

  // A page with tracks gets a button for each it declares.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.mediaSession.setActionHandler("nexttrack", () => {
      content.document.body.dataset.next = "yes";
    });
  });
  await TestUtils.waitForCondition(() => !next.hidden, "next track shows");
  Assert.ok(previous.hidden, "and previous, which it lacks, does not");
  EventUtils.synthesizeMouseAtCenter(next, {});
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.body.dataset.next === "yes"
      ),
    "and plays it"
  );
});

add_task(async function the_footer_goes_with_the_tab_that_played() {
  const { ids, observer } = await withSwitcherTabs();
  const bar = SvalPanel._els.mediaBar;
  await untilRestored(observer.tabFor(ids.tabs[0]));
  Assert.ok(bar.hidden, "with nothing heard the footer shows no controls");
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      TITLED_TAB_URL.replace("%s", "media")
    ),
    10_000,
    "a tab of its own opening"
  );
  await playVideo(tab);
  await TestUtils.waitForCondition(() => !bar.hidden, "heard, it shows");
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => bar.hidden,
    "with the tab that played gone, nothing is left to control"
  );
});

add_task(async function the_footer_sits_in_the_middle() {
  const { ids, observer } = await withSwitcherTabs();
  const bar = SvalPanel._els.mediaBar;
  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  await playVideo(tab);
  await TestUtils.waitForCondition(() => !bar.hidden, "the controls show");
  // The middle of the footer's content, which stands nearer the page by its
  // padding (`sval-panel.css`, the room at each side of the panel's content).
  const footerEl = SvalPanel._els.footer;
  const footer = footerEl.getBoundingClientRect();
  const style = window.getComputedStyle(footerEl);
  const middle =
    (footer.left +
      parseFloat(style.paddingLeft) +
      footer.right -
      parseFloat(style.paddingRight)) /
    2;
  const own = bar.getBoundingClientRect();
  Assert.lessOrEqual(
    Math.abs(own.left + own.width / 2 - middle),
    2,
    "centred in the footer"
  );
});

add_task(async function play_works_after_the_next_track() {
  const { ids, observer } = await withSwitcherTabs();
  const bar = SvalPanel._els.mediaBar;
  const [, , toggle, , nextButton] = bar.children;
  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  await playVideo(tab);
  // A player that swaps in the next track paused, and plays through its own
  // Media Session handler, as video sites do.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const session = content.navigator.mediaSession;
    session.setActionHandler("nexttrack", () => {
      const old = content.document.querySelector("video");
      const next = content.document.createElement("video");
      next.src = old.src;
      next.loop = true;
      old.pause();
      old.remove();
      content.document.body.append(next);
    });
    session.setActionHandler("play", () =>
      content.document.querySelector("video").play()
    );
  });
  await TestUtils.waitForCondition(
    () => !nextButton.hidden,
    "next track shows"
  );
  EventUtils.synthesizeMouseAtCenter(nextButton, {});
  await TestUtils.waitForCondition(
    () => bar.getAttribute("data-media") === "play",
    "the next track waits, paused"
  );
  EventUtils.synthesizeMouseAtCenter(toggle, {});
  await TestUtils.waitForCondition(
    async () => !(await videoPaused(tab)),
    "and play plays it"
  );
});
