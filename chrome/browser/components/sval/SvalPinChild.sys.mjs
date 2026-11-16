/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A pin's page, from inside it (pins spec §5): tells the parent the first
 * time the user touches the page, which settles its saved page, and hands a
 * plain click on a link to another site to the parent, which opens it in a
 * Quick Peek over the pin.
 *
 * Every web page's frames carry this actor, so a link in a frame of a pin's
 * page reaches Quick Peek too, and only a pin's page is told it is one, with the
 * pin's site and nothing else of its saved address: the parent tells each of
 * its documents as it is created (`SvalPin:Is`), and answers `SvalPin:Which`,
 * asked once per document on the first press, from its record of the tab
 * (`SvalPinPages`). A page told nothing behaves as any page does.
 *
 * The click is read as it bubbles to the top, after the page's own
 * listeners, so a link the page handles itself (`preventDefault`) stays the
 * page's: Gecko follows a link only afterwards, in the system group's pass
 * (`Element::PostHandleEventForLinks`). Only a link that would load the
 * whole page, or a new one, is taken; one aimed at a frame stays the
 * frame's. A sandboxed frame's links are Gecko's, which knows what its
 * sandbox lets it navigate or open. A click with a modifier goes where
 * `ClickHandlerParent` sends it: ⌘-click and a middle click open a tab, and
 * the Quick Peek's own click a Quick Peek (`SvalQuickPeek.openClick`).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  leavesPin: "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs",
  linkMessage: "moz-src:///browser/components/sval/SvalLinkClick.sys.mjs",
  linkOfClick: "moz-src:///browser/components/sval/SvalLinkClick.sys.mjs",
});

/** Listens in one frame of a web page. */
export class SvalPinChild extends JSWindowActorChild {
  /** `undefined` until asked, then the parent's answer: `{ site, quickPeek }` or null. */
  #pin = undefined;

  #asking = null;

  /** Whether the user has pressed a key or a button in this document. */
  #pressed = false;

  /** Whether the parent has been told of it. */
  #told = false;

  receiveMessage({ name, data }) {
    // The document is a pin's, told as it was created or when its tab was
    // pinned as it was.
    if (name === "SvalPin:Is") {
      this.#pin = data ?? null;
      this.#tell();
    }
  }

  /** @param {Event} event */
  handleEvent(event) {
    if (!event.isTrusted) {
      return;
    }
    switch (event.type) {
      case "mousedown":
      case "keydown":
        this.#pressed = true;
        this.#ask();
        this.#tell();
        break;
      case "click":
        this.#click(event);
        break;
    }
  }

  #ask() {
    if (this.#pin !== undefined || this.#asking) {
      return;
    }
    this.#asking = this.sendQuery("SvalPin:Which").then(
      answer => {
        this.#pin ??= answer ?? null;
        this.#tell();
      },
      () => {
        // The page went away while it was asked.
        this.#pin ??= null;
      }
    );
  }

  #tell() {
    // The page's own document settles it; a frame inside it, such as an
    // advertiser's, is no say in where the pin is.
    if (
      this.#pin &&
      this.#pressed &&
      !this.#told &&
      this.browsingContext === this.browsingContext.top
    ) {
      this.#told = true;
      this.sendAsyncMessage("SvalPin:Touched");
    }
  }

  /** @param {MouseEvent} event */
  #click(event) {
    const pin = this.#pin;
    if (
      !pin?.quickPeek ||
      this.browsingContext.sandboxFlags !== 0 ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const link = lazy.linkOfClick(event);
    if (
      !link ||
      !lazy.leavesPin(link.href, pin.site) ||
      link.node?.hasAttribute?.("download")
    ) {
      return;
    }
    const { node, doc } = link;
    const aimed = (
      node?.getAttribute?.("target") ||
      doc.querySelector("base[target]")?.getAttribute("target") ||
      ""
    ).toLowerCase();
    const top = this.browsingContext === this.browsingContext.top;
    const blank = aimed === "_blank";
    const whole =
      aimed === "_top" || ((aimed === "" || aimed === "_self") && top);
    if (!blank && !whole) {
      return;
    }
    event.preventDefault();
    this.sendAsyncMessage("SvalPin:QuickPeek", {
      ...lazy.linkMessage(link),
      blank,
    });
  }
}
