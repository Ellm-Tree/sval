/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's address and card autofill is not built (spec §7.3): its built-in
 * add-on, its form detection and storage, its settings and their dialogs,
 * its sync engines and the import of payment methods from another browser.
 * Form history stays, and still refuses to keep a card number.
 */

/** A file of each removed piece. */
const REMOVED_FILES = [
  "resource://builtin-addons/formautofill/manifest.json",
  "resource://gre-resources/autofill/FormAutofillParent.sys.mjs",
  "resource://gre-resources/autofill/FormAutofillStorage.sys.mjs",
  "resource://gre/modules/shared/FormAutofillUtils.sys.mjs",
  "resource://gre/modules/shared/FormAutofillHeuristics.sys.mjs",
  "resource://gre/actors/FormHandlerChild.sys.mjs",
  "chrome://browser/skin/formautofill-notification.css",
];

add_task(function removed_autofill_files_do_not_ship() {
  Assert.ok(
    packaged("resource://gre/modules/FormHistory.sys.mjs"),
    "form history is found"
  );
  for (const spec of REMOVED_FILES) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(function chrome_has_no_card_field_model() {
  Assert.ok(
    !("getFormAutofillConfidences" in ChromeUtils),
    "ChromeUtils has no card field detection"
  );
});

add_task(async function no_page_gets_the_autofill_actor() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    for (const name of ["FormAutofill", "FormHandler"]) {
      Assert.throws(
        () => browser.browsingContext.currentWindowGlobal.getActor(name),
        /NotFoundError/,
        `no ${name} actor is registered`
      );
    }
  });
});

add_task(function import_offers_no_payment_methods() {
  const { MigrationUtils } = ChromeUtils.importESModule(
    "resource:///modules/MigrationUtils.sys.mjs"
  );
  Assert.ok(
    "HISTORY" in MigrationUtils.resourceTypes,
    "the import resource types are read"
  );
  Assert.ok(
    !("PAYMENT_METHODS" in MigrationUtils.resourceTypes),
    "payment methods are not a resource another browser's data can bring"
  );
});

add_task(function form_history_still_refuses_card_numbers() {
  const { CreditCard } = ChromeUtils.importESModule(
    "resource://gre/modules/CreditCard.sys.mjs"
  );
  Assert.ok(
    CreditCard.isValidNumber("4111111111111111"),
    "a card number is still recognised, so form history leaves it out"
  );
});
