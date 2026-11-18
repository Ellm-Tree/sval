/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The pages the panel opens: Sval's settings, Import and Export.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

{
  /**
   * Sval's settings (spec §10.8): Sval's own categories in `about:preferences`,
   * which `SvalPreferences` puts there and the app menu's Settings opens. The
   * panel's notices open the category they concern, and pairing's two halves are
   * steps of the Sync and devices category.
   *
   * **`SvalTabs` recognises the same page** to keep a tab showing it out of the
   * user's document. The two must agree, or Sval publishes its own interface as a
   * node to every other device; `browser_sval_tabs.js` holds them to it.
   */
  const SVAL_SETTINGS_URL = "about:preferences";

  Object.assign(SvalPanel, {
    /**
     * Imports from other browsers (import spec §5): the import page asks, then
     * runs what the user chose through this panel, which holds the engine, and
     * shows its progress and result itself (messages spec §7).
     *
     * @param {object} [options]
     * @param {object[]} [options.plan] What first run's import step chose,
     *   which the page runs as it opens.
     * @param {string|null} [options.reuseWorkspace] First run's empty
     *   workspace, for the first imported window to fill (import spec §3).
     * @param {object} [options.roots] Where the readers look, for tests.
     * @returns {Promise<object|null>} `runImport`'s report, summed over every
     *   run the page made, or null when nothing was imported.
     */
    async openImport({ plan = null, reuseWorkspace = null, roots } = {}) {
      if (this._inMemory || !this._engine) {
        return null;
      }
      const { askImport } = ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalImport.sys.mjs"
      );
      let first = true;
      const run = (chosen, onProgress) => {
        // A run the page makes after the first (Try Again, a bookmarks file)
        // offers first run's workspace only while it is still the empty one.
        const reuse =
          first || !reuseWorkspace
            ? reuseWorkspace
            : this._emptyUnnamedWorkspace();
        first = false;
        return this._runImport(chosen, { reuseWorkspace: reuse, onProgress });
      };
      return askImport(window, { plan, run, roots });
    },

    /**
     * Exports to another browser, or everything Sval holds (export spec §4):
     * the export page asks, and writes through this panel's engine.
     *
     * @param {object} [options]
     * @param {string} [options.target] The target the page starts on:
     *   `sval` for the complete data, from Workspaces' Export all data.
     * @returns {Promise<void>}
     */
    async openExport({ target } = {}) {
      if (this._inMemory || !this._engine) {
        return;
      }
      const { askExport } = ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalExport.sys.mjs"
      );
      await askExport(window, { engine: this._engine, target });
    },

    /**
     * Runs an import the user has chosen, for the import page.
     *
     * @param {object[]} plan What `SvalImport.runImport` takes.
     * @param {object} [options]
     * @param {string|null} [options.reuseWorkspace] As `openImport` takes.
     * @param {Function} [options.onProgress] As `runImport` takes.
     * @returns {Promise<object>} `runImport`'s report.
     */
    async _runImport(plan, { reuseWorkspace = null, onProgress } = {}) {
      const { runImport } = ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalImport.sys.mjs"
      );
      const report = await runImport(plan, {
        engine: this._engine,
        reuseWorkspace,
        onProgress,
      });
      await this.refresh();
      this._publishSoon();
      return report;
    },

    /**
     * Whether import has anything to offer first run: any other browser on
     * this computer (import spec §5).
     *
     * @returns {Promise<boolean>}
     */
    async _importAvailable() {
      try {
        const { findAll } = ChromeUtils.importESModule(
          "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
        );
        return !!(await findAll()).length;
      } catch (err) {
        this._modules.SvalLog.warn(
          `looking for other browsers failed: ${this._modules.SvalLog.errorName(err)}`
        );
        return false;
      }
    },

    /**
     * The workspace this window shows, or `id`, when it is still the unnamed
     * one first launch made and holds nothing but the home page, which the
     * first imported window then fills (import spec §3).
     *
     * @param {?string} [id] The workspace, when it is one first run made
     *   that the window does not show yet.
     * @returns {string|null}
     */
    _emptyUnnamedWorkspace(id = this._workspace.id) {
      const node = id ? this._nodes[id] : null;
      if (!node || node.content?.name) {
        return null;
      }
      const { childrenByParent, TAB } = this._modules.SvalTree;
      const children = childrenByParent(this._nodes).get(id) ?? [];
      const onlyHome = children.every(
        child =>
          this._nodes[child]?.kind === TAB &&
          this._modules.SvalHomePage.isHomePage(this._nodes[child].content?.url)
      );
      return onlyHome ? id : null;
    },

    /**
     * Opens Sval's settings in a tab, or brings the settings tab already open
     * forward, at the category that holds `section`. The tab is filed in the
     * workspace like any other (spec §10.4), by the `TabOpen` that follows, and
     * opens at the end of the strip, as Firefox's `openPreferences` opens it,
     * so it is filed last in the workspace, outside every group. The tab it was
     * opened from is its owner, which `_findTabToBlurTo` goes back to when it
     * closes; `addTab` sets none for a tab it opens in the background.
     *
     * One tab, not one per press: a pairing offer is a file in the shared folder
     * and a second page would make a second one, leaving the user with two codes
     * and no way to tell which the other device is being shown. Only this
     * window's tabs are searched, which are the tabs of the workspace it shows
     * (spec §10.7): a settings tab in another workspace is that workspace's, and
     * Firefox's `openPreferences`, which searches every window through
     * `switchToTabHavingURI`, would switch the user away to it.
     *
     * `addTrustedTab` is what loads `about:preferences` with the system
     * principal, as Firefox's own `openPreferences` does.
     *
     * @param {string} [section] `"offer"`, `"claim"` or `"storage"`: which
     *   category opens and where the caret goes. With none, the Sync and devices
     *   category lands on its own title.
     * @returns {Element} the tab now showing the page.
     */
    openSettingsPage(section) {
      const isSettings = tab =>
        this._modules.SvalPreferences.isPreferencesURL(
          tab.linkedBrowser?.currentURI?.spec ?? ""
        );
      const existing = Array.from(window.gBrowser.tabs).find(isSettings);
      if (existing) {
        window.gBrowser.selectedTab = existing;
        // `?.` on `SvalSettings` covers a page whose Sval panes have not arrived
        // yet; it opens at whatever its URL named.
        existing.linkedBrowser.contentWindow?.SvalSettings?.focusSection(
          section
        );
        return existing;
      }
      const pane =
        section === "offer" || section === "claim" || section === "storage"
          ? `svalSync-${section}`
          : "svalSync";
      const tab = window.gBrowser.addTrustedTab(
        `${SVAL_SETTINGS_URL}#${pane}`,
        {
          ownerTab: window.gBrowser.selectedTab,
        }
      );
      window.gBrowser.selectedTab = tab;
      return tab;
    },
  });
}
