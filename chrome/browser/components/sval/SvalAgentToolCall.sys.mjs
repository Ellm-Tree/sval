/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One call of an agent's tool: who calls, the tab it names, and everything a
 * tool does to a page on the way to its answer (agent-control spec §4).
 *
 * A tool says what its page must be (`PAGE`, `SEEN`, `MOVED`, `ASKING`),
 * and `SvalAgentToolRunner` enters the tab that way before the tool runs
 * (`enter`). A tool reaches its page through the browser the call found and
 * nothing else, so a tab outside the agent's workspace answers
 * `not_controlled` whatever the tool.
 *
 * The parts a call works with are the listen's:
 * - `tabs` (`createAgentTabs`) finds, opens, loads and closes the agent's
 *   tabs.
 * - `gate.act(browser, agent, task, input)` runs one input and says what
 *   became of the writes it caused: `{writes, held}` merged into the input's
 *   own answer. An input that fails throws with `writes` and `held` set on
 *   its error, and the tool answers an error result that carries them, so
 *   a failure never hides a write.
 * - `sites` (`SvalAgentGate`) decides what the agent may open, read, upload
 *   and call. `checkPage(agent, browser)` throws unless the agent may open
 *   the site the tab shows now, and `checkSite(agent, site)` is the same
 *   check for a site already worked out. Every site handed to `sites` is
 *   named as the agent's rules are looked up by (`hostOfDocument`), so a
 *   host's own rule decides for it.
 * - `dialogs` (`SvalAgentPageDialogs`): `takeReport(browser)` hands over
 *   what a dialog Sval answered in the tab said since the last call, and
 *   `openDialog(browser)` the `confirm` or `prompt` open there for the
 *   agent, each with the sites of the tab's page and of the frame that
 *   raised it, or null. A result carries the message only if the agent may
 *   read every one of them now: a tool that does not read the page must not
 *   leak a page the agent may not read, and a frame must not speak for a
 *   site the agent may not read.
 *
 * Whatever asks the user waits for the answer as `task.wait` says: the
 * call's own `ApprovalWait`, which the session makes for each call.
 *
 * Every query to a page has a deadline (`SvalAgentPageParent`
 * `PAGE_TIMEOUT_MS`), past which the tool answers `page_unresponsive`. A
 * `confirm` or `prompt` an input raises holds the input's query until it is
 * answered, so the dialog opening ends the wait instead, and the tool
 * answers with `dialog_open: true`. Both run inside the input the gate is
 * given, so the gate still settles that input's writes and reports them.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  json,
  refusal,
} from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { pageActor } from "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs";
import {
  addressOfDocument,
  agentSiteOf,
  hostOfDocument,
  siteOfDocument,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import {
  settled,
  workIn,
} from "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs";
import {
  refuseIfUserHolds,
  reportActivity,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import { detect } from "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs";

/**
 * What an input's query settles with when a `confirm` or `prompt` opened
 * before the page answered it.
 */
export const DIALOG_OPENED = Object.freeze({ dialogOpened: true });

/**
 * What a tool's page must be before the tool runs. Each names what `enter`
 * checks of the tab the call names:
 *
 * - `dialog`: a `confirm` or `prompt` open in the tab refuses the tool with
 *   `dialog_open`, which carries the dialog. The page's script is stopped
 *   inside the dialog, so the page can be neither read nor driven until it
 *   is answered.
 * - `site`: the agent may open the site the tab shows now (`checkPage`).
 * - `challenge`: a page asking for human verification
 *   (`SvalAgentChallenge`) refuses the tool with
 *   `human_verification_required`, so the agent can neither attempt the
 *   check nor read its puzzle. `user_in_control` wins over it: a workspace
 *   the user holds is theirs, check or none.
 *
 * @typedef {{dialog: boolean, site: boolean, challenge: boolean}} PageNeeds
 */

/**
 * A page the tool reads or acts in.
 *
 * @type {PageNeeds}
 */
export const PAGE = Object.freeze({
  dialog: true,
  site: true,
  challenge: true,
});

/**
 * A page the tool shows as the user will see it, a check for a person
 * included.
 *
 * @type {PageNeeds}
 */
export const SEEN = Object.freeze({
  dialog: true,
  site: true,
  challenge: false,
});

/**
 * A tab the tool moves on, whatever it shows: a tab left on a blocked site
 * can still be loaded with another page.
 *
 * @type {PageNeeds}
 */
export const MOVED = Object.freeze({
  dialog: true,
  site: false,
  challenge: false,
});

/**
 * A page whose dialog the tool answers. An answer resumes the page's
 * script, which can then send anything, so the page's own site must be one
 * the agent may act on now, as for any other input.
 *
 * @type {PageNeeds}
 */
export const ASKING = Object.freeze({
  dialog: false,
  site: true,
  challenge: false,
});

/**
 * The site an acting tool is about to act on when that is the page its tab
 * shows, for Be polite (a tool's `actsOn`). A tab session restore left
 * unloaded is named by its node's address until its turn comes, and is
 * never loaded to be named.
 *
 * @param {object} args The call's arguments.
 * @param {{tab: object, url?: string}} found The tab, as `tabs.find` gives
 *   it.
 * @returns {string|null}
 */
export const ON_PAGE = (args, found) =>
  found.tab.linkedPanel
    ? siteOfDocument(
        found.tab.linkedBrowser.browsingContext?.currentWindowGlobal
      )
    : agentSiteOf(found.url ?? "");

/**
 * What an input did before the user took its tab, which is all a result
 * there keeps: the tab, the fields it filled and what became of the writes
 * it set off. The page and its dialogs are the user's (decision 0107).
 *
 * @param {object} body
 * @returns {object}
 */
const ownDoing = body => ({
  tab: body.tab,
  filled: body.filled,
  writes: body.writes,
  held: body.held,
});

/** One call of one tool by one agent. */
export class ToolCall {
  /** The tool called, a row of `SvalAgentToolTable`. */
  tool;
  /** What the session lends the call of itself (`SvalAgentSession`). */
  session;
  /** The paired agent calling. */
  agent;
  /** The call's task, whose `wait` is how it waits for the user. */
  task;
  /** `createAgentTabs`'s functions. */
  tabs;
  gate;
  sites;
  dialogs;
  /** The most one upload sends. */
  maxUploadBytes;
  /** The id of the tab the call found, as the agent names it. */
  tab = null;
  /** That tab's `<browser>`. */
  browser = null;
  /**
   * The tab Be polite found as the call was about to go, for a call it did
   * not hold: the call looks it up once. One held for its turn looks again,
   * as the tab may have moved meanwhile.
   *
   * @type {{tab: string, found: object}|null}
   */
  foundEarlier = null;

  /**
   * @param {object} parts The listen's `tabs`, `gate`, `sites` and
   *   `dialogs`, and `maxUploadBytes`.
   * @param {object} tool
   * @param {object} session
   * @param {object} [task]
   */
  constructor(parts, tool, session, task) {
    Object.assign(this, parts);
    this.tool = tool;
    this.session = session;
    this.agent = session.agent;
    this.task = task;
  }

  /**
   * Finds one of the agent's tabs, loading it if session restore left it
   * unloaded, and tells its window what the tool is doing there.
   *
   * @param {string} tab A tab id.
   * @returns {Promise<{win: object, tab: object, browser: object}>}
   */
  async find(tab) {
    const earlier = this.foundEarlier;
    this.foundEarlier = null;
    const found = await this.tabs.tabIn(
      this.agent,
      tab,
      earlier?.tab === tab ? earlier.found : undefined
    );
    this.tab = tab;
    this.browser = found.browser;
    if (this.tool.activity && !this.tool.namesWhereItGoes) {
      this.report();
    }
    return found;
  }

  /**
   * Tells the tab's window what the tool is doing in it.
   *
   * @param {string} [site] The site it acts on, when that is not the page's
   *   own, as for a load.
   */
  report(site) {
    reportActivity(this.browser, this.tool.activity, site);
  }

  /**
   * Finds the tab and refuses the call unless its page is what the tool
   * needs.
   *
   * @param {string} tab A tab id.
   * @param {PageNeeds} needs
   */
  async enter(tab, needs) {
    await this.find(tab);
    if (needs.dialog) {
      this.refuseIfDialogOpen();
    }
    if (needs.site) {
      this.checkPage();
    }
    if (needs.challenge) {
      await this.refuseIfChallenge();
      // Looking for a challenge waits on the page, which can move on to a
      // site the agent may not read meanwhile. A reading tool asks the
      // page's actor in the same turn as this check, so what it reads is
      // what was judged; an input is judged again as it goes (`gate.act`).
      this.checkPage();
    }
  }

  /** Throws unless the agent may open the site the tab shows now. */
  checkPage() {
    this.sites.checkPage(this.agent, this.browser);
  }

  /**
   * @returns {boolean} Whether the agent may read the page the tab shows
   *   now (`checkPage`). A page it may not read is never asked about a
   *   check: its tool calls fail on the site first.
   */
  mayReadPage() {
    try {
      this.checkPage();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string|null|undefined} site
   * @returns {boolean} Whether the agent may read a page on `site` now.
   *   Undefined is a page whose site is refused, which no agent may read.
   */
  mayRead(site) {
    if (site === undefined) {
      return false;
    }
    try {
      return this.sites.checkSite(this.agent, site) === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {{type: string, message: string, sites: Array}} report
   * @returns {{type: string, message: string}} The dialog as the agent may
   *   see it: what it said only if the agent may read every site behind it
   *   now. Its type is withheld with its message, because which a page
   *   asked is something it said too.
   */
  dialogFor(report) {
    return report.sites.every(site => this.mayRead(site))
      ? { type: report.type, message: report.message }
      : { type: "withheld", message: "" };
  }

  /**
   * Refuses the tool on a tab with a `confirm` or `prompt` open: the page is
   * stopped inside the dialog until it is answered.
   */
  refuseIfDialogOpen() {
    const report = this.dialogs.openDialog(this.browser);
    if (report) {
      throw new ToolError("dialog_open", undefined, {
        tab: this.tab,
        dialog: this.dialogFor(report),
      });
    }
  }

  /**
   * Refuses the tool on a tab whose page asks for human verification, or
   * does not answer. Either refusal names the tab and what it shows, so a
   * tool that has opened or moved the tab still tells the agent where it
   * is.
   */
  async refuseIfChallenge() {
    const { tab } = this;
    let check;
    try {
      check = await detect(this.browser);
    } catch (err) {
      if (err?.code === "page_unresponsive") {
        throw new ToolError(err.code, err.message, { tab, ...this.shown() });
      }
      throw err;
    }
    if (!check) {
      return;
    }
    throw new ToolError(
      "human_verification_required",
      `This page is asking for proof that a person is there. Do not try to complete it. Tell the user that tab ${tab} needs them: they should press Take control in Sval, complete the check, then give the workspace back. Call list_tabs to see when human_verification is gone.`,
      { tab, ...check, ...this.shown() }
    );
  }

  /**
   * What the tab shows now, if the agent may read the page: nothing when
   * it may not. An input can take the tab to a page whose site is refused
   * without opening a channel, as a back into the back-forward cache does,
   * and a site can be blocked while its page loads.
   *
   * The page is judged as `checkPage` judges it, and named from the same
   * window global: a browser's own title and address are updated on
   * schedules of their own, and can still name the page before.
   *
   * Nothing is shown of a tab the user has taken, which a tool that began
   * before the take can still be answering about: the page is the user's
   * (decision 0107).
   *
   * @returns {{url?: string, title?: string}}
   */
  shown() {
    const windowGlobal = this.browser.browsingContext?.currentWindowGlobal;
    try {
      refuseIfUserHolds(this.browser);
      this.sites.checkSite(this.agent, hostOfDocument(windowGlobal));
    } catch {
      return {};
    }
    return {
      url: addressOfDocument(windowGlobal),
      title: windowGlobal.documentTitle,
    };
  }

  /**
   * @param {string} url
   * @returns {Promise<boolean>} Whether the user blocked the site, so that
   *   the load only shows about:agentblocked. Only `true` from
   *   `sites.allowLoad` allows a load, which throws a `ToolError` to refuse
   *   with a reason of its own.
   */
  async allowLoad(url) {
    const answer = await this.sites.allowLoad(this.agent, this.task, url);
    if (answer !== true && answer !== "blocked") {
      throw new ToolError(
        "policy_denied",
        "The user has not allowed this agent to open that site."
      );
    }
    return answer === "blocked";
  }

  /**
   * @param {Promise<object>} query A query to the page actor.
   * @returns {Promise<object>} Its answer, or `DIALOG_OPENED` when a
   *   `confirm` or `prompt` opened in the tab first, which holds the query
   *   until it is answered.
   */
  async answered(query) {
    const dialog = this.dialogs.waitForOpen(this.browser);
    // A query a dialog cut short settles once the dialog is answered, or
    // never, and nobody waits for it then.
    query.catch(() => {});
    try {
      return await Promise.race([
        query,
        dialog.opened.then(() => DIALOG_OPENED),
      ]);
    } finally {
      dialog.stop();
    }
  }

  /**
   * @param {object} body
   * @returns {object} `body` with any page dialog the tab saw.
   */
  #withDialog(body) {
    const open = this.dialogs.openDialog(this.browser);
    if (open) {
      return { ...body, dialog: this.dialogFor(open), dialog_open: true };
    }
    const report = this.dialogs.takeReport(this.browser);
    return report ? { ...body, dialog: this.dialogFor(report) } : body;
  }

  /**
   * @param {object} body
   * @returns {object} The result of a tool that worked, with any page
   *   dialog the tab saw. In a tab the user has taken since the tool began,
   *   the result fails as every tool there does.
   */
  reply(body) {
    try {
      refuseIfUserHolds(this.browser);
    } catch (err) {
      return refusal(err.code, err.message, ownDoing(body));
    }
    return json(this.#withDialog(body));
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {object} body What the failure says besides.
   * @returns {object} The result of a tool that failed in its page, as
   *   `reply` answers one that worked.
   */
  replyFailed(code, message, body) {
    try {
      refuseIfUserHolds(this.browser);
    } catch (err) {
      return refusal(
        err.code,
        err.code === code ? message : err.message,
        ownDoing(body)
      );
    }
    return refusal(code, message, this.#withDialog(body));
  }

  /**
   * Runs one input through the write gate.
   *
   * @param {() => Promise<object>} run The input.
   * @param {(err: unknown) => object} [context] What a failure's result
   *   says besides the error and the writes: the tab, unless given. A
   *   `message` here replaces the error's own.
   * @param {object} [options] As `gate.act` takes.
   * @returns {Promise<{done: object}|{failed: object}>} The gate's answer,
   *   or, for an input that failed, the error result to answer with, which
   *   carries what became of its writes.
   */
  async act(run, context = () => ({ tab: this.tab }), options = undefined) {
    const { browser } = this;
    try {
      // The input's tab is selected as it goes, past the gate's last check
      // that the user does not hold it.
      const selected = () => {
        workIn(browser);
        return run();
      };
      return {
        done: await this.gate.act(
          browser,
          this.agent,
          this.task,
          selected,
          options
        ),
      };
    } catch (err) {
      if (err?.writes === undefined) {
        throw err;
      }
      let code = "internal_error";
      let message = `${err?.name ?? "Error"}: Sval hit a fault. Try once more, then tell the user.`;
      if (err instanceof ToolError) {
        ({ code, message } = err);
      } else {
        SvalLog.error(`an agent input failed: ${describeError(err)}`);
      }
      const { message: said = message, ...rest } = context(err);
      return {
        failed: this.replyFailed(code, said, {
          ...rest,
          writes: err.writes,
          held: err.held,
        }),
      };
    }
  }

  /**
   * One input into the page: a query to its actor, run through the write
   * gate, answered with the tab and what became of the writes it set off.
   *
   * @param {(page: object) => Promise<object>} query The input, given the
   *   page's actor.
   * @param {object} [options]
   * @param {boolean} [options.settle] Whether the input may start a
   *   navigation, which is waited for and whose page the answer then names.
   *   A held write may be the navigation itself, which cannot finish until
   *   the user answers, and a dialog holds the page until the agent does.
   * @param {(done: object) => object} [options.says] What the answer says
   *   of the input besides.
   * @returns {Promise<object>} The tool's result.
   */
  async input(query, { settle = false, says = () => ({}) } = {}) {
    const page = pageActor(this.browser);
    const { done, failed } = await this.act(() => this.answered(query(page)));
    if (failed) {
      return failed;
    }
    if (!settle) {
      return this.reply({ tab: this.tab, ...says(done), writes: done.writes });
    }
    if (done.writes !== "awaiting_approval" && !done.dialogOpened) {
      await settled(this.browser);
    }
    return this.reply({
      tab: this.tab,
      ...this.shown(),
      ...says(done),
      writes: done.writes,
    });
  }
}
