/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The content side of an agent's page actor. It runs only where the parent
 * asks for it: the actor declares no events, so `getActor` from the parent is
 * the only thing that creates one.
 *
 * An actor belongs to one window global, so its refs belong to one document.
 * A page the tab navigates to gets a fresh actor with no refs at all, which
 * is what makes a ref from an older page answer `stale_ref`.
 *
 * Input goes through Gecko's own WebDriver event module, as Marionette and
 * WebDriver BiDi send it from their content actors. Its mouse events go
 * through `windowUtils` and its keys through TextInputProcessor, so the page
 * sees them as trusted, the way it sees a person's.
 */

import {
  ConsoleWatch,
  MAX_CONSOLE_MESSAGES,
} from "moz-src:///browser/components/sval/SvalAgentConsole.sys.mjs";
import {
  isSecret,
  MASK,
  MAX_NEW_REFS,
  RefTable,
  snapshotOf,
  SOURCE_CHUNK_DEFAULT,
  SOURCE_CHUNK_MAX,
  cap,
} from "moz-src:///browser/components/sval/SvalAgentSnapshot.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  event: "chrome://remote/content/shared/webdriver/Event.sys.mjs",
  keyData: "chrome://remote/content/shared/webdriver/KeyData.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const POLL_MS = 200;
/** The longest `wait_for_text` goes without reading the page's text. */
const RECHECK_MS = 1000;
/** The most frames one human-verification check reports. */
const MAX_CHALLENGE_FRAMES = 50;
/**
 * The fields reCAPTCHA, hCaptcha and Turnstile put their answer in, in the
 * page that embeds them, once the person has completed the widget.
 */
const CHALLENGE_ANSWERS =
  'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]';
const MAX_WAIT_MS = 30_000;

const STALE_REF = { error: "stale_ref" };
const NO_DOCUMENT = { error: "no_document" };
const PAGE_CHANGED = { error: "page_changed" };
const NOT_VISIBLE = { error: "not_visible" };
const CLICK_INTERCEPTED = { error: "click_intercepted" };
const PRESS_INTERCEPTED = { error: "press_intercepted" };
const NOT_CLICKABLE = { error: "not_clickable" };
const OPENS_FILE_PICKER = { error: "opens_file_picker" };
const NOT_FILE_INPUT = { error: "not_file_input" };
const DIALOG_OPEN = { error: "dialog_open" };

/** What `#input` throws when a dialog holds the page. */
const HELD_BY_DIALOG = Symbol("held by a dialog");

/** What `#input` throws once the user has taken control of the tab. */
const HELD_BY_USER = Symbol("held by the user");
const USER_IN_CONTROL = { error: "user_in_control" };
const BAD_FILE = { error: "bad_file" };

/** The keys that activate a focused control, as a click would. */
const ACTIVATING_KEYS = new Set(["Enter", "Space", " "]);

/** Elements whose content is another document, which a click would enter. */
const FRAME_LIKE = new Set(["iframe", "frame", "embed", "object"]);

/**
 * Interactive content, inside which a click does not activate the label
 * around it (`nsContentUtils::IsInInteractiveHTMLContent`, as
 * HTMLLabelElement::PostHandleEvent asks it).
 */
const INTERACTIVE =
  "a[href], area[href], button, details, summary, embed, iframe, frame, " +
  "object, input:not([type=hidden]), select, textarea, label, " +
  "audio[controls], video[controls], img[usemap]";
const NOT_EDITABLE = { error: "not_editable" };
const NOT_FOCUSABLE = { error: "not_focusable" };
const NOT_A_SELECT = { error: "not_a_select" };
const ONE_OPTION = { error: "one_option" };
const NO_SUCH_OPTION = { error: "no_such_option" };
const UNKNOWN_KEY = { error: "unknown_key" };

/** The most of a field's value `type` answers with. */
const MAX_TYPED_VALUE = 10_000;

/**
 * The keys an agent may name, as WebDriver's code points for them, which
 * `keyData.getData` maps to a key and code (KeyData.sys.mjs).
 */
const NAMED_KEYS = {
  Backspace: "\uE003",
  Tab: "\uE004",
  Enter: "\uE006",
  Escape: "\uE00C",
  Space: "\uE00D",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
  End: "\uE010",
  Home: "\uE011",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  Delete: "\uE017",
};

/**
 * WebDriver gives code points in the Private Use Area meanings of its own:
 * U+E009 is Control, and `sendKeys` holds a modifier down for the rest of
 * the string. Text an agent types is text, so these are typed as the
 * characters they are.
 */
const WEBDRIVER_KEYS = /^[\uE000-\uF8FF]$/;

/** Inputs typed into with keys. */
const KEYED_INPUTS = new Set([
  "text",
  "email",
  "password",
  "search",
  "tel",
  "url",
  "number",
]);

/**
 * Inputs whose value is set directly, as Marionette does
 * (`interaction.setFormControlValue`): keys go to the browser's own picker
 * fields, not to the value.
 */
const PICKER_INPUTS = new Set([
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/**
 * @param {string} c One character.
 * @returns {object} The key data that types `c`.
 */
function charData(c) {
  return WEBDRIVER_KEYS.test(c)
    ? { key: c, location: 0, printable: true, shifted: false }
    : lazy.keyData.getData(c);
}

/**
 * @param {Element} el
 * @returns {"keys"|"picker"|null} How text is put into `el`, or null when a
 *   person could not type into it.
 */
function editKind(el) {
  if (el.isContentEditable) {
    return "keys";
  }
  if (el.localName !== "input" && el.localName !== "textarea") {
    return null;
  }
  if (el.matches(":disabled, :read-only")) {
    return null;
  }
  if (el.localName === "textarea" || KEYED_INPUTS.has(el.type)) {
    return "keys";
  }
  return PICKER_INPUTS.has(el.type) ? "picker" : null;
}

/**
 * @param {Element|null} el
 * @returns {boolean}
 */
function isFileInput(el) {
  return el?.localName === "input" && el.type === "file";
}

/**
 * Whether a click on `target` would open a file picker: it is a file input,
 * or the click reaches a label whose control is one. A click on a label's
 * content goes to its control unless interactive content nearer the target
 * takes it first (HTMLLabelElement::PostHandleEvent), which is the walk
 * {@link clickReaches} makes too.
 *
 * @param {Node|null} target
 * @returns {boolean}
 */
function opensFilePicker(target) {
  for (let node = target; node; node = node.flattenedTreeParentNode) {
    if (!Element.isInstance(node)) {
      continue;
    }
    if (isFileInput(node)) {
      return true;
    }
    if (node.localName === "label") {
      return isFileInput(node.control);
    }
    if (node.matches(INTERACTIVE)) {
      return false;
    }
  }
  return false;
}

/**
 * The element that has focus, looked for through open and closed shadow
 * roots. A frame that has focus is where the search stops.
 *
 * @param {Document} document
 * @returns {Element|null}
 */
function focusedElement(document) {
  let active = document.activeElement;
  while (active?.openOrClosedShadowRoot?.activeElement) {
    active = active.openOrClosedShadowRoot.activeElement;
  }
  return active;
}

/**
 * Whether keys sent now reach `el`: it has focus, or it is inside the
 * editing host that has. Read from `el`'s own root, so a field in a shadow
 * tree is compared with that tree's focused element.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function holdsFocus(el) {
  const active = el.getRootNode().activeElement;
  if (active === el) {
    return true;
  }
  return (
    el.isContentEditable && !!active?.isContentEditable && active.contains(el)
  );
}

/**
 * The middle of the part of `rect` inside the viewport, in whole CSS pixels,
 * as Marionette clicks (`dom.getInViewCentrePoint`,
 * remote/shared/DOM.sys.mjs). The viewport is measured without its
 * scrollbars, from the scrolling element, so a point on a scrollbar is
 * never taken for one on the page.
 *
 * @param {DOMRect} rect
 * @param {Window} win
 * @returns {{x: number, y: number}|null} null when none of `rect` is in
 *   view.
 */
function inViewCentre(rect, win) {
  const viewport = win.document.scrollingElement;
  const width = Math.min(win.innerWidth, viewport?.clientWidth || Infinity);
  const height = Math.min(win.innerHeight, viewport?.clientHeight || Infinity);
  const left = Math.max(0, rect.left);
  const right = Math.min(width, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(height, rect.bottom);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  };
}

/**
 * Whether `node` is `ancestor` or below it in the flattened tree: through
 * the slot it is assigned to, and from a shadow tree to its host. That is the
 * path a click's events take, and so which elements a click activates.
 *
 * @param {Node} ancestor
 * @param {Node} node
 * @returns {boolean}
 */
function flattenedContains(ancestor, node) {
  for (; node; node = node.flattenedTreeParentNode) {
    if (node === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a click at (`x`, `y`) would reach `el`, as Marionette's
 * `dom.isObscured` asks, and nothing else would take it.
 *
 * - The hit is read from the document, whatever tree `el` is in. Read from a
 *   shadow root, a hit outside that tree is skipped
 *   (`DocumentOrShadowRoot::Retarget` gives null for it), so a cover in the
 *   light DOM would not count. Shadow trees, closed ones too, are then
 *   searched down to the element there. Hit testing passes over
 *   `pointer-events: none`.
 * - A frame, embed or object there takes the click into another document,
 *   even inside `el`.
 * - The click reaches `el` when the hit is `el` or below it in the flattened
 *   tree, so text slotted into a component's button reaches that button.
 * - A checkbox or radio drawn by its label is reached through the label when
 *   the first interactive element on the hit's flattened-tree path is that
 *   label. Gecko walks the same path (`IsInInteractiveHTMLContent`), and a
 *   click on interactive content inside a label activates that content
 *   instead of the label.
 *
 * @param {Element} el
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function clickReaches(el, x, y) {
  let deepest = el.ownerDocument.elementFromPoint(x, y);
  if (!deepest) {
    return false;
  }
  for (
    let shadow = deepest.openOrClosedShadowRoot;
    shadow;
    shadow = deepest.openOrClosedShadowRoot
  ) {
    const inner = shadow.elementFromPoint(x, y);
    if (!inner || inner === deepest) {
      break;
    }
    deepest = inner;
  }
  if (FRAME_LIKE.has(deepest.localName)) {
    return false;
  }
  if (flattenedContains(el, deepest)) {
    return true;
  }
  if (
    el.localName !== "input" ||
    (el.type !== "checkbox" && el.type !== "radio")
  ) {
    return false;
  }
  for (let node = deepest; node; node = node.flattenedTreeParentNode) {
    if (Element.isInstance(node) && node.matches(INTERACTIVE)) {
      return node.localName === "label" && node.control === el;
    }
  }
  return false;
}

/**
 * The element a wheel turned at the middle of the viewport would scroll: the
 * nearest one under that point that can still scroll that way. Null means
 * the page itself.
 *
 * @param {Window} win
 * @param {boolean} horizontal
 * @param {number} sign -1 toward the top or left, 1 toward the bottom or
 *   right.
 * @returns {Element|null}
 */
function scrollerAt(win, horizontal, sign) {
  const doc = win.document;
  let el = doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2);
  while (el && el !== doc.documentElement && el !== doc.body) {
    const style = win.getComputedStyle(el);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      const position = horizontal ? el.scrollLeft : el.scrollTop;
      const end = horizontal
        ? el.scrollWidth - el.clientWidth
        : el.scrollHeight - el.clientHeight;
      if (sign > 0 ? position < end : position > 0) {
        return el;
      }
    }
    el = el.parentElement ?? el.getRootNode().host ?? null;
  }
  return null;
}

/**
 * Runs `scroll` and, when it moved something, waits for the page to see it:
 * for its `scroll` event, or for its next animation frame. Gecko runs a
 * document's scroll steps and then its animation frame callbacks in the same
 * refresh tick (`nsRefreshDriver::Tick`), and throttles a hidden document's
 * frame callbacks to a tick of their own, so the frame never comes before
 * the scroll steps have run. A page that is not painting ticks on a throttled
 * timer whose interval doubles while it keeps ticking
 * (`InactiveRefreshDriverTimer`), so no fixed wait covers it. The frame also
 * ends the wait for a scroll whose event never reaches the window: `scroll`
 * is not composed, so one inside a shadow root stays there, and a scroller
 * destroyed before the tick revokes its event. The listener is in the system
 * group, so it runs after every listener the page added for the same event.
 * A page that goes away first ends the wait.
 *
 * @param {Window} win
 * @param {() => boolean} scroll Scrolls, and says whether anything moved.
 */
async function scrolled(win, scroll) {
  const { promise, resolve } = Promise.withResolvers();
  const options = { capture: true, mozSystemGroup: true };
  win.addEventListener("scroll", resolve, options);
  win.addEventListener("pagehide", resolve, options);
  let frame = null;
  try {
    if (scroll()) {
      frame = win.requestAnimationFrame(resolve);
      await promise;
    }
  } finally {
    if (frame !== null) {
      win.cancelAnimationFrame(frame);
    }
    win.removeEventListener("scroll", resolve, options);
    win.removeEventListener("pagehide", resolve, options);
  }
}

/**
 * @param {Element} el
 * @returns {string} What the field holds now, as the agent may see it.
 */
function fieldValue(el) {
  const value = el.isContentEditable ? el.innerText : el.value;
  if (isSecret(el)) {
    return value ? MASK : "";
  }
  return cap(value, MAX_TYPED_VALUE);
}

/** Elements whose content a secret field keeps: a textarea's is its value. */
const FIELDS = "input, textarea";

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number} `value` as a whole number from 0 to `max`, or `fallback`
 *   when it is not a number.
 */
function clamp(value, fallback, max) {
  const number = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(number, 0), max);
}

/** Answers the parent's queries about this window global's page. */
export class SvalAgentPageChild extends JSWindowActorChild {
  #refs = new RefTable();
  #destroyed = false;
  /** Wakes the waits in progress, which end when the actor does. */
  #wakes = new Set();
  /**
   * Whether the user has taken control of this tab, as the parent last said
   * (`SvalAgentPageParent`'s `userHeld`). Checked next to every input this
   * actor dispatches, so input of the agent's that is still under way when
   * the user takes the tab stops there.
   */
  #userHeld = false;
  /** What the page writes to the console, from the actor's start on. */
  #console = null;

  actorCreated() {
    try {
      this.#console = new ConsoleWatch(this.manager.innerWindowId);
    } catch {}
  }

  didDestroy() {
    this.#destroyed = true;
    this.#console?.stop();
    for (const wake of this.#wakes) {
      wake();
    }
  }

  /**
   * @param {{name: string, data: object}} message
   * @returns {object|Promise<object>|null}
   */
  receiveMessage(message) {
    if (message.name === "userHeld") {
      this.#userHeld = message.data?.held === true;
      return null;
    }
    // Sent as each page in an agent's tab is created: the actor's creation
    // starts its console watch (`actorCreated`), and the message asks
    // nothing more.
    if (message.name === "watchConsole") {
      return null;
    }
    const refusal = err => {
      if (err === HELD_BY_DIALOG) {
        return DIALOG_OPEN;
      }
      if (err === HELD_BY_USER) {
        return USER_IN_CONTROL;
      }
      throw err;
    };
    let answer;
    try {
      answer = this.#receive(message);
    } catch (err) {
      return refusal(err);
    }
    return answer instanceof Promise ? answer.catch(refusal) : answer;
  }

  /**
   * @param {{name: string, data: object}} message
   * @returns {object|Promise<object>|null}
   */
  #receive({ name, data }) {
    switch (name) {
      case "snapshot":
        return this.#snapshot(data ?? {});
      case "console":
        return this.#consoleMessages(data ?? {});
      case "source":
        return this.#source(data ?? {});
      case "text":
        return this.#text(data ?? {});
      case "waitForText":
        return this.#waitForText(data ?? {});
      case "click":
        return this.#click(data ?? {});
      case "type":
        return this.#type(data ?? {});
      case "select":
        return this.#select(data ?? {});
      case "press":
        return this.#press(data ?? {});
      case "scroll":
        return this.#scroll(data ?? {});
      case "fileInput":
        return this.#fileInput(data ?? {});
      case "upload":
        return this.#upload(data ?? {});
      case "draw":
        return this.#draw(data ?? {});
      case "challenge":
        return this.#challenge();
    }
    return null;
  }

  /**
   * Throws `HELD_BY_DIALOG` when a dialog holds the page: nothing the page
   * would see, an input or a focus change, is made while it is stopped.
   * Throws `HELD_BY_USER` once the user has taken control of the tab.
   */
  #refuseIfHeld() {
    if (this.#userHeld) {
      throw HELD_BY_USER;
    }
    if (this.contentWindow?.windowUtils.isInModalState()) {
      throw HELD_BY_DIALOG;
    }
  }

  /**
   * Runs `dispatch` the way Marionette does (MarionetteCommandsChild
   * `#dispatchEvent`). This message arrives as a WebIDL callback, which has
   * raised the microtask level, so microtasks the events queue would wait
   * for it to return. Setting it to 0 lets them run between events, as they
   * do for a person's input.
   *
   * @param {(win: Window) => any} dispatch
   * @returns {Promise<any>}
   */
  async #input(dispatch) {
    const win = this.contentWindow;
    const windowUtils = win.windowUtils;
    // A page held by a dialog is in a nested event loop with its events
    // suppressed (`nsGlobalWindowOuter::EnterModalState`): an input sent now
    // would be delivered after the dialog closes, as nobody meant it. A
    // query reaches here in that state when a dialog opens between the
    // parent's check and the query's arrival.
    this.#refuseIfHeld();
    const microTaskLevel = windowUtils.microTaskLevel;
    windowUtils.microTaskLevel = 0;
    try {
      return await dispatch(win);
    } finally {
      windowUtils.microTaskLevel = microTaskLevel;
    }
  }

  /**
   * @param {unknown} ref
   * @returns {Element|object} The element `ref` names, or the answer that
   *   says why there is none.
   */
  #element(ref) {
    const document = this.document;
    if (!document?.documentElement) {
      return NO_DOCUMENT;
    }
    return this.#refs.resolve(document, ref) ?? STALE_REF;
  }

  async #click({ ref }) {
    const el = this.#element(ref);
    if (!Element.isInstance(el)) {
      return el;
    }
    // A frame's content is another document, which may be another site's
    // page with the person signed in. A page can give a frame any role, so
    // a ref to one is never clicked into.
    if (FRAME_LIKE.has(el.localName)) {
      return NOT_CLICKABLE;
    }
    // Files reach a page only through `upload_file` (spec §4.4).
    if (opensFilePicker(el)) {
      return OPENS_FILE_PICKER;
    }
    // Instantly, so the box read next is where the element ends up even on
    // a page that scrolls smoothly.
    el.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    // The first box with an area, as Marionette takes it
    // (`dom.getFirstNonZeroRect`): a link that wraps has one box per line,
    // and the middle of their union can fall between the lines.
    const rect = [...el.getClientRects()].find(r => r.width && r.height);
    if (!rect) {
      return NOT_VISIBLE;
    }
    // The checks and both halves of the click run in this one callback, so
    // no page script runs between a check and the event it allows except
    // the press's own handlers, which the second check is for.
    const refused = await this.#input(async win => {
      const point = inViewCentre(rect, win);
      if (!point) {
        return NOT_VISIBLE;
      }
      const { x, y } = point;
      if (!clickReaches(el, x, y)) {
        return CLICK_INTERCEPTED;
      }
      // What the click lands on can be a label of its own inside `el`.
      if (opensFilePicker(el.ownerDocument.elementFromPoint(x, y))) {
        return OPENS_FILE_PICKER;
      }
      await lazy.event.synthesizeMouseAtPoint(x, y, { type: "mousedown" }, win);
      // The user can take the tab while the press is handled. The button is
      // let go away from the page, so no click lands for the agent.
      if (this.#userHeld) {
        await lazy.event.synthesizeMouseAtPoint(
          -1,
          -1,
          { type: "mouseup" },
          win
        );
        return USER_IN_CONTROL;
      }
      // A press handler can raise a cover, or move the element, before the
      // release. Released there, the click would go to what is there now.
      if (!el.isConnected || !clickReaches(el, x, y)) {
        await lazy.event.synthesizeMouseAtPoint(
          -1,
          -1,
          { type: "mouseup" },
          win
        );
        return PRESS_INTERCEPTED;
      }
      await lazy.event.synthesizeMouseAtPoint(x, y, { type: "mouseup" }, win);
      return null;
    });
    return refused ?? { ref };
  }

  /**
   * Types `text` into the field `ref` names, over what it holds unless
   * `clear` is false. A date or time field takes `text` as its value, as
   * the browser's picker would set it.
   *
   * @param {{ref: string, text: string, clear?: boolean}} options
   * @returns {Promise<object>}
   */
  async #type({ ref, text, clear }) {
    const el = this.#element(ref);
    if (!Element.isInstance(el)) {
      return el;
    }
    const kind = editKind(el);
    if (!kind || typeof text !== "string") {
      return NOT_EDITABLE;
    }
    if (kind === "picker") {
      // The value is set without keys, so nothing about the input itself
      // would stop it; a field a person could not reach is refused here.
      if (
        el.disabled ||
        el.closest("[inert]") ||
        !el.checkVisibility({ checkVisibilityCSS: true })
      ) {
        return NOT_FOCUSABLE;
      }
      this.#refuseIfHeld();
      el.focus();
      if (!holdsFocus(el)) {
        return NOT_FOCUSABLE;
      }
      await this.#input(win => {
        el.value = text;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
      });
      return { value: fieldValue(el) };
    }
    // Keys go to whatever has focus. A field that cannot take focus, or a
    // page that moves focus away when it does, would put the text in
    // another field, so nothing is typed unless the field holds focus.
    this.#refuseIfHeld();
    el.focus();
    if (!holdsFocus(el)) {
      return NOT_FOCUSABLE;
    }
    const selection = this.contentWindow.getSelection();
    if (clear === false) {
      if (el.isContentEditable) {
        selection.selectAllChildren(el);
        selection.collapseToEnd();
      } else if (el.selectionStart !== null) {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    } else if (el.isContentEditable) {
      selection.selectAllChildren(el);
    } else {
      el.select();
    }
    const emptying = clear !== false && text === "" && fieldValue(el) !== "";
    const toEnd =
      clear === false && !el.isContentEditable && el.selectionStart === null;
    const keys = [];
    if (toEnd) {
      // `email` and `number` inputs have no selection API to move the caret
      // with, so it is moved the way a person would.
      keys.push(lazy.keyData.getData(NAMED_KEYS.End));
    }
    if (emptying) {
      keys.push(lazy.keyData.getData(NAMED_KEYS.Backspace));
    }
    for (const c of text) {
      keys.push(charData(c));
    }
    // A key's handlers can move focus too, so focus is checked before each.
    const kept = await this.#input(win => {
      for (const key of keys) {
        this.#refuseIfHeld();
        if (!holdsFocus(el)) {
          return false;
        }
        lazy.event.sendSingleKey(key, win);
      }
      return true;
    });
    return kept ? { value: fieldValue(el) } : NOT_FOCUSABLE;
  }

  async #select({ ref, values }) {
    const el = this.#element(ref);
    if (!Element.isInstance(el)) {
      return el;
    }
    if (el.localName !== "select") {
      return NOT_A_SELECT;
    }
    if (el.matches(":disabled")) {
      return NOT_EDITABLE;
    }
    if (!Array.isArray(values) || !values.length) {
      return NO_SUCH_OPTION;
    }
    if (!el.multiple && values.length > 1) {
      return ONE_OPTION;
    }
    const options = [...el.options].filter(o => !o.matches(":disabled"));
    const chosen = new Set();
    for (const value of values) {
      const option = options.find(
        o => o.value === value || o.label.trim() === value
      );
      if (!option) {
        return NO_SUCH_OPTION;
      }
      chosen.add(option);
    }
    await this.#input(win => {
      for (const option of el.options) {
        // A disabled option keeps its state, as it does for a person.
        if (
          (el.multiple || chosen.has(option)) &&
          !option.matches(":disabled")
        ) {
          option.selected = chosen.has(option);
        }
      }
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    return {};
  }

  async #press({ keys }) {
    if (!Array.isArray(keys)) {
      return UNKNOWN_KEY;
    }
    // Every key is checked before any is sent, so a bad key sends nothing.
    const data = [];
    for (const key of keys) {
      if (typeof key !== "string") {
        return UNKNOWN_KEY;
      }
      if (Object.hasOwn(NAMED_KEYS, key)) {
        data.push(lazy.keyData.getData(NAMED_KEYS[key]));
      } else if ([...key].length === 1) {
        data.push(charData(key));
      } else {
        return UNKNOWN_KEY;
      }
    }
    // A key that activates a focused file input opens its picker, as a
    // click would.
    if (
      keys.some(key => ACTIVATING_KEYS.has(key)) &&
      isFileInput(focusedElement(this.document))
    ) {
      return OPENS_FILE_PICKER;
    }
    await this.#input(win => {
      for (const key of data) {
        this.#refuseIfHeld();
        lazy.event.sendSingleKey(key, win);
      }
    });
    return {};
  }

  /**
   * @param {unknown} ref
   * @param {number} count How many files it is to take.
   * @returns {Element|object} The file input `ref` names, if it can take
   *   `count` files, or the answer that says why not. A disabled input is
   *   one a person could not use either.
   */
  #fileInputFor(ref, count) {
    const el = this.#element(ref);
    if (!Element.isInstance(el)) {
      return el;
    }
    if (!isFileInput(el)) {
      return NOT_FILE_INPUT;
    }
    if (el.disabled) {
      return NOT_EDITABLE;
    }
    if (!Number.isInteger(count) || count < 1 || (count > 1 && !el.multiple)) {
      return BAD_FILE;
    }
    return el;
  }

  #fileInput({ ref, count }) {
    const el = this.#fileInputFor(ref, count);
    return Element.isInstance(el) ? {} : el;
  }

  /**
   * Gives the input its files the way WebDriver BiDi's `input.setFiles` does
   * (remote/webdriver-bidi/modules/windowglobal/input.sys.mjs):
   * `mozSetFileArray`, then the `input` and `change` events a picker fires.
   * The parent made the files from bytes it read (`SvalAgentPageParent.upload`).
   *
   * @param {{ref: string, files: File[]}} options
   * @returns {Promise<object>}
   */
  async #upload({ ref, files }) {
    if (!Array.isArray(files) || !files.every(f => File.isInstance(f))) {
      return BAD_FILE;
    }
    const el = this.#fileInputFor(ref, files.length);
    if (!Element.isInstance(el)) {
      return el;
    }
    await this.#input(win => {
      el.mozSetFileArray(files);
      el.dispatchEvent(
        new win.Event("input", { bubbles: true, composed: true })
      );
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    return {};
  }

  /**
   * Scrolls `ref` into view, or scrolls toward `direction` by `amount`
   * times 80% of the scroller's size.
   *
   * The scroll is made directly and at once. A synthesized wheel event
   * scrolls through the async scroll path, which moves only on refresh
   * driver ticks, and an agent's window is often not painting.
   *
   * The answer waits for the page to see the scroll (`scrolled`), so what
   * it sends from its scroll listeners falls in the input's action window.
   *
   * @param {{ref?: string, direction?: string, amount?: number}} options
   * @returns {Promise<object>}
   */
  async #scroll({ ref, direction, amount }) {
    if (ref !== undefined && ref !== null) {
      const el = this.#element(ref);
      if (!Element.isInstance(el)) {
        return el;
      }
      await scrolled(this.contentWindow, () => {
        const before = el.getBoundingClientRect();
        el.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
        const after = el.getBoundingClientRect();
        return before.top !== after.top || before.left !== after.left;
      });
      return {};
    }
    const win = this.contentWindow;
    if (!win?.document?.documentElement) {
      return NO_DOCUMENT;
    }
    const steps = Number.isInteger(amount)
      ? Math.min(Math.max(amount, 1), 10)
      : 1;
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "up" || direction === "left" ? -1 : 1;
    const target = scrollerAt(win, horizontal, sign);
    const screen = target
      ? target[horizontal ? "clientWidth" : "clientHeight"]
      : win[horizontal ? "innerWidth" : "innerHeight"];
    const by = sign * screen * 0.8 * steps;
    const position = () =>
      target
        ? target[horizontal ? "scrollLeft" : "scrollTop"]
        : win[horizontal ? "scrollX" : "scrollY"];
    await scrolled(win, () => {
      const before = position();
      (target ?? win).scrollBy({
        left: horizontal ? by : 0,
        top: horizontal ? 0 : by,
        behavior: "instant",
      });
      return position() !== before;
    });
    return {};
  }

  /**
   * What `SvalAgentChallenge.classify` needs to tell a human-verification
   * check: the page's own markers of one, and each frame a person could see,
   * by its address and size. Only booleans and frame addresses leave the
   * page, and they go to the parent alone, which answers the agent with a
   * vendor name at most. Nothing here runs the page's script: the window's
   * own property is looked up without calling any getter.
   *
   * @returns {{frames: Array<{src: string, width: number, height: number, visible: boolean}>, markers: object}}
   */
  #challenge() {
    const win = this.contentWindow;
    const doc = win?.document;
    if (!doc?.documentElement) {
      return { frames: [], markers: {} };
    }
    let cloudflare = false;
    try {
      cloudflare = Object.hasOwn(Cu.waiveXrays(win), "_cf_chl_opt");
    } catch {}
    const markers = {
      cloudflare,
      perimeterx: !!doc.querySelector(
        'meta[name="description"][content="px-captcha"]'
      ),
      responded: [...doc.querySelectorAll(CHALLENGE_ANSWERS)].some(
        el => typeof el.value === "string" && el.value !== ""
      ),
    };
    const frames = [];
    for (const el of doc.querySelectorAll("iframe")) {
      if (frames.length >= MAX_CHALLENGE_FRAMES) {
        break;
      }
      const src = el.src;
      if (!/^https?:/i.test(src)) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const inView =
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < win.innerWidth &&
        rect.top < win.innerHeight;
      frames.push({
        src,
        width: rect.width,
        height: rect.height,
        visible:
          inView &&
          el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      });
    }
    return { frames, markers };
  }

  /**
   * Draws the part of the page the tab shows, as WebDriver BiDi's screenshot
   * takes it for the viewport (`_getScreenshotRect`), `scale` pixels to a
   * CSS pixel, with `drawWindow` in this process.
   *
   * A frame in another process is left blank, because its pixels are not in
   * this one: drawing to a canvas that does not record, layout draws a remote
   * frame as nothing (nsSubDocumentFrame.cpp `nsDisplayRemote::Paint`). With
   * Fission every frame from another site is in another process. A frame in
   * this process is drawn, so the documents of those frames are listed, in
   * the same turn as the draw, for the parent to check. The canvas is read
   * with willReadFrequently, which keeps it in software and off the GPU
   * process's recording canvas.
   *
   * `drawWindow` paints a video's decrypted frames, though Gecko keeps them
   * out of a page's own canvas (nsLayoutUtils `SurfaceFromElement` refuses
   * `ContainsRestrictedContent`), so every video holding MediaKeys is painted
   * over in the same turn as the draw, before any of the page's script can
   * run. A Widevine Verified Media Path audit reviews every capture path.
   *
   * @param {object} data
   * @param {number} data.scale Pixels drawn per CSS pixel.
   * @returns {{data: string, frames: number[]}|object} The drawing as a
   *   base64 PNG, and the inner window ids of the frames it drew.
   */
  #draw({ scale }) {
    const win = this.contentWindow;
    if (!win?.document?.documentElement) {
      return NO_DOCUMENT;
    }
    if (!(scale > 0 && scale <= 1)) {
      throw new Error("bad scale");
    }
    const x = win.visualViewport.pageLeft;
    const y = win.visualViewport.pageTop;
    const width = win.innerWidth;
    const height = win.innerHeight;
    if (!(width > 0 && height > 0)) {
      throw new Error("empty viewport");
    }
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.scale(scale, scale);
    const frames = this.#framesInProcess();
    ctx.drawWindow(win, x, y, width, height, "rgb(255,255,255)");
    for (const id of this.#framesInProcess()) {
      if (!frames.includes(id)) {
        frames.push(id);
      }
    }
    this.#coverProtectedVideos(ctx, win.scrollX - x, win.scrollY - y);
    const url = canvas.toDataURL("image/png");
    return { data: url.slice(url.indexOf(",") + 1), frames };
  }

  /**
   * Paints black over every video holding MediaKeys in the page and its
   * frames in this process, shadow trees included. `getBoxQuads` relative to
   * the top document gives each video's corners in its viewport, with
   * transforms and frame offsets applied; `dx` and `dy` move them to the
   * canvas. The outline is stroked as well as filled, so no antialiased
   * edge of the frame survives.
   *
   * @param {CanvasRenderingContext2D} ctx Scaled to CSS pixels.
   * @param {number} dx
   * @param {number} dy
   */
  #coverProtectedVideos(ctx, dx, dy) {
    const top = this.contentWindow.document;
    const videos = [];
    const collect = root => {
      for (const el of root.querySelectorAll("*")) {
        if (HTMLVideoElement.isInstance(el) && el.mediaKeys) {
          videos.push(el);
        }
        if (el.openOrClosedShadowRoot) {
          collect(el.openOrClosedShadowRoot);
        }
      }
    };
    for (const context of this.browsingContext.getAllBrowsingContextsInSubtree()) {
      const doc = context.docShell?.domWindow?.document;
      if (doc) {
        collect(doc);
      }
    }
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.strokeStyle = "rgb(0,0,0)";
    ctx.lineWidth = 2;
    for (const video of videos) {
      for (const quad of video.getBoxQuads({ relativeTo: top })) {
        ctx.beginPath();
        for (const p of [quad.p1, quad.p2, quad.p3, quad.p4]) {
          ctx.lineTo(p.x + dx, p.y + dy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /**
   * @returns {number[]} The inner window ids of the documents in this
   *   process that the page's frames, at any depth, show now. A frame here
   *   with no window is 0, which names no document and so is refused.
   */
  #framesInProcess() {
    const top = this.browsingContext;
    const ids = [];
    for (const context of top.getAllBrowsingContextsInSubtree()) {
      if (context !== top && context.docShell) {
        ids.push(
          context.docShell.domWindow?.windowGlobalChild?.innerWindowId ?? 0
        );
      }
    }
    return ids;
  }

  /**
   * @param {{after?: number, limit?: number}} options
   * @returns {object} `ConsoleWatch.read`'s answer.
   */
  #consoleMessages({ after, limit }) {
    if (!this.#console) {
      return { error: "page_failed" };
    }
    return this.#console.read({
      after: clamp(after, 0, Number.MAX_SAFE_INTEGER),
      limit: clamp(limit, 1, MAX_CONSOLE_MESSAGES) || 1,
    });
  }

  /**
   * @param {object} data
   * @param {number} data.firstRef Where the tab's ref numbers are up to. A
   *   page the tab showed before had its own table, so this table numbers
   *   new refs from there, and no ref number is ever used twice in a tab.
   * @param {string} [data.ref] Outlines this element's subtree alone.
   * @param {boolean} [data.viewportOnly] Lists only what shows in the
   *   viewport.
   * @returns {object}
   */
  #snapshot({ firstRef, ref, viewportOnly }) {
    const document = this.document;
    if (!document?.documentElement) {
      return NO_DOCUMENT;
    }
    let root;
    if (ref !== undefined && ref !== null) {
      root = this.#refs.resolve(document, ref);
      if (!root) {
        return STALE_REF;
      }
    }
    if (Number.isSafeInteger(firstRef) && firstRef > 0) {
      this.#refs.startAt(firstRef);
    }
    const start = this.#refs.next;
    const outline = snapshotOf(document, this.#refs, {
      root,
      viewportOnly: viewportOnly === true,
    });
    const nextRef = this.#refs.next;
    if (nextRef - start > MAX_NEW_REFS) {
      // The parent reserved only this many numbers for the snapshot.
      throw new Error("snapshot handed out more refs than reserved");
    }
    return { ...outline, nextRef };
  }

  /**
   * `element`'s markup with every secret field's value taken out. The copy
   * is made in a document of its own, which has no window, so cloning loads
   * no images and runs none of the page's code. Fields are matched between
   * the page and the copy by their order in the tree, which `importNode`
   * keeps.
   *
   * @param {Element} element
   * @returns {string}
   */
  #cleanMarkup(element) {
    const inert = element.ownerDocument.implementation.createHTMLDocument("");
    const copy = inert.importNode(element, true);
    const fields = [...element.querySelectorAll(FIELDS)];
    const copies = [...copy.querySelectorAll(FIELDS)];
    if (element.matches(FIELDS)) {
      fields.unshift(element);
      copies.unshift(copy);
    }
    fields.forEach((field, i) => {
      if (isSecret(field)) {
        copies[i].removeAttribute("value");
        copies[i].textContent = "";
      }
    });
    return copy.outerHTML;
  }

  /**
   * @param {string} text
   * @param {number} offset
   * @param {number} chunk
   * @returns {{offset: number, nextOffset: number|null, total: number}} where
   *   the chunk of `text` that starts at `offset` runs to, in the shape
   *   `get_page_source` and `get_page_text` both answer with.
   */
  #chunkOf(text, offset, chunk) {
    const total = text.length;
    const start = clamp(offset, 0, total);
    const size =
      clamp(chunk, SOURCE_CHUNK_DEFAULT, SOURCE_CHUNK_MAX) ||
      SOURCE_CHUNK_DEFAULT;
    const end = Math.min(start + size, total);
    return {
      offset: start,
      nextOffset: end < total ? end : null,
      total,
      slice: text.slice(start, end),
    };
  }

  /**
   * @param {unknown} ref An element's ref, or absent for the whole page.
   * @returns {Element|{error: string}} the element, or the error that
   *   answers when the page or the ref is gone.
   */
  #scope(ref) {
    const document = this.document;
    if (!document?.documentElement) {
      return NO_DOCUMENT;
    }
    if (ref === undefined || ref === null) {
      return document.documentElement;
    }
    return this.#refs.resolve(document, ref) ?? STALE_REF;
  }

  #source({ ref, offset, chunk }) {
    const element = this.#scope(ref);
    if (!Element.isInstance(element)) {
      return element;
    }
    const { slice, ...where } = this.#chunkOf(
      this.#cleanMarkup(element),
      offset,
      chunk
    );
    return { html: slice, ...where };
  }

  /**
   * The text `ref`'s element, or the page, draws, in reading order: what
   * `innerText` gives, which takes no value from a field. An element the
   * page does not render is refused, because `innerText` answers its
   * `textContent` instead, which holds the source of scripts and the text of
   * a secret field that `get_page_source` blanks.
   *
   * @param {object} data
   * @param {string} [data.ref] An element's ref; the whole page when absent.
   * @param {number} [data.offset]
   * @param {number} [data.chunk]
   * @returns {object}
   */
  #text({ ref, offset, chunk }) {
    const element = this.#scope(ref);
    if (!Element.isInstance(element)) {
      return element;
    }
    if (!element.checkVisibility()) {
      return STALE_REF;
    }
    const { slice, ...where } = this.#chunkOf(
      element.innerText ?? element.textContent ?? "",
      offset,
      chunk
    );
    return { text: slice, ...where };
  }

  /**
   * Waits for `text` in the page's rendered text. It is read again once the
   * document has changed, at most once every `POLL_MS`, since reading
   * `innerText` lays the page out and serializes all of its text. Attribute
   * changes count: a class or a `hidden` can show text a page already holds.
   * What changes no node, as a style sheet or a transition finishing, is
   * seen within `RECHECK_MS`.
   *
   * @param {{text: string, timeoutMs: number}} data
   * @returns {Promise<{found: boolean}|object>}
   */
  async #waitForText({ text, timeoutMs }) {
    if (typeof text !== "string") {
      return { found: false };
    }
    const deadline = Date.now() + clamp(timeoutMs, 0, MAX_WAIT_MS);
    const gone = () =>
      this.#destroyed ||
      !this.manager?.isCurrentGlobal ||
      this.manager.windowContext?.isInBFCache;
    if (gone()) {
      return PAGE_CHANGED;
    }
    const win = this.contentWindow;
    let changed = true;
    let wake = null;
    const observer = new win.MutationObserver(() => {
      changed = true;
      wake?.();
    });
    observer.observe(this.document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const onGone = () => {
      changed = true;
      wake?.();
    };
    const options = { mozSystemGroup: true };
    win.addEventListener("pagehide", onGone, options);
    this.#wakes.add(onGone);
    const sleep = (ms, wakes) =>
      new Promise(resolve => {
        const timer = lazy.setTimeout(resolve, ms);
        if (wakes) {
          wake = () => {
            lazy.clearTimeout(timer);
            resolve();
          };
        }
      }).finally(() => {
        wake = null;
      });
    try {
      for (;;) {
        if (gone()) {
          return PAGE_CHANGED;
        }
        if (changed) {
          changed = false;
          if (this.document?.body?.innerText.includes(text)) {
            return { found: true };
          }
        }
        if (deadline - Date.now() <= 0) {
          return { found: false };
        }
        await sleep(Math.min(POLL_MS, deadline - Date.now()), false);
        if (!changed && !gone() && deadline - Date.now() > 0) {
          await sleep(Math.min(RECHECK_MS, deadline - Date.now()), true);
          changed = true;
        }
      }
    } finally {
      this.#wakes.delete(onGone);
      observer.disconnect();
      win.removeEventListener("pagehide", onGone, options);
    }
  }
}
