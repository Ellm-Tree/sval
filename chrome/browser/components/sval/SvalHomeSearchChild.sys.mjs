/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/** The requests the page makes, by their names. */
const REQUESTS = new Set([
  "Placeholder",
  "Paste",
  "Query",
  "Pick",
  "Choose",
  "StopChoosing",
  "Dismiss",
  "Menu",
  "EngineMenu",
  "ExitSearchMode",
]);

/** The page's requests that act on the browser. */
const PICKS = new Set(["Pick", "Choose", "Dismiss", "Menu", "EngineMenu"]);

/**
 * Carries the home page's `SvalHomeSearch` events to `SvalHomeSearchParent` and
 * its answers back as `SvalHomeSearchService` events, as `ContentSearchChild`
 * does for `ContentSearch`. Each time the page is shown it tells the parent,
 * which decides whether the page may stay in its window.
 *
 * A pick opens, switches, moves or runs something, so one goes on only while
 * the page holds transient user activation: a key or click the user just
 * made there. A page script picking by itself reaches nothing. The parent
 * cannot read the activation (`WindowContext` exposes it to C++ alone).
 * Only the requests the page makes go on, by name, so nothing the page puts
 * in an event reads as another name once it is a message's.
 */
export class SvalHomeSearchChild extends JSWindowActorChild {
  async handleEvent(event) {
    if (event.type === "pageshow") {
      this.sendAsyncMessage("Shown");
      return;
    }
    const { type, data } = event.detail ?? {};
    if (
      typeof type !== "string" ||
      !REQUESTS.has(type) ||
      (PICKS.has(type) &&
        !this.document?.hasValidTransientUserGestureActivation)
    ) {
      return;
    }
    if (type === "Placeholder" || type === "Paste" || type === "Choose") {
      let answer;
      try {
        answer = await this.sendQuery(type, data);
      } catch (e) {
        // The page's tab or window closed before the parent answered, and
        // there is no page left to answer.
        if (DOMException.isInstance(e) && e.name === "AbortError") {
          return;
        }
        throw e;
      }
      this.#fire(type, answer);
    } else {
      this.sendAsyncMessage(type, data);
    }
  }

  receiveMessage(message) {
    this.#fire(message.name, message.data);
  }

  #fire(type, data) {
    const window = this.contentWindow;
    if (!window) {
      return;
    }
    window.dispatchEvent(
      new window.CustomEvent("SvalHomeSearchService", {
        detail: Cu.cloneInto({ type, data }, window),
      })
    );
  }
}
