/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The agents paired with this device (agent-control spec §5.1), kept in
 * `<profile>/sval-agents/agents.json` and never synced.
 *
 * Sval keeps only a SHA-256 of each agent's secret, so reading `agents.json`
 * gives no secret. The agent's copy is `sval-mcp`'s, in a file of its own in
 * the same directory. The file is readable by its owner only, in a directory
 * only its owner can open (`makePrivateDirectory`).
 *
 * Each `site` a policy setter takes names the rule it writes: a site, or a
 * host under its site (decision 1980), as `scopeOfHost` names them. The
 * policy's lookups walk from a host to its site (`mostSpecificRule`).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import {
  appsOf,
  cleanPolicy,
  DEFAULT_POLICY,
  DEFAULTS,
  FILE_KINDS,
  FILE_PERMISSIONS,
  filePermissionOf,
  isAppScheme,
  LEVELS,
  uploadFoldersOf,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { writePrivateJSON } from "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs";
import { readJSONOrNull } from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import {
  sha256Hex,
  toHex,
} from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";
import { forgetPolite } from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";
import {
  GRANT_HASH,
  PAGE_TOOL_SITE_ANSWERS,
  PAGE_TOOLS_SETTINGS,
} from "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  restrictToCurrentUser:
    "moz-src:///browser/components/sval/SvalWindowsAcl.sys.mjs",
});

const FILE_VERSION = 1;

export { DEFAULT_POLICY };

/**
 * Makes `path` a directory only its owner can open, mode 0700, and tightens
 * one that already exists with looser bits. Another OS user then cannot open
 * a file inside at any moment, whatever the file's own mode, so there is no
 * window between a file's creation and its chmod in which they could take a
 * handle to it and read what is later written there. `makeDirectory` passes
 * the mode to mkdir, so a new directory is never looser than 0700.
 *
 * On Windows `makeDirectory` ignores the mode (`IOUtils.webidl`), so the
 * directory gets a protected DACL instead, allowing only this user and SYSTEM
 * and inherited by every file inside (`restrictToCurrentUser`). It is set on
 * every call: a profile outside `%APPDATA%` can inherit an ACL that lets every
 * local user read.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function makePrivateDirectory(path) {
  await IOUtils.makeDirectory(path, {
    permissions: 0o700,
    ignoreExisting: true,
  });
  if (AppConstants.platform == "win") {
    lazy.restrictToCurrentUser(path);
    return;
  }
  const { permissions } = await IOUtils.stat(path);
  if (permissions & 0o077) {
    await IOUtils.setPermissions(path, 0o700);
  }
}

/**
 * Compares two equal-length hex strings without an early exit.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameInConstantTime(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * @param {object} policy
 * @param {string} map One of the policy's maps keyed by site.
 * @returns {object} The map's entries. A value that is not a map holds
 *   nothing readable and is started afresh.
 */
function entriesOf(policy, map) {
  const current = policy[map];
  return current && typeof current === "object" && !Array.isArray(current)
    ? current
    : {};
}

/**
 * @param {object} policy
 * @param {string} map One of the policy's maps keyed by site.
 * @param {string} site
 * @param {string} value
 * @returns {object} A copy of `policy` with `site` set to `value` in `map`,
 *   every other entry and field kept, including those this build cannot read.
 */
function withEntry(policy, map, site, value) {
  return {
    ...policy,
    [map]: { ...entriesOf(policy, map), [String(site)]: value },
  };
}

/**
 * @param {object} policy
 * @param {string} map One of the policy's maps keyed by site.
 * @param {string} site
 * @returns {object} A copy of `policy` with no entry for `site` in `map`. A
 *   map that held none, or that is absent, is left as it was.
 */
function withoutEntry(policy, map, site) {
  const entries = entriesOf(policy, map);
  if (!Object.hasOwn(entries, String(site))) {
    return policy;
  }
  return {
    ...policy,
    [map]: Object.fromEntries(
      Object.entries(entries).filter(([key]) => key !== String(site))
    ),
  };
}

/**
 * The workspaces an agent's record holds, by id: one per session of its app
 * (decision 1998), each with the task that names it, the model the session
 * gave, where and when the session's `sval-mcp` started, and when a session
 * last held it. A record written before workspaces were kept per session
 * holds its one workspace in its own fields.
 *
 * @param {object} record
 * @returns {{[workspaceId: string]: {task: string, model: string,
 *   dir: string, started: number|null, lastUsed: number|null}}}
 */
function workspacesOf(record) {
  if (record.workspaces && typeof record.workspaces === "object") {
    return record.workspaces;
  }
  if (typeof record.workspaceId !== "string") {
    return {};
  }
  return {
    [record.workspaceId]: {
      task: typeof record.task === "string" ? record.task : "",
      model: "",
      dir: record.dir ?? "",
      started: record.started ?? null,
      lastUsed: null,
    },
  };
}

/**
 * A workspace's entry as a record keeps it, from what a session said of
 * itself.
 *
 * @param {object} facts
 * @param {string} [facts.task]
 * @param {string} [facts.model]
 * @param {string} [facts.dir]
 * @param {number|null} [facts.started]
 * @param {number|null} [facts.lastUsed]
 * @returns {{task: string, model: string, dir: string, started: number|null,
 *   lastUsed: number|null}}
 */
function workspaceEntry({
  task = "",
  model = "",
  dir = "",
  started = null,
  lastUsed = null,
}) {
  return { task, model, dir, started, lastUsed };
}

/**
 * The device-local record of paired agents, keyed by agent id.
 */
export class SvalAgentStore {
  #path;
  /** @type {Map<string, {label, workspaces, secretHash, policy}>} */
  #agents = new Map();
  /**
   * The workspaces of unpaired agents that the user kept, by id, each with
   * its entry, so the idle sweep still deletes them in time.
   *
   * @type {Map<string, object>}
   */
  #kept = new Map();
  /**
   * The file's own fields this build does not know, written back as they
   * were (spec §5.2: a write keeps every field Sval does not know).
   */
  #unknown = {};
  /** The writes, one at a time. */
  #queue = new SvalSerialQueue("agent store");
  #onChange;

  /**
   * Reads the agents file. A policy Sval reads differently from how it is
   * stored, a rule Sval cannot read (`cleanPolicy`), is written back clean.
   * A write that fails then is logged, and the clean copy is written with
   * the next change.
   *
   * @param {string} path
   * @param {object} [options]
   * @param {() => void} [options.onChange] Called after each change is
   *   written, so what shows the agents can redraw.
   * @returns {Promise<SvalAgentStore>}
   */
  static async open(path, { onChange } = {}) {
    const store = new SvalAgentStore(path);
    store.#onChange = onChange;
    if (await store.#load()) {
      try {
        await store.#commit(() => ({ changed: true, result: undefined }));
      } catch (err) {
        SvalLog.warn(
          `could not write the cleaned agents file: ${SvalLog.errorName(err)}`
        );
      }
    }
    return store;
  }

  constructor(path) {
    this.#path = path;
  }

  /** @returns {Promise<boolean>} Whether a policy was cleaned. */
  async #load() {
    const json = await readJSONOrNull(this.#path);
    if (json === null) {
      return false;
    }
    if (json?.version !== FILE_VERSION) {
      throw new Error(
        `the agents file is version ${json?.version}, and this build reads version ${FILE_VERSION}`
      );
    }
    const { agents, kept, ...unknown } = json;
    delete unknown.version;
    for (const [workspaceId, entry] of Object.entries(kept ?? {})) {
      if (entry && typeof entry === "object") {
        this.#kept.set(workspaceId, entry);
      }
    }
    this.#unknown = unknown;
    let cleaned = false;
    for (const [agentId, record] of Object.entries(agents ?? {})) {
      const { policy, changed } = cleanPolicy(record?.policy);
      cleaned ||= changed;
      this.#agents.set(agentId, changed ? { ...record, policy } : record);
    }
    return cleaned;
  }

  /**
   * Applies `change` to a copy of the agents, writes the copy, and only then
   * makes it the store's state. A failed write leaves memory as it was and
   * rejects. Runs are queued, so each write holds every committed change and
   * two writes never share the temporary file at once.
   *
   * @param {(next: Map, kept: Map) => {changed: boolean, result: any}} change
   *   Edits the copies of the agents and the kept workspaces; says whether
   *   it did, and what the call returns.
   * @returns {Promise<any>}
   */
  #commit(change) {
    return this.#queue.run(async () => {
      const next = new Map(this.#agents);
      const kept = new Map(this.#kept);
      const { changed, result } = change(next, kept);
      if (!changed) {
        return result;
      }
      await writePrivateJSON(this.#path, {
        ...this.#unknown,
        version: FILE_VERSION,
        agents: Object.fromEntries(next),
        ...(kept.size && { kept: Object.fromEntries(kept) }),
      });
      this.#agents = next;
      this.#kept = kept;
      try {
        this.#onChange?.();
      } catch (err) {
        SvalLog.warn(
          `an agents change listener failed: ${SvalLog.errorName(err)}`
        );
      }
      return result;
    });
  }

  /**
   * Records an AI app the user allowed on this device, and issues its
   * secret. `workspaceId`, with the session's own facts, is the workspace of
   * the session that asked, when it has one.
   *
   * An app that pairs again under a launch id an agent already holds is that
   * agent: `sval-mcp` keeps one secret per app (decision 1998), and saves the
   * new one over the old, so a second record could never connect again. The
   * agent keeps its id, workspaces and policy, and takes the new secret and
   * the user's new choice of workspace.
   *
   * @param {object} agent
   * @param {string} agent.label What Sval calls the agent: its client.
   * @param {string} [agent.client] Its MCP client, by its display name
   *   where it gives one.
   * @param {boolean} [agent.isolated] Whether the user chose isolated
   *   workspaces for it, which each workspace made for it is.
   * @param {string|null} [agent.launchId] The id `sval-mcp` gives every
   *   launch of the app (`launchFrom`).
   * @param {string} [agent.workspaceId]
   * @param {string} [agent.task] What the session said it is doing, which
   *   names its workspace.
   * @param {string} [agent.model] The model the session said it runs on.
   * @param {string} [agent.dir] The directory its `sval-mcp` was launched in.
   * @param {number|null} [agent.started] When that `sval-mcp` started, in ms.
   * @returns {Promise<{agentId: string, secret: string}>}
   */
  async pair({
    label,
    client = "",
    isolated = false,
    launchId = null,
    workspaceId,
    ...facts
  }) {
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const secretHash = await sha256Hex(secret);
    const added = workspaceId ? { [workspaceId]: workspaceEntry(facts) } : {};
    return this.#commit(next => {
      const known =
        launchId &&
        [...next].find(([, record]) => record.launchId === launchId);
      if (known) {
        const [agentId, record] = known;
        next.set(agentId, {
          ...record,
          label,
          client,
          isolated,
          workspaces: { ...workspacesOf(record), ...added },
          secretHash,
        });
        return { changed: true, result: { agentId, secret } };
      }
      const agentId = crypto.randomUUID();
      next.set(agentId, {
        label,
        client,
        isolated,
        ...(launchId && { launchId }),
        workspaces: added,
        secretHash,
        policy: structuredClone(DEFAULT_POLICY),
      });
      return { changed: true, result: { agentId, secret } };
    });
  }

  async verify(agentId, secret) {
    // Only strings are an id and a secret. Anything else is refused, so the
    // session holds the very string the agent was paired under, and every
    // comparison with it, Unpair's included, matches.
    if (typeof agentId !== "string" || typeof secret !== "string") {
      return null;
    }
    // Hash first, so an unknown id and a wrong secret take the same time.
    const presented = await sha256Hex(secret);
    const record = this.#agents.get(agentId);
    if (!record || !sameInConstantTime(presented, record.secretHash)) {
      return null;
    }
    return { agentId, label: record.label, isolated: record.isolated === true };
  }

  /**
   * Gives agent `agentId` workspace `workspaceId`, made for one of its
   * sessions. An unknown agent is a no-op.
   *
   * @param {string} agentId
   * @param {string} workspaceId
   * @param {object} facts What the session said of itself, as `pair` takes.
   */
  async addWorkspace(agentId, workspaceId, facts) {
    await this.#commit(next => {
      const record = next.get(String(agentId));
      if (!record) {
        return { changed: false, result: undefined };
      }
      next.set(String(agentId), {
        ...record,
        workspaces: {
          ...workspacesOf(record),
          [workspaceId]: workspaceEntry(facts),
        },
      });
      return { changed: true, result: undefined };
    });
  }

  /**
   * Records that a session of agent `agentId` holds workspace `workspaceId`
   * at `now`, which is how long it has gone unused counts from. A workspace
   * not the agent's is a no-op.
   *
   * @param {string} agentId
   * @param {string} workspaceId
   * @param {number} now
   */
  async touchWorkspace(agentId, workspaceId, now) {
    await this.#commit(next => {
      const record = next.get(String(agentId));
      const workspaces = record ? workspacesOf(record) : {};
      const entry = workspaces[workspaceId];
      if (!entry || entry.lastUsed === now) {
        return { changed: false, result: undefined };
      }
      next.set(String(agentId), {
        ...record,
        workspaces: {
          ...workspaces,
          [workspaceId]: { ...entry, lastUsed: now },
        },
      });
      return { changed: true, result: undefined };
    });
  }

  /**
   * @param {string} workspaceId
   * @returns {{agentId: string, label: string}|null} The agent whose
   *   workspace `workspaceId` is.
   */
  agentOfWorkspace(workspaceId) {
    for (const [agentId, record] of this.#agents) {
      if (Object.hasOwn(workspacesOf(record), workspaceId)) {
        return { agentId, label: record.label };
      }
    }
    return null;
  }

  /**
   * @param {string} agentId
   * @param {string} workspaceId
   * @returns {object|null} The entry of `workspaceId` if it is the agent's.
   */
  workspaceOf(agentId, workspaceId) {
    const record = this.#agents.get(String(agentId));
    const entry = record && workspacesOf(record)[workspaceId];
    return entry ? { ...entry } : null;
  }

  /**
   * Keeps what the session in workspace `workspaceId` said it is doing,
   * which names that workspace. A workspace not the agent's is a no-op.
   *
   * @param {string} agentId
   * @param {string} workspaceId
   * @param {string} task
   */
  async setTask(agentId, workspaceId, task) {
    await this.#commit(next => {
      const record = next.get(String(agentId));
      const workspaces = record ? workspacesOf(record) : {};
      const entry = workspaces[workspaceId];
      if (!entry || entry.task === task) {
        return { changed: false, result: undefined };
      }
      next.set(String(agentId), {
        ...record,
        workspaces: { ...workspaces, [workspaceId]: { ...entry, task } },
      });
      return { changed: true, result: undefined };
    });
  }

  /**
   * Removes the agent's record and secret. The workspaces it had stay, for
   * the idle sweep to delete in time, unless the user deletes them with it.
   *
   * @param {string} agentId
   * @returns {Promise<boolean>} Whether the agent was paired.
   */
  async unpair(agentId) {
    const had = await this.#commit((next, kept) => {
      const record = next.get(agentId);
      if (!record) {
        return { changed: false, result: false };
      }
      next.delete(agentId);
      for (const [workspaceId, entry] of Object.entries(workspacesOf(record))) {
        kept.set(workspaceId, entry);
      }
      return { changed: true, result: true };
    });
    if (had) {
      forgetPolite(agentId);
    }
    return had;
  }

  /**
   * Forgets workspace `workspaceId`, which the user or its agent has
   * deleted. The agent stays paired (decision 1998).
   *
   * @param {string} workspaceId
   */
  async workspaceDeleted(workspaceId) {
    await this.#commit((next, kept) => {
      if (kept.delete(workspaceId)) {
        return { changed: true, result: undefined };
      }
      for (const [agentId, record] of next) {
        const workspaces = workspacesOf(record);
        if (Object.hasOwn(workspaces, workspaceId)) {
          next.set(agentId, {
            ...record,
            workspaces: Object.fromEntries(
              Object.entries(workspaces).filter(([id]) => id !== workspaceId)
            ),
          });
          return { changed: true, result: undefined };
        }
      }
      return { changed: false, result: undefined };
    });
  }

  /**
   * @param {string} agentId
   * @returns {object|null} A copy of the agent's policy.
   */
  policyOf(agentId) {
    const record = this.#agents.get(String(agentId));
    return record ? structuredClone(record.policy) : null;
  }

  /**
   * Sets what sites with no rule get: `"ask"`, or a level. An unknown agent
   * is a no-op.
   *
   * @param {string} agentId
   * @param {string} value One of `DEFAULTS`.
   */
  async setDefault(agentId, value) {
    if (!DEFAULTS.includes(value)) {
      throw new Error("unknown policy default");
    }
    await this.#editPolicy(agentId, policy => ({ ...policy, default: value }));
  }

  /**
   * Sets the level for one site. An unknown agent is a no-op.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} level One of `LEVELS`.
   */
  async setSiteLevel(agentId, site, level) {
    if (!LEVELS.includes(level)) {
      throw new Error("unknown policy level");
    }
    await this.#editPolicy(agentId, policy =>
      withEntry(policy, "sites", site, level)
    );
  }

  /**
   * Sets the level for each of `sites` in one write, leaving any site
   * `keep` holds for the policy as it stands at the write. An unknown agent
   * is a no-op.
   *
   * @param {string} agentId
   * @param {string[]} sites
   * @param {string} level One of `LEVELS`.
   * @param {(policy: object, site: string) => boolean} [keep]
   */
  async setSiteLevels(agentId, sites, level, keep = () => false) {
    if (!LEVELS.includes(level)) {
      throw new Error("unknown policy level");
    }
    await this.#editPolicy(agentId, policy =>
      sites.reduce(
        (edited, site) =>
          keep(policy, site) ? edited : withEntry(edited, "sites", site, level),
        policy
      )
    );
  }

  /**
   * Removes one site's level, so it follows the default. Its file
   * permissions stay.
   *
   * @param {string} agentId
   * @param {string} site
   */
  async removeSiteLevel(agentId, site) {
    await this.#editPolicy(agentId, policy =>
      withoutEntry(policy, "sites", site)
    );
  }

  /**
   * Records whether the agent may download files from a site or read its
   * console, or that it may not upload files to it (spec §5.2). Uploads are
   * allowed only from folders (`allowUploadFolders`).
   *
   * @param {string} agentId
   * @param {"downloads"|"uploads"|"console"} kind
   * @param {string} site
   * @param {"allow"|"deny"} value
   */
  async setFilePermission(agentId, kind, site, value) {
    if (!FILE_KINDS.includes(kind) || filePermissionOf(kind, value) !== value) {
      throw new Error("unknown file permission");
    }
    await this.#editPolicy(agentId, policy =>
      withEntry(policy, kind, site, value)
    );
  }

  /**
   * Lets the agent upload files to a site from `folders`, and from the
   * folders it was allowed before, without asking (spec §5.2, decision
   * 0129). A folder the entry already has keeps the wider of its two scopes:
   * only Settings narrows one. An entry that denied uploads is replaced: the
   * user allowed them since.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string[]} folders Absolute paths.
   * @param {boolean} subfolders Whether the folders inside them are allowed
   *   too.
   */
  async allowUploadFolders(agentId, site, folders, subfolders) {
    const given = (Array.isArray(folders) ? folders : []).map(path => ({
      path,
      subfolders,
    }));
    if (
      !uploadFoldersOf({ folders: given }) ||
      given.length !== folders.length
    ) {
      throw new Error("unknown upload folders");
    }
    await this.#editPolicy(agentId, policy => {
      const merged = new Map(
        (uploadFoldersOf(entriesOf(policy, "uploads")[String(site)]) ?? []).map(
          folder => [folder.path, folder]
        )
      );
      for (const folder of given) {
        const before = merged.get(folder.path);
        merged.set(folder.path, {
          path: folder.path,
          subfolders: folder.subfolders || !!before?.subfolders,
        });
      }
      return withEntry(policy, "uploads", site, {
        folders: [...merged.values()],
      });
    });
  }

  /**
   * Narrows one of a site's upload folders to the files directly in it, or
   * removes it. Neither ever allows more than before (decision 0129): an
   * entry left with no folders is removed, so Sval asks again.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} path The folder's path as its entry holds it.
   * @param {"narrow"|"remove"} change
   */
  async changeUploadFolder(agentId, site, path, change) {
    if (change !== "narrow" && change !== "remove") {
      throw new Error("unknown change to an upload folder");
    }
    await this.#editPolicy(agentId, policy => {
      const folders = uploadFoldersOf(
        entriesOf(policy, "uploads")[String(site)]
      );
      if (!folders?.some(folder => folder.path === path)) {
        return policy;
      }
      const left =
        change === "remove"
          ? folders.filter(folder => folder.path !== path)
          : folders.map(folder =>
              folder.path === path ? { path, subfolders: false } : folder
            );
      return left.length
        ? withEntry(policy, "uploads", site, { folders: left })
        : withoutEntry(policy, "uploads", site);
    });
  }

  /**
   * Records whether a site may open `scheme` addresses in other
   * applications (spec §5.2). An entry that denied every app is replaced by
   * this scheme's answer alone.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} scheme
   * @param {"allow"|"deny"} value
   */
  async setAppPermission(agentId, site, scheme, value) {
    if (!isAppScheme(scheme) || !FILE_PERMISSIONS.includes(value)) {
      throw new Error("unknown app permission");
    }
    await this.#editPolicy(agentId, policy => {
      const before = appsOf(entriesOf(policy, "apps")[String(site)]);
      return withEntry(policy, "apps", site, {
        ...(before && before !== "deny" ? before : {}),
        [scheme]: value,
      });
    });
  }

  /**
   * Forgets a site's answer for one scheme, so Sval asks again. An entry
   * left with no schemes is removed.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} scheme
   */
  async removeAppPermission(agentId, site, scheme) {
    await this.#editPolicy(agentId, policy => {
      const before = appsOf(entriesOf(policy, "apps")[String(site)]);
      if (!before || before === "deny" || !Object.hasOwn(before, scheme)) {
        return policy;
      }
      const left = Object.entries(before).filter(([key]) => key !== scheme);
      return left.length
        ? withEntry(policy, "apps", site, Object.fromEntries(left))
        : withoutEntry(policy, "apps", site);
    });
  }

  /**
   * Sets a site's apps: `"deny"` opens none, and null removes the entry, so
   * Sval asks about each scheme again.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {"deny"|null} value
   */
  async setApps(agentId, site, value) {
    if (value !== "deny" && value !== null) {
      throw new Error("unknown apps setting");
    }
    await this.#editPolicy(agentId, policy =>
      value
        ? withEntry(policy, "apps", site, value)
        : withoutEntry(policy, "apps", site)
    );
  }

  /**
   * Removes one site's download, upload or console permission, so Sval asks
   * again.
   *
   * @param {string} agentId
   * @param {"downloads"|"uploads"|"console"} kind
   * @param {string} site
   */
  async removeFilePermission(agentId, kind, site) {
    if (!FILE_KINDS.includes(kind)) {
      throw new Error("unknown file permission");
    }
    await this.#editPolicy(agentId, policy => withoutEntry(policy, kind, site));
  }

  /**
   * Sets whether the agent may use sites' tools: off, ask on every call, or
   * on (site-tools spec §4.1, layer B).
   *
   * @param {string} agentId
   * @param {"off"|"ask"|"on"} value
   */
  async setPageTools(agentId, value) {
    if (!PAGE_TOOLS_SETTINGS.includes(value)) {
      throw new Error("unknown setting for site tools");
    }
    await this.#editPolicy(agentId, policy => ({
      ...policy,
      pageTools: value,
    }));
  }

  /**
   * Records whether a site may offer its tools to the agent (layer C).
   * Denying a site also forgets the tools allowed on it.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {"allow"|"deny"} value
   */
  async setPageToolSite(agentId, site, value) {
    if (!PAGE_TOOL_SITE_ANSWERS.includes(value)) {
      throw new Error("unknown answer for site tools");
    }
    await this.#editPolicy(agentId, policy => {
      const edited = withEntry(policy, "pageToolSites", site, value);
      return value === "deny"
        ? withoutEntry(edited, "pageToolGrants", site)
        : edited;
    });
  }

  /**
   * Removes a site's answer about its tools, and the tools allowed on it, so
   * Sval asks again.
   *
   * @param {string} agentId
   * @param {string} site
   */
  async removePageToolSite(agentId, site) {
    await this.#editPolicy(agentId, policy =>
      withoutEntry(
        withoutEntry(policy, "pageToolSites", site),
        "pageToolGrants",
        site
      )
    );
  }

  /**
   * Remembers "Always allow this tool on this site" for one definition of
   * the tool (site-tools spec §4.3).
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} name
   * @param {string} hash The definition's hash, `definitionHash`.
   */
  async grantPageTool(agentId, site, name, hash) {
    if (typeof hash !== "string" || !GRANT_HASH.test(hash)) {
      throw new Error("unknown grant for site tools");
    }
    await this.#editPolicy(agentId, policy => {
      const tools = entriesOf(policy, "pageToolGrants")[String(site)];
      return withEntry(policy, "pageToolGrants", site, {
        ...(tools && typeof tools === "object" ? tools : {}),
        [String(name)]: hash,
      });
    });
  }

  /**
   * Forgets one remembered tool, so its next call asks again.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {string} name
   */
  async revokePageTool(agentId, site, name) {
    await this.#editPolicy(agentId, policy => {
      const tools = entriesOf(policy, "pageToolGrants")[String(site)];
      if (!tools || !Object.hasOwn(tools, String(name))) {
        return policy;
      }
      const left = Object.fromEntries(
        Object.entries(tools).filter(([key]) => key !== String(name))
      );
      return Object.keys(left).length
        ? withEntry(policy, "pageToolGrants", site, left)
        : withoutEntry(policy, "pageToolGrants", site);
    });
  }

  /**
   * Removes, in one write, the rules the policy holds for one site: its
   * level, its file and app permissions and, unless `keepTools`, its answer about
   * site tools and the tools remembered on it.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {object} [options]
   * @param {boolean} [options.keepTools] Leaves the site's tools rules.
   */
  async removeSite(agentId, site, { keepTools = false } = {}) {
    const maps = ["sites", ...FILE_KINDS, "apps"];
    if (!keepTools) {
      maps.push("pageToolSites", "pageToolGrants");
    }
    await this.#editPolicy(agentId, policy =>
      maps.reduce((edited, map) => withoutEntry(edited, map, site), policy)
    );
  }

  /**
   * Puts back, in one write, what {@link removeSite} took from one site: its
   * level, its file and app permissions, its answer about site tools and the tools
   * remembered on it. Every part is checked as its own setter checks it
   * before anything is written, so a rule with any part Sval cannot read is
   * refused whole.
   *
   * @param {string} agentId
   * @param {string} site
   * @param {object} rule Only the parts given are put back.
   * @param {string} [rule.level] One of `LEVELS`.
   * @param {string} [rule.downloads] One of `FILE_PERMISSIONS`.
   * @param {string|object} [rule.uploads] `"deny"`, or the folders entry
   *   `allowUploadFolders` writes.
   * @param {string} [rule.console] One of `FILE_PERMISSIONS`.
   * @param {string|object} [rule.apps] `"deny"`, or each scheme's answer.
   * @param {string} [rule.toolSite] One of `PAGE_TOOL_SITE_ANSWERS`.
   * @param {{[name: string]: string}} [rule.grants] Each remembered tool's
   *   definition hash, by the tool's name.
   */
  async restoreSite(agentId, site, rule) {
    const { level, toolSite, grants = {} } = rule;
    const tools = Object.entries(grants);
    if (
      (level && !LEVELS.includes(level)) ||
      FILE_KINDS.some(
        kind => rule[kind] && !filePermissionOf(kind, rule[kind])
      ) ||
      (rule.apps && !appsOf(rule.apps)) ||
      (toolSite && !PAGE_TOOL_SITE_ANSWERS.includes(toolSite)) ||
      tools.some(
        ([, hash]) => typeof hash !== "string" || !GRANT_HASH.test(hash)
      )
    ) {
      throw new Error("unreadable rule to restore");
    }
    await this.#editPolicy(agentId, policy => {
      let edited = level ? withEntry(policy, "sites", site, level) : policy;
      for (const kind of FILE_KINDS) {
        if (rule[kind]) {
          edited = withEntry(edited, kind, site, rule[kind]);
        }
      }
      if (rule.apps) {
        edited = withEntry(edited, "apps", site, appsOf(rule.apps));
      }
      if (toolSite) {
        edited = withEntry(edited, "pageToolSites", site, toolSite);
      }
      if (tools.length) {
        edited = withEntry(
          edited,
          "pageToolGrants",
          site,
          Object.fromEntries(tools)
        );
      }
      return edited;
    });
  }

  /**
   * Replaces an agent's policy with what `edit` makes of it. An unknown agent
   * is a no-op, and so is an edit that changes nothing. The record is
   * replaced rather than edited, because the commit's copy of the Map shares
   * its records with the live one.
   *
   * @param {string} agentId
   * @param {(policy: object) => object} edit Returns a new policy, keeping
   *   every field it does not change.
   */
  #editPolicy(agentId, edit) {
    return this.#commit(next => {
      const record = next.get(String(agentId));
      if (!record) {
        return { changed: false, result: undefined };
      }
      const policy = edit(record.policy ?? {});
      if (JSON.stringify(policy) === JSON.stringify(record.policy)) {
        return { changed: false, result: undefined };
      }
      next.set(String(agentId), { ...record, policy });
      return { changed: true, result: undefined };
    });
  }

  /**
   * Records that the user made workspace `workspaceId` isolated or shared, so
   * a workspace made later for the agent it belongs to is that kind too.
   * A workspace no agent holds is a no-op.
   *
   * @param {string} workspaceId
   * @param {boolean} isolated
   */
  async setIsolated(workspaceId, isolated) {
    await this.#commit(next => {
      for (const [agentId, record] of next) {
        if (
          Object.hasOwn(workspacesOf(record), workspaceId) &&
          (record.isolated === true) !== isolated
        ) {
          next.set(agentId, { ...record, isolated });
          return { changed: true, result: undefined };
        }
      }
      return { changed: false, result: undefined };
    });
  }

  /**
   * @returns {object[]} The workspaces unpaired agents left, as `agents()`
   *   lists an agent's.
   */
  keptWorkspaces() {
    return Array.from(this.#kept, ([workspaceId, e]) => ({
      workspaceId,
      ...e,
    }));
  }

  agents() {
    return Array.from(this.#agents, ([agentId, r]) => ({
      agentId,
      label: r.label,
      client: r.client ?? "",
      isolated: r.isolated === true,
      workspaces: Object.entries(workspacesOf(r)).map(([workspaceId, e]) => ({
        workspaceId,
        ...e,
      })),
    }));
  }
}
