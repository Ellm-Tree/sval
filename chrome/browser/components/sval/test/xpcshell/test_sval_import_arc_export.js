/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Arc's Markdown export as an import source (`SvalImportArcExport.sys.mjs`,
 * import spec §4.2), in the form Arc 1.171 writes it: a `#` heading per
 * Space, a heading one level deeper per folder, and a bare address per tab.
 */

"use strict";

const { parseArcExport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportArcExport.sys.mjs"
);
const { harvest } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportHtml.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const EXPORT = [
  "# Printing",
  "- https://one.example/",
  "- https://two.example/",
  "",
  "## folder",
  "- https://three.example/",
  "",
  "### folder in folder",
  "- https://four.example/",
  "",
  "## Pull Requests",
  "",
  "# Main",
  "",
  "## Basics",
  "- https://five.example/",
  "- arc://boost/x",
  "",
].join("\n");

const tab = url => ({ type: "tab", title: null, url });
const group = (name, children) => ({
  type: "group",
  name,
  color: null,
  children,
});
const space = (name, children) => ({
  kind: "space",
  name,
  emoji: null,
  color: null,
  children,
});

add_task(function spaces_folders_and_tabs_arrive_nested() {
  Assert.deepEqual(parseArcExport(EXPORT), {
    windows: [
      space("Printing", [
        tab("https://one.example/"),
        tab("https://two.example/"),
        group("folder", [
          tab("https://three.example/"),
          group("folder in folder", [tab("https://four.example/")]),
        ]),
      ]),
      space("Main", [group("Basics", [tab("https://five.example/")])]),
    ],
    skipped: 1,
  });
});

add_task(function a_shallower_heading_closes_the_folders_inside_it() {
  const { windows } = parseArcExport(
    [
      "# S",
      "## a",
      "### b",
      "#### c",
      "- https://c.example/",
      "## d",
      "- https://d.example/",
      "### e",
      "- https://e.example/",
    ].join("\r\n")
  );
  Assert.deepEqual(windows[0].children, [
    group("a", [group("b", [group("c", [tab("https://c.example/")])])]),
    group("d", [
      tab("https://d.example/"),
      group("e", [tab("https://e.example/")]),
    ]),
  ]);
});

add_task(function a_space_with_nothing_to_import_is_left_out() {
  Assert.deepEqual(
    parseArcExport("# Empty\n## Live\n\n# Only arc\n- arc://x\n"),
    { windows: [], skipped: 1 }
  );
});

add_task(function a_local_file_address_is_left_out() {
  Assert.deepEqual(
    parseArcExport(
      "# S\n- file:///Users/me/notes.html\n- https://web.example/\n"
    ),
    { windows: [space("S", [tab("https://web.example/")])], skipped: 1 }
  );
});

add_task(async function the_file_picker_reads_a_markdown_file_as_arcs_export() {
  const dir = await makeTempDir("sval-arc-export");
  const path = PathUtils.join(dir, "Arc Data Export.md");
  await IOUtils.writeUTF8(path, EXPORT);
  const harvested = await harvest({ source: "html", dir: path });
  Assert.equal(harvested.windows.length, 2);
  Assert.equal(harvested.bookmarks, null);
  Assert.ok(harvested.file, "a file, with no history or logins to offer");
});
