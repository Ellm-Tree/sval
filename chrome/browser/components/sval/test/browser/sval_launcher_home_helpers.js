/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* The file that loads this one imports `UrlbarTestUtils`. */
/* global UrlbarTestUtils */

/**
 * What the Launcher's tests on Home's field share: a home tab in the tree,
 * and the page's list and the address bar's view read alike, so a test
 * compares the two row for row.
 */

/* exported homeTab, treeTab, homeList, urlbarItems, closeUrlbarWithItems,
   typeInHomeField, untilHomeLists */

/**
 * A home page tab in this window, filed in the tree, closed when the task
 * ends if it is still open, and its node removed if the tab moved away.
 *
 * @returns {Promise<{tab: object, id: string}>}
 */
async function homeTab() {
  const tab = await openPage("about:home");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => !!content.document.querySelector(".search input").placeholder,
      "the page is answered"
    )
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const id = SvalPanel.observer.nodeIdFor(tab);
  Assert.ok(id, "the home tab is in the tree");
  atTaskEnd(async () => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
      await within(
        SvalPanel.observer.settled(),
        10_000,
        "SvalPanel.observer settling"
      );
      return;
    }
    const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
    if (nodes[id]) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  });
  return { tab, id };
}

/**
 * A tab of the workspace `parent` that no window shows, removed when the
 * task ends.
 *
 * @param {string} parent
 * @param {string} name
 * @param {string} url
 * @returns {Promise<string>} its node.
 */
async function treeTab(parent, name, url) {
  const id = await SvalPanel.engine.mutate({
    kind: "addTab",
    parent,
    name,
    url,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * The page's list as the user sees it: headings as `## heading`, then each
 * row's kind, title, address, the node or command it stands for (a tip's
 * button, or the action of a row a provider draws), and the workspace chip
 * of an open tab elsewhere; the selected row marked `>`.
 *
 * @param {object} browser
 * @returns {Promise<object>} `{ hidden, value, placeholder, chip, items,
 *   selection }`, `selection` the field's selected range.
 */
function homeList(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const input = doc.querySelector(".search input");
    const list = doc.querySelector(".suggestions");
    return {
      hidden: list.hidden,
      value: input.value,
      placeholder: input.placeholder,
      selection: [input.selectionStart, input.selectionEnd],
      // A command's chip, or the search mode the engine button shows.
      chip:
        doc.querySelector(".search .chip-label")?.textContent ??
        (doc.querySelector(".search.in-mode .engine-title")?.textContent ||
          null),
      // A section's heading leads its group of rows.
      items: [...list.querySelectorAll(".group, .result")].map(li =>
        li.classList.contains("group")
          ? `## ${li.textContent}`
          : [
              li.getAttribute("aria-selected") == "true" ? ">" : " ",
              li.dataset.kind,
              li.querySelector(".title").textContent,
              li.querySelector(".url")?.textContent ?? "",
              li.dataset.nodeId ??
                li.dataset.commandId ??
                li.querySelector(".tip-button")?.textContent ??
                (li.dataset.kind == "dynamic"
                  ? li.querySelector(".action")?.textContent
                  : "") ??
                "",
              li.querySelector(".sval-chip")?.textContent ?? "",
            ].join(" | ")
      ),
    };
  });
}

/**
 * The texts of a row a provider draws, as Home's field draws them: each
 * named part's text but its action's, in order, then the action's.
 *
 * @param {Element} row
 * @returns {{title: string, action: string}}
 */
function dynamicTexts(row) {
  const title = [];
  let action = "";
  for (const part of row.querySelectorAll("[name]")) {
    if (part.querySelector("[name]") || !part.checkVisibility()) {
      continue;
    }
    const text = part.textContent;
    if (!text) {
      continue;
    }
    if (part.getAttribute("name") == "action") {
      action = text;
    } else {
      title.push(text);
    }
  }
  return { title: title.join(" "), action };
}

/**
 * The open address bar view's rows, as {@link homeList} lists the page's.
 *
 * @returns {Promise<string[]>}
 */
async function urlbarItems() {
  const items = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { element, result } = await UrlbarTestUtils.getDetailsOfResultAt(
      window,
      i
    );
    const row = element.row;
    const label = row.getAttribute("label");
    if (label) {
      items.push(`## ${label}`);
    }
    const { DYNAMIC, SEARCH, TAB_SWITCH, TIP } = UrlbarUtils.RESULT_TYPE;
    let kind =
      { [SEARCH]: "search", [TAB_SWITCH]: "tab", [TIP]: "tip" }[result.type] ??
      "url";
    if (result.type == DYNAMIC) {
      kind =
        result.providerName == "SvalLauncherCommands" ? "command" : "dynamic";
    }
    if (result.payload.providesSearchMode) {
      kind = "searchmode";
    }
    const drawn = kind == "dynamic" ? dynamicTexts(row) : null;
    items.push(
      [
        row.hasAttribute("selected") ||
        row.querySelector("[selected]:not(.urlbarView-button-menu)")
          ? ">"
          : " ",
        kind,
        drawn?.title ?? row.querySelector(".urlbarView-title").textContent,
        result.heuristic || kind == "searchmode" || kind == "tip"
          ? ""
          : (row.querySelector(".urlbarView-url")?.textContent ?? ""),
        result.payload.svalNodeId ??
          result.payload.commandId ??
          (kind == "tip"
            ? row.querySelector(".urlbarView-button-0")?.textContent
            : drawn?.action) ??
          "",
        row.querySelector(".sval-chip")?.textContent ?? "",
      ].join(" | ")
    );
  }
  return items;
}

/**
 * The open address bar view's rows, as {@link homeList} lists the page's;
 * then closes the view.
 *
 * @returns {Promise<string[]>}
 */
async function closeUrlbarWithItems() {
  const items = await urlbarItems();
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the address bar's results closing"
  );
  gURLBar.handleRevert();
  return items;
}

/**
 * Types `text` into the page's field, as a person does.
 *
 * @param {object} browser
 * @param {string} text
 */
async function typeInHomeField(browser, text) {
  browser.focus();
  await SpecialPowers.spawn(browser, [text], value => {
    const input = content.document.querySelector(".search input");
    input.focus();
    input.setUserInput(value);
  });
}

/**
 * Waits until the page lists `items`.
 *
 * @param {object} browser
 * @param {string[]} items
 * @returns {Promise<object>} {@link homeList}'s answer.
 */
async function untilHomeLists(browser, items) {
  let home;
  await TestUtils.waitForCondition(async () => {
    home = await homeList(browser);
    return JSON.stringify(home.items) === JSON.stringify(items);
  }, "the field lists every row the address bar does");
  return home;
}
