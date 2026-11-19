/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What the open gates answer Gecko with. Gecko asks Sval about every content
 * tab: whose a file picker, a clipboard write, a launch of another
 * application, a download, a PDF.js save or a new tab is
 * (`SvalAgentGate`, `SvalAgentDownloads`, `SvalAgentRouting`). Each open
 * gate answers for its own agents' tabs, with one object it adds here as it
 * opens.
 *
 * Production has one gate, for the listen. Tests open several at once, so
 * each question goes to every open gate.
 */

/**
 * One gate's answers. Each function answers null, or false, for a tab none
 * of the gate's agents works in.
 *
 * @typedef {object} GateAnswers
 * @property {(top: BrowsingContext) => boolean} holdsTab Whether an agent
 *   of the gate's controls the tab and the user has not taken it.
 * @property {(uri: nsIURI, principal: nsIPrincipal|null, bc: BrowsingContext, appName: string|null) => Promise<boolean>|null} decideApp
 *   Whether a page may hand an address to another application.
 * @property {(bc: BrowsingContext, startSite?: string|null) => object|null} downloadHandler
 *   The download handler of the agent working in the tab, deciding for
 *   `startSite` when it is given:
 *   `{site, decide(): "allow"|"deny"|"ask", ask(): Promise<string>, track(entry)}`.
 * @property {(id: number) => object|null} startOf The latest load the gate
 *   recorded in a browsing context (`createLoadStarts`).
 * @property {(browser: Element) => Function|null} pdfSaver The save handler
 *   of the agent working in the tab whose PDF.js viewer asks to save.
 * @property {(opener: Element) => {window: Window|null, open: () => Promise<Window>}|null} routeTab
 *   For the `<browser>` of a page that asks for a new tab, the agent's full
 *   window, null while it has none, and how to open one.
 */

/** @type {GateAnswers} */
export const NO_ANSWERS = Object.freeze({
  holdsTab: () => false,
  decideApp: () => null,
  downloadHandler: () => null,
  startOf: () => null,
  pdfSaver: () => null,
  routeTab: () => null,
});

/** @type {Set<GateAnswers>} */
const gates = new Set();

/**
 * @param {GateAnswers} answers
 * @returns {() => void} Takes the gate out, as it closes.
 */
export function addGate(answers) {
  gates.add(answers);
  return () => gates.delete(answers);
}

/** @returns {Iterable<GateAnswers>} The open gates' answers, oldest first. */
export function openGates() {
  return gates;
}
