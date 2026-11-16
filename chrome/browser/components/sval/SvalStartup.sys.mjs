/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Starts what Sval runs once for the whole process and that needs no window.
 *
 * `sval.manifest` registers {@link SvalStartup.init} under
 * `browser-before-ui-startup`, which `BrowserGlue._beforeUIStartup` calls once,
 * before the first window opens. Each start below needs to come before any
 * window can have loaded a page or a settings tab, and before settings sync
 * starts, so a switch it applies reaches the fingerprinting overrides; that
 * hook is earlier than all of them. What touches a window stays in
 * `SvalWindow`.
 */

import { SvalAddonsNav } from "moz-src:///browser/components/sval/SvalAddonsNav.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { start as startFingerprinting } from "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs";
import { SvalFavoritesProvider } from "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs";
import { SvalHistorySync } from "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs";
import { SvalHomePage } from "moz-src:///browser/components/sval/SvalHomePage.sys.mjs";
import { SvalJavascript } from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";
import { SvalLauncherCommands } from "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs";
import { SvalLauncherTabs } from "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs";
import { SvalPageStyle } from "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs";
import { SvalPins } from "moz-src:///browser/components/sval/SvalPins.sys.mjs";
import { SvalPreferences } from "moz-src:///browser/components/sval/SvalPreferences.sys.mjs";
import { SvalReleaseCandidates } from "moz-src:///browser/components/sval/SvalReleaseCandidates.sys.mjs";
import { SvalSiteProtections } from "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs";
import { startConsoleCapture } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

export const SvalStartup = {
  init() {
    // First, so browser code's errors from the rest of startup reach the log.
    startConsoleCapture();
    SvalPreferences.watch();
    // A device publishes nothing to the shared folder before its first time
    // reading (decision 1714), so it asks for one now.
    SvalClock.start();
    SvalAddonsNav.start();
    SvalHomePage.registerSearchActor();
    SvalHomePage.registerFavoritesActor();
    SvalHomePage.registerWorkspaceActor();
    // Before any page loads, so its first paint is in Sval's design.
    SvalPageStyle.registerActor();
    // Before any page loads, so a link in a pin's page to another site opens
    // a Quick Peek (pins spec §5).
    SvalPins.registerActor();
    SvalHomePage.watchNewTabs();
    SvalHistorySync.watchClears();
    // Before any window's address bar or home page field queries.
    SvalFavoritesProvider.register();
    SvalLauncherTabs.register();
    SvalLauncherCommands.register();
    SvalJavascript.start();
    startFingerprinting();
    SvalSiteProtections.start();
    SvalReleaseCandidates.start();
  },
};
