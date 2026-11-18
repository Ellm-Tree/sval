/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * Take control hands an agent's workspace to the user (agent-control spec
 * §6, decision 0107): it needs the button, pauses the agent on
 * every tab and wins over a tool already running there. Its tabs, their
 * downloads, their loads and what they open are the user's until they give
 * it back, and a write or load the agent set off before the take is still the
 * agent's, held or cancelled.
 *
 * The user's input here is synthesized in the parent, at the page's place in
 * the window and to whatever has focus there, which is the path a person's
 * mouse and keyboard take. `BrowserTestUtils.synthesizeMouse` would dispatch
 * inside the page instead, beneath the overlay, as the agent's input is.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Take control needs a press of the button: a click on the button, or Enter
 * or Space on the focused button. A click elsewhere on the overlay, or a key
 * on the overlay itself, does nothing.
 */
add_task(async function take_control_needs_the_button() {
  const { win, browser } = await layerSetup();
  const id = browser.browsingContext.browserId;
  const { overlay, card, bar } = partsOf(browser);
  const take = card.querySelector(".sval-agent-take");
  const give = bar.querySelector(".sval-agent-give");

  EventUtils.synthesizeMouse(
    overlay,
    5,
    overlay.getBoundingClientRect().height - 5,
    {},
    win
  );
  EventUtils.synthesizeMouse(card, 5, 5, {}, win);
  card.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  EventUtils.synthesizeKey(" ", {}, win);
  Assert.ok(
    !isUserInControl(id),
    "a click or a key beside the button does not"
  );

  take.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  Assert.ok(isUserInControl(id), "Enter on the button takes control");
  Assert.ok(overlay.hidden, "the overlay goes");
  Assert.ok(!bar.hidden, "and the bar comes");
  Assert.ok(
    give.textContent.includes(AGENT_LABEL),
    "the bar's button names the agent it gives back to"
  );
  Assert.equal(win.document.activeElement, browser, "the page has focus");

  give.focus();
  EventUtils.synthesizeKey(" ", {}, win);
  Assert.ok(!isUserInControl(id), "Space on the bar's button gives it back");
  Assert.ok(
    !overlay.hidden && !card.hidden && bar.hidden,
    "the overlay is back"
  );
  Assert.equal(win.document.activeElement, card, "the keyboard is on it");

  take.focus();
  EventUtils.synthesizeKey(" ", {}, win);
  Assert.ok(isUserInControl(id), "Space on the button takes control");
  give.click();
  Assert.ok(!isUserInControl(id));
  await EventUtils.synthesizeMouseAtCenter(take, {}, win);
  Assert.ok(isUserInControl(id), "a click on the button takes control");
});

/**
 * Once the user has control the page is theirs to use, and giving it back
 * puts the overlay up again.
 */
add_task(async function the_user_uses_the_page_they_took() {
  const { win, browser } = await layerSetup();
  await takeControlOf(win, browser);
  await inputReaches(win, browser, "once the user has control");
  await giveBackFrom(win, browser);
  await inputBlocked(win, browser, "once it is given back");
});

/**
 * Every tool in a workspace the user has taken fails with `user_in_control`,
 * on every tab of it, and `list_tabs` still lists them. Giving it back makes
 * every tab the agent's again.
 */
add_task(async function every_tool_in_a_taken_workspace_fails() {
  const { call, tab, tabs, agent, win, browser } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  await showTab(win, win.gBrowser.getTabForBrowser(browser));
  await takeControlOf(win, browser);

  const calls = [
    ["navigate_tab", { tab, to: PAGE }],
    ["get_snapshot", { tab }],
    ["get_screenshot", { tab }],
    ["get_page_source", { tab }],
    ["get_page_text", { tab }],
    ["click_element", { tab, ref: "e1" }],
    ["type_text", { tab, ref: "e1", text: "x" }],
    ["fill_form", { tab, fields: [{ ref: "e1", text: "x" }] }],
    ["select_option", { tab, ref: "e1", values: ["a"] }],
    ["press_keys", { tab, keys: ["a"] }],
    ["scroll_page", { tab, direction: "down" }],
    ["wait_for_text", { tab, text: "x", timeout_ms: 10 }],
    ["answer_dialog", { tab, accept: true }],
    ["upload_file", { tab, ref: "e1", paths: ["/nowhere"] }],
    ["close_tab", { tab }],
    ["get_snapshot", { tab: other }],
    ["open_tab", { url: PAGE2 }],
  ];
  for (const [name, args] of calls) {
    await Assert.rejects(
      call(name, args),
      e =>
        e.code === "user_in_control" && e.message === USER_IN_CONTROL_MESSAGE,
      `${name} fails with user_in_control`
    );
  }
  Assert.ok(
    (await tabs.listTabsFor(agent)).some(t => t.tab === tab),
    "list_tabs still lists the tab"
  );
  Assert.equal(
    (await pageState(browser)).value,
    "",
    "the page was not typed in"
  );

  await giveBackFrom(win, browser);
  Assert.ok(
    (await call("get_snapshot", { tab })).snapshot,
    "given back, the tab is the agent's again"
  );
  Assert.ok(
    (await call("get_snapshot", { tab: other })).snapshot,
    "and so is its other tab"
  );
});

/**
 * Taking control wins over a tool already running on the tab: a form being
 * filled stops at the field it is on, and the fields after it are never
 * typed into.
 */
add_task(async function take_control_stops_a_form_between_fields() {
  const { call, reply, tab, win, browser } = await layerSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const second = content.document.createElement("input");
    second.id = "second";
    second.setAttribute("aria-label", "Second");
    content.document.body.append(second);
  });
  const first = await refFor(call, tab, /textbox "Field" \[(e\d+)\]/);
  const second = await refFor(call, tab, /textbox "Second" \[(e\d+)\]/);
  // The user presses Take control as the first field is done.
  const page = pageActor(browser);
  const type = page.type;
  page.type = async function (...args) {
    const answer = await type.apply(this, args);
    partsOf(browser).card.querySelector(".sval-agent-take").click();
    return answer;
  };
  const result = await reply("fill_form", {
    tab,
    fields: [
      { ref: first, text: "one" },
      { ref: second, text: "two" },
    ],
  });
  Assert.equal(result.error, "user_in_control", "the form stops");
  Assert.equal(result.filled, 1, "after the field it was on");
  Assert.ok(isUserInControl(browser.browsingContext.browserId));
  Assert.deepEqual(
    await SpecialPowers.spawn(browser, [], () => [
      content.document.getElementById("field").value,
      content.document.getElementById("second").value,
    ]),
    ["one", ""],
    "the field after it was never typed into"
  );
  Assert.ok(win.gBrowser, "the agent's window is still there");
});

/**
 * Taking control while a navigation waits on the user's answer about a new
 * site keeps the tab where it is, whatever the answer.
 */
add_task(async function take_control_while_a_load_waits_keeps_the_tab() {
  const { call, tab, win, browser } = await layerSetup();
  const pending = call("navigate_tab", { tab, to: ORG_PAGE });
  pending.catch(() => {});
  const doc = await alertIn(win);
  partsOf(browser).card.querySelector(".sval-agent-take").click();
  Assert.ok(isUserInControl(browser.browsingContext.browserId));
  await choose(doc, "allow");
  await Assert.rejects(
    pending,
    e => e.code === "user_in_control",
    "the navigation answers user_in_control"
  );
  await settle(browser);
  Assert.equal(browser.currentURI.spec, INPUT, "and the tab did not move");
});

add_task(async function take_control_ends_a_wait_for_text() {
  const { call, tab, browser } = await layerSetup();
  const started = Date.now();
  const pending = call("wait_for_text", {
    tab,
    text: "Never on this page",
    timeout_ms: 30_000,
  });
  pending.catch(() => {});
  await settle(browser);
  partsOf(browser).card.querySelector(".sval-agent-take").click();
  await Assert.rejects(
    pending,
    e => e.code === "user_in_control",
    "the wait answers user_in_control"
  );
  Assert.less(Date.now() - started, 30_000, "without waiting out its time");
});

const DOWNLOAD = ROOT + "sval_agent_download.sjs";

/**
 * Waits for `browser` to show `url`, loaded as the user loads a page.
 *
 * @param {object} browser
 * @param {string} url
 */
async function userLoads(browser, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await within(loaded, 10_000, "the tab's load");
}

/**
 * While the user has control, the tab is theirs to every check the gate
 * makes: a page it loads is not judged by the agent's site policy, a page
 * dialog is not answered for them, a file picker opens, and a tab it opens
 * is not routed into the background. Given back, every rule holds again.
 */
add_task(async function a_taken_tab_is_the_users() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let pickers = 0;
  MockFilePicker.showCallback = () => {
    pickers++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(() => MockFilePicker.cleanup());

  const { win, browser, gate, agent } = await layerSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  Assert.equal(
    gate.agentOf(browser)?.agentId,
    agent.agentId,
    "the agent's tab is watched"
  );
  await takeControlOf(win, browser);
  Assert.equal(gate.agentOf(browser), null, "taken, it is not the agent's");

  // A site the agent may not open.
  await userLoads(browser, ORG_PAGE);
  Assert.equal(browser.currentURI.spec, ORG_PAGE, "the user's load goes on");

  // A file picker.
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.type = "file";
    input.id = "pick";
    content.document.body.prepend(input);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
  await TestUtils.waitForCondition(() => pickers, "the file picker opens");

  // A page dialog stays up for the user.
  const { PromptTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PromptTestUtils.sys.mjs"
  );
  const { createAgentDialogs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentPageDialogs.sys.mjs"
  );
  const dialogs = createAgentDialogs({ gate });
  atTaskEnd(() => dialogs.close());
  const shown = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "alert",
  });
  await SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => content.alert("mine"), 0);
  });
  const dialog = await within(shown, 10_000, "the page's alert");
  // A handler answers a dialog inside the notification `shown` waited on,
  // through its buttons, which mark it inactive as they are pressed.
  Assert.notStrictEqual(
    dialog.args.promptActive,
    false,
    "nothing answered the alert"
  );
  Assert.equal(
    win.gBrowser.getTabDialogBox(browser).getContentDialogManager().dialogs
      .length,
    1,
    "the page's alert stays up for the user"
  );
  await within(
    PromptTestUtils.handlePrompt(dialog),
    10_000,
    "the page's alert closing once handled"
  );

  // Given back, the agent's rules hold again.
  await userLoads(browser, PAGE);
  await giveBackFrom(win, browser);
  Assert.equal(
    gate.agentOf(browser)?.agentId,
    agent.agentId,
    "given back, it is the agent's"
  );
  const stops = [];
  const listener = {
    onStateChange(b, webProgress, request, flags, status) {
      if (
        b === browser &&
        webProgress.isTopLevel &&
        flags & Ci.nsIWebProgressListener.STATE_STOP &&
        flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
      ) {
        stops.push(status);
      }
    },
  };
  win.gBrowser.addTabsProgressListener(listener);
  atTaskEnd(() => win.gBrowser.removeTabsProgressListener(listener));
  // The page goes to the blocked site itself: the window's own navigation of
  // an agent's tab is refused before it starts.
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    content.location.href = url;
  });
  await TestUtils.waitForCondition(
    () => stops.some(status => status !== 0),
    "the blocked site is refused again"
  );
  await TestUtils.waitForCondition(() => {
    const windowGlobal = browser.browsingContext.currentWindowGlobal;
    return (
      !!windowGlobal?.failedChannel &&
      !!windowGlobal.documentURI?.spec.startsWith("about:agentblocked?")
    );
  }, "the tab shows about:agentblocked in the blocked page's place");
  // An error page's document stays "interactive", so the page is waited on
  // for the text its script writes.
  await within(
    SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          content.document.documentURI.startsWith("about:agentblocked?") &&
          !!content.document
            .getElementById("sval-agent-blocked-reason")
            ?.textContent.includes("example.org"),
        "about:agentblocked's text"
      )
    ),
    10_000,
    "about:agentblocked's text"
  );
  const before = pickers;
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.type = "file";
    input.id = "pick";
    content.document.body.prepend(input);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
  await settle(browser);
  Assert.equal(pickers, before, "and no file picker opens");
});

/**
 * A download from a taken tab is the user's: it is neither held for the
 * agent's download permission nor listed for the agent.
 */
add_task(async function a_download_from_a_taken_tab_is_the_users() {
  const dir = await makeTempDir("sval-agent-take");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
      ["browser.download.always_ask_before_handling_new_types", false],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    await IOUtils.remove(dir, { recursive: true });
    await SpecialPowers.popPrefEnv();
  });
  const { win, browser, call, alerts } = await layerSetup();
  await takeControlOf(win, browser);
  await SpecialPowers.spawn(browser, [`${DOWNLOAD}?name=mine.txt`], url => {
    content.location.href = url;
  });
  await TestUtils.waitForCondition(
    async () => (await list.getAll()).some(d => d.succeeded),
    "the user's download finishes"
  );
  Assert.equal(alerts.opened, 0, "nobody was asked");
  Assert.deepEqual(
    (await call("list_downloads", {})).downloads,
    [],
    "the agent does not see it"
  );
});

/**
 * Taking control changes who owns input from then on, and nothing the
 * agent's input already set off: a write the agent's click sends a moment
 * after the user takes the tab is still held for the user to answer.
 */
add_task(async function a_write_the_agents_click_set_off_is_still_held() {
  const { call, tab, browser, win } = await layerSetup({
    sites: { "example.com": "ask-before-writes" },
  });
  await SpecialPowers.spawn(browser, [], () => {
    const buy = content.document.createElement("button");
    buy.textContent = "Buy";
    buy.setAttribute(
      "onclick",
      "setTimeout(() => fetch('https://example.com/sval-buy', {method: 'POST', body: 'x'}), 200)"
    );
    content.document.body.prepend(buy);
  });
  const ref = await refFor(call, tab, /button "Buy" \[(e\d+)\]/);
  const posts = requestsTo("/sval-buy");
  // The user takes control the moment the agent's click is done.
  const page = pageActor(browser);
  const click = page.click;
  page.click = async function (...args) {
    const answer = await click.apply(this, args);
    pressTakeControl(browser);
    return answer;
  };
  const pending = call("click_element", { tab, ref });
  const doc = await alertIn(win);
  Assert.equal(posts.started, 1, "the write was sent");
  Assert.deepEqual(posts.stopped, [], "and is held");
  await choose(doc, "deny");
  await Assert.rejects(
    pending,
    e => e.code === "user_in_control" && e.details.writes === "denied",
    "the click answers user_in_control, and the alert decided its write"
  );
  await TestUtils.waitForCondition(() => posts.stopped.length, "it ends");
  Assert.notEqual(posts.stopped[0], 0, "cancelled");
});

/**
 * A write alert already up when the user takes the tab still decides the
 * writes it holds. The agent's click then answers as every tool in a taken
 * tab does, and says nothing of the page the user is on (decision 0107).
 */
add_task(async function a_write_alert_up_at_the_take_still_decides() {
  const { call, tab, browser, win } = await layerSetup({
    sites: { "example.com": "ask-before-writes" },
  });
  await call("navigate_tab", { tab, to: PAGE });
  const posts = requestsTo("/sval-fetch");
  const ref = await refFor(call, tab, /button "Send by fetch" \[(e\d+)\]/);
  const pending = call("click_element", { tab, ref });
  pending.catch(() => {});
  const doc = await alertIn(win);
  pressTakeControl(browser);
  Assert.deepEqual(posts.stopped, [], "the write is still held");
  await choose(doc, "deny");
  let failure;
  await Assert.rejects(
    pending,
    e => (failure = e).code === "user_in_control",
    "the click answers user_in_control"
  );
  Assert.equal(failure.details.writes, "denied", "the alert decided it");
  Assert.ok(
    !("url" in failure.details) && !("title" in failure.details),
    "nothing names the page the user is on"
  );
  await TestUtils.waitForCondition(() => posts.stopped.length, "it ends");
  Assert.notEqual(posts.stopped[0], 0, "cancelled");
});

/**
 * A load the agent started that is held for its site alert when the user
 * takes the tab is stopped, whatever the alert is then answered: an agent's
 * load never skips its alert because the user took the tab.
 */
add_task(async function an_agents_held_load_does_not_go_on_as_the_users() {
  const { call, tab, browser, win } = await layerSetup();
  // example.com is allowed, and redirects to example.org, which is not.
  const pending = call("navigate_tab", {
    tab,
    to: `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(ORG_PAGE)}`,
  });
  pending.catch(() => {});
  const doc = await alertIn(win);
  pressTakeControl(browser);
  await Assert.rejects(
    pending,
    e => e.code === "user_in_control",
    "the navigation answers user_in_control"
  );
  await noLoadStarts(browser, () => choose(doc, "allow"), "Allow");
  Assert.equal(browser.currentURI.spec, INPUT, "the tab did not move");
});

/**
 * A load the page started that is held for its site alert when the user
 * takes the tab goes on as the user's, unasked.
 */
add_task(async function a_pages_held_load_goes_on_as_the_users() {
  const { browser, win } = await layerSetup();
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    content.location.href = url;
  });
  const doc = await alertIn(win);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, ORG_PAGE);
  pressTakeControl(browser);
  await within(loaded, 10_000, "the tab's load");
  Assert.equal(browser.currentURI.spec, ORG_PAGE, "the page's load went on");
  await choose(doc, "deny");
});

/**
 * A load the agent's click set off, held for its site's alert when the user
 * takes the tab, is the agent's and is cancelled.
 */
add_task(async function a_load_the_agents_click_set_off_is_cancelled() {
  const { call, tab, browser, win } = await layerSetup();
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    const link = content.document.createElement("a");
    link.href = url;
    link.textContent = "Elsewhere";
    content.document.body.prepend(link);
  });
  const ref = await refFor(call, tab, /link "Elsewhere" \[(e\d+)\]/);
  const pending = call("click_element", { tab, ref });
  pending.catch(() => {});
  const doc = await alertIn(win);
  pressTakeControl(browser);
  await noLoadStarts(browser, () => choose(doc, "allow"), "Allow");
  Assert.equal(
    browser.currentURI.spec,
    INPUT,
    "the agent's load did not go on"
  );
});

/**
 * A tab a page in a taken workspace opens starts in the user's control too,
 * where Firefox put it, and is the agent's once the user gives the workspace
 * back.
 */
add_task(async function what_a_taken_tab_opens_is_the_users() {
  const { win, call, tab, tabs, agent, gate } = await layerSetup();
  await call("navigate_tab", { tab, to: ROOT + "sval_agent_links.html" });
  const { browser } = await tabs.tabIn(agent, tab);
  await takeControlOf(win, browser);
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#allowed-tab", {}, browser);
  const born = (await within(opened, 10_000, "the TabOpen event")).target;
  await within(
    BrowserTestUtils.browserLoaded(born.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  const id = born.linkedBrowser.browsingContext.browserId;
  Assert.ok(isUserInControl(id), "the new tab is in the user's control");
  Assert.equal(gate.agentOf(born.linkedBrowser), null, "and not the agent's");
  await TestUtils.waitForCondition(
    () => !partsOf(born.linkedBrowser).bar?.hidden,
    "it shows the bar"
  );
  await giveBackFrom(win, born.linkedBrowser);
  Assert.equal(
    gate.agentOf(born.linkedBrowser)?.agentId,
    agent.agentId,
    "given back, it is the agent's"
  );
});

/**
 * Drags the agent's tab out to a window of the user's, having first taken
 * control of it if `taken`, and checks it is the user's for good.
 *
 * @param {boolean} taken
 * @returns {Promise<{userWin: Window, moved: object}>} the user's window,
 *   and the tab's browser in it.
 */
async function dragOut(taken) {
  const { win, gate, tabEl, browser, call, tab } = await layerSetup();
  if (taken) {
    await takeControlOf(win, browser);
  }
  const userWin = await newWindowAfter(() =>
    win.gBrowser.replaceTabWithWindow(tabEl)
  );
  const panel = userWin.SvalPanel;
  // The workspace the user's window shows holds the page, so it outlives the
  // window, and a later window with no workspace of its own would adopt it
  // and restore the page. It goes with the task.
  atTaskEnd(async () => {
    const workspace = SvalWindowWorkspace.of(userWin).id;
    const observer = panel._observer;
    await within(
      BrowserTestUtils.closeWindow(userWin),
      10_000,
      "the user's window closing"
    );
    await within(observer.detach(), 10_000, "its observer's last flush");
    // A workspace left with nothing in it went with its window.
    const { nodes } = await SvalPanel.engine.tree();
    if (nodes[workspace]) {
      await SvalPanel.engine.mutate({ kind: "remove", id: workspace });
    }
  });
  const moved = userWin.gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(
    () =>
      gate.agentOf(moved) === null &&
      !isUserInControl(moved.browsingContext.browserId),
    "the tab is the user's"
  );
  await within(panel._observer.settled(), 10_000, "the user's window filing");
  // The agent's tab is filed at `about:blank` and its page reaches the node
  // by a commit the agent's window recorded, which that window's flush
  // writes. Commits are held per engine, so the user's window writes them
  // only if its own flush takes them first.
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the agent's window writing the page"
  );
  const { nodes } = await panel._engine.tree();
  const id = SessionStore.getCustomTabValue(
    userWin.gBrowser.getTabForBrowser(moved),
    SvalTabs.NODE_ID_KEY
  );
  Assert.equal(
    nodes[id]?.content?.url,
    moved.currentURI.spec,
    "its node holds the page it shows"
  );
  Assert.ok(!partsOf(moved).overlay, "with no overlay");
  Assert.ok(!partsOf(moved).bar, "and no bar");
  await Assert.rejects(
    call("get_snapshot", { tab }),
    e => e.code === "not_controlled",
    "the agent cannot reach it"
  );
  return { userWin, moved };
}

add_task(async function dragging_a_tab_out_takes_it_for_good() {
  await dragOut(false);
});

add_task(async function dragging_a_taken_tab_out_takes_it_for_good() {
  await dragOut(true);
});

/**
 * A tab the user took from an agent and then closed stays closed: its node
 * leaves the profile's document as any tab's does, so no restore of the
 * window's workspace brings it back. Re-attaching the window's tab observer
 * is that restore, as a restart's is: it opens a tab for every node of the
 * workspace that has none.
 *
 * @param {boolean} taken
 */
async function closedStaysClosed(taken) {
  const { userWin, moved } = await dragOut(taken);
  const panel = userWin.SvalPanel;
  await within(panel._started.promise, 10_000, "the user's window's panel");
  await within(panel._observer.settled(), 10_000, "its observer settling");
  const movedTab = userWin.gBrowser.getTabForBrowser(moved);
  const url = moved.currentURI.spec;
  const id = SessionStore.getCustomTabValue(movedTab, SvalTabs.NODE_ID_KEY);
  Assert.ok(id, "the user's window filed the tab");

  // The window stays open with a tab of its own, as a user's does.
  BrowserTestUtils.addTab(userWin.gBrowser, "about:blank");
  BrowserTestUtils.removeTab(movedTab);
  await within(panel._observer.settled(), 10_000, "the close being filed");
  const { nodes } = await panel._engine.tree();
  Assert.ok(!nodes[id], "its node left the profile's document");

  await stopFixture({ observer: panel._observer });
  panel._observer = null;
  await panel._attachTabs();
  await within(panel._observer.settled(), 10_000, "the restore settling");
  Assert.ok(
    !userWin.gBrowser.browsers.some(b => b.currentURI.spec === url),
    "restoring the window's workspace does not reopen it"
  );
}

add_task(async function a_dragged_out_tab_closed_stays_closed() {
  await closedStaysClosed(false);
});

add_task(async function a_taken_tab_dragged_out_and_closed_stays_closed() {
  await closedStaysClosed(true);
});
