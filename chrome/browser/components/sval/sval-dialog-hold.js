/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Holds an agent alert's grant buttons disabled until the alert has been
 * shown and focused for `security.dialog_enable_delay`, as Firefox's own
 * prompts are (`EnableDelayHelper`, PromptUtils.sys.mjs). An alert can open
 * under a click the user meant for the page, and that click must not land
 * on a grant.
 *
 * While the timer runs, each held button carries `data-hold` and
 * `sval-dialog.css` sweeps its fill across it over the delay, so the wait
 * shows without words. The timer restarts when the alert's window comes back
 * from behind another, and on a repeated key, and the sweep restarts with
 * it. A held button outside the timer, while the alert's window is behind
 * another, shows the plain disabled look.
 */

"use strict";

{
  const { EnableDelayHelper } = ChromeUtils.importESModule(
    "resource://gre/modules/PromptUtils.sys.mjs"
  );

  /**
   * Holds `buttons` through the dialog delay.
   *
   * @param {HTMLButtonElement[]} buttons The grants.
   * @param {(held: boolean) => void} [onChange] Called after the buttons
   *   are disabled or enabled.
   * @returns {object} The `EnableDelayHelper`, which the page keeps for as
   *   long as it shows.
   */
  window.svalHoldGrants = (buttons, onChange) => {
    const sweep = delay => {
      for (const button of buttons) {
        button.style.setProperty("--sval-dialog-hold-time", `${delay}ms`);
        // A CSS animation starts over only when it is removed and applied
        // again, with a style flush between.
        button.removeAttribute("data-hold");
        button.getBoundingClientRect();
        button.toggleAttribute("data-hold", true);
      }
    };
    const set = held => {
      for (const button of buttons) {
        button.disabled = held;
        button.removeAttribute("data-hold");
      }
      onChange?.(held);
    };
    const top = window.browsingContext.top.window;
    /**
     * `EnableDelayHelper`, with the sweep started on each new timer and the
     * hold kept through a blur inside the alert's own window.
     */
    class Hold extends EnableDelayHelper {
      // A click elsewhere in the alert's own window moves focus without
      // lowering the window, and the alert stays in front, so the hold
      // carries on. `nsFocusManager::WindowLowered` clears the active window
      // before it blurs, so a window lowered behind another holds again.
      onBlur() {
        if (Services.focus.activeWindow !== top) {
          super.onBlur();
        }
      }

      onFocus() {
        if (buttons.some(button => button.disabled)) {
          super.onFocus();
        }
      }

      // `startOnFocusDelay` returns early while a timer runs, so a sweep
      // starts only where the call made a new timer.
      startOnFocusDelay() {
        const running = this._focusTimer;
        super.startOnFocusDelay();
        if (this._focusTimer && this._focusTimer !== running) {
          sweep(this.delayTime);
        }
      }
    }
    return new Hold({
      disableDialog: () => set(true),
      enableDialog: () => set(false),
      focusTarget: window,
    });
  };
}
