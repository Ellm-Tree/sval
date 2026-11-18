/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A crash report Sval sent is filed where only Sval's maintainers read it,
 * so about:crashes lists it with no link: Gecko's link goes to Mozilla's
 * crash site, which has no such report.
 */

const { CrashReports } = ChromeUtils.importESModule(
  "resource://gre/modules/CrashReports.sys.mjs"
);

add_task(async function a_sent_crash_report_is_listed_with_no_link() {
  const id = `bp-${Services.uuid.generateUUID().toString().slice(1, -1)}`;
  const dir = await makeTempDir("sval-submitted");
  await IOUtils.writeUTF8(
    PathUtils.join(dir, `${id}.txt`),
    `Crash ID: ${id}\n`
  );
  const real = CrashReports.submittedDir;
  CrashReports.submittedDir = await IOUtils.getFile(dir);
  atTaskEnd(() => {
    CrashReports.submittedDir = real;
  });

  const tab = await openPage("about:crashes");
  const row = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [id],
    async rowId => {
      const found = await ContentTaskUtils.waitForCondition(
        () => content.document.getElementById(rowId),
        "the sent report's row"
      );
      return { links: found.querySelectorAll("a").length };
    }
  );
  Assert.deepEqual(row, { links: 0 }, "the report is listed, with no link");
  BrowserTestUtils.removeTab(tab);
});
