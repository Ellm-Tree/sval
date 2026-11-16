/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file Sval's own lint rules: the teardown and waiting shapes that make
 * Sval's tests flaky, the hand-rolled queue, and an error's name logged
 * without `SvalLog.errorName`. Each turns a slow machine
 * into a red run, or one test's leftovers into another test's failure.
 * `chrome/browser/components/sval/test/CLAUDE.md` gives each test rule's fix;
 * `browser/components/sval/.eslintrc.mjs` says which files each rule covers.
 */

import baseline from "./baseline.mjs";
import accessibleRead from "./rules/accessible-read.mjs";
import addressWait from "./rules/address-wait.mjs";
import { baselined, staleBaseline } from "./baselined.mjs";
import bareTerminate from "./rules/bare-terminate.mjs";
import cleanupWait from "./rules/cleanup-wait.mjs";
import errorName from "./rules/error-name.mjs";
import frameWait from "./rules/frame-wait.mjs";
import handRolledQueue from "./rules/hand-rolled-queue.mjs";
import nativeInput from "./rules/native-input.mjs";
import numberedName from "./rules/numbered-name.mjs";
import panelGetter from "./rules/panel-getter.mjs";
import rawConditionWait from "./rules/raw-condition-wait.mjs";
import tabSwitch from "./rules/tab-switch.mjs";
import tickLoop from "./rules/tick-loop.mjs";
import timerWait from "./rules/timer-wait.mjs";
import uiWording from "./rules/ui-wording.mjs";
import unawaitedDetach from "./rules/unawaited-detach.mjs";
import unboundedWait from "./rules/unbounded-wait.mjs";

/** The rules a file not yet migrated may keep hits of (`baseline.mjs`). */
export const BASELINED_RULES = {
  "accessible-read": accessibleRead,
  "address-wait": addressWait,
  "bare-terminate": bareTerminate,
  "cleanup-wait": cleanupWait,
  "frame-wait": frameWait,
  "native-input": nativeInput,
  "tab-switch": tabSwitch,
  "tick-loop": tickLoop,
  "timer-wait": timerWait,
  "unawaited-detach": unawaitedDetach,
  "unbounded-wait": unboundedWait,
};

const rules = {
  "error-name": errorName,
  "hand-rolled-queue": handRolledQueue,
  "numbered-name": numberedName,
  "panel-getter": panelGetter,
  "raw-condition-wait": rawConditionWait,
  "stale-baseline": staleBaseline(BASELINED_RULES, baseline),
  "ui-wording": uiWording,
};
for (const [name, rule] of Object.entries(BASELINED_RULES)) {
  rules[name] = baselined(name, rule, baseline);
}

export default {
  meta: { name: "eslint-plugin-sval" },
  rules,
};
