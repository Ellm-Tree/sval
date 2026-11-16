/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's console: one instance, one prefix, and a level that follows a pref.
 *
 * The second half of this file is a guard rather than a test of behaviour: it
 * reads Sval's own source and fails on a logging call site that would carry
 * what the user is browsing into a console. See
 * {@link no_log_line_can_name_what_the_user_is_browsing} for why that is
 * written as a source read.
 */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const {
  SvalLog,
  SVAL_LOG_LEVEL_PREF,
  SVAL_LOG_PREFIX,
  svalLogLevel,
  describeError,
  SVAL_LOG_FILE,
  SVAL_LOG_FILE_OLD,
  _SvalLogFileForTests,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

/**
 * Every console event Sval produces while `run` runs.
 *
 * A `ConsoleInstance`'s level filtering happens before the event is created, so
 * "did this line survive the level" and "what prefix is on it" are both read
 * from here: the instance exposes neither.
 *
 * @param {Function} run What to do while listening.
 * @returns {Promise<object[]>} the events, in order.
 */
async function recorded(run) {
  const events = [];
  const observe = message => {
    if (message.prefix === SVAL_LOG_PREFIX) {
      events.push(message);
    }
  };
  ConsoleAPIStorage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  try {
    await run();
    // `ConsoleAPIStorage` delivers on the next tick.
    await TestUtils.waitForTick();
  } finally {
    ConsoleAPIStorage.removeLogEventListener(observe);
  }
  return events;
}

add_task(function the_module_exports_one_instance() {
  const again = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLog.sys.mjs"
  );
  Assert.ok(
    Object.is(again.SvalLog, SvalLog),
    "a second import is the same console, so the prefix and the level are " +
      "decided in one place"
  );
  for (const method of ["error", "warn", "info", "debug", "shouldLog"]) {
    Assert.equal(
      typeof SvalLog[method],
      "function",
      `and it carries ${method}`
    );
  }
});

/** A rejection need not be an Error, and its name is never "undefined". */
add_task(function an_error_name_is_always_a_name() {
  Assert.equal(SvalLog.errorName(new TypeError("x")), "TypeError");
  Assert.equal(
    SvalLog.errorName(new DOMException("x", "AbortError")),
    "AbortError"
  );
  for (const value of ["a string", undefined, null, {}, { name: "" }, 3]) {
    Assert.equal(SvalLog.errorName(value), "Error", `for ${String(value)}`);
  }
});

add_task(async function every_line_carries_the_prefix_from_the_instance() {
  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Warn");
  const events = await recorded(() => SvalLog.warn("a line"));
  Assert.equal(events.length, 1, "the line was logged");
  Assert.equal(
    events[0].prefix,
    "sval",
    "with the prefix the platform adds, not one written into the message"
  );
  Assert.equal(
    String(events[0].arguments[0]),
    "a line",
    "so no message hand-writes `sval: ` of its own"
  );
});

add_task(async function the_level_follows_the_pref() {
  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Warn");
  Assert.equal(svalLogLevel(), "Warn", "the level a worker would be handed");
  Assert.ok(SvalLog.shouldLog("Error"), "errors are logged at Warn");
  Assert.ok(SvalLog.shouldLog("Warn"), "and warnings are");
  Assert.ok(!SvalLog.shouldLog("Info"), "info is not");
  Assert.ok(!SvalLog.shouldLog("Debug"), "and neither is debug");

  let events = await recorded(() => {
    SvalLog.debug("quiet");
    SvalLog.info("quiet");
  });
  Assert.deepEqual(
    events.map(event => String(event.arguments[0])),
    [],
    "so nothing below Warn reaches the console at the shipped default"
  );

  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Debug");
  Assert.equal(svalLogLevel(), "Debug");
  Assert.ok(
    SvalLog.shouldLog("Debug"),
    "turning the pref up is the whole of it"
  );

  events = await recorded(() => SvalLog.debug("loud"));
  Assert.deepEqual(
    events.map(event => String(event.arguments[0])),
    ["loud"],
    "and the same instance now logs it — no restart, no second instance"
  );

  Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);
  Assert.equal(
    svalLogLevel(),
    "Warn",
    "the shipped default is Warn, so sval is quiet for anyone who has not asked"
  );
});

/**
 * The warnings and errors a session printed, kept in the profile: a failure
 * is still there to read after the console that showed it is gone.
 *
 * @param {Function} run What to log, with the file written to a directory of
 *   the test's own.
 * @param {number} [cap] The size the file rotates at.
 * @returns {Promise<{dir: string, text: string}>} the directory and the
 *   file's text.
 */
async function keptInFile(run, cap) {
  const dir = await makeTempDir("sval-log-file");
  _SvalLogFileForTests.use(dir, cap);
  try {
    await run();
    await _SvalLogFileForTests.written();
  } finally {
    _SvalLogFileForTests.use(null);
  }
  const path = PathUtils.join(dir, SVAL_LOG_FILE);
  const text = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : "";
  return { dir, text };
}

add_task(async function warnings_and_errors_are_kept_in_the_profile() {
  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Debug");
  const { text } = await keptInFile(() => {
    SvalLog.debug("a pass ran");
    SvalLog.info("a key adopted");
    SvalLog.warn("a peer file would not parse");
    SvalLog.error("the panel failed to start: TypeError: x is null");
  });
  Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);
  const kept = text.trimEnd().split("\n");
  Assert.equal(kept.length, 2, `two lines are kept: ${text}`);
  Assert.ok(
    /^\d{4}-\d\d-\d\dT[\d:.]+Z warn sval: a peer file would not parse$/.test(
      kept[0]
    ),
    `the warning, when it was logged: ${kept[0]}`
  );
  Assert.ok(
    kept[1].endsWith(
      " error sval: the panel failed to start: TypeError: x is null"
    ),
    `and the error as the console printed it: ${kept[1]}`
  );
});

add_task(async function warnings_are_kept_whatever_the_console_shows() {
  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Off");
  const { text } = await keptInFile(() => SvalLog.warn("kept"));
  Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);
  Assert.stringContains(text, "warn sval: kept");
});

add_task(async function a_full_file_makes_way_for_new_lines() {
  const line = "x".repeat(100);
  const { dir, text } = await keptInFile(async () => {
    for (let i = 0; i < 10; i++) {
      SvalLog.warn(`${i} ${line}`);
      // One batch each, so the cap is checked line by line.
      await _SvalLogFileForTests.written();
    }
  }, 600);
  const old = await IOUtils.readUTF8(PathUtils.join(dir, SVAL_LOG_FILE_OLD));
  Assert.lessOrEqual(text.length, 600, "the file stays within its cap");
  Assert.lessOrEqual(old.length, 600, "and so does the one before it");
  Assert.stringContains(text, `9 ${line}`, "the newest line is kept");
  Assert.ok(
    !old.includes(`0 ${line}`) && !text.includes(`0 ${line}`),
    "and the oldest has gone"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(dir))
      .map(path => PathUtils.filename(path))
      .sort(),
    [SVAL_LOG_FILE_OLD, SVAL_LOG_FILE].sort(),
    "two files at most"
  );
});

add_task(async function the_file_names_no_address() {
  const err = new TypeError(
    "NetworkError when fetching https://example.com/path?q=1 from " +
      "moz-extension://0a1b/page.html for news.example.co.uk"
  );
  const { text } = await keptInFile(() =>
    SvalLog.error(`a fetch failed: ${describeError(err)}`)
  );
  Assert.ok(
    !/example|0a1b|https/.test(text),
    `no URL or host is kept: ${text}`
  );
  Assert.stringContains(
    text,
    "error sval: a fetch failed: TypeError: NetworkError when fetching <url> " +
      "from <url> for <host>",
    "and the rest of the line is"
  );
});

add_task(async function one_call_is_one_line() {
  const { text } = await keptInFile(() =>
    SvalLog.warn("first\r\n2026-01-01T00:00:00.000Z error sval: forged")
  );
  Assert.equal(text.split("\n").length, 2, `one line and its end: ${text}`);
  Assert.stringContains(text, "warn sval: first  2026-01-01T00");
});

add_task(async function a_file_that_cannot_be_written_is_no_failure() {
  // A file where the directory should be, so every write fails.
  const notADir = tempPath("sval-log-blocked");
  await IOUtils.writeUTF8(notADir, "");
  _SvalLogFileForTests.use(notADir);
  let events;
  try {
    events = await recorded(async () => {
      SvalLog.error("the panel failed to start");
      await _SvalLogFileForTests.written();
    });
  } finally {
    _SvalLogFileForTests.use(null);
  }
  Assert.deepEqual(
    events.map(event => String(event.arguments[0])),
    ["the panel failed to start"],
    "the line reaches the console, and the failed write logs nothing of its own"
  );
});

/**
 * Every line `run` logged, as text, whatever level it was at.
 *
 * @param {Function} run What to do while listening.
 * @returns {Promise<string[]>} one string per line.
 */
async function lines(run) {
  const events = await recorded(run);
  return events.map(event =>
    Array.from(event.arguments ?? [])
      .map(argument => String(argument))
      .join(" ")
  );
}

add_task(async function a_pass_says_what_it_decided_but_only_at_debug() {
  const root = await makeTempDir("sval-log");

  const keyBytes = new Uint8Array(32);
  const deviceId = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  crypto.getRandomValues(deviceId);
  const engine = new SvalEngine({ root, keyBytes, deviceId });

  try {
    // The first pass has no file of this device's in the folder, so it
    // publishes. The second finds the document unchanged and writes nothing,
    // which is the outcome someone following a sync problem most needs told:
    // "nothing happened" and "nothing needed to happen" look identical from
    // the outside.
    Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Warn");
    let logged = await lines(() => engine.sync("workspace-under-test", 1000));
    Assert.deepEqual(
      logged,
      [],
      "a pass at the shipped default says nothing at all"
    );

    Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Debug");
    logged = await lines(() => engine.sync("workspace-under-test", 2000));
    Assert.ok(
      logged.some(text => text.includes("nothing to write")),
      `and at Debug it says a pass wrote nothing: ${JSON.stringify(logged)}`
    );
  } finally {
    engine.terminate();
    Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  }
});

/**
 * The pass line counts the nodes repair reparented, read from the report's
 * `repairedIds`. A tab filed under a group another device deleted at the
 * same time is the ordinary way one arises (spec §5.2).
 */
add_task(async function a_pass_counts_the_nodes_it_repaired() {
  const root = await makeTempDir("sval-log");
  const DOC = "workspace-under-test";
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const device = () => crypto.getRandomValues(new Uint8Array(16));
  const deleting = new SvalEngine({ root, keyBytes, deviceId: device() });
  const filing = new SvalEngine({ root, keyBytes, deviceId: device() });

  try {
    const workspace = await deleting.mutate({
      kind: "addWorkspace",
      name: "W",
      now: 100,
    });
    const group = await deleting.mutate({
      kind: "addGroup",
      parent: workspace,
      name: "G",
      now: 100,
    });
    await deleting.sync(DOC, 1000);
    await filing.sync(DOC, 2000);
    await deleting.mutate({ kind: "remove", id: group });
    await deleting.sync(DOC, 3000);
    await filing.mutate({
      kind: "addTab",
      parent: group,
      name: "T",
      url: "https://example.com/",
      now: 3500,
    });

    Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Debug");
    const logged = await lines(() => filing.sync(DOC, 4000));
    Assert.ok(
      logged.some(text => text.includes("1 nodes repaired")),
      `the pass counts the repaired tab: ${JSON.stringify(logged)}`
    );
  } finally {
    deleting.terminate();
    filing.terminate();
    Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  }
});

// ---------------------------------------------------------------- the guard

/**
 * Where Sval's own scripts ship, with the names of Sval's among each
 * directory's. `sval_core.mjs` is left out: it is generated glue nobody
 * writes, it logs nothing, and it is not committed.
 */
const SVAL_SCRIPT_DIRS = [
  ["moz-src:///browser/components/sval/", /\.sys\.mjs$/],
  ["chrome://browser/content/sval/", /\.m?js$/],
];

/**
 * Every script Sval ships, at the URL the browser loads it from, read from
 * the directories it ships in, so a script Sval adds is guarded without being
 * named anywhere. A directory that lists none of Sval's scripts fails the
 * guard, so a listing that breaks, or a packaging change that moves Sval's
 * scripts elsewhere, cannot leave it reading nothing.
 *
 * @returns {Promise<string[]>}
 */
async function svalSources() {
  const sources = [];
  for (const [dir, pattern] of SVAL_SCRIPT_DIRS) {
    const names = (await listedIn(dir)).filter(
      name => pattern.test(name) && name !== "sval_core.mjs"
    );
    Assert.greater(names.length, 0, `${dir} lists Sval's scripts`);
    sources.push(...names.map(name => dir + name));
  }
  return sources;
}

/**
 * What a diagnostic may never name, as the identifiers that would carry it.
 *
 * Matched against the segments of an interpolated expression, so `tab.label`,
 * `label`, `node.content.url` and `this._offer.code` are all caught and the
 * same words inside the sentence around them are not: "adopting a key threw"
 * is a fine thing to log and `${keyBytes}` is not.
 */
const FORBIDDEN_IN_A_DIAGNOSTIC = new Set([
  "name",
  "names",
  "title",
  "label",
  "url",
  "urls",
  "href",
  "uri",
  // An nsIURI's text, and what holds one, carry the URL under other names.
  "spec",
  "asciispec",
  "displayspec",
  "prepath",
  "currenturi",
  "documenturi",
  "originaluri",
  "location",
  "origin",
  "site",
  "emoji",
  "icon",
  "favicon",
  "code",
  "key",
  "keybytes",
  "path",
  "paths",
  "root",
  "storageroot",
  "dir",
  "filename",
  "textcontent",
  "innertext",
  "host",
  "hostname",
  "domain",
  "query",
  "search",
  "secret",
  "token",
  "session",
  "sessionlink",
  "cookie",
  "cookies",
  "authorization",
  "nonce",
  "proof",
]);

/**
 * The receivers `.name` is allowed on.
 *
 * An error's name, such as `NotFoundError` or `NS_ERROR_FAILURE`, is much of
 * what makes a failure diagnosable, and it cannot carry anything of the
 * user's. Everything else's `.name` is a workspace, a group or a tab, which is
 * what this guard is for.
 */
const ERRORS = new Set(["err", "error", "e", "ex", "exn", "reason"]);

/**
 * The names an error goes by, which a call site may not interpolate or pass
 * as they are: `${err}` and `SvalLog.warn(text, err)` both print the message.
 */
const BARE_ERRORS = new Set(["err", "error", "ex", "exn"]);

/** The levels a logger call can be at, plus the guard that precedes one. */
const LEVELS = "error|warn|info|debug|log|trace|shouldLog";

/**
 * The text between the parentheses of the call starting at `open`.
 *
 * @param {string} source A whole file.
 * @param {number} open The index of the `(`.
 * @returns {string} what the call was passed, parentheses excluded.
 */
function callArguments(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") {
      depth++;
    } else if (source[i] === ")") {
      depth--;
      if (!depth) {
        return source.slice(open + 1, i);
      }
    }
  }
  return source.slice(open + 1);
}

/**
 * Only the parts of `text` that are evaluated: every interpolated expression,
 * and any argument that is not a string literal at all. The sentences
 * themselves are dropped, because the English around an expression is not what
 * leaks: "adopting a key threw" would otherwise read as logging a key.
 *
 * @param {string} text A call's argument text.
 * @returns {string} the expressions in it, concatenated.
 */
function expressionsIn(text) {
  let out = "";
  // A stack rather than one flag, because a template literal can hold an
  // expression that holds another template literal.
  const stack = [{ kind: "code" }];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const top = stack[stack.length - 1];
    if (top.kind === "single" || top.kind === "double") {
      if (char === "\\") {
        i++;
      } else if (
        (top.kind === "single" && char === "'") ||
        (top.kind === "double" && char === '"')
      ) {
        stack.pop();
      }
      continue;
    }
    if (top.kind === "template") {
      if (char === "\\") {
        i++;
      } else if (char === "`") {
        stack.pop();
      } else if (char === "$" && text[i + 1] === "{") {
        // The space matters: without it two adjacent interpolations
        // concatenate into one identifier and `${tab.label}${err}` reads as
        // `tab.labelerr`, which is in no forbidden list.
        out += " ";
        stack.push({ kind: "code", braces: 0 });
        i++;
      }
      continue;
    }
    // Code.
    if (char === "'") {
      stack.push({ kind: "single" });
    } else if (char === '"') {
      stack.push({ kind: "double" });
    } else if (char === "`") {
      stack.push({ kind: "template" });
    } else if (char === "{" && top.braces !== undefined) {
      top.braces++;
      out += char;
    } else if (char === "}" && top.braces !== undefined) {
      if (!top.braces) {
        out += " ";
        stack.pop();
      } else {
        top.braces--;
        out += char;
      }
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Whatever `expressions` names that a diagnostic may not.
 *
 * @param {string} expressions As {@link expressionsIn} returns.
 * @returns {string[]} the offending expressions, empty when there are none.
 */
function leaksIn(expressions) {
  const found = [];
  const chains = expressions
    .replace(
      /\b(?:describeError|errorName)\s*\(\s*[\w$.?]*\s*\)/g,
      "describeError"
    )
    .matchAll(/[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g);
  for (const [chain] of chains) {
    const segments = chain.split(/\s*\??\.\s*/);
    // An error's message names the file it was about, and so does an error
    // turned into a string. `describeError` and `SvalLog.errorName` are the
    // ways an error is logged.
    if (
      segments.at(-1) === "message" ||
      (segments.length === 1 && BARE_ERRORS.has(segments[0]))
    ) {
      found.push(chain);
      continue;
    }
    for (const [index, segment] of segments.entries()) {
      const lowered = segment.toLowerCase();
      if (!FORBIDDEN_IN_A_DIAGNOSTIC.has(lowered)) {
        continue;
      }
      if (
        lowered === "name" &&
        index > 0 &&
        ERRORS.has(segments[index - 1].toLowerCase())
      ) {
        continue;
      }
      found.push(chain);
      break;
    }
  }
  return found;
}

/**
 * What the guard finds in one file: its bare console calls, and each SvalLog
 * call site with whatever it interpolates that a diagnostic may not carry.
 *
 * @param {string} source A whole file.
 * @param {string} url Where it came from, for the messages.
 * @returns {{bare: string[], sites: {where: string, leaks: string[], emoji: boolean}[]}}
 */
function reviewed(source, url) {
  // A bare `console.error` would walk straight past the rest of this guard,
  // so Sval logging through anything but `SvalLog` is itself the failure.
  // `createInstance` is how `SvalLog` and the worker's own logger are built
  // and is the only `console` reference Sval is allowed.
  const bare = source
    .split("\n")
    .map((line, number) => [line, number + 1])
    .filter(
      ([line]) =>
        !/^\s*(\*|\/\/)/.test(line) &&
        new RegExp(`\\bconsole\\s*\\.\\s*(${LEVELS})\\s*\\(`).test(line)
    )
    .map(([line, number]) => `${url}:${number}: ${line.trim()}`);

  const sites = [];
  const calls = source.matchAll(
    new RegExp(`\\bSvalLog\\s*\\.\\s*(?:${LEVELS})\\s*\\(`, "g")
  );
  for (const call of calls) {
    const open = call.index + call[0].length - 1;
    const text = callArguments(source, open);
    sites.push({
      where: `${url}, ${source.slice(0, call.index).split("\n").length}`,
      leaks: leaksIn(expressionsIn(text)),
      // The sentence as well as the expressions: an emoji in a log line is a
      // workspace's or a group's, and there is nowhere else one could come
      // from.
      emoji: /\p{Extended_Pictographic}/u.test(text),
    });
  }
  return { bare, sites };
}

/**
 * A source-reading test. The property held is about what a future line of
 * Sval may do, and no runtime test can catch a leak nobody has written yet: a
 * test that drives the browser can only assert about the lines that exist. So
 * this one reads Sval's own source, finds every call into {@link SvalLog}, and
 * fails if one interpolates an expression naming a workspace, a group, a tab,
 * a URL, the document key, a pairing code or an emoji.
 *
 * A browser should not be a surveillance instrument (spec §1). A warning or
 * an error is kept in `sval-log.txt` as well as shown in the console, and the
 * file's scrubbing cannot recognise a tab title, so the call site, at any
 * level, is where one is stopped before it reaches a feedback report. Node ids, counts, device ids,
 * error names and error messages say everything a diagnostic needs and none
 * of it is anybody's reading.
 */
add_task(async function no_log_line_can_name_what_the_user_is_browsing() {
  let sites = 0;

  for (const url of await svalSources()) {
    const response = await fetch(url);
    Assert.ok(response.ok, `${url} is where it is expected to be`);
    const source = await response.text();
    Assert.greater(source.length, 0, `${url} is not empty`);

    const review = reviewed(source, url);
    Assert.deepEqual(
      review.bare,
      [],
      `${url} logs through SvalLog, so every line has a level and a prefix`
    );
    for (const site of review.sites) {
      sites++;
      Assert.deepEqual(
        site.leaks,
        [],
        `the diagnostic at ${site.where} names nothing of the user's`
      );
      Assert.ok(
        !site.emoji,
        `and the diagnostic at ${site.where} carries no emoji`
      );
    }
  }

  Assert.greater(
    sites,
    20,
    "and the guard found Sval's logging rather than nothing at all — a " +
      "refactor that hid every call site from it would otherwise pass"
  );
});

/**
 * Secret material is banned as well: an agent's secret, the port file's token,
 * a challenge nonce, a proof, and a Kagi session (its cookie, its Session Link
 * and its authorization header). Any of them in a pasted log would let a
 * reader impersonate Sval or an agent, or replay a handshake.
 */
add_task(function the_guard_bans_secret_material() {
  const call =
    "`a ${secret} b ${this.token} c ${nonce} d ${frame.proof} e ${err?.name} " +
    "f ${sessionLink} g ${cookie.value} h ${headers.authorization}`";
  Assert.deepEqual(leaksIn(expressionsIn(call)), [
    "secret",
    "this.token",
    "nonce",
    "frame.proof",
    "sessionLink",
    "cookie.value",
    "headers.authorization",
  ]);
});

/**
 * The guard over a file written to break it, so a change that stops it
 * matching fails here instead of passing every real file.
 */
add_task(function the_guard_fails_a_call_site_that_logs_a_url() {
  const fixture = [
    "async function load(tab, err) {",
    "  SvalLog.warn(`loading ${tab.linkedBrowser.currentURI.spec} failed`);",
    "  SvalLog.debug(`restoring ${node.content.url}`);",
    "  SvalLog.error(`tab ${tab.id} failed: ${err.name}`);",
    "  SvalLog.info(`moved to 🦊`);",
    '  console.error("restore failed", err);',
    "  // console.warn(`a comment is not a call`);",
    "}",
  ].join("\n");
  const review = reviewed(fixture, "fixture.js");
  Assert.deepEqual(
    review.sites.map(site => site.leaks),
    [["tab.linkedBrowser.currentURI.spec"], ["node.content.url"], [], []],
    "a URL is caught however it is reached, and an id and an error's name pass"
  );
  Assert.deepEqual(
    review.sites.map(site => site.emoji),
    [false, false, false, true],
    "an emoji in the sentence is caught"
  );
  Assert.deepEqual(
    review.bare,
    ['fixture.js:6: console.error("restore failed", err);'],
    "and a bare console call is caught, but not one in a comment"
  );
});

/**
 * An error reaches a log line through `describeError` alone: its message, or
 * the error as a string, would carry the path of the file it was about.
 */
add_task(function the_guard_fails_a_call_site_that_logs_an_error_message() {
  const fixture = [
    "SvalLog.warn(`reading failed: ${err?.message ?? err}`);",
    "SvalLog.warn(`reading failed: ${error}`);",
    'SvalLog.warn("reading failed", ex);',
    "SvalLog.warn(`reading failed: ${describeError(err)}`);",
    "this._modules.SvalLog.warn(`${this._modules.describeError(err)}`);",
    "SvalLog.warn(`reading failed: ${err.name}`);",
    "SvalLog.warn(`reading failed: ${SvalLog.errorName(err.cause)}`);",
  ].join("\n");
  Assert.deepEqual(
    reviewed(fixture, "fixture.js").sites.map(site => site.leaks),
    [["err?.message", "err"], ["error"], ["ex"], [], [], [], []],
    "a message, an error as a string and an error passed whole are caught, " +
      "and describeError and an error's name pass"
  );
});

/**
 * What the console shows for a file that failed: the kind of failure and what
 * happened, with the path gone however the message spelled it.
 */
add_task(async function a_failed_file_is_logged_without_its_path() {
  const dir = await makeTempDir("sval-log path with spaces");
  const missing = PathUtils.join(dir, "settings.json");
  const err = await IOUtils.readJSON(missing).then(
    () => null,
    caught => caught
  );
  Assert.ok(err, "reading a file that is not there fails");
  Assert.stringContains(
    err.message,
    dir,
    "and IOUtils names the file in its message"
  );

  const logged = await lines(() =>
    SvalLog.error(`reading failed: ${describeError(err)}`)
  );
  Assert.equal(logged.length, 1, "the failure was logged");
  Assert.ok(
    !logged[0].includes(dir) && !logged[0].includes(PathUtils.filename(dir)),
    `the line carries no part of the path: ${logged[0]}`
  );
  Assert.ok(
    logged[0].startsWith("reading failed: NotFoundError: Could not"),
    `and still says what kind of failure it was: ${logged[0]}`
  );

  for (const [message, kept] of [
    [
      "Could not write to `C:\\Users\\Jo Doe\\sval\\key.bin'",
      "Could not write to `<path>'",
    ],
    [
      "cannot list /Volumes/My Drive/sval: no such folder",
      "cannot list <path>: no such folder",
    ],
    ["moved file:///home/jo/sval/x.json", "moved <path>"],
    [
      "sval/ws/0a1b/2c3d.json would not parse",
      "sval/ws/0a1b/2c3d.json would not parse",
    ],
    [
      "failed to load chrome://browser/content/sval/x.mjs",
      "failed to load chrome://browser/content/sval/x.mjs",
    ],
  ]) {
    Assert.equal(
      describeError(new Error(message)),
      `Error: ${kept}`,
      "a Windows path, an unquoted path with spaces and a file URL go; an " +
        "engine-relative name and a chrome address stay"
    );
  }
});

/**
 * The case a user meets: a settings file that will not parse is reported in
 * the console, and the report does not say where the profile is.
 */
add_task(async function a_damaged_settings_file_is_reported_without_its_path() {
  const { SvalLocalSettings } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
  );
  const dir = await makeTempDir("sval-log-settings");
  const path = PathUtils.join(dir, "sval-local-settings.json");
  await IOUtils.writeUTF8(path, "{ not json");

  Services.prefs.setStringPref(SVAL_LOG_LEVEL_PREF, "Warn");
  const logged = await lines(() => SvalLocalSettings.open(path));
  SvalLocalSettings.forgetCachedValues();
  Services.prefs.clearUserPref(SVAL_LOG_LEVEL_PREF);

  Assert.ok(
    logged.some(text => text.includes("could not be read")),
    `the damaged file is reported: ${JSON.stringify(logged)}`
  );
  Assert.ok(
    logged.every(text => !text.includes(dir)),
    `and no line names the folder it is in: ${JSON.stringify(logged)}`
  );
});

/**
 * The names of the files a directory URL lists, from the
 * `application/http-index-format` listing that both `file:` and `jar:`
 * directories answer with.
 *
 * @param {string} url A directory's URL, ending in a slash.
 * @returns {Promise<string[]>}
 */
async function listedIn(url) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadUsingSystemPrincipal: true,
  });
  const text = await new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream, status) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error(`listing ${url} failed: ${status}`));
        return;
      }
      resolve(NetUtil.readInputStreamToString(stream, stream.available()));
    });
  });
  return text
    .split("\n")
    .filter(line => line.startsWith("201: "))
    .map(line => decodeURIComponent(line.slice(5).split(" ")[0]));
}
