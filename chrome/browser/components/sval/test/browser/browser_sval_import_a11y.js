/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the import page gives a screen-reader or keyboard user: what the
 * accessibility tree says of the page and each row's controls, what its live
 * region says, and where focus lands. First run's import step is the same
 * picker (`import-picker.js`).
 */

/* import-globals-from head.js */

const SvalImport = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);

const { ROLE_GROUPING, ROLE_STATUSBAR } = Ci.nsIAccessibleRole;

/**
 * @param {nsIAccessible} acc
 * @returns {string} the words in the accessible's subtree, in order, as a
 *   screen reader says a live region's.
 */
function textOf(acc) {
  if (!acc.childCount) {
    return acc.role === Ci.nsIAccessibleRole.ROLE_TEXT_LEAF ? acc.name : "";
  }
  let text = "";
  for (let child = acc.firstChild; child; child = child.nextSibling) {
    text += textOf(child);
  }
  return text;
}

/**
 * @param {string} path
 * @returns {nsIFile}
 */
function fileAt(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

/**
 * Opens the import page over this window and waits for it to be drawn.
 *
 * @param {object} roots Where its readers look.
 * @returns {Promise<{closed: Promise, doc: Document}>}
 */
async function openImport(roots) {
  await closeLeftoverDialog();
  const closed = SvalImport.askImport(window, { roots });
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the page opens");
  await dialogShown(gDialogBox.dialog, "the page's load");
  return { closed, doc: gDialogBox.dialog._frame.contentDocument };
}

/**
 * @param {Document} doc
 * @returns {Element} the picker's live region.
 */
function announcer(doc) {
  return doc.querySelector(".sval-im-picker > [role=status]");
}

/** The import page says what it is as it opens, and what its scan found. */
add_task(async function the_import_page_is_named() {
  const page = await openImport({});
  const importDialog = await accessibleOf(page.doc);
  Assert.ok(importDialog.name, "the import page is named");
  Assert.equal(
    importDialog.name,
    page.doc.getElementById("sval-im-title").textContent.trim(),
    "by its title"
  );
  const status = await accessibleOf(announcer(page.doc));
  Assert.equal(status.role, ROLE_STATUSBAR, "it has a live status line");
  await TestUtils.waitForCondition(
    () => announcer(page.doc).dataset.said === "none" && textOf(status),
    "which says what the scan found"
  );
  page.doc.querySelector(".sval-im-cancel").click();
  await page.closed;
});

/**
 * With two browsers open, each row's controls sit in a group named for its
 * browser, so its History box says whose it is, and each workspace name
 * field says which workspace it names. A browser's two profiles are one row.
 */
add_task(async function each_rows_controls_say_whose_they_are() {
  const root = await makeTempDir("sval-import-chrome");
  for (const id of ["Default", "Profile 1"]) {
    const dir = PathUtils.join(root, id);
    await IOUtils.makeDirectory(dir);
    await IOUtils.writeJSON(PathUtils.join(dir, "Bookmarks"), {
      roots: {
        bookmark_bar: {
          type: "folder",
          children: [
            { type: "url", name: "Bar", url: "https://example.com/bar" },
          ],
        },
        other: { type: "folder", children: [] },
        synced: { type: "folder", children: [] },
      },
    });
  }
  await IOUtils.writeJSON(PathUtils.join(root, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Personal" },
        "Profile 1": { name: "Work" },
      },
    },
  });
  const home = await arcFixture();
  const { closed, doc } = await openImport({
    chromium: [{ source: "chrome", dir: root }],
    arc: { home },
  });
  const section = doc;
  await TestUtils.waitForCondition(
    () => section.querySelectorAll(".sval-im-source").length === 2,
    "the step lists Chrome, both its profiles in one row, and Arc"
  );
  for (const tick of section.querySelectorAll(".sval-im-tick")) {
    if (!tick.checked) {
      tick.click();
    }
  }
  for (const row of section.querySelectorAll(".sval-im-source")) {
    const name = row.querySelector(".sval-im-source-name").textContent;
    const group = await accessibleOf(row.querySelector(".sval-im-details"));
    Assert.equal(group.role, ROLE_GROUPING, `${name}'s details are a group`);
    Assert.equal(group.name, name, "named for its row");
  }
  const field = await accessibleOf(
    section.querySelector(".sval-im-window-name")
  );
  Assert.stringContains(
    field.name,
    "Arc Space 1",
    "a name field says which Space it names"
  );
  doc.querySelector(".sval-im-cancel").click();
  await closed;
});

/**
 * A bookmarks file added takes focus on its row, and one Sval cannot read is
 * said, with words for a file rather than a browser.
 */
add_task(async function adding_a_bookmarks_file_is_said() {
  const dir = await makeTempDir("sval-import-file");
  const good = PathUtils.join(dir, "saved.html");
  await IOUtils.writeUTF8(
    good,
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n" +
      '<DT><A HREF="https://example.com/">Example</A>\n</DL><p>\n'
  );
  const missing = PathUtils.join(dir, "missing.html");
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  atTaskEnd(() => MockFilePicker.cleanup());
  MockFilePicker.returnValue = MockFilePicker.returnOK;

  const { closed, doc } = await openImport({});
  const add = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-file:not([hidden]) .sval-im-add-file"),
    "a file can be added"
  );
  MockFilePicker.setFiles([fileAt(good)]);
  add.focus();
  add.click();
  const row = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-source"),
    "the file's row is drawn"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === row.querySelector(".sval-im-tick"),
    "and takes focus"
  );
  Assert.ok(doc.activeElement.checked, "ticked");

  MockFilePicker.setFiles([fileAt(missing)]);
  add.focus();
  add.click();
  const status = await accessibleOf(announcer(doc));
  await TestUtils.waitForCondition(
    () =>
      announcer(doc).dataset.said === "unreadable" &&
      textOf(status).includes("missing.html"),
    "a file sval cannot read is said"
  );
  const bad = doc.querySelectorAll(".sval-im-source")[1];
  Assert.ok(
    bad.hasAttribute("data-problem") && bad.dataset.source === "html",
    "and its row speaks of a file"
  );
  doc.querySelector(".sval-im-cancel").click();
  await closed;
});

/**
 * Coming back from System Settings with Full Disk Access given, Safari's row
 * is drawn again with focus on it, and what Sval can now read is said.
 */
add_task(
  { skip_if: () => AppConstants.platform !== "macosx" },
  async function safari_readable_again_keeps_focus_and_is_said() {
    const home = await makeTempDir("sval-import-safari");
    const safari = PathUtils.join(home, "Library", "Safari");
    await IOUtils.makeDirectory(safari, { createAncestors: true });
    const { closed, doc } = await openImport({ safari: { home } });
    const open = await TestUtils.waitForCondition(
      () => doc.querySelector(".sval-im-access-open"),
      "Safari waits on Full Disk Access"
    );
    open.focus();
    await IOUtils.writeUTF8(
      PathUtils.join(safari, "Bookmarks.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<plist version="1.0"><dict>' +
        "<key>WebBookmarkType</key><string>WebBookmarkTypeList</string>" +
        "<key>Title</key><string></string><key>Children</key><array><dict>" +
        "<key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>" +
        "<key>URLString</key><string>https://example.com/</string>" +
        "<key>URIDictionary</key><dict><key>title</key>" +
        "<string>Example</string></dict>" +
        "</dict></array></dict></plist>"
    );
    // What the window hears as Sval comes back to the front.
    doc.defaultView.dispatchEvent(new doc.defaultView.FocusEvent("focus"));
    const tick = await TestUtils.waitForCondition(
      () => doc.querySelector(".sval-im-tick:not(:disabled)"),
      "Safari can be read"
    );
    Assert.equal(doc.activeElement, tick, "focus is on Safari's row");
    const status = await accessibleOf(announcer(doc));
    await TestUtils.waitForCondition(
      () =>
        announcer(doc).dataset.said === "readable" &&
        textOf(status).includes("Safari"),
      "and what sval can read is said"
    );
    doc.querySelector(".sval-im-cancel").click();
    await closed;
  }
);
