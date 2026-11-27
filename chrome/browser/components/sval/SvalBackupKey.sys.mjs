/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The backup of the sync key (key-storage spec, "Backup and recovery").
 *
 * Losing the sync key loses nothing while any device survives, because every
 * device keeps the whole tree in its own profile and can start over with a
 * new key. The backup is for when every device is gone at once. So it is
 * offered when a key is made, can be skipped, and is never read at startup:
 * Sval does not track where it went.
 *
 * **It must not sit beside what it unlocks.** The folder the key opens is in
 * a cloud account; a backup saved into that account hands the provider both.
 * A destination inside the shared folder is refused. One in the same cloud
 * account as the shared folder is saved, since the user chose it, and the
 * sheet says what that place risks.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";

const DIALOG_URL = "chrome://browser/content/sval/backup-key.xhtml";

/**
 * `path` as a file, with every link and alias on its way resolved by
 * `nsIFile.normalize` (`realpath` on macOS and Linux, which also gives each
 * name its case on disk). The file being saved does not exist yet, and a
 * root may not either, so the longest part of the path that exists is
 * resolved and the rest is appended as it was written.
 *
 * @param {string} path An absolute native path.
 * @returns {nsIFile}
 */
function resolved(path) {
  const rest = [];
  let at = new FileUtils.File(path);
  for (;;) {
    const file = at.clone();
    try {
      file.normalize();
    } catch {
      if (!at.parent) {
        return new FileUtils.File(path);
      }
      rest.unshift(at.leafName);
      at = at.parent;
      continue;
    }
    for (const leaf of rest) {
      file.append(leaf);
    }
    return file;
  }
}

/**
 * Whether `path` is `root` or inside it, as the file system resolves both, so
 * that neither a link nor another spelling of the same folder gets past it.
 * On Windows `nsIFile.contains` and `equals` compare without case, and
 * `normalize` resolves `.` and `..` but follows no junction or link
 * (`nsLocalFile::Resolve` in nsLocalFileWin.cpp has none), so there a
 * junction into the folder still passes.
 *
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function within(path, root) {
  const p = resolved(path);
  const r = resolved(root);
  return r.equals(p) || r.contains(p);
}

/**
 * The cloud account folder `path` is in, as a resolved file, or null outside
 * every provider's folder. Under macOS's `Library/CloudStorage` each File
 * Provider account has its own folder, so the account is the folder beneath
 * it; every other root is one account's.
 *
 * @param {string} path
 * @param {string[]} roots From `providerRoots`.
 * @returns {nsIFile|null}
 */
function accountOf(path, roots) {
  const p = resolved(path);
  for (const root of roots) {
    const r = resolved(root);
    if (!r.equals(p) && !r.contains(p)) {
      continue;
    }
    if (r.leafName !== "CloudStorage" || r.equals(p)) {
      return r;
    }
    let account = p;
    while (account.parent && !account.parent.equals(r)) {
      account = account.parent;
    }
    return account;
  }
  return null;
}

export const SvalBackupKey = {
  /**
   * The folders a provider's own client syncs, where a backup would reach
   * the cloud. A test replaces this.
   *
   * @returns {string[]}
   */
  providerRoots() {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const roots = [PathUtils.join(home, "Dropbox")];
    if (AppConstants.platform === "macosx") {
      roots.push(
        PathUtils.join(home, "Library", "CloudStorage"),
        PathUtils.join(home, "Library", "Mobile Documents")
      );
    }
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const root = Services.env.get(name);
      if (root) {
        roots.push(root);
      }
    }
    return roots;
  },

  /**
   * What Sval says about saving the backup at `path`.
   *
   * @param {string} path Where the user chose to save it.
   * @param {string|null} sharedRoot The folder the key opens.
   * @returns {{verdict: string, text: string|null}} `refuse`, which saves
   *   nothing; `warn`, which saves and says why the place is risky; or `ok`.
   */
  checkDestination(path, sharedRoot) {
    if (sharedRoot && within(path, sharedRoot)) {
      return {
        verdict: "refuse",
        text:
          "Sval can't save the sync key in the sync folder. Anyone who can " +
          "open the sync folder could read your Workspaces with the key. " +
          "Choose another place.",
      };
    }
    const roots = this.providerRoots();
    const account = sharedRoot && accountOf(sharedRoot, roots);
    const destination = account && accountOf(path, roots);
    if (destination && account.equals(destination)) {
      return {
        verdict: "warn",
        text:
          "Sval saved the sync key. The file is in the same cloud account " +
          "as the sync folder. Anyone who gets into the cloud account could " +
          "read your Workspaces. A password manager is a safer place for " +
          "the sync key.",
      };
    }
    return { verdict: "ok", text: null };
  },

  /**
   * Shows the backup in the window's dialog box.
   *
   * @param {Window} win A browser window.
   * @param {object} options
   * @param {Uint8Array} options.keyBytes The sync key.
   * @param {string} options.fingerprint Its non-secret fingerprint.
   * @param {string|null} options.sharedRoot The folder it opens.
   * @returns {Promise<boolean>} whether the user saved or printed it.
   */
  async show(win, { keyBytes, fingerprint, sharedRoot }) {
    const args = {
      keyBytes,
      fingerprint,
      checkDestination: path => this.checkDestination(path, sharedRoot),
      saved: false,
      getProperty: name => name === "async",
    };
    await win.gDialogBox?.open(DIALOG_URL, args);
    return args.saved;
  },
};
