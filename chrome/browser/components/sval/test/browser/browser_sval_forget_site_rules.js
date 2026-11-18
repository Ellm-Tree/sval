/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Forget this site (site page spec §2): what names a site outside the
 * site's own page, which is the rules paired agents hold for it, the link
 * rules for it, the allowed domains of it and its archived tabs.
 */

const { SvalForgetSite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalForgetSite.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalArchive } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
);
const { SvalLinkRules } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLinkRules.sys.mjs"
);

const SITE = "a.com";
const HOST = `app.${SITE}`;
const OTHER = "b.com";

/** @returns {Promise<string>} A paired agent's id, unpaired at the task's end. */
async function paired() {
  await agentAccessForTask();
  const { agentId } = await SvalAgents.store.pair({
    label: "Claude Code",
    workspaceId: SvalWindowWorkspace.of(window).id,
  });
  atTaskEnd(() => SvalAgents.withStore(store => store.unpair(agentId)));
  return agentId;
}

/** @param {string} part One of `SvalForgetSite.PARTS`. */
async function forget(part) {
  await within(
    SvalForgetSite.retry(SITE, [part]),
    30_000,
    `the site's ${part} forgetting`
  );
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

add_task(
  async function forget_removes_what_a_paired_agent_holds_for_the_site() {
    const agentId = await paired();
    const store = SvalAgents.store;
    await store.setSiteLevel(agentId, SITE, "full");
    await store.setFilePermission(agentId, "downloads", HOST, "allow");
    await store.setSiteLevel(agentId, OTHER, "read-only");

    Assert.equal(
      (await SvalForgetSite.countsFor(SITE)).permissions,
      2,
      "the site's rule and its host's count"
    );
    await forget("permissions");

    const policy = store.policyOf(agentId);
    Assert.deepEqual(policy.sites, { [OTHER]: "read-only" });
    Assert.deepEqual(policy.downloads ?? {}, {});
    Assert.equal((await SvalForgetSite.countsFor(SITE)).permissions, 0);
  }
);

add_task(async function forget_reaches_the_agents_file_while_access_is_off() {
  const agentId = await paired();
  await SvalAgents.store.setSiteLevel(agentId, SITE, "full");
  await SvalAgents.store.setSiteLevel(agentId, OTHER, "full");
  await agentAccessOff();

  Assert.equal(
    (await SvalForgetSite.countsFor(SITE)).permissions,
    1,
    "the rule in the file counts"
  );
  await forget("permissions");

  await agentAccessForTask();
  Assert.deepEqual(SvalAgents.store.policyOf(agentId).sites, {
    [OTHER]: "full",
  });
});

add_task(
  async function forget_removes_the_sites_link_rules_and_allowed_domains() {
    const workspace = SvalWindowWorkspace.of(window).id;
    const contains = {
      kind: SvalLinkRules.CONTAINS,
      value: "a.com/docs",
      workspace,
    };
    const other = { kind: SvalLinkRules.SITE, value: OTHER, workspace };
    atTaskEnd(() => {
      SvalLinkRules.setRules([]);
      for (const domain of SvalBlocking.allowedDomains()) {
        SvalBlocking.removeAllowedDomain(domain);
      }
    });
    SvalLinkRules.setRules([
      { kind: SvalLinkRules.SITE, value: SITE, workspace },
      contains,
      { kind: SvalLinkRules.SITE, value: HOST, workspace },
      other,
    ]);
    SvalBlocking.addAllowedDomain(`cdn.${SITE}`);
    SvalBlocking.addAllowedDomain(OTHER);

    Assert.equal((await SvalForgetSite.countsFor(SITE)).choices, 3);
    await forget("choices");

    Assert.deepEqual(
      SvalLinkRules.rules(),
      [contains, other],
      "a rule for text an address contains names no site, so it stays"
    );
    Assert.deepEqual(SvalBlocking.allowedDomains(), [OTHER]);
    Assert.equal((await SvalForgetSite.countsFor(SITE)).choices, 0);
  }
);

add_task(async function forget_removes_the_sites_archived_tabs() {
  // Another file may have stopped the process's Archive when it ended.
  await SvalArchive.stopShared();
  const archive = await SvalArchive.startFor(SvalPanel.engine, {
    canBegin: () => true,
    requestPass: () => {},
  });
  const entry = url => ({
    title: "Page",
    url,
    workspace: SvalWindowWorkspace.of(window).id,
    workspaceName: "",
    closedAt: Date.now() - 60_000,
  });
  const added = [
    `https://${SITE}/one`,
    `https://${HOST}/two`,
    `https://${OTHER}/`,
  ];
  // The Archive may hold what earlier files left.
  const urls = async () =>
    (await archive.entries())
      .map(e => e.url)
      .filter(url => added.includes(url))
      .sort();
  atTaskEnd(async () => {
    await within(
      archive.forget(row => added.includes(row.url)),
      30_000,
      "the test's entries leaving the Archive"
    );
    await SvalArchive.stopShared();
  });
  await within(
    archive.importEntries(added.map(entry)),
    30_000,
    "the entries reaching the Archive"
  );

  Assert.equal((await SvalForgetSite.countsFor(SITE)).archive, 2);
  await forget("archive");

  Assert.deepEqual(await urls(), [`https://${OTHER}/`]);
  Assert.equal((await SvalForgetSite.countsFor(SITE)).archive, 0);
});

/**
 * Forget takes every choice a site can hold: each kind `SvalSiteChoices`
 * lists names the part of Forget that takes it.
 */
add_task(function every_site_choice_names_the_part_that_forgets_it() {
  const { SvalSiteChoices } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteChoices.sys.mjs"
  );
  for (const choice of SvalSiteChoices.CHOICES) {
    Assert.ok(
      SvalForgetSite.PARTS.includes(choice.forget),
      `${choice.id} is forgotten with a part of Forget`
    );
  }
});
