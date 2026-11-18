/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A remembered choice of client certificate is kept by host and jar. A
 * deleted Workspace's jar is cleared by its origin attributes
 * (`ContextualIdentityService.remove`), and the choices made in it go too.
 */

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

const HOST = "client-auth.example";

add_task(
  async function clearing_a_jar_forgets_its_client_certificate_choices() {
    const service = Cc[
      "@mozilla.org/security/clientAuthRememberService;1"
    ].getService(Ci.nsIClientAuthRememberService);
    const { Permanent, Session } = Ci.nsIClientAuthRememberService;
    const remembered = userContextId =>
      service.hasRememberedDecisionScriptable(HOST, { userContextId }, {});
    // No certificate is a choice too: the one not to send any.
    service.rememberDecisionScriptable(
      HOST,
      { userContextId: 7 },
      null,
      Permanent
    );
    service.rememberDecisionScriptable(
      HOST,
      { userContextId: 8 },
      null,
      Session
    );
    service.rememberDecisionScriptable(HOST, {}, null, Permanent);
    Assert.ok(remembered(7) && remembered(8) && remembered(0), "all are kept");

    for (const userContextId of [7, 8]) {
      await within(
        new Promise(resolve => {
          Services.clearData.deleteDataFromOriginAttributesPattern(
            { userContextId },
            { onDataDeleted: resolve }
          );
        }),
        30_000,
        "the jar's data clearing"
      );
      Assert.ok(!remembered(userContextId), "the jar's choice is forgotten");
    }
    Assert.ok(remembered(0), "the choice made outside any jar stays");
  }
);
