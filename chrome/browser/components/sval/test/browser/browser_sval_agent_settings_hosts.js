/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Site rules for one host in an agent's settings (decision 1980): the add
 * row's scope select, and a host's rule listed under its site's, removed and
 * put back on its own.
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

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({ set: [[SvalAgents.PREF, true]] });
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
});

/**
 * Pairs an agent with the window's workspace, unpaired when the task ends.
 *
 * @returns {Promise<{store, id: string}>}
 */
async function pairOne() {
  const store = SvalAgents.store;
  atTaskEnd(unpairAll);
  const { agentId } = await store.pair({
    label: "Claude Code",
    workspaceId: SvalWindowWorkspace.of(window).id,
  });
  return { store, id: agentId };
}

async function openEditor() {
  const ui = await openAgents();
  await TestUtils.waitForCondition(() => ui.row("Claude Code"), "listed");
  await ui.open("Claude Code");
  return ui;
}

/**
 * A host under its site offers where the rule goes, starting at the host. A
 * site, or `www.` of one, offers nothing to choose.
 */
add_task(async function the_add_row_saves_a_host_or_its_site() {
  const { store, id } = await pairOne();
  const ui = await openEditor();
  const editor = ui.editor;
  editor().querySelector(".sval-agent-add").click();
  const input = editor().querySelector(".sval-agent-add-input");
  const scope = () =>
    editor().querySelector(`[data-sval-key="adding-scope:${id}"]`);
  const preview = () => editor().querySelector(".sval-agent-preview");
  const enter = () =>
    input.dispatchEvent(
      new ui.page.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );

  for (const text of ["example.org", "www.example.org", "192.0.2.4"]) {
    setValue(ui.page, input, text, "input");
    Assert.ok(!scope().checkVisibility(), `${text} offers no scope`);
  }

  setValue(ui.page, input, "https://nas.example.org/dash", "input");
  Assert.ok(scope().checkVisibility(), "a host under its site offers one");
  Assert.equal(scope().value, "host", "starting at the host");
  Assert.equal(preview().dataset.site, "nas.example.org");
  enter();
  await TestUtils.waitForCondition(
    () => store.policyOf(id).sites["nas.example.org"] === "ask-before-writes",
    "the rule is saved for the host"
  );
  Assert.ok(
    !("example.org" in store.policyOf(id).sites),
    "the site has no rule"
  );

  editor().querySelector(".sval-agent-add").click();
  const again = editor().querySelector(".sval-agent-add-input");
  setValue(ui.page, again, "git.example.org", "input");
  setValue(ui.page, scope(), "site");
  Assert.equal(preview().dataset.site, "example.org");
  setValue(
    ui.page,
    editor().querySelector(`[data-sval-key="adding-level:${id}"]`),
    "blocked"
  );
  again.dispatchEvent(
    new ui.page.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await TestUtils.waitForCondition(
    () => store.policyOf(id).sites["example.org"] === "blocked",
    "the site's choice saves the rule for the whole site"
  );
  Assert.ok(
    !("git.example.org" in store.policyOf(id).sites),
    "the host has no rule of its own"
  );
});

/** A host's rule sits under its site's, and is removed on its own. */
add_task(async function a_host_rule_is_listed_under_its_site() {
  const { store, id } = await pairOne();
  await store.setSiteLevel(id, "example.org", "blocked");
  await store.setSiteLevel(id, "nas.example.org", "full");
  await store.setSiteLevel(id, "example.com", "read-only");
  await store.setFilePermission(id, "downloads", "nas.example.org", "allow");
  const ui = await openEditor();
  const editor = ui.editor;
  const names = () =>
    [
      ...editor().querySelectorAll(
        ".sval-agent-rule:not(.sval-agent-rule-head)"
      ),
    ].map(row => [
      row.dataset.host ?? null,
      row.querySelector(".sval-agent-site").title,
    ]);
  await TestUtils.waitForCondition(
    () => names().length === 3,
    "every rule is listed"
  );
  Assert.deepEqual(names(), [
    [null, "example.com"],
    [null, "example.org"],
    ["nas.example.org", "nas.example.org"],
  ]);
  Assert.equal(
    editor().querySelector(`[data-sval-key="downloads:${id}:example.org"]`)
      .value,
    "",
    "the site's row shows only its own answers"
  );

  ruleControl(editor, `[data-sval-key="remove:${id}:nas.example.org"]`).click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(id);
    return (
      !("nas.example.org" in policy.sites) &&
      !("nas.example.org" in policy.downloads)
    );
  }, "the host's rules are removed");
  Assert.equal(
    store.policyOf(id).sites["example.org"],
    "blocked",
    "its site's rule stays"
  );
  const undo = await TestUtils.waitForCondition(
    () =>
      editor().querySelector(`.sval-agents-done [data-sval-key="undo:${id}"]`),
    "Undo is offered"
  );
  undo.click();
  await TestUtils.waitForCondition(() => {
    const policy = store.policyOf(id);
    return (
      policy.sites["nas.example.org"] === "full" &&
      policy.downloads["nas.example.org"] === "allow"
    );
  }, "Undo puts the host's rules back");
});
