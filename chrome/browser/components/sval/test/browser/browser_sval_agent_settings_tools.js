/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Site tools in the Agents settings section: the switch under agent access,
 * an agent's Off, Ask or On, each site's Ask, Allowed or Blocked, and the
 * tools remembered on an allowed site. The controls show only where a tool
 * could reach the agent, and what they hide is kept.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_settings_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_settings_helpers.js",
  this
);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    set: [
      [SvalAgents.PREF, true],
      [SvalAgents.PAGE_TOOLS_PREF, true],
    ],
  });
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
});

/**
 * Pairs one agent with a site of each kind: an allowed site with two
 * remembered tools, a site with only a tools setting, and a blocked site.
 *
 * @returns {Promise<{store, id: string}>}
 */
async function pairWithTools() {
  const store = SvalAgents.store;
  atTaskEnd(unpairAll);
  const { agentId: id } = await store.pair({
    label: "Claude Code",
    workspaceId: SvalPanel.workspaceId,
  });
  await store.setSiteLevel(id, "github.com", "ask-before-writes");
  await store.setPageToolSite(id, "github.com", "allow");
  await store.grantPageTool(id, "github.com", "search_code", HASH_A);
  await store.grantPageTool(
    id,
    "github.com",
    '<img src="x" onerror="1">',
    HASH_B
  );
  await store.setPageToolSite(id, "ocado.com", "allow");
  await store.setSiteLevel(id, "paypal.com", "blocked");
  return { store, id };
}

/**
 * Opens settings on the Agents section with Claude Code's permissions open.
 *
 * @param {string} id The agent's id.
 * @returns {Promise<object>}
 */
async function openEditor(id) {
  const { page, byId, row: rowOf, open, editor } = await openAgents();
  const row = () => rowOf("Claude Code");
  await TestUtils.waitForCondition(row, "the agent is listed");
  await open("Claude Code");
  const q = selector => editor()?.querySelector(selector);
  const control = (kind, site) => q(`[data-sval-key="${kind}:${id}:${site}"]`);
  return {
    page,
    byId,
    row,
    editor,
    reopen: () => open("Claude Code"),
    q,
    control,
    // A site with no upload folders or apps has its remembered tools next.
    remembered: site =>
      control("page-tool-site", site)
        ?.closest(".sval-agent-rule")
        .nextElementSibling?.closest(".sval-agent-remembered"),
    sites: () =>
      [...editor().querySelectorAll(".sval-agent-site")].map(
        s => s.textContent
      ),
    message: () => editor().querySelector(".sval-agents-done")?.textContent,
    said: () => editor().querySelector(".sval-agents-done")?.dataset.said,
    undo: () => q(`.sval-agents-done [data-sval-key="undo:${id}"]`),
  };
}

add_task(async function the_switch_follows_agent_access() {
  const { id } = await pairWithTools();
  const ui = await openEditor(id);
  const toggle = ui.byId("sval-page-tools-enabled");
  Assert.ok(toggle.checked, "the switch shows the pref");
  Assert.ok(!toggle.disabled);
  Assert.equal(
    ui.page.document.querySelector('label[for="sval-page-tools-enabled"]')
      .control,
    toggle,
    "the label names the switch"
  );

  toggle.click();
  Assert.ok(
    !Services.prefs.getBoolPref(SvalAgents.PAGE_TOOLS_PREF),
    "the switch sets the pref"
  );
  await TestUtils.waitForCondition(
    () => ui.q(".sval-page-tools-hint"),
    "the editor points to the switch"
  );
  Assert.ok(!ui.q(".sval-agent-page-tools"), "no per-agent choice");
  Assert.ok(!ui.q(".sval-agent-tool-site"), "no Site tools column");
  Assert.ok(!ui.q(".sval-agent-remembered"), "no remembered tools");
  Assert.ok(!ui.q('option[value="tools"]'), "no tools filter");
  Assert.deepEqual(
    ui.sites(),
    ["github.com", "paypal.com"],
    "a tools-only site is hidden"
  );
  const meta = () => ui.row().querySelector(".sval-agent-meta").dataset;
  Assert.equal(meta().rules, "2", "the summary counts what shows");
  Assert.equal(meta().pageTools, "", "and has no tools");
  ui.q(".sval-page-tools-hint button").click();
  Assert.equal(
    ui.page.document.activeElement,
    toggle,
    "Go to the switch moves focus to it"
  );

  toggle.click();
  await ui.reopen();
  await TestUtils.waitForCondition(
    () => ui.q(".sval-agent-page-tools"),
    "the controls come back"
  );
  Assert.ok(ui.sites().includes("ocado.com"), "with every setting kept");
  Assert.equal(meta().rules, "3");
  Assert.equal(meta().pageTools, "ask");

  atTaskEnd(() => Services.prefs.setBoolPref(SvalAgents.PREF, true));
  Services.prefs.setBoolPref(SvalAgents.PREF, false);
  await TestUtils.waitForCondition(
    () => toggle.disabled,
    "the switch is locked while access is off"
  );
  Assert.ok(toggle.checked, "at its kept value");
  Assert.notEqual(
    ui.byId("sval-page-tools-note").textContent,
    "",
    "the note says how to change it"
  );
  ui.page.SvalSettings.setPageTools(false);
  Assert.ok(
    Services.prefs.getBoolPref(SvalAgents.PAGE_TOOLS_PREF),
    "it can't be changed while access is off"
  );
  Services.prefs.setBoolPref(SvalAgents.PREF, true);
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
  await TestUtils.waitForCondition(() => !toggle.disabled, "unlocked");
  Assert.equal(ui.byId("sval-page-tools-note").textContent, "", "no note");
  Assert.ok(SvalAgents.store.policyOf(id), "the agent was kept");
});

add_task(async function the_agent_chooses_off_ask_or_on() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);
  Assert.ok(ui.q('.sval-agent-page-tools input[value="ask"]').checked);

  ui.q('.sval-agent-page-tools input[value="on"]').click();
  await TestUtils.waitForCondition(
    () => store.policyOf(id).pageTools === "on",
    "On is set"
  );
  await TestUtils.waitForCondition(
    () => ui.row().querySelector(".sval-agent-meta").dataset.pageTools === "on",
    "the summary follows"
  );

  const filter = () => ui.q(`[data-sval-key="filt:${id}"]`);
  setValue(ui.page, filter(), "tools");
  Assert.deepEqual(ui.sites(), ["github.com", "ocado.com"], "the filter");

  ui.q('.sval-agent-page-tools input[value="off"]').click();
  await TestUtils.waitForCondition(
    () => store.policyOf(id).pageTools === "off",
    "Off is set"
  );
  await TestUtils.waitForCondition(() => !ui.q(".sval-agent-tool-site"));
  Assert.ok(ui.q('.sval-agent-page-tools input[value="off"]').checked);
  Assert.equal(filter().value, "all", "the tools filter resets");
  Assert.deepEqual(ui.sites(), ["github.com", "paypal.com"]);
  Assert.ok(!ui.q(".sval-agent-remembered"));

  // Removing a row while its tools are hidden keeps them.
  ui.control("remove", "github.com").click();
  await TestUtils.waitForCondition(
    () => !("github.com" in store.policyOf(id).sites),
    "the level is removed"
  );
  const policy = store.policyOf(id);
  Assert.equal(policy.pageToolSites["github.com"], "allow");
  Assert.equal(Object.keys(policy.pageToolGrants["github.com"]).length, 2);
});

add_task(async function each_site_is_ask_allowed_or_blocked() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);
  const select = site => ui.control("page-tool-site", site);
  Assert.equal(select("github.com").value, "allow");
  Assert.equal(
    ui.control("level", "ocado.com").value,
    "",
    "a tools-only site reads Default"
  );

  const paypal = select("paypal.com");
  Assert.ok(paypal.disabled, "a Blocked site's tools can't be changed");
  Assert.ok(paypal.title.includes("paypal.com"), "and the site says why");
  setValue(ui.page, ui.control("level", "paypal.com"), "full");
  await TestUtils.waitForCondition(() => !select("paypal.com").disabled);
  setValue(ui.page, select("paypal.com"), "allow");
  await TestUtils.waitForCondition(
    () => store.policyOf(id).pageToolSites["paypal.com"] === "allow",
    "Allowed is set"
  );

  setValue(ui.page, select("github.com"), "deny");
  await TestUtils.waitForCondition(
    () => store.policyOf(id).pageToolSites["github.com"] === "deny",
    "Blocked is set"
  );
  Assert.ok(
    !("github.com" in store.policyOf(id).pageToolGrants),
    "and the remembered tools are forgotten"
  );
  await TestUtils.waitForCondition(
    () => ui.said() === "blocked-tools" && ui.message().includes("2"),
    "the forgotten tools are counted"
  );
  Assert.ok(!ui.remembered("github.com"), "Blocked shows no remembered tools");

  setValue(ui.page, select("github.com"), "");
  await TestUtils.waitForCondition(
    () => !("github.com" in store.policyOf(id).pageToolSites),
    "Ask removes the entry"
  );
  Assert.ok(ui.sites().includes("github.com"), "the level keeps the row");

  setValue(ui.page, select("ocado.com"), "");
  await TestUtils.waitForCondition(
    () => !ui.sites().includes("ocado.com"),
    "Ask on a tools-only site removes its row"
  );
});

add_task(async function remembered_tools_are_listed_and_removed() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);
  const box = ui.remembered;
  Assert.equal(
    box("github.com").querySelectorAll(".sval-agent-chip").length,
    2,
    "both remembered tools are listed"
  );
  Assert.ok(
    box("github.com").querySelector(".sval-agents-note"),
    "under Ask a remembered tool still asks"
  );
  Assert.ok(
    !box("ocado.com").querySelector(".sval-agent-chips"),
    "a site with none lists none"
  );

  Assert.equal(
    box("ocado.com").querySelectorAll(".sval-agents-note").length,
    1,
    "with nothing remembered, the None line stands alone"
  );

  const names = [
    ...box("github.com").querySelectorAll(".sval-agent-chip-name"),
  ];
  Assert.deepEqual(
    names.map(n => n.textContent),
    ["search_code", '<img src="x" onerror="1">']
  );
  Assert.ok(!box("github.com").querySelector("img"), "a name is only text");
  Assert.equal(names[1].dir, "auto");
  Assert.equal(names[1].title, '<img src="x" onerror="1">');

  ui.q('.sval-agent-page-tools input[value="on"]').click();
  await TestUtils.waitForCondition(
    () =>
      store.policyOf(id).pageTools === "on" &&
      !box("github.com").querySelector(".sval-agents-note"),
    "under On there is no caveat"
  );

  ui.control("revoke", "github.com:search_code").click();
  await TestUtils.waitForCondition(
    () => !("search_code" in store.policyOf(id).pageToolGrants["github.com"]),
    "the tool is forgotten"
  );
  await TestUtils.waitForCondition(
    () => ui.said() === "forgot-tool" && ui.message().includes("search_code"),
    "the removal is said"
  );
  Assert.ok(!ui.q(".sval-agents-done button"), "with no Undo");

  setValue(ui.page, ui.control("page-tool-site", "github.com"), "");
  await TestUtils.waitForCondition(
    () => !("github.com" in store.policyOf(id).pageToolGrants),
    "Ask forgets the rest"
  );
  await TestUtils.waitForCondition(
    () => ui.said() === "forgot-tools" && ui.message().includes("1"),
    "and says so"
  );
});

add_task(async function undo_restores_the_remembered_tools() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);
  ui.control("remove", "github.com").click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(id);
    return (
      !("github.com" in policy.sites) &&
      !("github.com" in policy.pageToolSites) &&
      !("github.com" in policy.pageToolGrants)
    );
  }, "the row's every setting is removed");
  await TestUtils.waitForCondition(
    () => ui.said() === "removed" && ui.undo(),
    "the removal is said, with Undo"
  );

  ui.undo().click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(id);
    return (
      policy.sites["github.com"] === "ask-before-writes" &&
      policy.pageToolSites["github.com"] === "allow" &&
      policy.pageToolGrants["github.com"]?.search_code === HASH_A &&
      policy.pageToolGrants["github.com"]?.['<img src="x" onerror="1">'] ===
        HASH_B
    );
  }, "Undo puts back the level, the tools setting and the remembered tools");
  await TestUtils.waitForCondition(
    () => ui.remembered("github.com"),
    "and shows them"
  );
});

add_task(async function ask_on_a_tools_only_site_counts_what_it_forgets() {
  const { store, id } = await pairWithTools();
  await store.grantPageTool(id, "ocado.com", "add_to_basket", HASH_A);
  const ui = await openEditor(id);
  setValue(ui.page, ui.control("page-tool-site", "ocado.com"), "");
  await TestUtils.waitForCondition(
    () => !("ocado.com" in store.policyOf(id).pageToolGrants),
    "Ask forgets the remembered tool"
  );
  await TestUtils.waitForCondition(
    () => ui.said() === "forgot-tools" && ui.message().includes("1"),
    "as Allowed to Ask does on any site"
  );
  Assert.ok(!ui.q(".sval-agents-done button"), "with no Undo");
  Assert.ok(!ui.sites().includes("ocado.com"), "and the row is gone");
});

add_task(async function default_access_with_hidden_tools_offers_undo() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);
  ui.q('.sval-agent-page-tools input[value="off"]').click();
  await TestUtils.waitForCondition(() => !ui.q(".sval-agent-tool-site"));

  setValue(ui.page, ui.control("level", "github.com"), "");
  await TestUtils.waitForCondition(
    () => !("github.com" in store.policyOf(id).sites),
    "the level is removed"
  );
  await TestUtils.waitForCondition(
    () => ui.said() === "removed" && ui.undo(),
    "the row's removal is said, with Undo"
  );
  Assert.equal(store.policyOf(id).pageToolSites["github.com"], "allow");
  Assert.equal(
    Object.keys(store.policyOf(id).pageToolGrants["github.com"]).length,
    2,
    "the hidden tools are kept"
  );

  ui.undo().click();
  await TestUtils.waitForCondition(
    () => store.policyOf(id).sites["github.com"] === "ask-before-writes",
    "Undo puts back the level"
  );
  Assert.ok(ui.sites().includes("github.com"));
});

/**
 * With its tools hidden, a site's rule is its level and file permissions.
 * A removal Sval cannot save leaves all of it in place, and one it saves
 * takes all of it, keeps the hidden tools, and Undo puts back exactly what
 * was there.
 */
add_task(async function a_removal_is_all_of_the_rule_or_none_of_it() {
  const { store, id } = await pairWithTools();
  await store.setFilePermission(id, "downloads", "github.com", "allow");
  await store.setFilePermission(id, "uploads", "github.com", "deny");
  const before = store.policyOf(id);
  const ui = await openEditor(id);
  ui.q('.sval-agent-page-tools input[value="off"]').click();
  await TestUtils.waitForCondition(() => !ui.q(".sval-agent-tool-site"));
  const hidden = store.policyOf(id);

  const removeSite = store.removeSite;
  store.removeSite = () => Promise.reject(new Error("write failed"));
  ui.control("remove", "github.com").click();
  await TestUtils.waitForCondition(
    () => ui.said() === "not-saved",
    "the failure is said"
  );
  store.removeSite = removeSite;
  Assert.deepEqual(store.policyOf(id), hidden, "the rule is whole");
  Assert.ok(ui.sites().includes("github.com"), "and still listed");

  ui.control("remove", "github.com").click();
  await TestUtils.waitForCondition(
    () => ui.said() === "removed" && ui.undo(),
    "the removal is said, with Undo"
  );
  const removed = store.policyOf(id);
  Assert.ok(!("github.com" in removed.sites), "the level is removed");
  Assert.ok(!("github.com" in removed.downloads), "and the downloads rule");
  Assert.ok(!("github.com" in removed.uploads), "and the uploads rule");
  Assert.deepEqual(
    [removed.pageToolSites["github.com"], removed.pageToolGrants["github.com"]],
    [before.pageToolSites["github.com"], before.pageToolGrants["github.com"]],
    "the hidden tools are kept"
  );

  ui.undo().click();
  await TestUtils.waitForCondition(
    () => ui.sites().includes("github.com"),
    "Undo lists the site again"
  );
  Assert.deepEqual(store.policyOf(id), hidden, "with exactly what it had");
});

add_task(async function an_undo_that_cannot_be_saved_says_so() {
  const { store, id } = await pairWithTools();
  const ui = await openEditor(id);

  ui.control("remove", "github.com").click();
  await TestUtils.waitForCondition(() => ui.undo(), "the removal offers Undo");
  store.restoreSite = () => Promise.reject(new Error("write failed"));
  atTaskEnd(() => delete store.restoreSite);
  ui.undo().click();
  await TestUtils.waitForCondition(
    () => ui.said() === "not-saved",
    "the failure is said"
  );
  const policy = store.policyOf(id);
  Assert.ok(!("github.com" in policy.sites), "the level stays removed");
  Assert.ok(!("github.com" in policy.pageToolSites), "and the tools setting");
  Assert.ok(!ui.sites().includes("github.com"));
});

add_task(async function a_default_of_blocked_locks_site_tools() {
  const { store, id } = await pairWithTools();
  await store.setDefault(id, "blocked");
  const ui = await openEditor(id);
  const select = site => ui.control("page-tool-site", site);
  Assert.ok(select("ocado.com").disabled, "a site with no rule is Blocked");
  Assert.ok(select("ocado.com").title.includes("ocado.com"), "and says why");
  Assert.ok(!select("github.com").disabled, "a site's own level counts");

  setValue(ui.page, ui.control("level", "ocado.com"), "full");
  await TestUtils.waitForCondition(
    () => !select("ocado.com").disabled,
    "a level of its own unlocks it"
  );
});
