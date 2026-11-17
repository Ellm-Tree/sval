/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The home page's field, which behaves as the address bar does.
 *
 * What it types is answered by the address bar's own engine, through Sval's
 * `SvalHomeSearch` actor (`SvalHomeSearchParent.sys.mjs`): the same heuristic
 * deciding between visiting an address and searching, the same history,
 * Favorites, open tabs, commands and engine suggestions in the same sections,
 * under the same settings, worded with the address bar's strings, and the
 * rows the address bar draws from other providers: the calculator, tips and
 * the search-mode offers "@" lists. It autofills as the address bar does, and
 * takes the address bar's keys: the arrows, Tab and Page Up and Down move
 * through the rows as `UrlbarController.handleKeyNavigation` moves, and
 * Shift+Delete removes a row. The actor opens what is picked, so the page
 * never builds an address itself. Firefox's `ContentSearch`
 * actor tells the page which engine this window searches with, for its icon.
 * The icon is a button that opens the engine menu, the address bar's
 * search-mode switcher's items, which the actor opens in the window.
 *
 * A command that picks ("Move this tab to…") lists its choices in the field
 * as the address bar does (`SvalLauncherCommands`): the command shows as a
 * chip at the field's start, and Back (the chip's button, Backspace in the
 * empty field, or Escape) goes to the first list, with the command's row
 * selected. Escape there closes the list. A search mode shows as a chip
 * too, which Backspace at the field's start, the chip's button, or Escape
 * with the list closed leaves, as the address bar's does.
 *
 * The field takes typing itself. Nothing here hands focus or text to the
 * address bar. It opens its list as the address bar opens its view: on a
 * click, and with nothing typed, on the query for an empty field, which the
 * address bar's providers answer with top sites (`UrlbarView.autoOpen`).
 */

const form = document.querySelector(".search");
const input = form.querySelector("input");
const engineButton = form.querySelector(".engine-button");
const icon = engineButton.querySelector(".engine");
const engineTitle = engineButton.querySelector(".engine-title");
const engineClose = engineButton.querySelector(".engine-close");
const submit = form.querySelector("button[type=submit]");
const list = form.querySelector(".suggestions");
const footLine = form.querySelector(".sval-launcher-foot");
const launcherKey = form.querySelector(".launcher-key");

const SEARCH_ICON = "chrome://global/skin/icons/search-glass.svg";
// How far Page Up and Page Down move (`UrlbarUtils.PAGE_UP_DOWN_DELTA`).
const PAGE_UP_DOWN_DELTA = 5;
const PAGE_ICON = "chrome://global/skin/icons/defaultFavicon.svg";

let isPrivate = false;
let iconURL = null;
let modifiers = {};
// What the user typed, which selecting a row replaces in the field and Escape
// puts back.
let typed = "";
// The address bar's placeholder, which a command's choices and a search
// mode replace while they show.
let placeholder = "";
// The command whose choices the list shows: `{ commandId, previous, chip }`,
// `previous` being what was typed before.
let choosing = null;
// The command whose row Back selects, `{ id, commandId }`, once the answers
// to query `id` hold it.
let reselect = null;
// A row of a command that picks, whose choices were asked for.
let asked = null;
// Enter pressed among the choices before the list for what is typed came.
let enterWaits = false;
// The id of the query whose answer the list waits for. A reply to any other,
// or one that arrives after Escape or a pick, is stale.
let queryId = 0;
let shownId = -1;
let shownList = -1;
let rows = [];
let selected = -1;
// The line under the list while no row is selected.
let idleFoot = [];
// Whether the arrows pass through no row at either end of the list, as the
// address bar's do when it has no heuristic (`UrlbarView.selectBy`).
let allowEmptySelection = true;
// Whether the Up and Down arrows move the caret before they open the list
// (`UrlbarController.keyEventMovesCaret`), and Ctrl+N and Ctrl+P move
// through it, by the platform.
let caretKeys = false;
let emacsKeys = false;
// The row menus' button's name.
let menuLabel = "";
// Whether the selection is on the selected row's menu button, as Tab puts it.
let onMenu = false;
// Whether the latest query asked for autofill, and the autofill the field
// shows for it, `{ value, selectionStart, selectionEnd }`.
let autofillAsked = false;
let autofilled = null;
// The row asked to be removed: `{ id, at }`, its query and place.
let dismissed = null;
// Whether the field was focused by a press on it, which lets Tab move
// through the rows before anything is typed.
let focusedViaMousedown = false;
// The search mode the field is in: `{ chip }`, its chip's element.
let searchMode = null;

function send(type, data = null) {
  window.dispatchEvent(
    new CustomEvent("ContentSearchClient", { detail: { type, data } })
  );
}

function ask(type, data = null) {
  window.dispatchEvent(
    new CustomEvent("SvalHomeSearch", { detail: { type, data } })
  );
}

/**
 * Shows `engine`'s icon as the one the field searches with, and asks for the
 * address bar's placeholder, which names it.
 *
 * `iconData` is a URL the page can load, or an `ArrayBuffer` and MIME type
 * when the engine's icon is a `data:` or `blob:` URL only the parent can read
 * (`ContentSearch._getEngineIconURL`).
 *
 * @param {object} engine `{ name, iconData }`.
 */
function showEngine(engine) {
  ask("Placeholder");

  if (iconURL) {
    URL.revokeObjectURL(iconURL);
    iconURL = null;
  }
  const data = engine.iconData;
  let src = "";
  if (typeof data === "string") {
    src = data;
  } else if (data?.icon) {
    iconURL = URL.createObjectURL(
      new Blob([data.icon], { type: data.mimeType })
    );
    src = iconURL;
  }
  // An engine with no icon shows the glass, as the address bar's switcher
  // does.
  defaultIcon = src || SEARCH_ICON;
  if (!searchMode) {
    icon.src = defaultIcon;
  }
  engineButton.hidden = false;
}

/** The default engine's icon, which the button shows outside a mode. */
let defaultIcon = SEARCH_ICON;
/** The object URL of a search mode's engine icon, revoked when it goes. */
let modeIconURL = null;

/**
 * Shows the search mode on the engine button, as the address bar's switcher
 * shows it (`SearchModeSwitcher.updateSearchIcon`): the mode's icon, its
 * name and a Close button; or, with no mode, the default engine's icon.
 *
 * @param {object|null} mode `{ icon, chip, exit }` as the actor sends it.
 */
function showModeOnButton(mode) {
  if (modeIconURL) {
    URL.revokeObjectURL(modeIconURL);
    modeIconURL = null;
  }
  form.classList.toggle("in-mode", !!mode);
  engineClose.hidden = !mode;
  if (!mode) {
    icon.src = defaultIcon;
    engineTitle.textContent = "";
    form.style.removeProperty("--engine-width");
    return;
  }
  let src = SEARCH_ICON;
  if (typeof mode.icon === "string") {
    src = mode.icon;
  } else if (mode.icon?.icon) {
    modeIconURL = URL.createObjectURL(
      new Blob([mode.icon.icon], { type: mode.icon.mimeType })
    );
    src = modeIconURL;
  }
  icon.src = src;
  engineTitle.textContent = mode.chip;
  engineClose.title = mode.exit;
  engineClose.setAttribute("aria-label", mode.exit);
  form.style.setProperty("--engine-width", `${engineButton.offsetWidth}px`);
}

// The Close button leaves the mode, as the address bar's does, and the
// field keeps the focus.
engineClose.addEventListener("mousedown", event => event.preventDefault());
engineClose.addEventListener("click", event => {
  event.stopPropagation();
  input.focus();
  exitSearchMode();
});

/**
 * Opens the engine list under its button (`SvalHomeSearchParent`), with what
 * the field holds, which an engine or a search mode picked there takes.
 *
 * @param {object} [options]
 * @param {boolean} [options.byKeyboard] Whether a key opened it, which
 *   puts focus on its first item.
 */
function openEngineMenu({ byKeyboard = false } = {}) {
  if (engineButton.hidden || form.classList.contains("choosing")) {
    return;
  }
  const box = engineButton.getBoundingClientRect();
  engineButton.setAttribute("aria-expanded", "true");
  ask("EngineMenu", {
    value: input.value,
    anchor: {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    },
    byKeyboard,
  });
}

engineButton.addEventListener("click", event =>
  // A click from Enter or Space on the button is the keyboard's.
  openEngineMenu({ byKeyboard: event.detail === 0 })
);
// Down on the button opens its menu, as on the address bar's switcher.
engineButton.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    openEngineMenu({ byKeyboard: true });
  }
});

window.addEventListener("ContentSearchService", event => {
  const { type, data } = event.detail;
  switch (type) {
    case "Engine":
      isPrivate = data.isPrivateEngine;
      document.documentElement.classList.toggle("private", isPrivate);
      showEngine(data.engine);
      break;
    case "CurrentEngine":
      if (!isPrivate) {
        showEngine(data);
      }
      break;
    case "CurrentPrivateEngine":
      if (isPrivate) {
        showEngine(data);
      }
      break;
  }
});

window.addEventListener("SvalHomeSearchService", event => {
  const { type, data } = event.detail;
  switch (type) {
    case "Placeholder":
      engineButton.title = data.engineLabel;
      engineButton.setAttribute("aria-label", data.engineLabel);
      placeholder = data.text;
      launcherKey.textContent = data.key;
      launcherKey.hidden = !data.key;
      if (!choosing && !searchMode) {
        showPlaceholder(placeholder);
      }
      break;
    case "Choose":
      showChoices(data);
      break;
    case "SearchMode":
      enterSearchMode(data);
      break;
    case "EngineMenuClosed":
      engineButton.setAttribute("aria-expanded", "false");
      // Focus goes back to the field, as the address bar's switcher hands
      // it back when its menu closes.
      if (document.activeElement === engineButton) {
        input.focus();
      }
      break;
    case "MenuClosed":
      list.querySelector(".menu-button[open]")?.removeAttribute("open");
      if (data.closeList) {
        queryId++;
        closeList();
      }
      break;
    case "Paste":
      insertPasted(data);
      break;
    case "Results":
      if (data.id === queryId && document.activeElement === input) {
        showResults(data);
      }
      break;
  }
});

function showPlaceholder(text, label = text) {
  input.placeholder = text;
  input.setAttribute("aria-label", label);
}

function hideList() {
  list.hidden = true;
  list.replaceChildren();
  rows = [];
  selected = -1;
  shownId = -1;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

/** Closes the list, and leaves a command's choices. */
function closeList() {
  hideList();
  leaveChoices();
}

/**
 * Appends `text` to `parent`, with the stretches `highlights` names in bold,
 * as the address bar's view draws a match (`addTextContentWithHighlights`).
 *
 * @param {Element} parent
 * @param {string} text
 * @param {Array<[number, number]>} highlights `[start, length]` pairs.
 */
function appendHighlighted(parent, text, highlights) {
  let at = 0;
  for (const [start, length] of highlights) {
    parent.append(text.slice(at, start));
    const strong = document.createElement("strong");
    strong.textContent = text.slice(start, start + length);
    parent.append(strong);
    at = start + length;
  }
  parent.append(text.slice(at));
}

/**
 * One row, drawn from what the actor sends for it: the address bar's title,
 * address and action, an open tab's name with its workspace, a pin's or
 * Favorite's mark, a choice's "Current" tag and a command's key.
 *
 * @param {object} row
 * @param {number} i
 * @returns {Element}
 */
function rowElement(row, i) {
  const option = document.createElement("li");
  option.id = `result-${i}`;
  option.className = "result";
  option.dataset.kind = row.kind;
  if (row.nodeId) {
    option.dataset.nodeId = row.nodeId;
  }
  if (row.commandId) {
    option.dataset.commandId = row.commandId;
  }
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", "false");
  if (row.current) {
    option.setAttribute("aria-disabled", "true");
  }
  if (row.name) {
    // Its name with its workspace (launcher spec §7).
    option.setAttribute("aria-label", row.name);
  }
  // An open tab's address, then what the row's keys do, which the line
  // under the list shows and hides from a screen reader.
  if (row.description) {
    option.setAttribute("aria-description", row.description);
  }
  if (row.glyph) {
    option.dataset.glyph = row.glyph;
  }
  if (row.swatch) {
    option.dataset.swatch = "";
    paintColor(option, row.swatchTint);
  }
  const keyshortcuts = row.ariaShortcut ?? row.keyshortcuts;
  if (keyshortcuts) {
    option.setAttribute("aria-keyshortcuts", keyshortcuts);
  }

  const image = document.createElement("img");
  image.className = "icon";
  image.alt = "";
  if (row.kind !== "command") {
    if (row.image) {
      image.src = row.image;
    } else {
      image.src = row.icon ? `page-icon:${row.icon}` : SEARCH_ICON;
    }
    image.addEventListener("error", () => (image.src = PAGE_ICON), {
      once: true,
    });
  }

  const title = document.createElement("span");
  title.className = "title";
  appendHighlighted(title, row.title, row.titleHighlights);

  option.append(image, title);
  if (row.url && !row.heuristic) {
    const url = document.createElement("span");
    url.className = "url";
    appendHighlighted(url, row.url, row.urlHighlights);
    option.append(url);
  }
  if (row.action) {
    const action = document.createElement("span");
    action.className = "action";
    action.textContent = row.action;
    option.append(action);
  }
  // The row's own parts at its end, in the order the address bar's rows
  // show them (`SvalLauncherRows`): a workspace's or agent's chip, a pin's
  // or Favorite's mark, a choice's tag, a command's key and, while the row
  // is selected, what Enter does.
  const end = document.createElement("span");
  end.className = "end";
  if (row.chip) {
    end.append(chipElement(row.chip));
  }
  if (row.mark) {
    const mark = document.createElement("span");
    mark.className = "sval-mark";
    mark.dataset.mark = row.mark;
    mark.setAttribute("aria-hidden", "true");
    end.append(mark);
  }
  if (row.tag) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = row.tag;
    end.append(tag);
  }
  if (row.shortcut) {
    // Read from `aria-keyshortcuts`, so a screen reader does not hear the
    // glyphs.
    const key = document.createElement("kbd");
    key.className = "key";
    key.textContent = row.shortcut;
    key.setAttribute("aria-hidden", "true");
    end.append(key);
  }
  if (row.button) {
    // A tip's button, which Enter and a click on the row take.
    const button = document.createElement("span");
    button.className = "tip-button";
    button.textContent = row.button;
    end.append(button);
  }
  if (row.hint) {
    const hint = document.createElement("span");
    hint.className = "sval-launcher-hint";
    hint.setAttribute("aria-hidden", "true");
    const verb = document.createElement("span");
    verb.textContent = row.hint;
    hint.append(verb, keycap(row.enterKey));
    end.append(hint);
  }
  // Its menu, last in the row, as the address bar's view places it.
  if (row.menu) {
    const menu = document.createElement("span");
    menu.className = "menu-button";
    menu.setAttribute("role", "button");
    menu.setAttribute("aria-label", menuLabel);
    menu.title = menuLabel;
    end.append(menu);
  }
  option.append(end);
  return option;
}

/**
 * A key cap.
 *
 * @param {string} text
 * @returns {Element}
 */
function keycap(text) {
  const cap = document.createElement("kbd");
  cap.className = "sval-keycap";
  cap.textContent = text;
  return cap;
}

/**
 * Gives `el` a Workspace's colour as its fill with its ink on it, as
 * `SvalLauncherRows.paintColor` does in the address bar, in whichever
 * scheme the page is in.
 *
 * @param {Element} el
 * @param {{name: string, light: object, dark: object}|null} tint As
 *   `SvalHomeSearchParent` solves one; null for no colour.
 */
function paintColor(el, tint) {
  if (!tint) {
    return;
  }
  el.dataset.color = tint.name;
  el.style.setProperty(
    "--sval-launcher-tint",
    `light-dark(${tint.light.fill}, ${tint.dark.fill})`
  );
  el.style.setProperty(
    "--sval-launcher-ink",
    `light-dark(${tint.light.ink}, ${tint.dark.ink})`
  );
}

/**
 * A tab's workspace or agent, as a chip: a dot in the workspace's colour, or
 * the agent's glyph, the workspace's emoji, and its name.
 *
 * @param {{name: string, tint: object|null, emoji: string|null,
 *   agent: boolean}} chip `tint` as {@link paintColor} takes it.
 * @returns {Element}
 */
function chipElement(chip) {
  const el = document.createElement("span");
  el.className = "sval-chip";
  el.setAttribute("aria-hidden", "true");
  if (chip.agent) {
    el.dataset.agent = "";
  } else {
    paintColor(el, chip.tint);
  }
  const glyph = document.createElement("span");
  glyph.className = "sval-chip-glyph";
  el.append(glyph);
  if (chip.emoji) {
    const emoji = document.createElement("span");
    emoji.className = "sval-chip-emoji";
    emoji.textContent = chip.emoji;
    el.append(emoji);
  }
  const name = document.createElement("span");
  name.className = "sval-chip-name";
  name.textContent = chip.name;
  el.append(name);
  return el;
}

/**
 * Draws the line under the list: each item's key and what it does, or a
 * note, and Escape's at the end.
 *
 * @param {object[]} items `[{ keys, text, note, end }]`, `keys` the item's
 *   caps.
 */
function drawFoot(items) {
  footLine.replaceChildren();
  for (const item of items) {
    if (item.note) {
      const note = document.createElement("span");
      note.className = "sval-launcher-foot-note";
      note.textContent = item.text;
      footLine.append(note);
      continue;
    }
    const part = document.createElement("span");
    part.className = "sval-launcher-foot-item";
    part.toggleAttribute("end", item.end);
    const label = document.createElement("span");
    label.textContent = item.text;
    part.append(...item.keys.map(keycap), label);
    footLine.append(part);
  }
}

/**
 * Lists a query's rows under the field, grouped under the address bar's
 * labels, with its heuristic selected as the address bar selects it, or in
 * a command's choices the first that can be chosen.
 *
 * @param {object} data `{ id, list, searchString, rows }`.
 */
function showResults(data) {
  // A further answer to the same query keeps the row the user is on, found
  // again by what it stands for, since answers arriving reorder the rows. Any
  // other answer takes back the text of a row from the list it replaces.
  const kept =
    shownId === data.id && selected >= 0 && !rows[selected].heuristic
      ? identity(rows[selected])
      : null;
  const keep =
    kept === null ? -1 : data.rows.findIndex(r => identity(r) === kept);
  if (keep < 0 && selected >= 0 && !rows[selected]?.heuristic) {
    input.value = typed;
  }
  list.replaceChildren();
  rows = data.rows;
  idleFoot = data.idleFoot ?? [];
  allowEmptySelection = data.allowEmptySelection !== false;
  caretKeys = !!data.caretKeys;
  emacsKeys = !!data.emacsKeys;
  menuLabel = data.menuLabel ?? "";
  // A row removed from this query's list leaves the selection where it was,
  // as the address bar's view keeps it (`UrlbarView.onQueryResultRemoved`).
  const removedAt = dismissed?.id === data.id ? dismissed.at : -1;
  dismissed = null;
  const sameQuery = shownId === data.id;
  shownId = data.id;
  shownList = data.list;
  selected = -1;
  onMenu = false;
  if (reselect?.id !== data.id) {
    reselect = null;
  }
  if (!rows.length) {
    // Choices that match nothing leave the chip, so typing can go on.
    if (choosing) {
      hideList();
      shownId = data.id;
    } else {
      closeList();
    }
    enterWaits = false;
    return;
  }
  // A heading shows where the section changes, as the address bar's view
  // keeps the last one shown across rows with none (`#updateRowLabel`).
  // Each section is a group named by its heading, which a screen reader
  // says on entering it (launcher spec §7); the rows before the first
  // heading are in none.
  let label = null;
  let into = list;
  rows.forEach((row, i) => {
    if (row.label && row.label !== label) {
      const section = document.createElement("li");
      section.className = "section";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", row.label);
      const heading = document.createElement("span");
      heading.className = "group";
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = row.label;
      into = document.createElement("ul");
      into.className = "section-rows";
      into.setAttribute("role", "none");
      section.append(heading, into);
      list.append(section);
      label = row.label;
    }
    into.append(rowElement(row, i));
  });
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");

  let initial = rows[0].heuristic ? 0 : -1;
  if (choosing) {
    initial = next(-1, 1);
  } else if (reselect) {
    const at = rows.findIndex(
      r => r.kind === "command" && r.commandId === reselect.commandId
    );
    if (at >= 0) {
      initial = at;
      reselect = null;
    }
  }
  if (keep >= 0) {
    initial = keep;
  } else if (removedAt >= 0) {
    initial = Math.min(removedAt, rows.length - 1);
  }
  if (!sameQuery || !autofilled) {
    autofill(rows[0]);
  }
  select(initial, { fill: false });
  if (enterWaits) {
    enterWaits = false;
    if (selected >= 0) {
      pick(selected);
    }
  }
}

/**
 * Completes what was typed with the heuristic's autofill, selected after the
 * typed text, as the address bar does with its first result
 * (`UrlbarInput._autofillFirstResult`): only when the query asked for it and
 * the field still holds what was typed, with the caret at its end.
 *
 * @param {object|undefined} first The list's first row.
 */
function autofill(first) {
  if (
    !autofillAsked ||
    !first?.heuristic ||
    !first.autofill ||
    input.value !== typed ||
    input.selectionStart !== input.selectionEnd ||
    input.selectionEnd !== typed.length ||
    !first.autofill.value
      .toLocaleLowerCase()
      .startsWith(typed.toLocaleLowerCase())
  ) {
    return;
  }
  autofilled = first.autofill;
  showAutofill();
}

/** Writes the autofill into the field, its completion selected. */
function showAutofill() {
  input.value = autofilled.value;
  input.setSelectionRange(autofilled.selectionStart, autofilled.selectionEnd);
}

/**
 * What a row stands for, across the lists of one query: a command's row
 * fills in what was typed, as every row of its command does.
 *
 * @param {object} row
 * @returns {string}
 */
function identity(row) {
  if (row.kind === "command") {
    return `command:${row.commandId}:${row.title}`;
  }
  if (row.kind === "tip" || row.kind === "dynamic") {
    return `${row.kind}:${row.title}`;
  }
  return row.nodeId ? `tab:${row.nodeId}` : `fill:${row.fill}`;
}

/**
 * The row the arrows move to from `from`, past rows that cannot be chosen,
 * and through none, -1, at either end.
 *
 * @param {number} from
 * @param {number} by 1 down, -1 up.
 * @returns {number}
 */
function next(from, by) {
  const count = rows.length;
  let at = from;
  for (let n = 0; n <= count; n++) {
    if (by > 0) {
      at = at + 1 < count ? at + 1 : -1;
    } else {
      at = at < 0 ? count - 1 : at - 1;
    }
    if (at < 0 || !rows[at].current) {
      return at;
    }
  }
  return -1;
}

function options() {
  return [...list.querySelectorAll("[role=option]")];
}

/**
 * Moves the selection to row `index`, or to none at -1, and shows the row's
 * text in the field as the address bar does: a suggestion's words, a page's
 * address, or what was typed for the heuristic.
 *
 * @param {number} index
 * @param {object} [options]
 * @param {boolean} [options.fill] Whether the field takes the row's text.
 * @param {boolean} [options.menu] Whether the selection is on the row's
 *   menu button, as Tab puts it there.
 */
function select(index, { fill = true, menu = false } = {}) {
  const all = options();
  all[selected]?.setAttribute("aria-selected", "false");
  all[selected]?.querySelector(".menu-button")?.removeAttribute("selected");
  selected = index;
  const option = all[index];
  onMenu = menu && !!option?.querySelector(".menu-button");
  if (option) {
    option.setAttribute("aria-selected", "true");
    option.querySelector(".menu-button")?.toggleAttribute("selected", onMenu);
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
  drawFoot(rows[index]?.foot ?? idleFoot);
  if (fill) {
    if (rows[index]?.heuristic && autofilled) {
      showAutofill();
    } else {
      input.value = rows[index] ? rows[index].fill : typed;
    }
  }
}

/**
 * Moves the selection as the address bar's view does (`UrlbarView.selectBy`):
 * from none to the first row, or the last going up; at the end, to none
 * where the list has no heuristic, else round to the other end; otherwise by
 * `amount` rows, stopping at the end. Tab moves through each row's menu
 * button too, as through the view's selectable elements.
 *
 * @param {number} amount
 * @param {object} [options]
 * @param {boolean} [options.reverse]
 * @param {boolean} [options.tab]
 */
function selectBy(amount, { reverse = false, tab = false } = {}) {
  const choosable = rows
    .map((row, i) => (row.current ? -1 : i))
    .filter(i => i >= 0);
  if (!choosable.length) {
    return;
  }
  const first = choosable[0];
  const last = choosable.at(-1);
  const hasMenu = i => tab && !!rows[i]?.menu;
  if (selected < 0) {
    if (reverse) {
      select(last, { menu: hasMenu(last) });
    } else {
      select(first);
    }
    return;
  }
  const atEnd = reverse
    ? selected === first && !onMenu
    : selected === last && (onMenu || !hasMenu(last));
  if (atEnd) {
    if (allowEmptySelection) {
      select(-1);
    } else if (reverse) {
      select(last, { menu: hasMenu(last) });
    } else {
      select(first);
    }
    return;
  }
  if (tab) {
    if (!reverse && !onMenu && hasMenu(selected)) {
      select(selected, { fill: false, menu: true });
      return;
    }
    if (reverse && onMenu) {
      select(selected, { fill: false });
      return;
    }
  }
  let at = choosable.indexOf(selected);
  at = Math.max(
    0,
    Math.min(choosable.length - 1, at + (reverse ? -amount : amount))
  );
  const to = choosable[at];
  select(to, { menu: reverse && hasMenu(to) });
}

/**
 * Opens what the field holds: the selected row of the list on screen, or,
 * when the list is not the answer to what the field holds, that text's
 * heuristic, which the actor works out as the address bar would.
 *
 * @param {number} index The row picked, or -1.
 */
function pick(index) {
  const row = shownId === queryId && rows[index];
  if (row?.current) {
    return;
  }
  if (row?.picks) {
    askChoices(row);
    return;
  }
  ask("Pick", {
    id: row ? shownId : -1,
    list: shownList,
    index: row ? row.index : -1,
    modifiers,
  });
  modifiers = {};
  queryId++;
  closeList();
}

/**
 * Asks for the choices of the command that picks whose row is `row`; the
 * list stays open, and shows them once the actor has them (`showChoices`).
 *
 * @param {object} row
 */
function askChoices(row) {
  asked = { commandId: row.commandId, title: row.title, previous: typed };
  ask("Choose", { id: shownId, list: shownList, index: row.index });
  modifiers = {};
  queryId++;
}

/**
 * Shows the asked-for command's choices: the field empties, the command is a
 * chip at its start with a Back button, and the field asks for a choice. A
 * command that no longer applies closes the list.
 *
 * @param {object|null} answer `{ placeholder, back }`, or null.
 */
function showChoices(answer) {
  const row = asked;
  asked = null;
  if (!answer) {
    if (row) {
      closeList();
    }
    return;
  }
  if (!row || document.activeElement !== input) {
    // The user typed on, or the list closed, while the choices were on
    // their way.
    ask("StopChoosing");
    return;
  }
  leaveChoices();
  exitSearchMode({ requery: false });
  const chip = chipAtStart(row.title, answer.back, goBack);
  choosing = { commandId: row.commandId, previous: row.previous, chip };
  showPlaceholder(answer.placeholder);
  input.value = "";
  query();
}

/**
 * A chip at the field's start, for a command's choices or a search mode,
 * with a Back button that runs `back`.
 *
 * @param {string} text
 * @param {string} backLabel
 * @param {Function} back
 * @returns {Element}
 */
function chipAtStart(text, backLabel, back) {
  const chip = document.createElement("span");
  chip.className = "chip";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip-back";
  button.tabIndex = -1;
  button.setAttribute("aria-label", backLabel);
  button.title = backLabel;
  // The field keeps the focus, so typing goes on filtering.
  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", () => back());
  button.append(backArrow());
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = text;
  chip.append(button, label);
  input.before(chip);
  form.classList.add("choosing");
  form.style.setProperty("--chip-width", `${chip.offsetWidth}px`);
  return chip;
}

/**
 * Shows the search mode the actor entered: on the engine button, as the
 * address bar shows it, with its placeholder and what the field holds in
 * it, then asks for its rows.
 *
 * @param {object} mode `{ icon, chip, exit, placeholder, label, back,
 *   value }`.
 */
function enterSearchMode(mode) {
  leaveChoices();
  searchMode = { label: mode.chip };
  showModeOnButton(mode);
  showPlaceholder(mode.placeholder, mode.label);
  input.value = mode.value;
  // A mode picked in the engine menu comes while focus is on its button.
  input.focus();
  query();
}

/**
 * Leaves the search mode, as Backspace at the field's start does in the
 * address bar, and asks again for what the field holds.
 *
 * @param {object} [options]
 * @param {boolean} [options.requery]
 */
function exitSearchMode({ requery = true } = {}) {
  if (!searchMode) {
    return;
  }
  searchMode = null;
  showModeOnButton(null);
  ask("ExitSearchMode");
  showPlaceholder(placeholder);
  if (requery) {
    query();
  }
}

/** @returns {Element} The Back button's arrow, as the Favorites panel's. */
function backArrow() {
  const SVG = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of ["m12 19-7-7 7-7", "M19 12H5"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Leaves a command's choices, if the list shows them. */
function leaveChoices() {
  if (!choosing) {
    return;
  }
  choosing.chip.remove();
  form.classList.remove("choosing");
  choosing = null;
  enterWaits = false;
  showPlaceholder(placeholder);
  ask("StopChoosing");
}

/**
 * Back: the first list again, with what was typed before and the command's
 * row selected.
 */
function goBack() {
  const state = choosing;
  if (!state) {
    return;
  }
  leaveChoices();
  input.value = state.previous;
  query();
  reselect = { id: queryId, commandId: state.commandId };
}

// Pasted and dropped text is cleaned as the address bar cleans it, which
// strips `javascript:`, before it reaches the field. A paste after other
// text keeps its own text, as in the address bar.
let pasteAround = null;
input.addEventListener("paste", event => {
  const text = event.clipboardData.getData("text/plain");
  const before = input.value.slice(0, input.selectionStart);
  if (!text || before.trim()) {
    return;
  }
  event.preventDefault();
  pasteAround = [before, input.value.slice(input.selectionEnd)];
  ask("Paste", text);
});
input.addEventListener("drop", event => {
  const text = event.dataTransfer.getData("text/plain");
  if (!text) {
    return;
  }
  event.preventDefault();
  input.focus();
  pasteAround = ["", ""];
  ask("Paste", text);
});

function insertPasted(text) {
  if (!pasteAround) {
    return;
  }
  const [before, after] = pasteAround;
  pasteAround = null;
  input.value = before + text + after;
  const caret = before.length + text.length;
  input.setSelectionRange(caret, caret);
  query({ pasted: true });
}

/**
 * Asks for the rows for what the field holds. An empty field asks too, as
 * the address bar does, and a query with no rows closes the list.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowAutofill] Whether the answer may complete
 *   what was typed.
 * @param {boolean} [options.pasted] Whether the text was pasted or dropped.
 */
function query({ allowAutofill = false, pasted = false } = {}) {
  if (asked) {
    // Typed on before the choices came: the first list goes on.
    asked = null;
    ask("StopChoosing");
  }
  typed = input.value;
  autofillAsked = allowAutofill;
  autofilled = null;
  queryId++;
  ask("Query", { id: queryId, searchString: typed, allowAutofill, pasted });
}

// Typing autofills; deleting, undoing and an input method still composing do
// not (`UrlbarInput#_on_input`).
input.addEventListener("input", event => {
  const type = event.inputType ?? "";
  query({
    allowAutofill:
      !event.isComposing &&
      !type.startsWith("delete") &&
      !type.startsWith("history") &&
      type !== "insertFromPaste" &&
      type !== "insertFromDrop",
    pasted: type === "insertFromPaste" || type === "insertFromDrop",
  });
});

/**
 * Whether an Up or Down arrow moves the caret in the field before it opens
 * the list (`UrlbarController.keyEventMovesCaret`).
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function movesCaret(event) {
  if (!caretKeys || !["ArrowUp", "ArrowDown"].includes(event.key)) {
    return false;
  }
  const { selectionStart: start, selectionEnd: end } = input;
  return (
    end !== start ||
    (event.key === "ArrowUp" && start > 0) ||
    (event.key === "ArrowDown" && end < input.value.length)
  );
}

// The address bar's keys (`UrlbarController.handleKeyNavigation`). A
// composing input method keeps its keys.
input.addEventListener("keydown", event => {
  if (event.isComposing) {
    return;
  }
  // Alt+Up and Alt+Down open the engine menu, as in the address bar
  // (`SearchModeSwitcher.handleKeyDown`).
  if (
    event.altKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !engineButton.hidden &&
    !form.classList.contains("choosing")
  ) {
    event.preventDefault();
    engineButton.focus();
    openEngineMenu({ byKeyboard: true });
    return;
  }
  if (
    choosing &&
    (event.key === "Escape" || (event.key === "Backspace" && !input.value))
  ) {
    event.preventDefault();
    goBack();
    return;
  }
  const open = !list.hidden;
  if (
    searchMode &&
    event.key === "Backspace" &&
    !event.shiftKey &&
    input.selectionStart === 0 &&
    input.selectionEnd === 0
  ) {
    exitSearchMode();
    return;
  }
  if (
    open &&
    event.shiftKey &&
    (event.key === "Delete" || event.key === "Backspace")
  ) {
    if (dismiss()) {
      event.preventDefault();
    }
    return;
  }
  if (
    open &&
    emacsKeys &&
    event.ctrlKey &&
    (event.key === "n" || event.key === "p")
  ) {
    selectBy(1, { reverse: event.key === "p" });
    event.preventDefault();
    return;
  }
  switch (event.key) {
    case "Escape":
      if (open) {
        queryId++;
        input.value = typed;
        closeList();
      } else if (searchMode) {
        input.value = "";
        exitSearchMode({ requery: false });
      } else {
        return;
      }
      break;
    case " ":
      if (!onMenu) {
        return;
      }
      openMenu(selected);
      break;
    case "Tab":
      if (
        !open ||
        !rows.length ||
        event.ctrlKey ||
        event.altKey ||
        !(focusedViaMousedown || searchMode || selected >= 0 || input.value)
      ) {
        return;
      }
      selectBy(1, { reverse: event.shiftKey, tab: true });
      break;
    case "PageDown":
    case "PageUp":
    case "ArrowDown":
    case "ArrowUp": {
      const page = event.key.startsWith("Page");
      if ((page && event.ctrlKey) || event.altKey || event.metaKey) {
        return;
      }
      // Shift and an arrow select text in the field.
      if (!page && event.shiftKey) {
        return;
      }
      if (open) {
        selectBy(page ? PAGE_UP_DOWN_DELTA : 1, {
          reverse: event.key.endsWith("Up"),
        });
      } else {
        if (movesCaret(event)) {
          return;
        }
        query();
      }
      break;
    }
    default:
      return;
  }
  event.preventDefault();
});

/**
 * Asks to remove the selected row, as Shift+Delete does in the address bar
 * (`UrlbarController#dismissSelectedResult`): not while the selection is on
 * its menu button, nor the heuristic unless it autofilled.
 *
 * @returns {boolean} Whether the key was taken.
 */
function dismiss() {
  const row = rows[selected];
  if (!row || onMenu || (row.heuristic && !row.autofill)) {
    return false;
  }
  dismissed = { id: shownId, at: selected };
  ask("Dismiss", { id: shownId, list: shownList, index: row.index });
  return true;
}

/**
 * Opens row `index`'s menu under its button (`SvalHomeSearchParent`).
 *
 * @param {number} index
 */
function openMenu(index) {
  const button = options()[index]?.querySelector(".menu-button");
  if (!button || !rows[index]) {
    return;
  }
  button.setAttribute("open", "");
  const box = button.getBoundingClientRect();
  ask("Menu", {
    id: shownId,
    list: shownList,
    index: rows[index].index,
    anchor: { left: box.left, bottom: box.bottom },
  });
}

input.addEventListener("blur", () => {
  focusedViaMousedown = false;
  closeList();
});

// A press on the field opens the list when it is closed, as a press on the
// address bar opens its view (`UrlbarInput._on_mousedown`). Focus alone does
// not, so the field the page focuses on load keeps the page clear.
input.addEventListener("mousedown", event => {
  if (event.button !== 0) {
    return;
  }
  focusedViaMousedown ||= document.activeElement !== input;
  if (list.hidden) {
    query();
  }
});

// A press on the list would take the focus from the field and close the list
// before the click lands.
list.addEventListener("mousedown", event => event.preventDefault());

function pickFromList(event) {
  const option = event.target.closest("[role=option]");
  if (!option || (event.type === "auxclick" && event.button !== 1)) {
    return;
  }
  if (event.target.closest(".menu-button")) {
    if (event.type === "click") {
      openMenu(options().indexOf(option));
    }
    return;
  }
  modifiers = { ...pickModifiers(event), button: event.button };
  pick(options().indexOf(option));
}
list.addEventListener("click", pickFromList);
list.addEventListener("auxclick", pickFromList);

function pickModifiers(event) {
  return {
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    altGraph: event.getModifierState("AltGraph"),
  };
}

// The modifiers decide where the page opens (`UrlbarInput._whereToOpen`
// in the parent). Enter in the field submits through a synthetic click on the
// button, whose `detail` is 0, so only a real click replaces what the key
// press recorded.
input.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    modifiers = pickModifiers(event);
  }
});
submit.addEventListener("click", event => {
  if (event.detail > 0) {
    modifiers = { ...pickModifiers(event), button: event.button };
  }
});

// Among a command's choices, Enter picks once the list for what is typed is
// in: the row selected then, or the first that can be chosen. Picked
// earlier, the row would be a choice of an older list, or the text's search.
form.addEventListener("submit", event => {
  event.preventDefault();
  if (asked) {
    return;
  }
  if (choosing) {
    if (shownId !== queryId) {
      enterWaits = true;
    } else if (selected >= 0) {
      pick(selected);
    }
    return;
  }
  if (onMenu) {
    openMenu(selected);
    return;
  }
  if (!input.value.trim() && !(selected >= 0 && rows[selected])) {
    modifiers = {};
    return;
  }
  pick(selected);
});

send("GetEngine");

// A deferred script runs once the page is parsed, which can be before its
// stylesheet has loaded (`ScriptLoader` holds back only parser-blocking
// scripts for style sheets). Focusing lays the page out, so it waits for the
// page's load, which waits for the sheet: laid out early, the page draws
// unstyled and Gecko warns of it.
if (document.readyState === "complete") {
  input.focus();
} else {
  window.addEventListener("load", () => input.focus(), { once: true });
}
