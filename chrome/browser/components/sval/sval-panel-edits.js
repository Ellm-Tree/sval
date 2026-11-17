/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Changing the tree from the workspace panel: adding, renaming, editing,
 * closing, deleting, moving and merging rows, isolating a workspace, and the
 * prompts and confirmations those ask.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * Adds a workspace and goes to it.
   *
   * Making a place and then not being taken to it is the odd behaviour: a new
   * workspace is empty, so the window that asked for it is the window that
   * wants to start filling it, and the switcher would otherwise be the only
   * way to reach something the user just created.
   *
   * The workspace and its look are one batch, so it reaches other devices
   * whole.
   */
  async addWorkspace() {
    if (this._inMemory) {
      return;
    }
    const made = await this._promptForNewWorkspace();
    if (made === null) {
      return;
    }
    const id = crypto.randomUUID();
    await this._engine.mutate({
      kind: "batch",
      ops: [
        {
          kind: "addWorkspace",
          name: made.name,
          isolated: made.isolated,
          id,
        },
        ...this._chosenAppearanceOps(id, made),
      ],
      now: this._modules.SvalClock.now(),
    });
    this._settings.setCollapsed(id, false);
    await this.refresh();
    // Before the switch. A window that had no workspace yet (one whose sync
    // pass failed, so `_start` stopped before creating anything) has one now,
    // because the redraw above resolved it, so this is where its observer
    // starts rather than at the next window. `switchTo` then tells that
    // observer where to file, which is why attaching first costs nothing.
    await this._attachTabs();
    await this.switchTo(id);
    await this._select(id);
    this._publishSoon();
  },

  /**
   * The operation that gives a workspace or group being made the colour and
   * emoji its dialog chose, for the batch that makes it; none if it chose
   * neither.
   *
   * @param {string} id The new node.
   * @param {{color: string|object|null, emoji: string|null,
   *   transparency: number|null}} made What
   *   `SvalPanelModel.chosenContainer` returned.
   * @returns {object[]}
   */
  _chosenAppearanceOps(id, made) {
    if (!made.color && !made.emoji) {
      return [];
    }
    return [
      {
        kind: "setAppearance",
        id,
        color: made.color,
        emoji: made.emoji,
        transparency: made.transparency ?? null,
      },
    ];
  },

  /**
   * Asks what a new workspace should be: a name, which is required, and a
   * colour and emoji, which are not.
   *
   * The emoji starts as a random one this system can draw, from
   * `randomWorkspaceEmoji`, shown in the dialog where it can be changed or
   * removed; nothing is written until the user confirms.
   *
   * @param {object} [options]
   * @param {string} [options.name] The name the dialog starts with.
   * @returns {Promise<{name: string, color: string|null, emoji: string|null}|
   *   null>} what to create, or null if the user cancelled.
   */
  async _promptForNewWorkspace({ name = "" } = {}) {
    const { EMOJI_GROUPS, drawableEmojiGroups } = this._modules;
    const { randomWorkspaceEmoji } = this._modules.SvalPanelModel;
    const answer = await this._promptForContainer({
      title: "New Workspace",
      purpose: "new-workspace",
      submitLabel: "Create",
      tintsWindow: true,
      name,
      color: null,
      emoji:
        randomWorkspaceEmoji(drawableEmojiGroups(EMOJI_GROUPS, document)) ?? "",
      isolated: false,
    });
    const made = this._modules.SvalPanelModel.chosenContainer(!!answer, answer);
    return made && { ...made, isolated: answer.isolated === true };
  },

  /**
   * Asks what a new group should be, in the same dialog as a new workspace.
   * Its emoji starts empty: a group is often a short-lived sorting of tabs,
   * and a random emoji on each would be noise the user did not ask for.
   *
   * @returns {Promise<{name: string, color: string|null, emoji: string|null}|
   *   null>} what to create, or null if the user cancelled.
   */
  async _promptForNewGroup() {
    const answer = await this._promptForContainer({
      title: "New group",
      purpose: "new-group",
      submitLabel: "Create",
      tintsWindow: false,
      name: "",
      color: null,
      emoji: "",
    });
    return this._modules.SvalPanelModel.chosenContainer(
      !!answer,
      answer,
      "group"
    );
  },

  /**
   * The dialog behind {@link _promptForNewWorkspace},
   * {@link _promptForNewGroup} and {@link edit}.
   *
   * The dialog cannot open the emoji picker itself (see `SvalNewWorkspace`), so
   * choosing an emoji closes it and this opens the picker, then shows the
   * dialog again with everything the user had entered.
   *
   * @param {{title: string, purpose: string, submitLabel: string,
   *   tintsWindow: boolean, name: string, color: string|object|null,
   *   transparency?: number, emoji: string}} start What the dialog shows
   *   first.
   * @returns {Promise<{name: string, color: string|object|null,
   *   transparency: number, emoji: string}|null>} the dialog's fields as submitted, for
   *   `SvalPanelModel.chosenContainer` to read, or null if the user cancelled.
   */
  async _promptForContainer(start) {
    const { askNewContainer } = this._modules;
    let state = start;
    for (;;) {
      const answer = await askNewContainer(window, state);
      if (answer.action !== "pickEmoji") {
        return answer.action === "create" ? answer : null;
      }
      state = {
        ...start,
        name: answer.name ?? "",
        color: answer.color ?? null,
        transparency: answer.transparency ?? 0,
        emoji: answer.emoji ?? "",
        isolated: answer.isolated,
        ...(answer.lookError && { lookError: true }),
        ...(start.autoArchive && {
          autoArchive: {
            ...start.autoArchive,
            value: answer.autoArchive ?? start.autoArchive.value,
          },
        }),
        focus: "emoji",
      };
      // `undefined` is a dismissed picker, which keeps the emoji the dialog
      // had; `null` is "No emoji".
      const picked = await this._promptForEmoji(state.emoji);
      if (picked !== undefined) {
        state.emoji = picked ?? "";
      }
    }
  },

  /**
   * Opens a tab: at the top of the workspace from the header's button, as
   * Firefox's new-tab command does, and inside the row from a row's context
   * menu, which selects the row before running the command.
   *
   * Nothing is written here and no node is minted: the tab is opened in the
   * window, and the `TabOpen` that follows is what files it. One path for "a
   * tab appeared" is what keeps a row and a tab from disagreeing about where
   * the tab lives.
   *
   * @param {object|null} row The row the command was aimed at, if any.
   */
  _addTab(row) {
    this._observer?.openNewTab({ inSelection: !!row });
  },

  /**
   * Adds a group inside whatever the user is working in, which is what makes
   * the button predictable: the group lands where a link opened in a new tab
   * would have.
   *
   * The engine's `addGroup` takes no position and appends, so the group is
   * then moved to the place a group lands by default, after the groups
   * already there and ahead of the tabs (`SvalPanelModel.defaultSlot`). The
   * group, its look and its place are one batch, so it reaches other devices
   * whole.
   */
  async _addGroup() {
    const { defaultSlot } = this._modules.SvalPanelModel;
    const { GROUP } = this._modules.SvalTree;
    const parent = await this._newTabParent();
    if (!parent) {
      return;
    }
    const made = await this._promptForNewGroup();
    if (made === null) {
      return;
    }
    const id = crypto.randomUUID();
    const nodes = (await this._engine.tree()).nodes ?? {};
    const slot = defaultSlot({ ...nodes, [id]: { kind: GROUP } }, parent, id);
    await this._engine.mutate({
      kind: "batch",
      ops: [
        { kind: "addGroup", parent, name: made.name, id },
        ...this._chosenAppearanceOps(id, made),
        ...(slot.after === null
          ? []
          : [{ kind: "moveNode", id, newParent: parent, ...slot }]),
      ],
      now: this._modules.SvalClock.now(),
    });
    // Spec §5.6 defaults every id this device has not seen to collapsed, which
    // is right for a group arriving from sync and wrong for one just made
    // here: both it and its parent are expanded so the new group is visible.
    this._settings.setCollapsed(parent, false);
    this._settings.setCollapsed(id, false);
    await this.refresh();
    // Focused, so F2 names it and the arrow keys start from it, but not
    // selected: the selection is the active tab's, and a group made beside it
    // does not take that away. A pulse is what finds the row for the eye.
    this._focusRow(id);
    this._flashRow(id, "sval-row-new");
    this._publishSoon();
  },

  /**
   * Renames a node.
   *
   * The engine's `rename` stamps only the content group, so a name set here
   * never competes with a move or a pin another device made (spec §5.1). That
   * is why nothing else in this file may stand in for it: the `add*` calls
   * recompute a node's order key and would silently reorder it, and
   * remove-then-add turns an edit into a deletion, which a peer's concurrent
   * edit is allowed to beat (spec §5.4).
   *
   * The prompt starts from the name the document holds rather than
   * the placeholder a nameless row draws, so accepting the dialog unchanged
   * cannot write a label of Sval's own into the synced document.
   *
   * @param {object} row The row the user asked to rename.
   */
  async _rename(row) {
    if (this._nodes[row.id]?.kind === this._modules.SvalTree.TAB) {
      // A window with one temporary workspace names no tab, as its menu
      // offers no Rename (`SvalPanelModel.contextMenuItems`).
      if (!this._inMemory) {
        await this.renameTab(row.id);
      }
      return;
    }
    const current = this._nodes[row.id]?.content?.name ?? "";
    const name = await this._promptForName(
      `Rename ${this._kindNoun(this._nodes[row.id]?.kind)}`,
      null,
      current
    );
    if (name === null || name === current) {
      return;
    }
    await this._engine.mutate({
      kind: "rename",
      id: row.id,
      name,
      now: this._modules.SvalClock.now(),
    });
    await this.refresh();
    this._focusRow(row.id);
    this._publishSoon();
  },

  /**
   * Rename Tab…: gives a tab a label, shown in place of its page's title
   * however the tab navigates. An empty name is an answer, as Rename Split's
   * is: it takes the label away, and the row shows the page's title again.
   *
   * The label is the engine's `setLabel`, in the appearance group, so a
   * navigation on another device never competes with it (spec §5.1).
   *
   * @param {string} id A tab's node id.
   */
  async renameTab(id) {
    const { openSvalDialog, SvalPanelModel, SvalTree } = this._modules;
    const shown = SvalTree.displayName(this._nodes[id]);
    const answer = await openSvalDialog(window, {
      icon: "pencil",
      title: "Rename Tab",
      body: "A tab with no name shows its page’s title.",
      field: { label: "Name", value: shown, optional: true },
      primary: "Rename",
    });
    const name = SvalPanelModel.chosenOverName(answer.ok, answer.value);
    // The field starts from what the row shows, so accepting it unchanged
    // writes nothing, and a page's title never becomes a label unasked.
    const label = name || null;
    if (
      name === null ||
      name === shown ||
      label === (this._nodes[id]?.appearance?.label ?? null)
    ) {
      return;
    }
    await this.setTabLabel(id, label);
  },

  /**
   * Sets a tab's label, or clears it with null so the tab shows its page's
   * title (Remove Name).
   *
   * @param {string} id A tab's node id.
   * @param {string|null} label
   */
  async setTabLabel(id, label) {
    await this._engine.mutate({
      kind: "setLabel",
      id,
      label,
      now: this._modules.SvalClock.now(),
    });
    await this.refresh();
    this._focusRow(id);
    this._publishSoon();
  },

  /**
   * Edits a workspace or group in the dialog it was created in: its name,
   * colour and emoji, each starting from what the document holds.
   *
   * Save writes inside the dialog (`save` in the state), so a look the engine
   * refuses is said where the person chose it and the dialog stays open for
   * another Save. The rename and the archive choice are written before the
   * look and stay written when it is refused.
   *
   * A changed name is written with `rename`, for the reason {@link _rename}
   * gives. A changed look is written with `setAppearance`, which replaces the
   * appearance group entire (spec §5.1, §5.3), so every field is sent. A
   * colour this build's palette does not know is sent back as the document
   * holds it unless the user picked another: dropping it would delete a colour
   * chosen on a device whose palette is larger than this one's. Stamping only
   * `appearance_at` is what keeps recolouring on one device from losing a
   * rename made on another at the same moment.
   *
   * @param {object} row The workspace or group; only its id is read.
   */
  async edit(row) {
    const { chosenContainer } = this._modules.SvalPanelModel;
    const { WORKSPACE, appearanceOf } = this._modules.SvalTree;
    const node = this._nodes[row.id];
    if (!node) {
      return;
    }
    const held = {
      name: node.content?.name ?? "",
      ...appearanceOf(this._nodes, row.id),
    };
    const ownArchive = this._autoArchiveField(row.id);
    let archived = ownArchive?.value;
    let wrote = false;
    const kind = node.kind === WORKSPACE ? "workspace" : "group";
    const { SvalColor } = this._modules;
    const { sameColor } = SvalColor;
    const save = async fields => {
      const made = chosenContainer(true, fields, kind);
      if (made === null) {
        return { ok: true };
      }
      const keep = sameColor(fields.color, held.color);
      const color = keep ? held.color : made.color;
      const transparency =
        keep && fields.transparency === held.transparency
          ? held.transparency
          : made.transparency;
      if (made.name !== held.name) {
        wrote = true;
        await this._engine.mutate({
          kind: "rename",
          id: row.id,
          name: made.name,
          now: this._modules.SvalClock.now(),
        });
        held.name = made.name;
      }
      if (
        ownArchive &&
        typeof fields.autoArchive === "string" &&
        fields.autoArchive !== archived
      ) {
        // Lifecycle only, so it never competes with the rename or the look.
        wrote = true;
        await this._engine.mutate({
          kind: "setAutoArchive",
          id: row.id,
          choice: fields.autoArchive || null,
          now: this._modules.SvalClock.now(),
        });
        archived = fields.autoArchive;
      }
      if (
        !keep ||
        transparency !== held.transparency ||
        made.emoji !== held.emoji
      ) {
        // Set first: a cancel while this is in flight still follows its write.
        wrote = true;
        try {
          await this._engine.mutate({
            kind: "setAppearance",
            id: row.id,
            color,
            emoji: made.emoji,
            transparency,
            now: this._modules.SvalClock.now(),
          });
        } catch (err) {
          this._modules.SvalLog.warn(
            `edit: the look was not written: ${this._modules.SvalLog.errorName(err)}`
          );
          return { ok: false, field: "look" };
        }
        held.color = color;
        held.emoji = made.emoji;
        held.transparency = transparency;
      }
      return { ok: true };
    };
    // The workspace this window shows tries each colour on the window
    // itself; a closed dialog puts the window's own colour back.
    const live = node.kind === WORKSPACE && row.id === this._currentWorkspaceId;
    const preview = live
      ? (fields, done) =>
          this.previewColor(
            {
              color: SvalColor.colorOf(fields.color, "workspace"),
              transparency: fields.transparency ?? 0,
            },
            done
          )
      : undefined;
    let answer;
    try {
      answer = await this._promptForContainer({
        title: `Edit ${this._kindNoun(node.kind)}`,
        purpose: `edit-${node.kind}`,
        submitLabel: "Save",
        tintsWindow: node.kind === WORKSPACE,
        name: held.name,
        color: held.color,
        transparency: held.transparency ?? 0,
        emoji: held.emoji ?? "",
        ...(ownArchive && { autoArchive: ownArchive }),
        save,
        preview,
      });
      // A cancel after a refused Save still follows a rename that was
      // written.
      if (answer || wrote) {
        await this.refresh();
      }
    } finally {
      if (live) {
        this.previewColor(null);
      }
    }
    if (!answer && !wrote) {
      return;
    }
    this._focusRow(row.id);
    this._publishSoon();
  },

  /**
   * The Edit dialog's field for a workspace's own choice for archiving idle
   * tabs (idle-tab archive spec §5): the global choice, named, then each
   * time and Never, starting on what the document holds. None for a group,
   * for an agent's workspace, which is never archived, or on a tree in
   * memory, which is never swept.
   *
   * @param {string} id A node id.
   * @returns {object|undefined} `{ choices, value }`, or undefined.
   */
  _autoArchiveField(id) {
    const { agentLabelOf } = this._modules.SvalPanelModel;
    const { WORKSPACE } = this._modules.SvalTree;
    if (
      this._inMemory ||
      this._nodes[id]?.kind !== WORKSPACE ||
      agentLabelOf(this._nodes, id) !== null
    ) {
      return undefined;
    }
    const { ARCHIVE_TIMES, AUTO_ARCHIVE_PREF, NEVER, choiceLabel } =
      this._modules;
    const global = Services.prefs.getStringPref(AUTO_ARCHIVE_PREF, NEVER);
    return {
      choices: [
        { value: "", label: `Use Default (${choiceLabel(global)})` },
        ...ARCHIVE_TIMES,
        { value: NEVER, label: choiceLabel(NEVER) },
      ],
      value: this._nodes[id]?.lifecycle?.auto_archive ?? "",
    };
  },

  /**
   * Asks for an emoji, in Sval's picker (`SvalEmojiPicker`) shown in the
   * window's modal dialog.
   *
   * Sval draws its own picker because Gecko cannot open the OS's from chrome
   * code: on macOS it is reachable only through the native Edit menu, on
   * Windows it is Win+. The emoji it offers are data to regenerate
   * (`scripts/generate-emoji-data.py`) when Unicode adds some.
   *
   * @param {string} initial The emoji the document holds, so a dismissal and
   *   an unchanged answer both write nothing.
   * @returns {Promise<string|null|undefined>}
   *   {@link SvalPanelModel.chosenEmoji}'s result.
   */
  async _promptForEmoji(initial = "") {
    const { ok, value } = await this._modules.chooseEmoji(window, initial);
    return this._modules.SvalPanelModel.chosenEmoji(ok, value);
  },

  /**
   * Closes a tab, which deletes its node: there is no closed state, no
   * tombstone and no retention window (spec §5.4). Firefox's own
   * recently-closed list is what makes a closed tab recoverable, locally.
   *
   * Only a tab closes. A tab is a leaf (the engine refuses a tab as a parent,
   * `tree::move_node`), so there is nothing inside it to ask about.
   *
   * @param {string|string[]} id A tab node id, or several.
   */
  async _close(id) {
    await this._removeSubtree(id);
  },

  /**
   * Close on a tab's row: the tab, or every selected row when the row is
   * one of a selection (spec §10.5). A selection closes only when every row
   * of it is a tab, because a group is deleted by an entry that asks first.
   *
   * @param {object} row
   * @returns {Promise<void>|undefined}
   */
  _closeRows(row) {
    if (row.kind !== this._modules.SvalTree.TAB) {
      return undefined;
    }
    const several = this._selectionFor(row);
    if (!several) {
      return this._close(row.id);
    }
    return this._closesSelection(several)
      ? this._deferRemoval(`Closed ${several.length} tabs`, several)
      : undefined;
  },

  /**
   * @param {string[]} ids Selected rows.
   * @returns {boolean} whether Close can close them: every one is a tab.
   */
  _closesSelection(ids) {
    const { TAB } = this._modules.SvalTree;
    return ids.every(id => this._nodes[id]?.kind === TAB);
  },

  /**
   * "New group with selection" (spec §10.5): a new group in the first
   * selected row's place, holding every selected row in its order, asked for
   * and made as a drop of one row onto another makes one ({@link _merge}).
   *
   * @param {object} row The row the menu was opened on.
   * @returns {Promise<boolean>|undefined}
   */
  _groupSelection(row) {
    const several = this._selectionFor(row);
    return several
      ? this._newGroupWith(this._selectionRoots(several))
      : undefined;
  },

  /**
   * Makes a new group in the place of the first of `ids`, holding all of
   * them: "New group with selection", and "Move to group"'s "New group…".
   *
   * @param {string[]} ids The nodes the group takes, in the order they are
   *   drawn.
   * @returns {Promise<boolean>|undefined}
   */
  _newGroupWith(ids) {
    const plan = this._modules.SvalPanelModel.groupSelectionTarget(
      this._nodes,
      ids
    );
    return plan ? this._merge(plan) : undefined;
  },

  /**
   * "Delete group": asks whether the group's contents move out of it or go
   * with it, then deletes the group (spec §5.4).
   *
   * An empty group is deleted without asking. The entry already named the
   * act, and there are no contents to ask about.
   *
   * Moving out is the engine's `removeKeepingChildren`: the group's
   * immediate children go to its parent, in their order, at the group's
   * place, and the group is removed, in one call. A refusal leaves the group
   * standing with everything in it, and is logged.
   *
   * @param {string} id A group id.
   */
  async _deleteGroup(id) {
    const { descendantTabCount, descendantGroupCount, deleteGroupText } =
      this._modules.SvalPanelModel;
    const { GROUP, descendantIds } = this._modules.SvalTree;
    if (this._nodes[id]?.kind !== GROUP) {
      return;
    }
    const name = this._nodes[id]?.content?.name || this._untitled(GROUP);
    const text = `Deleted the “${name}” group`;
    if (!descendantIds(this._nodes, id).length) {
      await this._deferRemoval(text, [id]);
      return;
    }
    const answer = await this._askDeleteGroup(
      deleteGroupText(
        name,
        descendantTabCount(this._nodes, id),
        descendantGroupCount(this._nodes, id)
      )
    );
    if (answer === "delete") {
      await this._deferRemoval(text, [id]);
      return;
    }
    if (answer === "move") {
      await this._deferRemoval(text, [id], { keepContents: true });
    }
  },

  /**
   * "Delete workspace": confirms, then deletes the workspace and everything in
   * it. The confirmation says the tabs go too, and offers no way to keep
   * them: a workspace is a root, with no level above it to move them to
   * (spec §5.4).
   *
   * The window then shows another workspace, by the rule that a window follows
   * the document (spec §10.7). The last workspace is never deleted, because a
   * window with no workspace has nothing to show and no way to make one.
   *
   * @param {string} id A workspace id.
   */
  async _deleteWorkspace(id) {
    const { descendantTabCount, descendantGroupCount, deleteWorkspaceText } =
      this._modules.SvalPanelModel;
    const { WORKSPACE, workspaceIds } = this._modules.SvalTree;
    if (
      this._inMemory ||
      this._nodes[id]?.kind !== WORKSPACE ||
      workspaceIds(this._nodes).length < 2
    ) {
      return;
    }
    const name = this._nodes[id]?.content?.name || this._untitled(WORKSPACE);
    const confirmed = await this._confirmDeleteWorkspace(
      deleteWorkspaceText(
        name,
        descendantTabCount(this._nodes, id),
        descendantGroupCount(this._nodes, id)
      )
    );
    if (confirmed) {
      await this._deferRemoval(`Deleted the “${name}” Workspace`, [id]);
    }
  },

  /**
   * Deletes `id` and everything inside it: a closed tab, a deleted group's
   * contents with it, a deleted workspace.
   *
   * **Closing a row closes the browser.** Every tab this window has for the
   * nodes going closes as a person's close does, so Firefox's recently-closed
   * list can hand it back (`SvalTabObserver.closeNodes`).
   *
   * **The engine deletes the container.** `remove` takes the node with
   * everything the document holds beneath it, and `removeKeepingChildren`
   * moves its children out to its parent first, each in one call, so the
   * contents it acts on are the document's, not the rows this panel last
   * drew, and no peer reads a container half emptied.
   *
   * @param {string|string[]} id A node id, or several, removed in one batch.
   * @param {object} [options]
   * @param {boolean} [options.keepContents] Move what is inside `id` out to
   *   its parent, at its place, and remove `id` alone.
   */
  async _removeSubtree(id, { keepContents = false } = {}) {
    await this.commitPendingDelete();
    const { rowIndexIn } = this._modules.SvalPanelModel;
    const { descendantIds } = this._modules.SvalTree;
    const ids = [id].flat();
    const index = rowIndexIn(this._rows, ids[0]);
    // Every tab event this window has seen is filed first, so a tab just
    // opened inside `id` is among what goes.
    await this._observer?.settled();
    const descendants = keepContents
      ? []
      : ids.flatMap(each => descendantIds(this._nodes, each));

    // Before anything is closed: if these tabs are every tab the window has,
    // the window would close under the awaits below and the rest of this
    // removal would never run: the settings write and the sync pass. A
    // torn-off window showing a one-tab workspace is the ordinary case for
    // that. `SvalTabObserver.keepOneTab` is where the reasoning lives.
    this._observer?.keepOneTab([...descendants, ...ids]);

    if (!keepContents) {
      // The tree as it stood before the delete, which is where each closed
      // tab's node sat.
      const before = this._nodes;
      await this._modules.SvalTabs.removeNodes(
        this._engine,
        this._settings,
        before,
        ids
      );
      // After the delete, so a close that waits on the page's leave prompt
      // finds its node gone and deletes nothing.
      this._observer?.closeNodes([...descendants, ...ids], before);
    } else if (this._nodes[id]) {
      try {
        await this._engine.mutate({
          kind: "removeKeepingChildren",
          id,
          now: this._modules.SvalClock.now(),
        });
      } catch (err) {
        this._logRefusal(id, err);
        await this.refresh();
        return;
      }
      this._settings.forgetLastActive(id);
    }
    // Read as stored, so a selection already gone from `_nodes` is cleared
    // with the rest.
    const selected = this._settings.selectionIn(this._currentWorkspaceId);
    if (ids.includes(selected) || descendants.includes(selected)) {
      this._settings.setSelection(this._currentWorkspaceId, null);
    }
    this._settings.saveSoon();
    await this.refresh();
    // Focus lands where the removed row was, so closing several rows by
    // keyboard does not send focus back to the top of the tree each time.
    if (index >= 0) {
      const landing = this._rows[Math.min(index, this._rows.length - 1)];
      this._focusRow(landing?.id);
    }
    this._publishSoon();
  },

  /**
   * Logs a tree edit the engine refused (a move, a split, a group's removal),
   * by the node's id and the engine's message, which names nodes by id alone.
   *
   * @param {string} id The node the user asked to change.
   * @param {Error} err What the mutation threw.
   */
  _logRefusal(id, err) {
    this._modules.SvalLog.warn(
      `the engine refused an edit of ${id}: ${this._modules.describeError(err)}`
    );
  },

  /**
   * Moves a node one step in a direction: Alt with an arrow, or "Move up" and
   * "Move down" in the context menu. `SvalPanelModel.moveTarget` turns the
   * direction into the sibling pair `moveNode` orders against, and returns
   * null when there is nowhere to go, in which case nothing happens.
   *
   * @param {string} id A node id.
   * @param {string} command One of moveBefore, moveAfter, moveIn, moveOut.
   * @param {string} [focus] The row that keeps the focus: a pane whose split
   *   moves stays the focused pane.
   */
  async _move(id, command, focus = id) {
    const target = this._modules.SvalPanelModel.moveTarget(
      this._nodes,
      id,
      command
    );
    if (target) {
      await this._applyMove(target, { focus });
    }
  },

  /**
   * Files a node, or a selection's nodes in their order, inside `parent`, at
   * the place a node lands when nobody named one
   * (`SvalPanelModel.defaultSlot`): "Move to group" in the context menu.
   *
   * @param {string|string[]} id A node id, or a selection's.
   * @param {string} parent A workspace or group id.
   * @param {string} [focus] The row that keeps the focus, as {@link _move}.
   */
  async _moveInto(id, parent, focus = [id].flat()[0]) {
    const targets = this._modules.SvalPanelModel.moveIntoTargets(
      this._nodes,
      [id].flat(),
      parent
    );
    if (targets.length) {
      await this._applyMove(targets, { focus });
    }
  },

  /**
   * Moves a tab or group, with everything in it, into another workspace
   * (import spec §6). It lands where a moved node lands when nobody named a
   * place (`SvalPanelModel.defaultSlot`). The window stays on its workspace,
   * so any of the moved tabs this window holds leave it, kept in the
   * document, as a switch releases a workspace's tabs; they
   * materialise wherever the other workspace is shown, and one the release
   * kept loaded moves to the window showing it ({@link takeKeptTabs}).
   *
   * A move into an agent's workspace hands what moves to the agent
   * (agent-control spec §5.4): the tree's agent mark makes it the agent's
   * for every check (`SvalAgentTabRegistry`), once the user has agreed.
   *
   * A selection moves in one batch, in its order, after one question
   * (spec §10.5).
   *
   * @param {string|string[]} id A tab or group id, or a selection's nodes.
   * @param {string} workspaceId The workspace to move it to, or the empty
   *   string to make a new one first, as "New workspace…" does.
   * @param {object} [options]
   * @param {string} [options.name] What the new workspace's dialog starts
   *   with.
   */
  async moveToWorkspace(id, workspaceId, { name = "" } = {}) {
    if (this._inMemory) {
      return;
    }
    const { moveIntoTargets } = this._modules.SvalPanelModel;
    const { WORKSPACE } = this._modules.SvalTree;
    const ids = [id].flat();
    let targets;
    let first = [];
    let handOver = null;
    if (workspaceId) {
      const agent = this._modules.SvalPanelModel.agentLabelOf(
        this._nodes,
        workspaceId
      );
      if (agent !== null) {
        handOver = await this._confirmHandToAgent(ids, workspaceId, agent);
      }
      const ok = handOver
        ? handOver.ok
        : await this.confirmJarCrossing(ids, workspaceId);
      if (!ok) {
        return;
      }
      targets = moveIntoTargets(this._nodes, ids, workspaceId);
    } else {
      const made = await this._promptForNewWorkspace({ name });
      if (made === null) {
        return;
      }
      if (!(await this.confirmJarCrossing(ids, null, made))) {
        return;
      }
      // Made in the batch that moves the node into it, so no device is sent
      // an empty workspace and a refused move leaves none behind.
      const destination = crypto.randomUUID();
      first = [
        {
          kind: "addWorkspace",
          name: made.name,
          isolated: made.isolated,
          id: destination,
        },
        ...this._chosenAppearanceOps(destination, made),
      ];
      targets = moveIntoTargets(
        { ...this._nodes, [destination]: { kind: WORKSPACE } },
        ids,
        destination
      );
    }
    // Every moving tab is marked before the move makes it the agent's,
    // whichever window holds it and whether or not it stays loaded: one that
    // comes back at its address alone has no earlier entries to keep.
    if (handOver && !handOver.history) {
      for (const nodeId of handOver.tabs) {
        this._modules.SvalAgentControl.markUserHistory(nodeId);
      }
    }
    if (!targets.length || !(await this._applyMove(targets, { first }))) {
      return;
    }
    if (first.length) {
      // `_applyMove` opens only a parent the panel already knew of.
      this._settings.setCollapsed(targets[0].newParent, false);
      this.render();
    }
    await this.releaseTabsElsewhere();
    // What stayed loaded goes to the window that shows its workspace now.
    const shownBy =
      workspaceId && this.workspacesShownElsewhere().get(workspaceId);
    await shownBy?.SvalPanel?.takeKeptTabs();
    this._publishSoon();
  },

  /**
   * Lets go of every tab in this window whose node is no longer in the
   * workspace the window shows, putting one of the workspace's own on screen
   * first if the selected tab is among them, for the reasons
   * {@link _handOverWindowOnce} gives.
   *
   * @returns {Promise<void>}
   */
  async releaseTabsElsewhere() {
    const observer = this._observer;
    const current = this._currentWorkspaceId;
    if (!observer || !current) {
      return;
    }
    const { descendantIds, TAB } = this._modules.SvalTree;
    const keep = [current, ...descendantIds(this._nodes, current)];
    const selected = observer.nodeIdFor(window.gBrowser.selectedTab);
    if (selected && !keep.includes(selected)) {
      // Only a tab this window holds can be put on screen; a node of the
      // workspace with no tab here would leave the moved tab selected, and a
      // selected tab is never released.
      const tabs = keep.filter(
        n => this._nodes[n]?.kind === TAB && observer.tabFor(n)
      );
      const next = this._mostRecentlyActive(tabs);
      if (!next || !observer.selectNode(next)) {
        observer.openUnfiledTab();
      }
    }
    await observer.releaseTabsOutside(keep, { hold: false });
  },

  /**
   * Makes one move, from whichever route asked for it: a key, the menu, or a
   * drop.
   *
   * **The engine decides whether the move is allowed**, not this method.
   * `tree::move_node` refuses an absent parent, a tab as parent and a move
   * that would cycle, with the document unchanged, and that refusal arrives
   * here as a throw. So nothing device-local is written until the mutation has
   * come back, and a refusal redraws from the engine's tree.
   *
   * A selection's moves are one batch, applied in order, so they land
   * together or not at all.
   *
   * @param {object|object[]} target `{ id, newParent, before, after }`, or
   *   several.
   * @param {object} [options]
   * @param {boolean} [options.flash] Whether to flash the row where it lands,
   *   which a drop wants: the pointer has already let go, and the row can
   *   land some distance from where it was picked up.
   * @param {object[]} [options.first] Operations that make what the move
   *   needs, such as the workspace it goes into, applied in one batch with
   *   it so the two land together or not at all.
   * @param {string|null} [options.focus] The row that takes the focus after,
   *   when it is not the moved node's own.
   * @returns {Promise<boolean>} whether the move happened.
   */
  async _applyMove(target, { flash = false, first = [], focus = null } = {}) {
    const { splitShapeOps } = this._modules.SvalPanelModel;
    const { isWithin } = this._modules.SvalTree;
    const targets = [target].flat();
    const { id } = targets[0];
    // A tree in memory holds the workspace of every window on it; a move
    // never leaves this one.
    if (
      this._inMemory &&
      targets.some(
        each => !isWithin(this._nodes, each.newParent, this._currentWorkspaceId)
      )
    ) {
      return false;
    }
    const reparented = targets.filter(
      each =>
        each.newParent !== (this._nodes[each.id]?.placement?.parent ?? null)
    );
    const moves = targets.map(each => ({
      kind: "moveNode",
      id: each.id,
      newParent: each.newParent,
      before: each.before,
      after: each.after,
    }));
    // A pane moved out of its split leaves the split in shape in the same
    // write (split-view spec §5.2).
    const after = reparented.length
      ? splitShapeOps(
          this._nodes,
          reparented.map(each => each.id)
        )
      : [];
    const ops = [...first, ...moves, ...after];
    try {
      await this._engine.mutate(
        ops.length > 1
          ? { kind: "batch", ops, now: this._modules.SvalClock.now() }
          : { ...moves[0], now: this._modules.SvalClock.now() }
      );
    } catch (err) {
      // The move did not happen (the engine leaves the document byte-for-byte
      // unchanged when it refuses), so the panel must not act as though it
      // did. `refresh` draws from the engine's tree, which is the one place
      // that knows, and the collapse below is not written at all: a parent
      // opened for a node that never arrived in it is this method's own
      // optimism showing on screen. The panel never plans a move the engine
      // refuses, so a refusal means its picture was stale; the redraw is the
      // answer and nothing is said (spec §5.2, §10.7).
      this._logRefusal(id, err);
      await this.refresh();
      this._focusRow(focus ?? id);
      return false;
    }
    // A node moved into a collapsed parent would vanish from the panel, and
    // a move whose result cannot be seen is indistinguishable from a
    // deletion. After the mutation, so a refused move opens nothing.
    for (const parent of new Set(reparented.map(each => each.newParent))) {
      this._expandTo(parent);
    }
    await this.refresh();
    this._focusRow(focus ?? id);
    if (flash) {
      for (const each of targets) {
        this._flashRow(each.id);
      }
    }
    this._publishSoon();
    return true;
  },

  /**
   * Opens `id` and every container above it, so whatever is inside `id` is
   * drawn. "Move to group" can name a group under a collapsed one, and
   * opening only the group itself would still leave the node out of sight.
   *
   * @param {string} id A workspace or group id.
   */
  _expandTo(id) {
    const { ancestorIds } = this._modules.SvalTree;
    const chain =
      id in this._nodes ? [id, ...ancestorIds(this._nodes, id)] : [];
    for (const container of chain) {
      this._settings.setCollapsed(container, false);
    }
  },

  /**
   * Makes a new group holding two nodes: a tab dropped on a tab, or a group
   * dropped on a group.
   *
   * **The group is asked for before anything is written**, in the dialog
   * "New group" uses, and cancelling it is how the user changes their mind:
   * Sval never names a group itself (`_promptForName`), so the dialog is
   * unavoidable, and putting it first means a cancel leaves the document
   * as it was rather than undoing something already done.
   *
   * The group is made in one batch: create it, give it its look, put it
   * where the target was, move the target in, move the dragged node in after
   * it. The engine applies a batch whole or not at all, so no device is ever
   * sent a half-built group, and a refusal leaves the tree as it was.
   *
   * A selection's group is made the same way, from
   * `SvalPanelModel.groupSelectionTarget`, with every selected node moved in
   * in its order.
   *
   * @param {object} plan `SvalPanelModel.mergeTarget`'s answer, or
   *   `groupSelectionTarget`'s with its `members`.
   * @returns {Promise<boolean>} whether the group was made.
   */
  async _merge(plan) {
    const members = plan.members ?? [plan.target, plan.id];
    const focus = plan.id ?? members[0];
    this._pendingMerge = plan;
    this._paintDragState();
    let made;
    try {
      made = await this._promptForNewGroup();
    } finally {
      this._pendingMerge = null;
      this._paintDragState();
    }
    if (made === null) {
      return false;
    }

    const group = crypto.randomUUID();
    try {
      await this._engine.mutate({
        kind: "batch",
        ops: [
          { kind: "addGroup", parent: plan.parent, name: made.name, id: group },
          ...this._chosenAppearanceOps(group, made),
          {
            kind: "moveNode",
            id: group,
            newParent: plan.parent,
            before: plan.before,
            after: plan.after,
          },
          ...members.map((id, index) => ({
            kind: "moveNode",
            id,
            newParent: group,
            before: members[index - 1] ?? null,
            after: null,
          })),
          ...this._modules.SvalPanelModel.splitShapeOps(this._nodes, members),
        ],
        now: this._modules.SvalClock.now(),
      });
    } catch (err) {
      this._logRefusal(focus, err);
      await this.refresh();
      this._focusRow(focus);
      return false;
    }

    this._settings.setCollapsed(group, false);
    this._expandTo(plan.parent);
    await this.refresh();
    this._focusRow(focus);
    // Every row flashes: the group took the first one's place, and the
    // others may have come from anywhere.
    for (const id of members) {
      this._flashRow(id);
    }
    this._publishSoon();
    return true;
  },

  /**
   * Asks for a name.
   *
   * Every name that reaches a Sval document comes through this one call, and
   * it only ever returns what the user typed. **An empty answer is a refusal,
   * and nothing is substituted for it**: a prefilled field that a user
   * confirms without reading writes Sval's words into their data on every
   * device they own.
   *
   * @param {string} title
   * @param {string|null} body A sentence under the title, or null for none.
   * @param {string} [initial] What the field starts with. Only ever a value
   *   the document already holds (a rename starts from the current name),
   *   never a placeholder the panel drew or a label Sval chose.
   * @returns {Promise<string|null>} the name, or null if the user cancelled
   *   or left the field empty.
   */
  async _promptForName(title, body, initial = "") {
    const { openSvalDialog, SvalPanelModel } = this._modules;
    const answer = await openSvalDialog(window, {
      icon: "pencil",
      title,
      body,
      field: { label: "Name", value: initial },
      primary: "Rename",
    });
    return SvalPanelModel.chosenName(answer.ok, answer.value);
  },

  /**
   * Isolates workspace `id` or stops isolating it (isolated workspaces spec
   * §5), once the user has agreed to what it costs. Every tab of the
   * workspace reopens in its new jar, which `_keepJar` does on the refresh
   * this change causes, here and on every other device.
   *
   * @param {string} id A workspace id.
   * @param {boolean} isolated What to make it.
   */
  async _setIsolation(id, isolated) {
    const { isolationText } = this._modules.SvalPanelModel;
    const { WORKSPACE } = this._modules.SvalTree;
    if (this._inMemory || this._nodes[id]?.kind !== WORKSPACE) {
      return;
    }
    if (
      this._modules.SvalWorkspaceJar.isIsolated(this._nodes, id) === isolated
    ) {
      return;
    }
    const { title, body, primary, tone } = isolationText(
      this._nodes[id]?.content?.name || this._untitled(WORKSPACE),
      isolated
    );
    const answer = await this._modules.openSvalDialog(window, {
      title,
      body,
      primary,
      tone,
    });
    if (!answer.ok) {
      return;
    }
    await this._engine.mutate({
      kind: "setIsolation",
      id,
      isolated,
      now: this._modules.SvalClock.now(),
    });
    // An agent paired with the workspace keeps the user's latest choice, for
    // the workspace made for it if this one is deleted.
    await this._modules.SvalAgents.store?.setIsolated(id, isolated);
    await this.refresh();
    this._publishSoon();
  },

  /**
   * Asks before a move takes a tab or group into a workspace with another
   * cookie jar (isolated workspaces spec §6): it opens there fresh, and may
   * have to sign in again. Moves between workspaces sharing a jar ask
   * nothing.
   *
   * @param {string|string[]} id The tab or group moving, or a selection's
   *   nodes, asked about once.
   * @param {string|null} destination The workspace it moves to, or null for
   *   the workspace `made` describes, about to be made.
   * @param {{name: string, isolated: boolean}|null} [made] That new
   *   workspace.
   * @param {string} [source] The workspace it moves from.
   * @param {object} [nodes] The tree to read them in, when the caller's read
   *   is newer than the panel's.
   * @returns {Promise<boolean>} whether to go ahead.
   */
  async confirmJarCrossing(
    id,
    destination,
    made,
    source = this._currentWorkspaceId,
    nodes = this._nodes
  ) {
    const { moveAcrossJarsText } = this._modules.SvalPanelModel;
    const { WORKSPACE } = this._modules.SvalTree;
    if (!this._crossesJar(nodes, source, destination, made)) {
      return true;
    }
    const name = destination
      ? nodes[destination]?.content?.name || this._untitled(WORKSPACE)
      : made.name;
    const { title, body, primary } = moveAcrossJarsText(
      name,
      this._tabsMoving(nodes, id).length
    );
    const answer = await this._modules.openSvalDialog(window, {
      title,
      body,
      primary,
    });
    return answer.ok;
  },

  /**
   * Whether a move from workspace `source` into `destination`, or into the
   * workspace `made` describes, takes tabs into another cookie jar. Two
   * different workspaces share a jar only when neither is isolated.
   *
   * @param {object} nodes
   * @param {string} source
   * @param {string|null} destination
   * @param {{isolated: boolean}|null} [made]
   * @returns {boolean}
   */
  _crossesJar(nodes, source, destination, made = null) {
    const { isIsolated } = this._modules.SvalWorkspaceJar;
    return (
      isIsolated(nodes, source) ||
      (destination ? isIsolated(nodes, destination) : !!made?.isolated)
    );
  },

  /**
   * @param {object} nodes
   * @param {string|string[]} id A tab or group, or a selection's nodes.
   * @returns {string[]} the tab nodes a move of `id` moves, each once.
   */
  _tabsMoving(nodes, id) {
    const { outermostIds } = this._modules.SvalPanelModel;
    const { TAB, descendantIds } = this._modules.SvalTree;
    return outermostIds(nodes, [id].flat())
      .flatMap(each => [each, ...descendantIds(nodes, each)])
      .filter(each => nodes[each]?.kind === TAB);
  },

  /**
   * Asks before a move hands a tab or group to an agent, by taking it into
   * the agent's workspace (agent-control spec §5.4). The one question also
   * says what the move does to its sign-ins, so a move across jars asks
   * nothing more ({@link confirmJarCrossing}).
   *
   * It offers to include the tabs' history only when a tab would take some
   * along: one within one jar, in any window, that a release keeps loaded
   * (`SvalFirefox.mustStayLoaded`, read after a flush, as the release reads
   * it). Any other tab comes back at its node's address alone.
   *
   * A selection is asked about once, for every tab in it (spec §10.5).
   *
   * @param {string|string[]} id The tab or group moving, or a selection's
   *   nodes.
   * @param {string} destination The agent's workspace.
   * @param {string} agent The agent's label.
   * @returns {Promise<{ok: boolean, history: boolean, tabs: string[]}>}
   *   whether to go ahead, whether the user chose to include the history,
   *   and the tab nodes that move.
   */
  async _confirmHandToAgent(id, destination, agent) {
    const nodes = this._nodes;
    const { isIsolated } = this._modules.SvalWorkspaceJar;
    const tabs = this._tabsMoving(nodes, id);
    let signIns = "kept";
    if (isIsolated(nodes, destination)) {
      signIns = "separate";
    } else if (this._crossesJar(nodes, this._currentWorkspaceId, destination)) {
      signIns = "shared";
    }
    let history = false;
    if (signIns === "kept") {
      const { SvalFirefox } = this._modules;
      const held = [];
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        for (const n of tabs) {
          const tab = win.SvalPanel?.observer?.tabFor(n);
          if (tab) {
            held.push([win, tab]);
          }
        }
      }
      for (const [win, tab] of held) {
        if (SvalFirefox.isLazy(tab)) {
          continue;
        }
        await SvalFirefox.flushState(win, tab);
        if (
          SvalFirefox.mustStayLoaded(tab) &&
          tab.linkedBrowser.browsingContext?.sessionHistory?.count > 1
        ) {
          history = true;
          break;
        }
      }
    }
    const answer = await this._modules.openSvalDialog(
      window,
      this._modules.SvalPanelModel.handToAgentText(
        agent,
        tabs.length,
        signIns,
        history
      )
    );
    return { ok: answer.ok, history: history && !!answer.checked, tabs };
  },

  /**
   * Asks whether to delete a workspace. Cancel has focus, because what it
   * guards takes every tab in the workspace with it.
   *
   * @param {{title: string, body: string}} text
   *   {@link SvalPanelModel.deleteWorkspaceText}'s result.
   * @returns {Promise<boolean>} whether the user chose to delete.
   */
  async _confirmDeleteWorkspace({ title, body }) {
    const answer = await this._modules.openSvalDialog(window, {
      icon: "trash",
      tone: "danger",
      title,
      body,
      primary: "Delete Workspace",
    });
    return answer.ok;
  },

  /**
   * Asks what "Delete group" does with the group's contents. Cancel has
   * focus, and Escape answers it, so no key press deletes anything by
   * accident.
   *
   * @param {{title: string, body: string, keep: string, remove: string}} text
   *   {@link SvalPanelModel.deleteGroupText}'s result.
   * @returns {Promise<string|null>} `"move"`, `"delete"`, or null for cancel.
   */
  async _askDeleteGroup({ title, body, keep, remove }) {
    const answer = await this._modules.openSvalDialog(window, {
      icon: "trash",
      tone: "danger",
      title,
      body,
      extra: keep,
      primary: remove,
    });
    if (answer.ok) {
      return "delete";
    }
    return answer.extra ? "move" : null;
  },
});
