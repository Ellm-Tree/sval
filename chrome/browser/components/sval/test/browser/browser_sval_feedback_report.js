/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Send Feedback's report (feedback spec §3 to §5): what the user views is
 * what is posted, an unticked part stays home, settings and crash
 * annotations keep only what the rules allow, and a failed send says why.
 */

"use strict";

const { SvalFeedback, REPORT_URL_PREF, MAX_BYTES, CHANGED, CRASH_WARNING } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFeedback.sys.mjs"
  );
const { SvalLog, _SvalLogFileForTests } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { CrashReports } = ChromeUtils.importESModule(
  "resource://gre/modules/CrashReports.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const CRASH_ID = "0b0b0b0b-1111-4222-8333-444444444444";
const SENT_ID = "bp-5c5c5c5c-1111-4222-8333-444444444444";
const URL_MARKER = "https://url-marker.example/private";
const HOME_MARKER = "https://home-marker.example/";

let server;
let received = [];
let answer = { status: 200, body: '{"reference":"F-0042"}' };

/**
 * A UTF-8 string as the bytes the server reads, one char per byte.
 *
 * @param {string} text
 * @returns {string}
 */
function asBytes(text) {
  return Array.from(new TextEncoder().encode(text), b =>
    String.fromCharCode(b)
  ).join("");
}

function bytesOf(array) {
  let out = "";
  for (const b of array) {
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * The parts of a multipart body, each `{ name, filename, body }`.
 *
 * @param {{ type: string, body: string }} request
 * @returns {object[]}
 */
function partsOf(request) {
  const boundary = /boundary=(.+)$/.exec(request.type)[1];
  return request.body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(chunk => {
      const end = chunk.indexOf("\r\n\r\n");
      const head = chunk.slice(2, end);
      return {
        name: /name="([^"]*)"/.exec(head)[1],
        filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
        body: chunk.slice(end + 4, -2),
      };
    });
}

/** A minidump holding one module, at a path that names its user. */
function minidump() {
  const path = "/Users/someone-private/Sval.app/Contents/MacOS/XUL";
  const name = new Uint8Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    name[i * 2] = path.charCodeAt(i);
  }
  const nameAt = 32 + 12 + 4 + 108;
  const bytes = new Uint8Array(nameAt + 4 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x504d444d, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 32, true);
  view.setUint32(32, 4, true);
  view.setUint32(36, 4 + 108, true);
  view.setUint32(40, 44, true);
  view.setUint32(44, 1, true);
  view.setUint32(44 + 4 + 20, nameAt, true);
  view.setUint32(nameAt, name.length, true);
  bytes.set(name, nameAt + 4);
  return bytes;
}

add_setup(async function () {
  // CrashReports reads the folders it was given; pointing them at a test's
  // own keeps the profile's real crash files out of the test and its files
  // out of them.
  const pending = await makeTempDir("sval-feedback-pending");
  const submitted = await makeTempDir("sval-feedback-submitted");
  const { pendingDir, submittedDir } = CrashReports;
  CrashReports.pendingDir = await IOUtils.getFile(pending);
  CrashReports.submittedDir = await IOUtils.getFile(submitted);
  registerCleanupFunction(() => {
    CrashReports.pendingDir = pendingDir;
    CrashReports.submittedDir = submittedDir;
  });
  await IOUtils.write(PathUtils.join(pending, `${CRASH_ID}.dmp`), minidump());
  await IOUtils.writeJSON(PathUtils.join(pending, `${CRASH_ID}.extra`), {
    ProductName: "Sval",
    BuildID: Services.appinfo.appBuildID,
    ProcessType: "content",
    URL: URL_MARKER,
    Email: "someone@email-marker.example",
    Comments: "comment-marker",
    ServerURL: "https://server-marker.example/submit",
  });
  await IOUtils.writeUTF8(PathUtils.join(submitted, `${SENT_ID}.txt`), "sent");

  const logDir = await makeTempDir("sval-feedback-log");
  _SvalLogFileForTests.use(logDir);
  registerCleanupFunction(async () => {
    await _SvalLogFileForTests.written();
    _SvalLogFileForTests.use(null);
  });
  SvalLog.warn("feedback-log-line");
  await _SvalLogFileForTests.written();

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.startup.homepage", HOME_MARKER],
      ["browser.sval.adblock.level", "strict"],
      ["browser.sval.protection.site.site-marker.example", true],
      [
        "browser.sval.extensions.offOn.extension-site-marker.example",
        '["marker@extensions.example"]',
      ],
    ],
  });
  server = new HttpServer();
  server.registerPathHandler("/report", (request, response) => {
    received.push({
      type: request.getHeader("Content-Type"),
      agent: request.getHeader("User-Agent"),
      cookie: request.hasHeader("Cookie"),
      referer: request.hasHeader("Referer"),
      origin: request.hasHeader("Origin"),
      body: NetUtil.readInputStreamToString(
        request.bodyInputStream,
        request.bodyInputStream.available()
      ),
    });
    response.setStatusLine(request.httpVersion, answer.status, "");
    response.write(answer.body);
  });
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        REPORT_URL_PREF,
        `http://localhost:${server.identity.primaryPort}/report`,
      ],
    ],
  });
});

function everything(report) {
  return new Set(report.parts.map(part => part.id));
}

async function sendAll(report, checked = everything(report)) {
  received = [];
  const result = await SvalFeedback.send(report, {
    description: "Sync stopped after I moved my folder.",
    email: "",
    checked,
  });
  Assert.equal(received.length, 1, "one request reached the server");
  return { result, request: received[0], parts: partsOf(received[0]) };
}

add_task(async function the_preview_is_the_post() {
  const report = await SvalFeedback.collect({ context: "Import failed" });
  const ids = report.parts.map(part => part.id);
  Assert.deepEqual(
    ids.slice(0, 6),
    ["about", "log", "state", "prefs", "extensions", "graphics"],
    "the parts are in display order"
  );
  Assert.ok(ids.includes("crashes"), "a recent crash lists the crashes");
  Assert.ok(ids.includes(`crash:${CRASH_ID}`), "and offers its file");

  const views = new Map();
  for (const part of report.parts) {
    views.set(part.id, await part.view());
  }
  const { result, request, parts } = await sendAll(report);
  Assert.deepEqual(result, { ok: true, reference: "F-0042" }, "it was sent");
  Assert.equal(request.agent, `Sval/${Services.appinfo.version}`, "as Sval");
  Assert.ok(!request.cookie && !request.referer, "with no cookie or Referer");
  Assert.ok(
    !request.origin,
    "with no Origin, which the collector takes for a web page's post"
  );

  const byName = name => parts.filter(part => part.name === name);
  Assert.equal(byName("context")[0].body, "Import failed", "the context");
  Assert.equal(byName("log")[0].filename, "log.txt");
  Assert.equal(
    byName("log")[0].body,
    asBytes(views.get("log").text),
    "the log posted is the log viewed, byte for byte"
  );
  Assert.ok(
    views.get("log").text.includes("feedback-log-line"),
    "and holds Sval's log"
  );

  const json = byName("report")[0].body;
  Assert.ok(
    json.startsWith(asBytes(views.get("about").text.slice(0, -2))),
    "report.json opens with the always-sent part as viewed"
  );
  for (const id of ["state", "prefs", "extensions", "graphics", "crashes"]) {
    Assert.ok(
      json.includes(asBytes(views.get(id).text)),
      `report.json holds ${id} as viewed`
    );
  }
  const parsed = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(json, c => c.charCodeAt(0)))
  );
  Assert.equal(parsed.product, "Sval", "the collector's product");
  Assert.ok(/^\d{14}$/.test(parsed.build.buildID), "and a build id");
  Assert.equal(typeof parsed.build.version, "string", "and a version");

  const crash = views.get(`crash:${CRASH_ID}`);
  const files = byName("file");
  Assert.deepEqual(
    files.map(f => f.filename),
    [`${CRASH_ID}.dmp`, `${CRASH_ID}.extra.json`],
    "a ticked crash sends its minidump and its annotations"
  );
  Assert.equal(files[0].body, bytesOf(minidump()), "the minidump as on disk");
  Assert.equal(
    files[1].body,
    asBytes(crash.annotations),
    "annotations as viewed"
  );
  Assert.deepEqual(crash.libraries, ["XUL"], "View names the library alone");
  Assert.equal(crash.processType, "content", "and the process");

  const boundary = /boundary=(.+)$/.exec(request.type)[1];
  const description =
    `--${boundary}\r\nContent-Disposition: form-data; name="description"` +
    "\r\n\r\nSync stopped after I moved my folder.\r\n";
  Assert.equal(
    SvalFeedback.totalSize(report, everything(report)),
    request.body.length - description.length,
    "the size shown is the size posted, beside the description"
  );
});

add_task(async function an_unticked_part_is_not_sent() {
  const report = await SvalFeedback.collect();
  for (const part of report.parts) {
    if (part.locked || part.sent) {
      continue;
    }
    const checked = everything(report);
    checked.delete(part.id);
    const { request } = await sendAll(report, checked);
    const view = await part.view();
    const absent =
      view.kind === "text"
        ? asBytes(view.text)
        : `filename="${part.id.slice("crash:".length)}.dmp"`;
    if (view.kind === "text" && !view.text) {
      continue;
    }
    Assert.ok(!request.body.includes(absent), `${part.id} stays home unticked`);
  }
});

add_task(async function the_value_rule() {
  const report = await SvalFeedback.collect();
  const prefs = JSON.parse(
    (await report.parts.find(p => p.id === "prefs").view()).text
  );
  Assert.equal(
    prefs["browser.startup.homepage"],
    CHANGED,
    "a URL is held back"
  );
  Assert.equal(
    prefs["browser.sval.adblock.level"],
    "strict",
    "a level is kept"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage", "host-marker.example"]],
  });
  const bare = JSON.parse(
    (
      await (await SvalFeedback.collect()).parts
        .find(p => p.id === "prefs")
        .view()
    ).text
  );
  Assert.equal(
    bare["browser.startup.homepage"],
    CHANGED,
    "a host name with no scheme is held back"
  );
  await SpecialPowers.popPrefEnv();
  Assert.ok(
    !Object.keys(prefs).some(name => name.includes("site-marker")),
    "a setting named for a site is not named"
  );
  const state = JSON.parse(
    (await report.parts.find(p => p.id === "state").view()).text
  );
  Assert.equal(
    state.protections.sitesWithChoices.switches,
    1,
    "the sites with an extension switch are counted instead"
  );
});

add_task(async function a_crash_files_annotations() {
  const report = await SvalFeedback.collect();
  const part = report.parts.find(p => p.id === `crash:${CRASH_ID}`);
  Assert.ok(!part.checked && !part.tooLarge, "off by default, and sendable");
  Assert.equal(part.warning, CRASH_WARNING, "with its warning");
  const annotations = JSON.parse((await part.view()).annotations);
  for (const key of ["URL", "Email", "Comments", "ServerURL"]) {
    Assert.ok(!(key in annotations), `${key} is left out`);
  }
  for (const key of ["ProductName", "BuildID", "ProcessType"]) {
    Assert.ok(key in annotations, `${key}, on Gecko's list, is kept`);
  }
  const sent = report.parts.find(p => p.id === `crash:${SENT_ID}`);
  Assert.ok(sent.sent, "a crash sent from a dialog says so");
  Assert.less(part.size, MAX_BYTES, "a small crash file is not too large");
});

add_task(async function a_failed_send_says_why() {
  const report = await SvalFeedback.collect();
  const checked = new Set();
  const send = options =>
    SvalFeedback.send(
      report,
      { description: "It broke when I did it.", checked },
      options
    );

  answer = { status: 500, body: "" };
  Assert.deepEqual(await send(), { ok: false, cause: "server", status: 500 });
  answer = { status: 502, body: "" };
  Assert.deepEqual(await send(), { ok: false, cause: "server", status: 502 });
  answer = { status: 429, body: "" };
  Assert.deepEqual(await send(), { ok: false, cause: "rejected", status: 429 });
  answer = { status: 400, body: "" };
  Assert.deepEqual(await send(), { ok: false, cause: "rejected", status: 400 });
  answer = { status: 200, body: '{"reference":"F-0042"}' };

  const aborted = new AbortController();
  aborted.abort();
  Assert.deepEqual(await send({ signal: aborted.signal }), {
    ok: false,
    cause: "aborted",
  });

  const closed = new HttpServer();
  closed.start(-1);
  const port = closed.identity.primaryPort;
  await new Promise(resolve => closed.stop(resolve));
  await SpecialPowers.pushPrefEnv({
    set: [[REPORT_URL_PREF, `http://localhost:${port}/report`]],
  });
  Assert.deepEqual(await within(send(), 10_000, "a refused connection"), {
    ok: false,
    cause: "unreachable",
  });
  await SpecialPowers.popPrefEnv();

  // Offline Gecko still reaches localhost unless told not to; the collector
  // is never local, so the test server is held to the same.
  await SpecialPowers.pushPrefEnv({
    set: [["network.disable-localhost-when-offline", true]],
  });
  Services.io.offline = true;
  try {
    Assert.deepEqual(await send(), { ok: false, cause: "offline" });
  } finally {
    Services.io.offline = false;
    await SpecialPowers.popPrefEnv();
  }
});
