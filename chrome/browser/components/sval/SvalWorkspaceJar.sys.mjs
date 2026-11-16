/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The cookie jar each workspace's tabs use (isolated workspaces spec §2, §4).
 *
 * A shared workspace uses the profile's default jar, `userContextId` 0. An
 * isolated one uses a jar of its own: a non-public contextual identity named
 * for the workspace, which this device makes the first time it needs it. The
 * synced document says only whether a workspace is isolated; the identity is
 * this profile's own, since a `userContextId` means nothing on another
 * device.
 *
 * Non-public identities are the kind Firefox keeps for its own internal jars,
 * so no container menu lists one, no tab is coloured for one and the address
 * bar names none (`workspace-identities.patch`).
 */

const lazy = {};
// "contextual", so the sync worker can load this module, by way of
// `SvalPanelModel`, for `isIsolated`. On the main thread it is the shared
// global, as without it.
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    ContextualIdentityService:
      "resource://gre/modules/ContextualIdentityService.sys.mjs",
  },
  { global: "contextual" }
);

/** Every jar Sval makes is named this plus its workspace's id. */
const PREFIX = "sval.workspace.";

/**
 * Workspaces outside the synced document whose jars stay while they live: a
 * WebDriver window's, on a tree in memory (`SvalWebDriver`). Main thread only.
 *
 * @type {Set<string>}
 */
const held = new Set();

/**
 * Removes `userContextId`'s jar, with its cookies and site data
 * (`ContextualIdentityService.remove`), unless a tab still uses it: that
 * tab's page must not lose its data while it is on screen.
 *
 * @param {number} userContextId
 * @returns {boolean} whether it was removed.
 */
function removeUnused(userContextId) {
  return (
    lazy.ContextualIdentityService.countContainerTabs(userContextId) === 0 &&
    lazy.ContextualIdentityService.remove(userContextId)
  );
}

/**
 * @param {object} nodes The document's nodes, by id.
 * @param {string} workspaceId
 * @returns {boolean} Whether the workspace is isolated. A node with no
 *   `isolated` reads as shared.
 */
export function isIsolated(nodes, workspaceId) {
  return nodes?.[workspaceId]?.lifecycle?.isolated === true;
}

export const SvalWorkspaceJar = {
  isIsolated,

  /**
   * The `userContextId` of the jar `workspaceId`'s tabs use, making the
   * workspace's identity when it is isolated and has none here yet.
   *
   * @param {object} nodes The document's nodes, by id.
   * @param {string|null} workspaceId
   * @returns {number}
   */
  userContextIdFor(nodes, workspaceId) {
    if (!workspaceId || !isIsolated(nodes, workspaceId)) {
      return 0;
    }
    const name = PREFIX + workspaceId;
    const found = lazy.ContextualIdentityService.getPrivateIdentity(name);
    if (found) {
      return found.userContextId;
    }
    return lazy.ContextualIdentityService.create(name, "", "", {
      isPublic: false,
    }).userContextId;
  },

  /**
   * Keeps the jar of `workspaceId`, a workspace the synced document does not
   * hold, from {@link prune} until {@link release}.
   *
   * @param {string} workspaceId
   */
  hold(workspaceId) {
    held.add(workspaceId);
  },

  /**
   * Ends a {@link hold}, and removes the workspace's jar unless a tab still
   * uses it, which a later {@link prune} removes once none does.
   *
   * @param {string} workspaceId
   */
  release(workspaceId) {
    held.delete(workspaceId);
    lazy.ContextualIdentityService.ensureDataReady();
    const found = lazy.ContextualIdentityService.getPrivateIdentity(
      PREFIX + workspaceId
    );
    if (found) {
      removeUnused(found.userContextId);
    }
  },

  /**
   * Removes the jar of every workspace that is no longer isolated here,
   * because it was deleted or stopped being isolated, on this device or
   * another. Removing a jar deletes its cookies and site data
   * (`ContextualIdentityService.remove`), so a jar a tab still uses is left
   * for a later pass: the tab is about to be reopened in its workspace's
   * current jar, and its page must not lose its data while it is on screen.
   * A workspace absent from a non-empty document was deleted, so its jar
   * goes, unless it is held ({@link hold}).
   *
   * @param {object} nodes The document's nodes, by id.
   * @returns {number} how many jars were removed.
   */
  prune(nodes) {
    // An empty document is one not read yet, or a re-key given no tree
    // (`SvalTabObserver.closeOrphanTabs`), never one with no workspace.
    if (!nodes || !Object.keys(nodes).length) {
      return 0;
    }
    // The identities load in an idle task after startup; reading them before
    // that finds none.
    lazy.ContextualIdentityService.ensureDataReady();
    let removed = 0;
    for (const id of lazy.ContextualIdentityService.getPrivateUserContextIds()) {
      const identity = this.identityOf(id);
      if (
        identity &&
        !isIsolated(nodes, identity.workspaceId) &&
        !held.has(identity.workspaceId) &&
        removeUnused(id)
      ) {
        removed++;
      }
    }
    return removed;
  },

  /**
   * @param {number} userContextId
   * @returns {{workspaceId: string}|null} the workspace whose jar this is, or
   *   null for the default jar and every identity Sval did not make.
   */
  identityOf(userContextId) {
    if (!userContextId) {
      return null;
    }
    const name =
      lazy.ContextualIdentityService.getPrivateIdentityFromId(
        userContextId
      )?.name;
    return name?.startsWith(PREFIX)
      ? { workspaceId: name.slice(PREFIX.length) }
      : null;
  },
};
