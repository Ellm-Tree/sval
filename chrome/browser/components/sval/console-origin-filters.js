/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* global loader, module, require */

/**
 * The console filter bar's origin toggles (Page, Extensions, Sval) and the
 * menu that narrows Extensions to one extension. They are buttons of the
 * filter bar's own kind and keep their state in its redux filters, so the
 * level filters' persistence, counts and reset apply to them as they are.
 */

const {
  createFactory,
} = require("resource://devtools/client/shared/vendor/react.mjs");
const dom = require("resource://devtools/client/shared/vendor/react-dom-factories.js");
const actions = require("resource://devtools/client/webconsole/actions/index.js");
const {
  FILTERS,
  SVAL_FILTER_EXTENSION_SET,
} = require("resource://devtools/client/webconsole/constants.js");
const FilterButton = require("resource://devtools/client/webconsole/components/FilterBar/FilterButton.js");
const {
  ORIGIN,
  extensionOrigin,
} = require("chrome://browser/content/sval/console-origin.js");
const MenuButton = createFactory(
  require("resource://devtools/client/shared/components/menu/MenuButton.js")
);

loader.lazyGetter(this, "MenuItem", function () {
  return createFactory(
    require("resource://devtools/client/shared/components/menu/MenuItem.js")
  );
});
loader.lazyGetter(this, "MenuList", function () {
  return createFactory(
    require("resource://devtools/client/shared/components/menu/MenuList.js")
  );
});

const ALL_EXTENSIONS = "All extensions";

/**
 * An extension Sval cannot name, such as one uninstalled since it logged,
 * is told apart by the start of its internal id.
 *
 * @param {{key: string, name: string|null}} origin
 */
function nameOf(origin) {
  return origin.name ?? `Extension ${origin.key.slice(0, 8)}`;
}

/**
 * The extensions whose messages this console holds, by name. The menu is
 * built when it opens, so it lists what the console shows at that moment.
 *
 * @param {object} webConsoleUI
 * @param {string} selectedKey
 *        The extension the filter shows alone, listed even when the console
 *        holds none of its messages.
 */
function extensionsInConsole(webConsoleUI, selectedKey) {
  const byKey = new Map();
  const { messages } = webConsoleUI.wrapper.getStore().getState();
  for (const message of messages.mutableMessagesById.values()) {
    const origin = message.frame?.svalOrigin;
    if (origin?.kind === ORIGIN.EXTENSION && !byKey.has(origin.key)) {
      byKey.set(origin.key, nameOf(origin));
    }
  }
  if (selectedKey && !byKey.has(selectedKey)) {
    byKey.set(selectedKey, nameOf(extensionOrigin(selectedKey)));
  }
  return [...byKey].sort(([, a], [, b]) => a.localeCompare(b));
}

function selectExtension({ dispatch, filter }, key) {
  dispatch({ type: SVAL_FILTER_EXTENSION_SET, extension: key });
  if (key && !filter[FILTERS.EXTENSIONS]) {
    dispatch(actions.filterToggle(FILTERS.EXTENSIONS));
  }
}

function ExtensionMenu(props) {
  const { filter, webConsoleUI } = props;
  const selectedKey = filter[FILTERS.EXTENSION];
  const doc = webConsoleUI.document;
  const { toolbox } = webConsoleUI.wrapper;
  return MenuButton(
    {
      key: "sval-extension-menu",
      menuId: "sval-console-extension-menu",
      toolboxDoc: toolbox ? toolbox.doc : doc,
      className: "devtools-button devtools-dropdown-button",
      title: "Show messages from one extension",
      label: selectedKey
        ? nameOf(extensionOrigin(selectedKey))
        : ALL_EXTENSIONS,
    },
    () =>
      MenuList(
        { id: "sval-console-extension-menu-list" },
        [
          MenuItem({
            key: "all",
            role: "menuitemradio",
            checked: !selectedKey,
            label: ALL_EXTENSIONS,
            onClick: () => selectExtension(props, ""),
          }),
        ].concat(
          extensionsInConsole(webConsoleUI, selectedKey).map(([key, name]) =>
            MenuItem({
              key,
              role: "menuitemradio",
              checked: key === selectedKey,
              label: name,
              onClick: () => selectExtension(props, key),
            })
          )
        )
      )
  );
}

/**
 * @param {object} props
 * @param {Function} props.dispatch
 * @param {object} props.filter
 *        The redux "filters" state.
 * @param {Function} props.getLabel
 *        FilterBar's own labeller, which adds the hidden count.
 * @param {object} props.webConsoleUI
 * @returns {Array} The filter bar's children for the origin filters.
 */
function OriginFilters(props) {
  const { dispatch, filter, getLabel } = props;
  return [
    dom.div({ key: "sval-origin-separator", className: "devtools-separator" }),
    FilterButton({
      key: FILTERS.PAGE,
      active: filter[FILTERS.PAGE],
      label: getLabel("Page", FILTERS.PAGE),
      title: "Messages from the page's own scripts",
      filterKey: FILTERS.PAGE,
      dispatch,
    }),
    FilterButton({
      key: FILTERS.EXTENSIONS,
      active: filter[FILTERS.EXTENSIONS],
      label: getLabel("Extensions", FILTERS.EXTENSIONS),
      title: "Messages from extensions",
      filterKey: FILTERS.EXTENSIONS,
      dispatch,
    }),
    ExtensionMenu(props),
    FilterButton({
      key: FILTERS.SVAL,
      active: filter[FILTERS.SVAL],
      label: getLabel("Sval", FILTERS.SVAL),
      title: "Messages from Sval itself",
      filterKey: FILTERS.SVAL,
      dispatch,
    }),
  ];
}

module.exports = OriginFilters;
