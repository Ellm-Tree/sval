/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Registers Sval's elements in the document that evaluates this module. Each
 * tag's module loads the first time the document creates one, as
 * `customElements.js` does for Firefox's `moz-*` elements, so a document
 * pays only for the elements it uses. `setElementCreationCallback` upgrades
 * any element of the tag already in the document when it registers.
 */

const ELEMENTS = [
  ["sval-button", "chrome://browser/content/sval/elements/sval-button.mjs"],
  ["sval-dialog", "chrome://browser/content/sval/elements/sval-dialog.mjs"],
  ["sval-field", "chrome://browser/content/sval/elements/sval-field.mjs"],
  ["sval-select", "chrome://browser/content/sval/elements/sval-select.mjs"],
  ["sval-switch", "chrome://browser/content/sval/elements/sval-switch.mjs"],
  ["sval-checkbox", "chrome://browser/content/sval/elements/sval-checkbox.mjs"],
];

for (const [tag, url] of ELEMENTS) {
  if (!customElements.get(tag)) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(url, { global: "current" });
    });
  }
}
