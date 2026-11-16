/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { workspaceKey } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

/**
 * Draws the home page in its workspace's look (pins spec §9, §12.5) and
 * carries the page's `SvalHomeWorkspace` events to `SvalHomeWorkspaceParent`.
 *
 * The page's root carries the look (`SvalHomePage`'s `lookIn`):
 * `data-sval-workspace` the workspace's id, `data-sval-tint` its colour,
 * `data-sval-ink` the side its window's text is on, `--g-tint` the frame's
 * colour, and the wash of the colour laid over the page's night sky with
 * the text solved on it, and the colour the mark glows in, as the `--h-`
 * properties (`home.css`).
 *
 * **The first paint is already in it.** When the page's root element is
 * inserted, before anything is drawn, the colour comes from what the window
 * published in `sharedData`, which is read synchronously; the workspace's id
 * follows with the parent's first answer. Each later answer
 * from the parent is written the same way, and the page hears it as a
 * `SvalHomeWorkspaceService` event (`workspace.js`).
 */
export class SvalHomeWorkspaceChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "DOMDocElementInserted") {
      const look = Services.cpmm.sharedData.get(
        workspaceKey(this.#chromeOuterWindowID())
      );
      if (look) {
        this.#draw(look);
      }
      return;
    }
    const { type } = event.detail ?? {};
    if (type) {
      this.sendAsyncMessage(type);
    }
  }

  receiveMessage(message) {
    if (message.name !== "Workspace" || !this.#draw(message.data)) {
      return;
    }
    const window = this.contentWindow;
    window.dispatchEvent(
      new window.CustomEvent("SvalHomeWorkspaceService", {
        detail: Cu.cloneInto({ type: message.name }, window),
      })
    );
  }

  /**
   * The browser window's outer id, as `LightweightThemeChild` reads it, or 0,
   * which no window has.
   *
   * @returns {number}
   */
  #chromeOuterWindowID() {
    try {
      return this.docShell.browserChild?.chromeOuterWindowID ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Writes `look` onto the page's root. A look without `id`, as published in
   * `sharedData`, leaves the page's workspace as it is.
   *
   * @param {{id: (?string|undefined), key: ?string, tint: ?string,
   *   side: ?string, home: ?object}} look
   * @returns {boolean} whether there was a page to write it on.
   */
  #draw({ id, key, tint, side, home }) {
    const root = this.document?.documentElement;
    if (!root) {
      return false;
    }
    if (id) {
      root.setAttribute("data-sval-workspace", id);
    } else if (id !== undefined) {
      root.removeAttribute("data-sval-workspace");
    }
    const tinted = !!(key && tint && side && home);
    const properties = {
      "--g-tint": tinted && tint,
      "--h-wash-edge": tinted && home.edge,
      "--h-wash-mid": tinted && home.mid,
      "--h-glow": tinted && home.glow,
      "--h-body": tinted && home.body,
      "--h-muted": tinted && home.muted,
    };
    for (const [name, value] of Object.entries(properties)) {
      if (value) {
        root.style.setProperty(name, value);
      } else {
        root.style.removeProperty(name);
      }
    }
    if (tinted) {
      root.setAttribute("data-sval-ink", side);
      root.setAttribute("data-sval-tint", key);
    } else {
      root.removeAttribute("data-sval-ink");
      root.removeAttribute("data-sval-tint");
    }
    return true;
  }
}
