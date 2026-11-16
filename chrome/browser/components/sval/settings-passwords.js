/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Password manager and Security keys cards in Privacy and protection,
 * and the import and export windows the page opens. Choosing a password
 * manager calls `SvalPasswordManager`, the module first run calls, so the
 * answer is applied one way however it was reached.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalPasswordManager:
      "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs",
  });

  const SvalPasswordsSettings = {
    /**
     * Finds and wires the Password manager and Security keys cards.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     */
    _initPasswords(byId) {
      Object.assign(this._els, {
        passwordManager: byId("sval-password-manager"),
        passwordManagerStatus: byId("sval-password-manager-status"),
        passwordManagerSave: byId("sval-password-manager-save"),
        securityKeys: byId("sval-security-keys"),
        securityKeysOpen: byId("sval-security-keys-open"),
      });
      this._buildPasswordManagers();
      this._els.securityKeys.hidden = !(
        "@mozilla.org/network/protocol/about;1?what=webauthn" in Cc
      );
      this._els.securityKeysOpen.addEventListener("click", () =>
        window.browsingContext.topChromeWindow?.openTrustedLinkIn(
          "about:webauthn",
          "tab"
        )
      );
    },

    /**
     * One radio per manager this platform is offered, and "None of these",
     * with a button that applies the choice. Choosing installs an extension,
     * so a radio only selects: arrowing through the group passes over every
     * manager, and Gecko checks, and clicks, each radio it passes.
     */
    _buildPasswordManagers() {
      const { SvalPasswordManager } = lazy;
      for (const key of SvalPasswordManager.choices()) {
        const label = document.createElement("label");
        label.className = "sval-segment";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "sval-password-manager";
        radio.value = key;
        radio.addEventListener("change", () => {
          this._els.passwordManagerStatus.textContent = "";
          this._describePasswordManagerSave();
        });
        const name = document.createElement("span");
        name.textContent =
          SvalPasswordManager.managerFor(key)?.name ?? "None of these";
        label.append(radio, name);
        this._els.passwordManager.append(label);
      }
      this._els.passwordManagerSave.addEventListener("click", () => {
        const chosen = this._els.passwordManager.querySelector("input:checked");
        if (chosen) {
          this.choosePasswordManager(chosen.value);
        }
      });
    },

    _describePasswordManager() {
      // A choice being saved keeps its radio.
      if (this._els.passwordManager.getAttribute("aria-busy") === "true") {
        return;
      }
      this._selectRadio(
        "sval-password-manager",
        lazy.SvalPasswordManager.current()
      );
      this._describePasswordManagerSave();
    },

    /**
     * The button says what it does: Add extension for a manager, Save for
     * none, which installs nothing. It is off only while a choice is being
     * saved, and when nothing is chosen or to be chosen. Choosing the current
     * manager again installs its extension again after the user removed it.
     */
    _describePasswordManagerSave() {
      const { SvalPasswordManager } = lazy;
      const chosen =
        this._els.passwordManager.querySelector("input:checked")?.value ??
        SvalPasswordManager.NONE;
      const installs = !!SvalPasswordManager.managerFor(chosen);
      this._els.passwordManagerSave.dataset.action = installs
        ? "install"
        : "save";
      this._setText(
        this._els.passwordManagerSave,
        installs ? "Add extension" : "Save"
      );
      this._els.passwordManagerSave.disabled =
        this._els.passwordManager.getAttribute("aria-busy") === "true" ||
        (chosen === SvalPasswordManager.NONE &&
          SvalPasswordManager.current() === SvalPasswordManager.NONE);
    },

    /**
     * Records the password manager and installs its extension when it is
     * absent (spec §7.3). An install that fails keeps the choice and says so.
     *
     * @param {string} key One of `SvalPasswordManager.choices()`.
     */
    async choosePasswordManager(key) {
      const { SvalPasswordManager } = lazy;
      const group = this._els.passwordManager;
      const status = this._els.passwordManagerStatus;
      group.setAttribute("aria-busy", "true");
      this._describePasswordManagerSave();
      status.textContent = SvalPasswordManager.managerFor(key)
        ? "Adding its extension…"
        : "";
      let said;
      try {
        const result = await SvalPasswordManager.choose(key);
        said = result?.failed
          ? "Couldn't install it. Sval tries again the next time it starts."
          : "Saved.";
      } catch (err) {
        lazy.SvalLog.warn(
          `the password manager was not set: ${lazy.SvalLog.errorName(err)}`
        );
        said = "Couldn't change the password manager.";
      }
      group.removeAttribute("aria-busy");
      status.textContent = said;
      this._describePasswordManagerSave();
    },

    /**
     * Opens the import page over this tab's own window (import spec §5). The
     * panel of that window runs the import, so its tabs land where the user
     * is looking.
     */
    async openImport() {
      const panel =
        window.browsingContext.topChromeWindow?.SvalPanel ??
        (await this._startedPanel());
      await panel?.openImport();
    },

    /**
     * Opens the export page over this tab's own window (export spec §4), as
     * {@link openImport} opens import.
     *
     * @param {object} [options] As `SvalPanel.openExport` takes them.
     */
    async openExport(options) {
      const panel =
        window.browsingContext.topChromeWindow?.SvalPanel ??
        (await this._startedPanel());
      await panel?.openExport(options);
    },
  };

  Object.assign(window.SvalSettings, SvalPasswordsSettings);
}
