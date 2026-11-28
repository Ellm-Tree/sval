/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalCheckable } from "chrome://browser/content/sval/elements/sval-switch.mjs";

/**
 * Sval's checkbox: a choice a form or a dialog reads when it is sent, drawn
 * by `sval-checkbox.css` as a rounded box with a check from the
 * `--sval-field-check-*` tokens. `SvalCheckable` holds its behaviour.
 */
export class SvalCheckbox extends SvalCheckable {
  static stylesheet =
    "chrome://browser/content/sval/elements/sval-checkbox.css";
}

customElements.define("sval-checkbox", SvalCheckbox);
