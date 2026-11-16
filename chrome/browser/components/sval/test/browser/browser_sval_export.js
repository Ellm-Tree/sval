/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/** The export page, opened from the panel (export spec §3, §7). */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { noticeOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExportModel.sys.mjs"
);
const MockFilePicker = SpecialPowers.MockFilePicker;

add_setup(() => {
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/**
 * Opens the export page and waits for it to draw.
 *
 * @param {object} [options] As `SvalPanel.openExport` takes them.
 */
async function openExportPage(options) {
  const done = SvalPanel.openExport(options);
  const doc = await openedDialog(".sval-ex-target");
  return { done, doc };
}

async function pick(doc, key) {
  const radio = doc.querySelector(`.sval-ex-radio[value="${key}"]`);
  await clickInDialog(radio, key);
  Assert.ok(radio.checked, `${key} is chosen`);
}

/**
 * The page offers the user's workspaces and never an agent's, shows History
 * for Safari alone, and once saved says how to import into that browser.
 */
add_task(async function the_page_offers_what_the_target_takes() {
  const { engine, ids } = await withFreshPanel();
  const agent = crypto.randomUUID();
  await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Agent work",
    agentLabel: "Test Agent",
    id: agent,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const { done, doc } = await openExportPage();
  const listed = [...doc.querySelectorAll(".sval-ex-workspace")].map(
    box => box.value
  );
  Assert.ok(listed.includes(ids.workspace), "the user's workspace is offered");
  Assert.ok(!listed.includes(agent), "and the agent's is not");
  Assert.ok(
    [...doc.querySelectorAll(".sval-ex-workspace")].every(box => box.checked),
    "every workspace starts ticked"
  );
  const historyRow = doc.querySelector(".sval-ex-history-row");
  Assert.ok(historyRow.hidden, "no History for Chrome");
  await pick(doc, "safari");
  Assert.ok(!historyRow.hidden, "History for Safari");
  await pick(doc, "firefox");
  Assert.ok(historyRow.hidden, "and for no other browser");
  await pick(doc, "sval");
  Assert.ok(
    doc.querySelector(".sval-ex-choices").hidden,
    "complete data takes everything"
  );
  await pick(doc, "edge");

  const file = new FileUtils.File(tempPath("sval-export", ".html"));
  MockFilePicker.setFiles([file]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const exportButton = doc.querySelector(".sval-ex-export");
  await clickInDialog(exportButton, "Export");
  const notice = doc.querySelector(".sval-ex-notice");
  await TestUtils.waitForCondition(() => !notice.hidden, "the notice shows");
  Assert.deepEqual(
    [...notice.querySelectorAll("p")].slice(1).map(p => p.textContent),
    noticeOf("edge"),
    "the notice is Edge's"
  );
  const html = await IOUtils.readUTF8(file.path);
  Assert.ok(html.includes(">Work</H3>"), "the workspace is in the file");
  Assert.ok(!html.includes("Agent work"), "the agent's is not");

  Assert.equal(exportButton.dataset.done, "true", "Export became Done");
  await clickInDialog(exportButton, "Done");
  await within(done, 10_000, "Done closing the page");
});
