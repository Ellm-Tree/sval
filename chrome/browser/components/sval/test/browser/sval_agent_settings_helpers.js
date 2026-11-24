/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * What the Agents settings test files share: opening the section, and
 * changing a control as the user does. Each file loads this with
 * `loadSubScript` into its own scope.
 */

/* exported SvalAgents, unpairAll, openAgents, setValue, ruleControl */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

async function unpairAll() {
  for (const { agentId } of SvalAgents.store?.agents() ?? []) {
    await SvalAgents.unpair(agentId);
  }
}

/**
 * Opens settings afresh on the Agents section.
 *
 * @returns {Promise<object>} `openPane`'s result, with `rows` and `row`;
 *   `open(label)`, which opens that agent's page from its row; and `editor()`,
 *   the permissions editor on the page that shows.
 */
async function openAgents() {
  const ui = await openPane(
    "svalAgents",
    ({ byId }) => byId("sval-agents-paired")?.checkVisibility(),
    "the Agents section is showing"
  );
  const rows = () => [
    ...ui.byId("sval-agents-list").querySelectorAll(".sval-agent"),
  ];
  const row = label =>
    rows().find(
      r => r.querySelector(".sval-agent-label").textContent === label
    );
  return {
    ...ui,
    rows,
    row,
    async open(label) {
      row(label).querySelector(".sval-agent-open").click();
      await TestUtils.waitForCondition(
        () =>
          ui.byId("sval-agent-page").checkVisibility() &&
          ui.byId("sval-agent-title").textContent === label &&
          ui.byId("sval-agent-cards").querySelector(".sval-agent-editor"),
        `${label}'s page showing`
      );
    },
    editor: () =>
      ui.byId("sval-agent-cards").querySelector(".sval-agent-editor"),
  };
}

/**
 * A control in a site's rule, with the rule's row opened first when it is
 * closed, as the user opens it to reach the control.
 *
 * @param {Function} editor Returns the permissions editor, which each
 *   change draws afresh.
 * @param {string} selector
 * @returns {?Element}
 */
function ruleControl(editor, selector) {
  const body = editor()
    .querySelector(selector)
    ?.closest(".sval-agent-rule-body");
  if (body?.hidden) {
    body.parentElement.querySelector(".sval-agent-rule-toggle").click();
  }
  return editor().querySelector(selector);
}

/**
 * Sets a control's value as the user would, and fires its event.
 *
 * @param {Window} page
 * @param {Element} control
 * @param {string} value
 * @param {string} [type] The event the control fires.
 */
function setValue(page, control, value, type = "change") {
  control.value = value;
  control.dispatchEvent(new page.Event(type, { bubbles: true }));
}
