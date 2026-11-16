/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

// The Workspace panel's costs at scale, run by scripts/perf-panel.sh, which
// puts this file in the build tree's manifest for one run. Each step's median
// time, with the tree reads and renders it took, goes to the run's log and
// to results-<label>.json in SVAL_PERF_OUT.

requestLongerTimeout(40);

const OUT = Services.env.get("SVAL_PERF_OUT");
const DEPTH = 13;
const REPS = 5;
const LABEL = Services.env.get("SVAL_PERF_LABEL") || "run";

function planWorkspace(ops, name, tabs, ids) {
  const ws = crypto.randomUUID();
  ops.push({ kind: "addWorkspace", name, id: ws });
  const chains = Math.max(1, Math.round(tabs / (DEPTH * 15)));
  const groups = chains * DEPTH;
  const perGroup = Math.max(1, Math.ceil(tabs / groups));
  let made = 0;
  const allGroups = [];
  const allTabs = [];
  for (let c = 0; c < chains; c++) {
    let parent = ws;
    for (let d = 0; d < DEPTH; d++) {
      const g = crypto.randomUUID();
      ops.push({ kind: "addGroup", parent, name: `${name} g${c}.${d}`, id: g });
      allGroups.push({ id: g, depth: d, chain: c });
      parent = g;
      for (let t = 0; t < perGroup && made < tabs; t++) {
        const id = crypto.randomUUID();
        ops.push({
          kind: "addTab",
          parent,
          name: `Page ${made} about topic ${made % 97}`,
          url: `https://example${made % 50}.com/page/${made}`,
          id,
        });
        allTabs.push({ id, depth: d });
        made++;
      }
    }
  }
  ids.push({ ws, groups: allGroups, tabs: allTabs, count: made });
}

async function flushFrame() {
  SvalPanel._els.tree.getBoundingClientRect();
  // eslint-disable-next-line no-unused-expressions
  document.documentElement.offsetHeight;
  await within(
    new Promise(r => window.requestAnimationFrame(() => r())),
    10_000,
    "a frame"
  );
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const results = {};
const counts = { tree: 0, render: 0, refresh: 0 };

function countCalls(engine) {
  const tree = engine.tree;
  engine.tree = function (...args) {
    counts.tree++;
    return tree.apply(this, args);
  };
  const render = SvalPanel.render;
  SvalPanel.render = function (...args) {
    counts.render++;
    return render.apply(this, args);
  };
  const refresh = SvalPanel.refresh;
  SvalPanel.refresh = function (...args) {
    counts.refresh++;
    return refresh.apply(this, args);
  };
  return () => {
    delete engine.tree;
    SvalPanel.render = render;
    SvalPanel.refresh = refresh;
  };
}

const PROFILE = (Services.env.get("SVAL_PERF_PROFILE") || "").split(",");

async function measure(size, label, fn, reps = REPS) {
  const profiling = PROFILE.includes(label);
  if (profiling) {
    await Services.profiler.StartProfiler(
      1 << 24,
      1,
      ["js", "stackwalk", "cpu"],
      ["GeckoMain"]
    );
  }
  const total = [];
  const reads = [];
  const renders = [];
  for (let i = 0; i < reps; i++) {
    await flushFrame();
    counts.tree = counts.render = counts.refresh = 0;
    const t0 = performance.now();
    await fn(i);
    await flushFrame();
    total.push(performance.now() - t0);
    reads.push(counts.tree);
    renders.push(counts.render);
  }
  if (profiling) {
    const profile = await Services.profiler.getProfileDataAsync();
    await Services.profiler.StopProfiler();
    await IOUtils.writeUTF8(
      `${OUT}/profile-${LABEL}-${label}.json`,
      JSON.stringify(profile)
    );
  }
  results[size] ??= {};
  results[size][label] = {
    frame: Math.round(median(total) * 10) / 10,
    max: Math.round(Math.max(...total) * 10) / 10,
    reads: median(reads),
    renders: median(renders),
  };
  info(`PERF ${size} ${label} ${JSON.stringify(results[size][label])}`);
}

async function settledObserver() {
  await within(SvalPanel.observer.settled(), 600_000, "the observer settling");
}

async function runSize(total) {
  const engine = SvalPanel._engine;
  const settings = SvalPanel._settings;
  const home = SvalPanel._currentWorkspaceId;
  const ops = [];
  const ids = [];
  const wsCount = total <= 500 ? 5 : 20;
  const bigTabs = Math.round(total / 3);
  planWorkspace(ops, `Big ${total}`, bigTabs, ids);
  const rest = total - bigTabs;
  for (let w = 1; w < wsCount; w++) {
    planWorkspace(ops, `W${w} ${total}`, Math.round(rest / (wsCount - 1)), ids);
  }
  await engine.mutate({ kind: "batch", ops, now: Date.now() });
  const [big, other] = ids;
  for (const each of [big, other]) {
    for (const g of each.groups) {
      settings.setCollapsed(g.id, false);
    }
  }
  // A collapsed group in view, whose media button asks of every tab in it.
  for (const g of big.groups.filter(each => each.depth === DEPTH - 1)) {
    settings.setCollapsed(g.id, true);
  }
  const restore = countCalls(engine);
  try {
    await measure(
      total,
      "switch-into-big",
      async i => {
        if (i) {
          await SvalPanel.switchTo(home);
        }
        await SvalPanel.switchTo(big.ws);
        await settledObserver();
      },
      3
    );
    info(
      `PERF ${total} rows=${SvalPanel._rows.length} tabs=${gBrowser.tabs.length}`
    );

    await measure(total, "first-render", async () => {
      SvalPanel._rowEls = new Map();
      SvalPanel._els.tree.replaceChildren();
      await SvalPanel.refresh();
      await settledObserver();
    });

    await measure(total, "render-unchanged", () => SvalPanel.render());

    await measure(total, "paint-sound", () => SvalPanel._paintSound());

    const titled = big.tabs[3].id;
    await measure(total, "title-change", async i => {
      let nodes = (await engine.tree()).nodes;
      await engine.mutate({
        kind: "setContent",
        id: titled,
        name: `Retitled ${i}`,
        url: nodes[titled].content.url,
        icon: null,
        now: Date.now(),
      });
      nodes = (await engine.tree()).nodes;
      await SvalPanel.refresh(nodes);
      await settledObserver();
    });

    // Real tabs: one opened, then a burst closed at once.
    const opened = [];
    await measure(
      total,
      "open-tab",
      async () => {
        const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
        opened.push(tab);
        await TestUtils.waitForCondition(
          () => SvalPanel.observer.nodeIdFor(tab),
          "filed"
        );
        await settledObserver();
      },
      10
    );
    await measure(
      total,
      "close-10-at-once",
      async () => {
        const closing = opened.splice(0, 10);
        gBrowser.removeTabs(closing, { animate: false });
        await settledObserver();
      },
      1
    );
  } finally {
    restore();
  }

  await SvalPanel.switchTo(home);
  for (const each of ids) {
    for (const g of each.groups) {
      settings.setCollapsed(g.id, true);
    }
  }
  await engine.mutate({
    kind: "batch",
    ops: ids.map(each => ({ kind: "remove", id: each.ws })),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await settledObserver();
}

add_task(async function panel_scale() {
  const sizes = (Services.env.get("SVAL_PERF_SIZES") || "3000")
    .split(",")
    .map(Number);
  for (const size of sizes) {
    await runSize(size);
  }
  await IOUtils.writeUTF8(
    `${OUT}/results-${LABEL}.json`,
    JSON.stringify(results, null, 1)
  );
  ok(true, "measured");
});
