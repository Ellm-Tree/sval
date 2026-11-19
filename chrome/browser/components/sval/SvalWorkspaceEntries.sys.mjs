/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How a Workspace is named, labelled and marked in a menu: the switcher's
 * list, the strip's app menus, the row menu's Move to Workspace and the menu
 * bar's Workspaces menu all draw an entry with these, so a Workspace reads
 * the same wherever it is listed.
 *
 * Each takes a `SvalPanelModel.switcherItems` entry and holds no state.
 */

import {
  brandURL,
  modelBrandOf,
} from "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs";
import { descendantTabCount } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  SvalDeviceNames: "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
});

/** The robot face that marks an agent's workspace (agent-control spec §6). */
const AGENT_ROBOT_URL = "chrome://browser/content/sval/agent-robot.svg";

/** The box that marks an isolated workspace (isolated workspaces spec §10). */
const ISOLATED_BOX_URL = "chrome://browser/content/sval/workspace-isolated.svg";

/** What an isolated workspace's mark means, for its tooltip and description. */
export const ISOLATED_TEXT =
  "Isolated: sites here can’t see sign-ins from other Workspaces";

/** What an agent's mark means, for its tooltip and description. */
export const AGENT_TEXT = "Agent Workspace";

/**
 * The phone that marks a phone's own workspace (decision 2254), and the
 * devices' heading. A tablet's wears {@link DEVICE_TABLET_URL}.
 */
const DEVICE_PHONE_URL = "chrome://browser/content/sval/device-phone.svg";
const DEVICE_TABLET_URL = "chrome://browser/content/sval/device-tablet.svg";

/**
 * The heading over the agents' part of a workspace list. It wears the
 * robot, the face each entry under it wears.
 */
const AGENTS_CAPTION = "Agent Workspaces";

/**
 * The heading over the phones' and tablets' own workspaces. It wears the
 * phone, as each entry under it does.
 */
const DEVICES_CAPTION = "Devices";

/**
 * Whether a `switcherItems` entry is one of the user's own workspaces:
 * neither a device's nor an agent's.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function usersOwn(item) {
  return !item.agent && !item.device;
}

/**
 * Starts the devices' part of a workspace list: a separator after any of
 * the user's entries, then {@link DEVICES_CAPTION}. A `menucaption` in a
 * menu Gecko draws, which the arrow keys pass over, and a disabled item
 * in one a native menu bar can show, which draws no `menucaption`.
 *
 * @param {Element} popup The `menupopup` being filled.
 * @param {object} [options]
 * @param {boolean} [options.native] Whether a native menu bar shows it.
 */
export function appendDevicesCaption(popup, { native = false } = {}) {
  if (native || popup.querySelector(":scope > [data-workspace-id]")) {
    popup.append(popup.ownerDocument.createXULElement("menuseparator"));
  }
  const caption = popup.ownerDocument.createXULElement(
    native ? "menuitem" : "menucaption"
  );
  caption.setAttribute("label", DEVICES_CAPTION);
  caption.setAttribute("data-devices-caption", "true");
  if (native) {
    caption.setAttribute("disabled", "true");
    caption.classList.add("menuitem-iconic", "sval-device-menuitem");
    caption.setAttribute("image", DEVICE_PHONE_URL);
  } else {
    caption.className = "sval-devices-caption";
  }
  popup.append(caption);
}

/**
 * Says how many tabs a device's workspace holds, beside its name and in
 * its accessible description. Its tabs are open on that device and none
 * of them in a window here, so the count is the tree's.
 *
 * @param {Element} el A workspace `menu` or `menuitem`.
 * @param {object} item Its `switcherItems` entry.
 * @param {object} nodes The document's `nodes` map.
 */
export function countDeviceTabs(el, item, nodes) {
  const count = descendantTabCount(nodes, item.id);
  const text = count === 1 ? "1 tab" : `${count} tabs`;
  el.setAttribute("acceltext", text);
  const described = el.getAttribute("description");
  el.setAttribute("description", described ? `${text}. ${described}` : text);
}

/**
 * Starts the agents' part of a switcher list before its first agent entry:
 * a separator after any of the user's entries, then
 * {@link AGENTS_CAPTION}. A `menucaption`, a menu's own heading, which the
 * arrow keys pass over.
 * Each entry under it keeps its robot face, so the marking never rests on
 * the heading alone.
 *
 * @param {Element} popup The `menupopup` being filled.
 * @param {object} item The entry about to be appended.
 */
export function appendAgentsCaption(popup, item) {
  if (!item.agent || popup.querySelector(".sval-agents-caption")) {
    return;
  }
  if (popup.querySelector(":scope > [data-workspace-id]")) {
    popup.append(popup.ownerDocument.createXULElement("menuseparator"));
  }
  const caption = popup.ownerDocument.createXULElement("menucaption");
  caption.className = "sval-agents-caption";
  caption.setAttribute("label", AGENTS_CAPTION);
  popup.append(caption);
}

/**
 * Starts the agents' part of a menu a native menu bar can show: a
 * separator, then a disabled item that names them. A native menu bar draws
 * no `menucaption`.
 *
 * @param {Element} popup
 */
export function appendAgentsMenuCaption(popup) {
  const caption = popup.ownerDocument.createXULElement("menuitem");
  caption.setAttribute("label", AGENTS_CAPTION);
  caption.setAttribute("disabled", "true");
  caption.setAttribute("data-agents-caption", "true");
  caption.classList.add("menuitem-iconic", "sval-agent-menuitem");
  caption.setAttribute("image", AGENT_ROBOT_URL);
  popup.append(popup.ownerDocument.createXULElement("menuseparator"), caption);
}

/**
 * Appends the agents' workspaces to `popup`: one menu for each app, the
 * agent's name and its app's mark (`markAgentItem`), holding its
 * workspaces (`appendAgentAppEntries`). Every menu that lists the
 * agents' workspaces draws them this way, because every workspace of an
 * app carries the app's name, and only the task tells them apart.
 *
 * @param {Element} popup
 * @param {object[]} items The agents' `switcherItems` entries.
 * @param {function(object): Element} entryFor Draws one workspace's entry.
 * @returns {Element[]} Each app's `menu`.
 */
export function appendAgentApps(popup, items, entryFor) {
  const apps = [];
  for (const [app, entries] of Map.groupBy(items, item => item.agent)) {
    const el = popup.ownerDocument.createXULElement("menu");
    el.setAttribute("data-agent-app", app);
    labelMenuEntry(el, app);
    markAgentItem(el, { agent: app, brand: entries[0].brand });
    const appPopup = popup.ownerDocument.createXULElement("menupopup");
    appendAgentAppEntries(appPopup, entries, entryFor);
    el.append(appPopup);
    popup.append(el);
    apps.push(el);
  }
  return apps;
}

/**
 * Appends one agent app's workspaces to `popup`, the one a session used
 * last first (decision 1998), each wearing its model's mark
 * (`markAgentModel`). The app's menus and the strip's list of an
 * app ({@link _openStripAppMenu}) both draw them this way.
 *
 * @param {Element} popup
 * @param {object[]} entries The app's `switcherItems` entries.
 * @param {function(object): Element} entryFor Draws one workspace's entry.
 */
export function appendAgentAppEntries(popup, entries, entryFor) {
  const used = item => agentWorkspaceEntry(item.id)?.lastUsed ?? -Infinity;
  for (const item of entries.toSorted((a, b) => used(b) - used(a))) {
    const el = entryFor(item);
    markAgentModel(el, item.id);
    popup.append(el);
  }
}

/**
 * What this device's agents file says of an agent workspace: its folder,
 * model and last use. A workspace another device's agent works in has
 * none here.
 *
 * @param {string} id
 * @returns {object|null}
 */
export function agentWorkspaceEntry(id) {
  const store = lazy.SvalAgents.store;
  const agent = store?.agentOfWorkspace(id);
  return agent ? store.workspaceOf(agent.agentId, id) : null;
}

/**
 * Gives an agent workspace's entry its model's mark as its image, or
 * none when its session named no model Sval knows.
 *
 * @param {Element} el A workspace `menu` or `menuitem`.
 * @param {string} id
 */
export function markAgentModel(el, id) {
  const url = brandURL(modelBrandOf(agentWorkspaceEntry(id)?.model));
  if (url) {
    el.classList.add(iconicClass(el), "sval-agent-menuitem");
    el.setAttribute("image", url);
  } else {
    el.removeAttribute("image");
    el.classList.remove(iconicClass(el), "sval-agent-menuitem");
  }
}

/**
 * The mark an agent's Workspace wears: its app's, or the robot.
 *
 * @param {string|null} brand `SvalAgentBrands.agentBrandOf`'s answer.
 * @returns {string}
 */
export function agentMarkURL(brand) {
  return brandURL(brand) ?? AGENT_ROBOT_URL;
}

/**
 * The mark a phone's or tablet's Workspace wears: the tablet for a
 * device that says it is one (`SvalDeviceNames.kindOf`), else the phone.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A workspace's id.
 * @returns {string|null} null for a workspace that is no device's.
 */
export function deviceMarkURL(nodes, id) {
  const device = nodes[id]?.device_home?.device;
  if (!device) {
    return null;
  }
  return lazy.SvalDeviceNames.kindOf(device) === "tablet"
    ? DEVICE_TABLET_URL
    : DEVICE_PHONE_URL;
}

/**
 * Labels an agent workspace's entry in its app's menu: its task, then
 * where its session ran, the model, and when a session last used it.
 *
 * @param {Element} el A `menu` or `menuitem`.
 * @param {object} item Its `switcherItems` entry.
 */
export function labelAgentEntry(el, item) {
  const task = workspaceName(item);
  const entry = agentWorkspaceEntry(item.id);
  const detail = [
    entry?.dir ? folderName(entry.dir) : "",
    entry?.model ?? "",
    entry?.lastUsed ? usedAgo(entry.lastUsed) : "",
  ].filter(Boolean);
  labelMenuEntry(el, [task, ...detail].join(" · "), task);
}

/**
 * The last folder of `dir`, a path the agent's session reported. It is
 * split by hand: the agent may spell it with either separator, and on
 * Windows `PathUtils` throws on a forward slash, or crashes in a debug or
 * automated build (`PathUtils::InitFileWithPath`).
 *
 * @param {string} dir
 * @returns {string}
 */
export function folderName(dir) {
  return dir.split(/[\\/]+/).findLast(Boolean) ?? "";
}

/**
 * When a session last used an agent workspace, as people say it.
 *
 * @param {number} when Milliseconds since the epoch.
 * @returns {string}
 */
function usedAgo(when) {
  const minutes = Math.round((Date.now() - when) / 60_000);
  const say = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return say.format(-minutes, "minute");
  }
  if (minutes < 24 * 60) {
    return say.format(-Math.round(minutes / 60), "hour");
  }
  return say.format(-Math.round(minutes / (24 * 60)), "day");
}

/**
 * One menu label for a `switcherItems` entry: its emoji, then its name.
 *
 * @param {object} item
 * @returns {string}
 */
export function switcherItemLabel(item) {
  const name = workspaceName(item);
  return item.emoji && !item.agent ? `${item.emoji} ${name}` : name;
}

/**
 * What a `switcherItems` entry is called: the workspace's own name, which
 * for an agent's workspace is its task (decision 0125). An app's
 * sessions each have a workspace (decision 1998), so the app's name
 * tells them apart nowhere.
 *
 * @param {object} item
 * @returns {string}
 */
export function workspaceName(item) {
  return item.name || "Untitled Workspace";
}

/**
 * Labels a workspace's menu entry (`switcherItemLabel`), keyed by
 * its name, which is what type-ahead finds it by.
 *
 * @param {Element} el A `menuitem`.
 * @param {object} item Its `switcherItems` entry.
 */
export function labelWorkspaceEntry(el, item) {
  labelMenuEntry(el, switcherItemLabel(item), workspaceName(item));
}

/**
 * Labels a menu entry and gives it the first letter or digit of `name` as
 * its access key, the first thing in it that can be typed.
 *
 * Gecko's menu type-ahead matches an entry's `accesskey` when it has one
 * and the start of its `label` otherwise
 * (`XULMenuParentElement::FindMenuWithShortcut`), so the key is what lets a
 * label that leads with an emoji be reached by its name's first letter.
 * Every entry of a menu that keys one is keyed: a letter that only one
 * keyed entry starts with chooses that entry outright, even when an
 * unkeyed entry's label starts with it too.
 *
 * @param {Element} el A `menuitem` or `menu`.
 * @param {string} label
 * @param {string} [name] The part of `label` that names the entry.
 */
export function labelMenuEntry(el, label, name = label) {
  el.setAttribute("label", label);
  const key = name.match(/[\p{L}\p{N}]/u)?.[0];
  if (key) {
    el.setAttribute("accesskey", key);
  }
}

/**
 * Gives an agent's workspace entry its app's mark (`agentMarkURL`),
 * as the item's image, and
 * says what it means (`describeMenuEntry`), so the mark does not
 * rest on the image alone (agent-control spec §6).
 *
 * @param {Element} el A workspace `menu` or `menuitem`.
 * @param {object} item Its `switcherItems` entry.
 */
export function markAgentItem(el, item) {
  if (!item.agent) {
    return;
  }
  el.classList.add(iconicClass(el), "sval-agent-menuitem");
  el.setAttribute("image", agentMarkURL(item.brand));
  describeMenuEntry(el, AGENT_TEXT);
}

/**
 * Gives a phone's or tablet's workspace entry its device's mark, as its
 * image, as `markAgentItem` gives an agent's the robot.
 *
 * @param {Element} el A workspace `menu` or `menuitem`.
 * @param {object} item Its `switcherItems` entry.
 * @param {object} nodes The document's `nodes` map.
 */
export function markDeviceItem(el, item, nodes) {
  if (!item.device) {
    return;
  }
  el.classList.add(iconicClass(el), "sval-device-menuitem");
  el.setAttribute("image", deviceMarkURL(nodes, item.id));
}

/**
 * The class that shows an entry's `image`: Firefox's `menu.css` keys a
 * `menu`'s icon on `menu-iconic` and a `menuitem`'s on `menuitem-iconic`.
 *
 * @param {Element} el A `menu` or `menuitem`.
 * @returns {string}
 */
function iconicClass(el) {
  return el.localName === "menu" ? "menu-iconic" : "menuitem-iconic";
}

/**
 * Says what a menu entry's mark means: in its tooltip, to the eye, and in
 * its `description`, which is what Gecko exposes as a menu item's
 * accessible description (`XULMenuitemAccessible::Description`); a menu
 * item's tooltip reaches no screen reader.
 *
 * @param {Element} el A `menuitem`.
 * @param {string} text
 */
function describeMenuEntry(el, text) {
  el.setAttribute("tooltiptext", text);
  el.setAttribute("description", text);
}

/**
 * Gives an isolated workspace's entry the box (isolated workspaces spec
 * §10), as its image, as `markAgentItem` does. An agent's entry
 * keeps its robot and a device's its phone, the one image an item has,
 * and its description says it is isolated.
 *
 * @param {Element} el A workspace `menu` or `menuitem`.
 * @param {object} item The entry it draws.
 * @param {object} nodes The document's `nodes` map.
 */
export function markIsolatedItem(el, item, nodes) {
  if (!lazy.SvalWorkspaceJar.isIsolated(nodes, item.id)) {
    return;
  }
  describeMenuEntry(
    el,
    item.agent ? `${AGENT_TEXT}. ${ISOLATED_TEXT}` : ISOLATED_TEXT
  );
  if (!item.agent && !item.device) {
    el.classList.add(iconicClass(el), "sval-isolated-menuitem");
    el.setAttribute("image", ISOLATED_BOX_URL);
  }
}
