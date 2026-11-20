/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Everything the panel decides that does not need a DOM: which rows the tree
 * produces, what each row's ARIA numbers are, what a keystroke means, and how
 * a sync report should be worded.
 *
 * It is a separate module from the panel's scripts (`sval-panel*.js`) so this
 * half is testable under xpcshell, where there is no chrome window. Those
 * scripts are only the part that needs a document: elements, attributes and
 * focus.
 *
 * Nothing here reads a clock, mints an id, or touches storage. The view does
 * that, because the engine mints neither (host contract §3), and passes the
 * values in.
 */

import { agentBrandOf } from "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs";
import { colorOf } from "moz-src:///browser/components/sval/SvalColor.sys.mjs";
import {
  GROUP,
  SPLIT,
  TAB,
  WORKSPACE,
  ancestorIds,
  childrenByParent,
  descendantIds,
  displayName,
  isWithin,
  unreserved,
  workspaceIds,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

/**
 * The session-store key under which a window remembers the workspace it is
 * showing.
 *
 * Which workspace a window shows is **device-local and per window** (spec
 * §5.6, §10.7): it is a fact about a window on a machine, and putting it in
 * the synced document would drag one device's attention onto another's. Two
 * devices sitting in different workspaces at once is most of the point.
 *
 * `SessionStore.setCustomWindowValue` is the store because it is per window
 * and survives a restart, which is what §10.7 asks of a torn-off window;
 * `SvalLocalSettings` is per profile and cannot tell two windows apart. It
 * holds strings only, so a workspace id goes in as-is and an absent value
 * reads back as the empty string.
 */
export const CURRENT_WORKSPACE_KEY = "sval-current-workspace";

/**
 * The workspace a window created for itself, kept beside
 * {@link CURRENT_WORKSPACE_KEY} in the same store. Closing that window may
 * delete it if nobody touched it (decision 0101), and a window the session
 * brings back after Sval stopped without closing it has to know the same.
 */
export const MADE_WORKSPACE_KEY = "sval-made-workspace";

/**
 * The notification a browser window raises, with itself as the subject,
 * whenever the workspace it shows or that workspace's colour changes. The
 * home page redraws on it (pins spec §9).
 */
export const WINDOW_WORKSPACE_TOPIC = "sval-window-workspace";

/**
 * The notification a browser window's panel raises, with the window as the
 * subject, after every sync pass has been recorded. It is profile-wide, so a
 * page that follows it hears every window's passes: those of a panel that
 * starts after the page does, and those that go on after any one window
 * closes. The settings page redraws its sync readout on it (spec §10.8).
 */
export const SYNC_STATE_TOPIC = "sval-sync-state";

/**
 * The `sharedData` key under which a browser window's workspace look is
 * published for the home page, by the window's outer id, as Firefox
 * publishes a window's theme to its pages (`LightweightThemeConsumer`,
 * `LightweightThemeChild`).
 *
 * @param {number} outerWindowID The browser window's.
 * @returns {string}
 */
export function workspaceKey(outerWindowID) {
  return `sval-home-workspace/${outerWindowID}`;
}

/**
 * Workspaces handed to windows whose panel has not started yet, keyed by the
 * window itself and consumed by that panel.
 *
 * A module is one instance per process, which is what lets a tear-off (spec
 * §10.7) say something to a window that does not yet exist as far as its own
 * code is concerned.
 *
 * **This is a hand-off.** The record of what a window shows is
 * `CURRENT_WORKSPACE_KEY`, and the new window's own startup writes it. The
 * opener cannot: `setCustomWindowValue` throws "Window is not tracked" until
 * SessionStore has registered the window, which it does from
 * `browser-window-before-show`, and the observer order on a topic is not
 * defined.
 *
 * A `Map`, because {@link pendingHandOffs} lists it: a workspace handed to a
 * window that has not started is already that window's, and another window
 * must not take it meanwhile (spec §10.7). An entry goes when its window
 * starts, and an entry for a window that closed first goes the next time the
 * map is listed.
 */
const handedWorkspaces = new Map();

/**
 * Tells a window Sval has just opened which workspace it was opened for.
 *
 * @param {object} win The new chrome window.
 * @param {string} id A workspace id.
 * @param {object} [options]
 * @param {boolean} [options.agent] Whether the workspace is an agent's, so
 *   the window can wear the agent's marking before it has read the tree.
 */
export function handWorkspaceTo(win, id, { agent = false } = {}) {
  handedWorkspaces.set(win, { id, agent });
}

/**
 * @param {object} win A chrome window.
 * @returns {boolean} Whether the workspace {@link handWorkspaceTo} left for
 *   this window, not yet consumed, is an agent's.
 */
export function isHandedToAgent(win) {
  return handedWorkspaces.get(win)?.agent ?? false;
}

/**
 * What {@link handWorkspaceTo} left for this window, consumed.
 *
 * Consumed: after startup the per-window session-store value is the only
 * record of what a window shows, and a hand-off that survived would override
 * the user's own switching on the next read.
 *
 * @param {object} win A chrome window.
 * @returns {string|null} a workspace id, or null for a window nobody handed one
 *   to: an ordinary new window, and every window at launch.
 */
export function takeHandedWorkspace(win) {
  const id = handedWorkspaces.get(win)?.id ?? null;
  handedWorkspaces.delete(win);
  return id;
}

/**
 * The hand-offs no window has taken yet, as `[window, workspace id]` pairs.
 *
 * @returns {Array<[object, string]>}
 */
export function pendingHandOffs() {
  for (const win of handedWorkspaces.keys()) {
    if (win.closed) {
      handedWorkspaces.delete(win);
    }
  }
  return [...handedWorkspaces];
}

/**
 * The workspaces closed windows may still delete, until each window's last
 * flush has decided (`SvalTabObserver.detach` with `dropUntouched`). The
 * window is gone from the window list by then, and a window that took the
 * workspace meanwhile would be left showing a deleted one (spec §10.7,
 * decision 0101).
 */
const closingWorkspaces = new Map();

/**
 * Keeps `id` from every window until `flushed` settles.
 *
 * @param {string} id The workspace a closing window may delete.
 * @param {Promise} flushed That window's last flush.
 */
export function holdWhileClosing(id, flushed) {
  const settled = flushed.then(
    () => {},
    () => {}
  );
  closingWorkspaces.set(id, settled);
  settled.then(() => {
    if (closingWorkspaces.get(id) === settled) {
      closingWorkspaces.delete(id);
    }
  });
}

/**
 * @returns {Set<string>} the workspaces {@link holdWhileClosing} holds.
 */
export function heldWhileClosing() {
  return new Set(closingWorkspaces.keys());
}

/**
 * @param {string} id A workspace id.
 * @returns {Promise<void>} settles once no closed window may still delete
 *   `id` ({@link holdWhileClosing}).
 */
export async function closedWindowsDecided(id) {
  while (closingWorkspaces.has(id)) {
    await closingWorkspaces.get(id);
  }
}

/**
 * The type a dragged tree row carries in its `DataTransfer`, and the only one.
 *
 * A row is not a link: putting its URL on the drag as well would let a tab
 * row be dropped into a page or another application, which is a feature of
 * its own with its own questions. A type nothing else knows means only the
 * panel, and the pins row beside it, accept the drop.
 */
export const NODE_DRAG_TYPE = "application/x-sval-node";

const KNOWN_KINDS = new Set([WORKSPACE, GROUP, TAB, SPLIT]);

function isKnownKind(kind) {
  return KNOWN_KINDS.has(kind);
}

/**
 * Which kinds can hold children, and so can be expanded or collapsed. A split
 * holds its panes, but it is never collapsed, and a tab joins it only as its
 * rightmost pane (`joinSplitOps`, split-view spec §5.3).
 */
const CONTAINER_KINDS = new Set([WORKSPACE, GROUP]);

/** The most tabs one split shows side by side (split-view spec §5.1). */
export const SPLIT_MAX_PANES = 4;

/**
 * Which panes split `id` shows: its tabs in pane order, left to right, in
 * runs of up to {@link SPLIT_MAX_PANES}. A run of two or more is one split on
 * screen, and a run of one is an ordinary tab. A merge can leave a split
 * holding one tab, or more than four, and both are drawn and restored this
 * way (split-view spec §5.1): five tabs are a split of four and a tab, and a
 * split holding no tab shows nothing. The panel and the window's splits both
 * read this, so what the panel draws and what the window shows are one
 * answer.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A split's id.
 * @param {Map<string|null, string[]>} [byParent] {@link childrenByParent}'s
 *   answer, when the caller has it.
 * @returns {string[][]} the runs, in order.
 */
export function splitPanes(nodes, id, byParent = childrenByParent(nodes)) {
  const tabs = splitTabs(nodes, id, byParent);
  const runs = [];
  for (let at = 0; at < tabs.length; at += SPLIT_MAX_PANES) {
    runs.push(tabs.slice(at, at + SPLIT_MAX_PANES));
  }
  return runs;
}

/**
 * Whether `id` is a tab in a split.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @returns {boolean}
 */
export function isPane(nodes, id) {
  return nodes[nodes[id]?.placement?.parent]?.kind === SPLIT;
}

/**
 * What a change that takes `leaving` out of their places also writes, in the
 * same batch, for each split it takes a pane from (split-view spec §5.2). A
 * split left with one tab or none is removed, keeping what is in it, so its
 * tab is an ordinary tab where the split was. A split left with more keeps
 * them, and its widths go back to equal: a list of widths whose length is not
 * the number of panes is one the engine refuses.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {Iterable<string>} leaving Nodes the change moves or deletes, each
 *   with everything inside it.
 * @returns {object[]} operations, to follow the change's own.
 */
export function splitShapeOps(nodes, leaving) {
  const gone = new Set(leaving);
  const byParent = childrenByParent(nodes);
  const touched = new Set();
  for (const id of gone) {
    const parent = nodes[id]?.placement?.parent;
    if (nodes[parent]?.kind === SPLIT && !gone.has(parent)) {
      touched.add(parent);
    }
  }
  const ops = [];
  for (const split of touched) {
    if (ancestorIds(nodes, split).some(id => gone.has(id))) {
      continue;
    }
    const staying = (byParent.get(split) ?? []).filter(
      child => nodes[child]?.kind === TAB && !gone.has(child)
    );
    if (staying.length <= 1) {
      ops.push({ kind: "removeKeepingChildren", id: split });
    } else {
      ops.push(...resetWidthsOps(nodes, split));
    }
  }
  return ops;
}

/**
 * The op that drops a split's widths, so its panes share it equally, or none
 * when it holds none: `setContent` writes every content field, so the others
 * are passed back as they are.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} split A split's id.
 * @returns {object[]}
 */
function resetWidthsOps(nodes, split) {
  const content = nodes[split]?.content;
  return content?.shares
    ? [
        {
          kind: "setContent",
          id: split,
          name: content.name ?? "",
          url: content.url ?? null,
          icon: content.icon ?? null,
        },
      ]
    : [];
}

/**
 * @param {object} nodes The document's `nodes` map.
 * @param {string} split A split's id.
 * @param {Map<string|null, string[]>} [byParent] {@link childrenByParent}'s
 *   answer, when the caller has it.
 * @returns {string[]}
 */
export function splitTabs(nodes, split, byParent = childrenByParent(nodes)) {
  return (byParent.get(split) ?? []).filter(id => nodes[id]?.kind === TAB);
}

/**
 * Whether split `split` can take another pane: it holds fewer than
 * {@link SPLIT_MAX_PANES} tabs.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} split A node id.
 * @returns {boolean}
 */
export function splitHasRoom(nodes, split) {
  return (
    nodes[split]?.kind === SPLIT &&
    splitTabs(nodes, split).length < SPLIT_MAX_PANES
  );
}

/**
 * The one batch that adds tab `tab` to split `split` as its rightmost pane
 * (split-view spec §6.3): an Alt-click on it while a pane of `split` is
 * viewed, a drop on the split's row, or "Add to Split". The widths go back to
 * equal, because a list of widths whose length is not the number of panes is
 * one the engine refuses, and a split `tab` leaves stays in shape
 * (`splitShapeOps`).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} split The split it joins.
 * @param {string} tab The tab that joins it.
 * @returns {object[]|null} the batch's operations, or null when `tab` is no
 *   tab, is in `split` already, or `split` has no room.
 */
export function joinSplitOps(nodes, split, tab) {
  if (
    nodes[tab]?.kind !== TAB ||
    nodes[tab].placement?.parent === split ||
    !splitHasRoom(nodes, split)
  ) {
    return null;
  }
  return [
    {
      kind: "moveNode",
      id: tab,
      newParent: split,
      before: splitTabs(nodes, split).at(-1) ?? null,
      after: null,
    },
    ...resetWidthsOps(nodes, split),
    ...splitShapeOps(nodes, [tab]),
  ];
}

/**
 * The splits "Add to Split" offers tab `tab`: every split in workspace `root`
 * with room for it, in tree order, leaving out the one it is in. A split
 * holding one tab or none is drawn as no split (`splitPanes`), so it is not
 * offered either.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} tab The tab the menu is for.
 * @param {string|null} root The workspace the window shows.
 * @returns {string[]} split ids.
 */
export function addToSplitChoices(nodes, tab, root) {
  if (!root || !(root in nodes) || nodes[tab]?.kind !== TAB) {
    return [];
  }
  const byParent = childrenByParent(nodes);
  const out = [];
  const walk = parent => {
    for (const child of byParent.get(parent) ?? []) {
      const kind = nodes[child]?.kind;
      if (kind === SPLIT) {
        if (
          splitTabs(nodes, child, byParent).length > 1 &&
          joinSplitOps(nodes, child, tab)
        ) {
          out.push(child);
        }
      } else if (kind === GROUP) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The one batch an Alt-click on tab `clicked` writes while the user views tab
 * `selected` (split-view spec §5.2, §6.3), as Firefox's tab strip splits the
 * selected tab with an Alt-clicked one (`MozTabbrowserTab.on_click`). When
 * `selected` is in a split with room, `clicked` joins it as its rightmost
 * pane, and the widths go back to equal. Otherwise the two become a new split
 * at `selected`'s place, `selected` on the left; a `selected` in a full split
 * leaves it, and its split stays in shape (`splitShapeOps`).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} selected The tab the user is viewing.
 * @param {string} clicked The tab Alt-clicked.
 * @param {Function} newId Mints the id of a split the click makes.
 * @returns {object[]|null} the batch's operations, or null when the two are
 *   not two tabs that can be split: the same tab, not tabs, or `clicked`
 *   already a pane.
 */
export function altClickSplitOps(nodes, selected, clicked, newId) {
  if (
    !selected ||
    selected === clicked ||
    nodes[selected]?.kind !== TAB ||
    nodes[clicked]?.kind !== TAB ||
    isPane(nodes, clicked)
  ) {
    return null;
  }
  const byParent = childrenByParent(nodes);
  let place;
  if (isPane(nodes, selected)) {
    const split = nodes[selected].placement.parent;
    const join = joinSplitOps(nodes, split, clicked);
    if (join) {
      return join;
    }
    const parent = nodes[split].placement?.parent ?? null;
    const siblings = byParent.get(parent) ?? [];
    place = {
      parent,
      before: split,
      after: siblings[siblings.indexOf(split) + 1] ?? null,
    };
  } else {
    const parent = nodes[selected].placement?.parent ?? null;
    const siblings = byParent.get(parent) ?? [];
    place = {
      parent,
      before: siblings[siblings.indexOf(selected) - 1] ?? null,
      after: selected,
    };
  }
  const id = newId();
  return [
    { kind: "addSplit", id, ...place },
    {
      kind: "moveNode",
      id: selected,
      newParent: id,
      before: null,
      after: null,
    },
    {
      kind: "moveNode",
      id: clicked,
      newParent: id,
      before: selected,
      after: null,
    },
    ...splitShapeOps(nodes, [selected, clicked]),
  ];
}

/**
 * Which workspace a window shows, given what that window remembers.
 *
 * The remembered id wins whenever it is still a workspace in the document.
 * That is what keeps a workspace arriving from a peer from yanking the user
 * out of the one they are working in: a new root changes the list but not the
 * answer.
 *
 * When the workspace was deleted on another device, or this window has never
 * shown one, the first of the user's own workspaces in sibling order is
 * taken. An agent's workspace is taken only when the document holds no
 * workspace of the user's at all: a window the user opened is the user's, and
 * handing it an agent's workspace would put the user to work inside the
 * agent's window (agent-control spec §6). A window opened for an agent
 * (`SvalAgentTabs`) reaches its workspace as the remembered id. A phone's or
 * tablet's own workspace ({@link isDeviceWorkspace}) is passed over on the
 * same terms: its tabs are the ones opened on that device (decision 2254).
 *
 * A workspace has one window (spec §10.7), so a workspace another window
 * already shows is never the answer, remembered or not. `null` is the answer
 * only when no workspace is left for this window: the document holds none,
 * every one it holds has a window of its own, or every one left is an
 * agent's or a device's while the user has workspaces of their own.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} remembered What the window last showed, or null.
 * @param {{has: (id: string) => boolean}} [elsewhere] The workspaces other
 *   windows show.
 * @param {string|null} [after] A workspace the new window is opened from. The
 *   answer is then the first of the user's own workspaces below it in sibling
 *   order, wrapping at the bottom, that `elsewhere` does not hold, and `after`
 *   itself is never the answer; `remembered` does not apply. When `after` is
 *   not a workspace in the document, this is as if it were not given.
 * @returns {string|null} a workspace id present in the document and shown by
 *   no other window, or null when there is none.
 */
export function currentWorkspace(
  nodes,
  remembered,
  elsewhere = new Set(),
  after = null
) {
  const all = workspaceIds(nodes);
  const usersOwn = id =>
    agentLabelOf(nodes, id) === null && !isDeviceWorkspace(nodes, id);
  const from = after === null ? -1 : all.indexOf(after);
  if (from !== -1) {
    for (let step = 1; step < all.length; step++) {
      const id = all[(from + step) % all.length];
      if (usersOwn(id) && !elsewhere.has(id)) {
        return id;
      }
    }
    return null;
  }
  const ids = all.filter(id => !elsewhere.has(id));
  if (remembered && ids.includes(remembered)) {
    return remembered;
  }
  if (all.some(usersOwn)) {
    return ids.find(usersOwn) ?? null;
  }
  return ids[0] ?? null;
}

/**
 * The switcher's list: every workspace, in sibling order, saying which one
 * this window is showing.
 *
 * The list is never empty when a workspace exists, and a document holding
 * exactly one workspace still produces one entry, so the switcher names where
 * the user is and stays operable.
 *
 * Names are returned as the document holds them, empty string included. The
 * placeholder a nameless workspace reads as is a label the view draws
 * (`SvalPanel._untitled`), never a value, so it is not minted here.
 *
 * Colour and emoji come back beside the name because spec §10.7 shows them
 * wherever a workspace is named, and the switcher is where a workspace *is*
 * named: the workspace itself is not a row. The colour is filtered through
 * `SvalColor.colorOf`, so a colour this build cannot draw reads as no
 * colour. `agent` is the agent's label for an agent's workspace
 * ({@link agentLabelOf}), which the switcher marks with its app's mark,
 * `brand` ({@link agentBrandOf}), or with the robot face when the app is
 * none Sval knows. `device` is whether it is a phone's or tablet's own
 * ({@link isDeviceWorkspace}), which the switcher lists under Devices.
 * `elsewhere` is whether another window shows it, which is what keeps it out
 * of the switcher's "Open in New Window" list.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} current The workspace this window shows.
 * @param {{has: (id: string) => boolean}} [elsewhere] The workspaces other
 *   windows show.
 * @param {object} [devices] As {@link agentLabelOf} takes it.
 * @returns {object[]} `{ id, name, color, emoji, agent, brand, device,
 *   current, elsewhere }`,
 *   in sibling order.
 */
export function switcherItems(
  nodes,
  current,
  elsewhere = new Set(),
  devices = null
) {
  return workspaceIds(nodes).map(id =>
    itemOf(nodes, id, current, elsewhere, devices)
  );
}

/**
 * The change that moves workspace `id` to `side` (`"before"` or `"after"`)
 * of workspace `target` in `order`, the user's workspaces as the switcher
 * lists them. The engine's `moveWorkspace` keys it between the neighbours
 * it lands beside, so the order is the document's sibling order, synced as
 * any move is.
 *
 * @param {string[]} order
 * @param {string} id
 * @param {string} target
 * @param {string} side
 * @returns {?object} The `moveWorkspace` operation, or null when the move
 *   changes nothing or names a workspace not in `order`.
 */
export function moveWorkspaceOp(order, id, target, side) {
  const rest = order.filter(each => each !== id);
  const at = rest.indexOf(target);
  if (!order.includes(id) || at === -1) {
    return null;
  }
  const slot = side === "before" ? at : at + 1;
  if (order.indexOf(id) === slot) {
    return null;
  }
  return {
    kind: "moveWorkspace",
    id,
    before: rest[slot - 1] ?? null,
    after: rest[slot] ?? null,
  };
}

/**
 * Which Workspace switcher the panel shows (`app-sval-prefs.js`): one of
 * {@link SWITCHER_KINDS}. The strip's options are read only while it
 * shows.
 */
export const SWITCHER_PREF = "browser.sval.panel.switcher";
export const SWITCHER_KINDS = Object.freeze(["menu", "strip"]);
export const STRIP_NAMES_PREF = "browser.sval.panel.stripNames";
export const STRIP_NAMES = Object.freeze(["all", "current", "none"]);
export const STRIP_NAMES_AT_PREF = "browser.sval.panel.stripNamesAt";
export const STRIP_NAMES_AT = Object.freeze(["below", "beside"]);
export const STRIP_WHEEL_PREF = "browser.sval.panel.stripWheel";
export const STRIP_WHEELS = Object.freeze(["slide", "switch"]);
/** Whether the strip is folded away under its label row. */
export const STRIP_FOLDED_PREF = "browser.sval.panel.stripFolded";

/**
 * Reads one `wheel` event of a trackpad swipe, or of a smooth-scrolling
 * mouse's turn, into the gesture it belongs to, and says whether the
 * gesture moves now. Each gesture moves once, when the fingers' travel in
 * it reaches `stepPx`, and its momentum never moves.
 *
 * Gecko marks the event that starts a trackpad gesture and each event of
 * the momentum after the fingers lift (`WheelEvent.isGestureStart` and
 * `isMomentum`, `wheel-event-gesture-flags.patch`). Gecko sends no `wheel`
 * event without travel, so a gesture whose first event has none starts on
 * its next one unmarked. That event is still the fingers' own after
 * momentum, so the end of momentum starts a gesture too. A device that
 * marks neither starts one after a rest of `restMs`.
 *
 * @param {?object} gesture The gesture in progress, or null before one:
 *   `{ at, travel, dir, coasting }`, the `timeStamp` of its last event, the
 *   fingers' travel, the sign it moved by once it has, and whether its last
 *   event was momentum.
 * @param {object} event
 * @param {number} event.at The event's `timeStamp`.
 * @param {number} event.delta Its travel, in CSS pixels, signed.
 * @param {boolean} [event.momentum] Whether it is momentum.
 * @param {boolean} [event.start] Whether it starts a gesture.
 * @param {object} options
 * @param {number} options.restMs
 * @param {number} options.stepPx
 * @returns {{gesture: object, step: number}} The gesture to keep, and 1 or
 *   -1 when it moves now, 0 otherwise.
 */
export function wheelTurn(
  gesture,
  { at, delta, momentum = false, start = false },
  { restMs, stepPx }
) {
  let next = gesture;
  if (!next || start || (next.coasting && !momentum) || at - next.at > restMs) {
    next = { at, travel: 0, dir: 0, coasting: false };
  }
  next.at = at;
  next.coasting = momentum;
  if (momentum || next.dir || !delta) {
    return { gesture: next, step: 0 };
  }
  next.travel += delta;
  if (Math.abs(next.travel) < stepPx) {
    return { gesture: next, step: 0 };
  }
  next.dir = Math.sign(next.travel);
  return { gesture: next, step: next.dir };
}

/**
 * A gesture that has already moved by `dir`, for {@link wheelTurn} to pass
 * the rest of over, as when another window took its first move.
 *
 * @param {number} at
 * @param {number} dir
 * @returns {object}
 */
export function spentWheelTurn(at, dir) {
  return { at, travel: 0, dir, coasting: false };
}

/**
 * Where the strip of Workspaces rests along its track: the `translateX` that
 * puts the current item's centre at the track's centre, clamped so the
 * strip's start never passes the centre and its end never comes short of
 * it. The first and last items can still be centred, with empty track
 * beside them. A strip that fits does not move.
 *
 * @param {object} geometry
 * @param {number} geometry.width The track's inner width.
 * @param {number} geometry.total The strip's whole width.
 * @param {number} geometry.x The current item's start, along the strip.
 * @param {number} geometry.w The current item's width.
 * @returns {number}
 */
function stripRest({ width, total, x, w }) {
  if (total <= width) {
    return 0;
  }
  const centred = width / 2 - (x + w / 2);
  return Math.max(width / 2 - total, Math.min(width / 2, centred));
}

/**
 * How far the wheel can slide the strip from where it rests
 * ({@link stripRest}): as far as the resting place can go, until its start
 * or its end reaches the track's centre, so the wheel can bring any item to
 * the centre, clear of the edges' fade.
 *
 * @param {object} geometry As {@link stripRest} takes it.
 * @returns {{min: number, max: number}} The slide's least and greatest
 *   offset.
 */
export function stripSlideReach(geometry) {
  const rest = stripRest(geometry);
  if (geometry.total <= geometry.width) {
    return { min: 0, max: 0 };
  }
  return {
    min: geometry.width / 2 - geometry.total - rest,
    max: geometry.width / 2 - rest,
  };
}

/**
 * Where the strip sits along its track: where it rests, moved by `offset`,
 * the wheel's slide, within {@link stripSlideReach}.
 *
 * @param {object} geometry As {@link stripRest} takes it.
 * @param {number} [geometry.offset]
 * @returns {number}
 */
export function stripTranslate({ offset = 0, ...geometry }) {
  const { min, max } = stripSlideReach(geometry);
  return stripRest(geometry) + Math.max(min, Math.min(max, offset));
}

/**
 * One workspace's {@link switcherItems} entry, read without listing the
 * rest, for a caller that names one workspace many times over.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id
 * @param {string|null} current As {@link switcherItems} takes it.
 * @returns {?object} Its entry, or null when `switcherItems` lists no such
 *   workspace: one that is not a root of `nodes`, which `workspaceIds` lists
 *   alone.
 */
export function switcherItemOf(nodes, id, current) {
  const node = Object.hasOwn(nodes, id) ? nodes[id] : null;
  if (node?.kind !== WORKSPACE || (node.placement?.parent ?? null) !== null) {
    return null;
  }
  return itemOf(nodes, id, current, new Set(), null);
}

/**
 * @param {object} nodes
 * @param {string} id A root workspace of `nodes`.
 * @param {string|null} current
 * @param {{has: (id: string) => boolean}} elsewhere
 * @param {?object} devices
 * @returns {object} Its {@link switcherItems} entry.
 */
function itemOf(nodes, id, current, elsewhere, devices) {
  return {
    id,
    name: nodes[id]?.content?.name ?? "",
    color: colorOf(nodes[id]?.appearance?.color, "workspace"),
    emoji: unreserved(nodes[id]?.appearance?.emoji),
    agent: agentLabelOf(nodes, id, devices),
    brand: agentBrandOf(nodes[id]?.agent?.label),
    device: isDeviceWorkspace(nodes, id),
    current: id === current,
    elsewhere: elsewhere.has(id),
  };
}

/**
 * What an agent's window is titled with, before the agent's label
 * (agent-control spec §6). It is the robot face in the one place Sval cannot
 * draw its own icon, and for that reason the picker never offers it
 * (`scripts/generate-emoji-data.py`), so no workspace of the user's wears it.
 */
export const AGENT_EMOJI = "🤖";

/** A name's leading robot and the space after it. */
const LEADING_ROBOT = /^\u{1F916}\u{FE0F}?\s*/u;

/**
 * The label of the agent whose workspace `id` is, or null when it is no
 * agent's (agent-control spec §3.5).
 *
 * A mark whose label is missing or empty still says the workspace is an
 * agent's, so the window is marked all the same, under a generic name. An
 * agent's window drawn as the user's own would be the one mistake the marking
 * exists to prevent.
 *
 * An agent paired with another device reads "label · device name" when
 * `devices` is given and that device's name has arrived (history-sync spec
 * §4.3).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @param {object} [devices] `{ self, nameOf }`: this device's hex id, and
 *   a device's name by its hex id, or null.
 * @returns {string|null}
 */
export function agentLabelOf(nodes, id, devices = null) {
  const node = id === null || id === undefined ? null : nodes[id];
  if (node?.kind !== WORKSPACE) {
    return null;
  }
  const mark = node.agent;
  if (!mark || typeof mark !== "object") {
    return null;
  }
  const label =
    typeof mark.label === "string" && mark.label.trim()
      ? mark.label
      : "An agent";
  const device =
    devices && mark.device && mark.device !== devices.self
      ? devices.nameOf(mark.device)
      : null;
  return device ? `${label} · ${device}` : label;
}

/**
 * Whether `id` is a phone's or tablet's own workspace: one whose node
 * carries the `device_home` mark (decision 2254).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @returns {boolean}
 */
export function isDeviceWorkspace(nodes, id) {
  const node = id === null || id === undefined ? null : nodes[id];
  return node?.kind === WORKSPACE && !!node.device_home;
}

/**
 * Flattens one workspace into the rows the panel draws.
 *
 * **A window shows one workspace** (spec §10.7), so the top level of the tree
 * is that workspace's children rather than the document's roots, and the
 * workspace itself is not a row: the switcher above the tree is what names it.
 * Everything filed under the other workspaces is data this window does not
 * draw.
 *
 * The rows are flat because that is what makes `aria-level` meaningful and
 * what a virtualised list needs (spec §10.4). It is the shape
 * `devtools/client/shared/components/VirtualizedTree.js` uses.
 *
 * `setsize` and `posinset` count **every** sibling in the document, drawn or
 * not. Spec §10.4 requires that to stay true once rows virtualise, so they
 * are computed from the document instead of the row array.
 *
 * Every node is in some workspace's tree: the engine's sync pass repairs any
 * shape that would leave one out (spec §5.2, §10.7).
 *
 * **A collapsed container still draws the path to the selection**, as a
 * collapsed Firefox tab group still shows its active tab
 * (`MozTabbrowserTabGroup.hasActiveTab`): the tab the user is viewing always
 * has a row. Under the outermost collapsed container above the selection,
 * only the containers between it and the selection are drawn, each at its own
 * depth, and then the selection; every sibling off that path stays hidden.
 * Each container on the path keeps its own `expanded`, which is what
 * toggling it changes, and is marked `showsSelection`, because what is drawn
 * under it is that one path and not its contents.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {object} options
 * @param {Function} options.isCollapsed Given a node id, whether it renders
 *   collapsed. `SvalLocalSettings.isCollapsed` in production; spec §5.6 makes
 *   an id it has never seen collapsed, so a large tree arrives legible.
 * @param {string|null} options.root The workspace this window shows
 *   ({@link currentWorkspace}). A nullish root draws no workspace's children,
 *   which is the honest picture of a document holding no workspace.
 * @param {string|null} [options.selected] The selection
 *   (`SvalLocalSettings.selection`), drawn whatever is collapsed above it.
 * @param {Set<string>} [options.hidden] Tabs an extension hid
 *   (`tabs.hide`), which get no row and no place in `setsize`, as Firefox's
 *   tab strip draws none. Their nodes stay, and still count in `count`.
 * @param {Set<string>} [options.transparent] Containers drawn as their
 *   contents alone, each child in the container's place among its siblings:
 *   a group whose deletion moves its contents out, while the delete waits
 *   on the panel's Undo message.
 * @param {Function} [options.pendingName] Given a node id, the title its
 *   tab's page has set that the document does not hold yet, or undefined.
 *   A row shows it over the node's name (`SvalTabObserver.pendingName`).
 * @returns {object[]} `{ id, kind, name, url, color, tint, emoji, depth, setsize,
 *   posinset, hasChildren, expanded, showsSelection, firstShown, count, chain }`,
 *   in the order they are drawn. `firstShown` marks the first row drawn among
 *   its siblings, which is where a rail starts. `chain` lists the coloured
 *   groups the row sits in, outermost first and including the row itself when
 *   it is one, as `{ id, color, depth }`. `count` is the number of tabs a
 *   container holds at any depth, which is what a collapsed group shows
 *   beside its name. `color` is filtered through `SvalColor.colorOf`; `tint`
 *   is the row's own `color` or, failing that, the nearest ancestor's, which
 *   is what a tab inside a coloured group is filled with; `emoji` is whatever
 *   the document holds, byte for byte.
 *
 *   **A split is one row** (split-view spec §6.3), of kind `split`, at the
 *   split node's place, for each run of two or more panes {@link splitPanes}
 *   gives; a run of one is that tab's ordinary row. Its `split` is the split
 *   node's id, which is also its `id` for the first run, and `name` is the
 *   split's. Its `panes` are the panes' rows in pane order, each a tab row
 *   one level in, with `split` and its split row's id as `splitRow`, counted
 *   among its split's panes alone (`setsize`, `posinset`). A run of one
 *   drawn as its tab's row names its split as `inSplit`.
 */
export function rows(
  nodes,
  {
    isCollapsed,
    root,
    selected = null,
    hidden = new Set(),
    transparent = new Set(),
    pendingName = () => undefined,
  }
) {
  const byParent = childrenByParent(nodes);
  const out = [];
  // A title held back from the document stands in for the page's title, so
  // a label still wins over it.
  const nameOf = id =>
    nodes[id].appearance?.label ?? pendingName(id) ?? displayName(nodes[id]);
  const above = new Set(selected ? ancestorIds(nodes, selected) : []);
  const onPath = id => id === selected || above.has(id);

  const countTabs = id => {
    let total = 0;
    for (const child of byParent.get(id) ?? []) {
      total += nodes[child].kind === TAB ? 1 : 0;
      total += countTabs(child);
    }
    return total;
  };

  // A split's row: the split's name, and each pane as a tab row of its own
  // one level in, which is what the panel focuses, selects and acts on.
  const splitRow = ({ id, split, panes }, place) => ({
    id,
    kind: SPLIT,
    split,
    name: nodes[split].content?.name ?? "",
    url: null,
    color: null,
    tint: place.tint,
    emoji: null,
    depth: place.depth,
    setsize: place.setsize,
    posinset: place.posinset,
    hasChildren: false,
    expanded: false,
    showsSelection: false,
    firstShown: place.firstShown,
    count: panes.length,
    chain: place.chain,
    panes: panes.map((pane, index) => ({
      id: pane,
      kind: TAB,
      split,
      splitRow: id,
      name: nameOf(pane),
      url: nodes[pane].content?.url ?? null,
      color: null,
      tint: place.tint,
      emoji: unreserved(nodes[pane].appearance?.emoji),
      depth: place.depth + 1,
      setsize: panes.length,
      posinset: index + 1,
      hasChildren: false,
      expanded: false,
      showsSelection: false,
      firstShown: index === 0,
      count: 0,
      chain: place.chain,
    })),
  });

  // Each sibling as it is drawn: a node, or one split's run of panes
  // (`splitPanes`), which is one row holding them. A run left with one pane
  // is that tab's ordinary row.
  const drawnSiblings = all => {
    const drawn = [];
    for (const id of all) {
      const node = nodes[id];
      if (transparent.has(id)) {
        drawn.push(...drawnSiblings(byParent.get(id) ?? []));
        continue;
      }
      if (node?.kind !== SPLIT) {
        if (isKnownKind(node?.kind) && !hidden.has(id)) {
          drawn.push({ id });
        }
        continue;
      }
      splitPanes(nodes, id, byParent).forEach((run, index) => {
        const panes = run.filter(pane => !hidden.has(pane));
        if (panes.length > 1) {
          drawn.push({ id: index ? `${id}:${index}` : id, split: id, panes });
        } else if (panes.length) {
          drawn.push({ id: panes[0], inSplit: id });
        }
      });
    }
    return drawn;
  };

  // `pathOnly` is true under a collapsed container, where only the path to
  // the selection is drawn.
  const walk = (all, depth, inherited, outer, pathOnly = false) => {
    const siblings = drawnSiblings(all);
    const setsize = siblings.length;
    let firstShown = true;
    siblings.forEach((sibling, index) => {
      const { id } = sibling;
      if (pathOnly && !onPath(sibling.split ?? id)) {
        return;
      }
      if (sibling.split) {
        out.push(
          splitRow(sibling, {
            depth,
            setsize,
            posinset: index + 1,
            firstShown,
            tint: inherited,
            chain: outer,
          })
        );
        firstShown = false;
        return;
      }
      const node = nodes[id];
      const kind = node.kind;
      const children = byParent.get(id) ?? [];
      const hasChildren = CONTAINER_KINDS.has(kind) && !!children.length;
      const expanded = hasChildren && !isCollapsed(id);
      const color = colorOf(node.appearance?.color, "group");
      const tint = color ?? inherited;
      // Every coloured group from the outermost down to this row, so the panel
      // can draw a group inside a group as a surface inside a surface.
      const chain = color ? [...outer, { id, color, depth }] : outer;
      const showsSelection =
        hasChildren && above.has(id) && (pathOnly || !expanded);
      out.push({
        id,
        kind,
        name: nameOf(id),
        url: node.content?.url ?? null,
        color,
        tint,
        emoji: unreserved(node.appearance?.emoji),
        depth,
        setsize,
        posinset: index + 1,
        hasChildren,
        expanded,
        showsSelection,
        firstShown,
        count: hasChildren ? countTabs(id) : 0,
        chain,
        ...(sibling.inSplit ? { inSplit: sibling.inSplit } : {}),
      });
      firstShown = false;
      if (showsSelection) {
        walk(children, depth + 1, tint, chain, true);
      } else if (expanded) {
        walk(children, depth + 1, tint, chain);
      }
    });
  };

  walk(root && root in nodes ? (byParent.get(root) ?? []) : [], 0, null, []);
  return out;
}

/**
 * The index of the row in `drawn` that is `id` or holds it as a pane.
 *
 * @param {object[]} drawn Rows from {@link rows}.
 * @param {string|null} id A row or node id.
 * @returns {number} -1 when none does.
 */
export function rowIndexIn(drawn, id) {
  return drawn.findIndex(
    row => row.id === id || !!row.panes?.some(pane => pane.id === id)
  );
}

/**
 * What a name prompt's answer means.
 *
 * Returns only what the user typed, trimmed, or null. **An empty answer is a
 * refusal.** A prefilled or defaulted field that somebody confirms without
 * reading writes Sval's words into their data, on every device they own,
 * permanently. The caller then creates nothing and says so. Whitespace alone
 * counts as empty.
 *
 * @param {boolean} ok Whether the dialog was accepted.
 * @param {string} value What the field held.
 * @returns {string|null} the name, or null when there is none.
 */
export function chosenName(ok, value) {
  if (!ok) {
    return null;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

/**
 * What a Rename Split or Rename Tab prompt's answer means. A split's name and
 * a tab's label are shown in place of page titles, so an empty answer takes
 * the name away and the row shows the titles again (split-view spec §6.3);
 * only a cancel writes nothing.
 *
 * @param {boolean} ok Whether the dialog was accepted.
 * @param {string} value What the field held.
 * @returns {string|null} the name, "" for none, or null when cancelled.
 */
export function chosenOverName(ok, value) {
  if (!ok) {
    return null;
  }
  return typeof value === "string" ? value.trim() : "";
}

// ------------------------------------------------------------------ appearance

/**
 * Which coloured blocks end at which row, in the order {@link rows} gave them.
 *
 * A coloured group is drawn as a block (its header and everything visible
 * under it), and a group inside it as a block inside that one. The stylesheet
 * rounds a block's bottom corners on its last row, which is a fact about the
 * rows as drawn (a collapsed group's children are not there), so it is derived
 * from them on every draw.
 *
 * A block ends at the row after which the next row is no longer inside it.
 *
 * @param {object[]} drawn The result of {@link rows}.
 * @returns {Map<string, Set<string>>} for each row that ends at least one
 *   block, the ids of the coloured groups whose blocks end there.
 */
export function blockEnds(drawn) {
  const ends = new Map();
  drawn.forEach((row, index) => {
    const next = drawn[index + 1];
    for (const { id } of row.chain) {
      if (!next || !next.chain.some(entry => entry.id === id)) {
        if (!ends.has(row.id)) {
          ends.set(row.id, new Set());
        }
        ends.get(row.id).add(id);
      }
    }
  });
  return ends;
}

/**
 * Splits text into grapheme clusters, which is what "one emoji" means.
 *
 * A flag is two regional-indicator code points and a skin-toned figure is
 * several joined by zero-width joiners, so neither `value[0]` nor
 * `[...value][0]` is an emoji. The first slices a surrogate pair in half and
 * the second takes one code point out of a sequence. `Intl.Segmenter`'s
 * extended grapheme cluster rules keep both whole.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * What an emoji prompt's answer means.
 *
 * Cancelling changes nothing, an empty field **clears** the emoji, and
 * anything else sets the first grapheme cluster of what was typed. A person
 * who sets an emoji must be able to unset it, which an empty name cannot
 * mean ({@link chosenName}).
 *
 * The picker's own buttons answer with exactly one emoji and its search field
 * never reaches here, but a value is still cut to its first cluster: this is
 * the single place that decides what may be stored as an emoji.
 *
 * @param {boolean} ok Whether the picker was accepted.
 * @param {string} value What was chosen, or "" for none.
 * @returns {string|null|undefined} the emoji, null to clear it, or undefined
 *   when the user cancelled and nothing should be written.
 */
export function chosenEmoji(ok, value) {
  if (!ok) {
    return undefined;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  return GRAPHEMES.segment(trimmed)[Symbol.iterator]().next().value.segment;
}

/**
 * The picker groups a new workspace's starting emoji is drawn from: things and
 * places, which read as a label for a body of work. Faces, people, symbols and
 * flags are left out because they read as a mood, a person or a statement.
 */
const WORKSPACE_EMOJI_GROUPS = Object.freeze([
  "Animals & Nature",
  "Food & Drink",
  "Travel & Places",
  "Activities",
  "Objects",
]);

/**
 * An emoji to offer as a new workspace's starting point.
 *
 * It is only ever a suggestion in a field the user can change or clear: the
 * dialog shows it and nothing is written until they confirm. It is always the
 * plain character, so it carries no skin tone.
 *
 * @param {Array<{name: string, emoji: Array}>} groups `EMOJI_GROUPS`.
 * @param {() => number} [random] A `Math.random`-shaped source.
 * @returns {string|null} the emoji, or null if the data has none to offer.
 */
export function randomWorkspaceEmoji(groups, random = Math.random) {
  const pool = groups
    .filter(group => WORKSPACE_EMOJI_GROUPS.includes(group.name))
    .flatMap(group => group.emoji);
  if (!pool.length) {
    return null;
  }
  return pool[Math.min(Math.floor(random() * pool.length), pool.length - 1)][0];
}

/**
 * What the dialog that makes a workspace or a group answers (`SvalNewWorkspace`).
 *
 * The name is the only required part: without one nothing is created, for the
 * reason {@link chosenName} gives. The colour and emoji are each filtered by
 * the same rules as every other write of them, so the document never holds a
 * colour this build cannot draw or more than one emoji. Only a Workspace
 * keeps a transparency, with no colour too: no colour is Sval's own, which
 * can be see-through like any other (`SvalColor.windowLook`).
 *
 * @param {boolean} ok Whether the dialog was accepted.
 * @param {{name: string, color: string|object|null, emoji: string,
 *   transparency: number}} answer What the dialog held.
 * @param {"workspace"|"group"} [kind] What the dialog made or edited.
 * @returns {{name: string, color: string|object|null, emoji: string|null,
 *   transparency: number|null}|null} what to create, or null when nothing
 *   should be.
 */
export function chosenContainer(ok, answer, kind = "workspace") {
  const name = chosenName(ok, answer?.name);
  if (name === null) {
    return null;
  }
  const color = colorOf(answer.color, kind);
  const transparency =
    kind === "workspace" &&
    Number.isFinite(answer.transparency) &&
    answer.transparency > 0
      ? Math.min(1, answer.transparency)
      : null;
  return {
    name,
    color,
    emoji: chosenEmoji(true, answer.emoji) ?? null,
    transparency,
  };
}

/**
 * The five skin tones an emoji's `tones` list is ordered by, light to dark.
 * Named, because the picker's tone control is nothing but swatches and spec
 * §10.5 forbids an action that only sight can reach.
 */
export const SKIN_TONE_LABELS = Object.freeze([
  "Light",
  "Medium-light",
  "Medium",
  "Medium-dark",
  "Dark",
]);

/**
 * The emoji in a picker group that match a search.
 *
 * Every whitespace-separated word of the query has to appear somewhere in the
 * emoji's name, so "face smiling" finds "grinning face with smiling eyes" and
 * word order does not matter. An empty query matches everything, which is what
 * lets the picker show a whole group by default.
 *
 * @param {Array<{name: string, emoji: Array}>} groups `EMOJI_GROUPS`.
 * @param {string} query What was typed.
 * @returns {Array} the matching `[character, name, tones?]` entries, in the
 *   order the groups list them.
 */
export function searchEmoji(groups, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const group of groups) {
    for (const entry of group.emoji) {
      const name = entry[1].toLowerCase();
      if (words.every(word => name.includes(word))) {
        matches.push(entry);
      }
    }
  }
  return matches;
}

/**
 * The character a picker entry shows and answers with at a skin tone.
 *
 * An entry with no `tones` has none to give, so every tone index reads as the
 * plain character. That includes an out-of-range index: the answer is written
 * to the document, and a document must never be handed a non-string.
 *
 * @param {Array} entry A `[character, name, tones?]` entry.
 * @param {number|null} tone 0 (light) to 4 (dark), or null for the default.
 * @returns {string} the character.
 */
export function emojiAtTone(entry, tone) {
  const variants = entry[2];
  if (!variants || tone === null || tone === undefined) {
    return entry[0];
  }
  return variants[tone] ?? entry[0];
}

/**
 * What a window's title is prefaced with: the workspace it shows.
 *
 * A window shows one workspace (spec §10.7), and nothing else in the chrome
 * says which, so the title is where it goes. That is what makes a torn-off
 * window identifiable from the Dock and from ⌘` alone.
 *
 * `titlepreface` on the document element is Firefox's own hook for this
 * (`tabbrowser.js`'s `#determineContentTitle`). The preface is concatenated
 * straight onto the page's title, so the trailing separator is ours.
 *
 * A leading robot is taken off the name, so no workspace of the user's
 * titles its window the way an agent's does ({@link AGENT_EMOJI}).
 *
 * @param {string|null} emoji The workspace's emoji, or null.
 * @param {string} name What the workspace is called. The label the view draws,
 *   placeholder included: inventing the placeholder here would be minting a
 *   name (see {@link switcherItems}).
 * @param {string} [placeholder] What the view calls a nameless workspace,
 *   for a name that was nothing but the robot.
 * @returns {string} the preface, or "" when there is no workspace to name.
 */
export function windowTitlePreface(emoji, name, placeholder = "") {
  const shown = (name ?? "").replace(LEADING_ROBOT, "") || placeholder;
  if (!shown) {
    return "";
  }
  return `${emoji ? `${emoji} ` : ""}${shown} — `;
}

/**
 * What a keystroke on a focused row means.
 *
 * Kept as a pure function of the key and the row's state so the whole
 * keyboard map is asserted in xpcshell, where a real key event cannot be
 * dispatched. `sval-panel-input.js` does nothing with a key but ask this and
 * act.
 *
 * The arrow behaviour is the ARIA tree pattern: Right on a collapsed parent
 * expands it, on an expanded parent moves to its first child (the next row),
 * and does nothing on a leaf. Left collapses an expanded parent and otherwise
 * moves to the parent row.
 *
 * Alt with an arrow moves the node instead of the focus, because no action
 * may be mouse-only (spec §10.5): every direction a drag can express has a
 * key.
 *
 * A pane of a split row (split-view spec §6.3) is drawn side by side with its
 * split's other panes, so Left and Right move between them, and with Alt move
 * the pane itself; Up and Down still go from row to row, and with Alt move
 * the split.
 *
 * Shift with Up or Down extends the selection, Ctrl+Space adds the focused
 * row to it or takes it out, and Escape clears it: the ARIA tree pattern's
 * keys for a multi-select tree (spec §10.5). Escape is the panel's only
 * while there is a selection to clear.
 *
 * @param {object} event `{ key, altKey, ctrlKey, metaKey, shiftKey }`: a
 *   `KeyboardEvent` or a plain object.
 * @param {object} row A row from {@link rows}, or null when nothing is focused.
 * @param {object} [options]
 * @param {boolean} [options.selecting] Whether rows are selected beyond the
 *   tab on screen.
 * @returns {string|null} A command name, or null when the key is not ours and
 *   must be left to the browser.
 */
export function keyCommand(event, row, { selecting = false } = {}) {
  const { key, altKey, ctrlKey, metaKey, shiftKey } = event;

  // The context-menu key and Shift+F10 open the row's menu. Only the Windows
  // and GTK widgets turn them into a `contextmenu` event; the Cocoa widget
  // makes one only for an assistive technology's
  // `showContextMenuForSelection:`, so on macOS the key is the keyboard's one
  // way to the menu's commands.
  if (
    !altKey &&
    !ctrlKey &&
    !metaKey &&
    (key === "ContextMenu" || (key === "F10" && shiftKey))
  ) {
    return row ? "contextMenu" : null;
  }

  const selectionCommand = selectionKey(event, row);
  if (selectionCommand) {
    return selectionCommand;
  }

  if (ctrlKey || metaKey || shiftKey) {
    return null;
  }

  if (altKey) {
    if (!row) {
      return null;
    }
    switch (key) {
      case "ArrowUp":
        return "moveBefore";
      case "ArrowDown":
        return "moveAfter";
      // A pane moves within its run, as its menu offers (`splitPanes`).
      case "ArrowLeft":
        if (row.split) {
          return row.posinset > 1 ? "movePaneLeft" : null;
        }
        return "moveOut";
      case "ArrowRight":
        if (row.split) {
          return row.posinset < row.setsize ? "movePaneRight" : null;
        }
        return "moveIn";
      default:
        return null;
    }
  }

  switch (key) {
    case "ArrowDown":
      return "focusNext";
    case "ArrowUp":
      return "focusPrevious";
    case "Home":
      return "focusFirst";
    case "End":
      return "focusLast";
    case "Escape":
      return selecting ? "clearSelection" : null;
    default:
      break;
  }

  if (!row) {
    return null;
  }

  if (row.split && (key === "ArrowRight" || key === "ArrowLeft")) {
    return key === "ArrowRight" ? "focusNextPane" : "focusPreviousPane";
  }

  switch (key) {
    case "ArrowRight":
      if (!row.hasChildren) {
        return null;
      }
      return row.expanded ? "focusNext" : "expand";
    case "ArrowLeft":
      if (row.hasChildren && row.expanded) {
        return "collapse";
      }
      return row.depth > 0 ? "focusParent" : null;
    case "Enter":
      return "activate";
    // Space does what Enter does: the selection is the tab being viewed, so
    // a key that moved it without showing the page would report one tab as
    // selected while another is on screen.
    case " ":
      return "activate";
    case "F2":
      return "rename";
    case "Delete":
    case "Backspace":
      // A tab closes. A group is deleted, which asks what becomes of its
      // contents first (spec §5.4).
      return row.kind === GROUP ? "deleteGroup" : "close";
    default:
      return null;
  }
}

/**
 * The selection's modified keys, for {@link keyCommand}: Shift with Up or
 * Down, and Ctrl+Space.
 *
 * @param {object} event As {@link keyCommand} takes it.
 * @param {object|null} row The focused row.
 * @returns {string|null}
 */
function selectionKey(event, row) {
  const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
  if (altKey || metaKey || ctrlKey === shiftKey) {
    return null;
  }
  if (shiftKey) {
    return { ArrowDown: "extendNext", ArrowUp: "extendPrevious" }[key] ?? null;
  }
  return key === " " && row ? "toggleSelected" : null;
}

/**
 * The rows a Shift-click or Shift with an arrow selects: every row from
 * `from` to `to`, inclusive, in the order they are drawn, whichever comes
 * first.
 *
 * @param {string[]} ids Each drawn row's id, a split's panes one by one.
 * @param {string|null} from Where the range starts.
 * @param {string} to The row clicked or moved to.
 * @returns {string[]} the range, or `to` alone when `from` is not drawn.
 */
export function rangeIds(ids, from, to) {
  const start = ids.indexOf(from);
  const end = ids.indexOf(to);
  if (end < 0) {
    return [];
  }
  if (start < 0) {
    return [to];
  }
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The nodes of a selection that move: each one, once, less any inside
 * another of them, which goes with the one it is in.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string[]} ids Node ids, in the order they are drawn.
 * @returns {string[]} in the same order.
 */
export function outermostIds(nodes, ids) {
  const unique = [...new Set(ids)];
  return unique.filter(
    id => !unique.some(other => other !== id && isWithin(nodes, id, other))
  );
}

/**
 * The commands a row's menu runs on every selected row when it is open on a
 * selection (spec §10.5). Its other entries act on one row.
 */
export const SELECTION_COMMANDS = Object.freeze(
  new Set(["close", "moveToGroup", "groupSelection", "moveToWorkspace"])
);

/**
 * The row type-ahead lands on, by the ARIA tree pattern: the next row after
 * `from`, wrapping, whose label starts with what was typed, without regard to
 * case. Typing one character again and again steps through the rows that
 * start with it, and a longer prefix may stay on the row already focused.
 *
 * @param {string[]} labels Each drawn row's label, in order.
 * @param {number} from The focused row's index, or -1 when none is.
 * @param {string} typed What was typed since the last pause.
 * @returns {number} the index to focus, or -1 when no label matches.
 */
export function typeAheadIndex(labels, from, typed) {
  const chars = [...typed.toLocaleLowerCase()];
  if (!chars.length || !labels.length) {
    return -1;
  }
  const repeated = chars.every(char => char === chars[0]);
  const prefix = repeated ? chars[0] : chars.join("");
  const start = Math.max(repeated ? from + 1 : from, 0);
  for (let i = 0; i < labels.length; i++) {
    const index = (start + i) % labels.length;
    if (labels[index].toLocaleLowerCase().startsWith(prefix)) {
      return index;
    }
  }
  return -1;
}

/**
 * Where a "move" command lands `row`, expressed in the arguments
 * `SvalEngine.mutate`'s `moveNode` takes.
 *
 * Only siblings under one parent can bound a fractional index, so a reorder
 * is expressed as the pair of ids the node lands between: `before` is the
 * sibling it follows, `after` the one it precedes, as `SvalTabs` does for a
 * dragged tab.
 *
 * `moveIn` indents under the previous sibling, and only when that sibling can
 * hold children. It lands in that sibling's {@link defaultSlot}, because the
 * user named a parent and no position in it. `moveOut` outdents to the
 * grandparent, and is refused for a workspace, which has no parent to leave.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The node being moved.
 * @param {string} command One of moveBefore, moveAfter, moveIn, moveOut.
 * @returns {object|null} `{ id, newParent, before, after }`, or null when the
 *   move is not possible, and the panel then does nothing.
 */
export function moveTarget(nodes, id, command) {
  const node = nodes[id];
  if (!node) {
    return null;
  }
  const byParent = childrenByParent(nodes);

  const parent = node.placement?.parent ?? null;
  const siblings = byParent.get(parent) ?? [];
  const index = siblings.indexOf(id);

  switch (command) {
    case "moveBefore": {
      if (index <= 0) {
        return null;
      }
      return {
        id,
        newParent: parent,
        before: siblings[index - 2] ?? null,
        after: siblings[index - 1],
      };
    }
    case "moveAfter": {
      if (index < 0 || index >= siblings.length - 1) {
        return null;
      }
      return {
        id,
        newParent: parent,
        before: siblings[index + 1],
        after: siblings[index + 2] ?? null,
      };
    }
    case "moveIn": {
      if (index <= 0) {
        return null;
      }
      const target = siblings[index - 1];
      if (!CONTAINER_KINDS.has(nodes[target].kind)) {
        return null;
      }
      return {
        id,
        newParent: target,
        ...defaultSlot(nodes, target, id),
      };
    }
    case "moveOut": {
      if (parent === null) {
        return null;
      }
      const grandparent = nodes[parent]?.placement?.parent ?? null;
      if (grandparent === null) {
        // Only a workspace is a root, and `moveNode` requires a parent id, so
        // a node directly under a workspace stays there.
        return null;
      }
      return { id, newParent: grandparent, before: parent, after: null };
    }
    default:
      return null;
  }
}

/**
 * Where `id` lands in `parent` when the user named the parent and not a
 * position inside it: "Move to group", a drop on a group's middle, Alt+Right,
 * "New group".
 *
 * **Groups first, by default only.** A group lands just after the last group
 * already there, and a tab at the end, so a container left to itself reads as
 * its groups and then its tabs. Nothing enforces it: a drop between two rows
 * goes exactly where it was aimed, and nothing already in the document is
 * re-sorted, because an order the user chose is theirs to keep.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} parent The container the node is going into.
 * @param {string} id The node being placed. Left out of the sibling list, so a
 *   node already in `parent` is placed among the others.
 * @returns {object} `{ before, after }`, as `moveNode` takes them.
 */
export function defaultSlot(nodes, parent, id) {
  const siblings = (childrenByParent(nodes).get(parent) ?? []).filter(
    sibling => sibling !== id
  );
  if (nodes[id]?.kind !== GROUP) {
    return { before: siblings[siblings.length - 1] ?? null, after: null };
  }
  let lastGroup = -1;
  siblings.forEach((sibling, index) => {
    if (nodes[sibling]?.kind === GROUP) {
      lastGroup = index;
    }
  });
  return {
    before: siblings[lastGroup] ?? null,
    after: siblings[lastGroup + 1] ?? null,
  };
}

/**
 * The move that files `id` inside `parent`, at its {@link defaultSlot}.
 *
 * Null for a parent that cannot hold it: one that is absent, a tab, the node
 * itself or anything inside it, and the parent it is already in, where "move
 * into" would mean nothing. The engine refuses all but the current parent as
 * well; asking here lets the menu leave them out and a drag show no drop
 * target.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The node being moved.
 * @param {string} parent The container it is going into.
 * @returns {object|null} `{ id, newParent, before, after }`, or null.
 */
export function moveIntoTarget(nodes, id, parent) {
  if (
    !nodes[id] ||
    !CONTAINER_KINDS.has(nodes[parent]?.kind) ||
    (nodes[id].placement?.parent ?? null) === parent ||
    isWithin(nodes, parent, id)
  ) {
    return null;
  }
  return { id, newParent: parent, ...defaultSlot(nodes, parent, id) };
}

/**
 * The moves that put `moving` into `parent` in the order of `final`, its
 * children as they are to end up. Each lands after the one before it in
 * `final`, which an earlier move has already placed, and before the next node
 * that stays, so one batch applied in order leaves them in that order.
 *
 * @param {string} parent The container they go into.
 * @param {string[]} final Its children afterwards, in order.
 * @param {Set<string>} moving The nodes that move.
 * @returns {object[]} `{ id, newParent, before, after }` each.
 */
function orderedMoves(parent, final, moving) {
  const out = [];
  final.forEach((id, index) => {
    if (!moving.has(id)) {
      return;
    }
    const next = final.slice(index + 1).find(each => !moving.has(each));
    out.push({
      id,
      newParent: parent,
      before: final[index - 1] ?? null,
      after: next ?? null,
    });
  });
  return out;
}

/**
 * The moves that file every node of a selection inside `parent`, each at its
 * {@link defaultSlot}: groups after the groups that stay, tabs at the end, in
 * the order they are drawn. A node already in `parent` stays where it is,
 * as {@link moveIntoTarget} leaves it, and one inside another of `ids` goes
 * with that one.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string[]} ids The nodes being moved, in the order they are drawn.
 * @param {string} parent The container they are going into.
 * @returns {object[]} `{ id, newParent, before, after }` each, or none when
 *   `parent` cannot hold them: it is not a container, or it is one of them
 *   or inside one.
 */
export function moveIntoTargets(nodes, ids, parent) {
  if (
    !CONTAINER_KINDS.has(nodes[parent]?.kind) ||
    ids.some(id => isWithin(nodes, parent, id))
  ) {
    return [];
  }
  const moving = outermostIds(nodes, ids).filter(id =>
    moveIntoTarget(nodes, id, parent)
  );
  const set = new Set(moving);
  const staying = (childrenByParent(nodes).get(parent) ?? []).filter(
    id => !set.has(id)
  );
  const lastGroup = staying.findLastIndex(id => nodes[id]?.kind === GROUP);
  const final = [
    ...staying.slice(0, lastGroup + 1),
    ...moving.filter(id => nodes[id].kind === GROUP),
    ...staying.slice(lastGroup + 1),
    ...moving.filter(id => nodes[id].kind !== GROUP),
  ];
  return orderedMoves(parent, final, set);
}

/**
 * The destinations "Move to group" lists for `id`: the workspace the window
 * shows, then every group in it, in tree order and with its depth so the menu
 * can indent it.
 *
 * Collapsed groups are listed too. The menu is how a keyboard user reaches a
 * group without opening every group above it, and a destination hidden by a
 * collapse the user made for tidiness would be a reason to need the mouse.
 * Each entry is one {@link moveIntoTargets} allows, so the node itself, its
 * descendants and its current parent never appear; a group's subtree is still
 * walked past its parent being left out, because a group inside the current
 * parent is a destination. For a selection, an entry is where some of it can
 * go and none of it is.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|string[]} id The node being moved, or a selection's.
 * @param {string|null} root The workspace the window shows.
 * @param {object} [options]
 * @param {Set<string>} [options.transparent] Groups drawn as their contents
 *   (`rows`), which are no destination; the groups inside each are listed
 *   at its depth.
 * @returns {object[]} `{ id, kind, depth }`, the workspace first at depth 0
 *   and its groups from depth 0 down.
 */
export function moveToGroupChoices(
  nodes,
  id,
  root,
  { transparent = new Set() } = {}
) {
  const ids = [id].flat();
  if (!root || !(root in nodes) || !ids.every(each => nodes[each])) {
    return [];
  }
  const byParent = childrenByParent(nodes);
  const out = [];
  const allows = parent => !!moveIntoTargets(nodes, ids, parent).length;
  if (allows(root)) {
    out.push({ id: root, kind: WORKSPACE, depth: 0 });
  }
  const walk = (parent, depth) => {
    for (const child of byParent.get(parent) ?? []) {
      if (ids.includes(child) || nodes[child].kind !== GROUP) {
        continue;
      }
      if (transparent.has(child)) {
        walk(child, depth);
        continue;
      }
      if (allows(child)) {
        out.push({ id: child, kind: GROUP, depth });
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * How tall, in px, the bands at a row's top and bottom are that mean "drop
 * beside this row". Fixed, so a named split row or a stacked one at the
 * panel's narrowest feels like a tab row.
 */
export const DROP_EDGE_PX = 8;

/**
 * What a dragged thing is, for {@link dropIntent}: a tab, one page Alt-dragged
 * out of its split, a whole split, or a group.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The dragged node.
 * @returns {string|null} "tab", "page", "split" or "group".
 */
export function dragKind(nodes, id) {
  switch (nodes[id]?.kind) {
    case TAB:
      return isPane(nodes, id) ? "page" : "tab";
    case SPLIT:
      return "split";
    case GROUP:
      return "group";
    default:
      return null;
  }
}

/**
 * How many pages `id` brings to a split: a split's tabs, or one.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A tab or a split.
 * @returns {number}
 */
function pageCount(nodes, id) {
  return nodes[id]?.kind === SPLIT ? splitTabs(nodes, id).length : 1;
}

/**
 * What a drop of `id` at the pointer would do (panel-drag handoff, "Drop
 * zones"). A row has at most four zones, each with one meaning, and holding
 * still never changes which applies:
 *
 * - The top and bottom {@link DROP_EDGE_PX}: before and after it.
 * - A tab or split row's middle: its inline-start half makes a new group of
 *   the two, and its inline-end half, the split zone, combines them into a
 *   split ("split" onto a tab, "join" or "merge" onto a split), refused past
 *   {@link SPLIT_MAX_PANES} pages. The panel draws the two halves as the two
 *   drops, so a zone is where its mark is. A narrow panel has no split zone.
 * - A page over its own split's middle: a reorder to the gap at `slot`.
 * - An open group's header: before it, or its first child, by halves. A
 *   collapsed one's middle: into it, last.
 * - A group dragged onto a tab or split: before or after, by halves.
 *
 * A group over its own rows is refused, and a drop on the dragged row itself
 * is a no-op.
 *
 * A dragged selection (spec §10.5) is dropped as a group is, beside a tab or
 * a split by halves, so it never makes a group or a Split; over one of its
 * own rows it is a no-op, and over a row inside one, refused.
 *
 * Kept a pure function of the pointer's place on the row, so the whole map is
 * asserted in xpcshell; `SvalPanelDrag` measures and asks.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The dragged node.
 * @param {object} over The row under the pointer, from {@link rows}.
 * @param {object} at Where on it.
 * @param {number} at.x px from the row's inline start.
 * @param {number} at.y px from the row's top.
 * @param {number} at.w The row's width.
 * @param {number} at.h The row's height.
 * @param {number} [at.slot] For a split row: the gap the pointer is nearest,
 *   0 to the number of tiles, the first tile whose centre is past it.
 * @param {boolean} [at.narrow] Whether the panel is too narrow for a split
 *   zone.
 * @param {string[]|null} [carried] A dragged selection's nodes, from
 *   {@link outermostIds}, `id` among them.
 * @returns {object} `{ kind }`, kind one of before, after, firstChild, into,
 *   newGroup, split, join, merge, reorder (with `slot`), refused (with `full`
 *   when a split zone would pass {@link SPLIT_MAX_PANES} pages) or noop.
 */
export function dropIntent(nodes, id, over, at, carried = null) {
  const { x, y, w, h, slot = null, narrow = false } = at;
  const kind = carried ? "group" : dragKind(nodes, id);
  const overId = over.split ?? over.id;
  const top = y < h / 2;
  if (kind === "group") {
    const holder = (carried ?? [id]).find(each =>
      isWithin(nodes, overId, each)
    );
    if (holder) {
      return { kind: overId === holder ? "noop" : "refused" };
    }
  }
  if (overId === id) {
    return { kind: "noop" };
  }
  if (over.kind === GROUP) {
    if (over.expanded || over.showsSelection) {
      return { kind: top ? "before" : "firstChild" };
    }
    if (y < DROP_EDGE_PX) {
      return { kind: "before" };
    }
    return { kind: y > h - DROP_EDGE_PX ? "after" : "into" };
  }
  if (kind === "group" || (over.kind !== TAB && over.kind !== SPLIT)) {
    return { kind: top ? "before" : "after" };
  }
  if (y < DROP_EDGE_PX) {
    return { kind: "before" };
  }
  if (y > h - DROP_EDGE_PX) {
    return { kind: "after" };
  }
  const tabs = over.kind === SPLIT ? splitTabs(nodes, overId) : [];
  if (kind === "page" && nodes[id].placement.parent === overId) {
    const own = tabs.indexOf(id);
    return slot === own || slot === own + 1 || slot === null
      ? { kind: "noop" }
      : { kind: "reorder", slot };
  }
  if (narrow || x < w / 2) {
    return { kind: "newGroup" };
  }
  const pages = (over.kind === SPLIT ? tabs.length : 1) + pageCount(nodes, id);
  if (pages > SPLIT_MAX_PANES) {
    return { kind: "refused", full: true };
  }
  if (over.kind === TAB) {
    return { kind: "split" };
  }
  return { kind: kind === "split" ? "merge" : "join" };
}

/**
 * The one batch a drop in a tab row's split zone writes: a new split in the
 * row's place holding the row's tab on the left and the dropped pages after
 * it, in their order. A dropped split goes whole, and a dropped page leaves
 * its split in shape (`splitShapeOps`).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} target The tab dropped on.
 * @param {string} id The dropped tab, page or split.
 * @param {Function} newId Mints the new split's id.
 * @returns {object[]|null} the operations, or null when the two cannot make
 *   a split of at most {@link SPLIT_MAX_PANES}.
 */
export function splitTogetherOps(nodes, target, id, newId) {
  if (
    nodes[target]?.kind !== TAB ||
    isPane(nodes, target) ||
    target === id ||
    (nodes[id]?.kind !== TAB && nodes[id]?.kind !== SPLIT) ||
    1 + pageCount(nodes, id) > SPLIT_MAX_PANES
  ) {
    return null;
  }
  const parent = nodes[target].placement?.parent ?? null;
  const siblings = (childrenByParent(nodes).get(parent) ?? []).filter(
    sibling => sibling !== id
  );
  const split = newId();
  const incoming = nodes[id].kind === SPLIT ? splitTabs(nodes, id) : [id];
  const ops = [
    {
      kind: "addSplit",
      id: split,
      parent,
      before: siblings[siblings.indexOf(target) - 1] ?? null,
      after: target,
    },
    {
      kind: "moveNode",
      id: target,
      newParent: split,
      before: null,
      after: null,
    },
  ];
  let last = target;
  for (const tab of incoming) {
    ops.push({
      kind: "moveNode",
      id: tab,
      newParent: split,
      before: last,
      after: null,
    });
    last = tab;
  }
  return nodes[id].kind === SPLIT
    ? [...ops, { kind: "remove", id }]
    : [...ops, ...splitShapeOps(nodes, [id])];
}

/**
 * The one batch a split dropped in another split's split zone writes: its
 * pages join `target` after its own, in their order, the dropped split goes,
 * and the widths go back to equal.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} target The split dropped on.
 * @param {string} id The dropped split.
 * @returns {object[]|null} the operations, or null when the two are not two
 *   splits that fit in one.
 */
export function mergeSplitsOps(nodes, target, id) {
  if (
    nodes[target]?.kind !== SPLIT ||
    nodes[id]?.kind !== SPLIT ||
    target === id
  ) {
    return null;
  }
  const own = splitTabs(nodes, target);
  const incoming = splitTabs(nodes, id);
  if (own.length + incoming.length > SPLIT_MAX_PANES) {
    return null;
  }
  const ops = [];
  let last = own.at(-1) ?? null;
  for (const tab of incoming) {
    ops.push({
      kind: "moveNode",
      id: tab,
      newParent: target,
      before: last,
      after: null,
    });
    last = tab;
  }
  ops.push({ kind: "remove", id });
  ops.push(...resetWidthsOps(nodes, target));
  return ops;
}

/**
 * The move an Alt-dragged page makes to the gap `slot` of its own split, the
 * same move as Move Pane Left and Right.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A page.
 * @param {number} slot 0 to the number of the split's tabs.
 * @returns {object|null} `{ id, newParent, before, after }`, or null when it
 *   would not move.
 */
export function reorderPaneTarget(nodes, id, slot) {
  const split = nodes[id]?.placement?.parent;
  if (nodes[split]?.kind !== SPLIT) {
    return null;
  }
  const tabs = splitTabs(nodes, split);
  const own = tabs.indexOf(id);
  if (own < 0 || slot === own || slot === own + 1) {
    return null;
  }
  const rest = tabs.filter(tab => tab !== id);
  const at = slot > own ? slot - 1 : slot;
  return {
    id,
    newParent: split,
    before: rest[at - 1] ?? null,
    after: rest[at] ?? null,
  };
}

/**
 * The move a drop into a collapsed group makes: in as its last child.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The dropped node.
 * @param {string} group The group dropped on.
 * @returns {object|null} `{ id, newParent, before, after }`, or null for a
 *   group it cannot go into.
 */
export function intoLastTarget(nodes, id, group) {
  if (!moveIntoTarget(nodes, id, group)) {
    return null;
  }
  const children = (childrenByParent(nodes).get(group) ?? []).filter(
    child => child !== id
  );
  return { id, newParent: group, before: children.at(-1) ?? null, after: null };
}

/**
 * Whether `id` is drawn exactly where a move would put it. Such a move
 * changes only the node's order key, and another device's concurrent move of
 * the same node would lose to a drag that went nowhere.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {object} move `{ id, newParent, before, after }`.
 * @returns {boolean}
 */
function isInPlace(nodes, move) {
  const { id, newParent, before, after } = move;
  if ((nodes[id]?.placement?.parent ?? null) !== newParent) {
    return false;
  }
  const siblings = childrenByParent(nodes).get(newParent) ?? [];
  const index = siblings.indexOf(id);
  return (
    (siblings[index - 1] ?? null) === before &&
    (siblings[index + 1] ?? null) === after
  );
}

/**
 * The move a drop makes, in the same shape {@link moveTarget} returns, so a
 * drag and a keystroke reach the engine through one path.
 *
 * `intent` is {@link dropIntent}'s answer, or "end" for the empty space below
 * the last row, which is the end of the workspace the window shows. A merge
 * is not a move and is {@link mergeTarget}'s.
 *
 * Null for a row the node cannot go beside or into: the node itself or
 * anything inside it, which would be a cycle; a row in a broken chain, whose
 * parent is nowhere a drop could mean; and a drop that would leave the node
 * exactly where it is. A drop beside a pane of a split the
 * node is not in goes beside the split.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The dragged node.
 * @param {string|null} overId The row it was dropped on; ignored for "end".
 * @param {string} intent before, after, firstChild, into or end.
 * @param {string|null} [root] The workspace the window shows.
 * @returns {object|null} `{ id, newParent, before, after }`, or null.
 */
export function dropTarget(nodes, id, overId, intent, root = null) {
  if (!nodes[id]) {
    return null;
  }
  const byParent = childrenByParent(nodes);
  const without = parent =>
    (byParent.get(parent) ?? []).filter(sibling => sibling !== id);
  const unlessInPlace = move => (isInPlace(nodes, move) ? null : move);

  if (intent === "end") {
    if (!root || !(root in nodes)) {
      return null;
    }
    const siblings = without(root);
    return unlessInPlace({
      id,
      newParent: root,
      before: siblings[siblings.length - 1] ?? null,
      after: null,
    });
  }

  if (
    (intent === "before" || intent === "after") &&
    isPane(nodes, overId) &&
    nodes[overId].placement.parent !== nodes[id].placement?.parent
  ) {
    // Nothing is dropped into a split (split-view spec §6.3). Its panes are
    // drawn as rows of their own, and beside one of them is beside the split.
    overId = nodes[overId].placement.parent;
  }
  const over = nodes[overId];
  if (!over || isWithin(nodes, overId, id)) {
    return null;
  }

  switch (intent) {
    case "before":
    case "after": {
      const parent = over.placement?.parent ?? null;
      if (parent === null) {
        return null;
      }
      const siblings = without(parent);
      const index = siblings.indexOf(overId);
      return unlessInPlace(
        intent === "before"
          ? {
              id,
              newParent: parent,
              before: siblings[index - 1] ?? null,
              after: overId,
            }
          : {
              id,
              newParent: parent,
              before: overId,
              after: siblings[index + 1] ?? null,
            }
      );
    }
    case "firstChild": {
      if (!CONTAINER_KINDS.has(over.kind)) {
        return null;
      }
      return unlessInPlace({
        id,
        newParent: overId,
        before: null,
        after: without(overId)[0] ?? null,
      });
    }
    case "into":
      return intoLastTarget(nodes, id, overId);
    default:
      return null;
  }
}

/**
 * The moves a dropped selection makes (spec §10.5): every node of it, in the
 * order they are drawn, at the place {@link dropTarget} would put one node,
 * the nodes beside that place that are themselves selected left out of the
 * count.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string[]} ids The selection's nodes, from {@link outermostIds}.
 * @param {string|null} overId The row it was dropped on; ignored for "end".
 * @param {string} intent before, after, firstChild, into or end.
 * @param {string|null} [root] The workspace the window shows.
 * @returns {object[]|null} `{ id, newParent, before, after }` each, or null
 *   for a drop {@link dropTarget} would refuse, and for one that leaves every
 *   node where it is.
 */
export function dropTargets(nodes, ids, overId, intent, root = null) {
  const moving = ids.filter(id => nodes[id]);
  if (!moving.length) {
    return null;
  }
  let parent;
  let index;
  if (intent === "end") {
    if (!root || !(root in nodes)) {
      return null;
    }
    parent = root;
    index = Infinity;
  } else {
    // Beside a pane is beside its split, as for one node.
    if ((intent === "before" || intent === "after") && isPane(nodes, overId)) {
      overId = nodes[overId].placement.parent;
    }
    const over = nodes[overId];
    if (
      !over ||
      moving.some(id => isWithin(nodes, overId, id) && id !== overId)
    ) {
      return null;
    }
    switch (intent) {
      case "before":
      case "after":
        parent = over.placement?.parent ?? null;
        if (parent === null) {
          return null;
        }
        index =
          (childrenByParent(nodes).get(parent) ?? []).indexOf(overId) +
          (intent === "after" ? 1 : 0);
        break;
      case "firstChild":
      case "into":
        if (!CONTAINER_KINDS.has(over.kind) || moving.includes(overId)) {
          return null;
        }
        parent = overId;
        index = intent === "into" ? Infinity : 0;
        break;
      default:
        return null;
    }
  }
  const siblings = childrenByParent(nodes).get(parent) ?? [];
  const set = new Set(moving);
  const final = [
    ...siblings.slice(0, index).filter(id => !set.has(id)),
    ...moving,
    ...siblings.slice(index).filter(id => !set.has(id)),
  ];
  const unchanged =
    final.length === siblings.length &&
    final.every((id, at) => id === siblings[at]);
  return unchanged ? null : orderedMoves(parent, final, set);
}

/**
 * The new group "New group with selection" (spec §10.5) and "Move to
 * group"'s "New group…" make, in {@link mergeTarget}'s shape: in the first
 * node's parent, at its place, holding every node in the order they are
 * drawn.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string[]} ids The nodes, from {@link outermostIds}.
 * @returns {object|null} `{ parent, before, after, members }`, or null when
 *   none of `ids` is in the document or the first has no parent.
 */
export function groupSelectionTarget(nodes, ids) {
  const members = ids.filter(id => nodes[id]);
  const parent = nodes[members[0]]?.placement?.parent ?? null;
  if (parent === null) {
    return null;
  }
  const set = new Set(members);
  const siblings = childrenByParent(nodes).get(parent) ?? [];
  const staying = siblings.filter(id => !set.has(id));
  const at = siblings
    .slice(0, siblings.indexOf(members[0]))
    .filter(id => !set.has(id)).length;
  return {
    parent,
    before: staying[at - 1] ?? null,
    after: staying[at] ?? null,
    members,
  };
}

/**
 * What a kind counts as when two rows make a group: a split as a tab.
 *
 * @param {string|undefined} kind A `NodeKind`.
 * @returns {string|null} TAB or GROUP, or null for a kind no group is made
 *   from.
 */
function mergeKind(kind) {
  if (kind === TAB || kind === SPLIT) {
    return TAB;
  }
  return kind === GROUP ? GROUP : null;
}

/**
 * The new group a drop of `id` onto `overId` would make, holding the two of
 * them: a tab onto a tab, or a group onto a group.
 *
 * The group takes the target's place among its siblings, and the target goes
 * in first with the dragged node after it: the target is the one the user
 * aimed at, so it is the one that stays where they were looking.
 *
 * A split is a tab here: a tab or a split onto a tab or a split makes a group
 * of the two, as two tabs do.
 *
 * Null for two kinds that differ (a tab onto a group joins it instead, and a
 * group onto a tab has nothing to mean), for a pane of a split, which holds
 * tabs only, and for the node itself or anything inside it.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id The dragged node.
 * @param {string} overId The row it was dropped on.
 * @returns {object|null} `{ id, target, parent, before, after }`: the group is
 *   made in `parent` between `before` and `after`, and then `target` and `id`
 *   are moved into it in that order. Null when there is no such group.
 */
export function mergeTarget(nodes, id, overId) {
  const kind = mergeKind(nodes[id]?.kind);
  if (
    !kind ||
    mergeKind(nodes[overId]?.kind) !== kind ||
    isPane(nodes, overId) ||
    isWithin(nodes, overId, id)
  ) {
    return null;
  }
  const parent = nodes[overId].placement?.parent ?? null;
  if (parent === null) {
    return null;
  }
  const siblings = (childrenByParent(nodes).get(parent) ?? []).filter(
    sibling => sibling !== id
  );
  const index = siblings.indexOf(overId);
  return {
    id,
    target: overId,
    parent,
    before: siblings[index - 1] ?? null,
    after: overId,
  };
}

/**
 * Which commands the context menu offers for a row, in the order they are
 * drawn.
 *
 * Every kind gets "New tab", because the panel is the only tab surface there
 * is and a right-click is where a person looks for it. It is filed inside the
 * row the menu was opened on, through `_newTabParent`: the context menu
 * selects the row before running the command, so a group row resolves to the
 * group and a tab row to the tab's own parent. The header's button runs the
 * same command with no row, and its tab opens at the top of the workspace.
 *
 * Beyond that a tab is a leaf, so it gets only Rename and Close, and Remove
 * Name on a tab with a label. A group can
 * hold children, so it also gets "New group". "New workspace" is in none of
 * these: a workspace is made where workspaces are chosen, the switcher.
 *
 * **Only a tab closes.** A group and a workspace are deleted, by an entry that
 * says so, because closing either must never cost the user anything: a group
 * toggles, and a workspace is closed by closing its window, which keeps it
 * (spec §5.4).
 *
 * A tab and a group can both be moved (up, down, or into another group), and
 * the menu is where a person who does not drag finds that (spec §10.5). A
 * workspace is not a row, so it has no siblings here to move among. The panel
 * disables a move with nowhere to go, so the menu keeps one shape per kind and
 * a screen reader announces the move as unavailable.
 *
 * A workspace and a group are the kinds that are places, and each is edited
 * with one "Edit…" entry that opens the dialog it was created in: name, colour
 * and emoji together. A tab has only a name, so it keeps Rename.
 *
 * A workspace is reached through the switcher's right-click menu, because it
 * is not a row (spec §10.7). Its entries are listed here because they are the
 * same `run` commands, so one list says what each kind offers.
 *
 * A tab can be copied as a Markdown link, and a tab or a group unloaded:
 * a group's Unload unloads every tab inside it that this window holds. A tab
 * can be kept loaded, a check item that shows whether it is.
 *
 * A tab offers "Split View", which opens Firefox's picker beside it. A pane
 * of a split (split-view spec §6.3) offers its tab's entries, whose moves
 * move the whole split, then the split's own, and Close All.
 *
 * Like commands are drawn together, each block after a separator
 * ({@link CONTEXT_MENU_BLOCKS}), and a block the row offers nothing from is
 * left out with its separator.
 *
 * A menu opened on a selection (spec §10.5) adds "New group with selection"
 * after "Move to group", and the panel disables what is not one of
 * {@link SELECTION_COMMANDS}.
 *
 * @param {string} kind A `NodeKind`.
 * @param {object} [options]
 * @param {boolean} [options.temporary] Whether the row is in a window with
 *   one temporary workspace, a private window's or WebDriver's.
 * @param {boolean} [options.pane] Whether the row is a pane of a split row.
 * @param {boolean} [options.several] Whether the menu is for a selection.
 * @returns {string[]} command names, each already handled by
 *   `SvalPanel.run`; the separators are named too, so the panel shows them
 *   by the same list.
 */
export function contextMenuItems(
  kind,
  { temporary = false, pane = false, several = false } = {}
) {
  const offered = new Set(baseContextMenuItems(kind));
  if (several && offered.has("moveToGroup")) {
    offered.add("groupSelection");
  }
  if (kind === TAB) {
    if (pane) {
      // A pane's page belongs to its split, and a pin is a page of its own
      // (pins spec §8.1), so a pane is not pinned; split it off first.
      offered.delete("pin");
      offered.delete("pinHere");
      for (const command of [
        "addTabToSplit",
        "separate",
        "movePaneLeft",
        "movePaneRight",
        "renameSplit",
        "closeSplit",
      ]) {
        offered.add(command);
      }
    } else {
      offered.add("createSplit");
      offered.add("addToSplit");
    }
  }
  // A window with one temporary workspace (private-windows spec) cannot
  // delete the one, has no other to move a row to, shows no pins (pins spec
  // §7), files nothing in Favorites (`SvalFavorites.toggle`), saves no
  // site style (`styleScopeOf`) and names no tab.
  if (temporary) {
    for (const command of [
      "rename",
      "clearLabel",
      "deleteWorkspace",
      "moveToWorkspace",
      "pin",
      "pinHere",
      "favorite",
      "styleSite",
    ]) {
      offered.delete(command);
    }
  }
  const items = [];
  for (const [separator, commands] of CONTEXT_MENU_BLOCKS) {
    const shown = commands.filter(command => offered.has(command));
    if (shown.length) {
      if (items.length) {
        items.push(separator);
      }
      items.push(...shown);
    }
  }
  return items;
}

/**
 * The row menu's blocks of like commands, in the order they are drawn, each
 * with the separator drawn before it. The first block is never preceded by
 * one.
 */
const CONTEXT_MENU_BLOCKS = [
  [null, ["addTab", "addGroup"]],
  ["nameSeparator", ["rename", "clearLabel", "edit"]],
  [
    "moveSeparator",
    [
      "moveBefore",
      "moveAfter",
      "moveToGroup",
      "groupSelection",
      "moveToWorkspace",
    ],
  ],
  [
    "keepSeparator",
    ["pin", "pinHere", "favorite", "copyMarkdownLink", "styleSite"],
  ],
  ["createSplitSeparator", ["createSplit", "addToSplit"]],
  ["loadSeparator", ["unload", "keepLoaded", "media"]],
  ["closeSeparator", ["close", "deleteGroup", "deleteWorkspace"]],
  [
    "splitSeparator",
    [
      "addTabToSplit",
      "separate",
      "movePaneLeft",
      "movePaneRight",
      "renameSplit",
    ],
  ],
  ["closeSplitSeparator", ["closeSplit"]],
];

function baseContextMenuItems(kind) {
  switch (kind) {
    case TAB:
      return [
        "addTab",
        "rename",
        "clearLabel",
        "moveBefore",
        "moveAfter",
        "moveToGroup",
        "moveToWorkspace",
        "pin",
        "pinHere",
        "favorite",
        "copyMarkdownLink",
        "styleSite",
        "unload",
        "keepLoaded",
        "media",
        "close",
      ];
    case GROUP:
      return [
        "addTab",
        "edit",
        "addGroup",
        "moveBefore",
        "moveAfter",
        "moveToGroup",
        "moveToWorkspace",
        "unload",
        "media",
        "deleteGroup",
      ];
    case WORKSPACE:
      return ["addTab", "edit", "addGroup", "deleteWorkspace"];
    default:
      return [];
  }
}

/**
 * How many nodes deleting `id` with its contents would take with it.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @returns {number} the count of descendants, 0 for a leaf.
 */
export function descendantCount(nodes, id) {
  return descendantIds(nodes, id).length;
}

/**
 * How many *tabs* deleting `id` with its contents would take with it.
 *
 * This is the number {@link deleteWorkspaceText} and {@link deleteGroupText}
 * name. A workspace holding three groups of two tabs has nine descendants
 * ({@link descendantCount}) and six tabs, and "the 9 tabs inside it" is
 * false. The tabs are the pages the user would lose.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @returns {number} the count of descendant tabs, 0 for a leaf.
 */
export function descendantTabCount(nodes, id) {
  return descendantIds(nodes, id).filter(child => nodes[child]?.kind === TAB)
    .length;
}

/**
 * How many *groups* deleting `id` with its contents would take with it.
 *
 * The other half of {@link descendantTabCount}, for the container that holds
 * no tabs at all: it still has something in it, deleting it still deletes
 * outright (spec §5.4), and the groups are what the question can truthfully
 * name.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @returns {number} the count of descendant groups, 0 for a leaf.
 */
export function descendantGroupCount(nodes, id) {
  return descendantIds(nodes, id).filter(child => nodes[child]?.kind === GROUP)
    .length;
}

/**
 * "3 tabs", "1 group": what a container holds, as a question can name it.
 *
 * **Tabs when there are any, groups when there are not.** The tabs are the
 * pages the user would lose. A container holding only containers still holds
 * something its owner made and named, and the only true phrase about it names
 * groups. Counting the groups in beside the tabs would inflate the number the
 * user reads as pages.
 *
 * @param {number} tabs {@link descendantTabCount}'s result.
 * @param {number} groups {@link descendantGroupCount}'s result.
 * @returns {string} empty when both are zero.
 */
function contentsPhrase(tabs, groups) {
  const [count, noun] = tabs ? [tabs, "tab"] : [groups, "group"];
  if (!count) {
    return "";
  }
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * The confirmation for "Delete workspace".
 *
 * It says plainly that the tabs go too. Deleting a workspace offers no way to
 * keep them, because there is nowhere one level up for them to go: a
 * workspace is a root (spec §5.2, §5.4).
 *
 * @param {string} name The workspace's name, already resolved to its
 *   placeholder if it has none (`SvalPanel._untitled`).
 * @param {number} tabs {@link descendantTabCount}'s result for it.
 * @param {number} groups {@link descendantGroupCount}'s result for it.
 * @returns {{title: string, body: string}}
 */
export function deleteWorkspaceText(name, tabs, groups) {
  const what = contentsPhrase(tabs, groups);
  return {
    title: `Delete the “${name}” Workspace?`,
    body: what ? `The ${what} inside it will close too.` : "",
  };
}

/**
 * What the confirm says before a workspace is isolated or stops being
 * isolated (isolated workspaces spec §5). Either way every tab reloads in
 * another cookie jar, which is the cost the user is agreeing to.
 *
 * @param {string} name The workspace's name, already resolved to its
 *   placeholder if it has none.
 * @param {boolean} isolated What the workspace is about to become.
 * @returns {{title: string, body: string, primary: string, tone: string}}
 *   Stopping is a danger dialog: it deletes the sign-ins and site data kept
 *   only in the workspace's jar (`ContextualIdentityService.remove`).
 */
export function isolationText(name, isolated) {
  return isolated
    ? {
        title: `Isolate the “${name}” Workspace?`,
        body: "Sites in it won’t see your sign-ins from other Workspaces. Every tab in it reloads, and you’ll need to sign in again on sites you use here.",
        primary: "Isolate Workspace",
        tone: "default",
      }
    : {
        title: `Stop isolating the “${name}” Workspace?`,
        body: "Its tabs will share sign-ins with your other Workspaces. Every tab in it reloads, and sign-ins and site data kept only here are deleted.",
        primary: "Stop isolating",
        tone: "danger",
      };
}

/**
 * What the confirm says before a move takes tabs into a workspace with
 * another cookie jar (isolated workspaces spec §6).
 *
 * @param {string} name The destination workspace's name.
 * @param {number} tabs How many tabs move.
 * @returns {{title: string, body: string, primary: string}}
 */
export function moveAcrossJarsText(name, tabs) {
  return tabs === 1
    ? {
        title: `Move this tab to “${name}”?`,
        body: `It reloads in “${name}”, which has separate sign-ins. You may need to sign in again.`,
        primary: "Move",
      }
    : {
        title: `Move ${tabs} tabs to “${name}”?`,
        body: `They reload in “${name}”, which has separate sign-ins. You may need to sign in again.`,
        primary: "Move tabs",
      };
}

/**
 * What the confirm says before a move hands tabs to an agent, by moving them
 * into its workspace (agent-control spec §5.4). The warning says which
 * sign-ins the agent gets with them: a move within one jar keeps the tabs'
 * cookies, and a move across jars reloads each tab at its address in the
 * agent's jar (isolated workspaces spec §6).
 *
 * @param {string} agent The agent's label.
 * @param {number} tabs How many tabs move.
 * @param {"kept"|"separate"|"shared"} signIns `kept` for a move within one
 *   jar, `separate` into an isolated agent workspace, `shared` into a shared
 *   one from an isolated workspace of the user's.
 * @param {boolean} [history] Whether a tab moves with back and forward
 *   history the user made, which the dialog then offers to include.
 * @returns {{icon: string, state: string, title: string, body: string,
 *   warning: string, primary: string,
 *   checkbox?: {label: string, checked: boolean}}} `state` is `signIns`.
 */
export function handToAgentText(agent, tabs, signIns, history = false) {
  const one = tabs === 1;
  const warnings = {
    kept: `${one ? "The tab keeps" : "The tabs keep"} your sign-ins, so ${agent} can use them.`,
    separate: `${one ? "The tab reloads" : "The tabs reload"} in a Workspace with separate sign-ins, so ${agent} can’t use yours.`,
    shared: `${one ? "The tab reloads" : "The tabs reload"} with your sign-ins, so ${agent} can use them.`,
  };
  return {
    icon: "agent",
    state: signIns,
    title: one
      ? `Hand this tab to ${agent}?`
      : `Hand ${tabs} tabs to ${agent}?`,
    body: one
      ? `${agent} can read the tab and act in it.`
      : `${agent} can read the tabs and act in them.`,
    warning: warnings[signIns],
    primary: "Hand Over",
    ...(history
      ? {
          checkbox: {
            label: one
              ? "Include the pages you visited earlier in this tab"
              : "Include the pages you visited earlier in these tabs",
            checked: false,
          },
        }
      : {}),
  };
}

/**
 * The question "Delete group" asks of a group with something in it: whether
 * its contents stay, moving out of the group, or go with it (spec §5.4).
 * The body and both answers name what the group holds: its tabs, its
 * groups, or both. The iPhone app asks the same, in title case.
 *
 * @param {string} name The group's name, already resolved to its placeholder.
 * @param {number} tabs {@link descendantTabCount}'s result for it.
 * @param {number} groups {@link descendantGroupCount}'s result for it.
 * @returns {{title: string, body: string, keep: string, remove: string}}
 */
export function deleteGroupText(name, tabs, groups) {
  const title = `Delete “${name}”?`;
  const the = (count, noun) =>
    count === 1 ? `the ${noun}` : `the ${count} ${noun}s`;
  if (!groups) {
    const noun = tabs === 1 ? "tab" : "tabs";
    return {
      title,
      body: `Keep or close ${the(tabs, "tab")} inside.`,
      keep: `Keep ${noun}`,
      remove: `Close ${noun}`,
    };
  }
  if (!tabs) {
    const noun = groups === 1 ? "group" : "groups";
    return {
      title,
      body: `Keep or delete ${the(groups, "group")} inside.`,
      keep: `Keep ${noun}`,
      remove: `Delete ${noun}`,
    };
  }
  const count = (n, noun) => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);
  return {
    title,
    body: `Keep or delete the ${count(tabs, "tab")} and ${count(groups, "group")} inside.`,
    keep: "Keep all",
    remove: "Delete all",
  };
}

/** What the key store is called in a pairing line, on each platform. */
const KEY_STORE_NEED = {
  macosx: "Sval needs Keychain access.",
  win: "Sval needs Windows Credential Manager access.",
  linux: "Sval needs your keyring.",
};

/**
 * The line Settings shows after joining another device, Set Up Sync Again or
 * a restore from a backup, and the one button that acts on it (messages spec §7). The
 * key store's button is the indicator's (spec §3, `keyStoreRetryLabel`).
 *
 * Here because the settings page and the panel both say it, and a page script
 * cannot import from a chrome window's script.
 *
 * @param {object} result What `SvalPanel.adoptKey` answers: `adopted`, and
 *   when it is false, `failure` as `SvalKeyJoin.join` names it. A failure it
 *   does not name is told as this device's workspaces being unreadable,
 *   because what stopped the join is then known only to the log.
 * @param {string} platform `AppConstants.platform`.
 * @param {string} [verb] `"Join"`, `"Setup"` for Set Up Sync Again, or
 *   `"Restore"` for a restore from a backup.
 * @returns {{ status: string, reason: string, text: string,
 *   action: object|null }} `status` is `"success"` or `"error"`; `reason`
 *   names which line it is, `"joined"` or the failure the text tells;
 *   `action` is `{ label, command }` or null.
 */
export function pairingLine(result, platform, verb = "Join") {
  if (result?.adopted) {
    return {
      status: "success",
      reason: "joined",
      text: "Joined. Your devices are syncing.",
      action: null,
    };
  }
  const failed = (reason, sentence) => ({
    status: "error",
    reason,
    text: `${verb} failed: ${sentence}`,
  });
  switch (result?.failure) {
    case "folder":
      return {
        ...failed("folder", "Sval can't reach your sync folder."),
        action: { label: "Try Again", command: "tryAgain" },
      };
    case "key-store":
      return {
        ...failed(
          "key-store",
          KEY_STORE_NEED[platform] ?? KEY_STORE_NEED.linux
        ),
        action: {
          label: keyStoreRetryLabel(platform),
          command: "tryAgain",
        },
      };
    case "no-folder":
      return {
        ...failed("no-folder", "choose a sync folder first."),
        action: { label: "Choose Folder…", command: "chooseSharedFolder" },
      };
    default:
      return {
        ...failed(
          "own-unreadable",
          "Sval can't read this device's Workspaces."
        ),
        action: { label: "Send Report…", command: "sendReport" },
      };
  }
}

/**
 * Spec §6.7's alphabet: 32 characters with I, L, O and U left out, so nothing
 * in a code can be mistaken for anything else in it. The engine's
 * `pairing::CODE_ALPHABET` holds the same characters in another order. A
 * pairing code checks membership alone, but a sync key's backup is the index
 * of each character in this order (`backupCode`), so reordering it changes
 * what every written backup decodes to.
 */
export const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

/** Twelve characters, shown as three groups of four. */
export const CODE_LENGTH = 12;

/**
 * A typed pairing code as `SvalPairing` wants it, or null if it cannot be one.
 *
 * **This is the whole of the check that happens before any work.** Sealing is
 * Argon2id (spec §6.7), so putting a code to an offer costs tens of
 * milliseconds and a disk read, and a mistyped length is caught before that
 * wait.
 *
 * Entry is case-insensitive and forgiving of the dashes and spaces someone
 * copies along with the code, because the grouping exists to be read aloud
 * and re-typed. The letters the alphabet leaves out for looking like digits
 * are read as those digits, I and L as 1 and O as 0, so a code copied by eye
 * still works.
 *
 * Here because both Sval's settings page and first run take a code, and a
 * page script cannot import from another page's script.
 *
 * @param {string} text Whatever is in the field.
 * @returns {string|null} the grouped canonical form, or null.
 */
export function normalizeCode(text) {
  const bare = String(text ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (bare.length !== CODE_LENGTH) {
    return null;
  }
  for (const character of bare) {
    if (!BACKUP_ALPHABET.includes(character)) {
      return null;
    }
  }
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}`;
}

/**
 * A code field's text as the user types it, grouped in fours as codes are
 * shown, with `caret` kept after the same character it followed. Whatever
 * dashes and spaces were typed or pasted are dropped and put back between
 * the groups, so a dash never doubles. A dash goes in once the next group
 * starts, so Backspace after a group's last character deletes that
 * character. The characters themselves are left for `normalizeCode` to
 * judge.
 *
 * @param {string} text The field's value.
 * @param {number} caret Where the caret is in `text`.
 * @returns {{text: string, caret: number}}
 */
export function groupCodeEntry(text, caret) {
  const isGap = character => /[\s-]/.test(character);
  const kept = [...text].filter(character => !isGap(character));
  const before = [...text.slice(0, caret)].filter(
    character => !isGap(character)
  ).length;
  const grouped = kept
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join("-");
  // Each full group before the caret adds its dash, except a group the caret
  // ends, whose dash is still to come.
  const dashes = Math.max(0, Math.ceil(before / 4) - 1);
  return { text: grouped ?? "", caret: before + dashes };
}

/**
 * Groups `input`'s code as the user types or pastes it ({@link
 * groupCodeEntry}). Backspace or Delete against a dash removes the character
 * beyond it, since the dash would only come back.
 *
 * @param {HTMLInputElement} input
 */
export function groupCodeField(input) {
  input.addEventListener("beforeinput", event => {
    const { selectionStart: at, selectionEnd: end, value } = input;
    if (at !== end) {
      return;
    }
    let gap = -1;
    if (event.inputType === "deleteContentBackward" && value[at - 1] === "-") {
      gap = at - 2;
    } else if (
      event.inputType === "deleteContentForward" &&
      value[at] === "-"
    ) {
      gap = at + 1;
    }
    if (gap < 0 || gap >= value.length) {
      return;
    }
    event.preventDefault();
    const next = groupCodeEntry(
      value.slice(0, gap) + value.slice(gap + 1),
      Math.min(at, gap)
    );
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    input.dispatchEvent(
      new input.documentGlobal.Event("input", { bubbles: true })
    );
  });
  input.addEventListener("input", () => {
    const next = groupCodeEntry(input.value, input.selectionStart ?? 0);
    if (next.text !== input.value) {
      input.value = next.text;
      input.setSelectionRange(next.caret, next.caret);
    }
  });
}

/** A 32-byte sync key in the backup's 5-bit characters, rounded up. */
export const BACKUP_LENGTH = 52;

/**
 * A sync key as its backup shows it: the pairing alphabet, so nothing in it
 * can be mistaken for anything else, in groups of four (key-storage spec,
 * "Backup and recovery").
 *
 * @param {Uint8Array} bytes 32 bytes.
 * @returns {string} 52 characters in 13 groups.
 */
export function backupCode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BACKUP_ALPHABET[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) {
    out += BACKUP_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out.match(/.{1,4}/g).join("-");
}

/**
 * The sync key a typed backup holds, or null if it cannot be one. Forgiving
 * of case, spaces and dashes, as `normalizeCode` is.
 *
 * @param {string} text
 * @returns {Uint8Array|null} 32 bytes.
 */
export function fromBackupCode(text) {
  const bare = String(text ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  if (bare.length !== BACKUP_LENGTH) {
    return null;
  }
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const character of bare) {
    const digit = BACKUP_ALPHABET.indexOf(character);
    if (digit < 0) {
      return null;
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // The last character carries four bits past the key, which are zero in a
  // code `backupCode` wrote.
  if (bytes.length !== 32 || value !== 0) {
    return null;
  }
  return Uint8Array.from(bytes);
}

/**
 * What Sval says when the sync folder holds more than one step reads
 * (decision 0032). The settings page and the folder picker say it in the
 * same words.
 */
export const SYNC_FILES_TOO_LARGE =
  "The files in your sync folder are too large to sync.";

/**
 * What Sval says about syncing with no shared folder chosen: it keeps the
 * user's workspaces in the profile and writes them nowhere else. The settings
 * page says it.
 */
export const ON_THIS_DEVICE_ONLY = "On this device only";

/**
 * How a last-synced time reads, or how its absence does.
 *
 * Spec §6.4 and §12 require this indicator in v1 regardless of provider
 * latency, so "never" is a state it has to be able to say.
 *
 * @param {number|null} lastSynced Milliseconds since the epoch, or null.
 * @param {number} now Milliseconds since the epoch. Passed in because nothing
 *   in this module reads a clock.
 * @returns {string}
 */
export function lastSyncedText(lastSynced, now) {
  if (lastSynced === null) {
    return "Not synced yet";
  }
  const seconds = Math.max(0, Math.round((now - lastSynced) / 1000));
  if (seconds < 60) {
    return "Synced just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `Synced ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Synced ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  return `Synced ${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Cloud folders macOS's File Provider mounts under `~/Library/CloudStorage`,
 * by the prefix of the mount's name, and the name each service goes by.
 */
const CLOUD_STORAGE_NAMES = [
  ["Dropbox", "Dropbox"],
  ["OneDrive", "OneDrive"],
  ["GoogleDrive", "Google Drive"],
  ["Box", "Box"],
];

/**
 * A short name for the sync folder that a person recognises: the service and
 * the folder's own name for the cloud folders people sync through ("iCloud
 * Drive › Sval"), the folder's own name otherwise. The full path is shown
 * beside it, so this only has to be recognisable.
 *
 * @param {string} path An absolute path, with either separator.
 * @returns {string}
 */
export function friendlyFolderName(path) {
  const parts = String(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!parts.length) {
    return String(path);
  }
  const cloud = cloudFolder(parts);
  if (cloud) {
    return cloud.rest.length
      ? `${cloud.service} › ${cloud.rest.at(-1)}`
      : cloud.service;
  }
  return parts.at(-1);
}

/**
 * The cloud service that syncs `path`, by the name it goes by, or null for a
 * folder no service Sval recognises keeps, such as a network share or a
 * drive.
 *
 * @param {string} path An absolute path, with either separator.
 * @returns {string|null}
 */
export function cloudServiceOf(path) {
  const parts = String(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  return cloudFolder(parts)?.service ?? null;
}

/**
 * @param {string[]} parts A path's components.
 * @returns {?{service: string, rest: string[]}} the service and the
 *   components below its root.
 */
function cloudFolder(parts) {
  const icloud = parts.indexOf("com~apple~CloudDocs");
  if (icloud > 0 && parts[icloud - 1] === "Mobile Documents") {
    return { service: "iCloud Drive", rest: parts.slice(icloud + 1) };
  }
  const storage = parts.indexOf("CloudStorage");
  if (storage > 0 && parts[storage - 1] === "Library" && parts[storage + 1]) {
    const mount = parts[storage + 1];
    const known = CLOUD_STORAGE_NAMES.find(([prefix]) =>
      mount.startsWith(prefix)
    );
    if (known) {
      return { service: known[1], rest: parts.slice(storage + 2) };
    }
  }
  const home = parts.findIndex(
    part => part === "Dropbox" || /^OneDrive( - .+)?$/.test(part)
  );
  if (home >= 0 && home < parts.length - 1) {
    const service = parts[home] === "Dropbox" ? "Dropbox" : "OneDrive";
    return { service, rest: parts.slice(home + 1) };
  }
  return null;
}

/**
 * How long the shared folder may go unanswered, or missing, before the
 * footer's indicator says so (spec §3, decision 0032). Blips are normal on
 * every folder Sval supports, and a drive comes back or a share remounts.
 */
export const FOLDER_UNAVAILABLE_AFTER_MS = 3 * 60 * 1000;

/**
 * Whether an outage has lasted long enough for the indicator to show it.
 *
 * A `now` before the outage began is a clock set back since, and shows it:
 * how long the folder has really been away is unknown then, and waiting for
 * the clock to catch up could hide an outage for as long as the clock moved.
 *
 * @param {number|null} unreachableSince When the outage began, or null.
 * @param {number} now Milliseconds since the epoch. Passed in because nothing
 *   in this module reads a clock.
 * @returns {boolean}
 */
export function showsFolderNotice(unreachableSince, now) {
  if (unreachableSince === null) {
    return false;
  }
  const away = now - unreachableSince;
  return away < 0 || away >= FOLDER_UNAVAILABLE_AFTER_MS;
}

/**
 * How long saves to this device's own copy fail before the critical dialog
 * says so (messages spec §4): a pass that succeeds within it says nothing.
 */
export const SAVE_FAILING_MS = 60_000;

/**
 * Whether saves have failed long enough for the critical dialog to say so.
 *
 * @param {number|null} failingSince When saves began failing, or null while
 *   they save.
 * @param {number} now Milliseconds since the epoch, on the same clock as
 *   `failingSince`. Passed in because nothing in this module reads a clock.
 * @returns {boolean}
 */
export function saveFailureDue(failingSince, now) {
  return failingSince !== null && now - failingSince >= SAVE_FAILING_MS;
}

/**
 * A time of day in the user's own format.
 *
 * @param {number} when Milliseconds since the epoch.
 * @returns {string}
 */
export function shortTime(when) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
    when
  );
}

/** Below this many free bytes, an unreadable profile file means a full disk. */
const DISK_FULL_BELOW_BYTES = 1048576;

/**
 * Why this device's own copy could not be saved, from the name of the error
 * the failed pass carried (`SvalError.code`, a `DOMException` name).
 *
 * @param {string|null} code The failed pass's error code.
 * @param {number} freeBytes Free space on the profile's volume.
 * @returns {"disk-full"|"denied"|"disk"|null} Null when the name says nothing
 *   about the local disk.
 */
export function localCause(code, freeBytes) {
  if (code === "NotAllowedError") {
    return "denied";
  }
  if (code === "NotReadableError") {
    return freeBytes < DISK_FULL_BELOW_BYTES ? "disk-full" : "disk";
  }
  return null;
}

/** The panel's sentence for each {@link localCause}. */
export const LOCAL_CAUSE_TEXT = {
  "disk-full": "Your disk is full.",
  denied: "Sval doesn't have permission to save to its profile.",
  disk: "There's a problem with your disk.",
};

/** The key store's detail sentence on each platform (spec §3). */
const KEY_ACCESS_DETAIL = {
  macosx:
    "Sval needs Keychain access to sync. Choose Always Allow when your Mac asks.",
  win:
    "Sval can't reach Windows Credential Manager. Try again, or restart " +
    "your computer.",
  linux: "Sval needs your keyring to sync. Unlock it when asked.",
};

/**
 * The label of the button that reads the sync key from the key store again,
 * on the indicator and on a result line. Windows offers no access to allow,
 * so there it tries again.
 *
 * @param {string} platform `AppConstants.platform`.
 * @returns {string}
 */
function keyStoreRetryLabel(platform) {
  return platform === "win" ? "Try Again" : "Allow Access";
}

/** Spec §3: the window kinds whose tabs are never saved or synced. */
const UNSAVED_WINDOW_DETAIL = {
  private: "Private window. Tabs here aren't saved or synced.",
  automated: "Automated window. Tabs here aren't saved or synced.",
};

/**
 * What devices whose clocks are set ahead are costing the user, and how to
 * stop it (decision 1714).
 *
 * @param {Array<string|null>} names As `syncIndicator`'s `harmedByClock`.
 * @returns {string}
 */
function clockHarmDetail(names) {
  const cost =
    "are replacing yours and tabs you close can come back. Set the correct " +
    "time on";
  if (names.length === 1) {
    return names[0]
      ? `${names[0]}'s clock is set ahead, so its changes ${cost} ${names[0]} to fix this.`
      : `One of your devices has its clock set ahead, so its changes ${cost} that device to fix this.`;
  }
  const who = names.every(Boolean)
    ? new Intl.ListFormat("en-US", { type: "conjunction" }).format(names)
    : "Some of your devices";
  return `${who} have their clocks set ahead, so their changes ${cost} each of them to fix this.`;
}

/**
 * Which devices this one can't sync with because they write a schema newer
 * than this build reads (spec §5.5), and what fixes it.
 *
 * @param {Array<string|null>} names As `syncIndicator`'s `newerSchema`.
 * @returns {string}
 */
function newerSchemaDetail(names) {
  const fix = "Update Sval on this computer to sync with";
  if (names.length === 1) {
    return names[0]
      ? `${names[0]} is running a newer version of Sval, so this computer can't read what ${names[0]} syncs. ${fix} ${names[0]}.`
      : `One of your devices is running a newer version of Sval, so this computer can't read what that device syncs. ${fix} that device.`;
  }
  if (names.every(Boolean)) {
    const who = new Intl.ListFormat("en-US", { type: "conjunction" }).format(
      names
    );
    return `${who} are running a newer version of Sval, so this computer can't read what those devices sync. ${fix} those devices.`;
  }
  return `Some of your devices are running a newer version of Sval, so this computer can't read what those devices sync. ${fix} those devices.`;
}

function indicator(
  state,
  severity,
  icon,
  label,
  tooltip,
  detail,
  actions = []
) {
  return {
    state,
    severity,
    icon,
    label,
    tooltip,
    detail,
    actions,
    dismissible: false,
    detailShown: false,
  };
}

/**
 * The footer's one sync indicator (spec §3), or null when the footer row is
 * absent. The rules run in order and the first that holds wins, which is spec
 * §3's severity order: critical, error, warning, offline, syncing, synced.
 * A private or automated window ranks just under critical, because nothing in
 * it syncs.
 *
 * A state with no detail sentence in spec §3 has an empty `detail` and its
 * label as the tooltip. The indicator's click opens Settings › Sync, or
 * reopens the dialog when `severity` is `"critical"`, which has no actions.
 * `dismissible` marks the action that dismisses the state, here
 * `dismissOtherWorkspaces`. `detailShown` marks a state whose detail the
 * footer shows under its label (spec §3).
 *
 * @param {object} state
 * @param {"normal"|"private"|"automated"} state.window
 * @param {boolean} state.sharing A sync folder is chosen.
 * @param {boolean} state.firstPassDone
 * @param {{ problem: string|null, since: number|null }} state.folder The
 *   reason from `folderProblem`, and when the folder went away.
 * @param {number|null} state.lastSynced
 * @param {string|null} state.keyState One of `SvalIdentity.SYNC_KEY_STATES`,
 *   compared by value: the sync worker loads this module, and
 *   `SvalIdentity`'s lazy getters cannot load there.
 * @param {string} state.platform `AppConstants.platform`.
 * @param {boolean} state.unpairedDevice And not dismissed.
 * @param {Array<string|null>} [state.newerSchema] The names of the other
 *   devices whose files this build skipped as too new, one entry each, null
 *   for one whose name has not arrived.
 * @param {boolean} [state.newerSchemaOwn] This device's own stored file is
 *   too new for this build.
 * @param {Array<string|null>} [state.harmedByClock] The names of the
 *   devices whose clocks set ahead cost this device something, one entry
 *   each, null for one whose name has not arrived (decision 1714).
 * @param {boolean} [state.hasReading] Whether this device has a time
 *   reading. Without one, its own clock may be the wrong one, so no device
 *   is blamed.
 * @param {{ title: string }|null} state.critical
 * @param {number} state.now Milliseconds since the epoch.
 * @param {Function} state.formatTime Turns a timestamp into a time of day.
 * @returns {object|null} `{ state, severity, icon, label, tooltip, detail,
 *   actions, dismissible, detailShown }`, where `state` names the rule
 *   that held.
 */
export function syncIndicator({
  window: windowKind,
  sharing,
  firstPassDone,
  folder,
  lastSynced,
  keyState,
  platform,
  unpairedDevice,
  newerSchema = [],
  newerSchemaOwn = false,
  harmedByClock = [],
  hasReading = true,
  critical,
  now,
  formatTime,
}) {
  if (critical) {
    return indicator(
      "critical",
      "critical",
      "moon-error",
      critical.title,
      critical.title,
      ""
    );
  }
  if (windowKind !== "normal") {
    return indicator(
      `${windowKind}-window`,
      "off",
      "moon-off",
      "",
      UNSAVED_WINDOW_DETAIL[windowKind],
      UNSAVED_WINDOW_DETAIL[windowKind]
    );
  }
  if (!sharing) {
    return null;
  }

  const problem = folder?.problem ?? null;
  const waited = showsFolderNotice(folder?.since ?? null, now);
  const choose = [{ label: "Choose Folder…", command: "chooseSharedFolder" }];

  if (keyState === "missing" || keyState === "different") {
    const detail = "Sync is off on this device.";
    return indicator(
      "key-gone",
      "error",
      "moon-error",
      "Sync is off",
      detail,
      detail,
      [{ label: "Reconnect…", command: "pairAgain" }]
    );
  }
  if (problem === "too-large") {
    const detail =
      "Your sync folder is too large to sync. Choose a different folder.";
    return indicator(
      "too-large",
      "error",
      "moon-error",
      "Sync stopped",
      detail,
      detail,
      [{ label: "Settings", command: "openStorageSettings" }]
    );
  }
  if (problem === "gone" && waited) {
    return indicator(
      "folder-gone",
      "warning",
      "moon-warning",
      "Sync folder not found",
      "Sync folder not found",
      "",
      choose
    );
  }
  if (problem === "denied") {
    return indicator(
      "folder-denied",
      "warning",
      "moon-warning",
      "Can't access sync folder",
      "Can't access sync folder",
      "",
      choose
    );
  }
  if (unpairedDevice) {
    const detail =
      "Your sync folder has Workspaces from a device that isn't syncing " +
      'with this one. To sync them, choose "Sync with another device" on ' +
      "that device and enter the code it shows here.";
    const shown = indicator(
      "unpaired-device",
      "warning",
      "moon-warning",
      "Pair your other device",
      detail,
      detail,
      [
        { label: "Enter Code…", command: "pairAgain" },
        { label: "✕", command: "dismissOtherWorkspaces" },
      ]
    );
    shown.dismissible = true;
    shown.detailShown = true;
    return shown;
  }
  if (newerSchema.length || newerSchemaOwn) {
    const detail = newerSchema.length
      ? newerSchemaDetail(newerSchema)
      : "A newer version of Sval saved this computer's Workspaces. Update " +
        "Sval on this computer to keep syncing.";
    // The detail names the devices, which the footer's one-line label has no
    // room for.
    const shown = indicator(
      "newer-schema",
      "warning",
      "moon-warning",
      newerSchema.length
        ? "Can't sync with another device"
        : "Can't sync this computer",
      detail,
      detail,
      [{ label: "Check for Updates…", command: "checkForUpdate" }]
    );
    shown.detailShown = true;
    return shown;
  }
  if (hasReading && harmedByClock.length) {
    const shown = indicator(
      "clock-harm",
      "warning",
      "moon-warning",
      "Sync problem",
      clockHarmDetail(harmedByClock),
      clockHarmDetail(harmedByClock)
    );
    shown.detailShown = true;
    return shown;
  }
  if (keyState === "unreadable") {
    const detail = KEY_ACCESS_DETAIL[platform] ?? KEY_ACCESS_DETAIL.linux;
    return indicator(
      "key-unreadable",
      "warning",
      "moon-warning",
      "Sync needs access",
      detail,
      detail,
      [
        {
          label: keyStoreRetryLabel(platform),
          command: "retrySyncKey",
        },
      ]
    );
  }
  if (problem === "offline" && waited) {
    const detail = "Can't reach your sync folder";
    return indicator(
      lastSynced === null ? "offline-never-synced" : "offline",
      "offline",
      "moon-offline",
      lastSynced === null
        ? "Not synced yet"
        : `Last synced ${formatTime(lastSynced)}`,
      detail,
      detail
    );
  }
  if (!firstPassDone) {
    return indicator(
      "syncing",
      "syncing",
      "moon-syncing",
      "",
      "Syncing…",
      "Syncing…"
    );
  }
  const text = lastSyncedText(lastSynced, now);
  return indicator("synced", "synced", "moon", "", text, text);
}
