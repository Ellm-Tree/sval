/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What an import reads, and what it turns into (import spec §3).
 *
 * Pure: no I/O, no clock, no randomness. Every reader returns one shape, a
 * `Harvest`, and this module turns a harvest plus the user's choices into tree
 * operations and favorites to add. So the rules of §3 are tested once, here,
 * whatever browser the data came from.
 *
 * A `Harvest`:
 *
 *     {
 *       windows: [Window],     // open windows, Arc Spaces, Safari Tab Groups
 *       bookmarks: Roots|null, // null when the source has none
 *       logins: number|null,   // saved-login count; null when not counted
 *       encryptedSession: bool,// open windows exist only encrypted (§4.1)
 *       skipped: number,       // items of a kind import does not carry
 *       arcCard?: object,      // the card Arc gave its user (SvalCard)
 *     }
 *
 *     Window = { kind, name, emoji, color, children: [Node], source? }
 *       kind is "window", "edgeWorkspace", "workspace" (Vivaldi's),
 *       "space" (Arc's and Zen's) or "tabGroup"; `source` is the source's
 *       own id for it, where an `Archived` names it
 *     Node   = { type: "group", name, color, children: [Node] }
 *            | { type: "split", name, shares, children: [Tab] }
 *            | Tab
 *     Tab    = { type: "tab", title, url, emoji? }
 *     Archived = { title, url, closedAt, source }
 *       a tab the source archived (idle-tab archive spec §7.6), in the
 *       harvest's optional `archived`: `closedAt` in milliseconds since the
 *       epoch, `source` the `source` of its window, or null when the source
 *       no longer holds that window
 *     Roots  = { toolbar: [Mark], menu: [Mark], other: [Mark] }
 *     Mark   = { type: "folder", title, children: [Mark], pinned? }
 *            | { type: "bookmark", title, url, pinned? }
 *
 * A mark with `pinned` is one the source shows as a pin, as Arc's Favorites
 * and Zen's Essentials are, and arrives as a pin (pins spec §10).
 *
 * `name`, `emoji` and `color` are null when the source has none, and a tab's
 * `emoji` is absent too. `color` is
 * already one of Sval's presets (`SvalColor.PRESETS`): each reader maps its own palette with
 * {@link chromiumColor} or {@link nearestColor}.
 *
 * A split is the source's split view, its tabs the panes from left to right
 * (split-view spec §7). Its `shares` are the panes' widths in the source's own
 * units, one per pane and each above 0, or null for equal widths.
 */

import { SPLIT_MAX_PANES } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { sharesOf } from "moz-src:///browser/components/sval/SvalSplits.sys.mjs";

/**
 * Chromium's `tab_groups::TabGroupColorId`, by value
 * (`components/tab_groups/tab_group_color.h`). Firefox's are the same
 * colours, with grey spelled `gray`.
 */
const CHROMIUM_COLORS = Object.freeze([
  "gray",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

/**
 * @param {number} value A `TabGroupColorId`.
 * @returns {string} Sval's token. An unknown value is grey, as Chromium draws
 *   it.
 */
export function chromiumColor(value) {
  return CHROMIUM_COLORS[value] ?? "gray";
}

/**
 * The hue each token stands for, in degrees, for {@link nearestColor}. Gray
 * has none and is chosen by saturation instead.
 */
const HUES = Object.freeze({
  red: 0,
  orange: 30,
  yellow: 55,
  green: 120,
  cyan: 185,
  blue: 220,
  purple: 275,
  pink: 325,
});

/**
 * The nearest of Sval's tokens to an RGB colour, by hue. Arc stores a Space's
 * colour as RGB (import spec §4.2), and the panel can only draw a token.
 *
 * @param {object} rgb `{ red, green, blue }`, each 0–1.
 * @returns {string|null} A token, or null for a value that is not a colour.
 */
export function nearestColor(rgb) {
  const { red: r, green: g, blue: b } = rgb ?? {};
  if (![r, g, b].every(v => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  // Below this saturation a colour reads as grey whatever its hue.
  if (max === 0 || delta / max < 0.15) {
    return "gray";
  }
  let hue;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  hue = (hue + 360) % 360;
  let best = null;
  let bestDistance = Infinity;
  for (const [token, at] of Object.entries(HUES)) {
    const distance = Math.min(Math.abs(hue - at), 360 - Math.abs(hue - at));
    if (distance < bestDistance) {
      best = token;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Counts what a harvest holds, for a source's row (import spec §5).
 *
 * @param {object} harvest
 * @returns {{windows: number, tabs: number, groups: number, bookmarks: number}}
 */
export function countHarvest(harvest) {
  let tabs = 0;
  let groups = 0;
  const walk = nodes => {
    for (const node of nodes) {
      if (node.type === "tab") {
        tabs++;
      } else {
        groups += node.type === "group" ? 1 : 0;
        walk(node.children);
      }
    }
  };
  for (const win of harvest.windows) {
    walk(win.children);
  }
  return {
    windows: harvest.windows.length,
    tabs,
    groups,
    bookmarks: harvest.bookmarks ? countMarks(harvest.bookmarks) : 0,
  };
}

/**
 * Whether a harvest holds nothing to import: no window, no bookmark, no
 * encrypted session and no counted login. A browser can list a profile it
 * never used, as Zen does its empty "Default Profile" beside the one in use,
 * and such a profile brings no workspace.
 *
 * @param {object} harvest
 * @returns {boolean}
 */
export function holdsNothing(harvest) {
  const c = countHarvest(harvest);
  return (
    !c.windows &&
    !c.bookmarks &&
    !harvest.encryptedSession &&
    !(harvest.logins > 0)
  );
}

/**
 * The kinds of window a browser already keeps as a workspace of its own,
 * each of which stays one workspace (import spec §3).
 */
const OWN_WORKSPACES = new Set([
  "edgeWorkspace",
  "workspace",
  "space",
  "tabGroup",
]);

/**
 * One browser's profiles as one harvest (import spec §3). A browser is one
 * row however many profiles it keeps, and a profile is a workspace: its
 * plain windows land together in one workspace, named for the profile, and
 * what the browser already keeps as a workspace of its own (an Arc or Zen
 * Space, a Vivaldi or Edge Workspace, a Safari Tab Group) stays one
 * workspace each.
 *
 * A profile with one plain window brings that window's contents; one with
 * several brings each window as a group, "Window 1" onwards, so the
 * windows stay apart inside the one workspace. A browser with one profile
 * names its workspace after the browser, since a lone profile's name is a
 * word the user may never have chosen.
 *
 * Each window carries `profile`, the id of the profile it came from, which
 * decides its cookie jar (isolated workspaces spec §8).
 *
 * @param {object[]} parts `[{ profile, harvest }]`, in the browser's order.
 * @param {string} browser The browser's name.
 * @returns {object} A harvest, with `parts` kept as
 *   `[{ profile, bookmarks }]` for the import to read again and to take
 *   history from.
 */
export function combineProfiles(parts, browser) {
  const several = parts.length > 1;
  const windows = [];
  for (const { profile, harvest } of parts) {
    const plain = harvest.windows.filter(win => !OWN_WORKSPACES.has(win.kind));
    for (const win of harvest.windows) {
      if (OWN_WORKSPACES.has(win.kind)) {
        windows.push({ ...win, profile: profile.id });
      } else if (win === plain[0]) {
        windows.push({
          kind: "profile",
          name: several ? profile.name || profile.id : browser,
          emoji: null,
          color: null,
          profile: profile.id,
          children:
            plain.length === 1
              ? win.children
              : plain.map((w, i) => ({
                  type: "group",
                  name: w.name || `Window ${i + 1}`,
                  color: null,
                  children: w.children,
                })),
        });
      }
    }
  }
  const counted = parts
    .map(part => part.harvest.logins)
    .filter(n => typeof n === "number");
  const archived = parts.find(part => part.harvest.autoArchive);
  // Arc keeps one card per install, so every profile's harvest holds the same.
  const carded = parts.find(part => part.harvest.arcCard);
  const archivedTabs = parts.flatMap(part => part.harvest.archived ?? []);
  return {
    windows,
    bookmarks: mergeRoots(parts.map(part => part.harvest.bookmarks)),
    logins: counted.length ? counted.reduce((a, b) => a + b, 0) : null,
    encryptedSession: parts.some(part => part.harvest.encryptedSession),
    skipped: parts.reduce((n, part) => n + (part.harvest.skipped ?? 0), 0),
    ...(archived && { autoArchive: archived.harvest.autoArchive }),
    ...(carded && { arcCard: carded.harvest.arcCard }),
    ...(archivedTabs.length && { archived: archivedTabs }),
    ...(parts.some(part => part.harvest.file) && { file: true }),
    parts: parts.map(({ profile, harvest }) => ({
      profile,
      bookmarks: harvest.bookmarks,
    })),
  };
}

/**
 * Several profiles' bookmarks as one tree, each root the profiles' roots in
 * order. Favorites drops a bookmark already there (import spec §2), so a
 * bookmark two profiles share arrives once.
 *
 * @param {Array<object|null>} list Each profile's `Roots`, or null.
 * @returns {object|null} null when no profile has bookmarks.
 */
export function mergeRoots(list) {
  const present = list.filter(Boolean);
  if (!present.length) {
    return null;
  }
  return {
    toolbar: present.flatMap(roots => roots.toolbar),
    menu: present.flatMap(roots => roots.menu),
    other: present.flatMap(roots => roots.other),
  };
}

function countMarks(roots) {
  let n = 0;
  const walk = marks => {
    for (const mark of marks) {
      if (mark.type === "bookmark") {
        n++;
      } else {
        walk(mark.children);
      }
    }
  };
  walk(roots.toolbar);
  walk(roots.menu);
  walk(roots.other);
  return n;
}

/**
 * The name each window is offered under (decision 0087): the source's own
 * name when it has one, otherwise "<Browser> Window N" or, for an Edge or
 * Vivaldi workspace, "<Browser> Workspace N", numbered within its kind.
 *
 * @param {object[]} windows A harvest's windows.
 * @param {object} words `{ window(n), workspace(n) }`, each returning the
 *   localised suggestion for the nth unnamed window of that kind.
 * @returns {string[]} One suggestion per window, in order.
 */
export function suggestNames(windows, words) {
  let plain = 0;
  let workspaces = 0;
  return windows.map(win => {
    if (win.name) {
      return win.name;
    }
    return win.kind === "edgeWorkspace" || win.kind === "workspace"
      ? words.workspace(++workspaces)
      : words.window(++plain);
  });
}

/**
 * A window's contents as its preview shows them (import spec §5): every
 * group, nested ones included, each with the tabs directly inside it, and
 * the tabs in no group. A nested group is named by its path, so a reader can
 * tell where it sits without a nested list. A split's tabs are listed where
 * the split stands.
 *
 * @param {object} win A harvest window.
 * @returns {{groups: {path: string[], color: string|null, tabs: object[]}[],
 *   loose: object[]}} Groups in source order, outer before inner, and the
 *   window's own tabs.
 */
export function windowPreview(win) {
  const groups = [];
  const walk = (nodes, path) => {
    const tabs = [];
    for (const node of nodes) {
      if (node.type === "tab") {
        tabs.push(node);
      } else if (node.type === "split") {
        tabs.push(...node.children);
      } else {
        const entry = {
          path: [...path, node.name || ""],
          color: node.color,
          tabs: [],
        };
        groups.push(entry);
        entry.tabs = walk(node.children, entry.path);
      }
    }
    return tabs;
  };
  const loose = walk(win.children, []);
  return { groups, loose };
}

/**
 * The profile a Chromium browser makes first, which `Local State` lists as
 * `Default` and which Arc's Spaces name when they name none.
 */
export const DEFAULT_PROFILE = "Default";

/** Bookmarks go to Favorites, into a new workspace, or nowhere (§2). */
export const BOOKMARKS_TO = Object.freeze({
  favorites: "favorites",
  workspace: "workspace",
  none: "none",
});

/**
 * The workspace each profile's history goes to (decision 1287): the one its
 * plain windows landed in, since a profile is the workspace's analog (§2).
 * A browser keeps a profile's history in one place for all its windows, and
 * records no Space, Tab Group or Workspace per visit, so a profile that also
 * keeps workspaces of its own sends its history to none, as does one whose
 * windows were not imported.
 *
 * @param {object} harvest As `planTree` took it.
 * @param {object[]} windows `planTree`'s `choices.windows`.
 * @param {string[]} workspaces `planTree`'s answer, in its order.
 * @returns {object} Profile id -> workspace id.
 */
export function historyWorkspaces(harvest, windows, workspaces) {
  const ownWorkspaces = new Set(
    harvest.windows
      .filter(win => OWN_WORKSPACES.has(win.kind))
      .map(win => win.profile)
  );
  const profiles = {};
  let next = 0;
  harvest.windows.forEach((win, i) => {
    if (!windows[i]?.import) {
      return;
    }
    const workspace = workspaces[next++];
    if (win.kind === "profile" && !ownWorkspaces.has(win.profile)) {
      profiles[win.profile] = workspace;
    }
  });
  return profiles;
}

/**
 * The Archive entries for a harvest's archived tabs (idle-tab archive spec
 * §7.6), once its windows have landed. A tab whose window landed names that
 * window's workspace, so a restore puts it back there. One whose window the
 * source no longer holds, or the harvest left out for holding nothing to
 * import, names a workspace no tree holds, so a restore puts it in the
 * current one. One whose window the user chose not to import is left out.
 *
 * @param {object} harvest
 * @param {object[]} windows The user's choices, one per harvest window, as
 *   {@link planTree} takes them.
 * @param {string[]} workspaces The workspaces {@link planTree} filled, in
 *   order.
 * @param {object} context
 * @param {Function} context.mintId Returns a fresh node id.
 * @returns {object[]} `{ title, url, workspace, workspaceName, closedAt }`.
 */
export function planArchived(harvest, windows, workspaces, { mintId }) {
  const landed = new Map();
  const declined = new Set();
  let next = 0;
  harvest.windows.forEach((win, i) => {
    if (!windows[i]?.import) {
      if (win.source) {
        declined.add(win.source);
      }
      return;
    }
    const workspace = workspaces[next++];
    if (win.source) {
      landed.set(win.source, { workspace, name: windows[i].name ?? "" });
    }
  });
  let gone = null;
  return (harvest.archived ?? [])
    .filter(tab => !declined.has(tab.source))
    .map(tab => {
      const home = landed.get(tab.source);
      return {
        title: tab.title ?? "",
        url: tab.url,
        workspace: home?.workspace ?? (gone ??= mintId()),
        workspaceName: home?.name ?? "",
        closedAt: tab.closedAt,
      };
    });
}

/**
 * Turns a harvest and the user's choices into tree operations (import spec
 * §3, §7).
 *
 * Ids come from `mintId`, so every operation can name its parent before the
 * engine has seen it, and the whole import travels as one batch. Tabs and
 * groups are added in source order, and the engine appends each after its
 * existing siblings, so source order is the panel's order.
 *
 * @param {object} harvest
 * @param {object} choices
 * @param {object[]} choices.windows One per harvest window, in order:
 *   `{ import: bool, name: string, isolated?: bool }`. `name` is what the
 *   user left in the field; an empty string writes no name. `isolated` makes
 *   that window's workspace isolated (isolated workspaces spec §8).
 * @param {string} choices.bookmarks One of {@link BOOKMARKS_TO}.
 * @param {string} [choices.bookmarksName] The workspace name when bookmarks go
 *   to a workspace.
 * @param {boolean} [choices.isolated] Whether the bookmarks workspace is
 *   isolated (isolated workspaces spec §8).
 * @param {object} context
 * @param {Function} context.mintId Returns a fresh node id.
 * @param {string|null} [context.reuseWorkspace] An empty, unnamed workspace
 *   the first imported window fills instead of adding one (§3).
 * @returns {{ops: object[], workspaces: string[]}} The operations, and the ids
 *   of the workspaces they fill, in order.
 */
export function planTree(harvest, choices, { mintId, reuseWorkspace = null }) {
  const ops = [];
  const workspaces = [];
  let reuse = reuseWorkspace;

  const addWorkspace = (name, emoji, color, isolated) => {
    let id;
    if (reuse) {
      id = reuse;
      reuse = null;
      if (name || emoji) {
        ops.push({ kind: "rename", id, name: name || "" });
      }
      if (isolated) {
        ops.push({ kind: "setIsolation", id, isolated: true });
      }
    } else {
      id = mintId();
      ops.push({
        kind: "addWorkspace",
        id,
        name: name || "",
        icon: null,
        ...(isolated && { isolated: true }),
      });
    }
    if (emoji || color) {
      ops.push({ kind: "setAppearance", id, color, emoji });
    }
    workspaces.push(id);
    return id;
  };

  // A split of more than four panes lands as splits of up to four, in order,
  // and a single pane left over as an ordinary tab, as the panel draws such a
  // split (split-view spec §5.1, §7).
  const addSplit = (parent, split) => {
    const name = split.name || "";
    const widths =
      split.shares?.length === split.children.length ? split.shares : null;
    for (let at = 0; at < split.children.length; at += SPLIT_MAX_PANES) {
      const panes = split.children.slice(at, at + SPLIT_MAX_PANES);
      if (panes.length === 1) {
        addNodes(parent, panes);
        continue;
      }
      const id = mintId();
      ops.push({ kind: "addSplit", id, parent, name });
      addNodes(id, panes);
      const shares = widths && sharesOf(widths.slice(at, at + panes.length));
      if (shares) {
        ops.push({
          kind: "setContent",
          id,
          name,
          url: null,
          icon: null,
          shares,
        });
      }
    }
  };

  const addNodes = (parent, nodes) => {
    for (const node of nodes) {
      if (node.type === "split") {
        addSplit(parent, node);
      } else if (node.type === "tab") {
        const id = mintId();
        ops.push({
          kind: "addTab",
          id,
          parent,
          name: node.title || "",
          url: node.url,
        });
        if (node.emoji) {
          ops.push({
            kind: "setAppearance",
            id,
            color: null,
            emoji: node.emoji,
          });
        }
      } else {
        const id = mintId();
        ops.push({
          kind: "addGroup",
          id,
          parent,
          name: node.name || "",
          icon: null,
        });
        if (node.color) {
          ops.push({
            kind: "setAppearance",
            id,
            color: node.color,
            emoji: null,
          });
        }
        addNodes(id, node.children);
      }
    }
  };

  harvest.windows.forEach((win, i) => {
    const choice = choices.windows[i];
    if (!choice?.import) {
      return;
    }
    const id = addWorkspace(
      choice.name.trim(),
      win.emoji,
      win.color,
      choice.isolated === true
    );
    addNodes(id, win.children);
  });

  if (choices.bookmarks === BOOKMARKS_TO.workspace && harvest.bookmarks) {
    const roots = harvest.bookmarks;
    const marks = [...roots.toolbar, ...roots.menu, ...roots.other];
    if (marks.length) {
      const id = addWorkspace(
        (choices.bookmarksName ?? "").trim(),
        null,
        null,
        choices.isolated === true
      );
      addNodes(id, marks.map(markToNode));
    }
  }
  return { ops, workspaces };
}

function markToNode(mark) {
  return mark.type === "bookmark"
    ? { type: "tab", title: mark.title, url: mark.url }
    : {
        type: "group",
        name: mark.title,
        color: null,
        children: mark.children.map(markToNode),
      };
}

/**
 * The tree to insert into Favorites when bookmarks go there, with every
 * bookmark whose URL is already a favorite left out, and every folder that
 * leaves empty left out with it (import spec §2).
 *
 * Favorites is one tree (decision 0123): the source's toolbar is its top
 * level, and the source's menu and other bookmarks are folders in it. A
 * folder holding only one folder is that folder, so a chain of wrappers
 * another browser's import left arrives as its innermost folder.
 *
 * A source's pins, Arc's Favorites and Zen's Essentials, are a tree of their
 * own for the pins root (pins-root spec §7), in the source's order, with
 * every pin whose URL is already a pin left out. A pin is not a favorite, so
 * an address that is a favorite still arrives as a pin.
 *
 * @param {object} roots A harvest's bookmarks.
 * @param {Iterable<string>} known URLs already favorites.
 * @param {Iterable<string>} [knownPins] URLs already pins.
 * @returns {{favorites: object[], pins: object[], skipped: number}} The two
 *   trees, in `SvalFavoritesStore.insertTree`'s shape.
 */
export function planFavorites(roots, known, knownPins = []) {
  // A favorite holds its URL as `new URL(url).href`
  // (`SvalFavoritesStore`'s `normalUrl`), so two spellings of one URL are
  // one favorite and are compared in that form here.
  const seenOf = urls => {
    const seen = new Set();
    for (const url of urls) {
      seen.add(URL.parse(url)?.href ?? url);
    }
    return seen;
  };
  const seenFavorites = seenOf(known);
  const seenPins = seenOf(knownPins);
  let skipped = 0;
  const pins = [];
  const convert = (marks, seen, inPins) => {
    const out = [];
    for (const mark of marks) {
      const pinned = !inPins && !!mark.pinned;
      const into = pinned ? pins : out;
      if (mark.type === "bookmark") {
        // A favorite is an address that opens, so a URL that does not
        // parse is left out, and so is one too long for history to keep.
        const url = URL.parse(mark.url)?.href;
        if (!url || url.length > URL_LENGTH_MAX) {
          skipped++;
          continue;
        }
        const among = pinned ? seenPins : seen;
        if (among.has(url)) {
          skipped++;
          continue;
        }
        among.add(url);
        into.push({ title: mark.title || "", url });
      } else {
        const children = pinned
          ? convert(mark.children, seenPins, true)
          : convert(mark.children, seen, inPins);
        if (children.length === 1 && children[0].type === FOLDER) {
          into.push(children[0]);
        } else if (children.length) {
          into.push({ title: mark.title || "", type: FOLDER, children });
        }
      }
    }
    return out;
  };
  const favorites = convert(
    [
      ...roots.toolbar,
      { type: "folder", title: "Bookmarks Menu", children: roots.menu },
      { type: "folder", title: "Other Bookmarks", children: roots.other },
    ],
    seenFavorites,
    false
  );
  return { favorites, pins, skipped };
}

/** A folder's `type` in a planned tree. */
export const FOLDER = 2;

/**
 * The longest URL a favorite holds: Places' `DB_URL_LENGTH_MAX`, past which
 * history keeps no visit to open it from.
 */
const URL_LENGTH_MAX = 65536;

/**
 * Whether a URL is one import carries. Tabs and bookmarks on a browser's own
 * internal pages (`chrome://`, `arc://`, `edge://`, `about:`) mean nothing in
 * Sval, and `javascript:` bookmarklets are refused outright.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function importableUrl(url) {
  if (typeof url !== "string" || !url) {
    return false;
  }
  if (/^file:/i.test(url)) {
    return !namesAnotherMachine(url);
  }
  return importableFromFile(url);
}

/**
 * Whether a URL is one import carries from a file the user picks: a web
 * address alone. Anyone can write such a file, and a `file:` address it
 * holds would be marked local and open with this device's trust
 * (decision 1372), which belongs to what the user's own browser kept.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function importableFromFile(url) {
  return typeof url === "string" && /^(https?|ftp):/i.test(url);
}

/**
 * Two separators open the path of a Windows UNC path: `net_GetFileFromURLSpec`
 * turns `file://///host/share` into `\\host\share`, a file Windows fetches
 * from that host, signing in to it as the user. It swaps `/` for `\` before
 * it unescapes, so an escaped `/` or `\` counts too, and Windows takes either
 * as a separator.
 */
const UNC_PATH = /^(?:[/\\]|%2f|%5c){2}/i;

/**
 * Whether a `file:` URL opens a file on another machine. Gecko's file URL
 * parser drops an authority (`nsNoAuthURLParser::ParseAfterScheme`), so the
 * path it keeps decides.
 *
 * @param {string} url
 * @returns {boolean}
 */
function namesAnotherMachine(url) {
  const parsed = URL.parse(url);
  return !parsed || UNC_PATH.test(parsed.pathname);
}

/**
 * The import dialog's line once an import has run (messages spec §7). A
 * source that failed has a line of its own, {@link importFailureLine}.
 *
 * @param {object} report `SvalImport.runImport`'s report.
 * @returns {string}
 */
export function importReportText(report) {
  const n = report.workspaces.length;
  const parts = [];
  if (n) {
    parts.push(`${n} ${n === 1 ? "Workspace" : "Workspaces"}`);
  }
  if (report.favorites) {
    parts.push(
      `${report.favorites.toLocaleString()} ` +
        (report.favorites === 1 ? "favorite" : "favorites")
    );
  }
  // History is named without a count (messages spec §7).
  if (report.history > 0) {
    parts.push("your browsing history");
  }
  if (!parts.length) {
    return "Nothing new to import.";
  }
  const last = parts.pop();
  let list = last;
  if (parts.length === 1) {
    list = `${parts[0]} and ${last}`;
  } else if (parts.length) {
    list = `${parts.join(", ")}, and ${last}`;
  }
  return `Imported ${list} into Sval.`;
}

/**
 * The import dialog's line for a browser that failed, and its buttons
 * (messages spec §7). Its files not opening may pass, so that line offers a
 * second try; data Sval did not understand will not read the next time
 * either, so that line offers a report instead. A browser whose history
 * alone failed brought the rest, so its line speaks of the history only.
 *
 * @param {string} name The browser's name, as `SOURCE_NAMES` gives it.
 * @param {"open"|"data"|"history"} kind `SvalImport.importFailureKind`'s
 *   answer.
 * @returns {{text: string, actions: {label: string, command: string}[]}}
 *   `command` is `retrySource`, `importBookmarksFile` or `sendReport`.
 */
export function importFailureLine(name, kind) {
  const retry = { label: "Try Again", command: "retrySource" };
  if (kind === "history") {
    return { text: `Couldn't import ${name}'s history.`, actions: [retry] };
  }
  const verb = kind === "open" ? "open" : "read";
  const text =
    `Couldn't ${verb} ${name}'s data. Export your bookmarks from ${name} ` +
    "as an HTML file and import that instead.";
  const file = {
    label: "Import Bookmarks File…",
    command: "importBookmarksFile",
  };
  const actions =
    kind === "open"
      ? [retry, file]
      : [file, { label: "Send Report…", command: "sendReport" }];
  return { text, actions };
}
