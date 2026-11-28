# Sval — Design Specification

**Status:** The design Sval is built to. It describes Sval as it is. §15 lists
what it designs and no code provides; everything else is built. Where a later
spec holds a feature's mechanism, the section here states the rule and names
that spec.
**Author:** John Postlethwait

---

## 0. How to use this document

Read this spec before changing anything. These are hard rules for every
change:

1. **The design principles in §2 are load-bearing.** Every implementation choice
   gets judged against them. If a task seems to require violating one, stop and
   raise it rather than deciding on your own.
2. **The principles' wording is fixed.** Do not reword, "improve,"
   or summarize them in code comments, docs, or UI copy.
3. **§3 records decisions that are already made, including alternatives that were
   explicitly rejected and why.** Do not relitigate them, and do not silently
   reintroduce a rejected approach because it looks convenient.
4. The repository's hard rules, layout, licensing, builds and test placement
   are in `CONTRIBUTING.md` and `engine/CLAUDE.md`.
5. When a section says TODO or VERIFY, it is not an invitation to guess. Do the
   verification and report the result.

---

## 1. What Sval is, and why it exists

Sval is a desktop web browser: a fork of Firefox ESR whose distinguishing feature
is **workspaces that actually sync** — nested groups of tabs, with live tab state,
converging across all of a user's devices, stored wherever the user chooses, with
no Sval server anywhere in the picture.

It exists because everyone who built workspaces skipped sync, and everyone who
built sync skipped workspaces. Sval does both.

---

## 2. Design principles

These are locked. They are the user's own wording. Do not reword them.

1. **Your data belongs to you.** You decide where it's stored. Sval runs no servers,
   so there is nothing for anyone to breach, sell, or shut down. Everything can be
   exported in open formats at any time, so leaving is always easy.
2. **Simple by default, deep on demand.** A normal person never meets the word
   "encryption"; a curious one finds the key, the format, and the export in one panel.
3. **No feature is compulsory.** "Never" is always a valid setting.
4. **Compose, don't replace.** Work with 1Password, uBlock Origin, and Keychain
   rather than demanding users switch.
5. **Built to outlast its maker.** Open formats, documented protocol, published
   decryptor.
6. **Your attention is yours.** No telemetry by default, no engagement mechanics,
   no AI that speaks first.

### 2.1 Applying principle 2

The tension: the architecture is cryptographic, and most users flee from that.
The resolution is progressive disclosure, never two products.

- Setup never asks for a passphrase and never shows key material.
- A single "Technical details" disclosure reveals the key, the format, the raw
  blobs, and the export.
- Every advanced capability is *discoverable*, never *mandatory*, never in the way.

---

## 3. Locked decisions and rejected alternatives

Do not reopen these without the maintainer.

### 3.1 Base: fork of Firefox **ESR**

**Why a fork at all.** Sval's required features need privileged access that
extensions cannot reach: real tab state via the session store, the login manager,
cookie jars, a panel that renders where the user chooses, and switching off
Firefox's own credential UI completely. The cheaper tiers were evaluated and rejected:

- *Extension only* — cannot reach the password manager, has no filesystem access,
  cannot place the panel, cannot read a tab's history stack. Sidebery already
  occupies this space and does it well; the gap it leaves is sync.
- *Extension + native helper* — solves filesystem, not the rest.
- *Autoconfig (`config.js`) privileged JS* — works today, but unsupported, can be
  removed by Mozilla, and breaks macOS bundle signing. Building a product on it is
  building on sand.

**Why ESR over Rapid Release.** ESR takes major versions roughly annually and
receives security fixes as backports on the same schedule. Critically, **ESR
excludes Mozilla's UI/UX changes**, and the front-end is the only layer Sval
patches. Rapid Release would churn exactly the files Sval modifies, thirteen times
a year. ESR converts that into one deliberate rebase. Tor Browser's threat model
depends on ESR being safe; Waterfox ships on it.

Cost accepted: trailing new web platform features by up to a year. Irrelevant for
a workspace browser.

### 3.2 Engines that were ruled out

- **Chromium** — no MV2. MV2 is a founding requirement. Disqualifying.
- **WebKit** — no production Windows port (this is exactly why Orion can't serve
  this user), and Safari-style declarative content blockers with rule limits are
  the same neutering as MV3.
- **Servo** — ~81.5% WPT, no extension system of any kind, and it is an engine,
  not a browser. Revisit only if WPT exceeds 95% and a real extension story exists.
- **Ladybird** — pre-alpha by its own team's description, no Windows, no extensions.
  Worth watching.
- **Pale Moon / Goanna** — a genuine Gecko fork, but predates multiprocess and
  breaks modern sites.
- **Replacing Firefox's front-end wholesale (the Arc approach)** — rejected. Gecko
  has no stable embedding API outside Android's GeckoView, so Firefox's front-end
  is the only consumer of Gecko's internals and those internals have no stability
  contract. A wholesale replacement swaps a handful of loud merge conflicts for
  hundreds of silent runtime breakages, and would require reimplementing every
  WebExtensions UI surface — which MV2 support depends on.

### 3.3 No cookie sync

Cookie jars are **per-workspace and stay on the device**. Only the workspace and
its isolated flag sync (§10.1).

This was designed, then deliberately cut. Cookies are post-MFA bearer tokens:
possession is authentication, they bypass the second factor, and they survive
password changes. The industry is moving hard the other way — Chrome shipped
App-Bound Encryption in 2024, and **DBSC (Device Bound Session Credentials)
entered public rollout in Chrome 146 in April 2026**, binding cookies to the TPM
or Secure Enclave. Syncing cookies is precisely what DBSC exists to prevent.

Also: no mainstream browser syncs cookies, so there is no prior art to borrow
safety design from; the feature would erode as sites adopt DBSC; it collapses
blast radius so one compromised device yields every session; and it trips
enterprise conditional access. The payoff was only first-use-per-device
convenience, since each device accumulates its own sessions naturally.

**The door stays open.** Jars exist locally; syncing them later is a transport
change, not a redesign.

### 3.4 Deferred or dropped

| Item | Decision |
|---|---|
| AI features | Deferred past v1. BYO API key or local model. No Sval-run inference. No chat sidebar, nothing that speaks first. Agents the user runs drive Sval through sval-mcp (`2026-10-06-agent-control-design.md`); that is a separate feature. |
| Workspace sharing / collaboration | Out. Later or never. Real-time needs a server (violates principle 1) and the maintainer has no interest. |
| Split view | In v1. Two to four tabs side by side in one window (`2026-10-18-split-view-design.md`). |
| Tiling beyond a split | Post-v1. |
| Command palette | In v1 as the Launcher: the address bar, grown into one place to find tabs, pins, Favorites, commands, history and the web (`2026-10-22-launcher-design.md`). |
| Cloud provider APIs (Drive, OneDrive) | Post-v1. See §6.4. Dropbox and SMB are reached directly (decision 2650). |
| Mobile (iOS, Android) | v2 fast-follow. Designed for now. See §11. |
| Linux | **In v1.** It ships as a tarball, a .deb and an .rpm (decision 0094). See §12. |
| Inline Hide My Email | Post-v1. See §7.5. |
| A credential store of Sval's own, including Firefox's | **Rejected.** The user's password manager owns every credential. See §7.1. |
| Published format spec + CLI decryptor | Parked as scope creep. In-app export already satisfies principle 1. See §6.8. |
| Key rotation / device revocation | Dropped as features. Setting up sync again with a new sync key shuts out a lost device (§6.6). See §13. |
| CRDTs, including Automerge | **Rejected, do not reintroduce.** See §5.3. |

---

## 4. Architecture overview

```
┌─────────────────────────────────────────────┐
│ sval (Firefox ESR fork)                      │
│  ┌───────────────────────────────────────┐  │
│  │ Chrome layer (JS/XHTML/CSS)           │  │
│  │  panel UI · password manager picker   │  │
│  │  tab observers · first-run            │  │
│  └──────────────┬────────────────────────┘  │
│                 │ JS ↔ WASM bridge          │
│  ┌──────────────▼────────────────────────┐  │
│  │ sval-core (Rust → WASM)                │  │
│  │  tab tree · per-fact-group merge      │  │
│  │  encryption · storage providers       │  │
│  └──────────────┬────────────────────────┘  │
│                 │ I/O shim (WASM has no I/O)│
│  ┌──────────────▼────────────────────────┐  │
│  │ Chrome JS: filesystem, timers         │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
                  │
        encrypted files on disk
                  │
     a folder the user chose (may be cloud-synced)
```

The engine (`engine/`, the `sval-core` crate) is the product. The fork is a
host for it. The same core, compiled
natively with UniFFI bindings, serves iOS and Android in v2.

---

## 5. Data model

### 5.1 Entities

```
Every node carries four independently-timestamped, independently-attributed
facts:

  content     name, icon, url, ...                    -> content_at, content_by
  placement   parent, order                           -> placement_at, placement_by
  lifecycle   pinned, isolated, auto_archive, ...     -> lifecycle_at, lifecycle_by
  appearance  color, emoji, label                     -> appearance_at, appearance_by

and one stamp that holds no value:

  touched     (nothing)                               -> touched_at, touched_by

Workspace  id, kind, + the four fact groups
Group      id, kind, + the four fact groups
Split      id, kind, + the four fact groups; its children are its panes
Tab        id, kind, + the four fact groups
```

A workspace's `isolated` (§10.1) and `auto_archive` (§10.2) are lifecycle
fields, so they merge by lifecycle's timestamp and never compete with a rename.
A workspace can carry a mark saying whose it is, set when it is made and never
edited: `agent`, an agent's (agent-control spec §3.5), or `device_home`, a
phone's or tablet's own (decision 2254). Merge keeps either side's mark, and a
build that doesn't know one keeps it as an unknown field.
A split holds two to four tabs shown side by side (`2026-10-18-split-view-design.md`).
The other documents hold kinds of their own: `setting` (§5.6), `favorite`,
`folder` and `separator` (Favorites), `visit` and `shard` (history), and
`archived` (the Archive, §10.2). `engine/src/types.rs` is the full list.

**Why three timestamps rather than one.** Renaming a tab, moving it and pinning
it are unrelated acts, and with a single timestamp they compete for the same
slot. That loses data in a sequence a user would consider obvious:

1. Rename on device A.
2. Pin on device B, which has not yet seen the rename.
3. Expected: the tab is pinned and carries the rename.

With one timestamp per record, B's pin is later, so B's whole record wins and A's
rename is gone permanently with no path to recovery. Nobody renamed the tab on B;
B only pinned it. Separating the facts makes step 3 fall out with no special
case, and the same holds for a move racing a rename.

**`pinned` belongs to lifecycle, not content.** Pinning is a state of the tab,
not a description of the page. Putting it in `content` would make pinning on one
device collide with renaming on another — the same failure the split into
groups exists to prevent, one field lower down. Lifecycle stays a fact group of its
own for that reason: it is where a node's *state* lives, and whatever state a
later build adds beside `pinned` must merge without competing with a rename.

**The touch stamp records work inside a node, and holds nothing.** Filing a
tab under a workspace is not an edit to the workspace's own facts, but it is
work in it, and a peer deleting the workspace without having seen that work
must lose its delete (§5.4, decision 0106). A stamp in any of the four groups
would replace that group's value, and so could lose an edit made elsewhere that
the stamping device had not seen yet. A stamp with no value competes with
nothing: it merges like a group whose content is always equal, so the later
stamp wins and a tie goes to the writer. It is written only when the host
touches a node, and a node never touched carries no key for it.

**Appearance is its own group, for the reason lifecycle is.** Colour and emoji
describe how a workspace or group *looks*; the name describes what it *is*, and
the two are set at different moments. Recolouring a workspace on a laptop while
a desktop renames it is the pin-versus-rename collision again, and carrying them
in `content` would lose one. A flat field outside the groups would have no
timestamp, and so no answer to which side wins.

**A tab's appearance is the name a user gave it.** A workspace's and a group's
appearance is their colour and emoji. A tab's `content.name` follows its page's
title on every navigation, so a name the user gives a tab is `label`, in
appearance, and shown in place of that title. In `content` it would lose to a
navigation on another device that had not seen it (decision 2210). A tab's
icon is the site's favicon and belongs to `content`. The group exists on every
node kind so the model stays uniform.

**Emoji is a field, not a convention.** Vivaldi offers a fixed icon set and no
emoji, so its users type emoji into the name: "✉️ Mail", "🏠 Home",
"👾 Development", "📷 Photos". Names should be what a thing is called; a browser that makes
people smuggle a picture into a name has mislaid a field.

**`lastActive` does not sync.** When a tab was last looked at is inherently
per-device; syncing it lets one machine's idea of "recent" overwrite another's.
It lives in device-local state (§5.6).

**Each group carries its own bucket for unrecognised fields, and that bucket
moves with its group.** A single document-wide bucket breaks in two ways when
builds differ in version. It has no timestamp, so two devices holding different
values for the same unknown key each keep their own, forever, with no path to
convergence. And a field that logically belongs to one group — `pinned` written
by a newer build, say — sits outside that group in an older build, so it does not
travel when the group is replaced: the tab ends up with its name from one device
and its pinned state from another, and the group stops being atomic. Group-scoped
buckets inherit their group's timestamp and are compared as part of it.

**A node also carries one bucket of its own, for a group it cannot name.** A
fact group added by a later build is not an unrecognised *field* of any existing
group — it is an unrecognised key at the node's own level, so no group-scoped
bucket can hold it, and a build that predates the group would delete it on
rewrite. The node therefore has a single catch-all beside its four groups. This
is not the ambiguity described above: that comes from *sibling* catch-alls at
one JSON level, and each group's bucket sits inside that group's own nested
object, leaving the node's as the only catch-all at the node's level — the
arrangement the document already has. Node-level keys merge by greater
canonical JSON bytes, as document-level ones do, there being no timestamp at
that level; a build that does know the group merges it atomically as a group,
which is where the guarantee lives.

**Each group is its own JSON object on disk**, not a flat set of fields on the
node:

```json
{ "kind": "tab",
  "content":   { "name": "…", "url": "…" },      "content_at":   12, "content_by":   "<deviceId>",
  "placement": { "parent": "…", "order": "80" }, "placement_at": 12, "placement_by": "<deviceId>",
  "lifecycle": { "pinned": true },               "lifecycle_at": 12, "lifecycle_by": "<deviceId>" }
```

Nesting is forced by the per-group unrecognised-field buckets: three sibling
catch-alls flattened onto one object cannot be told apart, so a field recognised
by one group leaks into the others' buckets and serialisation emits duplicate
keys. Nesting keeps each bucket unambiguously inside its own group.

**On-disk field names are `snake_case`** — `content_at`, not `content_at`. The
files are machine-written and machine-read; matching the Rust field names keeps
one spelling in the system rather than two.

**Closing a tab deletes the node.** The record is removed from the document —
there is no closed state, no tombstone, no deletion record and no marker of any
kind. A node is visible exactly when it is present. Groups and workspaces are
never closed, only deleted by an action that says so (§5.4).

**Sval keeps no history of closed tabs.** Firefox's own recently-closed list
already does that, locally, and it is not Sval's job; a shared, synced graveyard
of everything every device ever closed is a cost paid forever for a feature the
browser already has. What stops a device whose file predates a deletion from
re-inserting the node is the version vector of §5.4, not a record left in its
place.

**Collapse state is not here.** Folding a group is a per-machine visual
treatment, so it lives in the device-local settings of §5.6 alongside panel
placement. A 34-inch monitor has room to leave open what a laptop folds away.

- `id` is a UUID, assigned once and never reused.
- `content_at`, `placement_at`, `lifecycle_at` and `appearance_at` are the four independently
  updated timestamps described above. Together they are the entire basis of
  conflict resolution. See §5.3.
- `content_by`, `placement_by`, and `lifecycle_by` name the device that last wrote
  each group. When and by whom are the same kind of fact about the same group,
  so they travel together and are replaced together; the writer is what lets a
  node's absence be judged against that writer's own watermark rather than
  somebody else's (§5.4). A host supplies it, exactly as it supplies ids and
  timestamps — the engine knows no identity of its own (§8.4).
- `icon` is an optional emoji on workspaces and groups. Tabs use the site favicon.
- **A tab's back and forward history stays on the device.** Session restore
  keeps it while the tab's address matches its node (decision 0050). Syncing
  it is designed and not built (§15).
- **Scroll position does not sync.** Explicitly decided.
- **Form data does not sync.** Explicitly decided.

### 5.2 Tree structure

Nesting is unbounded: a workspace holds an ordered tree; groups nest in workspaces
or other groups; tabs are leaves.

**Structure is stored as parent pointers plus fractional indices, not as child
lists.** Each node stores `parent` and an `order` key that sorts it among siblings.
Two devices moving the same node resolve by §5.3, and inserting between siblings
never renumbers the others.

**A local move refuses a parent relationship nothing can draw.** `move_node`
returns an error — leaving the document unchanged — when the node or the
requested parent is absent, when the parent is a tab (tabs are leaves), or when
the parent is the node itself or one of its descendants. An error, not a silent
no-op, so a host can tell "refused" from "done". The panel never builds such a
move, so a refusal there means its picture of the tree was stale: it logs the
refusal and redraws from the engine's tree, and says nothing to the user
(§10.7).

**That validation is a local-edit rule and never a filter inside `merge`.** A
peer on a different build may hold any of those shapes, and merge keeps what it
is given (§5.3); dropping such a node would delete another device's data rather
than repair it. The repair pass below is what makes a shape that arrives by
merge reachable again.

**Known hazard: unreachable ancestry.** Four shapes of it exist, all repaired by
the same deterministic pass, applied at read time (`repair_unreachable_ancestry`
in `engine/src/tree.rs`), never inside `merge` itself (see §5.3):

1. **A cycle** — device A moves group X into Y while device B moves Y into X, and
   merge forms a cycle.
2. **A deleted parent** — a node's `parent` names an id no longer in the
   document, because a peer deleted that group while this device filed
   something under it. Deletion is real (§5.4), so this is the ordinary shape,
   not a corrupt-input curiosity: only the group itself is meant to disappear,
   never whatever a concurrent edit put beneath it.
3. **A parentless non-workspace** — only a workspace belongs at the top, and a
   group or tab with no parent is exactly as invisible to a downward walk as
   one under a deleted parent.
4. **A tab as parent** — a node filed under a tab. The chain above the tab can
   be sound, but a tab is a leaf and nothing beneath it is ever drawn. `move_node`
   refuses to build this shape; a peer on another build or a hand-edited file
   can still deliver it.

The tab's place is known, so a node under a tab goes beside it: under the
tab's parent, immediately after the tab, in the tab's workspace, with its
subtree, after the other three shapes are repaired. Nodes under one tab keep
their order. A node is never moved to an unrelated workspace when its
neighbourhood is known.

A deleted parent's place is known too, from the files the sync pass read
(decision 0121). A node filed into a group another device deleted was written
by a device that still held that group, so the same file holds the group's
parent and order. The node **directly beneath the break** goes to the first
ancestor of the deleted group that the merged document still holds, at the
place of the deleted group directly beneath that ancestor, with its subtree.
Nodes that land in one place keep the order they held inside the deleted
groups. Where a group's placement differs between files, the placement the
merge would pick decides (§5.3), so every device that read the same files
files the node alike. `sync` collects these placements from this device's
document and every file it merges, and passes them to
`repair_unreachable_ancestry_knowing`. A favorite keeps the Favorites rule.

Otherwise, in the first three shapes, which leave no known place, the node
directly beneath the break is reparented to the lowest-`NodeId` workspace in the
whole document, skipping any candidate whose own ancestry already leads back to
the node being repaired. That covers a cycle, a parentless group or tab, a
deleted workspace, and a missing parent no file read in the pass places. The
pass returns the ids it changed as a `Vec<NodeId>` — that return value **is**
the repair log; there is no separate logging mechanism.

**`placement_at` is derived, never read from the clock: it becomes `0`.** The
lowest possible timestamp, deterministic, clock-free, and one that loses to any
real placement fact rather than out-ranking it. There is nothing else to derive
it from — a deletion leaves no timestamp behind, and a cycle has no single act
that caused it. The repaired value does not need to *win* a merge to hold: repair
is a pure function of the merged document, so an unrepaired peer's stale
placement wins the comparison and is then repaired again, identically, on every
device.

The engine implements and tests this pass.

### 5.3 Merge semantics — latest action wins, per fact

**Deliberately boring.** Sval does not use a CRDT. Each fact group is a
last-writer-wins register, and the merge is a max over four of them.

The whole algorithm:

1. **Nodes are matched by UUID.**
2. **For each of the four fact groups independently**, take the side whose
   timestamp for that group is greater. Content, placement, lifecycle and
   appearance are decided separately; they never compete.
3. **On an equal timestamp within a group, compare that group's fields in
   canonical JSON form and take the greater; on identical fields, compare the
   group's writer.** Canonical means serialising through a value map so keys are
   ordered alphabetically rather than by struct declaration order — otherwise an
   older build and a newer one serialise the same logical record differently and
   pick opposite winners on a tie, which is permanent divergence. The writer is
   the last term because two devices holding the same value for a group at the
   same timestamp, written by different devices, would otherwise each keep their
   own attribution forever. Do not tiebreak on node id: arbitrary *and* unstable
   with respect to which side is local.

   The canonical form is Sval's own encoding, so a JSON library changing how it
   prints a number cannot move a winner. It is JSON with object keys in byte
   order, no whitespace, strings escaping only `"`, `\` and control characters
   (as `\u00xx`), integers in decimal, and any other number written as `f`
   followed by the 16 lowercase hex digits of its IEEE 754 bits.
4. **A node present on one side only is kept exactly when it is news to the side
   that lacks it**, and a node is news when *any* of its groups is: that group's
   own writer (`content_by` and friends) has no watermark on that side, or one
   older than the group's timestamp. Adopt a node the peer has and we do not iff
   it is news to us; drop a node we have and the peer does not iff it is not news
   to them. Both halves evaluate the same predicate about the side *lacking* the
   node, so the two devices reach the same verdict whichever direction the merge
   runs, and the merge stays convergent. §5.4 has the reasoning, the version
   vector it reads, and the one case where it undoes a delete.
5. **A group's timestamp is compared only against a watermark for that group's
   own writer.** A file's own mtime is never consulted for anything, and no
   node's timestamp is ever measured against a watermark for a device that did
   not write it.

A node is visible when it is present. There is no closed state (§5.1).

Each group is a max over a total order, so each is commutative, associative and
idempotent. Any two devices that have seen the same set of records therefore
agree on every group, and so on the whole node, whatever order the records
arrived in.

The cases, which are the tests:

- Rename on A at t1, pin on B at t2 → lifecycle from B, content from A. Tab
  pinned, and it still carries A's rename.
- Move on A at t1, rename on B at t2 → placement from A, content from B. The
  rename does not drag the tab back to where it used to be.
- The seven deletion scenarios of §5.4, which are the contract for rule 4.

**Explicitly rejected: Automerge and CRDTs generally.** Automerge earns its keep
on collaborative rich text with character-level merging and many simultaneous
editors. Sval has one user, a handful of devices, and coarse-grained changes to a
small tree. It dragged in a history-bearing binary format, a mandatory compaction
subsystem, a megabyte of WASM, and a dependency on a small team — to deliver what
three timestamps already provide. **Do not reintroduce it.**

**Also rejected: one timestamp per record.** It loses a rename to an unrelated
pin or move. See §5.1.

**On clocks:** wall-clock timestamps, corrected against a server's clock
(decision 1714), never a logical or hybrid clock. A wrong clock does not correct
itself: one set back stamps a new tab below every peer's watermark for its
device, and one set ahead leaves stamps in the files that win every conflict
until real time passes them. So the time Sval stamps with is the wall clock
minus the difference Remote Settings measures against its server's `Date`
header on every poll (`services.settings.clock_skew_seconds`). Between readings
it follows the monotonic clock, which a change to the wall clock does not move,
and a wake adds the time the system slept. A drift of up to two seconds between
the two clocks, which NTP's slewing of the wall clock makes, is followed. A device's stamps only move forward,
each one the later of corrected time and one millisecond past its previous
stamp. The `Date` header has one-second precision, so edits on two devices
within about a second are ordered by the tie-break. The host supplies every
`now` the engine takes (host contract §3) from that one clock
(`SvalClock.sys.mjs`). In the browser, clocks are coarsened for Spectre
mitigation, which is why rule 3 is load-bearing rather than theoretical.

A device that has never had a reading stamps with its wall clock and publishes
nothing to the shared folder; it still reads and merges what the folder holds.
Until the first reading, Sval polls Remote Settings itself on a backoff (§10.9).
When the reading arrives, the device's first pass of each document pulls every
stamp of its own later than corrected time back to it. Those stamps were never
published, so no peer sees a difference. The engine records which documents it has pulled
back in its own folder, so a restart in between changes nothing. Joining
another device's key does not wait for the reading: the join stores the key
and merges the folder, and the gate holds this device's own changes until
the reading arrives.

A peer file whose `written_at` is more than ten minutes past corrected time
comes from a device stamping with an uncorrected clock. Sval keeps everything
in it. The sync indicator warns, naming the device, only when merging that
file cost the user something: one of its facts stamped after corrected time
replaced a different value this device held, or a node this device closed,
still in its own file, came back from it carrying a stamp after corrected
time. The engine decides that on the sync read path, never inside `merge`. A
device with no reading shows no such warning, since its own clock may be the
wrong one.

A fast clock's reading also lands in every peer's version vector, as that
device's watermark (§5.4), where it would outlive the fix: the device's new
nodes would be news to nobody, and it would delete them itself, until real
time caught up. A reader therefore drops any watermark more than a minute
later than its own corrected time (decision 0135). What the device closes after
the fix lingers on its peers until real time passes the fast reading; nothing is
lost. A watermark less than a minute ahead is taken: two corrected clocks differ
by a second or two, and dropping a truthful watermark would leave a peer's close
unhonoured until it next wrote. The same minute bounds how far a device keeps
its own stamps above its own watermark: each pass reports it, and the next
stamp is above it unless it is more than a minute past corrected time, which
only a fast clock from before the first reading leaves.

### 5.4 Deletion, and how absence propagates

Closing a tab deletes the node (§5.1). There is no retention window, no purge,
no tombstone and no marker: the record is gone, and Sval keeps no history of
closed tabs because Firefox's own recently-closed list already does, locally.

**Only a tab closes. A group and a workspace are deleted, and only by an action
named "Delete".** Closing must never cost the user anything they made, so the
two containers have no close at all:

- **A tab** closes from its row's X, from Delete or Backspace on its row, from
  its context menu and from Cmd/Ctrl+W. Closing it deletes its node. Cmd/Ctrl+W
  on a window's last tab closes the window instead, and keeps the tab (below).
- **A group** toggles open and shut, and its row has no X. Its context menu has
  "Delete group", and so do Delete and Backspace on its row. When the group
  holds anything, a dialog asks what happens to its contents: move them out of
  the group, one level up into the group's parent, in their order and at the
  place the group held; or delete them with it. A group inside comes out whole.
  An empty group is deleted without the question.
- **A workspace** is closed only by closing its window — Cmd/Ctrl+W on its last
  tab, or the window's own close box. That saves the workspace's state, to the
  shared folder or locally, and deletes nothing: not the workspace, not its
  groups, not its tabs. An agent's workspace is a workspace, and closing its
  window keeps it the same way. The workspace's right-click menu has "Delete
  workspace", whose confirmation says that every tab in it will be closed too;
  there is no option to keep them, because a workspace is a root with nowhere
  above it to move them. The last workspace cannot be deleted, because a window
  always shows one (§10.7), and a private window's one temporary workspace has
  no "Delete workspace".

Every one of these deletions is the same deletion: the nodes are removed, and
the rest of this section is how that absence reaches every device.

**The panel holds a delete back while it offers Undo.** Closing several tabs
at once, deleting a group, deleting a workspace and deleting a pin each take
what went out of the panel at once, and hide and unload its tabs, so none of
them plays or holds memory. The document and the Favorites store keep it
until the panel's Undo message goes: it times out after a few seconds, the
user dismisses it, another delete replaces it, or the window closes or Sval
quits. Undo cancels the delete, so nothing is rebuilt and no peer hears of a
delete that was never made. Closing one tab is made at once, because Firefox's
recently-closed list already hands it back.

A tab another device sent and this window never opened is opened lazily and
closed at once when its row closes, so the list holds it too.

**Another device's delete never closes a tab in front of the user here**: a
window's selected tab, or one in a call or a picture-in-picture video. The
device keeps the tab and adds its node back under the same id, which every
peer reads as news, so the tab returns on the device that closed it. A tab in
a call is local (decision 1372) for as long as the call lasts, so no other
device shows it. Decision 2237 has the reasons.

That leaves one problem, which is the whole of this section: **a device whose
file predates the deletion still has the node, so absence has to carry
evidence.** Without it, `merge` re-inserts the node from that file, the deleting
device publishes it again, and the tab returns, live, on every subsequent sync,
permanently.

**Prior art settles the shape.** Firefox's own tab engine avoids the problem
outright by having one writer per record and never merging — remote tabs are
display-only (`services/sync/modules/engines/tabs.sys.mjs`). Chromium's saved tab
groups is the only browser feature that genuinely shares editable state, and it
holds tombstones on a *server*; its own documentation concedes that without one
"this can result in reviving the entity if it had been deleted on another client
in the meantime". Sval has no server, so the evidence has to live in the files.

**Every file carries a version vector.** Alongside `schema` and `nodes`, a
document records:

- `written_at` — when this device last wrote this file, supplied by the host like
  every other timestamp;
- `written_by` — which device wrote it, so a file is self-describing rather than
  identified by where it happens to sit;
- `seen` — for each peer, the `written_at` of the newest file from that peer this
  document has incorporated.

`seen` merges pairwise by taking the per-peer maximum, so knowledge travels
transitively: if the desktop has incorporated the laptop's 3pm write, a phone
that syncs with the desktop learns that too, and stops treating the laptop's
older file as news.

**A file speaks only for itself, and only about writes the folder holds**
(decision 0134). A file whose `written_by` is not the device its path names is
damaged. A watermark later than both what the reader already holds for that
device and that device's own file in the folder is dropped from the file
before it is merged: no device has made that write, or its file has not
arrived yet, and either way taking the claim on would delete or block nodes
on its strength. So is one more than a minute past the reader's corrected
time (§5.3, decision 0135). The phone above therefore learns of the 3pm write once the
laptop's 3pm file has reached it too.

**Each fact group also records who wrote it** — `content_by`, `placement_by`,
`lifecycle_by`, `appearance_by` (§5.1) — and that is what a watermark is checked against. A
watermark says "I have incorporated everything device D wrote up to time T",
which settles whether a side has seen a *particular* fact only if the fact's own
writer is D. Measuring a node's timestamp against a watermark for some other
device asks a question about files and answers it with a timestamp that belongs
to a node: a node that reached a device after its last write can predate a peer's
watermark for that write, and that peer may never have seen the node at all.

**A group that has never been written is not news.** A group carries a fact only
once something has written it; before that it has no timestamp, and there is
nothing for a watermark to be checked against. This matters the moment a group
is *added* to the model: every node in every file written by an earlier build
lacks `appearance` entirely, and treating that absence as unattributed — hence
as news, hence undeletable — would make every pre-upgrade node immortal, which
is the zombie the version vector exists to kill. Absence of a fact is not an
unverifiable fact.

**Never written means no timestamp *and* no writer**, and the conjunction is
load-bearing. A zero timestamp alone is not absence: a node created at
`now == 0` is legitimate, and `repair_unreachable_ancestry` deliberately leaves
`placement_at` at zero *with* a writer, so skipping on the timestamp alone drops
facts that exist — measured against the suite, not reasoned about. A group with
neither is skipped when deciding news; a group with a timestamp and no writer is
news, as below.

**A node with no written group at all is news, always.** Skipping unwritten
groups must never empty the test: a node about which nothing is known —
every group unattributed and unstamped — would otherwise become droppable, and
rule 13's absolute is that nothing is deleted on the strength of a watermark
that cannot be checked. Skip unwritten groups only while at least one group
remains to judge; if none does, the node is news and is kept.

**The rule.** A node is **news** to a side when *any* of its four groups, or its
touch stamp, is: the writer has no watermark on that side, or one older than
the timestamp. The touch stamp is judged exactly as a group is, unwritten
included: a node never touched has no stamp to judge, so a node from a build
that predates the stamp is as droppable as before. Then, for a node present on one side of a merge only:

- **adopt** it iff it is news to us — some group of it was written by a device we
  have not heard from that recently, so we cannot have seen it and discarded it;
- **drop** it iff it is not news to them — they had incorporated every one of its
  groups, from the devices that wrote them, and do not have it, so they deleted
  it.

Both halves evaluate the same predicate about the side *lacking* the node, from
that side's own vector and the node's own attributions, which is what makes them
agree and the merge converge (§5.3 rule 4).

**Any group being news keeps the whole node, and unattributed is news.** A file
from a build that predates attribution carries none, and nothing here may be
invented: a node Sval cannot attribute is never deleted on the strength of a
watermark it cannot check. The cost is an occasional node kept that some device
had in fact already discarded; the alternative is silent loss, and the two are
not comparable.

**Our own stored file is a peer of ourselves.** `sync` reads it first, and it
predates anything done since — so `written_at` is recorded into `seen` under our
own device id when we write, and the file's contents are then not news and
cannot resurrect a deletion. It is exempt from the *drop* half only: a node we
hold that our own earlier file lacks is work we did after writing it, and our
own past self cannot have deleted anything. A device restored from a backup —
whose rolled-back document carries a rolled-back `seen[me]` too — still sees its
own file as news and recovers the offline writes only that file holds, which is
why the own-file read exists at all.

**A copy that begins empty under an id that has written before holds none of
that id's earlier writes**
([2232](../../decisions/2232-a-copy-that-begins-under-a-used-id-takes-back-its-earlier-writes.md)).
Its first write stamps `seen[me]`, which then covers every one of them, and
without more each would read as deleted here and, from here, everywhere. So a
copy records `began_at`, the time of the pass that found no file of its own
when it had never written. A file whose watermark for this id is below
`began_at` holds earlier writes, and merging it treats this id's stamps before
`began_at` as news. `earlier_to` records the highest such watermark taken, so
a file no newer than it is merged as any other, and a deletion made since is
not undone by a peer's idle file. Both are bookkeeping, kept in the profile copy
file and outside the write decision; a merge ignores them.

**The write decision compares the shared state only** — the nodes and the
document-level unrecognised fields — and never the per-device bookkeeping:
`written_at`, `written_by` and `seen` are excluded from it. `written_at` is
likewise stamped only when a write actually happens, after that comparison.
Both halves of that are load-bearing, because the bookkeeping moves whenever a
peer is merged: with two devices polling each other, a comparison over the whole
document differs on every single poll, each write raises the other device's
`seen` in turn, and the pair gossips forever without ever going quiet. Measured
at seven writes per file per thirty seconds with two idle browsers.

**Publishing a watermark late is safe, and this is why.** A `seen` entry we have
raised but not yet written out means our published vector is *older* than what
we have incorporated — never newer, because watermarks only rise. Our published
`seen` is read by peers for one purpose: deciding whether a node we lack is news
to us. A lower watermark makes more things news, so a peer **keeps** a node it
might otherwise drop. Staleness therefore biases toward keeping data, the same
direction as the accepted resurrection below, and the cost is a deletion a peer
applies at our next real write rather than immediately — a delay, never a wrong
drop. Nothing can bias the other way: there is no path that publishes a
watermark for a file we have not incorporated, so no peer is ever told we have
seen something we have not. Pinned by
`merge::tests::a_stale_published_watermark_keeps_the_node_where_a_current_one_drops_it`,
which merges the same pair twice and changes only that one number, and by
`sync::tests::a_deletion_a_stale_file_delayed_propagates_on_the_next_real_change`.

**The scenarios are the contract**, and each has a test:

1. **Ordinary close.** A deletes T and syncs; B, whose file was current, syncs →
   T is gone on B.
2. **Abandoned peer.** B syncs once and never again, its file still holding T. A
   deletes T and syncs repeatedly → T never returns, and A does not need to have
   read B's file first: a device can only hold a node by having incorporated a
   file from the device that wrote it, so a holder's watermarks always cover the
   node it is deleting.
3. **Concurrent add and delete.** B adds U and syncs; A deletes T and syncs →
   U is everywhere, T is gone everywhere. Both nodes arrive in the *same* file
   and take opposite branches, which is why the rule is per node: a single
   verdict for a whole file must either resurrect T or lose U.
4. **Returning device.** B is offline while A adds V. B returns and learns about
   V, and B's stale file deletes nothing from A.
5. **Offline creation.** B, offline, creates W. W propagates and is not mistaken
   for a deletion.
6. **The accepted resurrection.** A deletes T. B, offline, had renamed T and
   never synced. B returns → **T comes back, carrying B's rename.** Deliberate:
   B holds genuine unsynced work on that node, and losing it silently is worse
   than the tab reappearing. This is the one case where a delete is undone.
7. **Convergence.** Every device's shared state is identical after any schedule,
   with deletions in the mix — **and every node created on a device while it was
   away survives on all of them.** Convergence alone is satisfied when every
   device agrees on a *loss*, which is exactly how a deleted-everywhere offline
   creation hides from a convergence test; naming what must survive is what
   makes the property test a test.

**The bias is toward keeping data: an edit never loses to a stale absence, but a
delete can lose to a concurrent edit.** A device that deletes a node it has not
heard about since someone else edited it loses that delete — the edit is newer
than what the deleting device had incorporated, so its absence is not evidence.
Recovering the opposite behaviour would require remembering deletions, which is
exactly what this design removes; a lost delete here is the trade, not a bug, and
the fix is not a tombstone. Pinned by `sync::tests::
an_offline_delete_loses_to_a_concurrent_edit`, alongside the three cases that
show the per-fact-group comparison of §5.3 is unaffected by any of this
(`an_offline_edit_loses_to_a_later_edit_elsewhere_but_keeps_its_own_move`,
`an_offline_edit_wins_over_an_older_value`,
`an_offline_delete_propagates_when_nobody_else_touched_the_node`).

**Work inside a node counts once the host touches the node** (decision 0106).
A tab filed under a workspace is a fact about the tab, so on its own it does
not bring back a workspace a peer deleted: the delete wins and the tab is
repaired (§5.2). A host that wants that work to count stamps the workspace
with `touch`. A peer that deleted the workspace without having seen the touch
loses its delete, and the workspace comes back with the work in it, every fact
group as the deleting peer last saw it. A peer that had seen the touch deleted
the workspace knowing of it, and its delete propagates. Pinned by
`merge::tests::a_touch_the_deleter_never_saw_brings_the_node_back`,
`merge::tests::a_delete_made_after_seeing_the_touch_wins` and
`merge::tests::a_touch_loses_no_edit_made_elsewhere`.

**What brings a node back is a group a peer wrote that nobody has seen** —
genuine unsynced work, scenario 6 — and not a stale copy of facts the deleting
device wrote itself. That distinction is the whole benefit of attributing each
group: "have I seen this fact?" is answerable, where "is this node newer than my
last conversation with that peer?" was not.

### 5.5 Schema evolution

Each file carries a schema version. Two rules keep it simple:

1. **Preserve unknown fields on rewrite.** Because each device writes its full
   state, an older Sval would otherwise silently drop fields it does not recognize.
   Round-trip unrecognized keys verbatim.
2. **Refuse rather than guess.** A device encountering a *major* version above its
   own stops syncing that file, keeps working locally, and tells the user to
   update.

Additive changes need no migration: rule 1 makes them forward-compatible.

A new node kind is an additive change. A build that does not recognise a kind
carries the node and writes it back verbatim, does not show it, and never
repairs it or anything beneath it, because only a build that knows the kind
can tell where it may sit. A peer file is never rejected for containing one.

### 5.6 Favorites, history, and settings

Each is an engine document of its own, synced through the same storage layer
and merged by the same rules (§5.3, §5.4). The workspace tree is `workspaces`;
the others are `settings`, `favorites`, the weekly history shards with their
index, and `archive` (§10.2). No switch turns any of them off: choosing a
shared folder syncs them all.

**Favorites are Sval's bookmarks, and the `favorites` document is their only
store.** Places holds no bookmarks (decision 0108). The document reuses the
workspace tree's structure exactly: UUIDs, parent pointers, fractional
indices and the same fact groups, with kinds `favorite`, `folder` and
`separator` under one root Sval shows (decision 0123). Deleting removes the
record, and the version vector of §5.4 carries that to every device. Every
reader and writer of a favorite, the address bar and the extensions'
`bookmarks` API included, uses the document. A pin is a Favorite marked
pinned (`2026-10-20-pins-design.md`). `2026-10-21-favorites-native-design.md`
has the mechanism.

**Settings are split in two:**

- **Synced:** search engine, ad blocking level, the idle-tab archive's
  choices, and anything else expressing user intent, including the browser
  preferences Firefox Sync treats as device-independent, trimmed where Sval
  changed the ground under them. One node per setting, of kind `setting`, in
  the `settings` document. A device writes a setting only when its user
  changes it, and applying an incoming value never writes it back. The list
  and the mechanism are in `2026-10-07-settings-sync-design.md`.
- **Device-local, never synced:** panel placement (a 14" laptop and a 34"
  ultrawide want different things), window geometry, which groups are
  collapsed, when each tab was last active, **which workspace each window is
  currently showing (§10.7)**, the password manager choice (§7.3), and the
  storage folder path itself, which cannot sync through the thing it
  configures.

A device syncing for the first time starts with every group collapsed, so a large
tree arrives legible rather than fully unfolded.

**History syncs what Firefox's history engine syncs** (decision 1549): a
visit's URL, title, time and transition, with Firefox's limits on how many
visits to a page are kept. **It is sharded by ISO week** of visit time, one
document per week named `history-YYYY-Www`, so old shards go cold and stop
being rewritten (decision 0109). A small `history-index` document lists the
shards, so a pass runs the index, the current week and only the shards that
changed. Each visit is one node of kind `visit`, with an id derived from the
visiting device, the URL and the time.

**A visit belongs to the device that made it, and deleting it deletes it
everywhere** (decision 0109). Clear Recent History asks whether to clear this
device's history or every device's. "Never remember history" stops a device
both publishing and taking in visits. Every device has a name, the computer's
by default and changeable in Settings, and an entry from another device names
its device in the History sidebar. `2026-10-16-history-sync-design.md` has the
mechanism.

**Each visit records the workspace it was made in**, in its synced node and in
Places, and the History sidebar lists the window's workspace's history, with
"All workspaces" a click away (decision 1287).

**No retention setting.** Each device's own Places expiration decides what it
keeps; an expired visit is not deleted from the documents, and is never put
back. A user-facing retention period was rejected as an unnecessary knob.

### 5.7 Never synced

Cookie jars, form data, cache, credentials, the encryption key.

**An address no other device may open stays on the device that made it**
([1372](../../decisions/1372-an-address-no-other-device-may-open-stays-in-this-devices-copy.md)).
One function, `syncableAddress` (`SvalSyncableAddress.sys.mjs`), answers for
the writer and the reader: an address syncs unless the innermost address it
nests (`view-source:`, `jar:`) has a scheme Firefox's tab engine keeps off
its sync, `services.sync.engine.tabs.filteredSchemes` (`about`, `chrome`,
`resource`, `file`, `blob`, `moz-extension`, `data`). `javascript:` syncs, as
Firefox Sync syncs bookmarklets.

- **A tab, Favorite, pin or Archive entry at such an address is a node of
  its document marked `local`**, which the host sets on every write that
  carries an address. This device's profile copy holds it as it holds every
  node; no file in the shared folder does. A shared exchange sets local
  nodes aside, merges, and puts them back before repair, so another device's
  file can neither delete nor replace one, and a `local` mark read from any
  file but the profile copy is dropped.
- **The mark follows the address.** A tab that moves to such a page goes from
  other devices as if closed there, and comes back at its place once it
  shows a web page again. A new tab on the home page and a settings tab are
  local; a workspace left empty on another device shows that device's own
  home tab. A tab in reader view records the article it shows.
- **The reader never opens such an address another device wrote.** A tab
  node holding one stays in the tree and gets no tab; a Favorite is drawn
  disabled with Delete alone; an Archive entry is listed and never
  restored. A visit to one is neither written to history nor taken from
  another device's.

**A private window is never synced and never saved.** It shows Sval's panel with
one temporary workspace of its own tabs, held in memory only and gone when the
window closes, and nothing about it is written to the disk, the shared folder
or the session store. `2026-10-07-private-windows-design.md` has the design
and the tests that prove it.

---

## 6. Sync and storage

### 6.1 The provider interface

Four operations: **list, read, write, detect-changes.** Any backend satisfying
it is valid, including ones users add themselves.

**Deletion is the host's, not the engine's.** Sync never deletes: each device
owns one file for its whole life, and closing a tab removes a node inside a file
rather than a file (§5.4). Only the host removes files: the pairing handoff of
§6.7 consumes an offer when it is claimed and sweeps it when it expires, and
setting up sync again removes the old key's directories (§6.6). That
is host work, because a device that has no key yet cannot compute `syncPrefix`
and so cannot use the engine's provider at all. Adding a fifth operation to the engine
trait would put a method there that the engine itself never calls.

A host must therefore be able to delete a file in the shared folder. Every
platform Sval targets can: plain paths on desktop, the Storage Access Framework
on Android, document-provider extensions on iOS, and an HTTP verb on every
cloud API.

**An adopted device leaves its old directory behind.** Adoption changes the key,
and the key names the directory, so the tree published under a previous sync
key stays in the folder as ciphertext nothing can read. It is litter, and no
leak: no key for it exists on any device once adoption completes. Setting up
sync again is the one act that removes a previous key's directories (§6.6).

### 6.2 On-disk layout

```
sval/
  ws/<hashed>/   <deviceId>.json     ← one directory per document, one file per device
  keys/          <deviceId>.key      ← each device's sealed copy of the sync key (§6.6)
  pair/                              ← pairing offers (§6.7)
```

Every document lives under `ws/`, named by its hashed document name: the
workspace tree (`workspaces`), settings (`settings`), Favorites
(`favorites`), the Archive (`archive`), and the history shards and their
index. A reader of the folder cannot tell which directory holds what,
and the engine needs no path code per document
(`2026-10-07-settings-sync-design.md`).

**One synced document holds every workspace.** The tree it carries has each
workspace as a root, and `<hashed>` is a fixed document name hashed under the
user's key — the same string on every device, not a workspace id. That is what
makes a device pointed at a folder able to *find* what is already there: a
directory named after a workspace can only be opened by a device that already
knows which workspace to look for, and a device on its first run knows nothing.
Naming the directory after something every device can compute is what lets the
second device join the first rather than mint a workspace of its own and sit
beside it forever.

The engine takes the document name as a parameter and hashes it; it has no
notion of which document is which. A host passes the same string every time.

**Per-workspace documents are the move if scale demands it.** One document
means any edit rewrites the whole tree, so a user with thousands of tabs pays
for the whole thing on every change. The way out is a second document — an
index of the workspace list and its ordering, under a fixed name — with each
workspace's own tree under `ws/<hashed workspace id>/`: a device reads the
index, learns the ids, and then reads only the workspaces it cares about. It is
purely additive, because the engine already takes a document name and nothing
in the model has to change to grow into it. Do not build it before the cost is
measured.

**Each file describes itself.** Alongside `schema` and `nodes`, every file
carries `written_at`, `written_by` and the `seen` version vector of §5.4 — the
device id in hex, the same spelling the path already uses. A file therefore says
who wrote it and when, rather than that being inferred from where it sits.

**One file per device, per document.** Each device writes **only its own file** and
reads everyone else's.
Only a `<deviceId>.json` directly in the directory is a device's file; anything
else a cloud client or the operating system leaves there is passed over
(decision 0116).

This is the core trick. Cloud sync services cannot merge files — two devices
writing one file produces `conflicted copy (2)` garbage. Per-device files make
file-level conflict structurally impossible, and Sval merges after the files land.

Each file holds that device's **current state**, not a history of changes.
Therefore **file size is bounded by the size of the tree, not by how many times it
has been edited, and there is nothing to compact.**

### 6.3 The loop

Local change → stamp the timestamp of whichever fact group changed (`content_at`,
`placement_at`, `lifecycle_at` or `appearance_at`) on the touched node, or remove the node outright
if it was closed → debounce a few seconds → write own file atomically, stamping
`written_at`/`written_by`/`seen[me]` (§5.4) → provider propagates → other devices
notice changed peer files, merge by §5.3, re-render.

**A poll that changes nothing shared writes nothing.** After merging every file,
a device compares the merged document's shared state — the nodes and the
document-level unrecognised fields, with `written_at`, `written_by` and `seen`
excluded — against what its own file already held, and writes only if they
differ. The comparison is over parsed JSON, not the sealed bytes, which differ on
every seal from the fresh nonce. Excluding the bookkeeping is what lets two
devices polling each other go quiet, and it is safe in one direction only, which
is the direction it goes (§5.4).

Offline devices keep working and converge on reconnect. No coordination, no
locking, no server.

**A pass runs against two locations.** First the profile, which always holds
this device's own file: read it, merge, and write it if the merged shared state
differs. Then, at most every 30 seconds or when the user asks, the shared folder:
a short-lived helper process reads it, the browser merges what came back, and a
second helper writes this device's file there if it changed. The helper is
`sval-folder`, a native program shipped beside the browser (decision 1437). The browser never
touches the shared folder itself, because Firefox runs every file operation in a
process through one queue and a read stuck on a hung mount would stall them all.
The step has 20 seconds; past that Sval kills the helper without waiting and
starts no other while it is alive. A step that reached the folder runs the
profile step once more, so what arrived from peers is on disk locally too. The
full design is `2026-10-06-local-copy-shared-folder-design.md`, with the
helper's in `2026-10-26-native-shared-folder-helper-design.md`.

**Writes are atomic: write to a temp file, then rename over the target.** Each write
replaces a whole file, so this is what prevents a crash mid-write from leaving a
truncated file for other devices to read.

### 6.4 v1 scope: a folder

**v1 ships the provider interface with one implementation: a folder.** The user
points Sval at any directory — including `~/Dropbox`,
`~/Library/Mobile Documents`, or an SMB mount — and gets working cross-device sync
at that provider's latency. Sval also reaches a folder on an SMB share with
nothing mounted, and the shared-folder helper does it (decision 2650,
`2026-11-25-desktop-connectors-design.md`).

**This device's copy always lives in the profile.** Workspaces exist and persist
from the first launch with nothing configured, which is what makes them the
browser's tab model rather than a feature to switch on. Choosing a folder the
user's other devices can also see is the whole of "turning on sync": that folder
becomes where devices exchange files, and nothing moves out of the profile.
Choosing a folder never loses a workspace: an empty folder receives this
device's file on the next pass that reaches it, and one that holds Sval files is
merged with it.

**Either folder can be chosen: the one that holds `sval/`, or `sval/` itself.**
The folder Sval stores is the one that holds `sval/` (§6.2). A user who browses
into the folder they can see Sval's files in, `sval/` with `ws/`, `keys/` and
`pair/` inside, has chosen the folder that holds it. Sval stores the parent, in
first run and in Settings alike, so both choices reach the same files. Every
Sval file lives under `sval/`, so a folder named `sval` that a user made for
Sval fills with Sval's files either way.
The folder's name alone decides, matched exactly: what a folder holds changes
as devices write to it, and a test of its contents gives one pick two readings
on two devices. The engine holds the rule (`store::is_top_dir_name`,
`store::shared_root_of`), and every device and every way of reaching a folder
asks it. An iPhone given the inner folder by the Files picker, which grants
nothing above the folder picked, uses that folder as `sval/` itself.

Sval treats the chosen folder as volatile: a share that drops, a drive that is
unplugged, a folder that is moved or deleted. Not reaching it is an expected
state. One failed reach is retried within seconds and says nothing; a second
in a row, or a folder that is not there at all, is reported calmly, never as
an error (decision 0032), and Sval never recreates the folder by itself. The last-synced time is
the sync indicator's tooltip, and its label only while the folder is
unreachable (`2026-10-21-messages-design.md` §3). The profile copy is the same
pass run against a second location, and it is what lets Sval launch, edit and
quit without losing anything while the folder is away.

Rationale for deferring API-based providers:

- Measured latency: upload is fast everywhere (Dropbox ~1.7s, OneDrive ~1.8s,
  Google Drive ~3.1s median). **Download is the problem** — OneDrive falls back to
  a background poll every 10 minutes (15 on some Windows builds, 30 for
  SharePoint-backed folders), and iCloud Drive defers aggressively when not
  foregrounded.
- The fix is to bypass the desktop clients and use each provider's HTTP delta/change
  API directly, polling a cursor every few seconds. That drops latency to seconds
  and does **not** require a Sval server — OAuth goes straight from Sval to them.
- But each API provider needs app registration, token refresh, and scope
  verification. Google's review of restricted Drive scopes requires a published
  privacy policy and can take weeks. That is a bad thing to hit before the sync
  engine is proven.
- The folder provider exercises the entire architecture — per-device files, merge,
  the lifecycle model, encryption — with zero provider-specific code.

**In v1 regardless of latency:** a visible last-synced timestamp and a manual
"Sync now." These matter *more* with folder latency, not less. The timestamp is
one hover away on the panel's sync indicator; the button lives in settings
(§10.8), because one informs and the other acts.

On Apple platforms, the eventual iCloud integration should use the app's ubiquity
container (push-based, prompt) rather than poking at the Drive folder.

### 6.5 Encryption

**At-rest only.** Each file is encrypted with AES-256-GCM under the user's key,
with a fresh nonce per write. Filenames are hashed so the provider cannot read
workspace names from a directory listing.

**Format.** A sealed file is the bytes `svl`, a version byte (1), a 12-byte
nonce, then the AES-256-GCM ciphertext and tag. The cipher key is derived from
the user's key with HKDF-SHA256 (no salt, info `sval seal v1`). The associated
data is the 4-byte header followed by the file's path relative to the folder
root, so a file copied to another device's or another workspace's name does not
open. A directory's `<hashed>` name is HMAC-SHA256 of the document name under a
second derived key (info `sval name v1`), as lowercase hex. A file with a newer
version byte is reported as needing a newer Sval, never as damaged.

**Stated limitation:** file sizes, counts, and write times remain visible. The
provider can infer *that* the user is active and roughly how much, never *what*.

**Threat model, stated plainly:** this protects the user from the storage provider
and from anyone who obtains the files. It does **not** protect against someone who
already has the unlocked device. That is the correct trade for at-rest encryption
and must be documented honestly in the product.

Note that the on-disk format is plain JSON before encryption — deliberately, so
that debugging a sync problem means reading a file rather than decoding a binary
CRDT log.

### 6.6 Key management

**Two keys, each with one job.** The local key encrypts this device's file in
the profile. It is created on first launch, kept as raw bytes in the profile
(`sval-local-key`), never leaves the device, and protects nothing the profile
does not already expose. The sync key encrypts and names every file in the
shared folder. It exists only on a device that shares a folder, and leaves the
device only through pairing (§6.7) or the user's backup. The engine takes a key
on every call, so the profile pass gets the local key and the shared pass the
sync key. `2026-10-08-key-storage-design.md` has the mechanism.

**The user never invents, types, or memorizes a passphrase.** Sval generates a
random 256-bit sync key when the user sets up sharing on a device that is not
joining. It keeps the key in the profile, encrypted under a secret the system
credential store holds (Keychain, Windows Credential Manager or Secret
Service, through Gecko's `nsIOSKeyStore`). Firefox's login store is never used.
On Linux with no working Secret Service, Sval keeps the secret in the profile
and says so in Settings.

**A locked or missing sync key stops only syncing.** Sval starts, shows this
device's workspaces from the profile, and the sync indicator says why it is
not syncing. A locked store offers to try again. A missing or different key
offers "Sync with another device". Sval never mints a replacement on its own.

**The key can come back without another device.**

- **A backup.** When Sval mints a sync key it offers to save a backup: a file
  or a printed sheet with the key in the pairing alphabet, a QR code and a
  fingerprint. A backup inside the shared folder is refused. The user can also
  save the code in their password manager as a secure note (decision 0089).
  Settings says when no backup is saved. A backup is never read at startup.
- **A sealed copy in the folder.** Each device leaves the sync key in
  `sval/keys/<device id>.key`, sealed under the user's system secret, so Sval
  installed again for the same user on the same machine finds its key in the
  folder and asks for nothing.
- **iCloud Keychain** on macOS (decision 0084), in signed release builds only.

**Setting up sync again** mints a new sync key, publishes this device's tree
under it and removes the old key's directories from the folder. Every other
device then needs a code again. It is how a device carries on after every
copy of the key is lost, and the one way to shut out a lost device.

Sval cannot put the key into the user's password manager: no desktop operating
system lets a browser write to one (§7.2). A user who wants it there copies it
from the "Technical details" panel (§2.1).

### 6.7 Getting the key onto a second device

Two devices sharing a folder but not a key are not two devices in disagreement;
they are two strangers. The key names the directory — `syncPrefix` is a hash of
it — so a device holding the wrong key does not fail loudly. It reads a
directory nobody writes to and shows an empty browser. Pairing therefore has to
be exact, and a mistake has to be caught at the point of entry.

**The user types twelve characters.** Device A shows a code in three groups of
four, drawn from an alphabet with no ambiguous letters, and writes one file into
the shared folder: the document key sealed under that code. Device B, pointed at
the same folder, takes the code and unseals it. Nothing is displayed that is
worth stealing, and nothing has to be typed that is worth mistyping.

**The code is stretched with Argon2id** — memory-hard, so the guesses cannot be
parallelised across a GPU farm. Twelve characters is 60 bits, which is
unreachable at a memory-hard cost per guess but would be trivial under a plain
hash. The KDF is the whole of the security argument for a short code; it is not
an optimisation and must not be traded for a faster one.

**The seal is the checksum.** A wrong code fails AES-GCM authentication, so the
second device says the code did not work rather than adopting nonsense and
joining a directory of its own.
The file's plain fields (schema, salt, creation and expiry times) are the
seal's associated data, so an expired file cannot be revived by editing its
expiry.

**One hop, asynchronously.** An interactive handshake — a PAKE over two
round trips — was rejected: §6.4 measures download latency at up to 10 minutes
on OneDrive and 30 on SharePoint-backed folders, and Sval is coordination-free
precisely because the channel cannot support coordination. A single file
travelling one way lets the second device wait and retry instead of a live
exchange timing out. The first device offers the code for a bounded window and
says plainly that a slow provider can take minutes.

**The offering device must say that a slow provider can take minutes**, not only
the joining one. The wait is felt on both sides, and a code that appears to do
nothing is the moment a user decides the feature is broken.

**Pairing has three outcomes a person is told about.** Internal failures
(publish, read-back, key store, rollback) are Sval's business. What a person
needs to know is which of three situations they are in:

1. **It worked.** Both devices have everything.
2. **It did not work and nothing changed.** Try the same code again.
3. **The workspaces published but the key did not save on this device.** Try the
   same code again — distinct from 2 only because the other device *does* now
   have the data, which matters to someone who walks away and never retries.

**The key swap is atomic, so "sval is in an unknown state" cannot happen.** Write
the new key, confirm it, then remove the old — never remove first. Either the
new key is stored or the old one still is, and both are coherent states Sval can
keep working in.

**Where Sval is busy or not yet ready, it waits rather than refusing.** A second
pairing attempt joins the one already running and reports its outcome; an
attempt made before the panel has finished starting waits for it. Neither is a
state worth a sentence, because neither is a state the user caused or can act
on.

**The pairing file is deleted** once the second device has adopted the key, and
carries its own expiry so any device that sees a stale one can remove it — the
first device may have been closed before it could clean up. A file is stale
when its expiry has passed, or when its expiry is more than 24 hours after
now. A real offer lasts one hour, so the second case is a file Sval did not
write: anyone who can write to the folder can drop one, and the expiry is
read without the code. Such a file is never tried against a code, so it
cannot make a right code look wrong, and any device that sees it removes it.

**A device that already has workspaces keeps them.** Adopting a key writes
this device's file under the new key on the next sync pass — to the profile
unconditionally, and to the shared folder if one is chosen and reachable.
Changing a setting never loses a workspace. Its device id does not change.
The one exception is a joining device's untouched first workspace: unnamed,
never renamed and holding only tabs on the browser's own `about:` pages, it
is removed before the device first publishes. A window showing it moves to
the workspace it lands on with those tabs, so the Settings tab the join ran
in stays open.

**Threat model, stated plainly.** For the length of the pairing window, the
document key sealed under twelve characters sits in the user's folder. Anyone
with read access to the folder in that window can copy the file, and a cloud
provider's version history may keep it after it is deleted. A copy can be
attacked offline for as long as the attacker likes, so the window bounds who
can take a copy, and the cost of opening it is the whole defence: 60 bits,
each guess one Argon2id at 64 MiB. That is out of reach at today's costs. What
it would win is the document key, which pairing does not rotate, and with it
the user's open tabs and workspace names. That is the trade, made deliberately: the alternative costs every user a
52-character transfer on every device they own, forever, to protect a list of
URLs.

On mobile, a QR code scanned by the phone's camera carries the key (§11): a
real-time channel the folder can never be.

### 6.8 Export

**Export decrypts and saves** to open formats. This satisfies principle 1 on its
own: while Sval works, the user can always get everything out. Export is in
Settings and in "Technical details" (§2.1), and has two kinds of target:

- **Another browser.** Sval writes the bookmark file that browser imports
  best, with each workspace as a folder named after it and Favorites under
  the bar. Safari's target can carry history too.
- **Sval (complete data).** A ZIP of every document the engine holds,
  each decrypted to plain JSON. No key material goes in.

Export contacts no host and writes only the file the user chose.
`2026-10-18-export-design.md` has the targets and formats.

**Parked:** a published format spec plus a standalone CLI decryptor, covering
the narrower case where Sval is *gone* and only encrypted files remain. It is
deferred as scope creep.

---

## 7. Credentials

### 7.1 One owner, and it is the user's

**Sval keeps no credentials.** Passwords, passkeys, cards, addresses and one-time
codes live in the password manager the user already has. Sval's job is to make
that manager the only thing on the page that saves, offers or fills.

Every manager is treated alike. 1Password on macOS, iCloud Passwords on Windows,
Bitwarden, Proton Pass, KeePassXC and the rest get the same first-run offer, the
same settings and the same promise. No manager is a default and none is
recommended.

The reason is the experience. The common complaints about password managers in
other browsers are two systems answering one form: a browser save prompt beside
the manager's, two dropdowns on one field, a stale copy in the browser's store
filled over the manager's current one. Each is the browser's own manager still
running. Removing it removes the conflict.

### 7.2 What a browser can and cannot reach

**No desktop operating system lets a browser read or write a password
manager's website logins.** Checked 2026-10-08:

- **macOS.** `ASAuthorizationPasswordProvider` returns only the calling app's
  own associated domains. Apple Passwords reaches non-Safari browsers only
  through Apple's iCloud Passwords extension. Third-party managers reach them
  only through their own extensions.
- **Windows.** Credential Manager is a generic secret vault that no manager
  publishes website logins to. Microsoft's password manager lives inside Edge.
- **Linux.** Secret Service is a secret store, not a provider interface.
  `credentialsd` and an xdg-desktop-portal credentials portal are proposals,
  not shipped.

So **a manager's own extension is the channel for passwords on desktop.** It
runs its own field detection, dropdown, filling and save prompt, and it carries
the site-specific compatibility work Sval could never match. A merged
multi-manager list was designed and rejected: with no read API, Sval has nothing
to merge.

**Passkeys are the exception, because the operating system mediates them.**
Gecko's macOS backend (`MacOSWebAuthnService`) calls
`ASAuthorizationWebBrowserPublicKeyCredentialManager`, whose system sheet
includes iCloud Keychain and enabled third-party providers. Gecko's Windows
backend calls `webauthn.dll`, behind which Windows 11 (24H2 and later) runs
third-party passkey plugins. Linux has USB and NFC security keys only.

**Mobile is the OS's job.** On iOS, system Password AutoFill and passkeys work
inside WKWebView with whatever provider the user has set. On Android, GeckoView
implements the Android Autofill Framework (`Autofill.Session`), and its WebAuthn
path asks Credential Manager first on Android 14 and later.

### 7.3 What Sval does

1. **First run asks which password manager the user has**, and installs its
   extension from AMO (`2026-10-07-first-run-design.md`). The choice is
   device-local, and an extension installs only on a choice made on this
   device. "I don't use one" is a valid answer.
   Sval then says plainly that it will not remember passwords, and points to the
   free managers without choosing one.
2. **Firefox's password manager and form autofill are off, completely.**
   Locked prefs turn off saving, filling, generation, the passwords sidebar,
   and address and card autofill (`supported = "off"`, which removes their
   settings as well). about:logins still opens by name with the manager off,
   so `SvalCredentials` blocks it with a content policy, as the
   `PasswordManagerEnabled` policy does. The app menu's Passwords item is
   hidden, and `no-password-manager-settings.patch` hides the settings that
   have no pref of their own: OS reauthentication, site exceptions and the
   Primary Password. The login form's context menu items already hide
   themselves with the manager off.
3. **Firefox lists no passkeys in a sign-in field's dropdown.** That list
   (WebAuthn conditional mediation) is drawn by the login manager's dropdown,
   so it goes with the manager. It is not missed: the user's own manager
   extension offers passkeys in its own UI, and a second list on the same field
   is the clutter this section removes. A site's "sign in with a passkey"
   button still opens the operating system's passkey sheet. Restoring the list
   was weighed and rejected: it costs patches in Firefox's busiest password
   files and runs the login pipeline again in a narrow mode.
4. **Native messaging uses Sval's own folders** (decision 1738). Host,
   managed storage and PKCS#11 manifests are read from Sval's application
   data directory and its system twin (`~/Library/Application Support/Sval`
   and `/Library/Application Support/Sval` on macOS, `~/.sval` and
   `/etc/sval` on Linux) and from `Software\Sval` on Windows, never from the
   Mozilla folders Firefox reads (`native-messaging-manifests.patch`). A
   manager's desktop app finds Sval once it lists Sval among its browsers.
   Until then the user copies the manifest across
   (`docs/native-messaging-hosts.md`). Sharing Firefox's folders gave little:
   Bitwarden's desktop app writes the Firefox manifest only where Firefox's
   folder exists.
5. **Moving in.** Import (§12) reads no password. It guides the user through
   the other browser's own CSV export and the chosen manager's own import, then
   says to delete the file (`2026-10-08-import-design.md` §5.1). Google's and
   Microsoft's managers have no Firefox-family extension, so their users move
   through this path.

HTTP authentication dialogs cannot be filled by any extension. They stay
manual: the user copies from their manager.

### 7.4 Being let in

Some managers and every OS-mediated path admit only browsers they recognise,
because a request for credentials from an unknown program is how a credential
thief looks too. Each grant is bound to Sval's signing identity, so all of them
wait on an Apple Developer team for Ellm Tree and on Sval's release signing keys.
The extension alone works for 1Password, Bitwarden, Proton Pass, Dashlane and
LastPass without any of this.

| Grant | What it gates | Who decides |
|---|---|---|
| Parent launch constraint of `PasswordManagerBrowserExtensionHelper` | iCloud Passwords, entirely, on macOS | Apple, shipped in a macOS update |
| `com.apple.developer.web-browser.public-key-credential` | System passkeys on macOS | Apple, on request |
| `com.apple.developer.web-browser` | Passkeys for any site on iOS | Apple, on request |
| 1Password's approved browsers | Desktop-app unlock and Touch ID | 1Password; users can add Sval by hand meanwhile |
| Android autofill and privileged-browser allowlists | Autofill URL matching and passkeys on Android | Each provider, keyed by package and signing certificate |

**The iCloud gate is in the operating system.** Apple's helper carries a parent
launch constraint in its code signature: a list of signing-identifier and
team-identifier pairs (Zen, Waterfox, Glide and others). macOS kills it when
any other process launches it, and the extension reports that it cannot connect
to a helper application. This was observed with a Sval dev build on macOS 26.6
on 2026-10-08, and the list read with `codesign -d -vvvv`. Consequences: a
dev build, ad-hoc signed, never connects; a release build connects only on the
macOS releases that carry Sval's entry; until then an Apple Passwords user on a
Mac copies from the Passwords app.

Bitwarden documents biometric unlock as unsupported on Firefox ESR. Test it
against a Sval build before promising it.

### 7.5 Hide My Email

Apple's inline generation prompt is Safari-exclusive; no third-party browser gets
it on any platform. Sign in with Apple's masked-email option is a plain web OAuth
flow and works everywhere.

**Post-v1.** An open-source extension reimplements inline Hide My Email
generation against iCloud's APIs. Wiring that into Sval's chrome would make
Sval the only non-Safari browser with it.

---

## 8. The fork: build system and patch management

### 8.1 Repository

One repository holds the fork and its engine (decision 0111). Its layout and
licensing are in `CONTRIBUTING.md` ("Layout", "License notices") and `LICENSING.md`.

### 8.2 The build

The build steps and commands are in `CONTRIBUTING.md` ("Commands", "Patch
workflow").

### 8.3 Artifact builds

Development uses artifact builds on Sval's own compiled Gecko, and releases
are full builds (`CONTRIBUTING.md` hard rule 1). The engine
is never compiled into Gecko: it reaches the chrome as WASM, so one artifact
serves every desktop platform.

### 8.4 WASM has no I/O, and no clock or randomness either

**The core never reads the ambient environment.** Timestamps and new node ids are
passed in by the caller, never taken from a system clock or a random source
inside the engine. WebAssembly in the browser has neither: `std::time` panics
there, and UUID generation needs a randomness source the host supplies. A core
that reaches for either cannot be driven by a JS host at all, and cannot be
tested deterministically.



WASM in the chrome has no filesystem and no network. Every storage-provider call
shims back out to chrome JS. Keep that shim thin, explicit, and in one module — it
is the seam most likely to rot.

### 8.5 What needs a patch, and what does not

**Most of Sval needs no patches.** Firefox's chrome already exposes what the panel
requires:

| Need | Existing API — no patch |
|---|---|
| Track tab lifecycle | `TabOpen`, `TabClose`, `TabSelect` events |
| Read a tab's history stack | `SessionStore.getTabState()` |
| A cookie jar per isolated workspace | `ContextualIdentityService` |

All of that lives in an **added** JS module.

Where a feature needs more, Sval patches Mozilla's code (`CONTRIBUTING.md` hard rule
2). `patches/series` lists every patch, and each patch's header says what it
changes and why. First run is a `chrome://` page in Sval's own `jar.mn`,
opened as a modal, so it changes no Mozilla file
(`2026-10-07-first-run-design.md`).

### 8.6 Release engineering

A `v*` tag builds a release (`release.yml`): macOS in CI, Linux and Windows on a
clean machine. Signing and publishing happen in a separate private release
repository, which this repository's workflows cannot reach.

- **Updates.** Firefox's updater reads a static `update.xml` and MAR files from
  `download.sval.app`, signed with Sval's keys (§10.9, decision 0110). The host
  serves static files, and no server code of Sval's runs there. Release
  candidates go to a beta feed that About's setting opts into.
- **Packages.** macOS ships a .dmg, Windows an installer, and Linux a tarball,
  a .deb and an .rpm from signed APT and DNF repositories (decision 0094).
- **Signing.** Windows binaries are signed with an SSL.com certificate.
  The macOS app carries an ad-hoc signature, and Developer ID signing and
  notarisation wait on an Apple Developer team (§7.4, §15).
- **Security cadence.** Mozilla's ESR security releases are Sval's deadline.
  Falling behind means shipping known-exploitable browsers.
- **Widevine** downloads from Google on first use (§10.9). Netflix, Spotify,
  Disney+ and Prime need Sval to hold a Widevine license of its own (§15).

### 8.7 Where Sval's data lives

**Sval keeps its data in one directory per user**, `Data` in its application
data directory: `~/Library/Application Support/Sval/Data` on macOS,
`%APPDATA%\Sval\Data` on Windows, `~/.sval/Data` or `~/.config/sval/Data` on
Linux. Every build and every install location opens it, so moving the app or
installing a newer version never starts Sval empty
([1400](../../decisions/1400-sval-keeps-its-data-in-one-directory.md)).

**Firefox's profiles are not a Sval feature.** Gecko needs a profile
directory, and Sval's is that one directory. Sval reads and writes no
`profiles.ini` or `installs.ini`, so there are no named profiles, profile
groups, per-install profiles, profile selector or profile manager. `-P` and
`-ProfileManager` exit with a message.

**`--profile <path>` is the one override.** It starts Sval on another
directory, which is how `run.sh`, the test harness and sval-mcp get a
directory of their own. A Sval started that way is not on its default
profile, so it schedules no background update.

**A background task with a profile of its own** (`backgroundupdate`) keeps it
in Gecko's background-tasks directory, under a name made of the install and
the task. It reads Sval's data directory as the default profile.

---

## 9. Testing

Where each kind of test goes, and how tests run, is in
`chrome/browser/components/sval/test/CLAUDE.md` and `engine/CLAUDE.md`. The
engine's contract tests are the cases of
§5.3 and the deletion scenarios of §5.4.

---

## 10. Workspaces, isolation, and tab hygiene

### 10.1 Isolated workspaces

**A workspace is shared or isolated.** Shared is the default and uses the
profile's default cookie jar. Every tab in an isolated workspace uses that
workspace's own jar, and no other tab does; there is no per-tab isolation.
The choice is made in the new-workspace dialog and changed from the
workspace's menu, which reopens its tabs in the new jar after a confirmation.
Moving a tab between workspaces with different jars asks first.

**The flag syncs and the jar stays local** (§3.3). The workspace's `isolated`
lifecycle field syncs; each device makes its own jar the first time it needs
one, so users sign in once per device in each isolated workspace. Deleting an
isolated workspace clears its jar on every device.

**Firefox's container tabs are removed** as a user-visible feature, with their
prefs locked off, and the word "container" appears nowhere in Sval's UI.
`2026-10-14-isolated-workspaces-design.md` has the mechanism.

### 10.2 Archiving idle tabs

Have it, never force it. A tab nobody has used for a while, on any device,
leaves the tree and goes to the Archive (decision 0136).

- Options: **Never** (the default), 12 hours, 24 hours, 7 days, 30 days.
  Turning it on preselects 7 days. The global choice is a synced setting, and
  each workspace can override it in its `auto_archive` lifecycle field.
- Only loose tabs at a workspace's top level are archived, and a split only
  whole. A tab shown in a window, playing media, holding form data, kept
  loaded (§10.7) or in a group is exempt, and so are agents' workspaces and
  private windows.
- **The Archive is its own synced document, `archive`.** It only gains entries,
  and each device drops entries older than the synced retention period (7, 30
  or 90 days, 30 by default). The tree keeps no closed record (§5.4); an entry
  is never a tree node.
- The Archive shows in the History sidebar as "Archived tabs". Clicking an
  entry restores the tab as a new tab, beside its old neighbours in its
  workspace.
- A tab the user closes goes to Firefox's own recently-closed list, which is
  local, and not to the Archive.

`2026-10-19-idle-tab-archive-design.md` has the mechanism.

### 10.3 Ad blocking

**Sval blocks with its own lists, in Gecko's own engine.** Blocking runs on
adblock-rust through Gecko's content classifier, which takes the place of the
URL classifier for tracking protection's blocking categories; the URL
classifier keeps Safe Browsing. Sval does not install or manage uBlock Origin,
and a uBlock Origin the user installs is their own extension.
`2026-10-12-protections-design.md` §1 has the engine.

- **Lists.** Sval fetches its curated lists from each publisher (decision
  0102), and uBlock Origin's scriptlets at a pinned commit, checked by hash
  (decision 0103). It supports only the filter syntax adblock-rust applies
  (decision 0104). Every publisher host is on the network-contact list (§10.9).
- **Levels.** **Off**, **Balanced** and **Strict**, each a set of lists Sval
  curates, and **Custom** in Settings, where the user switches lists and adds
  list URLs. First run preselects Balanced, and installs nothing for it. The
  level is a synced setting. Strict also turns on Firefox's query stripping.
- **The user's own.** Allowed domains are never blocked anywhere. My filters
  are the user's own rules, one more list at every level but Off.
- **Trust to run trusted scriptlets is given on each device.** A trusted
  scriptlet runs code in every page, so a grant that synced would let one
  compromised device run code everywhere. An added list's trust syncs as
  "trusted on another device" and takes effect on a device only once its user
  trusts the list there, through the same confirmation. "My filters" sync as
  text, and the trust in them is in the text this device's user trusted: rules
  another device writes run no trusted scriptlet until trusted again here. The
  switch for trusted scriptlets is per device.

**Extensions install from AMO as they do in Firefox.** Sval keeps Firefox's
application id (`MOZ_APP_ID` in `browser/moz.configure`), so AMO serves Sval
what it serves Firefox.

---

### 10.4 Tab materialization and scale

**Sval takes over tab restoration from Firefox.** Sval's tree is the model, not a
copy of what happens to be open; a workspace holds its tabs whether or not they are
loaded. Firefox's open tabs are a *view* of that model, so on every startup — crash
or not — Sval holds each window's tabs to the tree.

**Firefox's session restore brings back the windows**
([0050](../../decisions/0050-tabs-restore-from-the-tree.md)). Every launch
resumes the last session, so each window returns with its place, its size, its
stacking and the workspace it showed, which is what §10.7 asks. The tabs the
session brings back are held to the tree: a tab whose node is in the window's
workspace stays, pointed at the node's address if it has not loaded; a node with
no tab gets one; a tab whose node is gone closes; and one whose node is in
another workspace goes as a switch lets it go.

Each Firefox tab carries its Sval node UUID via `SessionStore.setCustomTabValue`
(`browser/components/sessionstore/SessionStore.sys.mjs:674`; it accepts string
values only, and `getCustomTabValue`/`deleteCustomTabValue` are its partners), which
persists across restarts, making the match trivial. A restored tab with no known
UUID is a stray and becomes a child of the workspace itself.

**A workspace holds tabs and groups as siblings.** There is no catch-all group for
loose tabs, and a tab that belongs to no group is not wrapped in one. The panel
renders a workspace's children as a single ordered list — tabs and groups
interleaved, positioned by the shared fractional index, exactly as loose files sit
beside folders in a folder. Ordering is one comparison over that index; nothing
sorts by kind. A group expands, a tab is a leaf, and screen readers are told the
size of the whole mixed list.

This is why a stray needs no invented home: the workspace *is* the natural one. A
catch-all group would have put an unlocalised name inside the user's synced
document, and a fixed id for it across devices would converge on one placement when
two devices first created it under different workspaces.

**Every screen the viewport shows is a filed tab**
([0085](../../decisions/0085-every-screen-in-the-viewport-is-a-filed-tab.md)).
With no tab strip, the panel is the only way to reach or close a tab, so a tab
with no node is a screen the user can see and cannot close. Web pages, error
pages, the home page, settings, Firefox's `about:` pages, and an `about:blank`
the user opened are all filed and closed like any tab. The only tabs left
unfiled are bare `about:blank` tabs with no history that Sval or the window
opened: a new tab whose first load has not committed, the startup tab that
restore replaces with the workspace's tabs, and an agent window's keeper, the
blank page that keeps the window open when the agent has no tab. None of these
is a screen anyone chose.

**Materialization rules, which are also the answer to scale:**

- **Inactive workspaces are data only.** Their tabs are tree nodes, not Firefox
  tabs. Memory tracks what is in use, not everything ever filed away.
- **The active workspace materializes tabs lazily.** A tab exists unloaded,
  and its page loads when it is selected.
- **The panel virtualizes rows**, drawing only what is on screen. ARIA must report
  the full set size rather than the visible subset (see §10.5).
- **A materialized tab loads as its own site would.** Any device can write a
  tab's address, and the tree does not say which did. So a tab materializes
  only at an address a web page could navigate to, and loads it with a
  content principal for the address's own origin, in the workspace's jar.
  A local file, a browser page, script or a top-level data: page gets no tab.
  Sval's own home and settings pages are the exception: they load as the user's
  choice. A tab's first load is same-site, so a site the user is signed in to
  sees its cookies, as when the page reloads itself.
- **A restored tab's first load is a reload.** Session store loads a tab it
  restores through `nsSHistory::ReloadCurrentEntry`, which Sval patches to
  load as a reload does, so the page is checked with its server. A history
  load takes the cache's copy without asking (`VALIDATE_NEVER`), so a tab
  opened days after its session would show the page as it was then.

### 10.5 Accessibility

**Non-negotiable, and built from the start** — roughly a 10% tax when designed in,
a rewrite when bolted on. Replacing Firefox's sidebar moves this responsibility
from Mozilla onto Sval.

The panel requires: arrow-key navigation, correct ARIA tree roles so VoiceOver and
NVDA announce structure and nesting depth, visible focus indicators, and no
mouse-only actions.

**Several rows can be selected at once.** The tab on screen is the panel's one
selected row until the user selects more, and reorganising a workspace needs
many rows moved at a time. The panel follows the platform's list conventions,
which Firefox's tab strip follows too (`MozTabbrowserTab.on_mousedown`):

- A click shows the row's tab or folds its group, and clears the selection.
- Accel-click (⌘ on macOS, Ctrl elsewhere) adds a row to the selection or
  takes it out. Shift-click selects every row from the row last clicked to
  this one, in the order the panel draws them. Neither changes the tab on
  screen, and the first one starts from it.
- Shift+Up and Shift+Down extend the selection from the focused row, and
  Ctrl+Space adds or removes the focused row: the ARIA tree pattern's keys for
  a multi-select tree. The arrows alone move the focus and keep the
  selection. Escape clears it.
- A selection holds drawn rows only. A row its group folds over leaves the
  selection, and a selected group carries everything in it. A selection is
  of the workspace the window shows: a switch clears it, and a row that
  moves to another workspace leaves it.
- The tree is `aria-multiselectable`, and each row says whether it is
  selected in `aria-selected`. A selected row is drawn as the tab on screen's
  row is.

**A selection acts as one.** Close, Delete, Move to group, Move to Workspace,
New group with selection, and a drag act on every selected row, each through
the command one row runs, in one engine batch. The rows keep the order they
are drawn in, and a row inside a selected group goes with its group. A move
that asks first, into an agent's workspace or across cookie jars, asks once
for the whole selection. Only a tab closes, so a selection with a group in it
cannot be closed. A dropped selection lands beside a row or inside a group;
the drops that make a group or a Split take one row. The row menu's other
entries act on one row, and the menu disables them while it is open on a
selection. The selection lives in the window's memory, device-local
(§5.6) and unsaved, as Firefox's tab multiselection is.

**The selection is the panel's own.** Gecko's tab multiselection
(`addToMultiSelectedTabs`) holds tabs alone, and a row may be a group, a
Split, or a tab with no Gecko tab until it is opened (§10.4). Gecko clears it
on every tab switch (`updateCurrentBrowser`), and ranges over `visibleTabs`,
the hidden tab strip's order. Its readers are the tab strip's context menu
and drag, which Sval does not show, so a copy kept there would be read by
nothing.

### 10.6 Crash reporting

**Local unless the user sends it.** Crashes write a file locally. A crash
report leaves the device only when the user ticks the box on the crashed-tab
page or in the crash reporter, both unticked by default, and then goes to
Sval's feedback collector, `feedback.sval.app` (decision 1199), never to
Mozilla. The collector stores no IP address and no identifier, and Sval never
contacts it on its own (§10.9).

### 10.7 One workspace at a time

**A window shows one workspace.** The panel renders that workspace's children
and nothing else; a switcher at the top of the panel names the current one and
lists the others. The switcher is also the one place a workspace is made ("New
workspace…"); the panel's header and its row menus offer "New group", never a
new workspace. A new workspace and a new group are asked for in one dialog: a
name, a colour and an emoji. This is how Arc and Vivaldi both work, and it is what makes a
workspace feel like a place rather than a folder: the browser you are looking at
is the work you are doing.

**Which workspace a window shows is device-local (§5.6) and per-window.** It is
a fact about a window on a machine, not about the shared tree — two devices sit
in different workspaces at the same time, which is most of the point. Syncing it
would drag one machine's attention onto another's.

**Switching hides, and an idle workspace unloads.** The outgoing workspace's
tabs are hidden (`gBrowser.hideTab`) and keep running; the incoming
workspace's are shown if the window kept them, and otherwise materialised
lazily, exactly as a restored tab already is (§10.4): `addTrustedTab` with
`createLazyBrowser`, then `setTabState`. A workspace the user comes back to
within a few hours is as they left it, pages, scroll and audio included,
as it is in Zen and Crest.

A hidden workspace's tabs unload three hours after its window left it
(`HIDDEN_WORKSPACE_UNLOAD_MS`), released as a lazy tab: the node stays, and
the tab returns when it is clicked. Firefox's own `TabUnloader` still
discards the least recently used tabs sooner when memory runs low. Unloading
only under memory pressure is what Zen does, and its users report that tabs
then never unload; three hours lets a day's abandoned workspaces give their
memory back without a reload after a meeting. A tab holding no page leaves
the window at once.

**A tab the idle unload cannot release stays loaded and hidden.** A page the
user typed into, a video in picture-in-picture or a call, and a tab with a
dialog open are kept loaded, because releasing them would lose what they
hold. A tab playing sound is kept too, as `TabUnloader` weighs one
(`isPlayingMedia`): the user can hear it. Every place a hidden workspace's
audio can be heard from carries a media button: the tab's row, a collapsed
group's row and the workspace's entry in the switcher. It reads each tab's
media controller (`browsingContext.mediaController`, as the media keys do)
and redraws on its `playbackstatechange`, so it changes the moment the
page's own player does; `soundplaying` lags a stop by seconds and is read
only for sound no controller holds. A tab whose page has media shows pause
or play, a press pausing or playing it as its media keys would; muting alone
would leave a video running silently. Sound with nothing to pause, such as
Web Audio, shows mute and unmute instead. A group's or a workspace's button
pauses everything in it and plays again only what it paused, so it never
starts a video the user stopped in the page. Its tooltip names what a press
acts on, from the controller's metadata (`getMetadata`, the page's Media
Session title or Gecko's default from the page title) and redrawn on its
`metadatachange`: one name for one tab, up to three for a group or
workspace.

The panel's footer holds previous track, back ten seconds, play/pause,
forward ten seconds and next track for one tab of the window, whatever
workspace it is in: the one audible, or else the one heard last, never one
that holds media it has not played with sound. Gecko keeps its own main
controller for the media keys (`MediaControlService`) and exposes no way to
read it, so Sval chooses from the controllers' `audiblechange`. The track
buttons show only while the page offers them (`supportedKeys`); seeking
works on any media. The controls are hidden while no tab has media.

**A tab the user keeps loaded is exempt.** Keep Loaded, in a tab's menu, marks
the tab with Firefox's own `undiscardable` attribute, which Firefox's memory
unloader already honours (`isNonDiscardable` in `TabUnloader.sys.mjs`). A
switch keeps such a tab loaded and hidden, as it keeps one holding form data,
so its page goes on running in a hidden workspace; the idle-tab archive skips
it too. Unload still unloads it when the user asks. The mark is per device,
kept by session restore, and never synced: memory is a fact about one machine.

**A workspace can be torn off into its own window, and has at most one.**
"Open in new window" gives a window whose current workspace is that one. The
switcher offers it only for a workspace no window shows; choosing a workspace
another window shows brings that window forward instead of moving this one onto
it (decision 0079). The rule holds wherever a window takes a workspace — the
switcher, a tear-off, an agent's window, session restore, a new window — because
it is enforced at the one place a window changes workspace, which never takes a
workspace another window shows. A window still starting keeps its claim: what it
was handed, or what the session remembers for it, counts as shown. A new window
never takes an agent's workspace (agent-control spec §3.5), or a phone's or
tablet's own (decision 2254), while the user has a workspace of their own, open
or not: a window the user opens is the user's.
⌘N (Ctrl+N) takes the next free workspace down from the window's own,
wrapping at the bottom (`2026-10-22-launcher-design.md`). So
a new window with every one of the user's workspaces already open gets a new,
nameless workspace of its own, even when an agent's or a device's workspace has
no window; a
window whose workspace is deleted, with every other workspace of the user's
open elsewhere, has nothing left to show and closes, deleting nothing (§5.4).
A popup a page opened is outside the rule: it shows the page that opened it and
closes with it. A tab moved into a window showing another workspace, by a drop of its
row on that window's panel, Firefox's own moves (`gBrowser.adoptTab`,
`replaceTabsWithWindow`) or an extension's `tabs.move`, joins that window's
workspace, as Move to Workspace moves it: a
window holds only its workspace's tabs, so a tab left filed where it came
from would be one its window's panel does not draw. A dropped row lands where
it is dropped, beside a row or into a group, as a selection of one is dropped
(§10.5). The panel takes one tab's row from another window, and refuses a
group's, a Split's or a selection's. A move into another jar
asks first (isolated workspaces spec §6), and Cancel hands the tab back to the
window showing the workspace it came from. A window showing an agent's
workspace takes no tab of the user's this way, because a move into an agent's
workspace hands the tab over only once the user has agreed (agent-control
spec §5.4). A window's current workspace is remembered per window, so reopening
restores what each was showing.

**The panel follows the document, not the click.** When a sync removes the
workspace a window is showing, that window moves immediately and the switcher
is rebuilt — it does not wait for the user to try something and then explain
why it failed. A click on an entry that has since vanished is a no-op and a
redraw: the entry disappears, which is the answer. An unexpected failure to
show a workspace is a bug, and belongs in the console, loudly — not narrated to
someone who cannot act on it. A string that explains a state the user should
not be in is a sign the state should not exist. A sync problem is
the one such state the panel mentions, in the footer's sync indicator: an
unreachable folder is a calm offline state, a problem that fixes itself says
nothing, and a failure to save or open this device's own copy is a critical
dialog (`2026-10-21-messages-design.md` §3 and §4). The engine's own wording
stays in the console.

**Every node must be visible from somewhere.** The panel is Sval's only tab
surface, so a node drawn in no workspace is a tab the user cannot reach — worse
than a misplaced tab, because nothing tells them it exists. A merge can produce
the unreachable shapes §5.2 lists, and the engine's repair puts each into a
workspace on every sync pass, before the panel reads the tree. The engine is
the one place that rule lives: every document the panel draws has come through
a sync pass, so the panel draws the tree as it is and keeps no copy of the
rule. A repaired node is an ordinary row in its new workspace, and moves like
any other.

**Colour and emoji are shown wherever a workspace or group is named** — in the
switcher, on the row, and on the window when a workspace is torn off, so a
torn-off window is identifiable from the Dock and from ⌘` alone.

### 10.8 Where settings live

**The panel is a tab surface.** Anything configurable lives in Settings.

**Sval's settings are categories of `about:preferences`**, so settings are one
place ([0082](../../decisions/0082-sval-settings-are-categories-of-about-preferences.md)).
The nav, in order:

- **General**: the default browser, the warnings before quitting and before
  opening many tabs, languages, downloads, media and performance.
- **Workspaces** (Firefox's Home): the home page and whether it shows
  Favorites, archiving idle tabs, pins, and import and export, the complete
  export included.
- **Links**: links from other apps, peeks, a pin's links to other sites,
  whether a new tab takes focus, and routing rules. A link that asks for a
  new window opens a tab, from a page or from another app, and Sval offers
  no choice of it, because a new window takes another workspace (§10.7).
- **Sync and devices**: a Sync card (the folder, its sync status and Sync
  now), a Your devices card (this device's name and syncing another device),
  then an Advanced holding the sync key.
- **Appearance**: the panel's side, the theme, the address bar and its
  buttons, then Firefox's accessibility groups (zoom, fonts, contrast,
  keyboard and scrolling, motion) under an Accessibility heading.
- **Search and Launcher**: the engine, Kagi, suggestions and the Launcher's
  sections.
- **Privacy and protection** (Firefox's Privacy and security): blocking,
  cookies and site data, fingerprinting, privacy signals, HTTPS-Only and
  Secure DNS, breach warnings and browsing protection, passwords and security
  keys, history, then an Advanced holding the rest of the tracking switches,
  bookmarklets, certificates and the proxy
  ([1484](../../decisions/1484-privacy-and-protection-and-sites.md)).
- **Sites**: the defaults every site gets (JavaScript, video and audio, each
  permission's default, pop-ups), then every site with a choice, each row
  saying what differs and leading to its page, the one place its choices
  and permissions are made, the extensions that reach it among them
  ([1484](../../decisions/1484-privacy-and-protection-and-sites.md),
  [1659](../../decisions/1659-extension-site-switch.md)).
- **Extensions**: how long extension updates wait, the installed extensions
  and each one's page, which lists the sites it is off on
  ([1479](../../decisions/1479-extensions-is-a-category-of-settings.md),
  [1653](../../decisions/1653-extension-updates-wait.md),
  [1659](../../decisions/1659-extension-site-switch.md)).
- **Agents** (agent access), each paired agent's permissions on a page of its
  own, then **Keyboard shortcuts**.
- **About**, after a separator, whose Advanced holds the diagnostics log
  level and the way to `about:config`.

A setting sits where a person looks for its topic, whichever of Firefox's
categories held it.

**One topic has one category.** Where Firefox's own category already holds a
topic, Sval's setting joins it rather than repeating it. The search engine is
chosen only in Firefox's Search category, which Sval names Search and
Launcher, whose engine control sets the same default first run sets and
settings sync observes. Kagi's card sits there, after it, while Kagi is the
default engine or private windows' engine, or while a Session Link is saved:
signed out it offers first run's sign-in, and signed in it says how private
windows sign in, with the Session Link field for a plan without Privacy Pass.
They are added files, not a patch: a
`document-element-inserted` observer loads Sval's script into the page before
the page's own scripts run, and that script adds each category's nav button
and pane through `preferences.js`' own `register_module` before `init_all`
reads the URL. The panes' markup is a separate file Sval owns. A settings tab
is filed in its workspace like any other tab (§10.4). The cog brings forward
the settings tab already open in the window, at the category asked for, and
opens one only when there is none.

It holds, at minimum: where workspaces are stored and the control to change it;
both ends of device pairing; sync state and the manual "Sync now" of §6.4; the
idle-tab archive's choices (§10.2). Import and export live in the Workspaces
category (`2026-10-08-import-design.md` §5).

**Settings copy is short.** A heading, at most one line under it, and the
control; a control's label says what it does. Syncing is ordinary and is not
explained. The sync folder is shown as a field: a friendly name ("iCloud Drive
› Sval" for a cloud folder, the folder's own name otherwise) over the full path,
with "Change…" and the platform's reveal ("Show in Finder", "Show in File
Explorer", "Show in Files"). The sync readout shows one state at a time:
syncing, synced with the last-synced time, or a problem with a short reason.
It has a Lucide icon, and its motion stops under `prefers-reduced-motion`.

**Advanced settings are one pattern.** A category with advanced settings ends
in one collapsed **Advanced** disclosure holding them, each in a card of its
own: Sync and devices (the sync key's backup, restore and setting up sync
again), Privacy and protection (more tracking protection, bookmarklets, and
Firefox's certificate and proxy groups), Agents (WebDriver) and About (the
log level and `about:config`). Where moving an advanced control out
would part it from what it changes, its card ends in an Advanced disclosure of
its own instead: blocking's (My filters, page rules, trusted scriptlets),
fingerprinting's (each group's switches, which Strict and Restore also set)
and Privacy signals' (Do Not Track). Whether one is open is not kept. Settings
search opens them, so a match inside one shows.

**Like interactions look alike.** Every empty list says so the same way: a
title and one line on how something gets there. A heading carries no count;
a list with a search says "N of M" under it only while the search or a
filter narrows it. A choice applies as it is
made, except where making it acts outside settings: the password manager's
radios only select, because the arrow keys check each radio they pass, and its
button says what it does ("Add extension").

**There is one folder, and another device needs a code to read it.** The Sync
card is the folder and what it is doing; the Your devices card says "Your sync
folder is encrypted. Another device needs a one-time code to read it." beside
one button, "Sync with another device". The page never says "pair": Agents
uses the word for an agent's access.

**Syncing another device is a guided flow.** The button first asks which
device shows the code: "This device shows a code" (this device offers its
key, and the other types it) or "The other device shows a code" (this device
claims one, and you type it here). Only that path's steps show, one at a time.
Offering: confirm the sync folder, then show the code with its countdown, the
slow-provider note and the warning. Claiming: start the code on the other
device, then type it. A path with a live code or a claim still looking cannot
be left by Back; "Cancel code" and "Stop" are the way out. Without a sync
folder, the devices card says "Choose a sync folder first." with a button that
takes the caret to the Sync card. The flow is presentation only: §6.7's
mechanism and its three outcomes are unchanged.

**One scrollbar.** Every Sval scroller (Settings, the workspace panel's
tree, the popovers, the dialogs and pages Sval draws) has a thin scrollbar
whose thumb shows whenever there is more to scroll to, on a clear track.
A web page takes the same thin scrollbar by default, through Gecko's UA
sheet ([patch](../../../patches/content-thin-scrollbars.patch)), so a page's
own `scrollbar-width` and `scrollbar-color` win. Its thumb is a neutral grey
there, because a page's text colour does not say how dark its background is.
Forced colours keep the system's scrollbar. A popover scrolls a box inside
its rounded content, so the content's corners, edge and shadow stay whole.

**What floats is opaque.** A menu, a list, a popup or a dialog stands on
Sval's raised surface, never on the card colour, which is translucent in the
dark theme. Firefox's pages take it through Mozilla's panel token, which
`panel-list` reads ([patch](../../../patches/panel-list-panel-background.patch)).

**The panel keeps nothing configurable — only what informs, and the way out to
what configures.** That is a **settings cog in the bottom right**, labelled
"Settings" for a screen reader, and the **sync indicator** beside it: one icon
whose variant says the sync state, whose tooltip carries the last-synced time,
because §6.4 requires it to be *visible*, and whose label and button appear
only for a state a person needs to see without going looking, such as a device
on a newer schema (`2026-10-21-messages-design.md` §3). The test is not how many
elements there are; it is that **the button that acts goes to settings and the
text that informs stays.**

**Settings work in whatever window they are in.** It reaches Sval through
the profile, not through the window that happens to contain it, so a page
restored by session restore into a window whose panel has gone is still a
working settings page.

**First run offers some of these choices, and does not replace this page.**
Whatever Sval asks at first launch (a folder, a search engine, the blocking
level, the panel's side, a password manager) stays changeable here, because a
flow someone clicked through once is not the place to change it
(`2026-10-07-first-run-design.md`).

**A synced setting never switches Safe Browsing or extension updates off on
another device**
([0133](../../decisions/0133-safe-browsing-and-extension-updates-sync-one-way.md)).
Safe Browsing's malware, phishing and download switches, its block of
potentially unwanted downloads, and extension updates sync one way: a value
another device writes that turns one on applies, and one that turns it off
does not, so each device keeps its own "off". A device holding the sync key
is the user, so it may switch any other synced protection off. Settings sync also refuses, both ways, the addresses
Firefox Sync refuses (`data:`, `file:`, `blob:`, `moz-extension:`), as tabs,
Favorites and pins do with theirs (§5.7). The home
page opens with the system principal, so it is stricter: a home page syncs
only when every address in it is http, https or Sval's home page, and any
other stays on the device that set it.

### 10.9 Network contact

**Sval contacts nothing it cannot name.** Principle 1 says Sval runs no servers;
this section is what makes that true of the browser as well as of sync. Firefox
contacts about twenty hosts on its own, and Sval inherits every one unless it
says otherwise. A test launches Sval on a fresh profile, records every outbound
connection, and fails on any host not in the list below — so a rebase onto a new
ESR cannot add a contact quietly.

The list was built by measurement (153.5.0esr, macOS): fifteen
minutes idle on a fresh profile, then a relaunch driven through a page load,
address-bar typing, a search and a new tab, with Gecko's network logs
cross-checked against the operating system's socket table. Decided one host at
a time:

**Kept, and disclosed by name:**

- **Remote Settings** (`firefox.settings.services.mozilla.com` and its two
  CDNs), restricted to an allowlist of collections, grouped by what they
  protect. Certificate revocation: `cert-revocations`, `onecrl`,
  `intermediates`. Extension and driver blocklists: `addons`,
  `addons-bloomfilters`, `gfx`. Tracking protection and the site fixes it
  needs: `tracking-protection-lists`, `content-classifier-lists`,
  `query-stripping`, `url-classifier-skip-urls`, `url-classifier-exceptions`,
  `anti-tracking-url-decoration`, `bounce-tracking-protection-exceptions`,
  `fingerprinting-protection-overrides`, `partitioning-exempt-urls`,
  `third-party-cookie-blocking-exempt-urls`, `cookie-banner-rules-list`,
  `webcompat-interventions`, `hijack-blocklists`. Translations:
  `translations-models-v2`, `translations-wasm-v2`. Windows DRM:
  `mfcdm-origins-list`.
  Breach alerts: `fxmonitor-breaches`, the whole list, matched against the
  site on the device, and synced only while breach warnings are on (decision
  0131).
  Sval polls for changes every hour (`services.settings.poll_interval`). Each
  poll also measures the device's clock, and a device publishes nothing to
  its shared folder before its first measurement (§5.3, decision 1714). Until
  then Sval polls at startup, again after 30 seconds, then at doubling
  intervals up to 30 minutes, and at once when the network comes back or the
  computer wakes, never inside a backoff the server asked for.
  Each request carries an IP address and nothing about browsing. Without the
  revocation collections Sval falls back to asking each certificate authority
  about each site visited, which is worse. The list fails closed, so it is
  named by consumer, not by what a fresh-profile capture shows syncing: several
  protections arrive in the startup bundle and never appear as a sync of their
  own. `remote-permissions` is left out on purpose: it lets Mozilla grant sites
  permissions remotely, and the copy bundled in the build still applies. Every
  other collection — sponsor images, sponsored suggestions, wallpapers, search
  telemetry, Nimbus recipes, DoH rollout, Mozilla's search
  configuration — never syncs (`remote-settings-allowlist.patch`, reading
  `browser.sval.remoteSettings.collections`), and one that does fails the
  network-contact test.
- **Extension update checks** (AMO). They tell AMO which extensions are
  installed; that is the price of extensions' security fixes arriving on
  their own. Firefox's per-user "update automatically" switch stays. The
  checks run as Firefox runs them; an update they find waits the days set in
  Settings before it installs
  ([1653](../../decisions/1653-extension-updates-wait.md)).
- **OpenH264** (Cisco), fetched once per Sval release from the version list
  bundled in the build. Cisco must be the distributor for its patent license to
  cover the user, so it cannot be bundled. Fetching it only when a call needs it
  is post-v1.
- **Google Safe Browsing**, under Sval's own key, for phishing and malware lists.
  Lists are downloaded and checked locally; a match sends a hash prefix, never a
  URL. Chosen over uBlock Origin's lists after comparing coverage: uBO ships no
  phishing list by default, and the one it offers is built from OpenPhish and
  PhishTank, which published measurements put far behind Google (1.6 million
  URLs against 12,433 and 3,861; 74% of self-hosted phishing caught at a median
  51 minutes). The remote download check stays off — Gatekeeper and SmartScreen
  already examine downloaded programs.
- **The iPhone's fraudulent website warning**, WebKit's own, on by default.
  The app's WebKit processes contact `token.safebrowsing.apple`,
  `proxy.safebrowsing.apple`, `safebrowsing.g.aaplimg.com`,
  `configuration.apple.com`, `safebrowsing.googleapis.com` and
  `proxy-safebrowsing.googleapis.com` for it. Apple's Safari privacy notice says the
  check sends Google Safe Browsing and Apple information calculated from the
  address, and never the address itself.
- **Updates** (`download.sval.app`, §8.6, decision 0110): once a day, a
  request for a static `update.xml` per channel and platform, so the check
  reveals the channel and platform only, never the version, build, OS or
  locale.

- **Blocking lists**, from each list's publisher, on the lists' schedule
  (§10.3, decision 0102), and uBlock Origin's scriptlets at the one commit Sval
  pins (decision 0103). A list a user adds is theirs, like a page they open.

- **Search suggestions**, from the engine the user chose, in the address bar
  and on the home page (decision 0098). They tell the engine what the user
  types before they submit it. Settings > Search turns them off, and private
  windows keep them off unless the user turns them on there. The address bar's
  pre-connect on focus is off regardless.

**Kept, only after the user asks:**

- **AMO** (`addons.mozilla.org`), for the password manager extension the user
  chooses (§7.3), and for any extension the user installs.
- **Kagi** (`kagi.com` and its sign-in and suggestion hosts), only when the
  user chooses Kagi.

- **Widevine** downloads the first time a site needs DRM and the user agrees,
  through Firefox's own Linux flow (`media.eme.enabled` off) applied to every
  platform. Downloading it at first launch told Google about every install.
- **Web Push** connects only while some site holds a notification permission.
  Firefox holds the connection open from launch on every profile, which gives
  Mozilla each install's IP address and an identifier for as long as it stays
  connected, whether or not the user ever allowed a notification. Remote Settings loses instant updates and
  polls every hour instead of Firefox's daily, so a certificate
  revocation reaches every running Sval within an hour. "Never" is a
  setting.
- **DNS over HTTPS** is off unless the user turns it on (decision 0105).
  Automatic rollout routes every lookup to a resolver Sval chose; with it off,
  the operating system's DNS — a Pi-hole, NextDNS, a corporate resolver — is
  respected. The rollout's probe lookups go with it. Protections' Secure DNS
  card turns encrypted DNS on, through Quad9 (`dns.quad9.net`), Cloudflare
  (`cloudflare-dns.com`) or a URL the user gives, and only the chosen resolver
  is contacted.
- **Android remote debugging** (`ftp.mozilla.org`). about:debugging's Enable
  USB Devices button downloads Mozilla's ADB extension, which carries the
  Android Debug Bridge for the platform, from `devtools.remote.adb.extensionURL`
  (`ADBAddon.install`). That button is the only caller, so nothing contacts the
  host before the click. Once installed, the extension names its update
  manifest on the same host (its `update_url`), so the extension update checks
  ask there until Disable USB Devices uninstalls it. Kept so Sval can debug
  pages on Android, Sval's own Android version among them.
- **Sval's feedback collector** (`feedback.sval.app`, decision 1199). It
  receives a report only when the user presses Send in the Send Feedback form,
  or ticks a crash dialog's box to send a crash report. It stores no IP
  address and no identifier, and Sval never contacts it on its own. It is the
  one server Sval runs.

**Removed:**

- **Mozilla's update and system add-on checks** (`aus5.mozilla.org`). The
  request identified as Firefox and carried build ID, OS version, CPU features
  and installed memory; Sval cannot install Mozilla's updates anyway.
- **Region lookup by IP** (`location.services.mozilla.com`). The region comes
  from the operating system's own setting instead, which is the one the user
  chose and is right behind a VPN. Removing it without a replacement would leave
  region-gated features — address and card autofill among them — silently off.
- **Merino and Firefox Suggest**: new-tab and address-bar weather (which sent
  the user's city), sponsored and non-sponsored suggestions, and Merino's own
  geolocation. Endpoints are blanked so that anything a region or experiment
  re-enables has nowhere to go.
- **Captive-portal and connectivity checks** (`detectportal.firefox.com`).
  Plain HTTP, every few minutes. Every platform Sval targets detects captive
  portals itself.
- **Add-on metadata and recommendations** (AMO). Metadata sent the full list of
  installed extensions daily to fetch ratings and screenshots.
- **Certificate-error MITM priming** (`mitmdetection.services.mozilla.com`).
  An unknown-issuer certificate error sent Mozilla a request to learn whether
  a proxy intercepts every connection, and any page could cause one by
  sending the user to such a site.
- **Network geolocation** (`www.googleapis.com`). When the operating
  system's location service failed, the nearby Wi-Fi access points went to
  Google's geolocation API. Location comes from the operating system alone.
- **Crash report submission to Mozilla** (§10.6). Nothing submits unless the
  user ticks the box on the crashed-tab page or in the crash reporter, both
  unticked by default, and a report the user sends goes to
  `feedback.sval.app`.
- **Seeded top sites and DNS prefetch.** Every new tab looked up six sites the
  user never chose; prefetch also lets any page make Sval resolve hosts the user
  never visits.
- **Firefox Accounts and Sync.** Sval's sync is §6; Mozilla's is a second,
  server-based one that a privacy promise cannot coexist with. Firefox's own
  kill switch (`identity.fxaccounts.enabled`) is locked off, which removes the
  toolbar's Account button and every account and sync surface, and the
  network-contact test proves no build contacts Mozilla's account or sync
  servers. **The code still ships, dormant.** Removing it
  was measured: dropping it from the build broke startup, tab handling, the
  settings page, Firefox View and the passwords page, because Firefox's
  front-end imports those modules directly. Repairing every caller costs about
  twelve patched Mozilla files and a rebase tax on the ones Mozilla changes
  most; that was rejected. If "sval does not contain it" is ever wanted as a
  claim, the route is a two-line build patch plus inert stand-in modules at the
  same import paths — added files, no network code.

**Search** contacts only the engine the user picked (§13 item 3), and with none
of Mozilla's partner codes: they credit Mozilla under a contract Sval is not
party to.

**On iPhone** the same rule holds, and `scripts/network-contact-ios.sh`
measures it nightly in the simulator from a packet capture, with Balanced and
with Strict blocking. The blocking lists come from the same publishers as the
desktop's. Dropbox's hosts (`www.dropbox.com`,
`api.dropboxapi.com`, `content.dropboxapi.com`, `notify.dropboxapi.com`) are
contacted only when the user keeps the shared folder in Dropbox (mobile spec
§8.1). A site's icon is fetched without cookies once a page of the site has
loaded: from the address the page names, which can be on another host, else
from the site's `/favicon.ico`, and never from an address the page's blocking
lists block.

**On the desktop**, Dropbox's sign-in and API hosts (`www.dropbox.com`,
`api.dropboxapi.com`, `content.dropboxapi.com`) are contacted only when the
user signs in to Dropbox to keep the shared folder there (desktop connectors
spec §3, decision 2650).


## 11. Mobile (v2 fast-follow, designed for now)

Three commitments that bind v1 work:

1. **The engine contains zero browser APIs**, and the sync format is versioned.
2. **iOS is a separate native Swift app on WKWebView.** App Store guideline
   2.5.6 requires WebKit, the JIT entitlement is WebKit-only (so sideloading
   does not help: Gecko without JIT is unusable on a phone), and **no iOS
   GeckoView exists**. Mozilla prototyped one and shelved it.
   - iOS gets: the workspace tree, sync, `WKContentRuleList` ad blocking, system
     autofill.
   - iOS does not get: extensions. **Ever.** Say so plainly in the product rather
     than letting users feel shortchanged.
3. **Android uses GeckoView** — no engine restriction, extensions work, and APKs can
   be distributed from anywhere. Android can be the full Sval.

Note: **Apple restricts iOS only.** macOS Sval is the full, unrestricted fork.

---

## 12. v1 scope

**In:**

- Firefox ESR fork, branded, building on macOS, Windows and Linux. macOS
  ships one build for Apple silicon and one for Intel, and an Intel copy
  running under Rosetta updates to the Apple silicon build (decision 2122)
- Nested workspace/group/tab tree with emoji icons, and split view
- Panel on the left or right, with pins
- The engine in Rust, compiled to WASM: tree model, per-fact-group UUID merge,
  the lifecycle model, encryption, storage providers
- Storage provider interface with the **local folder** implementation
- At-rest encryption, the sync key kept under the system store (§6.6)
- Last-synced indicator and manual "Sync now"
- Export to other browsers and as complete data (§6.8)
- Password manager picker at first run; Firefox's password manager and form
  autofill off; passkeys through the operating system (§7.3)
- First-run search engine picker with first-class Kagi support
- Favorites, history, settings and the Archive syncing through the same
  storage layer (§5.6)
- Isolated workspaces, off by default (§10.1)
- Sval's own blocking with three curated levels and Custom (§10.3)
- Archiving idle tabs, defaulting to Never (§10.2)
- Import from Firefox, Arc, Chrome, Edge and Safari
- The Launcher (`2026-10-22-launcher-design.md`)
- Agent control through sval-mcp (`2026-10-06-agent-control-design.md`)
- Private windows on Sval's panel, saving nothing (§5.7)
- Sval-owned tab restoration; lazy materialization
- Accessible panel (keyboard navigation, ARIA tree, focus indicators)
- Crash reports local unless the user sends one (§10.6)

**Out of v1:** cloud provider APIs · AI features · sharing · mobile · tiling
beyond a split · inline Hide My Email · a published format spec and CLI
decryptor · key rotation.

**Linux's cost is packaging.** Gecko ships a libsecret backend for
`nsIOSKeyStore` (`security/manager/ssl/LibSecret.cpp`), so Secret Service is
integration rather than invention. Linux ships as a tarball, a .deb and an
.rpm, updated through signed APT and DNF repositories (decision 0094), and
it is a third desktop in every acceptance walk.

---

## 13. Settled and open questions

Items keep their numbers, because other documents cite them.

1. **License.** Sval's own files, the engine included, are AGPL-3.0-only with
   the Sval App Store Permission, in one repository, with no CLA (decisions
   0111 and 0119). Mozilla's files keep MPL 2.0. `LICENSING.md` explains the layout.
2. **Linux is a v1 target** (§12).

   2a. **Linux packages:** a tarball, a .deb and an .rpm (decision 0094).
3. **Default search engine: asked at first run.** The picker preselects
   DuckDuckGo, because every first-run step shows its default and Continue
   keeps it (`2026-10-07-first-run-design.md`). **DuckDuckGo is the engine in
   use until it is answered**: a browser needs some engine before first run
   completes, or when it is skipped, and that one should not contradict the
   privacy pitch on the first thing a user does. **Kagi gets first-class
   support**: it is on the picker beside the free options, signs in through
   Kagi's own cookie in normal windows, and signs private windows in with
   Privacy Pass (decision 0091). Bangs and lenses are processed server-side by
   Kagi, so the address bar passes the query through. Mozilla's partner codes
   are stripped from every engine (§10.9).
   **The engines Sval ships**, in this order everywhere: DuckDuckGo,
   Startpage, Brave Search, Kagi, Google, Bing, Ecosia, Qwant, Perplexity, and
   Wikipedia in the user's language. Each engine's URLs come from its own
   OpenSearch description, with no partner tag. Amazon and eBay are left out:
   Mozilla's entries for them exist to route searches through an ad redirect
   and an affiliate code. Perplexity is an AI engine, listed because a user
   who picks it has made a choice, and no AI speaks first.
   Three site searches follow them: YouTube, GitHub and OpenStreetMap. Each
   searches one site, has no suggestion URL, so Sval contacts it only when
   the user searches it, and is left out of first run's picker. **Every
   engine has a short `@` keyword** (`@g`, `@b`, `@w`, `@yt`, `@gh`,
   `@maps`, and one for each other engine), its first alias, beside the
   long ones Firefox gives it. The `@` follows Firefox's convention for the
   aliases an engine ships with, so an ordinary search such as "b
   vitamins" never picks an engine. A keyword the user sets in Settings
   needs no `@`.
4. **Favorites, history and settings sync** through the same storage layer and
   merge model (§5.6).
6. **Import: five sources**, Firefox, Arc, Chrome, Edge and Safari. A
   browser's profile becomes a workspace, its own workspaces stay workspaces,
   tab groups become groups, bookmarks go to Favorites or a workspace as the
   user chooses, and history goes to Places. Passwords move by a guided
   hand-off to the user's manager, and cookies are not imported.
   `2026-10-08-import-design.md` is the design. Sval's target users arrive
   carrying something, and an empty panel on day one loses them.
7. **Crash recovery.** Writes are atomic, write-temp-then-rename (§6.3), and
   Sval takes over tab restoration (§10.4).
8. **Crash reporting** is local unless the user sends a report (§10.6).
9. **Accessibility** is built in from the start (§10.5).
10. **Firefox branding.** Sval strips all Firefox branding, as Mozilla's
    trademark policy requires; `docs/firefox-assets.md` decides Firefox's art.
11. **Scale and performance.** Inactive workspaces are data only and the
    active workspace materializes tabs lazily (§10.4). The panel's rows are
    not virtualized (§15).

**Considered and dropped:** *key rotation / device revocation* as features.
With no Sval server, anything an attacker has already copied is
unrecoverable, and revoking storage access happens in tools Sval does not
control. Setting up sync again (§6.6) mints a new sync key, re-encrypts
everything under it and removes the old key's files, which covers a leaked
key and a lost device.

---

## 14. Glossary

- **Tombstone** — a parallel record marking that an object was deleted: its UUID
  plus a deletion time, with no payload. **Rejected for Sval** (decision 0013).
  Closing deletes the node outright, and the version vector of §5.4 keeps a
  stale peer from re-inserting it. Do not reintroduce a tombstone map, a
  closed record, or a retention window in the tree.
- **CRDT** — a family of data structures that merge concurrent edits without a
  coordinating server. **Evaluated and rejected for Sval** (§5.3); per-object
  timestamps deliver the required semantics far more simply.
- **ESR** — Firefox Extended Support Release. Major versions roughly annually,
  security fixes backported, Mozilla UI/UX changes excluded.
- **Artifact build** — a Firefox build that downloads prebuilt Gecko binaries and
  compiles only the front-end. Seconds, not hours.
- **`omni.ja`** — the zip archive inside a Firefox install holding the chrome
  JavaScript, XHTML, and CSS.
- **DBSC** — Device Bound Session Credentials. Binds cookies to a device's TPM or
  Secure Enclave. Rolling out in Chrome 146 as of April 2026.
- **Handoff semantics** — workspaces converge across devices within a sync cycle.
  Not live mirroring, which file-sync latency makes impossible.

---

## 15. Designed and not built

This spec designs these, and no code provides them. Each names the section
that designs it.

- Syncing a tab's back and forward history (§5.1)
- A virtualized panel that draws only the rows on screen (§10.4, §13 item 11)
- Panel placement beyond left and right (§5.6)
- Developer ID signing and notarisation on macOS, and the platform grants
  that wait on them (§7.4, §8.6)
- A Widevine license of Sval's own (§8.6)
