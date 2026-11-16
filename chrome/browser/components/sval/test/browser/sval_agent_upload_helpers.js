/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the `upload_file` test files share (agent-control spec §4.4, §5.2):
 * an agent's tab holding file inputs, fresh files to send, and readers of
 * what the page received. Each file loads this with `loadSubScript` into its
 * own scope.
 */

/* exported AGENT_DIR, Subprocess, resolved, symlink, filesNamed, uploadSetup, filesIn, contentsIn, eventsIn */

const { AGENT_DIR, SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

/**
 * @param {string} path
 * @returns {string} `path` with every symlink on it resolved, as Sval shows
 *   it to the user.
 */
function resolved(path) {
  const file = new FileUtils.File(path);
  file.normalize();
  return file.path;
}

/**
 * Makes `link` a symlink to `target`. Windows needs a privilege for one, so
 * the tests that use one run on macOS and Linux.
 *
 * @param {string} target
 * @param {string} link
 */
async function symlink(target, link) {
  const ln = await Subprocess.pathSearch("ln");
  const proc = await Subprocess.call({
    command: ln,
    arguments: ["-s", target, link],
  });
  Assert.equal((await proc.wait()).exitCode, 0, "the symlink was made");
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Files in a fresh directory, removed when the task ends.
 *
 * @param {...string} names
 * @returns {Promise<{dir: string, paths: string[]}>}
 */
async function filesNamed(...names) {
  const dir = await makeTempDir("sval-agent-upload");
  atTaskEnd(() => IOUtils.remove(dir, { recursive: true }));
  const paths = [];
  for (const name of names) {
    const path = PathUtils.join(dir, name);
    await IOUtils.writeUTF8(path, `contents of ${name}`);
    paths.push(path);
  }
  return { dir, paths };
}

/**
 * An agent's tab on the test page with file inputs added, and their refs.
 *
 * @param {object} [options] For `agentSetup`.
 * @returns {Promise<object>}
 */
async function uploadSetup(options) {
  const setup = await agentSetup({
    sites: { "example.com": "full" },
    ...options,
  });
  const { call, tabs, agent } = setup;
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const holder = doc.createElement("div");
    holder.innerHTML =
      "<input type=file id=many multiple aria-label=Many>" +
      "<input type=file id=one aria-label=One>" +
      "<button id=plain>Plain</button>";
    doc.body.prepend(holder);
    doc.body.dataset.events = "";
    for (const input of doc.querySelectorAll("input[type=file]")) {
      for (const type of ["input", "change"]) {
        input.addEventListener(type, () => {
          doc.body.dataset.events += `${input.id}:${type} `;
        });
      }
    }
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = re => snapshot.match(re)[1];
  return {
    ...setup,
    tab,
    browser,
    many: ref(/"Many" \[(e\d+)\]/),
    one: ref(/"One" \[(e\d+)\]/),
    plain: ref(/button "Plain" \[(e\d+)\]/),
  };
}

/**
 * @param {object} browser
 * @param {string} id
 * @returns {Promise<string[]>} The names of the files the input holds.
 */
const filesIn = (browser, id) =>
  SpecialPowers.spawn(browser, [id], inputId =>
    Array.from(content.document.getElementById(inputId).files, f => f.name)
  );

/**
 * @param {object} browser
 * @param {string} id
 * @returns {Promise<string[]>} What the files the input holds contain.
 */
const contentsIn = (browser, id) =>
  SpecialPowers.spawn(browser, [id], inputId =>
    Promise.all(
      Array.from(content.document.getElementById(inputId).files, f => f.text())
    )
  );

/**
 * @param {object} browser
 * @returns {Promise<string>} The input and change events the page saw.
 */
const eventsIn = browser =>
  SpecialPowers.spawn(browser, [], () =>
    content.document.body.dataset.events.trim()
  );
