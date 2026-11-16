/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * The first-visit alert on a host under its site (decision 1980): its
 * "Remember for" menu starts at the host, and the answer is saved for the
 * scope picked, so a sibling host asks again or follows the site.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

const HOST_PAGE = PAGE.replace("://example.com/", "://test1.example.com/");
const SIBLING_PAGE = PAGE2.replace("://example.com/", "://test2.example.com/");

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** Allow, left at the host, covers that host alone. */
add_task(async function an_answer_starts_at_the_host() {
  const { agent, store, call, win, alerts } = await agentSetup();
  const opening = call("open_tab", { url: HOST_PAGE });
  const doc = await alertIn(win);
  const button = doc.getElementById("sval-aa-scope-button");
  Assert.ok(button.checkVisibility(), "the alert offers where to save it");
  Assert.equal(
    doc.querySelector('[role="option"][aria-selected="true"]').dataset.scope,
    "test1.example.com",
    "it starts at the host"
  );
  await choose(doc, "allow");
  Assert.equal((await opening).url, HOST_PAGE);
  Assert.deepEqual(store.policyOf(agent.agentId).sites, {
    "test1.example.com": "ask-before-writes",
  });

  const sibling = call("open_tab", { url: SIBLING_PAGE });
  await choose(await alertIn(win), "deny");
  Assert.equal((await sibling).status, 403, "a sibling host is asked again");
  Assert.equal(alerts.opened, 2);
  Assert.equal(
    (await call("open_tab", { url: HOST_PAGE })).url,
    HOST_PAGE,
    "the host keeps its own answer"
  );
  Assert.equal(alerts.opened, 2, "and is not asked again");
});

/** Deny for the whole site, picked from the menu by keyboard. */
add_task(async function an_answer_for_the_site_covers_its_hosts() {
  const { agent, store, call, win, alerts } = await agentSetup();
  const opening = call("open_tab", { url: HOST_PAGE });
  const doc = await alertIn(win);
  const view = doc.defaultView;
  const button = doc.getElementById("sval-aa-scope-button");
  const menu = doc.getElementById("sval-aa-scope-menu");
  button.focus();
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, view);
  Assert.ok(menu.checkVisibility(), "Down opens the menu");
  Assert.equal(button.getAttribute("aria-expanded"), "true");
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, view);
  EventUtils.synthesizeKey("KEY_Enter", {}, view);
  Assert.ok(!menu.checkVisibility(), "Enter picks and closes the menu");
  Assert.equal(doc.activeElement, button, "focus returns to the button");
  Assert.equal(
    doc.querySelector('[role="option"][aria-selected="true"]').dataset.scope,
    "example.com"
  );
  button.focus();
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, view);
  EventUtils.synthesizeKey("KEY_Escape", {}, view);
  Assert.ok(!menu.checkVisibility(), "Escape closes the menu");
  Assert.ok(win.gDialogBox.isOpen, "and leaves the alert up");
  await choose(doc, "deny");
  Assert.equal((await opening).status, 403);
  Assert.deepEqual(store.policyOf(agent.agentId).sites, {
    "example.com": "blocked",
  });
  Assert.equal(
    (await call("open_tab", { url: SIBLING_PAGE })).status,
    403,
    "a sibling host follows the site"
  );
  Assert.equal(alerts.opened, 1, "unasked");
});

/** A site's own address has nothing to choose. */
add_task(async function a_site_offers_no_scope() {
  const { call, win } = await agentSetup();
  const opening = call("open_tab", { url: PAGE });
  const doc = await alertIn(win);
  Assert.ok(!doc.getElementById("sval-aa-scope").checkVisibility(), "no menu");
  await choose(doc, "allow");
  await opening;
});
