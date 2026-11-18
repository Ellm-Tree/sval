/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the header toggle files share: how a screen reader hears a toggle,
 * what colour a toggle is painted, and the check that both of a window's
 * toggles say whether their panel shows.
 */

/**
 * Whether a screen reader hears `node` as pressed.
 *
 * @param {Element} node
 * @returns {Promise<boolean>}
 */
async function heardPressed(node) {
  const acc = await accessibleOf(node);
  const state = {};
  acc.getState(state, {});
  return !!(state.value & Ci.nsIAccessibleStates.STATE_PRESSED);
}

/**
 * The colour `node` is painted in: its own background over each ancestor's,
 * down to the first opaque one.
 *
 * @param {Element} node
 * @returns {{r: number, g: number, b: number}}
 */
function paintedColour(node) {
  const win = node.documentGlobal;
  const layers = [];
  for (let el = node; el; el = el.parentElement) {
    const layer = InspectorUtils.colorToRGBA(
      win.getComputedStyle(el).backgroundColor
    );
    layers.push(layer);
    if (layer.a === 1) {
      break;
    }
  }
  return layers.reduceRight(
    (under, { r, g, b, a }) => ({
      r: r * a + under.r * (1 - a),
      g: g * a + under.g * (1 - a),
      b: b * a + under.b * (1 - a),
    }),
    { r: 255, g: 255, b: 255 }
  );
}

/** Puts the theme back as the task found it, once the task has changed it. */
let restoreTheme = null;

/**
 * Puts Sval in the light or dark theme until the task ends, and waits for
 * `win` to draw in it. The pref is set directly: SpecialPowers' pref
 * environment waits for a frame of the test's own window, which another
 * window may cover. A window takes a theme change on its own refresh tick
 * (`nsPresContext::ThemeChanged`) and fires `nativethemechange` once it has.
 * A covered window may not tick at all, so the wait is on the window being
 * measured, which is in front.
 *
 * @param {Window} win
 * @param {boolean} dark
 */
async function inTheme(win, dark) {
  const name = "ui.systemUsesDarkTheme";
  const value = dark ? 1 : 0;
  const user = () =>
    Services.prefs.prefHasUserValue(name)
      ? Services.prefs.getIntPref(name)
      : null;
  if (!restoreTheme) {
    const before = user();
    // LightweightThemeConsumer writes the scheme it draws in to this pref
    // once a theme change reaches a window, after the change itself, and the
    // file's end compares every pref with its starting value.
    const toolbar = "browser.theme.toolbar-theme";
    const toolbarBefore = Services.prefs.getIntPref(toolbar);
    restoreTheme = async () => {
      restoreTheme = null;
      if (before === null) {
        Services.prefs.clearUserPref(name);
      } else {
        Services.prefs.setIntPref(name, before);
      }
      await TestUtils.waitForCondition(
        () => Services.prefs.getIntPref(toolbar) === toolbarBefore,
        "the windows draw in the theme they started in"
      );
    };
    atTaskEnd(() => restoreTheme?.());
  }
  if (user() === value) {
    return;
  }
  const applied = BrowserTestUtils.waitForEvent(win, "nativethemechange");
  Services.prefs.setIntPref(name, value);
  await within(
    applied,
    10_000,
    `the ${dark ? "dark" : "light"} theme reaching the window`
  );
}

/**
 * Checks that `win`'s panel toggle and history button each say whether their
 * panel shows, to a screen reader as pressed and to the eye as a fill 3:1
 * apart from the off button with a glyph 3:1 against that fill, in the light
 * theme and the dark. Leaves the
 * panel shown and the History sidebar closed.
 *
 * @param {Window} win
 * @param {string} where The window, for the assertions' messages.
 */
async function checkTogglesShowTheirState(win, where) {
  const doc = win.document;
  const panel = doc.getElementById("sval-panel-button");
  const history = doc.getElementById("sval-history-button");
  const toolbox = doc.getElementById("navigator-toolbox");
  const icon = button => button.querySelector(".toolbarbutton-icon");
  const settled = () =>
    TestUtils.waitForCondition(
      () =>
        ![toolbox, icon(panel), icon(history)].some(
          el => el.getAnimations().length
        ),
      "the header's colours settle"
    );
  const hideHistory = async () => {
    win.SidebarController.hide();
    await TestUtils.waitForCondition(
      async () =>
        !win.SidebarController.isOpen && !(await heardPressed(history)),
      "the history button is heard as off"
    );
  };

  for (const dark of [false, true]) {
    const theme = `${where}, ${dark ? "dark" : "light"}`;
    await inTheme(win, dark);
    try {
      Assert.ok(await heardPressed(panel), "the panel toggle is pressed");
      await win.SidebarController.show("viewHistorySidebar");
      await TestUtils.waitForCondition(
        () => heardPressed(history),
        "the history button is heard as pressed"
      );
      await settled();
      const on = [panel, history].map(button => paintedColour(icon(button)));
      for (const [i, button] of [panel, history].entries()) {
        const ratio = contrastRatio(
          win.getComputedStyle(icon(button)).fill,
          on[i]
        );
        Assert.greaterOrEqual(
          ratio,
          3,
          `${theme}: the ${button.id} glyph is ${ratio.toFixed(2)}:1 against its chip`
        );
      }

      panel.click();
      await TestUtils.waitForCondition(
        async () => !(await heardPressed(panel)),
        "the panel toggle is heard as off"
      );
      await hideHistory();
      await settled();
      const off = [panel, history].map(button => paintedColour(icon(button)));

      for (const [i, name] of ["panel toggle", "history button"].entries()) {
        const ratio = contrastRatio(on[i], off[i]);
        Assert.greaterOrEqual(
          ratio,
          3,
          `${theme}: the ${name}'s on state is ${ratio.toFixed(2)}:1 against off`
        );
      }
    } finally {
      if (win.SidebarController.isOpen) {
        await hideHistory();
      }
      if (!(await heardPressed(panel))) {
        panel.click();
        await TestUtils.waitForCondition(
          () => heardPressed(panel),
          "the panel shows again"
        );
      }
    }
  }
}

/**
 * Opens a window and switches it through a workspace of each of `colors`,
 * checking in each, in the light and dark themes, that the toggles show
 * their state (`checkTogglesShowTheirState`). The workspaces go when it ends.
 *
 * @param {string[]} colors Palette tokens.
 */
async function checkColouredWindows(colors) {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "the window's opening"
  );
  const ids = [];
  try {
    // The window's panel reaches the engine as it starts, and a switch needs
    // the engine.
    await within(win.SvalPanel.started, 20_000, "the window's panel startup");
    for (const color of colors) {
      const now = Date.now();
      const id = await SvalPanel.engine.mutate({
        kind: "addWorkspace",
        name: `Colour ${color}`,
        id: crypto.randomUUID(),
        now,
      });
      ids.push(id);
      await SvalPanel.engine.mutate({
        kind: "setAppearance",
        id,
        color,
        emoji: null,
        now,
      });
      Assert.ok(
        await SvalWindowWorkspace.of(win).switchTo(id),
        `switched to ${color}`
      );
      await TestUtils.waitForCondition(
        () => win.SvalPanel.windowColor === color,
        `the window wears ${color}`
      );
      await checkTogglesShowTheirState(win, `a ${color} window`);
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20_000,
      "the window's closing"
    );
    for (const id of ids) {
      await removeWorkspace(id);
    }
  }
}
