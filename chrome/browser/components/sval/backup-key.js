/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The backup of the sync key, opened by `SvalBackupKey.sys.mjs` with
 * `{ keyBytes, fingerprint, checkDestination, saved }`. It sets `saved` when
 * the user copies, saves or prints it: each puts the key somewhere outside
 * this device. A classic script in a chrome document, so the modules come
 * through `ChromeUtils`.
 */

"use strict";

const { backupCode } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { writePrivateFile } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs"
);
const { SvalLog, describeError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);

const SvalBackupSheet = {
  _args: null,

  start() {
    this._args = window.arguments?.[0] ?? {};
    const code = backupCode(this._args.keyBytes);
    this._els = {
      code: document.querySelector(".sval-backup-code"),
      fingerprint: document.querySelector(".sval-backup-fingerprint"),
      status: document.querySelector(".sval-backup-status"),
      save: document.querySelector(".sval-backup-save"),
      print: document.querySelector(".sval-backup-print"),
      copy: document.querySelector(".sval-backup-copy"),
      done: document.querySelector(".sval-backup-done"),
    };
    this._code = code;
    // The code is one word to the line breaker, so it may break only at the
    // `wbr` after each dash, and never inside a group.
    this._els.code.replaceChildren(
      ...code
        .split("-")
        .flatMap((group, i, all) =>
          i < all.length - 1
            ? [`${group}-`, document.createElement("wbr")]
            : [group]
        )
    );
    this._els.fingerprint.textContent = `Fingerprint ${String(
      this._args.fingerprint ?? ""
    ).slice(0, 16)}`;
    this._els.save.addEventListener("click", () =>
      this.save().catch(err =>
        SvalLog.error(`the backup sheet's save failed: ${describeError(err)}`)
      )
    );
    this._els.print.addEventListener("click", () => this.print());
    this._els.copy.addEventListener("click", () => this.copy());
    this._els.done.addEventListener("click", () => window.close());
  },

  /** The text a saved backup holds: the code and the words around it. */
  _text() {
    return (
      "Sval sync key\n\n" +
      `${this._code}\n\n` +
      `${this._els.fingerprint.textContent}\n\n` +
      "This key unlocks your synced Sval Workspaces. Nobody can recover it " +
      "for you, not even Sval. Keep it as a secure note in your password " +
      "manager or somewhere else safe. Never keep it in your sync folder. If " +
      "you lose every device, set up Sval on a new one. Choose " +
      "\u201cUse my tabs and settings from another device\u201d, then your " +
      "sync folder. Choose \u201cRestore with your backup key\u201d and " +
      "paste this code.\n"
    );
  },

  async save() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      window.browsingContext,
      "Save your sync key",
      Ci.nsIFilePicker.modeSave
    );
    picker.defaultString = "Sval sync key.txt";
    picker.displayDirectory = Services.dirsvc.get("Docs", Ci.nsIFile);
    const result = await new Promise(resolve => picker.open(resolve));
    if (
      result !== Ci.nsIFilePicker.returnOK &&
      result !== Ci.nsIFilePicker.returnReplace
    ) {
      return;
    }
    await this.saveTo(picker.file.path);
  },

  /**
   * Writes the backup to `path`, unless that is inside the sync folder.
   *
   * @param {string} path
   */
  async saveTo(path) {
    const { verdict, text } = this._args.checkDestination(path);
    if (verdict === "refuse") {
      this._els.status.dataset.state = "refused";
      this._els.status.textContent = text;
      return;
    }
    // The file holds the key that opens every synced workspace, and the user
    // may save it anywhere, so it is written as Sval writes its own keys:
    // readable by its owner alone, and never through a file another user
    // left in its place.
    try {
      await writePrivateFile(path, new TextEncoder().encode(this._text()));
    } catch (err) {
      SvalLog.warn(`the key's backup was not saved: ${describeError(err)}`);
      this._els.status.dataset.state = "failed";
      this._els.status.textContent =
        "Sval couldn't save the key there. Choose another place, or copy it.";
      return;
    }
    this._args.saved = true;
    // A risky place stays open to say so; Done closes it.
    if (verdict === "warn") {
      this._els.status.dataset.state = "saved-warned";
      this._els.status.textContent = text;
      return;
    }
    window.close();
  },

  /**
   * Puts the code on the clipboard, for pasting into a password manager,
   * marked sensitive as Firefox marks a copied password, which keeps it out of
   * Windows' clipboard history and cloud clipboard.
   */
  copy() {
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(this._code, null, Ci.nsIClipboardHelper.Sensitive);
    this._args.saved = true;
    this._els.status.dataset.state = "copied";
    this._els.status.textContent =
      "Copied. Paste it into a secure note in your password manager.";
  },

  print() {
    window.print();
    this._args.saved = true;
  },
};

window.SvalBackupSheet = SvalBackupSheet;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => SvalBackupSheet.start(), {
    once: true,
  });
} else {
  SvalBackupSheet.start();
}
