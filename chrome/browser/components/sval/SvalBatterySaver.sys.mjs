/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Battery Saver: while it is on, pages draw at no more than 60 frames a
 * second, a background tab's timers get a fifth of the CPU budget Firefox
 * gives them, and a Workspace no window shows goes to sleep after
 * {@link BATTERY_SAVER_UNLOAD_MS} (`hiddenWorkspaceUnloadMs` in `SvalTabs`).
 *
 * {@link MODE_PREF} says when it is on: always, never, or while the computer
 * runs on battery. The power source is chrome `navigator.getBattery()`'s
 * `charging`, false on battery. A computer with no battery reports charging
 * (`kDefaultCharging` in `dom/battery/Constants.h`).
 *
 * The two Gecko prefs change on the default branch, so a value the user set
 * still wins and nothing reaches prefs.js. Each is read live:
 * `gfx.display.max-frame-rate` on every vsync (`ComputeFrameRateDivisor`),
 * the regeneration rate whenever a background budget is updated
 * (`GetRegenerationFactor` in `TimeoutManager.cpp`).
 *
 * Turning it off or on for now, from the header's button or the Tools menu,
 * flips the state until the power source next changes or Sval restarts.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import { SvalPopover } from "moz-src:///browser/components/sval/SvalPopover.sys.mjs";

export const MODE_PREF = "browser.sval.batterySaver.mode";

/** Observers hear this after Battery Saver turns on or off. */
export const CHANGED_TOPIC = "sval-battery-saver-changed";

export const BUTTON_ID = "sval-battery-saver-button";
export const PANEL_ID = "sval-battery-saver-panel";
export const MENU_ITEM_ID = "sval-menu-battery-saver";

/** How long a hidden Workspace stays awake while Battery Saver is on. */
export const BATTERY_SAVER_UNLOAD_MS = 30 * 60 * 1000;

/**
 * Each pref's value while Battery Saver is on. The regeneration rate is the
 * milliseconds a background tab takes to earn 1 ms of timer budget, 100 by
 * default, so 500 leaves it a fifth.
 */
export const SAVER_PREFS = {
  "gfx.display.max-frame-rate": 60,
  "dom.timeout.background_budget_regeneration_rate": 500,
};

/** The Settings section Battery Saver's choice is in. */
const SETTINGS_PANE = "paneSync-batterySaver";

/**
 * @param {string} mode {@link MODE_PREF}'s value.
 * @param {boolean} onBattery
 * @returns {boolean} whether Battery Saver is on, overrides aside.
 */
export function activeFor(mode, onBattery) {
  return mode === "always" || (mode === "unplugged" && onBattery);
}

/** The window's popover, built on first use. */
const panels = new WeakMap();

/** The open windows, for redrawing their button and menu item. */
const windows = new Set();

let started = false;
let onBattery = false;
/** `null`, or the state Turn Off for Now or Turn On for Now chose. */
let override = null;
/** Whether the prefs hold Battery Saver's values. */
let applied = false;
/** Each pref's default before Battery Saver changed it. */
const originals = new Map();

/** What `chargingchange` is followed on: the battery or a test's stand-in. */
let source = null;
/** The computer's battery, once `getBattery` answers. */
let battery = null;
/** A test's stand-in for the battery, while it has one. */
let standIn = null;
let windowless = null;

function currentMode() {
  return Services.prefs.getStringPref(MODE_PREF, "unplugged");
}

function onChargingChange() {
  setOnBattery(source?.charging === false);
}

/**
 * Follows `next`'s `charging` in place of the battery followed so far.
 *
 * @param {?EventTarget} next A `BatteryManager`, or a stand-in carrying
 *   `charging` that fires `chargingchange`.
 */
function follow(next) {
  source?.removeEventListener("chargingchange", onChargingChange);
  source = next;
  source?.addEventListener("chargingchange", onChargingChange);
  onChargingChange();
}

/**
 * The power source changed, which ends any override.
 *
 * @param {boolean} value
 */
function setOnBattery(value) {
  if (value === onBattery) {
    return;
  }
  onBattery = value;
  override = null;
  update();
}

/** A choice made in Settings ends any override. */
function onModeChange() {
  override = null;
  update();
}

/** Puts the prefs, the windows and the observers in step with `active`. */
function update() {
  const active = SvalBatterySaver.active;
  if (active === applied) {
    for (const win of windows) {
      drawWindow(win);
    }
    return;
  }
  const defaults = Services.prefs.getDefaultBranch("");
  for (const [name, value] of Object.entries(SAVER_PREFS)) {
    if (!originals.has(name)) {
      originals.set(name, defaults.getIntPref(name));
    }
    defaults.setIntPref(name, active ? value : originals.get(name));
  }
  applied = active;
  SvalLog.info(`battery saver ${active ? "on" : "off"}`);
  for (const win of windows) {
    drawWindow(win);
  }
  Services.obs.notifyObservers(null, CHANGED_TOPIC, active ? "on" : "off");
}

/**
 * Shows the button while Battery Saver is on, closing its popover once it
 * is off, and checks the Tools menu's item while it is on.
 *
 * @param {Window} win
 */
function drawWindow(win) {
  const active = SvalBatterySaver.active;
  const doc = win.document;
  const button = doc.getElementById(BUTTON_ID);
  if (button) {
    button.hidden = !active;
  }
  if (!active) {
    panels.get(win)?.close();
  }
  const item = doc.getElementById(MENU_ITEM_ID);
  if (item) {
    // A native menu bar reads the attribute (`nsMenuItemX`).
    item.setAttribute("checked", active ? "true" : "false");
  }
}

/**
 * The window's popover: that Battery Saver is on, Turn Off for Now, and the
 * way to its setting.
 *
 * @param {Window} win
 * @returns {Element}
 */
function panelFor(win) {
  let handle = panels.get(win);
  if (handle) {
    return handle;
  }
  const doc = win.document;
  handle = SvalPopover.create(doc, {
    name: PANEL_ID,
    labelledBy: `${PANEL_ID}-heading`,
    attributes: { flip: "slide", orient: "vertical" },
    // Grows from its button, reaching past it as the header's popovers do.
    stem: { hang: true },
    onShown: () => {
      if (handle.focusOff) {
        off.focus();
      }
      handle.focusOff = false;
    },
  });
  const panel = handle.popup;

  const tile = htmlElement(doc, "span", {
    className: "sval-notice-tile sval-battery-saver-tile",
  });
  tile.setAttribute("aria-hidden", "true");
  const heading = htmlElement(
    doc,
    "h2",
    { id: `${PANEL_ID}-heading`, className: "sval-battery-saver-heading" },
    "Battery Saver is on"
  );
  const text = htmlElement(
    doc,
    "p",
    { className: "sval-notice-text" },
    "Sval draws fewer frames on a fast screen, slows tabs in the background, and puts a Workspace to sleep 30 minutes after you leave it."
  );
  const settings = htmlElement(
    doc,
    "button",
    { className: "sval-notice-link text-link", type: "button" },
    "Battery Saver settings"
  );
  settings.dataset.action = "settings";
  settings.addEventListener("click", () => {
    panel.hidePopup();
    win.openPreferences(SETTINGS_PANE);
  });
  const off = htmlElement(
    doc,
    "button",
    { className: "footer-button small-button primary", type: "button" },
    "Turn Off for Now"
  );
  off.dataset.action = "off";
  off.addEventListener("click", () => {
    panel.hidePopup();
    SvalBatterySaver.toggleForNow();
  });
  panel.append(
    htmlElement(
      doc,
      "div",
      { className: "sval-notice" },
      tile,
      htmlElement(
        doc,
        "div",
        { className: "sval-notice-body" },
        heading,
        text,
        htmlElement(
          doc,
          "div",
          { className: "sval-notice-buttons" },
          settings,
          off
        )
      )
    )
  );
  panels.set(win, handle);
  return handle;
}

/**
 * The Tools menu's Battery Saver item, a checkbox checked while Battery
 * Saver is on, above Firefox's browser tools.
 *
 * @param {Window} win
 */
function mountMenuItem(win) {
  const doc = win.document;
  const popup = doc.getElementById("menu_ToolsPopup");
  if (!popup || doc.getElementById(MENU_ITEM_ID)) {
    return;
  }
  const item = doc.createXULElement("menuitem");
  item.id = MENU_ITEM_ID;
  item.setAttribute("type", "checkbox");
  item.setAttribute("label", "Battery Saver");
  // The item's state is Battery Saver's: the menu's own toggle of `checked`
  // is put back from it.
  item.setAttribute("autocheck", "false");
  item.addEventListener("command", () => SvalBatterySaver.toggleForNow());
  popup.insertBefore(item, doc.getElementById("devToolsSeparator"));
}

/**
 * Follows the computer's battery through a windowless chrome document's
 * `navigator.getBattery()`, which is exposed only to chrome. A windowless
 * browser lasts as long as Sval, where a browser window's navigator would
 * stop with its window.
 */
async function followBattery() {
  try {
    windowless = Services.appShell.createWindowlessBrowser(true);
    battery = await windowless.docShell.domWindow.navigator.getBattery();
    if (!standIn) {
      follow(battery);
    }
  } catch (err) {
    SvalLog.warn(
      `battery saver cannot read the battery: ${SvalLog.errorName(err)}`
    );
  }
}

export const SvalBatterySaver = {
  /**
   * Whether Battery Saver is on: an override's state while there is one,
   * else what {@link MODE_PREF} says for the power source.
   *
   * @returns {boolean}
   */
  get active() {
    return override ?? activeFor(currentMode(), onBattery);
  },

  /** Starts following the setting and the battery, once. */
  start() {
    if (started) {
      return;
    }
    started = true;
    Services.prefs.addObserver(MODE_PREF, onModeChange);
    Services.obs.addObserver(function closeWindowless() {
      Services.obs.removeObserver(closeWindowless, "quit-application");
      source?.removeEventListener("chargingchange", onChargingChange);
      windowless?.close();
      windowless = null;
    }, "quit-application");
    update();
    followBattery();
  },

  /**
   * Turns Battery Saver off for now while it is on, and on for now while it
   * is off, until the power source next changes or Sval restarts.
   */
  toggleForNow() {
    override = !this.active;
    update();
  },

  /**
   * After the window's delayed startup, once the header holds the button:
   * adds the Tools menu's item and draws both.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    this.start();
    mountMenuItem(win);
    windows.add(win);
    win.addEventListener("unload", () => windows.delete(win), { once: true });
    drawWindow(win);
  },

  /**
   * Opens the popover under the button, or closes it if it is open.
   *
   * @param {Window} win
   * @param {object} [options]
   * @param {boolean} [options.focus] Whether Turn Off for Now takes the
   *   focus, as it does when the popover is opened from the keyboard.
   */
  open(win, { focus = false } = {}) {
    const button = win.document.getElementById(BUTTON_ID);
    if (!button || button.hidden) {
      return;
    }
    const handle = panelFor(win);
    if (handle.isOpen()) {
      handle.close();
      return;
    }
    handle.focusOff = focus;
    handle.openFrom(button, "bottomright topright");
  },

  /**
   * @param {Window} win A browser window.
   * @returns {object} its popover, as `SvalPopover.create` gave it.
   */
  popoverOf(win) {
    return panelFor(win);
  },

  /**
   * Follows `stand` in place of the computer's battery, for tests, until
   * the returned function puts the battery back.
   *
   * @param {EventTarget} stand Carries `charging` and fires
   *   `chargingchange`.
   * @returns {function(): void} puts the computer's battery back, with no
   *   override.
   */
  useBatteryForTests(stand) {
    standIn = stand;
    follow(stand);
    return () => {
      standIn = null;
      follow(battery);
      override = null;
      update();
    };
  },
};
