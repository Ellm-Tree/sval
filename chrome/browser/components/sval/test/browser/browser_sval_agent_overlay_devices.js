/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pip_helpers.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * The user's input that reaches a page without passing through the window
 * the overlay covers reaches it only once the user takes control
 * (agent-control spec §6): media keys, a gamepad, a Picture-in-Picture
 * window, and an input method's text. Each task checks the page hears none of
 * it while the agent controls the tab, and hears it once the user has taken
 * the tab.
 */

for (const helpers of ["sval_pip_helpers.js", "sval_take_control_helpers.js"]) {
  Services.scriptloader.loadSubScript(
    getRootDirectory(gTestPath) + helpers,
    this
  );
}

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

// Served from Mozilla's picture-in-picture tests (`!/` in browser.toml).
const VIDEO =
  "https://example.com/browser/toolkit/components/pictureinpicture/tests/test-video-long.mp4";

add_setup(async function () {
  failOnConsoleErrors();
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  // Opening picture-in-picture records that its toggle was used
  // (`PictureInPictureChild.sys.mjs`). Undone when the file ends.
  await SpecialPowers.pushPrefEnv({
    clear: [["media.videocontrols.picture-in-picture.video-toggle.has-used"]],
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      // Settings › Sites: "Allow sites to play video and audio" Always
      // allow. This file is about media that plays.
      ["media.autoplay.site-permission-only.default", 1],
      // `MediaControlService.generateMediaControlKey`, a media key as the
      // system's media key source hands it on.
      ["media.mediacontrol.testingevents.enabled", true],
      // `navigator.requestGamepadServiceTest`, a gamepad as the system's
      // gamepad service hands it on.
      ["dom.gamepad.test.enabled", true],
    ],
  });
});

/**
 * Evaluated in the page's own global, so it must stand alone. Plays a tone
 * long and loud enough for media keys to control it
 * (`HTMLMediaElement::ShouldStartMediaControlKeyListener`), from a WAV the
 * page makes, so it loads nothing.
 */
async function soundProbe() {
  const rate = 8000;
  const samples = rate * 6;
  const view = new DataView(new ArrayBuffer(44 + samples));
  const text = (at, s) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) {
    view.setUint8(
      44 + i,
      128 + Math.round(64 * Math.sin((i * 2 * Math.PI) / 18))
    );
  }
  const audio = document.createElement("audio");
  audio.id = "sound";
  audio.loop = true;
  audio.src = URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
  document.body.append(audio);
  await audio.play();
}

/**
 * Plays the tone in `browser`'s page, and waits for its tab's media
 * controller to know it is heard, which is when media keys could reach it.
 *
 * @param {object} browser
 * @returns {MediaController}
 */
async function playSound(browser) {
  await within(
    SpecialPowers.spawn(browser, [soundProbe.toString()], src =>
      content.wrappedJSObject.eval(`(${src})()`)
    ),
    10_000,
    "the page's sound playing"
  );
  const controller = browser.browsingContext.mediaController;
  await TestUtils.waitForCondition(
    () => controller.isAudible,
    "the tab's media is heard"
  );
  return controller;
}

/**
 * @param {object} browser
 * @returns {Promise<boolean>} Whether the page's tone is paused.
 */
function soundPaused(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("sound").paused
  );
}

/**
 * Media keys and the system's media controls go to the media of the user's
 * own tab while the agent controls its tab, even where the agent's started
 * last, and to the agent's tab once the user has taken it.
 */
add_task(async function media_keys_reach_the_page_only_once_taken() {
  const { win, browser } = await layerSetup();
  const user = await within(
    BrowserTestUtils.openNewForegroundTab(window.gBrowser, INPUT),
    10_000,
    "the user's tab opening"
  );
  const userController = await playSound(user.linkedBrowser);
  await TestUtils.waitForCondition(
    () => userController.isActive,
    "the user's media takes media keys"
  );
  const agentController = await playSound(browser);
  await settle(browser);
  Assert.ok(
    !agentController.isActive,
    "the agent's tab takes no media keys while the agent controls it"
  );
  MediaControlService.generateMediaControlKey("pause");
  await SpecialPowers.spawn(user.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("sound").paused,
      "the user's media pauses"
    )
  );
  Assert.ok(!(await soundPaused(browser)), "the agent's media plays on");

  await takeControlOf(win, browser);
  await TestUtils.waitForCondition(
    () => agentController.isActive,
    "the tab takes media keys once the user has taken it"
  );
  MediaControlService.generateMediaControlKey("pause");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("sound").paused,
      "the media key pauses the page's media"
    )
  );
});

/**
 * Evaluated in the page's own global, so it must stand alone. Presses
 * `button` on a gamepad the test service adds the first time. The service
 * answers before the press reaches the page's process:
 * `GamepadEventChannelParent::DispatchUpdateEvent` sends the press from a
 * later task than the answer.
 *
 * @param {number} button
 */
async function gamepadProbe(button) {
  if (!window.gamepadTest) {
    const service = navigator.requestGamepadServiceTest();
    const seen = [];
    addEventListener("gamepadconnected", () => seen.push("gamepadconnected"));
    const pad = await service.addGamepad(
      "045e-028e-Xbox 360 Controller",
      service.standardMapping,
      service.noHand,
      17,
      4,
      0,
      0,
      0
    );
    window.gamepadTest = { service, pad, seen };
  }
  const { service, pad } = window.gamepadTest;
  await service.newButtonEvent(pad, button, true, true);
}

/**
 * @param {object} browser
 * @param {number} button
 */
async function pressGamepad(browser, button) {
  await within(
    SpecialPowers.spawn(browser, [gamepadProbe.toString(), button], (src, b) =>
      content.wrappedJSObject.eval(`(${src})(${b})`)
    ),
    10_000,
    "the gamepad's press"
  );
}

/**
 * @param {object} browser
 * @returns {Promise<{seen: string[], pressed: number[]}>} The gamepad events
 *   the page has heard, and the buttons `getGamepads()` shows it pressed.
 */
function gamepadState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    seen: content.wrappedJSObject.gamepadTest.seen.slice(),
    pressed: content.navigator
      .getGamepads()
      .filter(Boolean)
      .flatMap(g =>
        g.buttons.flatMap((button, index) => (button.pressed ? [index] : []))
      ),
  }));
}

/**
 * A gamepad reaches the page neither by its events nor by `getGamepads()`
 * while the agent controls the tab, and reaches it once the user has taken
 * the tab.
 */
add_task(async function a_gamepad_reaches_the_page_only_once_taken() {
  const { win, browser } = await layerSetup();
  atTaskEnd(() =>
    within(
      SpecialPowers.spawn(browser, [], async () => {
        const test = content.wrappedJSObject.gamepadTest;
        await test?.service.removeGamepad(test.pad);
      }),
      10_000,
      "the gamepad's removal"
    )
  );
  await pressGamepad(browser, 0);
  // The second press's answer comes after the first press has reached the
  // page's process, and `settle` waits for the page to have handled it.
  await pressGamepad(browser, 1);
  await settle(browser);
  Assert.deepEqual(
    await gamepadState(browser),
    { seen: [], pressed: [] },
    "the page sees no gamepad while the agent controls the tab"
  );
  await takeControlOf(win, browser);
  await pressGamepad(browser, 2);
  await TestUtils.waitForCondition(async () => {
    const { seen, pressed } = await gamepadState(browser);
    return seen.includes("gamepadconnected") && pressed.includes(2);
  }, "the page sees the gamepad and its press once the user has taken the tab");
});

/**
 * Starts a muted, looping video at the top of `browser`'s page.
 *
 * @param {object} browser
 */
async function playVideo(browser) {
  await within(
    SpecialPowers.spawn(browser, [VIDEO], async src => {
      const video = content.document.createElement("video");
      video.id = "video";
      video.src = src;
      video.muted = true;
      video.loop = true;
      content.document.body.prepend(video);
      await video.play();
    }),
    10_000,
    "the video playing"
  );
}

/**
 * Asks for a Picture-in-Picture window from `browser`'s page, as a press of
 * the page's own button would: the video's player, or a document window.
 *
 * @param {object} browser
 * @param {"video"|"document"} kind
 * @returns {Promise<string|null>} The name of the error the page's request
 *   failed with, or null once the window is open.
 */
function requestPip(browser, kind) {
  return within(
    SpecialPowers.spawn(browser, [kind], async which => {
      SpecialPowers.wrap(content.document).notifyUserGestureActivation();
      try {
        if (which === "video") {
          await content.document
            .getElementById("video")
            .requestPictureInPicture();
        } else {
          await content.documentPictureInPicture.requestWindow();
        }
        return null;
      } catch (e) {
        return e.name;
      }
    }),
    10_000,
    `the page's ${kind} picture-in-picture request`
  );
}

/**
 * The page opens neither Picture-in-Picture's player for its video nor a
 * document Picture-in-Picture window while the agent controls the tab, and
 * opens both once the user has taken it. Giving the tab back closes both.
 */
add_task(async function picture_in_picture_opens_only_once_taken() {
  const { win, browser } = await layerSetup();
  await playVideo(browser);
  for (const kind of ["video", "document"]) {
    Assert.notEqual(
      await requestPip(browser, kind),
      null,
      `the page's ${kind} picture-in-picture request fails while the agent controls the tab`
    );
  }
  Assert.ok(
    !Services.wm.getEnumerator("Toolkit:PictureInPicture").hasMoreElements(),
    "no player opened"
  );

  await takeControlOf(win, browser);
  const windows = [];
  for (const kind of ["video", "document"]) {
    const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
    Assert.equal(
      await requestPip(browser, kind),
      null,
      `the page's ${kind} picture-in-picture window opens once the user has taken the tab`
    );
    windows.push(await within(opened, 10_000, `the ${kind} window`));
  }
  atTaskEnd(async () => {
    for (const pip of windows) {
      if (!pip.closed) {
        await within(
          BrowserTestUtils.closeWindow(pip),
          10_000,
          "a picture-in-picture window closing"
        );
      }
    }
  });
  Assert.equal(
    windows[0].document.documentElement.getAttribute("windowtype"),
    "Toolkit:PictureInPicture",
    "the first is the video's player"
  );
  Assert.ok(
    windows[1].browsingContext.isDocumentPiP,
    "the second is the page's document window"
  );

  const closed = windows.map(pip => BrowserTestUtils.domWindowClosed(pip));
  await giveBackFrom(win, browser);
  await within(closed[0], 10_000, "the player closing at the give-back");
  await within(
    closed[1],
    10_000,
    "the document window closing at the give-back"
  );
  Assert.ok(
    !(await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("video").paused
    )),
    "the video plays on in its page"
  );
});

/**
 * Leaving the agent's tab for another opens no Picture-in-Picture window for
 * the video playing in it while the agent controls the tab, and opens one
 * once the user has taken it.
 */
add_task(async function leaving_the_tab_opens_a_player_only_once_taken() {
  const { win, browser, tabEl, call, tabs, agent } = await layerSetup();
  Assert.equal(await startVideo(browser), "playing");
  let other;
  await leaveOpensNothing(
    browser,
    async () => {
      const { tab } = await call("open_tab", { url: PAGE });
      other = (await tabs.tabIn(agent, tab)).tab;
      await selectTab(other);
    },
    "no Picture-in-Picture window opens while the agent controls the tab"
  );

  await showTab(win, tabEl);
  await takeControlOf(win, browser);
  const player = await leaveOpensPlayer(browser, () => selectTab(other));
  await returnClosesPlayer(player, () => showTab(win, tabEl));
});

/**
 * An input method's composition, and dictation, which commits its text as
 * one, reach the window's focused element, which under the overlay is the
 * card: the page never holds the window's focus while the agent controls the
 * tab. Once the user has taken the tab and focused the page's field, the text
 * lands there.
 */
add_task(async function an_input_method_reaches_the_page_only_once_taken() {
  const { win, browser } = await layerSetup();
  const compose = () => {
    EventUtils.synthesizeCompositionChange(
      {
        composition: {
          string: "\u3042",
          clauses: [
            { length: 1, attr: Ci.nsITextInputProcessor.ATTR_RAW_CLAUSE },
          ],
        },
        caret: { start: 1, length: 0 },
      },
      win
    );
    EventUtils.synthesizeComposition({ type: "compositioncommitasis" }, win);
  };

  const before = await pageState(browser);
  compose();
  await settle(browser);
  const after = await pageState(browser);
  Assert.deepEqual(after.seen, before.seen, "the page heard nothing");
  Assert.equal(after.value, before.value, "nothing was written in the page");

  await takeControlOf(win, browser);
  await SpecialPowers.spawn(browser, [], () => {
    content.focus();
    content.document.getElementById("field").focus();
  });
  browser.focus();
  compose();
  // The field shows the composition string from its first change, before
  // the commit reaches the page, so the wait is for the commit's end.
  await TestUtils.waitForCondition(
    async () => (await pageState(browser)).seen.includes("compositionend"),
    "the page hears the composition end once the user has taken the tab"
  );
  Assert.equal(
    (await pageState(browser)).value,
    "あ",
    "and the composition lands in the page's field"
  );
});
