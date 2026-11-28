/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Firefox's `setting-group` draws Sval's form elements as its controls: it
 * hands each its setting's value (`SettingControl.updated` sets `checked` or
 * `value`), and a user's change reaches the setting through the element's
 * `change` (`SettingGroup.onChange`), with the label and description the
 * config gives drawn by the element and naming its control. A setting
 * changed elsewhere shows in the element, and a locked one disables it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const GROUP_ID = "svalProbeFormControls";

/**
 * A settings page with a group of one switch, one select and one number
 * field, each on a setting held in `store`, and the group's elements.
 *
 * @returns {Promise<object>}
 */
async function groupOfControls() {
  const ui = await openSettings();
  await showPane(ui.page, "svalSync");
  const { Preferences } = ui.page;
  const store = { on: false, when: "900", rate: "4", locked: false };
  for (const [id, key] of [
    ["svalProbeSwitch", "on"],
    ["svalProbeSelect", "when"],
    ["svalProbeField", "rate"],
  ]) {
    Preferences.addSetting({
      id,
      get: () => store[key],
      set: value => {
        store[key] = value;
      },
      disabled: () => store.locked,
    });
  }
  const doc = ui.page.document;
  const group = doc.createElement("setting-group");
  group.setAttribute("groupid", GROUP_ID);
  group.getSetting = Preferences.getSetting.bind(Preferences);
  group.config = {
    controlAttrs: { label: "Probe" },
    items: [
      {
        id: "svalProbeSwitch",
        control: "sval-switch",
        controlAttrs: {
          label: "Show the probe",
          description: "It shows in every window.",
        },
      },
      {
        id: "svalProbeSelect",
        control: "sval-select",
        controlAttrs: { label: "Wait" },
        options: [
          { value: "300", control: "option", controlAttrs: { label: "5" } },
          { value: "900", control: "option", controlAttrs: { label: "15" } },
        ],
      },
      {
        id: "svalProbeField",
        control: "sval-field",
        controlAttrs: { label: "Rate", type: "number" },
      },
    ],
  };
  paneOf(ui.page, "svalSync").prepend(group);
  atTaskEnd(() => group.remove());
  await within(group.updateComplete, 5_000, "the group drawing");
  group.scrollIntoView();
  const controls = [...group.querySelectorAll("setting-control")];
  for (const control of controls) {
    await within(control.updateComplete, 5_000, "a control drawing");
  }
  const [toggle, select, field] = [
    "sval-switch",
    "sval-select",
    "sval-field",
  ].map(tag => group.querySelector(tag));
  for (const el of [toggle, select, field]) {
    await fieldDrawn(el);
  }
  return { ui, store, group, toggle, select, field, Preferences };
}

add_task(async function a_users_change_reaches_its_setting() {
  const { store, toggle, select, field } = await groupOfControls();

  Assert.ok(!toggle.checked, "the switch shows its setting");
  Assert.equal(select.value, "900", "the select shows its setting");
  Assert.equal(field.value, "4", "the field shows its setting");

  EventUtils.synthesizeMouseAtCenter(
    fieldInner(toggle),
    {},
    toggle.documentGlobal
  );
  Assert.strictEqual(store.on, true, "a click on the switch sets its setting");

  await pickOption(select, "300");
  Assert.equal(store.when, "300", "a pick sets the select's setting");

  await typeInto(field, "12");
  Assert.equal(store.rate, "4", "typing alone sets nothing yet");
  EventUtils.synthesizeKey("KEY_Enter", {}, field.documentGlobal);
  Assert.equal(store.rate, "12", "and the committed value sets the setting");
});

add_task(async function the_config_labels_and_describes_its_control() {
  const { toggle, select, field } = await groupOfControls();
  for (const [el, name] of [
    [toggle, "Show the probe"],
    [select, "Wait"],
    [field, "Rate"],
  ]) {
    const label = el.shadowRoot.getElementById("label");
    Assert.ok(label.checkVisibility(), `${el.localName} draws its label`);
    const acc = await accessibleOf(fieldInner(el));
    Assert.equal(acc.name, name, "which names its control");
  }
  const acc = await accessibleOf(fieldInner(toggle));
  Assert.equal(
    acc.description,
    "It shows in every window.",
    "the description describes it"
  );
  const page = toggle.documentGlobal;
  EventUtils.synthesizeMouseAtCenter(
    toggle.shadowRoot.getElementById("label"),
    {},
    page
  );
  Assert.ok(toggle.checked, "a click on the drawn label toggles the switch");
});

add_task(async function a_setting_changed_elsewhere_shows_and_locks() {
  const { store, toggle, select, field, Preferences } = await groupOfControls();
  store.on = true;
  store.when = "300";
  store.rate = "9";
  store.locked = true;
  for (const id of ["svalProbeSwitch", "svalProbeSelect", "svalProbeField"]) {
    Preferences.getSetting(id).onChange();
  }
  for (const el of [toggle, select, field]) {
    await TestUtils.waitForCondition(
      () => fieldInner(el).disabled,
      `${el.localName} locks with its setting`
    );
  }
  Assert.ok(toggle.checked && fieldInner(toggle).checked, "the switch follows");
  Assert.equal(fieldInner(select).value, "300", "the select follows");
  Assert.equal(fieldInner(field).value, "9", "the field follows");
});
