/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The report Send Feedback sends (feedback spec §3 to §5): what it holds, the
 * text each part shows in View, and the one request that posts it.
 *
 * **One build.** `collect` reads everything once and keeps each part's bytes;
 * `view` and `send` both read those, so what the user read is what leaves
 * (spec §4). A crash file is the exception that keeps the rule: its minidump
 * is read from disk once, the first time View or Send asks, and both use that
 * read.
 *
 * **What leaves.** Every line comes from the function that already answers it
 * (spec §3.4); nothing here works out an answer of its own. Text that could
 * name what the user browses goes through a rule before it is kept: the value
 * rule for settings (§3.5), Gecko's report allowlist for a crash's
 * annotations (§3.6), and `SvalLog`'s scrubbing for the log (§3.7).
 *
 * `report.json` is one JSON object: the always-sent part's members, then one
 * member per ticked part, each holding that part's View text as it is. JSON
 * ignores the whitespace between, so the file parses, and every byte a View
 * showed is in the file unchanged.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalReport } from "moz-src:///browser/components/sval/SvalReport.sys.mjs";

/** Where Send posts the report (spec §5). */
export const REPORT_URL_PREF = "browser.sval.support.reportURL";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ALLOWED_DOMAIN_BRANCH:
    "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  CrashReports: "resource://gre/modules/CrashReports.sys.mjs",
  descendantGroupCount:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  descendantTabCount:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  DEVICE_NAME_PREF:
    "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
  FAVORITES_ROOT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PAGE_RULES_PREF: "moz-src:///browser/components/sval/SvalPageRules.sys.mjs",
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
  SvalEngine: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
  SvalSiteChoices: "moz-src:///browser/components/sval/SvalSiteChoices.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalSecureDns: "moz-src:///browser/components/sval/SvalSecureDns.sys.mjs",
  Troubleshoot: "resource://gre/modules/Troubleshoot.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
  choiceOf: "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  isOn: "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  verdictOf: "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
});
/**
 * An export of one of Sval's modules whose name another module shares, read
 * when it is needed.
 *
 * @param {string} module The module's name.
 * @param {string} symbol The export.
 * @returns {*}
 */
function exportOf(module, symbol) {
  return ChromeUtils.importESModule(
    `moz-src:///browser/components/sval/${module}.sys.mjs`
  )[symbol];
}

/** The shortest description the form sends (spec §3.1). */
export const MIN_DESCRIPTION = 10;

/** The largest request the collector takes (spec §5). */
export const MAX_BYTES = 25 * 1024 * 1024;

/** The line under a crash file's row (spec §3.2). */
export const CRASH_WARNING = "May include parts of pages you had open.";

/**
 * How long a sent request may wait for its answer before the server is
 * taken to have failed (spec §5).
 */
const ANSWER_WAIT_MS = 60 * 1000;

/**
 * The annotation Gecko allows in a report that the form still leaves out
 * (spec §3.6): free text the form asks for itself.
 */
const ANNOTATION_LEFT_OUT = "Comments";

/**
 * A string setting value short and plain enough to be an enumerated value.
 * A dot is left out, because a host name or an address is dotted.
 */
const PLAIN_VALUE = /^[A-Za-z0-9_-]{1,32}$/;

/** What a string setting the value rule holds back is sent as (spec §3.5). */
export const CHANGED = "(changed)";

const ROW = {
  about: "Sval version and your system",
  log: "Sval's error log",
  state: "Sval's state",
  prefs: "Browser settings you've changed",
  extensions: "Installed extensions",
  graphics: "Graphics card and driver",
  crashes: "Crash list",
};

const encoder = new TextEncoder();

function byteLength(text) {
  return encoder.encode(text).length;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Sval's settings named for a site, a pref each under these branches. Their
 * names are sites, as are the names of the `browser.fixup.` branch that
 * `PREF_REGEXES_NOT_TO_DISPLAY` leaves out of a snapshot. Sval's state counts
 * the sites instead.
 *
 * @returns {string[]}
 */
function siteBranches() {
  return [...lazy.SvalSiteChoices.SITE_BRANCHES, lazy.ALLOWED_DOMAIN_BRANCH];
}

/**
 * A setting's value as a report carries it (spec §3.5).
 *
 * @param {*} value
 * @returns {boolean|number|string}
 */
export function reportedValue(value) {
  if (typeof value === "boolean" || Number.isInteger(value)) {
    return value;
  }
  return typeof value === "string" && PLAIN_VALUE.test(value) ? value : CHANGED;
}

function prefValue(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(name);
    default:
      return Services.prefs.getStringPref(name, "");
  }
}

/**
 * Every changed setting: Firefox's `modifiedPreferences`, which has already
 * applied `PREF_REGEXES_NOT_TO_DISPLAY`, and Sval's own branch.
 *
 * @param {object} modified The snapshot's `modifiedPreferences`.
 * @returns {object} Each name with its reported value, sorted by name.
 */
function changedSettings(modified) {
  const all = { ...modified };
  for (const name of Services.prefs.getChildList("browser.sval.")) {
    if (Services.prefs.prefHasUserValue(name)) {
      all[name] = prefValue(name);
    }
  }
  const branches = siteBranches();
  return Object.fromEntries(
    Object.keys(all)
      .filter(name => !branches.some(branch => name.startsWith(branch)))
      .sort()
      .map(name => [
        name,
        // A device name is never sent (spec §3.3), and one word such as a
        // person's name passes the value rule.
        name === lazy.DEVICE_NAME_PREF ? CHANGED : reportedValue(all[name]),
      ])
  );
}

/**
 * The window whose panel answers for sync: the top window that is not
 * private, whose footer shows the indicator.
 */
function panelWindow() {
  return lazy.BrowserWindowTracker.getTopWindow({ private: false }) ?? null;
}

function minutesSince(time) {
  return typeof time === "number" || time instanceof Date
    ? Math.floor((Date.now() - time) / 60000)
    : null;
}

/** Sval's state (spec §3.4). */
async function svalState() {
  const panel = panelWindow()?.SvalPanel ?? null;
  const indicatorState = panel?.indicatorState?.() ?? null;
  const indicator = indicatorState ? panel.syncIndicator() : undefined;

  const engine = lazy.SvalEngine.sharedInstance;
  const nodes = engine ? ((await engine.tree()).nodes ?? {}) : null;
  const workspaces = nodes ? lazy.workspaceIds(nodes) : [];
  const sum = (ids, count) => ids.reduce((n, id) => n + count(nodes, id), 0);
  const favorites = lazy.SvalFavoritesStore.readyInstance;

  const switches = exportOf("SvalFingerprinting", "GROUPS").flatMap(group => [
    ...group.shown,
    ...group.items,
  ]);
  const agentStore = lazy.SvalAgents.store;

  return {
    sync: {
      folderChosen: indicatorState?.sharing ?? null,
      // The footer has no indicator while no folder is chosen.
      indicator:
        indicator === undefined ? null : (indicator?.severity ?? "none"),
      syncKey: indicatorState?.keyState ?? null,
      minutesSinceLastSync: minutesSince(indicatorState?.lastSynced),
      folderProblem: indicatorState?.folder?.problem ?? null,
    },
    tree: nodes
      ? {
          workspaces: workspaces.length,
          groups: sum(workspaces, lazy.descendantGroupCount),
          tabs: sum(workspaces, lazy.descendantTabCount),
          pins: favorites ? favorites.home().length : null,
          favorites: favorites ? favorites.countIn(lazy.FAVORITES_ROOT) : null,
          windows: lazy.BrowserWindowTracker.windowCount,
          privateWindowOpen: !!lazy.BrowserWindowTracker.getOrderedWindows({
            private: true,
          }).length,
        }
      : null,
    protections: {
      blocking: lazy.SvalBlocking.level,
      fingerprinting: Object.fromEntries(
        switches.map(s => [s.id, s.choices ? lazy.choiceOf(s) : lazy.isOn(s)])
      ),
      secureDns: lazy.SvalSecureDns.current()?.value ?? null,
      pageRules: Services.prefs.getBoolPref(lazy.PAGE_RULES_PREF, true),
      // How many sites and hosts hold each kind of choice, by the kind's
      // id in `SvalSiteChoices`.
      sitesWithChoices: Object.fromEntries(
        lazy.SvalSiteChoices.CHOICES.map(choice => [
          choice.id,
          choice.read(null).size,
        ])
      ),
    },
    agents: {
      access: agentStore ? "on" : "off",
      paired: agentStore ? agentStore.agents().length : null,
      tabsInAgentWorkspaces: nodes
        ? sum(
            workspaces.filter(id => nodes[id]?.agent),
            lazy.descendantTabCount
          )
        : null,
    },
    uptimeMinutes: minutesSince(Services.startup.getStartupInfo().process),
  };
}

/**
 * The always-sent part (spec §3.1).
 *
 * @param {object} application The snapshot's `application`.
 * @returns {object}
 */
function aboutSval(application) {
  return {
    product: "Sval",
    build: {
      version: application.version,
      buildID: application.buildID,
      channel:
        application.updateChannel ?? lazy.UpdateUtils.getUpdateChannel(false),
    },
    os: {
      version: application.osVersion,
      arch: Services.sysinfo.getProperty("arch"),
      rosetta: !!application.rosetta,
    },
    troubleshootMode: !!application.safeMode,
    locale: Services.locale.appLocaleAsBCP47,
  };
}

function aboutLine(about) {
  const { build, os } = about;
  return (
    `Sval ${build.version}, build ${build.buildID}, ${build.channel} channel` +
    ` · ${os.version} on ${os.arch}${os.rosetta ? ", under Rosetta" : ""}` +
    ` · ${about.troubleshootMode ? "in Troubleshoot Mode" : "not in Troubleshoot Mode"}` +
    ` · ${about.locale}`
  );
}

/**
 * Each extension, with Sval's verdict on it (spec §3.2).
 *
 * @param {object[]} addons The snapshot's `addons`.
 * @returns {Promise<object[]>}
 */
async function extensions(addons) {
  const list = [];
  for (const addon of Array.isArray(addons) ? addons : []) {
    if (addon.type !== "extension") {
      continue;
    }
    list.push({
      name: addon.name,
      id: addon.id,
      version: addon.version,
      on: addon.isActive,
      sval: lazy.verdictOf(await lazy.AddonManager.getAddonByID(addon.id)),
    });
  }
  return list;
}

/**
 * The snapshot's graphics, cut down to spec §3.2's fields.
 *
 * @param {object|string} snapshot The snapshot's `graphics`, or the error
 *   it holds where no window could answer.
 * @returns {object|null}
 */
function graphics(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const status = name =>
    snapshot.featureLog?.features?.find(f => f.name === name)?.status ?? null;
  const info = snapshot.info ?? {};
  const displays = [];
  for (let i = 0; i < (info.DisplayCount ?? 0); i++) {
    // gfxPlatform::GetDisplayInfo writes "<w>x<h>@<hz>Hz scales:<contents>|<css> …".
    const scales = /scales:([\d.]+)\|([\d.]+)/.exec(info[`Display${i}`] ?? "");
    displays.push(
      scales ? { contentsScale: +scales[1], cssScale: +scales[2] } : null
    );
  }
  return {
    gpu: snapshot.adapterDescription ?? null,
    vendorID: snapshot.adapterVendorID ?? null,
    deviceID: snapshot.adapterDeviceID ?? null,
    driverVersion: snapshot.driverVersion ?? null,
    compositor: snapshot.windowLayerManagerType ?? null,
    webRender: status("WEBRENDER"),
    hardwareVideoDecoding: status("HARDWARE_VIDEO_DECODING"),
    displays: info.DisplayCount ?? null,
    displayScales: displays,
  };
}

/**
 * A crash's annotations as a report carries them (spec §3.6): the keys Gecko
 * allows in a report, the list `CrashSubmit` applies, less `Comments`. Gecko
 * as Sval builds it has no annotation for a page's address
 * (crash-reports-no-page-address.patch).
 *
 * @param {object} extra The `.extra` file's JSON.
 * @returns {object}
 */
export function reportedAnnotations(extra) {
  const allowed = key => {
    try {
      return (
        Services.appinfo.isAnnotationValid(key) &&
        Services.appinfo.isAnnotationAllowedForReport(key)
      );
    } catch {
      return false;
    }
  };
  return Object.fromEntries(
    Object.entries(extra ?? {}).filter(
      ([key]) => key !== ANNOTATION_LEFT_OUT && allowed(key)
    )
  );
}

/** A minidump's stream directory entry for its module list. */
const MODULE_LIST_STREAM = 4;

/**
 * The file name of each library a minidump lists (`MINIDUMP_MODULE_LIST`, in
 * Microsoft's `minidumpapiset.h`, which Breakpad writes on every platform).
 * The full path names the user's folders, so only its last part is kept.
 *
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function minidumpLibraries(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x504d444d) {
      return [];
    }
    const streams = view.getUint32(8, true);
    const directory = view.getUint32(12, true);
    for (let i = 0; i < streams; i++) {
      const entry = directory + i * 12;
      if (view.getUint32(entry, true) !== MODULE_LIST_STREAM) {
        continue;
      }
      const list = view.getUint32(entry + 8, true);
      const count = view.getUint32(list, true);
      const names = [];
      const utf16 = new TextDecoder("utf-16le");
      for (let m = 0; m < count; m++) {
        // MINIDUMP_MODULE is 108 bytes; ModuleNameRva is at 20.
        const nameAt = view.getUint32(list + 4 + m * 108 + 20, true);
        const length = view.getUint32(nameAt, true);
        const path = utf16.decode(
          bytes.subarray(nameAt + 4, nameAt + 4 + length)
        );
        names.push(path.split(/[\\/]/).at(-1));
      }
      return names;
    }
  } catch {}
  return [];
}

/** The multipart body's framing, one boundary per report. */
class Multipart {
  constructor() {
    const random = crypto.getRandomValues(new Uint8Array(16));
    this.boundary = "SvalFeedback" + random.toHex();
  }

  get type() {
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  field(name, value) {
    return [
      `--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`,
      value,
      "\r\n",
    ];
  }

  file(name, filename, type, content) {
    return [
      `--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"; ` +
        `filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      content,
      "\r\n",
    ];
  }

  get end() {
    return `--${this.boundary}--\r\n`;
  }
}

function chunksLength(chunks) {
  return chunks.reduce(
    (n, chunk) =>
      n + (typeof chunk === "string" ? byteLength(chunk) : chunk.byteLength),
    0
  );
}

/** The parts `report.json` holds a member for, in their order. */
const JSON_PARTS = ["state", "prefs", "extensions", "graphics", "crashes"];

function reportJsonOpening(aboutText) {
  // The about part's text without its closing "\n}".
  return aboutText.slice(0, -2);
}

function reportJsonMember(id, text) {
  return `,\n  "${id}": ${text}`;
}

const REPORT_JSON_CLOSING = "\n}\n";

function textPart(id, fields) {
  return {
    id,
    locked: false,
    checked: true,
    tooLarge: false,
    sent: false,
    warning: null,
    ...fields,
    view: () => Promise.resolve({ kind: "text", text: fields.text }),
  };
}

/**
 * @param {Date} time
 * @returns {string} when a crash happened, as the form shows it.
 */
export function crashTime(time) {
  return new Services.intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);
}

function crashTitle(processType, time) {
  const kind =
    { main: "Browser", content: "Tab" }[processType] ??
    `${processType} process`;
  return `${kind} crash snapshot · ${crashTime(time)}`;
}

function crashDescription(processType) {
  if (processType === "main") {
    return "A copy of Sval's main process memory, and the libraries it had loaded.";
  }
  if (processType === "content") {
    return "A copy of the crashed tab's memory, and the libraries it had loaded.";
  }
  return `A copy of the crashed ${processType} process's memory, and the libraries it had loaded.`;
}

/**
 * The crashes of the last three days, as `CrashReports` lists them and
 * about:support's age limit keeps them (`Troubleshoot.kMaxCrashAge`).
 */
function recentCrashes() {
  if (!AppConstants.MOZ_CRASHREPORTER) {
    return [];
  }
  const now = Date.now();
  return lazy.CrashReports.getReports().filter(
    report => now - report.date < lazy.Troubleshoot.kMaxCrashAge
  );
}

/**
 * One crash file's part. Its minidump is read the first time View or Send
 * asks for it, and that one read serves both.
 *
 * @param {object} report A `CrashReports.getReports` entry.
 * @param {Multipart} multipart
 */
async function crashPart(report, multipart) {
  const time = new Date(report.date);
  if (!report.pending) {
    return {
      id: `crash:${report.id}`,
      title: `Crash · ${crashTime(time)}`,
      description:
        "Already sent from the crash dialog that appeared after this crash.",
      size: 0,
      locked: false,
      checked: false,
      tooLarge: false,
      sent: true,
      warning: null,
      view: () =>
        Promise.resolve({
          kind: "crash",
          size: 0,
          time,
          processType: null,
          crashID: report.id,
          libraries: [],
          annotations: "",
        }),
    };
  }
  const base = PathUtils.join(lazy.CrashReports.pendingDir.path, report.id);
  let extra = {};
  try {
    extra = JSON.parse(await IOUtils.readUTF8(`${base}.extra`));
  } catch {}
  const processType = extra.ProcessType ?? "main";
  const annotations = pretty(reportedAnnotations(extra));
  const dumpSize = (await IOUtils.stat(`${base}.dmp`)).size;
  let bytes = null;
  const readDump = () => (bytes ??= IOUtils.read(`${base}.dmp`));
  const framing = [
    ...multipart.file(
      "file",
      `${report.id}.dmp`,
      "application/octet-stream",
      ""
    ),
    ...multipart.file(
      "file",
      `${report.id}.extra.json`,
      "application/json",
      annotations
    ),
  ];
  return {
    id: `crash:${report.id}`,
    title: crashTitle(processType, time),
    description: crashDescription(processType),
    size: dumpSize + chunksLength(framing),
    locked: false,
    checked: false,
    tooLarge: false,
    sent: false,
    warning: CRASH_WARNING,
    async view() {
      const read = await readDump();
      return {
        kind: "crash",
        size: read.byteLength,
        time,
        processType,
        crashID: report.id,
        libraries: minidumpLibraries(read),
        annotations,
      };
    },
    async chunks() {
      return [
        ...multipart.file(
          "file",
          `${report.id}.dmp`,
          "application/octet-stream",
          await readDump()
        ),
        ...multipart.file(
          "file",
          `${report.id}.extra.json`,
          "application/json",
          annotations
        ),
      ];
    },
  };
}

/** Whether the link is down or Gecko is offline, as the failure says. */
function offline() {
  if (Services.io.offline) {
    return true;
  }
  try {
    const link = Cc["@mozilla.org/network/network-link-service;1"].getService(
      Ci.nsINetworkLinkService
    );
    return link.linkStatusKnown && !link.isLinkUp;
  } catch {
    return false;
  }
}

/**
 * Posts `body` and says how it went, in the contract's causes.
 *
 * XMLHttpRequest rather than `fetch`, because its upload's end tells when
 * the request has been sent and the wait for the answer starts.
 *
 * @param {string} url
 * @param {Blob} body
 * @param {string} type The body's content type.
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} What {@link SvalFeedback.send} answers.
 */
function post(url, body, type, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ ok: false, cause: "aborted" });
      return;
    }
    // `mozAnon` sends no cookies or credentials, and a system module has no
    // document to give a Referer.
    const xhr = new XMLHttpRequest({ mozAnon: true });
    let timer = null;
    let settled = false;
    const done = answer => {
      if (settled) {
        return;
      }
      settled = true;
      lazy.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => {
      done({ ok: false, cause: "aborted" });
      xhr.abort();
    };
    signal?.addEventListener("abort", onAbort);
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", type);
    xhr.setRequestHeader("User-Agent", `Sval/${AppConstants.MOZ_APP_VERSION}`);
    xhr.channel.loadFlags |=
      Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    xhr.upload.addEventListener("load", () => {
      timer = lazy.setTimeout(() => {
        done({ ok: false, cause: "server" });
        xhr.abort();
      }, ANSWER_WAIT_MS);
    });
    xhr.addEventListener("load", () => {
      const status = xhr.status;
      if (status >= 200 && status < 300) {
        let reference = "";
        try {
          reference = String(JSON.parse(xhr.responseText).reference ?? "");
        } catch {}
        done({ ok: true, reference });
      } else if (status >= 400 && status < 500) {
        done({ ok: false, cause: "rejected", status });
      } else {
        done({ ok: false, cause: "server", status });
      }
    });
    xhr.addEventListener("error", () => {
      done({ ok: false, cause: offline() ? "offline" : "unreachable" });
    });
    xhr.send(body);
  });
}

export const SvalFeedback = {
  /**
   * Builds the report once, when the form opens (spec §4).
   *
   * @param {{ context?: string }} [options]
   * @returns {Promise<object>} `{ context, parts }`, parts in display order.
   */
  async collect({ context = null } = {}) {
    const multipart = new Multipart();
    const snapshot = await lazy.Troubleshoot.snapshot();
    const about = aboutSval(snapshot.application);
    const crashes = recentCrashes();

    const values = {
      state: await svalState(),
      prefs: changedSettings(snapshot.modifiedPreferences ?? {}),
      extensions: await extensions(snapshot.addons),
      graphics: graphics(snapshot.graphics),
      crashes: crashes.map(report => ({
        id: report.id,
        time: new Date(report.date).toISOString(),
        sent: !report.pending,
      })),
    };
    const texts = Object.fromEntries(
      JSON_PARTS.map(id => [id, pretty(values[id])])
    );
    const aboutText = pretty(about);
    const log = await SvalReport.log();

    // The request's framing that is sent whatever is ticked goes with the
    // always-sent part: the context, report.json's own opening and closing,
    // and the closing boundary.
    const aboutSize = chunksLength([
      ...(context ? multipart.field("context", context) : []),
      ...multipart.file(
        "report",
        "report.json",
        "application/json",
        reportJsonOpening(aboutText) + REPORT_JSON_CLOSING
      ),
      multipart.end,
    ]);
    const memberSize = id => byteLength(reportJsonMember(id, texts[id]));

    const shown = extension => `${extension.name} ${extension.version}`;
    const list = values.extensions;
    const parts = [
      {
        ...textPart("about", {
          title: ROW.about,
          description: aboutLine(about),
          size: aboutSize,
          text: aboutText,
        }),
        locked: true,
      },
      textPart("log", {
        title: ROW.log,
        description:
          "Recent warnings and errors written by Sval and by the browser's own code. No addresses, file paths or names.",
        size: chunksLength(
          multipart.file("log", "log.txt", "text/plain;charset=utf-8", log)
        ),
        text: log,
      }),
      textPart("state", {
        title: ROW.state,
        description:
          "Whether sync is working, how many Workspaces, groups, tabs and pins you have, your protection settings, and how long Sval has been running. No names, titles or addresses.",
        size: memberSize("state"),
        text: texts.state,
      }),
      textPart("prefs", {
        title: ROW.prefs,
        description:
          'The name and value of each setting that\'s no longer at its default, like browser.startup.page = 3. A setting that holds text, such as your home page, shows only as "(changed)".',
        size: memberSize("prefs"),
        text: texts.prefs,
      }),
      textPart("extensions", {
        title: `${ROW.extensions} · ${list.length}`,
        description:
          (list.length
            ? list.slice(0, 3).map(shown).join(", ") +
              (list.length > 3 ? `, and ${list.length - 3} more. ` : ". ")
            : "") +
          "Name, ID, version, whether each is on, and whether it works with Sval. Not the extensions' files or their settings.",
        size: memberSize("extensions"),
        text: texts.extensions,
      }),
      textPart("graphics", {
        title: ROW.graphics,
        description: `${values.graphics?.gpu ?? "Your graphics card"} with ${
          values.graphics?.compositor ?? "its compositor"
        }, its driver version, which hardware acceleration features are on, such as WebRender and video decoding, and how many displays you have and their scaling.`,
        size: memberSize("graphics"),
        text: texts.graphics,
      }),
    ];
    if (crashes.length) {
      parts.push(
        textPart("crashes", {
          title: `${ROW.crashes} · ${crashes.length}`,
          description:
            "The id and time of each recent crash. Not the snapshots themselves.",
          size: memberSize("crashes"),
          text: texts.crashes,
        })
      );
    }
    const crashParts = [];
    for (const report of crashes) {
      try {
        crashParts.push(await crashPart(report, multipart));
      } catch {
        // A crash whose files went while the form opened is listed alone.
      }
    }
    const rest = parts.reduce((n, part) => n + part.size, 0);
    for (const part of crashParts) {
      part.tooLarge = !part.sent && rest + part.size > MAX_BYTES;
    }
    parts.push(...crashParts);

    return {
      context,
      parts,
      _multipart: multipart,
      _aboutText: aboutText,
    };
  },

  /**
   * Total bytes the request will carry with these ticks (spec §4), beside
   * the description and email the user is still typing.
   *
   * @param {object} report
   * @param {Set<string>} checked Part ids.
   * @returns {number}
   */
  totalSize(report, checked) {
    return report.parts
      .filter(part => sends(part, checked))
      .reduce((n, part) => n + part.size, 0);
  },

  /**
   * Posts the report (spec §5). The bytes posted for each part are the bytes
   * `view()` showed.
   *
   * @param {object} report What {@link collect} built.
   * @param {{ description: string, email?: string, checked: Set<string> }} entry
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ ok: true, reference: string }
   *   | { ok: false, cause: string, status?: number }>}
   */
  async send(report, { description, email, checked }, { signal } = {}) {
    const url = Services.prefs.getStringPref(REPORT_URL_PREF, "");
    const multipart = report._multipart;
    const byId = new Map(report.parts.map(part => [part.id, part]));
    const ticked = id => byId.has(id) && sends(byId.get(id), checked);

    let json = reportJsonOpening(report._aboutText);
    for (const id of JSON_PARTS) {
      if (ticked(id)) {
        json += reportJsonMember(id, (await byId.get(id).view()).text);
      }
    }
    json += REPORT_JSON_CLOSING;

    const chunks = [...multipart.field("description", description)];
    if (email?.trim()) {
      chunks.push(...multipart.field("email", email.trim()));
    }
    if (report.context) {
      chunks.push(...multipart.field("context", report.context));
    }
    chunks.push(
      ...multipart.file("report", "report.json", "application/json", json)
    );
    if (ticked("log")) {
      chunks.push(
        ...multipart.file(
          "log",
          "log.txt",
          "text/plain;charset=utf-8",
          (await byId.get("log").view()).text
        )
      );
    }
    for (const part of report.parts) {
      if (part.chunks && sends(part, checked)) {
        try {
          chunks.push(...(await part.chunks()));
        } catch {
          // A crash file deleted since the form opened is not sent.
        }
      }
    }
    chunks.push(multipart.end);
    return post(url, new Blob(chunks), multipart.type, signal);
  },
};

/**
 * Whether `part` goes in the request with these ticks.
 *
 * @param {object} part
 * @param {Set<string>} checked
 * @returns {boolean}
 */
function sends(part, checked) {
  if (part.locked) {
    return true;
  }
  return !part.sent && !part.tooLarge && checked.has(part.id);
}
