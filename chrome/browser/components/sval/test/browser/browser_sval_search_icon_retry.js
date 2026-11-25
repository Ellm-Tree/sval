/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * An engine's icon that could not be read once is read again the next time
 * it is asked for (`search-icon-retry.patch`), so the address and the
 * Launcher show the engine's icon once it can be read.
 */

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { ConfigSearchEngine } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/ConfigSearchEngine.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

const ICON = "data:image/x-icon;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

add_task(async function an_icon_missed_once_is_read_again() {
  await within(SearchService.init(), 10_000, "the search service");
  const engine = await SearchService.getDefault();
  const handler = ConfigSearchEngine.iconHandler;
  const sandbox = sinon.createSandbox();
  atTaskEnd(() => sandbox.restore());
  sandbox
    .stub(handler, "getAvailableRecords")
    .resolves([{ id: "retry-icon", imageSize: 977 }]);
  const create = sandbox.stub(handler, "createIconURL");
  create.onFirstCall().resolves(null);
  create.onSecondCall().resolves(ICON);
  Assert.equal(
    await engine.getIconURL(977),
    null,
    "the icon is missing at first"
  );
  Assert.equal(
    await engine.getIconURL(977),
    ICON,
    "and is read again once it can be"
  );
  Assert.equal(create.callCount, 2, "with a second lookup");
});
