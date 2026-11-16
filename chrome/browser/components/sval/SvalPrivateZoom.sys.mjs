/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The site zoom of one private window (private-windows spec).
 *
 * Firefox keeps a private window's site zoom in the content pref service's
 * one private store, which every private window reads, and a page can
 * measure its own zoom. Each private window is a session of its own, so its
 * `FullZoom` is given a store of its own instead: the part of
 * `nsIContentPrefService2` it calls, held in memory on the window and gone
 * with it. A site with no zoom here reads the profile's, as a private
 * window reads it in Firefox, and changes to the profile's (the default
 * zoom among them) still reach the window; nothing here is ever written to
 * the service.
 */

const COMPLETE_OK = Ci.nsIContentPrefCallback2.COMPLETE_OK;

/** One private window's site zoom, with the service's surface `FullZoom` calls. */
class SvalPrivateZoomStore {
  /** @type {nsIContentPrefService2} */
  #service;
  /** Each site's zoom, by the service's group for it. */
  #values = new Map();
  /** `FullZoom`, by the name it observes. */
  #observers = new Map();

  constructor(service) {
    this.#service = service;
  }

  extractDomain(spec) {
    return this.#service.extractDomain(spec);
  }

  #own(spec, name) {
    const group = this.extractDomain(spec);
    const key = `${group}\n${name}`;
    return { group, key, value: this.#values.get(key) };
  }

  getCachedByDomainAndName(spec, name, context) {
    const { group, value } = this.#own(spec, name);
    if (value !== undefined) {
      return { domain: group, name, value };
    }
    return this.#service.getCachedByDomainAndName(spec, name, context);
  }

  getByDomainAndName(spec, name, context, callback) {
    const { group, value } = this.#own(spec, name);
    if (value === undefined) {
      this.#service.getByDomainAndName(spec, name, context, callback);
      return;
    }
    // The service answers on a later turn, and `FullZoom` relies on none of
    // its callbacks running inside the call.
    Services.tm.dispatchToMainThread(() => {
      callback.handleResult?.({ domain: group, name, value });
      callback.handleCompletion?.(COMPLETE_OK);
    });
  }

  set(spec, name, value, context, callback) {
    const { group, key } = this.#own(spec, name);
    this.#values.set(key, value);
    // The completion before the observers, in one turn, as the service
    // does: `FullZoom` tells its own change apart by that order.
    Services.tm.dispatchToMainThread(() => {
      callback?.handleCompletion?.(COMPLETE_OK);
      this.#observers.get(name)?.onContentPrefSet(group, name, value, true);
    });
  }

  removeByDomainAndName(spec, name, context, callback) {
    const { group, key, value } = this.#own(spec, name);
    this.#values.delete(key);
    Services.tm.dispatchToMainThread(() => {
      callback?.handleCompletion?.(COMPLETE_OK);
      if (value !== undefined) {
        this.#observers.get(name)?.onContentPrefRemoved(group, name, true);
      }
    });
  }

  addObserverForName(name, observer) {
    this.#observers.set(name, observer);
    this.#service.addObserverForName(name, observer);
  }

  removeObserverForName(name, observer) {
    this.#observers.delete(name);
    this.#service.removeObserverForName(name, observer);
  }
}

export const SvalPrivateZoom = {
  /**
   * @param {Window} win A browser window, as its `FullZoom` starts.
   * @returns {object|null} a store of its own for a private window, or null
   *   for a normal one, which uses the service.
   */
  storeFor(win) {
    if (!win.docShell?.QueryInterface(Ci.nsILoadContext).usePrivateBrowsing) {
      return null;
    }
    return new SvalPrivateZoomStore(
      Cc["@mozilla.org/content-pref/service;1"].getService(
        Ci.nsIContentPrefService2
      )
    );
  },
};
