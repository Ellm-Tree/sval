/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Keeps a headless browser off the desktop it runs on.
 *
 * Headless Gecko gives every window a widget with no OS window behind it
 * (`HeadlessWidget`), but a few paths reach the platform without a window:
 *
 * - Native menus. On macOS a XUL `menupopup` opened by `openPopup` or
 *   `openPopupAtScreen` becomes an `NSMenu` whenever
 *   `widget.macos.native-anchored-menus` or `widget.macos.native-context-menus`
 *   allows it (`NativeMenuSupport::ShouldUseNativeContextMenus`, which does not
 *   ask whether the process is headless). `MOZMenuOpeningCoordinator` pops that
 *   menu up at screen coordinates with no view, so it draws on the real
 *   display and its tracking loop takes the keyboard. `<select>` lists go the
 *   same way through `widget.macos.allow-native-select` (`SelectParent`).
 * - Modal pickers and dialogs: the platform's file picker, colour picker and
 *   print dialog are made by contract and run their own panels.
 * - The system notification backend (`alerts.useSystemBackend`), which posts
 *   to the OS notification centre.
 *
 * In a headless process each of these is turned off or replaced at
 * `browser-before-ui-startup`, before any window exists. Menus fall back to
 * Gecko's own popups, which headless draws into `HeadlessWidget`s like every
 * other window. The pickers and the print dialog answer as a person who
 * cancelled would, since nobody can see them to answer. A test's mock picker
 * registers over `@mozilla.org/filepicker;1` and so still comes first; these
 * replace only the platform classes behind it.
 *
 * Prefs are set on the default branch, so a user-branch value a profile
 * already holds stays its own and a headless run writes nothing to prefs.js.
 */

const NATIVE_UI_PREFS = [
  "widget.macos.native-anchored-menus",
  "widget.macos.native-context-menus",
  "widget.macos.allow-native-select",
  "alerts.useSystemBackend",
];

function emptyEnumerator() {
  return Cc["@mozilla.org/array;1"]
    .createInstance(Ci.nsIMutableArray)
    .enumerate();
}

/** Refuses every file picker it is asked to open. */
class HeadlessFilePicker {
  QueryInterface = ChromeUtils.generateQI(["nsIFilePicker"]);

  defaultString = "";
  defaultExtension = "";
  filterIndex = 0;
  displayDirectory = null;
  displaySpecialDirectory = "";
  addToRecentDocs = false;
  okButtonLabel = "";
  capture = Ci.nsIFilePicker.captureNone;
  #mode = Ci.nsIFilePicker.modeOpen;

  init(_bc, _title, mode) {
    this.#mode = mode;
  }
  isModeSupported() {
    return Promise.resolve(true);
  }
  appendFilters() {}
  appendFilter() {}
  appendRawFilter() {}
  get mode() {
    return this.#mode;
  }
  get file() {
    return null;
  }
  get fileURL() {
    return null;
  }
  get files() {
    return emptyEnumerator();
  }
  get domFileOrDirectory() {
    return null;
  }
  get domFileOrDirectoryEnumerator() {
    return emptyEnumerator();
  }
  get domFilesInWebKitDirectory() {
    return emptyEnumerator();
  }
  open(callback) {
    Services.tm.dispatchToMainThread(() =>
      callback?.done(Ci.nsIFilePicker.returnCancel)
    );
  }
}

/** Closes every colour picker unchanged. */
class HeadlessColorPicker {
  QueryInterface = ChromeUtils.generateQI(["nsIColorPicker"]);

  init() {}
  open(callback) {
    Services.tm.dispatchToMainThread(() => callback?.done(""));
  }
}

/** Cancels every print and page setup dialog. */
const headlessPrintDialog = {
  QueryInterface: ChromeUtils.generateQI(["nsIPrintDialogService"]),
  init() {},
  showPrintDialog() {
    return Promise.reject(Components.Exception("", Cr.NS_ERROR_ABORT));
  },
  showPageSetupDialog() {
    return Promise.reject(Components.Exception("", Cr.NS_ERROR_ABORT));
  },
};

/** Each platform class a headless process replaces, by contract. */
const REPLACEMENTS = [
  {
    contractID: "@mozilla.org/parent/filepicker;1",
    classID: Components.ID("{6f0b6f43-2d4e-4a41-9a7e-3f1b8c2d5e10}"),
    create: () => new HeadlessFilePicker(),
  },
  {
    contractID: "@mozilla.org/parent/colorpicker;1",
    classID: Components.ID("{0c5d7a8e-91b2-4f3c-8e6a-2b4d9f1c7a21}"),
    create: () => new HeadlessColorPicker(),
  },
  {
    contractID: "@mozilla.org/widget/printdialog-service;1",
    classID: Components.ID("{a2e4c6b8-3f51-4d7e-b9a0-5c8e1f2d4b32}"),
    create: () => headlessPrintDialog,
  },
];

function isHeadless() {
  try {
    return Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless;
  } catch {
    return Services.env.get("MOZ_HEADLESS") === "1";
  }
}

export const SvalHeadless = {
  /** Whether {@link init} found the process headless and guarded it. */
  guarded: false,

  /** The prefs a headless process turns off. */
  NATIVE_UI_PREFS,

  /** The contracts a headless process answers itself. */
  REPLACED_CONTRACTS: REPLACEMENTS.map(r => r.contractID),

  /** The classes that answer them. */
  REPLACED_CLASS_IDS: REPLACEMENTS.map(r => r.classID),

  /**
   * `browser-before-ui-startup`: in a headless process, turns native menus
   * and system notifications off and replaces the platform's pickers and
   * print dialog. Does nothing in a process with a display.
   */
  init() {
    if (this.guarded || !isHeadless()) {
      return;
    }
    const defaults = Services.prefs.getDefaultBranch("");
    for (const pref of NATIVE_UI_PREFS) {
      defaults.setBoolPref(pref, false);
    }
    const registrar = Components.manager.QueryInterface(
      Ci.nsIComponentRegistrar
    );
    for (const { contractID, classID, create } of REPLACEMENTS) {
      registrar.registerFactory(
        classID,
        `sval headless: ${contractID}`,
        contractID,
        {
          QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
          createInstance: iid => create().QueryInterface(iid),
        }
      );
    }
    this.guarded = true;
  },
};
