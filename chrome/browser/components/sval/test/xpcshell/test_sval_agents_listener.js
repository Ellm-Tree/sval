/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The loopback listener agents connect to. Each task starts the listener
 * afresh on a profile with no agent directory (`freshListener`), and pairs
 * any agent it needs itself, so a task passes run alone.
 */

const { AGENT_DIR, MAX_UNPROVEN_CONNECTIONS, SvalAgents } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
const { TOOL_DEFINITIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTools.sys.mjs"
);
const { WAITING_MESSAGE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { encodeFrame, freshNonce } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs"
);
const { SvalTestAgentClient } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestAgentClient.sys.mjs"
);
const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

do_get_profile();

const { connectRaw, mac } = SvalTestAgentClient;

/**
 * A loopback client that opens as `sval-mcp` does: it sends a fresh challenge
 * and checks Sval's answer against the port file's token before it sends
 * anything else.
 *
 * @param {number} port
 * @returns {Promise<object>} `SvalTestAgentClient.connect`'s client, with the
 *   port file's `token`.
 */
async function connect(port) {
  const { token } = await IOUtils.readJSON(portFile());
  const c = await SvalTestAgentClient.connect(port, token);
  Assert.deepEqual(Object.keys(c.ctl).sort(), ["challenge", "sval"]);
  Assert.equal(c.ctl.sval, await mac(token, `sval:${c.nonce}`));
  Assert.ok(/^[0-9a-f]{64}$/.test(c.challenge), "sval's challenge");
  c.token = token;
  return c;
}

const fakeEngine = {
  workspaces: [],
  /** The agents' workspaces the user has deleted, by id. */
  deleted: new Set(),
  /** The sync passes asked for, as `[document, options]`. */
  passes: [],
  async mutate(op) {
    this.workspaces.push(op);
    for (const each of op.kind === "batch" ? op.ops : []) {
      if (each.kind === "remove") {
        this.deleted.add(each.id);
      }
    }
    return op.id;
  },
  async sync(document, _now, options) {
    this.passes.push([document, options]);
    return {};
  },
  async tree() {
    const agents = this.workspaces
      .filter(op => op.kind === "addAgentWorkspace" && !this.deleted.has(op.id))
      .map(op => [
        op.id,
        {
          kind: "workspace",
          content: { name: op.name },
          agent: { label: op.agentLabel },
          placement: { parent: null, order: "90" },
        },
      ]);
    return {
      nodes: {
        ...Object.fromEntries(agents),
        "ws-fake": {
          kind: "workspace",
          content: { name: "W" },
          placement: { parent: null, order: "80" },
        },
        t: {
          kind: "tab",
          content: { name: "T", url: "https://t/" },
          placement: { parent: "ws-fake", order: "80" },
        },
      },
    };
  },
};

/** Sval's private directory in the profile, which holds both its files. */
const agentDir = () => PathUtils.join(PathUtils.profileDir, AGENT_DIR);
const portFile = () => PathUtils.join(agentDir(), "port.json");

/** Every label the pairing dialog was asked about. */
const asked = [];
/** While set, the pairing dialog answers only once it settles. */
let pairingHeld = null;
/**
 * The pairing dialog: records the question and allows, because the pairing
 * task pairs through this answer.
 *
 * @param {string} label
 * @returns {Promise<{action: string}>}
 */
async function askToPair(label) {
  asked.push(label);
  await pairingHeld;
  return { action: "allow" };
}

// In Sval a window's panel hands the takes' and Stops' settings over before
// agent access starts, and until then every agent counts as stopped
// (`SvalAgentControl.isWorkspaceStopped`). Here no panel runs, so the test
// hands over settings in which nothing is taken or stopped.
const control = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);
control.useSettings({ isUserHeld: () => false, isAgentStopped: () => false });

registerCleanupFunction(async () => {
  control.useSettings(null);
  Services.prefs.clearUserPref(SvalAgents.PREF);
  await SvalAgents.stop();
});

/**
 * Stops the listener if it runs, removes the agent directory, and starts the
 * listener as Sval's startup does, with agent access as `on` says. The
 * listener holds a barrier of the task's own, standing in for
 * profile-before-change.
 *
 * @param {object} [options]
 * @param {boolean} [options.on] Agent access on, the default.
 * @param {() => Promise<void>} [options.prepare] Runs once the directory is
 *   gone, before the start, to leave what an earlier run would.
 * @param {number} [options.hello] The handshake version Sval speaks.
 * @returns {Promise<{barrier: object}>} The barrier the listener holds.
 */
async function freshListener({ on = true, prepare, hello } = {}) {
  await SvalAgents.stop();
  pairingHeld = null;
  await IOUtils.remove(agentDir(), { recursive: true, ignoreAbsent: true });
  await prepare?.();
  Services.prefs.setBoolPref(SvalAgents.PREF, on);
  const barrier = new AsyncShutdown.Barrier("test_sval_agents_listener");
  await SvalAgents.start({
    profileDir: PathUtils.profileDir,
    engine: fakeEngine,
    askToPair,
    version: "test",
    shutdownClient: barrier.client,
    hello,
  });
  if (on) {
    await waitForCondition(() => SvalAgents.port !== null, "listening");
    await waitForCondition(() => IOUtils.exists(portFile()), "port file");
  }
  return { barrier };
}

add_task(async function nothing_listens_while_the_pref_is_off() {
  // What a crash leaves behind. With access off, no discovery file may exist
  // (spec §7.2), so starting removes it.
  await freshListener({
    on: false,
    async prepare() {
      await IOUtils.makeDirectory(agentDir(), { permissions: 0o700 });
      await IOUtils.writeJSON(portFile(), { port: 1, token: freshNonce() });
    },
  });
  Assert.equal(SvalAgents.port, null);
  Assert.ok(!(await IOUtils.exists(portFile())));
});

add_task(async function turning_the_pref_on_listens_and_writes_the_port_file() {
  await freshListener({ on: false });
  Services.prefs.setBoolPref(SvalAgents.PREF, true);
  await waitForCondition(() => SvalAgents.port !== null, "listening");
  await waitForCondition(() => IOUtils.exists(portFile()), "port file");
  Assert.equal((await IOUtils.readJSON(portFile())).port, SvalAgents.port);
});

/**
 * No other socket can bind the listener's address and port, so a connection
 * meant for Sval reaches Sval (agent-control spec §3.6). Windows lets a
 * second socket that asks for SO_REUSEADDR bind them unless the listener
 * holds them for exclusive use.
 */
add_task(async function no_other_socket_can_bind_the_listeners_port() {
  await freshListener();
  const other = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  Assert.throws(
    () => other.init(SvalAgents.port, true, -1),
    /NS_ERROR/,
    "a second listener on the port is refused"
  );
  other.close();
});

/**
 * Gecko's WebMCP switch follows agent access and sites' tools together
 * (site-tools spec §3.1), so either one off keeps WebMCP off.
 */
add_task(async function webmcp_is_on_only_with_both_switches() {
  await freshListener();
  const modelContext = () =>
    Services.prefs.getBoolPref("dom.modelcontext.enabled", false);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(SvalAgents.PAGE_TOOLS_PREF)
  );
  Assert.ok(!modelContext(), "sites' tools are off by default");
  Services.prefs.setBoolPref(SvalAgents.PAGE_TOOLS_PREF, true);
  Assert.ok(modelContext(), "both on");
  Services.prefs.setBoolPref(SvalAgents.PREF, false);
  Assert.ok(!modelContext(), "agent access off");
  Services.prefs.setBoolPref(SvalAgents.PREF, true);
  Assert.ok(modelContext(), "agent access back on");
  Services.prefs.setBoolPref(SvalAgents.PAGE_TOOLS_PREF, false);
  Assert.ok(!modelContext(), "sites' tools off");
  await waitForCondition(() => SvalAgents.port !== null, "listening");
});

/**
 * The directory holds the token and the agents' secret hashes. A file in it
 * cannot be opened by another OS user at any moment, whatever the file's own
 * mode, even where the profile directory is world-readable. Windows has no
 * mode to check; its DACL is checked below.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function the_agent_directory_is_private() {
    // From no directory at all.
    await freshListener();
    const { type, permissions } = await IOUtils.stat(agentDir());
    Assert.equal(type, "directory");
    Assert.equal(
      permissions & 0o077,
      0,
      `mode ${permissions.toString(8)} gives nothing to group or others`
    );
  }
);

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function an_existing_loose_directory_is_tightened() {
    await freshListener();
    Services.prefs.setBoolPref(SvalAgents.PREF, false);
    await waitForCondition(() => SvalAgents.port === null, "closed");
    await IOUtils.setPermissions(agentDir(), 0o755);
    Assert.equal((await IOUtils.stat(agentDir())).permissions & 0o077, 0o055);

    Services.prefs.setBoolPref(SvalAgents.PREF, true);
    await waitForCondition(() => IOUtils.exists(portFile()), "port file");
    const { permissions } = await IOUtils.stat(agentDir());
    Assert.equal(permissions & 0o777, 0o700, `mode ${permissions.toString(8)}`);
  }
);

/**
 * The DACL of `path` in SDDL, read with `GetNamedSecurityInfoW`.
 *
 * @param {string} path
 * @returns {string} For example `D:PAI(A;OICI;FA;;;S-1-5-21-…)(A;OICI;FA;;;SY)`.
 */
function windowsDacl(path) {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const SE_FILE_OBJECT = 1;
  const DACL_SECURITY_INFORMATION = 4;
  const SDDL_REVISION_1 = 1;
  const advapi32 = ctypes.open("advapi32.dll");
  const kernel32 = ctypes.open("kernel32.dll");
  try {
    const getNamedSecurityInfo = advapi32.declare(
      "GetNamedSecurityInfoW",
      ctypes.winapi_abi,
      ctypes.uint32_t,
      ctypes.char16_t.ptr,
      ctypes.int,
      ctypes.uint32_t,
      ctypes.voidptr_t.ptr,
      ctypes.voidptr_t.ptr,
      ctypes.voidptr_t.ptr,
      ctypes.voidptr_t.ptr,
      ctypes.voidptr_t.ptr
    );
    const toSddl = advapi32.declare(
      "ConvertSecurityDescriptorToStringSecurityDescriptorW",
      ctypes.winapi_abi,
      ctypes.int,
      ctypes.voidptr_t,
      ctypes.uint32_t,
      ctypes.uint32_t,
      ctypes.char16_t.ptr.ptr,
      ctypes.uint32_t.ptr
    );
    const localFree = kernel32.declare(
      "LocalFree",
      ctypes.winapi_abi,
      ctypes.voidptr_t,
      ctypes.voidptr_t
    );
    const descriptor = ctypes.voidptr_t();
    const error = getNamedSecurityInfo(
      path,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION,
      null,
      null,
      null,
      null,
      descriptor.address()
    );
    Assert.equal(error, 0, `GetNamedSecurityInfoW(${path})`);
    try {
      const sddl = ctypes.char16_t.ptr();
      Assert.ok(
        toSddl(
          descriptor,
          SDDL_REVISION_1,
          DACL_SECURITY_INFORMATION,
          sddl.address(),
          null
        ),
        "the DACL converts to SDDL"
      );
      try {
        return sddl.readString();
      } finally {
        localFree(sddl);
      }
    } finally {
      localFree(descriptor);
    }
  } finally {
    advapi32.close();
    kernel32.close();
  }
}

/** This process's user SID, from `whoami`, which shares no code with Sval. */
async function currentUserSid() {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const proc = await Subprocess.call({
    command: PathUtils.join(
      Services.env.get("SystemRoot"),
      "System32",
      "whoami.exe"
    ),
    arguments: ["/user", "/fo", "csv", "/nh"],
  });
  let out = "";
  for (let chunk; (chunk = await proc.stdout.readString()); ) {
    out += chunk;
  }
  await proc.wait();
  return out.match(/"(S-1-[0-9-]+)"/)[1];
}

/**
 * Windows has no mode bits, so the directory gets a protected DACL: only
 * this user and SYSTEM, inherited by every file in it. A profile outside
 * `%APPDATA%`, such as `C:\shared\profile`, otherwise lets every local user
 * read the token through the ACL it inherits.
 */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function the_agent_directory_is_private_on_windows() {
    // A directory made with the ACL the profile's location gives it.
    await freshListener({ prepare: () => IOUtils.makeDirectory(agentDir()) });

    const user = await currentUserSid();
    for (const path of [agentDir(), portFile()]) {
      const dacl = windowsDacl(path);
      info(`${path}: ${dacl}`);
      const [, flags, aces] = dacl.match(/^D:([A-Z]*)((?:\([^)]*\))*)$/);
      const grants = [...aces.matchAll(/\(([^)]*)\)/g)].map(([, ace]) =>
        ace.split(";")
      );
      Assert.ok(
        grants.every(([type]) => type == "A"),
        "every ACE allows"
      );
      Assert.deepEqual(
        grants.map(ace => ace[5]).sort(),
        [user, "SY"].sort(),
        "only this user and SYSTEM"
      );
      if (path == agentDir()) {
        Assert.ok(flags.includes("P"), "the DACL inherits nothing");
        Assert.ok(
          grants.every(([, aceFlags]) => aceFlags.includes("OICI")),
          "files and directories inside inherit it"
        );
      }
    }
  }
);

/**
 * The token is what both proofs rest on. The file is 0600 inside the private
 * directory, too.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function the_port_file_is_readable_only_by_its_owner() {
    await freshListener();
    const { permissions } = await IOUtils.stat(portFile());
    Assert.equal(
      permissions & 0o077,
      0,
      `mode ${permissions.toString(8)} gives nothing to group or others`
    );
    Assert.ok(
      !(await IOUtils.exists(`${portFile()}.tmp`)),
      "the temporary file is gone"
    );
  }
);

add_task(async function sval_proves_itself_by_answering_a_fresh_challenge() {
  await freshListener();
  const { token } = await IOUtils.readJSON(portFile());
  Assert.ok(/^[0-9a-f]{64}$/.test(token), "the token is 64 hex characters");

  // The vectors sval-mcp's Rust tests check, computed independently with
  // Python's hmac module, so this file's `mac` means what sval-mcp's does.
  const vectorToken = "0123456789abcdef".repeat(4);
  const vectorNonce = "fedcba9876543210".repeat(4);
  Assert.equal(
    await mac(vectorToken, `sval:${vectorNonce}`),
    "06bf7a6e23313d6e35442d7ca05118e5206f1511f65e0da0d14c719ea0b109d4"
  );
  Assert.equal(
    await mac(vectorToken, `agent:${vectorNonce}`),
    "8250d82b0207bd5bf671b20aad92933ab149f5a1fdfa075771a9ba12fea34904"
  );

  const proofs = [];
  const challenges = [];
  for (const nonce of [freshNonce(), freshNonce()]) {
    const c = connectRaw(SvalAgents.port);
    c.send(encodeFrame({ challenge: nonce }));
    const reply = await c.next();
    Assert.deepEqual(Object.keys(reply), ["ctl"]);
    Assert.deepEqual(Object.keys(reply.ctl).sort(), ["challenge", "sval"]);
    Assert.equal(reply.ctl.sval, await mac(token, `sval:${nonce}`));
    Assert.notEqual(reply.ctl.sval, token, "the token never crosses the wire");
    Assert.ok(/^[0-9a-f]{64}$/.test(reply.ctl.challenge));
    proofs.push(reply.ctl.sval);
    challenges.push(reply.ctl.challenge);
    c.close();
  }
  Assert.notEqual(proofs[0], proofs[1], "a new nonce gets a new proof");
  Assert.notEqual(
    challenges[0],
    challenges[1],
    "every connection gets a fresh challenge"
  );
});

add_task(
  async function a_handshake_without_a_valid_client_proof_is_closed_silently() {
    await freshListener();
    const askedBefore = asked.length;
    const handshakes = [
      ["no proof", () => ({ hello: 1, pair: true })],
      [
        "a wrong proof",
        () => ({ hello: 1, pair: true, proof: "0".repeat(64) }),
      ],
      [
        "sval's own proof for the challenge, reflected",
        async c => ({
          hello: 1,
          pair: true,
          proof: await mac(c.token, `sval:${c.challenge}`),
        }),
      ],
      [
        "an unprefixed proof",
        async c => ({
          hello: 1,
          pair: true,
          proof: await mac(c.token, c.challenge),
        }),
      ],
      [
        "the right proof in uppercase",
        c => ({ hello: 1, pair: true, proof: c.proof.toUpperCase() }),
      ],
      [
        "a proof for another connection's challenge",
        async c => ({
          hello: 1,
          pair: true,
          proof: await mac(c.token, `agent:${freshNonce()}`),
        }),
      ],
      [
        "a proof that is not a string",
        () => ({ hello: 1, pair: true, proof: 7 }),
      ],
    ];
    for (const [what, make] of handshakes) {
      const c = await connect(SvalAgents.port);
      // A pairing request rides along with the handshake, so a peer that got
      // past it would reach the dialog.
      c.send(
        new Uint8Array([
          ...encodeFrame(await make(c)),
          ...encodeFrame({
            mcp: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          }),
          ...encodeFrame({
            mcp: {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "request_shared_pairing",
                arguments: { task: "Test task" },
              },
            },
          }),
        ])
      );
      await c.closed;
      Assert.equal(c.unread(), 0, `nothing is sent for ${what}`);
    }
    Assert.equal(asked.length, askedBefore, "no pairing dialog was asked for");
  }
);

add_task(
  async function a_connection_that_does_not_open_with_a_challenge_gets_nothing() {
    await freshListener();
    const upper = "A".repeat(64);
    const openings = [
      { hello: 1, pair: true },
      { mcp: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
      { challenge: "short" },
      { challenge: upper },
      { challenge: 7 },
      { challenge: "a".repeat(63) },
      { challenge: "a".repeat(65) },
      {},
    ];
    for (const opening of openings) {
      const c = connectRaw(SvalAgents.port);
      c.send(encodeFrame(opening));
      await c.closed;
      Assert.equal(
        c.unread(),
        0,
        `nothing is sent for ${JSON.stringify(opening)}`
      );
    }
  }
);

add_task(async function an_http_request_is_closed_unanswered() {
  await freshListener();
  const c = connectRaw(SvalAgents.port);
  c.send(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
  await c.closed;
});

/**
 * Before the handshake succeeds a connection may send at most 4 KiB, which
 * covers the challenge and the handshake, so a peer that cannot prove itself
 * cannot make Sval buffer more.
 */
add_task(
  async function a_large_frame_before_the_challenge_is_closed_silently() {
    await freshListener();
    const c = connectRaw(SvalAgents.port);
    c.send(encodeFrame({ challenge: freshNonce(), pad: "x".repeat(5000) }));
    await c.closed;
    Assert.equal(c.unread(), 0, "nothing is sent");
  }
);

add_task(async function a_large_handshake_is_closed_silently() {
  await freshListener();
  const c = await connect(SvalAgents.port);
  c.send(
    encodeFrame({ hello: 1, pair: true, proof: c.proof, pad: "x".repeat(5000) })
  );
  await c.closed;
  Assert.equal(c.unread(), 0, "nothing is sent");
});

add_task(async function a_large_frame_after_the_handshake_is_fine() {
  await freshListener();
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "x".repeat(5000) },
      },
    })
  );
  Assert.deepEqual((await c.next()).mcp, { jsonrpc: "2.0", id: 1, result: {} });
  c.close();
});

add_task(
  async function pairing_end_to_end_then_list_tabs_on_a_new_connection() {
    await freshListener();
    const c = await connect(SvalAgents.port);
    c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
    Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
    c.send(
      encodeFrame({
        mcp: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "Test Agent" } },
        },
      })
    );
    await c.next();
    c.send(
      encodeFrame({
        mcp: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "request_shared_pairing",
            arguments: { task: "Test task" },
          },
        },
      })
    );
    const ctl = await c.next();
    const { agent_id, secret } = ctl.ctl.paired;
    if (AppConstants.platform != "win") {
      const { permissions } = await IOUtils.stat(
        PathUtils.join(agentDir(), "agents.json")
      );
      Assert.equal(permissions & 0o077, 0, "the agents file is private");
    }
    Assert.equal(fakeEngine.workspaces.at(-1).kind, "addAgentWorkspace");
    Assert.equal(fakeEngine.workspaces.at(-1).agentLabel, "Test Agent");
    c.close();

    // The engine fake always reports ws-fake's tab; what matters is that a second
    // connection authenticates with the secret and reaches list_tabs.
    const d = await connect(SvalAgents.port);
    d.send(encodeFrame({ hello: 1, agent_id, secret, proof: d.proof }));
    Assert.deepEqual(await d.next(), { ctl: { ready: "paired" } });
    d.send(
      encodeFrame({ mcp: { jsonrpc: "2.0", id: 3, method: "tools/list" } })
    );
    Assert.deepEqual(
      (await d.next()).mcp.result.tools.map(t => t.name),
      [
        "list_tabs",
        "set_task",
        "use_workspace",
        "close_window",
        "delete_workspace",
        ...TOOL_DEFINITIONS.map(t => t.name),
      ]
    );
    d.close();
  }
);

/**
 * Peers that open connections and never finish a handshake hold at most
 * `MAX_UNPROVEN_CONNECTIONS` of the process's sockets, so another local user
 * cannot use the listener to leave the user's page loads waiting for one.
 * One more is closed at once, unanswered. Agents past their handshake do not
 * count, and a place freed by a handshake takes the next agent.
 */
add_task(async function connections_without_a_handshake_are_capped() {
  await freshListener();
  const ready = async c => {
    c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
    Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  };
  const opened = [];
  for (let i = 0; i < MAX_UNPROVEN_CONNECTIONS; i++) {
    const c = await connect(SvalAgents.port);
    await ready(c);
    opened.push(c);
  }
  const unproven = [];
  for (let i = 0; i < MAX_UNPROVEN_CONNECTIONS; i++) {
    unproven.push(await connect(SvalAgents.port));
  }
  opened.push(...unproven);
  const extra = connectRaw(SvalAgents.port);
  extra.sendFrame({ challenge: freshNonce() });
  await extra.closed;
  Assert.equal(extra.unread(), 0, "the connection past the cap gets nothing");

  await ready(unproven[0]);
  const next = await connect(SvalAgents.port);
  await ready(next);
  next.close();
  for (const c of opened) {
    c.close();
  }
});

add_task(async function a_paired_agent_lists_every_tool_with_a_description() {
  await freshListener();
  const pairing = await pairNew("Listing Agent");
  pairing.close();
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, ...pairing.credentials, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "paired" } });
  c.send(encodeFrame({ mcp: { jsonrpc: "2.0", id: 4, method: "tools/list" } }));
  const { tools } = (await c.next()).mcp.result;
  Assert.deepEqual(
    tools.map(t => t.name),
    [
      "list_tabs",
      "set_task",
      "use_workspace",
      "close_window",
      "delete_workspace",
      ...TOOL_DEFINITIONS.map(t => t.name),
    ],
    "every tool is listed"
  );
  for (const tool of tools) {
    Assert.equal(typeof tool.description, "string", tool.name);
    Assert.greater(tool.description.length, 0, `${tool.name}'s description`);
    Assert.equal(tool.inputSchema.type, "object", `${tool.name}'s schema`);
  }
  c.close();
});

add_task(async function a_wrong_secret_is_refused_and_closed() {
  await freshListener();
  const c = await connect(SvalAgents.port);
  c.send(
    encodeFrame({
      hello: 1,
      agent_id: "nope",
      secret: "0".repeat(64),
      proof: c.proof,
    })
  );
  Assert.deepEqual(await c.next(), { ctl: { refused: "unknown_agent" } });
  await c.closed;
});

add_task(async function an_unproven_peer_cannot_probe_agent_ids() {
  await freshListener();
  const pairing = await pairNew("Probed Agent");
  pairing.close();
  // A paired agent's real credentials, and an id that does not exist: without
  // a valid proof, neither gets `refused` or `ready`, so the answer says
  // nothing about which ids exist.
  for (const credentials of [
    pairing.credentials,
    { agent_id: "nope", secret: "0".repeat(64) },
  ]) {
    const c = await connect(SvalAgents.port);
    c.send(encodeFrame({ hello: 1, ...credentials, proof: "0".repeat(64) }));
    await c.closed;
    Assert.equal(c.unread(), 0, "nothing is sent");
  }
});

add_task(async function a_first_frame_that_is_not_a_handshake_is_closed() {
  await freshListener();
  const c = await connect(SvalAgents.port);
  c.send(
    encodeFrame({
      mcp: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      proof: c.proof,
    })
  );
  await c.closed;
});

add_task(async function two_agents_can_be_connected_at_once() {
  await freshListener();
  const a = await connect(SvalAgents.port);
  const b = await connect(SvalAgents.port);
  a.send(encodeFrame({ hello: 1, pair: true, proof: a.proof }));
  b.send(encodeFrame({ hello: 1, pair: true, proof: b.proof }));
  Assert.deepEqual(await a.next(), { ctl: { ready: "unpaired" } });
  Assert.deepEqual(await b.next(), { ctl: { ready: "unpaired" } });
  a.close();
  b.close();
});

/**
 * A call that carries a progress token hears from Sval while the user
 * decides, over the wire exactly as sval-mcp relays it to the agent, and gets
 * its answer the moment the user gives it (spec §5.6).
 */
add_task(async function a_waiting_call_reports_progress_over_the_wire() {
  await freshListener();
  let release;
  pairingHeld = new Promise(resolve => (release = resolve));
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "Waiting Agent" } },
      },
    })
  );
  await c.next();
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "request_shared_pairing",
          arguments: { task: "Test task" },
          _meta: { progressToken: "wire-1" },
        },
      },
    })
  );
  Assert.deepEqual(await c.next(), {
    mcp: {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "wire-1",
        progress: 1,
        message: WAITING_MESSAGE,
      },
    },
  });
  pairingHeld = null;
  release();
  const after = [];
  let frame;
  do {
    frame = await c.next();
    after.push(frame);
  } while (frame.mcp?.id !== 2);
  Assert.ok(
    after.some(f => f.ctl?.paired),
    "Allow paired the agent"
  );
  Assert.ok(!frame.mcp.result.isError, "and the call answered with it");
  c.close();
});

/**
 * A call waiting for the user does not hold up the connection: the agent's
 * next request is answered meanwhile, a second call waiting on the same
 * alert waits with it, and the answer settles both.
 */
add_task(async function a_waiting_call_does_not_hold_up_the_next_request() {
  await freshListener();
  let release;
  pairingHeld = new Promise(resolve => (release = resolve));
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  const frames = [];
  const read = (async () => {
    for (;;) {
      frames.push(await c.next());
    }
  })();
  read.catch(() => {});
  const replyTo = id => frames.find(f => f.mcp?.id === id)?.mcp;
  const call = (id, method, params) =>
    c.send(encodeFrame({ mcp: { jsonrpc: "2.0", id, method, params } }));
  const pairing = token => ({
    name: "request_shared_pairing",
    arguments: { task: "Test task" },
    _meta: { progressToken: token },
  });
  const progressed = token =>
    waitForCondition(
      () => frames.some(f => f.mcp?.params?.progressToken === token),
      `call ${token} waits`
    );
  call(1, "tools/call", pairing("first"));
  await progressed("first");
  call(2, "tools/list");
  await waitForCondition(() => replyTo(2), "tools/list answered");
  Assert.deepEqual(
    replyTo(2).result.tools.map(t => t.name),
    ["request_isolated_pairing", "request_shared_pairing"]
  );
  call(3, "tools/call", pairing("second"));
  await progressed("second");
  Assert.equal(replyTo(1), undefined, "the first call still waits");
  Assert.equal(replyTo(3), undefined, "and so does the second");
  pairingHeld = null;
  release();
  await waitForCondition(
    () => replyTo(1) && replyTo(3),
    "the answer settles both"
  );
  Assert.ok(!replyTo(1).result.isError);
  Assert.ok(!replyTo(3).result.isError);
  Assert.equal(
    frames.filter(f => f.ctl?.paired).length,
    1,
    "one pairing for both"
  );
  c.close();
});

/**
 * Pairing adds a workspace, and that is published by one sync pass for the
 * process, however many windows are listening for the change. Each window
 * draws the pass's report as another window's.
 */
add_task(async function one_pairing_runs_one_sync_pass() {
  await freshListener();
  let told = 0;
  const forget = [1, 2, 3].map(() =>
    SvalAgents.addChangeListener(() => told++)
  );
  const passesBefore = fakeEngine.passes.length;
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "request_shared_pairing",
          arguments: { task: "Test task" },
        },
      },
    })
  );
  let frame;
  do {
    frame = await c.next();
  } while (frame.mcp?.id !== 1);
  await waitForCondition(() => told == 3, "every window is told");
  await waitForCondition(
    () => fakeEngine.passes.length > passesBefore,
    "a pass runs"
  );
  // Anything still queued would have run by the next task.
  await new Promise(executeSoon);
  Assert.equal(fakeEngine.passes.length, passesBefore + 1, "one pass");
  const [document, options] = fakeEngine.passes.at(-1);
  Assert.equal(document, "workspaces");
  Assert.equal(options.shared, "background");
  forget.forEach(f => f());
  c.close();
});

/**
 * Connects as a new agent and pairs it, through the dialog, which allows.
 *
 * @param {string} name The name its MCP client gives.
 * @returns {Promise<object>} The connection, with the agent's `credentials`
 *   and its `workspaceId`.
 */
async function pairNew(name) {
  const c = await connect(SvalAgents.port);
  c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
  Assert.deepEqual(await c.next(), { ctl: { ready: "unpaired" } });
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name } },
      },
    })
  );
  await c.next();
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "request_shared_pairing",
          arguments: { task: "Test task" },
        },
      },
    })
  );
  let frame;
  do {
    frame = await c.next();
    if (frame.ctl?.paired) {
      c.credentials = frame.ctl.paired;
    }
  } while (frame.mcp?.id !== 2);
  Assert.ok(!frame.mcp.result.isError, "paired");
  c.workspaceId = fakeEngine.workspaces.at(-1).id;
  return c;
}

/**
 * Connects with an agent's credentials, naming the workspace its `sval-mcp`
 * held before, if any.
 *
 * @param {{agent_id: string, secret: string}} credentials
 * @param {string} [workspace]
 * @returns {Promise<object>} The connection and Sval's answer to it.
 */
async function connectAs(credentials, workspace) {
  const c = await connect(SvalAgents.port);
  c.send(
    encodeFrame({
      hello: 1,
      ...credentials,
      ...(workspace && { workspace }),
      proof: c.proof,
    })
  );
  return { c, answer: await c.next() };
}

/**
 * Sends a tool call and reads frames up to its reply.
 *
 * @param {object} c
 * @param {number} id
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<{reply: object, before: object[]}>} The reply, and the
 *   frames that came before it.
 */
async function callTool(c, id, name, args = {}) {
  c.send(
    encodeFrame({
      mcp: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
    })
  );
  const before = [];
  let frame;
  while ((frame = await c.next()).mcp?.id !== id) {
    before.push(frame);
  }
  return { reply: frame.mcp, before };
}

const errorOf = reply => JSON.parse(reply.result.content[0].text).error;

const workspaceIdOf = reply =>
  JSON.parse(reply.result.content[0].text).workspace_id;

/**
 * Every session of an app connects as the one agent the user allowed, with
 * no alert, and has no workspace until it makes one: its own, beside the
 * first session's (decision 1998).
 */
add_task(async function a_second_session_makes_a_workspace_of_its_own() {
  await freshListener();
  const first = await pairNew("Session Agent");
  const askedBefore = asked.length;
  const { c: second, answer } = await connectAs(first.credentials);
  Assert.deepEqual(answer, { ctl: { ready: "paired" } });
  const { reply: none } = await callTool(second, 1, "list_tabs");
  Assert.equal(errorOf(none), "no_workspace", "it has none yet");
  const { reply: made } = await callTool(second, 2, "set_task", {
    task: "Second job",
  });
  Assert.ok(!made.result.isError, "set_task makes one");
  const made2 = fakeEngine.workspaces.at(-1);
  Assert.equal(made2.kind, "addAgentWorkspace");
  Assert.notEqual(made2.id, first.workspaceId, "a workspace of its own");
  Assert.stringContains(made.result.content[0].text, made2.id, "its id");
  Assert.equal(asked.length, askedBefore, "with no pairing alert");
  Assert.equal(made2.isolated, false, "of the kind the user chose");
  await SvalAgents.store.setIsolated(first.workspaceId, true);
  const { c: third } = await connectAs(first.credentials);
  await callTool(third, 3, "set_task", { task: "Third job" });
  Assert.equal(
    fakeEngine.workspaces.at(-1).isolated,
    true,
    "and of the kind the user changed it to since"
  );
  third.close();
  const [agent] = SvalAgents.store.agents();
  Assert.deepEqual(
    agent.workspaces.map(w => [w.workspaceId, w.task]),
    [
      [first.workspaceId, "Test task"],
      [made2.id, "Second job"],
      [fakeEngine.workspaces.at(-1).id, "Third job"],
    ]
  );
  first.close();
  second.close();
});

/**
 * A session that names the workspace it held in its handshake gets it back
 * at its first call. While one session holds a workspace, another cannot
 * take it, and once that session is gone it can.
 */
add_task(async function a_held_workspace_is_one_sessions_at_a_time() {
  await freshListener();
  const first = await pairNew("Holding Agent");
  const { c: other } = await connectAs(first.credentials);
  const { reply: taken } = await callTool(other, 1, "use_workspace", {
    workspace: first.workspaceId,
  });
  Assert.equal(errorOf(taken), "workspace_in_use", "the first session has it");
  first.close();
  await waitForCondition(
    async () =>
      !(
        await callTool(other, 2, "use_workspace", {
          workspace: first.workspaceId,
        })
      ).reply.result.isError,
    "the workspace is free once its session is gone"
  );
  other.close();

  const { c: back } = await connectAs(first.credentials, first.workspaceId);
  const { reply: listed } = await callTool(back, 3, "list_tabs");
  Assert.equal(
    workspaceIdOf(listed),
    first.workspaceId,
    "a session that names its workspace gets it back"
  );
  const { reply: unknown } = await callTool(back, 4, "use_workspace", {
    workspace: "ws-fake",
  });
  Assert.equal(errorOf(unknown), "not_found", "the user's own is not its");
  back.close();
});

/**
 * Stop and take control are the user's on a workspace whoever reaches it: a
 * session that reconnects naming a stopped workspace is stopped, whatever it
 * calls first, and no session takes a workspace the user holds.
 */
add_task(async function no_session_steps_out_of_what_the_user_holds() {
  await freshListener();
  const first = await pairNew("Stopped Agent");
  first.close();
  const free = { isUserHeld: () => false, isAgentStopped: () => false };
  control.useSettings({
    isUserHeld: () => false,
    isAgentStopped: id => id === first.workspaceId,
  });
  try {
    const { c: back } = await connectAs(first.credentials, first.workspaceId);
    for (const [id, name, args] of [
      [1, "set_task", { task: "Elsewhere" }],
      [2, "use_workspace", { workspace: "ws-fake" }],
      [3, "list_tabs", {}],
    ]) {
      const { reply } = await callTool(back, id, name, args);
      Assert.equal(errorOf(reply), "stopped_by_user", `${name} is stopped`);
    }
    back.close();

    control.useSettings({
      isUserHeld: id => id === first.workspaceId,
      isAgentStopped: () => false,
    });
    const { c: other } = await connectAs(first.credentials);
    const { reply: taken } = await callTool(other, 4, "use_workspace", {
      workspace: first.workspaceId,
    });
    Assert.equal(errorOf(taken), "user_in_control", "the user has it");
    other.close();
  } finally {
    control.useSettings(free);
  }
});

/**
 * Deleting an agent's workspace, by the user or by the agent, leaves the
 * agent paired: its session has no workspace until it makes one, and its
 * next connection needs no alert.
 */
add_task(async function a_deleted_workspace_leaves_its_agent_paired() {
  await freshListener();
  const c = await pairNew("Deleted Agent");
  fakeEngine.deleted.add(c.workspaceId);
  const { reply: gone } = await callTool(c, 3, "list_tabs");
  Assert.equal(errorOf(gone), "no_workspace", "the user deleted it");
  await callTool(c, 4, "set_task", { task: "Again" });
  const made = fakeEngine.workspaces.at(-1).id;
  control.useSettings({
    isUserHeld: id => id === made,
    isAgentStopped: () => false,
  });
  const { reply: held } = await callTool(c, 7, "delete_workspace");
  control.useSettings({ isUserHeld: () => false, isAgentStopped: () => false });
  Assert.equal(errorOf(held), "user_in_control", "not while the user has it");
  Assert.ok(!fakeEngine.deleted.has(made), "and nothing is deleted");
  const { reply: deleted } = await callTool(c, 5, "delete_workspace");
  Assert.ok(!deleted.result.isError, "the agent deletes its own");
  Assert.ok(fakeEngine.deleted.has(made));
  const { reply: none } = await callTool(c, 6, "list_tabs");
  Assert.equal(errorOf(none), "no_workspace");
  Assert.deepEqual(SvalAgents.store.agents()[0].workspaces, []);
  c.close();

  const askedBefore = asked.length;
  const { c: again, answer } = await connectAs(c.credentials);
  Assert.deepEqual(answer, { ctl: { ready: "paired" } }, "still paired");
  Assert.equal(asked.length, askedBefore, "with no alert");
  again.close();
});

/**
 * The sweep deletes an agent workspace no session has held for longer than
 * the setting, 30 days to start with. One a session holds stays however old
 * it is, and Never keeps them all.
 */
add_task(async function unused_agent_workspaces_are_deleted_past_the_setting() {
  await freshListener();
  const idle = await pairNew("Idle Agent");
  const { c: busy } = await connectAs(idle.credentials);
  await callTool(busy, 1, "set_task", { task: "Busy" });
  const held = fakeEngine.workspaces.at(-1).id;
  idle.close();
  const day = 24 * 60 * 60 * 1000;
  const later = Date.now() + 31 * day;

  Services.prefs.setIntPref(SvalAgents.WORKSPACE_RETENTION_PREF, 0);
  try {
    Assert.deepEqual(
      await SvalAgents.sweepIdleWorkspaces(later),
      [],
      "Never keeps every workspace"
    );
  } finally {
    Services.prefs.clearUserPref(SvalAgents.WORKSPACE_RETENTION_PREF);
  }
  Assert.deepEqual(
    await SvalAgents.sweepIdleWorkspaces(Date.now() + 29 * day),
    [],
    "a workspace used within 30 days stays"
  );
  // The idle session's close reaches Sval on its own turn, and a workspace
  // stays while its session holds it.
  await waitForCondition(
    async () =>
      (await SvalAgents.sweepIdleWorkspaces(later)).includes(idle.workspaceId),
    "the idle session's workspace goes once its session has closed"
  );
  Assert.ok(fakeEngine.deleted.has(idle.workspaceId));
  Assert.ok(!fakeEngine.deleted.has(held), "the held one stays");
  Assert.deepEqual(
    SvalAgents.store.agents()[0].workspaces.map(w => w.workspaceId),
    [held]
  );
  busy.close();
});

/**
 * Unpairing keeps an agent's workspaces unless the user deletes them with
 * it. A kept one is still the sweep's to delete once it has gone unused.
 */
add_task(async function an_unpaired_agents_workspaces_go_with_it_or_in_time() {
  await freshListener();
  const kept = await pairNew("Kept Agent");
  kept.close();
  Assert.ok(await SvalAgents.unpair(kept.credentials.agent_id));
  Assert.ok(!fakeEngine.deleted.has(kept.workspaceId), "kept");
  Assert.deepEqual(
    SvalAgents.store.keptWorkspaces().map(w => w.workspaceId),
    [kept.workspaceId]
  );
  const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
  Assert.deepEqual(
    await SvalAgents.sweepIdleWorkspaces(later),
    [kept.workspaceId],
    "the sweep still deletes it"
  );
  Assert.deepEqual(SvalAgents.store.keptWorkspaces(), []);

  const gone = await pairNew("Deleted Agent");
  gone.close();
  Assert.ok(
    await SvalAgents.unpair(gone.credentials.agent_id, {
      deleteWorkspaces: true,
    })
  );
  Assert.ok(fakeEngine.deleted.has(gone.workspaceId), "deleted with it");
  Assert.deepEqual(SvalAgents.store.keptWorkspaces(), []);
});

/**
 * Unpairing an agent closes its live connections, so it can do nothing more
 * after the user has removed it. Other agents' connections stay open.
 */
add_task(async function unpairing_closes_the_agents_connections() {
  await freshListener();
  const pairing = await pairNew("Unpaired Agent");
  pairing.close();
  const paired = pairing.credentials;
  const own = await connect(SvalAgents.port);
  own.send(encodeFrame({ hello: 1, ...paired, proof: own.proof }));
  Assert.deepEqual(await own.next(), { ctl: { ready: "paired" } });
  const other = await connect(SvalAgents.port);
  other.send(encodeFrame({ hello: 1, pair: true, proof: other.proof }));
  Assert.deepEqual(await other.next(), { ctl: { ready: "unpaired" } });

  Assert.ok(await SvalAgents.unpair(paired.agent_id), "it was paired");
  await own.closed;

  other.send(encodeFrame({ mcp: { jsonrpc: "2.0", id: 1, method: "ping" } }));
  Assert.deepEqual((await other.next()).mcp, {
    jsonrpc: "2.0",
    id: 1,
    result: {},
  });
  other.close();

  const again = await connect(SvalAgents.port);
  again.send(encodeFrame({ hello: 1, ...paired, proof: again.proof }));
  Assert.deepEqual(await again.next(), { ctl: { refused: "unknown_agent" } });
  await again.closed;
  Assert.ok(!(await SvalAgents.unpair(paired.agent_id)), "nothing left to do");
});

/**
 * Turns agent access off and on again with the directory as `prepare` leaves
 * it, and answers the problem the listener reported.
 *
 * @param {() => Promise<void>} prepare
 * @returns {Promise<string|null>}
 */
async function problemAfterRestart(prepare) {
  Services.prefs.setBoolPref(SvalAgents.PREF, false);
  await waitForCondition(() => SvalAgents.port === null, "closed");
  await prepare();
  const told = TestUtils.topicObserved(SvalAgents.STATE_TOPIC);
  Services.prefs.setBoolPref(SvalAgents.PREF, true);
  await within(told, 10_000, "the agents listener's state notification");
  return SvalAgents.problem;
}

/**
 * A listener that cannot start says why, for the Agents settings section.
 * Fixing the cause and switching access on again clears it.
 */
add_task(async function an_unreadable_agents_file_is_reported() {
  await freshListener();
  (await pairNew("Kept Agent")).close();
  const agentsFile = PathUtils.join(agentDir(), "agents.json");
  const kept = await IOUtils.read(agentsFile);
  Assert.equal(SvalAgents.problem, null, "no problem while listening");
  const problem = await problemAfterRestart(() =>
    IOUtils.writeUTF8(agentsFile, "{ not json")
  );
  Assert.equal(problem, "agents-file");
  Assert.equal(SvalAgents.port, null, "nothing listens");

  Assert.equal(
    await problemAfterRestart(() =>
      IOUtils.writeJSON(agentsFile, { version: 99, agents: {} })
    ),
    "agents-file",
    "a file from a newer build is reported too"
  );

  Assert.equal(
    await problemAfterRestart(() => IOUtils.write(agentsFile, kept)),
    null
  );
  Assert.notEqual(SvalAgents.port, null, "listening again");
});

add_task(async function a_directory_that_cannot_be_made_private_is_reported() {
  await freshListener();
  (await pairNew("Kept Agent")).close();
  const saved = await IOUtils.read(PathUtils.join(agentDir(), "agents.json"));
  const problem = await problemAfterRestart(async () => {
    await IOUtils.remove(agentDir(), { recursive: true });
    // A file where the directory should be: nothing can make it private.
    await IOUtils.writeUTF8(agentDir(), "");
  });
  Assert.equal(problem, "agent-directory");
  Assert.equal(SvalAgents.port, null, "nothing listens");

  Assert.equal(
    await problemAfterRestart(async () => {
      await IOUtils.remove(agentDir());
      await IOUtils.makeDirectory(agentDir(), { permissions: 0o700 });
      await IOUtils.write(PathUtils.join(agentDir(), "agents.json"), saved);
    }),
    null
  );
});

/**
 * A port file that cannot be written leaves nothing listening, and switching
 * access on again once it can be written listens. A read-only directory is
 * how the write is made to fail, and Windows ignores a directory's mode.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_port_file_that_cannot_be_written_leaves_nothing_listening() {
    await freshListener();
    const problem = await problemAfterRestart(() =>
      IOUtils.setPermissions(agentDir(), 0o500)
    );
    await IOUtils.setPermissions(agentDir(), 0o700);
    Assert.equal(problem, "failed");
    Assert.equal(SvalAgents.port, null, "nothing listens");
    Assert.ok(!(await IOUtils.exists(portFile())), "no port file");

    Services.prefs.setBoolPref(SvalAgents.PREF, false);
    Services.prefs.setBoolPref(SvalAgents.PREF, true);
    await waitForCondition(() => SvalAgents.port !== null, "listening again");
    await waitForCondition(() => IOUtils.exists(portFile()), "port file");
    Assert.equal(SvalAgents.problem, null);
    Assert.equal(
      (await IOUtils.readJSON(portFile())).port,
      SvalAgents.port,
      "the port file names the listener"
    );
  }
);

add_task(
  async function turning_the_pref_off_closes_connections_and_removes_the_port_file() {
    await freshListener();
    const c = await connect(SvalAgents.port);
    c.send(encodeFrame({ hello: 1, pair: true, proof: c.proof }));
    await c.next();
    Services.prefs.setBoolPref(SvalAgents.PREF, false);
    await c.closed;
    await waitForCondition(() => SvalAgents.port === null, "stopped");
    Assert.ok(!(await IOUtils.exists(portFile())));
  }
);

add_task(async function a_clean_quit_removes_the_port_file() {
  const { barrier } = await freshListener();
  await barrier.wait();
  Assert.equal(SvalAgents.port, null);
  Assert.ok(!(await IOUtils.exists(portFile())));
});

add_task(async function a_quit_waits_for_the_port_file_to_go() {
  // quit-application runs `stop` long before profile-before-change, and does
  // not wait for it. The blocker must still be there when the barrier runs.
  const { barrier } = await freshListener();

  const stopping = SvalAgents.stop();
  await barrier.wait();
  // A synchronous check: an IOUtils call here would queue behind the removal
  // and see it finished even when nothing waited for it.
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(portFile());
  Assert.ok(
    !file.exists(),
    "the port file is gone once profile-before-change has finished"
  );
  await stopping;
});

add_task(
  async function a_shim_older_than_the_handshake_before_svals_is_told_so() {
    // Sval speaks hello 3 here, so it accepts 2 and 3, refuses 1 as outdated,
    // and treats 4, which no Sval speaks yet, as no handshake at all.
    await freshListener({ hello: 3 });

    const old = await connect(SvalAgents.port);
    old.send(encodeFrame({ hello: 1, pair: true, proof: old.proof }));
    Assert.deepEqual(await old.next(), { ctl: { refused: "outdated" } });
    await old.closed;

    const newer = await connect(SvalAgents.port);
    newer.send(encodeFrame({ hello: 4, pair: true, proof: newer.proof }));
    await newer.closed;
    Assert.equal(
      newer.unread(),
      0,
      "nothing is sent to a hello sval does not know"
    );

    for (const hello of [2, 3]) {
      const c = await connect(SvalAgents.port);
      c.send(encodeFrame({ hello, pair: true, proof: c.proof }));
      Assert.deepEqual(
        await c.next(),
        { ctl: { ready: "unpaired" } },
        `hello ${hello}`
      );
      c.close();
    }
    await SvalAgents.stop();
  }
);
