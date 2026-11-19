/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What an agent needs the user's leave for, and the one way Sval asks for
 * it (agent-control spec §5.2, site-tools spec §4).
 *
 * A permission is one object: what the agent's policy already says of it,
 * which askers share one alert, what the alert says, and what the answer
 * records. `createAsker` asks about any of them the same way: one alert per
 * question in flight, the "Remember for" menu, an alert with no window, an
 * answer that comes after agent access went off, and the policy read again
 * before an Allow counts, because the user can block the site while the
 * alert is open.
 *
 * `SvalAgentGate` decides when to ask and what a refusal does to a load or
 * a call. The writes an input sets off are asked about by `SvalAgentWrites`,
 * whose alert answers for several sites at once.
 *
 * @typedef {object} Permission
 * @property {string} name What tells its alerts in flight from another
 *   permission's.
 * @property {(policy: object|null, subject: object) =>
 *   "allow"|"deny"|"ask"} decide What the agent's policy says now. A null
 *   policy is an agent Sval does not know.
 * @property {(subject: object) => unknown[]} [shares] What, with the agent,
 *   names the question: askers of the same one wait on one alert. A
 *   permission with none asks each time.
 * @property {(agent: object, subject: object, scope: object|undefined) =>
 *   object} alert The alert's `kind`, `question`, `choices` and whatever
 *   else `ask` takes. `scope` is the "Remember for" menu, absent for a host
 *   that offers no choice.
 * @property {ReadonlySet<string>} [allows] The choices that allow: `allow`
 *   and `allow_always` unless this says otherwise.
 * @property {boolean} [decidesItself] The permission's `record` reads the
 *   policy again itself, so the asker does not.
 * @property {(answer: object) => Promise<string|void>} record Saves what
 *   the user chose, given `store`, `agent`, `subject`, `choice`, the `name`
 *   to save it under, whether it `allowing`, and the alert's `option`. It
 *   may answer in place of `allow` or `deny`.
 * @property {(subject: object) => ToolError} [refused] What a call the
 *   user did not allow fails with.
 * @property {(subject: object) => string} [awaiting] What a call says
 *   while the user has not answered.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  alertOnce,
  answerOf,
  awaitAnswer,
  CHOICES,
  scopeMenuOf,
} from "moz-src:///browser/components/sval/SvalAgentAsk.sys.mjs";
import {
  appPermissionFor,
  decideLoad,
  DEFAULT_LEVEL,
  defaultLevelOf,
  filePermissionFor,
  grantMatches,
  levelFor,
  pageToolSiteOf,
  pageToolsSettingOf,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { decideCall } from "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

/**
 * The default "Allow all sites" sets: the least a site can get and still
 * open without asking (spec §5.2). A site where the agent should write keeps
 * its own rule, set in Settings.
 */
const ALL_SITES_LEVEL = "read-only";

/**
 * The upload alert's choice of what "Always allow" covers (decision 0129),
 * "This folder only" first and by default.
 */
const UPLOAD_SCOPES = Object.freeze({
  label: "Always allow covers",
  value: "folder",
  choices: Object.freeze([
    Object.freeze({ id: "folder", label: "This folder only" }),
    Object.freeze({
      id: "subfolders",
      label: "This folder and the folders inside it",
    }),
  ]),
});

const SITE_CHOICES = Object.freeze([
  CHOICES[0],
  Object.freeze({ id: "allow_all", label: "Allow all sites, read only" }),
  CHOICES[1],
]);

/**
 * How the alert about a local site names where it is (`localPlaceOf`). It
 * offers no "Allow all sites": a local site with no rule asks whatever the
 * default (spec §5.2), so only a rule for the site answers it.
 */
const PLACE_WORDS = Object.freeze({
  computer: "a service on this computer",
  network: "a device on your local network",
});

/** The most tool names a site alert names (site-tools spec §4.2). */
const MAX_TOOLS_SHOWN = 10;

const ALLOWS = new Set(["allow", "allow_always"]);

/** @returns {object[]} Allow and Deny, for an alert to add to. */
const allowOrDeny = () => CHOICES.map(c => ({ ...c }));

/**
 * @param {string} allow
 * @param {string} deny
 * @returns {object[]} Allow, Deny and the two choices that are remembered.
 */
const withAlways = (allow, deny) => [
  ...allowOrDeny(),
  { id: "allow_always", label: allow },
  { id: "deny_always", label: deny },
];

/**
 * Opening a site (spec §5.2). The subject is `{site, place}`: the site as
 * `hostOf` names it, and where a local one is (`localPlaceOf`), which the
 * alert names.
 *
 * Allow keeps a rule the user set for the site while the alert was open.
 * Otherwise it records the site at the policy's default level, or at
 * `DEFAULT_LEVEL` when the default asks or blocks: the user allowed this
 * site. Allow all sites first sets the policy's default to
 * `ALL_SITES_LEVEL`, so no site asks again, and this one, with no rule of
 * its own, follows the default with the rest. Deny, or any answer the alert
 * did not offer, records it as blocked. The answer is recorded whether or
 * not the load or call that asked still waits for it, since a page can
 * supersede its own load and the agent's next navigation stops it: the
 * answer is the user's decision about the site the alert named, and serves
 * its next load.
 *
 * @type {Permission}
 */
export const SITE = {
  name: "site",
  decide: (policy, { site }) => decideLoad(policy, site),
  shares: ({ site }) => [site],
  alert: (agent, { site, place }) => ({
    kind: place ? `site-${place}` : "site",
    question: place
      ? `${agent.label} wants to open ${site}, ${PLACE_WORDS[place]}.`
      : `${agent.label} wants to open ${site}.`,
    choices: (place ? CHOICES : SITE_CHOICES).map(c => ({ ...c })),
  }),
  allows: new Set(["allow", "allow_all"]),
  decidesItself: true,
  async record({ store, agent, subject: { site }, choice, name, allowing }) {
    const { agentId } = agent;
    if (!allowing) {
      await store.setSiteLevel(agentId, name, "blocked");
      SvalLog.info(`agent ${agentId}: a new site was blocked`);
      return "deny";
    }
    // Read again: the policy can have changed while the alert was open, and
    // the agent can have been unpaired.
    let current = store.policyOf(agentId);
    if (!current) {
      return "deny";
    }
    if (choice === "allow_all") {
      await store.setDefault(agentId, ALL_SITES_LEVEL);
      SvalLog.info(`agent ${agentId}: every site was allowed`);
      current = store.policyOf(agentId);
      if (!current) {
        return "deny";
      }
    }
    // A rule the user set for the site while the alert was open is their
    // later decision, and stands.
    const meanwhile = levelFor(current, site);
    if (meanwhile.known) {
      return meanwhile.level === "blocked" ? "deny" : "allow";
    }
    // Allowing every site makes the site one of them: it follows the
    // default, wherever the user sets it later.
    if (choice === "allow_all") {
      return "allow";
    }
    const level = defaultLevelOf(current);
    await store.setSiteLevel(
      agentId,
      name,
      level === "blocked" ? DEFAULT_LEVEL : level
    );
    SvalLog.info(`agent ${agentId}: a new site was allowed`);
    return "allow";
  },
  awaiting: ({ site }) =>
    `Sval is asking the user whether this agent may open ${site}. Ask them to answer in Sval, then call again.`,
};

/**
 * What the policy says of files on a site, downloaded from it or uploaded
 * to it, or of its console (spec §5.2). A Blocked site does none of them,
 * whatever its entry, and an entry Sval cannot read asks again.
 *
 * @param {"downloads"|"uploads"|"console"} kind
 * @returns {(policy: object|null, subject: {site: string}) =>
 *   "allow"|"deny"|"ask"}
 */
const onSite =
  kind =>
  (policy, { site }) => {
    if (!policy || decideLoad(policy, site) === "deny") {
      return "deny";
    }
    return filePermissionFor(policy, kind, site) ?? "ask";
  };

/**
 * Downloading files from a site. The subject is `{site, action}`: askers
 * about the same `action` share one alert, and a one-time answer covers
 * that download alone. Allow and Deny answer for what is asked about now;
 * "Always allow" and "Always deny" are recorded for the site.
 *
 * @type {Permission}
 */
export const DOWNLOADS = {
  name: "downloads",
  decide: onSite("downloads"),
  shares: ({ site, action }) => [site, action],
  alert: (agent, { site }, scope) => ({
    kind: "downloads",
    question: `${agent.label} wants to download files from ${site}.`,
    choices: scope
      ? withAlways("Always allow downloads", "Always deny downloads")
      : withAlways(
          `Always allow downloads from ${site}`,
          `Always deny downloads from ${site}`
        ),
  }),
  async record({ store, agent, choice, name, allowing }) {
    if (choice === "allow_always" || choice === "deny_always") {
      const value = allowing ? "allow" : "deny";
      await store.setFilePermission(agent.agentId, "downloads", name, value);
      SvalLog.info(
        `agent ${agent.agentId}: downloads on a site set to ${value}`
      );
    }
  },
};

/**
 * Uploading files to a site. The subject is `{site, filePaths, folders}`:
 * a retry of the same files waits on their alert, and `folders` are what
 * "Always allow" lets the agent send files from without asking. The alert
 * asks whether the folders inside them are allowed too.
 *
 * @type {Permission}
 */
export const UPLOADS = {
  name: "uploads",
  decide: onSite("uploads"),
  shares: ({ site, filePaths }) => [site, filePaths],
  alert: (agent, { site, filePaths, folders }, scope) => ({
    kind: "uploads",
    question: `${agent.label} wants to upload files from your computer to ${site}.`,
    detail: `Allow sends these files only. Always allow also lets ${agent.label} send ${site} files from ${folders.join(", ")} without asking again, as chosen below. Hidden files still ask. Now it asks to send:`,
    items: filePaths,
    choices: scope
      ? withAlways("Always allow uploads", "Always deny uploads")
      : withAlways(
          `Always allow uploads to ${site}`,
          `Always deny uploads to ${site}`
        ),
    options: UPLOAD_SCOPES,
  }),
  async record({ store, agent, subject, choice, name, option }) {
    const { agentId } = agent;
    if (choice === "allow_always") {
      await store.allowUploadFolders(
        agentId,
        name,
        subject.folders,
        option === "subfolders"
      );
      SvalLog.info(
        `agent ${agentId}: uploads on a site allowed from ${subject.folders.length} folders`
      );
    } else if (choice === "deny_always") {
      await store.setFilePermission(agentId, "uploads", name, "deny");
      SvalLog.info(`agent ${agentId}: uploads on a site set to deny`);
    }
  },
  refused: ({ site }) =>
    new ToolError(
      "policy_denied",
      `The user has not allowed this agent to upload files to ${site}.`
    ),
  awaiting: ({ site }) =>
    `Sval is asking the user whether this agent may upload files to ${site}. Ask them to answer in Sval, then call again.`,
};

/**
 * Reading a site's console (spec §4.5). The subject is `{site}`. Either
 * answer is recorded for the site, as a site alert's is: an alert closed
 * any other way is Deny (`ask`).
 *
 * @type {Permission}
 */
export const CONSOLE = {
  name: "console",
  decide: onSite("console"),
  shares: ({ site }) => [site],
  alert: (agent, { site }, scope) => ({
    kind: "console",
    question: `${agent.label} wants to read the messages ${site} writes to its developer console.`,
    detail: scope
      ? "Sites sometimes write account details, sign-in codes, or what you type there. Sval remembers your answer. You can change it in Settings › Agents."
      : `Sites sometimes write account details, sign-in codes, or what you type there. Sval remembers your answer for ${site}. You can change it in Settings › Agents.`,
    choices: allowOrDeny(),
  }),
  allows: new Set(["allow"]),
  async record({ store, agent, name, allowing }) {
    const value = allowing ? "allow" : "deny";
    await store.setFilePermission(agent.agentId, "console", name, value);
    SvalLog.info(`agent ${agent.agentId}: console on a site set to ${value}`);
  },
  refused: ({ site }) =>
    new ToolError(
      "console_denied",
      `The user has not allowed this agent to read ${site}'s console.`
    ),
  awaiting: ({ site }) =>
    `Sval is asking the user whether this agent may read ${site}'s console. Ask them to answer in Sval, then call again.`,
};

/**
 * Opening an address in another application (spec §5.2). The subject is
 * `{site, topSite, scheme, uri, appName}`: the site of the document that
 * asked, the top-level page's (null for a blank page with none), and the
 * address. The launching site's answer decides, unless that site or the
 * top-level page's is Blocked or Read only, which opens nothing. Allow
 * opens this link only; the Always choices are recorded for the scheme on
 * the site.
 *
 * @type {Permission}
 */
export const APP = {
  name: "app",
  decide(policy, { site, topSite, scheme }) {
    if (!policy) {
      return "deny";
    }
    for (const each of topSite === null ? [site] : [site, topSite]) {
      const { level } = levelFor(policy, each);
      if (level === "blocked" || level === "read-only") {
        return "deny";
      }
    }
    return appPermissionFor(policy, site, scheme) ?? "ask";
  },
  alert(agent, { site, scheme, uri, appName }, scope) {
    const from = scope ? "" : ` from ${site}`;
    return {
      kind: "app",
      question: `${agent.label} wants to open an app from ${site}.`,
      detail: appName
        ? `${site} asks to open a ${scheme} link with ${appName}. Allow opens this link only:`
        : `${site} asks to open a ${scheme} link in another app. Allow opens this link only:`,
      items: [uri.spec],
      choices: withAlways(
        `Always allow ${scheme} links${from}`,
        `Always deny ${scheme} links${from}`
      ),
    };
  },
  async record({ store, agent, subject, choice, name, allowing }) {
    if (choice === "allow_always" || choice === "deny_always") {
      const value = allowing ? "allow" : "deny";
      await store.setAppPermission(agent.agentId, name, subject.scheme, value);
      SvalLog.info(`agent ${agent.agentId}: an app on a site set to ${value}`);
    }
  },
};

/**
 * A site offering its tools to the agent: layer B, then layer C (site-tools
 * spec §4.1). The subject is `{site, names}`, the tools the page offers. A
 * Blocked site never may. Allow and Deny are recorded for the site.
 *
 * @type {Permission}
 */
export const SITE_TOOLS = {
  name: "site tools",
  decide(policy, { site }) {
    if (
      !policy ||
      decideLoad(policy, site) === "deny" ||
      pageToolsSettingOf(policy) === "off"
    ) {
      return "deny";
    }
    return pageToolSiteOf(policy, site) ?? "ask";
  },
  shares: ({ site }) => [site],
  alert(agent, { site, names }) {
    const shown = names.slice(0, MAX_TOOLS_SHOWN).join(", ");
    const more =
      names.length > MAX_TOOLS_SHOWN
        ? ` and ${names.length - MAX_TOOLS_SHOWN} more`
        : "";
    const count = names.length === 1 ? "1 tool" : `${names.length} tools`;
    return {
      kind: "page-tools",
      question: `${site} offers ${count} to ${agent.label}: ${shown}${more}. Let ${agent.label} see and use them?`,
      detail: `${site} wrote these tools and their descriptions. Sval still asks before a tool sends anything your settings for ${site} ask about.`,
      choices: allowOrDeny(),
    };
  },
  allows: new Set(["allow"]),
  async record({ store, agent, name, allowing }) {
    const value = allowing ? "allow" : "deny";
    await store.setPageToolSite(agent.agentId, name, value);
    SvalLog.info(
      `agent ${agent.agentId}: site tools on a site set to ${value}`
    );
  },
  refused: ({ site }) =>
    new ToolError(
      "policy_denied",
      `The user has not allowed this agent to use ${site}'s tools.`
    ),
  awaiting: ({ site }) =>
    `Sval is asking the user whether this agent may use ${site}'s tools. Ask them to answer in Sval, then call again.`,
};

/**
 * What a call of one of a site's tools does (site-tools spec §4.3), from
 * the agent's setting, the site's level and the grants.
 *
 * @param {object|null} policy
 * @param {{site: string, tool: {name: string, read_only: boolean},
 *   hash: string}} subject `hash` is the tool's definition hash.
 * @returns {{action: string, always?: boolean}} As `decideCall`.
 */
export const decideSiteToolCall = (policy, { site, tool, hash }) =>
  decideCall({
    setting: pageToolsSettingOf(policy),
    level: levelFor(policy, site).level,
    hinted: tool.read_only === true,
    granted: grantMatches(policy, site, tool.name, hash),
  });

/**
 * One call of a site's tool (site-tools spec §4.3): the tool, what it says
 * it does, and the arguments it would send. The subject is
 * `{site, tool, hash, sent, always}`: `sent` is the arguments as the alert
 * shows them. Allow and Deny answer for this call. "Always allow" records a
 * grant for this definition of the tool, offered only when `always` is
 * true, so a tool the site registers or changes later asks again; "Always
 * deny" blocks the site's tools (layer C). Its answer is the choice itself.
 *
 * @type {Permission}
 */
export const SITE_TOOL_CALL = {
  name: "site tool call",
  // The user can have blocked the site, turned its tools off, or made it
  // Read-only while the alert was open.
  decide: (policy, subject) =>
    SITE_TOOLS.decide(policy, subject) !== "allow" ||
    decideSiteToolCall(policy, subject).action === "refused"
      ? "deny"
      : "ask",
  alert(agent, { site, tool, sent, always }, scope) {
    const choices = allowOrDeny();
    if (always) {
      choices.push({
        id: "allow_always",
        label: scope
          ? `Always allow "${tool.name}"`
          : `Always allow "${tool.name}" on ${site}`,
      });
    }
    choices.push({
      id: "deny_always",
      label: scope
        ? "Always deny this site's tools"
        : `Always deny ${site}'s tools`,
    });
    return {
      kind: "page-tool-call",
      question: `${agent.label} wants to use ${site}'s tool "${tool.name}".`,
      detail: `${site}'s own code runs this tool, and it can do anything your account on ${site} can do. ${site} describes it as: ${tool.description || "(no description)"}`,
      items: [`It would send: ${sent}`],
      choices,
    };
  },
  async record({ store, agent, subject, choice, name }) {
    const { agentId } = agent;
    if (choice === "allow_always" && subject.always) {
      await store.grantPageTool(agentId, name, subject.tool.name, subject.hash);
      SvalLog.info(`agent ${agentId}: a site tool always allowed`);
    } else if (choice === "deny_always") {
      await store.setPageToolSite(agentId, name, "deny");
      SvalLog.info(`agent ${agentId}: site tools on a site set to deny`);
    }
    return choice;
  },
};

/**
 * @param {object} parts
 * @param {object} parts.store The agents' store, which holds each policy.
 * @param {Function} parts.ask Shows an alert (`SvalAgentAlerts`).
 * @param {(agent: object) => Promise<Window|null>} parts.whereToAsk The
 *   agent's own full window.
 * @param {() => boolean} parts.isClosed Whether agent access went off.
 * @param {object} parts.closing Ends with agent access (`Ending`).
 * @returns {{decision: Function, alert: Function, permit: Function}}
 */
export function createAsker({ store, ask, whereToAsk, isClosed, closing }) {
  /**
   * The alerts in flight, by permission, agent and what the permission
   * shares. A call that gave up waiting, a retry, and a page asking the
   * same question all wait on one alert.
   *
   * @type {Map<string, {answer: Promise<string>}>}
   */
  const inFlight = new Map();

  /**
   * @param {Permission} permission
   * @param {object} agent
   * @param {object} subject
   * @returns {"allow"|"deny"|"ask"} What the agent's policy says now.
   */
  const decision = (permission, agent, subject) =>
    permission.decide(store.policyOf(agent.agentId), subject);

  /**
   * Asks, and records the answer. A window that closed under the alert
   * records nothing.
   *
   * @param {Permission} permission
   * @param {object} agent
   * @param {object} subject
   * @param {Promise<Window|null>} win Where to ask.
   * @returns {Promise<string>} `allow`, `deny`, `no_window`, or what the
   *   permission's `record` answers.
   */
  async function asked(permission, agent, subject, win) {
    const { site } = subject;
    const scope = scopeMenuOf(site);
    const answered = await ask(await win, {
      ...permission.alert(agent, subject, scope),
      defaultChoice: "deny",
      scope,
    });
    const { choice, name } = answerOf(answered, site);
    if (choice === "no_window") {
      return "no_window";
    }
    if (isClosed()) {
      return "deny";
    }
    const allowing = (permission.allows ?? ALLOWS).has(choice);
    // Read again: the user can have blocked the site while the alert was
    // open, and an Allow given then must not open it.
    if (
      allowing &&
      !permission.decidesItself &&
      decision(permission, agent, subject) === "deny"
    ) {
      SvalLog.info(
        `agent ${agent.agentId}: an Allow came for a site now blocked`
      );
      return "deny";
    }
    const said = await permission.record({
      store,
      agent,
      subject,
      choice,
      name,
      allowing,
      option: answered?.option,
    });
    return said ?? (allowing ? "allow" : "deny");
  }

  /**
   * The alert about `subject`, opening one if none that the permission
   * shares is open.
   *
   * @param {Permission} permission
   * @param {object} agent
   * @param {object} subject
   * @param {Promise<Window|null>} [win] Where to ask: the agent's own full
   *   window unless given.
   * @returns {{answer: Promise<string>}}
   */
  function alert(permission, agent, subject, win = whereToAsk(agent)) {
    if (!permission.shares) {
      return { answer: asked(permission, agent, subject, win) };
    }
    return alertOnce(
      inFlight,
      JSON.stringify([
        permission.name,
        agent.agentId,
        ...permission.shares(subject),
      ]),
      () => asked(permission, agent, subject, win)
    );
  }

  /**
   * Resolves once the agent may, asking the user about what they have not
   * decided. A call that stops waiting (`ApprovalWait`) answers
   * `awaiting_approval` and leaves the alert up; the answer is recorded, so
   * the agent's retry reads it.
   *
   * @param {Permission} permission
   * @param {object} agent
   * @param {object} subject
   * @param {object} wait The call's `ApprovalWait`.
   * @returns {Promise<void>} Every refusal throws the permission's
   *   `refused`.
   */
  async function permit(permission, agent, subject, wait) {
    const now = decision(permission, agent, subject);
    if (now === "allow") {
      return;
    }
    if (
      now === "deny" ||
      (await awaitAnswer({
        wait,
        answer: () => alert(permission, agent, subject).answer,
        awaiting: permission.awaiting(subject),
        closing,
      })) !== "allow"
    ) {
      throw permission.refused(subject);
    }
  }

  return { decision, alert, permit };
}
