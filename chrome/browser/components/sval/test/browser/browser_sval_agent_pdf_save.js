/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * PDF.js's own Save button in an agent's tab is a download like any other
 * (agent-control spec §5.2): it follows the site's download permission.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const PDF = ROOT + "sval_agent_doc.pdf";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * An agent's tab showing the test PDF in PDF.js, with downloads going to a
 * fresh folder.
 *
 * @param {string} downloads example.com's download permission.
 * @returns {Promise<object>}
 */
async function pdfSetup(downloads) {
  const dir = await makeTempDir("sval-agent-pdf");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", false],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let pickers = 0;
  MockFilePicker.showCallback = () => {
    pickers++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(async () => {
    MockFilePicker.cleanup();
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    await IOUtils.remove(dir, { recursive: true });
    await SpecialPowers.popPrefEnv();
  });
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  await setup.store.setFilePermission(
    setup.agent.agentId,
    "downloads",
    "example.com",
    downloads
  );
  const { tab } = await setup.call("open_tab", { url: PDF });
  const { browser } = await setup.tabs.tabIn(setup.agent, tab);
  await TestUtils.waitForCondition(
    () =>
      browser.browsingContext.currentWindowGlobal?.documentPrincipal
        .originNoSuffix === "resource://pdf.js",
    "PDF.js shows the PDF"
  );
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(browser, [], () =>
        Boolean(content.wrappedJSObject.PDFViewerApplication?.pdfDocument)
      ),
    "the PDF has loaded"
  );
  return { ...setup, dir, list, tab, browser, pickers: () => pickers };
}

/**
 * Has the agent click PDF.js's Save button.
 *
 * @param {object} setup What `pdfSetup` returned.
 * @param {Function} setup.call
 * @param {string} setup.tab
 */
async function clickSave({ call, tab }) {
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Save" \[(e\d+)\]/)[1];
  await call("click_element", { tab, ref });
}

add_task(async function a_pdf_saved_on_a_denied_site_is_not_saved() {
  const setup = await pdfSetup("deny");
  const saved = TestUtils.topicObserved("pdfjs:saveComplete");
  await clickSave(setup);
  await within(saved, 10_000, "the pdfjs:saveComplete notification");
  await TestUtils.waitForCondition(async () => {
    const all = (await setup.call("list_downloads", {})).downloads;
    return all.length === 1 && all[0].state === "denied";
  }, "the save is listed as denied");
  Assert.deepEqual(await IOUtils.getChildren(setup.dir), [], "nothing saved");
  Assert.equal(setup.pickers(), 0, "no save-as picker opened");
  Assert.equal(setup.alerts.opened, 0, "the site's answer was not asked again");
});

add_task(async function a_pdf_saved_on_an_allowed_site_is_saved_unasked() {
  const setup = await pdfSetup("allow");
  await clickSave(setup);
  let entry;
  await TestUtils.waitForCondition(async () => {
    [entry] = (await setup.call("list_downloads", {})).downloads;
    return entry?.state === "done";
  }, "the save is listed as done");
  Assert.equal(
    PathUtils.parent(entry.path),
    setup.dir,
    "in the download folder"
  );
  Assert.ok(await IOUtils.exists(entry.path), "and on disk");
  Assert.equal(setup.pickers(), 0, "no save-as picker opened");
  Assert.equal(setup.alerts.opened, 0);
  const { workspaceOfDownload } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs"
  );
  const [download] = await setup.list.getAll();
  Assert.equal(
    workspaceOfDownload(download),
    setup.agent.workspaceId,
    "the save is the agent's workspace's download"
  );
  Assert.equal(
    document.getElementById("downloadsPanel").state,
    "closed",
    "and opens no Downloads panel in the user's window"
  );
});

/** A save the gate fails to place is dropped, never handed to PDF.js. */
add_task(async function a_save_the_gate_cannot_place_is_dropped() {
  const { addPdfSaverForTests } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs"
  );
  const setup = await pdfSetup("allow");
  atTaskEnd(
    addPdfSaverForTests(() => {
      throw new Error("injected");
    })
  );
  const saved = TestUtils.topicObserved("pdfjs:saveComplete");
  await clickSave(setup);
  await within(saved, 10_000, "the pdfjs:saveComplete notification");
  Assert.deepEqual(await IOUtils.getChildren(setup.dir), [], "nothing saved");
  Assert.deepEqual(
    (await setup.list.getAll()).length,
    0,
    "and nothing was handed to Firefox's downloads"
  );
  Assert.equal(setup.pickers(), 0, "no save-as picker opened");
});

/** An allowed save that fails before its download exists is listed failed. */
add_task(async function an_allowed_save_that_cannot_start_is_listed_failed() {
  const setup = await pdfSetup("allow");
  const preferred = Downloads.getPreferredDownloadsDirectory;
  Downloads.getPreferredDownloadsDirectory = async () => {
    throw new Error("injected");
  };
  atTaskEnd(() => (Downloads.getPreferredDownloadsDirectory = preferred));
  const saved = TestUtils.topicObserved("pdfjs:saveComplete");
  await clickSave(setup);
  await within(saved, 10_000, "the pdfjs:saveComplete notification");
  await TestUtils.waitForCondition(async () => {
    const all = (await setup.call("list_downloads", {})).downloads;
    return all.length === 1 && all[0].state === "failed";
  }, "the save is listed as failed");
  Assert.deepEqual(await IOUtils.getChildren(setup.dir), [], "nothing saved");
});
