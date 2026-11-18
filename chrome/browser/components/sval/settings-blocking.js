/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Privacy and protection's Ad and tracker blocking card (blocking-engine
 * spec §3): the level, the lists, My filters and the allowed domains; the
 * confirmation dialog it shares with Sites, through which a level, a trusted
 * list and a site's reset, forgetting or clearing everywhere each ask; and
 * the Address bar buttons card. Every change is `SvalBlocking`'s, and its
 * topic redraws the card.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const { counted } = window.SvalSettingsHelpers;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    BLOCKING_TOPIC: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    MY_FILTERS_LIST: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    SvalSiteControls:
      "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });

  /**
   * What trusting a list allows, said wherever trust is granted: by the Trust
   * this list switch and by allowing a trusted list that arrived by sync.
   */
  const TRUST_WARNING =
    "Its publisher could then set cookies, click buttons, and rewrite responses on any site.";

  /** Each blocking level's name and what it does (protections spec §1.3). */
  const BLOCKING_LEVELS = {
    off: { label: "No Blocking", desc: "Nothing is blocked." },
    balanced: {
      label: "Balanced Blocking",
      desc: "Blocks ads and trackers with lists that rarely break sites.",
    },
    strict: {
      label: "Strict Blocking",
      desc: "Adds lists that block more, including trackers in links, social widgets, and scam sites. Some sites may break.",
    },
    custom: {
      label: "Custom",
      desc: "Pick any of the lists Sval knows, and add your own by address.",
    },
  };

  const SvalBlockingSettings = {
    /**
     * The blocking card's view: the list being added, the domain being
     * added, the last change with its Undo, the level, the list to trust,
     * the synced trusted list to allow, the site to reset, the site to
     * forget with what it holds, or the site to clear everywhere, waiting
     * on the confirmation, and the domains added while
     * the page has been open.
     */
    _blockingView: {
      adding: null,
      msg: "",
      undo: null,
      confirm: null,
      trust: null,
      trustShown: null,
      allow: null,
      reset: null,
      forget: null,
      clearEverywhere: null,
      alAdding: null,
      alMsg: "",
      alUndo: null,
      alRecent: [],
      mfShown: null,
      opener: null,
    },

    /**
     * Finds and wires the Ad and tracker blocking and Address bar buttons cards.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    /**
     * Opens the confirmation in the section `from` is in. A modal dialog
     * shows only while its ancestors render, and the blocking card and Sites
     * are in different categories.
     *
     * @param {Element} from An element of the section asking.
     */
    _showBlockingDialog(from) {
      const dialog = this._els.blockingDialog;
      from.closest("[data-sval-pane]").append(dialog);
      dialog.showModal();
    },

    _initBlocking(byId, lifetime) {
      Object.assign(this._els, {
        blockingLevelDesc: byId("sval-blocking-level-desc"),
        blockingLists: byId("sval-blocking-lists"),
        blockingStatus: byId("sval-blocking-status"),
        allowed: byId("sval-allowed"),
        allowedStatus: byId("sval-allowed-status"),
        blockingDialog: byId("sval-blocking-dialog"),
        blockingDialogTitle: byId("sval-blocking-dialog-title"),
        blockingDialogBody: byId("sval-blocking-dialog-body"),
        blockingDialogCancel: byId("sval-blocking-dialog-cancel"),
        blockingDialogConfirm: byId("sval-blocking-dialog-confirm"),
        blockingDialogAlt: byId("sval-blocking-dialog-alt"),
        blockingDialogTile: byId("sval-blocking-dialog-tile"),
        blockingDialogMore: byId("sval-blocking-dialog-more"),
        trustedScriptlets: byId("sval-trusted-scriptlets"),
        myFiltersNote: byId("sval-my-filters-note"),
        myFiltersText: byId("sval-my-filters-text"),
        myFiltersSave: byId("sval-my-filters-save"),
        myFiltersStatus: byId("sval-my-filters-status"),
        myFiltersTrusted: byId("sval-my-filters-trusted"),
        addressPins: {
          javascript: byId("sval-address-pin-javascript"),
          remove: byId("sval-address-pin-remove"),
          snip: byId("sval-address-pin-snip"),
        },
      });
      for (const radio of document.querySelectorAll(
        'input[name="sval-blocking-level"]'
      )) {
        radio.addEventListener("change", () =>
          this.chooseBlockingLevel(radio.value)
        );
      }
      this._els.blockingDialogCancel.addEventListener("click", () =>
        this._els.blockingDialog.close()
      );
      this._els.blockingDialogConfirm.addEventListener("click", () => {
        if (this._blockingView.reset) {
          this.confirmResetSite();
        } else if (this._blockingView.forget) {
          this.confirmForgetSite();
        } else if (this._blockingView.clearEverywhere) {
          this.confirmClearEverywhere();
        } else if (this._blockingView.trust) {
          this.confirmTrustList();
        } else if (this._blockingView.allow) {
          this.confirmAllowList(true);
        } else {
          this.confirmBlockingLevel();
        }
      });
      this._els.blockingDialogAlt.addEventListener("click", () =>
        this.confirmAllowList(false)
      );
      // A click on the dialog itself, not its contents, is a click on the
      // dimmed page around it.
      this._els.blockingDialog.addEventListener("click", event => {
        if (
          event.target === this._els.blockingDialog &&
          !this._blockingView.reset &&
          !this._blockingView.forget &&
          !this._blockingView.clearEverywhere
        ) {
          this._els.blockingDialog.close();
        }
      });
      // Closing without confirming leaves Custom, and its radio, as they were.
      // The dialog gives focus back to the control that opened it, and the
      // redraw keeps it there, or on that control's replacement.
      this._els.blockingDialog.addEventListener("close", () => {
        const opener = this._blockingView.opener;
        this._blockingView.confirm = null;
        this._blockingView.trust = null;
        this._blockingView.trustShown = null;
        this._blockingView.allow = null;
        this._blockingView.reset = null;
        this._blockingView.forget = null;
        this._blockingView.clearEverywhere = null;
        this._blockingView.opener = null;
        this._els.blockingDialogAlt.hidden = true;
        this._els.blockingDialogMore.hidden = true;
        this._els.blockingDialogMore.replaceChildren();
        this._els.blockingDialogConfirm.removeAttribute("aria-disabled");
        this._els.blockingDialogTile.hidden = true;
        this._els.blockingDialogTile.replaceChildren(this._glyph("trash-2"));
        delete this._els.blockingDialog.dataset.confirm;
        delete this._els.blockingDialog.dataset.list;
        this._els.blockingDialog.removeAttribute("role");
        this._els.blockingDialogConfirm.dataset.tone = "primary";
        this._describeBlocking(opener);
      });
      this._els.trustedScriptlets.addEventListener("change", () =>
        lazy.SvalBlocking.setTrustedScriptlets(
          this._els.trustedScriptlets.checked
        )
      );
      this._els.myFiltersText.addEventListener("input", () => {
        this._els.myFiltersStatus.textContent = "";
        delete this._els.myFiltersStatus.dataset.state;
        this._describeMyFilters(lazy.SvalBlocking.level);
      });
      this._els.myFiltersSave.addEventListener("click", () =>
        this.saveMyFilters()
      );
      // Trusting asks first; withdrawing trust does not.
      this._els.myFiltersTrusted.addEventListener("change", () => {
        const toggle = this._els.myFiltersTrusted;
        if (toggle.checked) {
          toggle.checked = false;
          this._askTrustList(lazy.MY_FILTERS_LIST, "My filters");
        } else {
          this._blockingChange(() =>
            lazy.SvalBlocking.setMyFiltersTrusted(false)
          );
        }
      });
      for (const [id, pin] of Object.entries(this._els.addressPins)) {
        pin.addEventListener("click", () =>
          lazy.SvalSiteControls.setPinned(
            id,
            pin.getAttribute("aria-pressed") != "true"
          )
        );
      }
      // Levels, lists and allowed domains move from sync, and a list's state
      // with each download.
      lifetime.topic(lazy.BLOCKING_TOPIC, () => {
        this._describeBlocking();
        // Sites with hidden elements are the sites My filters names.
        if (lazy.SvalBlocking.myFilters !== this._sitesFilters) {
          this._describeSites();
        }
      });
      // The site menu's pin buttons write the same pref.
      lifetime.pref(lazy.SvalSiteControls.PINS_PREF, () =>
        this._describeAddressPins()
      );
    },

    /**
     * The blocking card (protections spec §1.5): the level, the lists in
     * it, read-only under a curated level and editable under Custom, and the
     * allowed domains, editable at every level.
     *
     * @param {?(string|string[])} [next] Where focus goes when the redraw
     *   takes away the control that had it (`_keepFocus`).
     * @param {boolean} [take] As for `_keepFocus`.
     */
    _describeBlocking(next = null, take = false) {
      const bb = lazy.SvalBlocking;
      const level = bb.level;
      this._keepFocus(
        this._els.blockingLists.closest(".sval-card"),
        () => {
          if (!this._blockingView.confirm) {
            this._selectRadio("sval-blocking-level", level);
          }
          this._els.blockingLevelDesc.textContent = `${
            BLOCKING_LEVELS[level]?.label ?? ""
          }: ${BLOCKING_LEVELS[level]?.desc ?? ""}`;
          this._describeBlockingLists(level);
          this._describeAllowed(level);
          this._describeMyFilters(level);
          this._els.trustedScriptlets.checked = bb.trustedScriptlets;
        },
        next,
        take
      );
    },

    /**
     * Says what a switch to Custom started from, with an Undo back to it.
     *
     * @param {?string} from The curated level left, or null when the level
     *   was Custom already.
     * @param {string} [more] What else happened, after it.
     */
    _blockingSwitched(from, more = "") {
      const view = this._blockingView;
      if (from) {
        const label = BLOCKING_LEVELS[from].label;
        view.msg =
          `Now Custom, starting from ${label}'s lists. ${more}`.trimEnd();
        view.undo = { level: from };
      } else {
        view.msg = more;
        view.undo = null;
      }
    },

    /**
     * Runs a change through `SvalBlocking` and redraws, logging a failure by
     * its name.
     *
     * @param {Function} change Returns what `SvalBlocking` returned.
     * @param {?(string|string[])} [next] Where focus goes when the change
     *   takes away the control that had it.
     * @param {boolean} [take] As for `_keepFocus`.
     * @returns {Promise<*>} that, or undefined when it threw.
     */
    async _blockingChange(change, next = null, take = false) {
      let result;
      try {
        result = await change();
      } catch (err) {
        lazy.SvalLog.warn(
          `a blocking change failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._blockingView.msg = "Couldn't change blocking.";
        this._blockingView.undo = null;
      }
      this._describeBlocking(next, take);
      return result;
    },

    /**
     * A level radio. Custom starts from the level's lists; leaving Custom for
     * a curated level asks first, since it replaces the custom set.
     *
     * @param {string} level One of `SvalBlocking.LEVELS`.
     */
    async chooseBlockingLevel(level) {
      const bb = lazy.SvalBlocking;
      const view = this._blockingView;
      const current = bb.level;
      if (level === current) {
        return;
      }
      view.adding = null;
      if (level === "custom") {
        await this._blockingChange(async () => {
          const { switchedFrom } = await bb.customize();
          this._blockingSwitched(switchedFrom);
        }, ["blocking-undo", "level:custom"]);
        return;
      }
      if (current === "custom") {
        this._askBlockingLevel(level);
        return;
      }
      view.msg = "";
      view.undo = null;
      await this._blockingChange(() => bb.setLevel(level));
    },

    /**
     * Opens the confirmation for leaving Custom.
     *
     * @param {string} level A curated level.
     */
    _askBlockingLevel(level) {
      const bb = lazy.SvalBlocking;
      const label = BLOCKING_LEVELS[level].label;
      const added = bb.catalog().filter(list => list.user).length;
      let body = `${label}'s lists replace your custom set.`;
      if (added === 1) {
        body += " The list you added is removed.";
      } else if (added) {
        body += ` The ${added} lists you added are removed.`;
      }
      this._blockingView.confirm = level;
      this._els.blockingDialog.dataset.confirm = `level:${level}`;
      this._els.blockingDialogTitle.textContent = `Switch to ${label}?`;
      this._els.blockingDialogBody.textContent = body;
      this._els.blockingDialogConfirm.textContent = `Use ${label}`;
      this._blockingView.opener =
        document.activeElement?.dataset?.svalKey ?? null;
      this._showBlockingDialog(this._els.blockingLists);
      this._els.blockingDialogCancel.focus();
    },

    /** Applies the level the confirmation asked about. */
    async confirmBlockingLevel() {
      const level = this._blockingView.confirm;
      this._blockingView.confirm = null;
      this._els.blockingDialog.close();
      if (!level) {
        return;
      }
      this._blockingView.msg = `Switched to ${BLOCKING_LEVELS[level].label}.`;
      this._blockingView.undo = null;
      await this._blockingChange(() => lazy.SvalBlocking.setLevel(level));
    },

    /**
     * Opens the confirmation for trusting a list the user added.
     *
     * @param {string} id
     * @param {string} name
     */
    _askTrustList(id, name) {
      this._blockingView.trust = id;
      // What My filters held when asked, which is what a yes trusts.
      this._blockingView.trustShown =
        id === lazy.MY_FILTERS_LIST ? lazy.SvalBlocking.myFilters : null;
      this._els.blockingDialog.dataset.confirm = "trust";
      // Names the list asked about, which only the title's words say.
      this._els.blockingDialog.dataset.list = id;
      this._els.blockingDialogTitle.textContent = `Trust ${name}?`;
      this._els.blockingDialogBody.textContent = TRUST_WARNING;
      this._els.blockingDialogConfirm.textContent =
        id === lazy.MY_FILTERS_LIST ? "Trust filters" : "Trust list";
      this._blockingView.opener =
        document.activeElement?.dataset?.svalKey ?? null;
      this._showBlockingDialog(this._els.blockingLists);
      this._els.blockingDialogCancel.focus();
    },

    /** Trusts the list the confirmation asked about. */
    async confirmTrustList() {
      const id = this._blockingView.trust;
      const shown = this._blockingView.trustShown;
      // Rules that changed while the question was open are not the rules the
      // user was asked about, so the question stays, about the rules there
      // are now.
      if (
        id === lazy.MY_FILTERS_LIST &&
        shown !== lazy.SvalBlocking.myFilters
      ) {
        this._blockingView.trustShown = lazy.SvalBlocking.myFilters;
        this._els.blockingDialog.dataset.confirm = "trust-changed";
        this._els.blockingDialogBody.textContent = `My filters changed on another device while you were asked. ${TRUST_WARNING}`;
        return;
      }
      this._blockingView.trust = null;
      this._blockingView.trustShown = null;
      this._els.blockingDialog.close();
      if (!id) {
        return;
      }
      await this._blockingChange(
        () =>
          id === lazy.MY_FILTERS_LIST
            ? lazy.SvalBlocking.setMyFiltersTrusted(true, shown)
            : lazy.SvalBlocking.setListTrusted(id, true),
        `trust:${id}`
      );
    },

    /**
     * Opens the confirmation for allowing, on this device, a list trusted on
     * another. Allowing it trusts it here too, so the confirmation says so.
     * Trust is part of the synced list, so allowing it untrusted takes the
     * trust away on every device, and the confirmation says that as well.
     *
     * @param {string} id
     * @param {string} name
     */
    _askAllowList(id, name) {
      this._blockingView.allow = id;
      this._els.blockingDialog.dataset.confirm = "allow";
      this._els.blockingDialogTitle.textContent = `Allow and trust ${name}?`;
      this._els.blockingDialogBody.textContent = `It's trusted on another device. ${TRUST_WARNING} If you allow it untrusted, it loses its trust on every device.`;
      this._els.blockingDialogConfirm.textContent = "Allow and trust";
      this._els.blockingDialogAlt.textContent = "Allow untrusted";
      this._els.blockingDialogAlt.hidden = false;
      this._blockingView.opener =
        document.activeElement?.dataset?.svalKey ?? null;
      this._showBlockingDialog(this._els.blockingLists);
      this._els.blockingDialogCancel.focus();
    },

    /**
     * Allows the list the confirmation asked about.
     *
     * @param {boolean} trusted Whether it keeps its trust.
     */
    async confirmAllowList(trusted) {
      const id = this._blockingView.allow;
      this._blockingView.allow = null;
      this._els.blockingDialog.close();
      if (!id) {
        return;
      }
      await this._blockingChange(() => {
        lazy.SvalBlocking.setListTrusted(id, trusted);
        lazy.SvalBlocking.confirmList(id);
      }, [`list:${id}`, `trust:${id}`, "add-list"]);
    },

    /**
     * The lists: under a curated level its lists, read-only; under Custom
     * every list Sval knows, by category, each with a switch.
     *
     * @param {string} level
     */
    _describeBlockingLists(level) {
      const bb = lazy.SvalBlocking;
      const view = this._blockingView;
      const custom = level === "custom";
      const catalog = bb.catalog();
      const active = new Set(bb.activeListIds());
      const shown = custom
        ? catalog
        : catalog.filter(list => active.has(list.id));
      const order = bb.CATEGORIES.map(c => c.id);
      const rank = list => {
        const i = order.indexOf(list.category);
        return i < 0 ? order.length : i;
      };
      shown.sort((a, b) => rank(a) - rank(b));

      const body = this._els.blockingLists;
      body.textContent = "";

      const add = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "add-list" },
        },
        "Add list"
      );
      add.disabled = !!view.adding;
      add.addEventListener("click", () => {
        this._blockingView.adding = { text: "", category: "other" };
        this._describeBlocking();
        body.querySelector(".sval-agent-add-input")?.focus();
      });
      let count = "";
      if (shown.length) {
        count = custom
          ? `${active.size} of ${shown.length} on`
          : `${shown.length} in use`;
      }
      body.append(
        this._el(
          "div",
          { className: "sval-blocking-head" },
          this._el("h3", {}, "Lists"),
          this._el("span", { className: "sval-meta" }, count),
          this._el("span", { className: "sval-fp-spacer" }),
          add
        )
      );
      if (view.adding) {
        body.append(this._blockingAddRow(catalog));
      }

      if (!shown.length) {
        body.append(
          custom
            ? this._emptyState(
                "No lists yet",
                "Nothing is blocked until you add a list by its address."
              )
            : this._emptyState(
                "No lists in use",
                "Blocking is off. Choose a level to use its lists."
              )
        );
      }

      // One list per category, named by its heading.
      const lists = this._el("div", { className: "sval-blocking-list" });
      let list = null;
      const labels = new Map(bb.CATEGORIES.map(c => [c.id, c.label]));
      for (const entry of shown) {
        if (entry.category !== list?.dataset.category) {
          const id = `sval-blocking-category-${entry.category}`;
          list = this._el("div", {
            className: "sval-blocking-list",
            role: "list",
            ariaLabelledby: id,
            dataset: { category: entry.category },
          });
          lists.append(
            this._el(
              "h4",
              { className: "sval-blocking-category", id },
              labels.get(entry.category) ?? "Other"
            ),
            list
          );
        }
        list.append(this._blockingRow(entry, custom, active.has(entry.id)));
      }
      body.append(lists);

      if (!custom) {
        const known = catalog.length;
        const note = shown.length
          ? `Sval chooses ${BLOCKING_LEVELS[level].label}'s lists and keeps them updated. Sval knows ${known} lists. Choose Customize lists to pick from them or add your own.`
          : `Sval knows ${known} lists. Choose Customize lists to pick from them or add your own.`;
        const customize = this._el(
          "button",
          {
            type: "button",
            className: "sval-link",
            id: "sval-blocking-customize",
            dataset: { svalKey: "customize" },
          },
          "Customize lists"
        );
        customize.addEventListener("click", () =>
          this.chooseBlockingLevel("custom")
        );
        body.append(
          this._el(
            "p",
            { className: "sval-agents-note sval-blocking-ro" },
            this._el("span", {}, note),
            customize
          )
        );
      }

      const undo = view.undo;
      this._els.blockingStatus.dataset.customFrom = undo?.level ?? "";
      this._say(
        this._els.blockingStatus,
        view.msg,
        undo &&
          (() => {
            this._blockingView.msg = "";
            this._blockingView.undo = null;
            if (undo.level) {
              return this._blockingChange(
                () => lazy.SvalBlocking.setLevel(undo.level),
                `level:${undo.level}`
              );
            }
            return this._blockingChange(
              () => lazy.SvalBlocking.addList(undo.url, undo.category),
              "add-list"
            );
          }),
        "blocking-undo"
      );
    },

    /**
     * One list: its name, what licenses it, and its last download's trouble,
     * with a switch under Custom and a mark under a curated level.
     *
     * @param {object} entry From `SvalBlocking.catalog()`.
     * @param {boolean} custom
     * @param {boolean} on
     * @returns {Element}
     */
    _blockingRow(entry, custom, on) {
      const bb = lazy.SvalBlocking;
      const status = bb.listStatus(entry.id);
      const name = status?.title || entry.title;
      const head = this._el(
        "span",
        { className: "sval-fp-item-head" },
        this._el("span", { className: "sval-fp-label" }, name)
      );
      if (entry.user) {
        head.append(
          this._el("span", { className: "sval-agent-new" }, "Added by you")
        );
      }
      const words = this._el("span", { className: "sval-fp-words" }, head);
      const source = entry.license || entry.url || "";
      if (source) {
        words.append(
          this._el(
            "span",
            {
              className: "sval-agents-note sval-blocking-source",
              title: source,
            },
            source
          )
        );
      }
      // Only a list in use is downloaded, so only its trouble is news.
      let trouble = "";
      if (on && status?.state === "stale") {
        trouble = `Couldn't load this list today. Sval is using the copy from ${counted(
          status.ageDays ?? 0,
          "day"
        )} ago.`;
      } else if (on && status?.state === "never") {
        trouble = "Couldn't load this list. Nothing from it is blocked yet.";
      }
      const troubleId = `sval-blocking-trouble-${entry.id}`;
      if (trouble) {
        words.append(
          this._el(
            "span",
            { className: "sval-blocking-trouble", id: troubleId },
            this._glyph("circle-alert"),
            this._el("span", {}, trouble)
          )
        );
      }
      // A list added on another device downloads here only once the user
      // allows it on this one (SvalBlockingLists.CONFIRMED_LISTS_PREF).
      if (status?.state === "unconfirmed") {
        const allow = this._el(
          "button",
          {
            className: "sval-link",
            type: "button",
            dataset: { svalKey: `allow-list:${entry.id}` },
          },
          "Allow on this device"
        );
        allow.addEventListener("click", () => {
          if (entry.trusted || entry.trustedElsewhere) {
            this._askAllowList(entry.id, name);
          } else {
            this._blockingChange(
              () => bb.confirmList(entry.id),
              [`list:${entry.id}`, `trust:${entry.id}`, "add-list"]
            );
          }
        });
        words.append(
          this._el(
            "span",
            { className: "sval-agents-note" },
            "You added this list on another device. Sval downloads it here once you allow it. ",
            allow
          )
        );
      }

      // Trust another device gave is this device's to give too (spec §10.3),
      // through the same switch and confirmation.
      if (entry.trustedElsewhere && status?.state !== "unconfirmed") {
        words.append(
          this._el(
            "span",
            {
              className: "sval-agents-note",
              dataset: { note: "trusted-elsewhere" },
            },
            "You trusted this list on another device. Trust it here too to let it run trusted scriptlets on this device."
          )
        );
      }

      // Trusting asks first; withdrawing trust does not.
      if (entry.user) {
        const trust = this._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: !!entry.trusted,
          ariaLabel: `Trust this list: ${name}`,
          dataset: { svalTrust: entry.id, svalKey: `trust:${entry.id}` },
        });
        trust.addEventListener("change", () => {
          if (trust.checked) {
            trust.checked = false;
            this._askTrustList(entry.id, name);
          } else {
            this._blockingChange(() => bb.setListTrusted(entry.id, false));
          }
        });
        words.append(
          this._el(
            "label",
            { className: "sval-switch-row" },
            this._el(
              "span",
              { className: "sval-agents-note" },
              "Trust this list"
            ),
            trust
          )
        );
      }

      let control;
      if (custom) {
        control = this._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: on,
          ariaLabel: name,
          dataset: { svalList: entry.id, svalKey: `list:${entry.id}` },
        });
        if (trouble) {
          control.setAttribute("aria-describedby", troubleId);
        }
        control.addEventListener("change", () =>
          this._blockingChange(async () => {
            const { switchedFrom } = await bb.setListEnabled(
              entry.id,
              control.checked
            );
            this._blockingSwitched(switchedFrom);
          })
        );
      } else {
        control = this._el(
          "span",
          { className: "sval-blocking-on", title: "On at this level" },
          this._glyph("circle-check"),
          this._el(
            "span",
            { className: "sval-visually-hidden" },
            "On at this level"
          )
        );
      }
      const row = this._el(
        "div",
        {
          className: "sval-fp-item sval-blocking-row",
          role: "listitem",
          dataset: { svalList: entry.id },
        },
        control,
        words
      );
      if (custom && entry.user) {
        const remove = this._el(
          "button",
          {
            type: "button",
            className: "sval-agent-remove",
            ariaLabel: `Remove ${name}`,
            title: "Remove this list",
            dataset: { svalKey: `remove-list:${entry.id}` },
          },
          this._glyph("x")
        );
        remove.addEventListener("click", () =>
          this._blockingChange(
            async () => {
              await bb.removeList(entry.id);
              this._blockingView.msg = `${name} removed.`;
              this._blockingView.undo = {
                url: entry.url,
                category: entry.category,
              };
            },
            "blocking-undo",
            true
          )
        );
        row.append(remove);
      }
      return row;
    },

    /**
     * The row that adds a list by its https address, and what it blocks.
     *
     * @param {object[]} catalog Every list Sval knows.
     * @returns {Element}
     */
    _blockingAddRow(catalog) {
      const bb = lazy.SvalBlocking;
      const adding = this._blockingView.adding;
      const input = this._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        id: "sval-blocking-add-input",
        placeholder: "https://example.org/list.txt",
        spellcheck: false,
        value: adding.text,
        dataset: { svalKey: "adding-list" },
      });
      const category = this._el("select", {
        className: "sval-agent-select",
        ariaLabel: "What the list blocks",
        dataset: { svalKey: "adding-list-category" },
      });
      for (const { id, label } of bb.CATEGORIES) {
        category.append(this._el("option", { value: id }, label));
      }
      category.value = adding.category;
      const confirm = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: "adding-list-add" },
        },
        "Add"
      );
      const cancel = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "adding-list-cancel" },
        },
        "Cancel"
      );
      const preview = this._el("div", {
        className: "sval-agent-preview",
        id: "sval-blocking-add-preview",
        ariaLive: "polite",
      });
      input.setAttribute("aria-describedby", preview.id);
      const reading = () => {
        const text = (this._blockingView.adding?.text ?? "").trim();
        if (!text) {
          return { text, words: "Paste the address of a filter list." };
        }
        let url = null;
        try {
          url = new URL(text);
        } catch {}
        if (url?.protocol !== "https:" || !url.hostname) {
          return {
            text,
            words: "Enter a list address starting with https://.",
          };
        }
        if (catalog.some(list => list.url === url.href)) {
          return {
            text,
            words: "Sval already knows this list. Switch it on below.",
          };
        }
        const label = bb.CATEGORIES.find(
          c => c.id === this._blockingView.adding.category
        )?.label;
        return {
          text,
          can: true,
          words: `Sval fetches the list from this address, names it from its title, and keeps it updated. It goes under ${label}.`,
        };
      };
      const describe = () => {
        const { text, can, words } = reading();
        confirm.disabled = !can;
        input.setAttribute("aria-invalid", String(!!text && !can));
        preview.textContent = words;
      };
      const add = async () => {
        const { text, can } = reading();
        if (!can) {
          return;
        }
        const chosen = this._blockingView.adding.category;
        this._blockingView.adding = null;
        await this._blockingChange(async () => {
          try {
            const { switchedFrom } = await bb.addList(text, chosen);
            const host = new URL(text).hostname;
            this._blockingSwitched(switchedFrom, `Added ${host}.`);
          } catch (err) {
            this._blockingView.adding = { text, category: chosen };
            this._blockingView.msg =
              err?.message === "not-https"
                ? "Enter a list address starting with https://."
                : "That address isn't a list Sval can add.";
            this._blockingView.undo = null;
          }
        }, ["adding-list", "blocking-undo", "add-list"]);
      };
      input.addEventListener("input", () => {
        this._blockingView.adding = {
          ...this._blockingView.adding,
          text: input.value,
        };
        describe();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          add();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this._blockingView.adding = null;
          this._describeBlocking("add-list");
        }
      });
      category.addEventListener("change", () => {
        this._blockingView.adding = {
          ...this._blockingView.adding,
          category: category.value,
        };
        describe();
      });
      confirm.addEventListener("click", add);
      cancel.addEventListener("click", () => {
        this._blockingView.adding = null;
        this._describeBlocking("add-list");
      });
      describe();
      return this._el(
        "div",
        {
          className: "sval-agent-adding",
          role: "group",
          ariaLabel: "Add a filter list",
        },
        this._fieldLabel(input, "List address"),
        this._el(
          "div",
          { className: "sval-agent-adding-row" },
          input,
          category,
          confirm,
          cancel
        ),
        preview
      );
    },

    /**
     * My filters: the user's own rules, one per line, used with the level's
     * lists. A change from sync replaces the box's text only while the user
     * has not edited it, so a redraw never takes away unsaved rules.
     *
     * @param {string} level
     */
    _describeMyFilters(level) {
      const bb = lazy.SvalBlocking;
      const view = this._blockingView;
      const els = this._els;
      const stored = bb.myFilters;
      if (view.mfShown === null || els.myFiltersText.value === view.mfShown) {
        els.myFiltersText.value = stored;
        view.mfShown = stored;
      }
      els.myFiltersNote.dataset.changedElsewhere = String(
        bb.myFiltersChangedElsewhere
      );
      els.myFiltersNote.textContent = `${
        level === "off" ? "Blocking is off, so these have no effect now. " : ""
      }Write your own rules here, one per line, in uBlock Origin's syntax. Sval uses them with the lists, and they sync like the lists do.${
        bb.myFiltersChangedElsewhere
          ? " They changed on another device, so trust them here again to let them run trusted scriptlets."
          : ""
      }`;
      els.myFiltersSave.disabled = els.myFiltersText.value === stored;
      els.myFiltersTrusted.checked = bb.myFiltersTrusted;
    },

    /** Saves the box's rules, which rebuilds the engine with them. */
    async saveMyFilters() {
      const els = this._els;
      const text = els.myFiltersText.value;
      try {
        lazy.SvalBlocking.setMyFilters(text);
      } catch (err) {
        const tooLarge = err?.message === "too-large";
        els.myFiltersStatus.dataset.state = tooLarge ? "too-large" : "not-text";
        els.myFiltersStatus.textContent = tooLarge
          ? "These filters are too long to save."
          : "Filters can only hold plain text.";
        return;
      }
      this._blockingView.mfShown = null;
      this._describeBlocking();
      els.myFiltersStatus.dataset.state = "saved";
      els.myFiltersStatus.textContent = "Saved.";
    },

    /**
     * The allowed domains: requests to them, and to every address under
     * them, are never blocked, on any site (protections spec §1.2).
     *
     * @param {string} level
     */
    _describeAllowed(level) {
      const bb = lazy.SvalBlocking;
      const view = this._blockingView;
      const domains = bb.allowedDomains();
      const body = this._els.allowed;
      body.textContent = "";

      const add = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "add-domain" },
        },
        "Add domain"
      );
      add.disabled = !!view.alAdding;
      add.addEventListener("click", () => {
        this._blockingView.alAdding = { text: "" };
        this._blockingView.alMsg = "";
        this._blockingView.alUndo = null;
        this._describeBlocking();
        body.querySelector(".sval-agent-add-input")?.focus();
      });
      body.append(
        this._el(
          "div",
          { className: "sval-blocking-head" },
          this._el("h3", {}, "Allowed domains"),
          this._el(
            "span",
            { className: "sval-meta" },
            domains.length ? String(domains.length) : ""
          ),
          this._el("span", { className: "sval-fp-spacer" }),
          add
        ),
        this._el(
          "p",
          { className: "sval-agents-note" },
          `${
            level === "off"
              ? "Blocking is off, so these have no effect now. "
              : ""
          }Sval never blocks requests to these domains, on any site. To turn protections off for one site you visit, use Sites below.`
        )
      );
      if (view.alAdding) {
        body.append(this._allowedAddRow(domains));
      }
      if (!domains.length && !view.alAdding) {
        body.append(
          this._emptyState(
            "No allowed domains yet",
            "Add one when a list blocks something a site needs."
          )
        );
      }

      const recent = view.alRecent.filter(d => domains.includes(d));
      const order = [
        ...recent,
        ...domains.filter(d => !recent.includes(d)).sort(),
      ];
      const list = this._el("div", {
        className: "sval-blocking-list",
        role: "list",
        id: "sval-allowed-list",
      });
      for (const domain of order) {
        const remove = this._el(
          "button",
          {
            type: "button",
            className: "sval-agent-remove",
            ariaLabel: `Remove ${domain}`,
            title: "Remove",
            dataset: { svalKey: `remove-domain:${domain}` },
          },
          this._glyph("x")
        );
        remove.addEventListener("click", async () => {
          this._blockingView.alMsg = `${domain} removed. Lists can block it again.`;
          this._blockingView.alUndo = domain;
          this._blockingView.alRecent = this._blockingView.alRecent.filter(
            d => d !== domain
          );
          await this._blockingChange(
            () => bb.removeAllowedDomain(domain),
            "allowed-undo",
            true
          );
        });
        const words = this._el(
          "span",
          { className: "sval-agent-site", title: domain },
          domain
        );
        const cell = this._el("span", { className: "sval-fp-words" }, words);
        if (recent.includes(domain)) {
          cell.append(
            this._el("span", { className: "sval-agent-new" }, "Just added")
          );
        }
        list.append(
          this._el(
            "div",
            {
              className: "sval-fp-item sval-blocking-row",
              role: "listitem",
              dataset: { svalDomain: domain },
            },
            cell,
            remove
          )
        );
      }
      body.append(list);

      const domain = view.alUndo;
      this._say(
        this._els.allowedStatus,
        view.alMsg,
        domain &&
          (() => {
            this._blockingView.alMsg = "";
            this._blockingView.alUndo = null;
            return this._blockingChange(
              () => bb.addAllowedDomain(domain),
              [`remove-domain:${domain}`, "add-domain"]
            );
          }),
        "allowed-undo"
      );
    },

    /**
     * The row that adds an allowed domain. `SvalBlocking.addAllowedDomain`
     * decides what a domain is; the preview only says what Add will do.
     *
     * @param {string[]} domains The domains allowed now.
     * @returns {Element}
     */
    _allowedAddRow(domains) {
      const bb = lazy.SvalBlocking;
      const input = this._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        id: "sval-allowed-add-input",
        placeholder: "cdn.example.com",
        spellcheck: false,
        value: this._blockingView.alAdding.text,
        dataset: { svalKey: "adding-domain" },
      });
      const confirm = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: "adding-domain-add" },
        },
        "Add"
      );
      const cancel = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "adding-domain-cancel" },
        },
        "Cancel"
      );
      const preview = this._el("div", {
        className: "sval-agent-preview",
        id: "sval-allowed-add-preview",
        ariaLive: "polite",
      });
      input.setAttribute("aria-describedby", preview.id);
      const describe = () => {
        const text = input.value.trim();
        confirm.disabled = !text;
        input.setAttribute("aria-invalid", "false");
        preview.textContent = text
          ? "Sval never blocks requests to this domain or any address under it."
          : "Type a domain, or paste an address.";
      };
      const add = async () => {
        const text = input.value.trim();
        if (!text) {
          return;
        }
        let domain;
        try {
          domain = await bb.addAllowedDomain(text);
        } catch {
          input.setAttribute("aria-invalid", "true");
          preview.textContent = "Enter a domain like cdn.example.com.";
          return;
        }
        const view = this._blockingView;
        view.alAdding = null;
        view.alMsg = domains.includes(domain)
          ? `${domain} is already allowed.`
          : `Allowed ${domain}.`;
        view.alUndo = null;
        view.alRecent = [domain, ...view.alRecent.filter(d => d !== domain)];
        this._describeBlocking("add-domain");
      };
      input.addEventListener("input", () => {
        this._blockingView.alAdding = { text: input.value };
        describe();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          add();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this._blockingView.alAdding = null;
          this._describeBlocking("add-domain");
        }
      });
      confirm.addEventListener("click", add);
      cancel.addEventListener("click", () => {
        this._blockingView.alAdding = null;
        this._describeBlocking("add-domain");
      });
      describe();
      return this._el(
        "div",
        {
          className: "sval-agent-adding",
          role: "group",
          ariaLabel: "Add an allowed domain",
        },
        this._fieldLabel(input, "Domain"),
        this._el(
          "div",
          { className: "sval-agent-adding-row" },
          input,
          confirm,
          cancel
        ),
        preview
      );
    },

    /** Draws the pinned card's pin buttons from the pins pref. */
    _describeAddressPins() {
      const pins = lazy.SvalSiteControls.pins();
      for (const [id, pin] of Object.entries(this._els.addressPins)) {
        const pinned = pins.includes(id);
        pin.setAttribute("aria-pressed", String(pinned));
        pin.title = pinned
          ? "Unpin from the address bar"
          : "Pin to the address bar";
      }
    },
  };

  Object.assign(window.SvalSettings, SvalBlockingSettings);
}
