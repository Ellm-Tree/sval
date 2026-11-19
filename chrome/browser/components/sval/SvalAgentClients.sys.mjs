/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Connecting the MCP clients people use most to Sval, from Agents settings
 * (sval-mcp-ships-with-sval spec §5). Each client gets one entry of Sval's,
 * named `sval`, whose command is the shim `shimPath` names: `sval-mcp` finds
 * its own profile, so the path is all an entry holds, and it stays the same
 * across Sval's updates. Any other client gets that path, and the standard JSON
 * for it, to copy.
 *
 * Sval writes only an entry the user asked for, and only its own. A client
 * with a command-line tool for its configuration is changed through it. A
 * file Sval edits keeps every key it did not write, and is replaced whole, so
 * it is never seen half written. Sval records the path it wrote for each
 * client, in the profile's `sval-agents` directory. An entry that still holds
 * that path after the install has moved is rewritten (`repair`). One the user
 * changed by hand is left alone, and reported as changed, or as broken when
 * its command file does not exist, until the user asks Sval to connect it.
 *
 * Every place a client keeps its configuration is checked against the
 * client's own documentation: Claude Code's `claude mcp`, Claude Desktop's
 * `claude_desktop_config.json`, the `[mcp_servers.<name>]` tables of
 * `~/.codex/config.toml` that the ChatGPT desktop app shares with Codex,
 * Cursor's `~/.cursor/mcp.json`, and Mistral Vibe's `[[mcp_servers]]` in
 * `~/.vibe/config.toml`.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

import { AGENT_DIR } from "moz-src:///browser/components/sval/SvalAgentConst.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  writePrivateFile:
    "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs",
});

const NAME = "sval";

/**
 * Where a desktop app's PATH, which is often only the system's, misses the
 * places command-line tools install themselves.
 *
 * @param {string} home
 * @returns {string[]}
 */
function toolDirs(home) {
  return AppConstants.platform == "win"
    ? []
    : [
        PathUtils.join(home, ".local", "bin"),
        PathUtils.join(home, ".claude", "local"),
        PathUtils.join(home, ".npm-global", "bin"),
        PathUtils.join(home, ".bun", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
}

/**
 * The machine as the clients see it. Tests give their own.
 *
 * @returns {object}
 */
export function defaultEnv() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return {
    platform: AppConstants.platform,
    home,
    appData: Services.env.get("APPDATA"),
    codexHome: Services.env.get("CODEX_HOME"),
    desktop: Services.env.get("XDG_CURRENT_DESKTOP"),
    wayland: Services.env.get("WAYLAND_DISPLAY"),
    shim: shimPath(),
    installShim,
    recordPath: PathUtils.join(PathUtils.profileDir, AGENT_DIR, "clients.json"),
    async find(name) {
      const path = [Services.env.get("PATH"), ...toolDirs(home)]
        .filter(Boolean)
        .join(AppConstants.platform == "win" ? ";" : ":");
      try {
        return await lazy.Subprocess.pathSearch(name, { PATH: path });
      } catch {
        return null;
      }
    },
    async run(command, args, environment = {}) {
      const proc = await lazy.Subprocess.call({
        command,
        arguments: args,
        environment,
        environmentAppend: true,
        stderr: "stdout",
      });
      const output = await proc.stdout.readString();
      const { exitCode } = await proc.wait();
      return { exitCode, output };
    },
  };
}

/**
 * The shim the package carries beside the browser binary.
 *
 * @returns {string}
 */
export function bundledShim() {
  const file = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent;
  file.append(AppConstants.platform == "win" ? "sval-mcp.exe" : "sval-mcp");
  return file.path;
}

/**
 * The shim an AI app is given to run. On macOS it is Sval's copy in its
 * application data directory (decision 2052), which `installShim` keeps.
 * Elsewhere it is the one beside the browser binary.
 *
 * @param {string} [platform]
 * @returns {string}
 */
export function shimPath(platform = AppConstants.platform) {
  if (platform != "macosx") {
    return bundledShim();
  }
  return PathUtils.join(
    Services.dirsvc.get("UAppData", Ci.nsIFile).path,
    "sval-mcp"
  );
}

/**
 * The file beside the copy that names the directory of the install it came
 * from, which the copy starts Sval from (`tools/sval-mcp/src/install.rs`,
 * `INSTALL_FILE`).
 *
 * @param {string} shim
 * @returns {string}
 */
const installFileOf = shim => `${shim}.install`;

/**
 * Makes the file at `path` hold `bytes`, unless it already does. The new file
 * is filled under another name in the same directory and moved into place, so
 * an app starting the shim finds the whole old file or the whole new one, and
 * a shim already running keeps the file it started from.
 *
 * Sval's Info.plist sets `LSFileQuarantineEnabled`, so macOS quarantines every
 * file Sval creates, and the first run of a quarantined program has Gatekeeper
 * assess it. The attribute comes off before the move, so the file at `path`
 * never has one.
 *
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {number} mode
 */
async function writeUnlessSame(path, bytes, mode) {
  try {
    const current = await IOUtils.read(path);
    if (
      current.length === bytes.length &&
      current.every((byte, i) => byte === bytes[i])
    ) {
      return;
    }
  } catch (err) {
    if (!DOMException.isInstance(err) || err.name !== "NotFoundError") {
      throw err;
    }
  }
  const suffix = crypto.getRandomValues(new Uint8Array(8)).toHex();
  const tmpPath = await IOUtils.createUniqueFile(
    PathUtils.parent(path),
    `${PathUtils.filename(path)}.${suffix}.tmp`,
    0o600
  );
  try {
    await IOUtils.write(tmpPath, bytes, { mode: "overwrite", flush: true });
    await IOUtils.setPermissions(tmpPath, mode, false);
    if (
      AppConstants.platform == "macosx" &&
      (await IOUtils.hasMacXAttr(tmpPath, "com.apple.quarantine"))
    ) {
      await IOUtils.delMacXAttr(tmpPath, "com.apple.quarantine");
    }
    await IOUtils.move(tmpPath, path);
  } catch (err) {
    await IOUtils.remove(tmpPath, { ignoreAbsent: true }).catch(() => {});
    throw err;
  }
}

/**
 * Copies the shim beside the browser binary to `shimPath()`, with the file
 * that names this install beside it, so no AI app runs a program inside
 * Sval.app (decision 2052).
 *
 * @param {object} [paths] A test's own.
 * @param {string} [paths.from]
 * @param {string} [paths.to]
 * @returns {Promise<boolean>} Whether there was a shim to copy.
 */
export async function installShim({
  from = bundledShim(),
  to = shimPath(),
} = {}) {
  let bytes;
  try {
    bytes = await IOUtils.read(from);
  } catch (err) {
    // A dev build carries a shim only once `stage-sval-mcp.sh` has run.
    if (DOMException.isInstance(err) && err.name === "NotFoundError") {
      return false;
    }
    throw err;
  }
  await IOUtils.makeDirectory(PathUtils.parent(to), { ignoreExisting: true });
  await writeUnlessSame(
    installFileOf(to),
    new TextEncoder().encode(PathUtils.parent(from)),
    0o644
  );
  await writeUnlessSame(to, bytes, 0o755);
  return true;
}

/**
 * The standard `mcpServers` JSON for `shim`, which most clients that run
 * local servers accept.
 *
 * @param {string} shim
 * @returns {string}
 */
export function snippet(shim) {
  return JSON.stringify({ mcpServers: { [NAME]: { command: shim } } }, null, 2);
}

// A TOML basic string is a JSON string for any path: both escape `\` and `"`
// the same way.
const tomlString = value => JSON.stringify(value);

/**
 * The value of `key` in one TOML table's lines, when it is a basic string.
 *
 * @param {string[]} lines
 * @param {string} key
 * @returns {string|null}
 */
function tomlValue(lines, key) {
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(".*")\\s*$`));
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const isTableHeader = line => /^\s*\[/.test(line);

/**
 * Splits TOML text into the lines before its first table and its tables,
 * each the header line and the lines up to the next.
 *
 * @param {string} text
 * @returns {{top: string[], tables: string[][]}}
 */
function tomlTables(text) {
  const top = [];
  const tables = [];
  for (const line of text.split("\n")) {
    if (isTableHeader(line)) {
      tables.push([line]);
    } else if (tables.length) {
      tables.at(-1).push(line);
    } else {
      top.push(line);
    }
  }
  return { top, tables };
}

const joinToml = (top, tables) =>
  [...top, ...tables.flat()].join("\n").replace(/\n*$/, "\n");

// A bare or quoted TOML key, as a pattern.
const tomlKey = name => `\\s*(?:${name}|"${name}"|'${name}')\\s*`;

/**
 * Whether `text` defines `mcp_servers.sval` in a spelling other than the
 * plain `[mcp_servers.sval]` header the editor below reads: a quoted header,
 * a dotted key, or an inline table. TOML refuses a key defined twice, so a
 * table added beside one of these would leave the client unable to load its
 * whole configuration.
 *
 * @param {string} text
 * @returns {boolean}
 */
function codexSvalElsewhere(text) {
  const servers = tomlKey("mcp_servers");
  const sval = tomlKey("sval");
  const header = new RegExp(`^\\s*\\[${servers}\\.${sval}[\\].]`);
  const plain = /^\s*\[\s*mcp_servers\.sval\s*[\].]/;
  const dotted = new RegExp(`^${servers}\\.${sval}[.=]`);
  const inline = new RegExp(`^${servers}=.*[{,]${sval}[.=]`);
  const serversTable = new RegExp(`^\\s*\\[${servers}\\]`);
  const inServers = new RegExp(`^${sval}[.=]`);
  const { top, tables } = tomlTables(text);
  return (
    top.some(line => dotted.test(line) || inline.test(line)) ||
    tables.some(
      ([head, ...lines]) =>
        (header.test(head) && !plain.test(head)) ||
        (serversTable.test(head) && lines.some(line => inServers.test(line)))
    )
  );
}

/**
 * Codex's, and the ChatGPT desktop app's, `[mcp_servers.sval]` table. A
 * configuration that defines it in another spelling is left to the user:
 * reading it throws, which settings shows as one Sval leaves as it is, and
 * so does writing it.
 */
export const CodexToml = {
  isOurs(table) {
    return (
      /^\s*\[\s*mcp_servers\.sval\s*\]/.test(table[0]) ||
      /^\s*\[\s*mcp_servers\.sval\./.test(table[0])
    );
  },
  command(text) {
    if (codexSvalElsewhere(text)) {
      throw new Error(
        "it defines mcp_servers.sval in a form Sval does not edit"
      );
    }
    const table = tomlTables(text).tables.find(t =>
      /^\s*\[\s*mcp_servers\.sval\s*\]/.test(t[0])
    );
    return table ? tomlValue(table, "command") : null;
  },
  without(text) {
    const { top, tables } = tomlTables(text);
    return joinToml(
      top,
      tables.filter(t => !this.isOurs(t))
    );
  },
  with(text, shim) {
    if (codexSvalElsewhere(text)) {
      throw new Error(
        "it defines mcp_servers.sval in a form Sval does not edit"
      );
    }
    const kept = this.without(text).replace(/\n*$/, "");
    return `${kept ? kept + "\n\n" : ""}[mcp_servers.${NAME}]\ncommand = ${tomlString(shim)}\n`;
  },
};

/**
 * Mistral Vibe's `[[mcp_servers]]` entry named `sval`.
 */
export const VibeToml = {
  isOurs(table) {
    return (
      /^\s*\[\[\s*mcp_servers\s*\]\]/.test(table[0]) &&
      tomlValue(table, "name") === NAME
    );
  },
  command(text) {
    const table = tomlTables(text).tables.find(t => this.isOurs(t));
    return table ? tomlValue(table, "command") : null;
  },
  without(text) {
    const { top, tables } = tomlTables(text);
    return joinToml(
      top,
      tables.filter(t => !this.isOurs(t))
    );
  },
  with(text, shim) {
    // Vibe's default configuration holds an empty `mcp_servers = []`, and
    // TOML refuses an array of tables beside an array of the same name.
    const { top, tables } = tomlTables(this.without(text));
    const kept = joinToml(
      top.filter(line => !/^\s*mcp_servers\s*=\s*\[\s*\]\s*$/.test(line)),
      tables
    ).replace(/\n*$/, "");
    return (
      `${kept ? kept + "\n\n" : ""}[[mcp_servers]]\n` +
      `name = ${tomlString(NAME)}\n` +
      `transport = "stdio"\n` +
      `command = ${tomlString(shim)}\n` +
      `args = []\n`
    );
  },
};

/**
 * Replaces the file at `path` with `text` whole, through a file beside it
 * (`writePrivateFile`), so the client never reads it half written. A
 * client's configuration can hold other servers' tokens, and the user
 * decides who may read it, so the file keeps its mode, and a new one is made
 * 0600. A path that is a symbolic link, as a managed dotfile often is, is
 * written at the file it leads to, which `nsIFile.normalize` finds
 * (`realpath` on macOS and Linux), so the link stays.
 *
 * @param {string} path
 * @param {string} text
 */
async function replaceFile(path, text) {
  let target = path;
  let mode = 0o600;
  if (await IOUtils.exists(path)) {
    const file = new lazy.FileUtils.File(path);
    file.normalize();
    target = file.path;
    mode = (await IOUtils.stat(target)).permissions;
  }
  await IOUtils.makeDirectory(PathUtils.parent(target), {
    ignoreExisting: true,
  });
  await lazy.writePrivateFile(target, new TextEncoder().encode(text), {
    mode,
  });
}

async function readText(path) {
  try {
    return await IOUtils.readUTF8(path);
  } catch (err) {
    if (DOMException.isInstance(err) && err.name === "NotFoundError") {
      return "";
    }
    throw err;
  }
}

/**
 * A client whose configuration is a JSON file with an `mcpServers` object.
 *
 * @param {(env: object) => string|null} pathOf
 * @returns {object}
 */
function jsonFile(pathOf) {
  const read = async env => {
    const text = await readText(pathOf(env));
    if (!text.trim()) {
      return {};
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("its configuration is not a JSON object");
    }
    return value;
  };
  return {
    async available(env) {
      const path = pathOf(env);
      return !!path && (await IOUtils.exists(PathUtils.parent(path)));
    },
    async command(env) {
      const command = (await read(env)).mcpServers?.[NAME]?.command;
      return typeof command === "string" ? command : null;
    },
    async connect(env, shim) {
      const config = await read(env);
      const servers =
        config.mcpServers && typeof config.mcpServers === "object"
          ? config.mcpServers
          : {};
      servers[NAME] = { command: shim };
      config.mcpServers = servers;
      await replaceFile(pathOf(env), JSON.stringify(config, null, 2) + "\n");
    },
    async disconnect(env) {
      const config = await read(env);
      if (config.mcpServers?.[NAME]) {
        delete config.mcpServers[NAME];
        await replaceFile(pathOf(env), JSON.stringify(config, null, 2) + "\n");
      }
    },
  };
}

/**
 * A client whose configuration is a TOML file, changed through `kind`.
 *
 * @param {(env: object) => string} pathOf
 * @param {object} kind `CodexToml` or `VibeToml`.
 * @returns {object}
 */
function tomlFile(pathOf, kind) {
  return {
    async available(env) {
      return IOUtils.exists(PathUtils.parent(pathOf(env)));
    },
    async command(env) {
      return kind.command(await readText(pathOf(env)));
    },
    async connect(env, shim) {
      await replaceFile(
        pathOf(env),
        kind.with(await readText(pathOf(env)), shim)
      );
    },
    async disconnect(env) {
      const text = await readText(pathOf(env));
      if (kind.command(text) !== null) {
        await replaceFile(pathOf(env), kind.without(text));
      }
    },
  };
}

const claudeDesktopConfig = env => {
  if (env.platform == "macosx") {
    return PathUtils.join(
      env.home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  if (env.platform == "win" && env.appData) {
    return PathUtils.join(env.appData, "Claude", "claude_desktop_config.json");
  }
  // Claude Desktop is for macOS and Windows only.
  return null;
};

/**
 * Where `claude mcp` writes when Sval runs it. Claude Code keeps a user's
 * servers in `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, and
 * in `~/.claude.json` otherwise, the file `command` reads. A Sval started
 * from a shell that sets the variable would otherwise write where it never
 * reads. Subprocess removes a variable given as null.
 */
const CLAUDE_DEFAULT_CONFIG = { CLAUDE_CONFIG_DIR: null };

/** Claude Code keeps a user's servers in `~/.claude.json`, which it owns. */
const claudeCode = {
  async available(env) {
    return !!(await env.find("claude"));
  },
  async command(env) {
    try {
      const config = JSON.parse(
        await readText(PathUtils.join(env.home, ".claude.json"))
      );
      const command = config?.mcpServers?.[NAME]?.command;
      return typeof command === "string" ? command : null;
    } catch {
      return null;
    }
  },
  async connect(env, shim) {
    const claude = await env.find("claude");
    // An entry already there is replaced, as for every other client.
    await env.run(
      claude,
      ["mcp", "remove", "--scope", "user", NAME],
      CLAUDE_DEFAULT_CONFIG
    );
    const { exitCode, output } = await env.run(
      claude,
      ["mcp", "add", "--scope", "user", NAME, "--", shim],
      CLAUDE_DEFAULT_CONFIG
    );
    if (exitCode !== 0) {
      throw new Error(`claude mcp add exited ${exitCode}: ${output.trim()}`);
    }
  },
  async disconnect(env) {
    const claude = await env.find("claude");
    await env.run(
      claude,
      ["mcp", "remove", "--scope", "user", NAME],
      CLAUDE_DEFAULT_CONFIG
    );
  },
};

const codexHome = env => env.codexHome || PathUtils.join(env.home, ".codex");

/**
 * The clients Agents settings connects, in the order it lists them.
 */
export const CLIENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    restart: "Start a new Claude Code session",
    ...claudeCode,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    restart: "Quit and reopen Claude Desktop",
    ...jsonFile(claudeDesktopConfig),
  },
  {
    id: "chatgpt",
    label: "ChatGPT desktop app and Codex",
    restart: "Restart the ChatGPT app or Codex",
    ...tomlFile(
      env => PathUtils.join(codexHome(env), "config.toml"),
      CodexToml
    ),
  },
  {
    id: "cursor",
    label: "Cursor",
    restart: "Restart Cursor",
    ...jsonFile(env => PathUtils.join(env.home, ".cursor", "mcp.json")),
  },
  {
    id: "mistral",
    label: "Mistral Vibe",
    restart: "Start a new Vibe session",
    ...tomlFile(
      env => PathUtils.join(env.home, ".vibe", "config.toml"),
      VibeToml
    ),
  },
];

async function readRecords(env) {
  try {
    return await IOUtils.readJSON(env.recordPath);
  } catch {
    return {};
  }
}

async function writeRecords(env, records) {
  await replaceFile(env.recordPath, JSON.stringify(records));
}

/**
 * Whether `client` holds Sval's entry, and whose it is: `connected` to this
 * install's shim, `moved` when it still holds the path Sval wrote for an
 * install that has since moved, `broken` when it holds a path Sval did not
 * write to a file that does not exist, `changed` when it holds any other
 * command Sval did not write, and `none`. A command that is a bare name is
 * found through the client's own PATH, which Sval cannot see, so it is
 * never judged broken.
 *
 * @param {string|null} command The entry's command.
 * @param {string|undefined} recorded The path Sval wrote.
 * @param {string} shim
 * @returns {Promise<string>}
 */
async function stateOf(command, recorded, shim) {
  if (command === null) {
    return "none";
  }
  if (command === shim) {
    return "connected";
  }
  if (command === recorded) {
    return "moved";
  }
  return PathUtils.isAbsolute(command) && !(await IOUtils.exists(command))
    ? "broken"
    : "changed";
}

let testEnv = null;
const envNow = () => testEnv ?? defaultEnv();

export const SvalAgentClients = {
  /**
   * Has every call without an env of its own use `env`, a test's temporary
   * machine, until it is called with null, so no test reads or writes the
   * real apps' settings.
   *
   * @param {object|null} env
   */
  setEnvForTests(env) {
    testEnv = env;
  },

  /**
   * Whether a Sval that `sval-mcp` starts comes to the front over the window
   * the user is in. GNOME on Wayland focuses every new window, whoever
   * started it, unless its `focus-new-windows` setting is `strict`
   * (Ubuntu 24.04). KDE on Wayland does the same, with no setting that
   * changes it for a Wayland window, so there is nothing to tell its users.
   *
   * @param {object} [env]
   * @returns {boolean}
   */
  opensInFrontOnGnome(env = envNow()) {
    return (
      env.platform == "linux" &&
      !!env.wayland &&
      (env.desktop ?? "").split(":").includes("GNOME")
    );
  },

  /**
   * Every client, with whether it is on this machine and what its entry is.
   *
   * @param {object} [env]
   * @returns {Promise<Array<{id, label, restart, available, state}>>}
   */
  async list(env = envNow()) {
    const { shim } = env;
    const records = await readRecords(env);
    return Promise.all(
      CLIENTS.map(async client => {
        const available = await client.available(env).catch(() => false);
        let state = "none";
        let problem = null;
        if (available) {
          try {
            state = await stateOf(
              await client.command(env),
              records[client.id],
              shim
            );
          } catch (err) {
            problem = err.message;
          }
        }
        const { id, label, restart } = client;
        return { id, label, restart, available, state, problem };
      })
    );
  },

  /**
   * Writes Sval's entry into the client `id`, and records the path written.
   *
   * @param {string} id
   * @param {object} [env]
   */
  async connect(id, env = envNow()) {
    const client = CLIENTS.find(c => c.id === id);
    const { shim } = env;
    await client.connect(env, shim);
    const records = await readRecords(env);
    records[id] = shim;
    await writeRecords(env, records);
  },

  /**
   * Removes Sval's entry from the client `id`.
   *
   * @param {string} id
   * @param {object} [env]
   */
  async disconnect(id, env = envNow()) {
    const client = CLIENTS.find(c => c.id === id);
    await client.disconnect(env);
    const records = await readRecords(env);
    delete records[id];
    await writeRecords(env, records);
  },

  /**
   * Rewrites every entry that still holds the path Sval wrote for an install
   * that has moved, and leaves the rest as they are.
   *
   * @param {object} [env]
   * @returns {Promise<string[]>} the ids rewritten.
   */
  async repair(env = envNow()) {
    const rewritten = [];
    for (const client of await this.list(env)) {
      if (client.state === "moved") {
        await this.connect(client.id, env);
        rewritten.push(client.id);
      }
    }
    return rewritten;
  },

  /**
   * What each start of Sval does for the AI apps: on macOS it refreshes the
   * shim they run (`installShim`), then it rewrites the entries Sval wrote for
   * an install that has moved, the in-bundle shim among them. Without a
   * copy every entry is left as it is, since a rewritten one would name a
   * file that is not there.
   *
   * @param {object} [env]
   * @returns {Promise<string[]>} the ids rewritten.
   */
  async startup(env = envNow()) {
    if (env.platform == "macosx" && !(await env.installShim())) {
      return [];
    }
    return this.repair(env);
  },

  shimPath,
  snippet,
};
