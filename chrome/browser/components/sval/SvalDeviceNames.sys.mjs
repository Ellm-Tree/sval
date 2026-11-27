/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { SvalSettingsRegistry } from "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs";

const { SETTINGS_DOCUMENT } = SvalSettingsRegistry;

/**
 * This device's name as the user set it in Settings. Empty until they do,
 * which reads as the computer's name.
 */
export const DEVICE_NAME_PREF = "browser.sval.device.name";

/** Notified when any device's name or kind may have changed. */
export const DEVICE_NAMES_TOPIC = "sval-device-names-changed";

/** The setting each device's name syncs under (history-sync spec §3.1). */
export const KEY_PREFIX = "sval.device.name.";

/**
 * The setting a phone or tablet says which it is under: `"phone"` or
 * `"tablet"`, so its Workspace wears that device's mark (decision 2254).
 */
export const KIND_PREFIX = "sval.device.kind.";

/** Longest name kept: a label, never a paragraph. */
const MAX_LENGTH = 64;

/** The engine names are read from and written to, and its listener. */
let current = null;

/** Every device's name by hex id, as the settings document last held them. */
let names = new Map();

/** Every phone's and tablet's kind by hex id, as the document last held them. */
let kinds = new Map();

/**
 * The computer's name, as the system reports it: its host name without the
 * local domain.
 *
 * @returns {string}
 */
export function computerName() {
  let host = "";
  try {
    host = Services.dns.myHostName;
  } catch {}
  host = host.replace(/\.(local|lan|home)$/i, "");
  return host || "This device";
}

function clean(name) {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
}

/**
 * Every device's name (history-sync spec §3.1). Each device writes its own
 * into the `settings` document, under a key that names the device, and
 * every device reads all of them.
 */
export const SvalDeviceNames = {
  /**
   * This device's name: the one set in Settings, else the computer's.
   *
   * @returns {string}
   */
  get own() {
    return (
      clean(Services.prefs.getStringPref(DEVICE_NAME_PREF, "")) ||
      clean(computerName())
    );
  },

  /** @returns {object|null} The engine names are read through. */
  get engine() {
    return current?.engine ?? null;
  },

  /**
   * The name of the device with hex id `device`, or null before it arrives.
   *
   * @param {string} device
   * @returns {string|null}
   */
  nameOf(device) {
    if (current && device === current.engine.deviceIdHex) {
      return this.own;
    }
    return names.get(device) ?? null;
  },

  /**
   * The names of every other device that has published one, in the order
   * a person reads a list.
   *
   * @returns {string[]}
   */
  others() {
    const own = current?.engine.deviceIdHex;
    return [...names]
      .filter(([device]) => device !== own)
      .map(([, name]) => name)
      .sort((a, b) => a.localeCompare(b));
  },

  /**
   * Whether the device with hex id `device` is a `"phone"` or a `"tablet"`,
   * or null when it has not said.
   *
   * @param {string} device
   * @returns {string|null}
   */
  kindOf(device) {
    return kinds.get(device) ?? null;
  },

  /**
   * Starts publishing this device's name through `engine`'s settings
   * document, and reading every device's after each pass that brings a
   * change to that document. One engine for the process; another stops the
   * last.
   *
   * @param {object} engine The profile's engine, settings sync started.
   * @returns {Promise<void>}
   */
  async startFor(engine) {
    if (current?.engine === engine) {
      return;
    }
    this.stop();
    const entry = { engine, stopPasses: null, observer: null };
    current = entry;
    // Another device's name changes here only by a pass bringing it in, and
    // this device's own is read from the pref.
    entry.stopPasses = engine.addDocumentListener(SETTINGS_DOCUMENT, report => {
      if (report.changedIds?.length || report.removedIds?.length) {
        refresh(entry).catch(err =>
          SvalLog.warn(`device names did not read: ${SvalLog.errorName(err)}`)
        );
      }
    });
    entry.observer = () =>
      publish(entry).catch(err =>
        SvalLog.warn(`device name did not publish: ${SvalLog.errorName(err)}`)
      );
    Services.prefs.addObserver(DEVICE_NAME_PREF, entry.observer);
    await publish(entry);
    await refresh(entry);
  },

  stop() {
    if (!current) {
      return;
    }
    current.stopPasses?.();
    Services.prefs.removeObserver(DEVICE_NAME_PREF, current.observer);
    current = null;
    names = new Map();
    kinds = new Map();
  },
};

/**
 * Writes this device's name, when the document holds another.
 *
 * @param {object} entry The running engine's entry.
 */
async function publish(entry) {
  const key = KEY_PREFIX + entry.engine.deviceIdHex;
  const synced = await entry.engine.settings(SETTINGS_DOCUMENT);
  if (synced[key] === SvalDeviceNames.own || current !== entry) {
    return;
  }
  await entry.engine.mutate({
    kind: "setSetting",
    document: SETTINGS_DOCUMENT,
    key,
    valueJson: JSON.stringify(SvalDeviceNames.own),
    now: SvalClock.now(),
  });
  Services.obs.notifyObservers(null, DEVICE_NAMES_TOPIC);
}

/**
 * Reads every device's name from the settings document.
 *
 * @param {object} entry The running engine's entry.
 */
async function refresh(entry) {
  const synced = await entry.engine.settings(SETTINGS_DOCUMENT);
  if (current !== entry) {
    return;
  }
  const next = new Map();
  const nextKinds = new Map();
  for (const [key, value] of Object.entries(synced)) {
    if (key.startsWith(KEY_PREFIX) && typeof value === "string") {
      const name = clean(value);
      if (name) {
        next.set(key.slice(KEY_PREFIX.length), name);
      }
    } else if (key.startsWith(KIND_PREFIX) && typeof value === "string") {
      nextKinds.set(key.slice(KIND_PREFIX.length), value);
    }
  }
  const differs = (a, b) =>
    a.size !== b.size || [...a].some(([device, v]) => b.get(device) !== v);
  const changed = differs(next, names) || differs(nextKinds, kinds);
  names = next;
  kinds = nextKinds;
  if (changed) {
    Services.obs.notifyObservers(null, DEVICE_NAMES_TOPIC);
  }
}
