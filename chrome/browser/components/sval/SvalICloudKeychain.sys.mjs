/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The sync key in iCloud Keychain, on macOS (decision 0084, key-storage spec
 * "Installing again").
 *
 * A synchronizable password item in the data-protection keychain, under the
 * access group Sval's Mac and iOS apps share, so a new Mac or an iPhone signed
 * in to the same Apple account finds the key with no code and no backup.
 * Reached through js-ctypes calls into Security.framework: no native code of
 * Sval's own, and nothing changed in Gecko, whose `KeychainSecret` keeps its
 * own, unsynchronized items.
 *
 * **Only a signed release build can use it.** The access group needs the
 * `keychain-access-groups` entitlement from a Developer ID provisioning
 * profile; without it every call answers `errSecMissingEntitlement`. The
 * group is `browser.sval.keychainAccessGroup`, which has no default: the
 * signed release sets it in a file under `$gre/defaults/pref/`, which Gecko
 * reads before the app's own defaults, so an app default would override it.
 * An unset group or a refused call is "not available": Sval goes on with
 * the per-user system secret and the sealed copy in the folder. Nothing here
 * ever stops Sval from starting.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
});

const GROUP_PREF = "browser.sval.keychainAccessGroup";

/** The item's service and account: one sync key per Apple account. */
const SERVICE = "sval";
const ACCOUNT = "sync key";

/** Security.framework's answers this module tells apart (`SecBase.h`). */
export const STATUS = Object.freeze({
  success: 0,
  duplicate: -25299,
  notFound: -25300,
  missingEntitlement: -34018,
});

const UTF8 = 0x08000100;

/**
 * The CoreFoundation and Security entry points, opened once, or null on a
 * machine that is not a Mac or cannot open them.
 */
let api;

function openApi() {
  if (api !== undefined) {
    return api;
  }
  api = null;
  if (AppConstants.platform !== "macosx") {
    return api;
  }
  const { ctypes } = lazy;
  try {
    const cf = ctypes.open(
      "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
    );
    const sec = ctypes.open(
      "/System/Library/Frameworks/Security.framework/Security"
    );
    const ref = ctypes.voidptr_t;
    const callbacks = ctypes.ArrayType(ctypes.uint8_t, 64);
    // A data symbol declared as a pointer is that pointer: passed as an
    // argument, it is the `CFStringRef` the framework exports.
    const data = name => sec.declare(name, ref);
    api = {
      CFRelease: cf.declare(
        "CFRelease",
        ctypes.default_abi,
        ctypes.void_t,
        ref
      ),
      CFStringCreateWithCString: cf.declare(
        "CFStringCreateWithCString",
        ctypes.default_abi,
        ref,
        ref,
        ctypes.char.ptr,
        ctypes.uint32_t
      ),
      CFDataCreate: cf.declare(
        "CFDataCreate",
        ctypes.default_abi,
        ref,
        ref,
        ctypes.uint8_t.ptr,
        ctypes.long
      ),
      CFDataGetLength: cf.declare(
        "CFDataGetLength",
        ctypes.default_abi,
        ctypes.long,
        ref
      ),
      CFDataGetBytePtr: cf.declare(
        "CFDataGetBytePtr",
        ctypes.default_abi,
        ctypes.uint8_t.ptr,
        ref
      ),
      CFDictionaryCreate: cf.declare(
        "CFDictionaryCreate",
        ctypes.default_abi,
        ref,
        ref,
        ref.ptr,
        ref.ptr,
        ctypes.long,
        ref,
        ref
      ),
      keyCallbacks: cf
        .declare("kCFTypeDictionaryKeyCallBacks", callbacks)
        .address(),
      valueCallbacks: cf
        .declare("kCFTypeDictionaryValueCallBacks", callbacks)
        .address(),
      kCFBooleanTrue: cf.declare("kCFBooleanTrue", ref),
      SecItemAdd: sec.declare(
        "SecItemAdd",
        ctypes.default_abi,
        ctypes.int32_t,
        ref,
        ref.ptr
      ),
      SecItemCopyMatching: sec.declare(
        "SecItemCopyMatching",
        ctypes.default_abi,
        ctypes.int32_t,
        ref,
        ref.ptr
      ),
      SecItemUpdate: sec.declare(
        "SecItemUpdate",
        ctypes.default_abi,
        ctypes.int32_t,
        ref,
        ref
      ),
      SecItemDelete: sec.declare(
        "SecItemDelete",
        ctypes.default_abi,
        ctypes.int32_t,
        ref
      ),
      k: {
        class: data("kSecClass"),
        genericPassword: data("kSecClassGenericPassword"),
        service: data("kSecAttrService"),
        account: data("kSecAttrAccount"),
        accessGroup: data("kSecAttrAccessGroup"),
        synchronizable: data("kSecAttrSynchronizable"),
        accessible: data("kSecAttrAccessible"),
        afterFirstUnlock: data("kSecAttrAccessibleAfterFirstUnlock"),
        dataProtection: data("kSecUseDataProtectionKeychain"),
        valueData: data("kSecValueData"),
        returnData: data("kSecReturnData"),
        matchLimit: data("kSecMatchLimit"),
        matchLimitOne: data("kSecMatchLimitOne"),
      },
    };
  } catch (err) {
    lazy.SvalLog.warn(
      `iCloud Keychain is not reachable: ${lazy.SvalLog.errorName(err)}`
    );
    api = null;
  }
  return api;
}

/**
 * Runs `work` with CoreFoundation objects it makes through `make`, and
 * releases every one of them afterwards.
 *
 * @param {Function} work Called with `{ api, string, bytes, dict }`.
 * @returns {*} what `work` returns.
 */
function withObjects(work) {
  const made = [];
  const keep = ref => {
    if (!ref.isNull()) {
      made.push(ref);
    }
    return ref;
  };
  const { ctypes } = lazy;
  const string = text => keep(api.CFStringCreateWithCString(null, text, UTF8));
  const bytes = array => {
    const buffer = ctypes.uint8_t.array(array.length)(Array.from(array));
    return keep(api.CFDataCreate(null, buffer, array.length));
  };
  const dict = entries => {
    const Refs = ctypes.voidptr_t.array(entries.length);
    const keys = Refs(entries.map(([key]) => key));
    const values = Refs(entries.map(([, value]) => value));
    return keep(
      api.CFDictionaryCreate(
        null,
        keys,
        values,
        entries.length,
        api.keyCallbacks,
        api.valueCallbacks
      )
    );
  };
  try {
    return work({ string, bytes, dict });
  } finally {
    for (const ref of made) {
      api.CFRelease(ref);
    }
  }
}

export const SvalICloudKeychain = {
  STATUS,

  /** The access group, or "" until a signed build sets it. */
  accessGroup() {
    return Services.prefs.getStringPref(GROUP_PREF, "");
  },

  /** Whether this build can try iCloud Keychain at all. */
  configured() {
    return !!this.accessGroup() && !!openApi();
  },

  /**
   * The attributes naming Sval's item: the class, the service and account,
   * the shared access group, the data-protection keychain, and synchronizable.
   *
   * @param {object} make What `withObjects` passes.
   * @param {Function} make.string Makes a CFString.
   * @param {Array[]} [extra] More `[key, value]` pairs.
   * @returns {Array[]} the pairs, for `make.dict`.
   */
  _query({ string }, extra = []) {
    const { k, kCFBooleanTrue } = api;
    return [
      [k.class, k.genericPassword],
      [k.service, string(SERVICE)],
      [k.account, string(ACCOUNT)],
      [k.accessGroup, string(this.accessGroup())],
      [k.dataProtection, kCFBooleanTrue],
      [k.synchronizable, kCFBooleanTrue],
      ...extra,
    ];
  },

  /**
   * Stores `keyBytes` as the user's sync key in iCloud Keychain, replacing
   * the one there.
   *
   * @param {Uint8Array} keyBytes
   * @returns {number} Security.framework's status; `STATUS.success` when it
   *   is stored. Never throws.
   */
  store(keyBytes) {
    if (!this.configured()) {
      return STATUS.missingEntitlement;
    }
    try {
      return withObjects(make => {
        const { k } = api;
        const value = make.bytes(keyBytes);
        let status = api.SecItemAdd(
          make.dict(
            this._query(make, [
              [k.accessible, k.afterFirstUnlock],
              [k.valueData, value],
            ])
          ),
          null
        );
        if (status === STATUS.duplicate) {
          status = api.SecItemUpdate(
            make.dict(this._query(make)),
            make.dict([[k.valueData, value]])
          );
        }
        if (status !== STATUS.success) {
          lazy.SvalLog.info(`iCloud Keychain did not store the key: ${status}`);
        }
        return status;
      });
    } catch (err) {
      lazy.SvalLog.warn(
        `iCloud Keychain failed: ${lazy.SvalLog.errorName(err)}`
      );
      return STATUS.missingEntitlement;
    }
  },

  /**
   * The user's sync key from iCloud Keychain, or null when there is none,
   * this build cannot reach it, or the store refused.
   *
   * @returns {Uint8Array|null}
   */
  read() {
    if (!this.configured()) {
      return null;
    }
    try {
      return withObjects(make => {
        const { k, kCFBooleanTrue } = api;
        const result = lazy.ctypes.voidptr_t();
        const status = api.SecItemCopyMatching(
          make.dict(
            this._query(make, [
              [k.returnData, kCFBooleanTrue],
              [k.matchLimit, k.matchLimitOne],
            ])
          ),
          result.address()
        );
        if (status !== STATUS.success || result.isNull()) {
          return null;
        }
        try {
          const length = api.CFDataGetLength(result);
          const array = lazy.ctypes.cast(
            api.CFDataGetBytePtr(result),
            lazy.ctypes.uint8_t.array(length).ptr
          ).contents;
          return Uint8Array.from({ length }, (_, i) => array[i]);
        } finally {
          api.CFRelease(result);
        }
      });
    } catch (err) {
      lazy.SvalLog.warn(
        `iCloud Keychain failed: ${lazy.SvalLog.errorName(err)}`
      );
      return null;
    }
  },

  /**
   * Opens the frameworks and asks for the item with no access group, which
   * every build may do, so a test can see the calls work on an unsigned
   * build.
   *
   * @returns {number|null} the status, or null off a Mac.
   */
  _probe() {
    if (!openApi()) {
      return null;
    }
    return withObjects(make => {
      const { k, kCFBooleanTrue } = api;
      const result = lazy.ctypes.voidptr_t();
      return api.SecItemCopyMatching(
        make.dict([
          [k.class, k.genericPassword],
          [k.service, make.string(`${SERVICE} probe`)],
          [k.dataProtection, kCFBooleanTrue],
          [k.returnData, kCFBooleanTrue],
        ]),
        result.address()
      );
    });
  },
};
