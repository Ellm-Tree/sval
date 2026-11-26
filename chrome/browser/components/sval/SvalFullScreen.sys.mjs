/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Escape takes a window out of full screen, on every platform, once
 * everything else that answers Escape has left it alone: the page, an open
 * menu or panel, the address bar, a Quick Peek, and Stop while a page loads.
 * These are the rules of `nsCocoaWindow::PostHandleKeyEvent`, which does
 * this on macOS alone and which Sval turns off
 * (`browser.fullscreen.exit_on_escape`), so one handler serves every
 * platform.
 *
 * A page's own full screen, as a video's, is Gecko's to end on Escape, and
 * this leaves it alone.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
});

/**
 * Escape events that reached the window while its page was loading. Stop's
 * `<key>` ends the load and leaves the event unprevented, so by the time
 * Escape reaches the end of its path the load it stopped is gone.
 *
 * @type {WeakSet<KeyboardEvent>}
 */
const duringLoad = new WeakSet();

export const SvalFullScreen = {
  /**
   * The window root is the first and last stop of a key event's path. Its
   * capturing listener sees Escape before Stop's `<key>` does; its bubbling
   * one sees it after the document's `<key>` elements and the window's own
   * listeners (Quick Peek's), so each of them has had Escape first.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const root = win.windowRoot;
    root.addEventListener(
      "keydown",
      event => {
        const stop = win.document.getElementById("Browser:Stop");
        if (event.key === "Escape" && !stop?.hasAttribute("disabled")) {
          duringLoad.add(event);
        }
      },
      { capture: true, mozSystemGroup: true }
    );
    root.addEventListener("keydown", event => onKeyDown(win, event), {
      mozSystemGroup: true,
    });
  },
};

/**
 * @param {Window} win
 * @param {KeyboardEvent} event
 */
function onKeyDown(win, event) {
  if (
    event.key !== "Escape" ||
    duringLoad.has(event) ||
    !event.isTrusted ||
    event.defaultPrevented ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    !win.fullScreen ||
    win.document.fullscreenElement ||
    event.target?.closest?.("menupopup, panel")
  ) {
    return;
  }
  if (lazy.SvalFirefox.awaitsPageReply(win, event)) {
    return;
  }
  event.preventDefault();
  win.document.getElementById("View:FullScreen").doCommand();
}
