/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Whose a tab is, as the tree says: every part of Sval that asks whether a
 * tab is an agent's asks this module, and it keeps no record of its own.
 *
 * A tab is an agent's exactly when the workspace above its node, in the
 * latest tree its window's engine handed out (`SvalTreeSnapshot`), carries
 * the `agent` mark (agent-control spec §3.5). A tab with no node yet, or
 * under a workspace with no mark, is no agent's. The agent's tools reach it
 * (`SvalAgentTabs`), its loads, writes, downloads, pickers and dialogs are
 * the agent's gate's to decide (`SvalAgentGate`), and its pages get WebMCP
 * (`svalAgentTab`, which content processes read, and which only this module
 * writes, from the same answer, each time the tree changes; site-tools spec
 * §3.1). Whether agent access is on is the gate's own question: with no
 * gate open, no agent can act anywhere.
 *
 * A tab that could be an agent's waits for its node: a load that starts in
 * such a tab before the tree holds it is held until the window's tab
 * observer has filed the tab (`SvalAgentGate`, `fileBeforeLoad`). Any other
 * tab the tree does not hold is the user's, and never waits.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { onTabGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { isQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";
import {
  CONTROL_TOPIC,
  forgetControl,
  isUserInControl,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  handWorkspaceTo,
  isHandedToAgent,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { workspaceOfNode } from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import {
  latestNodes,
  onTree,
} from "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  PictureInPicture: "resource://gre/modules/PictureInPicture.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  fullWindowShowing: "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs",
  isPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
});

/**
 * How far up a chain of openers the write half looks for the agent's input
 * that a request comes from. The bound only stops a loop.
 */
export const MAX_OPENER_DEPTH = 32;

/**
 * @param {object} browser A `<browser>`.
 * @returns {object|null} Its tab.
 */
function tabOf(browser) {
  try {
    return browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} browser A `<browser>`.
 * @returns {{nodes: object, id: string}|null} The tree its window's engine
 *   last handed out, and the node `browser`'s tab stands for in it, or null
 *   when that tree does not hold one.
 */
function nodeOf(browser) {
  const tab = tabOf(browser);
  const win = tab?.documentGlobal;
  if (!win || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return null;
  }
  const nodes = latestNodes(win.SvalPanel?.engine);
  const id = nodes && lazy.SvalTabs.nodeIdOf(tab);
  return id && nodes[id] ? { nodes, id } : null;
}

/**
 * @param {object} browser A `<browser>`.
 * @returns {string|null} The workspace the tree files `browser`'s tab under,
 *   or null when it holds no node for the tab.
 */
export function homeOf(browser) {
  const found = nodeOf(browser);
  return found ? workspaceOfNode(found.nodes, found.id) : null;
}

/**
 * @param {object} browser A `<browser>`.
 * @returns {string|null} The agent's workspace `browser`'s tab is filed
 *   under, or null when the tab is no agent's.
 */
export function agentHomeOf(browser) {
  const found = nodeOf(browser);
  if (!found) {
    return quickPeekAgentHomeOf(browser);
  }
  const workspace = workspaceOfNode(found.nodes, found.id);
  return workspace && found.nodes[workspace].agent ? workspace : null;
}

/**
 * An open Quick Peek has no node until the user keeps it (`SvalQuickPeek`), and is
 * filed then in the workspace its window shows. In a window that shows an
 * agent's workspace it is the agent's from its first load, decided under
 * the agent's site policy as any of the agent's tabs is.
 *
 * @param {object} browser A `<browser>` the tree holds no node for.
 * @returns {string|null} The agent's workspace, when `browser` is a Quick Peek's
 *   in a window that shows one.
 */
function quickPeekAgentHomeOf(browser) {
  const tab = tabOf(browser);
  const win = tab?.documentGlobal;
  if (!isQuickPeek(tab) || !win?.SvalPanel || isPrivateOrInMemory(win)) {
    return null;
  }
  const id = lazy.SvalWindowWorkspace.of(win).id;
  return id && latestNodes(win.SvalPanel.engine)?.[id]?.agent ? id : null;
}

/**
 * @param {Window} win A browser window.
 * @returns {boolean} Whether its tabs are filed in a tree in memory (a
 *   private or WebDriver window), which holds no agent's workspace.
 */
function isPrivateOrInMemory(win) {
  return (
    !!win.SvalPanel?.inMemory || lazy.PrivateBrowsingUtils.isWindowPrivate(win)
  );
}

/**
 * The context that asked for `bc`'s content. Gecko keeps it as the
 * `crossGroupOpener` of every top-level context it opens for a page,
 * `noopener` popups and tabs included (`nsFrameLoader::Create`, from the
 * window's `nsIOpenWindowInfo.parent`), where `opener` is left unset.
 *
 * @param {BrowsingContext|null} bc A top-level context.
 * @returns {BrowsingContext|null} The top of the context that opened it.
 */
function openerOf(bc) {
  return (bc?.crossGroupOpener ?? bc?.opener)?.top ?? null;
}

/**
 * @param {number} id A `browserId`.
 * @returns {object|null} The `<browser>` its content is in now.
 */
function browserOf(id) {
  try {
    return (
      BrowsingContext.getCurrentTopByBrowserId(id)?.embedderElement ?? null
    );
  } catch {
    return null;
  }
}

/**
 * @param {number} id A `browserId`.
 * @returns {string|null} As {@link agentHomeOf}, for a tab's content.
 */
export function agentHomeOfId(id) {
  return id ? agentHomeOf(browserOf(id)) : null;
}

/**
 * @param {number} id A `browserId`.
 * @returns {boolean} Whether the tree files the tab with that content under
 *   a workspace of the user's: one with no `agent` mark. Nothing such a tab
 *   sends or opens is an agent's.
 */
export function isUsersTab(id) {
  const browser = id && browserOf(id);
  return !!browser && !!homeOf(browser) && !agentHomeOf(browser);
}

/**
 * What the user's window calls as it files a tab the user took out of an
 * agent's workspace (`SvalTabs`): the content keeps no take of its own.
 *
 * @param {number} browserId
 */
export function releaseAgentTab(browserId) {
  if (browserId) {
    forgetControl(browserId);
  }
}

/**
 * @param {Window} win A browser window.
 * @returns {"agent"|"user"|"unknown"} Whose workspace `win` shows: an
 *   agent's, as the tree marks it or as the window was handed one
 *   (`handWorkspaceTo`); the user's, once the window is seen showing a
 *   workspace without the mark, or on a tree in memory, which holds no
 *   agent's; and unknown before the window shows a workspace the tree holds,
 *   as before its panel has started. A Peek is the user's: it shows
 *   no workspace and runs no tab observer, so the tree never holds its tab,
 *   and only a link from another app opens one (`SvalPeek`).
 */
function windowOwner(win) {
  if (isPrivateOrInMemory(win) || lazy.isPeek(win)) {
    return "user";
  }
  if (isHandedToAgent(win)) {
    return "agent";
  }
  const panel = win.SvalPanel;
  const id = lazy.SvalWindowWorkspace.of(win).id;
  const node = id ? latestNodes(panel.engine)?.[id] : null;
  if (!node) {
    return "unknown";
  }
  return node.agent ? "agent" : "user";
}

/**
 * The tabs `browser`'s tab could have been opened from: the browser that
 * asked for it (`openerBrowser`, which Firefox keeps as the tab's
 * `openerTab`, and which `routeNewTab` and `routeLinkOpen` route by; a
 * `noopener` page or link still names it), and the context that opened it
 * (`openerOf`, which `agentFrom` and `onWindowBeforeShow` go by).
 *
 * @param {object} browser A `<browser>`.
 * @returns {object[]} Their `<browser>`s.
 */
function openersOf(browser) {
  let bc = null;
  try {
    bc = browser.browsingContext ?? null;
  } catch {}
  return [
    tabOf(browser)?.openerTab?.linkedBrowser,
    openerOf(bc)?.embedderElement,
  ].filter(Boolean);
}

/**
 * Whether `browser`'s tab is an agent's, or, while the tree holds no node for
 * it, could be one once it is filed: it is in a window an agent's workspace
 * is shown in, or one whose owner is not known yet, or one of its openers
 * could be an agent's. Only a tab in a window seen showing the user's
 * workspace, with no opener that could be an agent's, is not. Every opener
 * is followed, each once; a chain too long to follow to its end could be an
 * agent's.
 *
 * @param {object} browser A `<browser>`.
 * @returns {boolean}
 */
function mayBeAgents(browser) {
  const seen = new Set([browser]);
  const queue = [browser];
  while (queue.length) {
    if (seen.size > MAX_OPENER_DEPTH) {
      return true;
    }
    const current = queue.shift();
    if (nodeOf(current)) {
      if (agentHomeOf(current)) {
        return true;
      }
      continue;
    }
    const win = tabOf(current)?.documentGlobal;
    const owner = win ? windowOwner(win) : "unknown";
    if (owner !== "user") {
      return true;
    }
    for (const opener of openersOf(current)) {
      if (!seen.has(opener)) {
        seen.add(opener);
        queue.push(opener);
      }
    }
  }
  return false;
}

/**
 * @param {object} browser A `<browser>`.
 * @returns {boolean} Whether a load in `browser`'s tab has to wait for the
 *   tab to be filed: the tree holds no node for it yet, and it could be an
 *   agent's once it is (`mayBeAgents`). An agent's page's new tab can start
 *   its first load before `routeNewTab` (`SvalAgentRouting`) has moved it into
 *   the agent's window, so its openers count as well as its window. An open
 *   Quick Peek's owner is known without a node (`quickPeekAgentHomeOf`), and it is
 *   never filed while open, so it never waits. A window's preloaded new tab
 *   page (`gBrowser.preloadedBrowser`) is in no tab and opened by no page,
 *   so it is no one's until a tab takes its browser. An extension's own
 *   view, its toolbar popup or sidebar, is the extension's, and no agent
 *   works in one. Any other browser in no tab could be an agent's, and
 *   waits.
 */
export function awaitsFiling(browser) {
  if (
    isPreloadedNewTab(browser) ||
    browser?.hasAttribute?.("webextension-view-type")
  ) {
    return false;
  }
  return (
    !nodeOf(browser) && !isQuickPeek(tabOf(browser)) && mayBeAgents(browser)
  );
}

/**
 * @param {object} browser A `<browser>`.
 * @returns {boolean} Whether `browser` is its window's preloaded new tab
 *   page, in no tab yet, which no page opened.
 */
function isPreloadedNewTab(browser) {
  let bc = null;
  try {
    bc = browser.browsingContext ?? null;
  } catch {}
  return (
    !!browser &&
    browser.documentGlobal?.gBrowser?.preloadedBrowser === browser &&
    !tabOf(browser) &&
    !openerOf(bc)
  );
}

/**
 * Has the window's tab observer file the tab `bc`'s content is in, for a
 * load in it that waits on that. A window that has just opened files its
 * tabs once its panel has started. The content can move to another tab
 * meanwhile, as a page's new tab is moved into the agent's own window
 * (`SvalAgentRouting` `routeNewTab`); the tab it is in by then is the one
 * filed.
 *
 * A window whose panel has no tab observer, as one whose first sync pass
 * failed, files nothing, so the tree cannot answer for its tab, and the
 * load cannot go on.
 *
 * @param {CanonicalBrowsingContext} bc A top-level context.
 * @returns {Promise<"filed"|"failed">} Whether the tree holds a node for
 *   the tab once the filing has landed.
 */
export async function fileBeforeLoad(bc) {
  const id = bc.browserId;
  // Content moves between tabs only a few times while its first load
  // waits; the bound only stops a loop.
  for (let moves = 0; moves < 8; moves++) {
    const tab = tabOf(browserOf(id));
    const win = tab?.documentGlobal;
    const panel = win?.SvalPanel;
    if (!panel) {
      return "failed";
    }
    await panel.started;
    if (tabOf(browserOf(id)) !== tab) {
      continue;
    }
    const observer = panel.observer;
    if (!observer || tab.closing) {
      return "failed";
    }
    await observer.fileNow(tab);
    if (tabOf(browserOf(id)) === tab) {
      return nodeOf(tab.linkedBrowser) ? "filed" : "failed";
    }
  }
  return "failed";
}

/**
 * The `browserId`s whose `svalAgentTab` this module set, so it unsets only a
 * mark of its own, each with the agent's workspace it was set for.
 *
 * @type {Map<number, string>}
 */
const marked = new Map();

/**
 * Sets `browser`'s top-level browsing context's `svalAgentTab` to whether its
 * tab is an agent's. The flag decides whether its pages get WebMCP's
 * `modelContext` (through `sval-agent-model-context.patch`), and Gecko
 * carries it across a replacement of the context.
 *
 * A tab that joins an agent's workspace, from the user's or another
 * agent's, brings history whose pages that agent's gate never checked. Its
 * back-forward cache is dropped, so a back or forward into one of them is a
 * load the gate checks (`SvalAgentGate`).
 *
 * @param {object} browser A `<browser>`.
 */
function mark(browser) {
  // A lazy tab's browser has no content to mark, and reading its context
  // would insert it (`Tabbrowser._createLazyBrowser`).
  if (!tabOf(browser)?.linkedPanel) {
    return;
  }
  let bc = null;
  try {
    bc = browser.browsingContext ?? null;
  } catch {}
  if (!bc?.browserId) {
    return;
  }
  const home = agentHomeOf(browser);
  markControl(browser, bc, !!home && !isUserInControl(bc.browserId));
  const was = marked.get(bc.browserId) ?? null;
  if (home === was) {
    return;
  }
  try {
    if (!home !== !was) {
      bc.svalAgentTab = !!home;
    }
    if (home) {
      marked.set(bc.browserId, home);
      bc.sessionHistory?.evictAllDocumentViewers();
    } else {
      marked.delete(bc.browserId);
    }
  } catch (err) {
    SvalLog.warn(`an agent tab's mark was not set: ${SvalLog.errorName(err)}`);
  }
}

/**
 * Sets `bc`'s `svalAgentInControl` to whether an agent controls its tab: the
 * tab is an agent's and the user has not taken it. None of the user's input
 * reaches a page there. The window's overlay stops what passes through the
 * window (`SvalAgentMarking`); the flag stops what reaches the page some
 * other way, through `agent-in-control.patch`: the tab takes no media keys
 * and no gamepad input, and its page opens no document Picture-in-Picture
 * window, and through `agent-pip-player-refused.patch` no video player. A
 * player or a document window open as the flag is set closes, Gecko closing
 * the document window itself, and a page in full screen leaves it.
 *
 * @param {object} browser A `<browser>`.
 * @param {BrowsingContext} bc Its top-level browsing context.
 * @param {boolean} inControl
 */
function markControl(browser, bc, inControl) {
  if (bc.svalAgentInControl === inControl) {
    return;
  }
  try {
    bc.svalAgentInControl = inControl;
  } catch (err) {
    SvalLog.warn(
      `an agent tab's control was not marked: ${SvalLog.errorName(err)}`
    );
    return;
  }
  if (inControl) {
    closePlayers(browser);
    exitFullscreen(browser);
  }
}

/**
 * Takes `browser`'s page out of full screen, as Escape would. The `<browser>`
 * in full screen is in its window's top layer (`DOMFullscreenParent`), above
 * the overlay that keeps the user's input out of the page. Under the overlay
 * the page never holds the window's focus, so it cannot ask for full screen
 * there (`Document::FullscreenElementReadyCheck`, `IsInFocusedTab`); only a
 * page that went full screen before the agent held the tab is in it.
 *
 * @param {object} browser A `<browser>`.
 */
function exitFullscreen(browser) {
  const doc = browser.ownerDocument;
  if (doc.fullscreenElement === browser) {
    doc.exitFullscreen();
  }
}

/**
 * Closes every Picture-in-Picture player playing a video of `browser`'s, as
 * the player's own close does (`PictureInPicture.closeSinglePipWindow`, with
 * the actor of the player's browser, which `player.js` sends its controls
 * through). The video goes on in its page.
 *
 * @param {object} browser A `<browser>`.
 */
function closePlayers(browser) {
  for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
    if (lazy.PictureInPicture.weakWinToBrowser.get(win) !== browser) {
      continue;
    }
    try {
      const actorRef = win.document
        .getElementById("browser")
        .browsingContext.currentWindowGlobal.getActor("PictureInPicture");
      lazy.PictureInPicture.closeSinglePipWindow({
        reason: "Unpip",
        actorRef,
      }).catch(err =>
        SvalLog.warn(
          `a Picture-in-Picture player did not close: ${SvalLog.errorName(err)}`
        )
      );
    } catch (err) {
      SvalLog.warn(
        `a Picture-in-Picture player did not close: ${SvalLog.errorName(err)}`
      );
    }
  }
}

/** Marks every tab of every window as the tree says. */
function markAll() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const tab of win.gBrowser?.tabs ?? []) {
      mark(tab.linkedBrowser);
    }
  }
}
onTree(markAll);
// The tabs that went in before this module was first asked about one.
Services.tm.dispatchToMainThread(markAll);
Services.obs.addObserver((subject, topic, data) => {
  // 0 is a workspace changing hands, which every tab follows.
  const id = Number(data);
  if (id) {
    mark(browserOf(id));
  } else {
    markAll();
  }
}, CONTROL_TOPIC);

const contexts = {
  observe(bc) {
    try {
      if (bc.parent || !bc.isContent || !bc.browserId) {
        return;
      }
      // New content in a tab the tree already holds, as a lazy or
      // discarded tab's browser goes in. Gecko attaches a browser's new
      // context before it gives the context its embedder
      // (`nsFrameLoader::MaybeCreateDocShell`, `ContentParent::CreateBrowser`),
      // so a context with no embedder yet is marked on the next turn.
      if (bc.embedderElement) {
        mark(bc.embedderElement);
      } else {
        Services.tm.dispatchToMainThread(() => {
          if (!bc.isDiscarded) {
            mark(bc.embedderElement);
          }
        });
      }
    } catch (err) {
      SvalLog.warn(
        `the tab marks missed a browsing context: ${SvalLog.errorName(err)}`
      );
    }
  },
};
Services.obs.addObserver(contexts, "browsing-context-attached");
onTabGone(browserId => marked.delete(browserId));

/**
 * @param {object} browser A `<browser>`.
 * @returns {number} Its `browserId`, or 0 for a lazy browser with no content
 *   yet.
 */
export function browserIdOf(browser) {
  try {
    return browser?.browsingContext?.browserId || browser?.browserId || 0;
  } catch {
    return 0;
  }
}

/**
 * The gate whose tools last handed a tab in each workspace, by workspace id,
 * as its resolver. Production has one gate; tests open more than one over
 * the same pairing, and then the gate whose agent acted there last answers.
 *
 * @type {Map<string, Function>}
 */
const claims = new Map();

/**
 * One gate's view of the tree's answer: which of its agents a tab is, and
 * where the windows and tabs its agents' pages open go.
 *
 * @param {object} options
 * @param {() => boolean} options.isClosed Whether the gate has closed, after
 *   which no tab is its agents'.
 * @param {(workspaceId: string) => object|null} options.agentFor The agent
 *   paired with an agent's workspace, from the gate's store.
 * @returns {object}
 */
export function createTabRegistry({ isClosed, agentFor }) {
  /**
   * The agent last handed a tab in each workspace, so that a tab is
   * answered for with the agent its tools act as.
   */
  const known = new Map();
  /** The browser windows whose tab events the gate listens to. */
  const hooked = new Map();

  /**
   * @param {string|null} workspaceId An agent's workspace.
   * @returns {object|null} This gate's agent working in it.
   */
  function agentIn(workspaceId) {
    if (isClosed() || !workspaceId) {
      return null;
    }
    const claimant = claims.get(workspaceId);
    if (claimant && claimant !== agentIn) {
      return null;
    }
    return known.get(workspaceId) ?? agentFor(workspaceId) ?? null;
  }

  /**
   * The agent whose tab `bc` is, as the tree says or as an open Quick Peek's
   * window does (`quickPeekAgentHomeOf`), or, for a tab the tree holds no node
   * for yet, the tab it was opened from, however many openers
   * back: such a tab opens where its opener's does, which is where it is
   * then filed.
   *
   * @param {BrowsingContext|null} bc
   * @returns {{agent: object, user: boolean}|null} This gate's agent, and
   *   whether the tab that answered is in the user's control.
   */
  function agentFrom(bc) {
    let ctx = bc?.top;
    for (let depth = 0; ctx && depth < MAX_OPENER_DEPTH; depth++) {
      const browser = ctx.embedderElement;
      if (browser && (nodeOf(browser) || quickPeekAgentHomeOf(browser))) {
        const agent = agentIn(agentHomeOf(browser));
        return agent ? { agent, user: isUserInControl(ctx.browserId) } : null;
      }
      ctx = openerOf(ctx);
    }
    return null;
  }

  /**
   * @param {BrowsingContext|null} bc
   * @returns {{agent: object, user: boolean}|null} As {@link agentFrom},
   *   for the tab `bc` was opened from.
   */
  function openerAgent(bc) {
    return agentFrom(openerOf(bc?.top));
  }

  /**
   * Notes the agent the tools act as in its workspace: `openTab` and
   * `tabIn` found the tab filed there.
   *
   * @param {object} _browser A `<browser>`.
   * @param {object} agent
   */
  function watch(_browser, agent) {
    if (isClosed() || !agent) {
      return;
    }
    known.set(agent.workspaceId, agent);
    claims.set(agent.workspaceId, agentIn);
  }

  /**
   * A tab just opened in a hooked window. One an agent's page opened that
   * lands in a window showing another workspace, by a way of opening
   * `routeNewTab` and `routeLinkOpen` do not cover, is closed: it is
   * never moved through a workspace of the user's. A tab the user moves
   * between windows (`adoptTab`) is filed where it lands instead, and one a
   * tab in the user's control opened is theirs wherever Firefox put it.
   *
   * @param {Event} event The tab's `TabOpen`.
   */
  function onTabOpen(event) {
    const tab = event.target;
    if (event.detail?.adoptedTab) {
      return;
    }
    const found = openerAgent(tab.linkedBrowser?.browsingContext);
    const win = tab.documentGlobal;
    const shown = win ? lazy.SvalWindowWorkspace.of(win).id : null;
    if (!found || found.user || !shown || shown === found.agent.workspaceId) {
      return;
    }
    SvalLog.warn(
      `agent ${found.agent.agentId}: a tab its page opened landed outside its workspace and is closed`
    );
    closeOpened(tab);
  }

  /**
   * Closes a tab an agent's page opened outside the agent's workspace. It
   * closes in a microtask, which runs once the script that opened the tab
   * has returned, since `addTab` goes on setting the tab up after its
   * `TabOpen`, and before the window's tab observer can file it: the
   * observer awaits before it writes a node, and writes none for a tab gone
   * by then (`SvalTabs` `#reconcile`). Nothing the page does keeps it open.
   *
   * @param {object} tab
   */
  function closeOpened(tab) {
    Promise.resolve().then(() => {
      try {
        if (!tab.closing) {
          tab.documentGlobal?.gBrowser?.removeTab(tab, {
            animate: false,
            skipPermitUnload: true,
          });
        }
      } catch (err) {
        SvalLog.warn(
          `a tab outside the agent's workspace stayed open: ${SvalLog.errorName(err)}`
        );
      }
    });
  }

  /**
   * @param {Window} win
   */
  function hookWindow(win) {
    const container = win?.gBrowser?.tabContainer;
    if (isClosed() || !container || hooked.has(win)) {
      return;
    }
    container.addEventListener("TabOpen", onTabOpen);
    win.addEventListener("unload", () => hooked.delete(win), { once: true });
    hooked.set(win, onTabOpen);
  }

  /**
   * A browser window is about to show. Its tab events are watched from now
   * on. If an agent's page opened it, it is handed the agent's workspace,
   * which its panel reads later, in delayed startup, so its tab is filed
   * there and never under a workspace of the user's; its first load waits
   * for that filing (`fileBeforeLoad`). That holds while the user has taken
   * control too: the window is still the agent's workspace's. A popup stays
   * a popup; a full window, which a page opens only while the agent has none
   * (`routeNewTab`), becomes the agent's own.
   *
   * @param {Window} win
   */
  function onWindowBeforeShow(win) {
    hookWindow(win);
    const found = openerAgent(
      win.gBrowser?.selectedTab?.linkedBrowser?.browsingContext
    );
    if (!found || !win.SvalPanel || win.SvalPanel.initialized) {
      return;
    }
    const { agent } = found;
    if (win.toolbar.visible && lazy.fullWindowShowing(agent.workspaceId)) {
      // A second full window for a workspace that has one, which no window
      // may be (main spec §10.7). It closes before its panel starts, so it
      // never shows a workspace of the user's.
      SvalLog.warn(
        `agent ${agent.agentId}: a window its page opened is closed, as its own window is open`
      );
      Services.tm.dispatchToMainThread(() => win.close());
      return;
    }
    handWorkspaceTo(win, agent.workspaceId, { agent: true });
    SvalLog.info(`agent ${agent.agentId}: a page opened a window`);
  }

  /**
   * The agent a top-level load in `bc` works for, or null. A tab in the
   * user's control is the user's, so no agent works in it.
   *
   * @param {CanonicalBrowsingContext} bc
   * @returns {object|null}
   */
  function agentForLoad(bc) {
    const top = bc?.top;
    if (!top?.browserId || isUserInControl(top.browserId)) {
      return null;
    }
    return agentIn(agentHomeOf(top.embedderElement));
  }

  return {
    watch,
    agentForLoad,
    onWindowBeforeShow,
    hookWindow,

    /**
     * @param {number} id A `browserId`.
     * @returns {object|null} The agent whose tab it is, whoever holds it.
     */
    agentWatching(id) {
      return agentIn(agentHomeOfId(id));
    },

    /**
     * @param {object} browser The `<browser>` of a page that opens a tab.
     * @returns {object|null} The agent the tab it opens is filed for
     *   (`agentFrom`).
     */
    agentOpening(browser) {
      let bc = null;
      try {
        bc = browser?.browsingContext ?? null;
      } catch {}
      return agentFrom(bc)?.agent ?? null;
    },

    /**
     * @param {object} browser
     * @returns {object|null} The agent whose tab `browser` is, whoever
     *   holds it.
     */
    agentOf(browser) {
      return agentIn(agentHomeOf(browser));
    },

    /** Stops listening to every window, and answers for no tab again. */
    close() {
      for (const [win, handler] of hooked) {
        win.gBrowser?.tabContainer.removeEventListener("TabOpen", handler);
      }
      hooked.clear();
      for (const [workspaceId, claimant] of claims) {
        if (claimant === agentIn) {
          claims.delete(workspaceId);
        }
      }
      known.clear();
    },
  };
}
