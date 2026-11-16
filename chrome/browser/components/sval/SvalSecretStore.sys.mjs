/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's secrets, kept out of anything that copies the profile (key-storage
 * spec, "Where the sync key is kept").
 *
 * `nsIOSKeyStore` holds one secret of its own under a label, in Keychain,
 * Credential Manager or Secret Service. It cannot hold bytes Sval chose. So
 * each secret is stored here encrypted under that system secret, in
 * `sval-secrets.json` in the profile, and the system store holds only what
 * unlocks it. A copy of the profile carries ciphertext and nothing that opens
 * it.
 *
 * **The system store is asked once per run.** On macOS every Keychain read by
 * an app the item does not trust is a prompt, and `nsIOSKeyStore` reads the
 * Keychain again for each encryption and decryption. So Sval reads the system
 * secret once, through `asyncGetRecoveryPhrase`, keeps it as a
 * non-extractable key, and seals with it as `OSKeyStore` does
 * (`AbstractOSKeyStore::DoCipher`: AES-GCM, a 12-byte IV before the
 * ciphertext, base64). A refusal is kept too, so one prompt the user denied
 * is not followed by another; {@link SvalSecretStore.retry} asks again when
 * the user does.
 *
 * **The label is per user of this machine, never per profile.** Keychain,
 * Credential Manager and Secret Service entries outlive an uninstall and a
 * deleted profile, so a Sval installed again for the same user can open what
 * the last one wrapped: the copy of the sync key it left in the shared folder
 * (key-storage spec, "Installing again"). Every profile of the user shares
 * the one system secret, so Sval never removes it.
 *
 * **A Mac build that is not the one Sval ships has a label of its own.** A
 * dev build's bundle is given another identifier before launch
 * (`scripts/lib/launch.sh`, `sign_dev_bundle`), while its compiled-in
 * `MOZ_MACBUNDLE_ID` stays the release's. The label follows the identifier
 * macOS reports for the running bundle, so a dev build never reads, or
 * replaces, the secret an installed Sval keeps.
 *
 * **A Linux machine with no keyring keeps the secrets in the profile.**
 * libsecret may be absent, or present with no Secret Service answering; either
 * way the system store cannot be used. The threat model trusts the device and
 * keeps the provider out (spec §6.5), so a profile-held secret is the honest
 * fallback, and Settings says it is in use. The choice is made once, when the
 * first secret is written, and recorded: a keyring that appears later must not
 * hide a secret already kept in the profile.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { writePrivateJSON } from "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs";
import { readJSONOrNull } from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { sameBytes } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "keyStore", () =>
  Cc["@mozilla.org/security/oskeystore;1"].getService(Ci.nsIOSKeyStore)
);

const FILENAME = "sval-secrets.json";

/** The system store's secret for this user of this machine; see above. */
const USER_LABEL = "Sval secrets";

/**
 * Under automation, a label that is no user's: set, Sval uses the real
 * `nsIOSKeyStore` under it in place of a {@link MemoryKeyStore}. Outside
 * automation it is never read, so no pref moves a user's secrets.
 */
export const TEST_LABEL_PREF = "browser.sval.secrets.testLabel";

/** {@link TEST_LABEL_PREF}'s label, or the empty string. */
function testLabel() {
  return Cu.isInAutomation
    ? Services.prefs.getStringPref(TEST_LABEL_PREF, "")
    : "";
}

/** `kCFStringEncodingUTF8`. */
const UTF8 = 0x08000100;

/**
 * The identifier macOS reports for the running main bundle
 * (`CFBundleGetIdentifier`), or null when it has none.
 *
 * @returns {string|null}
 */
function mainBundleIdentifier() {
  const { ctypes } = lazy;
  const cf = ctypes.open(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
  );
  try {
    const ref = ctypes.voidptr_t;
    const getMainBundle = cf.declare(
      "CFBundleGetMainBundle",
      ctypes.default_abi,
      ref
    );
    const getIdentifier = cf.declare(
      "CFBundleGetIdentifier",
      ctypes.default_abi,
      ref,
      ref
    );
    const getCString = cf.declare(
      "CFStringGetCString",
      ctypes.default_abi,
      ctypes.uint8_t,
      ref,
      ctypes.char.ptr,
      ctypes.long,
      ctypes.uint32_t
    );
    // Both are CoreFoundation "Get" calls: the caller owns nothing to release.
    const bundle = getMainBundle();
    const id = bundle.isNull() ? bundle : getIdentifier(bundle);
    if (id.isNull()) {
      return null;
    }
    const buffer = ctypes.char.array(256)();
    return getCString(id, buffer, buffer.length, UTF8)
      ? buffer.readString()
      : null;
  } finally {
    cf.close();
  }
}

let bundleIdentifierRead;

/** `AbstractOSKeyStore`'s IV length; the IV leads each sealed secret. */
const IV_BYTES = 12;

/** Where the secrets are kept. */
export const BACKENDS = Object.freeze({
  system: "system",
  profile: "profile",
});

/**
 * The secret was stored and cannot be read at the moment: a Keychain locked
 * by hand, or a system store that refused. Trying again later may work.
 */
export class SvalSecretUnreadableError extends Error {
  name = "SvalSecretUnreadableError";
}

/**
 * The secret was stored and what unlocks it is gone: the system store does
 * not hold this profile's secret. A new computer, a reset Windows
 * password, or a profile copied between machines. Trying again will not help.
 */
export class SvalSecretLostError extends Error {
  name = "SvalSecretLostError";
}

function toBase64(bytes) {
  return Uint8Array.from(bytes).toBase64();
}

function fromBase64(text) {
  return Uint8Array.fromBase64(text);
}

/**
 * A system store held in memory, with `nsIOSKeyStore`'s shape, for automation.
 *
 * The label is per user, so a test run against the real store under it would
 * read and replace the developer's own system secret. Tests reach the failure
 * states through `failing`. A test of the real store names a label of its own
 * through {@link TEST_LABEL_PREF}.
 */
export class MemoryKeyStore {
  /** Label to secret bytes. */
  secrets = new Map();

  /**
   * Which calls fail, by method name, with the error each throws: a test sets
   * `failing.asyncGetRecoveryPhrase = new Error("locked")` to lock the store.
   */
  failing = {};

  #check(method) {
    if (this.failing[method]) {
      throw this.failing[method];
    }
  }

  async asyncGenerateSecret(label) {
    this.#check("asyncGenerateSecret");
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    this.secrets.set(label, secret);
    return "";
  }

  async asyncGetRecoveryPhrase(label) {
    this.#check("asyncGetRecoveryPhrase");
    const secret = this.secrets.get(label);
    if (!secret) {
      throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
    }
    return toBase64(secret);
  }

  async asyncDeleteSecret(label) {
    this.#check("asyncDeleteSecret");
    this.secrets.delete(label);
  }
}

/**
 * `bytes` sealed under `key` as `OSKeyStore` seals them, so either can open
 * what the other sealed.
 *
 * @param {CryptoKey} key
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return toBase64(out);
}

/**
 * What {@link seal} or `OSKeyStore` sealed under `key`.
 *
 * @param {CryptoKey} key
 * @param {string} text
 * @returns {Promise<Uint8Array>}
 * @throws when `key` does not open it.
 */
async function open(key, text) {
  const bytes = fromBase64(text);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
      key,
      bytes.subarray(IV_BYTES)
    )
  );
}

/**
 * Whether libsecret can be loaded, which is how `OSKeyStore` decides too
 * (`MaybeLoadLibSecret`). Only asked on Linux.
 *
 * @returns {boolean}
 */
function libsecretLoads() {
  try {
    lazy.ctypes.open("libsecret-1.so.0").close();
    return true;
  } catch {
    return false;
  }
}

export const SvalSecretStore = {
  BACKENDS,
  UnreadableError: SvalSecretUnreadableError,
  LostError: SvalSecretLostError,

  /**
   * The file's path. A test points it somewhere temporary; the default is
   * this profile's own directory.
   */
  path: null,

  /**
   * The store in use in place of `nsIOSKeyStore`, or null for the real one.
   * Automation gets a {@link MemoryKeyStore} unless a test sets its own or
   * sets {@link TEST_LABEL_PREF}.
   */
  keyStore: null,

  /** Whether this machine can use the system store; a test overrides it. */
  systemStoreUsable: null,

  /**
   * The running Mac bundle's identifier, or null off a Mac or with none.
   *
   * @returns {string|null}
   */
  bundleIdentifier() {
    if (bundleIdentifierRead === undefined) {
      bundleIdentifierRead =
        AppConstants.platform === "macosx" ? mainBundleIdentifier() : null;
    }
    return bundleIdentifierRead;
  },

  /**
   * The label of this user's system secret for this build; see above. It is
   * the name of the item the Keychain shows, and Settings names it.
   *
   * @returns {string}
   */
  userLabel() {
    const test = testLabel();
    if (test) {
      return test;
    }
    const id = this.bundleIdentifier();
    return id && id !== AppConstants.MOZ_MACBUNDLE_ID
      ? `${USER_LABEL} (${id})`
      : USER_LABEL;
  },

  /** Every write; see {@link _oneAtATime}. */
  _writes: new SvalSerialQueue("secret store writes"),

  /**
   * The system secret as read this run: `{store, label, promise}`, the
   * promise resolving to the key or rejecting with the store's refusal. See
   * {@link _systemKey}.
   */
  _key: null,

  _path() {
    return this.path ?? PathUtils.join(PathUtils.profileDir, FILENAME);
  },

  _store() {
    if (!this.keyStore && Cu.isInAutomation && !testLabel()) {
      this.keyStore = new MemoryKeyStore();
    }
    return this.keyStore ?? lazy.keyStore;
  },

  _systemStoreUsable() {
    if (this.systemStoreUsable !== null) {
      return this.systemStoreUsable;
    }
    if (this._store() !== lazy.keyStore) {
      return true;
    }
    return AppConstants.platform !== "linux" || libsecretLoads();
  },

  /**
   * Runs `work` after every write already queued, so two writers never read
   * the same file and each write half of it back.
   *
   * @param {Function} work
   * @returns {Promise<*>} what `work` resolves to.
   */
  _oneAtATime(work) {
    return this._writes.run(work);
  },

  /**
   * The file, or null when there is none. A file that exists and cannot be
   * read is a throw: every secret in it would otherwise look absent, and an
   * absent secret is one a caller may replace.
   *
   * @returns {Promise<object|null>}
   */
  async _readFile() {
    const path = this._path();
    let stored;
    try {
      stored = await readJSONOrNull(path);
    } catch (err) {
      throw Object.assign(
        new Error(
          `sval: ${path} exists and could not be read, so no secret in it can ` +
            `be used: ${err.name}: ${err.message}`
        ),
        { code: "file_unreadable" }
      );
    }
    if (stored === null) {
      return null;
    }
    if (
      !Object.values(BACKENDS).includes(stored?.backend) ||
      typeof stored.label !== "string" ||
      typeof stored.secrets !== "object" ||
      stored.secrets === null
    ) {
      throw new Error(`sval: ${path} is not a Sval secrets file`);
    }
    return stored;
  },

  async _writeFile(contents) {
    const path = this._path();
    await writePrivateJSON(path, contents);
  },

  /**
   * Where secrets are kept: the system store, or this profile on a machine
   * without one. Null before the first secret is written.
   *
   * @returns {Promise<string|null>} one of {@link BACKENDS}, or null.
   */
  async backend() {
    return (await this._readFile())?.backend ?? null;
  },

  /**
   * The secret called `name`, or null when none is stored.
   *
   * @param {string} name
   * @returns {Promise<Uint8Array|null>}
   * @throws {SvalSecretUnreadableError} when the system store will not answer.
   * @throws {SvalSecretLostError} when it does not hold this profile's
   *   secret.
   */
  async read(name) {
    const file = await this._readFile();
    const stored = file?.secrets[name];
    if (typeof stored !== "string") {
      return null;
    }
    if (file.backend === BACKENDS.profile) {
      return fromBase64(stored);
    }
    // A file sealed under another build's label is lost to this one: reading
    // that label would read the other build's secret.
    const key =
      file.label === this.userLabel()
        ? await this._systemKey(file.label)
        : null;
    if (!key) {
      throw new SvalSecretLostError(
        "sval: the system store no longer holds what unlocks this profile's " +
          "secrets"
      );
    }
    try {
      return await open(key, stored);
    } catch (err) {
      throw new SvalSecretUnreadableError(
        `sval: the system store would not unlock ${name}: ` +
          `${err?.message ?? err}`
      );
    }
  },

  /**
   * Stores `bytes` as `name`, replacing what was there, and reads it back.
   *
   * The file is replaced whole, through a temporary file, so a crash leaves
   * the old secret or the new one and never neither.
   *
   * @param {string} name
   * @param {Uint8Array} bytes
   */
  write(name, bytes) {
    const copy = Uint8Array.from(bytes);
    return this._oneAtATime(async () => {
      const file = (await this._readFile()) ?? (await this._firstFile());
      file.secrets[name] =
        file.backend === BACKENDS.profile
          ? toBase64(copy)
          : await this._encrypt(file, name, copy);
      await this._writeFile(file);
      const back = await this.read(name);
      if (!back || !sameBytes(back, copy)) {
        throw new Error(`sval: ${name} did not read back as it was written`);
      }
    });
  },

  /**
   * Removes `name`. Removing one that is not there does nothing.
   *
   * @param {string} name
   */
  remove(name) {
    return this._oneAtATime(async () => {
      const file = await this._readFile();
      if (!file || !(name in file.secrets)) {
        return;
      }
      delete file.secrets[name];
      await this._writeFile(file);
    });
  },

  /**
   * The file for a profile that has stored nothing yet, with the backend
   * chosen. On Linux a system store that cannot make its secret is a machine
   * with no Secret Service answering, which is the profile backend too.
   *
   * @returns {Promise<object>}
   */
  async _firstFile() {
    const file = {
      backend: BACKENDS.profile,
      label: this.userLabel(),
      secrets: {},
    };
    if (!this._systemStoreUsable()) {
      return file;
    }
    // The backend chosen here is kept for good, so a refusal remembered from
    // earlier in the run must not decide it. A secret already read this run
    // is used as it is: on a Mac, reading it again is another prompt.
    await this._forgetRefusal();
    try {
      await this._systemSecret(file.label);
      file.backend = BACKENDS.system;
    } catch (err) {
      if (AppConstants.platform !== "linux") {
        throw err;
      }
    }
    return file;
  },

  /**
   * `bytes` sealed under this user's system secret, for a copy kept outside
   * the profile: in the shared folder, where only this user on this machine
   * can open it. Null on a machine whose secrets are kept in the profile,
   * which has no system secret to seal under.
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<string|null>}
   */
  async wrap(bytes) {
    const file = await this._readFile();
    if (
      file?.backend === BACKENDS.profile ||
      (!file && !this._systemStoreUsable())
    ) {
      return null;
    }
    const label = this.userLabel();
    let key = await this._systemKey(label);
    if (!key) {
      if (file?.label === label && Object.keys(file.secrets).length) {
        throw new SvalSecretLostError(
          "sval: the system store no longer holds this user's secret"
        );
      }
      key = await this._generate(label);
    }
    return seal(key, bytes);
  },

  /**
   * What `wrap` sealed, or null when this user's system secret does not open
   * it: another user's or another machine's copy, or one from a store since
   * wiped.
   *
   * @param {string} text
   * @returns {Promise<Uint8Array|null>}
   */
  async unwrap(text) {
    try {
      const key = await this._systemKey(this.userLabel());
      return key ? await open(key, text) : null;
    } catch {
      return null;
    }
  },

  /**
   * Forgets what the system store answered this run, so the next secret
   * asks it again. For a step the user takes, such as Try again: only then
   * may the store show a prompt the user already answered.
   */
  retry() {
    this._key = null;
  },

  /** Forgets a refusal the system store gave this run, and nothing else. */
  async _forgetRefusal() {
    const entry = this._key;
    const refused = await entry?.promise.then(
      () => false,
      () => true
    );
    if (refused && this._key === entry) {
      this._key = null;
    }
  },

  /**
   * Makes sure the system store holds `label`'s secret.
   *
   * @param {string} label
   */
  async _systemSecret(label) {
    if (!(await this._systemKey(label))) {
      await this._generate(label);
    }
  },

  /**
   * `label`'s system secret as a key, or null when the store holds none. Read
   * from the store once per run (see above). A secret that is not there is
   * asked for again next time, since a later write may make it.
   *
   * @param {string} label
   * @returns {Promise<CryptoKey|null>}
   * @throws {SvalSecretUnreadableError} when the store will not answer.
   */
  _systemKey(label) {
    const store = this._store();
    if (this._key?.store === store && this._key.label === label) {
      return this._key.promise;
    }
    const entry = { store, label };
    entry.promise = (async () => {
      let phrase;
      try {
        phrase = await store.asyncGetRecoveryPhrase(label);
      } catch (err) {
        if (err?.result === Cr.NS_ERROR_NOT_AVAILABLE) {
          return null;
        }
        throw new SvalSecretUnreadableError(
          `sval: the system store did not answer: ${err?.message ?? err}`
        );
      }
      return crypto.subtle.importKey(
        "raw",
        fromBase64(phrase),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
      );
    })();
    this._key = entry;
    entry.promise.then(
      key => {
        if (!key && this._key === entry) {
          this._key = null;
        }
      },
      () => {}
    );
    return entry.promise;
  },

  /**
   * Makes `label`'s system secret and returns it as a key.
   *
   * @param {string} label
   * @returns {Promise<CryptoKey>}
   */
  async _generate(label) {
    await this._store().asyncGenerateSecret(label);
    this._key = null;
    const key = await this._systemKey(label);
    if (!key) {
      throw new SvalSecretUnreadableError(
        "sval: the system store did not keep the secret it made"
      );
    }
    return key;
  },

  /**
   * `bytes` encrypted under the profile's system secret.
   *
   * A system secret that is not there is made only when nothing else depends
   * on it. Every secret in the file shares the one label, so replacing it for
   * one write would leave the others unopenable for good, and would turn a
   * key that pairing could bring back into one that reads as a store that is
   * merely refusing. A Linux keyring that is locked can also answer "not
   * there" (`LibSecret.cpp`, `RetrieveSecret`), and replacing it then would
   * destroy what it held.
   *
   * @param {object} file The secrets file.
   * @param {string} name The secret being written.
   * @param {Uint8Array} bytes
   * @returns {Promise<string>}
   */
  async _encrypt(file, name, bytes) {
    const others = Object.keys(file.secrets).some(other => other !== name);
    if (file.label !== this.userLabel()) {
      if (others) {
        throw new SvalSecretLostError(
          "sval: this profile's other secrets are sealed under another " +
            "build's system secret, so it was not replaced"
        );
      }
      file.label = this.userLabel();
    }
    let key = await this._systemKey(file.label);
    if (!key) {
      if (others) {
        throw new SvalSecretLostError(
          "sval: the system store no longer holds what unlocks this " +
            "profile's other secrets, so it was not replaced"
        );
      }
      key = await this._generate(file.label);
    }
    return seal(key, bytes);
  },
};
