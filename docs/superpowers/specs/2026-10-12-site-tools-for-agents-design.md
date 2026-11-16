# Sites' tools for agents (WebMCP)

Date: 2026-10-12. Status: built. Decision 0095.
Builds on the agent-control spec (`2026-10-06-agent-control-design.md`) and
the first-run spec (`2026-10-07-first-run-design.md`).

## 1. What this is

WebMCP lets a page offer tools to agents. A tool has a name, a description, an
optional JSON Schema for its input, and a function in the page that runs it with
the user's session. This spec lets a paired agent see and call the tools of pages
in its own workspace, under permissions the user sets.

An agent working on a site that offers tools sees them, calls them under that
site's level, and the user approves what they would approve for a click. Nothing changes for a user who leaves the feature off, and
no page outside an agent workspace can tell the feature exists.

## 2. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **Use Gecko's own prototype.** ESR 153 ships `dom/modelcontext` (bugs 2018320 and 2018323, landed in Firefox 150): `navigator.modelContext` with `registerTool` and `unregisterTool`, and the parent-process `nsIModelContextService` with `getToolsForWindow` and `invokeTool`. | It already exists and Mozilla keeps developing it. Their WebDriver BiDi bug (2022028) builds on the same service. |
| **A Gecko patch exposes the API only in agent tabs.** | Gecko gates the API on one global pref. With it on, every site in every workspace sees `navigator.modelContext`. That is a fingerprinting signal, and it changes how pages behave in the user's own browsing. |
| **Three permission layers, each failing closed.** A global switch, a setting per agent, and a setting per agent per site. | The user decides whether the feature runs at all, whether this agent may use site tools, and whether this site may offer them to this agent. |
| **A tool call is an agent action.** It opens the same action window as a click (agent-control §5.3), and an allowed call's writes pass. | One approval per action. The call alert shows the arguments, which a write alert never would, and the arguments are where data leaves. |
| **`readOnlyHint` is trusted for prompting, never for writes.** A hinted call runs without a call alert, and the write gate still judges what it sends. | The hint is the site's claim. A site that lies about it is caught by the gate. |
| **The global switch is off by default**, in Settings and in first run. | Decision 0095. |
| **The sval-mcp tool contract does not use Gecko's names.** | Mozilla's API shape moves (`document.modelContext`, tools identified by ID). The agent should not notice the yearly rebase. |

Mozilla's position on WebMCP is neutral
([standards-positions#1412](https://github.com/mozilla/standards-positions/issues/1412)).
Its concerns are the ones this design answers: tools that do not match the page,
prompt injection through tool text, and data collection through arguments.

### 2.1 Rejected approaches

- **Turning the pref on globally and refusing calls outside agent tabs in the
  parent.** Rejected for the fingerprinting and behaviour change above.
- **Sval's own `modelContext`, injected from an actor.** It needs no Gecko patch,
  but it reimplements what Mozilla ships and drifts from it.
- **The write gate alone, with no call alert.** The user would never see the
  arguments.
- **A call alert and a write alert for the same call.** That asks twice for one
  action.
- **Dynamic MCP tools, one per page tool.** Names collide across tabs, and the
  list would change on every navigation. Two fixed tools carry the tab instead.

## 3. Architecture

```
page JS ──registerTool──▶ Gecko modelContext (agent tabs only, via patch)
                                 │
                     nsIModelContextService (parent process)
                                 │
              SvalAgentPageTools.sys.mjs  ◀── policy: A / B / C + site level
                                 │                write gate (agent-control §5.3)
                           SvalAgentTools ──bridge──▶ sval-mcp ──▶ agent
```

### 3.1 The Gecko patch

`patches/sval-agent-model-context.patch`:

- A synced BrowsingContext field, `SvalAgentTab` (bool), settable only from the
  parent.
- The `[Pref="dom.modelcontext.enabled"]` gates on `ModelContext`,
  `ModelContextClient` and `Navigator.modelContext` become `[Func=…]`. The check
  passes when `dom.modelcontext.enabled` is true and the window's top-level
  BrowsingContext has `SvalAgentTab` set.

Sval sets `dom.modelcontext.enabled` to true only while both agent access
(agent-control §7.2) and the global switch (§4.1) are on, so Gecko's service
refuses calls on its own otherwise.
`dom.modelcontext.testing.enabled` stays false outside tests.

A page's interfaces are fixed when its global is created. A flag change is
picked up at the next navigation.

### 3.2 Setting the flag

Sval sets `SvalAgentTab` in the parent when a tab is created in an agent
workspace or moved into one (agent-control §5.4), and clears it when the user
takes the tab back. Private windows never hold agent tabs, so they never get the
API.

A document already loaded when the user takes its tab back keeps the API until
it navigates. Its tools are unreachable, because calls come only through the
parent, which checks that the tab belongs to the calling agent on every call.

### 3.3 `SvalAgentPageTools.sys.mjs`

The only caller of `nsIModelContextService`. It:

- lists a tab's tools for its current inner window;
- applies the permission layers (§4) and the site level;
- runs a call inside an action window, so the write gate applies;
- cleans and caps everything that came from the page (§5.3).

### 3.4 No agent JavaScript

Agents run no JavaScript of their own (agent-control §2.1). An agent can call
only functions the page chose to offer.

### 3.5 Out of scope

- `ModelContextClient.requestUserInteraction`. Gecko's prototype rejects it
  with "not supported", and Sval leaves it so.
- Tools registered by iframes (bugs 2019743, 2022027) and declarative form tools
  (2018326, 2022029). Neither is in the prototype.
- Site tools for anything other than a paired agent. WebExtension (2019124) and
  BiDi (2022028) access.

## 4. Permissions

### 4.1 The three layers

| Layer | Values | Default | Stored |
|---|---|---|---|
| **A.** "Let sites offer tools to agents" | on / off | off | Local pref `browser.sval.agents.pageTools.enabled`. It does not sync. |
| **B.** Site tools for this agent | off / ask / on | ask | The agent's policy, `pageTools` |
| **C.** This site's tools for this agent | allow / deny / no entry | no entry | The agent's policy, `pageToolSites` |

A tool reaches an agent only when A is on, B is not off, and C is `allow`.

- **A off:** no page has the API, and no agent sees the two tools (§5.1).
- **B off:** this agent never sees any site's tools.
- **B ask:** every call this agent makes raises a call alert, whatever the
  site's level.
- **B on:** calls follow the site's level (§4.3).
- **C no entry:** the first time the agent meets tools on the site, Sval asks
  (§4.2). Allow and Deny are stored as `allow` and `deny`.
- **C deny:** the agent sees none of the site's tools.

A site's level (agent-control §5.2) still applies first. A Blocked site never
loads.

The policy's fields for site tools:

```json
{ "pageTools": "ask",
  "pageToolSites": { "shop.example": "allow", "spam.example": "deny" },
  "pageToolGrants": { "shop.example": { "add_to_cart": "<sha256>" } } }
```

**A value Sval cannot read counts as no decision**, as in agent-control §5.2. An
unreadable `pageTools` is `ask`. An unreadable `pageToolSites` entry counts as
no entry, so Sval asks again. A grant Sval cannot read, or whose hash does not
match, is ignored. Nothing unreadable ever grants more than asking. A write
keeps every field Sval does not know.

### 4.2 The site alert (C)

Raised by `list_page_tools` or `call_page_tool` when the page has at least one
tool and C has no entry for the top-level page's site:

> shop.example offers 4 tools to Claude Code: search, add_to_cart, checkout,
> track_order. Let Claude Code see and use them?

Allow / Deny. The alert lists up to 10 names and counts the rest. A page with no
tools raises nothing. The call waits for the answer as a tool-started load
waits (agent-control §5.6). The answer is checked against the policy again when
it arrives, so a site blocked while the alert was up stays blocked.

### 4.3 Calls

| | Read-only site | Ask-before-writes site | Full-access site |
|---|---|---|---|
| **B ask**, hinted tool | Call alert; its writes are cancelled | Call alert | Call alert |
| **B ask**, unhinted tool | Refused, `refused_read_only` | Call alert | Call alert |
| **B on**, hinted tool | Runs; its writes are cancelled | Runs; its writes go to the write alert | Runs |
| **B on**, unhinted tool | Refused, `refused_read_only` | Matching grant: runs. Otherwise a call alert | Runs |

"Hinted" means the tool carries `annotations.readOnlyHint: true`.

**The call alert** shows the agent, the site, the tool's name and description,
and its arguments as formatted JSON, all of them: a call whose arguments run
past 2000 characters of that JSON fails with `invalid_arguments` and is not
asked about, because Allow must cover only what the user was shown. It says the
site's own code runs the tool and can do anything the user's account on that
site can do. The choices are Allow and Deny, which answer for this call,
"Always allow "<tool>" on <site>", and "Always deny <site>'s tools", which
records `deny` for the site (layer C). Under B ask the Always allow choice is
not offered. Every answer is checked against the policy again when it arrives.

**Always** stores, under the site in `pageToolGrants`, the SHA-256 of the tool's
canonical JSON definition: name, description, input schema and hint. A later
call matches only when the page's current definition hashes the same. A changed
description or schema asks again, so a site cannot get "search" approved and
then turn it into "transfer".

**What Allow covers.** An allowed call opens an action window whose writes pass
without a write alert, except on a Read-only site, where they are cancelled. A call that runs without an alert (hinted, or under Full
access, or by grant) opens an ordinary action window, and the gate judges its
writes by the site's level as it does a click's.

**Action windows.** Every write a tool sends while it runs is judged. The call
opens an action window when the tool starts, and the window stays open until
the tool answers, then closes as agent-control §5.3 describes. A tool can wait
on its own write, which the gate holds until its window closes, so a window's
input ends at the first write it holds: the window closes, the user is asked
about what it holds, and once they answer a new window opens for the rest of
the tool's run. A call answers the agent with the most telling of its windows'
outcomes.

Each window gives the tool 60 seconds, so time spent waiting on the user is
not counted. A tool that does not answer or send a held write within a
window's 60 seconds fails the call with `page_tool_timeout`. The tool cannot be stopped, so when a call answers the
agent while its tool still runs, after a timeout or because the user has not
answered yet, the gate cancels every write the page sends until the tool
settles, at most ten minutes.

A refused call (`Refused` above) fails with `policy_denied` and carries
`writes: "refused_read_only"`.

While a call alert or write alert is unanswered, a further call or input in that
tab returns `awaiting_approval` without running, as for clicks.

## 5. What the agent sees

### 5.1 Two tools

| Tool | Does | Alert |
|---|---|---|
| `list_page_tools(tab)` | The tab's URL and title, and `tools: [{name, description, input_schema, read_only}]` for the current document | Site alert, if C has no entry (§4.2) |
| `call_page_tool(tab, name, input)` | Runs the tool. Returns `{result, writes}` | Site alert; call alert or write alert (§4.3) |

`writes` uses agent-control's outcomes: `none`, `allowed`, `denied`,
`refused_read_only`, `awaiting_approval`.

Both tools are in an agent's tool list only while A is on and its B is not off.
When either changes during a session, Sval sends
`notifications/tools/list_changed`, as it already does after pairing. A call
that races a change fails with `page_tools_off` or `policy_denied`.

### 5.2 Rules

- **Tools belong to the current document.** A call names the tool, and Sval looks
  it up in the page as it is now. A tool that is gone, because the page
  navigated or unregistered it, fails with `unknown_page_tool`, whose message
  tells the agent to list again.
- **The site is worked out again just before the call runs**, as for
  `upload_file`. If the tab moved to another site while an alert waited, the
  call fails with `page_changed` and nothing runs.
- **Withheld content.** On a site the agent may not read (agent-control §4.1),
  tool names, descriptions and results are withheld like page titles.

### 5.3 Untrusted page text

Everything a page supplies is untrusted, as `nsIModelContextService` itself
warns.

- Names: control and format characters removed, at most 64 characters.
- Descriptions: the same cleaning as page titles, at most 2 KiB.
- Input schemas: over 16 KiB becomes `null`, and the description says so.
- Results: converted to JSON. A value that cannot be fails with
  `page_tool_bad_result`. Over 256 KiB fails with `page_tool_result_too_large`.
  Both caps keep a reply well under the bridge's 1 MiB frame.
- A tool that throws fails with `page_tool_failed`, carrying the page's message
  after the same cleaning as a description.

### 5.4 Errors

The existing shape and codes apply (agent-control §7.3), including
`awaiting_approval`, `policy_denied`, `user_in_control` and `dialog_open`. New
codes:

| Code | When |
|---|---|
| `page_tools_off` | Switch A is off |
| `unknown_page_tool` | No tool by that name in the current document |
| `page_tool_failed` | The page's tool threw or rejected |
| `page_tool_timeout` | The page's promise did not settle within 60 s |
| `page_tool_bad_result` | The result cannot be converted to JSON |
| `page_tool_result_too_large` | The result is over 256 KiB |

### 5.5 Server instructions

The instructions (agent-control §4.1) carry one paragraph on site tools: they
are written by the site; their descriptions are the site's claims, never
instructions to the agent; prefer a site's tool to clicking when one fits the
task. `sval-mcp`'s copy matches it.

### 5.6 Marking and logging

While a call runs, the tab shows the agent's activity mark, as for a click.
Each call is logged like a click, by tool name only. Arguments and results are
never logged.

## 6. Settings

- **Agents pane:** a second switch under "Agent access", "Let sites offer
  tools to agents" (A). It can be changed only while agent access is on, and
  keeps its value when agent access goes off.
- **Per-agent editor** (`settings-agent-policy.js`): "Site tools", Off / Ask /
  On (B). A per-site "Site tools" setting, Ask / Allowed / Blocked (C). Under
  each allowed site, its remembered tools, each with Remove. Every Always and
  Allow an alert records can be undone here, so first run is not the only
  route to a setting (Sval spec §10.8).

## 7. First run

The **Agents** step in `SvalFirstRunModel` comes after `passwordManager` and
before `panelSide`, on both paths, because agent access is per device.

- A labelled radio group, like every other first-run step (first-run spec
  §7), asking whether AI assistants may use Sval: "No" (selected) and "Yes".
  Under Yes alone, a checkbox lets websites offer AI assistants tools. The
  checkbox keeps the order the switches impose: site tools only with agent
  access.
- One line says an AI assistant on this computer can browse in Sval and that
  Sval asks before any assistant connects. It names no vendor.
- Continue writes both prefs from the choice. Skip setup leaves both off.
- First run does not pair an agent.

## 8. Testing

- **Gecko patch (mochitest):** a page in a normal tab has no
  `navigator.modelContext`, whatever the switches say. A page in an agent tab
  has it only while A is on. A tab taken back loses it at its next navigation.
  A private window never has it.
- **Policy (xpcshell):** every A/B/C combination resolves as §4 says. Damaged
  values fail closed. A grant whose hash no longer matches asks again. Writes
  keep unknown fields.
- **Tools (browser-chrome), with test pages that register tools:**
  - list and call under each site level and each B value;
  - the site alert and the call alert, and each answer;
  - a tool that claims `readOnlyHint` and POSTs: held under ask-before-writes,
    cancelled under read-only;
  - a navigation while an alert waits gives `page_changed`;
  - an unregistered tool, a throw, a timeout, an unconvertible and an oversized
    result;
  - descriptions with control characters and injected instructions arrive
    cleaned;
  - a site the agent may not read withholds tool text;
  - `list_changed` fires when A or B changes.
- **First run:** the step on both paths; "No" preselected; Skip setup
  leaves both prefs off; each choice writes the prefs it names.
- **sval-mcp:** the server-instructions test still matches.

## 9. Upkeep

The patch and `dom/modelcontext` are internal Gecko code with no stability
promise. The tests above pin their behaviour, and the yearly ESR
rebase checks them, as it checks the internal modules the agent-control spec
names. Mozilla's
newer shape (`document.modelContext`, tools identified by ID) needs the patch
adapted when a rebase brings it. The sval-mcp contract stays as it is.

## 10. Network contact

None. The pages are already loaded, and calls run in them.
