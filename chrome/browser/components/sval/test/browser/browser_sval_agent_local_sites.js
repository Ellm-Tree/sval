/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Sites on this computer and the local network (agent-control spec §5.2):
 * an agent's first load of one asks, whatever the default, as its host
 * shows it to be.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A server on this computer's loopback address, serving one page.
 *
 * @returns {string} The page's address, by IP address.
 */
function loopbackPage() {
  const server = new HttpServer();
  server.registerPathHandler("/", (request, response) => {
    response.setHeader("Content-Type", "text/html", false);
    response.write(
      "<!doctype html><title>Local</title><p>On this computer</p>"
    );
  });
  server.start(-1);
  atTaskEnd(() => new Promise(resolve => server.stop(resolve)));
  // eslint-disable-next-line sdl/no-insecure-url
  return `http://127.0.0.1:${server.identity.primaryPort}/`;
}

/**
 * @param {Document} doc An alert.
 * @returns {string[]} Its buttons' choices, in order.
 */
function choicesIn(doc) {
  return [...doc.querySelectorAll(".sval-aa-actions button")].map(
    b => b.dataset.choice
  );
}

add_task(
  async function a_loopback_address_asks_under_a_default_that_does_not() {
    const url = loopbackPage();
    const { agent, store, call, win } = await agentSetup();
    await store.setDefault(agent.agentId, "full");
    const opening = call("open_tab", { url });
    const doc = await alertIn(win);
    Assert.equal(
      doc.querySelector(".sval-aa").dataset.kind,
      "site-computer",
      "the alert asks about a service on this computer"
    );
    Assert.ok(
      doc.getElementById("sval-aa-question").textContent.includes("127.0.0.1"),
      "and names it"
    );
    Assert.deepEqual(
      choicesIn(doc),
      ["deny", "allow"],
      "no choice covers every site"
    );
    await choose(doc, "allow");
    Assert.equal((await opening).url, url);
    Assert.equal(
      store.policyOf(agent.agentId).sites["127.0.0.1"],
      "full",
      "Allow records the site at the default level"
    );
  }
);

add_task(async function a_denied_local_address_is_blocked() {
  const url = loopbackPage();
  const { agent, store, call, win, alerts } = await agentSetup();
  await store.setDefault(agent.agentId, "read-only");
  const opening = call("open_tab", { url });
  await choose(await alertIn(win), "deny");
  Assert.equal((await opening).status, 403, "Deny refuses the load");
  Assert.equal(store.policyOf(agent.agentId).sites["127.0.0.1"], "blocked");
  Assert.equal((await call("open_tab", { url })).status, 403);
  Assert.equal(alerts.opened, 1, "the refusal asked nothing");
});

add_task(async function a_public_site_with_no_rule_follows_the_default() {
  const { agent, store, call, alerts } = await agentSetup();
  await store.setDefault(agent.agentId, "read-only");
  Assert.equal((await call("open_tab", { url: PAGE })).url, PAGE);
  Assert.equal(alerts.opened, 0, "nothing asked");
  Assert.ok(
    !Object.hasOwn(store.policyOf(agent.agentId).sites, "example.com"),
    "and nothing recorded"
  );
});
