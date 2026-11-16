/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The address field's loading line (`SvalLoadLine`): drawn while the
 * selected tab's page loads, cleared once it has loaded, and redrawn for
 * whichever tab is selected.
 */

add_setup(failOnConsoleErrors);

/**
 * Opens a tab on a page that loads until the task releases it.
 *
 * @returns {Promise<{tab: Element, release: () => Promise}>}
 */
async function openHeldPage() {
  const key = crypto.randomUUID();
  const release = () => fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`);
  atTaskEnd(release);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: `${ROOT}sval_agent_slow.sjs?hold=${key}`,
      waitForLoad: false,
    }),
    10_000,
    "a held page's tab opening"
  );
  return { tab, release };
}

add_task(async function the_line_follows_the_selected_tabs_load() {
  const line = document.getElementById("sval-load-line");
  Assert.equal(
    line.parentElement.id,
    "urlbar-container",
    "the address field has a loading line"
  );
  const loaded = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a page opening"
  );
  // The page's load event comes before tabbrowser hears the load stop.
  await TestUtils.waitForCondition(
    () => !loaded.hasAttribute("busy"),
    "the page's load stopping"
  );
  Assert.ok(!line.hasAttribute("loading"), "a loaded page draws no line");

  const { tab: held, release } = await openHeldPage();
  await TestUtils.waitForCondition(
    () => line.hasAttribute("loading"),
    "a loading page draws the line"
  );

  await selectTab(loaded);
  Assert.ok(
    !line.hasAttribute("loading"),
    "selecting a loaded tab clears the line"
  );
  await selectTab(held);
  Assert.ok(
    line.hasAttribute("loading"),
    "selecting the loading tab draws it again"
  );

  await release();
  await TestUtils.waitForCondition(
    () => !held.hasAttribute("busy"),
    "the held page loading"
  );
  Assert.ok(!line.hasAttribute("loading"), "a finished load clears the line");
  Assert.equal(
    line.style.getPropertyValue("--sval-load"),
    "1",
    "after running it to the end"
  );
});
