/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Colorshift, the site style editor (site styles spec §3): a dialog of its
 * own over the page, drawn from the site menu's parts, that sets a style's
 * tint, adjustments, theme and font for the selected tab's site. The page
 * shows each change as it is made; Save keeps the changes, and Cancel puts
 * back the page as the dialog found it.
 *
 * A style is saved at the page's host or its whole site, picked as the site
 * menu picks it (decision 1980). The editor opens at the host and shows the
 * style that applies there, and Save saves it at the scope in view.
 * Private windows keep nothing, so the editor is not offered there.
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import {
  ScopeDropdown,
  keepsLine,
  scopeChoices,
} from "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs";
import {
  STYLE_KEY,
  STYLE_NAME,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";
import {
  ADJUSTMENTS,
  DEFAULT_COMPLEMENT,
  STYLES_PREF,
  SvalSiteStyles,
  wrapAngle,
} from "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  glyph: "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs",
  scopeForURI: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

/** How far in from the page's top and end corner the dialog opens. */
const OPEN_INSET = 16;

export const STYLE_PANEL_ID = "sval-style-panel";

/** The site controls' Colorshift button, shown while the person pins it. */
export const COLORSHIFT_BUTTON_ID = "sval-colorshift-button";

/**
 * The command's name in the menu bar's Tab menu and the page context menu,
 * in the title case the other items there are written in.
 */
export const STYLE_MENU_LABEL = "Colorshift This Site…";

/** Each adjustment's slider label, in the order shown. */
const ADJUSTMENT_LABELS = {
  contrast: "Contrast",
  brightness: "Brightness",
  saturation: "Saturation",
};

/** Where the accent dot points before a person first moves it: blue. */
const DEFAULT_HUE = 220;

/** How far one arrow key moves a dot: degrees around, or percent out. */
const KEY_STEP = 5;
/** How far one arrow key moves a dot with Shift held. */
const KEY_STEP_LARGE = 15;

/**
 * Names for the hues around the wheel, each from its angle up to the next,
 * for a screen reader to say where a dot points.
 */
const HUE_NAMES = [
  [0, "Red"],
  [20, "Orange"],
  [45, "Yellow"],
  [75, "Green"],
  [160, "Teal"],
  [190, "Blue"],
  [255, "Purple"],
  [290, "Pink"],
  [340, "Red"],
];

/**
 * @param {number} hue Degrees, 0 to 359.
 * @returns {string} The hue's name.
 */
function hueName(hue) {
  return HUE_NAMES.findLast(([from]) => hue >= from)[1];
}

/**
 * @param {number} value An adjustment, -100 to 100.
 * @returns {string} It as a screen reader says it.
 */
function spoken(value) {
  if (!value) {
    return "No change";
  }
  return value > 0 ? `${value} percent more` : `${-value} percent less`;
}

/**
 * @param {number} value An adjustment, -100 to 100.
 * @returns {string} It as the slider shows it.
 */
function signed(value) {
  return value > 0 ? `+${value}` : String(value).replace("-", "\u2212");
}

/** The font choices, in the order listed, "" leaving the page's own. */
const FONT_CHOICES = [
  { value: "", text: "Original" },
  { value: "system", text: "System" },
  { value: "serif", text: "Serif" },
  { value: "mono", text: "Monospace" },
  { value: "readable", text: "Readable" },
];

/** The words that name a saved Colorshift in the site menu, part by part. */
const SUMMARY = {
  tint: hue => `${hueName(hue)} tint`,
  contrast: value => `contrast ${signed(value)}`,
  brightness: value => `brightness ${signed(value)}`,
  saturation: value => `saturation ${signed(value)}`,
  theme: theme => `${theme} theme`,
  font: {
    system: "system font",
    serif: "serif font",
    mono: "monospace font",
    readable: "readable font",
  },
};

/** What the site menu says of a site with a saved Colorshift. */
export const HAS_COLORSHIFT = "This site has a Colorshift.";

/**
 * @param {object} values A saved style's values.
 * @returns {string} What the style applies, for the site menu: its tint,
 *   adjustments, theme and font, in that order, as one line.
 */
export function describeStyle(values) {
  const parts = [];
  if (values.strength) {
    parts.push(SUMMARY.tint(values.hue));
  }
  for (const key of ADJUSTMENTS) {
    if (values[key]) {
      parts.push(SUMMARY[key](values[key]));
    }
  }
  if (values.theme) {
    parts.push(SUMMARY.theme(values.theme));
  }
  if (values.font) {
    parts.push(SUMMARY.font[values.font]);
  }
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * @param {Element} browser
 * @returns {?{site: string, host: string, choice: boolean}} The scopes a
 *   style for the tab's page can be saved at, or null where it can have
 *   none: a page with no site, or a private window's.
 */
export function styleScopeOf(browser) {
  if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
    return null;
  }
  return lazy.scopeForURI(browser.currentURI);
}

/** One window's editor. */
class StylePanel {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.panel = null;
    /** The tab the open editor styles. */
    this.browser = null;
    /** The scope picked in the title, or null for the page's host. */
    this.picked = null;
    /** Whether the panel moves the focus into itself once it shows. */
    this.focusOnShow = false;
    /** The values the dialog shows and the page previews, unsaved. */
    this.draft = null;
    /** Where the dialog stands, as `openPopupAtScreen` places it. */
    this.at = null;
    this.onStyles = () => this.redraw();
    this.observing = false;
  }

  /**
   * Follows the setting while the editor is open, so a change from a synced
   * device shows whether the host keeps a style of its own.
   *
   * @param {boolean} on
   */
  observe(on) {
    if (on === this.observing) {
      return;
    }
    this.observing = on;
    if (on) {
      Services.prefs.addObserver(STYLES_PREF, this.onStyles);
    } else {
      Services.prefs.removeObserver(STYLES_PREF, this.onStyles);
    }
  }

  mount() {
    const { doc } = this;
    const panel = doc.createXULElement("panel");
    panel.id = STYLE_PANEL_ID;
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Colorshift");
    // A panel that hides itself closes on a press anywhere outside it, the
    // page included (`nsXULPopupManager::Rollup`). The dialog stays while the
    // person works between it, the page and the site menu, and closes from
    // Save, Cancel, its Close button, Escape or a tab switch.
    panel.setAttribute("noautohide", "true");
    panel.addEventListener("popupshown", event => {
      if (event.target !== panel) {
        return;
      }
      this.drawPressed(true);
      if (this.focusOnShow) {
        this.focusOnShow = false;
        doc.commandDispatcher.advanceFocusIntoSubtree(panel);
      }
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target !== panel) {
        return;
      }
      this.observe(false);
      this.drawPressed(false);
      // The page goes back to its saved style, which Save has just written
      // or Cancel leaves as the dialog found it.
      if (this.browser) {
        SvalSiteStyles.endPreview(this.browser);
      }
      this.browser = null;
      this.picked = null;
      this.draft = null;
      this.focusOnShow = false;
    });
    this.movable(panel);
    panel.addEventListener("keydown", event => {
      // The scope dropdown and the font menu take their own Escape first.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        this.cancel();
      }
    });
    doc.getElementById("mainPopupSet").append(panel);
    this.panel = panel;
    this.win.gBrowser.tabContainer.addEventListener("TabSelect", () =>
      this.cancel()
    );
    // A closing window tears the panel down without its popuphidden
    // (`nsMenuPopupFrame::Destroy`).
    this.win.addEventListener("unload", () => this.observe(false), {
      once: true,
    });
  }

  /**
   * Marks the site controls' Colorshift button pressed while the dialog is
   * open.
   *
   * @param {boolean} open
   */
  drawPressed(open) {
    this.doc
      .getElementById(COLORSHIFT_BUTTON_ID)
      ?.setAttribute("aria-pressed", String(open));
  }

  /**
   * Lets the person move the dialog, as the element picker's card is moved:
   * by its title row or the bare surface around and between its sections.
   *
   * @param {Element} panel
   */
  movable(panel) {
    let grip = null;
    const onGrip = target => {
      const body = panel.firstElementChild;
      // The panel itself is also its window's shadow margin, which macOS
      // gives presses to (`nsCocoaWindow::SetInputRegion`).
      return (
        target === body ||
        (!!target.closest?.(".sval-style-head") &&
          !target.closest(".sval-scope, button"))
      );
    };
    // The dialog's place is kept as `openPopupAtScreen` took it. `moveTo`
    // takes the same place less the popup's margins, which it adds back
    // (`nsMenuPopupFrame::MoveTo`), so the move follows the pointer's travel
    // from where the press began.
    const placeOf = event => ({
      x: this.at.x + event.screenX - grip.x,
      y: this.at.y + event.screenY - grip.y,
    });
    panel.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !onGrip(event.target)) {
        return;
      }
      grip = { x: event.screenX, y: event.screenY };
      panel.setPointerCapture(event.pointerId);
      panel.toggleAttribute("moving", true);
      event.preventDefault();
    });
    panel.addEventListener("pointermove", event => {
      if (grip) {
        const { x, y } = placeOf(event);
        const style = this.win.getComputedStyle(panel);
        panel.moveTo(
          Math.round(x + parseFloat(style.marginLeft)),
          Math.round(y + parseFloat(style.marginTop))
        );
      }
    });
    const drop = event => {
      if (grip && event.type === "pointerup") {
        this.at = placeOf(event);
      }
      grip = null;
      panel.removeAttribute("moving");
    };
    panel.addEventListener("pointerup", drop);
    panel.addEventListener("lostpointercapture", drop);
  }

  /** @param {{focus?: boolean}} [options] */
  open({ focus = false } = {}) {
    const { win } = this;
    const browser = win.gBrowser.selectedBrowser;
    const scope = styleScopeOf(browser);
    if (!scope) {
      return;
    }
    if (this.panel.state !== "closed") {
      if (focus) {
        this.focusFirst();
      }
      return;
    }
    this.picked = null;
    this.focusOnShow = focus;
    this.browser = browser;
    this.draft = this.valuesAt(scope, this.scopeAt(scope));
    this.observe(true);
    this.render(scope);
    // The dialog opens over the page's top end corner, apart from any
    // button, and the person moves it from there.
    const page = browser.getBoundingClientRect();
    const width = parseFloat(
      win.getComputedStyle(this.panel).getPropertyValue("--panel-width")
    );
    const ltr = win.getComputedStyle(browser).direction !== "rtl";
    const left = ltr ? page.right - width - OPEN_INSET : page.left + OPEN_INSET;
    this.at = {
      x: Math.round(win.mozInnerScreenX + left),
      y: Math.round(win.mozInnerScreenY + page.top + OPEN_INSET),
    };
    this.panel.openPopupAtScreen(this.at.x, this.at.y, false);
  }

  /** Saves the dialog's values at the scope in view, and closes it. */
  saveAndClose() {
    const scope = this.browser && styleScopeOf(this.browser);
    if (scope && this.draft) {
      SvalSiteStyles.setStyle(this.scopeAt(scope), this.draft);
    }
    this.panel.hidePopup();
  }

  /** Closes the dialog, which gives the page back its saved style. */
  cancel() {
    this.panel.hidePopup();
  }

  /**
   * Changes the dialog's values and shows them on the page, unsaved.
   *
   * @param {object} patch The values that change, `undefined` for one the
   *   page takes back.
   * @param {boolean} [redraw] Whether the controls are drawn again, for a
   *   change no control drew itself.
   */
  change(patch, redraw = false) {
    if (!this.browser || this.panel.state === "closed") {
      return;
    }
    this.draft = { ...this.draft, ...patch };
    SvalSiteStyles.previewIn(this.browser, this.draft);
    if (redraw) {
      this.redraw();
    }
  }

  /** Draws the open editor again, after a change from here or a sync. */
  redraw() {
    const scope = this.browser && styleScopeOf(this.browser);
    if (!scope || this.panel.state === "closed") {
      this.panel.hidePopup();
      return;
    }
    this.render(scope);
  }

  /**
   * The editor's tab moved to another page. The dialog stays, its values
   * still unsaved, on a page of the same scope, and closes as Cancel does on
   * any other, whose style it does not edit.
   */
  onPageChanged() {
    const scope = this.browser && styleScopeOf(this.browser);
    if (!scope || this.scopeAt(scope) !== this.panel.dataset.scope) {
      this.cancel();
    }
  }

  /**
   * @param {object} scope From `styleScopeOf`.
   * @returns {string} The scope a change is saved at.
   */
  scopeAt(scope) {
    return this.picked === scope.site ? scope.site : scope.host;
  }

  /**
   * The values the editor shows at `at`: the scope's own style, and at the
   * host the style that applies there when the host has none.
   *
   * @param {object} scope
   * @param {string} at
   * @returns {object}
   */
  valuesAt(scope, at) {
    const own = SvalSiteStyles.styleAt(at);
    if (own || at !== scope.host) {
      return own ?? {};
    }
    return SvalSiteStyles.styleFor(scope.host)?.values ?? {};
  }

  /** Moves the focus to the first control that takes it. */
  focusFirst() {
    const first = ["sval-style-accent", "sval-style-theme-auto"]
      .map(id => this.doc.getElementById(id))
      .find(el => el && !el.disabled);
    first?.focus();
  }

  /** @param {object} scope */
  render(scope) {
    const { doc } = this;
    const at = this.scopeAt(scope);
    this.panel.dataset.scope = at;
    const values = { ...this.draft };
    const body = htmlElement(
      doc,
      "div",
      {
        className: "sval-prot-body sval-site-menu sval-style",
        // It scrolls, which would make it a stop of its own in the tab
        // order, ahead of the controls the focus moves into as it opens.
        tabIndex: -1,
      },
      ...this.head(scope, at),
      this.colorSection(scope, values),
      this.themeSection(scope, values),
      this.fontSection(scope, values),
      this.footer()
    );
    const focused = this.panel.querySelector(":focus")?.id;
    this.panel.replaceChildren(body);
    const again = focused && doc.getElementById(focused);
    if (again) {
      // A Lit control, as the theme's items are, has its focusable part once
      // it has rendered, and an item takes its tab index from its picker's
      // render.
      if (again.updateComplete) {
        const picker = again.closest("moz-visual-picker");
        Promise.all([picker?.updateComplete, again.updateComplete])
          .then(() => again.updateComplete)
          .then(() => again.focus());
      } else {
        again.focus();
      }
    }
  }

  /**
   * The title: the site, or on a host with a choice of scope, the scope
   * dropdown, as the site menu draws it, and the Close button.
   *
   * @param {object} scope
   * @param {string} at
   * @returns {Element[]}
   */
  head(scope, at) {
    const { doc } = this;
    const status = htmlElement(
      doc,
      "span",
      { className: "sval-prot-status" },
      "Allows you to change the site's look and feel. Changes sync to all your devices."
    );
    const close = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-dismiss sval-style-close",
        id: "sval-style-close",
        title: "Close",
        attrs: { "aria-label": "Close" },
      },
      lazy.glyph(doc, "sc-x")
    );
    close.addEventListener("click", () => this.cancel());
    let title;
    let keeps = null;
    if (scope.choice) {
      title = new ScopeDropdown(doc, {
        id: "sval-style-scope",
        choices: scopeChoices(scope),
        current: at,
        onPick: name => {
          // The dialog edits the style at one scope: the picked scope's own
          // takes the place of the values shown.
          this.picked = name;
          this.draft = this.valuesAt(scope, this.scopeAt(scope));
          SvalSiteStyles.previewIn(this.browser, this.draft);
          this.redraw();
        },
      }).listen().root;
      keeps =
        at === scope.site && SvalSiteStyles.styleAt(scope.host)
          ? keepsLine(scope.host, ["style"])
          : null;
    } else {
      title = htmlElement(
        doc,
        "span",
        { className: "sval-prot-domain" },
        scope.site
      );
    }
    return [
      htmlElement(
        doc,
        "div",
        { className: "sval-style-head" },
        htmlElement(doc, "div", { className: "sval-site-head" }, title, status),
        close
      ),
      keeps
        ? htmlElement(doc, "span", { className: "sval-scope-keeps" }, keeps)
        : null,
    ];
  }

  /**
   * @param {string} title
   * @returns {Element}
   */
  heading(title) {
    return htmlElement(
      this.doc,
      "div",
      { className: "sval-prot-label sval-site-label" },
      htmlElement(this.doc, "h2", { className: "sval-prot-heading" }, title)
    );
  }

  /**
   * The tint and the adjustments: the wheel, then a slider each for
   * contrast, brightness and saturation.
   *
   * @param {object} scope
   * @param {object} values
   */
  colorSection(scope, values) {
    const { doc } = this;
    const sliders = ADJUSTMENTS.map(key => this.slider(scope, values, key));
    return htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-style-color",
        attrs: { role: "group", "aria-label": "Color" },
      },
      this.heading("Color"),
      this.wheel(scope, values),
      htmlElement(doc, "div", { className: "sval-style-sliders" }, ...sliders)
    );
  }

  /**
   * The tint's wheel, after Zen Browser's: the accent dot's angle is the hue
   * the page's light colors take, and its distance from the middle the
   * tint's strength. The second dot, at the same distance, is the hue its
   * dark colors take. The middle is no tint.
   *
   * @param {object} scope
   * @param {object} values
   * @returns {Element}
   */
  wheel(scope, values) {
    const { doc } = this;
    const tint = {
      hue: values.hue ?? DEFAULT_HUE,
      strength: values.strength ?? 0,
      complement: values.complement ?? DEFAULT_COMPLEMENT,
    };
    const line = htmlElement(
      doc,
      "span",
      { className: "sval-prot-sub sval-style-wheel-line" },
      "Drag the big dot to tint the page. The farther it is from the middle, the stronger the tint."
    );
    const dot = (id, label) => {
      const el = htmlElement(doc, "div", {
        className: "sval-style-dot",
        id,
        tabIndex: 0,
        attrs: {
          role: "slider",
          "aria-label": label,
          "aria-valuemin": "0",
          "aria-valuemax": "359",
        },
      });
      return el;
    };
    const accent = dot("sval-style-accent", "Light colors");
    accent.ariaDescribedByElements = [line];
    const second = dot("sval-style-second", "Dark colors");
    second.classList.add("sval-style-dot-second");
    const ring = htmlElement(doc, "div", { className: "sval-style-ring" });
    const wheel = htmlElement(
      doc,
      "div",
      { className: "sval-style-wheel" },
      ring,
      second,
      accent
    );

    const draw = () => {
      const { hue, strength, complement } = tint;
      const reach = strength / 100;
      const place = (el, angle) => {
        const radians = (angle * Math.PI) / 180;
        el.style.setProperty("--sval-x", `${Math.sin(radians) * reach}`);
        el.style.setProperty("--sval-y", `${-Math.cos(radians) * reach}`);
        el.style.setProperty("--sval-style-hue", `hsl(${angle} 50% 55%)`);
        el.toggleAttribute("data-tinted", strength > 0);
      };
      place(accent, hue);
      place(second, hue + complement);
      ring.style.setProperty("--sval-reach", String(reach));
      accent.setAttribute("aria-valuenow", String(hue));
      accent.dataset.strength = String(strength);
      accent.setAttribute(
        "aria-valuetext",
        strength ? `${hueName(hue)}, strength ${strength} percent` : "No tint"
      );
      const secondHue = wrapAngle(hue + complement);
      second.setAttribute("aria-valuenow", String(secondHue));
      second.setAttribute(
        "aria-valuetext",
        strength ? hueName(secondHue) : "No tint"
      );
    };
    draw();

    const show = () => {
      draw();
      this.change({ ...tint });
    };

    // A press moves the accent dot to it, or picks up whichever dot it is
    // on, and the dot follows the pointer until it is let go.
    let dragging = null;
    const follow = event => {
      const rect = wheel.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const angle = wrapAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
      if (dragging === second) {
        tint.complement = wrapAngle(angle - tint.hue);
      } else {
        tint.hue = angle;
        tint.strength = Math.min(
          100,
          Math.round((Math.hypot(dx, dy) / (rect.width / 2)) * 100)
        );
      }
      show();
    };
    wheel.addEventListener("pointerdown", event => {
      if (event.button !== 0) {
        return;
      }
      dragging = event.target === second && tint.strength > 0 ? second : accent;
      dragging.focus();
      wheel.setPointerCapture(event.pointerId);
      wheel.toggleAttribute("moving", true);
      event.preventDefault();
      follow(event);
    });
    wheel.addEventListener("pointermove", event => {
      if (dragging) {
        follow(event);
      }
    });
    const drop = () => {
      wheel.removeAttribute("moving");
      dragging = null;
    };
    wheel.addEventListener("pointerup", drop);
    wheel.addEventListener("lostpointercapture", drop);

    const onKey = (event, isSecond) => {
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      const turn = { ArrowRight: step, ArrowLeft: -step }[event.key];
      const reach = { ArrowUp: step, ArrowDown: -step }[event.key];
      if (turn !== undefined) {
        if (isSecond) {
          tint.complement = wrapAngle(tint.complement + turn);
        } else {
          tint.hue = wrapAngle(tint.hue + turn);
        }
      } else if (reach !== undefined) {
        tint.strength = Math.max(0, Math.min(100, tint.strength + reach));
      } else if (event.key === "Home" || event.key === "End") {
        tint.strength = event.key === "Home" ? 0 : 100;
      } else {
        return;
      }
      event.preventDefault();
      show();
    };
    accent.addEventListener("keydown", event => onKey(event, false));
    second.addEventListener("keydown", event => onKey(event, true));

    return htmlElement(
      doc,
      "div",
      { className: "sval-style-wheel-row" },
      wheel,
      line
    );
  }

  /**
   * One adjustment's slider, from -100 to 100 with no change in the middle.
   * Dragging shows the value on the page, and letting go saves it.
   *
   * @param {object} scope
   * @param {object} values
   * @param {string} key One of `ADJUSTMENTS`.
   * @returns {Element}
   */
  slider(scope, values, key) {
    const { doc } = this;
    const id = `sval-style-${key}`;
    const value = values[key] ?? 0;
    const input = htmlElement(doc, "input", {
      type: "range",
      className: "sval-site-zoom-slider sval-style-slider",
      id,
      min: -100,
      max: 100,
      step: 5,
      value,
    });
    const output = htmlElement(doc, "output", {
      className: "sval-style-slider-value",
      htmlFor: id,
    });
    const draw = () => {
      const now = input.valueAsNumber;
      output.value = signed(now);
      input.setAttribute("aria-valuetext", spoken(now));
    };
    draw();
    input.addEventListener("input", () => {
      draw();
      this.change({ [key]: input.valueAsNumber });
    });
    return htmlElement(
      doc,
      "div",
      { className: "sval-style-slider-row" },
      htmlElement(
        doc,
        "label",
        { className: "sval-style-slider-label", htmlFor: id },
        ADJUSTMENT_LABELS[key]
      ),
      htmlElement(
        doc,
        "div",
        { className: "sval-site-zoom-track" },
        input,
        htmlElement(
          doc,
          "div",
          {
            className: "sval-site-zoom-ticks",
            attrs: { "aria-hidden": "true" },
          },
          ...this.ticks()
        )
      ),
      output
    );
  }

  /**
   * An adjustment slider's ticks, the zoom slider's marks: one each quarter
   * of the way, with no change in the middle marked as the zoom slider marks
   * its default.
   *
   * @returns {Element[]}
   */
  ticks() {
    return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => {
      const tick = htmlElement(this.doc, "span", {
        className:
          i === 4 ? "sval-site-zoom-tick named" : "sval-site-zoom-tick",
      });
      tick.style.setProperty("--sval-at", String(i / 8));
      return tick;
    });
  }

  /**
   * The site's theme, on the control Settings › Appearance › Theme uses
   * (`web-appearance-chooser`, `appearance.mjs`): Automatic leaves the page
   * the scheme Sval gives every site, and Light or Dark asks the site for
   * that theme and turns the page to it where it has none.
   *
   * @param {object} scope
   * @param {object} values
   */
  themeSection(scope, values) {
    const { doc } = this;
    const picker = htmlElement(doc, "moz-visual-picker", {
      id: "sval-style-theme",
      attrs: {
        name: "sval-style-theme",
        label: "Theme",
        value: values.theme ?? "auto",
      },
    });
    for (const [value, label, image] of [
      ["auto", "Automatic", "web-appearance-light.svg"],
      ["light", "Light", "web-appearance-light.svg"],
      ["dark", "Dark", "web-appearance-dark.svg"],
    ]) {
      picker.append(
        htmlElement(doc, "moz-visual-picker-item", {
          id: `sval-style-theme-${value}`,
          className: "setting-chooser-item",
          attrs: {
            value,
            label,
            imagesrc: `chrome://browser/content/preferences/${image}`,
          },
        })
      );
    }
    picker.addEventListener("change", () =>
      this.change({
        theme: picker.value === "auto" ? undefined : picker.value,
      })
    );
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-section", id: "sval-style-theme-section" },
      picker
    );
  }

  /**
   * The font, as a value button that opens a menu of the choices, as the
   * site menu's permissions are picked.
   *
   * @param {object} scope
   * @param {object} values
   */
  fontSection(scope, values) {
    const { doc } = this;
    const current = values.font ?? "";
    const { text } = FONT_CHOICES.find(c => c.value === current);
    const name = htmlElement(
      doc,
      "span",
      { className: "sval-style-color-label", id: "sval-style-font-label" },
      "Font"
    );
    const value = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-pill sval-prot-secondary sval-site-value",
        id: "sval-style-font",
        dataset: { font: current },
        attrs: { "aria-haspopup": "menu" },
      },
      text,
      lazy.glyph(doc, "sc-chevron-down", "sval-site-chevron")
    );
    value.ariaLabelledByElements = [name, value];
    value.addEventListener("click", () =>
      this.pickFont(scope, values, current, value)
    );
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-section", id: "sval-style-font-section" },
      htmlElement(doc, "div", { className: "sval-style-color" }, name, value)
    );
  }

  /**
   * Opens the font choices under the font's button.
   *
   * @param {object} scope
   * @param {object} values
   * @param {string} current
   * @param {Element} anchor
   */
  pickFont(scope, values, current, anchor) {
    const { doc } = this;
    const popup = doc.createXULElement("menupopup");
    popup.id = "sval-style-font-menu";
    for (const { value, text } of FONT_CHOICES) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("type", "radio");
      item.setAttribute("label", text);
      item.dataset.font = value;
      if (value === current) {
        item.setAttribute("checked", "true");
      }
      item.addEventListener("command", () =>
        this.change({ font: value || undefined }, true)
      );
      popup.append(item);
    }
    popup.addEventListener("popuphidden", () => popup.remove(), {
      once: true,
    });
    // Outside the panel, which a choice redraws.
    doc.getElementById("mainPopupSet").append(popup);
    popup.openPopup(anchor, "after_end");
  }

  /**
   * The dialog's buttons, as the element picker's card has them: Cancel,
   * then Save, primary and last. Reset comes first and leaves the dialog
   * open: it puts the page's own look back in the dialog, which Save then
   * keeps, removing a saved style, and Cancel undoes.
   */
  footer() {
    const { doc } = this;
    const button = (id, className, label, onClick) => {
      const el = htmlElement(
        doc,
        "button",
        { type: "button", className, id },
        label
      );
      el.addEventListener("click", onClick);
      return el;
    };
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-footer sval-style-footer" },
      button(
        "sval-style-reset",
        "sval-prot-pill sval-prot-secondary sval-style-reset",
        "Reset",
        () => {
          this.draft = {};
          SvalSiteStyles.previewIn(this.browser, this.draft);
          this.redraw();
          this.focusFirst();
        }
      ),
      button(
        "sval-style-cancel",
        "sval-prot-pill sval-prot-secondary sval-style-action",
        "Cancel",
        () => this.cancel()
      ),
      button(
        "sval-style-save",
        "sval-prot-pill sval-prot-primary sval-style-action",
        "Save",
        () => this.saveAndClose()
      )
    );
  }
}

/** window -> its StylePanel. */
const panels = new WeakMap();

/** The page context menu's item. */
export const STYLE_CONTEXT_ITEM_ID = "sval-context-site-style";

export const SvalSiteStylePanel = {
  STYLE_KEY,
  STYLE_MENU_LABEL,
  STYLE_NAME,

  /**
   * Adds the editor's item to the page context menu, after Take
   * Screenshot and shown where it shows, on a page that can have a style;
   * and keeps each tab's color scheme following its page's style.
   *
   * @param {Window} win A browser window, after its delayed startup.
   */
  startWindow(win) {
    SvalSiteStyles.init();
    const doc = win.document;
    const progress = {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (
          webProgress?.isTopLevel &&
          !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)
        ) {
          // The dialog first decides whether its preview stays on the new
          // page, which then shows its look.
          const panel = panels.get(win);
          if (panel?.browser === browser) {
            panel.onPageChanged();
          }
          SvalSiteStyles.onLocationChange(browser, location);
        }
      },
    };
    win.gBrowser.addTabsProgressListener(progress);
    win.addEventListener(
      "unload",
      () => win.gBrowser.removeTabsProgressListener(progress),
      { once: true }
    );
    const anchor = doc.getElementById("context-take-screenshot");
    if (!anchor) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = STYLE_CONTEXT_ITEM_ID;
    item.setAttribute("label", STYLE_MENU_LABEL);
    item.setAttribute("key", STYLE_KEY);
    item.hidden = true;
    anchor.after(item);
    item.addEventListener("command", () => this.open(win, { focus: true }));
    // On the window, so it runs after the menu's own `popupshowing`, which
    // makes `gContextMenu` and decides Take Screenshot.
    win.addEventListener("popupshowing", event => {
      if (event.target.id !== "contentAreaContextMenu") {
        return;
      }
      const menu = win.gContextMenu;
      item.hidden =
        !menu?.inTabBrowser ||
        menu.onTextInput ||
        menu.onLink ||
        menu.onEditable ||
        menu.onPassword ||
        !styleScopeOf(menu.browser);
      // Firefox placed the menu's separators for the items it showed
      // (`nsContextMenu.showHideSeparators`), before this ran.
      event.target.showHideSeparators?.();
    });
  },

  /**
   * @param {Window} win
   * @returns {boolean} Whether the selected tab's page can have a style.
   */
  offered(win) {
    return !!styleScopeOf(win.gBrowser.selectedBrowser);
  },

  /**
   * @param {Window} win
   * @returns {boolean} Whether the window's editor is open.
   */
  isOpen(win) {
    const state = panels.get(win)?.panel.state;
    return !!state && state !== "closed";
  },

  /**
   * Opens the editor for the selected tab's page, where it can have a style.
   *
   * @param {Window} win A browser window.
   * @param {{focus?: boolean}} [options] Whether the focus moves into it.
   */
  open(win, options) {
    let panel = panels.get(win);
    if (!panel) {
      panel = new StylePanel(win);
      panel.mount();
      panels.set(win, panel);
    }
    panel.open(options);
  },
};
