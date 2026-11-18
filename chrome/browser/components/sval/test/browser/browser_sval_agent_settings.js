/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Agents settings section: the paired agents, one agent's permissions
 * edited in place, a site rule added and removed with Undo, unpairing, and
 * the section with agent access off. Every change goes through the open
 * listener's store, which the gate reads for every decision, so it applies
 * to a live connection without a re-pair.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_settings_helpers.js */
/* import-globals-from sval_panel_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_settings_helpers.js",
  this
);

const { APPROVAL_WAIT_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { POLITE_RATE_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({ set: [[SvalAgents.PREF, true]] });
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
});

/**
 * Pairs two agents, one in the window's workspace and one whose workspace is
 * gone, and unpairs them when the task ends.
 *
 * @returns {Promise<{store, claude: string, codex: string}>}
 */
async function pairTwo() {
  const store = SvalAgents.store;
  atTaskEnd(unpairAll);
  const claude = await store.pair({
    label: "Claude Code",
    workspaceId: SvalWindowWorkspace.of(window).id,
    client: "claude-code",
    dir: "/work/sval",
    started: 1_700_000_000_000,
  });
  const codex = await store.pair({ label: "Codex", workspaceId: "gone" });
  return { store, claude: claude.agentId, codex: codex.agentId };
}

/**
 * The rate "Be polite" holds an agent to is a setting in the section: one a
 * second to start with, whole numbers from one, and only those are kept.
 * Anything else stays in the field, marked invalid, with what to type.
 */
add_task(async function the_polite_rate_is_a_setting() {
  Services.prefs.clearUserPref(POLITE_RATE_PREF);
  atTaskEnd(() => Services.prefs.clearUserPref(POLITE_RATE_PREF));
  const ui = await openAgents();
  const field = ui.byId("sval-agents-polite-rate");
  Assert.equal(field.value, "1", "one action a second by default");
  Assert.equal(
    ui.page.document.querySelector('label[for="sval-agents-polite-rate"]')
      .control,
    field,
    "the label names the field"
  );

  setValue(ui.page, field, "5");
  Assert.equal(Services.prefs.getIntPref(POLITE_RATE_PREF), 5, "it is kept");

  const status = ui.byId(field.getAttribute("aria-describedby"));
  for (const bad of ["0", "-2", "1.5", "150"]) {
    setValue(ui.page, field, bad);
    Assert.equal(
      Services.prefs.getIntPref(POLITE_RATE_PREF),
      5,
      `${JSON.stringify(bad)} leaves the setting as it was`
    );
    Assert.equal(field.value, bad, "the field keeps what was typed");
    Assert.equal(field.getAttribute("aria-invalid"), "true", "marked invalid");
    Assert.notEqual(status.textContent, "", "with what to type");
  }
  setValue(ui.page, field, "5");
  Assert.equal(
    field.getAttribute("aria-invalid"),
    "false",
    "a good one is not"
  );
  Assert.equal(status.textContent, "", "and the message goes");

  Services.prefs.setIntPref(POLITE_RATE_PREF, 2);
  await TestUtils.waitForCondition(
    () => field.value === "2",
    "a change from about:config shows"
  );
});

/**
 * How long an agent waits for the user's answer is a setting in the section:
 * an hour to start with.
 */
add_task(async function the_agents_wait_is_a_setting() {
  Services.prefs.clearUserPref(APPROVAL_WAIT_PREF);
  atTaskEnd(() => Services.prefs.clearUserPref(APPROVAL_WAIT_PREF));
  const ui = await openAgents();
  const menu = ui.byId("sval-agents-wait");
  Assert.equal(menu.value, "3600", "an hour by default");
  Assert.equal(
    ui.page.document.querySelector('label[for="sval-agents-wait"]').control,
    menu,
    "the label names the menu"
  );
  setValue(ui.page, menu, "900");
  Assert.equal(Services.prefs.getIntPref(APPROVAL_WAIT_PREF), 900, "kept");
  Services.prefs.setIntPref(APPROVAL_WAIT_PREF, 14400);
  await TestUtils.waitForCondition(
    () => menu.value === "14400",
    "a change from about:config shows"
  );
});

/**
 * How long an unused agent Workspace is kept is a setting in the section:
 * 30 days to start with, and Never keeps them.
 */
add_task(async function unused_agent_workspaces_are_kept_as_set() {
  const pref = SvalAgents.WORKSPACE_RETENTION_PREF;
  Services.prefs.clearUserPref(pref);
  atTaskEnd(() => Services.prefs.clearUserPref(pref));
  const ui = await openAgents();
  const menu = ui.byId("sval-agents-retention");
  Assert.equal(menu.value, "30", "30 days by default");
  Assert.equal(
    ui.page.document.querySelector('label[for="sval-agents-retention"]')
      .control,
    menu,
    "the label names the menu"
  );
  setValue(ui.page, menu, "0");
  Assert.equal(Services.prefs.getIntPref(pref), 0, "Never is kept");
  Services.prefs.setIntPref(pref, 90);
  await TestUtils.waitForCondition(
    () => menu.value === "90",
    "a change from about:config shows"
  );
});

add_task(async function paired_agents_are_listed() {
  const { store, claude } = await pairTwo();
  await store.setSiteLevel(claude, "a.example", "full");
  const ui = await openAgents();

  await TestUtils.waitForCondition(() => ui.rows().length === 2, "two rows");
  Assert.equal(ui.byId("sval-agents-status").dataset.state, "on");
  Assert.ok(ui.byId("sval-agents-empty").hidden, "no empty state");
  const meta = ui.row("Claude Code").querySelector(".sval-agent-meta");
  Assert.ok(
    meta.querySelector(".sval-agent-ws"),
    "the agent's workspace is named"
  );
  Assert.equal(meta.dataset.level, "ask", "other sites ask on first visit");
  Assert.equal(meta.dataset.rules, "1", "with one site rule");
  Assert.ok(
    !ui.row("Codex").querySelector(".sval-agent-ws"),
    "a workspace that is gone is not named"
  );
  await unpairAll();
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-agents-empty").hidden,
    "the empty state shows"
  );
  Assert.equal(ui.rows().length, 0);
  Assert.equal(ui.byId("sval-agents-status").dataset.state, "on");
});

/**
 * The user deletes an agent's workspace from the panel. The agent stays
 * paired and listed, with that workspace gone from it (decision 1998).
 */
add_task(async function deleting_an_agents_workspace_leaves_it_paired() {
  const store = SvalAgents.store;
  atTaskEnd(unpairAll);
  const id = await SvalPanel.engine.mutate({
    kind: "addAgentWorkspace",
    name: "Kept",
    agentLabel: "Kept",
    id: crypto.randomUUID(),
    now: Date.now(),
    isolated: false,
  });
  atTaskEnd(async () => {
    if (id in ((await SvalPanel.engine.tree()).nodes ?? {})) {
      await removeWorkspace(id);
    }
  });
  await SvalPanel.refresh();
  const { agentId } = await store.pair({ label: "Kept", workspaceId: id });
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Kept"), "listed");

  await chooseOnWorkspace(id, "deleteWorkspace");
  await answerDialog();
  await dismissUndoMessage();
  Assert.ok(!(id in (await SvalPanel.engine.tree()).nodes), "deleted");
  await TestUtils.waitForCondition(
    () => !store.agents().find(a => a.agentId === agentId)?.workspaces.length,
    "the agent's record lets the workspace go"
  );
  Assert.ok(ui.row("Kept"), "the agent stays paired and listed");
  Assert.ok(
    !ui.row("Kept").querySelector(".sval-agent-ws"),
    "with no workspace named"
  );
});

add_task(async function a_level_is_edited_in_place() {
  const { store, claude } = await pairTwo();
  await store.setSiteLevel(claude, "a.example", "read-only");
  await store.allowUploadFolders(
    claude,
    "b.example",
    [PathUtils.tempDir],
    true
  );
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");

  const link = () => ui.row("Claude Code").querySelector(".sval-agent-open");
  Assert.ok(
    link().getAttribute("aria-label").includes("Claude Code"),
    "each agent's Permissions is named for it"
  );
  const editor = ui.editor;
  await ui.open("Claude Code");
  Assert.ok(
    !ui.byId("sval-agents-paired").checkVisibility(),
    "the agent's page takes the place of the list"
  );
  ui.byId("sval-agent-back").click();
  await TestUtils.waitForCondition(
    () => ui.byId("sval-agents-paired").checkVisibility(),
    "Back returns to the list"
  );
  Assert.ok(!editor(), "with the page gone");
  await ui.open("Codex");
  await ui.open("Claude Code");

  editor().querySelector('input[value="full"]').click();
  await TestUtils.waitForCondition(
    () => store.policyOf(claude).default === "full",
    "the default is set"
  );
  await TestUtils.waitForCondition(
    () =>
      ui.row("Claude Code").querySelector(".sval-agent-meta").dataset.level ===
      "full",
    "the summary follows"
  );

  const control = (kind, site) =>
    editor().querySelector(`[data-sval-key="${kind}:${claude}:${site}"]`);
  const access = () => control("level", "a.example");
  Assert.equal(access().value, "read-only");
  setValue(ui.page, access(), "blocked");
  await TestUtils.waitForCondition(
    () => store.policyOf(claude).sites["a.example"] === "blocked",
    "the site's level is set"
  );

  const uploads = control("uploads", "b.example");
  Assert.equal(
    control("level", "b.example").value,
    "",
    "a site with only a file rule reads Default"
  );
  Assert.equal(uploads.value, "allow", "an upload grant reads Allow");
  Assert.equal(uploads.title, PathUtils.tempDir, "with the folders it covers");
  setValue(ui.page, uploads, "deny");
  await TestUtils.waitForCondition(
    () => store.policyOf(claude).uploads["b.example"] === "deny",
    "the upload permission is set"
  );
  setValue(ui.page, control("uploads", "b.example"), "");
  await TestUtils.waitForCondition(
    () => !("b.example" in store.policyOf(claude).uploads),
    "Ask removes it"
  );

  // A change the gate makes while the editor is open shows at once.
  await store.setSiteLevel(claude, "c.example", "full");
  await TestUtils.waitForCondition(
    () => control("level", "c.example"),
    "a rule from a prompt answer appears"
  );
});

/**
 * A site's apps show each scheme it asked for, with Allow, Ask and Deny, and
 * a site-wide Deny. Its upload folders show their scope, and Settings
 * narrows or removes one, never widening it (agent-control spec §5.2).
 */
add_task(async function apps_and_upload_folders_are_edited_in_place() {
  const { store, claude } = await pairTwo();
  await store.setAppPermission(claude, "zoom.us", "zoommtg", "allow");
  await store.setAppPermission(claude, "zoom.us", "zoomus", "deny");
  const dir = PathUtils.tempDir;
  await store.allowUploadFolders(claude, "b.example", [dir], true);
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");
  const editor = ui.editor;

  const apps = () =>
    editor().querySelector(`[data-sval-key="apps:${claude}:zoom.us"]`);
  Assert.equal(apps().value, "schemes", "the site's apps are listed");
  Assert.deepEqual(apps().title.split("\n"), ["zoommtg", "zoomus"]);
  const scheme = name =>
    editor().querySelector(`[data-sval-key="app:${claude}:zoom.us:${name}"]`);
  Assert.equal(scheme("zoommtg").value, "allow");
  Assert.equal(scheme("zoomus").value, "deny");
  setValue(ui.page, scheme("zoomus"), "");
  await TestUtils.waitForCondition(
    () => !("zoomus" in store.policyOf(claude).apps["zoom.us"]),
    "Ask forgets the scheme"
  );
  setValue(ui.page, apps(), "deny");
  await TestUtils.waitForCondition(
    () => store.policyOf(claude).apps["zoom.us"] === "deny",
    "Deny covers every app"
  );
  await TestUtils.waitForCondition(() => !scheme("zoommtg"), "no list");
  setValue(ui.page, apps(), "");
  await TestUtils.waitForCondition(
    () => !("zoom.us" in store.policyOf(claude).apps),
    "Ask removes the entry"
  );

  const folders = () =>
    editor()
      .querySelector(`[data-sval-key^="folder-remove:${claude}:b.example:"]`)
      ?.closest(".sval-agent-remembered");
  const chip = () => folders()?.querySelector(".sval-agent-chip");
  await TestUtils.waitForCondition(() => folders(), "the folders show");
  Assert.equal(chip().dataset.subfolders, "true", "with their scope");
  folders().querySelector(".sval-agent-chip-action").click();
  await TestUtils.waitForCondition(
    () =>
      store.policyOf(claude).uploads["b.example"].folders[0].subfolders ===
      false,
    "Settings narrows it"
  );
  await TestUtils.waitForCondition(
    () => chip()?.dataset.subfolders === "false",
    "and says so"
  );
  Assert.ok(
    !folders().querySelector(".sval-agent-chip-action"),
    "with nothing to widen it"
  );
  folders().querySelector(".sval-agent-chip-remove").click();
  await TestUtils.waitForCondition(
    () => !("b.example" in store.policyOf(claude).uploads),
    "removing the last folder makes uploads ask"
  );
});

add_task(async function a_site_is_added_and_removed_with_undo() {
  const { store, claude } = await pairTwo();
  await store.setSiteLevel(claude, "amazon.co.uk", "read-only");
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");
  const editor = ui.editor;

  editor().querySelector(".sval-agent-add").click();
  const input = editor().querySelector(".sval-agent-add-input");
  Assert.equal(ui.page.document.activeElement, input, "the field has focus");
  const [label] = input.labels;
  Assert.ok(label?.checkVisibility(), "the field has a shown label");
  Assert.equal(
    (await accessibleOf(input)).name,
    label.textContent.trim(),
    "the label names the field"
  );
  Assert.equal(
    editor().querySelector(`[data-sval-key="adding-level:${claude}"]`).value,
    "ask-before-writes",
    "under Ask on first visit the level starts at Ask before writes"
  );
  const preview = () => editor().querySelector(".sval-agent-preview");
  const add = () =>
    editor().querySelector(".sval-agent-adding .sval-button-primary");

  setValue(ui.page, input, "www.amazon.co.uk", "input");
  Assert.ok(add().disabled, "a site with a rule cannot be added twice");
  Assert.equal(preview().dataset.reading, "exists", "the rule is named");
  Assert.equal(preview().dataset.site, "amazon.co.uk");
  Assert.ok(
    preview().querySelector(`[data-sval-key="show:${claude}"]`),
    "with a way to show it"
  );

  setValue(ui.page, input, "github.io", "input");
  Assert.ok(!add().disabled, "a host that is itself a suffix is a site");
  Assert.equal(preview().dataset.reading, "suffix", "covering only itself");
  Assert.equal(preview().dataset.site, "github.io");

  setValue(ui.page, input, "https://www.ocado.com/basket?id=4471", "input");
  Assert.ok(!add().disabled);
  Assert.equal(preview().dataset.reading, "site", "the address is a site's");
  Assert.equal(preview().dataset.site, "ocado.com", "read as its site");
  input.dispatchEvent(
    new ui.page.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await TestUtils.waitForCondition(
    () => store.policyOf(claude).sites["ocado.com"] === "ask-before-writes",
    "Enter adds the rule"
  );
  await TestUtils.waitForCondition(
    () => editor().querySelector(".sval-agent-rule-new"),
    "the new rule is pinned"
  );
  const pinned = editor().querySelectorAll(
    ".sval-agent-rule:not(.sval-agent-rule-head)"
  )[0];
  Assert.equal(
    pinned.querySelector(".sval-agent-site").textContent,
    "ocado.com"
  );
  Assert.ok(pinned.querySelector(".sval-agent-new"), "marked as just added");
  Assert.ok(!editor().querySelector(".sval-agent-adding"), "the row closes");

  await store.setFilePermission(claude, "downloads", "amazon.co.uk", "deny");
  await TestUtils.waitForCondition(
    () =>
      editor().querySelector(
        `[data-sval-key="downloads:${claude}:amazon.co.uk"]`
      )?.value === "deny",
    "the file rule shows"
  );
  editor()
    .querySelector(`[data-sval-key="remove:${claude}:amazon.co.uk"]`)
    .click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(claude);
    return (
      !("amazon.co.uk" in policy.sites) && !("amazon.co.uk" in policy.downloads)
    );
  }, "every rule for the site is removed");
  const undo = await TestUtils.waitForCondition(
    () =>
      editor()
        .querySelector(".sval-agents-done")
        ?.textContent.includes("amazon.co.uk") &&
      editor().querySelector(
        `.sval-agents-done [data-sval-key="undo:${claude}"]`
      ),
    "the removal is said, with Undo"
  );
  undo.click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(claude);
    return (
      policy.sites["amazon.co.uk"] === "read-only" &&
      policy.downloads["amazon.co.uk"] === "deny"
    );
  }, "Undo puts both back");
});

/**
 * An agent's permissions are a page of its own, as a site's and an
 * extension's are: an address of its own, a breadcrumb back to Agents, the
 * browser's Back, and Unpair, which takes the page with the agent.
 */
add_task(async function an_agents_page_is_a_page_of_its_own() {
  const { store, claude } = await pairTwo();
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");
  Assert.equal(
    ui.page.location.hash,
    `#svalAgents-agent?id=${encodeURIComponent(claude)}`,
    "the page has an address"
  );
  Assert.ok(
    ui.page.document.title.includes("Claude Code"),
    "the title names the agent"
  );
  const crumbs = ui.byId("sval-agent-page").querySelector(".sval-site-crumbs");
  Assert.deepEqual(
    [...crumbs.querySelectorAll("a")],
    [ui.byId("sval-agent-crumb")],
    "the breadcrumb is Agents › the agent"
  );
  Assert.equal(
    ui.page.document.activeElement,
    ui.byId("sval-agent-title"),
    "the caret lands on its name"
  );

  ui.page.history.back();
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-agent-page").checkVisibility(),
    "the browser's Back leaves the page"
  );
  Assert.equal(ui.page.location.hash, "#svalAgents");
  Assert.equal(
    ui.page.document.activeElement,
    ui.row("Claude Code").querySelector(".sval-agent-open"),
    "focus goes back to the agent's link"
  );

  await ui.open("Claude Code");
  ui.byId("sval-agent-crumb").click();
  await TestUtils.waitForCondition(
    () => ui.byId("sval-agents-paired").checkVisibility(),
    "the breadcrumb returns to the list"
  );

  await ui.open("Codex");
  ui.byId("sval-agent-cards")
    .querySelector('[data-sval-key^="page-unpair:"]')
    .click();
  ui.byId("sval-unpair-confirm").click();
  await TestUtils.waitForCondition(
    () =>
      !ui.row("Codex") &&
      !ui.byId("sval-agent-page").checkVisibility() &&
      ui.byId("sval-agents-paired").checkVisibility(),
    "unpairing from the page returns to the list without it"
  );
  Assert.equal(store.agents().length, 1);
});

/**
 * At twice the text size the row that adds a site rule stays usable, and
 * Agents still fits the window's width.
 */
add_task(async function the_add_row_fits_twice_the_text_size() {
  await pairTwo();
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  atTwiceTheText(ui);
  await ui.open("Claude Code");
  ui.editor().querySelector(".sval-agent-add").click();
  const row = await TestUtils.waitForCondition(
    () => ui.editor().querySelector(".sval-agent-adding"),
    "the add row opens"
  );
  assertRowFits(row, "Add site");
  assertPaneFits(ui, "Agents");
});

add_task(async function the_rules_are_searched_and_shown_eight_at_first() {
  const { store, claude } = await pairTwo();
  for (let i = 0; i < 12; i++) {
    await store.setSiteLevel(
      claude,
      `s${String(i).padStart(2, "0")}.example`,
      i % 2 ? "full" : "blocked"
    );
  }
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");
  const editor = ui.editor;
  const shown = () =>
    editor().querySelectorAll(".sval-agent-rule:not(.sval-agent-rule-head)")
      .length;
  Assert.equal(shown(), 8, "the first eight");
  const more = editor().querySelector(".sval-agent-more");
  Assert.equal(more.textContent.match(/\d+/)?.[0], "4", "the rest are offered");
  more.click();
  Assert.equal(shown(), 12);

  setValue(
    ui.page,
    editor().querySelector(".sval-agent-search"),
    "s1",
    "input"
  );
  Assert.equal(shown(), 2, "a search shows every match");
  setValue(
    ui.page,
    editor().querySelector(".sval-agent-search"),
    "nothing",
    "input"
  );
  const nomatch = editor().querySelector(".sval-agent-nomatch");
  Assert.ok(nomatch.textContent.includes("nothing"), "no match is said");
  nomatch.querySelector(`[data-sval-key="clear:${claude}"]`).click();
  setValue(
    ui.page,
    editor().querySelector(`[data-sval-key="filt:${claude}"]`),
    "blocked"
  );
  Assert.equal(shown(), 6, "the filter narrows to one level");
});

add_task(async function unpair_confirms_and_closes_the_agent() {
  const { store, codex } = await pairTwo();
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Codex"), "listed");
  ui.row("Codex").querySelector(".sval-agent-unpair").click();
  const dialog = ui.byId("sval-unpair-dialog");
  Assert.ok(dialog.open, "Unpair asks first");
  Assert.ok(
    ui.byId("sval-unpair-title").textContent.includes("Codex"),
    "it names the agent"
  );
  Assert.equal(
    ui.page.document.activeElement,
    ui.byId("sval-unpair-cancel"),
    "Cancel has the focus"
  );
  ui.byId("sval-unpair-cancel").click();
  Assert.ok(!dialog.open);
  Assert.ok(store.policyOf(codex), "Cancel keeps the agent");

  ui.row("Codex").querySelector(".sval-agent-unpair").click();
  Assert.ok(
    ui.byId("sval-unpair-workspaces").hidden,
    "an agent with no workspace left offers to delete none"
  );
  ui.byId("sval-unpair-confirm").click();
  await TestUtils.waitForCondition(() => !ui.row("Codex"), "the row goes");
  Assert.equal(store.policyOf(codex), null, "its record and policy are gone");
  Assert.ok(
    ui.byId("sval-agents-message").textContent.includes("Codex"),
    "the unpairing is said"
  );
});

/**
 * Unpair offers to delete the agent's workspaces with it, checked. Unchecked,
 * the workspace stays.
 */
add_task(async function unpair_deletes_the_agents_workspaces_when_checked() {
  const store = SvalAgents.store;
  atTaskEnd(unpairAll);
  const addWorkspace = async name => {
    const id = await SvalPanel.engine.mutate({
      kind: "addAgentWorkspace",
      name,
      agentLabel: name,
      id: crypto.randomUUID(),
      now: Date.now(),
      isolated: false,
    });
    atTaskEnd(async () => {
      if (id in ((await SvalPanel.engine.tree()).nodes ?? {})) {
        await removeWorkspace(id);
      }
    });
    await store.pair({ label: name, workspaceId: id });
    return id;
  };
  const deleted = await addWorkspace("Deleted");
  const kept = await addWorkspace("Kept");
  await SvalPanel.refresh();
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Kept"), "listed");
  const nodes = async () => (await SvalPanel.engine.tree()).nodes;

  ui.row("Deleted").querySelector(".sval-agent-unpair").click();
  Assert.ok(!ui.byId("sval-unpair-workspaces").hidden, "it offers");
  Assert.ok(ui.byId("sval-unpair-delete-workspaces").checked, "checked");
  ui.byId("sval-unpair-confirm").click();
  await TestUtils.waitForCondition(
    async () => !(deleted in (await nodes())),
    "its workspace goes with it"
  );

  ui.row("Kept").querySelector(".sval-agent-unpair").click();
  ui.byId("sval-unpair-delete-workspaces").click();
  ui.byId("sval-unpair-confirm").click();
  await TestUtils.waitForCondition(() => !ui.row("Kept"), "unpaired");
  Assert.ok(kept in (await nodes()), "unchecked, the workspace stays");
});

add_task(async function access_off_hides_the_list_and_keeps_pairings() {
  const { claude } = await pairTwo();
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");

  atTaskEnd(() => Services.prefs.setBoolPref(SvalAgents.PREF, true));
  Services.prefs.setBoolPref(SvalAgents.PREF, false);
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-agents-off").hidden,
    "the card says access is off"
  );
  Assert.equal(ui.rows().length, 0, "the list is hidden");
  Assert.equal(ui.byId("sval-agents-status").dataset.state, "off");

  Services.prefs.setBoolPref(SvalAgents.PREF, true);
  await TestUtils.waitForCondition(
    () => ui.row("Claude Code"),
    "the agents are back"
  );
  Assert.ok(SvalAgents.store.policyOf(claude), "the pairing was kept");
  Assert.ok(
    !ui.byId("sval-agent-page").checkVisibility() && !ui.editor(),
    "and the agent's page stayed closed"
  );
});
