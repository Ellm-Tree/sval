/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/** Dragging rows in the panel: where a drop lands, and merges. */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

add_task(async function a_row_is_draggable() {
  const { ids } = await withFreshPanel();
  const row = SvalPanel._rowElementFor(ids.groupA);
  Assert.equal(row.getAttribute("draggable"), "true", "the row is draggable");
});

/**
 * Every node's parent and its place among its siblings: the shape of the
 * tree without the order keys, because a node put back where it was holds a
 * new key for the same place.
 *
 * @param {object} engine A `SvalEngine`.
 * @returns {Promise<object>} node id to `[parent, index]`.
 */
async function treeShape(engine) {
  const nodes = (await engine.tree()).nodes;
  const byParent = SvalTree.childrenByParent(nodes);
  const shape = {};
  for (const [parent, ids] of byParent) {
    ids.forEach((id, index) => (shape[id] = [parent, index]));
  }
  return shape;
}

/**
 * A drag driven by dispatched `DragEvent`s carrying one `DataTransfer`, the
 * way a real session hands the same one to every event of a drag.
 *
 * Used where a real drag cannot go: `synthesizePlainDragAndDrop` sends its
 * `dragover` and its `drop` in one turn, and a merge is only offered after the
 * pointer has rested. The tests that do not need a rest use a real session.
 */
class DispatchedDrag {
  constructor(id) {
    this.dataTransfer = new DataTransfer();
    this.source = SvalPanel._rowElementFor(id);
    this.#send("dragstart", this.source, 0.5);
  }

  // A quarter of the way along by default: in a top-level tab row's middle,
  // that is the New group half, and the split half starts at its centre.
  #send(type, element, fraction, x = null) {
    const rect = element.getBoundingClientRect();
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x ?? rect.left + rect.width / 4,
      clientY: rect.top + rect.height * fraction,
      dataTransfer: this.dataTransfer,
    });
    element.dispatchEvent(event);
    return event;
  }

  /**
   * @param {string} id The row to drag over.
   * @param {number} fraction How far down it, 0 to 1.
   * @param {number} [x] The pointer's clientX, when not a quarter along.
   * @returns {DragEvent} the `dragover`, so a test can ask if it was taken.
   */
  over(id, fraction, x) {
    return this.#send("dragover", SvalPanel._rowElementFor(id), fraction, x);
  }

  drop(id, fraction) {
    return this.#send("drop", SvalPanel._rowElementFor(id), fraction);
  }

  end() {
    this.#send("dragend", this.source, 0.5);
  }
}

/**
 * Collapses group `id`, as its twisty does.
 *
 * @param {string} id
 */
function collapse(id) {
  SvalPanel.settings.setCollapsed(id, true);
  SvalPanel.render();
}

function dragRow(sourceId, targetId, fraction) {
  const target = SvalPanel._rowElementFor(targetId);
  const rect = target.getBoundingClientRect();
  return EventUtils.synthesizeDrop(
    SvalPanel._rowElementFor(sourceId),
    target,
    null,
    "move",
    window,
    window,
    { clientY: rect.top + rect.height * fraction }
  );
}

/**
 * A tab dragged onto a collapsed group's middle goes in as its last child,
 * and the group stays closed.
 */
add_task(async function a_tab_dragged_onto_a_collapsed_group_joins_it() {
  const { engine, ids } = await withFreshPanel();
  collapse(ids.groupB);

  Assert.equal(
    dragRow(ids.loose, ids.groupB, 0.5),
    "move",
    "the drop is taken"
  );

  await TestUtils.waitForCondition(async () => {
    const children = await childrenOf(engine, ids.groupB);
    return children.join() === [ids.tab4, ids.loose].join();
  }, "the tab joined the group, at its end");
  Assert.equal(SvalPanel.draggedId, undefined, "and the drag is over");
  Assert.ok(
    !SvalPanel._els.tree.querySelector(".sval-drop-into, .sval-row-dragging"),
    "with nothing of it left drawn"
  );
});

/**
 * A drop on a row's top edge lands the node above it, between any two rows
 * whatever their kinds, because groups first is only a default.
 */
add_task(async function a_drop_on_an_edge_lands_beside_the_row() {
  const { engine, ids } = await withFreshPanel();

  Assert.equal(
    dragRow(ids.groupB, ids.loose, 0.1),
    "move",
    "the drop is taken"
  );

  await TestUtils.waitForCondition(async () => {
    const children = await childrenOf(engine, ids.workspace);
    return children.join() === [ids.groupA, ids.groupB, ids.loose].join();
  }, "the group landed above the tab it was dropped on");
});

/**
 * What a drop would do is drawn before it is done: a line between rows, at
 * the depth the node will land, a solid outline on a group it will join, and
 * nothing over the node itself, where the drop is refused.
 */
add_task(async function the_drop_under_the_pointer_is_drawn() {
  const { ids } = await withFreshPanel();
  const line = SvalPanel._els.dropLine;

  const drag = new DispatchedDrag(ids.loose);
  try {
    let event = drag.over(ids.tab2, 0.1);
    Assert.ok(event.defaultPrevented, "a row's top edge takes the drop");
    Assert.ok(!line.hidden, "and shows the line");
    Assert.equal(
      parseFloat(line.style.top),
      SvalPanel._rowElementFor(ids.tab2).offsetTop,
      "at the top of that row"
    );
    Assert.equal(
      line.style.getPropertyValue("--sval-drop-depth"),
      "1",
      "indented to the depth the tab will land at, inside the group"
    );

    drag.over(ids.groupA, 0.9);
    Assert.equal(
      parseFloat(line.style.top),
      SvalPanel._rowElementFor(ids.groupA).offsetTop +
        SvalPanel._rowElementFor(ids.groupA).offsetHeight,
      "under an open group's bottom edge the line is at its first child"
    );
    Assert.equal(
      line.style.getPropertyValue("--sval-drop-depth"),
      "1",
      "and indented as one"
    );

    collapse(ids.groupB);
    drag.over(ids.groupB, 0.5);
    Assert.ok(line.hidden, "a collapsed group's middle shows no line");
    Assert.ok(
      SvalPanel._rowElementFor(ids.groupB).classList.contains("sval-drop-into"),
      "but outlines the group the tab will go into"
    );

    event = drag.over(ids.loose, 0.1);
    Assert.ok(
      event.defaultPrevented,
      "over the dragged row itself the drop is a move to where it is"
    );
    Assert.ok(
      line.hidden &&
        !SvalPanel._els.tree.querySelector(".sval-drop-into, .sval-drop-merge"),
      "and draws nothing"
    );
    await TestUtils.waitForCondition(
      () =>
        SvalPanel._rowElementFor(ids.loose).classList.contains(
          "sval-row-dragging"
        ),
      "the dragged row is dimmed once the drag image has been taken"
    );
  } finally {
    drag.end();
  }
  Assert.ok(line.hidden, "ending the drag takes the line away");
  Assert.ok(
    !SvalPanel._els.tree.querySelector(".sval-row-dragging"),
    "and the dimming"
  );
});

/**
 * A group dragged by its row carries everything inside it, so none of that
 * can be a drop target: dropping a group inside itself is a cycle.
 */
add_task(async function a_group_cannot_be_dropped_inside_itself() {
  const { ids } = await withFreshPanel();

  const drag = new DispatchedDrag(ids.groupA);
  try {
    for (const fraction of [0.1, 0.5, 0.9]) {
      Assert.ok(
        !drag.over(ids.tab2, fraction).defaultPrevented,
        `a row inside the dragged group refuses the drop at ${fraction}`
      );
    }
    await TestUtils.waitForCondition(
      () =>
        SvalPanel._rowElementFor(ids.tab3).classList.contains(
          "sval-row-dragging"
        ),
      "and is dimmed with the group carrying it"
    );
    Assert.ok(
      !SvalPanel._rowElementFor(ids.loose).classList.contains(
        "sval-row-dragging"
      ),
      "while the row after the group is not"
    );
  } finally {
    drag.end();
  }
});

/**
 * A tab over another tab's middle offers a new group of the two at once, and
 * says so: the row fades under two halves, New group filled under the
 * pointer and Create Split beside it. The drop asks for the name first, with
 * both rows outlined while it asks, and then makes the group where the
 * target was.
 */
add_task(async function a_tab_dropped_on_a_tab_makes_a_group_of_both() {
  const { engine, ids } = await withFreshPanel();

  {
    const drag = new DispatchedDrag(ids.tab4);
    Assert.ok(
      drag.over(ids.loose, 0.5).defaultPrevented,
      "the middle takes the drop"
    );
    const mark = SvalPanel._els.dropMark;
    const target = SvalPanel._rowElementFor(ids.loose);
    Assert.ok(!mark.hidden, "with its mark");
    Assert.deepEqual(
      [mark.offsetTop, mark.offsetLeft, mark.offsetWidth, mark.offsetHeight],
      [
        target.offsetTop,
        target.offsetLeft,
        target.offsetWidth,
        target.offsetHeight,
      ],
      "over the whole row"
    );
    const half = name => mark.querySelector(`[data-half="${name}"]`);
    Assert.deepEqual(
      [half("group"), half("split")].map(element => [
        element.dataset.kind,
        element.hasAttribute("data-active"),
        element.hasAttribute("data-faint"),
      ]),
      [
        ["newGroup", true, false],
        ["split", false, false],
      ],
      "New group under the pointer, Create Split beside it"
    );
    Assert.equal(mark.dataset.kind, "newGroup", "labelled");
    Assert.equal(
      SvalPanel._els.dropAnnounce.textContent,
      half("group").textContent,
      "and said to a screen reader"
    );
    drag.drop(ids.loose, 0.5);
    drag.end();
    let outlinedWhileAsking = null;
    await answerContainerDialog("Pair", () => {
      outlinedWhileAsking = [ids.loose, ids.tab4].map(id =>
        SvalPanel._rowElementFor(id).classList.contains("sval-drop-merge")
      );
    });

    let group;
    await TestUtils.waitForCondition(async () => {
      const children = await childrenOf(engine, ids.workspace);
      group = children[1];
      return group !== ids.loose && group !== ids.groupB && group;
    }, "a new node took the loose tab's place");
    const nodes = (await engine.tree()).nodes;
    Assert.equal(nodes[group].kind, "group", "it is a group");
    Assert.equal(nodes[group].content.name, "Pair", "named as asked");
    Assert.deepEqual(
      await childrenOf(engine, group),
      [ids.loose, ids.tab4],
      "holding the target first and the dragged tab after it"
    );
    Assert.deepEqual(
      await childrenOf(engine, ids.workspace),
      [ids.groupA, group, ids.groupB],
      "and nothing else moved"
    );
    Assert.deepEqual(
      outlinedWhileAsking,
      [true, true],
      "both rows were outlined while the name was asked"
    );
    Assert.ok(
      !SvalPanel._els.tree.querySelector(".sval-drop-merge"),
      "and are not any more"
    );
  }
});

/**
 * Cancelling the name is changing one's mind: nothing moves and no group is
 * made, because nothing is written until a name is given.
 */
add_task(async function cancelling_the_name_leaves_everything_where_it_was() {
  const { engine, ids } = await withFreshPanel();
  // Where every node is. What a tab says is left out: the page of the tab on
  // screen can give its title while the name is asked.
  const places = async () =>
    JSON.stringify(
      Object.entries((await engine.tree()).nodes).map(([id, node]) => [
        id,
        node.kind,
        node.placement,
      ])
    );
  const before = await places();

  {
    const drag = new DispatchedDrag(ids.tab4);
    drag.over(ids.loose, 0.5);
    Assert.equal(
      SvalPanel._els.dropMark.dataset.kind,
      "newGroup",
      "a tab on a tab's middle offers a group of the two"
    );
    drag.drop(ids.loose, 0.5);
    drag.end();
    Assert.equal(
      await answerContainerDialog(null),
      "new-group",
      "the name was asked"
    );
    await TestUtils.waitForCondition(
      () => !SvalPanel._els.tree.querySelector(".sval-drop-merge"),
      "the outlines are cleared"
    );

    Assert.equal(await places(), before, "and no node was made or moved");
  }
});

/**
 * A merge whose target is closed while its name is asked makes nothing: the
 * group, its place and the move of the dragged tab are refused with the move
 * of the target, so the tree is as the close left it. The redraw is the
 * answer, the target gone and the dragged tab where it was, and the panel
 * says nothing about a close the user may not have made (spec §10.7).
 */
add_task(async function a_merge_whose_target_went_makes_no_group() {
  const { engine, ids } = await withFreshPanel();
  const plan = SvalPanelModel.mergeTarget(SvalPanel.nodes, ids.tab1, ids.tab3);
  Assert.ok(plan, "the two tabs can be merged");

  const drag = new DispatchedDrag(ids.tab1);
  drag.over(ids.tab3, 0.5);
  drag.drop(ids.tab3, 0.5);
  drag.end();
  let closed;
  await answerContainerDialog("Doomed", async () => {
    await engine.mutate({ kind: "remove", id: plan.target, now: Date.now() });
    closed = await engine.treeJson();
  });
  await TestUtils.waitForCondition(
    () => !SvalPanel._rowElementFor(plan.target),
    "the panel redraws without the target"
  );
  Assert.equal(
    await engine.treeJson(),
    closed,
    "the document is exactly as the close left it"
  );
  Assert.deepEqual(
    drawnIds(),
    [ids.groupA, ids.tab1, ids.tab2, ids.loose, ids.groupB, ids.tab4],
    "the panel is redrawn from the engine's tree: no group, the target " +
      "gone, the dragged tab where it was"
  );
});

/**
 * A row in a group is a drop target from its group's indent on, and inside
 * the card of a coloured group nested in another colour: the middle's mark
 * covers that and no more, and the half the mark fills is the half the
 * pointer is on, either side of the mark's centre. Checked on a coloured
 * group's tab and on the selected tab in a nested coloured group's card.
 */
add_task(async function a_middles_mark_keeps_to_the_row_it_is_on() {
  let deep;
  const { ids } = await withFreshPanel({
    async before({ engine, ids: fixture }) {
      const now = Date.now();
      const inner = await engine.mutate({
        kind: "addGroup",
        parent: fixture.groupA,
        name: "Inner",
        id: crypto.randomUUID(),
        now,
      });
      deep = await engine.mutate({
        kind: "addTab",
        parent: inner,
        name: "Deep",
        url: "https://example.com/Deep",
        id: crypto.randomUUID(),
        now,
      });
      SvalPanel.settings.setCollapsed(inner, false);
      for (const [id, color] of [
        [fixture.groupA, "green"],
        [inner, "red"],
      ]) {
        await engine.mutate({
          kind: "setAppearance",
          id,
          color,
          emoji: null,
          now,
        });
      }
    },
  });
  await viewTab(deep);
  const mark = SvalPanel._els.dropMark;
  for (const [id, what] of [
    [ids.tab1, "a coloured group's tab"],
    [deep, "the selected tab in a nested group's card"],
  ]) {
    const row = SvalPanel._rowElementFor(id);
    const drag = new DispatchedDrag(ids.loose);
    try {
      drag.over(id, 0.5);
      Assert.ok(!mark.hidden, `${what} shows the middle's mark`);
      const box = mark.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const name = row.querySelector(".sval-row-name").getBoundingClientRect();
      Assert.greater(box.left, rowBox.left, `${what}: past the group's indent`);
      Assert.lessOrEqual(box.left, name.left, `${what}: from before its name`);
      Assert.lessOrEqual(box.right, rowBox.right, `${what}: within the row`);
      const card = row
        .querySelector(".sval-row-surface[data-inner]")
        ?.getBoundingClientRect();
      if (card) {
        Assert.ok(
          box.left >= card.left &&
            box.right <= card.right &&
            box.top >= card.top &&
            box.bottom <= card.bottom,
          `${what}: inside its card`
        );
      }
      const centre = (box.left + box.right) / 2;
      drag.over(id, 0.5, centre - 2);
      Assert.equal(
        mark.dataset.kind,
        "newGroup",
        `${what}: the start half makes a group`
      );
      drag.over(id, 0.5, centre + 2);
      Assert.equal(
        mark.dataset.kind,
        "split",
        `${what}: the end half makes a split`
      );
    } finally {
      drag.end();
    }
  }
});
