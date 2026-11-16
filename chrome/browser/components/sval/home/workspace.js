/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The page's side of its workspace (pins spec §9, §12.5). The
 * `SvalHomeWorkspace` actor writes the workspace's look onto the page's
 * root (`SvalHomeWorkspaceChild.sys.mjs`): `data-sval-workspace` the
 * workspace's id and `data-sval-tint` its colour, already there when this
 * script runs, and again after each answer, which the page hears as a
 * `SvalHomeWorkspaceService` event. The page asks again each time it is
 * shown, since a tab can move to another window while hidden, and when the
 * theme changes, since a colour resolves to a value of each theme's own.
 *
 * A page with a colour (`data-sval-tint`) is the night sky under a wash of
 * the colour, whatever the theme, and its text is light. A page with none
 * takes the theme's scheme, as the window does. The scheme is set here, as
 * the `light` class, and this script is not deferred, so the first paint
 * has it.
 *
 * `SvalHomeWorkspaceChanged` fires on the window when the workspace's id
 * changes. The page's own scripts are deferred and start after the first
 * look is written, so they read `data-sval-workspace` when they start and
 * listen for the event after.
 */
{
  const root = document.documentElement;
  const lightTheme = window.matchMedia("(prefers-color-scheme: light)");
  let shown = root.getAttribute("data-sval-workspace");

  const applyScheme = () => {
    root.classList.toggle(
      "light",
      !root.hasAttribute("data-sval-tint") && lightTheme.matches
    );
  };

  const ask = () => {
    window.dispatchEvent(
      new CustomEvent("SvalHomeWorkspace", { detail: { type: "Ask" } })
    );
  };

  window.addEventListener("SvalHomeWorkspaceService", () => {
    applyScheme();
    const id = root.getAttribute("data-sval-workspace");
    if (id !== shown) {
      shown = id;
      window.dispatchEvent(
        new CustomEvent("SvalHomeWorkspaceChanged", { detail: { id } })
      );
    }
  });

  lightTheme.addEventListener("change", () => {
    applyScheme();
    ask();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      ask();
    }
  });

  applyScheme();
  ask();
}
