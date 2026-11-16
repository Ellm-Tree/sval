/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/** The requests the page makes, by their names. */
const REQUESTS = new Set([
  "Init",
  "Open",
  "OpenAll",
  "Move",
  "File",
  "Context",
  "Enabled",
]);

/**
 * The page's requests that act on the browser and come straight from a
 * click or key in the page. Move and File also come from a drop, which
 * Gecko does not count as activation (`UserActivation::IsUserInteractionEvent`),
 * and Move from the tile menu's Move Left and Move Right, which the parent
 * asks the page to work out (`MoveBy`). The parent bounds both to the pins
 * the row shows.
 */
const ACTS = new Set(["Open", "OpenAll", "Context", "Enabled"]);

/**
 * Carries the home page's `SvalHomeFavorites` events to
 * `SvalHomeFavoritesParent` and its answers back as `SvalHomeFavoritesService`
 * events, as `SvalHomeSearchChild` does for the field.
 *
 * A request that opens a page, opens a menu or turns the row off goes on
 * only while the page holds transient user activation: a key or click the
 * user just made there. The parent cannot read the activation
 * (`WindowContext` exposes it to C++ alone). Only the requests the page
 * makes go on, by name, so nothing the page puts in an event reads as
 * another name once it is a message's.
 */
export class SvalHomeFavoritesChild extends JSWindowActorChild {
  handleEvent(event) {
    const { type, data } = event.detail ?? {};
    if (
      typeof type !== "string" ||
      !REQUESTS.has(type) ||
      (ACTS.has(type) && !this.document?.hasValidTransientUserGestureActivation)
    ) {
      return;
    }
    this.sendAsyncMessage(type, data);
  }

  receiveMessage(message) {
    const window = this.contentWindow;
    if (!window) {
      return;
    }
    window.dispatchEvent(
      new window.CustomEvent("SvalHomeFavoritesService", {
        detail: Cu.cloneInto(
          { type: message.name, data: message.data },
          window
        ),
      })
    );
  }
}
