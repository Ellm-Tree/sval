/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global Assert, info, registerCleanupFunction, do_get_profile */
/* exported BACKENDS, STOPPABLE, SvalSecretStore, TEST_LABEL_PREF,
   AppConstants, keyStore, labels, control, withLabel, secretsFile,
   randomBytes, same, step, skip_if */

/**
 * The OS key-store suite's shared setup: Sval's secrets in the platform's own
 * store, Keychain on macOS, the Secret Service through libsecret on Linux,
 * Credential Manager on Windows. The daily CI run sets SVAL_CI_OS_KEYSTORE=1
 * once it has set that store up, and names in SVAL_CI_OS_KEYSTORE_CONTROL the
 * script that stops and starts it. Without it
 * every task skips: a developer's machine holds the developer's own store.
 *
 * Each task names a label of its own (`TEST_LABEL_PREF`), so no task reads
 * another's system secret or a user's. A task that stops the store has a file
 * of its own, so nothing it leaves in the process reaches another task.
 */

const { SvalSecretStore, BACKENDS, TEST_LABEL_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
  );
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { ctypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

do_get_profile();

const ENABLED = Services.env.get("SVAL_CI_OS_KEYSTORE") === "1";
const CONTROL = Services.env.get("SVAL_CI_OS_KEYSTORE_CONTROL");
const skip_if = () => !ENABLED;

// One call to the system store. It never shows a prompt here (below), so one
// that does not answer is a fault of the setup, named by its step.
const STORE_MS = 20_000;

const keyStore = Cc["@mozilla.org/security/oskeystore;1"].getService(
  Ci.nsIOSKeyStore
);

const labels = [];

/**
 * Keychain shows a dialog where a read needs the user, as to unlock a locked
 * keychain. With interaction off it answers with an error instead
 * (`SecKeychainSetUserInteractionAllowed`), so a locked keychain fails here
 * as it does for a user who cancels the dialog, and nothing waits on a dialog
 * no one can answer. The setting is the process's.
 *
 * @param {boolean} allowed
 */
function keychainInteraction(allowed) {
  const security = ctypes.open(
    "/System/Library/Frameworks/Security.framework/Security"
  );
  try {
    const set = security.declare(
      "SecKeychainSetUserInteractionAllowed",
      ctypes.default_abi,
      ctypes.int32_t,
      ctypes.uint8_t
    );
    Assert.equal(set(allowed ? 1 : 0), 0, `Keychain interaction ${allowed}`);
  } finally {
    security.close();
  }
}

if (ENABLED && AppConstants.platform === "macosx") {
  keychainInteraction(false);
  registerCleanupFunction(() => keychainInteraction(true));
}

// Linux's keyring is the run's own, made by run-suite.sh, and goes with
// the run. Credential Manager is the runner user's and outlives the run, and
// a keychain may be the user's own, so the labels are removed there.
registerCleanupFunction(async () => {
  if (AppConstants.platform === "linux") {
    return;
  }
  for (const label of labels) {
    await within(
      keyStore.asyncDeleteSecret(label),
      STORE_MS,
      "removing a test label's system secret"
    );
  }
});

/**
 * Runs `action` through the job's switch for the store: `stop` makes the
 * store stop answering (Keychain locked, the Secret Service gone), `start`
 * brings it back as it was.
 *
 * @param {"stop"|"start"} action
 */
async function control(action) {
  Assert.ok(CONTROL, "SVAL_CI_OS_KEYSTORE_CONTROL names the store's switch");
  const run = async () => {
    const proc = await Subprocess.call({
      command: "/bin/bash",
      arguments: [CONTROL, action],
      stderr: "stdout",
    });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    const { exitCode } = await proc.wait();
    return { exitCode, out };
  };
  const { exitCode, out } = await within(
    run(),
    30_000,
    `the store's ${action} switch`
  );
  info(out);
  Assert.equal(exitCode, 0, `the store's ${action} switch worked`);
}

/** Whether this platform's store can be stopped. Credential Manager cannot. */
const STOPPABLE =
  AppConstants.platform === "macosx" || AppConstants.platform === "linux";

/**
 * Gives one task a label no other task has, a profile with no secrets file,
 * and a store that answers, and takes the label away after.
 *
 * @param {Function} work Called with the label.
 */
async function withLabel(work) {
  Assert.equal(SvalSecretStore.keyStore, null, "no store stands in");
  Assert.equal(
    SvalSecretStore.systemStoreUsable,
    null,
    "the store decides for itself whether the system store is usable"
  );
  if (STOPPABLE) {
    await control("start");
  }
  const label = `Sval secrets test ${Services.uuid
    .generateUUID()
    .toString()
    .slice(1, -1)}`;
  labels.push(label);
  Services.prefs.setStringPref(TEST_LABEL_PREF, label);
  await IOUtils.remove(secretsFile(), { ignoreAbsent: true });
  SvalSecretStore.retry();
  try {
    Assert.equal(SvalSecretStore.userLabel(), label, "the task's own label");
    await work(label);
  } finally {
    Services.prefs.clearUserPref(TEST_LABEL_PREF);
    SvalSecretStore.retry();
    if (STOPPABLE) {
      await control("start");
    }
  }
}

function secretsFile() {
  return PathUtils.join(PathUtils.profileDir, "sval-secrets.json");
}

function randomBytes() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function same(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * `promise`, bounded as one call to the system store.
 *
 * @param {Promise} promise
 * @param {string} what The call, as a failure names it.
 * @returns {Promise<*>}
 */
function step(promise, what) {
  return within(promise, STORE_MS, what);
}
