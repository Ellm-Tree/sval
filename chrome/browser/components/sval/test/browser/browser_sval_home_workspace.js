/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The home page knows the workspace its tab is in and wears that
 * workspace's colour, meeting the tinted frame without an edge (pins spec
 * §9, §12.5). It follows the colour as it changes, and a home tab moved to
 * another workspace wears that one's.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

/**
 * Gives a workspace a colour, or takes it away, as another device's edit
 * arrives: in the document, then drawn.
 *
 * @param {object} engine
 * @param {string} id A workspace id.
 * @param {string|null} color A palette token.
 */
async function colour(engine, id, color) {
  const now = Date.now();
  await engine.mutate({ kind: "setAppearance", id, color, emoji: null, now });
  await engine.sync(SYNC_DOCUMENT, now);
  await SvalPanel.refresh();
}

/**
 * The colour a declaration of `value` paints in this window, as RGBA, so two
 * routes to one colour compare equal.
 *
 * @param {string} value A CSS `<color>`.
 * @returns {object}
 */
function painted(value) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.documentElement.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return InspectorUtils.colorToRGBA(color);
}

/**
 * What the home page in `tab` shows of its workspace: the workspace and
 * colour on its root, the frame colour it was handed, and its field.
 *
 * @param {Element} tab
 * @returns {Promise<object>}
 */
function lookOf(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    const root = doc.documentElement;
    const style = content.getComputedStyle(root);
    const glow = doc.querySelector(".mark > .moon-glow");
    return {
      workspace: root.getAttribute("data-sval-workspace"),
      tint: root.getAttribute("data-sval-tint"),
      edge: root.style.getPropertyValue("--g-tint").trim(),
      wash: root.style.getPropertyValue("--h-wash-edge").trim(),
      glowColor: root.style.getPropertyValue("--h-glow").trim(),
      field: style.backgroundImage,
      light: root.classList.contains("light"),
      glow: glow && content.getComputedStyle(glow).backgroundImage,
      muted: content.getComputedStyle(doc.querySelector(".fav-switch")).color,
    };
  });
}

/**
 * Waits until the home page in `tab` reads as `workspace` in `tint`.
 *
 * @param {Element} tab
 * @param {string} workspace
 * @param {string|null} tint
 * @returns {Promise<object>} its look then.
 */
async function untilLook(tab, workspace, tint) {
  let look;
  await TestUtils.waitForCondition(
    async () => {
      look = await lookOf(tab);
      return look.workspace === workspace && look.tint === tint;
    },
    `the home page wears ${tint ?? "no colour"}`
  );
  return look;
}

/**
 * Opens a home tab in this window's workspace and waits for it to be filed.
 *
 * @returns {Promise<Element>}
 */
async function openHome() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:home"),
    10_000,
    "a home tab opening"
  );
  await TestUtils.waitForCondition(
    () => SvalTabs.nodeIdOf(tab),
    "the home tab is filed"
  );
  return tab;
}

add_setup(solidWindows);

add_task(async function a_home_tab_wears_its_workspaces_colour() {
  const { ids, engine, observer } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;
  const tab = await openHome();
  const untinted = await untilLook(tab, first, null);

  for (const token of ["purple", "blue", "yellow"]) {
    await colour(engine, first, token);
    const look = await untilLook(tab, first, token);
    Assert.deepEqual(
      painted(look.edge),
      painted("var(--sval-tint)"),
      `the page is handed ${token}'s frame colour`
    );
    Assert.notEqual(look.field, untinted.field, `a field in ${token}`);
    const { home } = SvalPanel.windowLookOf(token);
    Assert.deepEqual(
      painted(look.wash),
      painted(home.edge),
      `${token} washes the sky as strongly as its text allows`
    );
    Assert.ok(!look.light, `under ${token} the sky stays dark`);
    Assert.deepEqual(
      painted(look.glowColor),
      painted(home.glow),
      `the mark glows in ${token}`
    );
    Assert.notEqual(look.glow, untinted.glow, "in place of Sval's own glow");
    Assert.deepEqual(
      painted(look.muted),
      painted(home.muted),
      "and the switch's label solved on the wash"
    );
  }
  let look;

  await colour(engine, first, null);
  look = await untilLook(tab, first, null);
  Assert.equal(look.field, untinted.field, "no colour is the untinted page");
  Assert.equal(look.edge, "", "with no frame colour of its own");

  // Moved to a red workspace, the tab leaves this window; shown there, its
  // page is that workspace's.
  await colour(engine, second, "red");
  const node = SvalTabs.nodeIdOf(tab);
  // The fixture's observer holds its writes until asked, and the moved tab
  // comes back from what its node says it shows.
  await within(observer.settled(), 10_000, "observer settling");
  await SvalPanel.moveToWorkspace(node, second);
  await TestUtils.waitForCondition(
    () => !observer.tabFor(node),
    "the moved tab leaves the window"
  );
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window shows its workspace"
  );
  const moved = observer.tabFor(node);
  Assert.ok(moved, "where the moved tab is");
  await selectTab(moved);
  await pageReady(moved.linkedBrowser, "about:home");
  look = await untilLook(moved, second, "red");
  Assert.deepEqual(
    painted(look.edge),
    painted("var(--sval-tint)"),
    "and its page wears that workspace's colour"
  );
  Assert.deepEqual(
    painted(look.edge),
    painted(SvalColor.css(SvalPanel.windowLookOf("red").tint)),
    "red's"
  );
});
