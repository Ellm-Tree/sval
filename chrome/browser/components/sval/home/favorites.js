/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// home.js shares this page's global scope, so everything here lives in its
// own function scope.
(() => {
  /**
   * The home page's row of pinned Favorites (home-favorites spec §3, §4, §11).
   *
   * The `SvalHomeFavorites` actor (`SvalHomeFavoritesParent.sys.mjs`) sends the
   * row whenever it changes, and does what the page asks: open, open all,
   * unpin, move a tile, file a tile in a folder, and turn the row on or off.
   * The page only draws and listens.
   */

  const section = document.querySelector(".favorites");
  const row = section.querySelector(".fav-row");
  const empty = section.querySelector(".fav-empty");
  const drop = section.querySelector(".fav-drop");
  const panel = section.querySelector(".fav-panel");
  const caret = panel.querySelector(".fav-caret");
  const back = panel.querySelector(".fav-back");
  const panelTitle = panel.querySelector(".fav-panel-title");
  const openAll = panel.querySelector(".fav-open-all");
  const panelBody = panel.querySelector(".fav-panel-body");
  const panelEmpty = panel.querySelector(".fav-panel-empty");
  const status = section.querySelector(".fav-status");
  const toggle = document.querySelector(".fav-switch-track");
  const searchInput = document.querySelector(".search input");

  const DRAG_TYPE = "application/x-sval-favorite";

  let enabled = true;
  // Never a bookmarklet: the actor leaves them off the row
  // (`SvalFavoritesStore.home`), since one would run on this page.
  let tiles = [];
  // The pinned folder whose panel is open, and the folders opened inside it.
  let path = [];
  // The tile that holds the row's one tab stop.
  let current = 0;

  function ask(type, data = null) {
    window.dispatchEvent(
      new CustomEvent("SvalHomeFavorites", { detail: { type, data } })
    );
  }

  window.addEventListener("SvalHomeFavoritesService", event => {
    const { type, data } = event.detail;
    if (type === "Row") {
      enabled = data.enabled;
      tiles = data.tiles;
      render();
    } else if (type === "MoveBy") {
      const index = tiles.findIndex(t => t.guid === data.guid);
      if (index >= 0) {
        moveBy(index, (data.direction === "right") !== isRtl() ? 1 : -1);
      }
    }
  });

  function isRtl() {
    return getComputedStyle(row).direction === "rtl";
  }

  /**
   * The tile, among `list` and their folders' contents, with `guid`.
   *
   * @param {object[]} list
   * @param {string} guid
   */
  function find(list, guid) {
    for (const tile of list) {
      if (tile.guid === guid) {
        return tile;
      }
      const inside = tile.children && find(tile.children, guid);
      if (inside) {
        return inside;
      }
    }
    return null;
  }

  /**
   * A folder's first four favorites, depth-first through its subfolders.
   *
   * @param {object} folder
   * @param {object[]} [out]
   */
  function firstFavorites(folder, out = []) {
    for (const child of folder.children ?? []) {
      if (out.length >= 4) {
        break;
      }
      if (child.kind === "folder") {
        firstFavorites(child, out);
      } else {
        out.push(child);
      }
    }
    return out;
  }

  /**
   * What a tile is called: its title, else its address's host, so a favorite
   * saved without a title still says where it goes.
   *
   * @param {object} tile
   */
  function nameOf(tile) {
    const name = tile.name?.trim();
    if (name) {
      return name;
    }
    try {
      return new URL(tile.url).hostname.replace(/^www\./, "") || tile.url;
    } catch {
      return tile.url ?? "";
    }
  }

  /**
   * The letter a favorite without an icon shows.
   *
   * @param {object} tile
   */
  function letterOf(tile) {
    return (nameOf(tile)[0] ?? "?").toUpperCase();
  }

  /**
   * An icon for a favorite: the one this device keeps for it
   * (`SvalFavoriteIcons`, sent with the tile), else its page's cached icon,
   * never fetched (spec §11.2), or its letter when there is none.
   *
   * @param {object} tile
   * @param {string} className
   * @returns {Element}
   */
  function iconFor(tile, className) {
    const letter = document.createElement("span");
    letter.className = "fav-letter";
    letter.textContent = letterOf(tile);
    if (!tile.url) {
      return letter;
    }
    const img = document.createElement("img");
    img.className = className;
    img.alt = "";
    img.src = tile.icon ?? `page-icon:${tile.url}`;
    img.addEventListener("error", () => img.replaceWith(letter), {
      once: true,
    });
    return img;
  }

  function wellFor(tile) {
    const well = document.createElement("span");
    well.className = "fav-well";
    // A tile is named by its label alone; the well's letters repeat it.
    well.setAttribute("aria-hidden", "true");
    if (tile.kind === "folder") {
      well.classList.add("fav-grid");
      const four = firstFavorites(tile);
      for (let i = 0; i < 4; i++) {
        const slot = document.createElement("span");
        slot.className = "fav-mini";
        if (four[i]) {
          slot.append(iconFor(four[i], "fav-mini-icon"));
        }
        well.append(slot);
      }
    } else {
      well.append(iconFor(tile, "fav-icon"));
    }
    return well;
  }

  function labelFor(tile) {
    const label = document.createElement("span");
    label.className = "fav-label";
    const text = document.createElement("span");
    text.className = "fav-name";
    text.textContent = nameOf(tile);
    label.append(text);
    if (tile.kind === "folder") {
      const chevron = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg"
      );
      chevron.setAttribute("viewBox", "0 0 24 24");
      chevron.setAttribute("class", "fav-chevron");
      chevron.setAttribute("aria-hidden", "true");
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );
      line.setAttribute("d", "m6 9 6 6 6-6");
      chevron.append(line);
      label.append(chevron);
    }
    return label;
  }

  /**
   * One tile: a link for a favorite, so the page's own context menu and a
   * middle-click treat it as one, and a button for a folder.
   *
   * @param {object} tile
   * @returns {Element}
   */
  function tileElement(tile) {
    let el;
    if (tile.kind === "folder") {
      el = document.createElement("button");
      el.type = "button";
      el.setAttribute("aria-expanded", "false");
      el.setAttribute("aria-controls", "fav-panel");
    } else {
      el = document.createElement("a");
      el.href = tile.url;
    }
    el.className = "fav-tile";
    el.dataset.guid = tile.guid;
    el.dataset.kind = tile.kind;
    el.title = tile.name?.trim() || tile.url || "";
    el.append(wellFor(tile), labelFor(tile));
    return el;
  }

  function render() {
    document.documentElement.classList.toggle("has-favorites", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
    section.hidden = !enabled;
    empty.hidden = !enabled || !!tiles.length;

    const focusedGuid = row.contains(document.activeElement)
      ? document.activeElement.dataset.guid
      : null;
    row.replaceChildren(
      ...tiles.map(tile => {
        const li = document.createElement("li");
        const el = tileElement(tile);
        el.draggable = true;
        li.append(el);
        return li;
      })
    );
    current = Math.max(
      0,
      Math.min(
        tiles.findIndex(t => t.guid === focusedGuid) >= 0
          ? tiles.findIndex(t => t.guid === focusedGuid)
          : current,
        tiles.length - 1
      )
    );
    rove(current, { focus: !!focusedGuid });

    // An open panel stays open on the folder it shows, as long as it is pinned.
    if (path.length && tiles.some(t => t.guid === path[0])) {
      showPanel();
    } else {
      closePanel({ focus: false });
    }
  }

  function rowTiles() {
    return [...row.querySelectorAll(".fav-tile")];
  }

  /**
   * Gives tile `index` the row's one tab stop, and the focus if asked.
   *
   * @param {number} index
   * @param {object} [options]
   * @param {boolean} [options.focus]
   */
  function rove(index, { focus = true } = {}) {
    const all = rowTiles();
    all.forEach((el, i) => (el.tabIndex = i === index ? 0 : -1));
    current = index;
    if (focus) {
      all[index]?.focus();
    }
  }

  // Opening. A click or a middle-click on a favorite goes to the actor, which
  // opens it as the Favorites menu would; the link's own navigation is not used.
  function onActivate(event) {
    const el = event.target.closest(".fav-tile");
    if (!el || (event.type === "auxclick" && event.button !== 1)) {
      return;
    }
    if (el.dataset.kind === "folder") {
      // A folder inside the panel opens in the panel, below.
      if (event.type === "click" && row.contains(el)) {
        toggleFolder(el.dataset.guid, el);
      }
      return;
    }
    event.preventDefault();
    ask("Open", {
      guid: el.dataset.guid,
      modifiers: {
        button: event.button,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      },
    });
  }
  for (const list of [row, panelBody]) {
    list.addEventListener("click", onActivate);
    list.addEventListener("auxclick", onActivate);
  }

  // The panel (spec §4).

  function toggleFolder(guid, tileEl) {
    if (path[0] === guid) {
      closePanel({ focus: false });
      return;
    }
    path = [guid];
    showPanel();
    tileEl?.setAttribute("aria-expanded", "true");
    // The panel opens below the row, which in a short window is past the
    // bottom of the page's view: the folder would seem not to open.
    panel.scrollIntoView({ block: "nearest" });
  }

  function showPanel() {
    const folder = find(tiles, path.at(-1));
    if (!folder) {
      closePanel({ focus: false });
      return;
    }
    for (const el of rowTiles()) {
      el.setAttribute(
        "aria-expanded",
        String(el.dataset.kind === "folder" && el.dataset.guid === path[0])
      );
      el.classList.toggle("open", el.dataset.guid === path[0]);
    }
    panelTitle.textContent = folder.name;
    panel.setAttribute("aria-label", folder.name);
    const parent = path.length > 1 ? find(tiles, path.at(-2)) : null;
    back.hidden = !parent;
    if (parent) {
      back.setAttribute("aria-label", `Back to ${parent.name}`);
      back.title = `Back to ${parent.name}`;
    }
    const children = folder.children ?? [];
    const focusedGuid = panelBody.contains(document.activeElement)
      ? document.activeElement.dataset.guid
      : null;
    openAll.disabled = !children.some(c => c.kind === "favorite");
    panelBody.replaceChildren(
      ...children.map(child => {
        const li = document.createElement("li");
        li.append(tileElement(child));
        return li;
      })
    );
    panelEmpty.hidden = !!children.length;
    panel.hidden = false;
    placePanel();
    // Focus in the panel stays on its tile as the panel redraws.
    if (focusedGuid) {
      const again = [...panelBody.querySelectorAll(".fav-tile")].find(
        el => el.dataset.guid === focusedGuid
      );
      (again ?? panelBody.querySelector(".fav-tile") ?? openAll).focus();
    }
  }

  /** Below the row's last line, its caret on the open folder's tile. */
  function placePanel() {
    const tile = row.querySelector(
      `.fav-tile[data-guid="${CSS.escape(path[0])}"]`
    );
    if (!tile) {
      return;
    }
    panel.style.top = `${row.offsetTop + row.offsetHeight + 12}px`;
    const panelBox = panel.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    caret.style.insetInlineStart = `${tileBox.left + tileBox.width / 2 - panelBox.left - 7}px`;
  }

  function closePanel({ focus = true } = {}) {
    if (panel.hidden) {
      path = [];
      return;
    }
    const opener = row.querySelector(
      `.fav-tile[data-guid="${CSS.escape(path[0])}"]`
    );
    path = [];
    panel.hidden = true;
    for (const el of rowTiles()) {
      el.classList.remove("open");
      if (el.dataset.kind === "folder") {
        el.setAttribute("aria-expanded", "false");
      }
    }
    if (focus) {
      opener?.focus();
    }
  }

  panelBody.addEventListener("click", event => {
    const el = event.target.closest(".fav-tile[data-kind=folder]");
    if (el) {
      path.push(el.dataset.guid);
      showPanel();
      panelBody.querySelector(".fav-tile")?.focus();
    }
  });
  back.addEventListener("click", () => {
    path.pop();
    showPanel();
    back.hidden ? openAll.focus() : back.focus();
  });
  openAll.addEventListener("click", () =>
    ask("OpenAll", { guid: path.at(-1) })
  );
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      closePanel();
    }
  });
  document.addEventListener("pointerdown", event => {
    if (
      !panel.hidden &&
      !panel.contains(event.target) &&
      !event.target.closest?.(".fav-tile[data-kind=folder]")
    ) {
      closePanel({ focus: false });
    }
  });
  searchInput?.addEventListener("input", () => closePanel({ focus: false }));
  window.addEventListener("resize", () => !panel.hidden && placePanel());

  // The keyboard (spec §11.5): one tab stop, arrows within the row, and
  // Ctrl+Shift+arrows to move the focused tile.

  function lineNeighbour(index, direction) {
    const all = rowTiles();
    const from = all[index].getBoundingClientRect();
    const centre = from.left + from.width / 2;
    let best = -1;
    let bestDistance = Infinity;
    all.forEach((el, i) => {
      const box = el.getBoundingClientRect();
      const onLine =
        direction > 0 ? box.top > from.bottom - 1 : box.bottom < from.top + 1;
      if (!onLine) {
        return;
      }
      const lineGap = Math.abs(box.top - from.top);
      const distance =
        lineGap * 1000 + Math.abs(box.left + box.width / 2 - centre);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  }

  row.addEventListener("keydown", event => {
    const el = event.target.closest(".fav-tile");
    if (!el) {
      return;
    }
    const all = rowTiles();
    const index = all.indexOf(el);
    const rtl = isRtl();
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    if (
      event.ctrlKey &&
      event.shiftKey &&
      [forward, backward].includes(event.key)
    ) {
      event.preventDefault();
      moveBy(index, event.key === forward ? 1 : -1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    let to = -1;
    switch (event.key) {
      case forward:
        to = Math.min(index + 1, all.length - 1);
        break;
      case backward:
        to = Math.max(index - 1, 0);
        break;
      case "ArrowDown":
        to = lineNeighbour(index, 1);
        break;
      case "ArrowUp":
        to = lineNeighbour(index, -1);
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (to >= 0) {
      rove(to);
    }
  });
  row.addEventListener("focusin", event => {
    const el = event.target.closest(".fav-tile");
    if (el) {
      rove(rowTiles().indexOf(el), { focus: false });
    }
  });

  /**
   * Moves the tile at `index` one place along the row, and says where.
   *
   * @param {number} index
   * @param {number} step -1 or 1.
   */
  function moveBy(index, step) {
    const to = index + step;
    if (to < 0 || to >= tiles.length) {
      return;
    }
    const guid = tiles[index].guid;
    const others = tiles.filter(t => t.guid !== guid);
    ask("Move", {
      guid,
      afterGuid: others[to - 1]?.guid ?? null,
      beforeGuid: others[to]?.guid ?? null,
    });
    current = to;
    status.textContent = `Moved to position ${to + 1} of ${tiles.length}`;
  }

  // Dragging (spec §11.2): within the row to reorder, or onto a folder's middle
  // half to file it there.

  let dragged = null;

  row.addEventListener("dragstart", event => {
    const el = event.target.closest(".fav-tile");
    if (!el) {
      return;
    }
    dragged = el.dataset.guid;
    event.dataTransfer.setData(DRAG_TYPE, dragged);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setDragImage(el.querySelector(".fav-well"), 32, 32);
    el.classList.add("dragging");
  });

  row.addEventListener("dragend", () => {
    row.querySelector(".dragging")?.classList.remove("dragging");
    clearDropTarget();
    dragged = null;
  });

  function clearDropTarget() {
    drop.hidden = true;
    row.querySelector(".drop-into")?.classList.remove("drop-into");
  }

  /**
   * Where a drop at the pointer lands: into a folder tile, or between two
   * tiles of the row.
   *
   * @param {DragEvent} event
   * @returns {object} `{ folder }` or `{ index, x, top, height }`.
   */
  function dropPlace(event) {
    const all = rowTiles();
    for (const el of all) {
      const box = el.getBoundingClientRect();
      if (
        el.dataset.kind === "folder" &&
        el.dataset.guid !== dragged &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom &&
        event.clientX >= box.left + box.width / 4 &&
        event.clientX <= box.right - box.width / 4
      ) {
        return { folder: el };
      }
    }
    const rowBox = row.getBoundingClientRect();
    let index = all.length;
    for (const [i, el] of all.entries()) {
      const box = el.getBoundingClientRect();
      const sameLine =
        event.clientY < box.bottom && event.clientY >= box.top - 8;
      if (sameLine && event.clientX < box.left + box.width / 2) {
        index = i;
        break;
      }
      if (event.clientY < box.top - 8) {
        index = i;
        break;
      }
    }
    const ref = all[Math.min(index, all.length - 1)]?.getBoundingClientRect();
    if (!ref) {
      return { index: 0, x: 0, top: 0, height: 0 };
    }
    const x = index < all.length ? ref.left - 4 : ref.right + 4;
    return {
      index,
      x: x - rowBox.left + row.offsetLeft,
      top: ref.top - rowBox.top + row.offsetTop + 8,
    };
  }

  row.addEventListener("dragover", event => {
    if (!dragged || !event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropTarget();
    const place = dropPlace(event);
    if (place.folder) {
      place.folder.classList.add("drop-into");
      return;
    }
    drop.hidden = false;
    drop.style.insetInlineStart = `${place.x - 1}px`;
    drop.style.top = `${place.top}px`;
  });

  row.addEventListener("dragleave", event => {
    if (!row.contains(event.relatedTarget)) {
      clearDropTarget();
    }
  });

  row.addEventListener("drop", event => {
    if (!dragged) {
      return;
    }
    event.preventDefault();
    const place = dropPlace(event);
    clearDropTarget();
    if (place.folder) {
      ask("File", { guid: dragged, folderGuid: place.folder.dataset.guid });
      return;
    }
    const others = tiles.filter(t => t.guid !== dragged);
    const from = tiles.findIndex(t => t.guid === dragged);
    const to = place.index > from ? place.index - 1 : place.index;
    if (to === from) {
      return;
    }
    ask("Move", {
      guid: dragged,
      afterGuid: others[to - 1]?.guid ?? null,
      beforeGuid: others[to]?.guid ?? null,
    });
  });

  // A tile's context menu is the Favorites menu's (favorites-native
  // spec §15.2), which the actor opens in place of the page's. On a row tile it
  // carries Move Left and Move Right, how a pointer that cannot drag
  // reorders the row.
  document.addEventListener("contextmenu", event => {
    const el = event.target.closest?.(".fav-tile");
    if (!el) {
      return;
    }
    event.preventDefault();
    const index = row.contains(el)
      ? tiles.findIndex(t => t.guid === el.dataset.guid)
      : -1;
    const first = index === 0;
    const last = index === tiles.length - 1;
    ask("Context", {
      guid: el.dataset.guid,
      screenX: event.screenX * window.devicePixelRatio,
      screenY: event.screenY * window.devicePixelRatio,
      row: index >= 0,
      left: index >= 0 && !(isRtl() ? last : first),
      right: index >= 0 && !(isRtl() ? first : last),
    });
  });

  // The switch (spec §2): the row on or off, every pin kept.
  toggle.addEventListener("click", () => ask("Enabled", { on: !enabled }));

  ask("Init");
})();
