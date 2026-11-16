/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A download an agent's tab is refused leaves nothing (agent-control spec
 * §5.2): no file in the download folder, no entry in Firefox's downloads
 * list or history, and the user's own records of its address untouched.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A download that waits for the user is not in Firefox's downloads list or
 * history, and a denied one never is.
 */
add_task(async function a_denied_download_leaves_no_history() {
  const { call, win, browser, list } = await downloadsSetup();
  const url = `${DOWNLOAD_SJS}?name=history.txt`;
  await pageRuns(browser, `location.href = ${JSON.stringify(url)};`);
  const doc = await alertIn(win);
  Assert.ok(!(await PlacesUtils.history.hasVisits(url)), "not in history");
  Assert.deepEqual(await list.getAll(), [], "nor in the downloads list");
  await choose(doc, "deny");
  await listedAs(call, "history.txt", "denied");
  Assert.ok(!(await PlacesUtils.history.hasVisits(url)), "nor once denied");
  Assert.deepEqual(await list.getAll(), []);
});

/** A refused download leaves the user's own visits to its address alone. */
add_task(async function a_denied_download_keeps_the_users_own_visit() {
  const { PlacesTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PlacesTestUtils.sys.mjs"
  );
  const { call, win, browser } = await downloadsSetup();
  const url = `${DOWNLOAD_SJS}?name=visited.txt`;
  await PlacesTestUtils.addVisits({
    url,
    transition: PlacesUtils.history.TRANSITIONS.LINK,
  });
  atTaskEnd(() => PlacesUtils.history.remove(url));
  await pageRuns(browser, `location.href = ${JSON.stringify(url)};`);
  await choose(await alertIn(win), "deny");
  await listedAs(call, "visited.txt", "denied");
  const visits =
    (await PlacesUtils.history.fetch(url, { includeVisits: true }))?.visits ??
    [];
  Assert.deepEqual(
    visits.map(v => v.transition),
    [PlacesUtils.history.TRANSITIONS.LINK],
    "the user's own visit is there, and no download's"
  );
});

/**
 * A refused download never touches the user's own download notes: the page's
 * record of where the user saved the same address stays as it was.
 */
add_task(async function a_denied_download_keeps_the_users_own_download_note() {
  const { call, win, dir, browser } = await downloadsSetup();
  const url = `${DOWNLOAD_SJS}?name=shared.txt`;
  const usersFile = Services.io.newFileURI(
    new FileUtils.File(PathUtils.join(dir, "mine.txt"))
  ).spec;
  await PlacesUtils.history.insert({
    url,
    visits: [{ transition: PlacesUtils.history.TRANSITIONS.DOWNLOAD }],
  });
  await PlacesUtils.history.update({
    url,
    annotations: new Map([["downloads/destinationFileURI", usersFile]]),
  });
  atTaskEnd(() => PlacesUtils.history.remove(url));
  const note = async () =>
    (
      await PlacesUtils.history.fetch(url, { includeAnnotations: true })
    )?.annotations.get("downloads/destinationFileURI");

  await pageRuns(browser, `location.href = ${JSON.stringify(url)};`);
  const doc = await alertIn(win);
  Assert.equal(
    await note(),
    usersFile,
    "the note is the user's while it waits"
  );
  await choose(doc, "deny");
  await listedAs(call, "shared.txt", "denied");
  Assert.equal(await note(), usersFile, "and once it is denied");
});

/**
 * Starts a download that streams slowly, and waits for its alert and for
 * bytes to arrive into the file Firefox's handler writes as it waits.
 *
 * @param {object} setup What `downloadsSetup` returned.
 * @param {string} name
 * @returns {Promise<Document>} The alert.
 */
async function streaming(setup, name) {
  const { win, browser, dir } = setup;
  const url = `${ROOT}sval_agent_stream.sjs?name=${name}`;
  await pageRuns(browser, `location.href = ${JSON.stringify(url)};`);
  const doc = await alertIn(win);
  await TestUtils.waitForCondition(async () => {
    for (const path of await IOUtils.getChildren(dir)) {
      if ((await IOUtils.stat(path)).size > 0) {
        return true;
      }
    }
    return false;
  }, "bytes are arriving");
  return doc;
}

/**
 * Checks a download refused while it streamed left nothing: no file, and
 * no entry in Firefox's list.
 *
 * @param {object} setup What `downloadsSetup` returned.
 */
async function leftNothing(setup) {
  const { dir, list } = setup;
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.getChildren(dir)).length,
    "nothing is left in the download folder"
  );
  Assert.deepEqual(await list.getAll(), [], "nor in Firefox's list");
}

add_task(async function deny_while_bytes_arrive_leaves_nothing() {
  const setup = await downloadsSetup();
  const doc = await streaming(setup, "deny.bin");
  await choose(doc, "deny");
  await listedAs(setup.call, "deny.bin", "denied");
  await leftNothing(setup);
});

add_task(async function access_off_while_bytes_arrive_leaves_nothing() {
  const setup = await downloadsSetup();
  await streaming(setup, "off.bin");
  // Access going off closes the agent's connection, so what is left to see
  // is the folder and Firefox's list.
  await agentAccessOff();
  await leftNothing(setup);
});
