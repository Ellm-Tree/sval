/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The overlay over an agent's window (agent-control spec §6, as
 * decision 0107 has it). While the agent controls its workspace, one
 * semi-opaque overlay covers the whole window, panel, toolbar, address bar,
 * page and sidebars alike, through which the window stays visible, and one
 * card at its centre says "<agent> is controlling this workspace", with one
 * button, Take control. Until the user presses it, none of the
 * user's input reaches the window. Pressed, the whole workspace is the
 * user's: the overlay goes from every window showing it, and a bar above
 * each tab's page says "You control this Workspace.", with Give Workspace
 * back to <agent>.
 *
 * The card also carries Stop agent, next to Take control, which refuses every call
 * of the agent's with `stopped_by_user` until the user presses Resume in its
 * place (`SvalAgentControl.stopWorkspace`). It leaves the workspace the
 * agent's, so the overlay stays up. Every window showing the workspace
 * shows the one Stop agent.
 *
 * The card also carries Be polite (`SvalAgentPolite`), ticked until the user
 * unticks it. It is the one way to lift the agent's rate limit, and it is
 * the user's: the overlay holds the user's input in the window and the
 * agent's tools never reach the tick.
 *
 * The overlay keeps the user's input out of the whole window:
 *
 * - The pointer: the overlay is drawn over everything in the window, so
 *   every mouse, wheel, touch and drag event the window hit-tests lands on it
 *   and never reaches the panel, the toolbar or the page's process. The
 *   address bar draws in the top layer while it is broken out of the toolbar
 *   (`UrlbarInput`), so the overlay holds its breakout off as Firefox's own
 *   window-modal dialogs do (`gDialogBox.open`, `incrementBreakoutBlockerCount`).
 * - The keyboard: the card holds the window's focus, and every key the user
 *   presses is stopped at the window before Firefox's shortcuts see it
 *   (`GlobalKeyListener::WalkHandlers` skips a default-prevented key), except
 *   Tab, Enter and Space on the card, and the shortcuts that only close,
 *   quit, minimise or hide the window or open another (`isWindowKey`).
 * - Commands, such as macOS's menu bar sends: every one but those same
 *   window commands (`WINDOW_COMMANDS`) is stopped.
 * - Context menus and drops are stopped at the window.
 *
 * The user is never trapped: the window's own buttons, its edges and its
 * title bar stay the system's. The overlay leaves a hole over the window
 * buttons Firefox draws itself (`.titlebar-buttonbox-container`), which on
 * Windows the system hit-tests anyway (`nsWindow::ClientMarginHitTestPoint`),
 * marks the strip over the toolbar as the window's drag region
 * (`-moz-window-dragging`), and never consumes a mouse press, which GTK checks
 * before it starts a drag. Resizing starts at the edges before any event is
 * dispatched, on every platform. A window-modal dialog, such as an agent's
 * alert (`SvalAgentAlerts`), draws in the top layer above the overlay, and the
 * overlay lets its input through.
 *
 * The page itself is held as well, for the agent's own input and for what
 * reaches a page without the window's hit-testing:
 *
 * - The `<browser>` cannot take focus (`-moz-user-focus: none`, as Firefox's
 *   `tabDialogShowing` sets), so a page's own `focus()` cannot pull the
 *   keyboard in (`BrowserParent::RecvRequestFocus` asks the focus manager,
 *   which refuses an element that cannot be focused).
 * - The page never holds the window's focus, not for the agent's input
 *   either: the keyboard is the user's, on the card, and moves only when the
 *   user moves it or control changes hands. The selected tab's page has
 *   focus all the same, to itself, while the agent holds it (agent-control
 *   spec §4.1): its browsing context's `svalFocusEmulated` gives its pages
 *   the focus of a focused window without the window's, and every other tab
 *   here is without it, as a backgrounded tab is. The page also stays
 *   visible while the window is minimised or covered. Without the window's
 *   focus, the page can neither go full screen above the overlay nor lock
 *   the pointer (`Document::FullscreenElementReadyCheck`,
 *   `PointerLockManager`'s `IsInActiveTab`).
 * - Navigation the window's chrome asks for is refused: the `<browser>`'s own
 *   load, history and stop methods are shadowed, and the window's Reload and
 *   Stop commands are stopped on their way. Session store and the window's
 *   own code reach those without any input of the user's. The agent's own
 *   loads pass (`asAgentLoad`).
 * - Popups Firefox draws for the page, a `<select>`'s list, a date picker,
 *   form autocomplete, would take the user's click into the page, and are
 *   not shown.
 * - Every other popup of the window, a panel, a menu or a tooltip, is a
 *   native widget drawn above the overlay, so while the overlay is up none
 *   opens, and one already open closes as it goes up. The menu bar's menus
 *   open, for the window commands above. A permission prompt
 *   (`PopupNotifications`) is suppressed instead, as Firefox suppresses it
 *   while a tab dialog shows (`shouldSuppressPopupNotifications`), so it
 *   stays pending and shows once the user takes control.
 * - Find in page is closed in a tab under the overlay and kept closed.
 * - Assistive technology: the `<browser>` is `aria-hidden` under the overlay,
 *   which takes the page out of the accessibility tree
 *   (`aria::IsValidARIAHidden`), and the card is a modal dialog.
 * - Media keys, a gamepad and Picture-in-Picture reach a page without
 *   passing through the window, and are kept out by the tab's
 *   `svalAgentInControl` (`SvalAgentTabRegistry`). An input method's
 *   composition and dictation go where the keyboard is, on the card.
 *
 * While the selected tab's page asks for human verification
 * (`SvalAgentChallenge`), the card says so under its label and asks the user
 * to take control and complete it: the agent may not, and the user should
 * not depend on the agent relaying that.
 *
 * A page dialog in the agent's tab draws over the page, beneath the overlay:
 * the agent answers it (`answer_dialog`), or the user does once they take
 * control. No page can cover Take control.
 *
 * The agent's own input is untouched: Sval dispatches it inside the page's
 * process, beneath the overlay (`SvalAgentPageChild`, through WebDriver's
 * `Event.sys.mjs`).
 *
 * A take is kept by the workspace's node id (`SvalAgentControl`), and each
 * tab's content is put in the user's control as it goes in while the
 * workspace is held: a tab opened in it, by the user or by a page, and one
 * whose browser goes in again after a discard or a restart, before anything
 * loads in it.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { WORKSPACES_MENU_ID } from "moz-src:///browser/components/sval/SvalMenuBar.sys.mjs";
import {
  AGENT_ACTIVITY_TOPIC,
  CONTROL_TOPIC,
  forgetControl,
  giveBack,
  giveBackWorkspace,
  holdWorkspace,
  isGivingBack,
  isAgentLoadDispatch,
  isUserInControl,
  isWorkspaceHeld,
  isWorkspaceStopped,
  stopWorkspace,
  takeControl,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  CHALLENGE_TOPIC,
  hasCheck,
} from "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs";
import {
  isPolite,
  politeRate,
  POLITE_TOPIC,
  POLITE_RATE_PREF,
  setPolite,
} from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  SvalQuickPeek: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";

/** On a `<browser>` under the overlay; `sval-panel.css` keys on it. */
export const LAYER_ATTRIBUTE = "sval-agent-layer";

/** What the card adds while the selected tab asks for human verification. */
export const CHALLENGE_TEXT =
  "This page wants you to confirm you're human. Take control to do it.";

/**
 * The `<browser>` methods the window's chrome loads, steps through history
 * and stops with, which a tab under the overlay refuses.
 */
const NAVIGATION = [
  "loadURI",
  "fixupAndLoadURIString",
  "goBack",
  "goForward",
  "gotoIndex",
  "reload",
  "reloadWithFlags",
  "stop",
];

/**
 * The window's commands that load, step or stop the selected tab. Reload and
 * Stop reach the page's history and web navigation without any `<browser>`
 * method (`BrowserCommands.reload`, `stop`), so they are stopped as commands.
 */
const NAVIGATION_COMMANDS = new Set([
  "Browser:Back",
  "Browser:BackOrBackDuplicate",
  "Browser:Forward",
  "Browser:ForwardOrForwardDuplicate",
  "Browser:Reload",
  "Browser:ReloadOrDuplicate",
  "Browser:ReloadSkipCache",
  "Browser:Stop",
]);

/**
 * The commands the overlay lets through: they close, quit or minimise the
 * window, or open another of the user's, and touch nothing of the agent's.
 * Settings, which macOS's application menu dispatches to the menu bar's
 * `menu_settings` or `menu_preferences`, opens in the user's own window
 * (`SvalPeek.settingsWindow`).
 * macOS's Window menu (`#windowPopup`) passes whole, for the same reason.
 */
const WINDOW_COMMANDS = new Set([
  "cmd_closeWindow",
  "cmd_minimizeWindow",
  "cmd_newNavigator",
  "cmd_quitApplication",
  "menu_preferences",
  "menu_settings",
  "Tools:PrivateBrowsing",
  "zoomWindow",
]);

/**
 * On the window's root while the overlay is up. browser.js's
 * `shouldSuppressPopupNotifications` reads it.
 */
const OVERLAY_ATTRIBUTE = "sval-agent-overlay";

/** How many times the avatar's ring pulses after each action of the agent. */
const RING_PULSES = 2;

/**
 * @param {Element} popup
 * @returns {boolean} Whether `popup` is a menu of the window's menu bar.
 */
function inMenuBar(popup) {
  return !!popup?.closest?.("#main-menubar");
}

/**
 * A workspace in the menu bar's Workspaces menu. It goes through the overlay
 * because the panel opens it in a window of its own while the agent holds
 * this one (`SvalPanel.runMenuBarWorkspacesCommand`), so the user always has
 * a way out of the agent's window.
 *
 * @param {Element} target
 * @returns {boolean}
 */
function isWorkspaceChoice(target) {
  return (
    !!target?.closest?.(`#${WORKSPACES_MENU_ID}`) &&
    target.hasAttribute("data-workspace-id")
  );
}

/** Popups Firefox draws for a page: a list, a date picker, autocomplete. */
const PAGE_POPUPS = new Set([
  "ContentSelectDropdownPopup",
  "DateTimePickerPanel",
  "PopupAutoComplete",
]);

/** The user's input the overlay stops at the window. */
const BLOCKED_EVENTS = [
  "keydown",
  "keypress",
  "keyup",
  "contextmenu",
  "dragstart",
  "dragenter",
  "dragover",
  "drop",
];

/** Ids for the cards' and bars' labels, unique within a window. */
let nextId = 0;

/**
 * Whether `event` is a shortcut that only acts on the window as a whole:
 * close it, quit, minimise or hide it, cycle to another window, or open a
 * new one of the user's or Settings in one. These are the keys Firefox binds to
 * `WINDOW_COMMANDS` (`browser-sets.inc.xhtml`) and the system's own window
 * keys, which a window under the overlay leaves to the user so they are
 * never trapped in it.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isWindowKey(event) {
  const mac = AppConstants.platform == "macosx";
  if (!mac && event.altKey && !event.ctrlKey && !event.metaKey) {
    // Alt+F4 closes the window, and Alt+Space opens Windows' window menu.
    return event.key === "F4" || event.key === " ";
  }
  const accel = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (!accel || other) {
    return false;
  }
  const key = event.key?.toLowerCase();
  const { shiftKey: shift, altKey: alt } = event;
  if (key === "w") {
    return shift && !alt;
  }
  if (key === "q") {
    return !alt;
  }
  if (key === "n") {
    return !shift && !alt;
  }
  if (key === "p") {
    return shift && !alt;
  }
  if (mac && (key === "m" || key === "`" || key === ",")) {
    return !alt;
  }
  return mac && key === "h";
}

/**
 * @param {Element} browser A `<browser>`.
 * @returns {number} Its content's `browserId`, or 0 for one with no content.
 */
function contentIdOf(browser) {
  try {
    return browser?.browsingContext?.browserId ?? 0;
  } catch {
    return 0;
  }
}

/**
 * @param {object} tab
 * @returns {string|null} Its node id.
 */
function nodeIdOf(tab) {
  try {
    return lazy.SvalTabs.nodeIdOf(tab);
  } catch {
    return null;
  }
}

/**
 * The overlay and the bars of one window showing an agent's workspace, and
 * the live region that announces control changing hands.
 */
export class AgentWindowMarking {
  #win;
  #label = null;
  #hooked = false;
  /** The overlay over the whole window, once drawn. */
  #overlay = null;
  /** Whether the overlay is up, and holds the address bar's breakout off. */
  #up = false;
  /** Keeps the overlay's drag strip and hole on the window's own parts. */
  #resizeObserver = null;
  /** The visually hidden live region the window's changes are announced in. */
  #announcer = null;
  /**
   * The browsers whose navigation is shadowed, each with what its shadowed
   * properties were before.
   *
   * @type {WeakMap<Element, Map<string, {had: boolean, value: Function}>>}
   */
  #shadowed = new WeakMap();
  /** Tabs whose opening load tabbrowser has yet to start. */
  #opening = new WeakSet();

  /** Each tab's latest activity line, by its `<browser>`. */
  #activity = new WeakMap();

  /**
   * @param {Window} win A browser window.
   */
  constructor(win) {
    this.#win = win;
  }

  /** @returns {string|null} The agent's label, or null. */
  get label() {
    return this.#label;
  }

  /** @returns {Element|null} */
  get overlay() {
    return this.#overlay;
  }

  /** @returns {boolean} Whether the overlay holds the window's input. */
  get blocking() {
    return this.#blocking();
  }

  /**
   * Marks the window for the agent labelled `label`, or unmarks it.
   *
   * @param {string|null} label
   */
  update(label) {
    if (label !== this.#label) {
      this.#label = label;
      if (label) {
        this.#hook();
      } else {
        this.#unhook();
      }
    }
    if (!label) {
      this.#announcer?.remove();
      this.#announcer = null;
    }
    for (const tab of this.#win.gBrowser?.tabs ?? []) {
      this.#render(tab);
    }
    this.#renderOverlay();
    if (!label) {
      this.#overlay?.remove();
      this.#overlay = null;
    }
  }

  destroy() {
    this.update(null);
  }

  #hook() {
    if (this.#hooked) {
      return;
    }
    this.#hooked = true;
    const container = this.#win.gBrowser.tabContainer;
    for (const type of ["TabOpen", "TabSelect", "TabClose"]) {
      container.addEventListener(type, this);
    }
    // Captured at the window, so it runs before session store, which
    // restores the tab's page from its own `TabBrowserInserted` listener.
    this.#win.addEventListener("TabBrowserInserted", this, true);
    this.#win.addEventListener("TabSwitchDone", this);
    this.#win.addEventListener("EndSwapDocShells", this, true);
    this.#win.addEventListener("focus", this, true);
    this.#win.addEventListener("findbaropen", this, true);
    this.#win.addEventListener("command", this, true);
    this.#win.addEventListener("popupshowing", this, true);
    for (const type of BLOCKED_EVENTS) {
      this.#win.addEventListener(type, this, true);
    }
    Services.obs.addObserver(this, CONTROL_TOPIC);
    Services.obs.addObserver(this, CHALLENGE_TOPIC);
    Services.obs.addObserver(this, AGENT_ACTIVITY_TOPIC);
    Services.obs.addObserver(this, POLITE_TOPIC);
    Services.prefs.addObserver(POLITE_RATE_PREF, this);
  }

  #unhook() {
    if (!this.#hooked) {
      return;
    }
    this.#hooked = false;
    const container = this.#win.gBrowser?.tabContainer;
    for (const type of ["TabOpen", "TabSelect", "TabClose"]) {
      container?.removeEventListener(type, this);
    }
    this.#win.removeEventListener("TabBrowserInserted", this, true);
    this.#win.removeEventListener("TabSwitchDone", this);
    this.#win.removeEventListener("EndSwapDocShells", this, true);
    this.#win.removeEventListener("focus", this, true);
    this.#win.removeEventListener("findbaropen", this, true);
    this.#win.removeEventListener("command", this, true);
    this.#win.removeEventListener("popupshowing", this, true);
    for (const type of BLOCKED_EVENTS) {
      this.#win.removeEventListener(type, this, true);
    }
    Services.obs.removeObserver(this, CONTROL_TOPIC);
    Services.obs.removeObserver(this, CHALLENGE_TOPIC);
    Services.obs.removeObserver(this, AGENT_ACTIVITY_TOPIC);
    Services.obs.removeObserver(this, POLITE_TOPIC);
    Services.prefs.removeObserver(POLITE_RATE_PREF, this);
  }

  handleEvent(event) {
    const gBrowser = this.#win.gBrowser;
    switch (event.type) {
      case "TabOpen":
      case "TabBrowserInserted": {
        const tab = event.target;
        // tabbrowser starts a new tab's first load straight after its browser
        // goes in and `TabOpen` (`addTab`, `_kickOffBrowserLoad`), and that
        // load is the tab's opening, not navigation of a page the agent has:
        // the window's loads are refused from the next task on.
        if (event.type === "TabOpen" || event.detail?.insertedOnTabCreation) {
          this.#opening.add(tab);
          Services.tm.dispatchToMainThread(() => {
            this.#opening.delete(tab);
            this.#render(tab);
          });
        }
        this.#render(tab);
        break;
      }
      case "TabSelect":
        this.#render(event.target);
        break;
      case "TabSwitchDone":
        this.#render(gBrowser.selectedTab);
        break;
      case "EndSwapDocShells":
        // A tab moved in from another window has its content, and with it
        // its `browserId`, only once the swap is done.
        this.#render(gBrowser.getTabForBrowser(event.target));
        break;
      case "TabClose":
        // Closed for good, not carried to another window. The workspace's
        // take is kept by its node, and a tab brought back from the closed
        // list follows it.
        if (!event.detail?.adoptedBy) {
          forgetControl(contentIdOf(event.target.linkedBrowser));
        }
        // A tab carried to another window takes its browsing context with
        // it, and is the agent's selected tab here no more. A closing Quick Peek
        // gives the focus back to the tab it was shown over.
        this.#setFocusEmulated(event.target, false);
        this.#emulateFocus();
        break;
      case "focus":
        this.#onFocus(event.target);
        break;
      case "findbaropen": {
        const tab = gBrowser.getTabForBrowser(event.target.browser);
        if (tab?.linkedBrowser.hasAttribute(LAYER_ATTRIBUTE)) {
          event.target.close(true);
        }
        break;
      }
      case "command":
        this.#onCommand(event);
        break;
      case "popupshowing":
        // The tooltip of a button on the card is the one popup the overlay
        // lets open over the window.
        if (
          (PAGE_POPUPS.has(event.target?.id) &&
            gBrowser.selectedBrowser?.hasAttribute(LAYER_ATTRIBUTE)) ||
          (this.#holds(event) &&
            !inMenuBar(event.target) &&
            !(
              event.target.localName === "tooltip" &&
              this.#card()?.contains(event.target.triggerNode)
            ))
        ) {
          event.preventDefault();
        }
        break;
      case "keydown":
      case "keypress":
      case "keyup":
        this.#onKey(event);
        break;
      case "contextmenu":
      case "dragstart":
      case "dragenter":
      case "dragover":
      case "drop":
        this.#onPointer(event);
        break;
      case "click":
        // A click on the overlay beside the card leaves the keyboard on it.
        if (!this.#card()?.contains(event.target)) {
          this.#focusCard();
        }
        break;
    }
  }

  /**
   * Keeps the keyboard out of the page, and, while the overlay is up, on
   * the card: whatever the window's own code focuses, the address bar of a
   * new tab included, the keyboard goes back to the card.
   *
   * @param {EventTarget} target What took focus.
   */
  #onFocus(target) {
    if (target?.nodeType !== 1) {
      return;
    }
    if (
      target.hasAttribute(LAYER_ATTRIBUTE) ||
      (this.#blocking() &&
        target.ownerDocument === this.#win.document &&
        !this.#overlay.contains(target))
    ) {
      this.#focusCard();
    }
  }

  /**
   * Stops the window's navigation of a tab under the overlay, and, while the
   * overlay is up, every command but the window's own (`WINDOW_COMMANDS`).
   *
   * @param {Event} event A `command` event.
   */
  #onCommand(event) {
    const target = event.target;
    const command = target?.getAttribute?.("command") || target?.id;
    const browser = this.#win.gBrowser.selectedBrowser;
    if (
      NAVIGATION_COMMANDS.has(command) &&
      browser?.hasAttribute(LAYER_ATTRIBUTE)
    ) {
      this.#stop(event);
      this.#refuseNavigation(browser);
    } else if (
      this.#holds(event) &&
      !WINDOW_COMMANDS.has(command) &&
      !target?.closest?.("#windowPopup") &&
      !isWorkspaceChoice(target) &&
      !this.#overlay.contains(target)
    ) {
      this.#stop(event);
    }
  }

  /**
   * Stops a context menu or a drag while the overlay is up.
   *
   * @param {Event} event
   */
  #onPointer(event) {
    if (!this.#holds(event)) {
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
    this.#stop(event);
  }

  observe(subject, topic, data) {
    if (topic === POLITE_TOPIC || data === POLITE_RATE_PREF) {
      this.#showPolite();
      return;
    }
    if (topic === AGENT_ACTIVITY_TOPIC) {
      if (subject?.ownerDocument === this.#win.document) {
        this.#activity.set(subject, String(data));
        this.#showActivity();
        if (subject === this.#win.gBrowser?.selectedBrowser) {
          this.#pulseRing();
        }
      }
      return;
    }
    if (topic !== CONTROL_TOPIC && topic !== CHALLENGE_TOPIC) {
      return;
    }
    const id = Number(data);
    for (const tab of this.#win.gBrowser?.tabs ?? []) {
      // 0 is a workspace changing hands, which every tab follows.
      if (!id || contentIdOf(tab.linkedBrowser) === id) {
        this.#render(tab);
      }
    }
    if (!id) {
      this.#renderOverlay();
    }
  }

  /**
   * @param {Event} event
   */
  #stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * @returns {boolean} Whether the overlay is up and holding the user's input:
   *   not while a window-modal dialog, drawn above it, has the window.
   */
  #blocking() {
    return this.#up && !this.#win.document.querySelector(":modal");
  }

  /**
   * @param {Event} event
   * @returns {boolean} Whether the overlay holds `event` back: it is up, and
   *   the event is the window's own. An event in a frame of Sval's chrome,
   *   such as a page dialog's (`TabDialogBox`), reaches the window through
   *   the frame (its chrome event handler), and is that frame's own: the
   *   user cannot reach the frame under the overlay, and the agent answers a
   *   page dialog through it (`SvalAgentPageDialogs`).
   */
  #holds(event) {
    return (
      this.#blocking() &&
      event.originalTarget?.ownerDocument === this.#win.document
    );
  }

  /**
   * Stops a key the user pressed in the window under the overlay. Tab moves
   * between the card, Take control, Stop or Resume and Be polite, in the
   * order the card shows them, and goes no further; Enter and Space reach
   * the focused control; a window key (`isWindowKey`) is the user's.
   *
   * @param {KeyboardEvent} event
   */
  #onKey(event) {
    if (!this.#holds(event) || isWindowKey(event)) {
      return;
    }
    const card = this.#card();
    const plain =
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing;
    if (plain && card.contains(event.target)) {
      if (event.key === "Tab") {
        this.#stop(event);
        if (event.type === "keydown") {
          const stops = [
            card,
            card.querySelector(".sval-agent-take"),
            card.querySelector(".sval-agent-stop"),
            card.querySelector(".sval-agent-resume"),
            card.querySelector(".sval-agent-polite input"),
          ].filter(stop => !stop.disabled && !stop.hidden);
          const at = stops.indexOf(event.target);
          stops.at((at + (event.shiftKey ? -1 : 1)) % stops.length).focus();
        }
        return;
      }
      if (
        (event.key === "Enter" || event.key === " ") &&
        (event.target.localName === "button" ||
          event.target.matches(".sval-agent-polite input"))
      ) {
        return;
      }
    }
    this.#stop(event);
    if (event.type === "keydown" && !card.contains(event.target)) {
      this.#focusCard();
    }
  }

  /** @returns {Element|null} The card with Take control, once drawn. */
  #card() {
    return this.#overlay?.querySelector(".sval-agent-card") ?? null;
  }

  #focusCard() {
    if (this.#up) {
      this.#card()?.focus({ preventScroll: true });
    }
  }

  /**
   * @param {string} tag
   * @param {string} className
   * @returns {Element}
   */
  #html(tag, className) {
    const el = this.#win.document.createElementNS(HTML, tag);
    el.className = className;
    return el;
  }

  /**
   * The robot face, for sighted users only: the text beside it says the same.
   *
   * @returns {Element}
   */
  #robot() {
    const robot = this.#html("span", "sval-agent-glyph sval-agent-robot");
    robot.setAttribute("aria-hidden", "true");
    return robot;
  }

  /**
   * Shadows `browser`'s navigation methods while the overlay is up, so the
   * window's chrome cannot load, step or stop the agent's tab; the agent's
   * own loads pass (`isAgentLoadDispatch`). Taken away when the overlay goes,
   * putting back exactly what was there: tabbrowser gives each browser its
   * own `loadURI` and `fixupAndLoadURIString` (`URILoadingWrapper`, bound in
   * `_insertBrowser`), and the others come from the browser's prototype.
   *
   * @param {Element} browser
   * @param {boolean} shadowed
   */
  #shadow(browser, shadowed) {
    const saved = this.#shadowed.get(browser);
    if (!shadowed) {
      if (!saved) {
        return;
      }
      this.#shadowed.delete(browser);
      for (const [name, { had, value }] of saved) {
        if (had) {
          browser[name] = value;
        } else {
          delete browser[name];
        }
      }
      return;
    }
    if (saved) {
      return;
    }
    const kept = new Map();
    for (const name of NAVIGATION) {
      const current = browser[name];
      if (typeof current !== "function") {
        continue;
      }
      const had = Object.hasOwn(browser, name);
      kept.set(name, { had, value: had ? current : undefined });
      const marking = this;
      browser[name] = function (...args) {
        if (isAgentLoadDispatch()) {
          return current.apply(this, args);
        }
        // A stop is refused quietly: session store stops a tab as it
        // restores it (`SessionStore._restoreHistory`), and the user's Stop
        // is refused as a command, with its answer (`NAVIGATION_COMMANDS`).
        if (name !== "stop") {
          marking.#refuseNavigation(browser);
        }
        return undefined;
      };
    }
    this.#shadowed.set(browser, kept);
  }

  /** @returns {string|null} The workspace this window shows. */
  #workspaceId() {
    return lazy.SvalWindowWorkspace.of(this.#win).id;
  }

  /**
   * @returns {boolean} Whether the user holds the agent's workspace this
   *   window shows.
   */
  #held() {
    return !!this.#label && isWorkspaceHeld(this.#workspaceId());
  }

  /**
   * @returns {boolean} Whether the user has stopped the agent whose
   *   workspace this window shows.
   */
  #stopped() {
    return !!this.#label && isWorkspaceStopped(this.#workspaceId());
  }

  /**
   * Answers navigation the window asked of a tab under the overlay: the
   * address bar goes back to what the tab shows, and the card pulses when
   * the tab is the one it covers.
   *
   * @param {Element} browser
   */
  #refuseNavigation(browser) {
    try {
      this.#win.gURLBar?.handleRevert();
    } catch {}
    const card = this.#card();
    if (!card || !this.#up || this.#win.gBrowser.selectedBrowser !== browser) {
      return;
    }
    card.removeAttribute("data-pulse");
    // A reflow between, so the animation starts again on a second refusal.
    card.getBoundingClientRect();
    card.setAttribute("data-pulse", "true");
    card.addEventListener(
      "animationend",
      () => card.removeAttribute("data-pulse"),
      { once: true }
    );
    this.#focusCard();
  }

  /**
   * Holds `tab`'s page under the overlay, or gives it to the user with the
   * bar above it, or takes it all away when the window shows no agent's
   * workspace. A tab with no content yet has nothing to hold; it is drawn
   * when its browser goes in (`TabBrowserInserted`), which is also when the
   * workspace's take is put on its new content.
   *
   * @param {object} tab A Firefox tab.
   */
  #render(tab) {
    this.#renderTab(tab);
    if (tab?.selected) {
      this.#renderOverlay();
    }
    this.#emulateFocus();
  }

  /**
   * Gives the page of the tab the agent works in, the selected one while
   * the agent holds it, the focus of a focused window, and takes it from
   * every other tab here (agent-control spec §4.1). An open Quick Peek is shown
   * over the selected tab, and is the one whose page has the focus.
   */
  #emulateFocus() {
    const quickPeek = lazy.SvalQuickPeek.tabOf(this.#win);
    const front =
      quickPeek && !quickPeek.closing
        ? quickPeek
        : this.#win.gBrowser?.selectedTab;
    for (const tab of this.#win.gBrowser?.tabs ?? []) {
      this.#setFocusEmulated(
        tab,
        !!this.#label &&
          tab === front &&
          !tab.closing &&
          tab.linkedBrowser.hasAttribute(LAYER_ATTRIBUTE)
      );
    }
    this.#keepCompositing(
      !!this.#win.gBrowser?.keepsPageShown(this.#win.gBrowser.selectedBrowser)
    );
    // A minimised or covered window keeps the page the agent holds shown, as
    // tabbrowser reads it from the layer attribute (`keepsPageShown`), and
    // it applies that to its pages only when told.
    if (this.#win.document.hidden) {
      this.#win.gBrowser?.pagesShownChanged();
    }
  }

  /**
   * Keeps the window active while it keeps the agent's page shown. Gecko
   * pauses the compositor of a minimised or covered window
   * (`CanonicalBrowsingContext::RecomputeAppWindowVisibility`), and a page
   * whose paints are never composited skips every refresh tick while it
   * waits for them (`nsRefreshDriver::IsWaitingForPaint`), so no animation
   * frame or scroll event would reach it. `forceAppWindowActive` is how
   * Picture-in-Picture keeps its covered originating window running.
   *
   * @param {boolean} active
   */
  #keepCompositing(active) {
    const context = this.#win.browsingContext;
    if (!context || context.isDiscarded) {
      return;
    }
    if (context.forceAppWindowActive === active) {
      return;
    }
    try {
      context.forceAppWindowActive = active;
    } catch (err) {
      SvalLog.warn(
        `an agent's window was not kept active: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * @param {object} tab A Firefox tab.
   * @param {boolean} emulated Whether its page has the focus of a focused
   *   window.
   */
  #setFocusEmulated(tab, emulated) {
    // A lazy tab has no content, and reading its context would insert it
    // (`Tabbrowser._createLazyBrowser`).
    if (!tab?.linkedPanel) {
      return;
    }
    const bc = tab.linkedBrowser.browsingContext;
    if (!bc || bc.svalFocusEmulated === emulated) {
      return;
    }
    try {
      bc.svalFocusEmulated = emulated;
    } catch (err) {
      SvalLog.warn(`a tab's focus was not emulated: ${SvalLog.errorName(err)}`);
    }
  }

  /**
   * @param {object} tab A Firefox tab.
   */
  #renderTab(tab) {
    const browser = tab?.linkedBrowser;
    const stack = browser?.parentNode;
    const container = stack?.parentNode;
    if (!tab?.linkedPanel || !stack?.classList.contains("browserStack")) {
      return;
    }
    let bar = container.querySelector(":scope > .sval-agent-bar");
    if (!this.#label) {
      bar?.remove();
      if (browser.hasAttribute(LAYER_ATTRIBUTE)) {
        browser.removeAttribute(LAYER_ATTRIBUTE);
        browser.removeAttribute("aria-hidden");
      }
      this.#shadow(browser, false);
      return;
    }

    // The tab's content follows the workspace's take, and goes back to the
    // agent only in the user's Give back. Content in the user's control that
    // lands in a workspace they do not hold, such as a copy of one of their
    // tabs, takes the workspace for them instead. A change renders this tab
    // again on its own (`CONTROL_TOPIC`).
    const id = contentIdOf(browser);
    const workspace = this.#workspaceId();
    const nodeId = nodeIdOf(tab);
    if (this.#held()) {
      if (takeControl(id)) {
        return;
      }
    } else if (isUserInControl(id)) {
      if (isGivingBack(workspace)) {
        giveBack(id, nodeId);
      } else {
        try {
          holdWorkspace(workspace, true);
        } catch (err) {
          // Not kept, and the workspace counts as the user's all the same
          // (`isWorkspaceHeld`).
          SvalLog.warn(`a take could not be kept: ${SvalLog.errorName(err)}`);
        }
      }
      return;
    }

    bar ??= this.#makeBar(container, stack);
    this.#setText(
      bar.querySelector(".sval-agent-give"),
      `Give Workspace back to ${this.#label}`
    );

    const user = isUserInControl(id);
    bar.hidden = !user;
    if (user) {
      browser.removeAttribute(LAYER_ATTRIBUTE);
      browser.removeAttribute("aria-hidden");
      this.#shadow(browser, false);
      return;
    }
    browser.setAttribute(LAYER_ATTRIBUTE, "true");
    browser.setAttribute("aria-hidden", "true");
    if (!this.#opening.has(tab)) {
      this.#shadow(browser, true);
    }
    if (this.#win.gBrowser.isFindBarInitialized(tab)) {
      const findBar = this.#win.gBrowser.getCachedFindBar(tab);
      if (!findBar.hidden) {
        findBar.close(true);
      }
    }
  }

  /**
   * Puts the overlay up while the agent controls the workspace, and takes it
   * down while the user does or the window shows no agent's workspace.
   */
  #renderOverlay() {
    const tab = this.#win.gBrowser?.selectedTab;
    const id = contentIdOf(tab?.linkedBrowser);
    const up = !!this.#label && !!tab && !this.#held();
    if (up) {
      this.#overlay ??= this.#makeOverlay();
      const text = this.#overlay.querySelector(".sval-agent-text");
      const stopped = this.#stopped();
      this.#setText(
        text,
        stopped
          ? `You stopped ${this.#label}`
          : `${this.#label} is controlling this Workspace`
      );
      if (stopped) {
        text.dataset.state = "stopped";
      } else {
        delete text.dataset.state;
      }
      this.#showStop(stopped);
      this.#showActivity();
      this.#showPolite();
      this.#showChallenge(!!id && hasCheck(id));
    }
    if (up !== this.#up) {
      this.#up = up;
      if (this.#overlay) {
        this.#overlay.hidden = !up;
      }
      this.#holdBreakout(up);
      this.#holdPopups(up);
      if (up) {
        this.#fitOverlay();
        this.#resizeObserver ??= new this.#win.ResizeObserver(() =>
          this.#fitOverlay()
        );
        this.#resizeObserver.observe(this.#win.document.documentElement);
        this.#resizeObserver.observe(this.#win.gNavToolbox);
      } else {
        this.#resizeObserver?.disconnect();
      }
    }
    if (up) {
      const active = this.#win.document.activeElement;
      if (!this.#card().contains(active)) {
        this.#focusCard();
      }
    }
  }

  /**
   * Shows or hides the card's line asking the user to complete a
   * human-verification check, and says it through the live region when it
   * appears, since focus stays where it was.
   *
   * @param {boolean} shown
   */
  #showChallenge(shown) {
    const line = this.#overlay.querySelector(".sval-agent-challenge");
    if (line.hidden === !shown) {
      return;
    }
    line.hidden = !shown;
    const card = this.#card();
    const take = card.querySelector(".sval-agent-take");
    card.setAttribute(
      "aria-describedby",
      shown ? `${line.id} ${take.id}` : take.id
    );
    if (shown) {
      this.#announce(CHALLENGE_TEXT, "challenge");
    }
  }

  /**
   * Holds every address bar's breakout off, or lets it go again, as
   * `gDialogBox.open` does, so the address bar draws beneath the overlay.
   *
   * @param {boolean} held
   */
  #holdBreakout(held) {
    for (const urlbar of this.#win.document.querySelectorAll("moz-urlbar")) {
      try {
        if (held) {
          urlbar.incrementBreakoutBlockerCount();
        } else {
          urlbar.decrementBreakoutBlockerCount();
        }
      } catch (err) {
        SvalLog.warn(
          `the address bar's breakout was not held: ${SvalLog.errorName(err)}`
        );
      }
    }
  }

  /**
   * Suppresses the window's permission prompts while the overlay is up, or
   * shows the ones still pending, and closes every other popup open as it
   * goes up but the menu bar's.
   *
   * @param {boolean} held
   */
  #holdPopups(held) {
    const doc = this.#win.document;
    doc.documentElement.toggleAttribute(OVERLAY_ATTRIBUTE, held);
    // Defined by browser.js; reads the attribute through
    // `shouldSuppressPopupNotifications`.
    this.#win.UpdatePopupNotificationsVisibility?.();
    if (!held) {
      return;
    }
    for (const popup of doc.querySelectorAll("panel, menupopup, tooltip")) {
      if (
        (popup.state === "open" || popup.state === "showing") &&
        !inMenuBar(popup)
      ) {
        popup.hidePopup();
      }
    }
  }

  /**
   * Sizes the overlay's drag strip to the toolbar, and cuts the overlay's
   * hole over the window buttons Firefox draws (`.titlebar-buttonbox-container`
   * in a window with a custom title bar), so the user can always move,
   * minimise, maximise and close the window. A clip path takes the hole out
   * of hit-testing as well as drawing.
   *
   * macOS draws its window buttons natively, above the window's content, so
   * they are always reachable there; the box Firefox lays out for them is
   * empty room, and a hole over it would show the chrome beneath undimmed.
   */
  #fitOverlay() {
    const overlay = this.#overlay;
    if (!overlay || !this.#up) {
      return;
    }
    const doc = this.#win.document;
    const toolbox = this.#win.gNavToolbox?.getBoundingClientRect();
    overlay.style.setProperty(
      "--sval-agent-titlebar-height",
      `${Math.max(0, toolbox?.bottom ?? 0)}px`
    );
    const holes = [];
    const boxes =
      AppConstants.platform === "macosx"
        ? []
        : doc.querySelectorAll(".titlebar-buttonbox-container");
    for (const box of boxes) {
      const r = box.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        holes.push(
          `${r.left}px ${r.top}px, ${r.right}px ${r.top}px, ` +
            `${r.right}px ${r.bottom}px, ${r.left}px ${r.bottom}px, ` +
            `${r.left}px ${r.top}px, 0 0`
        );
      }
    }
    overlay.style.clipPath = holes.length
      ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${holes.join(", ")})`
      : "";
  }

  /**
   * @returns {string|null} The id of the paired agent whose workspace this
   *   window shows: what Be polite is kept under. Null when none is paired.
   */
  #agentId() {
    const workspace = lazy.SvalWindowWorkspace.of(this.#win).id;
    return lazy.SvalAgents.store?.agentOfWorkspace(workspace)?.agentId ?? null;
  }

  #showPolite() {
    const polite = this.#overlay?.querySelector(".sval-agent-polite");
    if (!polite || !this.#label) {
      return;
    }
    const agentId = this.#agentId();
    const tick = polite.querySelector("input");
    // An agent that is not paired has no tick to change.
    tick.disabled = !agentId;
    tick.checked = !agentId || isPolite(agentId);
    const rate = politeRate();
    polite.dataset.rate = rate;
    this.#setText(
      polite.querySelector(".sval-agent-polite-text"),
      `Be polite: at most ${rate === 1 ? "1 action" : `${rate} actions`} a second on each site`
    );
  }

  #showActivity() {
    const status = this.#overlay?.querySelector(".sval-agent-status");
    const browser = this.#win.gBrowser?.selectedBrowser;
    if (status && browser) {
      // A stopped agent is doing nothing, whatever it last did.
      const doing = this.#stopped() ? "" : this.#activity.get(browser);
      this.#setText(status, doing ?? "");
    }
  }

  /**
   * Pulses the avatar's ring `RING_PULSES` more times after the pulse it is
   * in, so it goes on while the agent acts and comes to rest once it stops.
   */
  #pulseRing() {
    const avatar = this.#overlay?.querySelector(".sval-agent-avatar");
    if (!avatar || this.#stopped()) {
      return;
    }
    const ring = avatar.getAnimations()[0];
    if (ring) {
      const { currentIteration } = ring.effect.getComputedTiming();
      ring.effect.updateTiming({
        iterations: currentIteration + 1 + RING_PULSES,
      });
      return;
    }
    // A ring at rest is no longer one of the element's animations
    // (`Element.getAnimations` lists only those current or in effect), so it
    // starts again as a new one. With reduced motion the stylesheet gives it
    // none.
    avatar.style.animationName = "none";
    avatar.getBoundingClientRect();
    avatar.style.removeProperty("animation-name");
  }

  /**
   * Shows Stop while the agent may act, and Resume in its place once the
   * user has stopped it, with the card's `data-stopped` saying which. The
   * keyboard follows the press from one to the other.
   *
   * @param {boolean} stopped
   */
  #showStop(stopped) {
    const card = this.#card();
    const stop = card.querySelector(".sval-agent-stop");
    const resume = card.querySelector(".sval-agent-resume");
    stop.setAttribute("aria-label", `Stop ${this.#label}`);
    resume.setAttribute("aria-label", `Resume ${this.#label}`);
    card.dataset.stopped = String(stopped);
    if (stop.hidden === stopped) {
      return;
    }
    const focused = this.#win.document.activeElement;
    stop.hidden = stopped;
    resume.hidden = !stopped;
    if (focused === stop || focused === resume) {
      (stopped ? resume : stop).focus();
    }
  }

  /**
   * @param {Element} el
   * @param {string} text
   */
  #setText(el, text) {
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  /**
   * @returns {Element} The overlay over the whole window, with its card.
   */
  #makeOverlay() {
    const doc = this.#win.document;
    const overlay = this.#html("div", "sval-agent-overlay");
    overlay.hidden = true;
    const titlebar = this.#html("div", "sval-agent-titlebar");
    // A dialog, modal over the window, so moving focus to it announces what
    // it says and, through `aria-describedby`, the button it holds. Focus
    // lands on the card and not the button, so a key the user meant for
    // something else cannot take control by accident.
    const card = this.#html("div", "sval-agent-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    const text = this.#html("span", "sval-agent-text");
    text.id = `sval-agent-text-${++nextId}`;
    card.setAttribute("aria-labelledby", text.id);
    const take = this.#html("button", "sval-agent-take");
    take.id = `sval-agent-take-${nextId}`;
    take.textContent = "Take control";
    take.title =
      "Pause the agent and use this Workspace yourself. Give it back to the agent when you're done.";
    card.setAttribute("aria-describedby", take.id);
    // `click` comes from a press of the mouse, or from Enter or Space on the
    // focused button, and from nothing else.
    take.addEventListener("click", () => this.#take());
    const stop = this.#html("button", "sval-agent-stop");
    stop.textContent = "Stop agent";
    stop.title =
      "Stop the agent and end what it's doing. It can't act again until you press Resume.";
    stop.addEventListener("click", () => this.#setStopped(true));
    const resume = this.#html("button", "sval-agent-resume");
    resume.textContent = "Resume";
    resume.title = "Let the agent act in this Workspace again.";
    resume.hidden = true;
    resume.addEventListener("click", () => this.#setStopped(false));
    const challenge = this.#html("p", "sval-agent-challenge");
    challenge.id = `sval-agent-challenge-${nextId}`;
    challenge.textContent = CHALLENGE_TEXT;
    challenge.hidden = true;
    // What the agent is doing now (`AGENT_ACTIVITY_TOPIC`), read out as it
    // changes.
    const status = this.#html("span", "sval-agent-status");
    status.setAttribute("aria-live", "polite");
    // Only the user can untick this: no tool reaches `setPolite`.
    const polite = this.#html("label", "sval-agent-polite");
    const tick = this.#html("input", "sval-agent-polite-box");
    tick.type = "checkbox";
    tick.addEventListener("change", () => {
      const agentId = this.#agentId();
      if (agentId) {
        setPolite(agentId, tick.checked);
      }
    });
    polite.append(tick, this.#html("span", "sval-agent-polite-text"));
    const avatar = this.#html("span", "sval-agent-avatar");
    avatar.append(this.#robot());
    const copy = this.#html("div", "sval-agent-copy");
    copy.append(text, status, challenge);
    const label = this.#html("div", "sval-agent-label");
    label.append(avatar, copy);
    const actions = this.#html("div", "sval-agent-actions");
    actions.append(take, stop, resume);
    // Who is acting and what it is doing in one block, the user's controls
    // in another, apart from it.
    const controls = this.#html("div", "sval-agent-controls");
    controls.append(actions, polite);
    card.append(label, controls);
    overlay.append(titlebar, card);
    overlay.addEventListener("click", this);
    doc.body.append(overlay);
    return overlay;
  }

  /**
   * Takes the agent's workspace from the agent, for Take control of
   * workspace. Every window showing it follows at once (`CONTROL_TOPIC`).
   */
  #take() {
    holdWorkspace(this.#workspaceId(), true);
    this.#announce(
      `You control this Workspace. Give Workspace back to ${this.#label} is above the page.`,
      "user"
    );
    this.#win.gBrowser.selectedBrowser.focus();
  }

  /**
   * Stops the agent whose workspace this window shows, for Stop, or lets it
   * go on, for Resume. Every window showing it follows at once
   * (`CONTROL_TOPIC`).
   *
   * @param {boolean} stopped
   */
  #setStopped(stopped) {
    stopWorkspace(this.#workspaceId(), stopped);
    this.#announce(
      stopped
        ? `You stopped ${this.#label}. It can't act until you press Resume.`
        : `${this.#label} is controlling this Workspace.`,
      stopped ? "stopped" : "agent"
    );
  }

  /**
   * Gives the workspace back to the agent, whole, in every window showing
   * it (`CONTROL_TOPIC`): the bar's Give workspace back, and the Launcher's
   * command.
   */
  giveBack() {
    if (!this.#held()) {
      return;
    }
    try {
      giveBackWorkspace(this.#workspaceId());
    } catch (err) {
      SvalLog.warn(`a give-back could not be kept: ${SvalLog.errorName(err)}`);
      return;
    }
    this.#announce(`${this.#label} is controlling this Workspace.`, "agent");
    this.#focusCard();
  }

  /**
   * @param {Element} container The tab's `.browserContainer`.
   * @param {Element} stack The tab's `.browserStack`, which the bar sits
   *   above.
   * @returns {Element} The bar.
   */
  #makeBar(container, stack) {
    const bar = this.#html("div", "sval-agent-bar");
    bar.setAttribute("role", "group");
    const text = this.#html("span", "sval-agent-text");
    text.id = `sval-agent-text-${++nextId}`;
    text.textContent = "You control this Workspace.";
    bar.setAttribute("aria-labelledby", text.id);
    const give = this.#html("button", "sval-agent-give");
    give.addEventListener("click", () => this.giveBack());
    bar.append(this.#robot(), text, give);
    container.insertBefore(bar, stack);
    return bar;
  }

  /**
   * Says `text` through the window's live region, so a screen reader hears
   * that control changed hands even though focus moves on to the page.
   *
   * @param {string} text
   * @param {"user"|"agent"|"challenge"|"stopped"} state What it says,
   *   set on the region as `data-state`.
   */
  #announce(text, state) {
    if (!this.#announcer) {
      this.#announcer = this.#html("div", "sval-agent-announcer");
      this.#announcer.setAttribute("role", "status");
      this.#win.document.body.append(this.#announcer);
    }
    this.#announcer.textContent = text;
    this.#announcer.dataset.state = state;
  }
}
