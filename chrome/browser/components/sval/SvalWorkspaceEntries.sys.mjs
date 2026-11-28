/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How a Workspace is named, labelled and marked in a menu: the switcher's
 * list, the strip's app menus, the row menu's Move to Workspace and the menu
 * bar's Workspaces menu all draw an entry with these, so a Workspace reads
 * the same wherever it is listed.
 *
 * Each takes a `SvalPanelModel.switcherItems` entry and holds no state. An
 * entry here is a `SvalMenu` item, plain data, which these fill in.
 */

import {
  agentBrandOf,
  brandURL,
  modelBrandOf,
} from "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs";
import {
  agentLabelOf,
  descendantTabCount,
  isDeviceWorkspace,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { appearanceOf } from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

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
 * The phone that marks a phone's own workspace, and the
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
 * Sets an attribute of an entry.
 *
 * @param {object} entry A `SvalMenu` item.
 * @param {string} name
 * @param {string} value
 */
function setAttribute(entry, name, value) {
  entry.attributes = { ...entry.attributes, [name]: value };
}

/**
 * Adds a class to an entry.
 *
 * @param {object} entry A `SvalMenu` item.
 * @param {string} name
 */
function addClass(entry, name) {
  const names = new Set((entry.className ?? "").split(/\s+/).filter(Boolean));
  names.add(name);
  entry.className = [...names].join(" ");
}

/**
 * Starts the devices' part of a workspace list: a separator, which
 * `SvalMenu` hides with nothing above it, then {@link DEVICES_CAPTION}. A
 * `menucaption` in a menu Gecko draws, which the arrow keys pass over, and
 * a disabled item in one a native menu bar can show, which draws no
 * `menucaption`.
 *
 * @param {object} [options]
 * @param {boolean} [options.native] Whether a native menu bar shows it.
 * @returns {Array<object|string>}
 */
export function devicesCaption({ native = false } = {}) {
  const caption = native
    ? {
        label: DEVICES_CAPTION,
        disabled: true,
        icon: DEVICE_PHONE_URL,
        className: "sval-workspace-menuitem",
      }
    : {
        type: "caption",
        label: DEVICES_CAPTION,
        className: "sval-devices-caption",
      };
  setAttribute(caption, "data-devices-caption", "true");
  return ["separator", caption];
}

/**
 * Says how many tabs a device's workspace holds, beside its name and in
 * its accessible description. Its tabs are open on that device and none
 * of them in a window here, so the count is the tree's.
 *
 * @param {object} entry A workspace's entry.
 * @param {object} item Its `switcherItems` entry.
 * @param {object} nodes The document's `nodes` map.
 */
export function countDeviceTabs(entry, item, nodes) {
  const count = descendantTabCount(nodes, item.id);
  const text = count === 1 ? "1 tab" : `${count} tabs`;
  entry.acceltext = text;
  const described = entry.attributes?.description;
  setAttribute(
    entry,
    "description",
    described ? `${text}. ${described}` : text
  );
}

/**
 * Starts the agents' part of a switcher list: a separator, then
 * {@link AGENTS_CAPTION}. A `menucaption`, a menu's own heading, which the
 * arrow keys pass over.
 * Each entry under it keeps its robot face, so the marking never rests on
 * the heading alone.
 *
 * @returns {Array<object|string>}
 */
export function agentsCaption() {
  return [
    "separator",
    {
      type: "caption",
      label: AGENTS_CAPTION,
      className: "sval-agents-caption",
    },
  ];
}

/**
 * Starts the agents' part of a menu a native menu bar can show: a
 * separator, then a disabled item that names them. A native menu bar draws
 * no `menucaption`.
 *
 * @returns {Array<object|string>}
 */
export function agentsMenuCaption() {
  const caption = {
    label: AGENTS_CAPTION,
    disabled: true,
    icon: AGENT_ROBOT_URL,
    className: "sval-workspace-menuitem",
  };
  setAttribute(caption, "data-agents-caption", "true");
  return ["separator", caption];
}

/**
 * The agents' workspaces: one menu for each app, the agent's name and its
 * app's mark (`markAgentApp`), holding its workspaces
 * (`agentAppEntries`). Every menu that lists the agents' workspaces draws
 * them this way, because every workspace of an app carries the app's name,
 * and only the task tells them apart.
 *
 * @param {object[]} items The agents' `switcherItems` entries.
 * @param {function(object): object} entryFor One workspace's entry.
 * @param {string} [popupClassName] The class of each app's submenu.
 * @returns {object[]} Each app's menu.
 */
export function agentApps(items, entryFor, popupClassName) {
  const apps = [];
  for (const [app, entries] of Map.groupBy(items, item => item.agent)) {
    const entry = {
      items: agentAppEntries(entries, entryFor),
      popupClassName,
    };
    setAttribute(entry, "data-agent-app", app);
    labelMenuEntry(entry, app);
    markAgentApp(entry, entries[0].brand);
    apps.push(entry);
  }
  return apps;
}

/**
 * One agent app's workspaces, the one a session used last first (decision
 * 1998), each wearing its model's mark (`markAgentModel`). The app's menus
 * and the strip's list of an app (`SvalPanelStrip`) both draw them this way.
 *
 * @param {object[]} entries The app's `switcherItems` entries.
 * @param {function(object): object} entryFor One workspace's entry.
 * @returns {object[]}
 */
export function agentAppEntries(entries, entryFor) {
  const used = item => agentWorkspaceEntry(item.id)?.lastUsed ?? -Infinity;
  return entries
    .toSorted((a, b) => used(b) - used(a))
    .map(item => {
      const entry = entryFor(item);
      markAgentModel(entry, item.id);
      return entry;
    });
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
 * @param {object} entry A workspace's entry.
 * @param {string} id
 */
export function markAgentModel(entry, id) {
  const url = brandURL(modelBrandOf(agentWorkspaceEntry(id)?.model));
  if (url) {
    delete entry.type;
    addClass(entry, "sval-workspace-menuitem");
    entry.icon = url;
  } else {
    delete entry.icon;
    entry.className = (entry.className ?? "")
      .split(/\s+/)
      .filter(name => name && name !== "sval-workspace-menuitem")
      .join(" ");
  }
}

/**
 * A Workspace's icon. Every surface that draws one takes it from here, so
 * a Workspace wears the same icon in the strip, the switcher, every menu,
 * a Peek, the Launcher and the Downloads panel.
 *
 * An agent's Workspace wears its app's mark or the robot, and a phone's or
 * tablet's its device's mark, in place of an emoji of its own. Any other
 * Workspace wears the emoji the user chose, or none.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A workspace's id.
 * @returns {{mark: string|null, emoji: string|null}} `mark` is an image's
 *   URL, drawn as a mask in the text's colour or as a menu item's image.
 */
export function workspaceIcon(nodes, id) {
  if (agentLabelOf(nodes, id) !== null) {
    return {
      mark: agentMarkURL(agentBrandOf(nodes[id].agent.label)),
      emoji: null,
    };
  }
  if (isDeviceWorkspace(nodes, id)) {
    return { mark: deviceMarkURL(nodes, id), emoji: null };
  }
  return { mark: null, emoji: appearanceOf(nodes, id).emoji };
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
 * @param {string} id A device's workspace's id.
 * @returns {string}
 */
function deviceMarkURL(nodes, id) {
  const device = nodes[id].device_home.device;
  return lazy.SvalDeviceNames.kindOf(device) === "tablet"
    ? DEVICE_TABLET_URL
    : DEVICE_PHONE_URL;
}

/**
 * Labels an agent workspace's entry in its app's menu: its task, then
 * where its session ran, the model, and when a session last used it.
 *
 * @param {object} entry A workspace's entry.
 * @param {object} item Its `switcherItems` entry.
 */
export function labelAgentEntry(entry, item) {
  const task = workspaceName(item);
  const session = agentWorkspaceEntry(item.id);
  const detail = [
    session?.dir ? folderName(session.dir) : "",
    session?.model ?? "",
    session?.lastUsed ? usedAgo(session.lastUsed) : "",
  ].filter(Boolean);
  labelMenuEntry(entry, [task, ...detail].join(" · "), task);
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
 * for an agent's workspace is its task. An app's
 * sessions each have a workspace, so the app's name
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
 * @param {object} entry A workspace's entry.
 * @param {object} item Its `switcherItems` entry.
 */
export function labelWorkspaceEntry(entry, item) {
  labelMenuEntry(entry, switcherItemLabel(item), workspaceName(item));
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
 * @param {object} entry A `SvalMenu` item.
 * @param {string} label
 * @param {string} [name] The part of `label` that names the entry.
 * @returns {object} `entry`.
 */
export function labelMenuEntry(entry, label, name = label) {
  entry.label = label;
  const key = name.match(/[\p{L}\p{N}]/u)?.[0];
  if (key) {
    setAttribute(entry, "accesskey", key);
  }
  return entry;
}

/**
 * Gives a workspace's entry its mark (`workspaceIcon`) as its image, and
 * says what an agent's means (`describeMenuEntry`), so the mark does not
 * rest on the image alone (agent-control spec §6). The user's own
 * Workspaces wear their emoji in their label (`switcherItemLabel`).
 *
 * A native macOS menu draws no image on a checkbox or radio item
 * (`nsMenuItemX::SetupIcon`), so an entry with a mark is a plain item,
 * which shows `checked` all the same (`nsMenuItemX::SetChecked`).
 *
 * @param {object} entry A workspace's entry.
 * @param {object} item Its `switcherItems` entry.
 * @param {object} nodes The document's `nodes` map.
 */
export function markWorkspaceItem(entry, item, nodes) {
  const { mark } = workspaceIcon(nodes, item.id);
  if (!mark) {
    return;
  }
  delete entry.type;
  addClass(entry, "sval-workspace-menuitem");
  entry.icon = mark;
  if (item.agent) {
    describeMenuEntry(entry, AGENT_TEXT);
  }
}

/**
 * Gives an agent app's menu its app's mark, as `markWorkspaceItem` gives
 * each of its Workspaces theirs.
 *
 * @param {object} entry The app's menu.
 * @param {string|null} brand `SvalAgentBrands.agentBrandOf`'s answer.
 */
function markAgentApp(entry, brand) {
  addClass(entry, "sval-workspace-menuitem");
  entry.icon = agentMarkURL(brand);
  describeMenuEntry(entry, AGENT_TEXT);
}

/**
 * Says what a menu entry's mark means: in its tooltip, to the eye, and in
 * its `description`, which is what Gecko exposes as a menu item's
 * accessible description (`XULMenuitemAccessible::Description`); a menu
 * item's tooltip reaches no screen reader.
 *
 * @param {object} entry
 * @param {string} text
 */
function describeMenuEntry(entry, text) {
  setAttribute(entry, "tooltiptext", text);
  setAttribute(entry, "description", text);
}

/**
 * Gives an isolated workspace's entry the box (isolated workspaces spec
 * §10), as its image, as `markWorkspaceItem` does. An agent's entry
 * and a device's keep their mark (`workspaceIcon`), the one image an item
 * has, and the description says the Workspace is isolated.
 *
 * @param {object} entry A workspace's entry.
 * @param {object} item The entry it draws.
 * @param {object} nodes The document's `nodes` map.
 */
export function markIsolatedItem(entry, item, nodes) {
  if (!lazy.SvalWorkspaceJar.isIsolated(nodes, item.id)) {
    return;
  }
  describeMenuEntry(
    entry,
    item.agent ? `${AGENT_TEXT}. ${ISOLATED_TEXT}` : ISOLATED_TEXT
  );
  if (!workspaceIcon(nodes, item.id).mark) {
    addClass(entry, "sval-workspace-menuitem");
    entry.icon = ISOLATED_BOX_URL;
  }
}
