/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Workspace panel's Undo message: after closing several tabs, deleting a
 * group, a pin or a Workspace, or unpinning a pin, a message with Undo shows
 * at the panel's foot for a few seconds. It is the element picker's toast
 * (`SvalElementPickerChild`'s `#showToast`) drawn in the chrome: the same
 * parts, timer and keys.
 *
 * **The delete waits on the message.** What the user deleted leaves the
 * panel at once, but the document and the Favorites store keep it until the
 * message goes: its time runs out, the user dismisses it, another delete
 * replaces it, or the window closes or Sval quits. Undo cancels the delete,
 * so nothing has to be rebuilt, and no other device hears of a delete until
 * it is made.
 *
 * An unpin offers the same message, but is made at once, since its page
 * becomes a tab the user goes on using (`SvalPinsRow.unpin`). Its commit
 * makes nothing, and its Undo takes the unpin back.
 *
 * One delete waits at a time in a window. A Workspace waiting to be deleted
 * is left out of every window's panel, since each window lists every
 * Workspace; a tab, a group or a pin is this window's alone.
 *
 * The panel makes one of these for its window. What is deleted, hidden and
 * shown again is the caller's: this holds the delete and shows the message.
 */

import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { descendantIds } from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * A delete held back behind the message.
 *
 * @typedef {object} HeldDelete
 * @property {Function} undo Shows again what was hidden. Awaited.
 * @property {Function} commit Makes the delete, given
 *   `{ closing, inUnload }`. With `closing` it starts every write before it
 *   returns, and answers them as steps for the engine's
 *   `finishBeforeShutdown`: a promise, or an array of them.
 * @property {object} [tree] `{ ids, keepContents, workspace }`, document
 *   nodes every panel leaves out of its view.
 * @property {object[]} [tabs] The tabs hidden for it in its window.
 * @property {string[]} [pins] Pins every window's row leaves out.
 */

/**
 * What the Undo message reads of its panel, and asks of it.
 *
 * @typedef {object} PanelView
 * @property {Element|null} region The message's live region, once built.
 * @property {object|null} engine The window's engine.
 * @property {() => void} refocus Gives focus back to the tree.
 * @property {(held: HeldDelete) => Promise<void>} committed Redraws what a
 *   delete that was made changes.
 */

/**
 * @returns {HeldDelete[]} the delete each normal window holds for Undo.
 */
function heldEverywhere() {
  const all = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const held = win.SvalPanel?.undo.held;
    if (held) {
      all.push(held);
    }
  }
  return all;
}

/**
 * Logs a failure to make a held delete.
 *
 * @param {Error} err
 */
function logCommitFailure(err) {
  SvalLog.error(`a delete held for Undo failed: ${describeError(err)}`);
}

/** One window's Undo message, and the delete waiting on it. */
export class SvalPanelUndo {
  /** How long the message stays, unless the pointer or focus is on it. */
  messageMs = 8000;

  #window;

  /** @type {PanelView} */
  #view;

  /** The message showing, as `{ el, timer, hovered, focused }`, or null. */
  #offer = null;

  /** @type {HeldDelete|null} */
  #held = null;

  /**
   * Whether a tab was hidden since `showStrandedHides` last looked, and the
   * delete held then. A window's tabs can be restored before the panel
   * listens.
   */
  #tabHiddenSinceLook = true;
  #heldAtLook = null;

  #watching = false;

  /**
   * @param {Window} win The panel's chrome window.
   * @param {PanelView} view
   */
  constructor(win, view) {
    this.#window = win;
    this.#view = view;
  }

  /** @returns {HeldDelete|null} the delete waiting on the message. */
  get held() {
    return this.#held;
  }

  /**
   * Answers the undo key, and makes the delete waiting on the message as the
   * window closes or Sval quits, so neither loses it or leaves it half made.
   *
   * `quit-application-requested` and `SSWindowClosing` both come before the
   * session store reads the window's tabs (`onQuitApplicationGranted`, and
   * `SessionStore.onClose`, which dispatches the event first), so the hidden
   * tabs close as a person's close does and none is saved as open. `unload`
   * catches a window the session store does not track; its tabs go with it.
   */
  watch() {
    if (this.#watching) {
      return;
    }
    this.#watching = true;
    const win = this.#window;
    win.addEventListener("keydown", event => this.#onKey(event));
    win.addEventListener("TabHide", () => {
      this.#tabHiddenSinceLook = true;
    });
    const onQuit = () => this.commit({ closing: true });
    Services.obs.addObserver(onQuit, "quit-application-requested");
    win.addEventListener(
      "SSWindowClosing",
      () => this.commit({ closing: true }),
      { once: true }
    );
    win.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(onQuit, "quit-application-requested");
        this.commit({ closing: true, inUnload: true });
      },
      { once: true }
    );
  }

  /**
   * Holds a delete back behind the message: makes any delete already waiting,
   * hides this one, and shows the message.
   *
   * @param {string} text What went, in a few words.
   * @param {HeldDelete} held
   * @param {Function} hide Takes it out of sight. Awaited.
   */
  async defer(text, held, hide) {
    await this.commit();
    held.settled = false;
    this.#held = held;
    try {
      await hide();
    } catch (err) {
      SvalLog.error(`hiding a delete failed: ${describeError(err)}`);
    }
    if (this.#held !== held || held.settled) {
      return;
    }
    if (this.#view.region) {
      this.#show(text);
    } else {
      await this.commit();
    }
  }

  /**
   * Makes the delete waiting on the message, and takes the message away.
   *
   * @param {object} [options]
   * @param {boolean} [options.closing] The window is closing or Sval is
   *   quitting: every write starts before this returns, and the profile's
   *   shutdown blocker waits for them (`finishBeforeShutdown`).
   * @param {boolean} [options.inUnload] The window is unloading, too late to
   *   close its tabs, which go with it.
   * @returns {Promise<void>}
   */
  async commit({ closing = false, inUnload = false } = {}) {
    const held = this.#held;
    if (!held || held.settled) {
      return;
    }
    held.settled = true;
    this.#remove();
    const release = () => {
      if (this.#held === held) {
        this.#held = null;
      }
    };
    if (closing) {
      // The writes end after a closing window has gone, so the engine chains
      // them (`finishBeforeShutdown`).
      let steps = [];
      try {
        steps = [held.commit({ closing, inUnload })].flat();
      } catch (err) {
        logCommitFailure(err);
      }
      this.#view.engine?.finishBeforeShutdown?.(...steps, release);
      return;
    }
    let done;
    try {
      done = Promise.resolve(held.commit({ closing, inUnload }));
    } catch (err) {
      done = Promise.reject(err);
    }
    await done.catch(logCommitFailure).then(release);
    await this.#view.committed(held);
  }

  /**
   * Takes the message away and makes the delete it held back.
   *
   * @param {object} [options]
   * @param {boolean} [options.refocus] Gives focus back to the tree, for a
   *   message that held it.
   * @returns {boolean} whether a message was showing.
   */
  dismiss(options) {
    const shown = this.#remove(options);
    this.commit().catch(logCommitFailure);
    return shown;
  }

  /** The message's Undo: takes the message away and cancels the delete. */
  async take() {
    const held = this.#held;
    if (!held || held.settled) {
      return;
    }
    held.settled = true;
    this.#held = null;
    this.#remove({ refocus: true });
    await held.undo();
  }

  /**
   * `nodes` without what a delete held for Undo takes, in any window: a
   * group whose contents move out stays, drawn as its contents
   * (`transparentIds`).
   *
   * @param {object} nodes The document's `nodes` map.
   * @returns {object}
   */
  viewOf(nodes) {
    const gone = new Set();
    for (const { tree } of heldEverywhere()) {
      if (!tree || tree.keepContents) {
        continue;
      }
      for (const id of tree.ids) {
        gone.add(id);
        for (const each of descendantIds(nodes, id)) {
          gone.add(each);
        }
      }
    }
    if (!gone.size) {
      return nodes;
    }
    return Object.fromEntries(
      Object.entries(nodes).filter(([id]) => !gone.has(id))
    );
  }

  /**
   * @returns {Set<string>} the groups whose delete, held for Undo in any
   *   window, moves their contents out.
   */
  transparentIds() {
    const ids = new Set();
    for (const { tree } of heldEverywhere()) {
      if (tree?.keepContents) {
        tree.ids.forEach(id => ids.add(id));
      }
    }
    return ids;
  }

  /**
   * @returns {Set<string>} the pins whose delete waits on any normal
   *   window's Undo message.
   */
  pinGuids() {
    return new Set(heldEverywhere().flatMap(held => held.pins ?? []));
  }

  /**
   * Shows the tabs a delete held for Undo hid that no delete still holds: the
   * session store brings back the hide of a window that was not closed
   * cleanly, and its delete was never made.
   *
   * A hide is stranded only by a hide since the last look, which fires
   * `TabHide` whether the session store or Sval made it
   * (`tabbrowser.restoreTabs`, `gBrowser.hideTab`), or by the delete
   * holding it ending, so the tabs are walked only after one of those.
   */
  showStrandedHides() {
    if (!this.#tabHiddenSinceLook && this.#held === this.#heldAtLook) {
      return;
    }
    this.#tabHiddenSinceLook = false;
    this.#heldAtLook = this.#held;
    const { gBrowser } = this.#window;
    const kept = this.#held?.tabs ?? [];
    for (const tab of gBrowser.tabs) {
      if (SvalFirefox.isHiddenForDelete(tab) && !kept.includes(tab)) {
        gBrowser.showTab(tab);
      }
    }
  }

  /**
   * The platform's undo key, Z with the accel key alone, as Gecko's editor
   * reads it (`ShortcutKeyDefinitions`' `cmd_undo`), is the message's Undo
   * while focus is in this window's chrome and nothing there would undo:
   * no command dispatcher controller takes `cmd_undo`, which a text field's
   * editor does. A page holding focus keeps the key, whether its browser
   * (`<browser>`) or an in-process page's document holds it.
   *
   * @param {KeyboardEvent} event
   */
  #onKey(event) {
    const held = this.#held;
    if (
      !held ||
      held.settled ||
      event.defaultPrevented ||
      event.key.toLowerCase() !== "z" ||
      !event.getModifierState("Accel") ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const { commandDispatcher } = this.#window.document;
    if (
      commandDispatcher.focusedWindow !== this.#window ||
      commandDispatcher.focusedElement?.localName === "browser" ||
      commandDispatcher.getControllerForCommand("cmd_undo")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.take().catch(err =>
      SvalLog.error(`undoing a held delete failed: ${describeError(err)}`)
    );
  }

  /**
   * Shows the message, replacing any other.
   *
   * @param {string} text What went, in a few words.
   */
  #show(text) {
    const { region } = this.#view;
    this.#remove();
    const make = (tag, attrs = {}) => {
      const el = this.#window.document.createElementNS(XHTML, tag);
      for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, value);
      }
      return el;
    };
    const el = make("div", { class: "sval-undo" });
    const label = make("span", { class: "sval-undo-text" });
    label.textContent = text;
    const button = make("button", {
      class: "sval-undo-button",
      "data-command": "undo",
      "aria-label": "Undo",
    });
    const buttonLabel = make("span");
    buttonLabel.textContent = "Undo";
    button.append(
      make("span", { class: "sval-undo-glyph", "aria-hidden": "true" }),
      buttonLabel
    );
    const dismiss = make("button", {
      class: "sval-undo-dismiss",
      "data-command": "dismissUndo",
      title: "Dismiss",
      "aria-label": "Dismiss",
    });
    el.append(
      make("span", { class: "sval-undo-icon", "aria-hidden": "true" }),
      label,
      button,
      dismiss
    );
    const offer = { el, timer: null, hovered: false, focused: false };
    const pause = () => this.#arm(offer);
    // Gecko logs mouseenter and mouseleave in chrome as slower than
    // mouseover and mouseout (`EventListenerManager`, `SlowChromeEvent`).
    el.addEventListener("mouseover", () => {
      if (!offer.hovered) {
        offer.hovered = true;
        pause();
      }
    });
    el.addEventListener("mouseout", event => {
      if (!el.contains(event.relatedTarget)) {
        offer.hovered = false;
        pause();
      }
    });
    el.addEventListener("focusin", () => {
      offer.focused = true;
      pause();
    });
    el.addEventListener("focusout", event => {
      offer.focused = el.contains(event.relatedTarget);
      pause();
    });
    el.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss({ refocus: true });
      }
    });
    this.#offer = offer;
    region.append(el);
    this.#arm(offer);
  }

  /**
   * Runs the message's timer, paused while it is hovered or focused.
   *
   * @param {object} offer The message, as `#offer` holds it.
   */
  #arm(offer) {
    const win = this.#window;
    win.clearTimeout(offer.timer);
    offer.timer = null;
    if (this.#offer === offer && !offer.hovered && !offer.focused) {
      offer.timer = win.setTimeout(() => {
        if (this.#offer === offer) {
          this.dismiss();
        }
      }, this.messageMs);
    }
  }

  /**
   * Takes the message element away.
   *
   * @param {object} [options]
   * @param {boolean} [options.refocus] Gives focus back to the tree, for a
   *   message that held it.
   * @returns {boolean} whether a message was showing.
   */
  #remove({ refocus = false } = {}) {
    const offer = this.#offer;
    if (!offer) {
      return false;
    }
    this.#offer = null;
    this.#window.clearTimeout(offer.timer);
    const had = offer.el.contains(this.#window.document.activeElement);
    offer.el.remove();
    if (refocus || had) {
      this.#view.refocus();
    }
    return true;
  }
}
