/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * JavaScript per site (`SvalJavascript`) and the header's button for it, on
 * real pages.
 */

ChromeUtils.defineESModuleGetters(this, {
  SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
  JAVASCRIPT_BUTTON_ID: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
  SITE_BRANCH: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
});

const JS_PATH = "/browser/browser/components/sval/test/browser/";
const JS_PAGE = `https://example.com${JS_PATH}sval_javascript_page.html`;
const JS_SUBDOMAIN_PAGE = `https://www.example.com${JS_PATH}sval_javascript_page.html`;
const JS_OTHER_PAGE = `https://example.org${JS_PATH}sval_javascript_page.html`;
const JS_FRAMED_PAGE = `https://example.com${JS_PATH}sval_javascript_frame.html`;
const JS_HOST_PAGE = `https://test1.example.com${JS_PATH}sval_javascript_page.html`;
const JS_SIBLING_PAGE = `https://test2.example.com${JS_PATH}sval_javascript_page.html`;

function clearRules() {
  clearPrefBranches(SITE_BRANCH);
}

registerCleanupFunction(clearRules);

/**
 * @param {Element} browser
 * @returns {Promise<{ran: boolean, fallback: boolean}>} Whether the page's
 *   script ran, and whether its `<noscript>` was parsed as markup.
 */
function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    ran: content.document.body.dataset.ran === "yes",
    fallback: !!content.document.getElementById("fallback"),
  }));
}

/**
 * What a screen reader hears of `node`: its description, and whether it is
 * pressed or unavailable.
 *
 * @param {Element} node
 * @returns {Promise<{description: string, pressed: boolean, unavailable: boolean}>}
 */
async function heard(node) {
  const acc = await accessibleOf(node);
  const state = {};
  acc.getState(state, {});
  const { STATE_PRESSED, STATE_UNAVAILABLE } = Ci.nsIAccessibleStates;
  return {
    description: acc.description,
    pressed: !!(state.value & STATE_PRESSED),
    unavailable: !!(state.value & STATE_UNAVAILABLE),
  };
}

async function withPage(url, task) {
  await BrowserTestUtils.withNewTab(url, task);
}

add_task(async function a_blocked_site_runs_no_script_and_shows_its_fallback() {
  await withPage(JS_PAGE, async browser => {
    Assert.deepEqual(
      await pageState(browser),
      { ran: true, fallback: false },
      "with no rule the site follows the default"
    );
  });

  SvalJavascript.setEnabled("example.com", false);
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [["example.com", "block"]],
    "turning it off stores a block rule"
  );

  await withPage(JS_PAGE, async browser => {
    Assert.deepEqual(
      await pageState(browser),
      { ran: false, fallback: true },
      "the blocked site runs no script and parses <noscript>"
    );
  });
  await withPage(JS_SUBDOMAIN_PAGE, async browser => {
    Assert.equal(
      (await pageState(browser)).ran,
      false,
      "a host under the site is blocked with it"
    );
  });
  await withPage(JS_OTHER_PAGE, async browser => {
    Assert.equal(
      (await pageState(browser)).ran,
      true,
      "another site keeps the default"
    );
  });

  SvalJavascript.setEnabled("example.com", true);
  Assert.equal(
    SvalJavascript.rules().size,
    0,
    "a choice that matches the default takes the rule away"
  );
  await withPage(JS_PAGE, async browser => {
    Assert.equal((await pageState(browser)).ran, true, "script is back");
  });
});

add_task(async function with_the_default_off_an_allowed_site_runs_script() {
  await SpecialPowers.pushPrefEnv({ set: [["javascript.enabled", false]] });
  SvalJavascript.setEnabled("example.com", true);
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [["example.com", "allow"]],
    "turning it on against an off default stores an allow rule"
  );

  await withPage(JS_PAGE, async browser => {
    Assert.equal((await pageState(browser)).ran, true, "the allowed site runs");
  });
  await withPage(JS_OTHER_PAGE, async browser => {
    Assert.deepEqual(
      await pageState(browser),
      { ran: false, fallback: true },
      "a site without a rule follows the off default"
    );
  });

  SvalJavascript.removeRule("example.com");
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_hosts_allow_beats_its_sites_block() {
  SvalJavascript.setEnabled("example.com", false);
  SvalJavascript.setEnabled("test1.example.com", true);
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [
      ["example.com", "block"],
      ["test1.example.com", "allow"],
    ],
    "the host's allow is stored, since it differs from its site's block"
  );
  await withPage(JS_HOST_PAGE, async browser => {
    Assert.equal((await pageState(browser)).ran, true, "the host runs script");
  });
  await withPage(JS_SIBLING_PAGE, async browser => {
    Assert.equal(
      (await pageState(browser)).ran,
      false,
      "its sibling keeps the site's block"
    );
  });
  await withPage(JS_PAGE, async browser => {
    Assert.equal((await pageState(browser)).ran, false, "so does the site");
  });
  clearRules();
});

add_task(
  async function with_the_default_off_a_hosts_block_beats_its_sites_allow() {
    await SpecialPowers.pushPrefEnv({ set: [["javascript.enabled", false]] });
    SvalJavascript.setEnabled("example.com", true);
    SvalJavascript.setEnabled("test1.example.com", false);
    await withPage(JS_HOST_PAGE, async browser => {
      Assert.equal(
        (await pageState(browser)).ran,
        false,
        "the host is blocked"
      );
    });
    await withPage(JS_SIBLING_PAGE, async browser => {
      Assert.equal(
        (await pageState(browser)).ran,
        true,
        "its sibling keeps the site's allow"
      );
    });
    clearRules();
    await SpecialPowers.popPrefEnv();
  }
);

add_task(async function a_frame_follows_its_own_sites_rule() {
  SvalJavascript.setEnabled("example.org", false);
  await withPage(JS_FRAMED_PAGE, async browser => {
    Assert.equal(
      (await pageState(browser)).ran,
      true,
      "the page's own site runs"
    );
    const frame = browser.browsingContext.children[0];
    Assert.deepEqual(
      await pageState(frame),
      { ran: false, fallback: true },
      "the blocked site's frame does not"
    );
  });
  SvalJavascript.removeRule("example.org");
});

add_task(async function the_button_turns_the_site_off_and_reloads() {
  await withPage(JS_PAGE, async browser => {
    const button = document.getElementById(JAVASCRIPT_BUTTON_ID);
    Assert.equal(button.getAttribute("sval-js"), "on", "the button reads on");
    Assert.ok(!button.hasAttribute("sval-js-rule"), "with no rule of its own");
    Assert.ok(!button.disabled, "a web page can be switched");
    let said = await heard(button);
    Assert.ok(said.pressed, "a screen reader hears it on");
    const ruleless = said.description;
    Assert.ok(ruleless, "with a description");

    let loaded = BrowserTestUtils.browserLoaded(browser, false, JS_PAGE);
    button.click();
    await within(loaded, 10_000, "the reload with script off");
    Assert.equal(button.getAttribute("sval-js"), "off", "the button reads off");
    Assert.ok(button.hasAttribute("sval-js-rule"), "and marks the exception");
    await TestUtils.waitForCondition(async () => {
      said = await heard(button);
      return (
        !said.pressed &&
        button.hasAttribute("sval-js-rule") &&
        said.description != ruleless
      );
    }, "a screen reader hears it off, by the site's rule");
    Assert.deepEqual(
      await pageState(browser),
      { ran: false, fallback: true },
      "the reloaded page ran no script"
    );

    loaded = BrowserTestUtils.browserLoaded(browser, false, JS_PAGE);
    button.click();
    await within(loaded, 10_000, "the reload with script on");
    Assert.equal(button.getAttribute("sval-js"), "on", "on again");
    Assert.ok(!button.hasAttribute("sval-js-rule"), "with the rule gone");
    Assert.equal((await pageState(browser)).ran, true, "and the page ran");
  });
});

add_task(async function going_back_loads_the_page_under_the_new_rule() {
  await withPage(JS_PAGE, async browser => {
    Assert.equal((await pageState(browser)).ran, true, "the page ran");
    BrowserTestUtils.startLoadingURIString(browser, JS_OTHER_PAGE);
    await within(
      BrowserTestUtils.browserLoaded(browser, false, JS_OTHER_PAGE),
      10_000,
      "the load of another site"
    );

    SvalJavascript.setEnabled("example.com", false);
    // A load from the browser's own UI marks the page it leaves as one the
    // back button stops at (nsDocShell::LoadURI), and goBack() does nothing
    // while no page behind has the mark. The mark comes from the left page's
    // process, so when the next site loads in another process it can arrive
    // after the switch, where it marks nothing. The test takes the mark away,
    // so it always runs that case, and goes back without asking for one.
    const history = browser.browsingContext.sessionHistory;
    history.getEntryAtIndex(history.index - 1).hasUserInteraction = false;
    const shown = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
    browser.goBack(false);
    await within(shown, 10_000, "the page shown by going back");
    Assert.equal(
      (await pageState(browser)).ran,
      false,
      "the cached page was dropped, so going back loaded it without script"
    );
  });
  SvalJavascript.removeRule("example.com");
});

add_task(async function the_button_is_disabled_off_the_web() {
  await withPage("about:license", async () => {
    const button = document.getElementById(JAVASCRIPT_BUTTON_ID);
    Assert.ok(button.disabled, "a page no rule covers cannot be switched");
    Assert.ok(!button.hasAttribute("sval-js"), "and shows no state");
  });
});

add_task(function a_synced_value_that_is_not_a_rule_is_none() {
  clearRules();
  // As settings sync applies other devices' values.
  Services.prefs.setStringPref(SITE_BRANCH + "c.com", "allow");
  Services.prefs.setStringPref(SITE_BRANCH + "b.com", "maybe");
  Services.prefs.setBoolPref(SITE_BRANCH + "d.com", true);
  Services.prefs.setStringPref(SITE_BRANCH + "a.com", "block");
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [
      ["a.com", "block"],
      ["c.com", "allow"],
    ],
    "an entry that is not a rule is dropped"
  );
  clearRules();
});

const JS_SANDBOX_PAGE = `https://example.com${JS_PATH}sval_javascript_sandbox.html`;

/**
 * @param {BrowsingContext} frame
 * @returns {Promise<boolean>} Whether the frame's script set its title.
 */
function frameRan(frame) {
  return SpecialPowers.spawn(frame, [], () => content.document.title === "ran");
}

add_task(async function opaque_frames_follow_the_page_that_made_them() {
  await withPage(JS_SANDBOX_PAGE, async browser => {
    for (const frame of browser.browsingContext.children) {
      await TestUtils.waitForCondition(
        () => frameRan(frame),
        "with no rule a sandboxed or data: frame runs its script"
      );
    }
  });

  SvalJavascript.setEnabled("example.com", false);
  await withPage(JS_SANDBOX_PAGE, async browser => {
    for (const frame of browser.browsingContext.children) {
      Assert.ok(
        !(await frameRan(frame)),
        "on a blocked site its opaque frames are blocked too"
      );
    }
  });
  SvalJavascript.removeRule("example.com");
});

add_task(async function a_rule_covers_its_site_on_any_port() {
  SvalJavascript.setEnabled("mochi.test", false);
  await withPage(
    `http://mochi.test:8888${JS_PATH}sval_javascript_page.html`,
    async browser => {
      Assert.equal(
        (await pageState(browser)).ran,
        false,
        "a page on a non-default port is blocked with its site"
      );
    }
  );
  SvalJavascript.removeRule("mochi.test");
});

add_task(async function a_private_window_cannot_change_a_rule() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, JS_PAGE);
  await within(
    BrowserTestUtils.browserLoaded(
      win.gBrowser.selectedBrowser,
      false,
      JS_PAGE
    ),
    10_000,
    "the private window's load"
  );
  const button = win.document.getElementById(JAVASCRIPT_BUTTON_ID);
  Assert.equal(button.getAttribute("sval-js"), "on", "it shows the state");
  const said = await heard(button);
  Assert.ok(said.unavailable, "but cannot change it");
  Assert.ok(
    !button.disabled,
    "and keeps its stop in the toolbar's keyboard navigation"
  );
  Assert.equal(
    button.getAttribute("aria-disabled"),
    "true",
    "in a private window"
  );
  Assert.ok(said.description, "so the reason is heard");
  button.doCommand();
  Assert.equal(
    SvalJavascript.rules().size,
    0,
    "so a private visit leaves no rule to save or sync"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});

add_task(function a_public_suffix_rule_covers_that_host_alone() {
  const policy = SvalJavascript._policy;
  const uri = spec => Services.io.newURI(spec);
  SvalJavascript.setEnabled("github.io", false);
  Assert.ok(
    policy.blocklist.contains(uri("https://github.io/")),
    "the suffix itself is blocked"
  );
  Assert.ok(
    !policy.superBlocklist.containsSuperDomain(uri("https://x.github.io/")),
    "and no site under it"
  );
  SvalJavascript.removeRule("github.io");
  Assert.ok(!policy.blocklist.contains(uri("https://github.io/")), "removed");
});

add_task(function an_ipv6_rule_reaches_the_policy() {
  const policy = SvalJavascript._policy;
  SvalJavascript.setEnabled("::1", false);
  Assert.ok(
    policy.superBlocklist.containsSuperDomain(
      Services.io.newURI("https://[::1]/")
    ),
    "the literal is entered with its brackets"
  );
  SvalJavascript.removeRule("::1");
});

add_task(async function a_blocked_sites_service_worker_does_not_run() {
  const register = `https://example.com${JS_PATH}sval_javascript_sw.html`;
  const scoped = `https://example.com${JS_PATH}sval_javascript_sw_scope/page.html`;
  const title = browser =>
    SpecialPowers.spawn(browser, [], () => content.document.title);
  // Cleared however the task ends, so no later file inherits the block or
  // the registration. The registration goes through the service worker
  // manager, which needs no page of the site.
  registerCleanupFunction(async () => {
    SvalJavascript.removeRule("example.com");
    const { ServiceWorkerCleanUp } = ChromeUtils.importESModule(
      "resource://gre/modules/ServiceWorkerCleanUp.sys.mjs"
    );
    await within(
      ServiceWorkerCleanUp.removeFromHost("example.com"),
      10_000,
      "the site's service worker going"
    );
  });

  await withPage(register, async browser => {
    await TestUtils.waitForCondition(
      async () => (await title(browser)) !== "sval javascript sw",
      "the site's service worker settles"
    );
    Assert.equal(await title(browser), "registered", "it is active");
  });
  await withPage(scoped, async browser => {
    Assert.equal(await title(browser), "from sw", "it answers in its scope");
  });

  SvalJavascript.setEnabled("example.com", false);
  await withPage(scoped, async browser => {
    Assert.notEqual(
      await title(browser),
      "from sw",
      "with the site's script off, the network answers instead"
    );
  });

  // A registration or update of a worker whose site's script is off fails
  // at once. Its script comparison reads the cache through a sandbox the
  // policy blocks, so one left waiting would hold every later job for its
  // scope, the cleanup's unregister among them.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.serviceWorkers.testing.enabled", true]],
  });
  const manager = Cc["@mozilla.org/serviceworkers/manager;1"].getService(
    Ci.nsIServiceWorkerManager
  );
  await Assert.rejects(
    within(
      manager.registerForTest(
        Services.scriptSecurityManager.createContentPrincipalFromOrigin(
          "https://example.com"
        ),
        `https://example.com${JS_PATH}sval_javascript_sw_other_scope/`,
        `https://example.com${JS_PATH}sval_javascript_sw.js`
      ),
      10_000,
      "a registration on the blocked site settling"
    ),
    e => e.name === "InvalidStateError",
    "a blocked site registers no worker"
  );
});

add_task(async function a_running_worker_stops_once_its_site_is_turned_off() {
  // The block the task above leaves stands until the file's cleanup.
  SvalJavascript.removeRule("example.com");
  const register = `https://example.com${JS_PATH}sval_javascript_sw.html`;
  const scoped = `https://example.com${JS_PATH}sval_javascript_sw_scope/page.html`;
  const title = browser =>
    SpecialPowers.spawn(browser, [], () => content.document.title);
  registerCleanupFunction(async () => {
    SvalJavascript.removeRule("example.com");
    const { ServiceWorkerCleanUp } = ChromeUtils.importESModule(
      "resource://gre/modules/ServiceWorkerCleanUp.sys.mjs"
    );
    await within(
      ServiceWorkerCleanUp.removeFromHost("example.com"),
      10_000,
      "the site's service worker going"
    );
  });
  await withPage(register, async browser => {
    await TestUtils.waitForCondition(
      async () => (await title(browser)) === "registered",
      "the site's service worker is active"
    );
  });
  // The worker that answered stays running until its idle timeout, past the
  // end of the task.
  await withPage(scoped, async browser => {
    Assert.equal(await title(browser), "from sw", "its worker answers");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    document.getElementById(JAVASCRIPT_BUTTON_ID).click();
    await within(loaded, 10_000, "the reload with script off");
    Assert.notEqual(await title(browser), "from sw", "the network answers");
  });

  // Every way a worker stops (its idle timeout, an unregister, an event the
  // policy refuses) goes through the same termination as this.
  const manager = Cc["@mozilla.org/serviceworkers/manager;1"].getService(
    Ci.nsIServiceWorkerManager
  );
  const registration = manager.getRegistrationByPrincipal(
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      "https://example.com"
    ),
    `https://example.com${JS_PATH}sval_javascript_sw_scope/`
  );
  await within(
    registration.activeWorker.terminateWorker(),
    10_000,
    "the blocked site's running worker stopping"
  );
});
