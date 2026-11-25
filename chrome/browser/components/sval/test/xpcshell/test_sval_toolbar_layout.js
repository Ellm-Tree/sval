/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The toolbar's layout in the Workspace panel at every width
 * (`SvalToolbarLayout`; panel toolbar widths spec, §3, §4 and §7).
 */

const {
  EDGE,
  GAP,
  KEY_MIN_W,
  NAV_ROW_MIN_W,
  ROWS_MIN_W,
  SETS,
  layout,
  rowsMinWidth,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalToolbarLayout.sys.mjs"
);

/**
 * A 28px cell in a pill with a 1px border and 3px padding at each end.
 *
 * @param {number} cells
 * @returns {number}
 */
const pill = cells => cells * 28 + 8;

/**
 * Sets measured as the header draws them: every item shown, and only the
 * items that never leave (§2).
 *
 * @param {boolean} macos Whether the window's buttons are macOS's.
 * @param {number} extensions Pinned extension buttons.
 * @param {boolean} [privateWindow]
 * @param {boolean} [page] Whether the page shows any of its cluster.
 * @param {boolean} [more] Whether » shows.
 * @returns {{natural: object, min: object}}
 */
function measured(
  macos,
  extensions,
  privateWindow = false,
  page = true,
  more = false
) {
  // macOS's three window buttons, or three 46px caption buttons
  // (`browser.css`, windows).
  const buttons = macos ? 60 : 3 * 46;
  const natural = {
    // 8px, the window's buttons, 12px, the toggle's 36px pill.
    [SETS.WINDOW]: 8 + buttons + 12 + 36,
    [SETS.NAV]: pill(4),
    [SETS.ADDRESS]: 64,
    [SETS.SITE]: pill(8),
    [SETS.PAGE]: pill(3),
    [SETS.TOOLS]: pill(1 + extensions),
  };
  const min = {
    // Wrapped: the toggle under the buttons, both 8px in.
    [SETS.WINDOW]: 8 + buttons,
    // Back stays in rows; Home, Forward and Reload may leave.
    [SETS.NAV]: pill(1),
    [SETS.ADDRESS]: 64,
    [SETS.SITE]: pill(1),
    [SETS.PAGE]: 0,
    [SETS.TOOLS]: pill(1),
  };
  if (more) {
    natural[SETS.OVERFLOW] = min[SETS.OVERFLOW] = pill(1);
  }
  if (!page) {
    delete natural[SETS.PAGE];
    delete min[SETS.PAGE];
  }
  if (privateWindow) {
    natural[SETS.BADGE] = min[SETS.BADGE] = 24;
  }
  return { natural, min };
}

const WIDTHS = Array.from({ length: 600 - 48 + 1 }, (_, i) => 48 + i);
const CASES = [];
for (const macos of [true, false]) {
  for (const extensions of [0, 4, 12]) {
    for (const privateWindow of [false, true]) {
      for (const page of [true, false]) {
        for (const more of [false, true]) {
          CASES.push({ macos, extensions, privateWindow, page, more });
        }
      }
    }
  }
}

/**
 * Calls `check` with every width and kind of window, and its layout.
 *
 * @param {Function} check
 */
function everyWidth(check) {
  for (const { macos, extensions, privateWindow, page, more } of CASES) {
    const { natural, min } = measured(
      macos,
      extensions,
      privateWindow,
      page,
      more
    );
    for (const width of WIDTHS) {
      const result = layout({ width, macos, natural, min });
      check({ width, macos, natural, min, result });
    }
  }
}

add_task(function the_column_stands_below_the_rows_narrowest() {
  everyWidth(({ width, result }) => {
    const want = width < 192;
    if (result.column !== want) {
      Assert.ok(false, `column at ${width}px: ${result.column}`);
    }
  });
  Assert.ok(true, "the column stands below the rows' narrowest only");
});

add_task(function caption_buttons_too_wide_for_the_row_wrap_the_toggle() {
  const { natural, min } = measured(false, 0);
  for (const [width, wrapped] of [
    [192, true],
    [209, true],
    [210, false],
  ]) {
    Assert.equal(
      layout({ width, macos: false, natural, min }).windowWrapped,
      wrapped,
      `the toggle under the caption buttons at ${width}px`
    );
  }
});

add_task(function the_rows_start_at_six_circles_across() {
  for (const { macos, extensions, privateWindow, page, more } of CASES) {
    const { natural, min } = measured(
      macos,
      extensions,
      privateWindow,
      page,
      more
    );
    Assert.equal(
      rowsMinWidth(natural, min),
      ROWS_MIN_W,
      "the rows' narrowest is six circles in a pill across"
    );
  }
});

add_task(function every_set_stands_once_or_has_given_up_everything() {
  everyWidth(({ width, natural, min, result }) => {
    if (result.column) {
      return;
    }
    const placed = result.rows.flat();
    if (new Set(placed).size !== placed.length) {
      Assert.ok(false, `a set stands twice at ${width}px: ${placed}`);
    }
    for (const set of Object.keys(natural)) {
      const w = result.widths[set];
      const stands = placed.includes(set);
      if (stands !== w > 0 || (!stands && min[set])) {
        Assert.ok(false, `${set} at ${width}px: width ${w}, placed ${stands}`);
      }
    }
  });
  Assert.ok(true, "a set stands once, or has given up all it may");
});

add_task(function every_row_fits_the_panel() {
  everyWidth(({ width, result }) => {
    if (result.column) {
      return;
    }
    const inner = width - 2 * EDGE;
    for (const row of result.rows) {
      const used = row.reduce(
        (sum, set) => sum + result.widths[set],
        GAP * (row.length - 1)
      );
      if (used > inner) {
        Assert.ok(false, `[${row}] needs ${used}px of ${inner}px`);
      }
    }
  });
  Assert.ok(true, "every row fits");
});

add_task(function a_set_is_given_between_its_narrowest_and_its_whole() {
  everyWidth(({ width, natural, min, result }) => {
    for (const [set, w] of Object.entries(result.widths)) {
      if (set === SETS.WINDOW) {
        continue;
      }
      const ok =
        w <= natural[set] && (w === 0 ? !min[set] : w >= (min[set] || 36));
      if (!ok) {
        Assert.ok(false, `${set} given ${w}px at ${width}px`);
      }
    }
  });
  Assert.ok(true, "each set's width is between its narrowest and its whole");
});

add_task(function narrowing_takes_room_and_never_gives_it_back() {
  for (const { macos, extensions, privateWindow, page, more } of CASES) {
    const { natural, min } = measured(
      macos,
      extensions,
      privateWindow,
      page,
      more
    );
    let wider = null;
    for (const width of WIDTHS.toReversed()) {
      const result = layout({ width, macos, natural, min });
      if (result.column) {
        break;
      }
      const sameRows =
        wider && wider.rows.flat().join() === result.rows.flat().join();
      if (sameRows) {
        for (const [set, w] of Object.entries(result.widths)) {
          if (w > wider.widths[set]) {
            Assert.ok(false, `${set} grew narrowing to ${width}px`);
          }
        }
      }
      wider = result;
    }
  }
  Assert.ok(true, "a narrower panel gives no set more room");
});

add_task(
  function the_toggle_wraps_under_the_window_buttons_before_the_column() {
    everyWidth(({ width, natural, result }) => {
      if (result.column) {
        return;
      }
      const wraps = natural[SETS.WINDOW] > width - 2 * EDGE;
      if (result.windowWrapped !== wraps) {
        Assert.ok(
          false,
          `window wrapped ${result.windowWrapped} at ${width}px`
        );
      }
      if (wraps && result.rows[0].length !== 1) {
        Assert.ok(false, `the wrapped window row shares itself at ${width}px`);
      }
    });
    Assert.ok(
      true,
      "the toggle wraps under the window buttons before the column"
    );
  }
);

add_task(function navigation_leaves_the_window_row_below_its_width() {
  everyWidth(({ width, macos, natural, result }) => {
    if (result.column) {
      return;
    }
    const fits =
      natural[SETS.WINDOW] + GAP + natural[SETS.NAV] <= width - 2 * EDGE;
    const inWindowRow = result.rows[0].includes(SETS.NAV);
    if (inWindowRow !== (macos && width >= NAV_ROW_MIN_W && fits)) {
      Assert.ok(false, `Navigation at ${width}px, macOS ${macos}`);
    }
  });
  Assert.ok(true, "Navigation joins the window row only on macOS, wide");
});

add_task(function page_joins_navigation_on_its_own_row() {
  everyWidth(({ width, result }) => {
    if (result.column || result.rows[0].includes(SETS.NAV)) {
      return;
    }
    const row = result.rows.find(r => r.includes(SETS.NAV));
    const site = result.rows.find(r => r.includes(SETS.SITE));
    if (site?.includes(SETS.PAGE) || (row.length > 1 && row[1] !== SETS.PAGE)) {
      Assert.ok(false, `Page at ${width}px: [${row}]`);
    }
  });
  Assert.ok(true, "Page stands beside Navigation on its own row");
});

add_task(function the_launcher_key_shows_from_its_width() {
  everyWidth(({ width, result }) => {
    if (result.key !== (!result.column && width >= KEY_MIN_W)) {
      Assert.ok(false, `the key at ${width}px`);
    }
  });
  Assert.ok(true, "the key shows from its width");
});

add_task(function site_controls_and_page_join_side_by_side() {
  everyWidth(({ width, result }) => {
    if (result.column) {
      return;
    }
    const row = result.rows.find(r => r.includes(SETS.SITE)) ?? [];
    const together =
      row.indexOf(SETS.PAGE) > 0 &&
      row.indexOf(SETS.PAGE) === row.indexOf(SETS.SITE) + 1;
    if (result.joined !== together) {
      Assert.ok(false, `joined ${result.joined} at ${width}px`);
    }
  });
  Assert.ok(true, "the two pills join while they stand side by side");
});

add_task(function the_window_row_leads() {
  everyWidth(({ width, result }) => {
    if (!result.column && result.rows[0][0] !== SETS.WINDOW) {
      Assert.ok(false, `the window row leads at ${width}px`);
    }
  });
  Assert.ok(true, "the window row is first");
});
