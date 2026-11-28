/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Performance recordings: Gecko's profiler, started in the
 * running Sval and saved as a gzipped profile in the download folder, which
 * the system's file manager then shows. Nothing is uploaded, and a saved
 * profile goes nowhere Sval sends things: it holds the addresses of the
 * pages that were open, so it stays a file the user hands on by choice.
 *
 * Whether a recording runs is the profiler's own state
 * (`Services.profiler.IsActive`), so a recording about:processes started
 * for one process is the one Help › Save Performance Recording saves.
 *
 * **No recording holds a private window's pages.** Gecko's profiler has no
 * feature that leaves private browsing out (`PROFILER_FOR_EACH_FEATURE`,
 * ProfilerState.h), so a recording cannot start while a private window is
 * open, and one that runs when a private window opens is stopped and
 * dropped unsaved. That holds for a recording Sval did not start: one from
 * `MOZ_PROFILER_STARTUP`, or from the signal that starts the profiler
 * (`profiler_start_from_signal`, platform.cpp).
 *
 * **Nor does any other diagnostic file.** Gecko's logging names the
 * addresses it works on, and about:memory's saved reports and GC and CC logs
 * name each document by its address. So logging to a file stops when a
 * private window opens, and about:logging and about:memory cannot start or
 * save either while one is open ({@link SvalProfiler.holdWhilePrivate}).
 */

import { HELP_MENU_ITEM_ID as FEEDBACK_ITEM_ID } from "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  presets: "resource://devtools/shared/performance-new/prefs-presets.sys.mjs",
});

/**
 * The profile keeps the last minute: long enough to hold a slow stretch the
 * user noticed, then reached for the menu.
 */
export const BUFFER_SECONDS = 60;

/** The Help menu's item, and its labels while idle and while recording. */
export const HELP_MENU_ITEM_ID = "sval-help-record-performance";
export const RECORD_LABEL = "Record Performance";
export const SAVE_LABEL = "Save Performance Recording";

/**
 * Firefox's Graphics and Media presets together (`presets`,
 * prefs-presets.sys.mjs): the threads that draw, composite and present,
 * those that decode, capture and send media, and every process's main
 * thread. The GPU process's threads are among them.
 *
 * @returns {{entries: number, interval: number, features: string[], threads: string[]}}
 */
export function recordingSettings() {
  const { graphics, media } = lazy.presets;
  return {
    entries: Math.max(graphics.entries, media.entries),
    interval: Math.min(graphics.interval, media.interval),
    features: [...new Set([...graphics.features, ...media.features])],
    threads: [...new Set([...graphics.threads, ...media.threads])],
  };
}

/**
 * The saved file's name, from the local time `date` holds.
 *
 * @param {Date} date
 * @returns {string}
 */
export function profileFileName(date) {
  const two = n => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `sval-performance-${day}-${time}.json.gz`;
}

/** Called whenever {@link SvalProfiler.canRecord} may have changed. */
const listeners = new Set();

/**
 * Gecko's logging prefs: a module's level is `logging.<module>`, and
 * `logging.config.` holds what names no module. Of those, about:logging's
 * Stop Logging clears the three in `LOGGING_OPTIONS` and turns
 * `LOGGING_RUNNING_PREF` off.
 */
const LOGGING_BRANCH = "logging.";
const LOGGING_CONFIG = "config.";
const LOGGING_OPTIONS = [
  "config.LOG_FILE",
  "config.add_timestamp",
  "config.sync",
];
const LOGGING_RUNNING_PREF = "logging.config.running";

export const SvalProfiler = {
  /** Whether a recording runs, in this process's profiler. */
  get recording() {
    return Services.profiler.IsActive();
  },

  /**
   * Whether a recording may start or be saved: no private window is open.
   * The window mediator lists a window from its opening on
   * (`nsWindowMediator::RegisterWindow`), ahead of `domwindowopened`, where
   * `BrowserWindowTracker` lists it only once it loads.
   */
  get canRecord() {
    for (const win of Services.wm.getEnumerator(null)) {
      if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        return false;
      }
    }
    return true;
  },

  /**
   * Calls `fn` whenever {@link SvalProfiler.canRecord} may have changed.
   *
   * @param {Function} fn
   * @returns {Function} Stops the calls.
   */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Stops a running recording and drops it, when the window that opened is
   * private.
   *
   * @param {Window} win A window, as it opens.
   */
  windowOpened(win) {
    if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    if (this.recording) {
      Services.profiler.StopProfiler();
    }
    this.stopLogging();
    this.changed();
  },

  /**
   * `profiler-started`: stops, unsaved, a recording that starts while a
   * private window is open. Sval's own starts never get here
   * ({@link SvalProfiler.start}); the profiler's signal and its other
   * callers do.
   */
  profilerStarted() {
    if (!this.canRecord && this.recording) {
      Services.profiler.StopProfiler();
    }
  },

  /**
   * Stops Gecko's logging to a file, as about:logging's Stop Logging does
   * (`stopLogging`, aboutLogging.mjs): the log file goes back to none, every
   * module's level to its default, and the page's own mark that logging runs
   * is cleared. `LogModulePrefWatcher` applies each as the pref changes.
   * Logging set up in the environment (`MOZ_LOG`, `MOZ_LOG_FILE`) is no
   * pref's and stays.
   */
  stopLogging() {
    const branch = Services.prefs.getBranch(LOGGING_BRANCH);
    for (const name of branch.getChildList("")) {
      if (!name.startsWith(LOGGING_CONFIG) || LOGGING_OPTIONS.includes(name)) {
        branch.clearUserPref(name);
      }
    }
    if (Services.prefs.getBoolPref(LOGGING_RUNNING_PREF, false)) {
      Services.prefs.setBoolPref(LOGGING_RUNNING_PREF, false);
    }
  },

  /**
   * Keeps each of `controls` disabled while a private window is open: the
   * buttons of a diagnostic page that would start or save something naming
   * the pages that are open. A control the page itself disabled stays as the
   * page left it.
   *
   * @param {Array<HTMLButtonElement|null>} controls All in one document.
   */
  holdWhilePrivate(controls) {
    const buttons = controls.filter(Boolean);
    if (!buttons.length) {
      return;
    }
    const held = new Set();
    const apply = () => {
      for (const button of buttons) {
        if (!this.canRecord && !button.disabled) {
          button.disabled = true;
          held.add(button);
        } else if (this.canRecord && held.delete(button)) {
          button.disabled = false;
        }
        button.toggleAttribute("data-sval-private-hold", held.has(button));
      }
    };
    apply();
    const win = buttons[0].documentGlobal;
    win.addEventListener("pageshow", apply);
    const stop = this.onChange(apply);
    win.addEventListener("unload", stop, { once: true });
  },

  /** Tells each {@link SvalProfiler.onChange} listener. */
  changed() {
    for (const fn of listeners) {
      fn();
    }
  },

  /**
   * Starts a recording of every process. Does nothing while one runs, or
   * while a private window is open.
   *
   * @returns {Promise<void>} Resolves once every process records.
   */
  async start() {
    if (this.recording || !this.canRecord) {
      return;
    }
    const { entries, interval, features, threads } = recordingSettings();
    await Services.profiler.StartProfiler(
      entries,
      interval,
      features,
      threads,
      0,
      BUFFER_SECONDS
    );
  },

  /**
   * Starts a recording of every thread of the process `pid`, as
   * about:processes' button on that process does. Does nothing while a
   * recording runs, or while a private window is open.
   *
   * @param {number} pid
   * @returns {Promise<void>}
   */
  async startProcess(pid) {
    if (this.recording || !this.canRecord) {
      return;
    }
    const { entries, interval, features } = recordingSettings();
    await Services.profiler.StartProfiler(
      entries,
      interval,
      features,
      [`pid:${pid}`],
      0,
      BUFFER_SECONDS
    );
  },

  /**
   * Stops the recording and writes it to the download folder, as devtools
   * collects one (`getProfileDataAsGzippedArrayBufferThenStop`): paused
   * first, so no samples gather while the other processes answer.
   *
   * A private window that opened while the profile was gathered drops it.
   *
   * @returns {Promise<string|null>} The file's path, or null when nothing
   *   was saved.
   */
  async save() {
    if (!this.recording || Services.profiler.IsPaused()) {
      return null;
    }
    Services.profiler.Pause();
    let profile;
    try {
      ({ profile } =
        await Services.profiler.getProfileDataAsGzippedArrayBuffer());
    } finally {
      Services.profiler.StopProfiler();
    }
    if (!this.canRecord) {
      return null;
    }
    const dir = await lazy.Downloads.getPreferredDownloadsDirectory();
    const path = PathUtils.join(dir, profileFileName(new Date()));
    await IOUtils.write(path, new Uint8Array(profile), { mode: "create" });
    return path;
  },

  /**
   * Saves the recording and shows the file in the system's file manager.
   *
   * @returns {Promise<string|null>} As {@link SvalProfiler.save}.
   */
  async saveAndReveal() {
    let path = null;
    try {
      path = await this.save();
    } catch (err) {
      lazy.SvalLog.warn(
        `a performance recording failed to save: ${lazy.SvalLog.errorName(err)}`
      );
      return null;
    }
    if (path) {
      this.revealFile(path);
    }
    return path;
  },

  /**
   * Shows the file at `path` in the system's file manager.
   *
   * @param {string} path
   */
  revealFile(path) {
    new lazy.FileUtils.File(path).reveal();
  },

  /**
   * Starts a recording, or saves the one that runs.
   *
   * @returns {Promise<string|null>} The saved file's path, or null.
   */
  async toggle() {
    if (this.recording) {
      return this.saveAndReveal();
    }
    await this.start();
    return null;
  },

  /** What a control that starts or saves a recording says right now. */
  get label() {
    return this.recording ? SAVE_LABEL : RECORD_LABEL;
  },

  /**
   * about:support's button, which starts or saves a recording, disabled
   * while a private window is open. It is worded again each time the page
   * is shown, since a recording can start or stop elsewhere meanwhile.
   *
   * @param {HTMLButtonElement|null} button
   */
  mountButton(button) {
    if (!button) {
      return;
    }
    const doc = button.ownerDocument;
    let busy = false;
    const word = () => {
      button.textContent = this.label;
      button.toggleAttribute("data-recording", this.recording);
      button.disabled = busy || !this.canRecord;
    };
    word();
    doc.defaultView.addEventListener("pageshow", word);
    doc.addEventListener("visibilitychange", word);
    const stop = this.onChange(word);
    doc.defaultView.addEventListener("unload", stop, { once: true });
    button.addEventListener("click", async () => {
      busy = true;
      word();
      try {
        await this.toggle();
      } finally {
        busy = false;
        word();
      }
    });
  },

  /**
   * Help › Record Performance in the menu bar, after Send Feedback…, worded
   * for what it does next each time the menu opens, and disabled while a
   * private window is open. `data-recording` marks the item, and
   * about:support's button, while a recording runs.
   *
   * @param {Window} win A browser window, before its first layout, with
   *   Send Feedback… mounted (`SvalFeedbackForm.mountWindow`).
   */
  mountWindow(win) {
    const doc = win.document;
    const popup = doc.getElementById("menu_HelpPopup");
    const after = doc.getElementById(FEEDBACK_ITEM_ID);
    if (!popup || !after) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = HELP_MENU_ITEM_ID;
    item.setAttribute("label", RECORD_LABEL);
    item.addEventListener("command", () => this.toggle());
    after.after(item);
    popup.addEventListener("popupshowing", () => {
      item.setAttribute("label", this.label);
      item.toggleAttribute("data-recording", this.recording);
      item.toggleAttribute("disabled", !this.canRecord);
    });
  },
};

const observer = {
  observe(subject, topic) {
    if (topic === "domwindowopened") {
      SvalProfiler.windowOpened(subject);
    } else if (topic === "profiler-started") {
      SvalProfiler.profilerStarted();
    } else {
      SvalProfiler.changed();
    }
  },
};
// From the module's load, which a browser window's start causes
// (`SvalWindow`), so no private window opens unseen.
Services.obs.addObserver(observer, "domwindowopened");
Services.obs.addObserver(observer, "last-pb-context-exited");
Services.obs.addObserver(observer, "profiler-started");
// The window whose start loaded this module opened before it, and may be
// private, with a recording from `MOZ_PROFILER_STARTUP` already running.
if (!SvalProfiler.canRecord) {
  SvalProfiler.profilerStarted();
  SvalProfiler.stopLogging();
}
