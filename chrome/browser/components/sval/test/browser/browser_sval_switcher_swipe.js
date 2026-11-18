/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A sideways scroll or two-finger swipe over the Workspace panel moves the
 * window to the next or previous Workspace in the switcher's order, one per
 * gesture (`SvalPanel._onPanelWheel`). The same scroll over the page is the
 * page's, and the switch in Settings › Keyboard shortcuts turns it off.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SWIPE_WORKSPACES_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

/** `SWIPE_REST_MS` in `sval-panel-switcher.js`. */
const SWIPE_REST_MS = 250;

/** The `timeStamp` of the last wheel event `wheel` sent. */
let lastWheelAt = -Infinity;

/**
 * Sends wheel events over the middle of `target`, all before anything they
 * start can run. A trackpad swipe and its momentum arrive as many small
 * events, so the deltas are split across `count` of them. Gecko marks the
 * first of a swipe and each of its momentum (`WheelEvent.isGestureStart`,
 * `isMomentum`), as a real trackpad's are.
 *
 * @param {Element} target
 * @param {object} delta Each event's.
 * @param {number} [delta.deltaX]
 * @param {number} [delta.deltaY]
 * @param {boolean} [delta.shiftKey]
 * @param {boolean} [delta.momentum] Whether the events are momentum.
 * @param {boolean} [delta.start] Whether the first starts a swipe.
 * @param {number} [count]
 */
function wheel(
  target,
  { deltaX = 0, deltaY = 0, shiftKey = false, momentum = false, start = false },
  count
) {
  const win = target.documentGlobal;
  const utils = win.windowUtils;
  const rect = target.getBoundingClientRect();
  const record = event => (lastWheelAt = event.timeStamp);
  win.addEventListener("wheel", record, true);
  try {
    for (let i = 0; i < (count ?? 10); i++) {
      if (start && i === 0) {
        // EventUtils has no option for a swipe's start.
        utils.sendWheelEvent(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          deltaX,
          deltaY,
          0,
          WheelEvent.DOM_DELTA_PIXEL,
          shiftKey ? utils.MODIFIER_SHIFT : 0,
          0,
          0,
          utils.WHEEL_EVENT_STARTS_GESTURE
        );
        continue;
      }
      EventUtils.synthesizeWheel(
        target,
        rect.width / 2,
        rect.height / 2,
        {
          deltaX,
          deltaY,
          shiftKey,
          isMomentum: momentum,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        },
        win
      );
    }
  } finally {
    win.removeEventListener("wheel", record, true);
  }
}

/**
 * Sends the fingers' part of one swipe over `target`: `deltas`, the first
 * marked as the swipe's start when `start` says so.
 *
 * @param {Element} target
 * @param {number[]} deltas Each event's `deltaX`.
 * @param {boolean} [start]
 */
function fingers(target, deltas, start = true) {
  deltas.forEach((deltaX, i) =>
    wheel(target, { deltaX, start: start && i === 0 }, 1)
  );
}

/**
 * Waits for the switch a swipe started while events go on arriving, one
 * each poll, well inside the rest that would end the gesture: the swipe's
 * momentum, slowing as a trackpad's does, or the fingers resting on it.
 *
 * @param {Element} target
 * @param {object} options
 * @param {boolean} options.momentum
 * @returns {Promise<void>}
 */
async function carryOnUntilSwitched(target, { momentum }) {
  let deltaX = momentum ? 25 : 2;
  let switched = false;
  const done = switchDone().then(() => (switched = true));
  await TestUtils.waitForCondition(() => {
    wheel(target, { deltaX, momentum }, 1);
    if (momentum) {
      deltaX = Math.max(1, deltaX * 0.95);
    }
    return switched;
  }, "the switch finishing while the swipe goes on");
  await done;
}

/**
 * Waits until the wheel has rested long enough that the next event starts
 * a gesture of its own, the one way a gesture ends.
 */
async function wheelRests() {
  await TestUtils.waitForCondition(
    () => performance.now() - lastWheelAt > SWIPE_REST_MS,
    "the wheel resting"
  );
}

/**
 * Whether a swipe-navigation gesture over `target` would start, as Firefox
 * asks before it tracks one (`nsIWidget::SendMayStartSwipe`, answered by
 * `gGestureSupport`).
 *
 * @param {Element} target
 * @returns {boolean}
 */
function swipeNavigationStarts(target) {
  const rect = target.getBoundingClientRect();
  let seen = null;
  const record = event => (seen = event);
  window.addEventListener("MozSwipeGestureMayStart", record, true);
  try {
    window.windowUtils.sendSimpleGestureEvent(
      "MozSwipeGestureMayStart",
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      SimpleGestureEvent.DIRECTION_LEFT,
      0,
      0
    );
  } finally {
    window.removeEventListener("MozSwipeGestureMayStart", record, true);
  }
  Assert.ok(seen, "the gesture's question reached the window");
  return seen.defaultPrevented;
}

add_task(async function a_sideways_scroll_over_the_panel_moves_one_workspace() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second] = ids.workspaces;
  // The profile's own Workspace comes before the task's in sibling order.
  const [profiles] = SvalTree.workspaceIds(SvalPanel.nodes);
  const tree = SvalPanel.container.querySelector(".sval-tree");
  const page = gBrowser.selectedBrowser;
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the window starts on the first"
  );

  wheel(page, { deltaX: 20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "a scroll over the page stays"
  );

  wheel(tree, { deltaY: 20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "a vertical scroll stays"
  );

  await SpecialPowers.pushPrefEnv({ set: [[SWIPE_WORKSPACES_PREF, false]] });
  wheel(tree, { deltaX: 20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "with the switch off, it stays"
  );
  await SpecialPowers.popPrefEnv();

  // The vertical scroll above was a gesture of its own, locked upright.
  await wheelRests();
  // A swipe's momentum goes on arriving while the switch it started runs,
  // and after. Each poll sends one more event, well inside the rest that
  // would end the gesture, so the whole of it is one gesture.
  wheel(tree, { deltaX: 20, start: true });
  await carryOnUntilSwitched(tree, { momentum: true });
  wheel(tree, { deltaX: 20, momentum: true });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "one gesture moves one place"
  );

  // A swipe back before the momentum has ended is a swipe of its own.
  wheel(tree, { deltaX: -20, start: true });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the other way moves back one"
  );

  await wheelRests();
  wheel(tree, { deltaX: -20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    profiles,
    "and to the list's first"
  );

  const last = SvalTree.workspaceIds(SvalPanel.nodes).at(-1);
  Assert.equal(last, ids.workspaces.at(-1), "the task's last is the list's");
  await wheelRests();
  wheel(tree, { deltaX: -20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    last,
    "before the first, it wraps"
  );

  await wheelRests();
  wheel(tree, { deltaX: 20 });
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    profiles,
    "and past the last, too"
  );

  // Shift turns a wheel sideways where Firefox scrolls sideways for it. On
  // macOS the system does that, and the event arrives with a deltaX.
  await wheelRests();
  wheel(tree, { deltaY: 20, shiftKey: true });
  await switchDone();
  const sideways =
    Services.prefs.getIntPref("mousewheel.with_shift.action") === 4;
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    sideways ? first : profiles,
    sideways ? "Shift with the wheel moves one" : "Shift with the wheel stays"
  );
});

/**
 * One swipe whose fingers slow and speed up again as they go is still one
 * swipe, and its momentum moves nothing: the window moves one place.
 */
add_task(async function a_swipe_that_slows_and_speeds_up_moves_once() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second] = ids.workspaces;
  const tree = SvalPanel.container.querySelector(".sval-tree");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the window starts on the first"
  );
  await wheelRests();

  fingers(tree, [2, 5, 10, 20, 30, 30, 25, 15, 8, 4, 3, 2, 2]);
  await carryOnUntilSwitched(tree, { momentum: false });
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "the swipe moves one place"
  );
  fingers(tree, [6, 12, 20, 30, 30, 25], false);
  wheel(tree, { deltaX: 20, momentum: true });
  await switchDone();
  Assert.equal(SvalWindowWorkspace.of(window).id, second, "and only one");
});

/**
 * Swipes one after another in the same direction each move the window,
 * the next begun while the last one's momentum still runs, so the wheel
 * never rests between them.
 */
add_task(async function swipe_after_swipe_moves_each_time() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second, third] = ids.workspaces;
  const tree = SvalPanel.container.querySelector(".sval-tree");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the window starts on the first"
  );
  await wheelRests();

  fingers(tree, [2, 5, 10, 20, 30, 30, 25]);
  await carryOnUntilSwitched(tree, { momentum: true });
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "a swipe right moves one"
  );
  fingers(tree, [10, 20, 30, 30, 25]);
  await carryOnUntilSwitched(tree, { momentum: true });
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "the next swipe right one more"
  );
});

/**
 * Each gesture is locked to the axis its first few pixels travel along. A
 * diagonal swipe that goes more sideways than up moves the window and holds
 * the tree still; a scroll that goes more up than sideways scrolls the tree
 * and moves no Workspace.
 */
add_task(async function a_gesture_keeps_to_the_axis_it_starts_on() {
  const { ids, engine } = await withSwitcherPanel({ workspaces: 2 });
  const [first, second] = ids.workspaces;
  for (let i = 0; i < 40; i++) {
    await engine.mutate({
      kind: "addTab",
      parent: first,
      name: `Tab ${i}`,
      url: `https://example.com/${i}`,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  }
  await SvalPanel.refresh();
  const tree = SvalPanel.container.querySelector(".sval-tree");
  Assert.greater(tree.scrollHeight, tree.clientHeight, "the tree scrolls");
  const prevented = [];
  const record = event => prevented.push(event.defaultPrevented);
  window.addEventListener("wheel", record);
  atTaskEnd(() => window.removeEventListener("wheel", record));

  // The task before ends on a gesture of its own, which this one's first
  // events would otherwise continue.
  await wheelRests();
  wheel(tree, { deltaX: 3, deltaY: 12 });
  await TestUtils.waitForCondition(
    () => tree.scrollTop > 0,
    "the mostly upright scroll scrolling the tree"
  );
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "and moving no Workspace"
  );
  Assert.ok(!prevented.includes(true), "it is left to scroll the tree");

  await wheelRests();
  prevented.length = 0;
  wheel(tree, { deltaX: 12, deltaY: 8 });
  Assert.deepEqual(
    [...new Set(prevented)],
    [true],
    "the mostly sideways swipe holds the tree still"
  );
  await switchDone();
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "and moves one Workspace"
  );
});

/**
 * A Workspace another window shows is a step like any other: the swipe
 * brings that window forward, as the switcher does, and the rest of the
 * gesture arriving over it moves nothing there.
 */
add_task(async function a_swipe_to_another_windows_workspace_raises_it() {
  const { ids } = await withSwitcherPanel({ workspaces: 2 });
  const [first, second] = ids.workspaces;
  Assert.ok(
    await within(
      SvalPanel.switchTo(second),
      10_000,
      "the switch to the second"
    ),
    "the window shows the second"
  );
  const other = await tearOff(first);
  window.focus();
  await untilFocused(window, "the first window taking focus back");
  const tree = win => win.SvalPanel.container.querySelector(".sval-tree");

  // The momentum goes on over the window that comes forward, where one more
  // step back would go to the profile's own Workspace.
  await wheelRests();
  wheel(tree(window), { deltaX: -20 });
  wheel(tree(other), { deltaX: -20 });
  await untilFocused(other, "the other window coming forward");
  await switchDone(window);
  await switchDone(other);
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "this window stays where it is"
  );
  Assert.equal(
    SvalWindowWorkspace.of(other).id,
    first,
    "and the rest of the gesture moves nothing in the window it raised"
  );
});

/**
 * Firefox's swipe navigation answers a gesture over the page and leaves one
 * over the panel alone, so a swipe over the panel never also goes Back.
 */
add_task(async function a_swipe_over_the_panel_never_navigates() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/1"),
    10_000,
    "the tab opening"
  );
  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    "https://example.com/2"
  );
  await pageReady(tab.linkedBrowser, "https://example.com/2");
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.canGoBack,
    "the tab having a page to go back to"
  );
  Assert.ok(
    swipeNavigationStarts(tab.linkedBrowser),
    "a swipe over the page goes Back"
  );
  Assert.ok(
    !swipeNavigationStarts(SvalPanel.container),
    "a swipe over the panel does not"
  );
});
