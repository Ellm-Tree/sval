/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's panel toggle and history button (`SvalHeader`,
 * `sval-header.css`): the panel's slide, and what each toggle says of its
 * panel or sidebar, to a screen reader and to the eye, in a plain, a private
 * and an agent's window.
 */

/* import-globals-from head.js */
/* import-globals-from sval_header_toggle_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_header_toggle_helpers.js",
  this
);

add_task(async function the_panel_toggle_slides_the_panel_out_and_in() {
  const container = document.getElementById("sval-panel-container");
  const button = document.getElementById("sval-panel-button");
  Assert.ok(button, "the toggle is in the header");
  Assert.ok(
    !container.hasAttribute("sval-collapsed"),
    "the panel starts shown"
  );

  Assert.ok(await heardPressed(button), "the toggle is heard as pressed");

  const page = document.getElementById("tabbrowser-tabbox");
  const pushed = () =>
    page.style.getPropertyValue("--sval-push-sval-panel-container");
  const moving = () =>
    page.getAnimations().some(a => a.transitionProperty === "translate");
  const animated = !!parseFloat(getComputedStyle(container).transitionDuration);

  button.click();
  Assert.ok(container.hasAttribute("sval-collapsed"), "one press collapses it");
  Assert.equal(pushed(), "", "the page heads back to its place");
  if (animated) {
    Assert.ok(moving(), "moving with the panel");
  }
  await TestUtils.waitForCondition(
    async () => !(await heardPressed(button)),
    "and the toggle is heard as off"
  );
  await within(
    Promise.all(
      [...container.getAnimations(), ...page.getAnimations()].map(
        a => a.finished
      )
    ),
    10_000,
    "the panel and the page coming to rest"
  );

  button.click();
  Assert.ok(
    !container.hasAttribute("sval-collapsed"),
    "a second press shows it"
  );
  if (animated) {
    Assert.greater(parseFloat(pushed()), 0, "the page is pushed aside");
    Assert.ok(moving(), "as the panel slides in");
  }
  await TestUtils.waitForCondition(
    () => heardPressed(button),
    "and the toggle is heard as pressed again"
  );
  await TestUtils.waitForCondition(
    () => !container.hasAttribute("sval-overlay"),
    "the panel is back in the layout once it has slid in"
  );
  Assert.equal(pushed(), "", "and the page sits beside it, unmoved");
});

add_task(async function a_toggle_that_is_on_is_heard_and_seen_as_on() {
  await checkTogglesShowTheirState(window, "a plain window");
});

add_task(async function a_private_window_shows_its_toggles_state() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window's opening"
  );
  try {
    await checkTogglesShowTheirState(win, "a private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20_000,
      "the private window's closing"
    );
  }
});

/**
 * The same in an agent's window, once the user has taken control of it, as
 * Take control does: until then the window's commands are the agent's
 * (`SvalAgentMarking`).
 */
add_task(async function an_agent_window_shows_its_toggles_state() {
  const { holdWorkspace } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const { win, ws } = await agentSetup();
  holdWorkspace(ws, true);
  atTaskEnd(() => holdWorkspace(ws, false));
  Assert.ok(
    win.document.documentElement.hasAttribute("data-sval-agent"),
    "the window is an agent's"
  );
  await checkTogglesShowTheirState(win, "an agent's window");
});
