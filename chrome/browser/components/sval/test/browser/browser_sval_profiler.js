/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Performance recordings (decision 2428): a recording started in the running
 * Sval saves a gzipped profile in the download folder, from Help ›
 * Record Performance, about:support's button and about:processes' button on
 * a process, and the file manager is asked to show it.
 */

const { SvalProfiler } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProfiler.sys.mjs"
);

/**
 * Points the download folder at a fresh directory, and catches the file the
 * file manager is asked to show in place of showing it.
 *
 * @returns {Promise<{dir: string, shown: Promise<string>}>}
 */
async function downloadsInTemp() {
  const dir = await makeTempDir("sval-profiler");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.folderList", 2],
      ["browser.download.dir", dir],
    ],
  });
  const { promise: shown, resolve } = Promise.withResolvers();
  const revealFile = SvalProfiler.revealFile;
  SvalProfiler.revealFile = resolve;
  atTaskEnd(async () => {
    SvalProfiler.revealFile = revealFile;
    if (Services.profiler.IsActive()) {
      await within(
        Services.profiler.StopProfiler(),
        10_000,
        "the profiler stopping"
      );
    }
  });
  return { dir, shown };
}

/**
 * The profile a saved file holds, unzipped and parsed.
 *
 * @param {string} path
 * @returns {Promise<object>}
 */
async function readProfile(path) {
  const bytes = await IOUtils.read(path);
  Assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "the file is gzipped");
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/**
 * Waits until every process has sampled at least once.
 */
async function sampled() {
  await within(
    Services.profiler.waitOnePeriodicSampling(),
    10_000,
    "every process sampling once"
  );
}

add_task(async function a_recording_saves_a_profile_in_the_download_folder() {
  const { dir } = await downloadsInTemp();
  await within(SvalProfiler.start(), 10_000, "the recording starting");
  Assert.ok(SvalProfiler.recording, "a recording runs");
  await sampled();

  const path = await within(SvalProfiler.save(), 30_000, "the profile saving");
  Assert.ok(!SvalProfiler.recording, "the recording stops once saved");
  Assert.equal(PathUtils.parent(path), dir, "saved in the download folder");

  const profile = await readProfile(path);
  Assert.equal(
    profile.meta.appBuildID,
    Services.appinfo.appBuildID,
    "the profile names the build it came from"
  );
  Assert.ok(
    profile.threads.some(thread => thread.name == "GeckoMain"),
    "the parent's main thread is recorded"
  );
  Assert.ok(profile.processes.length, "the child processes are recorded");
});

add_task(async function saving_with_nothing_recording_saves_nothing() {
  await downloadsInTemp();
  Assert.equal(await SvalProfiler.save(), null, "no file");
});

add_task(async function help_menu_starts_then_saves_a_recording() {
  const { dir, shown } = await downloadsInTemp();
  const popup = document.getElementById("menu_HelpPopup");
  const item = document.getElementById("sval-help-record-performance");
  Assert.equal(item.parentNode, popup, "in the Help menu");

  popup.dispatchEvent(new Event("popupshowing"));
  Assert.ok(!item.hasAttribute("data-recording"), "it offers to record");
  item.doCommand();
  await within(
    TestUtils.waitForCondition(() => Services.profiler.IsActive()),
    10_000,
    "the recording starting"
  );
  popup.dispatchEvent(new Event("popupshowing"));
  Assert.ok(item.hasAttribute("data-recording"), "it offers to save");
  await sampled();

  item.doCommand();
  const path = await within(shown, 30_000, "the saved file shown");
  Assert.equal(PathUtils.parent(path), dir, "in the download folder");
  Assert.ok(await IOUtils.exists(path), "and it exists");
  Assert.ok(!Services.profiler.IsActive(), "the recording stops");
});

add_task(async function about_support_starts_then_saves_a_recording() {
  const { shown } = await downloadsInTemp();
  await BrowserTestUtils.withNewTab("about:support", async browser => {
    const button = browser.contentDocument.getElementById(
      "sval-record-performance-button"
    );
    Assert.ok(!button.hasAttribute("data-recording"), "it offers to record");
    button.click();
    await within(
      TestUtils.waitForCondition(
        () => button.hasAttribute("data-recording") && !button.disabled
      ),
      10_000,
      "the recording starting"
    );
    await sampled();
    button.click();
    const path = await within(shown, 30_000, "the saved file shown");
    Assert.ok(await IOUtils.exists(path), "the saved file exists");
    await within(
      TestUtils.waitForCondition(() => !button.hasAttribute("data-recording")),
      10_000,
      "it offers to record again"
    );
  });
});

add_task(async function about_processes_records_one_process_to_a_file() {
  const { shown } = await downloadsInTemp();
  await SpecialPowers.pushPrefEnv({
    set: [["toolkit.aboutProcesses.profileDuration", 1]],
  });
  await BrowserTestUtils.withNewTab("about:processes", async browser => {
    const doc = browser.contentDocument;
    const icon = await within(
      TestUtils.waitForCondition(() => doc.querySelector(".profiler-icon")),
      10_000,
      "a process's profiler button"
    );
    icon.click();
    const path = await within(shown, 30_000, "the saved file shown");
    const profile = await readProfile(path);
    Assert.ok(profile.meta, "a profile was saved");
  });
});

/**
 * Opens a private window, closed when the task ends.
 *
 * @returns {Promise<Window>}
 */
async function openPrivateWindow() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  atTaskEnd(
    () =>
      !win.closed &&
      within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the private window closing"
      )
  );
  return win;
}

add_task(async function a_private_window_disables_recording_everywhere() {
  await downloadsInTemp();
  const win = await openPrivateWindow();
  Assert.ok(!SvalProfiler.canRecord, "no recording may start");

  const popup = document.getElementById("menu_HelpPopup");
  const item = document.getElementById("sval-help-record-performance");
  popup.dispatchEvent(new Event("popupshowing"));
  Assert.ok(item.hasAttribute("disabled"), "the Help item is disabled");
  await SvalProfiler.start();
  Assert.ok(!SvalProfiler.recording, "and a start does nothing");

  await BrowserTestUtils.withNewTab("about:support", async browser => {
    const button = browser.contentDocument.getElementById(
      "sval-record-performance-button"
    );
    Assert.ok(button.disabled, "about:support's button is disabled");
  });

  await BrowserTestUtils.withNewTab("about:processes", async browser => {
    const doc = browser.contentDocument;
    const icon = await within(
      TestUtils.waitForCondition(() =>
        doc.querySelector(".profiler-icon[aria-disabled]")
      ),
      10_000,
      "a process's profiler button"
    );
    Assert.equal(
      icon.getAttribute("aria-disabled"),
      "true",
      "about:processes' button is disabled"
    );
    icon.click();
    Assert.ok(!SvalProfiler.recording, "and a press records nothing");
  });

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the private window closing"
  );
  await within(
    TestUtils.waitForCondition(() => SvalProfiler.canRecord),
    10_000,
    "recording allowed again"
  );
  popup.dispatchEvent(new Event("popupshowing"));
  Assert.ok(!item.hasAttribute("disabled"), "the Help item is enabled again");
});

add_task(async function a_private_window_opening_drops_the_recording() {
  const { dir } = await downloadsInTemp();
  await within(SvalProfiler.start(), 10_000, "the recording starting");
  await sampled();
  await openPrivateWindow();
  Assert.ok(!SvalProfiler.recording, "the recording stops");
  Assert.equal(await SvalProfiler.save(), null, "nothing is saved");
  Assert.deepEqual(await IOUtils.getChildren(dir), [], "no file was written");
});

add_task(async function a_recording_from_outside_stops_while_private() {
  const { dir } = await downloadsInTemp();
  await openPrivateWindow();
  // As the profiler's signal and `MOZ_PROFILER_STARTUP` start it: straight
  // through Gecko, past `SvalProfiler.start`.
  await within(
    Services.profiler.StartProfiler(1024, 1, ["js"], ["GeckoMain"]),
    10_000,
    "the profiler's own start"
  );
  await within(
    TestUtils.waitForCondition(() => !Services.profiler.IsActive()),
    10_000,
    "the recording stopping"
  );
  Assert.equal(await SvalProfiler.save(), null, "nothing is saved");
  Assert.deepEqual(await IOUtils.getChildren(dir), [], "no file was written");
});

add_task(async function a_private_window_opening_stops_logging_to_a_file() {
  const file = PathUtils.join(await makeTempDir("sval-logging"), "log.txt");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["logging.config.LOG_FILE", file],
      ["logging.config.running", true],
      ["logging.SvalTestModule", 5],
    ],
  });
  await openPrivateWindow();
  Assert.ok(
    !Services.prefs.prefHasUserValue("logging.config.LOG_FILE"),
    "the log file is put back to none"
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue("logging.SvalTestModule"),
    "the module logs at its default level"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("logging.config.running"),
    "and about:logging reads that logging has stopped"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_private_window_holds_the_diagnostic_pages() {
  const win = await openPrivateWindow();
  const held = doc => doc.querySelectorAll("[data-sval-private-hold]");
  // In this window, which stays open: with a string alone, the tab opens in
  // the window used last, the private one.
  const aboutPage = url => ({ gBrowser, url });
  // about:logging writes the output it shows as it loads
  // (`updateLoggingOutputType`).
  atTaskEnd(() => Services.prefs.clearUserPref("logging.config.output_type"));

  await BrowserTestUtils.withNewTab(
    aboutPage("about:logging"),
    async browser => {
      const doc = browser.contentDocument;
      const toggle = doc.getElementById("toggle-logging-button");
      await within(
        TestUtils.waitForCondition(() => toggle.disabled),
        10_000,
        "about:logging's start button being held"
      );
      toggle.click();
      Assert.ok(
        !Services.prefs.getBoolPref("logging.config.running", false),
        "a press starts no logging"
      );
      Assert.ok(
        doc.getElementById("set-log-file-button").disabled,
        "no log file can be set"
      );
      Assert.ok(
        doc.getElementById("set-log-modules-button").disabled,
        "and no log modules"
      );
    }
  );

  await BrowserTestUtils.withNewTab(
    aboutPage("about:memory"),
    async browser => {
      const doc = browser.contentDocument;
      await within(
        TestUtils.waitForCondition(() => held(doc).length === 3),
        10_000,
        "about:memory's save buttons being held"
      );
      for (const id of ["saveLogsConcise", "saveLogsVerbose"]) {
        Assert.ok(doc.getElementById(id).disabled, `${id} is disabled`);
      }
      Assert.ok(
        !doc.getElementById("measureButton").disabled,
        "measuring on the page stays"
      );

      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the private window closing"
      );
      await within(
        TestUtils.waitForCondition(() => !held(doc).length),
        10_000,
        "the save buttons coming back"
      );
      Assert.ok(
        !doc.getElementById("saveLogsConcise").disabled,
        "saving is offered again"
      );
    }
  );
});
