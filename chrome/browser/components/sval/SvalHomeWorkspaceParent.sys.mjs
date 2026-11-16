/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Tells the home page which workspace its tab is in and that workspace's
 * colour (pins spec §9, §12.5), when the page asks and whenever its window's
 * workspace or colour changes (`WINDOW_WORKSPACE_TOPIC`).
 *
 * The first paint needs no answer: the child draws the page in the look its
 * window publishes (`SvalPanelModel.workspaceKey`). This is what keeps it
 * right after that, and for a tab whose own workspace is not the one its
 * window shows.
 *
 * **Workspace names are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalHomePage } from "moz-src:///browser/components/sval/SvalHomePage.sys.mjs";
import { WINDOW_WORKSPACE_TOPIC } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

/** One per home page: answers it, and watches its window for it. */
export class SvalHomeWorkspaceParent extends JSWindowActorParent {
  #watching = false;

  #observer = {
    observe: subject => {
      if (subject === this.#browser?.documentGlobal) {
        this.#send();
      }
    },
  };

  didDestroy() {
    if (this.#watching) {
      this.#watching = false;
      Services.obs.removeObserver(this.#observer, WINDOW_WORKSPACE_TOPIC);
    }
  }

  get #browser() {
    return this.browsingContext.top.embedderElement;
  }

  receiveMessage({ name }) {
    if (name !== "Ask") {
      return;
    }
    if (!this.#watching) {
      this.#watching = true;
      Services.obs.addObserver(this.#observer, WINDOW_WORKSPACE_TOPIC);
    }
    this.#send();
  }

  #send() {
    const shown = SvalHomePage.workspaceOf(this.#browser);
    // A private window's page keeps its own palette (pins spec §9).
    if (!shown) {
      return;
    }
    try {
      this.sendAsyncMessage("Workspace", shown);
    } catch {
      // The page went away while the workspace was read.
    }
  }
}
