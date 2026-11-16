/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The buttons a permission prompt shows for its further actions, where the
 * prompt asks for them (`options.actionButtons`, read by
 * `PopupNotifications._refreshPanel`). Firefox lists every action past the
 * secondary one in a menu behind the secondary button's chevron; a prompt
 * whose answers are all equal choices, as the camera prompt's Allow, Always
 * allow and Block are, shows each as a button of its own.
 */

const BUTTON_CLASS = "sval-prompt-action-button";

export const SvalPromptButtons = {
  /**
   * Replaces the action buttons of a prompt's element with one for each
   * action, between its secondary and primary buttons. The element is
   * reused from prompt to prompt, so a prompt with no actions clears them.
   *
   * @param {Element} popupnotification
   * @param {object[]} actions `PopupNotifications` secondary actions.
   * @param {Function} onCommand Called with the click event and the action.
   */
  draw(popupnotification, actions, onCommand) {
    for (const old of popupnotification.querySelectorAll(`.${BUTTON_CLASS}`)) {
      old.remove();
    }
    const doc = popupnotification.ownerDocument;
    for (const action of actions) {
      const button = doc.createElement("moz-button");
      button.className = BUTTON_CLASS;
      button.setAttribute("label", action.label);
      if (action.accessKey) {
        button.setAttribute("accesskey", action.accessKey);
      }
      button.addEventListener("click", event => onCommand(event, action), {
        capture: true,
      });
      popupnotification.button.before(button);
    }
  },
};
