/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The strip: every Workspace in a row in the switcher's place, when
 * Settings › Workspaces picks it. Choosing it keeps the window's Workspace.
 * A click or the arrow keys go to a Workspace, the wheel slides the strip
 * or steps along it as the setting says, and its right-click menu changes
 * what the strip shows of names.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SWITCHER_PREF, STRIP_NAMES_PREF, STRIP_WHEEL_PREF } = SvalPanelModel;

/** Shows the strip for the running task, and the menu again after it. */
async function useStrip() {
  await SpecialPowers.pushPrefEnv({ set: [[SWITCHER_PREF, "strip"]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const strip = SvalPanel._els.strip;
  await TestUtils.waitForCondition(
    () => strip.checkVisibility(),
    "the strip showing"
  );
  return strip;
}

/**
 * @param {string} id A Workspace id.
 * @returns {Element} the strip's item for it.
 */
function itemOf(id) {
  return SvalPanel._els.strip.querySelector(
    `.sval-strip-item[data-workspace-id="${CSS.escape(id)}"]`
  );
}

/**
 * Presses a strip item where it shows: the item beside the current one runs
 * past the track's edge when names show, so its centre can lie outside it.
 *
 * @param {Element} item
 * @param {object} [event] As `EventUtils.synthesizeMouse` takes it.
 */
function pressItem(item, event = {}) {
  const box = item.getBoundingClientRect();
  const view = SvalPanel._els.strip
    .querySelector(".sval-strip-view")
    .getBoundingClientRect();
  const left = Math.max(box.left, view.left);
  const right = Math.min(box.right, view.right);
  EventUtils.synthesizeMouse(
    item,
    (left + right) / 2 - box.left,
    box.height / 2,
    event
  );
}

/** @returns {?string} the Workspace the strip marks as selected. */
function selectedOnStrip() {
  return SvalPanel._els.strip.querySelector(
    '.sval-strip-item[aria-selected="true"]'
  )?.dataset.workspaceId;
}

/**
 * Waits for the switch something on the strip started.
 *
 * @param {string} id The Workspace it goes to.
 */
async function switched(id) {
  await within(
    SvalPanel._switching?.idle() ?? Promise.resolve(),
    10_000,
    "the switch"
  );
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === id && selectedOnStrip() === id,
    "the window and the strip on the Workspace"
  );
}

/**
 * Sends wheel events over the strip, all before anything they start can
 * run, as one turn of the wheel arrives.
 *
 * @param {number} deltaY Each event's.
 * @param {number} deltaMode Lines for a notched wheel, pixels for a
 *   trackpad.
 * @param {number} [count] How many events the turn is.
 */
function turnWheel(deltaY, deltaMode, count = 1) {
  const view = SvalPanel._els.strip.querySelector(".sval-strip-view");
  for (let i = 0; i < count; i++) {
    view.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode,
      })
    );
  }
}

/**
 * One sideways trackpad swipe over the strip, sent as Gecko delivers it:
 * the fingers' travel, its first event marked as the swipe's start, then
 * `coast` events of momentum, each marked so, slowing as a trackpad's does
 * (`WheelEvent.isGestureStart`, `isMomentum`).
 *
 * @param {number[]} deltas The fingers' events' `deltaX`.
 * @param {number} [coast] How many events of momentum follow.
 */
function swipe(deltas, coast = 6) {
  const utils = window.windowUtils;
  const view = SvalPanel._els.strip
    .querySelector(".sval-strip-view")
    .getBoundingClientRect();
  const send = (deltaX, options) =>
    utils.sendWheelEvent(
      view.left + view.width / 2,
      view.top + view.height / 2,
      deltaX,
      0,
      0,
      WheelEvent.DOM_DELTA_PIXEL,
      0,
      0,
      0,
      options
    );
  deltas.forEach((deltaX, i) =>
    send(deltaX, i === 0 ? utils.WHEEL_EVENT_STARTS_GESTURE : 0)
  );
  for (let i = 0; i < coast; i++) {
    send(25 * 0.95 ** i, utils.WHEEL_EVENT_CAUSED_BY_MOMENTUM);
  }
}

/**
 * @param {Element} row The strip's sliding row.
 * @returns {number} where it stands along the track.
 */
function translateOf(row) {
  return parseFloat(/translateX\((-?[\d.]+)px\)/.exec(row.style.transform)[1]);
}

/**
 * The strip of twelve named Workspaces, which overflows its track.
 *
 * @returns {Promise<object>} `{ ids, strip }`.
 */
async function overflowingStrip() {
  const names = Array.from({ length: 12 }, (_, i) => `Workspace number ${i}`);
  const { ids } = await withSwitcherPanel({ names });
  const strip = await useStrip();
  await TestUtils.waitForCondition(
    () => strip.hasAttribute("data-overflow"),
    "twelve named Workspaces overflowing the strip"
  );
  return { ids, strip };
}

/**
 * @param {Element} strip
 * @returns {Promise<void>} once the strip has stopped moving.
 */
async function settled(strip) {
  await TestUtils.waitForCondition(
    () => !strip.getAnimations({ subtree: true }).length,
    "the strip coming to rest"
  );
}

add_task(async function choosing_the_strip_keeps_the_workspace() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [, second] = ids.workspaces;
  await within(SvalPanel.switchTo(second), 10_000, "the switch to the second");
  Assert.ok(
    SvalPanel._els.switcher.checkVisibility(),
    "the menu's button shows by default"
  );

  const strip = await useStrip();
  Assert.ok(!SvalPanel._els.switcher.checkVisibility(), "in its place");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "the window stays put"
  );
  Assert.equal(selectedOnStrip(), second, "and the strip marks where it is");
  Assert.equal(
    strip.querySelectorAll('[aria-selected="true"]').length,
    1,
    "once"
  );
  Assert.deepEqual(
    Array.from(
      strip.querySelectorAll(".sval-strip-item"),
      el => el.dataset.workspaceId
    ).filter(id => ids.workspaces.includes(id)),
    ids.workspaces,
    "every Workspace, in order"
  );

  await SpecialPowers.pushPrefEnv({ set: [[SWITCHER_PREF, "menu"]] });
  await TestUtils.waitForCondition(
    () => SvalPanel._els.switcher.checkVisibility(),
    "the button back"
  );
  Assert.ok(!strip.checkVisibility(), "for the strip");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "and the window stays put"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_click_and_the_arrow_keys_switch() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second] = ids.workspaces;
  // The press goes where the item comes to rest, beside the current one.
  await settled(await useStrip());

  pressItem(itemOf(second));
  await switched(second);

  itemOf(second).focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
  await switched(first);
  await TestUtils.waitForCondition(
    () => document.activeElement === itemOf(first),
    "the keys moving focus with the switch"
  );
  Assert.equal(itemOf(first).tabIndex, 0, "the strip is one tab stop");
  Assert.equal(itemOf(second).tabIndex, -1, "on the current Workspace");
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
  await switched(second);
});

add_task(async function the_wheel_slides_either_end_to_the_centre() {
  const { ids, strip } = await overflowingStrip();
  const view = strip.querySelector(".sval-strip-view").getBoundingClientRect();
  const centre = view.left + view.width / 2;
  const items = strip.querySelectorAll(".sval-strip-item");
  const end = () =>
    strip.querySelector(".sval-strip-add").getBoundingClientRect();
  const start = () => items[0].getBoundingClientRect();
  await settled(strip);
  const before = end().right;

  turnWheel(100_000, WheelEvent.DOM_DELTA_PIXEL);
  await settled(strip);
  Assert.less(end().right, before, "the wheel slides the strip");
  Assert.lessOrEqual(
    Math.abs(end().right - centre),
    1,
    "until its end meets the track's centre, and no further"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    ids.workspaces[0],
    "without switching"
  );

  turnWheel(-100_000, WheelEvent.DOM_DELTA_PIXEL);
  await settled(strip);
  Assert.lessOrEqual(
    Math.abs(start().left - centre),
    1,
    "and back until its start meets the track's centre"
  );
});

add_task(async function a_notched_wheel_slides_one_workspace_a_turn() {
  const { strip } = await overflowingStrip();
  const row = strip.querySelector(".sval-strip-row");
  const items = strip.querySelectorAll(".sval-strip-item");
  const pitch =
    items[1].getBoundingClientRect().left -
    items[0].getBoundingClientRect().left;
  await settled(strip);
  const from = translateOf(row);

  info("Windows makes one turn six lines, by default");
  turnWheel(6, WheelEvent.DOM_DELTA_LINE);
  await settled(strip);
  const moved = from - translateOf(row);
  Assert.greater(moved, pitch / 2, "one turn slides the strip");
  Assert.less(moved, pitch * 1.5, "by about one Workspace");
});

add_task(async function each_turn_of_the_wheel_switches_once() {
  const { ids } = await overflowingStrip();
  const [, second, third] = ids.workspaces;
  await SpecialPowers.pushPrefEnv({ set: [[STRIP_WHEEL_PREF, "switch"]] });

  info("a trackpad swipe, its momentum included, is many events in pixels");
  turnWheel(15, WheelEvent.DOM_DELTA_PIXEL, 40);
  await switched(second);

  info("a notched wheel's turn is one event in lines");
  turnWheel(3, WheelEvent.DOM_DELTA_LINE);
  await switched(third);
  await SpecialPowers.popPrefEnv();
});

add_task(async function swipe_after_swipe_switches_each_time() {
  const { ids } = await overflowingStrip();
  const [, second, third] = ids.workspaces;
  await SpecialPowers.pushPrefEnv({ set: [[STRIP_WHEEL_PREF, "switch"]] });

  info("one swipe, its momentum included, switches once");
  swipe([2, 5, 10, 20, 30, 30, 25]);
  await switched(second);
  info("the next swipe in the same way, begun in the momentum, switches again");
  swipe([18, 22, 26, 30, 30, 25]);
  await switched(third);
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_swipe_that_slows_and_speeds_up_switches_once() {
  const { ids } = await overflowingStrip();
  const [, second] = ids.workspaces;
  await SpecialPowers.pushPrefEnv({ set: [[STRIP_WHEEL_PREF, "switch"]] });

  swipe([2, 5, 10, 20, 30, 30, 25, 15, 8, 4, 3, 2, 2, 6, 12, 20, 30, 30, 25]);
  await switched(second);
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "one Workspace along, no more"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_click_after_a_slide_glides_straight_there() {
  const { strip } = await overflowingStrip();
  const row = strip.querySelector(".sval-strip-row");
  turnWheel(100_000, WheelEvent.DOM_DELTA_PIXEL);
  await settled(strip);
  const from = translateOf(row);

  const seen = [];
  const watch = new MutationObserver(() => seen.push(translateOf(row)));
  watch.observe(row, { attributeFilter: ["style"] });
  const target = Array.from(strip.querySelectorAll(".sval-strip-item")).at(-1);
  EventUtils.synthesizeMouseAtCenter(target, {});
  await switched(target.dataset.workspaceId);
  await settled(strip);
  watch.disconnect();
  const to = translateOf(row);

  Assert.notEqual(to, from, "the strip moves to the Workspace clicked");
  for (const at of seen) {
    Assert.lessOrEqual(
      Math.min(from, to) - 0.5,
      at,
      "never past where it starts or ends"
    );
    Assert.lessOrEqual(at, Math.max(from, to) + 0.5, "on the way there");
  }
});

/**
 * Narrows the Workspace panel to `width` for the running task.
 *
 * @param {number} width
 */
async function panelAt(width) {
  atTaskEnd(() => {
    SvalPanel.settings.panelWidth = null;
    SvalPanel._applyPanelWidth();
  });
  SvalPanel.settings.panelWidth = width;
  SvalPanel._applyPanelWidth();
  const container = document.getElementById("sval-panel-container");
  await TestUtils.waitForCondition(
    () => Math.round(container.getBoundingClientRect().width) === width,
    `the panel ${width}px wide`
  );
}

/**
 * Whether a strip item's name shows whole: its text laid out no wider than
 * the box that shows it. Both in fractions of a pixel, where text cut by an
 * ellipsis can be short of its box by less than one.
 *
 * @param {Element} el A strip item.
 * @returns {boolean}
 */
function nameFits(el) {
  const name = el.querySelector(".sval-strip-name");
  if (!name.checkVisibility()) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(name);
  return (
    range.getBoundingClientRect().width <=
    name.getBoundingClientRect().width + 0.01
  );
}

add_task(async function names_show_whole_up_to_the_track_less_two_icons() {
  const long = "A Workspace whose name runs far past the strip's track";
  const { ids } = await withSwitcherPanel({
    names: ["Development", "3D Printing", long],
  });
  const [development, printing, overlong] = ids.workspaces;
  const strip = await useStrip();

  await SpecialPowers.pushPrefEnv({ set: [[STRIP_NAMES_PREF, "current"]] });
  await settled(strip);
  Assert.ok(nameFits(itemOf(development)), "the current name shows whole");
  await within(SvalPanel.switchTo(printing), 10_000, "the switch");
  await settled(strip);
  Assert.ok(nameFits(itemOf(printing)), "as does the next one's");

  await SpecialPowers.pushPrefEnv({ set: [[STRIP_NAMES_PREF, "all"]] });
  await settled(strip);
  Assert.ok(
    nameFits(itemOf(development)) && nameFits(itemOf(printing)),
    "with every name shown, each shows whole"
  );
  const view = strip.querySelector(".sval-strip-view").clientWidth;
  Assert.lessOrEqual(
    itemOf(overlong).getBoundingClientRect().width,
    view - 2 * 34 + 0.5,
    "a longer name stops at the track less two icons"
  );
  Assert.ok(!nameFits(itemOf(overlong)), "and is cut short there");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_narrow_panel_shows_icons_and_a_caption() {
  const { ids } = await withSwitcherPanel({
    names: ["Ceramics", "Garden", "Reading"],
  });
  const [first] = ids.workspaces;
  const strip = await useStrip();
  const caption = strip.querySelector(".sval-strip-caption");
  Assert.equal(strip.dataset.layout, "wide", "names in a wide panel");
  Assert.ok(!caption.checkVisibility(), "and no caption");

  await panelAt(160);
  await TestUtils.waitForCondition(
    () => strip.dataset.layout === "icons",
    "the strip down to icons"
  );
  Assert.ok(
    !itemOf(first).querySelector(".sval-strip-name").checkVisibility(),
    "the items show no names"
  );
  Assert.ok(caption.checkVisibility(), "the caption shows");
  Assert.equal(caption.textContent, "Ceramics", "naming the current one");

  await SpecialPowers.pushPrefEnv({ set: [[STRIP_NAMES_PREF, "none"]] });
  await TestUtils.waitForCondition(
    () => !caption.checkVisibility(),
    "no caption with icons only"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_48px_panel_stands_the_strip_up() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second] = ids.workspaces;
  const strip = await useStrip();
  await panelAt(48);
  await TestUtils.waitForCondition(
    () => strip.dataset.layout === "column",
    "the strip a column"
  );
  const tabs = strip.querySelector('[role="tablist"]');
  Assert.equal(tabs.getAttribute("aria-orientation"), "vertical");
  Assert.ok(
    !strip.querySelector(".sval-strip-caption").checkVisibility(),
    "no caption"
  );
  Assert.ok(strip.hasAttribute("data-overflow"), "more than the column holds");
  Assert.ok(
    !strip.querySelector(".sval-strip-line").checkVisibility() &&
      !strip.querySelector(".sval-strip-dots").checkVisibility(),
    "and no dots or line beside it"
  );
  const top = el => el.getBoundingClientRect().top;
  Assert.less(top(itemOf(first)), top(itemOf(second)), "one above another");

  itemOf(first).focus();
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  await switched(second);
});

add_task(async function the_current_workspace_opens_the_full_list() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, , third] = ids.workspaces;
  const strip = await useStrip();
  const menu = SvalPanel._els.switcherMenu;
  await settled(strip);

  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(itemOf(first), {});
  await within(shown, 10_000, "a click on the current Workspace opening it");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the click switches nothing"
  );
  Assert.equal(itemOf(first).getAttribute("aria-expanded"), "true");
  const track = strip
    .querySelector(".sval-strip-track")
    .getBoundingClientRect();
  const box = menu.getOuterScreenRect();
  const own = menu.getBoundingClientRect();
  const content = menu.shadowRoot
    .querySelector('[part~="content"]')
    .getBoundingClientRect();
  Assert.lessOrEqual(
    Math.abs(
      box.left + content.left - own.left - (window.mozInnerScreenX + track.left)
    ),
    1,
    "over the track"
  );
  Assert.greaterOrEqual(content.width, 219, "at least 220px wide");
  Assert.equal(
    menu.querySelectorAll('[aria-current="true"]').length,
    1,
    "with the current Workspace in it once"
  );
  await closeSwitcher(menu);

  info("Enter and Space open it from the keyboard");
  itemOf(first).focus();
  for (const key of ["KEY_Enter", " "]) {
    const opened = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeKey(key, {}, window);
    await within(opened, 10_000, `${key} opening the list`);
    await closeSwitcher(menu);
    itemOf(first).focus();
  }

  info("End and Home go to the last and the first");
  EventUtils.synthesizeKey("KEY_End", {}, window);
  await switched(third);
  const [profiles] = SvalTree.workspaceIds(SvalPanel.nodes);
  EventUtils.synthesizeKey("KEY_Home", {}, window);
  await switched(profiles);
});

add_task(async function the_right_click_menu_changes_the_names() {
  const { ids } = await withSwitcherPanel({ workspaces: 2 });
  const strip = await useStrip();
  await SpecialPowers.pushPrefEnv({ set: [[STRIP_NAMES_PREF, "all"]] });
  const menu = SvalPanel._els.workspaceMenu;
  // The strip glides from where the last task left it, and a press is made
  // where the item comes to rest.
  await settled(strip);

  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  pressItem(itemOf(ids.workspaces[1]), { type: "contextmenu" });
  await within(shown, 10_000, "the Workspace's menu opening");
  Assert.ok(
    !menu.querySelector(":scope > [data-open-workspace]").hidden,
    "it offers the Workspace a window of its own"
  );
  const hide = menu.querySelector(':scope > [data-strip-names="none"]');
  Assert.ok(
    menu.querySelector(':scope > [data-strip-names="all"]').hidden &&
      menu.querySelector(":scope > [data-strip-names-menu]").hidden,
    "names on every Workspace can only be hidden"
  );
  await chooseMenuItem(hide, menu, "Hide Workspace Names");
  await TestUtils.waitForCondition(
    () => strip.dataset.names === "none",
    "the strip showing icons only"
  );
  Assert.equal(
    Services.prefs.getStringPref(STRIP_NAMES_PREF),
    "none",
    "the same choice as Settings"
  );
  Assert.ok(
    !itemOf(ids.workspaces[0]).hasAttribute("data-shows-name"),
    "no Workspace's name shows"
  );
  await SpecialPowers.popPrefEnv();
});

/**
 * An agent app's Workspaces share one item, wearing the app's mark and how
 * many Workspaces it holds, so every session an agent starts does not
 * lengthen the strip. A click lists them, and picking one goes there. An
 * app with one Workspace is that Workspace's item, and an app Sval does not
 * know wears the robot.
 */
add_task(async function an_agent_apps_workspaces_share_one_item() {
  await withSwitcherPanel({ workspaces: 1 });
  const engine = SvalPanel.engine;
  const add = (label, name) =>
    engine.mutate({
      kind: "addAgentWorkspace",
      name,
      agentLabel: label,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  const one = await add("Claude Code", "Fix the build");
  const two = await add("Claude Code", "Write the docs");
  const lone = await add("Test Agent", "Look something up");
  leftWhenTheTaskEnds([one, two, lone]);
  await SvalPanel.refresh();
  const strip = await useStrip();
  await settled(strip);

  const apps = strip.querySelectorAll(".sval-strip-item[data-agent-app]");
  Assert.equal(apps.length, 1, "the app with two Workspaces has one item");
  const app = apps[0];
  Assert.equal(app.dataset.agentApp, "Claude Code", "named for the app");
  Assert.equal(
    app.querySelector(".sval-strip-count").textContent,
    "2",
    "counting its Workspaces"
  );
  const markOf = el =>
    window.getComputedStyle(el.querySelector(".sval-strip-face"), "::before")
      .maskImage;
  Assert.stringContains(
    markOf(app),
    "agent-brands/claudecode.svg",
    "it wears Claude Code's mark"
  );
  Assert.ok(itemOf(lone), "an app with one Workspace is that Workspace's item");
  Assert.stringContains(
    markOf(itemOf(lone)),
    "agent-robot.svg",
    "and an app Sval does not know wears the robot"
  );

  // The tile: the strip keeps the current Workspace centred, and the app's
  // name runs on past the track's end.
  EventUtils.synthesizeMouseAtCenter(app.querySelector(".sval-strip-tile"), {});
  await TestUtils.waitForCondition(
    () => SvalPanel._stripAppMenu?.state === "open",
    "the app's list"
  );
  const list = SvalPanel._stripAppMenu;
  Assert.equal(app.getAttribute("aria-expanded"), "true");
  Assert.deepEqual(
    Array.from(list.children, el => el.dataset.workspaceId).toSorted(),
    [one, two].toSorted(),
    "listing each of the app's Workspaces"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  list.activateItem(
    list.querySelector(`[data-workspace-id="${CSS.escape(two)}"]`)
  );
  await within(hidden, 10_000, "the list closing");
  await switched(two);
  Assert.equal(
    strip.querySelector('.sval-strip-item[aria-selected="true"]'),
    strip.querySelector('.sval-strip-item[data-agent-app="Claude Code"]'),
    "and the app's item is the one selected"
  );
});
