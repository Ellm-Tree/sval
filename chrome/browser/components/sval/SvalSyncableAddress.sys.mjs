/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Whether an address may leave this device (decision 1372). The writer asks
 * it of every tab, pin, favorite and history visit it records, and an address
 * it refuses stays in this device's profile copy. The reader asks it of what
 * another device wrote, and never opens an address it refuses.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

// Firefox's tab engine reads the same pref, the same way
// (`TABS_FILTERED_SCHEMES` in `services/sync/modules/engines/tabs.sys.mjs`).
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "filteredSchemes",
  "services.sync.engine.tabs.filteredSchemes",
  "",
  null,
  value => new Set(value.split("|"))
);

/**
 * @param {string} url An address.
 * @returns {boolean} whether `url` may be synced: it parses, and the
 *   innermost address it nests (`view-source:`, `jar:`) has a scheme
 *   `services.sync.engine.tabs.filteredSchemes` does not list.
 */
export function syncableAddress(url) {
  let uri;
  try {
    uri = Services.io.newURI(url);
  } catch {
    return false;
  }
  while (uri instanceof Ci.nsINestedURI) {
    uri = uri.innerURI;
  }
  return !lazy.filteredSchemes.has(uri.scheme);
}

/**
 * Whether a tab, favorite or Archive entry holds an address another device
 * wrote that may not leave a device, which the reader never opens (decision
 * 1372). This device marks each such address of its own `local`, and a mark
 * read from any other device's file is dropped, so an unmarked one came from
 * another device.
 *
 * @param {object} item
 * @param {?string} [item.url] Its address; a folder or separator has none.
 * @param {boolean} [item.local] Its `local` mark.
 * @returns {boolean}
 */
export function refusedAddress({ url, local }) {
  return typeof url === "string" && local !== true && !syncableAddress(url);
}
