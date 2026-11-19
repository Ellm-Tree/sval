/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tools that open, load and close an agent's tabs (agent-control spec
 * §4). Each is a row of `SvalAgentToolTable`.
 *
 * None of them needs the tab's page to be one the agent may read: a tab
 * left on a blocked site can still be moved on or closed. `open_tab` and
 * `navigate_tab` answer `human_verification_required` when the page they
 * land on asks for a person.
 */

import { json } from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import { agentSiteOf } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { checkedTarget } from "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs";
import { refuseIfWorkspaceHeld } from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import { MOVED } from "moz-src:///browser/components/sval/SvalAgentToolCall.sys.mjs";
import {
  input,
  MOVES,
  TAB,
} from "moz-src:///browser/components/sval/SvalAgentToolSchema.sys.mjs";

const MAX_URL = 2048;

/**
 * @param {{url?: string|null}} shown What the call said of the page.
 * @param {number} [status] The page's HTTP status, when it is known.
 * @returns {{status?: number}} The status, none when it is not known or the
 *   page is not one the agent may read.
 */
function responseTo(shown, status) {
  if (status === undefined || !shown.url) {
    return {};
  }
  return { status };
}

/**
 * @param {string} [url]
 * @returns {string} Its host and port, or "" when it has none.
 */
function hostPortOf(url) {
  try {
    return url ? Services.io.newURI(url).hostPort : "";
  } catch {
    return "";
  }
}

export const openTab = {
  name: "open_tab",
  title: "Open a tab",
  description:
    "Open an http or https URL in a new tab in your workspace and wait for it to load. Returns the tab id, which the other tools take, and the page's HTTP status.",
  inputSchema: input(
    {
      url: {
        type: "string",
        maxLength: MAX_URL,
        description: "An http or https URL.",
      },
    },
    ["url"]
  ),
  annotations: MOVES,
  page: null,
  actsOn: args => agentSiteOf(args.url),
  activity: "Opening a tab",
  async run(call, { url }) {
    // Refused before a window opens for it, or the user is asked about
    // its site.
    refuseIfWorkspaceHeld(call.agent.workspaceId);
    const blocked = await call.allowLoad(url);
    const { tab, status } = await call.tabs.openTab(call.agent, url, {
      blocked,
    });
    // Named as any other page is: the site can be blocked while it loads.
    // The tab has opened whatever happens next, so a page that cannot be
    // read now, such as one that moved itself somewhere agents may not
    // open, is reported with a null address and title, as `list_tabs`
    // reports it, rather than as a failure.
    let shown = { url: null, title: null };
    let browser;
    try {
      browser = (await call.find(tab)).browser;
      shown = { ...shown, ...call.shown() };
    } catch {}
    if (browser && call.mayReadPage()) {
      await call.refuseIfChallenge();
    }
    return json({ tab, ...shown, ...responseTo(shown, status) });
  },
};

export const closeTab = {
  name: "close_tab",
  title: "Close a tab",
  description: "Close one of your tabs.",
  inputSchema: input({ tab: TAB }, ["tab"]),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  page: null,
  async run(call, { tab }) {
    // Not through `call.find`: a tab showing a page agents may not open is
    // still the agent's to close, and closing a tab session restore left
    // unloaded must not load it first. `closeTab` refuses a tab outside
    // the workspace itself.
    await call.tabs.closeTab(call.agent.workspaceId, tab);
    return json({ closed: tab });
  },
};

export const navigateTab = {
  name: "navigate_tab",
  title: "Navigate a tab",
  description:
    'Load an http or https URL in one of your tabs, or go "back", "forward" or "reload", and wait for the page to load. Returns its HTTP status.',
  inputSchema: input(
    {
      tab: TAB,
      to: {
        type: "string",
        maxLength: MAX_URL,
        description: 'An http or https URL, or "back", "forward" or "reload".',
      },
    },
    ["tab", "to"]
  ),
  annotations: MOVES,
  page: MOVED,
  actsOn(args, found) {
    if (found.tab.linkedPanel) {
      const checked = checkedTarget(found.tab.linkedBrowser, args.to);
      return checked ? agentSiteOf(checked.url) : null;
    }
    // An unloaded tab has no history to step through or page to reload.
    return ["back", "forward", "reload"].includes(args.to)
      ? null
      : agentSiteOf(args.to);
  },
  activity: "Going to a page",
  namesWhereItGoes: true,
  async run(call, { tab, to }) {
    const { browser } = call;
    // The load is checked, then made only if it is still what was checked:
    // the page can move on while the check waits for the user.
    const checked = checkedTarget(browser, to);
    call.report(hostPortOf(checked?.url));
    const blocked = checked ? await call.allowLoad(checked.url) : false;
    const { status } = await call.tabs.navigate(browser, to, {
      checked: checked ?? undefined,
      workIn: true,
      blocked,
    });
    if (!call.dialogs.openDialog(browser) && call.mayReadPage()) {
      await call.refuseIfChallenge();
    }
    const shown = call.shown();
    return call.reply({
      tab,
      ...shown,
      ...responseTo(shown, status),
    });
  },
};
