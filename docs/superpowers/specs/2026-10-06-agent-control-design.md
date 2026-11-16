# Sval — Agent Control Design

**Date:** 2026-10-06
**Author:** John Postlethwait
**Extends:** `2026-09-24-sval-browser-design.md`. Read that first. Its principles
(§2) and hard rules (§0) apply here unchanged.

---

## 1. What this is

Any agent running on the user's machine (Claude Code, Codex, Gemini CLI, Cursor,
anything that speaks MCP) can reach over to Sval and ask it to open pages, read
them, and act on them, using the user's signed-in sessions. It works the same on
macOS, Windows and Linux.

This is not the "AI features" item that §3.4 of the main spec defers. Sval gains
no model, no chat surface, and nothing that speaks first. It gains a door that
local agents can knock on, and the user decides what each one may do.

**Success looks like:** the user adds one MCP server to an agent's config, the
agent's first call asks Sval to pair, the user accepts once, and from then on the
agent browses in its own visible workspace under a policy the user set.

## 2. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **The agent drives its own workspace.** Each agent gets a dedicated workspace that shares the user's normal cookie jar. | The user's own tabs stay out of reach, and the agent still has the user's sessions. |
| **A tab can be acted on only while it is in the agent's workspace.** | One rule, easy to state, easy to enforce at every tool entry point. |
| **The user hands a tab to an agent by moving it into the agent's workspace** (§5.4). No tool reaches the user's workspaces. | The user decides what the agent sees, with one act they already know, and the rule above stays whole. |
| **One agent per device.** "Claude Code on the laptop" and "Claude Code on the desktop" are two agents with two workspaces. | One-agent-across-devices was rejected: an approval given for one process would silently cover a different process on another machine; two devices would write the same workspace concurrently and move tabs under each other mid-task; revocation would have to propagate. Per device keeps the blast radius of a compromised device on that device, the same reasoning as §3.3 of the main spec. |
| **Agent workspaces sync.** Policy, approvals and pairing secrets do not. | The user can see what an agent did from any device. Secrets are bearer credentials and approvals describe one device's agent. |
| **If Sval is not running, the agent's call starts it in the background** without taking focus, and opens the agent's workspace in its own window. | An unattended agent can finish its job, and nothing jumps in front of the user (principle 6). |
| **Off by default.** | Principle 3. |

### 2.1 Rejected approaches

- **Exposing Firefox's WebDriver BiDi remote agent** (`remote/`). It is built for
  test automation and is unusable on a daily profile as shipped: it starts only
  from a launch flag; while it runs every page sees `navigator.webdriver = true`
  (`dom/base/Navigator.cpp`), which bot detection flags; it applies roughly a
  hundred prefs including disabling Safe Browsing and the popup blocker
  (`remote/shared/RecommendedPreferences.sys.mjs`); and its port accepts any
  local process unauthenticated. Making it fit means deep patches to Mozilla code
  that changes often, filtering a protocol that assumes control of every tab, and
  still writing an MCP layer because no agent speaks BiDi.
- **A WebExtension with native messaging** (the Claude in Chrome model). An
  extension cannot create Sval workspaces or start Sval, and separating
  agent-triggered writes from the page's own requests is harder from extension
  APIs. It still needs a native host installed on every platform.
- **Gating writes by HTTP method alone.** A modern page sends dozens of POSTs per
  load (analytics, GraphQL reads, token refreshes), so the user would approve a
  stream of requests they cannot judge. It is also leaky: some GETs change state
  and WebSocket messages have no method. See §5.3 for the rule used instead.
- **A "create but not delete" policy level.** Sval can tell a read from a write.
  It cannot tell a create from a delete, because most sites delete with a POST
  (`POST /api/messages/123/delete`, a GraphQL `deleteMessage` mutation). The
  level would let most deletes through while claiming to stop them.
- **A tool that runs page JavaScript.** Page JavaScript can `fetch()` freely, so
  the tool would bypass the write gate entirely.

## 3. Architecture

```
agent ──stdio MCP──▶ sval-mcp ──loopback TCP──▶ SvalAgents.sys.mjs ──▶ page actors
                    (Rust binary,              (parent process,      (JSWindowActor
                     ships in sval)              added files only)     in agent tabs)
```

### 3.1 `sval-mcp`

A small Rust binary that ships inside the Sval bundle or install directory, so its
version always matches the browser. Agents register it as an ordinary stdio MCP
server, for example `claude mcp add sval -- /Applications/sval.app/Contents/MacOS/sval-mcp`.

It does three things and holds no tool logic:

1. **Find sval.** Read the discovery file (§3.2) in the profile named by
   `--profile`, or without it in the profile Sval's own install starts on
   (`src/install.rs`). If no Sval holds the profile, start the Sval beside the
   shim in the background (§7.1) and wait up to 30 seconds for the port. If a
   Sval holds the profile with no port file, answer `access_off` (§7.3).
2. **Authenticate.** Prove to Sval that it can read the discovery file, read this
   agent's secret from its file in `sval-agents` (§5.1), and complete the
   handshake (§3.3). With no secret, the only call that succeeds is pairing (§5.1).
3. **Relay.** Pass MCP JSON-RPC messages through untouched in both directions.

It lives in `tools/sval-mcp`, under Sval's own license, and CI builds and
tests it in the `sval-mcp` job. It is the security boundary people install into
their agents, so it is kept small enough to audit. It contains no `sval-core`
code. It is a separate program, so nothing of it is compiled into Gecko.

### 3.2 `SvalAgents.sys.mjs`

The control module in Sval's parent process, made of added files only. It:

- listens on a loopback-only TCP port (`nsIServerSocket`, loopback flag set)
  while agent access is on, and nothing listens while it is off;
- writes the port and a random 256-bit token for this listen to
  `<profile>/sval-agents/port.json`, as `{port, token}`. The file is removed on
  clean shutdown and at start whenever access is off, so a crash leaves no
  stale file behind once Sval runs again;
- keeps the paired agents in `<profile>/sval-agents/agents.json`, in the same
  directory;
- speaks MCP itself: tool definitions, argument validation, and results;
- maps each authenticated connection to its agent and that agent's workspace;
- evaluates policy (§5) before every tool runs;
- owns the alerts, the write gate, and the window marking (§6).

**Sval speaks MCP `2025-06-18`, `2025-11-25` and `2026-07-28`.** The first two
open with `initialize`, and 2026-07-28 has no handshake: every request carries
its version, the client's capabilities and, optionally, who the client is in
its `_meta`. A client may say which it speaks either way, so both are served on
one connection, each request by what it says.

- **`initialize` answers a version Sval supports.** It answers the client's
  version when it is `2025-06-18` or `2025-11-25`, and `2025-11-25` otherwise.
  MCP's version negotiation requires exactly this: a server that supports the
  requested version must answer with it, and otherwise must answer with
  another version it supports, preferably its latest. The client then decides
  whether it can continue. Echoing a version Sval has not built to would claim
  behaviour it does not have, and `initialize` cannot open a 2026-07-28
  session.
- **A 2026-07-28 request is answered by what it carries.** A request naming a
  version Sval does not speak gets `UnsupportedProtocolVersionError` (-32022)
  listing the three, from which the client picks one and asks again. One
  without the client's capabilities is malformed (-32602). Every result
  carries `resultType: "complete"` and Sval's name and version in
  `_meta["io.modelcontextprotocol/serverInfo"]`. A tool list carries
  `ttlMs: 0` and `cacheScope: "private"`: it is the agent's own, by its
  pairing and its Be polite rules, and it changes when either does, which a
  client that has not subscribed hears nothing of. A pairing names the agent
  from its own call's `clientInfo`.
- **`sval-mcp` answers `server/discover` and holds the subscriptions.**
  `server/discover` gives the three versions, `tools.listChanged`, and the
  server instructions, with `ttlMs: 0` and `cacheScope: "public"`, since a shim
  updated in place may change any of it. A `subscriptions/listen` asking for
  `toolsListChanged` is acknowledged with that alone, and stays open until the
  agent cancels it. Sval tells the bridge of every change to the tool list,
  and the bridge sends it on to each such stream, tagged with its
  `subscriptionId`, and to a legacy session plainly. Both live in the bridge,
  since the agent's session outlives any one connection to Sval.
- **What else 2026-07-28 changes needs nothing of Sval.** Sval asks the client
  for nothing (no sampling, elicitation or roots, so no multi round-trip
  results), sends no log messages, has no resources or prompts, advertises no
  extensions (Claude Code's `io.modelcontextprotocol/tasks` falls back to core
  behaviour), and runs over stdio, so the Streamable HTTP, session and
  authorization changes do not reach it. `ping` is still answered. Progress
  and cancellation work as before.

**The directory is private.** `sval-agents` is created with mode 0700, and a
directory that already exists with looser bits is tightened to 0700. Both files
inside are written 0600. The directory is what keeps other OS users out. A
file that is created and then chmod'ed can be opened by another user between
the two steps, and that user keeps the handle. A private directory closes the
window, because nobody else can reach the file at any moment, whatever the
file's own mode. On Windows the mode is ignored and the profile directory's ACL
does the same job. Sval sets no ACL of its own, so a `--profile` outside the
user's own profile tree keeps whatever ACL its place gives it.

**Why loopback TCP everywhere.** `nsIServerSocket.initWithFilename` gives Unix
domain sockets on macOS and Linux, but Windows has no equivalent reachable from
chrome JS. One transport on three platforms is one thing to test. The
handshake carries the authentication either way.

### 3.3 Wire format

**Frames.** A 4-byte big-endian length, then that many bytes of UTF-8 JSON
holding one object. The maximum frame is 1 MiB, enforced in both directions and
checked on the declared length before any body is buffered. After the handshake,
`{"mcp": <JSON-RPC message>}` frames carry MCP and `{"ctl": {...}}` frames are
between Sval and `sval-mcp` only. The pairing secret travels in a `ctl` frame, so
it reaches the bridge and never the agent's model context.

**Before the handshake, a connection may send 4 KiB in total.** Past that Sval
closes it with nothing sent. A challenge and a handshake are far smaller. The
cap exists because any local process can connect, and an unproven peer could
otherwise declare a 1 MiB frame and trickle it for as long as the timeout allows,
on as many connections as it likes.

**The exchange.** Both sides prove they can read `port.json`. The token never
crosses the wire.

1. `sval-mcp` sends `{"challenge": nonce_c}`. A nonce is 32 fresh random bytes as
   64 lowercase hex characters, new for every attempt.
2. Sval answers `{"ctl": {"sval": proof_sval, "challenge": nonce_b}}`. `nonce_b` is
   fresh for this connection and used once.
3. `sval-mcp` checks `proof_sval` and that `nonce_b` is 64 lowercase hex
   characters, then sends its handshake: `{"hello": 1, "pair": true, "proof":
   proof_agent}` for an agent with no secret, or `{"hello": 1, "agent_id": id,
   "secret": secret, "proof": proof_agent}`.
4. Sval checks `proof_agent`, and only then reads the rest of the handshake. It
   answers `{"ctl": {"ready": "paired"}}` or `{"ctl": {"ready": "unpaired"}}`.
   A secret that does not match gets `{"ctl": {"refused": "unknown_agent"}}` and
   a close. Sval compares the SHA-256 of the secret with the stored hash in
   constant time. After `ready`, frames go to the session.

**The proofs.** Each is the lowercase hex HMAC-SHA256, keyed by the UTF-8 bytes
of the token's 64-character hex text, so the key is 64 bytes long, over the UTF-8
bytes of a prefix and the nonce's hex text:

- `proof_sval = HMAC(token, "sval:" + nonce_c)`
- `proof_agent = HMAC(token, "agent:" + nonce_b)`

Sval verifies `proof_agent` with `crypto.subtle.verify`, which compares in
constant time, and refuses anything that is not 64 lowercase hex characters. Both
test suites pin the same independently computed vector for each prefix.

**Silence is part of the protocol.** `sval-mcp` speaks first. Sval sends nothing
until it has received a valid challenge, and it checks the client's proof before
it looks at anything else in the handshake. A peer that fails any step, whether
a first frame that is not a challenge, a missing or wrong proof, or too many
bytes, gets no reply of any kind, and Sval closes the connection. Sval sends
`refused` only after the proof has verified, so an unproven peer never sees it.
Sval answers any well-formed challenge, so a probe learns that the port is
Sval's listener, and nothing else: not whether an agent id exists. It cannot
make `sval-mcp` forget a stored credential, and Sval's answer never serves as
an agent's proof (the prefixes, below).

**Deadlines.** `sval-mcp` gives the whole exchange, from connect to `ready`, 5
seconds. Every read and write gets only the time remaining, so a peer that
answers a byte at a time cannot stretch it. Sval closes a connection that has no
session 10 seconds after accepting it. The wider window means the client's
deadline is the one that ends a stalled handshake.

**Why each piece exists.**

- **Another OS user on shared loopback.** Every user on the machine can reach
  Sval's port. Without the client's proof, any of them could raise a pairing alert
  on this user's screen naming itself "Claude Code", and an Allow would hand it a
  secret that drives this user's signed-in sessions. Only a process that can read
  the owner-only `port.json` can make the proof.
- **A stale port file after a crash.** The file outlives Sval, and another
  process, possibly another user's, can later listen on the port it names.
  Without Sval's proof, `sval-mcp` would send that process the agent id and secret.
  The proof is a fresh challenge-response, so the listener must hold the token to
  answer.
- **Replay of a token-first banner (rejected).** An earlier design had Sval send
  the token as its first frame and `sval-mcp` compare it with the file. Do not
  reintroduce it. Anyone who connects while Sval runs learns the token. They can
  wait for a crash to leave a stale port file, listen on that port, and replay
  the token to `sval-mcp`, which then sends the secret. A fresh nonce makes every
  recorded proof worthless.
- **Reflection between the two proofs.** Sval answers any valid challenge it
  receives. A peer that has connected once holds Sval's `nonce_b`, so it could
  connect again, send `nonce_b` as its own challenge, and take Sval's answer as the
  client proof for the first connection. The prefixes close this. Sval only ever
  signs `"sval:" + …`, which never verifies as `"agent:" + …`, and `sval-mcp` signs
  only `"agent:" + …`, and only after Sval has proven itself, so neither side can
  be used as an oracle for the other.
- **The 4 KiB cap, the deadlines and the silent close.** They bound what a peer
  that cannot prove anything can make Sval buffer, hold open or reveal.

Sending the secret itself over loopback after both proofs is acceptable. The
peer has shown it can read the profile, and reading other users' loopback
traffic needs privileges §3.6 already excludes.

**Why not HTTP or WebSocket.** A web page cannot open a raw TCP socket, but it
can send HTTP and WebSocket requests to localhost. The first four bytes of an
HTTP request line or a TLS hello, read as a length, are hundreds of megabytes,
so the decoder refuses them before buffering a body. Even a page that got
through could not make either proof, because it cannot read the port file. A
page has no way to talk to the listener at all, and DNS rebinding has nothing to
rebind to.

### 3.4 Page actors

A JSWindowActor pair registered for agent tabs. The child side:

- builds snapshots (§4.2) and keeps the ref table for the current document;
- resolves refs to elements;
- reads page source.

An actor belongs to one window global, so a page the tab navigates to starts with
no refs.

Input goes through Firefox's own `remote/shared/webdriver/Event.sys.mjs`, the
module Marionette and WebDriver BiDi send input through from their content actors.
It delivers mouse events through `windowUtils` and keys through
TextInputProcessor, so the page sees trusted events, as it does from a person.
Screenshots go through `remote/shared/Capture.sys.mjs` in the parent, and page
dialogs are answered in the parent through `remote/shared/Prompt.sys.mjs` (§4.1).
All three ship in release builds, because `--disable-webdriver` is off by default
(`toolkit/moz.configure`). They are internal modules with no stability promise, so
tests pin their behaviour and the yearly ESR rebase checks them.

Sval never starts the remote agent, so `navigator.webdriver` stays false.

### 3.5 Agent workspaces

An ordinary Sval workspace carrying an additive field, `agent: {label, device}`,
set at creation and never changed, like `kind`. Should two sides ever differ, the greater canonical JSON wins, so devices converge. Per §5.5 of the main spec, builds that do not
know the field round-trip it verbatim and show the workspace as an ordinary one.

- The switcher shows agent workspaces under an "Agents" group, as
  "Claude Code · laptop" on other devices.
- Each opens in its own window (main spec §10.7, torn-off workspaces).
- A tab handed to an agent keeps its cookie jar when the agent's workspace
  shares the user's jar, and reopens in the agent's jar otherwise (§5.4).
- A link the user peeks at in the agent's window (Alt-click, `SvalPeek`) is
  the agent's while the peek is open: `list_tabs` lists it with `peek: true`,
  and every tool takes its id, under the same site policy, write gate and
  take of control as the agent's other tabs. An open peek is the window's
  and the device's alone and transient, so the synced tree never holds it:
  the agent's list gains it from the window, and its id comes from its
  content's `browserId`, never from a node. `close_tab` closes the peek, and
  `navigate_tab` loads within it. Closed, its id answers as a closed tab
  does. Kept, it is filed as any new tab is and listed by its node id; the
  peek's id then answers as a closed tab does, so no tab has two ids. A peek
  in a window showing the user's workspace is no agent's.
- A peek window, which a link from another app opens (quick window spec §4),
  is the user's. It shows no workspace and files nothing in the tree, and
  only another app opens one, so its pages load at once, never held for a
  filing that cannot come.

### 3.6 Threat model, stated plainly

Agent control protects the user against **pages**, through approvals shown in
browser UI that a page cannot draw or hide, and against **agents doing more than
the user granted**, through policy checked in the parent process.

It also protects against **other OS users on the same machine**, who share the
loopback interface and can connect to Sval's port or listen on a port a stale
file names. Every step that matters needs the token, the token sits in a file
inside a directory only the profile's owner can open (§3.2), and both sides
prove they hold it (§3.3). Another user therefore cannot raise a pairing alert,
learn whether an agent id exists, or receive a secret. They can still connect.
They get nothing back and are closed after 4 KiB or 10 seconds. Nor can they
listen on Sval's own port while Sval holds it: on Windows, where a socket
bound with `SO_REUSEADDR` lets another account bind the same address and port,
the listener binds with `SO_EXCLUSIVEADDRUSE` instead
(`nsIServerSocket.ExclusiveAddress`).

It does not protect against malware running as the user's account. That malware
can already read the profile, including its cookies and the token. This matches
the main spec's at-rest threat model.

The write gate (§5.3) has known gaps, documented there.

## 4. Tools

Every tool name is `verb_object`. Anything that raises an alert starts with
`request_`. Every tool that takes a tab returns the tab's current URL and title,
unless the agent may not read that page now (§4.1).

An agent reaches only the tabs in its own workspace; the user hands it one of
theirs by moving the tab there (§5.4). `list_page_tools` and `call_page_tool`,
which reach a page's own WebMCP tools, are in the site tools spec.

| Tool | Does | Alert |
|---|---|---|
| `list_tabs` | Lists tabs in its own workspace | |
| `set_task(task)` | Names its workspace for the work it is doing | |
| `open_tab(url)` | Opens a new tab in its workspace and waits for load | Site alert, if the site is new (§5.2) |
| `close_tab(tab)` | Closes a tab in its workspace | |
| `navigate_tab(tab, url \| back \| forward \| reload)` | Waits for load | Site alert, if new |
| `get_snapshot(tab)` | Page outline: each element's role and name with a ref like `e12` | |
| `get_screenshot(tab)` | Viewport PNG | |
| `get_page_source(tab, ref?, offset?)` | Current DOM as HTML, whole page or one ref's subtree. Large pages return in chunks with a next offset | |
| `get_page_text(tab, ref?, offset?, max_chars?)` | The text the page draws, whole page or one ref's, in chunks, without what was typed into a form | |
| `click_element(tab, ref)` | Clicks | Write alert, if it causes writes (§5.3) |
| `type_text(tab, ref, text)` | Focuses, clears, types real key events | Write alert, if the page autosaves |
| `fill_form(tab, {ref: value, …})` | `type_text` for several fields in one call | Write alert, if the page autosaves |
| `select_option(tab, ref, values)` | Chooses options in a `<select>` | Write alert, if it causes writes |
| `press_keys(tab, keys)` | Key presses to the focused element | Write alert, if it causes writes |
| `scroll_page(tab, ref \| direction)` | Scrolls | Write alert, if it causes writes |
| `wait_for_text(tab, text, timeout_ms)` | For pages that load content late | |
| `answer_dialog(tab, accept, text?)` | Answers the `confirm` or `prompt` dialog open in the tab; `text` fills a prompt (§4.1) | Write alert, if it causes writes |
| `upload_file(tab, ref, paths)` | Gives a file input the named local files | Upload alert, if the site is undecided (§5.2) |
| `get_console_messages(tab, cursor?, max_messages?)` | What the tab's page wrote to its console, oldest first, from a cursor (§4.5) | Console alert, if the site is undecided (§5.2) |
| `list_downloads()` | The agent's downloads: file name, saved path, state, bytes | Download alert when a page on an undecided site starts one (§5.2) |

### 4.1 Rules every tool follows

- **`initialize` and `server/discover` carry server instructions.** One text, about 300 words, tells
  the agent's model what no single tool description holds: it acts with the
  user's own signed-in sessions, in a workspace whose window the user watches and
  which is marked as the agent's; the user may take any tab; how tab ids and refs
  work; and what each family of error codes asks it to do next. It also tells the
  agent not to imitate a person (no random delays, no human-like pacing) and
  never to attempt a human-verification check. Sval enforces every rule it states
  in its own code; the text only explains them. `sval-mcp` answers `initialize`
  itself with the same text, and a test fails when the two differ. MCP 2026-07-28
  carries them on `server/discover`, which `sval-mcp` answers with the same
  text.
- **Every tool error has one shape:** an MCP tool result with `isError: true`
  whose text is JSON carrying `error` (the code), `message` (a sentence that
  starts with the code and says what to do next) and, where there is one, `tab`.
  An error may add fields of its own: `dialog`, `writes`, `held`, `filled`, or a
  human-verification check's `kind` and `vendor`. `sval-mcp`'s own errors
  (`sval_not_running`, `sval_disconnected`) have the same shape, and it relays
  Sval's unchanged. Each tool's description names every code it can return.
- **Annotations say what a tool can do.** Input tools (`click_element`,
  `type_text`, `fill_form`, `select_option`, `press_keys`, `answer_dialog`,
  `upload_file`) carry `destructiveHint: true`, MCP's default for a tool that
  is not read-only, because a click can place an order. `open_tab`,
  `navigate_tab` and `scroll_page` only change what a tab shows, and
  `close_tab` reaches nothing outside Sval (`openWorldHint: false`).
- **The tab the agent works in has focus, to its page.** Sites depend on it:
  form libraries validate a field as it loses focus, comboboxes open as they
  gain it, and pages check `document.hasFocus()` and their visibility. A tool
  that changes a page (`navigate_tab`, the input tools and `call_page_tool`)
  selects its tab in the agent's window as its load or input goes, and
  `open_tab` opens its tab selected. While the
  agent holds the workspace, its window's selected tab is, to the page, the
  focused tab of a focused window: `hasFocus()` is true, `:focus` and
  `:focus-visible` match, focus, blur, focusin and focusout fire as the
  agent's input moves focus, and the page stays visible even when the window
  is minimised or covered. It goes on rendering there too: the window stays
  active to Gecko while it shows the page the agent holds, so its compositor
  keeps running and the page's animation frames and scroll events go on, as
  Picture-in-Picture keeps its covered window running. The tab the agent leaves hears blur and goes hidden,
  as a backgrounded tab does, and a tab a page opens in the background stays
  unfocused. None of it moves the user's focus, in the agent's window or
  outside it, or what a screen reader has focused, and the page hears the
  same whichever window the user is in. Sval's Gecko gives the tab's browsing
  context this focus without the window's (`svalFocusEmulated`); the tab's real
  focus wins whenever the user has it. Take control turns it off, so the page
  hears blur until the user's own input focuses it, and Give back turns it on
  again.

- Acting on a tab outside the agent's workspace fails with `not_controlled`.
- Reading a tab outside the agent's workspace fails with `not_controlled` too.
- A Blocked site can be neither loaded nor read. A load of one, whoever starts
  it, and a load the user refuses at the site alert, show Sval's
  `about:agentblocked` in the tab in its place: a page saying the user blocked
  the agent from the site, which the agent may read. `open_tab` and
  `navigate_tab` answer with that page and status 403, HTTP's Forbidden; no
  request reaches the site.
- An agent can never list the user's tabs or workspaces.
- **Only `http` and `https` URLs and `about:blank` are allowed.** Every other
  scheme gets `unsupported_url`. `file:` would let an agent read local files, and
  a privileged page such as `about:config` would hand the agent a page with
  browser powers. The rule covers every load in an agent's tab, whoever starts it,
  with one exception: a page's own move to a `blob:` or `data:` address goes ahead,
  because a content policy cannot tell a page's download of a file it made from a
  page load, and such downloads follow the download permission (§5.2). If it turns
  out to be a page, no tool reads or acts in it, no result names it, and its writes
  are refused, because a `blob:` or `data:` document has no site (§4.1). A redirect
  to either is refused. The rule also means the user cannot open an `about:` page
  in an agent's tab. A page's own load of an address whose protocol Gecko hands
  to another application (its handler is `nsIExternalProtocolHandler`), in the
  top-level document or a frame, opens no page: it is the page asking to open an
  app, and the apps permission decides it (§5.2). A tool's `open_tab` or
  `navigate_tab` to such an address still gets `unsupported_url`. Site policy
  covers top-level loads alone (§5.2), so a frame's other loads go ahead.
- **A page in a tab an agent controls does not write the system clipboard**
  (decision 0130). An agent's click gives the page user activation, which would
  otherwise let it replace what the user later pastes elsewhere. Every write from
  the page is refused: `navigator.clipboard`, `execCommand("copy")` and a copy
  event's own data. None of the user's input reaches such a tab (§6), so no copy of
  the user's is lost. Once the user takes control, the page writes the clipboard as
  in any tab.
- **Every load an agent starts carries a null principal.** The system principal
  would let a page the agent names inherit browser privileges. A null principal is
  what `tabbrowser` gives web content it opens. For the same reason, an agent
  replays only a history entry whose triggering principal is a null principal,
  one its own load made. Back and forward refuse any other entry (one the
  user, a page or session restore made, which carries their authority and the
  site's SameSite=Strict cookies) with `no_history`, and reload of one becomes a
  fresh null-principal load. History cannot load an entry afresh in its own
  place, so the refusal carries the entry's address, when an agent may open
  it, for the agent to open with `navigate_tab`. A page the user opened is
  refused without its address.
- **History entries that hold POST data are never replayed.** That covers an entry
  whose subframe holds POST data. A replay would send the form again outside the
  write gate (§5.3). Reload of such an entry loads its address afresh with a GET,
  and back or forward onto one fails with `no_history`.
- **A site decision is made on the page's document principal, never on its
  address.** An `about:blank` or `about:srcdoc` document inherits the origin of the
  page that made it, so a blank page a site wrote into is that site's page. A
  sandboxed frame's null principal gives the site of the page that made it. A PDF
  counts as the site it came from. The one document with no site is a blank page
  nothing wrote into. Any principal the rule does not name, such as a null principal
  with no origin behind it on anything but `about:blank`, is refused, so the check
  fails closed.
- **A tab or window a page opens from an agent's tab belongs to the agent's
  workspace.** A new tab a page asks for (`target=_blank`, or `window.open` without
  window features) opens in the background of the agent's own window, so no window
  opens and focus does not move. Sval routes it there by wrapping
  `BrowserDOMWindow.createContentWindowInFrame`, which receives the opener's
  `<browser>`. A `window.open` with window features is different: Firefox decides
  in native code (`nsWindowWatcher::GetWindowOpenLocation`, then
  `OpenWindowWithRemoteTab`) to open a window and shows it with no chrome JS on the
  way, so that window opens and takes focus. Sval then moves its tab into the agent's
  own window without selecting it, and closes it if it cannot, so a page cannot use a
  popup to slip out from under the gate. Stopping that window from opening needs
  native code, which Sval does not add. Only the
  user's own move takes a tab out, and §5.4 describes what that does.
- **`list_tabs` and tool results name a page only when the agent may read it
  now.** The title and URL come from the page's window global and are judged by
  that same window global, because a tab's own title and address update on
  schedules of their own and can still name the page before. A refused page has no
  title or URL. A page that holds nothing a site wrote has no title. This keeps a
  site the user blocked after the page loaded from leaking through a tab list or
  through a click that lands in the back-forward cache.
- **A page dialog in an agent's tab is answered by its type, or by the agent.** The
  result that reports it carries `dialog {type, message}`:

  | Dialog | Answer | Why |
  |---|---|---|
  | `alert` | accept, by Sval | It has no other answer. |
  | `confirm`, `prompt` | the agent's, through `answer_dialog` | The answer is the page's question to the agent, and only the agent can give it. A default would turn "Delete this item?" into a silent no and break any page that asks for input. |
  | `beforeunload` | leave, by Sval | The agent's own navigation must go on. Only an agent's tab is answered for, so a page the user is editing never is. |
  | PDF.js leave-page | leave without saving, by Sval | PDF.js's accepting button saves a file, and a saved file is a side effect. |

  A `confirm` or `prompt` stays open until it is answered. The tool whose input
  raised it returns as soon as it opens, with `dialog` and `dialog_open: true`.
  While it is open, every tool on that tab except `answer_dialog`, `close_tab` and
  `list_tabs` fails with `dialog_open` and carries the dialog again, because the page
  is stopped inside the dialog and cannot be read or acted on. `answer_dialog` is
  an input action: it runs through the write gate (§5.3), since accepting a
  "Delete?" is what sends the delete. The checkbox some dialogs carry ("Don't allow
  this site to prompt you again") is never ticked. A dialog nobody answers stays up,
  and the user can answer it in the agent's window. `answer_dialog` on a tab with no
  `confirm` or `prompt` open fails with `no_dialog`.

  The message is the page's own text, cut to 500 characters. It reaches the agent
  only when both the page's site and the site of the frame that raised the dialog
  are readable now. A frame from a site the agent may not read must not speak
  through a page it may read. Otherwise the agent gets the type alone.
  `answer_dialog` is held to the same site check as every acting tool, because an
  answer resumes the page's script: on a page whose site the agent may not act on
  now it fails with `policy_denied`, and the agent can close the tab, or the user
  can answer in the agent's window. The same holds for the frame that raised the
  dialog: a frame from a Blocked site, or one whose site Sval cannot work out, is
  the user's to answer. A frame from a site merely not yet allowed can be answered,
  with its words withheld. An input that reaches a page while a dialog holds it is
  refused there, so it never lands after the answer on whatever the page moved
  under it.
- **Acting tools time out.** An acting tool (`click_element`, `type_text`,
  `fill_form`, `select_option`, `press_keys`, `scroll_page`) waits 30 seconds for
  the page, and then fails with `page_unresponsive`. `fill_form` shares one 30
  seconds across its fields. A page that never yields would otherwise hold the
  tool call, and the write gate's window with it. A load that does not finish in 60
  seconds fails with `navigation_failed`, and the tab stops loading.
- **Downloads, uploads and apps are per-site permissions** (§5.2). A download is decided
  by the site of the page that started it, so a `blob:` or `data:` file a
  page generated counts as that page's site.
- **File pickers a page opens are refused in an agent-controlled tab.** Files reach
  a page only through `upload_file` (§4.4).
- A policy refusal names the site and says whether it is blocked or has not been
  allowed, so the agent can tell the user why it stopped.

**A screenshot leaves a frame blank when the agent may not read its site.** A
page holding such a frame that Sval cannot leave blank fails with
`frame_not_readable`.

**Known gaps.**

- **The dialog type reaches the agent when its message is withheld.** The agent
  learns that a dialog opened, and not what it said.
- **A navigation that commits just as a dialog opens can attribute the dialog to the
  new page.** The handler reads the tab's window global when the dialog loads. The
  window is narrow, and the page that raised the dialog is held in it.
- **An error page whose principal has no site is unreadable.** Such a page, for
  example a network error page, is refused where a read by address would have
  passed.

### 4.2 Snapshots and refs

A snapshot is a text outline built by walking the DOM in the actor and computing
each element's ARIA role and accessible name, for example:

```
heading "Sign in" [e3]
textbox "Email" [e14]
textbox "Password" [e15]
checkbox "Keep me signed in" [e16]
button "Sign in" [e17]
```

Refs are valid for the document they were taken from. A ref used after the tab
has navigated fails with `stale_ref`, so an agent never clicks the wrong element
on a new page. The parent hands each snapshot a block of ref numbers that no
earlier snapshot of the tab used, so a ref never repeats within a tab. A counter
that restarted with each page would let an old page's `e12` resolve to a different
element on the new one.

**Roles and names come from a walk of the DOM with heuristic rules, not from the
accessibility service.** Computing them in the actor is how Playwright's ARIA
snapshots work. The service starts in every content process once it is asked of
one, and builds its trees in both the content and the parent process. It also has
no API for an element's ARIA role and name without it. The cost is roles and names that follow heuristic rules for the common
cases, and not the full ARIA computation.

- The walk follows the flattened tree, so content in shadow roots is read where it
  renders. It does not enter frames, because each frame has a window global of its
  own.
- Names and text are emitted as JSON-escaped strings with control characters
  collapsed, and refs appear only outside quotes. A page's own text cannot forge a
  line that points the agent at a different ref.
- A password field's value is never read, even after a show-password toggle, with
  autocomplete, or with CSS masking. `get_page_source` strips it as well.
- A snapshot stops at 2000 lines, 200 000 characters, 50 000 visited elements or
  2 seconds, and its result carries `truncated: true`.

### 4.3 How an agent fills in a form

1. `get_snapshot` gives the field refs.
2. `fill_form(tab, {e14: "me@x.com", e15: "…"})`, or `type_text` per field.
   Typing produces real key events, so the page's own handlers and validation
   run. Checkboxes and radios use `click_element`; dropdowns use `select_option`.
3. `click_element(tab, e17)` submits. This is the action the write gate watches.

A click lands only on the element the agent named. Sval works out what covers the
element's centre point, and refuses with `click_intercepted` when anything but the
element, one of its descendants, or the label of a checkbox or radio it controls
is on top, so a page cannot lay a frame from another site over a button and have
the agent click through it. The page is checked again between the press and the
release, and a press on a target that moved is released elsewhere. A frame is
never a click target.

Typing does not prompt, because nothing leaves the page until the submit. Pages
that autosave as you type are the exception (§5.3).

### 4.4 Out of v1

Running page JavaScript (§2.1), network inspection, a strict per-request write
mode, copying site approvals between agents, and a text policy language.

**Files reach a page only through `upload_file`.** An OS file picker is a dialog
the agent cannot see or answer, so every picker a page asks for in an
agent-controlled tab is refused in the parent, where every picker is made. That
holds however the page asks: a click on a file input or its label, a page's own
`click()` on the activation an agent's click gave it, or `showPicker()`, which opens
a picker with no click event at all. An event listener in the page could not stop
the last. The refusal is per tab. It ends the moment the user takes the tab back
(§5.4), and from then on its pickers open as in any tab. The agent's own click on a
file input fails with `not_clickable` and points it at `upload_file`.

`upload_file(tab, ref, paths)` gives the input its files the way WebDriver's file
upload does (`File.createFromFileName`, then `mozSetFileArray`, in
`remote/webdriver-bidi/modules/windowglobal/input.sys.mjs`), and fires the page's
`input` and `change` events. It needs the upload permission for the top-level
page's site (§5.2). Each path must be absolute and name a regular file the user can
read. Each path is resolved through symbolic links first, and the page gets the
file the link points at. A directory, a missing file, more than one path for an
input without `multiple`, or a file inside a Sval profile fails with `bad_file`.
On Windows, so does a path that is not on one of the computer's own drives, as
Windows reads it (`PathGetDriveNumberW`, then `GetDriveTypeW`): a UNC path
(`\\host\share`, `\\?\UNC\…`), a device path (`\\.\…`) or a mapped network
drive. It is refused before anything opens it, because opening a file on another
host makes Windows offer that host the user's credentials.
On Windows, so does a path through a link: the file, or a directory on the way
to it, is a reparse point other than a deduplicated file or a cloud-files
placeholder. Gecko follows no Windows link, so the page would get another file
than the alert names, and a link can lead to a share. Each entry is read with
`FindFirstFileW` from the drive down, which reads a link without following it,
so the path is refused before anything opens it.
A file is inside a profile when any directory above it holds a profile's
`compatibility.ini`, or Sval's own `.sval-profile` mark, or is named
`sval-agents`. Sval writes the mark into its profile and local profile directories
when it starts, because the local directory, which holds the cache, carries no
`compatibility.ini`. A directory holding both `times.json` and `prefs.js` also counts,
which catches a profile whose `compatibility.ini` is gone; `times.json` alone does
not, because a user's own project can hold one. That is checked on
the directories the path actually reaches, because one file has many spellings: a
macOS firmlink (`/System/Volumes/Data/Users/…`), a Windows junction or an 8.3
short name all name the same profile file, and a comparison of path
strings would miss them. A
profile holds the agents' own tokens, the cookies and the saved passwords, and a
page given any of them could take over the user's sessions or speak to Sval as an
agent. No other file is refused: a site can be sent any file the user can read
that the user allowed, one call at a time or by folder (§5.2). Sval reads each file itself once it has
checked it, and gives the page those bytes, so a link swapped after the check cannot
change what is sent, and every check runs again on the path after the read. The
site is worked out again just before the files go: if the tab has moved to another
site while the alert waited, the call fails with `page_changed` and sends nothing.
One call sends at most 100 MiB, or fails with
`file_too_large`. A hard link to a profile file made outside the profile is not
caught; only a process that can already read the profile can make one. The ref must be a file input, or the tool fails
with `not_file_input`.

### 4.5 Console messages

`get_console_messages` gives the agent what the page in its tab wrote to the
console: the page's console calls, and its uncaught exceptions and unhandled
rejections, each with `kind` (`console`, `uncaught_exception` or
`unhandled_rejection`), `level` (the console method, or `error`), `text`,
`time`, and `url`, `line` and `column` where Gecko gives them. Warnings Gecko
itself reports (CSS, network, security) are left out.

**What is read.** Only the tab's top-level document, from its creation until
it goes. Frames are left out, as `get_snapshot` never enters one. A message
belongs to a document by its inner window id, which Gecko gives every console
call (`ConsoleAPIStorage`) and every script error (`nsIScriptError.innerWindowID`),
so nothing from another tab, a frame or chrome code is read. A console call
from an extension's content script carries an `addonId` and is left out, as
is anything from a chrome context. Arguments are turned into text through
Xrays, so reading them runs none of the page's code.

**Where it is kept.** In the page's own process, by its page actor
(`SvalAgentConsole`). Gecko already keeps each window's console calls
(`ConsoleAPIStorage`, up to 1000) and the process's latest 250 script errors
(`nsConsoleService`), so the watch starts from those, then listens. The gate
starts the watch as each top-level page in an agent's tab is created
(`window-global-created`), whether or not the agent asks, so a page's early
errors are kept before other documents' push them out of the shared ring, and
a grant given later covers what the page logged before it. A page keeps its
latest 500 messages, each cut to 2000 characters, and the watch ends with the
document.

**The cursor.** Each answer carries `cursor`, naming the page and the last
message answered. Passed back, it gives only what came after. A cursor from
another page gives the current page from its first message, since all of it
is new to the agent. `max_messages` caps one answer (default 100), and `more`
says there are later ones; `dropped` counts messages after the cursor the page
no longer keeps.

**Permission.** Sites log tokens, account details and what the user typed, so
the console is a per-site permission of its own, `console` in the policy
(§5.2). Nothing is read until the user allows the site for that agent. A call
on an undecided site asks and waits like `upload_file` (§5.6); a denied site
answers `console_denied`, and an unanswered alert `awaiting_approval`, both
with no messages. The messages are read from the page the user was asked
about: a tab that moved on while the alert was up answers `page_changed`. The
text reaches the agent's tool result and no other sink (§7.4).

## 5. Permissions

### 5.1 Pairing

1. An unknown agent connects. Its tool list holds two tools,
   `request_isolated_pairing` and `request_shared_pairing`, and any other call
   fails with `not_paired`. Each names the kind of workspace the agent asks for
   (isolated workspaces spec §7).
2. Sval shows an alert naming the agent and the kind of workspace it asked
   for, where the user may change the kind. The name is the client's MCP
   `clientInfo` (`title`, else `name`), from `initialize` or a 2026-07-28
   request's `_meta`, with control characters removed and at most 64
   characters kept. The name is the agent's own claim, and only processes
   running as the user can raise the alert (§3.6).
3. On Allow, Sval creates the agent's workspace and policy, generates a 256-bit
   secret, and stores only its SHA-256 in `agents.json`. The secret goes to
   `sval-mcp` in a `ctl` frame.
4. `sval-mcp` stores the secret in a JSON file of its own in the profile's
   `sval-agents` directory, one per agent: its client name, the directory it
   was launched in, and its instance there (`account_for` in `src/bridge.rs`). The file is
   0600 in the 0700 directory on Unix. On Windows the profile's ACL guards it.
   An OS credential store adds nothing against a process running as the user,
   which can read the profile anyway (§3.6), and the macOS Keychain asks the
   user with a prompt that cannot say why (decision 0088).

Pairing requests from one launch share one alert and one result across every
connection, keyed by the launch's id, or by the client's name when
`sval-mcp` gives no launch, so one agent cannot be paired twice into
two workspaces with one record orphaned.

The agent's identity is the secret. Its name is a label.

**Unpairing** deletes the hash and the policy, and closes the agent's live
connections. Its confirmation offers to delete the agent's workspaces with it,
checked. A workspace the user keeps is the user's data, and the idle sweep
still deletes it once it has gone unused past the retention setting, as it
does a paired agent's. The next connection from that agent is back to asking
to pair.

**Deleting the agent's workspace leaves the pairing** (decision 1998). The
user deletes it like any other workspace, and the session that held it has
none until it makes another or takes one back.

**Connect without asking** is a per-agent switch in Settings → Agents, under
the agent's permissions, off by default. With it on, deleting the agent's
workspace keeps the pairing: the agent's next call gets a new, empty
workspace of the kind the user chose at pairing, named for the agent, and
the record points there from then on, with no alert. The switch lives in the
agent's record, which only the agent's secret reaches. It is never matched by
the name an agent reports, which any local program can give, so a new
connection under the same name with no secret is asked about like any other.

### 5.2 Policy

Four levels, each of which Sval can enforce:

| Level | Effect |
|---|---|
| **Blocked** | The agent cannot load the site. |
| **Read only** | Navigate and read. Writes are refused without an alert, and the agent is told why. |
| **Ask before writes** | Writes raise the write alert (§5.3). |
| **Full access** | No alerts. |

Each agent has a **default level** (initially "Ask before writes") and
**per-site exceptions** keyed by registrable domain. A **"new sites: ask first"**
switch, on by default, raises "Claude Code wants to open ebay.com. Allow / Deny"
the first time the agent loads a site with no exception. Allow adds the site at
the default level; Deny adds it as Blocked.

Settings → Agents shows each agent with its default level, its exceptions, and
Unpair. The policy is stored per agent on the device as a small JSON document
whose format is documented here:

```json
{ "version": 3,
  "default": "ask-before-writes",
  "askForNewSites": true,
  "sites": { "github.com": "full", "bank.example": "blocked" },
  "downloads": { "github.com": "allow" },
  "console": { "github.com": "allow", "bank.example": "deny" },
  "uploads": { "github.com": { "folders": [
                 { "path": "/Users/me/Documents/cv", "subfolders": false },
                 { "path": "/Users/me/Projects/site", "subfolders": true } ] },
               "shop.example": "deny" },
  "apps": { "zoom.us": { "zoommtg": "allow", "zoomus": "deny" },
            "shop.example": "deny" } }
```

**A local site always asks first.** An agent's first load of a site on this
computer or the local network asks, whatever the default, unless the default
is Blocked, which refuses it as it refuses every new site. Sites on the
internet get the default the user chose; a router's admin page, a NAS or a
development server is not one of those, and a prompt-injected agent could
otherwise reach it under "Allow all sites". The alert names where the site
is: "Claude Code wants to open 192.168.1.1, a device on your local network."
or "…, a service on this computer.", with Allow and Deny alone, since "Allow
all sites" would leave the site with no rule, and so asking again. Allow
records the site at the default level, Deny as Blocked. A site is local by
its host, before the load: when Gecko calls the host a loopback host
(`nsIPrincipal.isLoopbackHost`: `localhost`, names under `.localhost`,
`127.0.0.0/8`, `::1`) or the any-address, which is this computer, or a local
or shared address (`nsIIOService` `hostnameIsLocalIPAddress` and
`hostnameIsSharedIPAddress`: private, link-local and unique local addresses,
and `100.64.0.0/10`), or when it is a name under `.local` or a single label,
which is the local network. A public name that resolves to a local address
is judged as the public site it names; Sval does not check where a load
connects.

Policy never syncs. **A value Sval cannot read counts as no decision.** A site
whose level Sval does not know is a site the agent has never visited, so the next
load asks first, even with "new sites: ask first" off, because the entry shows the
user decided something about the site. Until the user answers, a damaged entry
counts as "Ask before writes" whatever the default level is, so a page of that
site already open has its writes held. No decision never grants more than asking
does. A `downloads`, `uploads`, `console` or `apps` entry Sval does not know asks again; in
an `uploads` entry that is each folder, and in an `apps` entry each scheme. An
unreadable default level is "Ask before writes", and an unreadable
`askForNewSites` is on. Treating damage as Blocked would lock the agent out of a
site the user allowed, with nothing to tell the user why. Treating it as new puts
the decision back in front of the user, and only a hand-edited `agents.json` can
hold such a value. A write keeps every field Sval does not know.

**Downloads, uploads, the console and apps are per-site permissions of their own.** They are
separate from the level, because they move files between the user's disk and the
site, or hand an address to an application on the user's computer, and the level
is about what the agent may do to the site. Downloads and uploads are decided once
per site, not per file. Apps are decided once per site and scheme:

| Permission | Asked | Allow | Deny |
|---|---|---|---|
| Downloads | The first time a page whose site has no `downloads` entry starts a download in an agent's tab, or the PDF viewer's Save is pressed in one: "Claude Code wants to download files from shop.example." | Every download from that site saves without asking, to the user's download folder, under the name Firefox picks. | Every download from that site is cancelled without asking. |
| Uploads | An `upload_file` on a page whose top-level site does not deny uploads, unless every file lies in a folder its entry allows and none is hidden: "Claude Code wants to upload files from your computer to shop.example." The alert lists the full resolved path of every file the call sends, and names the folders Always allow adds: the folders of the files no folder of the entry allows. Under it the user picks what Always allow covers: "This folder only", the default, or "This folder and the folders inside it". | Allow sends that call's files. Always allow also adds those folders to the site's entry with the scope the user picked, and a later `upload_file` whose files all lie in the entry's folders goes ahead (decision 0129). | `upload_file` on that site fails with `policy_denied` without asking. |
| Console | The first time a `get_console_messages` call reads a page whose site has no `console` entry: "Claude Code wants to read the messages shop.example writes to its developer console." The detail says sites sometimes write account details, sign-in codes or what the user types there, and that Sval remembers the answer for the site. | The agent reads the console of every page on the site without asking. | `get_console_messages` on that site fails with `console_denied` without asking. Closing the alert any other way is Deny. |
| Apps | The first time a page in an agent's tab asks to open an address whose scheme Gecko hands to another application, and the site that asked has no entry for that scheme: "Claude Code wants to open an app from zoom.us." The alert names the scheme, the application the address would open in when Gecko knows one, and the full address. | Allow opens that address. Always allow also records the scheme as allowed for the site, and its later addresses from that site open without asking. | Deny opens nothing. Always deny records the scheme as denied for the site, and its later addresses open nothing without asking. |

**Which site a download belongs to** is the site of the document that triggered
its request (`loadInfo.triggeringPrincipal`), then the site recorded when the
download first reached Sval, then the tab's current site. On that last fallback
Sval cannot be sure whose download it is, so it asks even where the site's entry
says `allow`. A held download ends, refused, when agent access closes, when Sval
quits, or when the user cancels it in the downloads list, and what it had written
so far is deleted. A download Firefox itself blocks, as insecure or by Safe
Browsing, never reaches the permission and is not listed. A refused download
leaves no trace in history: Sval removes only its own download visit and, when they
name this download's file, its download notes, never the user's visits to the same
address. Every answer to a file or write alert is checked against the policy again
when it arrives, so a site the user blocked while the alert was up is refused, and
"Always allow" never overwrites a block.

**Which site asks to open an app** is the site of the document that started the
launch: the principal Gecko hands its dispatcher (`nsIContentDispatchChooser`'s
`handleURI`, given the redirecting page's principal for a redirect), read as
`siteOfPrincipal` reads a document's. A launch with no such site opens nothing.
The launch opens nothing, and is not asked about, when that site or the tab's
top-level page's site is Blocked or Read only: a frame's launch answers to the
page the user decided about as well as to its own site. An `apps` entry of
`"deny"` is the site-wide Deny that Settings sets, under which no scheme opens.
A tool never opens an app: `open_tab` and `navigate_tab` refuse such an address
(§4.1).

**Every way a page opens an app reaches one check.** A link click to a scheme
Gecko does not expose (`nsDocShell::OnLinkClickSync`), a load of a document or a
frame (`nsExtProtocolChannel::OpenURL`), a `window.open`, a form, a redirect and a
content process's request (`ContentParent::RecvLoadURIExternal`) all end in the
parent's `nsExternalHelperAppService::LoadURI`, which hands the address to the
dispatcher. Sval decides at the start of `handleURI`, for a context in an agent's
tab (`agentForLoad`). A tab the tree holds no node for yet, as one a page's
`window.open` made, is the agent's its openers are, since Gecko closes such a tab
once it hands the address on and it may never be filed. Gecko's own rules run
before and after: an address Gecko refuses before the dispatcher (a scheme no
application handles, `network.protocol-handler.external.<scheme>` false, a
sandboxed frame) is refused without an alert, and once Sval allows, Gecko's own
permission dialog and app chooser decide as in any tab. A tab the user has taken
control of opens apps as the user's.

A launch waits for the answer with no timeout, since no tool call waits on it. A
tab holds one apps alert at a time; a further launch in that tab while it is up
opens nothing and is not asked about, so a page cannot fill the screen with
alerts. Closing the window under the alert, or agent access closing, opens
nothing and records nothing.

Always allow for uploads covers folders, never the whole disk, because the
agent chooses which files it sends: the user approves the files in front of
them and the folders those files are in, and a file anywhere else is asked
about again. Each folder carries its scope. With `"subfolders": false`, the
default, a file is allowed when its parent folder is the folder; with `true`,
when the folder holds it at any depth, as Gecko's `nsIFile.contains` judges it.
A folder never covers a hidden file, or a file in a hidden folder below the
granted one: an entry whose name starts with a dot, on every platform, or that
Gecko's `nsIFile.isHidden` calls hidden (the hidden attribute, on Windows). On
Windows a name holding a tilde and a digit counts too: that is the form of an 8.3
short name, which names a dotfile without its dot, and Gecko gives no way to read
the long name. Such a file asks every time, because the home folder keeps keys and tokens in hidden
files (decision 0129).
"This folder only" is the default because a file's folder is often the home
folder or Downloads, and the folders inside those hold keys and credentials. An
Always allow never narrows a folder the entry already has: it adds only the
folders no grant covers, and a folder named again keeps the wider scope.
Settings shows each upload folder with its scope, and can narrow a folder to
"This folder only", remove one, or set the entry to Ask or Deny. It never widens
a scope or sets an entry to Allow: only an alert that showed the files gives
either. Settings shows each site's apps: Ask, Deny for every app, or the schemes
the site has asked to open, each Allow, Ask (which forgets it) or Deny. A scheme
is listed only once the site has asked for it. A Blocked site downloads, uploads
and opens apps for nothing, whatever its entries. A held download waits for the answer, with no
timeout, like a page-started load. An `upload_file` call waits for the answer like a
tool-started load (§5.6). The agent sees its
downloads, finished or not, through `list_downloads`, which never lists the user's
own.

**A saved Allow for the camera, the microphone or the location is never used in
an agent's tab.** The user gave it for their own tabs, and on such a site a
prompt-injected agent could otherwise join a call or read the location unasked.
The page's request prompts as if nothing were saved, the prompt waits for Take
control like any permission prompt (§6), and it offers no answer to save. A
saved Block still refuses, and a device the user allowed in that tab still
counts (`agent-tab-device-prompts.patch`). Screen sharing asks every time, in
any tab.

**Site policy applies to every top-level load in an agent's tab, whoever starts
it.** That is the tool, the page (a link, a redirect, a timer), and the user. A
check on tool loads alone would let a page the agent opened navigate to any site,
the user's blocked ones included, and the agent would read it. The two kinds of
load differ in how they wait for an unanswered new-site alert:

- A load a tool starts (`open_tab`, `navigate_tab`) waits for the answer (§5.6),
  and Allow opens it.
- A load the page starts is suspended in the parent until the user answers, with no
  timeout, because no tool call waits on it. A tab holds one pending page-started
  alert. A further new-site load in that tab is refused without asking, so a page
  cannot fill the screen with alerts.

A site's alert is shared: a tool call that gave up, a retry, and a page's load of
the same site all wait on one alert.

A back or forward into the back-forward cache opens no channel, so no load check
sees it. Sval drops the back-forward cache of an agent's tabs whenever it may hold
a page the agent's rules would refuse: when agent access turns on, when the agent's
site rules change, when the user gives a tab back, and when a tab joins the agent's
workspace. The user's own tabs keep theirs. A back or forward is then a load, and
site policy applies to it.

**The level for a write is the level of the top-level page's site**, and not the
level of the site the request goes to. The user decided about the page the agent is
working on. The request's own target is often a third party, such as an analytics
host, that has no decision of its own, and its alert line still names it.

### 5.3 The write gate

**What counts as a write.** A request from the agent's tab with method POST,
PUT, PATCH or DELETE.

**Which writes are held.** Those that start while one of the agent's input
actions is in progress. That covers `click_element`, `type_text`, `fill_form`,
`select_option`, `press_keys` and `scroll_page`: an infinite-scroll page sends
POSTs as it loads more. The action window is open from the moment the input
starts until the tab's network has been quiet for 500 ms, meaning no request has
started or ended for that long and none the window let through is still in flight.
It closes at the latest 10 seconds after the input is done, and at the latest 30
seconds after it opened, so a page that never answers cannot hold the window open
and its writes unasked about for as long as it likes. Requests the page makes on
its own outside that window pass. The window covers every frame of the tab, and
every tab or window the tab's pages opened.

**Only the agent's own writes are held.** A write counts as the agent's when the
document the agent's input went to, or one of its frames, sends it. Once the tab's
top-level document is replaced by a navigation the input caused, what the new page
sends while it loads is that page's own start-up, analytics and the like, and
passes for the rest of the action. The navigation itself is still judged, so a
form posted by the agent's click is held. Without this rule a click that opens an article would ask the user
about the article's analytics, which the user cannot judge and the agent did not
send.

**Beacons and pings are never held** (`navigator.sendBeacon`, `<a ping>`). Sites use
them for analytics, and the page gets no answer from them. This is a deliberate
trade-off: a beacon is a credentialed POST, so a site that performs
a real action through `sendBeacon` performs it unasked. A Blocked or Read-only site
still refuses them. A `fetch` with `keepalive` is not a beacon and is judged.

While a write alert is unanswered, a further input in that tab returns
`awaiting_approval` without being performed, so a retry never sends the write twice.

This catches form submissions and also `fetch()` calls from click handlers,
which is how most modern sites implement "Buy" and "Send".

**How they are held.** An `http-on-modify-request` observer in the parent
suspends the matching channels, the same mechanism the WebExtension `webRequest`
API uses to block (`toolkit/components/extensions/webrequest/WebRequest.sys.mjs`).

**The alert.** Everything held during one action becomes one alert, with one
item for each request: "Claude Code is about to send: POST shop.com/api/order, POST
analytics.example/collect." Each item names the request's own target and path, so
the user sees what is sent where. The alert lists the first 20 and counts the rest.
The choices are Allow, Deny, "Allow writes on this site for this task", and
"Always allow writes on this site". Both site choices name the top-level page's
site (§5.2). The task choice ends when the agent disconnects (§5.5). "Always"
sets the site to Full access, so the user answers once per site, ever, and only
Settings undoes it. Deny cancels the held channels. The result
tells the agent what became of its writes: `none`, `allowed`, `denied`,
`refused_read_only` or `awaiting_approval`.

Under "Read only" the held requests are cancelled without an alert. Under "Full
access" nothing is held. With agent access switched off mid-action, the writes already
held are cancelled, and so is every write the open action windows would have judged
until they close; what a page the action navigated to sends on its own still passes.

**Known gaps.** The gate sees requests the parent process makes for a tab, and some
writes never reach it:

- A page that waits longer than the action window before sending a write escapes the
  gate. A test pins the delayed case so the gap stays visible.
- A GET that changes state, such as an unsubscribe link, is never held.
- A service worker's own fetches cannot be attributed to a tab: they carry no
  browsing context. The same holds for a shared worker's. A page's own request that
  a service worker answers is seen, because the parent notifies
  `http-on-modify-request` before it hands the request to the worker, so the gap is
  only what a service worker fetches by itself.
- Frames sent on a WebSocket or WebTransport that is already open open no channel,
  and the upgrade itself is a GET.
- A write relayed to another tab through a `BroadcastChannel` or a storage event,
  and sent from there, is not attributed to the action.

### 5.4 Handing tabs to an agent and taking them back

The user hands a tab to an agent by moving it into the agent's workspace. No
tool asks for the user's tabs: an agent reads and acts only where it works.

- **Move to Workspace hands a tab or a group over.** The row menu's Move to
  Workspace lists the user's workspaces, then "New Workspace…", then the
  agents' workspaces after a disabled "Agent Workspaces" item, each named as
  the switcher names it. The caption is a disabled item because the same
  entries fill the menu bar's Tab menu, where a native menu draws no
  `menucaption`, as the menu bar's Workspaces menu does.
- **Sval asks first.** Choosing an agent's workspace opens one Sval dialog,
  with Cancel: "Hand this tab to Claude Code?", saying the agent can read the
  tab and act in it, and what it gets with it. A move within one jar keeps
  the tab's sign-ins, and the agent can use them. A move into an isolated agent workspace reloads each tab at its
  address in the agent's jar, without its history (isolated workspaces spec
  §6), so the agent gets none of the user's sign-ins. A move from an isolated
  workspace of the user's into a shared agent workspace reloads it in the
  shared jar, with the sign-ins the user's shared workspaces hold. That one
  dialog says the jar's part too, so a move across jars asks nothing more.
  Cancel moves nothing.
- **The move is the ordinary one.** The node moves under the agent's
  workspace, and the user's window releases the tab. A tab the release keeps
  loaded, such as one holding typed text, moves to the agent's window with
  its page, its typed text and its back and forward history. Any other tab
  opens there lazily, at its address alone, when a tool first names it.
- **The user's history stays theirs unless they include it.** When a tab
  would take history along (a move within one jar of a tab the release keeps
  loaded), the dialog offers "Include the pages you visited earlier in this
  tab", unchecked. Unless the user checks it, every moving tab is marked as
  holding the user's history before the move makes it the agent's
  (`SvalAgentControl.markUserHistory`, the mark decision 0107 keeps for a
  copy of a user's tab), whichever window holds it and whether or not it
  stays loaded. `navigate_tab` then steps only into entries the agent's own
  navigations make; the page and its typed text stay. Checked,
  the agent may step back and forward through it. The dialog shows no
  checkbox when no tab takes history along: a tab the release lets go, and
  any move across jars, which reopens each tab at its address. The tree's agent mark then makes it the agent's for every
  check at once (`SvalAgentTabRegistry`): the tools reach it, the gate
  decides its loads, and its pages get WebMCP.
- **Taking a tab back works whether or not agent access is on.** The user's window
  files the node under its own workspace when a tab from an agent's workspace
  arrives there, and records that the tab is the user's. Without that, a tab dragged
  out while access was off would stay filed under the agent, the agent's tab list
  would show what the user reads in it, and the next restore of the agent's window
  would hand it back. A tab taken back is released for good: nothing it opens is
  gated or adopted through it, and its dialogs and file pickers are the user's.
  A move into another agent's window is not a take.

### 5.5 A task is one MCP connection

"Allow writes on this site for this task" ends when the agent disconnects. The agent's window and tabs stay.

### 5.6 Alerts while Sval is in the background

Alerts appear in the agent's window, and an OS notification points the user
there. Every alert is browser UI.

**Every site, write, file and apps alert opens in the agent's own full window**, never in the
window the page's content is in. That window can be a popup the page can move,
resize or close, which would take the alert with it, or a window of the user's the
content is about to leave.

**Allow has Firefox's dialog enable delay.** Every choice but the default is
disabled until the alert has been shown and focused for
`security.dialog_enable_delay`, as Firefox's own prompts are. An alert can open
under a click the user meant for the page, and that click must not land on a grant.
Deny is never delayed, and Escape always answers Deny. While the delay holds the
grants, a line below the buttons says "Allow unlocks a moment after this alert is in
front", because on macOS the click that brings Sval forward lands on the still-disabled
Allow. The line sits below the buttons so they never move as they enable. The pairing
alert has the same delay: a page cannot raise it, but it is a grant.

**Closing the window under an alert records nothing, and is not a Deny.** A dialog
queued behind another settles only when the window opens it next, so in a window
that closes it would hang, and a dialog that was showing would answer with its
default. Sval treats both as no answer: nothing is recorded, a held load is refused,
held writes are cancelled, and a tool call fails with `no_window`. A retry raises a
fresh alert.

**A tool call waits for the user's answer, and the answer carries it on.** An
agent blocked on an alert must hear the answer when it happens; a call that gives
up first leaves the user to tell the agent to try again. Every call waits until the
user answers or the limit the user picks in Settings › Agents runs out, an hour
unless they pick another, read as each call first waits (decision 1880). When the
call carries an MCP `progressToken`, Sval also sends `notifications/progress` every
10 seconds, whose message says it is waiting for the user, so the client shows why.
Either way, Allow carries the
call on at once (the tab opens, pairing completes, the held writes go), Deny refuses
it, and a call still unanswered at its limit returns `awaiting_approval` with the
alert left up. Retrying attaches to the same pending alert. The limit is per call:
a call that waits on two alerts in turn, such as an upload whose page then writes,
still gives up at its one deadline.

A waiting call does not hold up the agent's other calls: the connection moves on to
its next request while one waits, so the agent can list tabs or work in another tab.
At most 8 calls on one connection wait at once; a ninth answers `awaiting_approval`
at once, without raising another alert. One action runs at a time per tab, so two
calls' writes never land in one alert. An upload reads its files only after the user
allows it. A call the client cancels (`notifications/cancelled`) stops waiting and
sending progress, and a later Allow does not carry it on.

## 6. Making agent workspaces unmistakable

The marking is drawn by Sval's chrome, so a page cannot fake or hide it, and it
never relies on colour alone. A user looking at any Sval window must be able to tell,
at a glance and without reading, whether an agent is working in it.

- **Robot face.** Every agent workspace carries a robot-face icon wherever a
  workspace is named: its switcher row, every tab in the workspace, handed-over
  tabs included, and the window title ("🤖 Claude Code — Sval", identifiable from the
  Dock, the taskbar and ⌘\`). The icon is Sval's own drawing, not an emoji, and the
  robot emoji is left out of the workspace emoji picker, so no workspace of the
  user's can wear it. A user workspace that already wears it, or is named with a
  leading robot, shows neither in the switcher or the window title, and every user
  window carries its own title preface, so no page title can make a user window
  read as an agent's.
- **Window.** A striped band along the toolbar and a frame in charcoal and grey,
  stark and drained of colour, darker than any workspace tint a user can pick, so
  the window reads as somewhere the user does not work. The window under the
  overlay shows in greyscale. **Take control** is the one bright thing in it.
  Sval draws it with its own CSS (`sval-panel.css`, `:root[data-sval-agent]`).
  Firefox's own remote-control cue (`:root[remotecontrol]`) is not reused,
  because `gRemoteControl` sets it on every window whenever any remote
  protocol listens, so it cannot say which windows an agent works in.
- **The window is the agent's until the user takes the workspace.** While an
  agent controls the selected tab, Sval lays one semi-opaque overlay over the
  whole window: the workspace panel, the toolbar and address bar, the page and
  any sidebar. The window stays visible through it. One card at its centre
  says the agent is controlling this workspace, with **Take control**. Until the
  user presses it, none of the user's input reaches the window: clicks, scrolling,
  touch, keys and shortcuts, context menus, drag and drop, and the commands of
  macOS's menu bar. So nobody nudges an agent's work by accident or mistakes the
  agent's window for their own. The agent's input is not affected: Sval dispatches
  it inside the page, beneath the overlay. The overlay follows the selected tab,
  so switching to a tab the user holds takes it down, and back to one the agent
  holds puts it up.
  - **The user is never trapped.** The window's frame stays the system's: the
    window moves by its title bar and toolbar, resizes at its edges, and
    minimises, maximises and closes from its window buttons, on macOS, Windows
    and Linux. The overlay leaves a hole over the window buttons Sval draws itself.
    The keys that only close, quit, minimise or hide the window, cycle to another
    window or open a new one of the user's still work, as do the matching menu
    bar commands and macOS's Window menu. Sval's own alerts (§5) draw above the
    overlay and take input as usual.
  - **Take control** is a deliberate act: a click on the button, or Enter or Space
    with the button focused. The keyboard rests on the card, never on the button,
    and Tab moves between them. **Take control takes the agent's whole
    workspace** (decision 0107). Until the user presses Give back, every tab in
    it, including tabs either party opens later, is the user's: every tool that
    acts in the workspace, `open_tab` and `close_tab` included, fails with
    `user_in_control`. The overlay goes from every window showing the
    workspace, and a bar above each tab's page says the user controls the
    workspace, with **Give back**. Only the user's Give back returns control.
  - While the user has control, each tab is the user's: its loads, page dialogs,
    file pickers and downloads behave as in any tab of the user's, and nothing the
    user does is held by the write gate (§5.3), which only ever holds the agent's
    writes. Giving it back restores every rule. The agent's reads still check the
    site of whatever page the tab then shows.
  - Dragging the tab out to one of the user's own workspaces takes it for good
    (§5.4), whether or not the user holds it. With the overlay up, the user takes
    control first to reach the tab.
  - **A take lasts until the user gives the workspace back.** It is kept by
    the workspace's node id in the device's local settings, so a discarded tab,
    a crash or a restart finds the workspace still the user's. `list_tabs` lists
    every tab with no title or address and `user_in_control: true`, because what
    the user browses there is theirs. History the user made while holding the
    workspace is not a target for the agent's back and forward after give-back.
  - **Taking control stops what the agent started.** A load the agent's input or
    tool started and that waits on a site alert is cancelled at the take; a load the
    page started on its own is released as the user's. Writes the agent's input
    caused before the take are still held and asked about (§5.3), so pressing Take
    control is never a way for the agent's work to slip through.
  - **What reaches a page without passing through the window is held too.**
    Media keys and the system's media controls go to the media of the user's
    own tabs, a game controller reaches no page in a tab the agent holds, and
    such a page opens no Picture-in-Picture window, for its video or for a
    document. A Picture-in-Picture window open as the user gives the tab back
    closes. An input method's composition and dictation go where the window's
    keyboard is, on the card, since the page never holds the window's focus.
  - **Beneath the overlay, the browser's own code cannot move the page either.**
    The address bar, back, forward, reload and stop are refused on that tab until
    the user takes control, whatever asks for them, because a typed address would
    load the user's own session where the agent can read it. The page's own
    navigation is unaffected. Pop-ups Firefox draws for the page (a `<select>` list,
    a date picker, form autocomplete) do not open. A page dialog draws beneath the
    overlay, so it never covers Take control: the agent answers it, or the user
    does once they have taken control.
- **Popups.** Firefox draws its own popups, panels, menus and tooltips, as
  native widgets above the overlay, so none opens while the overlay is up and
  one already open closes as it goes up. The menu bar's menus still open, for
  the window commands the overlay lets through. A page's permission prompt
  waits, suppressed as Firefox suppresses it under a tab dialog, and shows once
  the user takes control.
- **Activity.** While a tool call runs, the overlay's card says what the agent
  is doing ("Clicking 'Place order'"). A stopped agent's card says nothing of
  it. `set_task` names the agent's workspace for the work it is doing.
- **Stop.** A large Stop button, with a square stop glyph, sits on the
  overlay's card next to Take control, because the toolbar is beneath the
  overlay. Pressed, it refuses every call the agent makes, `list_tabs` and
  `set_task` included, with `stopped_by_user`, whose message starts "Stopped
  by the user." and tells the agent to wait for Resume. Resume takes Stop's
  place on the card, and the card reads "You stopped <agent>". Both are
  reached with Tab from the card and pressed with Enter or Space, and the
  keyboard follows the press from one to the other.
  - **Stop covers the agent.** It is kept by the agent's workspace, so it
    holds in every window and every tab of it, and for each session of the
    agent, since every session of an agent works in its one workspace (§3.5).
  - **Stop lasts until Resume.** It is written down at once in the device's
    local settings, with the takes, so a restart or a crash finds the agent
    still stopped. It is dropped with its workspace.
  - **Stop ends what the agent has under way**, as a take does: the call
    running is answered with `stopped_by_user` at once, a page query or input
    in the agent's tabs stops where it is, a load of the agent's is stopped,
    and one waiting on a site alert is cancelled. The page's own loads held for
    an alert stay held, and writes already held are still asked about (§5.3).
  - **Stop leaves the workspace the agent's.** The overlay stays up, and the
    user can still take control; giving the workspace back finds the agent
    still stopped.
- **Screen readers.** The window and its tabs announce that the agent controls
  them, and a tab the user holds announces that the user has control. The overlay's card
  is a modal dialog announced with its button, and the bar with its own.

**Known gaps.** DevTools still reaches a page under the overlay. The
overlay stops the agent window's DevTools keys and commands, so no toolbox
opens from that window, but a toolbox already open in a window of its own,
about:debugging and the Browser Toolbox reach the page. A write the user sends
from a tab they hold, inside an action window the agent opened before the take,
is held and asked about as the agent's, which fails safe.

### 6.1 Human-verification checks

An agent never attempts a check that asks for proof a person is there: a
CAPTCHA, a "verify you are human" page, a press-and-hold puzzle. Imitating a
person, or completing such a check, is what sites' terms and Anthropic's usage
policy forbid, and it is the opposite of an agent that is clearly marked. So a
check stops the agent and hands the tab to the user.

- **Detection is passive.** Sval fetches nothing from any vendor. The parent
  reads the response headers of each top-level document load in an agent's tab:
  `cf-mitigated: challenge` (Cloudflare, set on every challenge page) and
  `x-amzn-waf-action: captcha` (AWS WAF; its silent `challenge` is ignored).
  The page actor reports the page's own markers of an interstitial (Cloudflare's
  challenge options object, HUMAN's `px-captcha` block page) and each frame a
  person could see and use: at least 30 CSS pixels square, in the viewport, not
  hidden. A frame counts when it comes from a vendor's widget origin, kept in
  the pref `browser.sval.agents.challengeOrigins` (Turnstile, DataDome, reCAPTCHA
  v2's anchor and challenge frames, hCaptcha, Arkose), and a vendor's invisible
  modes never count. A widget's frame loaded as the whole page counts too. A
  widget counts only if it still shows 3 s after Sval first saw it, since managed
  widgets often clear themselves, and not once the page holds its answer. Only a
  code, a kind and a vendor name leave the parent; no log line names a site.
- **The agent is stopped.** While a check shows, every tool that reads or acts in
  the tab fails with `human_verification_required`, naming the tab, with `kind`
  (`interstitial` or `widget`) and `vendor`. `open_tab` and `navigate_tab` return
  it when the page they land on is one. `get_screenshot`, `navigate_tab`,
  `close_tab` and `list_tabs` still work, and `list_tabs` shows
  `human_verification: true`. `user_in_control` wins over it.
- **The user is told.** The overlay's card adds "This page wants you to confirm
  you're human. Take control to do it." The user takes control, completes the
  check, and gives the tab back.
- **Give-back checks again** at once, without the grace. A completed check
  clears, and one still showing is refused again.
- **Tests never reach a vendor.** The origin list is a pref, and the tests point
  it at a local test host and serve every check from local fixtures.

## 7. Lifecycle

### 7.1 Starting Sval in the background

`sval-mcp` starts the Sval installed beside it, in a process of its own that
outlives the agent (`src/launch.rs`):

| Platform | How |
|---|---|
| macOS | `open -g`, which leaves the active app active. |
| Windows | `CreateProcessW` with `SW_SHOWNOACTIVATE`, detached from the agent's console. |
| Linux | A process group of its own, with a `DESKTOP_STARTUP_ID` whose timestamp predates any input (`_TIME1`), so an X11 window manager keeps the user's window focused. An `XDG_ACTIVATION_TOKEN` in the agent's environment is not passed on, because on Wayland it asks for focus. |

**The agent's window does not take focus from another app.** When the user is in
another app, Sval's new window opens without activating Sval (macOS keeps the active
app under `open -g`; Windows shows it with `SW_SHOWNOACTIVATE`). **When Sval itself is the active app, the agent's window comes
to the front.** Every platform's window `Show` activates the window when its app is
in the foreground (macOS `makeKeyAndOrderFront` in `nsCocoaWindow.mm`, Windows
`SW_SHOWNORMAL` under `CanTakeFocus`, GTK focus-on-map), and the only exception,
an always-on-top window, keeps the window above everything. Changing that needs
native code, which Sval does not add, and handing focus back afterwards would still
take the user's keystrokes in between. Alerts come forward by design (§5.6).

`sval-mcp` starts Sval with the agent's environment, less every variable whose
name starts `MOZ_` other than `MOZ_ENABLE_WAYLAND`, on every platform. Gecko
reads those variables as switches with no check on who set them:
`MOZ_MARIONETTE` makes Marionette listen on a local port with no
authentication, `MOZ_DISABLE_CONTENT_SANDBOX` turns off the content sandbox,
and `MOZ_LOG` with `MOZ_LOG_FILE` writes network logs to a file the agent
names. None is the agent's to set on the user's browser.
`MOZ_ENABLE_WAYLAND` only chooses GTK's display backend. On macOS `open`
passes the environment it is given to the app it starts, so `sval-mcp` gives `open` the filtered environment alone. The
Remote Agent and the DevTools server start only from command-line flags,
which `sval-mcp` does not pass.

Sval still restores the user's own session windows when it starts.

### 7.2 The switch

Settings → Agents → "Agent access", off by default, is the pref
`browser.sval.agents.enabled`. While it is off, nothing listens and no
discovery file exists. A port file left by a crash is removed when Sval starts
with access off, and a clean quit removes it before the process exits. When
the listener cannot start, as when Sval cannot make `sval-agents` private on a
filesystem that refuses the mode, the Agents pane says why.

`sval-mcp` tells the two cases apart by the profile's lock: a Sval that holds
the profile with no listener is `access_off`, and no Sval at all is
`sval_not_running`, after it has tried to start one (§3.1).

### 7.3 Errors

| Situation | Result |
|---|---|
| No Sval holds the profile, and starting one did not bring up a listener that proves itself | `sval_not_running`, from `sval-mcp`. |
| A Sval holds the profile with no listener | `access_off`, from `sval-mcp`. |
| Sval refuses the shim's `hello` as older than it | `sval_mcp_outdated`, from `sval-mcp`. |
| Sval closed the connection before answering | `sval_disconnected`, from `sval-mcp`. |
| A peer that sends no valid challenge, a wrong or missing proof, or too much before the handshake | Sval closes with no reply. `sval-mcp` keeps its stored secret. |
| Proof valid, secret does not match | Sval sends `refused: unknown_agent` and closes. `sval-mcp` forgets the stored secret and pairs again once. |
| Unpaired agent calls anything but a pairing tool | `not_paired`. |
| Paired agent calls a tool Sval does not have | `unknown_tool`. |
| User declined, or closed the alert | `pairing_denied`. |
| Agent disconnected while the alert was open | `disconnected`, and nothing is created. |
| An argument Sval cannot take, or a request over 1 MiB | `invalid_arguments`. |
| A reply over 1 MiB | `result_too_large`, for that call alone; the connection stays open. |
| A tool or dependency failed | `internal_error` naming only the error's name, as a tool error for `tools/call` and as JSON-RPC `-32603` for other requests. The message stays out because it can carry a path and the agent's model reads it. |
| A method Sval does not implement | JSON-RPC `-32601`. |
| Policy refusal | `policy_denied`, naming the site and saying whether it is blocked or not yet allowed. |
| An address that is not `http`, `https` or `about:blank` | `unsupported_url`. |
| Tab outside the workspace | `not_controlled`. |
| Ref from an older document | `stale_ref`. |
| The page changed while Sval read it, or has no document yet | `page_changed`, `no_document`. |
| No decision within the wait (§5.6) | `awaiting_approval`. Acting again on a tab with an unanswered write alert also gets it. |
| The page gave no answer to an input within 30 s | `page_unresponsive`. |
| A load failed or took over 60 s | `navigation_failed`. |
| Back or forward onto a page an agent may not load | `no_history`. |
| An element covered by another, or holding a frame, a file chooser or another page | `click_intercepted`, `not_clickable`. |
| No window to show an alert in, or the window closed under it | `no_window`. The user gave no answer. |
| The user has taken control of the workspace (§6) | `user_in_control`. |
| The page asks for proof a person is there (§6.1) | `human_verification_required`, naming the tab, with `kind` and `vendor`. |
| User pressed Stop (§6) | `stopped_by_user`, for every call until Resume. |

Every tool error is JSON text carrying `error`, `message` and, where there is
one, `tab` (§4.1).

A notification gets no reply and runs nothing, so a `tools/call` notification
cannot raise an alert. Every request gets exactly one reply, because an agent
left waiting cannot tell a slow answer from none.

Sval quitting mid-task ends the connection. `sval-mcp` keeps the agent's
session and reaches the next Sval that runs.

### 7.4 Logging

Rule 10 of `CONTRIBUTING.md` applies. A line may carry the agent id, tool
name, error name and counts. It never carries an agent label, URL, site, tab
title, workspace name, or policy contents, and never anything a page wrote
to its console (§4.5).

### 7.5 Network contact

The listener accepts loopback connections only and Sval makes no new outbound
contact for this feature, so §10.9 of the main spec gains no host.

## 8. Testing

- **`sval-core`:** the `agent` field round-trips, survives merge, and converges
  across devices; a build without the field carries it verbatim.
- **xpcshell:**
  - policy evaluation for every level, exceptions, and new-site handling;
  - framing and the handshake;
  - refusal of an HTTP request line, a WebSocket upgrade, a TLS hello, a wrong
    secret, and an unpaired agent calling anything but pairing;
  - pairing stores only a hash, and unpairing deletes it and the policy while
    keeping the workspace.
  - deleting an agent's workspace unpairs it, its calls answer `not_paired`
    and its secret is refused; with Connect without asking on, it connects
    with its secret and gets a new workspace with no alert, and a connection
    giving the same name without the secret is asked about.
- **mochitest, against local test pages:**
  - the write gate holds a form POST;
  - it holds a `fetch()` POST from a click handler;
  - a POST delayed past the action window passes, pinning the documented gap;
  - a page's own background POST outside any action passes;
  - Read only cancels without an alert, Full access holds nothing;
  - `stale_ref`, `not_controlled`;
  - dialog dismissal;
  - Allow and Deny on every alert;
  - Take control and Give back of the whole workspace, and Stop and Resume;
  - the window, tab and switcher marking, and the screen-reader label;
  - `navigator.webdriver` is false in an agent tab.
- **End-to-end on every platform:** `browser_sval_mcp_end_to_end.js` runs the
  packaged shim against a real Sval, through the listener, the handshake and
  the pairing alert.
- **`sval-mcp`:** unit tests for discovery, launch, the handshake and relay.

## 9. Open questions

None. Finding the profile and starting Sval are in §3.1 and §7.1.
