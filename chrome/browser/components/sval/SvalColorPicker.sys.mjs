/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The colour section a Workspace or group is coloured with (decision 0057):
 * the presets, a custom colour, and a Workspace's transparency. The
 * Workspace dialog (`workspace-form.js`) and first run's Workspace step draw
 * it; its look is `sval-color-picker.css`, in the colours its host gives it.
 *
 * A Workspace's presets are two rows: each preset's dark version, then its
 * light one (`SvalColor.presetVersion`). A custom colour is picked on a
 * wheel, hue round it and intensity out from its centre, painted at the
 * chosen shade. Shade runs over every lightness `SvalColor` lets body text
 * meet its target on, dark to light, so every colour the wheel and Shade
 * reach passes, and the text changes side where Shade crosses from the deep
 * colours to the pale ones. A group's presets are one row, and its custom
 * colour is a hue and an intensity on the same wheel: its window sets its
 * lightness.
 *
 * Pure DOM: the host's document makes the elements, so the picker draws in a
 * dialog's page and in the browser window alike.
 */

import { SvalColor } from "moz-src:///browser/components/sval/SvalColor.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The wheel's canvas, in pixels, at twice the size CSS draws it
// (`sval-color-picker.css`), so it stays sharp on a high-density screen.
const WHEEL = 300;

// The wheel is painted from lightnesses worked out on a grid of this many
// hue steps and chroma steps, and blended between them.
const GRID_H = 48;
const GRID_C = 10;

// The wheel's pixels are blended from colours worked out on a grid of this
// many hue steps and chroma steps.
const FINE_H = 120;
const FINE_C = 30;

let wheelPixelTable = null;

/**
 * Where each of the wheel's pixels falls on the fine grid, worked out once:
 * its byte offset in the image and the grid cell it blends from, and its
 * place in that cell.
 *
 * @returns {{at: Int32Array, weights: Float32Array, count: number}}
 */
function wheelPixels() {
  if (wheelPixelTable) {
    return wheelPixelTable;
  }
  const at = new Int32Array(WHEEL * WHEEL * 2);
  const weights = new Float32Array(WHEEL * WHEEL * 2);
  const R = WHEEL / 2;
  let count = 0;
  for (let y = 0; y < WHEEL; y++) {
    for (let x = 0; x < WHEEL; x++) {
      const dx = x + 0.5 - R;
      const dy = R - (y + 0.5);
      const r = Math.hypot(dx, dy) / R;
      if (r > 1) {
        continue;
      }
      const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const fa = (h / 360) * FINE_H;
      const fb = r * FINE_C;
      const a0 = Math.min(FINE_H - 1, Math.floor(fa));
      const b0 = Math.min(FINE_C - 1, Math.floor(fb));
      at[2 * count] = (y * WHEEL + x) * 4;
      at[2 * count + 1] = a0 * (FINE_C + 1) + b0;
      weights[2 * count] = fa - a0;
      weights[2 * count + 1] = fb - b0;
      count++;
    }
  }
  wheelPixelTable = { at, weights, count };
  return wheelPixelTable;
}

// A slider thumb's centre travels this far in from each end of its track.
const THUMB_INSET = 9;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * The lightnesses of one side of a Workspace colour's shades, or the other
 * side's where it has none.
 *
 * @param {number} h
 * @param {number} c
 * @param {"pale"|"deep"} band
 * @param {boolean} more
 * @returns {number[]}
 */
function bandList(h, c, band, more) {
  const b = SvalColor.bands(h, c, more);
  return b[band].length ? b[band] : b[band === "pale" ? "deep" : "pale"];
}

/**
 * The lightness a shade gives hue `h` and chroma `c`. A shade is a band and
 * a place in it, `frac` 0 its lightest and 1 its darkest, so moving on the
 * wheel keeps the place and the text's side wherever the colour allows.
 *
 * @param {number} h
 * @param {number} c
 * @param {{band: string, frac: number}} shade
 * @param {boolean} more
 * @returns {number|undefined}
 */
function lightnessOf(h, c, { band, frac }, more) {
  const Ls = bandList(h, c, band, more);
  return Ls[Math.round((1 - frac) * (Ls.length - 1))];
}

/**
 * Every shade of hue `h` and chroma `c`, darkest first.
 *
 * @param {number} h
 * @param {number} c
 * @param {boolean} more
 * @returns {Array<{band: string, frac: number, l: number}>}
 */
function shadesOf(h, c, more) {
  const b = SvalColor.bands(h, c, more);
  const place = (band, Ls) =>
    Ls.map((l, i) => ({
      band,
      l,
      frac: Ls.length > 1 ? 1 - i / (Ls.length - 1) : 0,
    }));
  return [...place("deep", b.deep), ...place("pale", b.pale)];
}

/**
 * Timings of each drag on the wheel or a slider, for comparing how fast
 * machines draw the picker: what each step costs in the picker, the dialog
 * and the window, and how often the window draws a frame. Off unless
 * `browser.sval.colorPicker.timing` is set. Each drag's summary goes to the
 * Browser Console and to `sval-picker-timing.txt` in the profile. They hold
 * times and counts only.
 */
export const pickerTiming = {
  /** The drag being timed, or null. */
  _drag: null,

  /**
   * Starts timing a drag, when timing is on.
   *
   * @param {string} what The control dragged.
   * @param {Window} win The picker's window, whose frames are counted.
   */
  start(what, win) {
    if (!Services.prefs.getBoolPref("browser.sval.colorPicker.timing", false)) {
      return;
    }
    const drag = {
      what,
      began: ChromeUtils.now(),
      events: 0,
      stages: {},
      frames: [],
    };
    this._drag = drag;
    let last = ChromeUtils.now();
    const tick = () => {
      if (this._drag !== drag) {
        return;
      }
      const now = ChromeUtils.now();
      drag.frames.push(now - last);
      last = now;
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  },

  /** Counts a pointer event the drag received. */
  event() {
    if (this._drag) {
      this._drag.events++;
    }
  },

  /**
   * Runs `fn`, adding its time to `stage` while a drag is timed.
   *
   * @param {string} stage
   * @param {Function} fn
   * @returns {*} what `fn` returns.
   */
  time(stage, fn) {
    const drag = this._drag;
    if (!drag) {
      return fn();
    }
    const t0 = ChromeUtils.now();
    try {
      return fn();
    } finally {
      (drag.stages[stage] ??= []).push(ChromeUtils.now() - t0);
    }
  },

  /**
   * Times the style and layout `doc` has pending, as `stage`, while a drag
   * is timed. Reading a box makes Gecko do now what the next frame would.
   *
   * @param {string} stage
   * @param {Document} doc
   */
  flush(stage, doc) {
    if (this._drag) {
      this.time(stage, () => doc.documentElement.getBoundingClientRect());
    }
  },

  /** Ends the drag and reports it. */
  end() {
    const drag = this._drag;
    if (!drag) {
      return;
    }
    this._drag = null;
    const sum = list => list.reduce((a, b) => a + b, 0);
    const stat = list =>
      list.length
        ? `n=${list.length} avg=${(sum(list) / list.length).toFixed(1)} max=${Math.max(...list).toFixed(1)}`
        : "n=0";
    const lines = [
      `${new Date().toISOString()} ${drag.what} drag, ${Services.appinfo.OS}: ` +
        `${(ChromeUtils.now() - drag.began).toFixed(0)} ms, ${drag.events} pointer events`,
      ...Object.entries(drag.stages).map(
        ([stage, list]) => `  ${stage} ms: ${stat(list)}`
      ),
      `  frame interval ms: ${stat(drag.frames.slice(1))}`,
    ];
    const text = lines.join("\n");
    Services.console.logStringMessage(`Sval picker timing\n${text}`);
    IOUtils.writeUTF8(
      PathUtils.join(PathUtils.profileDir, "sval-picker-timing.txt"),
      text + "\n",
      { mode: "append" }
    ).catch(() => {});
  },
};

/**
 * One colour section, bound to the element it fills.
 */
export class SvalColorPicker {
  /**
   * @param {Element} root An empty element the picker fills.
   * @param {object} options
   * @param {"workspace"|"group"} options.kind
   * @param {string|object|null} [options.color] A filtered colour.
   * @param {number} [options.transparency] A Workspace's, as stored.
   * @param {Function} options.context Answers `{scheme, more, on,
   *   seeThrough}`: the appearance and contrast the colours are drawn for,
   *   for a group the window its block sits on (`SvalColor.groupBlock`), and
   *   the material a window shows what is behind it through, or null
   *   (`SvalColor.seeThroughMaterial`).
   * @param {string} [options.labelId] The id the section's label takes.
   * @param {Function} [options.onChange] Called with `{color, transparency,
   *   done}` on each change; `done` is false while a drag goes on.
   */
  constructor(
    root,
    {
      kind,
      color = null,
      transparency = 0,
      context,
      labelId = "sval-nw-color-label",
      onChange = () => {},
    }
  ) {
    this._root = root;
    this._doc = root.ownerDocument;
    this._kind = kind;
    this._context = context;
    this._onChange = onChange;
    /** @type {string|object|null} The chosen colour. */
    this.color = color;
    /** The colour the "+" swatch holds, kept while a preset is chosen. */
    this._custom = color && typeof color === "object" ? { ...color } : null;
    /** The swatch last chosen, while the colour is still its colour. */
    this._slot = null;
    /** The custom colour's shade, and the custom colour it belongs to. */
    this._shade = null;
    /** @type {number} The chosen transparency, as the person set it. */
    this.transparency = kind === "workspace" ? transparency || 0 : 0;
    /** The transparency the colour arrived with, kept where it can't draw. */
    this._heldTransparency = this.transparency;
    this._wheelKey = "";
    this._build(labelId);
    this.refresh();
  }

  /**
   * @param {string} tag
   * @param {object} [attrs]
   * @param {...(Node|string)} children
   * @returns {Element}
   */
  _el(tag, attrs = {}, ...children) {
    const el = this._doc.createElementNS(HTML_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) {
        el.setAttribute(name, value);
      }
    }
    el.append(...children);
    return el;
  }

  /**
   * The swatches, in order: `slot` names what each picks, `row` and `col`
   * its place in the grid.
   *
   * @returns {Array<{slot: string, label: string, row: number, col: number}>}
   */
  _slots() {
    const { PRESETS, PRESET_LABELS } = SvalColor;
    if (this._kind === "group") {
      return [
        { slot: "", label: "No color" },
        ...PRESETS.map(name => ({ slot: name, label: PRESET_LABELS[name] })),
        { slot: "custom", label: "Custom color" },
      ].map((each, col) => ({ ...each, row: 1, col }));
    }
    return [
      { slot: "", label: "No color", row: 1, col: 0 },
      ...PRESETS.map((name, i) => ({
        slot: `dark:${name}`,
        label: `${PRESET_LABELS[name]}, dark`,
        row: 1,
        col: i + 1,
      })),
      {
        slot: "custom",
        label: "Custom color",
        row: 1,
        col: PRESETS.length + 1,
      },
      ...PRESETS.map((name, i) =>
        name === "black"
          ? { slot: "light:white", label: "White", row: 2, col: i + 1 }
          : {
              slot: `light:${name}`,
              label: `${PRESET_LABELS[name]}, light`,
              row: 2,
              col: i + 1,
            }
      ),
    ];
  }

  _build(labelId) {
    const el = (...args) => this._el(...args);
    this._root.classList.add("sval-cp");
    this._root.dataset.kind = this._kind;
    this._name = el("span", {
      class: "sval-nw-color-name",
      "aria-hidden": "true",
    });
    const head = el(
      "div",
      { class: "sval-nw-color-head" },
      el("span", { class: "sval-dialog-label", id: labelId }, "Color"),
      this._name
    );
    this._swatches = el("div", {
      class: "sval-nw-colors",
      role: "radiogroup",
      "aria-labelledby": labelId,
    });
    for (const { slot, label, row, col } of this._slots()) {
      const swatch = el("button", {
        class: "sval-nw-swatch",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "aria-label": label,
        title: label,
        "data-slot": slot,
        "data-token": slot,
        "data-row": row,
        "data-col": col,
      });
      // Set through the CSSOM: a dialog's page forbids style attributes
      // (its Content-Security-Policy).
      swatch.style.gridArea = `${row} / ${col + 1}`;
      this._swatches.append(swatch);
    }
    this._swatches.addEventListener("click", event => {
      const swatch = event.target.closest?.(".sval-nw-swatch");
      if (swatch) {
        this._chooseSwatch(swatch);
      }
    });
    this._swatches.addEventListener("keydown", event =>
      this._onSwatchKey(event)
    );

    this._customBlock = el("div", { class: "sval-cp-custom" });
    this._canvas = el("canvas", {
      class: "sval-cp-wheel-paint",
      width: WHEEL,
      height: WHEEL,
    });
    this._knob = el("span", { class: "sval-cp-knob", "aria-hidden": "true" });
    this._wheel = el(
      "div",
      {
        class: "sval-cp-wheel",
        role: "slider",
        tabindex: "0",
        "aria-label": "Hue and intensity",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      },
      this._canvas,
      this._knob
    );
    this._drag(this._wheel, (event, done) => this._wheelAt(event, done));
    this._wheel.addEventListener("keydown", event => this._onWheelKey(event));
    // Shade, and Transparency while a custom colour is on show, stand to
    // the wheel's right.
    this._side = el("div", { class: "sval-cp-side" });
    this._customBlock.append(this._wheel, this._side);
    this._shadeRow = null;
    if (this._kind === "workspace") {
      this._shadeRow = this._slider("Shade", {
        set: (x, done) => this._setShade(x, done),
        get: () =>
          this._shadeAt().index / Math.max(1, this._shadeAt().count - 1),
        step: () => 1 / Math.max(1, this._shadeAt().count - 1),
      });
      this._side.append(this._shadeRow.row);
    }

    this._transparencyRow = null;
    if (this._kind === "workspace") {
      this._transparencyRow = this._slider("Transparency", {
        set: (x, done) => this._setTransparency(x, done),
        get: () => {
          const max = this._max();
          return max ? clamp(this.transparency / max) : 0;
        },
        step: () => 0.05,
      });
    }
    this._root.append(
      head,
      this._swatches,
      this._customBlock,
      ...(this._transparencyRow ? [this._transparencyRow.row] : [])
    );
  }

  /**
   * A slider row: its label, its track and thumb, and its value.
   *
   * @param {string} label
   * @param {object} how
   * @param {Function} how.set Called with the thumb's place, 0..1, and
   *   whether the change is done.
   * @param {Function} how.get The thumb's place, 0..1.
   * @param {Function} how.step What an arrow key moves it by.
   * @returns {{row: Element, slider: Element, track: Element, thumb: Element,
   *   value: Element}}
   */
  _slider(label, { set, get, step }) {
    const el = (...args) => this._el(...args);
    const name = el("span", { class: "sval-cp-label" }, label);
    const track = el("span", { class: "sval-cp-track" });
    const thumb = el("span", { class: "sval-cp-thumb" });
    const slider = el(
      "div",
      {
        class: "sval-cp-slider",
        role: "slider",
        tabindex: "0",
        "aria-label": label,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      },
      track,
      thumb
    );
    const value = el("span", { class: "sval-cp-value" });
    const row = el("div", { class: "sval-cp-row" }, name, value, slider);
    this._drag(slider, (event, done) => {
      const r = slider.getBoundingClientRect();
      const px = event.clientX - r.left;
      set(clamp((px - THUMB_INSET) / (r.width - 2 * THUMB_INSET)), done);
    });
    slider.addEventListener("keydown", event => {
      const by = {
        ArrowLeft: -1,
        ArrowDown: -1,
        ArrowRight: 1,
        ArrowUp: 1,
      }[event.key];
      let to;
      if (event.key === "Home") {
        to = 0;
      } else if (event.key === "End") {
        to = 1;
      } else if (by) {
        to = clamp(get() + by * step() * (event.shiftKey ? 5 : 1));
      } else {
        return;
      }
      event.preventDefault();
      set(to, true);
    });
    return { row, slider, track, thumb, value };
  }

  /**
   * Follows a press and drag on `el`, calling `fn` with the press, then with
   * the latest pointer event once a frame while the pointer moves, and on
   * release once more with `done`. A mouse can report moves far faster than
   * the window draws, and each call redraws the window in a new colour.
   *
   * @param {Element} el
   * @param {Function} fn
   */
  _drag(el, fn) {
    const win = this._doc.defaultView;
    let pending = null;
    let frame = 0;
    const flushMove = () => {
      frame = 0;
      const event = pending;
      pending = null;
      if (event && el.hasAttribute("data-dragging")) {
        fn(event, false);
      }
    };
    el.addEventListener("pointerdown", event => {
      if (event.button !== 0) {
        return;
      }
      el.setPointerCapture(event.pointerId);
      el.toggleAttribute("data-dragging", true);
      el.focus({ focusVisible: false });
      pickerTiming.start(el.getAttribute("aria-label"), win);
      pickerTiming.event();
      fn(event, false);
    });
    el.addEventListener("pointermove", event => {
      if (!el.hasPointerCapture(event.pointerId)) {
        return;
      }
      pickerTiming.event();
      pending = event;
      frame ||= win.requestAnimationFrame(flushMove);
    });
    const end = event => {
      if (el.hasAttribute("data-dragging")) {
        if (frame) {
          win.cancelAnimationFrame(frame);
          frame = 0;
        }
        pending = null;
        el.removeAttribute("data-dragging");
        fn(event, true);
        pickerTiming.end();
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("lostpointercapture", end);
  }

  // ------------------------------------------------------------ state

  /** @returns {{scheme: string, more: boolean, on: object}} */
  _ctx() {
    return this._context();
  }

  /**
   * What a swatch picks in the present appearance.
   *
   * @param {string} slot
   * @returns {string|object|null}
   */
  _slotColor(slot) {
    if (!slot) {
      return null;
    }
    if (slot === "custom") {
      return this._custom;
    }
    if (this._kind === "group") {
      return slot;
    }
    const { scheme, more } = this._ctx();
    const [side, name] = slot.split(":");
    return SvalColor.presetVersion(name, side, scheme, more);
  }

  /**
   * The swatch that shows as chosen: the one last chosen while the colour is
   * still what it picks, or else the first that picks the colour.
   *
   * @returns {string}
   */
  _chosenSlot() {
    if (!this.color) {
      return "";
    }
    if (
      this._slot !== null &&
      SvalColor.sameColor(this._slotColor(this._slot), this.color)
    ) {
      return this._slot;
    }
    for (const swatch of this._swatches.children) {
      const slot = swatch.dataset.slot;
      if (
        slot &&
        slot !== "custom" &&
        SvalColor.sameColor(this._slotColor(slot), this.color)
      ) {
        return slot;
      }
    }
    return "custom";
  }

  /**
   * The custom colour as editing it starts in this appearance: a Workspace
   * colour picked in the other appearance, or none yet, is taken as it
   * looks now.
   *
   * @returns {object}
   */
  _editable() {
    const { scheme, more } = this._ctx();
    if (this._kind === "group") {
      return this._custom ?? { h: 262, c: 0.1 };
    }
    if (this._custom?.mode === scheme) {
      return this._custom;
    }
    this._custom = SvalColor.customFrom(this._custom ?? "blue", scheme, more);
    return this._custom;
  }

  /**
   * The Workspace custom colour's shade: the one Shade last set, while the
   * colour is the one it set it for, or else the custom colour's own.
   *
   * @returns {{band: string, frac: number}}
   */
  _shadeOf() {
    const edit = this._editable();
    if (this._shade?.of === edit) {
      return this._shade;
    }
    const { more } = this._ctx();
    const b = SvalColor.bands(edit.h, edit.c, more);
    let band = SvalColor.isDarkSurface(
      SvalColor.oklch(edit.l, edit.c, edit.h),
      more
    )
      ? "deep"
      : "pale";
    if (!b[band].length) {
      band = band === "deep" ? "pale" : "deep";
    }
    const Ls = b[band];
    const i = SvalColor.nearestIndex(Ls, edit.l);
    this._shade = {
      band,
      frac: Ls.length > 1 ? 1 - i / (Ls.length - 1) : 0,
      of: edit,
    };
    return this._shade;
  }

  /**
   * Where the custom colour's shade sits among its hue's shades.
   *
   * @returns {{index: number, count: number, shades: object[]}}
   */
  _shadeAt() {
    const { more } = this._ctx();
    const edit = this._editable();
    const shades = shadesOf(edit.h, edit.c, more);
    const { band, frac } = this._shadeOf();
    let index = shades.findIndex(
      s => s.band === band && Math.abs(s.frac - frac) < 1e-9
    );
    if (index < 0) {
      index = SvalColor.nearestIndex(
        shades.map(s => s.l),
        edit.l
      );
    }
    return { index, count: shades.length, shades };
  }

  /**
   * Takes a new custom colour and tells the host.
   *
   * @param {object} custom
   * @param {boolean} done
   * @param {{band: string, frac: number}} [shade] The shade it was made at.
   */
  _setCustom(custom, done, shade) {
    this._custom =
      this._kind === "group"
        ? { h: custom.h, c: custom.c }
        : { h: custom.h, c: custom.c, l: custom.l, mode: custom.mode };
    if (shade) {
      this._shade = { band: shade.band, frac: shade.frac, of: this._custom };
    }
    this.color = this._custom;
    this._slot = "custom";
    this._changed(done);
  }

  _changed(done) {
    pickerTiming.time("picker", () => this.refresh());
    this._onChange({
      color: this.color,
      transparency: this._storedTransparency(),
      done,
    });
  }

  /**
   * @returns {number} the colour's most transparency. No colour is Sval's
   *   own, which can be see-through like any other.
   */
  _max() {
    if (this._kind !== "workspace") {
      return 0;
    }
    return SvalColor.maxTransparency();
  }

  /**
   * The transparency a save stores: what the person set, never past what
   * the colour allows in this appearance. Where the window cannot show
   * through, the row is hidden and the stored value is kept as it was.
   *
   * @returns {number}
   */
  _storedTransparency() {
    if (this._kind !== "workspace") {
      return 0;
    }
    if (!this._ctx().seeThrough) {
      return this._heldTransparency;
    }
    return SvalColor.round(Math.min(this.transparency, this._max()), 2);
  }

  /** @returns {number} what a save stores ({@link _storedTransparency}). */
  get chosenTransparency() {
    return this._storedTransparency();
  }

  // ------------------------------------------------------------ input

  _chooseSwatch(swatch) {
    const slot = swatch.dataset.slot;
    // Custom starts from the colour on show, so the person tweaks what
    // they see. A Workspace with no colour shows Sval's own; a group with
    // none starts from the custom colour kept, or Blue.
    const workspace = this._kind === "workspace";
    if (
      slot === "custom" &&
      (!this._custom ||
        ((workspace || this.color) && this._chosenSlot() !== "custom"))
    ) {
      const { scheme, more } = this._ctx();
      this._custom = workspace
        ? SvalColor.customFrom(this.color, scheme, more)
        : this._groupCustomFrom(this.color ?? "blue");
    }
    const color = this._slotColor(slot);
    if (color && typeof color === "object" && slot !== "custom") {
      // A preset's version for the other appearance is a custom colour,
      // which "+" then edits.
      this._custom = { ...color };
    }
    this._slot = slot;
    const changed = !SvalColor.sameColor(color, this.color);
    this.color = color;
    if (changed) {
      this._changed(true);
    } else {
      this.refresh();
    }
  }

  /**
   * A group's custom colour that starts from `color`.
   *
   * @param {string|object} color
   * @returns {{h: number, c: number}}
   */
  _groupCustomFrom(color) {
    if (typeof color === "object") {
      return { h: color.h, c: color.c };
    }
    const m = SvalColor.groupMembers(color);
    return { h: m.h, c: Math.min(m.bc, SvalColor.CHROMA_MAX) };
  }

  _onSwatchKey(event) {
    const swatches = [...this._swatches.children];
    const at = swatches.indexOf(event.target);
    if (at < 0) {
      return;
    }
    const placeOf = swatch => ({
      row: Number(swatch.dataset.row),
      col: Number(swatch.dataset.col),
    });
    let next;
    switch (event.key) {
      case "ArrowRight":
        next = swatches[(at + 1) % swatches.length];
        break;
      case "ArrowLeft":
        next = swatches[(at - 1 + swatches.length) % swatches.length];
        break;
      case "ArrowDown":
      case "ArrowUp": {
        // To the nearest swatch in the other row, where there is one.
        const { row, col } = placeOf(event.target);
        const others = swatches.filter(s => placeOf(s).row !== row);
        if (!others.length) {
          next =
            swatches[
              (at + (event.key === "ArrowDown" ? 1 : -1) + swatches.length) %
                swatches.length
            ];
          break;
        }
        next = others.reduce((a, b) =>
          Math.abs(placeOf(b).col - col) < Math.abs(placeOf(a).col - col)
            ? b
            : a
        );
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    this._chooseSwatch(next);
    next.focus();
  }

  /**
   * Picks the hue and intensity under the pointer on the wheel.
   *
   * @param {PointerEvent} event
   * @param {boolean} done
   */
  _wheelAt(event, done) {
    const r = this._wheel.getBoundingClientRect();
    const R = r.width / 2;
    const dx = event.clientX - r.left - R;
    const dy = R - (event.clientY - r.top);
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const c = clamp(Math.hypot(dx, dy) / R) * SvalColor.CHROMA_MAX;
    this._setHueChroma(h, c, done);
  }

  /**
   * A new hue and chroma for the custom colour, at the shade it has.
   *
   * @param {number} h
   * @param {number} c
   * @param {boolean} done
   */
  _setHueChroma(h, c, done) {
    const { round } = SvalColor;
    h = round(h, 1) % 360;
    c = round(clamp(c, 0, SvalColor.CHROMA_MAX), 3);
    if (this._kind === "group") {
      this._setCustom({ h, c }, done);
      return;
    }
    const { scheme, more } = this._ctx();
    const shade = this._shadeOf();
    const l = lightnessOf(h, c, shade, more);
    if (l === undefined) {
      return;
    }
    this._setCustom({ h, c, l, mode: scheme }, done, shade);
  }

  _onWheelKey(event) {
    const edit = this._editable();
    const by = event.shiftKey ? 3 : 1;
    const moves = {
      ArrowLeft: [5 * by, 0],
      ArrowRight: [-5 * by, 0],
      ArrowUp: [0, 0.01 * by],
      ArrowDown: [0, -0.01 * by],
    }[event.key];
    if (!moves) {
      return;
    }
    event.preventDefault();
    this._setHueChroma(
      (edit.h + moves[0] + 360) % 360,
      edit.c + moves[1],
      true
    );
  }

  _setShade(x, done) {
    const { shades } = this._shadeAt();
    const edit = this._editable();
    const { band, frac, l } =
      shades[Math.round(clamp(x) * (shades.length - 1))];
    this._setCustom(
      { h: edit.h, c: edit.c, l, mode: this._ctx().scheme },
      done,
      { band, frac }
    );
  }

  _setTransparency(x, done) {
    this.transparency = SvalColor.round(x * this._max(), 2);
    this._changed(done);
  }

  // ------------------------------------------------------------ drawing

  /**
   * Draws the picker for the chosen colour in the context's appearance;
   * call again when the appearance changes.
   */
  refresh() {
    const ctx = this._ctx();
    const { scheme, more } = ctx;
    const chosen = this._chosenSlot();
    const fillOf = color =>
      SvalColor.swatchOf(color, this._kind, { scheme, more, on: ctx.on });
    for (const swatch of this._swatches.children) {
      const slot = swatch.dataset.slot;
      const checked = slot === chosen;
      swatch.setAttribute("aria-checked", String(checked));
      swatch.setAttribute("tabindex", checked ? "0" : "-1");
      if (slot === "custom") {
        this._drawCustomSwatch(swatch);
      } else if (slot) {
        const color = this._slotColor(slot);
        // The preset itself is its own token, and a version that stays as
        // shown is its swatch's.
        swatch.dataset.token = typeof color === "string" ? color : slot;
        swatch.setAttribute("data-color", swatch.dataset.token);
        swatch.style.setProperty("--sval-nw-fill", fillOf(color));
      }
    }
    if (!this.color) {
      this._name.textContent = "None";
    } else if (chosen === "custom") {
      this._name.textContent = "Custom";
    } else {
      this._name.textContent = this._swatches
        .querySelector(`[data-slot="${chosen}"]`)
        .getAttribute("aria-label");
    }
    const custom = chosen === "custom";
    this._customBlock.hidden = !custom;
    if (custom) {
      this._drawWheel();
    }
    if (this._transparencyRow) {
      const home = custom ? this._side : this._root;
      if (this._transparencyRow.row.parentNode !== home) {
        home.append(this._transparencyRow.row);
      }
      this._drawTransparency();
    }
  }

  /** @param {Element} swatch The "+" swatch. */
  _drawCustomSwatch(swatch) {
    const { more } = this._ctx();
    swatch.textContent = "";
    const glyph = this._doc.createElementNS(HTML_NS, "span");
    glyph.className = "sval-cp-glyph";
    if (this._custom) {
      const fill = this._swatchRgb(this._custom);
      swatch.setAttribute("data-color", "custom");
      swatch.style.setProperty("--sval-nw-fill", SvalColor.css(fill));
      swatch.style.setProperty(
        "--sval-cp-glyph",
        SvalColor.isDarkSurface(fill, more) ? "#ffffff" : "#060a2e"
      );
      swatch.setAttribute("aria-label", "Edit custom color");
      swatch.setAttribute("title", "Edit custom color");
      glyph.dataset.glyph = "pencil";
    } else {
      swatch.removeAttribute("data-color");
      swatch.style.removeProperty("--sval-nw-fill");
      swatch.setAttribute("aria-label", "Custom color");
      swatch.setAttribute("title", "Custom color");
      glyph.dataset.glyph = "plus";
    }
    swatch.append(glyph);
  }

  /**
   * The custom colour's swatch: a Workspace's window, or a group's block.
   *
   * @param {object} color
   * @returns {number[]}
   */
  _swatchRgb(color) {
    const { scheme, more, on } = this._ctx();
    return this._kind === "workspace"
      ? SvalColor.windowTint(color, scheme, more)
      : SvalColor.groupBlock(
          color,
          on ?? SvalColor.untintedSurface(scheme),
          1,
          { more }
        );
  }

  _drawWheel() {
    const { scheme, more, on } = this._ctx();
    const edit = this._editable();
    const workspace = this._kind === "workspace";
    const shade = workspace ? this._shadeOf() : null;
    const key = workspace
      ? [shade.band, shade.frac, more].join("|")
      : [scheme, more, JSON.stringify(on)].join("|");
    if (key !== this._wheelKey) {
      this._wheelKey = key;
      pickerTiming.time("wheel paint", () => this._paintWheel(shade));
    }
    const fill = this._swatchRgb(edit);
    const a = (edit.h * Math.PI) / 180;
    const r = (edit.c / SvalColor.CHROMA_MAX) * 50;
    this._knob.style.left = `${50 + r * Math.cos(a)}%`;
    this._knob.style.top = `${50 - r * Math.sin(a)}%`;
    this._knob.style.background = SvalColor.css(fill);
    const intensity = Math.round((edit.c / SvalColor.CHROMA_MAX) * 100);
    this._wheel.setAttribute("aria-valuenow", String(intensity));
    this._wheel.setAttribute(
      "aria-valuetext",
      `hue ${Math.round(edit.h)}°, intensity ${intensity}%`
    );
    if (!workspace) {
      return;
    }
    const { index, shades } = this._shadeAt();
    const [L] = SvalColor.toOklch(fill);
    const deep = SvalColor.isDarkSurface(fill, more);
    const value = `${deep ? "Dark" : "Light"} ${Math.round(L * 100)}%`;
    // Stops spaced along the track so each sits under the thumb's centre
    // at its own shade.
    const n = Math.min(24, shades.length);
    const stops = Array.from({ length: n }, (_, i) => {
      const at = n > 1 ? i / (n - 1) : 0;
      const s = shades[Math.round(at * (shades.length - 1))];
      return `${SvalColor.css(SvalColor.oklch(s.l, edit.c, edit.h))} calc(${THUMB_INSET}px + (100% - ${2 * THUMB_INSET}px) * ${at.toFixed(4)})`;
    });
    this._paintSlider(
      this._shadeRow,
      index / Math.max(1, shades.length - 1),
      `linear-gradient(90deg, ${stops.join(", ")})`,
      value
    );
    this._shadeRow.slider.dataset.side = deep ? "deep" : "pale";
  }

  /**
   * Paints the wheel: each hue and chroma as the colour it would give, a
   * Workspace's at `shade`, or a group's block on its window. The colours
   * are worked out on a fine grid and blended between its points for each
   * pixel, so a Shade drag repaints the wheel within a frame.
   *
   * @param {{band: string, frac: number}|null} shade
   */
  _paintWheel(shade) {
    const { scheme, more, on } = this._ctx();
    const CMAX = SvalColor.CHROMA_MAX;
    // Each coarse grid point's colour: for a Workspace its lightness, for a
    // group its block.
    const grid = [];
    for (let i = 0; i <= GRID_H; i++) {
      const row = [];
      for (let j = 0; j <= GRID_C; j++) {
        const h = SvalColor.round((i * 360) / GRID_H, 1) % 360;
        const c = SvalColor.round((j * CMAX) / GRID_C, 3);
        row.push(
          shade
            ? [lightnessOf(h, c, shade, more) ?? 0]
            : SvalColor.groupBlock(
                { h, c },
                on ?? SvalColor.untintedSurface(scheme),
                1,
                { more }
              )
        );
      }
      grid.push(row);
    }
    const coarse = (fi, fj, k) => {
      const i0 = Math.min(GRID_H - 1, Math.floor(fi));
      const j0 = Math.min(GRID_C - 1, Math.floor(fj));
      const ti = fi - i0;
      const tj = fj - j0;
      return (
        (grid[i0][j0][k] * (1 - tj) + grid[i0][j0 + 1][k] * tj) * (1 - ti) +
        (grid[i0 + 1][j0][k] * (1 - tj) + grid[i0 + 1][j0 + 1][k] * tj) * ti
      );
    };
    // The fine grid's colours, gamma sRGB 0..255.
    const fine = new Float32Array((FINE_H + 1) * (FINE_C + 1) * 3);
    for (let a = 0; a <= FINE_H; a++) {
      const h = (a * 360) / FINE_H;
      const fi = (a * GRID_H) / FINE_H;
      for (let b = 0; b <= FINE_C; b++) {
        const r = b / FINE_C;
        const fj = r * GRID_C;
        const rgb = shade
          ? SvalColor.oklch(coarse(fi, fj, 0), r * CMAX, h % 360)
          : [coarse(fi, fj, 0), coarse(fi, fj, 1), coarse(fi, fj, 2)];
        const q = (a * (FINE_C + 1) + b) * 3;
        fine[q] = rgb[0] * 255;
        fine[q + 1] = rgb[1] * 255;
        fine[q + 2] = rgb[2] * 255;
      }
    }
    const g = this._canvas.getContext("2d");
    const img = g.createImageData(WHEEL, WHEEL);
    const { at, weights, count } = wheelPixels();
    const W = FINE_C + 1;
    for (let n = 0; n < count; n++) {
      const a = at[2 * n + 1];
      const ti = weights[2 * n];
      const tj = weights[2 * n + 1];
      const q00 = a * 3;
      const q01 = q00 + 3;
      const q10 = q00 + W * 3;
      const q11 = q10 + 3;
      const p = at[2 * n];
      for (let k = 0; k < 3; k++) {
        img.data[p + k] =
          (fine[q00 + k] * (1 - tj) + fine[q01 + k] * tj) * (1 - ti) +
          (fine[q10 + k] * (1 - tj) + fine[q11 + k] * tj) * ti;
      }
      img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  _drawTransparency() {
    const row = this._transparencyRow;
    // Only a window that can show what is behind it offers transparency.
    row.row.hidden = !this._ctx().seeThrough;
    if (row.row.hidden) {
      return;
    }
    const { scheme, more } = this._ctx();
    const max = this._max();
    const t = this._storedTransparency();
    const tint = SvalColor.css(SvalColor.windowTint(this.color, scheme, more));
    const clear = SvalColor.css(
      SvalColor.windowTint(this.color, scheme, more),
      1 - max
    );
    this._paintSlider(
      row,
      t / max,
      `linear-gradient(90deg, ${tint}, ${clear}), var(--sval-cp-checker)`,
      `${Math.round(t * 100)}%`
    );
  }

  /**
   * @param {object} slider From {@link _slider}.
   * @param {number} at The thumb's place, 0..1.
   * @param {string} track The track's background.
   * @param {string} value What the value reads.
   */
  _paintSlider(slider, at, track, value) {
    slider.track.style.background = track;
    slider.thumb.style.left = `calc(${THUMB_INSET}px + (100% - ${2 * THUMB_INSET}px) * ${clamp(at).toFixed(4)})`;
    slider.value.textContent = value;
    slider.slider.setAttribute("aria-valuenow", String(Math.round(at * 100)));
    slider.slider.setAttribute(
      "aria-valuetext",
      value || `${Math.round(at * 100)}%`
    );
  }
}
