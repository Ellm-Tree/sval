/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * First run's import (2026-11-09 spec §2.4, §3.7, §4): an import continued
 * through still runs on Skip setup, under the welcome, which shows the card
 * Arc gave the user. The row steps through the browsers, Start browsing
 * waits for the import to end, and the Workspace the flow made is the one
 * the first imported Space fills, so no empty Workspace is left. First run
 * is opened here with the panel's own actions, so its import step can read
 * a fake Arc.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

const { SvalFirstRun } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs"
);
const { SvalFirstRunModel } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRunModel.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const { STEPS } = SvalFirstRunModel;

/**
 * @param {Document} doc The dialog's document.
 * @returns {Element|null} the one visible step.
 */
function shownSection(doc) {
  return [...doc.querySelectorAll("main > section")].find(
    section => !section.hidden
  );
}

/**
 * Presses `which` on the visible step and waits for `step`, once the step
 * shown has passed its own task, which a Continue in it is ignored in.
 *
 * @param {Document} doc
 * @param {string} which A button's class, past `sval-fr-`.
 * @param {string} step
 */
async function press(doc, which, step) {
  await new Promise(resolve => doc.defaultView.setTimeout(resolve, 0));
  shownSection(doc).querySelector(`.sval-fr-${which}`).click();
  await TestUtils.waitForCondition(
    () => shownSection(doc)?.dataset.step === step,
    `${which} shows ${step}`
  );
}

add_task(async function an_arc_import_runs_under_the_welcome() {
  keepPrefs(
    "browser.sval.card",
    "browser.sval.adblock.level",
    "browser.sval.agents.enabled",
    "browser.sval.agents.pageTools.enabled",
    "browser.sval.passwordManager",
    // First run's import step offers to keep archiving idle tabs as Arc did.
    "browser.sval.tabs.autoArchive",
    "sidebar.position_start",
    "sidebar.revamp"
  );
  const search = SvalSettingsSync.searchService();
  const engine = await search.currentId();
  registerCleanupFunction(() =>
    within(search.setById(engine), 10_000, "putting back the search engine")
  );
  atTaskEnd(closeLeftoverDialog);

  const home = await arcFixture();
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  await IOUtils.writeJSON(PathUtils.join(root, "StorableMembershipCard.json"), {
    version: 1,
    shapeName: "Shape3",
    paletteNumber: 4,
    backgroundBlobInfo: [2, 10, 5, 5, 12, 11, 2, 12, 3, 2, 11, 3, 6, 14, 3],
    title: "VAGUE ARCHIVIST",
  });
  await IOUtils.writeJSON(PathUtils.join(root, "StorableAuthState.json"), {
    session: {
      user: {
        createdAt: (Date.UTC(2024, 4, 17, 12) - Date.UTC(2001, 0, 1)) / 1000,
      },
    },
  });
  const before = new Set(
    SvalPanelModel.workspaceIds((await SvalPanel.engine.tree()).nodes)
  );

  const shown = SvalFirstRun.open(window, {
    actions: SvalPanel._firstRunActions(),
    facts: { importAvailable: true, isDefaultBrowser: true, earlier: {} },
    roots: { arc: { home } },
  });
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "first run opens");
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  const doc = gDialogBox.dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => shownSection(doc)?.dataset.step === STEPS.intro,
    "the introduction"
  );
  await press(doc, "skip", STEPS.question);
  await press(doc, "continue", STEPS.import);
  const step = shownSection(doc);
  await TestUtils.waitForCondition(
    () => !step.querySelector(".sval-fr-continue").disabled,
    "the import step reads Arc"
  );
  const tick = step.querySelector('.sval-im-source[data-source="arc"] input');
  if (!tick.checked) {
    tick.click();
  }
  Assert.ok(
    BrowserTestUtils.isVisible(step.querySelector(".sval-fr-arc-card")),
    "the step says Arc's card comes too"
  );
  // Arc's Space fills the Workspace the flow makes, so there is none to name.
  await press(doc, "continue", STEPS.search);

  await press(doc, "later", STEPS.welcome);
  const welcome = shownSection(doc);
  const start = welcome.querySelector(".sval-fr-start");
  const row = welcome.querySelector(".sval-fr-import");
  Assert.equal(welcome.dataset.card, "arc", "the welcome shows Arc's card");
  const title = JSON.parse(
    Services.prefs.getStringPref("browser.sval.card")
  ).title;
  const heading = welcome.querySelector("h1").textContent;
  Assert.ok(
    heading.toLowerCase().includes(title.toLowerCase()),
    "and greets the user by its title"
  );
  Assert.ok(!heading.includes(title), "in title case, not the card's capitals");
  Assert.ok(BrowserTestUtils.isVisible(row), "the import shows under it");
  Assert.ok(
    row.querySelector(".sval-fr-import-logos img"),
    "with the browser's logo"
  );
  Assert.ok(
    row.dataset.state !== "running" || start.disabled,
    "Start browsing waits while the import runs"
  );
  await TestUtils.waitForCondition(
    () => row.dataset.state === "done",
    "the import ends"
  );
  Assert.ok(!start.disabled, "and Start browsing can be pressed");
  await TestUtils.waitForCondition(
    () => welcome.querySelector(".sval-mcard svg"),
    "the card is drawn"
  );
  start.click();
  await within(shown, 10_000, "first run's end");

  const { nodes } = await SvalPanel.engine.tree();
  const made = SvalPanelModel.workspaceIds(nodes).filter(id => !before.has(id));
  Assert.equal(made.length, 1, "one Workspace is made");
  Assert.equal(
    nodes[made[0]].content.name,
    "Home",
    "and it is the one Arc's Space filled"
  );
  Assert.ok(
    SvalPanelModel.childrenByParent(nodes).get(made[0])?.length,
    "with its tabs"
  );
  Assert.equal(
    JSON.parse(Services.prefs.getStringPref("browser.sval.card")).title,
    "VAGUE ARCHIVIST",
    "the user's card is Arc's"
  );
});
