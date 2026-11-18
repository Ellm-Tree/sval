/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Link routing (link routing spec §6, §7): rules made in Settings › Links
 * send a link from another app straight to a workspace, the first match
 * winning, and a link no rule sends anywhere opens in a Peek. Every
 * link arrives as a command line holding `-url`, which these tests run
 * through the registered command-line handlers in their category's order,
 * as `nsCommandLine::Run` does.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
const { RULES_PREF, setRules } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLinkRules.sys.mjs"
);

const ROUTED = "https://example.com/browser/?routed";

/**
 * A second workspace, shown in no window, gone when the task ends with the
 * window back on the workspace it showed.
 *
 * @param {string} name
 * @returns {Promise<string>} its id.
 */
async function workspace(name) {
  const home = SvalWindowWorkspace.of(window).id;
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name,
    isolated: false,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalWindowWorkspace.of(window).id !== home) {
      await SvalPanel.switchTo(home);
      await within(
        SvalPanel.observer.settled(),
        10_000,
        "SvalPanel.observer settling"
      );
      // A workspace with no tab of its own opens a blank one when the window
      // switches back to it.
      expectOpened(...gBrowser.tabs);
    }
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * @returns {Promise<string>} the id of a workspace the user made and then
 *   deleted.
 */
async function deletedWorkspace() {
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Gone",
    isolated: false,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await removeWorkspace(id);
  await SvalPanel.refresh();
  return id;
}

/**
 * The user's rules, as Settings › Links saves them, cleared when the task
 * ends.
 *
 * @param {object[]} rules
 */
function rulesAre(rules) {
  setRules(rules);
  atTaskEnd(() => Services.prefs.clearUserPref(RULES_PREF));
}

/**
 * A link from another app, and the tab it opened in a workspace, loaded.
 *
 * @param {string} workspaceId Where it should open.
 * @returns {Promise<Element>} the tab.
 */
async function routedTo(workspaceId) {
  runCommandLine(["-url", ROUTED]);
  await TestUtils.waitForCondition(
    () =>
      SvalWindowWorkspace.of(window).id === workspaceId &&
      gBrowser.selectedTab.linkedBrowser.currentURI.spec === ROUTED,
    "the link opens as a tab in the rule's workspace"
  );
  const tab = expectOpened(gBrowser.selectedTab);
  Assert.equal(SvalPeek.windows().length, 0, "no Peek opened");
  return tab;
}

/**
 * A link from another app, and the Peek it opened instead.
 *
 * @returns {Promise<void>}
 */
async function peekFor() {
  const opened = BrowserTestUtils.waitForNewWindow({ url: ROUTED });
  runCommandLine(["-url", ROUTED]);
  const win = await within(opened, 20_000, "the Peek");
  Assert.ok(SvalPeek.isPeek(win), "it opened a Peek");
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing");
}

/**
 * Settings › Links, with its rules drawn.
 *
 * @returns {Promise<object>} as `openSettings` gives it.
 */
function openLinks() {
  return openPane(
    "svalLinks",
    ({ byId }) => byId("sval-link-rules-body")?.isConnected,
    "the Links pane"
  );
}

/**
 * @param {object} ui
 * @returns {Element[]} the rules' rows, in order.
 */
function ruleRows(ui) {
  return [
    ...ui
      .byId("sval-link-rules-body")
      .querySelectorAll(".sval-links-rule:not(.sval-agent-rule-head)"),
  ];
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

add_task(
  async function a_rule_made_in_settings_sends_a_link_to_its_workspace() {
    const work = await workspace("Work");
    atTaskEnd(() => Services.prefs.clearUserPref(RULES_PREF));
    const ui = await openLinks();
    const { page, byId } = ui;
    Assert.ok(
      byId("sval-link-rules-body").querySelector(".sval-empty"),
      "there are no rules at first"
    );

    byId("sval-link-rules-add").click();
    const form = byId("sval-link-rules-body").querySelector(
      '[data-form="adding"]'
    );
    const input = form.querySelector(".sval-agent-add-input");
    input.focus();
    EventUtils.sendString("https://www.example.com/some/page", page);
    const select = form.querySelector('[data-sval-key="add-rule-workspace"]');
    select.value = work;
    select.dispatchEvent(new page.Event("change"));
    const preview = form.querySelector(".sval-agent-preview");
    Assert.equal(preview.dataset.tone, "", "the rule can be saved");
    Assert.ok(
      preview.textContent.includes("example.com") &&
        preview.textContent.includes("Work"),
      "the preview says what the rule will do"
    );
    input.focus();
    EventUtils.synthesizeKey("KEY_Enter", {}, page);

    const [row] = ruleRows(ui);
    Assert.ok(row, "the rule is listed");
    Assert.equal(
      row.querySelector(".sval-agent-site").textContent,
      "example.com"
    );
    Assert.equal(
      row.querySelector(".sval-links-workspace").dataset.workspace,
      work,
      "in its workspace"
    );
    const status = byId("sval-link-rules-status");
    Assert.deepEqual(
      [status.textContent.match(/\d+/g), !!status.querySelector("button")],
      [["1"], false],
      "the status line says rule 1 was added"
    );

    const tab = await routedTo(work);
    Assert.equal(tab.documentGlobal, window, "in the frontmost window");
  }
);

add_task(async function a_routed_link_joins_no_group() {
  const { workspace: home } = await viewingAGroupedTab();
  rulesAre([{ kind: "site", value: "example.com", workspace: home }]);
  const tab = await routedTo(home);
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  Assert.deepEqual(
    await filedAt(tab),
    { parent: home, last: true },
    "it ends the workspace's own list, in no group"
  );
});

add_task(async function with_no_rule_matching_a_link_opens_a_peek() {
  const work = await workspace("Work");
  rulesAre([{ kind: "site", value: "example.org", workspace: work }]);
  await peekFor();
  Assert.notEqual(SvalWindowWorkspace.of(window).id, work, "nothing switched");
});

add_task(async function a_rule_whose_workspace_was_deleted_falls_through() {
  const work = await workspace("Work");
  const gone = await deletedWorkspace();
  rulesAre([
    { kind: "site", value: "example.com", workspace: gone },
    { kind: "contains", value: "?routed", workspace: work },
  ]);

  const ui = await openLinks();
  const [first] = ruleRows(ui);
  Assert.ok(
    first.querySelector(".sval-links-workspace.sval-links-none"),
    "the rule shows that its workspace is gone"
  );

  await routedTo(work);
});

add_task(async function with_every_rule_on_a_deleted_workspace_a_peek() {
  const gone = await deletedWorkspace();
  rulesAre([{ kind: "site", value: "example.com", workspace: gone }]);
  await peekFor();
});

add_task(async function reordering_changes_which_rule_wins() {
  const home = SvalWindowWorkspace.of(window).id;
  const work = await workspace("Work");
  rulesAre([
    { kind: "contains", value: "example", workspace: home },
    { kind: "site", value: "example.com", workspace: work },
  ]);

  const ui = await openLinks();
  const [, second] = ruleRows(ui);
  const mark = second.querySelector(".sval-links-mark")?.textContent;
  Assert.ok(
    mark?.match(/\d+/g)?.join() === "1" && mark.includes('"example"'),
    "the rule the first always beats is marked, naming rule 1"
  );

  second.querySelector(".sval-links-grip").focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, ui.page);
  const [first, next] = ruleRows(ui);
  Assert.equal(
    first.querySelector(".sval-agent-site").textContent,
    "example.com",
    "the site rule moved up"
  );
  Assert.ok(
    !ui.page.document.querySelector(".sval-links-mark"),
    "and neither rule is marked"
  );
  Assert.ok(next, "both rules are kept");
  Assert.equal(
    ui.page.document.activeElement,
    first.querySelector(".sval-links-grip"),
    "the moved rule's grip keeps the focus"
  );

  await routedTo(work);
});

add_task(async function deleting_a_rule_can_be_undone() {
  const work = await workspace("Work");
  rulesAre([
    { kind: "site", value: "example.com", workspace: work },
    { kind: "site", value: "example.org", workspace: work },
  ]);

  const ui = await openLinks();
  ruleRows(ui)[0]
    .querySelector('[data-sval-key="remove:site:example.com"]')
    .click();
  Assert.deepEqual(
    ruleRows(ui).map(row => row.querySelector(".sval-agent-site").textContent),
    ["example.org"],
    "the rule is gone at once"
  );
  const status = ui.byId("sval-link-rules-status");
  Assert.stringContains(
    status.querySelector("span").textContent,
    "example.com",
    "the status line names the deleted rule"
  );
  Assert.ok(status.querySelector("button"), "and offers Undo");
  await peekFor();

  status.querySelector("button").click();
  Assert.deepEqual(
    ruleRows(ui).map(row => row.querySelector(".sval-agent-site").textContent),
    ["example.com", "example.org"],
    "Undo puts it back in its place"
  );
  await routedTo(work);
});

add_task(async function editing_a_rule_changes_where_its_links_open() {
  const home = SvalWindowWorkspace.of(window).id;
  const work = await workspace("Work");
  rulesAre([
    { kind: "site", value: "example.org", workspace: home },
    { kind: "site", value: "example.com", workspace: home },
  ]);

  const ui = await openLinks();
  ruleRows(ui)[1]
    .querySelector('[data-sval-key="edit:site:example.com"]')
    .click();
  // A sync moves the rule being edited while its form is open.
  setRules([
    { kind: "site", value: "example.com", workspace: home },
    { kind: "site", value: "example.org", workspace: home },
  ]);
  const form = ui
    .byId("sval-link-rules-body")
    .querySelector('[data-form="editing"]');
  Assert.equal(
    form.querySelector(".sval-agent-add-input").value,
    "example.com",
    "the form follows its rule"
  );
  const select = form.querySelector('[data-sval-key="edit-rule-workspace"]');
  select.value = work;
  select.dispatchEvent(new ui.page.Event("change"));
  form.querySelector('[data-sval-key="edit-rule-save"]').click();
  const rows = ruleRows(ui);
  Assert.deepEqual(
    rows.map(row => row.querySelector(".sval-agent-site").textContent),
    ["example.com", "example.org"],
    "the other rule is kept"
  );
  Assert.equal(
    rows[0].querySelector(".sval-links-workspace").dataset.workspace,
    work,
    "the edited rule opens in its new workspace"
  );
  await routedTo(work);
});
