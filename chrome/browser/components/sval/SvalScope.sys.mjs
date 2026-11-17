/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What a window or a page listens to, taken down together when it goes.
 *
 * An observer the observer service or a pref branch holds outlives the
 * window that added it, and goes on calling into a document that is gone.
 * Each add made through a scope is undone by `end`, so the add is written
 * once and its removal cannot be left out or fall out of step with it.
 */
export class SvalScope {
  #ends = [];

  /**
   * @param {Window} win
   * @returns {SvalScope} A scope that ends when `win` unloads.
   */
  static forWindow(win) {
    const scope = new SvalScope();
    win.addEventListener("unload", () => scope.end(), { once: true });
    return scope;
  }

  /**
   * Observes an observer service topic until the scope ends.
   *
   * @param {string} topic
   * @param {Function|nsIObserver} observer
   */
  topic(topic, observer) {
    Services.obs.addObserver(observer, topic);
    this.#ends.push(() => Services.obs.removeObserver(observer, topic));
  }

  /**
   * Observes a pref, or a branch of them, until the scope ends.
   *
   * @param {string} name A pref's name, or a branch's prefix.
   * @param {Function|nsIObserver} observer
   */
  pref(name, observer) {
    Services.prefs.addObserver(name, observer);
    this.#ends.push(() => Services.prefs.removeObserver(name, observer));
  }

  /**
   * Listens for an event until the scope ends.
   *
   * @param {EventTarget} target
   * @param {string} type
   * @param {Function|EventListener} listener
   * @param {object|boolean} [options] As `addEventListener` takes them.
   */
  listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#ends.push(() => target.removeEventListener(type, listener, options));
  }

  /**
   * Has `end` run as the scope ends, for what the methods above do not add.
   *
   * @param {Function} end
   */
  add(end) {
    this.#ends.push(end);
  }

  /** Undoes every add, in the order it was made. A second call does nothing. */
  end() {
    for (const end of this.#ends.splice(0)) {
      end();
    }
  }
}
