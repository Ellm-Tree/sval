/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Connecting MCP clients to Sval (sval-mcp-ships-with-sval spec §5): each
 * client's own configuration gets Sval's entry and nothing else of it
 * changes, a client's tool is run for it where it has one, and an entry Sval
 * wrote is repaired once the install moves, while one the user changed, or
 * one whose command is gone, is left alone. Each task's machine is a temporary home of its own.
 */

const {
  SvalAgentClients,
  CodexToml,
  VibeToml,
  bundledShim,
  installShim,
  shimPath,
  snippet,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentClients.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);

do_get_profile();

// Sval's application data directory, which xpcshell does not provide.
const APP_DATA = PathUtils.join(PathUtils.profileDir, "app-data");
Services.dirsvc.QueryInterface(Ci.nsIDirectoryService).registerProvider({
  QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
  getFile(prop, persistent) {
    if (prop != "UAppData") {
      return null;
    }
    persistent.value = true;
    return new FileUtils.File(APP_DATA);
  },
});

/**
 * A machine with only the clients `has` names installed, as their
 * configuration directories, and a `claude` tool that keeps its servers in
 * `$CLAUDE_CONFIG_DIR/.claude.json` when that is set and `~/.claude.json`
 * otherwise, as Claude Code does.
 *
 * @param {string[]} has
 * @param {object} [options]
 * @param {string} [options.claudeConfigDir] The `CLAUDE_CONFIG_DIR` Sval was
 *   started with, which a tool it runs inherits.
 * @returns {Promise<object>} an env, and `ran`, the tool calls it saw.
 */
async function machine(has, { claudeConfigDir = null } = {}) {
  const home = await makeTempDir("sval-clients-home");
  const appData = PathUtils.join(home, "AppData");
  const dirs = {
    "claude-desktop":
      AppConstants.platform == "win"
        ? PathUtils.join(appData, "Claude")
        : PathUtils.join(home, "Library", "Application Support", "Claude"),
    chatgpt: PathUtils.join(home, ".codex"),
    cursor: PathUtils.join(home, ".cursor"),
    mistral: PathUtils.join(home, ".vibe"),
  };
  for (const id of has) {
    if (dirs[id]) {
      await IOUtils.makeDirectory(dirs[id], { createAncestors: true });
    }
  }
  const ran = [];
  const env = {
    platform: AppConstants.platform == "win" ? "win" : "macosx",
    home,
    appData,
    codexHome: null,
    shim: shimPath(),
    installShim: async () => true,
    recordPath: PathUtils.join(home, "sval-clients.json"),
    async find(name) {
      return name === "claude" && has.includes("claude-code")
        ? "/fake/claude"
        : null;
    },
    async run(command, args, environment = {}) {
      ran.push([command, ...args]);
      const dir =
        "CLAUDE_CONFIG_DIR" in environment
          ? environment.CLAUDE_CONFIG_DIR
          : claudeConfigDir;
      const claudeJson = PathUtils.join(dir ?? home, ".claude.json");
      const config = (await IOUtils.exists(claudeJson))
        ? await IOUtils.readJSON(claudeJson)
        : {};
      config.mcpServers ??= {};
      if (args[1] === "add") {
        config.mcpServers[args[4]] = { command: args[6] };
      } else if (args[1] === "remove") {
        delete config.mcpServers[args[4]];
      }
      await IOUtils.writeJSON(claudeJson, config);
      return { exitCode: 0, output: "" };
    },
  };
  return { env, ran, dirs, home };
}

const stateOf = async (env, id) =>
  (await SvalAgentClients.list(env)).find(c => c.id === id);

add_task(async function only_installed_clients_can_be_connected() {
  const { env } = await machine(["cursor"]);
  const clients = await SvalAgentClients.list(env);
  Assert.deepEqual(
    clients.map(c => [c.id, c.available, c.state]),
    [
      ["claude-code", false, "none"],
      ["claude-desktop", false, "none"],
      ["chatgpt", false, "none"],
      ["cursor", true, "none"],
      ["mistral", false, "none"],
    ]
  );
});

add_task(async function a_json_client_gets_svals_entry_and_keeps_the_rest() {
  const { env, dirs } = await machine(["cursor"]);
  const file = PathUtils.join(dirs.cursor, "mcp.json");
  await IOUtils.writeJSON(file, {
    mcpServers: { other: { command: "/bin/other", args: ["-x"] } },
    theme: "dark",
  });
  await SvalAgentClients.connect("cursor", env);
  Assert.deepEqual(await IOUtils.readJSON(file), {
    mcpServers: {
      other: { command: "/bin/other", args: ["-x"] },
      sval: { command: shimPath() },
    },
    theme: "dark",
  });
  Assert.equal((await stateOf(env, "cursor")).state, "connected");

  await SvalAgentClients.disconnect("cursor", env);
  Assert.deepEqual(await IOUtils.readJSON(file), {
    mcpServers: { other: { command: "/bin/other", args: ["-x"] } },
    theme: "dark",
  });
  Assert.equal((await stateOf(env, "cursor")).state, "none");
});

/**
 * A client's configuration can hold other servers' tokens, so writing Sval's
 * entry keeps who may read it: the file's mode stays, a new file is the
 * owner's alone, and a symlinked file, as managed dotfiles are, is written
 * where the link leads and stays a link.
 */
add_task(
  // Windows keeps files private by their directory's ACL, and symlinks need
  // a privilege there.
  { skip_if: () => AppConstants.platform == "win" },
  async function a_config_keeps_its_mode_and_its_link() {
    const { env, dirs } = await machine(["cursor", "claude-desktop"]);
    const file = PathUtils.join(dirs.cursor, "mcp.json");
    await IOUtils.writeJSON(file, { mcpServers: {} });
    await IOUtils.setPermissions(file, 0o640, false);
    await SvalAgentClients.connect("cursor", env);
    Assert.equal((await IOUtils.stat(file)).permissions, 0o640, "kept");

    await SvalAgentClients.connect("claude-desktop", env);
    const made = PathUtils.join(
      dirs["claude-desktop"],
      "claude_desktop_config.json"
    );
    Assert.equal((await IOUtils.stat(made)).permissions, 0o600, "made 0600");

    const target = PathUtils.join(env.home, "dotfiles-mcp.json");
    await IOUtils.writeJSON(target, { mcpServers: {} });
    await IOUtils.setPermissions(target, 0o600, false);
    await IOUtils.remove(file);
    const ln = await Subprocess.pathSearch("ln");
    const proc = await Subprocess.call({
      command: ln,
      arguments: ["-s", target, file],
    });
    Assert.equal((await proc.wait()).exitCode, 0, "the symlink was made");
    await SvalAgentClients.connect("cursor", env);
    Assert.ok(new FileUtils.File(file).isSymlink(), "the link stays a link");
    Assert.deepEqual((await IOUtils.readJSON(target)).mcpServers, {
      sval: { command: shimPath() },
    });
    Assert.equal((await IOUtils.stat(target)).permissions, 0o600);
  }
);

add_task(async function claude_desktop_gets_its_config_file_made() {
  const { env, dirs } = await machine(["claude-desktop"]);
  await SvalAgentClients.connect("claude-desktop", env);
  Assert.deepEqual(
    await IOUtils.readJSON(
      PathUtils.join(dirs["claude-desktop"], "claude_desktop_config.json")
    ),
    { mcpServers: { sval: { command: shimPath() } } }
  );
});

add_task(async function a_broken_config_is_reported_and_left_as_it_is() {
  const { env, dirs } = await machine(["cursor"]);
  const file = PathUtils.join(dirs.cursor, "mcp.json");
  await IOUtils.writeUTF8(file, "{ not json");
  const cursor = await stateOf(env, "cursor");
  Assert.ok(cursor.problem, "the problem is reported");
  await Assert.rejects(SvalAgentClients.connect("cursor", env), /JSON/);
  Assert.equal(await IOUtils.readUTF8(file), "{ not json", "untouched");
});

add_task(async function claude_code_is_changed_through_its_own_tool() {
  const { env, ran } = await machine(["claude-code"]);
  await SvalAgentClients.connect("claude-code", env);
  Assert.deepEqual(ran, [
    ["/fake/claude", "mcp", "remove", "--scope", "user", "sval"],
    ["/fake/claude", "mcp", "add", "--scope", "user", "sval", "--", shimPath()],
  ]);
  Assert.equal((await stateOf(env, "claude-code")).state, "connected");
  await SvalAgentClients.disconnect("claude-code", env);
  Assert.deepEqual(ran.at(-1), [
    "/fake/claude",
    "mcp",
    "remove",
    "--scope",
    "user",
    "sval",
  ]);
  Assert.equal((await stateOf(env, "claude-code")).state, "none");
});

add_task(async function claude_code_is_connected_in_its_default_settings() {
  const elsewhere = await makeTempDir("sval-clients-claude-config");
  const { env, home } = await machine(["claude-code"], {
    claudeConfigDir: elsewhere,
  });
  await SvalAgentClients.connect("claude-code", env);
  Assert.equal((await stateOf(env, "claude-code")).state, "connected");
  Assert.deepEqual(
    (await IOUtils.readJSON(PathUtils.join(home, ".claude.json"))).mcpServers,
    { sval: { command: shimPath() } }
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(elsewhere, ".claude.json"))),
    "the CLAUDE_CONFIG_DIR Sval started with is left alone"
  );
});

add_task(function codex_gets_a_table_of_its_own_and_keeps_the_rest() {
  const before = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "x"]\n`;
  const shim = "C:\\Program Files\\Sval\\sval-mcp.exe";
  const after = CodexToml.with(before, shim);
  Assert.equal(
    after,
    `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "x"]\n\n[mcp_servers.sval]\ncommand = "C:\\\\Program Files\\\\Sval\\\\sval-mcp.exe"\n`
  );
  Assert.equal(CodexToml.command(after), shim, "a Windows path round-trips");
  const again = CodexToml.with(
    after + `\n[mcp_servers.sval.env]\nX = "1"\n`,
    "/b"
  );
  Assert.equal(
    (again.match(/\[mcp_servers\.sval/g) ?? []).length,
    1,
    "sval's table, and its subtables, are replaced"
  );
  Assert.equal(CodexToml.without(after).trim(), before.trim());
});

/**
 * TOML refuses a key defined twice, so a Codex configuration that already
 * defines mcp_servers.sval in a spelling the editor does not read is
 * reported and left as it is, never given a second table.
 */
add_task(async function codex_with_sval_spelled_another_way_is_left_alone() {
  const spellings = [
    `[mcp_servers."sval"]\ncommand = "/a"\n`,
    `[ mcp_servers.'sval' ]\ncommand = "/a"\n`,
    `[mcp_servers."sval".env]\nX = "1"\n`,
    `mcp_servers.sval.command = "/a"\n`,
    `mcp_servers = { sval = { command = "/a" } }\n`,
    `mcp_servers = { other = { command = "/b" }, "sval" = { command = "/a" } }\n`,
    `[mcp_servers]\nsval.command = "/a"\n`,
    `[mcp_servers]\nsval = { command = "/a" }\n`,
  ];
  for (const text of spellings) {
    Assert.throws(() => CodexToml.command(text), /mcp_servers\.sval/, text);
    Assert.throws(() => CodexToml.with(text, "/s"), /mcp_servers\.sval/, text);
  }
  for (const text of [
    `[mcp_servers.svalbard]\ncommand = "/a"\n`,
    `[mcp_servers]\nother.command = "/a"\n`,
    `[mcp_servers.other]\nsval = "1"\n`,
  ]) {
    Assert.equal(CodexToml.command(text), null, text);
  }

  const { env, dirs } = await machine(["chatgpt"]);
  const file = PathUtils.join(dirs.chatgpt, "config.toml");
  await IOUtils.writeUTF8(file, spellings[0]);
  const chatgpt = await stateOf(env, "chatgpt");
  Assert.ok(chatgpt.problem, "the problem is reported");
  await Assert.rejects(
    SvalAgentClients.connect("chatgpt", env),
    /mcp_servers\.sval/
  );
  Assert.equal(await IOUtils.readUTF8(file), spellings[0], "untouched");
});

add_task(function vibe_gets_an_entry_named_sval_and_keeps_the_rest() {
  const before = `active_model = "devstral"\nmcp_servers = []\n`;
  const after = VibeToml.with(before, "/opt/sval/sval-mcp");
  Assert.equal(
    after,
    `active_model = "devstral"\n\n[[mcp_servers]]\nname = "sval"\ntransport = "stdio"\ncommand = "/opt/sval/sval-mcp"\nargs = []\n`,
    "the empty mcp_servers array goes, since TOML refuses it beside a table array"
  );
  const theirs = `[[mcp_servers]]\nname = "fetch"\ntransport = "stdio"\ncommand = "uvx"\n`;
  const both = VibeToml.with(theirs, "/opt/sval/sval-mcp");
  Assert.ok(both.startsWith(theirs), "another server's entry is kept");
  Assert.equal(VibeToml.command(both), "/opt/sval/sval-mcp");
  Assert.equal(VibeToml.without(both), theirs);
});

add_task(async function a_moved_install_is_repaired_and_a_hand_edit_is_not() {
  const { env, dirs } = await machine(["cursor", "chatgpt"]);
  const cursorFile = PathUtils.join(dirs.cursor, "mcp.json");
  const codexFile = PathUtils.join(dirs.chatgpt, "config.toml");
  // What Sval wrote for an install that has since moved.
  await IOUtils.writeJSON(cursorFile, {
    mcpServers: { sval: { command: "/old/sval-mcp" } },
  });
  const mine = PathUtils.join(env.home, "mine-sval-mcp");
  await IOUtils.writeUTF8(mine, "");
  await IOUtils.writeUTF8(
    codexFile,
    `[mcp_servers.sval]\ncommand = ${JSON.stringify(mine)}\n`
  );
  await IOUtils.writeJSON(env.recordPath, {
    cursor: "/old/sval-mcp",
    chatgpt: "/old/sval-mcp",
  });
  Assert.equal((await stateOf(env, "cursor")).state, "moved");
  Assert.equal((await stateOf(env, "chatgpt")).state, "changed");

  Assert.deepEqual(await SvalAgentClients.repair(env), ["cursor"]);
  Assert.equal(
    (await IOUtils.readJSON(cursorFile)).mcpServers.sval.command,
    shimPath(),
    "sval's own entry follows the install"
  );
  Assert.equal(
    CodexToml.command(await IOUtils.readUTF8(codexFile)),
    mine,
    "the user's entry is theirs"
  );
});

/**
 * An entry Sval has no record of writing, whose command file does not exist,
 * is broken: the client fails to start it. Startup leaves it as it is, since
 * Sval did not write it, and Connect points it at this install's shim.
 */
add_task(async function an_entry_whose_command_is_gone_is_broken() {
  const { env, dirs } = await machine(["cursor", "claude-code"]);
  const cursorFile = PathUtils.join(dirs.cursor, "mcp.json");
  const gone = PathUtils.join(env.home, "gone", "sval-mcp");
  await IOUtils.writeJSON(cursorFile, {
    mcpServers: { sval: { command: gone } },
  });
  await IOUtils.writeJSON(PathUtils.join(env.home, ".claude.json"), {
    mcpServers: { sval: { command: gone } },
  });
  Assert.equal((await stateOf(env, "cursor")).state, "broken");
  Assert.equal((await stateOf(env, "claude-code")).state, "broken");

  Assert.deepEqual(await SvalAgentClients.repair(env), [], "nothing rewritten");
  Assert.equal(
    (await IOUtils.readJSON(cursorFile)).mcpServers.sval.command,
    gone,
    "startup leaves an entry Sval did not write"
  );

  await SvalAgentClients.connect("claude-code", env);
  Assert.equal((await stateOf(env, "claude-code")).state, "connected");
});

add_task(async function a_recorded_entry_whose_command_is_gone_has_moved() {
  const { env, dirs } = await machine(["cursor"]);
  const gone = PathUtils.join(env.home, "gone", "sval-mcp");
  await IOUtils.writeJSON(PathUtils.join(dirs.cursor, "mcp.json"), {
    mcpServers: { sval: { command: gone } },
  });
  await IOUtils.writeJSON(env.recordPath, { cursor: gone });
  Assert.equal((await stateOf(env, "cursor")).state, "moved");
});

add_task(async function a_command_found_on_the_path_is_not_judged() {
  const { env, dirs } = await machine(["cursor"]);
  await IOUtils.writeJSON(PathUtils.join(dirs.cursor, "mcp.json"), {
    mcpServers: { sval: { command: "sval-mcp" } },
  });
  Assert.equal((await stateOf(env, "cursor")).state, "changed");
});

add_task(function the_copy_snippet_is_the_standard_mcpServers_json() {
  Assert.deepEqual(JSON.parse(snippet("/x/sval-mcp")), {
    mcpServers: { sval: { command: "/x/sval-mcp" } },
  });
});

add_task(function only_gnome_on_wayland_is_told_sval_opens_in_front() {
  const on = (platform, desktop, wayland) =>
    SvalAgentClients.opensInFrontOnGnome({ platform, desktop, wayland });
  Assert.ok(on("linux", "ubuntu:GNOME", "wayland-0"), "Ubuntu's GNOME");
  Assert.ok(on("linux", "GNOME", "wayland-0"), "GNOME");
  Assert.ok(!on("linux", "ubuntu:GNOME", undefined), "GNOME on X11");
  Assert.ok(!on("linux", "KDE", "wayland-0"), "KDE");
  Assert.ok(!on("macosx", "GNOME", "wayland-0"), "another platform");
});

/**
 * On macOS an AI app runs Sval's copy of the shim in its application data
 * directory, so no app starts a program inside Sval.app while Finder may be
 * replacing it (decision 2052). Elsewhere it runs the one beside the browser.
 */
add_task(function macos_apps_run_the_copy_outside_the_bundle() {
  Assert.equal(shimPath("macosx"), PathUtils.join(APP_DATA, "sval-mcp"));
  Assert.equal(shimPath("linux"), bundledShim());
  Assert.equal(shimPath("win"), bundledShim());
});

/**
 * A bundle's shim and where its copy goes, in a temporary directory.
 *
 * @param {string} build What the bundle's shim holds.
 * @returns {Promise<{from: string, to: string, install: string}>}
 */
async function bundleAndCopy(build) {
  const root = await makeTempDir("sval-shim-copy");
  const install = PathUtils.join(root, "Sval.app", "Contents", "MacOS");
  await IOUtils.makeDirectory(install, { createAncestors: true });
  const from = PathUtils.join(install, "sval-mcp");
  await IOUtils.writeUTF8(from, build);
  const to = PathUtils.join(root, "Application Support", "Sval", "sval-mcp");
  return { from, to, install };
}

add_task(async function the_copy_runs_and_names_its_install() {
  const { from, to, install } = await bundleAndCopy("build 1");
  await installShim({ from, to });
  Assert.equal(await IOUtils.readUTF8(to), "build 1");
  if (AppConstants.platform != "win") {
    Assert.equal(
      (await IOUtils.stat(to)).permissions & 0o111,
      0o111,
      "an app can run it"
    );
  }
  Assert.equal(
    await IOUtils.readUTF8(`${to}.install`),
    install,
    "the copy starts the Sval it came from"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(PathUtils.parent(to)))
      .map(PathUtils.filename)
      .sort(),
    ["sval-mcp", "sval-mcp.install"].sort(),
    "nothing else is left beside it"
  );
});

add_task(async function a_build_without_a_shim_has_nothing_to_copy() {
  const { from, to } = await bundleAndCopy("build 1");
  await IOUtils.remove(from);
  Assert.equal(await installShim({ from, to }), false);
  Assert.ok(!(await IOUtils.exists(to)));
});

add_task(async function an_unchanged_copy_is_left_as_it_is() {
  const { from, to } = await bundleAndCopy("build 1");
  await installShim({ from, to });
  const past = Date.now() - 60 * 60 * 1000;
  await IOUtils.setModificationTime(to, past);
  await IOUtils.setModificationTime(`${to}.install`, past);
  await installShim({ from, to });
  Assert.equal((await IOUtils.stat(to)).lastModified, past);
  Assert.equal((await IOUtils.stat(`${to}.install`)).lastModified, past);
});

/**
 * A new build's copy takes the old one's place as a new file, so a shim an
 * app is running keeps the file it started from, here a second link to it.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_new_build_replaces_the_copy_as_a_new_file() {
    const { from, to } = await bundleAndCopy("build 1");
    await installShim({ from, to });
    const running = `${to}.running`;
    const ln = await Subprocess.call({
      command: "/bin/ln",
      arguments: [to, running],
    });
    Assert.equal((await ln.wait()).exitCode, 0);

    await IOUtils.writeUTF8(from, "build 2");
    await installShim({ from, to });
    Assert.equal(await IOUtils.readUTF8(to), "build 2");
    Assert.equal(
      await IOUtils.readUTF8(running),
      "build 1",
      "the running shim's file is untouched"
    );
  }
);

/**
 * At start on macOS, an entry Sval wrote for the shim inside the bundle is
 * moved to the copy once the copy is in place. While the copy cannot be
 * written, the entry keeps the shim it has.
 */
add_task(async function a_start_moves_svals_entries_to_the_copy() {
  const { env, dirs } = await machine(["cursor"]);
  const cursorFile = PathUtils.join(dirs.cursor, "mcp.json");
  const inBundle = "/Applications/Sval.app/Contents/MacOS/sval-mcp";
  await IOUtils.writeJSON(cursorFile, {
    mcpServers: { sval: { command: inBundle } },
  });
  await IOUtils.writeJSON(env.recordPath, { cursor: inBundle });
  env.platform = "macosx";
  env.shim = PathUtils.join(env.home, "Sval", "sval-mcp");

  env.installShim = async () => {
    throw new Error("disk full");
  };
  await Assert.rejects(SvalAgentClients.startup(env), /disk full/);
  Assert.equal(
    (await IOUtils.readJSON(cursorFile)).mcpServers.sval.command,
    inBundle
  );

  env.installShim = async () => false;
  Assert.deepEqual(
    await SvalAgentClients.startup(env),
    [],
    "a build with no shim to copy"
  );

  env.installShim = async () => true;
  Assert.deepEqual(await SvalAgentClients.startup(env), ["cursor"]);
  Assert.equal(
    (await IOUtils.readJSON(cursorFile)).mcpServers.sval.command,
    env.shim
  );
  Assert.equal((await stateOf(env, "cursor")).state, "connected");
});
