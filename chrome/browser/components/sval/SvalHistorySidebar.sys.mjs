/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Firefox's History sidebar, as Sval shows it: the header's history button
 * opens it (`SvalHeader`), and it is where history is searched, read and
 * cleared. Sval keeps Firefox's own sidebar page and its Places tree, and adds
 * to them, the query and the cells through the tree's `svalHistory`, which
 * `history-sidebar-hooks.patch` has the page and `PlacesTreeView` ask:
 *
 * - The sidebar's header names what it shows and closes it. Its switcher
 *   button, whose menu moves the sidebar or picks another one, is hidden with
 *   its icon, and its title stays. The side is the panel's opposite (`SvalPanel`).
 * - While an enabled extension has a sidebar (`sidebar_action`), the switcher
 *   shows, and its menu lists History and the extensions' sidebars alone
 *   (extension-compatibility spec §6).
 * - Its search field, buttons and rows are drawn as the panel's ({@link SHEET}).
 * - A site's folder, under "By Site" and "By Date and Site", shows the icon
 *   of that site's most recent page.
 * - Every view lists pages with when each was visited, in `PlacesTreeView`'s
 *   own date column, which leaves a day's or a site's folder blank.
 * - It lists the history of the workspace its window shows, with the pages
 *   visited in no workspace, or under "All Workspaces" every page, each with
 *   the workspace of its latest visit in a column (decision 1287). Places
 *   holds each visit's workspace, and a query names the one it lists
 *   (`SvalVisitWorkspaces`). A private window records no history and lists
 *   all of it, as Firefox's does.
 * - "Clear Recent History…" below the list runs Firefox's `Tools:Sanitize`.
 * - "Archived tabs", after the View menu's own views, lists the tabs Sval
 *   archived for being idle, and a click brings one back (idle-tab archive
 *   spec §7.3). The History menu's "Archive" opens it.
 *   A private window offers none of it: its tabs are never archived.
 * - It slides in and out as the panel does (`slide`).
 */

import {
  EXTENSION_ITEM_CLASS,
  settle,
  slide,
  slideIn,
  slides,
} from "moz-src:///browser/components/sval/SvalHeader.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  keepKeyDescribed: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  ARCHIVE_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  SvalArchive: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  SvalVisitWorkspaces:
    "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs",
  switcherItemOf: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  WINDOW_WORKSPACE_TOPIC:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  handWorkspaceTo: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  openNormalWindow: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  TAB: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
});

const SIDEBAR_ID = "viewHistorySidebar";
const HISTORY_ITEM_ID = "sidebar-switcher-history";
const SHEET = "chrome://browser/content/sval/history-sidebar.css";
export const CLEAR_BUTTON_ID = "sval-history-clear";
export const DATE_COLUMN_ID = "date";
export const WORKSPACE_COLUMN_ID = "sval-workspace";
export const SCOPE_SWITCH_ID = "sval-history-views";
export const ARCHIVED_VIEW_ID = "sval-byarchived";
export const ARCHIVED_TREE_ID = "sval-archived-tree";
export const ARCHIVE_MENU_ID = "sval-history-archive";

/** The archived view's columns, by id. */
const ARCHIVED_COLUMNS = Object.freeze({
  title: "sval-archived-title",
  workspace: "sval-archived-workspace",
  closed: "sval-archived-closed",
});

/** Windows that asked for the History sidebar on its archived view. */
const wantsArchived = new WeakSet();

/**
 * The formats {@link archivedAt} writes with, made once for a listing since
 * the tree asks for a cell's text on every paint.
 *
 * @returns {{time: object, dateTime: object}}
 */
function archivedFormats() {
  return {
    time: new Services.intl.DateTimeFormat(undefined, { timeStyle: "short" }),
    dateTime: new Services.intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }),
  };
}

/**
 * When an entry was archived, as Places' own date column says when a page
 * was visited: its time alone today, its date and time before.
 *
 * @param {number} ms Milliseconds since the epoch.
 * @param {{time: object, dateTime: object}} formats As
 *   {@link archivedFormats} makes them.
 * @returns {string}
 */
function archivedAt(ms, formats) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (ms >= today.getTime() ? formats.time : formats.dateTime).format(ms);
}

/**
 * Brings the restored tab to the screen: in the window that shows its
 * workspace, or in `win`, which goes to that workspace.
 * Exported for tests.
 *
 * @param {Window} win The window whose sidebar restored it.
 * @param {object} restored As the restore answers.
 * @param {string[]} restored.tabs The restored tabs, the first shown.
 * @param {string} restored.workspace The workspace they went to.
 */
export async function showRestored(win, { tabs, workspace }) {
  // A Peek shows no workspace, so the frontmost ordinary window goes
  // to it instead, or a new one when the Peek is the only window.
  let target = win.SvalPanel
    ? win
    : lazy.BrowserWindowTracker.getTopWindow({ private: false });
  for (const other of Services.wm.getEnumerator("navigator:browser")) {
    if (
      !other.closed &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(other) &&
      lazy.SvalWindowWorkspace.of(other).id === workspace
    ) {
      target = other;
      break;
    }
  }
  target ??= await lazy.openNormalWindow(w =>
    lazy.handWorkspaceTo(w, workspace)
  );
  const panel = target.SvalPanel;
  if (lazy.SvalWindowWorkspace.of(target).id === workspace) {
    await panel.refresh();
  } else {
    await lazy.SvalWindowWorkspace.of(target).switchTo(workspace);
  }
  await panel.activate({ kind: lazy.TAB, id: tabs[0] });
  target.focus();
}

/**
 * The archived view (idle-tab archive spec §7.3): a tree of its own beside
 * the Places tree, shown in its place while the view is chosen. It is a
 * plain `nsITreeView` over `SvalArchive.entries()`, newest first, which the
 * sidebar's search filters by title and address. A row shows the page, the
 * workspace it was archived from, and when, dimmed once it was restored.
 *
 * @param {Window} win The browser window.
 * @param {Document} doc The sidebar's document.
 * @param {Element} places The Places tree.
 * @returns {object} `{ shown, show, hide, filter }`.
 */
function archivedView(win, doc, places) {
  const tree = doc.createXULElement("tree");
  tree.id = ARCHIVED_TREE_ID;
  tree.className = "sidebar-placesTree";
  tree.setAttribute("flex", "1");
  tree.setAttribute("hidecolumnpicker", "true");
  tree.setAttribute("seltype", "single");
  tree.setAttribute("aria-label", "Archived tabs");
  tree.hidden = true;
  const cols = doc.createXULElement("treecols");
  for (const [id, label] of [
    [ARCHIVED_COLUMNS.title, "Page"],
    [ARCHIVED_COLUMNS.workspace, "Workspace"],
    [ARCHIVED_COLUMNS.closed, "Archived"],
  ]) {
    const col = doc.createXULElement("treecol");
    col.id = id;
    col.setAttribute("label", label);
    col.setAttribute("hideheader", "true");
    col.setAttribute("crop", "end");
    if (id === ARCHIVED_COLUMNS.title) {
      col.setAttribute("flex", "1");
      col.setAttribute("primary", "true");
    }
    cols.append(col);
  }
  tree.append(cols, doc.createXULElement("treechildren"));
  places.after(tree);

  const search = doc.getElementById("search-box");
  let entries = [];
  // The rows the view shows, kept here: the tree hands its view back as the
  // interface alone.
  let listed = [];
  // A tree reads a view's row count when the view is set, so each listing
  // is a view of its own.
  const viewOf = rows => ({
    QueryInterface: ChromeUtils.generateQI(["nsITreeView"]),
    rows,
    formats: archivedFormats(),
    selection: null,
    get rowCount() {
      return this.rows.length;
    },
    getCellText(row, column) {
      const entry = this.rows[row];
      switch (entry && column.id) {
        case ARCHIVED_COLUMNS.title:
          return entry.title || entry.url;
        case ARCHIVED_COLUMNS.workspace:
          return entry.workspaceName;
        case ARCHIVED_COLUMNS.closed:
          // Last, so a row's accessible name, its cells in turn, ends with
          // it. The dimmed title says it to the eye.
          return entry.restored
            ? `${archivedAt(entry.closedAt, this.formats)}, restored`
            : archivedAt(entry.closedAt, this.formats);
      }
      return "";
    },
    getImageSrc(row, column) {
      const entry = this.rows[row];
      if (column.id !== ARCHIVED_COLUMNS.title || !entry) {
        return "";
      }
      // The icon the tab had where it was archived, else the one Places
      // keeps for its page here.
      return entry.icon || (entry.url ? `page-icon:${entry.url}` : "");
    },
    getCellProperties(row, column) {
      const properties = [];
      // `title` takes Places' favicon rule in tree-icons.css, which sizes
      // the icon to 16px and draws the default one for a page with none.
      if (column.id === ARCHIVED_COLUMNS.title) {
        properties.push("title");
      }
      if (this.rows[row]?.restored) {
        properties.push("restored");
      }
      return properties.join(" ");
    },
    getRowProperties: () => "",
    getColumnProperties: () => "",
    isContainer: () => false,
    isContainerOpen: () => false,
    isContainerEmpty: () => false,
    isSeparator: () => false,
    isSorted: () => false,
    canDrop: () => false,
    drop() {},
    getParentIndex: () => -1,
    hasNextSibling: () => false,
    getLevel: () => 0,
    getCellValue: () => "",
    setTree() {},
    toggleOpenState() {},
    cycleHeader() {},
    selectionChanged() {},
    cycleCell() {},
    isEditable: () => false,
    setCellValue() {},
    setCellText() {},
  });

  const filter = () => {
    const term = search.value.trim().toLowerCase();
    listed = term
      ? entries.filter(
          entry =>
            (entry.title ?? "").toLowerCase().includes(term) ||
            (entry.url ?? "").toLowerCase().includes(term)
        )
      : entries;
    tree.view = viewOf(listed);
  };
  const reload = async () => {
    const archive = lazy.SvalArchive.instance;
    entries = archive?.ready ? await archive.entries() : [];
    if (!tree.hidden) {
      filter();
    }
  };
  const redraw = () =>
    reload().catch(err =>
      SvalLog.warn(
        `history: the Archive did not load: ${SvalLog.errorName(err)}`
      )
    );
  Services.obs.addObserver(redraw, lazy.ARCHIVE_CHANGED_TOPIC);
  doc.defaultView.addEventListener(
    "unload",
    () => Services.obs.removeObserver(redraw, lazy.ARCHIVE_CHANGED_TOPIC),
    { once: true }
  );

  const restore = row => {
    const entry = listed[row];
    const archive = lazy.SvalArchive.instance;
    if (!entry || entry.refused || !archive?.ready) {
      return;
    }
    archive
      .restore(entry.id, lazy.SvalWindowWorkspace.of(win).id)
      .then(restored => showRestored(win, restored))
      .catch(err =>
        SvalLog.error(`history: a restore failed: ${SvalLog.errorName(err)}`)
      );
  };
  tree.addEventListener("click", event => {
    // A double click restores once.
    if (event.button !== 0 || event.detail > 1) {
      return;
    }
    const { row } = tree.getCellAt(event.clientX, event.clientY);
    if (row >= 0) {
      restore(row);
    }
  });
  tree.addEventListener("keypress", event => {
    if (event.keyCode === event.DOM_VK_RETURN && tree.view?.selection) {
      restore(tree.view.selection.currentIndex);
    }
  });

  return {
    get shown() {
      return !tree.hidden;
    },
    tree,
    async show() {
      places.hidden = true;
      tree.hidden = false;
      await reload();
    },
    hide() {
      tree.hidden = true;
      places.hidden = false;
    },
    filter,
  };
}

/** The two views of history, as the Downloads panel names its own. */
const SCOPES = Object.freeze([
  { all: false, label: "This Workspace" },
  { all: true, label: "All Workspaces" },
]);

/**
 * What the Workspace column says a workspace is: its name as the switcher
 * shows it, or "Deleted Workspace" for one no longer in the tree, as the
 * Downloads panel says (`SvalDownloadsPanel`).
 *
 * @param {Window} win The browser window.
 * @param {string} id
 * @returns {string}
 */
export function workspaceLabel(win, id) {
  const panel = win.SvalPanel;
  const item = lazy.switcherItemOf(
    panel?.nodes ?? {},
    id,
    lazy.SvalWindowWorkspace.of(win).id
  );
  return item ? panel.workspaceName(item) : "Deleted Workspace";
}

/**
 * Whether `view` still has `row`. The accessibility service reads a row's
 * cells after the view has dropped it: `XULTreeAccessible::InvalidateCache`
 * fires the removed row's hide event, and a screen reader asks the name of
 * what it hides. `PlacesTreeView` answers only for the rows it has.
 *
 * @param {object} view
 * @param {number} row
 * @returns {boolean}
 */
function hasRow(view, row) {
  return row >= 0 && row < view.rowCount;
}

/**
 * The text of a cell of `view`, the sidebar's `PlacesTreeView`, in the
 * workspace column, which Firefox's view has no text for, or
 * undefined for a cell Firefox's view fills.
 *
 * @param {object} view
 * @param {number} row
 * @param {object} column A `TreeColumn`.
 * @param {(node: object) => string} workspaceOf The workspace column's text.
 * @returns {string|undefined}
 */
function cellText(view, row, column, workspaceOf) {
  if (!hasRow(view, row)) {
    return "";
  }
  if (column.id === WORKSPACE_COLUMN_ID) {
    return workspaceOf(view.nodeForTreeIndex(row));
  }
  return undefined;
}

/**
 * The workspace column's text for each page, the workspace of its latest
 * visit, asked of Places off the main thread, because the tree asks while it
 * paints. A page shows nothing until its answer arrives, and nothing for a
 * visit made in no workspace.
 *
 * @param {Window} win The browser window.
 * @param {Function} repaint
 * @returns {{ textOf: (node: object) => string, forget: () => void }}
 */
function workspaceColumn(win, repaint) {
  // `url\ntime` of a page's latest visit -> its workspace id, null for none,
  // or undefined while Places answers.
  const known = new Map();
  return {
    textOf(node) {
      if (!node || !lazy.PlacesUtils.nodeIsURI(node)) {
        return "";
      }
      const key = `${node.uri}\n${node.time}`;
      if (!known.has(key)) {
        known.set(key, undefined);
        lazy.SvalVisitWorkspaces.latestOf(node.uri)
          .then(id => {
            known.set(key, id);
            if (id) {
              repaint();
            }
          })
          .catch(err =>
            SvalLog.warn(
              `history: a page's workspace: ${SvalLog.errorName(err)}`
            )
          );
      }
      const id = known.get(key);
      return id ? workspaceLabel(win, id) : "";
    },
    forget() {
      known.clear();
    },
  };
}

/**
 * The icon of a site's most recent page, as the tree shows a page's icon
 * (`page-icon:`), or null for a site with no page left. Asked of Places off
 * the main thread, because the tree asks while it paints.
 *
 * @param {nsINavHistoryQueryResultNode} site A site's folder.
 * @returns {Promise<string|null>}
 */
function siteIcon(site) {
  const { history } = lazy.PlacesUtils;
  const node = lazy.PlacesUtils.asQuery(site);
  const options = history.getNewQueryOptions();
  options.resultType = options.RESULTS_AS_URI;
  options.sortingMode = options.SORT_BY_DATE_DESCENDING;
  options.maxResults = 1;
  return new Promise(resolve => {
    let url = null;
    history.asyncExecuteLegacyQuery(node.query, options, {
      handleResult(results) {
        url ??= results.getNextRow()?.getResultByName("url") ?? null;
      },
      handleError(error) {
        SvalLog.warn(`history: a site's icon did not load: ${error.result}`);
      },
      handleCompletion() {
        resolve(url ? `page-icon:${url}` : null);
      },
    });
  });
}

/**
 * The icon of a site's folder in `view`, the sidebar's `PlacesTreeView`, as
 * its site's most recent page, or undefined for a cell that shows the
 * tree's own icon: any other cell, and a folder until its site's icon
 * arrives, when `repaint` draws it.
 *
 * @param {object} view
 * @param {number} row
 * @param {object} column A `TreeColumn`.
 * @param {Map<string, string|null|undefined>} icons Each site's icon, kept
 *   for the sidebar's life, so a search or a sort, each of which makes a new
 *   view, asks Places again for none. `undefined` is an icon on its way.
 * @param {Function} repaint
 * @returns {string|undefined}
 */
function siteImage(view, row, column, icons, repaint) {
  if (!hasRow(view, row)) {
    return "";
  }
  const node = view.nodeForTreeIndex(row);
  if (column.id !== "title" || !lazy.PlacesUtils.nodeIsHost(node)) {
    return undefined;
  }
  const site = node.uri;
  if (!icons.has(site)) {
    icons.set(site, undefined);
    siteIcon(node)
      .then(icon => {
        icons.set(site, icon);
        if (icon) {
          repaint();
        }
      })
      // The sidebar can close while Places answers, taking its tree.
      .catch(err =>
        SvalLog.warn(`history: a site's icon: ${SvalLog.errorName(err)}`)
      );
  }
  return icons.get(site) ?? undefined;
}

export const SvalHistorySidebar = {
  /**
   * Takes the switcher out of the sidebar's header, and adds to the History
   * sidebar each time it shows.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    const switcher = doc.getElementById("sidebar-switcher-target");
    if (switcher) {
      // `SidebarController` keeps writing the title; outside the button it
      // still shows, and nothing opens the switcher's menu. The icon stays
      // inside, hidden with it: Firefox draws it only there (`sidebar.css`).
      switcher.before(doc.getElementById("sidebar-title"));
      switcher.hidden = true;
    }
    const menu = doc.getElementById("sidebarMenu-popup");
    if (switcher && menu) {
      this._switchToExtensions(win, switcher, menu);
    }
    const undoWindow = doc.getElementById("historyUndoWindowMenu");
    if (undoWindow) {
      const archive = doc.createXULElement("menuitem");
      archive.id = ARCHIVE_MENU_ID;
      archive.setAttribute("label", "Archive");
      archive.hidden = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      // The menu's Places view handles only its own items' commands.
      archive.addEventListener("command", event => {
        event.stopPropagation();
        this.showArchived(win);
      });
      undoWindow.after(archive);
    }
    const box = doc.getElementById("sidebar-box");
    const slider = box && this._slider(win, box);
    win.addEventListener("SidebarShown", () => {
      try {
        slider?.(win.SidebarController.browser.contentWindow);
        this._decorate(win);
      } catch (err) {
        SvalLog.error(`history sidebar: ${SvalLog.errorName(err)}`);
      }
    });
  },

  /**
   * Opens the History sidebar on its archived view. A private window has
   * none.
   *
   * @param {Window} win A browser window.
   */
  showArchived(win) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    const { SidebarController } = win;
    const shown =
      SidebarController.isOpen && SidebarController.currentID === SIDEBAR_ID
        ? SidebarController.browser.contentDocument?.getElementById(
            "historyTree"
          )?._svalArchived
        : null;
    if (shown) {
      shown.choose();
      return;
    }
    wantsArchived.add(win);
    SidebarController.show(SIDEBAR_ID);
  },

  /**
   * Shows the switcher while its menu holds an extension's sidebar, the only
   * way into one besides the extension's own button or shortcut. Firefox adds
   * an extension's item as the extension starts and removes it as it stops
   * (`SidebarController.registerExtension`, `removeExtension`), so the items
   * say which enabled extensions have one.
   *
   * The menu keeps History, to get back to Sval's, and the extensions'
   * sidebars. Its other items are hidden each time it opens, because
   * `SidebarController` makes some of them late.
   *
   * @param {Window} win
   * @param {Element} switcher `#sidebar-switcher-target`.
   * @param {Element} menu `#sidebarMenu-popup`.
   */
  _switchToExtensions(win, switcher, menu) {
    const update = () => {
      switcher.hidden =
        !menu.getElementsByClassName(EXTENSION_ITEM_CLASS).length;
    };
    new win.MutationObserver(update).observe(menu, { childList: true });
    update();
    menu.addEventListener("popupshowing", event => {
      if (event.target !== menu) {
        return;
      }
      for (const item of menu.children) {
        if (
          item.id !== HISTORY_ITEM_ID &&
          !item.classList.contains(EXTENSION_ITEM_CLASS)
        ) {
          item.hidden = true;
        }
      }
    });
  },

  /**
   * Slides the sidebar in each time it appears, and out before it hides.
   *
   * `SidebarController` shows the box by clearing its `hidden`, so the slide
   * in starts from that change, before the box is first drawn. It hides the
   * box in the same call that unloads the sidebar's page, so the slide out
   * happens first: the page's cancelable `SidebarWillHide` is held while the
   * box slides, and the hide runs again once it is out. A hide or a show
   * asked for mid-slide reverses it, as a second press does the panel's.
   *
   * @param {Window} win
   * @param {Element} box `#sidebar-box`.
   * @returns {(content: Window) => void} Listens to a sidebar page.
   */
  _slider(win, box) {
    let hiding = false;
    new win.MutationObserver(() => {
      if (box.hidden) {
        settle(box);
      } else if (!box.hasAttribute("sval-overlay")) {
        slideIn(box);
      }
    }).observe(box, { attributeFilter: ["hidden"] });
    const onWillHide = event => {
      if (hiding || !slides(box)) {
        return;
      }
      event.preventDefault();
      if (box.hasAttribute("sval-collapsed")) {
        slide(box, true);
        return;
      }
      slide(box, false, () => {
        hiding = true;
        try {
          win.SidebarController.hide();
        } finally {
          hiding = false;
        }
      });
    };
    const onWillShow = () => {
      if (box.hasAttribute("sval-collapsed")) {
        slide(box, true);
      }
    };
    return content => {
      content.addEventListener("SidebarWillHide", onWillHide);
      content.addEventListener("SidebarWillShow", onWillShow);
    };
  },

  /** @param {Window} win */
  _decorate(win) {
    if (win.SidebarController.currentID !== SIDEBAR_ID) {
      return;
    }
    const doc = win.SidebarController.browser.contentDocument;
    const tree = doc?.getElementById("historyTree");
    if (!tree || tree._svalDecorated) {
      return;
    }
    tree._svalDecorated = true;
    doc.defaultView.windowUtils.loadSheetUsingURIString(
      SHEET,
      doc.defaultView.windowUtils.AUTHOR_SHEET
    );

    // Beside the title, before the date. Firefox's column and these are
    // labelled although their headers are hidden: more than one column makes
    // the tree a table, and the label is the header a screen reader gives
    // each column's cells.
    const workspace = doc.createXULElement("treecol");
    workspace.id = WORKSPACE_COLUMN_ID;
    workspace.setAttribute("label", "Workspace");
    workspace.setAttribute("hideheader", "true");
    workspace.setAttribute("crop", "end");
    const date = doc.createXULElement("treecol");
    date.id = DATE_COLUMN_ID;
    date.setAttribute("label", "Visited");
    date.setAttribute("hideheader", "true");
    const cols = tree.querySelector("treecols");
    const title = cols.querySelector("#title");
    title?.setAttribute("label", "Page");
    // xul.css gives `[flex="1"]` an `!important` flex, which outranks
    // the sheet's sizing of the title (`history-sidebar.css`).
    title?.removeAttribute("flex");
    cols.append(workspace, date);
    tree.columns.invalidateColumns();
    // Gecko makes the tree's accessible for the columns shown as it first
    // reads the tree: a list for one, a table for more (`XULMAP(tree)` in
    // accessible/base/XULMap.inc), its column headers the ones shown then.
    // It never looks again, and a screen reader may first read it with
    // Firefox's one column. A change of `role` makes Gecko make it again
    // (`DocAccessible::UpdateAccessibleOnAttrChange`), so each change of the
    // columns shown sets and clears one.
    let shown = null;
    const reread = () => {
      const now = [...cols.children]
        .filter(col => !col.hidden)
        .map(col => col.id)
        .join(" ");
      if (now !== shown) {
        shown = now;
        tree.setAttribute("role", "tree");
        tree.removeAttribute("role");
      }
    };
    const workspaces = workspaceColumn(win, () => tree.invalidate());
    const scope = this._scope(win, doc, tree, workspace, workspaces);

    const footer = doc.createXULElement("hbox");
    footer.id = "sval-history-footer";
    const clear = doc.createXULElement("button");
    clear.id = CLEAR_BUTTON_ID;
    clear.setAttribute("label", "Clear Recent History…");
    lazy.keepKeyDescribed(
      clear,
      "key_sanitize",
      "Clear Recent History",
      win.document
    );
    clear.addEventListener("command", () =>
      win.document.getElementById("Tools:Sanitize").doCommand()
    );
    footer.append(clear);
    tree.after(footer);

    const viewButton = doc.getElementById("viewButton");
    const siteIcons = new Map();
    // A choice of another view is heard before the sidebar's own handler
    // runs its query, so the Places tree is back for it.
    const archived = lazy.PrivateBrowsingUtils.isWindowPrivate(win)
      ? null
      : this._archivedChoice(win, doc, tree, viewButton, reread);
    // What the sidebar's page (`searchHistory`) and its `PlacesTreeView`
    // ask Sval, through the hooks Sval's patches give them.
    tree.svalHistory = {
      // A search while the archived view is shown filters it, and runs no
      // query.
      willLoad(query) {
        if (archived?.view.shown) {
          archived.view.filter();
          return false;
        }
        query.svalWorkspace = scope.workspace();
        return true;
      },
      loaded: reread,
      cellText: (view, row, column) =>
        cellText(view, row, column, node => workspaces.textOf(node)),
      imageSrc: (view, row, column) =>
        siteImage(view, row, column, siteIcons, () => tree.invalidate()),
    };
    // The page ran its first query before this was here.
    scope.reload();
    if (archived && wantsArchived.delete(win)) {
      archived.choose();
    }
  },

  /**
   * The switch between "This Workspace" and "All Workspaces" above the list,
   * a radio group as the Downloads panel's is (`SvalDownloadsPanel`): arrow
   * keys move between its two segments and choose as they move. Each window
   * starts on its own workspace, and goes back to it when it comes to show
   * another. The workspace column shows under All Workspaces alone.
   *
   * @param {Window} win The browser window.
   * @param {Document} doc The sidebar's document.
   * @param {Element} tree The Places tree.
   * @param {Element} column The workspace column.
   * @param {object} workspaces The column's text, as `workspaceColumn` makes.
   * @returns {{ workspace: () => string|null, reload: () => void }}
   */
  _scope(win, doc, tree, column, workspaces) {
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    let all = isPrivate;
    let shownWorkspace = lazy.SvalWindowWorkspace.of(win).id;
    const reload = () => {
      // A private window's switcher holds its own session's workspaces
      // alone, so it could name none of the others.
      column.hidden = !all || isPrivate;
      tree.columns?.invalidateColumns();
      doc.defaultView.searchHistory?.(
        doc.getElementById("search-box")?.value ?? ""
      );
    };
    const group = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    group.id = SCOPE_SWITCH_ID;
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Show history from");
    const draw = () => {
      for (const button of group.children) {
        const on = button.dataset.all === String(all);
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
      }
    };
    const choose = value => {
      if (value === all) {
        return;
      }
      all = value;
      draw();
      reload();
    };
    for (const view of SCOPES) {
      const button = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      button.type = "button";
      button.className = "sval-history-view";
      button.setAttribute("role", "radio");
      button.dataset.all = String(view.all);
      button.textContent = view.label;
      button.addEventListener("click", () => choose(view.all));
      group.append(button);
    }
    group.addEventListener("keydown", event => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();
      choose(!all);
      group.querySelector(`[data-all="${all}"]`)?.focus();
    });
    draw();
    // A private window records no history, so it has no workspace's to show.
    if (!isPrivate) {
      doc.getElementById("sidebar-search-container")?.after(group);
    }

    const shown = subject => {
      const now = lazy.SvalWindowWorkspace.of(win).id;
      if (subject !== win || now === shownWorkspace) {
        tree.invalidate();
        return;
      }
      shownWorkspace = now;
      // A private window draws no switch, so it lists every page throughout.
      all = isPrivate;
      draw();
      reload();
    };
    // A visit's workspace changed where no Places event says so.
    const purged = () => {
      workspaces.forget();
      tree.invalidate();
    };
    Services.obs.addObserver(shown, lazy.WINDOW_WORKSPACE_TOPIC);
    PlacesObservers.addListener(["purge-caches"], purged);
    doc.defaultView.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(shown, lazy.WINDOW_WORKSPACE_TOPIC);
        PlacesObservers.removeListener(["purge-caches"], purged);
      },
      { once: true }
    );
    return {
      workspace: () => (all ? null : shownWorkspace),
      reload,
    };
  },

  /**
   * Adds "Archived tabs" after the View menu's own items.
   *
   * @param {Window} win The browser window.
   * @param {Document} doc The sidebar's document.
   * @param {Element} tree The Places tree.
   * @param {Element} viewButton The View menu's button.
   * @param {Function} update Runs once the Places tree is back.
   * @returns {object} `{ view, choose }`.
   */
  _archivedChoice(win, doc, tree, viewButton, update) {
    const view = archivedView(win, doc, tree);
    const popup = viewButton.querySelector("menupopup");
    const item = doc.createXULElement("menuitem");
    item.id = ARCHIVED_VIEW_ID;
    item.setAttribute("type", "radio");
    item.setAttribute("label", "Archived tabs");
    popup.append(item);
    const choose = () => {
      for (const other of popup.children) {
        other.toggleAttribute("checked", other === item);
      }
      doc.getElementById(SCOPE_SWITCH_ID)?.setAttribute("hidden", "true");
      view
        .show()
        .catch(err =>
          SvalLog.warn(
            `history: the Archive did not show: ${SvalLog.errorName(err)}`
          )
        );
    };
    // On the item, so the sidebar's own handler on the popup, which would
    // take the item's id for a Places sort and remember it, never hears it.
    item.addEventListener("command", event => {
      event.stopPropagation();
      choose();
    });
    popup.addEventListener(
      "command",
      event => {
        if (event.target !== item && view.shown) {
          item.removeAttribute("checked");
          view.hide();
          doc.getElementById(SCOPE_SWITCH_ID)?.removeAttribute("hidden");
          update();
        }
      },
      true
    );
    const archived = { view, choose };
    tree._svalArchived = archived;
    return archived;
  },
};
