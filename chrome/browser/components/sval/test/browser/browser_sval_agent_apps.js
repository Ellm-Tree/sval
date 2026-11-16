/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * A page in an agent's tab opens another application only as the agent's
 * apps permission says (agent-control spec §5.2): the first launch of a
 * scheme from a site asks, a Blocked or Read only site opens nothing, and
 * Gecko's own dispatcher goes on as in any tab once Sval allows. Every way a
 * page launches reaches the dispatcher, so each is tried here: a link the
 * agent clicks, a link to a scheme Gecko does not expose, a frame, and a
 * `window.open`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const { nsContentDispatchChooser } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentDispatchChooser.sys.mjs"
);

const SCHEME = "bluext-test";
const EXTERNAL = `${SCHEME}:hello`;

/** The addresses Gecko's dispatcher launched, in order. */
const launched = [];

/** Resolvers waiting for the dispatcher's next address. */
const waiting = [];

/**
 * @returns {Promise<Promise>} The dispatcher's handling of the next address
 *   it is given, once it is given one.
 */
function nextHandling() {
  return new Promise(resolve => waiting.push(resolve));
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  // Mozilla's own dispatcher, Sval's patch in it, runs every address; only
  // the application's launch at its end is recorded in its place.
  const real = new nsContentDispatchChooser();
  const cid = MockRegistrar.register(
    "@mozilla.org/content-dispatch-chooser;1",
    {
      handleURI(handler, uri, principal, bc, external) {
        // XPConnect's methods are fixed own properties, which a Proxy may
        // not report as anything else, so the stand-in forwards by hand
        // what `handleURI` reads and writes.
        const standIn = { launchWithURI: u => launched.push(u.spec) };
        for (const name of [
          "type",
          "preferredAction",
          "preferredApplicationHandler",
          "alwaysAskBeforeHandling",
          "hasDefaultHandler",
          "defaultDescription",
        ]) {
          Object.defineProperty(standIn, name, {
            get: () => handler[name],
            set: value => {
              handler[name] = value;
            },
          });
        }
        const handling = real.handleURI(standIn, uri, principal, bc, external);
        waiting.shift()?.(handling);
        return handling;
      },
      QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]),
    }
  );
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
  // Gecko loads an external protocol only when some application handles it
  // (`ExternalProtocolHandlerExists`), so the test's scheme gets one, set to
  // open without Gecko's own dialog.
  const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(
    Ci.nsIHandlerService
  );
  const info = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
    .getService(Ci.nsIExternalProtocolService)
    .getProtocolHandlerInfo(SCHEME);
  const app = Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(
    Ci.nsIWebHandlerApp
  );
  app.name = "A test application";
  app.uriTemplate = "https://example.com/?url=%s";
  info.possibleApplicationHandlers.appendElement(app);
  info.preferredApplicationHandler = app;
  info.preferredAction = Ci.nsIHandlerInfo.useHelperApp;
  info.alwaysAskBeforeHandling = false;
  handlers.store(info);
  registerCleanupFunction(() => handlers.remove(info));
  await SpecialPowers.pushPrefEnv({
    set: [[`network.protocol-handler.external.${SCHEME}`, true]],
  });
});

/**
 * Gives the page a link to `EXTERNAL`, a button that points a frame at it,
 * and a button that opens it in a new window.
 *
 * @param {object} browser
 */
function addLaunchers(browser) {
  return SpecialPowers.spawn(browser, [EXTERNAL], external => {
    const doc = content.document;
    const holder = doc.createElement("div");
    holder.innerHTML =
      "<a id=app>Open the app</a><button id=frame>In a frame</button>" +
      "<button id=win>In a window</button><iframe id=ext></iframe>";
    doc.body.prepend(holder);
    doc.getElementById("app").href = external;
    doc.getElementById("frame").addEventListener("click", () => {
      doc.getElementById("ext").src = external;
    });
    doc.getElementById("win").addEventListener("click", () => {
      content.open(external);
    });
  });
}

/**
 * An agent's tab on `PAGE` with the launchers, and a ref finder for it.
 *
 * @param {object} [sites] Site levels for the agent.
 * @returns {Promise<object>}
 */
async function appsSetup(sites = { "example.com": "full" }) {
  const setup = await agentSetup({ sites });
  const { call, tabs, agent } = setup;
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await addLaunchers(browser);
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = name =>
    snapshot.match(new RegExp(`(?:link|button) "${name}" \\[(e\\d+)\\]`))[1];
  return { ...setup, tab, browser, ref };
}

/**
 * Clicks `name` as the agent, and waits for the dispatcher to be given the
 * address.
 *
 * @param {object} setup From `appsSetup`.
 * @param {Function} setup.call
 * @param {string} setup.tab
 * @param {string} name
 * @returns {Promise<Promise>} The dispatcher's handling of it.
 */
async function agentClicks({ call, tab }, name) {
  const handling = nextHandling();
  await call("click_element", { tab, ref: name });
  return within(handling, 10_000, "the dispatcher's address");
}

add_task(async function a_users_tab_opens_the_app_unasked() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the user's tab"
  );
  await addLaunchers(tab.linkedBrowser);
  launched.length = 0;
  const handling = nextHandling();
  await BrowserTestUtils.synthesizeMouseAtCenter("#app", {}, tab.linkedBrowser);
  await within(await handling, 10_000, "the dispatcher");
  Assert.deepEqual(launched, [EXTERNAL], "Firefox's own dispatcher opens it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_first_launch_of_a_scheme_asks() {
  const setup = await appsSetup();
  const { win, alerts, store, agent, ref } = setup;
  launched.length = 0;

  let handling = agentClicks(setup, ref("Open the app"));
  let doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "app");
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes("example.com"),
    "the alert names the site that asked"
  );
  Assert.deepEqual(
    [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
    [EXTERNAL],
    "and shows the address"
  );
  await choose(doc, "deny");
  await within(await handling, 10_000, "the denied launch");
  Assert.deepEqual(launched, [], "Deny opens nothing");

  handling = agentClicks(setup, ref("Open the app"));
  await choose(await alertIn(win), "allow");
  await within(await handling, 10_000, "the allowed launch");
  Assert.deepEqual(launched, [EXTERNAL], "Allow opens it");
  Assert.equal(store.policyOf(agent.agentId).apps["example.com"], undefined);

  handling = agentClicks(setup, ref("Open the app"));
  await choose(await alertIn(win), "allow_always");
  await within(await handling, 10_000, "the always allowed launch");
  Assert.deepEqual(store.policyOf(agent.agentId).apps["example.com"], {
    [SCHEME]: "allow",
  });

  const opened = alerts.opened;
  await within(
    await agentClicks(setup, ref("Open the app")),
    10_000,
    "the launch Always allow covers"
  );
  Assert.equal(alerts.opened, opened, "it no longer asks");
  Assert.deepEqual(launched, [EXTERNAL, EXTERNAL, EXTERNAL]);
});

add_task(async function always_deny_covers_the_scheme() {
  const setup = await appsSetup();
  const { win, alerts, store, agent, ref } = setup;
  launched.length = 0;
  const handling = agentClicks(setup, ref("Open the app"));
  await choose(await alertIn(win), "deny_always");
  await within(await handling, 10_000, "the denied launch");
  Assert.deepEqual(store.policyOf(agent.agentId).apps["example.com"], {
    [SCHEME]: "deny",
  });
  const opened = alerts.opened;
  await within(await agentClicks(setup, ref("Open the app")), 10_000, "again");
  Assert.equal(alerts.opened, opened, "it is not asked again");
  Assert.deepEqual(launched, [], "and opens nothing");

  await store.setApps(agent.agentId, "example.com", "deny");
  await store.setAppPermission(agent.agentId, "example.org", SCHEME, "allow");
  await within(await agentClicks(setup, ref("Open the app")), 10_000, "deny");
  Assert.equal(alerts.opened, opened, "a site-wide Deny asks nothing");
  Assert.deepEqual(launched, []);
});

add_task(async function a_read_only_site_opens_nothing() {
  const setup = await appsSetup({ "example.com": "read-only" });
  launched.length = 0;
  const handling = nextHandling();
  await SpecialPowers.spawn(setup.browser, [], () =>
    content.document.getElementById("app").click()
  );
  await within(await handling, 10_000, "the launch");
  Assert.equal(setup.alerts.opened, 0, "nothing is asked");
  Assert.deepEqual(launched, [], "and nothing opens");
});

/**
 * The site that asks is the frame's, and the tab's top-level page counts
 * too: either one Blocked or Read only opens nothing.
 */
add_task(async function a_frame_is_judged_by_its_site_and_its_top() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.block_external_protocol_in_iframes", false]],
  });
  const setup = await appsSetup({ "example.com": "full" });
  const { browser, win, alerts, store, agent } = setup;
  await SpecialPowers.spawn(browser, [ORG_PAGE], async page => {
    const frame = content.document.getElementById("ext");
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    frame.src = page;
    await loaded;
  });
  const frameBC = browser.browsingContext.children.find(
    bc => bc.currentURI?.host === "example.org"
  );
  const launchInFrame = async () => {
    const handling = nextHandling();
    // The page's own script navigates, so the load carries its principal.
    await SpecialPowers.spawn(frameBC, [EXTERNAL], external => {
      content.wrappedJSObject.eval(
        `location.href = ${JSON.stringify(external)}`
      );
    });
    return within(handling, 10_000, "the frame's launch");
  };
  launched.length = 0;

  const asked = launchInFrame();
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "app");
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes("example.org"),
    "the alert names the frame's site"
  );
  await choose(doc, "deny");
  await within(await asked, 10_000, "the denied launch");

  await store.setSiteLevel(agent.agentId, "example.org", "read-only");
  const opened = alerts.opened;
  await within(await launchInFrame(), 10_000, "a read only frame");
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  await store.setAppPermission(agent.agentId, "example.org", SCHEME, "allow");
  await store.setSiteLevel(agent.agentId, "example.com", "read-only");
  await within(await launchInFrame(), 10_000, "a read only top");
  Assert.equal(alerts.opened, opened, "neither asks");
  Assert.deepEqual(launched, [], "and neither opens anything");
});

add_task(async function a_frame_or_window_on_the_agents_click_asks() {
  const setup = await appsSetup();
  const { win, ref } = setup;
  launched.length = 0;
  for (const name of ["In a frame", "In a window"]) {
    const handling = agentClicks(setup, ref(name));
    const doc = await alertIn(win);
    await choose(doc, "deny");
    await within(await handling, 10_000, `${name}: the launch`);
  }
  Assert.deepEqual(launched, [], "neither opens an app");
});

add_task(async function a_scheme_gecko_does_not_expose_asks_too() {
  await SpecialPowers.pushPrefEnv({
    set: [[`network.protocol-handler.expose.${SCHEME}`, false]],
  });
  const setup = await appsSetup();
  launched.length = 0;
  const handling = agentClicks(setup, setup.ref("Open the app"));
  await choose(await alertIn(setup.win), "deny");
  await within(await handling, 10_000, "the link's launch");
  Assert.deepEqual(launched, [], "a link click asks like any launch");
});

add_task(async function one_apps_alert_at_a_time_per_tab() {
  const setup = await appsSetup();
  const { win, alerts, browser } = setup;
  launched.length = 0;
  const first = nextHandling();
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("app").click()
  );
  const doc = await alertIn(win);
  const second = nextHandling();
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("app").click()
  );
  await within(await second, 10_000, "the second launch");
  Assert.equal(alerts.opened, 1, "the second launch is not asked about");
  await choose(doc, "allow");
  await within(await first, 10_000, "the first launch");
  Assert.deepEqual(launched, [EXTERNAL], "only the asked one opens");
});

add_task(async function a_tab_the_user_took_opens_as_the_users() {
  const setup = await appsSetup();
  const { win, alerts, browser } = setup;
  await takeControlOf(win, browser);
  launched.length = 0;
  const handling = nextHandling();
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("app").click()
  );
  await within(await handling, 10_000, "the launch");
  Assert.equal(alerts.opened, 0, "Sval asks nothing");
  Assert.deepEqual(launched, [EXTERNAL], "Firefox's dispatcher opens it");
});

add_task(async function a_tool_never_opens_an_app() {
  const { call } = await agentSetup({ sites: { "example.com": "full" } });
  await Assert.rejects(
    call("open_tab", { url: EXTERNAL }),
    e => e.code === "unsupported_url"
  );
});
