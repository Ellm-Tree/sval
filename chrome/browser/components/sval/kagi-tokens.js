/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Says when the private-window allowance resets. The page has the system
 * principal, so it reads the date from `SvalKagiPrivacyPass` itself.
 */
const { SvalKagiPrivacyPass } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);

const until = SvalKagiPrivacyPass.outUntil();
if (until > Date.now()) {
  const date = new Date(until).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
  document.getElementById("sval-kagi-tokens-reset").textContent =
    `Private windows sign in to Kagi with Privacy Pass, and Kagi allows a set number each month. They reset on ${date}.`;
}
