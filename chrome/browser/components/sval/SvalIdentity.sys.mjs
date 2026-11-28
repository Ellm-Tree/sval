/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's local identity: the device id, which is public, and two keys. The
 * engine holds none of them. It takes them as arguments on every call and
 * persists nothing itself (host contract §4, §5).
 *
 * **The local key** encrypts this device's own copy in the profile. It is a
 * plain file beside that copy, made at first launch, and protects nothing:
 * it exists because the file format is encrypted, and anyone who can read the
 * profile can read Firefox's session files too (key-storage spec, "Two
 * keys"). It can never be locked, so this device's workspaces always open.
 *
 * **The sync key** encrypts the shared folder and names its directory
 * (`syncPrefix`). Only a device the user set up to share holds one, and it
 * lives in `SvalSecretStore`, out of anything that copies the profile. Holding
 * one never decides whether the user has workspaces: a device syncs because
 * the user set it up to.
 *
 * Every getter here generates only when nothing is recorded, and refuses when
 * something is recorded that cannot be read. A second device id orphans every
 * file published under the first; a second local key hides this device's own
 * copy; a second sync key splits the user's workspaces in two. None of those
 * is recoverable, so none may happen by accident. `sval-identity.json` records
 * the device id and a non-secret fingerprint of each key, and that record is
 * what tells "never made" from "made and gone".
 *
 * The identity file also records the device id the profile uses on each
 * computer, by a fingerprint of that computer, so a profile copied to another
 * computer is noticed before it publishes under the device id it brought
 * along; see {@link _onThisMachine}.
 *
 * A sync key that cannot be read stops syncing and nothing else. `syncKey()`
 * answers with a state and does not throw, because the panel starts either
 * way and only says why it is not syncing.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { writePrivateFile } from "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs";
import { readJSONOrNull } from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { toHex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSecretStore: "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
  SvalICloudKeychain:
    "moz-src:///browser/components/sval/SvalICloudKeychain.sys.mjs",
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
  WindowsRegistry: "resource://gre/modules/WindowsRegistry.sys.mjs",
});

/** Host contract §5. */
const DEVICE_ID_BYTES = 16;

/** Host contract §4. */
const KEY_BYTES = 32;

const IDENTITY_FILENAME = "sval-identity.json";
const LOCAL_KEY_FILENAME = "sval-local-key";

const SYNC_KEY_SECRET = "sync key";

/**
 * Why the device's identity or one of its keys was refused. Callers and tests
 * branch on `code`, because the message may be reworded.
 */
export class SvalIdentityError extends Error {
  name = "SvalIdentityError";

  /**
   * @param {string} code What was refused: `bad_key_length`,
   *   `identity_unreadable`, `bad_device_id`, `no_device_id`,
   *   `key_unreadable`, `wrong_key`, `key_missing` or `has_sync_key`.
   * @param {string} message What failed, for people.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * What `syncKey()` can answer.
 *
 * - `none`: this device was never set up to share.
 * - `present`: the key is here, and it is the one this device was using.
 * - `unreadable`: the store would not answer now. Trying again may work.
 * - `missing`: the key, or what unlocks it, is gone. Pairing brings it back.
 * - `different`: the store holds a key this device was not using.
 */
export const SYNC_KEY_STATES = Object.freeze({
  none: "none",
  present: "present",
  unreadable: "unreadable",
  missing: "missing",
  different: "different",
});

/**
 * @param {string} hex Lowercase hex.
 * @param {number} expectedBytes How many bytes `hex` must decode to.
 * @returns {Uint8Array|null} the bytes, or null if `hex` is not that.
 */
function fromHex(hex, expectedBytes) {
  if (
    typeof hex !== "string" ||
    hex.length !== expectedBytes * 2 ||
    !/^[0-9a-f]+$/.test(hex)
  ) {
    return null;
  }
  return Uint8Array.fromHex(hex);
}

/**
 * Domain separation for {@link fingerprintOf}, so the fingerprint is a
 * different hash from any other Sval derives from a key.
 */
const FINGERPRINT_LABEL = "sval document key fingerprint\u0000";

/**
 * Domain separation for {@link machineFingerprintOf}. The OS asks that its
 * machine id never be stored or shown as it is, only hashed with a key of the
 * application's own (machine-id(5)), and this label is Sval's.
 */
const MACHINE_LABEL = "sval machine fingerprint\u0000";

/**
 * SHA-256 over `label` and `bytes`, as hex.
 *
 * @param {string} label
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} 64 lowercase hex characters.
 */
async function labelledHash(label, bytes) {
  const prefix = new TextEncoder().encode(label);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

/**
 * A non-secret name for `bytes`: SHA-256 over a label and the key, as hex.
 *
 * The key is 256 random bits, so its hash reveals nothing usable about it.
 * The engine's `syncPrefix` cannot serve: it needs the wasm engine this key
 * is an input to, and hashes the document name with the key, so it names a
 * key and a document together.
 *
 * @param {Uint8Array} bytes A key.
 * @returns {Promise<string>} 64 lowercase hex characters.
 */
export function fingerprintOf(bytes) {
  return labelledHash(FINGERPRINT_LABEL, bytes);
}

/**
 * What the identity file records of the computer it is on: a hash of the
 * OS's machine id, which is the same for every profile and every user on that
 * computer and changes when the profile is copied to another.
 *
 * @param {string} machineId What {@link readMachineId} read.
 * @returns {Promise<string>} 64 lowercase hex characters.
 */
export function machineFingerprintOf(machineId) {
  return labelledHash(MACHINE_LABEL, new TextEncoder().encode(machineId));
}

/**
 * The Mac's IOPlatformUUID, from `gethostuuid(2)`, which answers with that
 * same value without the IOKit and CoreFoundation calls reading it directly
 * takes.
 *
 * @returns {string}
 */
function macPlatformUuid() {
  const ctypes = lazy.ctypes;
  const lib = ctypes.open("/usr/lib/libSystem.B.dylib");
  try {
    const Timespec = new ctypes.StructType("timespec", [
      { tv_sec: ctypes.long },
      { tv_nsec: ctypes.long },
    ]);
    const gethostuuid = lib.declare(
      "gethostuuid",
      ctypes.default_abi,
      ctypes.int,
      ctypes.uint8_t.array(16).ptr,
      Timespec.ptr
    );
    const uuid = ctypes.uint8_t.array(16)();
    const wait = new Timespec(1, 0);
    if (gethostuuid(uuid.address(), wait.address()) !== 0) {
      throw new Error(`gethostuuid failed: ${ctypes.errno}`);
    }
    const hex = toHex(Array.from(uuid)).toUpperCase();
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  } finally {
    lib.close();
  }
}

/**
 * The OS's id for this computer: IOPlatformUUID on macOS, MachineGuid on
 * Windows, /etc/machine-id on Linux.
 *
 * @returns {Promise<string|null>} the id, or null when it cannot be read.
 */
export async function readMachineId() {
  try {
    let id;
    switch (AppConstants.platform) {
      case "macosx":
        id = macPlatformUuid();
        break;
      case "win":
        id = lazy.WindowsRegistry.readRegKey(
          Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
          "SOFTWARE\\Microsoft\\Cryptography",
          "MachineGuid",
          Ci.nsIWindowsRegKey.WOW64_64
        );
        break;
      case "linux":
        id = await IOUtils.readUTF8("/etc/machine-id");
        break;
    }
    id = typeof id === "string" ? id.trim() : "";
    return id || null;
  } catch (err) {
    lazy.SvalLog.warn(
      `could not read this computer's machine id: ${lazy.describeError(err)}`
    );
    return null;
  }
}

/**
 * `value` as a key, or a throw.
 *
 * A copy, because the caller's array arrived from a worker and nothing should
 * be able to change a key after it has been stored. Shape-checked: the bytes
 * come from pairing's worker by way of a structured clone, and the length is
 * what matters. 31 bytes would be a key that never opens anything.
 *
 * @param {Uint8Array} value Candidate key bytes.
 * @returns {Uint8Array} exactly {@link KEY_BYTES} bytes.
 */
function asKey(value) {
  if (
    !ArrayBuffer.isView(value) ||
    value.length !== KEY_BYTES ||
    value.byteLength !== KEY_BYTES
  ) {
    throw new SvalIdentityError(
      "bad_key_length",
      `sval: a key is ${KEY_BYTES} bytes, so this one was not taken: ` +
        `${ArrayBuffer.isView(value) ? `${value.byteLength} bytes` : typeof value}`
    );
  }
  return Uint8Array.from(value);
}

function newKey() {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

export const SvalIdentity = {
  SYNC_KEY_STATES,
  fingerprintOf,

  /**
   * The in-flight or settled promise for each value, so two concurrent callers
   * share one generation instead of each making their own. Reset by
   * `forgetCachedValues`.
   */
  _deviceIdPromise: null,
  _localKeyPromise: null,

  /**
   * The identity file's path, and the local key's. Null is this profile's
   * own directory, because each identifies an installation.
   */
  path: null,
  localKeyPath: null,

  /**
   * This computer's machine id, or null when it cannot be read.
   *
   * @returns {Promise<string|null>}
   */
  readMachineId() {
    return readMachineId();
  },

  /**
   * Asks whether Sval's data moved here from the computer it last ran on,
   * or this computer is a new device beside that one, in Sval's dialog over
   * the most recent browser window (`openSvalDialog`). The device id is
   * settled as the first window's panel starts, so that window is the one
   * asked in.
   *
   * Dismissing the question answers "new device", as does a process with no
   * browser window to ask in: a new id costs the old one's watermarks, while
   * two computers under one id overwrite each other's file.
   *
   * @returns {Promise<boolean>} true when the user moved here.
   */
  async askIfMoved() {
    const { ok } = await lazy.openSvalDialog(
      Services.wm.getMostRecentWindow("navigator:browser"),
      {
        icon: "sval",
        state: "moved-here",
        focus: "cancel",
        title: "Did you move Sval to this computer?",
        body:
          "Sval was last used on another computer. If you moved Sval to " +
          "this computer, Sval keeps syncing as the same device. If you'll " +
          "keep using the other computer too, this computer syncs as a new " +
          "device.",
        primary: "Same device",
        secondary: "New device",
      }
    );
    return ok;
  },

  _keyWrites: new SvalSerialQueue("sync key writes"),

  /**
   * Runs `work` after every key write already queued, so two writes never
   * interleave.
   *
   * @param {Function} work
   * @returns {Promise<*>} what `work` resolves to.
   */
  _oneAtATime(work) {
    return this._keyWrites.run(work);
  },

  /**
   * The identity file's writes. The device id and the key
   * fingerprints share one file and are written by concurrent callers on
   * every first run, so each write re-reads the file and merges inside this
   * queue.
   */
  _identityWrites: new SvalSerialQueue("identity writes"),

  /**
   * Drops the memoised promises so the next call reads storage again. For
   * tests that need to observe what a restart would see.
   */
  forgetCachedValues() {
    this._deviceIdPromise = null;
    this._localKeyPromise = null;
  },

  _identityPath() {
    return this.path ?? PathUtils.join(PathUtils.profileDir, IDENTITY_FILENAME);
  },

  _localKeyPath() {
    return (
      this.localKeyPath ??
      PathUtils.join(PathUtils.profileDir, LOCAL_KEY_FILENAME)
    );
  },

  /**
   * The identity file's contents, or null when there is no file.
   *
   * @param {string} purpose What reading it was for, for the message.
   * @returns {Promise<object|null>}
   */
  async _readIdentity(purpose) {
    const path = this._identityPath();
    try {
      return await readJSONOrNull(path);
    } catch (err) {
      throw new SvalIdentityError(
        "identity_unreadable",
        `sval: the identity file at ${path} exists but could not be read, ` +
          `so ${purpose}: ${err.name}: ${err.message}`
      );
    }
  },

  /**
   * Merges `changes` into the identity file. A field set to null is removed.
   *
   * `tmpPath` keeps a crash mid-write from leaving a truncated file, which
   * every read of it would then refuse, and `flush` puts the bytes on disk
   * before the rename, so a power loss after it cannot leave an empty one
   * either: the file names the keys this device holds ({@link adoptSyncKey}).
   *
   * @param {object} changes The fields to set.
   * @returns {Promise<void>}
   */
  _updateIdentity(changes) {
    return this._identityWrites.run(async () => {
      const path = this._identityPath();
      const next = {
        ...((await this._readIdentity("nothing was written to it")) ?? {}),
        ...changes,
      };
      for (const [field, value] of Object.entries(next)) {
        if (value === null) {
          delete next[field];
        }
      }
      await IOUtils.writeJSON(path, next, {
        tmpPath: `${path}.tmp`,
        flush: true,
      });
    });
  },

  /**
   * This installation's device id: 16 bytes, generated once and persisted.
   *
   * Never regenerated by Sval on its own. A new id comes only from the user,
   * who says a profile that arrived from another computer is a new device
   * ({@link _onThisMachine}). Two devices sharing one id would both write the
   * same path, which the one-file-per-device layout exists to make
   * impossible: it keeps a cloud sync client's "conflicted copy" resolution
   * unable to touch workspace data (spec §6.2). A device that *changes* its id
   * is still lossy: every watermark its peers hold for the old id is
   * abandoned, so its earlier writes can never again be recognised as already
   * seen and deletions of those nodes stop propagating (host contract §5).
   *
   * @returns {Promise<Uint8Array>} the same 16 bytes on every call.
   */
  deviceId() {
    if (!this._deviceIdPromise) {
      this._deviceIdPromise = this._loadOrCreateDeviceId().catch(err => {
        this._deviceIdPromise = null;
        throw err;
      });
    }
    return this._deviceIdPromise;
  },

  async _loadOrCreateDeviceId() {
    const path = this._identityPath();

    // `IOUtils.readJSON` rejects differently for "no file" and "a file that is
    // not readable JSON", and that difference is what decides whether a new id
    // may be generated. Only `NotFoundError` means first run. A parse failure,
    // a permission failure or an unreadable volume all mean an id may already
    // exist and may already have published files, so nothing is generated and
    // the user is told.
    const stored = await this._readIdentity(
      "no device id was generated — a second id would orphan every file " +
        "already published under the first"
    );

    const machineId = await this.readMachineId();
    const machine =
      machineId === null ? null : await machineFingerprintOf(machineId);

    if (stored?.deviceId !== undefined) {
      const bytes = fromHex(stored.deviceId, DEVICE_ID_BYTES);
      if (!bytes) {
        throw new SvalIdentityError(
          "bad_device_id",
          `sval: the identity file at ${path} does not hold a 16-byte device ` +
            `id, so none was generated`
        );
      }
      return this._onThisMachine(stored, bytes, machine);
    }
    if (stored !== null) {
      throw new SvalIdentityError(
        "no_device_id",
        `sval: the identity file at ${path} holds no device id, so none was ` +
          `generated`
      );
    }

    const bytes = new Uint8Array(DEVICE_ID_BYTES);
    crypto.getRandomValues(bytes);
    // Written, and awaited, before the id is handed out: an id that reached
    // the engine but not the disk would be replaced on the next startup,
    // orphaning whatever had already been published under it.
    await this._updateIdentity({
      deviceId: toHex(bytes),
      devices: machine === null ? null : { [machine]: toHex(bytes) },
    });
    return bytes;
  },

  /**
   * The device id for a profile that already has one, settled against the
   * computer it is starting on.
   *
   * `devices` maps each computer's fingerprint to the device id the profile
   * uses there, and `deviceId` is the one it used last. A profile kept in a
   * synced folder and opened on two computers in turn is then two devices,
   * each with its own id, and the user is asked once per computer.
   *
   * A computer the profile has not run on may be one it was copied to while
   * the first still uses it, and two computers with one id overwrite each
   * other's file, so the user is asked whether this is a move or a new
   * device. This runs before the id is handed to anything, so nothing is
   * published under the old id first. A profile that has no map records this
   * computer for the id it holds, and a computer whose id cannot be read
   * carries on with the last id; neither is asked.
   *
   * @param {object} stored The identity file's contents.
   * @param {Uint8Array} bytes The device id it used last.
   * @param {string|null} machine This computer's fingerprint, or null.
   * @returns {Promise<Uint8Array>} the device id to use.
   */
  async _onThisMachine(stored, bytes, machine) {
    if (machine === null) {
      return bytes;
    }
    const devices = stored.devices;
    if (typeof devices !== "object" || devices === null) {
      await this._updateIdentity({
        devices: { [machine]: stored.deviceId },
        machineFingerprint: null,
      });
      return bytes;
    }
    const known = devices[machine];
    if (known !== undefined) {
      const mine = fromHex(known, DEVICE_ID_BYTES);
      if (!mine) {
        throw new SvalIdentityError(
          "bad_device_id",
          `sval: the identity file at ${this._identityPath()} does not hold ` +
            `a 16-byte device id for this computer, so none was generated`
        );
      }
      if (known !== stored.deviceId) {
        await this._updateIdentity({ deviceId: known });
      }
      return mine;
    }
    if (await this.askIfMoved()) {
      const moved = Object.fromEntries(
        Object.entries(devices).filter(([, id]) => id !== stored.deviceId)
      );
      moved[machine] = stored.deviceId;
      await this._updateIdentity({ devices: moved });
      lazy.SvalLog.info(`the profile moved here and keeps ${toHex(bytes)}`);
      return bytes;
    }
    // The workspaces stay: this device's copy in the profile and the shared
    // folder both still hold the old id's file, which the new id reads as a
    // peer's.
    const fresh = new Uint8Array(DEVICE_ID_BYTES);
    crypto.getRandomValues(fresh);
    await this._updateIdentity({
      deviceId: toHex(fresh),
      devices: { ...devices, [machine]: toHex(fresh) },
    });
    lazy.SvalLog.info(
      `a new device on this computer: ${toHex(fresh)}, after ${toHex(bytes)}`
    );
    return fresh;
  },

  /**
   * The local key: 32 bytes in a plain file in the profile, made at first
   * launch.
   *
   * @returns {Promise<Uint8Array>} the same 32 bytes on every call.
   */
  localKey() {
    if (!this._localKeyPromise) {
      this._localKeyPromise = this._loadOrCreateLocalKey().catch(err => {
        this._localKeyPromise = null;
        throw err;
      });
    }
    return this._localKeyPromise;
  },

  /**
   * A local key that exists and cannot be read, or that is not the one
   * recorded, stops startup: that is a damaged profile, and a replacement
   * would hide this device's own copy, which only the recorded key opens.
   */
  async _loadOrCreateLocalKey() {
    const path = this._localKeyPath();
    // The device id first, so the identity file is never one that holds a key
    // fingerprint and no device id.
    await this.deviceId();
    const identity = await this._readIdentity(
      "the local key could not be checked and no new one was made"
    );
    const recorded = identity?.localKeyFingerprint ?? null;

    let bytes = null;
    try {
      bytes = await IOUtils.read(path);
    } catch (err) {
      if (err.name !== "NotFoundError") {
        throw new SvalIdentityError(
          "key_unreadable",
          `sval: the local key at ${path} exists but could not be read, so ` +
            `no new one was made: ${err.name}: ${err.message}`
        );
      }
    }

    if (bytes) {
      if (bytes.length !== KEY_BYTES) {
        throw new SvalIdentityError(
          "bad_key_length",
          `sval: the local key at ${path} is ${bytes.length} bytes, not ` +
            `${KEY_BYTES}, so no new one was made`
        );
      }
      const fingerprint = await fingerprintOf(bytes);
      if (recorded === null) {
        // Written and not yet recorded: a first launch that stopped between
        // the two.
        await this._updateIdentity({ localKeyFingerprint: fingerprint });
      } else if (fingerprint !== recorded) {
        throw new SvalIdentityError(
          "wrong_key",
          `sval: the local key at ${path} is not the one this device was ` +
            `using, so sval did not start with it`
        );
      }
      return bytes;
    }

    if (recorded !== null) {
      throw new SvalIdentityError(
        "key_missing",
        `sval: the local key this device was using is missing from ${path}, ` +
          `so no new one was made`
      );
    }

    bytes = newKey();
    // Written before it is recorded and before it is handed out, so a key
    // that encrypted anything is always on disk.
    await writePrivateFile(path, bytes);
    await this._updateIdentity({
      localKeyFingerprint: await fingerprintOf(bytes),
    });
    return bytes;
  },

  /**
   * The sync key and what state it is in.
   *
   * Never memoised: the store's answer can change while Sval runs, and "Try
   * again" has `SvalSecretStore.retry` ask it afresh.
   *
   * One step among the key writes, because the read can repair the identity
   * file: a read between an adoption's writes would judge the identity and
   * the store from two different moments.
   *
   * @returns {Promise<{state: string, bytes: Uint8Array|null, reason: string|null}>}
   *   `bytes` only when `state` is `present`; `reason` says why otherwise.
   */
  syncKey() {
    return this._oneAtATime(() => this._syncKeyNow());
  },

  /**
   * {@link syncKey}'s body, for a caller already inside {@link _oneAtATime}.
   *
   * @returns {Promise<object>} what {@link syncKey} answers.
   */
  async _syncKeyNow() {
    const identity = await this._readIdentity(
      "the sync key could not be checked"
    );
    const recorded = identity?.syncKeyFingerprint ?? null;
    const adopting = identity?.adoptingSyncKeyFingerprint ?? null;
    if (recorded === null && adopting === null) {
      return { state: SYNC_KEY_STATES.none, bytes: null, reason: null };
    }

    const { SvalSecretStore } = lazy;
    let bytes;
    try {
      bytes = await SvalSecretStore.read(SYNC_KEY_SECRET);
    } catch (err) {
      const state =
        err instanceof SvalSecretStore.LostError
          ? SYNC_KEY_STATES.missing
          : SYNC_KEY_STATES.unreadable;
      return { state, bytes: null, reason: err?.message ?? String(err) };
    }
    if (!bytes) {
      return {
        state: SYNC_KEY_STATES.missing,
        bytes: null,
        reason: "no sync key is stored",
      };
    }
    if (bytes.length !== KEY_BYTES) {
      return {
        state: SYNC_KEY_STATES.different,
        bytes: null,
        reason: `the stored sync key is ${bytes.length} bytes`,
      };
    }

    const fingerprint = await fingerprintOf(bytes);
    if (fingerprint !== recorded && fingerprint !== adopting) {
      return {
        state: SYNC_KEY_STATES.different,
        bytes: null,
        reason: "the stored sync key is not the one this device was using",
      };
    }
    // An adoption that stopped after its write is finished here, and one
    // that stopped before it is forgotten.
    if (fingerprint !== recorded || adopting !== null) {
      await this._recordSyncKey(fingerprint);
    }
    return { state: SYNC_KEY_STATES.present, bytes, reason: null };
  },

  /**
   * Makes the sync key, on a device being set up to share for the first time.
   *
   * Refused on a device that already has one recorded, present or not: a
   * second key would split the user's workspaces, and a missing one comes
   * back by pairing.
   *
   * @returns {Promise<Uint8Array>} the new key, stored and read back.
   */
  mintSyncKey() {
    return this._oneAtATime(async () => {
      const identity = await this._readIdentity("no sync key was made");
      if (
        identity?.syncKeyFingerprint !== undefined ||
        identity?.adoptingSyncKeyFingerprint !== undefined
      ) {
        throw new SvalIdentityError(
          "has_sync_key",
          "sval: this device already has a sync key, so no new one was made"
        );
      }
      const bytes = newKey();
      await this._storeSyncKey(bytes);
      return bytes;
    });
  },

  /**
   * Makes `keyBytes` this device's sync key: a key pairing received, or one
   * restored from a backup.
   *
   * **This is the last step of an adoption, never the first.** The key names
   * the shared directory, so a device that stored a new key before publishing
   * under it would, if it stopped there, sync with a directory holding
   * nothing of its own. `SvalKeyJoin` therefore publishes first, calls this
   * only once that is confirmed, and moves the profile onto the key only once
   * this has succeeded.
   *
   * The store replaces its file whole (`SvalSecretStore.write`), so it holds
   * the old key or the new one at every moment and never neither. The
   * identity file names the new key before the write and records it after, so
   * `syncKey()` accepts whichever one the store holds if this stops between.
   *
   * The device id is untouched. Re-keying is not a new installation, and every
   * watermark this device's peers hold is keyed on that id (spec §6.7).
   *
   * @param {Uint8Array} keyBytes The 32 bytes received.
   * @param {Function} [onStored] Run once the key is stored, before any other
   *   key write or {@link useStoredSyncKey} can run: what moves the profile's
   *   engine onto the key, so nothing reads the store between the two and
   *   applies what it read after them. Module code only, since a window's
   *   script may never finish.
   * @returns {Promise<boolean>} whether the stored key changed. False means
   *   `keyBytes` was already the stored key, and nothing was written.
   */
  adoptSyncKey(keyBytes, onStored = null) {
    return this._oneAtATime(async () => {
      const changed = await this._adoptSyncKeyNow(keyBytes);
      await onStored?.();
      return changed;
    });
  },

  /**
   * Reads the stored sync key and, when it is present, moves `engine` onto
   * it, as one step among the key writes: a read that a join's store and
   * swap overtook would otherwise put the engine back on the key it left.
   *
   * @param {object} engine The profile's `SvalEngine`.
   * @returns {Promise<object>} what {@link syncKey} answered.
   */
  useStoredSyncKey(engine) {
    return this._oneAtATime(async () => {
      const sync = await this._syncKeyNow();
      if (sync.state === SYNC_KEY_STATES.present) {
        engine.useSyncKey(sync.bytes);
      }
      return sync;
    });
  },

  /**
   * {@link adoptSyncKey}'s body, for a caller already inside
   * {@link _oneAtATime}.
   *
   * @param {Uint8Array} keyBytes
   * @returns {Promise<boolean>}
   */
  async _adoptSyncKeyNow(keyBytes) {
    const adopted = asKey(keyBytes);
    const fingerprint = await fingerprintOf(adopted);
    const current = await this._syncKeyNow();
    if (
      current.state === SYNC_KEY_STATES.present &&
      current.bytes.every((byte, i) => byte === adopted[i])
    ) {
      return false;
    }
    await this.deviceId();
    await this._updateIdentity({ adoptingSyncKeyFingerprint: fingerprint });
    await this._storeSyncKey(adopted);
    return true;
  },

  /**
   * Stores `bytes` as the sync key, reads it back, and records it.
   *
   * @param {Uint8Array} bytes
   */
  async _storeSyncKey(bytes) {
    // `write` reads the secret back and compares it, so a write that reported
    // success and left nothing readable is a throw here, before the key is
    // recorded or handed to anything.
    await lazy.SvalSecretStore.write(SYNC_KEY_SECRET, bytes);
    await this._recordSyncKey(await fingerprintOf(bytes));
    // Also into iCloud Keychain, where a signed build can reach it, so a new
    // Mac or an iPhone finds it (decision 0084). Never a reason to fail: the
    // key is stored above whatever this answers.
    lazy.SvalICloudKeychain.store(bytes);
  },

  /**
   * Records `fingerprint` as the sync key in use, ending any adoption in
   * flight. The device id is settled first, so this never writes a file that
   * holds a fingerprint and no device id.
   *
   * @param {string} fingerprint What {@link fingerprintOf} gave for the key.
   */
  async _recordSyncKey(fingerprint) {
    await this.deviceId();
    await this._updateIdentity({
      syncKeyFingerprint: fingerprint,
      adoptingSyncKeyFingerprint: null,
    });
  },
};
