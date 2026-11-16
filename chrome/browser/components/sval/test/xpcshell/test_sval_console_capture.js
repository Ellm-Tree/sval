/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Browser code's warnings and errors reach Sval's log file (feedback spec
 * §3.7): once each, marked `console`, with their file and line, and with
 * every address, path and host taken out.
 */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { SvalLog, SVAL_LOG_FILE, _SvalLogFileForTests, startConsoleCapture } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLog.sys.mjs"
  );

const MARKERS = [
  "https://url-marker.example/page",
  "host-marker.example.com",
  "/Users/path-marker/Documents",
];

let dir;

add_setup(async () => {
  do_get_profile();
  dir = await makeTempDir("sval-console-capture");
  _SvalLogFileForTests.use(dir);
  registerCleanupFunction(async () => {
    await _SvalLogFileForTests.written();
    _SvalLogFileForTests.use(null);
  });
  startConsoleCapture();
});

async function logText() {
  await _SvalLogFileForTests.written();
  return IOUtils.readUTF8(PathUtils.join(dir, SVAL_LOG_FILE)).catch(() => "");
}

/**
 * Waits until the log holds `text`, which the console hands over async.
 *
 * @param {string} text
 * @returns {Promise<string>} The log.
 */
async function untilLogged(text) {
  await within(
    (async () => {
      while (!(await logText()).includes(text)) {
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
    })(),
    10_000,
    `the log line holding ${text}`
  );
  return logText();
}

add_task(async function an_uncaught_error_reaches_the_log() {
  // Browser code is a system-principal script with a privileged address; the
  // engine reports its uncaught error as chrome JavaScript, from that file.
  const browserCode = Cu.Sandbox(
    Services.scriptSecurityManager.getSystemPrincipal()
  );
  browserCode.Services = Services;
  browserCode.markers = MARKERS.join(" ");
  Cu.evalInSandbox(
    "Services.tm.dispatchToMainThread(() => {\n" +
      "  throw new Error(`uncaught-marker ${markers}`);\n" +
      "});",
    browserCode,
    null,
    "resource://sval-test/BrowserCode.sys.mjs",
    1
  );
  const text = await untilLogged("uncaught-marker");
  const lines = text.split("\n").filter(l => l.includes("uncaught-marker"));
  Assert.equal(lines.length, 1, "once");
  Assert.ok(/ error console: /.test(lines[0]), "marked console, as an error");
  Assert.ok(
    /\(BrowserCode\.sys\.mjs:2\)$/.test(lines[0]),
    "with its file and line"
  );
  for (const marker of MARKERS) {
    Assert.ok(!lines[0].includes(marker), `without ${marker}`);
  }
});

add_task(async function a_console_warning_reaches_the_log() {
  console.warn(`warn-marker ${MARKERS.join(" ")}`);
  const text = await untilLogged("warn-marker");
  const lines = text.split("\n").filter(l => l.includes("warn-marker"));
  Assert.equal(lines.length, 1, "once");
  Assert.ok(/ warn console: /.test(lines[0]), "marked console, as a warning");
  for (const marker of MARKERS) {
    Assert.ok(!lines[0].includes(marker), `without ${marker}`);
  }
});

add_task(async function sval_lines_are_not_kept_twice() {
  SvalLog.warn("own-marker");
  console.warn("after-own-marker");
  const text = await untilLogged("after-own-marker");
  const lines = text.split("\n").filter(l => /own-marker$/.test(l));
  Assert.equal(lines.length, 1, "SvalLog's own line is in the file once");
  Assert.ok(lines[0].includes(" warn sval: "), "marked as Sval's");
});

add_task(async function a_private_window_error_is_not_kept() {
  const report = (text, fromPrivateWindow) => {
    const error = Cc["@mozilla.org/scripterror;1"].createInstance(
      Ci.nsIScriptError
    );
    error.init(
      text,
      "resource://sval-test/BrowserCode.sys.mjs",
      7,
      0,
      Ci.nsIScriptError.errorFlag,
      "chrome javascript",
      fromPrivateWindow,
      true
    );
    Services.console.logMessage(error);
  };
  report("private-window-marker", true);
  report("public-after-private-marker", false);
  // The console hands messages over in order, so once the later one is in
  // the log the private one has been passed over.
  const log = await untilLogged("public-after-private-marker");
  Assert.ok(
    !log.includes("private-window-marker"),
    "an error from a private window stays out of the log"
  );
});
