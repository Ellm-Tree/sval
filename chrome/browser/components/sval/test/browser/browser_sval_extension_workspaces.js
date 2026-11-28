/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * An extension kept to some Workspaces reaches nothing in a tab of another,
 * and leaves that window's extensions menu and toolbar; a pinned extension's
 * button shows only in the Workspaces its pin names
 * (`SvalExtensionWorkspaces`, extension-workspaces.patch).
 */

const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);
const { SvalExtensionWorkspaces } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs"
);

const ID = "workspaces@sval.invalid";
const EXAMPLE_PAGE = `https://example.com/document-builder.sjs?html=${encodeURIComponent(
  "<p>page</p>"
)}`;

add_setup(async function () {
  failOnConsoleErrors();
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * A second window, on a Workspace of its own that is deleted when the task
 * ends.
 *
 * @returns {Promise<{win: Window, workspace: string}>}
 */
async function secondWindow() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  await within(win.SvalPanel.started, 20_000, "its panel starting");
  const workspace = SvalWindowWorkspace.of(win).id;
  Assert.notEqual(workspace, SvalWindowWorkspace.of(window).id);
  atTaskEnd(async () => {
    if (SvalPanel.nodes[workspace]) {
      await removeWorkspace(workspace);
    }
  });
  return { win, workspace };
}

/**
 * Loads the extension under test, with a toolbar button and a content
 * script that marks every page of example.com, and a control extension
 * whose script marks every page, so a check of a page kept from the first
 * is made once the page's content scripts have run (`scriptKept`).
 *
 * @returns {Promise<object>}
 */
async function loadExtensions() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: ID } },
      browser_action: { default_area: "menupanel" },
      content_scripts: [
        {
          matches: ["https://example.com/*"],
          js: ["cs.js"],
          run_at: "document_end",
        },
      ],
    },
    files: {
      "cs.js": () => {
        document.documentElement.setAttribute("data-sval-cs", "ran");
      },
    },
    useAddonManager: "temporary",
  });
  const control = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: "control@sval.invalid" } },
      content_scripts: [
        { matches: ["<all_urls>"], js: ["c.js"], run_at: "document_idle" },
      ],
      permissions: ["<all_urls>"],
    },
    files: {
      "c.js": () => {
        document.documentElement.setAttribute("data-sval-control", "ran");
      },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  await control.startup();
  atTaskEnd(async () => {
    SvalExtensionWorkspaces.setAvailableIn(ID, null);
    SvalExtensionWorkspaces.setPinScope(ID, null);
    gUnifiedExtensions.pinToToolbar(widgetIdOf(), false);
    await extension.unload();
    await control.unload();
  });
  return extension;
}

function widgetIdOf() {
  return gUnifiedExtensions.browserActionFor(WebExtensionPolicy.getByID(ID))
    .widget.id;
}

/**
 * Resolves once the content script under test has marked `bc`'s page.
 *
 * @param {BrowsingContext} bc
 * @returns {Promise<void>}
 */
function scriptRuns(bc) {
  return within(
    SpecialPowers.spawn(bc, [], () => {
      const root = content.document.documentElement;
      if (root.hasAttribute("data-sval-cs")) {
        return undefined;
      }
      return new Promise(resolve => {
        new content.MutationObserver((records, observer) => {
          observer.disconnect();
          resolve();
        }).observe(root, { attributeFilter: ["data-sval-cs"] });
      });
    }),
    10_000,
    "the extension's script marking the page"
  );
}

/**
 * Gecko orders content scripts within one extension alone
 * (`gPendingScriptBlockers` in ExtensionContent.sys.mjs), and each
 * extension's injection waits for its own compile, so the control's mark
 * can come before the other extension's. Its matcher, which decides
 * injection, says whether the page is kept from it for good.
 *
 * @param {BrowsingContext} bc
 * @returns {Promise<boolean>} Whether the content script under test is
 *   kept from `bc`'s page: its matcher refuses the page, and it has not
 *   marked the page once the control's script has.
 */
async function scriptKept(bc) {
  await within(
    SpecialPowers.spawn(bc, [], () => {
      const root = content.document.documentElement;
      if (root.hasAttribute("data-sval-control")) {
        return undefined;
      }
      return new Promise(resolve => {
        new content.MutationObserver((records, observer) => {
          observer.disconnect();
          resolve();
        }).observe(root, { attributeFilter: ["data-sval-control"] });
      });
    }),
    10_000,
    "the control's script marking the page"
  );
  return SpecialPowers.spawn(bc, [ID], id => {
    const matched = content.WebExtensionPolicy.getByID(id).contentScripts.some(
      script => script.matchesWindowGlobal(content.windowGlobalChild)
    );
    return (
      !matched && !content.document.documentElement.hasAttribute("data-sval-cs")
    );
  });
}

/**
 * @param {Window} win
 * @returns {Promise<Element>} A new tab of `win` showing `EXAMPLE_PAGE`.
 */
function openPageIn(win) {
  return within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, EXAMPLE_PAGE),
    10_000,
    "the page loading"
  );
}

add_task(async function test_kept_to_one_workspace() {
  await loadExtensions();
  const here = SvalWindowWorkspace.of(window).id;
  const { win, workspace } = await secondWindow();
  SvalExtensionWorkspaces.setAvailableIn(ID, [workspace]);

  const there = await openPageIn(win);
  Assert.equal(
    there.linkedBrowser.browsingContext.svalWorkspace,
    workspace,
    "the tab carries its Workspace"
  );
  await scriptRuns(there.linkedBrowser.browsingContext);

  const tab = await openPageIn(window);
  Assert.equal(tab.linkedBrowser.browsingContext.svalWorkspace, here);
  Assert.ok(
    await scriptKept(tab.linkedBrowser.browsingContext),
    "nothing ran in the other Workspace's tab"
  );

  Assert.ok(
    !gUnifiedExtensions.getActivePolicies().some(policy => policy.id === ID),
    "this window's extensions menu leaves it out"
  );
  Assert.ok(
    win.gUnifiedExtensions.getActivePolicies().some(policy => policy.id === ID),
    "the Workspace's window lists it"
  );
});

add_task(async function test_scope_change_reloads_the_tabs_it_turns() {
  await loadExtensions();
  const tab = await openPageIn(window);
  await scriptRuns(tab.linkedBrowser.browsingContext);
  const { workspace } = await secondWindow();
  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await SvalExtensionSites.changeAndReload(ID, () =>
    SvalExtensionWorkspaces.setAvailableIn(ID, [workspace])
  );
  await within(reloaded, 10_000, "the tab reloading");
  Assert.ok(
    await scriptKept(tab.linkedBrowser.browsingContext),
    "the reloaded page is kept from it"
  );
});

add_task(async function test_pin_shows_in_its_workspaces() {
  await loadExtensions();
  const here = SvalWindowWorkspace.of(window).id;
  const { win } = await secondWindow();
  gUnifiedExtensions.pinToToolbar(widgetIdOf(), true);
  const nodeIn = w => CustomizableUI.getWidget(widgetIdOf()).forWindow(w).node;

  SvalExtensionWorkspaces.setPinScope(ID, [here]);
  await TestUtils.waitForCondition(
    () => nodeIn(win).hasAttribute("sval-workspace-hidden"),
    "the button leaves the other Workspace's toolbar"
  );
  Assert.ok(!nodeIn(window).hasAttribute("sval-workspace-hidden"));

  gUnifiedExtensions.pinToToolbar(widgetIdOf(), false);
  Assert.equal(
    SvalExtensionWorkspaces.pinScope(ID),
    null,
    "unpinning forgets the Workspaces"
  );
});

add_task(async function test_window_mid_layout_builds_no_button() {
  await loadExtensions();
  // Sval's own modules run at `browser-window-before-initial-xul-layout`,
  // before the window has a tabbrowser; a pass over every window made then
  // is what this stands in for.
  let midLayout = null;
  const opened = {
    observe(subject) {
      Services.obs.removeObserver(opened, "domwindowopened");
      subject.addEventListener(
        "MozBeforeInitialXULLayout",
        () => {
          midLayout = !subject.gBrowser;
          SvalExtensionWorkspaces.applyToAll();
        },
        { once: true }
      );
    },
  };
  Services.obs.addObserver(opened, "domwindowopened");
  atTaskEnd(() => {
    if (midLayout === null) {
      Services.obs.removeObserver(opened, "domwindowopened");
    }
  });
  await secondWindow();
  // The console check `failOnConsoleErrors` makes when the file ends reads
  // the error a button made in a window with no tabbrowser logs.
  Assert.strictEqual(midLayout, true, "the pass ran before the tabbrowser");
});
