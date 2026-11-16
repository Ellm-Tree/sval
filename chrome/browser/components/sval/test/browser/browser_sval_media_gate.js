/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Under media.autoplay.site-permission-only, media plays only where the
 * top-level site's autoplay-media permission is ALLOW, or where it has none
 * and the choice for such sites is Always allow (protections spec §4.1),
 * whatever the user pressed on the page (decision 0132). A permission scoped
 * to the tab, as SitePermissions' SCOPE_TEMPORARY sets it, allows the site in
 * that tab only. Each blocked
 * case tells the front end through GloballyAutoplayBlocked. An
 * OfflineAudioContext makes no sound, so it renders on every site
 * (fingerprinting catalogue §2).
 *
 * The harness profile allows a page with a gesture to play
 * (media.autoplay.blocking_policy 0), so without the gate the probes after
 * one would play.
 */

const ORIGIN = "https://example.com";
const SITE = "example.com";

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

/** Evaluated in the page's own global, so each must stand alone. */
async function videoPolicyProbe() {
  const canvas = document.createElement("canvas");
  canvas.getContext("2d").fillRect(0, 0, 1, 1);
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = canvas.captureStream();
  document.body.append(video);
  const policy = navigator.getAutoplayPolicy(video);
  // A blocked play() rejects; an allowed one fires `playing`. `run` bounds
  // the wait.
  const play = await new Promise(resolve => {
    video.addEventListener("playing", () => resolve("resolved"), {
      once: true,
    });
    video.play().catch(e => resolve(e.name));
  });
  video.remove();
  return JSON.stringify({ play, policy });
}

async function audioContextProbe(expectAllowed) {
  // A blocked context reports `blocked` once when it is made and again from
  // resume(), which keeps its promise pending until the site is allowed. The
  // probe lets the first event pass before calling resume(), so the `blocked`
  // it races is resume()'s own: arriving first means resume() waits.
  const untilBlocked = (ctx, p) =>
    Promise.race([
      p.then(
        () => "resolved",
        e => e.name
      ),
      new Promise(resolve =>
        ctx.addEventListener("blocked", () => resolve("pending"), {
          once: true,
        })
      ),
    ]);
  const ctx = new AudioContext();
  const madeBlocked = new Promise(resolve =>
    ctx.addEventListener("blocked", resolve, { once: true })
  );
  const policy = navigator.getAutoplayPolicy(ctx);
  // An allowed resume() settles only when the output stream first calls back:
  // MediaTrackGraphImpl::CheckDriver applies a pending Resume only on an
  // AudioCallbackDriver off its fallback. That is the audio stack's to
  // deliver, and a stream whose callbacks never reach the content process
  // leaves it pending. The gate's answer is whether resume() was blocked,
  // which ReportBlocked sends as GloballyAutoplayBlocked and runCounted counts
  // once the content process is idle.
  let resume;
  if (expectAllowed) {
    ctx.resume().catch(() => {});
  } else {
    resume = await madeBlocked.then(() => untilBlocked(ctx, ctx.resume()));
  }
  const state = ctx.state;
  await ctx.close();
  return JSON.stringify({ resume, state, policy });
}

async function offlineProbe() {
  // Races `blocked`, so a gated render reports "pending" at once rather than
  // at `run`'s bound.
  const untilBlocked = (ctx, p) =>
    Promise.race([
      p.then(
        () => "resolved",
        e => e.name
      ),
      new Promise(resolve =>
        ctx.addEventListener("blocked", () => resolve("pending"), {
          once: true,
        })
      ),
    ]);
  const ctx = new OfflineAudioContext(1, 128, 44100);
  const render = await untilBlocked(ctx, ctx.startRendering());
  return JSON.stringify({ render, state: ctx.state });
}

function documentPolicyProbe() {
  return JSON.stringify({
    mediaelement: navigator.getAutoplayPolicy("mediaelement"),
    audiocontext: navigator.getAutoplayPolicy("audiocontext"),
  });
}

/**
 * Gives the page the sticky activation a click gives it.
 *
 * @param {Element} browser
 */
async function activate(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    content.document.notifyUserGestureActivation();
  });
}

/**
 * Logs what the page itself sees for its autoplay policy, read the way the
 * probes read it, as the page and through the same channel. A tab-scoped
 * grant reaches the content process as a message of its own; this shows
 * whether it had arrived when a probe ran.
 *
 * @param {Element} browser
 * @param {string} when
 */
async function logPagePolicy(browser, when) {
  const policy = await within(
    SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.eval(
        'navigator.getAutoplayPolicy("audiocontext")'
      )
    ),
    10_000,
    `the page's autoplay policy ${when}`
  );
  info(`page autoplay policy ${when}: ${policy}`);
}

/**
 * Runs a probe in the page.
 *
 * @param {Element} browser
 * @param {Function} probe
 * @param {*} [arg] Passed to the probe.
 */
async function run(browser, probe, arg) {
  return within(
    SpecialPowers.spawn(
      browser,
      [probe.toString(), JSON.stringify(arg ?? null)],
      async (src, json) =>
        JSON.parse(await content.wrappedJSObject.eval(`(${src})(${json})`))
    ),
    10_000,
    `the page's ${probe.name || "probe"}`
  );
}

/**
 * Runs a probe and counts the GloballyAutoplayBlocked events it causes.
 *
 * @param {Element} browser
 * @param {Function} probe
 * @param {*} [arg] Passed to the probe.
 */
async function runCounted(browser, probe, arg) {
  let notified = 0;
  const listener = () => notified++;
  const tabbrowser = browser.documentGlobal.gBrowser;
  tabbrowser.addEventListener("GloballyAutoplayBlocked", listener);
  try {
    const result = await run(browser, probe, arg);
    // Blocking posts GloballyAutoplayBlocked as a task in the content
    // process, and AutoplayChild forwards it over the same window actor
    // channel this reply takes. So once the content process has gone idle
    // and said so, every notification the probe caused has arrived and none
    // is left to be counted against the next probe.
    await within(
      SpecialPowers.spawn(
        browser,
        [],
        () => new Promise(resolve => ChromeUtils.idleDispatch(() => resolve()))
      ),
      10_000,
      `the content process going idle after the ${probe.name}`
    );
    result.notified = notified;
    return result;
  } finally {
    tabbrowser.removeEventListener("GloballyAutoplayBlocked", listener);
  }
}

/**
 * Runs every probe, counting each one's notifications.
 *
 * @param {Element} browser
 * @param {boolean} [expectAllowed] Whether the gate should let media start,
 *   so an AudioContext's resume() is checked for a block rather than raced.
 */
async function probeAll(browser, expectAllowed = false) {
  const result = {};
  for (const [name, probe] of [
    ["video", videoPolicyProbe],
    ["audio", audioContextProbe],
    ["offline", offlineProbe],
  ]) {
    result[name] = await runCounted(browser, probe, expectAllowed);
  }
  result.document = await run(browser, documentPolicyProbe);
  return result;
}

/**
 * @param {object} result What `probeAll` returned.
 * @param {string} where
 * @param {object} [options]
 * @param {boolean} [options.gesture] Whether the page had a user activation,
 *   which makes a blocked AudioContext's resume() report again.
 */
function assertBlocked(result, where, { gesture = false } = {}) {
  Assert.equal(result.video.play, "NotAllowedError", `${where}: video blocked`);
  Assert.equal(result.video.policy, "disallowed", `${where}: video policy`);
  Assert.equal(result.video.notified, 1, `${where}: video blocking notified`);
  Assert.equal(
    result.audio.resume,
    "pending",
    `${where}: AudioContext.resume() waits`
  );
  Assert.equal(
    result.audio.state,
    "suspended",
    `${where}: AudioContext stays suspended`
  );
  Assert.equal(result.audio.policy, "disallowed", `${where}: context policy`);
  Assert.equal(
    result.audio.notified,
    gesture ? 2 : 1,
    gesture
      ? `${where}: AudioContext blocking notified as made and on resume()`
      : `${where}: AudioContext blocking notified once`
  );
  Assert.equal(
    result.offline.render,
    "resolved",
    `${where}: OfflineAudioContext renders`
  );
  Assert.equal(
    result.offline.state,
    "closed",
    `${where}: OfflineAudioContext finished`
  );
  Assert.equal(
    result.offline.notified,
    0,
    `${where}: OfflineAudioContext not blocked`
  );
  Assert.deepEqual(
    result.document,
    { mediaelement: "disallowed", audiocontext: "disallowed" },
    `${where}: getAutoplayPolicy reports disallowed`
  );
}

function assertPlays(result, where) {
  Assert.notEqual(
    result.video.play,
    "NotAllowedError",
    `${where}: video plays`
  );
  Assert.equal(result.video.policy, "allowed", `${where}: video policy`);
  Assert.equal(
    result.audio.notified,
    0,
    `${where}: AudioContext and its resume() not blocked`
  );
  Assert.equal(result.audio.policy, "allowed", `${where}: context policy`);
  Assert.equal(result.offline.render, "resolved", `${where}: offline renders`);
  Assert.equal(
    result.video.notified + result.audio.notified + result.offline.notified,
    0,
    `${where}: nothing notified`
  );
  Assert.deepEqual(
    result.document,
    { mediaelement: "allowed", audiocontext: "allowed" },
    `${where}: getAutoplayPolicy reports allowed`
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Sval's default, Gecko's own. SitePermissions.setForPrincipal removes
      // a state equal to the default rather than storing it, and the
      // harness's default of "allowed" would make an ALLOW one.
      ["media.autoplay.default", Ci.nsIAutoplay.BLOCKED],
      // A blocked context's `blocked` event, which the probes wait on.
      ["media.autoplay.block-event.enabled", true],
      // The activation `activate` gives lasts through every probe, so the
      // gesture counts do not depend on the machine's speed.
      ["dom.user_activation.transient.timeout", 60000],
    ],
  });
  registerCleanupFunction(reset);
});

function reset() {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  Services.perms.removeAll();
}

/**
 * Each choice means one thing for a site and for sites with no choice of
 * their own, as Settings › Sites and the site menu set them: Always allow
 * plays everything, Web Audio included; Ask first and Always deny block
 * everything, muted media included, with a gesture or without. A site with
 * no choice gets the default's.
 */
add_task(
  async function each_choice_means_one_thing_for_a_site_and_the_default() {
    for (const fallback of ["allow", "ask", "block"]) {
      for (const choice of ["", "allow", "ask", "block"]) {
        reset();
        SvalSiteProtections.setMediaDefault(fallback);
        SvalSiteProtections.setMedia(SITE, choice);
        const gets = choice || fallback;
        Assert.equal(SvalSiteProtections.mediaFor(SITE), gets, "mediaFor");
        const where = `default ${fallback}, site ${choice || "unset"}`;
        await BrowserTestUtils.withNewTab(PAGE2, async browser => {
          if (gets === "allow") {
            assertPlays(await probeAll(browser, true), where);
            return;
          }
          assertBlocked(await probeAll(browser), `${where}, no press`);
          await activate(browser);
          assertBlocked(await probeAll(browser), `${where}, press`, {
            gesture: true,
          });
        });
      }
    }
    reset();
  }
);

add_task(async function allow_now_overrides_a_stored_deny() {
  reset();
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(ORIGIN);
  SvalSiteProtections.setMedia(SITE, "block");
  try {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      SitePermissions.setForPrincipal(
        principal,
        "autoplay-media",
        SitePermissions.ALLOW,
        SitePermissions.SCOPE_TEMPORARY,
        browser
      );
      await logPagePolicy(browser, "right after the tab grant");
      assertPlays(await probeAll(browser, true), "denied site allowed now");
    });
  } finally {
    reset();
  }
});

add_task(async function a_private_window_gates_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
      10_000,
      "a new tab's load"
    );
    assertBlocked(await probeAll(tab.linkedBrowser), "private window");
    await activate(tab.linkedBrowser);
    assertBlocked(
      await probeAll(tab.linkedBrowser),
      "private window after a gesture",
      { gesture: true }
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});

/**
 * The gate reads a tab's own grant, the one the media button writes for a
 * visit: the page plays in that tab, another tab of the site stays blocked,
 * and the tab is blocked again once the grant goes. When a visit ends is the
 * site controls' (`browser_sval_site_controls.js`).
 */
add_task(async function a_tab_grant_plays_in_that_tab_alone() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    const principal = browser.contentPrincipal;
    SitePermissions.setForPrincipal(
      principal,
      "autoplay-media",
      SitePermissions.ALLOW,
      SitePermissions.SCOPE_TEMPORARY,
      browser
    );
    await logPagePolicy(browser, "right after the tab grant");
    assertPlays(await probeAll(browser, true), "allowed now, same page");

    await BrowserTestUtils.withNewTab(PAGE2, async other => {
      assertBlocked(await probeAll(other), "allowed now, another tab");
    });

    SitePermissions.removeFromPrincipal(principal, "autoplay-media", browser);
    await within(
      BrowserTestUtils.reloadTab(gBrowser.getTabForBrowser(browser)),
      10_000,
      "the reload with the grant withdrawn"
    );
    assertBlocked(await probeAll(browser), "allow now withdrawn");
  });
});
