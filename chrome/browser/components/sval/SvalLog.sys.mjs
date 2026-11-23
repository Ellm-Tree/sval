/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The one console every part of Sval logs through.
 *
 * `console.createInstance` is Gecko's own pattern for a component log
 * (`dom/chrome-webidl/ConsoleInstance.webidl`; `BackupService.sys.mjs` and
 * `Sanitizer.sys.mjs` are the examples followed here). It gives three things a
 * bare `console.error` cannot: one prefix applied by the platform rather than
 * written into every message, a level per call site, and a pref that turns
 * detail on without a build.
 *
 * **Quiet by default.** {@link SVAL_LOG_LEVEL_PREF} ships as `"Warn"`, so
 * someone who never opens a console sees nothing Sval did not already have to
 * say. `Info` and `Debug` exist for the person following a sync problem, and
 * cost nothing until they ask for them.
 *
 * **What each level means in Sval**, and the call sites are held to it:
 *
 * - `error`: an operation the user asked for failed, or data is at risk: a
 *   key adoption that did not complete, a folder choice that did not take effect.
 * - `warn`: something unexpected that Sval recovered from: a folder it could
 *   not read this pass, a peer file that would not parse.
 * - `info`: lifecycle worth seeing while following a problem: a key adopted,
 *   a shared folder chosen, a workspace handed to a window.
 * - `debug`: per-pass detail: a pass ran and wrote nothing, a retry's wait
 *   grew, an offer that resisted withdrawal.
 *
 * **What Sval keeps or sends never says what the user is browsing**
 * (decision 0061). A warning or an error reaches both the console and
 * {@link SVAL_LOG_FILE}, and the file's scrubbing ({@link forTheFile})
 * replaces paths, URLs and hosts but cannot recognise a name, so a call site
 * at any level interpolates no
 * workspace, group or tab name, no URL, no document key, no pairing code, no
 * emoji and no secret. Node ids, counts, device ids, error names and
 * {@link describeError} are what a diagnostic is allowed. The console is the
 * user's own live view, so an error's message may name a URL there. Sval
 * exists because a browser should not be a surveillance instrument (spec
 * §1), and a kept log travels into a feedback report. The rule is enforced
 * rather than remembered: `test_sval_log.js` reads Sval's own source and
 * fails on a call site that interpolates one of those fields.
 */

/**
 * The level pref, shipped as `"Warn"` in `branding/sval/pref/app-sval-prefs.js`.
 *
 * Values are `ConsoleLogLevel`'s names, capitalised as that enum spells them
 * (`ConsoleInstance.webidl`): `All`, `Debug`, `Log`, `Info`, `Warn`, `Error`,
 * `Off`. An unparseable value leaves the level where it was and complains
 * once, which is Gecko's behaviour.
 */
export const SVAL_LOG_LEVEL_PREF = "browser.sval.loglevel";

/** What the platform prepends to every line: `console.warn: sval: …`. */
export const SVAL_LOG_PREFIX = "sval";

/** The level to fall back on when the pref is missing. */
const SVAL_DEFAULT_LOG_LEVEL = "Warn";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/**
 * The console behind {@link SvalLog}. One instance for the whole process, so
 * the prefix and the level are decided in exactly one place.
 */
const svalConsole = console.createInstance({
  prefix: SVAL_LOG_PREFIX,
  // `maxLogLevelPref` is the live one: Gecko re-reads the pref on every
  // change (`ConsoleInstance::SetLogLevel`). `maxLogLevel` is what it falls
  // back to where the pref is not there to read: a context whose default
  // prefs were never loaded would otherwise default to `All`.
  maxLogLevel: SVAL_DEFAULT_LOG_LEVEL,
  maxLogLevelPref: SVAL_LOG_LEVEL_PREF,
});

/** The file Sval's warnings and errors are kept in, in the profile. */
export const SVAL_LOG_FILE = "sval-log.txt";

/** Where {@link SVAL_LOG_FILE} moves when it is full, replacing the last. */
export const SVAL_LOG_FILE_OLD = "sval-log-old.txt";

/**
 * The size {@link SVAL_LOG_FILE} may reach before it is rotated. Sval's
 * warnings are a line or two each, so this holds thousands of them, and the
 * two files together stay under a megabyte.
 */
const SVAL_LOG_FILE_CAP = 256 * 1024;

/**
 * The warnings and errors Sval has printed, kept on disk so that a failure is
 * still there to read after the console that showed it is gone.
 *
 * Firefox's persistent logging, `LogManager` and its `FlushableStorageAppender`
 * (`toolkit/modules/LogManager.sys.mjs`), serves `Log.sys.mjs` loggers rather
 * than a `ConsoleInstance`, and writes a new file per sync session that it
 * prunes by age. Sval wants one file that a person can open, bounded by size,
 * so it appends here.
 *
 * Lines are queued as they are logged and written in batches by one write at
 * a time, through `IOUtils`, off the caller's path. Nothing here may throw into
 * the caller or log: a line about the log failing would be written to the log.
 * A batch that cannot be written is dropped.
 *
 * This module's rule keeps every call site free of what the user is
 * browsing, private windows included, but an error's own message can still
 * name a URL or a host, and a message can hold a line break. What is kept on
 * disk goes through {@link forTheFile} first, so one call is one line and
 * names no address. The console keeps the message whole.
 */
const svalLogFile = {
  /**
   * The directory the files are in, decided at the first line: `null` where
   * nothing is written, which is a test run (unless a test asks, through
   * {@link _SvalLogFileForTests}) or a content process. A line logged before
   * the profile is known leaves it undecided, for the next line to try.
   *
   * @type {string|null|undefined}
   */
  dir: undefined,
  cap: SVAL_LOG_FILE_CAP,
  queue: [],
  /**
   * The length of the queued text. Lines beyond the cap while a write is
   * slow are dropped, so neither memory nor one batch outgrows a file.
   */
  queued: 0,
  /** The batch being written, until the queue is empty. */
  writing: null,
  blocking: false,

  /**
   * @param {string} level `"warn"` or `"error"`.
   * @param {Iterable} args What was logged.
   * @param {string} [mark] What the line says after its level: Sval's prefix,
   *   or `"console"` for a line {@link consoleCapture} took from browser code.
   * @param {string} [source] Where browser code's message came from, as
   *   {@link sourceOf} gives it, already fit for the file.
   */
  record(level, args, mark = SVAL_LOG_PREFIX, source = "") {
    try {
      if (this.dir === undefined) {
        this.dir = this.defaultDir();
      }
      if (!this.dir) {
        return;
      }
      const text = Array.from(args, arg => forTheFile(String(arg))).join(" ");
      const line = `${new Date().toISOString()} ${level} ${mark}: ${text}${source}\n`;
      if (this.queued + line.length > this.cap) {
        return;
      }
      this.queue.push(line);
      this.queued += line.length;
      this.writing ??= this.drain();
    } catch {}
  },

  defaultDir() {
    if (
      Cu.isInAutomation ||
      Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_DEFAULT
    ) {
      return null;
    }
    try {
      return PathUtils.profileDir;
    } catch {
      return undefined;
    }
  },

  async drain() {
    this.blockShutdown();
    // Let the lines logged in the same turn join the first batch.
    await Promise.resolve();
    while (this.queue.length) {
      const text = this.queue.join("");
      this.queue = [];
      this.queued = 0;
      try {
        await this.write(text);
      } catch {}
    }
    this.writing = null;
  },

  async write(text) {
    const path = PathUtils.join(this.dir, SVAL_LOG_FILE);
    const bytes = new TextEncoder().encode(text);
    const info = await IOUtils.stat(path).catch(() => null);
    if (info && info.size + bytes.length > this.cap) {
      await IOUtils.move(path, PathUtils.join(this.dir, SVAL_LOG_FILE_OLD));
    }
    await IOUtils.write(path, bytes, { mode: "appendOrCreate" });
  },

  /** The lines still queued at shutdown are written before the profile goes. */
  blockShutdown() {
    if (this.blocking) {
      return;
    }
    this.blocking = true;
    try {
      lazy.AsyncShutdown.profileBeforeChange.addBlocker(
        "SvalLog: writing its file",
        () => this.writing
      );
    } catch {}
  },
};

/**
 * Sval's console. System modules share a global, so every importer gets this
 * one object.
 *
 * It carries `shouldLog(level)` as well as the level methods, which is how a
 * `Debug` line that would cost something to build costs nothing when `Debug`
 * is off. `warn` and `error` also go to {@link svalLogFile}, whatever the
 * level pref says, and `info` and `debug` never do.
 */
export const SvalLog = Object.freeze({
  error(...args) {
    svalConsole.error(...args);
    svalLogFile.record("error", args);
  },
  warn(...args) {
    svalConsole.warn(...args);
    svalLogFile.record("warn", args);
  },
  info(...args) {
    svalConsole.info(...args);
  },
  debug(...args) {
    svalConsole.debug(...args);
  },
  shouldLog(level) {
    return svalConsole.shouldLog(level);
  },
  /**
   * An error's name as a log line carries it. A rejection need not be an
   * Error: a string, or an object without a name, gives "Error", where
   * `err?.name` would log "undefined". `sval/error-name` holds every
   * `SvalLog` call to this.
   *
   * @param {*} err Anything a `throw` or a rejection produced.
   * @returns {string}
   */
  errorName(err) {
    const name = err?.name;
    return typeof name === "string" && name ? name : "Error";
  },
});

/**
 * The folder Sval's log files are in, or null where none are written: a test
 * run that has not asked for them, or a content process. A report reads the
 * files from here (feedback spec §3.2).
 *
 * @returns {string|null}
 */
export function svalLogDir() {
  if (svalLogFile.dir === undefined) {
    svalLogFile.dir = svalLogFile.defaultDir();
  }
  return svalLogFile.dir ?? null;
}

/** The schemes of browser code's own files, which a line names by file name. */
const BROWSER_CODE_SCHEMES = new Set([
  "chrome:",
  "resource:",
  "moz-src:",
  "jar:",
]);

/**
 * Where a browser-code message came from, as its line in the file says it:
 * ` (<file name>:<line>)`. The file of a script the browser ships is named by
 * its file name, which is what points at the bug. Any other source is an
 * address, which {@link forTheFile} replaces. It is kept apart from the
 * message's own scrubbing, which reads `<file name>:<line>` as an address too.
 *
 * The engine names eval'd code after the script that ran the eval
 * ("<url> line <n> > eval"), and a script a privileged loader ran after the
 * loader and then the script ("<loader> -> <url>"); the last script is the
 * one that logged.
 *
 * @param {string} source
 * @param {number} line
 * @returns {string}
 */
function sourceOf(source, line) {
  if (!source) {
    return "";
  }
  const script = source
    .split(" -> ")
    .at(-1)
    .replace(/ line \d+ > .*$/, "");
  const url = URL.parse(script);
  const name = BROWSER_CODE_SCHEMES.has(url?.protocol)
    ? url.pathname.split("/").at(-1)
    : forTheFile(script);
  return ` (${name}:${line})`;
}

/**
 * Browser code's warnings and errors, kept in Sval's log file beside Sval's
 * own lines (feedback spec §3.7): every `nsIScriptError` the engine marked as
 * coming from system code, and every console API `warn` and `error` from a
 * chrome context, which is the mark the console's Sval filter reads
 * (`console-origin.js`). A page or an extension cannot set it. Content
 * processes forward their script errors to the parent's console service
 * (`ContentParent::RecvScriptError`), so the parent's listener sees them too.
 *
 * Firefox's code is not held to this module's rule at its call sites, so
 * {@link forTheFile} is the only guard on these lines, and a message raised
 * in a private window is left out whole ({@link raisedInPrivateWindow}).
 */

/**
 * Whether the window a message was raised in is a private browser window, or
 * inside one: a page, a frame or the window's own chrome. Gecko's own mark
 * leaves chrome code out: `nsScriptErrorBase::ComputeIsFromPrivateWindow`
 * answers false for a system principal's window, and a console event's
 * `private` is read from the origin attributes of its global's principal
 * (`Console::MethodInternal`), which the system principal has none of. So
 * the window is found from its id, and the browser window that holds it
 * answers.
 *
 * @param {*} innerWindowId The message's inner window id. A message no
 *   window raised has 0, or a string naming its kind.
 * @returns {boolean}
 */
function raisedInPrivateWindow(innerWindowId) {
  if (typeof innerWindowId !== "number" || !innerWindowId) {
    return false;
  }
  const top =
    WindowGlobalParent.getByInnerWindowId(innerWindowId)?.browsingContext
      .topChromeWindow;
  return !!top && lazy.PrivateBrowsingUtils.isWindowPrivate(top);
}

const consoleCapture = {
  /** @param {nsIConsoleMessage} message */
  observe(message) {
    try {
      if (
        !(message instanceof Ci.nsIScriptError) ||
        !message.isFromChromeContext ||
        message.isFromPrivateWindow ||
        raisedInPrivateWindow(message.innerWindowID) ||
        message.flags & Ci.nsIScriptError.infoFlag
      ) {
        return;
      }
      const level =
        message.flags & Ci.nsIScriptError.warningFlag ? "warn" : "error";
      svalLogFile.record(
        level,
        [message.errorMessage],
        "console",
        sourceOf(message.sourceName, message.lineNumber)
      );
    } catch {}
  },

  /**
   * A console API call. `SvalLog`'s own carry its prefix and are already in
   * the file.
   *
   * @param {object} event A `ConsoleEvent`.
   */
  onConsoleEvent(event) {
    try {
      if (
        (event.level !== "warn" && event.level !== "error") ||
        !event.chromeContext ||
        event.private ||
        raisedInPrivateWindow(event.innerID) ||
        event.prefix === SVAL_LOG_PREFIX
      ) {
        return;
      }
      const text = Array.from(event.arguments ?? [], String).join(" ");
      svalLogFile.record(
        event.level,
        [text],
        "console",
        sourceOf(event.filename, event.lineNumber)
      );
    } catch {}
  },
};

let capturing = false;

/**
 * Starts keeping browser code's warnings and errors in the log file, once for
 * the parent process. Its listeners stay for the life of the process.
 */
export function startConsoleCapture() {
  if (
    capturing ||
    Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_DEFAULT
  ) {
    return;
  }
  capturing = true;
  Services.console.registerListener(consoleCapture);
  const onEvent = event => consoleCapture.onConsoleEvent(event);
  Cc["@mozilla.org/consoleAPI-storage;1"]
    .getService(Ci.nsIConsoleAPIStorage)
    .addLogEventListener(
      onEvent,
      Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
    );
}

/**
 * For tests: write the log file into `dir`, rotated at `cap` bytes, or stop
 * writing it, and wait for the lines logged so far to be written.
 */
export const _SvalLogFileForTests = {
  /**
   * @param {string|null} dir Where to write, or `null` to write nothing.
   * @param {number} [cap] The size the file rotates at.
   */
  use(dir, cap = SVAL_LOG_FILE_CAP) {
    svalLogFile.dir = dir;
    svalLogFile.cap = cap;
  },
  /** @returns {Promise} once every line logged so far is written. */
  async written() {
    await svalLogFile.writing;
  },
};

/**
 * A file path or file URL inside an error message: a POSIX path, a Windows
 * drive or UNC path, or a `file:` URL, starting where a word cannot. It runs
 * to the quote, bracket, `: ` or `, ` that closes it, so a path with spaces in
 * it, which IOUtils quotes as `` `…' ``, is caught whole. A scheme's `//`
 * follows a colon, so `chrome://` and `moz-src:///` addresses are kept.
 */
const PATH_IN_MESSAGE =
  /(?:file:\/\/|(?<=^|[\s`'"(=[])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[^\s/])))[^`'"\n)\]]*?(?=: |, |[`'"\n)\]]|$)/g;

/**
 * An address in a message: a URL with `//`, or one of the schemes that go
 * without it (`about:`, `moz-extension:`, `data:`, `blob:` and the like),
 * running to the next space, quote or bracket. The brackets around an IPv6
 * host, straight after the `//`, are part of the address.
 */
const URL_IN_MESSAGE =
  /\b[a-z][a-z+.-]+:(?:\/\/\[[^\]\s]*\][^\s`'"<>()[\]{}]*|(?:\/\/|(?=[^\s/\\`'"]))[^\s`'"<>()[\]{}]+)/gi;

/** A dotted name that could be a host; {@link forTheFile} asks the PSL. */
const HOST_IN_MESSAGE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\b/gi;

/**
 * An IPv4 address written in full: four numbers around dots, with no digit
 * and no further dotted number on either side. A letter, a hyphen or an
 * underscore beside it hides nothing. Three numbers, such as "153.0.1", are
 * a version in a log line and stay.
 */
const IPV4_IN_MESSAGE = /(?<!\d|\d\.)\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)/g;

/**
 * What could be an IPv6 address: a run of hex digits, colons and dots that
 * holds a colon and starts where a word cannot, with or without its brackets
 * and its zone id ("%eth0"). {@link withoutIPv6} decides.
 */
const IPV6_IN_MESSAGE =
  /(?<![\w:.])\[?[0-9a-f:.]*:[0-9a-f:.]*(?:%[\w-]+)?\]?/gi;

/**
 * @param {string} host
 * @returns {boolean} Whether `host` is an IP address, as the Public Suffix
 *   List's service tells one from a name (`NS_ERROR_HOST_IS_IP_ADDRESS`).
 */
function isIPLiteral(host) {
  try {
    Services.eTLD.getBaseDomainFromHost(host);
    return false;
  } catch (err) {
    return err.result === Cr.NS_ERROR_HOST_IS_IP_ADDRESS;
  }
}

/**
 * A candidate {@link IPV6_IN_MESSAGE} found, with its address taken out if
 * it holds one. The run can end in the sentence's own colons and full stops,
 * and the Public Suffix List's service reads an address with a full stop
 * after it as an address too. So the shortest start of the run that is an
 * address is taken, from the run without its closing colons and stops up to
 * the whole run, which keeps an address that ends in "::", and what follows
 * the address stays in the line.
 *
 * @param {string} found
 * @returns {string}
 */
function withoutIPv6(found) {
  const [, body] = found.match(/^\[?([^%\]]*)/);
  const least = body.replace(/[:.]+$/, "").length;
  for (let end = Math.max(least, 1); end <= body.length; end++) {
    if (isIPLiteral(body.slice(0, end))) {
      return `<host>${body.slice(end)}`;
    }
  }
  return found;
}

/** Line breaks and other control characters, which would forge a line. */
// Control characters are what this matches.
// eslint-disable-next-line no-control-regex
const CONTROL_IN_MESSAGE = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/**
 * A logged argument as `sval-log.txt` keeps it: on one line, with file paths
 * redacted as {@link describeError} redacts them, then every address, then
 * every IP address and every dotted name whose ending is on the Public Suffix
 * List. That last catches a bare host and can catch a file name such as
 * `run.sh`, which a line on disk can spare.
 *
 * @param {string} text
 * @returns {string}
 */
function forTheFile(text) {
  return text
    .replace(CONTROL_IN_MESSAGE, " ")
    .replace(PATH_IN_MESSAGE, "<path>")
    .replace(URL_IN_MESSAGE, "<url>")
    .replace(IPV6_IN_MESSAGE, withoutIPv6)
    .replace(IPV4_IN_MESSAGE, "<host>")
    .replace(HOST_IN_MESSAGE, host => {
      try {
        return Services.eTLD.hasKnownPublicSuffixFromHost(host)
          ? "<host>"
          : host;
      } catch {
        return host;
      }
    });
}

/**
 * An error as a log line may carry it: its name, then its message with every
 * file path in it replaced by `<path>`.
 *
 * Every `IOUtils` rejection names its file ("Could not read `%s'",
 * `IOUtils.cpp`), and so do Sval's own errors about a file. A message logged
 * as it is carries the profile directory, the user's account name and their
 * shared folder, which names their cloud provider. Log an error through this,
 * never through its `.message`; `test_sval_log.js` holds every call site to it.
 *
 * @param {*} err Anything a `throw` or a rejection produced.
 * @returns {string} `Name: message`, or the name alone.
 */
export function describeError(err) {
  if (err === null || typeof err !== "object") {
    return String(err).replace(PATH_IN_MESSAGE, "<path>");
  }
  const name = typeof err.name === "string" && err.name ? err.name : "Error";
  const message = String(err.message ?? "").replace(PATH_IN_MESSAGE, "<path>");
  if (!message) {
    return name;
  }
  return message.startsWith(name) ? message : `${name}: ${message}`;
}

/**
 * The level the pref currently names, for a context that cannot read a pref.
 *
 * `maxLogLevelPref` is documented not to work in workers and says so on the
 * worker's own console when tried (`ConsoleInstance.webidl`: "the maxLogLevel
 * will default to the value passed to this constructor … or it is used in
 * workers"), so `SvalSync.worker.mjs` builds its instance with a fixed
 * `maxLogLevel` and `SvalEngine` hands it this value instead.
 *
 * @returns {string} A `ConsoleLogLevel` name.
 */
export function svalLogLevel() {
  return Services.prefs.getStringPref(
    SVAL_LOG_LEVEL_PREF,
    SVAL_DEFAULT_LOG_LEVEL
  );
}
