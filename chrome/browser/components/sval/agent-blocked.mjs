/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Says why about:agentblocked's load was refused, by the `e` docshell puts
 * in its address (`nsDocShell::DisplayLoadError`), and names the refused
 * address's host from `u`. The agent reads this page as the answer to its
 * load, so every reason it can give is written out here.
 */

const params = new URLSearchParams(document.documentURI.split("?")[1] ?? "");
const host = URL.parse(params.get("u") ?? "")?.host || "this page";

const REASONS = {
  blockedByUser: {
    title: "Blocked by the user",
    text: `The user has blocked this agent from opening ${host}. Sval did not load the page.`,
  },
  tabNotFiled: {
    title: "Not loaded",
    text: `Sval did not load ${host}, because it could not tell whose tab this is. Reload the page to try again.`,
  },
};

const key = Object.hasOwn(REASONS, params.get("e"))
  ? params.get("e")
  : "blockedByUser";
const reason = REASONS[key];
document.title = reason.title;
document.getElementById("sval-agent-blocked-title").textContent = reason.title;
document.getElementById("sval-agent-blocked-reason").textContent = reason.text;
document.body.dataset.reason = key;
