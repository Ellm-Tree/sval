/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Nothing private leaves in a feedback report (feedback spec §9): a profile
 * holding a named workspace, an open page, a device name and a home page,
 * with browser code that has thrown and warned about addresses, builds a
 * report in which none of them appears. Browser code's errors, in the parent
 * and in a content process, reach the report's log once each, marked
 * `console`, with their file and line.
 */

"use strict";

const { SvalFeedback } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFeedback.sys.mjs"
);
const { _SvalLogFileForTests } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

/** What the profile holds that a report must not carry. */
const PROFILE_MARKERS = {
  workspace: "workspace-marker",
  title: "title-marker",
  device: "device-marker",
  home: "https://home-marker.example/start",
};

/**
 * What browser code's messages name: an address, a host and a file path,
 * which the log's scrubbing takes out.
 */
const MESSAGE_MARKERS = [
  "https://url-marker.example/page",
  "host-marker.example.com",
  "/Users/someone/Dropbox/folder-marker",
];

async function logHolds(text) {
  const report = await SvalFeedback.collect();
  return (await report.parts.find(p => p.id === "log").view()).text.includes(
    text
  );
}

/**
 * Waits until the report's log holds `text`; the console hands it over async.
 *
 * @param {string} text
 */
async function untilInLog(text) {
  await within(
    TestUtils.waitForCondition(() => logHolds(text), `the log holds ${text}`),
    30_000,
    `the log line holding ${text}`
  );
}

add_setup(async function () {
  // CrashReports reads the folders it was given; empty temporary ones keep
  // the user's own crash files out of the report this test builds.
  const { CrashReports } = ChromeUtils.importESModule(
    "resource://gre/modules/CrashReports.sys.mjs"
  );
  const { pendingDir, submittedDir } = CrashReports;
  CrashReports.pendingDir = await IOUtils.getFile(
    await makeTempDir("sval-feedback-private-pending")
  );
  CrashReports.submittedDir = await IOUtils.getFile(
    await makeTempDir("sval-feedback-private-submitted")
  );
  registerCleanupFunction(() => {
    CrashReports.pendingDir = pendingDir;
    CrashReports.submittedDir = submittedDir;
  });
  const logDir = await makeTempDir("sval-feedback-private-log");
  _SvalLogFileForTests.use(logDir);
  registerCleanupFunction(async () => {
    await _SvalLogFileForTests.written();
    _SvalLogFileForTests.use(null);
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.startup.homepage", PROFILE_MARKERS.home],
      ["browser.sval.device.name", PROFILE_MARKERS.device],
    ],
  });
});

add_task(async function nothing_private_leaves() {
  const server = new HttpServer();
  server.registerPathHandler("/url-marker", (request, response) => {
    response.setHeader("Content-Type", "text/html", false);
    response.write(
      `<title>${PROFILE_MARKERS.title}</title>` +
        '<script>console.warn("page-console-marker");' +
        'setTimeout(() => { throw new Error("page-throw-marker"); });</script>'
    );
  });
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
  const pageURL = `http://localhost:${server.identity.primaryPort}/url-marker`;

  await SvalPanel.engine.mutate({
    kind: "rename",
    id: SvalPanel.workspaceId,
    name: PROFILE_MARKERS.workspace,
    now: Date.now(),
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, pageURL),
    10_000,
    "the marked page"
  );

  const said = MESSAGE_MARKERS.join(" ");
  const browserCode = Cu.Sandbox(
    Services.scriptSecurityManager.getSystemPrincipal()
  );
  browserCode.said = said;
  browserCode.Services = Services;
  browserCode.console = console;
  Cu.evalInSandbox(
    "Services.tm.dispatchToMainThread(() => {\n" +
      "  throw new Error(`parent-throw ${said}`);\n" +
      "});\n" +
      "console.warn(`parent-warn ${said}`);",
    browserCode,
    null,
    "resource:///modules/BrowserCode.sys.mjs",
    1
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [said], words => {
    Services.tm.dispatchToMainThread(() => {
      throw new Error(`content-throw ${words}`);
    });
  });
  for (const mark of ["parent-throw", "parent-warn", "content-throw"]) {
    await untilInLog(mark);
  }

  const report = await SvalFeedback.collect({ context: "Sync is off" });
  const texts = [];
  for (const part of report.parts) {
    const view = await part.view();
    texts.push(part.title, part.description, view.text ?? "");
    texts.push(view.annotations ?? "", ...(view.libraries ?? []));
  }
  const everything = texts.join("\n");
  for (const marker of [
    ...Object.values(PROFILE_MARKERS),
    pageURL,
    ...MESSAGE_MARKERS,
    "page-console-marker",
    "page-throw-marker",
  ]) {
    Assert.ok(!everything.includes(marker), `the report holds no ${marker}`);
  }

  const log = (await report.parts.find(p => p.id === "log").view()).text;
  const linesWith = mark => log.split("\n").filter(l => l.includes(mark));
  for (const [mark, level, file] of [
    ["parent-throw", "error", /\(BrowserCode\.sys\.mjs:2\)$/],
    ["parent-warn", "warn", /\(BrowserCode\.sys\.mjs:4\)$/],
    ["content-throw", "error", /\([^ ()]+:\d+\)$/],
  ]) {
    const lines = linesWith(mark);
    Assert.equal(lines.length, 1, `${mark} is in the log once`);
    Assert.ok(
      lines[0].includes(` ${level} console: `),
      `${mark} is marked console, as ${level}`
    );
    Assert.ok(file.test(lines[0]), `${mark} names its file and line`);
  }

  BrowserTestUtils.removeTab(tab);
});
