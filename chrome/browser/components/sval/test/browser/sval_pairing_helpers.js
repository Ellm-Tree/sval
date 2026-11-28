/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the pairing files share: devices with workspaces of their own over a
 * shared folder, a peer that publishes into it, the sentences a pairing
 * attempt produces, and the setup that puts this profile's key back. Each
 * file loads this with `loadSubScript` into its own scope.
 */

/* exported SvalEngine, SvalIdentity, SvalSecretStore, SvalLocalSettings, SvalSharedFolder, SvalPanelModel, SYNC_DOCUMENT, shownReason, asArray, directoryOf, thisDevice, peerPublishing, openSettingsPage, showACode, anotherRequest, codeDialog, submitCode, joinWithCode, lookEnded, offerAndClaim, folderAway */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const { SYNC_DOCUMENT } = SvalTree;

/**
 * The line a pairing result is told as, by its `reason`: "joined", or the
 * failure `SvalPanelModel.pairingLine` names. A result whose `message` is
 * not that line's text answers "message-differs", so a check on the reason
 * also checks the result says it.
 *
 * @param {object} result `SvalPanel.adoptKey`'s answer.
 * @returns {string}
 */
function shownReason(result) {
  const line = SvalPanelModel.pairingLine(result, AppConstants.platform);
  return result.message === line.text ? line.reason : "message-differs";
}

/**
 * Byte arrays compare as plain arrays; `deepEqual` on two typed arrays passes
 * on a length mismatch.
 *
 * @param {Uint8Array|null} value The bytes to compare, or null.
 * @returns {number[]|null} the same bytes as a plain array.
 */
function asArray(value) {
  return value === null ? null : Array.from(value);
}

/**
 * The directory an engine-relative path names, under the storage folder.
 *
 * Every path in a sync report names a position in `sval-core`'s own layout
 * and is `/`-separated whatever this filesystem uses.
 *
 * @param {string} root The storage folder.
 * @param {string} relative An engine-relative path.
 * @returns {string} the absolute directory holding that file.
 */
function directoryOf(root, relative) {
  return PathUtils.parent(PathUtils.join(root, ...relative.split("/")));
}

/**
 * This device: the window's own panel on the profile's engine, sharing a
 * fresh folder it chose through `chooseSharedFolder`, with a workspace of
 * its own published there (`panelOnAFolder`). Each pairing file runs on a
 * fresh profile of its own, so the key a task adopts reaches no other file.
 *
 * @param {string} label Distinguishes this task's temporary paths.
 * @returns {Promise<object>} `{ root, engine, settings, ourKey, workspace,
 *   tab, ourDirectory }`: the shared folder, the profile's engine and
 *   settings, this device's sync key before any join, the task's workspace
 *   and its tab, and the directory that key names in the folder.
 */
async function thisDevice(label) {
  const device = await panelOnAFolder(label, { shared: true });
  const root = SvalPanel.sharedRootSetting();
  const { syncKey } = await svalKeys();
  // Expanded, so the tab under it is a row: these tasks are about what the
  // user would still see.
  device.settings.setCollapsed(device.workspace, false);
  // A device publishes a directory per document it keeps (the tree,
  // Favorites, history), each named for the sync key and the document. The
  // pass after a change to the tree names the tree's.
  await device.engine.mutate({
    kind: "rename",
    id: device.workspace,
    name: "Made on this device",
    now: Date.now(),
  });
  // Whichever step publishes the change says where: a pass that asks the
  // folder waits out a step already running, and that one may be the step
  // that published it, leaving the pass's own step nothing to write.
  let wrote = null;
  const stop = device.engine.addSharedListener(report => {
    if (report.shared === "reached" && report.sharedWrote) {
      wrote = report.sharedWrote;
    }
  });
  try {
    await TestUtils.waitForCondition(
      async () => (await SvalPanel.syncWithFolder()) === "reached" && wrote,
      "this device's pass published its tree to the folder"
    );
  } finally {
    stop();
  }
  const ourDirectory = directoryOf(root, wrote);
  return {
    root,
    engine: device.engine,
    settings: device.settings,
    ourKey: syncKey,
    workspace: device.workspace,
    tab: device.tab,
    ourDirectory,
  };
}

/**
 * Another device, holding the sync key `keyBytes`, that has already published
 * a workspace into `root`. It reads and writes the folder as its own
 * location, so what it holds is what the folder holds under that key.
 *
 * @param {string} root The shared folder.
 * @param {Uint8Array} keyBytes The sync key of the document it belongs to.
 * @param {string} name The workspace's name.
 * @returns {Promise<object>} `{ engine, id, directory }`.
 */
async function peerPublishing(root, keyBytes, name) {
  const engine = new SvalEngine({
    root,
    keyBytes,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(engine));
  const id = await engine.mutate({
    kind: "addWorkspace",
    name,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const report = await engine.sync(SYNC_DOCUMENT, Date.now());
  Assert.notEqual(report.wrote, null, `${name} reached the folder`);
  return { engine, id, directory: directoryOf(root, report.wrote) };
}

/**
 * Opens Sval's settings page the way the panel's pairing buttons do
 * (`openSvalSettings`), with the pairing controls to hand.
 *
 * @param {string} section `"offer"` or `"claim"`.
 * @returns {Promise<object>} `{ tab, page, settings, els }`.
 */
async function openSettingsPage(section) {
  const ui = await openSvalSettings(section);
  const byId = id => ui.page.document.getElementById(id);
  return {
    ...ui,
    els: {
      ...ui.els,
      pairingOpen: byId("sval-pairing-open"),
      offerCode: byId("sval-offer-code"),
      offerStatus: byId("sval-offer-status"),
      offerCountdown: byId("sval-offer-countdown"),
      offerWithdraw: byId("sval-offer-withdraw"),
    },
  };
}

/**
 * Presses Add a device… and waits for the code it shows.
 *
 * @param {object} ui What `openSettingsPage` returned.
 * @returns {Promise<string>} the code on screen.
 */
async function showACode(ui) {
  ui.els.pairingOpen.click();
  await TestUtils.waitForCondition(
    () => ui.els.offerCode.value,
    "a code appeared on the offering side"
  );
  return ui.els.offerCode.value;
}

/**
 * Another request at the helper, as Sval's own folder work makes: a request
 * made after it waits its turn.
 *
 * @param {string} root The folder.
 * @returns {Promise<object>} its answer.
 */
function anotherRequest(root) {
  return SvalSharedFolder.exists({
    root,
    path: "sval",
    deadline: Date.now() + 20_000,
  });
}

/**
 * Opens the Enter code dialog on the page `ui`. A page whose state offers
 * Enter code… opens it from the `claim` address; these tasks are about the
 * claim itself, from whichever state the page is in, so a page that offers
 * none opens it as the button does.
 *
 * @param {object} ui What `openSettingsPage("claim")` returned.
 * @returns {Promise<object>} `svalDialogAsking`'s result.
 */
async function codeDialog(ui) {
  if (!ui.settings._codeDialog) {
    ui.settings.enterCode();
  }
  const win = ui.page.browsingContext.topChromeWindow;
  const asked = await svalDialogAsking(win, "enter-code");
  // The dialog is the window's, and outlives the page: a task's next window
  // dialog would queue behind it.
  atTaskEnd(async () => {
    if (win.gDialogBox.dialog === asked.dialog) {
      asked.cancel.click();
      await svalDialogClosed(win, asked, "the Enter code dialog closing");
    }
  });
  return asked;
}

/**
 * Types `typed` into the Enter code dialog and presses Enter code, as a
 * person does.
 *
 * @param {object} asked `codeDialog`'s result.
 * @param {string} typed
 */
function submitCode(asked, typed) {
  submitInDialog(asked, typed);
}

/** The dialog states in which a look for a code has ended without a join. */
const LOOK_ENDED = ["no-match", "unreadable"];

/**
 * Types `code` into the Enter code dialog of a settings page of its own and
 * waits for the look to end in a join's outcome, a wrong code or a folder it
 * cannot read.
 *
 * @param {string} code
 * @returns {Promise<object>} `{ ui, asked, outcome, said }`: the page,
 *   which the caller closes, the dialog, still up unless the join landed,
 *   the join's `outcome` (absent when there was no join), and what the page
 *   said, as a result line's reason or the dialog's state.
 */
async function joinWithCode(code) {
  const ui = await openSettingsPage("claim");
  const asked = await codeDialog(ui);
  submitCode(asked, code);
  return { ui, asked, ...(await lookEnded(ui, asked)) };
}

/**
 * Waits for the look the Enter code dialog `asked` started to end.
 *
 * @param {object} ui What `openSettingsPage` returned.
 * @param {object} asked `codeDialog`'s result.
 * @returns {Promise<object>} `{ outcome, said }`, as `joinWithCode`.
 */
async function lookEnded(ui, asked) {
  // A join that landed closes the dialog and says so on the Sync card.
  const landed = ui.els.storageStatus;
  const card = ui.els.storage;
  // A claim's Argon2id and the join after it take seconds on a loaded
  // machine, past waitForCondition's default budget.
  await TestUtils.waitForCondition(
    () =>
      landed.dataset.outcome ||
      card.dataset.joinOutcome ||
      LOOK_ENDED.includes(asked.card.state),
    "the look for the code ended",
    250,
    120
  );
  if (landed.dataset.outcome) {
    return { outcome: landed.dataset.outcome, said: landed.dataset.reason };
  }
  return {
    outcome: card.dataset.joinOutcome,
    said: asked.card.state,
  };
}

/**
 * The pairing hop by hand, for a task that hands the claim to the panel
 * itself: the other device offers `keyBytes` under a code, and this device
 * claims it with that code.
 *
 * @param {string} root The shared folder.
 * @param {Uint8Array} keyBytes The key being handed over.
 * @returns {Promise<object>} `{ code, path, claimed }`.
 */
async function offerAndClaim(root, keyBytes) {
  // An adoption's withdrawal can still be running; one helper at a time.
  await SvalSharedFolder._whenIdle();
  const { SvalPairing } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
  );
  const { code, path } = await SvalPairing.offer(root, keyBytes);
  const claimed = await SvalPairing.claim(root, code);
  Assert.equal(claimed.status, "claimed", "the code opened the offer");
  return { code, path, claimed };
}

/**
 * Takes `root`'s `sval/` away, as a share that is not mounted or a folder
 * moved by hand does, until the returned function brings it back.
 *
 * @param {string} root The shared folder.
 * @returns {Promise<Function>} brings `sval/` back.
 */
async function folderAway(root) {
  await SvalSharedFolder._whenIdle();
  const here = PathUtils.join(root, "sval");
  const away = PathUtils.join(root, "sval-away");
  await IOUtils.move(here, away);
  let back = false;
  const bringBack = async () => {
    if (!back) {
      back = true;
      await IOUtils.move(away, here);
    }
  };
  atTaskEnd(bringBack);
  return bringBack;
}
