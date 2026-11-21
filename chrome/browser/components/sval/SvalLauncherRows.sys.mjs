/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One row design for the Launcher's three hosts, the float, the address bar
 * in place and Home's field (launcher spec §7, §8, and the Launcher's
 * design): what each row teaches and how a screen reader hears it.
 *
 * {@link describeRow} reads a row's result once for every host: its kind, the
 * workspace or agent chip of an open tab elsewhere, a pin's or Favorite's
 * mark, what Enter does on it (the hint the selected row shows), and the
 * keys the line under the list offers while it is selected ({@link footFor}).
 * Where a modifier takes a row is `SvalLauncherEnter.whereFor`'s answer, so
 * the line never offers a split where Enter would open a tab.
 *
 * The address bar's view draws its rows itself, so `launcher-rows.patch`
 * hands them here once it has laid them out ({@link
 * SvalLauncherRows.updateRows}) and when the selection moves ({@link
 * SvalLauncherRows.updateSelection}). Home's page draws the same parts from
 * what `SvalHomeSearchParent` sends it. `sval-launcher-rows.css` styles the
 * parts in both.
 *
 * The view's rows are flat children of its listbox, with a heading drawn on
 * the first row of a section. For a screen reader the section is a group
 * named by that heading: the first row is the group, and it owns the
 * options of the rows under the same heading (`aria-owns`).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import {
  ariaShortcut,
  keycap,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

export { keycap };
import { UrlbarUtils } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  COMMANDS_PROVIDER:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  FAVORITES_PROVIDER:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  PINS_GROUP:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  SvalLauncherCommands:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  SvalLauncherEnter:
    "moz-src:///browser/components/sval/SvalLauncherEnter.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
});

/** Each kind's hint: what Enter does there. */
const HINTS = Object.freeze({
  page: "launcher-hint-open",
  history: "launcher-hint-open",
  search: "launcher-hint-search",
  suggestion: "launcher-hint-search",
  pin: "launcher-hint-pin",
  favorite: "launcher-hint-favorite",
  command: "launcher-hint-run",
  picks: "launcher-hint-choose",
  choice: "launcher-hint-move-here",
  "split-choice": "launcher-hint-split",
  new: "launcher-hint-create",
});

/** The keys `foot` offers, as a `<key>`'s attributes. */
const ENTER = "VK_RETURN";
/** Firefox removes a row on Shift+Delete, and on macOS Shift+Backspace. */
const REMOVE = AppConstants.platform === "macosx" ? "VK_BACK" : "VK_DELETE";

/**
 * A row's key in the foot: its cap, the same key in `aria-keyshortcuts`'
 * form, and what it does there.
 *
 * @param {string} keycode
 * @param {string} modifiers
 * @param {string} l10nId
 * @returns {{keys: string[], aria: string, l10nId: string}}
 */
export function rowKey(keycode, modifiers, l10nId) {
  return {
    keys: [keycap(keycode, modifiers)],
    aria: ariaShortcut({ keycode, modifiers }),
    l10nId,
  };
}

/**
 * Where `SvalLauncherEnter.whereFor` takes `result` for a key's modifiers.
 *
 * @param {Window} win
 * @param {UrlbarResult} result
 * @param {object} keys
 * @param {boolean} [keys.shift]
 * @param {boolean} [keys.accel]
 * @param {boolean} [keys.alt]
 * @returns {string}
 */
function whereWith(win, result, { shift = false, accel = false, alt = false }) {
  const mac = AppConstants.platform === "macosx";
  return lazy.SvalLauncherEnter.whereFor({
    win,
    result,
    event: {
      shiftKey: shift,
      altKey: alt,
      metaKey: mac && accel,
      ctrlKey: !mac && accel,
      getModifierState: () => false,
    },
  });
}

/**
 * Whether Enter on a page's or a search's row opens it in a new tab: on a
 * pin, for a page of another site (`SvalLauncherEnter.whereToLoad`).
 *
 * @param {Window} win
 * @param {UrlbarResult} result
 * @returns {boolean}
 */
function entersNewTab(win, result) {
  const { engine } = result.payload;
  // A search of an engine since removed loads nothing.
  if (engine && !lazy.SearchService.getEngineByName(engine)) {
    return false;
  }
  const { url } = UrlbarUtils.getUrlFromResult(result);
  return (
    !!url &&
    lazy.SvalLauncherEnter.whereToLoad(
      win,
      url,
      whereWith(win, result, {}),
      win.gBrowser.selectedBrowser
    ) === "tab"
  );
}

/**
 * The foot's items for the places a page's modifiers open it, by where they
 * go there, less the place Enter alone opens it.
 *
 * @param {Window} win
 * @param {UrlbarResult} result
 * @param {object} [options]
 * @param {boolean} [options.split] Whether Alt+Enter is offered.
 * @param {string|null} [options.enter] Where Enter alone opens it, when
 *   that is one of these places.
 * @returns {object[]}
 */
function placesFor(win, result, { split = true, enter = null } = {}) {
  const LABELS = {
    // A Peek's new tab goes on to a Peek of its own
    // (`SvalPeek.startWindow`).
    tab: lazy.SvalPeek.isPeek(win)
      ? "launcher-foot-new-peek"
      : "launcher-foot-new-tab",
    window: "launcher-foot-new-window",
    split: "launcher-foot-split",
  };
  const items = [];
  const offers = [
    ["shift", { shift: true }],
    ["accel,shift", { accel: true, shift: true }],
    ...(split ? [["alt", { alt: true }]] : []),
  ];
  for (const [modifiers, keys] of offers) {
    const where = whereWith(win, result, keys);
    if (
      LABELS[where] &&
      where !== enter &&
      !items.some(item => item.l10nId === LABELS[where])
    ) {
      items.push(rowKey(ENTER, modifiers, LABELS[where]));
    }
  }
  return items;
}

/**
 * What a row is, for what it teaches.
 *
 * @param {UrlbarResult} result
 * @returns {string|null} null for a row that teaches nothing, such as a tip.
 */
function kindOf(result) {
  const { payload } = result;
  const { DYNAMIC, KEYWORD, OMNIBOX, REMOTE_TAB, SEARCH, TAB_SWITCH } =
    UrlbarUtils.RESULT_TYPE;
  if (result.providerName === lazy.COMMANDS_PROVIDER) {
    if (payload.inChoices) {
      if (payload.isNew) {
        return "new";
      }
      return payload.commandId === "split-with" ? "split-choice" : "choice";
    }
    return payload.picks ? "picks" : "command";
  }
  switch (result.type) {
    case TAB_SWITCH:
      return "tab";
    case SEARCH:
      return payload.isBlockable ? "suggestion" : "search";
    case UrlbarUtils.RESULT_TYPE.URL:
    case KEYWORD:
    case OMNIBOX:
    case REMOTE_TAB:
      if (result.providerName === lazy.FAVORITES_PROVIDER) {
        return result.group === lazy.PINS_GROUP ? "pin" : "favorite";
      }
      return payload.isBlockable ? "history" : "page";
    case DYNAMIC:
    default:
      return null;
  }
}

/**
 * What a row teaches and how a screen reader names it (the Launcher's
 * design, "Rows" and "Teaching").
 *
 * @param {UrlbarResult} result
 * @param {Window} win The browser window the row is for.
 * @returns {object|null} `{ kind, hint: {id, args}, chip: {name, color,
 *   emoji, agent}|null, mark, icon, swatch, name: {id, args}|null, address, foot }`,
 *   or null for a row that teaches nothing. A foot item with `aria` is a key
 *   of this row, which the row names to a screen reader ({@link
 *   accessOf}).
 */
export function describeRow(result, win) {
  const kind = kindOf(result);
  if (!kind) {
    return null;
  }
  const { payload } = result;
  const row = {
    kind,
    hint: { id: HINTS[kind] },
    chip: null,
    mark: null,
    icon: null,
    name: null,
    address: null,
    foot: [],
    swatch: null,
  };
  switch (kind) {
    case "tab": {
      const workspace = payload.svalWorkspaceName;
      if (workspace && !payload.svalHere) {
        row.chip = {
          name: workspace,
          color: payload.svalWorkspaceColor || null,
          mark: payload.svalWorkspaceMark || null,
          emoji: payload.svalWorkspaceEmoji || null,
          agent: !!payload.svalAgent,
        };
        row.hint = { id: "launcher-hint-switch-to", args: { workspace } };
      } else {
        row.hint = { id: "launcher-hint-switch-tab" };
      }
      if (workspace) {
        row.address =
          result.getDisplayableValueAndHighlights("url", { isURL: true })
            .value ?? payload.url;
        row.name = payload.svalAgent
          ? {
              id: "launcher-result-agent-tab-name",
              args: { title: payload.title, agent: workspace },
            }
          : {
              id: "launcher-result-tab-name",
              args: { title: payload.title, workspace },
            };
      }
      if (whereWith(win, result, { shift: true }) === "window") {
        row.foot.push(rowKey(ENTER, "shift", "launcher-foot-new-window"));
      }
      if (whereWith(win, result, { alt: true }) === "split") {
        row.foot.push(rowKey(ENTER, "alt", "launcher-foot-split-with-tab"));
      }
      break;
    }
    case "pin":
    case "favorite":
      row.mark = kind;
      row.foot = placesFor(win, result, { split: false });
      break;
    case "command":
      row.icon = "command";
      row.foot = payload.shortcut
        ? [{ keys: [payload.shortcut], l10nId: "launcher-foot-runs-anywhere" }]
        : [{ note: "launcher-foot-no-shortcut" }];
      if (payload.shiftWindow) {
        row.foot.push(rowKey(ENTER, "shift", "launcher-foot-new-window"));
      }
      break;
    case "picks":
      row.icon = "command";
      row.foot = [{ note: "launcher-foot-opens-list" }];
      break;
    case "choice":
    case "split-choice":
    case "new":
      if (kind === "new") {
        row.icon = "plus";
      } else if (payload.current) {
        row.icon = "check";
      }
      // A workspace's swatch: its colour, or "" for none.
      row.swatch = kind === "choice" ? payload.color || "" : null;
      break;
    default: {
      // A page or a search.
      row.mark =
        result.source === UrlbarUtils.RESULT_SOURCE.BOOKMARKS
          ? "favorite"
          : null;
      const newTab = entersNewTab(win, result);
      if (newTab) {
        row.hint = {
          id:
            kind === "search" || kind === "suggestion"
              ? "launcher-hint-search-new-tab"
              : "launcher-hint-open-new-tab",
        };
      }
      row.foot = placesFor(win, result, { enter: newTab ? "tab" : null });
      if (payload.isBlockable) {
        row.foot.push(rowKey(REMOVE, "shift", "launcher-foot-remove"));
      }
    }
  }
  return row;
}

/**
 * The line under the list, for the row selected: its keys and Escape's.
 *
 * @param {object|null} described {@link describeRow}'s answer for the selected
 *   row, or null for none.
 * @param {object} options
 * @param {boolean} options.choosing Whether the list is a command's choices.
 * @returns {object[]} `[{ keys, l10nId, end } | { note }]`, `keys` each
 *   item's caps. In a command's choices Backspace in the empty field and
 *   Escape both step back (launcher spec §4); elsewhere Escape closes.
 */
export function footFor(described, { choosing }) {
  if (choosing) {
    return [
      {
        keys: [keycap("VK_BACK"), keycap("VK_ESCAPE")],
        l10nId: "launcher-foot-back",
      },
    ];
  }
  const items = described
    ? described.foot
    : [
        { keys: ["↑↓"], l10nId: "launcher-foot-choose" },
        { keys: [keycap(ENTER)], l10nId: "launcher-foot-open" },
      ];
  return [
    ...items,
    { keys: [keycap("VK_ESCAPE")], l10nId: "launcher-foot-close", end: true },
  ];
}

/**
 * What a screen reader hears of a row's keys, which the foot, hidden from
 * it, shows: the keys in `aria-keyshortcuts`' form, and the row's
 * description, its address if it has one, then what each key does, in the
 * keys' order.
 *
 * @param {object|null} described {@link describeRow}'s answer.
 * @param {string[]} meanings The words of each of the row's keys, worded.
 * @returns {{keyshortcuts: string|null, description: string|null}}
 */
export function accessOf(described, meanings) {
  const keys = (described?.foot ?? []).filter(item => item.aria);
  const parts = [described?.address, ...meanings].filter(Boolean);
  return {
    keyshortcuts: keys.length ? keys.map(item => item.aria).join(" ") : null,
    description: parts.length
      ? new Intl.ListFormat(Services.locale.appLocalesAsBCP47, {
          type: "unit",
        }).format(parts)
      : null,
  };
}

/**
 * The l10n ids of the words of a row's own keys, in {@link accessOf}'s
 * order.
 *
 * @param {object|null} described
 * @returns {string[]}
 */
export function meaningIds(described) {
  return (described?.foot ?? [])
    .filter(item => item.aria)
    .map(item => item.l10nId);
}

// ------------------------------------------------------------ the view

/**
 * Draws one item of the foot, or a chip's or hint's key cap, into `parent`.
 *
 * @param {Element} parent
 * @param {object} item A {@link footFor} item.
 */
function appendFootItem(parent, item) {
  const doc = parent.ownerDocument;
  if (item.note) {
    const note = htmlElement(doc, "span", {
      className: "sval-launcher-foot-note",
    });
    doc.l10n.setAttributes(note, item.note);
    parent.append(note);
    return;
  }
  const part = htmlElement(doc, "span", {
    className: "sval-launcher-foot-item",
  });
  part.toggleAttribute("end", !!item.end);
  for (const keys of item.keys) {
    const cap = htmlElement(doc, "kbd", { className: "sval-keycap" });
    cap.textContent = keys;
    part.append(cap);
  }
  const label = htmlElement(doc, "span", {
    className: "sval-launcher-foot-label",
  });
  doc.l10n.setAttributes(label, item.l10nId);
  part.append(label);
  parent.append(part);
}

/**
 * Draws `items` as the line under the rows.
 *
 * @param {Element} line
 * @param {object[]} items
 */
export function drawFoot(line, items) {
  line.replaceChildren();
  for (const item of items) {
    appendFootItem(line, item);
  }
}

/**
 * The rows' parts drawn here, by row, with the result they were drawn for.
 *
 * @type {WeakMap<Element, {result: object, end: Element}>}
 */
const drawn = new WeakMap();

/**
 * The parts a row of the view shows at its end: its chip, mark and hint,
 * and how its option is named, for the row's result.
 *
 * @param {Element} item A `.urlbarView-row`.
 * @param {Window} win
 */
function drawRow(item, win) {
  const { result } = item;
  const inner = item._content;
  const known = drawn.get(item);
  if (known?.result === result && inner?.contains(known.end)) {
    return;
  }
  known?.end.remove();
  const doc = item.ownerDocument;
  const described = describeRow(result, win);
  item.toggleAttribute("sval-tab", !!result.payload.svalNodeId);
  for (const name of ["sval-kind", "sval-icon", "sval-swatch"]) {
    item.removeAttribute(name);
  }
  paintColor(item, null);
  if (result.type !== UrlbarUtils.RESULT_TYPE.DYNAMIC) {
    for (const name of [
      "aria-description",
      "aria-keyshortcuts",
      "aria-label",
      "data-l10n-id",
      "data-l10n-args",
    ]) {
      inner.removeAttribute(name);
    }
  }
  if (!described) {
    drawn.delete(item);
    return;
  }
  item.setAttribute("sval-kind", described.kind);
  if (described.icon) {
    item.setAttribute("sval-icon", described.icon);
  }
  if (described.swatch !== null) {
    item.setAttribute("sval-swatch", "");
    if (described.swatch) {
      paintColor(item, described.swatch);
    }
  }
  if (described.kind === "split-choice") {
    // The tab's favicon, found as its row in the panel finds it.
    win.SvalPanel?.fillTabIcon(
      item.querySelector(".urlbarView-favicon"),
      result.payload.choiceId,
      result.payload.choiceUrl
    );
  }

  const end = htmlElement(doc, "span", { className: "sval-launcher-end" });
  end.setAttribute("aria-hidden", "true");
  if (described.chip) {
    end.append(chipElement(doc, described.chip));
  }
  if (described.mark) {
    const mark = htmlElement(doc, "span", { className: "sval-mark" });
    mark.dataset.mark = described.mark;
    end.append(mark);
  }
  const hint = htmlElement(doc, "span", { className: "sval-launcher-hint" });
  const verb = htmlElement(doc, "span", {
    className: "sval-launcher-hint-verb",
  });
  doc.l10n.setAttributes(verb, described.hint.id, described.hint.args);
  const cap = htmlElement(doc, "kbd", { className: "sval-keycap" });
  cap.textContent = keycap(ENTER);
  hint.append(verb, cap);
  end.append(hint);
  inner.append(end);
  drawn.set(item, { result, end });

  if (result.type !== UrlbarUtils.RESULT_TYPE.DYNAMIC) {
    nameRow(item, result, described).catch(err =>
      lazy.SvalLog.error(`naming a row failed: ${lazy.describeError(err)}`)
    );
  }
}

/**
 * Names a row's option for a screen reader ({@link accessOf}): an open tab
 * with its workspace (launcher spec §7), and every row with the keys the
 * foot shows for it, once their words are in, if the row still shows the
 * same result. A command's row names its own key (`SvalLauncherCommands`).
 *
 * @param {Element} item
 * @param {UrlbarResult} result
 * @param {object} described
 */
async function nameRow(item, result, described) {
  const doc = item.ownerDocument;
  const ids = meaningIds(described);
  const meanings = ids.length
    ? await doc.l10n.formatValues(ids.map(id => ({ id })))
    : [];
  if (drawn.get(item)?.result !== result) {
    return;
  }
  const inner = item._content;
  const { keyshortcuts, description } = accessOf(described, meanings);
  if (keyshortcuts) {
    inner.setAttribute("aria-keyshortcuts", keyshortcuts);
  }
  if (described.name) {
    // Fluent writes the description too: it takes away an attribute it may
    // write that a translation leaves out (`L10nOverlays`).
    doc.l10n.setAttributes(inner, described.name.id, {
      ...described.name.args,
      description: description ?? "",
    });
  } else if (description) {
    inner.setAttribute("aria-description", description);
  }
}

/**
 * Gives `el` a Workspace's or group's colour as its fill, with its text
 * solved on it (`SvalColor.chipOf`) in the window's appearance, or takes it
 * away.
 *
 * @param {Element} el
 * @param {string|object|null} color A filtered colour.
 */
export function paintColor(el, color) {
  if (!color) {
    delete el.dataset.color;
    el.style.removeProperty("--sval-launcher-tint");
    el.style.removeProperty("--sval-launcher-ink");
    return;
  }
  const win = el.documentGlobal;
  const { fill, ink } = lazy.SvalColor.chipOf(color, {
    scheme: win.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    more: win.matchMedia("(prefers-contrast: more)").matches,
  });
  // A preset by its name, a custom colour as "custom": the stylesheet keys
  // on the attribute's presence, and its value says which colour it is.
  el.dataset.color = typeof color === "string" ? color : "custom";
  el.style.setProperty("--sval-launcher-tint", fill);
  el.style.setProperty("--sval-launcher-ink", ink);
}

/**
 * A workspace's or agent's chip: the workspace's mark, or a dot in its
 * colour, then its emoji (`SvalWorkspaceEntries.workspaceIcon`), and the
 * name.
 *
 * @param {Document} doc
 * @param {{name: string, color: string|null, mark?: string|null,
 *   emoji: string|null, agent: boolean}} chip
 * @returns {Element}
 */
export function chipElement(doc, chip) {
  const el = htmlElement(doc, "span", { className: "sval-chip" });
  if (chip.agent) {
    el.dataset.agent = "";
  } else if (chip.color) {
    paintColor(el, chip.color);
  }
  const name = htmlElement(doc, "span", { className: "sval-chip-name" });
  name.textContent = chip.name;
  const glyph = htmlElement(doc, "span", { className: "sval-chip-glyph" });
  if (chip.mark) {
    el.dataset.mark = "";
    glyph.style.setProperty("--sval-chip-mark", `url("${chip.mark}")`);
  }
  el.append(glyph);
  if (chip.emoji) {
    const emoji = htmlElement(doc, "span", { className: "sval-chip-emoji" });
    emoji.textContent = chip.emoji;
    el.append(emoji);
  }
  el.append(name);
  return el;
}

/**
 * Exposes each section as a group named by its heading: the row that shows
 * the heading is the group, and owns the options of the rows after it up to
 * the next heading. Rows before the first heading, the top area, are in no
 * group.
 *
 * @param {Element} rows The view's `.urlbarView-results`.
 */
function groupRows(rows) {
  let group = null;
  const close = () => {
    if (group) {
      group.row.setAttribute("aria-owns", group.owned.join(" "));
    }
  };
  for (const item of rows.children) {
    const visible =
      !item.hasAttribute("hidden") && item.style.display !== "none";
    const label = item._content?.querySelector(
      ":scope > .urlbarView-group-aria-label"
    );
    if (visible && label) {
      close();
      // Hidden, so the first option does not say the heading again.
      label.setAttribute("aria-hidden", "true");
      item.setAttribute("role", "group");
      nameGroup(item);
      group = { row: item, owned: [] };
      continue;
    }
    item.setAttribute("role", "presentation");
    item.removeAttribute("aria-label");
    item.removeAttribute("aria-owns");
    if (visible && group && item._content?.id) {
      group.owned.push(item._content.id);
    }
  }
  close();
}

/** The rows whose heading's words this module follows. */
const headed = new WeakSet();

/**
 * Names a section's group by its heading's words, which the view writes
 * into the row's `label` once they are translated (`UrlbarView`'s
 * `L10nCache`), maybe after the row is laid out. Gecko names nothing by an
 * `aria-labelledby` that points at the view's hidden `aria-label` span.
 *
 * @param {Element} item A row that is a group.
 */
function nameGroup(item) {
  const copy = () => {
    const words = item.getAttribute("label");
    if (
      item.getAttribute("role") === "group" &&
      words &&
      item.getAttribute("aria-label") !== words
    ) {
      item.setAttribute("aria-label", words);
    }
  };
  copy();
  if (!headed.has(item)) {
    headed.add(item);
    // Fluent, translating the row's heading, takes away an `aria-label` its
    // message does not hold (`L10nOverlays`), so the name is written again.
    new item.documentGlobal.MutationObserver(copy).observe(item, {
      attributes: true,
      attributeFilter: ["label", "aria-label"],
    });
  }
}

/**
 * The line under the view's rows, made after `.urlbarView-results`, outside
 * the part that scrolls.
 *
 * @param {Element} rows
 * @returns {Element}
 */
function footOf(rows) {
  let line = rows.parentNode.querySelector(":scope > .sval-launcher-foot");
  if (!line) {
    line = htmlElement(rows.ownerDocument, "div", {
      className: "sval-launcher-foot",
    });
    line.setAttribute("aria-hidden", "true");
    rows.after(line);
  }
  return line;
}

export const SvalLauncherRows = {
  /**
   * After the address bar's view lays out its rows
   * (`UrlbarView#updateIndices`): each row's parts and name, and the
   * sections' groups. Home's and the search bar's fields keep theirs.
   *
   * @param {object} input The view's `UrlbarInput`.
   * @param {Element} rows The view's `.urlbarView-results`.
   */
  updateRows(input, rows) {
    if (input.sapName !== "urlbar") {
      return;
    }
    for (const item of rows.children) {
      if (item.result) {
        drawRow(item, input.window);
      }
    }
    groupRows(rows);
    this.updateSelection(input, rows);
  },

  /**
   * After the selection moves in the address bar's view
   * (`UrlbarView#selectElement`): the line under the rows follows it, and
   * the selected row scrolls into the list's view, which scrolls when its
   * rows outgrow it (`sval-launcher-rows.css`).
   *
   * @param {object} input
   * @param {Element} rows
   */
  updateSelection(input, rows) {
    if (input.sapName !== "urlbar") {
      return;
    }
    const selected = rows.querySelector(
      ":scope > .urlbarView-row:is([selected], [descendant-selected])"
    );
    const described = selected?.result
      ? describeRow(selected.result, input.window)
      : null;
    drawFoot(
      footOf(rows),
      footFor(described, {
        choosing: !!lazy.SvalLauncherCommands.providersFor(input),
      })
    );
    selected?.scrollIntoView({ block: "nearest" });
  },
};
