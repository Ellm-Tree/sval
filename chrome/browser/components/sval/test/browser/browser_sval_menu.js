/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * SvalMenu: menus built from item data, their commands, submenus,
 * separators, checks, keys, openings, removal, `choose`, the keyboard, their
 * accessibles and their colours.
 */

const { SvalMenu, MENU_ID_ATTR } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMenu.sys.mjs"
);
const { MENU_KEYS, ariaShortcut } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

/**
 * Removes a menu the task made when the task ends.
 *
 * @param {{popup: Element}} handle
 * @returns {{popup: Element}} `handle`.
 */
function made(handle) {
  atTaskEnd(() => handle.popup.remove());
  return handle;
}

function anchor() {
  return document.getElementById("reload-button");
}

async function close(handle) {
  const hidden = BrowserTestUtils.waitForPopupEvent(handle.popup, "hidden");
  handle.close();
  await within(hidden, 10_000, "the menu hiding");
}

// Sval's default window is see-through where the system allows it: the
// file's tasks check the solid look, and make a window see-through where
// they check that look.
add_setup(() => windowSeeThrough(false));

add_task(async function test_items_build_and_rebuild() {
  let round = 0;
  const handle = made(
    SvalMenu.create(document, {
      name: "sval-test-menu",
      build: () => {
        round++;
        return [
          { id: "first", label: "First" },
          "separator",
          { id: "gone", label: "Gone", hidden: true },
          "separator",
          { id: "round", label: "Round", data: round },
          ...(round > 1 ? [{ id: "second-round", label: "Again" }] : []),
          "separator",
        ];
      },
    })
  );
  Assert.equal(handle.popup.id, "sval-test-menu", "the name is its id");
  Assert.equal(
    handle.popup.parentElement,
    document.getElementById("mainPopupSet"),
    "the menu is in the window's popupset"
  );
  await openMenu(handle, () => handle.openFrom(anchor()));
  Assert.ok(!menuItem(handle, "second-round"), "the first build has no extra");
  Assert.equal(SvalMenu.dataOf(menuItem(handle, "round")), 1, "data is kept");
  assertTidySeparators(handle.popup, "the built menu");
  Assert.equal(
    [...handle.popup.querySelectorAll("menuseparator")].filter(el => !el.hidden)
      .length,
    1,
    "one separator stands between the two runs of items"
  );
  await close(handle);
  await openMenu(handle, () => handle.openFrom(anchor()));
  Assert.ok(menuItem(handle, "second-round"), "each opening builds afresh");
  Assert.equal(SvalMenu.dataOf(menuItem(handle, "round")), 2, "fresh data");
  await close(handle);

  const again = made(SvalMenu.create(document, { name: "sval-test-menu" }));
  Assert.ok(!handle.popup.isConnected, "a menu of the same name replaces it");
  Assert.equal(document.getElementById("sval-test-menu"), again.popup);
});

add_task(async function test_commands_checks_and_submenus() {
  const commands = [];
  let filled = 0;
  let subHidden = 0;
  const handle = made(
    SvalMenu.create(document, {
      items: [
        { id: "run", label: "Run", data: { what: "run" } },
        { id: "box", label: "Box", type: "checkbox" },
        { id: "kept", label: "Kept", type: "checkbox", autocheck: false },
        { id: "a", label: "A", type: "radio", checked: true },
        { id: "b", label: "B", type: "radio" },
        { id: "stay", label: "Stay", closemenu: "none" },
        {
          id: "sub",
          label: "Sub",
          fill: () => {
            filled++;
            return [
              "separator",
              { id: `child-${filled}`, label: "Child", data: filled },
              "separator",
            ];
          },
          onHidden: () => subHidden++,
        },
        { id: "static", label: "Static", items: [{ id: "leaf", label: "L" }] },
      ],
      onCommand: (id, data) => commands.push([id, data]),
    })
  );
  const open = () => openMenu(handle, () => handle.openFrom(anchor()));

  await open();
  Assert.equal(menuItem(handle, "box").getAttribute("type"), "checkbox");
  Assert.equal(menuItem(handle, "a").getAttribute("checked"), "true");
  await pickMenuItem(handle, "run");
  Assert.deepEqual(commands.pop(), ["run", { what: "run" }], "the command");

  await open();
  await pickMenuItem(handle, "box");
  Assert.ok(
    menuItem(handle, "box").hasAttribute("checked"),
    "a checkbox ticks itself"
  );
  await open();
  await pickMenuItem(handle, "kept");
  Assert.ok(
    !menuItem(handle, "kept").hasAttribute("checked"),
    "autocheck: false leaves the tick to the command"
  );
  await open();
  await pickMenuItem(handle, "b");
  Assert.ok(menuItem(handle, "b").hasAttribute("checked"), "a radio ticks");
  Assert.ok(!menuItem(handle, "a").hasAttribute("checked"), "radios share");

  await open();
  const ran = BrowserTestUtils.waitForEvent(handle.popup, "command");
  handle.popup.activateItem(menuItem(handle, "stay"));
  await within(ran, 10_000, "the item's command");
  Assert.equal(commands.pop()[0], "stay", "the item ran");
  Assert.equal(handle.popup.state, "open", "closemenu none keeps it open");

  const sub = menuItem(handle, "sub");
  const shown = BrowserTestUtils.waitForPopupEvent(sub.menupopup, "shown");
  sub.openMenu(true);
  await within(shown, 10_000, "the submenu showing");
  Assert.equal(filled, 1, "fill runs as the submenu shows");
  Assert.ok(menuItem(handle, "child-1"), "the submenu holds what fill gave");
  assertTidySeparators(sub.menupopup, "the filled submenu");
  Assert.ok(
    sub.menupopup.hasAttribute("sval-menu"),
    "the submenu takes Sval's look"
  );
  await pickMenuItem(handle, "child-1");
  Assert.deepEqual(commands.pop(), ["child-1", 1], "a submenu's command");
  Assert.equal(subHidden, 1, "the submenu's onHidden ran");
  await open();
  Assert.ok(menuItem(handle, "leaf"), "a static submenu holds its items");
  await pickMenuItem(handle, "leaf");
  Assert.equal(commands.pop()[0], "leaf");
});

add_task(async function test_keys_and_accessibles() {
  const handle = made(
    SvalMenu.create(document, {
      items: [
        { id: "rename", label: "Rename", key: MENU_KEYS.rename },
        { id: "firefox", label: "Reload", key: { id: "key_reload" } },
        { id: "accel", label: "Accel", acceltext: "X" },
        { id: "check", label: "Check", type: "checkbox", checked: true },
        { id: "radio", label: "Radio", type: "radio" },
        {
          id: "named",
          label: "Indented",
          attributes: { "aria-label": "Named", "aria-description": "in A" },
        },
        "separator",
        { id: "sub", label: "Sub", items: [{ id: "leaf", label: "Leaf" }] },
      ],
    })
  );
  const rename = menuItem(handle, "rename");
  Assert.equal(rename.getAttribute("key"), MENU_KEYS.rename.id);
  Assert.equal(
    rename.getAttribute("aria-keyshortcuts"),
    ariaShortcut(MENU_KEYS.rename),
    "a key that spells its keys names them"
  );
  const firefox = menuItem(handle, "firefox");
  Assert.equal(firefox.getAttribute("key"), "key_reload");
  Assert.ok(
    !firefox.hasAttribute("aria-keyshortcuts"),
    "a key given by id leaves its keys to the key element"
  );
  Assert.equal(menuItem(handle, "accel").getAttribute("acceltext"), "X");

  await openMenu(handle, () => handle.openFrom(anchor()));
  const roles = {
    rename: Ci.nsIAccessibleRole.ROLE_MENUITEM,
    check: Ci.nsIAccessibleRole.ROLE_CHECK_MENU_ITEM,
    radio: Ci.nsIAccessibleRole.ROLE_RADIO_MENU_ITEM,
    sub: Ci.nsIAccessibleRole.ROLE_PARENT_MENUITEM,
  };
  for (const [id, role] of Object.entries(roles)) {
    const accessible = await accessibleOf(menuItem(handle, id));
    Assert.equal(accessible.role, role, `${id} has its role`);
  }
  const popup = await accessibleOf(handle.popup);
  Assert.equal(popup.role, Ci.nsIAccessibleRole.ROLE_MENUPOPUP);
  const named = await accessibleOf(menuItem(handle, "named"));
  Assert.equal(named.name, "Named", "aria-label names the item");
  Assert.equal(
    menuItem(handle, "named").getAttribute("aria-description"),
    "in A",
    "an item carries the attributes it is given"
  );
  const checked = {};
  (await accessibleOf(menuItem(handle, "check"))).getState(checked, {});
  Assert.ok(
    checked.value & Ci.nsIAccessibleStates.STATE_CHECKED,
    "a checked item reads as checked"
  );
  await close(handle);
});

add_task(async function test_open_at_pointer_or_anchor() {
  const handle = made(
    SvalMenu.create(document, { items: [{ id: "one", label: "One" }] })
  );
  const button = anchor();
  await openMenu(handle, () => handle.openAt(null, button));
  Assert.equal(handle.popup.anchorNode, button, "a key opens it at the anchor");
  await close(handle);

  const rect = button.getBoundingClientRect();
  const screenX = window.mozInnerScreenX + rect.left + 2;
  const screenY = window.mozInnerScreenY + rect.top + 2;
  await openMenu(handle, () =>
    handle.openAt(new MouseEvent("contextmenu", { screenX, screenY }), button)
  );
  Assert.ok(!handle.popup.anchorNode, "a pointer opens it at the point");
  const box = handle.popup.getOuterScreenRect();
  const margin = parseFloat(
    getComputedStyle(handle.popup).getPropertyValue("--panel-box-shadow-margin")
  );
  Assert.lessOrEqual(
    Math.abs(box.left + margin - screenX),
    2,
    "it opens at the pointer"
  );
  await close(handle);
});

add_task(async function test_transient_menus_go() {
  let hidden = 0;
  const handle = SvalMenu.create(document, {
    transient: true,
    items: [{ id: "one", label: "One" }],
    onHidden: () => hidden++,
  });
  await openMenu(handle, () => handle.openFrom(anchor()));
  await close(handle);
  Assert.equal(hidden, 1, "onHidden runs once it hides");
  Assert.ok(!handle.popup.isConnected, "a transient menu is removed");
});

add_task(async function test_choose() {
  const choices = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C", disabled: true },
  ];
  let picked = SvalMenu.choose(anchor(), choices, "a", {
    name: "sval-test-choice",
  });
  let popup = document.getElementById("sval-test-choice");
  await within(
    BrowserTestUtils.waitForPopupEvent(popup, "shown"),
    10_000,
    "the choices showing"
  );
  const handle = { popup };
  Assert.equal(menuItem(handle, "a").getAttribute("checked"), "true");
  Assert.ok(menuItem(handle, "c").disabled, "a disabled choice stays so");
  await pickMenuItem(handle, "b");
  Assert.equal(await picked, "b", "the choice is given");
  Assert.ok(!popup.isConnected, "the choices go once chosen");

  picked = SvalMenu.choose(anchor(), choices, "a", {
    name: "sval-test-choice",
  });
  popup = document.getElementById("sval-test-choice");
  await within(
    BrowserTestUtils.waitForPopupEvent(popup, "shown"),
    10_000,
    "the choices showing again"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await within(hidden, 10_000, "Escape closing the choices");
  Assert.equal(await picked, null, "closing with none gives null");
});

add_task(async function test_keyboard() {
  const commands = [];
  const handle = made(
    SvalMenu.create(document, {
      items: [
        { id: "one", label: "One" },
        { id: "off", label: "Off", disabled: true },
        { id: "gone", label: "Gone", hidden: true },
        { id: "two", label: "Two" },
        { id: "sub", label: "Sub", items: [{ id: "leaf", label: "Leaf" }] },
      ],
      onCommand: id => commands.push(id),
    })
  );
  await openMenu(handle, () => handle.openFrom(anchor()));
  const active = () =>
    handle.popup.querySelector(":scope > [_moz-menuactive]") ?? null;
  // Each press moves the active item once, as Gecko's menu keyboard
  // handling makes it (`nsXULPopupManager::HandleKeyboardNavigation`).
  const visited = [];
  const press = async (key, what) => {
    const before = active();
    EventUtils.synthesizeKey(key, {}, window);
    await TestUtils.waitForCondition(() => active() !== before, what);
    visited.push(active().getAttribute("data-sval-menu-id"));
  };
  await press("KEY_ArrowDown", "Down reaching the first item");
  Assert.equal(active(), menuItem(handle, "one"), "Down reaches the first");
  const sub = menuItem(handle, "sub");
  // Whether Down stops on a disabled item is the platform's
  // (`LookAndFeel::IntID::SkipNavigatingDisabledMenuItem`).
  for (let i = 0; i < 3 && active() !== sub; i++) {
    await press("KEY_ArrowDown", "Down moving on");
  }
  Assert.equal(active(), sub, "Down reaches the submenu");
  Assert.ok(!visited.includes("gone"), "a hidden item is passed over");
  Assert.ok(visited.includes("two"), "Down goes through every item shown");
  const shown = BrowserTestUtils.waitForPopupEvent(sub.menupopup, "shown");
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
  await within(shown, 10_000, "Right opening the submenu");
  const leaf = menuItem(handle, "leaf");
  if (!leaf.hasAttribute("_moz-menuactive")) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    await TestUtils.waitForCondition(
      () => leaf.hasAttribute("_moz-menuactive"),
      "Down reaching the leaf"
    );
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(handle.popup, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await within(hidden, 10_000, "Enter choosing the leaf");
  Assert.deepEqual(commands, ["leaf"], "Enter runs the active item");
});

add_task(async function test_colours_read_the_roles() {
  const handle = made(
    SvalMenu.create(document, {
      items: [
        { id: "one", label: "One" },
        { id: "off", label: "Off", disabled: true },
      ],
    })
  );
  await openMenu(handle, () => handle.openFrom(anchor()));
  const content = handle.popup.shadowRoot.querySelector('[part~="content"]');
  const look = getComputedStyle(content);
  const root = getComputedStyle(document.documentElement);
  const resolve = value => {
    const probe = document.createElement("div");
    probe.style.color = value;
    document.documentElement.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  };
  Assert.equal(
    look.backgroundColor,
    resolve(root.getPropertyValue("--sval-popup-bg")),
    "the menu is the window's popup colour"
  );
  Assert.equal(
    look.color,
    resolve(root.getPropertyValue("--sval-menu-ink")),
    "its text is the window's popup text"
  );
  Assert.equal(
    look.borderTopColor,
    resolve(root.getPropertyValue("--sval-menu-edge")),
    "its edge is the window's popup edge"
  );
  // Firefox's `menu.css` colours a disabled item by `--text-color-disabled`;
  // Sval's sheet gives it its own share of the item's text.
  const off = menuItem(handle, "off");
  off.style.setProperty("--text-color-disabled", "rgb(255, 0, 0)");
  Assert.notEqual(
    getComputedStyle(off).color,
    "rgb(255, 0, 0)",
    "Firefox's disabled colour does not reach the item"
  );
  await close(handle);
});

add_task(async function test_see_through_window_menus() {
  const root = document.documentElement;
  // What `_applyWindowTint` sets on a window some of whose backdrop shows.
  const accent = "rgba(40, 60, 120, 0.4)";
  root.style.setProperty("--sval-tint-accent", accent);
  root.setAttribute("data-sval-translucent", "");
  atTaskEnd(() => {
    root.removeAttribute("data-sval-translucent");
    root.style.removeProperty("--sval-tint-accent");
  });
  const handle = made(
    SvalMenu.create(document, { items: [{ id: "one", label: "One" }] })
  );
  await openMenu(handle, () => handle.openFrom(anchor()));
  const style = getComputedStyle(handle.popup);
  const content = getComputedStyle(
    handle.popup.shadowRoot.querySelector('[part~="content"]')
  );
  // Windows lays a backdrop behind a popup only where `WinUtils::
  // MicaPopupsEnabled` says so.
  if (
    !matchMedia(
      "(-moz-platform: macos) or (-moz-platform: linux) or (-moz-windows-mica-popups)"
    ).matches
  ) {
    Assert.equal(style.appearance, "none", "no backdrop, so the menu is solid");
    await close(handle);
    return;
  }
  Assert.equal(
    style.appearance,
    "auto",
    "the system's menu backdrop is asked for"
  );
  Assert.equal(
    content.backgroundColor,
    accent,
    "the menu wears the window's colour at its share"
  );
  Assert.equal(content.boxShadow, "none", "the system's shadow stands");
  Assert.equal(style.marginTop, "0px", "with no room kept for a drawn one");
  await close(handle);

  root.removeAttribute("data-sval-translucent");
  await openMenu(handle, () => handle.openFrom(anchor()));
  Assert.equal(
    getComputedStyle(handle.popup).appearance,
    "none",
    "an opaque window's menus draw their own look"
  );
  Assert.notEqual(
    getComputedStyle(handle.popup.shadowRoot.querySelector('[part~="content"]'))
      .boxShadow,
    "none",
    "with Sval's drawn shadow"
  );
  await close(handle);
});

add_task(async function test_menu_in_an_html_document() {
  const ui = await openSvalSettings();
  const doc = ui.page.document;
  const handle = SvalMenu.create(doc, {
    transient: true,
    items: [{ id: "one", label: "One" }],
  });
  const set = handle.popup.parentElement;
  Assert.equal(set.localName, "popupset", "the menu is in a popupset");
  Assert.equal(set.parentElement, doc.body, "made at the end of the body");
  Assert.ok(menuItem(handle, "one").hasAttribute(MENU_ID_ATTR));
  await openMenu(handle, () => handle.openFrom(ui.els.heading));
  const content = handle.popup.shadowRoot.querySelector('[part~="content"]');
  Assert.equal(
    ui.page.getComputedStyle(content).borderTopLeftRadius,
    ui.page
      .getComputedStyle(handle.popup)
      .getPropertyValue("--sval-menu-radius")
      .trim(),
    "the menu sheet styles a menu in a settings page"
  );
  await close(handle);
  await closeSvalSettings(ui);
});

/**
 * A `menupopup` of the window's popupset that `SvalMenu.fill` fills, removed
 * when the task ends.
 *
 * @param {object} [attributes]
 * @returns {Element}
 */
function fillable(attributes = {}) {
  const popup = document.createXULElement("menupopup");
  for (const [name, value] of Object.entries(attributes)) {
    popup.setAttribute(name, value);
  }
  document.getElementById("mainPopupSet").append(popup);
  atTaskEnd(() => popup.remove());
  return popup;
}

/**
 * @param {Element} popup
 * @returns {string[]} the ids of its items, in order.
 */
function idsIn(popup) {
  return [...popup.children].map(el => el.getAttribute(MENU_ID_ATTR));
}

add_task(async function test_fill_keeps_each_items_element() {
  const popup = fillable();
  SvalMenu.fill(popup, [
    { id: "a", label: "A", attributes: { "data-old": "1" }, data: 1 },
    "separator",
    { id: "b", label: "B", checked: true, type: "checkbox" },
    { id: "c", label: "C", items: [{ id: "c1", label: "C1" }] },
    { id: "d", label: "D" },
  ]);
  const before = Object.fromEntries(
    ["a", "b", "c", "c1", "d"].map(id => [
      id,
      popup.querySelector(`[${MENU_ID_ATTR}="${id}"]`),
    ])
  );
  const separator = popup.querySelector("menuseparator");

  SvalMenu.fill(popup, [
    { id: "d", label: "D" },
    { id: "a", label: "A again", data: 2 },
    { id: "b", label: "B", type: "checkbox" },
    "separator",
    {
      id: "c",
      label: "C",
      items: [
        { id: "c2", label: "C2" },
        { id: "c1", label: "C1" },
      ],
    },
    { id: "e", label: "E", items: [{ id: "e1", label: "E1" }] },
  ]);
  Assert.deepEqual(
    idsIn(popup),
    ["d", "a", "b", null, "c", "e"],
    "the items in their new order"
  );
  for (const id of ["a", "b", "c", "c1", "d"]) {
    Assert.equal(
      popup.querySelector(`[${MENU_ID_ATTR}="${id}"]`),
      before[id],
      `${id} keeps its element`
    );
  }
  Assert.ok(!separator.isConnected, "a separator with no id is made again");
  const a = before.a;
  Assert.equal(a.getAttribute("label"), "A again", "its label redrawn");
  Assert.ok(!a.hasAttribute("data-old"), "what it no longer has goes");
  Assert.equal(SvalMenu.dataOf(a), 2, "its data redrawn");
  Assert.ok(!before.b.hasAttribute("checked"), "a check no longer given goes");
  Assert.deepEqual(
    idsIn(before.c.menupopup),
    ["c2", "c1"],
    "a submenu's items keep theirs too"
  );

  // An item of another kind is a new element.
  SvalMenu.fill(popup, [{ id: "a", label: "A", items: [] }]);
  const menu = popup.querySelector(`[${MENU_ID_ATTR}="a"]`);
  Assert.notEqual(menu, a, "an item that becomes a submenu is made again");
  Assert.equal(menu.localName, "menu");
  Assert.deepEqual(idsIn(popup), ["a"], "and the rest are gone");
  Assert.ok(!before.d.isConnected, "removed from the document");
});

add_task(async function test_fill_keeps_an_open_submenu_open() {
  const popup = fillable({ "sval-menu": "" });
  const items = [
    { id: "a", label: "A" },
    { id: "b", label: "B", items: [{ id: "b1", label: "B1" }] },
    { id: "c", label: "C" },
  ];
  SvalMenu.fill(popup, items);
  const handle = { popup };
  await openMenu(handle, () => popup.openPopup(anchor(), "after_start"));
  const b = popup.querySelector(`[${MENU_ID_ATTR}="b"]`);
  const sub = b.menupopup;
  const shown = BrowserTestUtils.waitForPopupEvent(sub, "shown");
  b.openMenu(true);
  await within(shown, 10_000, "the submenu showing");

  // Favorites change while their menu is open.
  SvalMenu.fill(popup, [
    { id: "c", label: "C" },
    { id: "b", label: "B", items: [{ id: "b1", label: "B1 renamed" }] },
    { id: "a", label: "A" },
  ]);
  Assert.deepEqual(idsIn(popup), ["c", "b", "a"], "in their new order");
  Assert.equal(popup.querySelector(`[${MENU_ID_ATTR}="b"]`), b, "b stayed");
  Assert.equal(sub.state, "open", "its submenu is still open");
  Assert.equal(
    sub.querySelector(`[${MENU_ID_ATTR}="b1"]`).getAttribute("label"),
    "B1 renamed",
    "and shows its items as they are"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await within(hidden, 10_000, "the menu hiding");
});

add_task(async function test_fill_leaves_fixed_items_first() {
  const popup = fillable();
  SvalMenu.fill(popup, [
    { id: "fixed", label: "Fixed", attributes: { "data-fixed": "" } },
    { type: "separator", attributes: { "data-fixed": "" } },
  ]);
  const fixed = [...popup.children];
  fixed[0].setAttribute("label", "Set by its own menu");
  SvalMenu.fill(popup, [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ]);
  SvalMenu.fill(popup, [
    { id: "two", label: "Two" },
    { id: "one", label: "One" },
  ]);
  Assert.deepEqual(
    [...popup.children].slice(0, 2),
    fixed,
    "the fixed items stay first"
  );
  Assert.equal(
    fixed[0].getAttribute("label"),
    "Set by its own menu",
    "as their menu left them"
  );
  Assert.deepEqual(idsIn(popup).slice(2), ["two", "one"], "then the items");
});

add_task(async function test_fill_can_leave_a_menus_look() {
  const popup = fillable({ nonnative: "" });
  SvalMenu.fill(
    popup,
    [{ id: "sub", label: "Sub", items: [{ id: "x", label: "X" }] }],
    { look: null }
  );
  Assert.ok(!popup.hasAttribute("sval-menu"), "the menu keeps its own look");
  Assert.ok(
    !popup.querySelector("menupopup").hasAttribute("sval-menu"),
    "and so do its submenus"
  );

  const panelLook = fillable({ "sval-menu": "panel" });
  SvalMenu.fill(
    panelLook,
    [
      {
        id: "sub",
        label: "Sub",
        items: [],
        popupAttributes: { "data-folder": "f" },
      },
    ],
    { look: null }
  );
  const sub = panelLook.querySelector("menupopup");
  Assert.equal(panelLook.getAttribute("sval-menu"), "panel", "panel kept");
  Assert.equal(sub.getAttribute("sval-menu"), "panel", "a submenu takes it");
  Assert.ok(sub.hasAttribute("nonnative"), "never handed to a native menu");
  Assert.equal(sub.getAttribute("data-folder"), "f", "with its attributes");
});
