/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Favorites in the header and in Firefox's bookmark entry points
 * (`SvalFavorites.sys.mjs`), and the header's downloads and history buttons
 * (`SvalHeader.sys.mjs`).
 */

// `PAGE` and `PAGE2` are head.js's test pages.
const OTHER_PAGE = PAGE2;

/** @returns {Element} the header's favorite button. */
function favoriteButton() {
  return document.getElementById("sval-favorite-button");
}

/** Whether Firefox's edit-bookmark panel has been made or is showing. */
function editPanelShown() {
  const panel = document.getElementById("editBookmarkPanel");
  return !!panel && panel.state !== "closed";
}

const { FAVORITES_ROOT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);

/** The file's own Favorites (`favoritesFixture`). */
let favorites;

/** Deletes every favorite, so a task starts with none. */
async function eraseFavorites() {
  for (const row of favorites.children(FAVORITES_ROOT)) {
    await favorites.delete(row.guid);
  }
}

/**
 * Runs `action` and waits for the notice it shows (Firefox's
 * `ConfirmationHint`).
 *
 * @param {Function} action
 * @returns {Promise<{text: string, anchor: Element}>} what the notice says,
 *   and what it points at.
 */
async function noticeAfter(action) {
  // The notice is made the first time one shows.
  const panel = () => document.getElementById("confirmation-hint");
  if (panel()?.state === "open") {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
    panel().hidePopup();
    await within(hidden, 10_000, "the last notice closing");
  }
  const shown = BrowserTestUtils.waitForEvent(
    window,
    "popupshown",
    false,
    event => event.target.id === "confirmation-hint"
  );
  await action();
  await within(shown, 10_000, "the notice showing");
  const message = document.getElementById("confirmation-hint-message");
  // `ConfirmationHint.show` sets the message's l10n id.
  await translated(message);
  return {
    id: document.l10n.getAttributes(message).id,
    anchor: panel().anchorNode,
  };
}

add_setup(async function () {
  ({ store: favorites } = await favoritesFixture());
});

add_task(async function the_favorite_button_shows_on_every_page() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const box = favoriteButton().getBoundingClientRect();
    Assert.greater(box.width, 0, "the favorite button is drawn");
    Assert.ok(
      favoriteButton()
        .getAttribute("tooltiptext")
        .includes(
          ShortcutUtils.prettifyShortcut(
            document.getElementById("addBookmarkAsKb")
          )
        ),
      "the button's tooltip names the key that adds the page"
    );
  });
});

add_task(async function the_button_adds_and_removes_a_favorite() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const button = favoriteButton();
    let notice = await noticeAfter(() =>
      EventUtils.synthesizeMouseAtCenter(button, {})
    );
    Assert.equal(notice.id, "sval-favorites-hint-added", "a notice says so");
    Assert.equal(notice.anchor, button, "on the button");
    await TestUtils.waitForCondition(
      () => button.hasAttribute("starred"),
      "the button shows the page is a favorite"
    );
    const [favorite] = favoritesFor(PAGE);
    Assert.equal(
      favorite.parentGuid,
      FAVORITES_ROOT,
      "it is filed in Favorites, which the Favorites menu lists"
    );
    Assert.equal(favorite.name, "Agent test page", "under the page's title");
    Assert.ok(!editPanelShown(), "Firefox's bookmark panel stays closed");
    Assert.equal(button.getAttribute("aria-pressed"), "true", "it is pressed");
    Assert.ok(
      !button.hasAttribute("aria-keyshortcuts"),
      "and names no key, since the key only adds"
    );
    const acc = await accessibleOf(button);
    const state = {};
    acc.getState(state, {});
    Assert.equal(
      acc.name,
      button.getAttribute("label"),
      "a screen reader hears the button's one name, whatever a press does"
    );
    Assert.ok(
      state.value & Ci.nsIAccessibleStates.STATE_PRESSED,
      "with the button pressed, so name and state never contradict"
    );

    notice = await noticeAfter(() =>
      EventUtils.synthesizeMouseAtCenter(button, {})
    );
    Assert.equal(
      notice.id,
      "sval-favorites-hint-removed",
      "and a second press"
    );
    await TestUtils.waitForCondition(
      () => !button.hasAttribute("starred"),
      "a second press takes it out"
    );
    Assert.deepEqual(favoritesFor(PAGE), [], "and Favorites hold none");
  });
});

add_task(async function the_button_follows_the_selected_tab() {
  await favorites.insertTree([{ url: PAGE, title: "A favorite" }]);
  const favorite = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the favorite's tab loading"
  );
  await TestUtils.waitForCondition(
    () => favoriteButton().hasAttribute("starred"),
    "a favorite's tab shows the filled star"
  );
  const other = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER_PAGE),
    10_000,
    "the other page's tab loading"
  );
  await TestUtils.waitForCondition(
    () => !favoriteButton().hasAttribute("starred"),
    "another page's tab does not"
  );
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(favorite);
  await eraseFavorites();
});

add_task(async function the_bookmark_shortcut_adds_a_favorite() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const command = document.getElementById("Browser:AddBookmarkAs");
    let notice = await noticeAfter(() => command.doCommand());
    Assert.equal(notice.id, "sval-favorites-hint-added", "a notice says so");
    Assert.equal(notice.anchor, favoriteButton(), "on the favorite button");
    await TestUtils.waitForCondition(
      () => favoriteButton().hasAttribute("starred"),
      "the shortcut's command makes the page a favorite"
    );
    Assert.equal(favoritesFor(PAGE).length, 1);
    Assert.ok(!editPanelShown(), "and opens no bookmark panel");
    notice = await noticeAfter(() => command.doCommand());
    Assert.equal(
      notice.id,
      "sval-favorites-hint-already",
      "pressed again, it says"
    );
    Assert.equal(favoritesFor(PAGE).length, 1, "and the favorite stays");
    Assert.ok(favoriteButton().hasAttribute("starred"), "starred");
  });
  await eraseFavorites();
});

add_task(async function the_bookmark_key_adds_and_never_removes() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    // The key as a person presses it, with the page focused.
    browser.focus();
    let notice = await noticeAfter(() =>
      EventUtils.synthesizeKey("d", { accelKey: true }, window)
    );
    Assert.equal(
      notice.id,
      "sval-favorites-hint-added",
      "the key adds the page"
    );
    await TestUtils.waitForCondition(
      () => favoriteButton().hasAttribute("starred"),
      "the button shows it is a favorite"
    );
    Assert.equal(favoritesFor(PAGE).length, 1, "one favorite for the page");
    Assert.ok(!editPanelShown(), "and opens no bookmark panel");
    gURLBar.focus();
    notice = await noticeAfter(() =>
      EventUtils.synthesizeKey("d", { accelKey: true }, window)
    );
    Assert.equal(
      notice.id,
      "sval-favorites-hint-already",
      "pressed again from the address bar, it says the page is one"
    );
    Assert.equal(favoritesFor(PAGE).length, 1, "and leaves it in place");
    Assert.ok(favoriteButton().hasAttribute("starred"), "still starred");
  });
  await eraseFavorites();
});

add_task(async function a_redirected_page_is_saved_where_it_landed() {
  const redirect = `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(PAGE2)}`;
  await BrowserTestUtils.withNewTab(redirect, async browser => {
    Assert.equal(browser.currentURI.spec, PAGE2, "the tab followed it");
    document.getElementById("Browser:AddBookmarkAs").doCommand();
    await TestUtils.waitForCondition(
      () => favoriteButton().hasAttribute("starred"),
      "the shortcut makes the page a favorite"
    );
    Assert.equal(favoritesFor(PAGE2).length, 1, "the page it landed on");
    Assert.equal(favoritesFor(redirect).length, 0, "and not the redirect");
  });
  await eraseFavorites();
});

add_task(async function the_button_follows_a_change_made_elsewhere() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    Assert.ok(!favoriteButton().hasAttribute("starred"), "not a favorite");
    const [guid] = await favorites.insertTree([{ url: PAGE, title: "P" }]);
    await TestUtils.waitForCondition(
      () => favoriteButton().hasAttribute("starred"),
      "the button fills once Favorites hold the page"
    );
    await favorites.delete(guid);
    await TestUtils.waitForCondition(
      () => !favoriteButton().hasAttribute("starred"),
      "and empties once they do not"
    );
  });
});

add_task(function firefox_bookmark_entry_points_are_gone() {
  Assert.ok(
    !document.getElementById("star-button-box"),
    "the address bar has no bookmark star"
  );
  for (const id of ["bookmarksMenu"]) {
    Assert.ok(document.getElementById(id).hidden, `${id} is hidden`);
  }
  for (const id of [
    "viewBookmarksSidebarKb",
    "bookmarkAllTabsKb",
    "Browser:BookmarkAllTabs",
  ]) {
    Assert.equal(
      document.getElementById(id).getAttribute("disabled"),
      "true",
      `${id} does nothing`
    );
  }
});

add_task(async function the_sidebar_menus_offer_no_bookmarks() {
  // View › Sidebar's item is made by `SidebarController` and hidden as any
  // popup opens. The popup is outside the menu bar, whose autohide would
  // take it as the menu bar opening (`AutoHideMenubar`). It opens and closes
  // for real: the window's other listeners count a popup open from its
  // popupshowing to its popuphiding (`TabHoverPanelSet`).
  const popup = document.createXULElement("menupopup");
  popup.append(document.createXULElement("menuitem"));
  document.getElementById("mainPopupSet").append(popup);
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  popup.openPopup(document.documentElement);
  await within(shown, 10_000, "a popup showing");
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await within(hidden, 10_000, "the popup hiding");
  popup.remove();
  for (const id of ["menu_bookmarksSidebar", "sidebar-switcher-bookmarks"]) {
    const item = document.getElementById(id);
    Assert.ok(!item || item.hidden, `${id} is hidden`);
  }
});

add_task(async function a_link_is_added_to_favorites_from_its_menu() {
  const target = "https://example.com/a-linked-page";
  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: `data:text/html,<a id=link href='${target}'>A linked page</a>`,
    },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#link",
        { type: "contextmenu", button: 2 },
        browser
      );
      await within(shown, 10_000, "the page's context menu showing");
      const item = document.getElementById("sval-context-favorite-link");
      Assert.ok(!item.hidden, "the link's menu offers Add Link to Favorites");
      Assert.ok(
        document.getElementById("context-bookmarklink").hidden,
        "and not Firefox's Bookmark Link"
      );
      Assert.ok(
        document.getElementById("context-bookmarkpage").hidden,
        "nor Bookmark Page"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      const notice = await noticeAfter(() => menu.activateItem(item));
      await within(hidden, 10_000, "the page's context menu hiding");
      Assert.equal(notice.id, "sval-favorites-hint-added", "a notice says so");
      await TestUtils.waitForCondition(
        () => favoritesFor(target).length === 1,
        "the link is a favorite"
      );
      const [favorite] = favoritesFor(target);
      Assert.equal(favorite.name, "A linked page", "named by its text");
    }
  );
  await eraseFavorites();
});

/** The question asked before a page's script becomes a favorite. */
const BOOKMARKLET_QUESTION = new Localization(
  ["sval/favorites.ftl"],
  true
).formatValueSync("sval-favorites-bookmarklet-question");

/**
 * Waits for the Sval dialog the window shows.
 *
 * @returns {Promise<Document>}
 */
async function svalDialog() {
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "a dialog opens");
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = gDialogBox.dialog?._frame.contentDocument;
    return doc?.querySelector(".sval-dialog-actions button");
  }, "the dialog has drawn");
  return doc;
}

/**
 * Presses `button` in the open dialog and waits for it to close.
 *
 * @param {Document} doc
 * @param {string} button `ok` or `cancel`.
 */
async function answer(doc, button) {
  const closed = TestUtils.waitForCondition(() => !gDialogBox.isOpen);
  doc.querySelector(`[data-button="${button}"]`).click();
  await within(closed, 10_000, "the dialog closing");
}

add_task(async function a_pages_script_link_asks_before_it_is_added() {
  const script = "javascript:void(document.title='ran')";
  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: `data:text/html,<a id=link href="${script}">Free stuff</a>`,
    },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      const item = document.getElementById("sval-context-favorite-link");
      const choose = async () => {
        const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
        await BrowserTestUtils.synthesizeMouseAtCenter(
          "#link",
          { type: "contextmenu", button: 2 },
          browser
        );
        await within(shown, 10_000, "the page's context menu showing");
        const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
        menu.activateItem(item);
        await within(hidden, 10_000, "the page's context menu hiding");
        return svalDialog();
      };

      let doc = await choose();
      Assert.equal(
        doc.querySelector(".sval-dialog-title").textContent,
        BOOKMARKLET_QUESTION,
        "Sval asks what the favorite does"
      );
      Assert.equal(
        doc.activeElement?.dataset.button,
        "cancel",
        "with Cancel focused"
      );
      await answer(doc, "cancel");
      await within(favorites.whenIdle(), 10_000, "favorites going idle");
      Assert.deepEqual(favoritesFor(script), [], "Cancel adds nothing");

      doc = await choose();
      await answer(doc, "ok");
      await TestUtils.waitForCondition(
        () => favoritesFor(script).length === 1,
        "Add makes it a favorite"
      );
    }
  );
  await eraseFavorites();
});

add_task(async function the_page_menu_offers_no_bookmark_page() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "data:text/html,<p id=text>Some text</p>" },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#text",
        { type: "contextmenu", button: 2 },
        browser
      );
      await within(shown, 10_000, "the page's context menu showing");
      Assert.ok(
        document.getElementById("context-bookmarkpage").hidden,
        "the page's menu offers no Bookmark Page"
      );
      Assert.ok(
        document.getElementById("sval-context-favorite-link").hidden,
        "and, off a link, no Add Link to Favorites"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.hidePopup();
      await within(hidden, 10_000, "the page's context menu hiding");
    }
  );
});

add_task(async function import_opens_svals_import() {
  await noOtherBrowsers();
  document.getElementById("cmd_file_importFromAnotherBrowser").doCommand();
  await TestUtils.waitForCondition(
    () => gDialogBox.isOpen,
    "File › Import opens a dialog"
  );
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  const page = gDialogBox.dialog._frame.contentWindow;
  Assert.equal(
    page.location.href,
    "chrome://browser/content/sval/import.xhtml",
    "and it is Sval's import, in the window's own dialog"
  );
  page.close();
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the import page closes"
  );
});

add_task(function downloads_shows_before_any_download() {
  const button = document.getElementById("downloads-button");
  Assert.ok(!button.hidden, "the downloads button is in the row");
  Assert.greater(
    button.getBoundingClientRect().width,
    0,
    "and drawn with nothing downloaded"
  );
});

add_task(async function a_private_window_offers_no_favorites() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window's opening"
  );
  await within(
    win.SvalPanel.started,
    10_000,
    "the private window's panel startup"
  );
  try {
    Assert.ok(
      win.SvalPanel._els.favoritesBar.hidden,
      "the private panel has no Favorites row"
    );
    const bookmarkPage = win.PlacesCommandHook.bookmarkPage;
    let firefoxBookmarked = false;
    win.PlacesCommandHook.bookmarkPage = () => (firefoxBookmarked = true);
    try {
      win.document.getElementById("Browser:AddBookmarkAs").doCommand();
    } finally {
      win.PlacesCommandHook.bookmarkPage = bookmarkPage;
    }
    Assert.ok(!firefoxBookmarked, "the bookmark shortcut is not Firefox's");
    await within(favorites.whenIdle(), 10_000, "favorites going idle");
    Assert.deepEqual(
      favorites.children(FAVORITES_ROOT),
      [],
      "and makes no favorite"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20_000,
      "the private window's closing"
    );
  }
});
