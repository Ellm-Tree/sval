/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The defaults at the top of Sites (decision 1484), drawn by Firefox's
 * `setting-group` like the rest of its settings, in the site menu's
 * controls (`SvalSiteControls`): what a site gets until it has a choice of
 * its own. JavaScript is Gecko's `javascript.enabled`, which
 * `SvalJavascript`'s site rules depart from; video and audio is the media
 * gate's default (protections spec §4.3). Each permission's default is the
 * `permissions.default.<type>` pref, which `SitePermissions.getDefault` and
 * `PermissionManager` answer a site with no choice from, offered with the
 * states the site menu offers. Pop-ups are Firefox's own
 * `popupAndRedirectPolicy` from `config/permissions-data.mjs`, and so are
 * pausing notifications and `enabledLNA`, which shows the local network
 * permissions where Firefox does.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    MEDIA_CHOICES:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    MEDIA_DEFAULT_PREF:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    PERMISSION_ICONS:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
    SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
    SvalSiteProtections:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    permissionLabel:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    permissionWords:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
  });

  const GROUP_ID = "svalSiteDefaults";

  /**
   * The permissions with a default, in the site menu's order, each with
   * whether only `enabledLNA` shows it. Pop-ups take their place among them.
   */
  const PERMISSIONS = [
    { type: "camera" },
    { type: "microphone" },
    { type: "geo" },
    { type: "desktop-notification" },
    { type: "popup" },
    { type: "local-network", lna: true },
    { type: "loopback-network", lna: true },
    { type: "xr" },
  ];

  /** @param {string} type */
  const settingOf = type => `svalSiteDefault-${type}`;

  /**
   * One row of the site menu's Permissions: the permission's glyph and
   * name, and its `sval-choice-pill`. `value` is the chosen state, as a
   * string, and a pick fires `change` from this row, the element
   * `setting-group` reads the value of.
   */
  class SvalPermissionDefault extends HTMLElement {
    #pill = document.createElement("sval-choice-pill");

    static get observedAttributes() {
      return ["disabled"];
    }

    connectedCallback() {
      if (this.#pill.isConnected) {
        return;
      }
      const icon = document.createElement("span");
      icon.className = `sval-glyph sval-glyph-${this.getAttribute("icon")} sval-site-perm-icon`;
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "sval-default-name";
      name.textContent = this.getAttribute("label");
      this.#pill.setAttribute("label", this.getAttribute("label"));
      this.#pill.addEventListener("change", event => {
        event.stopPropagation();
        this.dispatchEvent(new Event("change", { bubbles: true }));
      });
      this.append(icon, name, this.#pill);
    }

    attributeChangedCallback() {
      this.#pill.toggleAttribute("disabled", this.hasAttribute("disabled"));
    }

    set choices(choices) {
      this.#pill.choices = choices;
    }

    get choices() {
      return this.#pill.choices;
    }

    set value(value) {
      this.#pill.value = value;
    }

    get value() {
      return this.#pill.value;
    }

    focus(options) {
      this.#pill.focus(options);
    }
  }

  /**
   * The site menu's choice of one among a few: a label over one track of
   * segments, native radios that keep one Tab stop and the arrow keys.
   * `value` is the checked choice, and a pick fires `change`.
   */
  class SvalSegmentsDefault extends HTMLElement {
    /** @type {Array<[string, string]>} */
    #choices = [];
    #value = "";
    #track = null;

    connectedCallback() {
      if (this.#track) {
        return;
      }
      const label = document.createElement("span");
      label.className = "sval-default-name";
      label.id = `${this.id}-label`;
      label.textContent = this.getAttribute("label");
      this.#track = document.createElement("div");
      this.#track.className = "sval-segments sval-track";
      this.#track.setAttribute("role", "radiogroup");
      this.#track.setAttribute("aria-labelledby", label.id);
      this.append(label, this.#track);
      this.#draw();
    }

    set choices(choices) {
      this.#choices = choices;
      this.#draw();
    }

    get choices() {
      return this.#choices;
    }

    set value(value) {
      this.#value = value;
      for (const radio of this.#track?.querySelectorAll("input") ?? []) {
        radio.checked = radio.value === value;
      }
    }

    get value() {
      return this.#value;
    }

    focus(options) {
      this.#track?.querySelector("input:checked")?.focus(options);
    }

    #draw() {
      if (!this.#track) {
        return;
      }
      this.#track.replaceChildren(
        ...this.#choices.map(([value, word]) => {
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = this.id;
          radio.value = value;
          radio.checked = value === this.#value;
          radio.addEventListener("change", event => {
            // `setting-group` reads the value of the element a change
            // comes from, which is this one.
            event.stopPropagation();
            this.#value = value;
            this.dispatchEvent(new Event("change", { bubbles: true }));
          });
          const text = document.createElement("span");
          text.textContent = word;
          const segment = document.createElement("label");
          segment.className = "sval-segment";
          segment.append(radio, text);
          return segment;
        })
      );
    }
  }

  customElements.define("sval-permission-default", SvalPermissionDefault);
  customElements.define("sval-segments-default", SvalSegmentsDefault);

  /**
   * @param {string} type
   * @returns {Array<[string, string]>} The states the site menu offers for
   *   the permission, with Ask once, as `permissionWords` reads Unknown and
   *   Prompt alike.
   */
  function choicesOf(type) {
    const SP = lazy.SitePermissions;
    const words = lazy.permissionWords();
    const states = SP.getAvailableStates(type)
      .filter(state => words.has(state))
      .map(state => (state === SP.PROMPT ? SP.UNKNOWN : state));
    return [...new Set(states)].map(state => [String(state), words.get(state)]);
  }

  window.SvalSiteDefaultsSettings = {
    GROUP_ID,

    register() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting("svalSiteJavascript")) {
        return;
      }
      const SP = lazy.SitePermissions;
      const jsPref = lazy.SvalJavascript.ENABLED_PREF;
      if (!Preferences.get(jsPref)) {
        Preferences.add({ id: jsPref, type: "bool" });
      }
      Preferences.addSetting({ id: "svalSiteJavascript", pref: jsPref });

      const sp = lazy.SvalSiteProtections;
      Preferences.addSetting({
        id: "svalSiteMedia",
        get: () => sp.mediaDefault(),
        set: value => sp.setMediaDefault(value),
        setup: emitChange => {
          Services.prefs.addObserver(lazy.MEDIA_DEFAULT_PREF, emitChange);
          return () =>
            Services.prefs.removeObserver(lazy.MEDIA_DEFAULT_PREF, emitChange);
        },
      });

      const prefTypes = PERMISSIONS.filter(({ type }) => type !== "popup");
      Preferences.addAll(
        prefTypes.map(({ type }) => ({
          id: `permissions.default.${type}`,
          type: "int",
        }))
      );
      for (const { type, lna } of prefTypes) {
        Preferences.addSetting({
          id: settingOf(type),
          pref: `permissions.default.${type}`,
          get: state => String(state === SP.PROMPT ? SP.UNKNOWN : state),
          set: state => Number(state),
          ...(lna && {
            deps: ["enabledLNA"],
            visible: ({ enabledLNA }) => enabledLNA.value,
          }),
        });
      }
      Preferences.addSetting({
        id: settingOf("popup"),
        deps: ["popupAndRedirectPolicy"],
        get: (_value, { popupAndRedirectPolicy }) =>
          String(popupAndRedirectPolicy.value ? SP.BLOCK : SP.ALLOW),
        set: (state, { popupAndRedirectPolicy }) => {
          popupAndRedirectPolicy.value = Number(state) === SP.BLOCK;
        },
        disabled: ({ popupAndRedirectPolicy }) =>
          popupAndRedirectPolicy.disabled,
      });
      Preferences.addSetting({ id: "svalSitePermissionDefaults" });

      SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Defaults",
            description:
              "Every site gets these settings until you make a choice for it. You'll find a site's own choices on its page.",
            searchkeywords:
              "permissions javascript autoplay video audio camera microphone location notifications pop-ups popups",
          },
          items: [
            {
              id: "svalSiteJavascript",
              control: "moz-toggle",
              controlAttrs: {
                label: "Run JavaScript on every site",
                description:
                  "The JavaScript button next to the address bar turns JavaScript on or off for one site.",
              },
            },
            {
              id: "svalSiteMedia",
              control: "sval-segments-default",
              controlAttrs: {
                label: "Video and audio",
                ".choices": lazy.MEDIA_CHOICES,
              },
            },
            {
              id: "svalSitePermissionDefaults",
              control: "moz-fieldset",
              controlAttrs: { label: "Permissions" },
              items: PERMISSIONS.map(({ type }) => ({
                id: settingOf(type),
                control: "sval-permission-default",
                controlAttrs: {
                  label: lazy.permissionLabel(type),
                  icon: lazy.PERMISSION_ICONS[type],
                  ".choices": choicesOf(type),
                },
              })),
            },
            {
              id: "notificationsDoNotDisturb",
              l10nId: "permissions-notification-pause",
            },
          ],
        },
      });
    },
  };
}
