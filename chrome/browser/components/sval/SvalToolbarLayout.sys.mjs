/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Where the toolbar's sets stand in the Workspace panel at a width
 * (`docs/superpowers/specs/2026-11-22-panel-toolbar-widths-design.md`, §3
 * and §4). A pure function of the panel's width and the sets' measured
 * widths: `SvalPanelToolbar` measures, calls it, and puts each set in the
 * row it names, so the rows come from here alone.
 */

/** The toolbar's sets, each a toolbar area that draws one pill (§2). */
export const SETS = Object.freeze({
  WINDOW: "window",
  NAV: "nav",
  BADGE: "badge",
  SHIELD: "shield",
  ADDRESS: "address",
  SITE: "site",
  PAGE: "page",
  OVERFLOW: "overflow",
  TOOLS: "tools",
});

/** Below this panel width, Navigation takes a row of its own (§4). */
export const NAV_ROW_MIN_W = 248;
/** Below this panel width, the Launcher key leaves the address (§4). */
export const KEY_MIN_W = 240;
/**
 * At this panel width or less, the panel is the column (§4), as the panel's
 * own narrow layout is (`sval-panel.css`). A wider panel too narrow for its
 * rows snaps clear of them ({@link rowsMinWidth}, `SvalPanel._snapWidth`),
 * so all of it turns at once.
 */
export const COLUMN_MAX_W = 72;
/**
 * The narrowest panel in rows (§4): six circles in a pill across the rows'
 * width, the address whole and Page beside Navigation.
 */
export const ROWS_MIN_W = 192;

/**
 * Half the rows' inline padding: `--sval-panel-start` and
 * `--sval-panel-end` together (`sval-panel.css`).
 */
export const EDGE = 8;
/** The gap between two sets in a row. */
export const GAP = 6;
/** One circle in its pill, as » stands: the narrowest a set shows. */
const OVERFLOW_W = 36;

/**
 * The rows, top to bottom, each with its sets in order and the order they
 * give up room in, last first (§3). Navigation stands in the window row
 * while both fit whole; below that it takes a row of its own, and Page
 * joins it there. Site controls, with Page while it is not with
 * Navigation, take a row; » and Tools take the row under it, or share
 * Site controls' row while all of them fit there whole.
 *
 * @param {boolean} navInWindowRow
 * @param {{[set: string]: number}} natural As `layout` takes it.
 * @param {number} inner The rows' width; 0 for each row on its own.
 * @returns {{sets: string[], gives: string[]}[]}
 */
function rowsOf(navInWindowRow, natural, inner) {
  const rows = navInWindowRow
    ? [{ sets: [SETS.WINDOW, SETS.NAV], gives: [] }]
    : [
        { sets: [SETS.WINDOW], gives: [] },
        { sets: [SETS.NAV, SETS.PAGE], gives: [SETS.PAGE, SETS.NAV] },
      ];
  rows.push({ sets: [SETS.BADGE], gives: [] });
  rows.push({ sets: [SETS.ADDRESS], gives: [] });
  const site = navInWindowRow
    ? { sets: [SETS.SITE, SETS.PAGE], gives: [SETS.PAGE, SETS.SITE] }
    : { sets: [SETS.SITE], gives: [SETS.SITE] };
  const tools = {
    sets: [SETS.OVERFLOW, SETS.TOOLS],
    gives: [SETS.TOOLS],
  };
  const whole = sets => {
    const shown = sets.filter(set => set in natural);
    return (
      shown.reduce((sum, set) => sum + natural[set], 0) +
      GAP * (shown.length - 1)
    );
  };
  if (whole([...site.sets, ...tools.sets]) <= inner) {
    rows.push({
      sets: [...site.sets, ...tools.sets],
      gives: [...tools.gives, ...site.gives],
    });
  } else {
    rows.push(site, tools);
  }
  return rows
    .map(row => ({
      sets: row.sets.filter(set => set in natural),
      gives: row.gives.filter(set => set in natural),
    }))
    .filter(row => row.sets.length);
}

/**
 * The width a row needs with each of its sets at its narrowest, and » in
 * the row with Tools: a set at its narrowest has given up all it may. A set
 * whose narrowest is 0 has nothing that stays, and goes, gap and all.
 *
 * @param {string[]} sets
 * @param {{[set: string]: number}} min
 * @returns {number}
 */
function rowMin(sets, min) {
  const widths = sets
    .map(set => (set === SETS.OVERFLOW ? OVERFLOW_W : min[set]))
    .filter(w => w > 0);
  if (sets.includes(SETS.TOOLS) && !sets.includes(SETS.OVERFLOW)) {
    widths.push(OVERFLOW_W);
  }
  return widths.reduce((sum, w) => sum + w, 0) + GAP * (widths.length - 1);
}

/**
 * The narrowest panel in rows: {@link ROWS_MIN_W}, or wider where every
 * set at its narrowest, the window row wrapped and Navigation on its own
 * row, needs more.
 *
 * @param {{[set: string]: number}} natural As `layout` takes it.
 * @param {{[set: string]: number}} min As `layout` takes it.
 * @returns {number}
 */
export function rowsMinWidth(natural, min) {
  return Math.max(
    ROWS_MIN_W,
    2 * EDGE +
      Math.max(
        0,
        ...rowsOf(false, natural, 0).map(row => rowMin(row.sets, min))
      )
  );
}

/**
 * @typedef {object} Layout
 * @property {boolean} column Whether the panel is the column.
 * @property {string[][]} rows The sets in each row, top to bottom; empty in
 *   the column, where the sets stand in {@link SETS}' order.
 * @property {{[set: string]: number}} widths The width each set in a row is
 *   given: from its natural width down to its narrowest, and 0 for one that
 *   has given up everything. A set gives up items to fit (§2).
 * @property {boolean} joined Whether Site controls and Page are one pill.
 * @property {boolean} windowWrapped Whether the toggle stands under the
 *   window's buttons, the window row being too narrow for both.
 * @property {boolean} key Whether the Launcher key shows.
 */

/**
 * @param {object} input
 * @param {number} input.width The panel's width, in CSS pixels.
 * @param {boolean} input.macos Whether the window's buttons start the
 *   window row; elsewhere they end it, and Navigation takes its own row.
 * @param {{[set: string]: number}} input.natural Each shown set's width
 *   with every item in it. A set left out is not in this window, as the
 *   private badge outside a private window.
 * @param {{[set: string]: number}} input.min Each set's width with only
 *   the items that never leave it; 0 for a set none of whose items stay.
 * @returns {Layout}
 */
export function layout({ width, macos, natural, min }) {
  const inner = width - 2 * EDGE;
  const column = width < rowsMinWidth(natural, min);
  const key = !column && width >= KEY_MIN_W;
  if (column) {
    return {
      column,
      rows: [],
      widths: {},
      joined: false,
      windowWrapped: false,
      key,
    };
  }
  const windowWrapped = natural[SETS.WINDOW] > inner;
  const navInWindowRow =
    !windowWrapped &&
    macos &&
    width >= NAV_ROW_MIN_W &&
    natural[SETS.WINDOW] + GAP + natural[SETS.NAV] <= inner;

  const widths = {};
  const rows = [];
  for (const { sets, gives } of rowsOf(navInWindowRow, natural, inner)) {
    for (const set of sets) {
      widths[set] = natural[set];
    }
    // Each set in its turn gives up room, down to its narrowest, until the
    // row fits; one that gives up everything takes its gap with it.
    const shown = () => sets.filter(set => widths[set] > 0);
    const used = () =>
      shown().reduce((sum, set) => sum + widths[set], 0) +
      GAP * (shown().length - 1);
    for (const set of gives) {
      const over = used() - inner;
      if (over <= 0) {
        break;
      }
      const floor = min[set] ?? 0;
      const left = widths[set] - over;
      if (floor) {
        widths[set] = Math.max(floor, left);
      } else {
        // Narrower than one circle in its pill, a set shows nothing.
        widths[set] = left >= OVERFLOW_W ? left : 0;
      }
    }
    rows.push(shown());
  }
  if (windowWrapped) {
    widths[SETS.WINDOW] = inner;
  }

  // The joined pill draws the divider where the two pills' facing ends
  // were, so it is one pill while both show side by side.
  const joined = rows.some(
    row =>
      row.includes(SETS.SITE) &&
      row.indexOf(SETS.PAGE) === row.indexOf(SETS.SITE) + 1
  );
  return { column, rows, widths, joined, windowWrapped, key };
}
