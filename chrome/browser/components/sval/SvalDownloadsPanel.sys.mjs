/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Downloads panel's workspace views (`SvalDownloadWorkspaces`): the
 * switch between "This Workspace" and "All Workspaces" at the top of the
 * list, the rows each view lists, the workspace each row is from under All
 * workspaces, the two empty states, and the controls that take rows off the
 * list: each row's remove button and the footer's Clear list. Firefox's `DownloadsView` keeps
 * every download of the session, newest first, and calls in here to show
 * the ones its window's view lists.
 */

import {
  listAll,
  labelOf,
  listed,
  listsAll,
} from "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const STYLESHEET = "chrome://browser/content/sval/sval-downloads.css";

const VIEWS = Object.freeze([
  { all: false, label: "This Workspace" },
  { all: true, label: "All Workspaces" },
]);

/**
 * The view switch, a radio group: arrow keys move between its two segments
 * and choose as they move, and Tab moves on into the list.
 *
 * @param {Window} win
 * @returns {Element}
 */
function viewSwitch(win) {
  const doc = win.document;
  const group = htmlElement(doc, "div", {
    id: "sval-downloads-views",
    attrs: { role: "radiogroup", "aria-label": "Show downloads from" },
  });
  for (const view of VIEWS) {
    const button = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-downloads-view",
        attrs: { role: "radio" },
        dataset: { all: String(view.all) },
      },
      view.label
    );
    button.addEventListener("click", () => listAll(win, view.all));
    group.append(button);
  }
  group.addEventListener("keydown", event => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const all = !listsAll(win);
    listAll(win, all);
    group.querySelector(`[data-all="${all}"]`)?.focus();
  });
  return group;
}

/**
 * The empty states: nothing in this workspace while others have downloads,
 * with a way to list them, and nothing anywhere.
 *
 * @param {Window} win
 * @returns {Element}
 */
function emptyState(win) {
  const doc = win.document;
  const show = htmlElement(
    doc,
    "button",
    { type: "button", className: "sval-downloads-empty-show" },
    "Show all Workspaces"
  );
  show.addEventListener("click", () => {
    listAll(win, true);
    doc.querySelector('#sval-downloads-views [data-all="true"]')?.focus();
  });
  return htmlElement(
    doc,
    "div",
    { id: "sval-downloads-empty", attrs: { role: "status" } },
    htmlElement(doc, "span", { className: "sval-downloads-empty-icon" }),
    htmlElement(doc, "span", { className: "sval-downloads-empty-title" }),
    htmlElement(doc, "span", { className: "sval-downloads-empty-body" }),
    show
  );
}

/**
 * The footer's Clear list, which takes the stopped downloads the view lists
 * off the list, by the rule of Firefox's `downloadsCmd_clearList`
 * (`DownloadList.removeFinished`), and leaves other views' downloads alone.
 *
 * @param {Window} win
 * @returns {Element}
 */
function clearButton(win) {
  const button = win.document.createXULElement("button");
  button.id = "sval-downloads-clear";
  button.className =
    "downloadsPanelFooterButton subviewbutton panel-subview-footer-button toolbarbutton-1";
  button.setAttribute("label", "Clear list");
  button.setAttribute("flex", "1");
  button.setAttribute("pack", "start");
  button.addEventListener("command", async () => {
    const list = await lazy.Downloads.getList(
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
        ? lazy.Downloads.PRIVATE
        : lazy.Downloads.PUBLIC
    );
    list.removeFinished(download => listed(win, download));
  });
  return button;
}

/**
 * Adds the workspace views to `win`'s panel, once, when Firefox first sets
 * the panel up (`DownloadsPanel.initialize`).
 *
 * @param {Window} win
 */
export function mount(win) {
  const doc = win.document;
  if (doc.getElementById("sval-downloads-views")) {
    return;
  }
  win.windowUtils.loadSheetUsingURIString(
    STYLESHEET,
    win.windowUtils.AUTHOR_SHEET
  );
  const list = doc.getElementById("downloadsListBox");
  // A private window is a session of its own, and lists its own downloads
  // alone, so it has no other view.
  if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    list.before(viewSwitch(win));
  }
  list.after(emptyState(win));
  doc.getElementById("downloadsHistory").after(clearButton(win));
  draw(win, 0, 0);
}

/**
 * @param {Window} win
 * @param {object[]} downloads Every download of the session.
 * @returns {number} How many `win`'s panel lists.
 */
export function listedCount(win, downloads) {
  return downloads.filter(download => listed(win, download)).length;
}

/**
 * Shows the switch's choice and the empty state that fits.
 *
 * @param {Window} win
 * @param {number} shown How many downloads the view lists.
 * @param {number} total How many the session has.
 */
function draw(win, shown, total) {
  const doc = win.document;
  const all = listsAll(win);
  for (const button of doc.querySelectorAll(".sval-downloads-view")) {
    const on = button.dataset.all === String(all);
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
  }
  const empty = doc.getElementById("sval-downloads-empty");
  if (!empty) {
    return;
  }
  doc.getElementById("sval-downloads-clear").hidden = !shown;
  const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const elsewhere = !isPrivate && !shown && total > 0 && !all;
  empty.hidden = shown > 0;
  empty.toggleAttribute("elsewhere", elsewhere);
  empty.querySelector(".sval-downloads-empty-title").textContent = elsewhere
    ? "No downloads in this Workspace"
    : "No downloads yet";
  let body = "Files you download in any Workspace will appear here.";
  if (isPrivate) {
    body = "Files you download in this window will appear here.";
  } else if (elsewhere) {
    body =
      "Files downloaded in your other Workspaces are listed under All Workspaces.";
  }
  empty.querySelector(".sval-downloads-empty-body").textContent = body;
  empty.querySelector(".sval-downloads-empty-show").hidden = !elsewhere;
}

/**
 * Shows in `view` (`DownloadsView`) the newest of its downloads `win`'s
 * panel lists, up to its limit, in order, and updates its count.
 *
 * @param {Window} win
 * @param {object} view
 */
export function relist(win, view) {
  const shown = view._downloads
    .filter(download => listed(win, download))
    .slice(0, view.kItemCountLimit);
  for (const download of [...view._visibleViewItems.keys()]) {
    if (!shown.includes(download)) {
      view._removeViewItem(download);
    }
  }
  let before = view.richListBox.firstElementChild;
  for (const download of shown) {
    if (!view._visibleViewItems.has(download)) {
      view._addViewItem(download, false);
    }
    const item = view._visibleViewItems.get(download);
    if (item.element !== before) {
      view.richListBox.insertBefore(item.element, before);
    }
    before = item.element.nextElementSibling;
    decorate(win, item);
  }
  draw(win, shown.length, view._downloads.length);
  view._itemCountChanged();
}

/**
 * Gives a row its remove button, which runs the row's `cmd_delete`, as the
 * Delete key and the context menu's Remove From History do. The item enables
 * it once the download has stopped.
 *
 * @param {Window} win
 * @param {object} item A `DownloadsViewItem`.
 */
function addRemoveButton(win, item) {
  const row = item.element;
  if (row.querySelector(".sval-downloads-remove")) {
    return;
  }
  const button = htmlElement(win.document, "button", {
    type: "button",
    className: "sval-downloads-remove",
    title: "Remove from list",
    tabIndex: -1,
    attrs: { "aria-label": "Remove from list" },
  });
  button.addEventListener("click", () =>
    win.DownloadsView.itemForElement(row).doCommand("cmd_delete")
  );
  row.append(button);
}

/**
 * Gives a row its remove button, and says which workspace its download is
 * from, at the start of its status line, while the panel lists every
 * workspace's.
 *
 * @param {Window} win
 * @param {object} item A `DownloadsViewItem`.
 */
export function decorate(win, item) {
  const doc = win.document;
  const row = item.element;
  const container = row.querySelector(".downloadContainer");
  if (!container) {
    return;
  }
  addRemoveButton(win, item);
  let label = container.querySelector(".sval-downloads-from");
  const from = listsAll(win) ? labelOf(win, item.download) : null;
  if (!from) {
    label?.remove();
    row.removeAttribute("aria-description");
    return;
  }
  if (!label) {
    label = htmlElement(doc, "span", { className: "sval-downloads-from" });
    container.querySelector(".downloadDetailsNormal")?.before(label);
  }
  const disc = htmlElement(doc, "span", {
    className: "sval-downloads-from-disc",
  });
  let name;
  let description;
  if (from.unknown) {
    label.dataset.kind = "unknown";
    name = "Unknown Workspace";
    description = "From a tab Sval could not find";
  } else if (from.deleted) {
    label.dataset.kind = "deleted";
    name = "Deleted Workspace";
    description = "From a Workspace that was deleted";
  } else if (from.agent) {
    label.dataset.kind = "agent";
    name = from.name;
    description = `From ${from.name} (agent Workspace)`;
  } else {
    label.dataset.kind = "workspace";
    name = from.name;
    description = `From ${from.name}`;
  }
  if (from.mark) {
    disc.dataset.mark = "";
    disc.style.setProperty("--sval-dl-mark", `url("${from.mark}")`);
  } else {
    disc.textContent = from.emoji ?? "";
  }
  if (from.color) {
    label.dataset.color = "";
    label.style.setProperty(
      "--sval-dl-from-color",
      lazy.SvalColor.markOf(from.color)
    );
  } else {
    delete label.dataset.color;
    label.style.removeProperty("--sval-dl-from-color");
  }
  label.replaceChildren(
    disc,
    htmlElement(doc, "span", { className: "sval-downloads-from-name" }, name)
  );
  label.title = description;
  row.setAttribute("aria-description", description);
}

export const SvalDownloadsPanel = { mount, listedCount, relist, decorate };
