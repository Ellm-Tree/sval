/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's categories in `about:preferences` (spec §10.8). `SvalPreferences`
 * loads this into the page before the page's own scripts run, so the
 * `DOMContentLoaded` listener below runs ahead of `init_all`: each category's
 * nav button and pane container exist, and are registered, before `gotoPref`
 * reads the URL's hash.
 *
 * A pane is a container in `#mainPrefPane` carrying `data-category`, which is
 * how `preferences.js`' `search` shows and hides every pane's elements. The
 * containers are empty at first and filled from `settings-panes.html` as soon
 * as it arrives, because `gotoPref` shows a pane synchronously and only a
 * container that already exists can be shown.
 */

"use strict";

{
  const { paneName } = window.SvalSettingsHelpers;
  const PANES_URL = "chrome://browser/content/sval/settings-panes.html";
  const { iconURL } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIcons.sys.mjs"
  );

  /**
   * Sval's categories. `id` is the friendly name that goes in the URL's hash
   * (`about:preferences#svalSync`); `preferences.js` turns it into the pane
   * name `paneSvalSync`. Where each sits in the nav is `NAV_ORDER`'s.
   */
  const CATEGORIES = [
    { id: "svalSync", label: "Sync and devices", icon: "sync" },
    { id: "svalLinks", label: "Links", icon: "links" },
    { id: "svalSites", label: "Sites", icon: "sites" },
    { id: "svalExtensions", label: "Extensions", icon: "extensions-settings" },
    { id: "svalAgents", label: "Agents", icon: "agents" },
    { id: "svalKeyboard", label: "Keyboard shortcuts", icon: "keyboard" },
  ];

  /**
   * The nav, by button id: these first, in this order, then any category
   * not named here in the order Firefox gives them, then `NAV_LAST` after a
   * separator.
   */
  const NAV_ORDER = [
    "category-sync",
    // Firefox's Home category, which Sval names Workspaces.
    "category-home",
    "category-svalLinks",
    "category-svalSync",
    "category-appearance",
    "category-search",
    // Firefox's Privacy and security, which Sval names Privacy and
    // protection.
    "category-privacy",
    "category-svalSites",
    "category-svalExtensions",
    "category-svalAgents",
    "category-svalKeyboard",
  ];

  /** Firefox's own separator, then About. */
  const NAV_LAST = ["nav-separator", "category-about-firefox"];

  /**
   * Firefox's categories with nothing left to show in Sval. Their buttons
   * leave the nav; `LegacyPaneMappings` sends their addresses to the category
   * that holds their topic.
   */
  const NAV_REMOVED = [
    // Sval turns off Firefox's password manager and card autofill (spec
    // §7.3), and Sval's own password setting is in Privacy and protection.
    "category-passwords-autofill",
    // Their groups are in General, Workspaces and Appearance.
    "category-downloads",
    "category-tabs-browsing",
    "category-accessibility",
    "category-languages",
    // Sites holds the permission defaults, and each site's page its
    // permissions.
    "category-permissions-data",
  ];

  /**
   * Sections of Sval's that belong in one of Firefox's own categories, because
   * that category already holds their topic. `after` or `before` is the
   * element the section sits beside: a setting group, or `moz-page-header`
   * for the top of the category. Firefox's `setting-pane` renders its groups
   * only when it is first shown, so the section moves into place on
   * `paneshown`, once. Sections sharing an `after` land in reverse order of
   * this list, and sections sharing a `before` in its order.
   */
  const SECTIONS = [
    {
      // Firefox's Home category, which Sval names Workspaces, holds the home
      // page group; whether the home page shows Favorites follows it.
      id: "svalHomeFavorites",
      category: "paneHome",
      after: 'setting-group[groupid="homepage"]',
    },
    {
      id: "svalTabArchive",
      category: "paneHome",
      before: 'setting-group[groupid="importBrowserData"]',
    },
    {
      id: "svalPins",
      category: "paneHome",
      before: 'setting-group[groupid="importBrowserData"]',
    },
    {
      // Battery Saver, after the Warnings below it in this list.
      id: "svalBatterySaver",
      category: "paneSync",
      after: 'setting-group[groupid="defaultBrowserSync"]',
    },
    {
      // Firefox's quit and many-tabs warnings, after the default browser
      // and what a launch does.
      id: "svalWarnings",
      category: "paneSync",
      after: 'setting-group[groupid="defaultBrowserSync"]',
    },
    {
      id: "svalPanelSide",
      category: "paneAppearance",
      after: "moz-page-header",
    },
    {
      id: "svalAddressBar",
      category: "paneAppearance",
      after: 'setting-group[groupid="appearance"]',
    },
    {
      // A heading over the accessibility groups Appearance takes in.
      id: "svalAccessibility",
      category: "paneAppearance",
      before: 'setting-group[groupid="zoom"]',
    },
    {
      id: "svalUpdates",
      category: "paneAbout",
      after: 'setting-group[groupid="updates"]',
    },
    {
      id: "svalDiagnostics",
      category: "paneAbout",
      after: 'setting-group[groupid="support"]',
    },
    {
      id: "svalKagi",
      category: "paneSearch",
      after: 'setting-group[groupid="defaultEngine"]',
    },
    {
      id: "svalLauncher",
      category: "paneSearch",
      after: 'setting-group[groupid="searchSuggestions"]',
    },
    // Privacy and protection, in this order: Sval's cards
    // around Firefox's HTTPS-Only, browsing protection and history groups.
    {
      id: "svalBlocking",
      category: "panePrivacy",
      before: 'setting-group[groupid="httpsOnly"]',
    },
    {
      id: "svalCookies",
      category: "panePrivacy",
      before: 'setting-group[groupid="httpsOnly"]',
    },
    {
      id: "svalFingerprinting",
      category: "panePrivacy",
      before: 'setting-group[groupid="httpsOnly"]',
    },
    {
      id: "svalSignals",
      category: "panePrivacy",
      before: 'setting-group[groupid="httpsOnly"]',
    },
    {
      id: "svalSecureDns",
      category: "panePrivacy",
      after: 'setting-group[groupid="httpsOnly"]',
    },
    {
      id: "svalBreaches",
      category: "panePrivacy",
      before: 'setting-group[groupid="browsingProtection"]',
    },
    {
      id: "svalPasswords",
      category: "panePrivacy",
      before: 'setting-group[groupid="history2"]',
    },
    {
      // The category's advanced settings, after its last group.
      id: "svalPrivacyAdvanced",
      category: "panePrivacy",
      after: 'setting-group[groupid="history2"]',
    },
    {
      // Under History, which holds Always use private browsing mode.
      id: "svalPrivateWindows",
      category: "panePrivacy",
      after: 'setting-group[groupid="history2"]',
    },
  ];

  /** The sections of Privacy and protection `SvalSettings.showPane` shows. */
  const PRIVACY_SECTIONS = new Set(["tracking", "secureDns"]);

  /**
   * `#svalProtections-site?host=…` names a site's page, which is in Sites.
   * `LegacyPaneMappings` maps a category, and would drop the
   * site, so the address is rewritten before `gotoPref` reads it: at load,
   * and on `hashchange`, whose listener here is added before `init_all` adds
   * Firefox's.
   */
  const OLD_SITE_PAGE = "#svalProtections-site?";
  const followOldSitePage = () => {
    if (location.hash.startsWith(OLD_SITE_PAGE)) {
      history.replaceState(
        history.state,
        "",
        `#svalSites-site?${location.hash.slice(OLD_SITE_PAGE.length)}`
      );
    }
  };
  followOldSitePage();
  window.addEventListener("hashchange", followOldSitePage);

  const stylesheet = () => {
    const link = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "link"
    );
    link.rel = "stylesheet";
    link.href = "chrome://browser/content/sval/settings.css";
    const loaded = new Promise(resolve => {
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
    });
    document.head.append(link);
    return loaded;
  };

  /**
   * Fetches the panes' markup and moves each pane's contents into its
   * container. `SvalSettings` starts once they are all in place.
   *
   * A stylesheet a script inserts applies at once only when Gecko's shared
   * sheet cache holds it (`css::Loader::CreateSheet`); otherwise it loads
   * asynchronously. `settings.css` lays the cards out, so the panes arrive
   * only once it has applied: before that they would show unstyled.
   *
   * @param {Map<string, Element>} containers By friendly name.
   * @param {Promise} styled Settles once `settings.css` has loaded or failed.
   */
  async function fill(containers, styled) {
    const [markup] = await Promise.all([
      fetch(PANES_URL).then(response => response.text()),
      styled,
    ]);
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    for (const section of parsed.querySelectorAll("[data-sval-pane]")) {
      const container = containers.get(section.dataset.svalPane);
      if (!container) {
        continue;
      }
      container.append(document.importNode(section, true));
    }
    // Firefox configures its setting groups as its panes start, which can
    // be before these panes arrive, so the ones they carry are configured
    // here.
    window.SvalSecureDnsSettings.register();
    window.initSettingGroup(window.SvalSecureDnsSettings.GROUP_ID);
    window.SvalArchiveSettings.register();
    window.initSettingGroup(window.SvalArchiveSettings.GROUP_ID);
    window.SvalWarningsSettings.register();
    window.initSettingGroup(window.SvalWarningsSettings.GROUP_ID);
    window.SvalBatterySaverSettings.register();
    window.initSettingGroup(window.SvalBatterySaverSettings.GROUP_ID);
    window.SvalBatterySaverSettings.ready().catch(err =>
      window.SvalSettings.log(`showing Battery Saver failed: ${err?.name}`)
    );
    window.SvalCookiesSettings.register();
    window.initSettingGroup(window.SvalCookiesSettings.GROUP_ID);
    window.SvalSiteDefaultsSettings.register();
    window.initSettingGroup(window.SvalSiteDefaultsSettings.GROUP_ID);
    window.SvalExtensionsSettings.registerUpdates();
    window.initSettingGroup(window.SvalExtensionsSettings.UPDATES_GROUP_ID);
    window.SvalExtensionsSettings.registerInstall();
    window.initSettingGroup(window.SvalExtensionsSettings.INSTALL_GROUP_ID);
    // Firefox's own groups, which Privacy and protection's Advanced holds.
    window.initSettingGroup("certificates");
    window.initSettingGroup("networkProxy");
    window.SvalKeyboardSettings.init();
    window.SvalExtensionsSettings.init();
    window.SvalSettings.init();
    window.SvalLinksSettings.init();
    // Says the panes are in and every handler above is bound, for whatever
    // drives the page from outside it.
    document.documentElement.dataset.svalSettings = "ready";
  }

  /**
   * Puts the nav in `NAV_ORDER`. Firefox's buttons are in the page's markup
   * by now and Sval's were just added, so every button named is here; the
   * buttons Firefox adds later, for its sub-pages, never show.
   *
   * @param {Element} nav
   */
  function arrangeNav(nav) {
    const byId = id => document.getElementById(id);
    for (const id of NAV_REMOVED) {
      byId(id)?.remove();
    }
    const named = new Set([...NAV_ORDER, ...NAV_LAST]);
    nav.append(
      ...NAV_ORDER.map(byId).filter(Boolean),
      ...[...nav.children].filter(el => !named.has(el.id)),
      ...NAV_LAST.map(byId).filter(Boolean)
    );
  }

  function mount() {
    const styled = stylesheet();
    const nav = document.getElementById("categories");
    const first = document.getElementById("category-general");
    const pane = document.getElementById("mainPrefPane");
    const containers = new Map();

    for (const category of CATEGORIES) {
      const name = paneName(category.id);
      const button = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "moz-page-nav-button"
      );
      button.id = `category-${category.id}`;
      button.setAttribute("view", name);
      button.setAttribute("iconsrc", iconURL(category.icon));
      // `title` names the button when the nav collapses to icons and hides
      // its text.
      button.setAttribute("title", category.label);
      button.textContent = category.label;
      nav.insertBefore(button, first);

      const container = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div"
      );
      container.className = "sval-pane";
      container.dataset.category = name;
      // The pane's title wears the nav button's icon, as Firefox's
      // `moz-page-header` wears its category's (`settings.css`).
      container.style.setProperty(
        "--sval-pane-icon",
        `url("${iconURL(category.icon)}")`
      );
      container.hidden = true;
      pane.append(container);
      containers.set(category.id, container);

      window.register_module(name, {
        init() {},
        handleSubcategory(subcategory) {
          return window.SvalSettings.showPane(category.id, subcategory);
        },
      });
    }

    for (const section of SECTIONS) {
      // Until the category is first shown, the container is one of
      // `#mainPrefPane`'s own, shown and hidden with the category's other
      // elements.
      const container = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div"
      );
      container.className = "sval-pane sval-pane-section";
      container.dataset.category = section.category;
      container.hidden = true;
      pane.append(container);
      containers.set(section.id, container);

      document.addEventListener("paneshown", event => {
        if (event.detail.category !== section.category) {
          return;
        }
        const anchor = pane.querySelector(
          `[data-category="${section.category}"] ${section.after ?? section.before}`
        );
        if (anchor && !anchor.parentNode.contains(container)) {
          if (section.after) {
            anchor.after(container);
          } else {
            anchor.before(container);
          }
          container.hidden = false;
        }
      });
    }

    // The Extensions category takes the place of Firefox's footer link to
    // add-ons. The link is hidden rather than removed:
    // `init_all` adds its click listener by id once the first pane shows.
    const addons = document.getElementById("addonsButton");
    if (addons) {
      addons.hidden = true;
    }

    arrangeNav(nav);

    // The user's card, at the foot of the nav after Firefox's own footer
    // links: the card itself while the nav shows labels, and an icon once it
    // narrows to icons (`settings.css`). Either opens the card dialog over
    // the browser window, as the View menu's item does.
    const html = tag =>
      document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const openCard = () =>
      ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
      ).openCardDialog(window.browsingContext.topChromeWindow);
    const cardIcon = html("moz-page-nav-button");
    cardIcon.id = "sval-card-button";
    cardIcon.slot = "secondary-nav";
    cardIcon.setAttribute(
      "iconsrc",
      "chrome://browser/content/sval/card/card-icon.svg"
    );
    cardIcon.setAttribute("title", "Your Sval Card");
    cardIcon.textContent = "Your Sval Card";
    cardIcon.addEventListener("click", openCard);
    const cardFace = html("button");
    cardFace.id = "sval-nav-card";
    cardFace.type = "button";
    cardFace.slot = "secondary-nav";
    cardFace.setAttribute("aria-label", "Your Sval Card");
    cardFace.addEventListener("click", openCard);
    nav.append(cardIcon, cardFace);
    const { readCard, CARD_PREF } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalCard.sys.mjs"
    );
    const drawCard = async () => {
      // The card's layers take their size from `card.css`, which comes with
      // `settings.css`. Drawn before that applies, the glow's canvas is laid
      // out at its bitmap's size, and each repaint at the device's pixel
      // ratio multiplies that size by the ratio, without end.
      await styled;
      const card = readCard();
      if (!card) {
        cardFace.replaceChildren();
        return;
      }
      const { renderCard } = ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
      );
      cardFace.replaceChildren(await renderCard(document, card));
    };
    drawCard().catch(() => {});
    // An Arc import or another device's sync can change the card while the
    // page is open.
    const cardChanged = () => drawCard().catch(() => {});
    const { SvalScope } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalScope.sys.mjs"
    );
    SvalScope.forWindow(window).pref(CARD_PREF, cardChanged);
    document
      .getElementById("category-home")
      ?.setAttribute("iconsrc", iconURL("workspaces"));
    document
      .getElementById("category-privacy")
      ?.setAttribute("iconsrc", iconURL("privacy"));

    // Privacy and protection and General are Firefox's categories, so Sval's
    // sections in them are reached here rather than through a module of
    // Sval's.
    document.addEventListener("paneshown", event => {
      const { category, subcategory } = event.detail;
      if (category === "panePrivacy" && PRIVACY_SECTIONS.has(subcategory)) {
        window.SvalSettings.showPane("privacy", subcategory);
      } else if (category === "paneSync" && subcategory === "batterySaver") {
        window.SvalBatterySaverSettings.show().catch(err =>
          window.SvalSettings.log(`showing Battery Saver failed: ${err?.name}`)
        );
      }
    });

    // Search results show advanced settings too: a match is what was asked
    // for, and a match inside a closed disclosure would not show.
    document.addEventListener("paneshown", event => {
      if (event.detail.category === "paneSearchResults") {
        for (const details of document.querySelectorAll(
          "details.sval-advanced"
        )) {
          details.open = true;
        }
      }
    });

    fill(containers, styled).catch(err =>
      window.SvalSettings.log(`sval's settings did not load: ${err?.name}`)
    );
  }

  document.addEventListener("DOMContentLoaded", mount, { once: true });
}
