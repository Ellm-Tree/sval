# Host contract for `sval-core`'s WASM boundary

This is what a host — the Firefox fork's chrome today, an iOS or Android
app later — must supply to load `sval-core` compiled for
`wasm32-unknown-unknown` and drive it correctly. It is binding: a host that
deviates from it produces silent data loss or a build that fails at
runtime, not merely a bug in one feature.

The Rust side of this contract is `src/wasm.rs`. Read this document and that
file's doc comments together; if they disagree, the code is either the bug
or has moved on and this document is stale — say which, don't guess.

## 1. Storage: the host does all I/O, the engine never calls back into JS

**This is the one design decision in this document worth understanding
before any other.** The engine never calls back into JS to read or write a
file. Against the host this module runs in, a callback interface cannot work,
for two independent reasons, both verified against the Firefox source tree:

- **A missing file cannot be told apart from a real error via a thrown JS
  exception.** `dom/webidl/DOMException.webidl` declares
  `interface DOMException` with no `: Error` inheritance, so a `DOMException`
  is not `instanceof Error` in Firefox, and `xpcom/ioutils/IOUtils.cpp`
  rejects a missing file with exactly that — a `DOMException` named
  `"NotFoundError"`, not an `Error` named `"NotFound"`. A callback protocol
  that tries to distinguish "no such file" from "a real failure" by
  inspecting a thrown value's shape cannot be made to work reliably against
  this host, and misclassifying "no such file" as "a real failure" is not a
  cosmetic bug: `sync` treats a missing own file as "first run on this
  device, nothing to merge" and otherwise refuses to write — a device whose
  first sync misclassifies its own missing file this way would publish
  nothing, silently, on every sync it ever runs.
- **Privileged Firefox chrome code has no synchronous I/O API this could
  call at all.** `dom/chrome-webidl/IOUtils.webidl` is Promise-based
  throughout; its only synchronous method,
  `openFileForSyncReading`, is worker-only and read-only — there is no
  synchronous write, list, or stat anywhere in it. Blocking the chrome main
  thread on I/O to a user-chosen folder (which may be a network-backed cloud
  sync client) is a regression Firefox has a dedicated test to catch
  (`browser/base/content/test/performance/browser_startup_mainthreadio.js`),
  and a worker does not rescue a callback-based design either: JS cannot
  block synchronously on a `Promise`, and XPCOM (the source of Firefox's
  *other* synchronous file I/O, `toolkit/modules/FileUtils.sys.mjs`) is
  unavailable inside a worker. Every WASM consumer already in the Firefox
  tree solves this the same way — the translations engine
  (`toolkit/components/translations/content/translations-engine.worker.js`),
  the ML backends (`toolkit/components/ml/`), and pdf.js all run in a worker
  and invert control: the host does the (asynchronous) I/O, and the engine
  only ever receives plain bytes.

So this boundary inverts control the same way. **The engine never calls
into JS.** Instead:

1. The host calls `syncPrefix(keyBytes, workspace)` to learn the one
   directory it must enumerate — exactly `sval-core`'s own
   `sval/ws/<hashed-workspace-id>` layout, without the trailing `/`, computed
   for the host rather than duplicated by it.
2. The host lists that directory and reads every file directly in it — not
   a sibling directory whose name starts the same, such as the
   `<hashed> (1)` a cloud client makes of a conflict — however it
   needs to — asynchronously, in a worker, via `IOUtils`, against whatever
   its own storage backend is. **It must include its own device's file if
   one exists.** Omitting it is not a smaller sync, it is the exact
   data-loss path `sync`'s own doc comment (`src/sync.rs`) describes at
   length: a device that skips reading its own file back before merging
   peers in can overwrite the cloud copy with a rolled-back state, silently
   discarding anything it wrote while offline that no peer ever saw.
3. The host calls `SvalDocument.sync(keyBytes, deviceId, workspace, paths,
   files, now)` once, with parallel arrays: `paths[i]` names `files[i]`'s bytes.
   Every path is exactly what `list()` returned in step 2 — full sealed
   ciphertext, not decoded, not filtered further. The engine opens only the
   device files among them (`<device>.json`) and passes over the rest: a
   `.DS_Store`, a conflict copy. A host that could not read a file reports
   it only when `isDeviceFile(keyBytes, workspace, path)` says it is one.
4. The call returns a `SyncOutcome`. If `writePath`/`writeBytes` are
   present, the host writes those bytes to that path, **atomically** (a
   reader must never observe a partial write — a temp-file-then-rename, or
   an equivalent atomic operation your storage backend already provides,
   such as a single `IndexedDB` transaction). If they are absent, nothing
   changed and there is nothing to write.

Only the argument marshaling at the edge touches a `JsValue`: it turns a JS
`Uint8Array[]` into a `Vec<Vec<u8>>` and back. The sync logic runs against
plain Rust types and is unit-tested the same way `store::MemoryStore` is,
with no JS engine involved.

**A host may run one document against more than one location.** Each `sync`
call is a snapshot of one location, and the write it returns belongs to that
location. Sval's desktop host runs a pass against the profile and then against
the shared folder (`2026-10-06-local-copy-shared-folder-design.md` §4.2). The
engine needs nothing for this: it decides what to write by comparing against the
own file in whichever snapshot it is handed, and it treats a stale own file as a
peer of itself.

## 2. Build requirement: `crypto.getRandomValues`

`sval-core` calls into host entropy in five places: `Key::generate` (a fresh
document key, native/test-only — nothing in this WASM surface calls it), the
per-write nonce in `crypto::seal`, which `SvalDocument::sync` calls on every
write, and `generatePairingCode`/`sealPairing` (§9), both of which draw
through `crypto::random_bytes` — a code's random bits and a fresh per-seal
salt, respectively, and `kagiTokenRequest` (§12), for each token's nonce and
blinding scalar. On every other target these reach the OS's random number
generator directly; on `wasm32-unknown-unknown` neither `getrandom` nor
`aes-gcm`'s dependency on it has an OS to call, so all of them resolve
instead to `getrandom`'s `wasm_js` backend, which calls the host's
`crypto.getRandomValues`.

**This is a runtime failure on the calls that need entropy, not a
build-time one, and pairing is reachable before `sync()`.** `getrandom`'s
`wasm_js` backend calls `crypto.getRandomValues` at the moment entropy is
needed, not at module instantiation, and both `crypto::seal` and
`pairing::generate_code`/`pairing::seal` use the fallible `try_generate()`
form rather than a panicking one, specifically so a host missing
`crypto.getRandomValues` gets an `Err` with code `no_entropy` back from that
one call rather than an aborted module. Concretely: a host missing `crypto.getRandomValues` will
instantiate the module successfully, and every call that does not draw
entropy (`loadJson`, `toJson`, `exportJson`, `openPairing`,
`pairingExpiresAt`, every `SvalDocument` mutator) will work; the *first* call
to `generatePairingCode`, `sealPairing`, or `sync()` — whichever the host
reaches first, and pairing is normally reached first since it exists to run
before two devices have synced anything — will return an error instead. In a
browser environment (Firefox chrome, a web worker) `globalThis.crypto.getRandomValues`
is present by default and this never triggers; an embedder without a
`crypto` global must polyfill one before calling any of these three.

## 3. Ids and timestamps are the host's to supply

No mutator on `SvalDocument` reads a clock or generates an id internally.
Every one of `addWorkspace`, `addAgentWorkspace`, `addGroup`, `addSplit`, `addTab`, `rename`, `setContent`, `setLocal`,
`setAppearance`, `setIsolation`, `touch`, `setSetting`, `moveNode`, `moveWorkspace`,
`removeKeepingChildren`, `markUsed`, `setAutoArchive`, `archiveIdle`, `archiveNow`, `restore` and `sync` takes an explicit id, device id and/or timestamp from the caller. (`remove`
takes only the node id: closing a tab deletes the node, and a deletion stores
nothing, so there is nothing to stamp or attribute — spec §5.4.)

```
SvalDocument.rename(
  id:        string,       // a node already in the document
  name:      string,
  device_id: Uint8Array,   // 16 bytes
  now:       number,       // milliseconds, validated like every other timestamp
) -> void
```

`rename` sets a node's name and stamps **only** the content group's `_at` and
`_by`. `placement` and `lifecycle` are left exactly as they were, which is what
lets a rename on one device and a move or a pin on another both survive (spec
§5.1). It is also the only correct way to set a name: calling `addWorkspace`/
`addGroup`/`addTab` with an id already in the document recomputes the order key
and silently reorders the node, and `remove` followed by an add turns an edit
into a deletion, which a peer's concurrent edit is allowed to beat (spec §5.4).

`addAgentWorkspace(name, label, id, deviceId, now, isolated?)` adds a workspace carrying the
immutable agent mark `{label, device}` (agent-control spec §3.5); `device` is
`deviceId`. It trims `label` and throws if the result is empty.

`addWorkspace` and `addAgentWorkspace` take an optional last argument
`isolated`. `true` creates the workspace isolated (isolated workspaces spec
§2) under the same `lifecycle_at` as the add; absent or `false`, it is shared.

`addTab(parent, name, url, id, before?, after?, deviceId, now, local?)` adds
a tab under `parent`. `before` and `after` are the siblings it goes between,
as in `moveNode`; with neither, it goes last. A tab opened mid-strip is filed
where it sits in the one add, so no peer reads it at the end of its parent
first.

**Every write that carries an address takes `local`**: `addTab`,
`setContent` with a url and `addFavorite` with a url, alone and in a batch,
where the operation's field is `local` (decision 1372). `true` marks an
address that stays on this device, which the host decides with
`syncableAddress` (`SvalSyncableAddress.sys.mjs`); the engine never reads an
address to decide it. It is stored as `content.local`, absent meaning
`false`, so it is replaced with the rest of the content group. `rename`
keeps it, and so does a `setContent` whose url is the one the node holds,
whatever `local` it sends: only a change of address changes the mark. A host
that copies an address out of a node passes that node's mark. `local` on a write with no url is refused with `invalid_argument`.
An Archive entry takes its tab's mark, and a restored tab its entry's.

`setLocal(id, local, deviceId, now)` sets or clears the mark with the address
kept, for a node the host holds on this device for another reason: a tab in
a call (decision 2237). A change stamps the content group, so a node coming
back is news to every peer. A mark already as asked writes nothing. `true` on
a node with no url is refused with `invalid_argument`.

`moveWorkspace(id, before?, after?, deviceId, now)` puts a workspace between
the workspaces `before` and `after`, as `moveNode` places a node among its
siblings. A workspace is a root, so it takes no parent, and anything but a
workspace at the top of the tree is refused with `not_a_root_workspace`.

`addSplit(parent, name, id, before?, after?, deviceId, now)` adds an empty
split under `parent`, placed between `before` and `after` as `addTab` places a
tab (split-view spec §5.2). Its panes are tabs moved in with `moveNode`, in
the same `applyBatch`: splitting X with Y is `addSplit` beside X, then
`moveNode` X and then Y into it. `name` is empty unless the user names the
split; in a batch it may be left out. The parent must be a workspace or a
group. A split holds tabs only, at most four, and its children in sibling
order are its panes from left to right. Moving a pane within its split, as
"Move Pane Left" does, is a `moveNode` into the same split. A host reads a
split as a node of kind `"split"` (§10).

`setIsolation(id, isolated, deviceId, now)` sets a workspace's
`lifecycle.isolated`, stamping only `lifecycle_at`/`lifecycle_by` and carrying
`pinned` over; `content`, `placement` and `appearance` stay byte-identical. It
throws `no_such_node` for an unknown id and `invalid_argument` for a node that
is not a workspace. The document holds only the flag: the cookie jar it
selects is each device's own (isolated workspaces spec §4). A host reads the
flag as `lifecycle.isolated` on the node, absent meaning `false`.

```
SvalDocument.setContent(
  id:        string,       // a node already in the document
  name:      string,
  url:       string|null,  // null clears it: a workspace or group has none
  icon:      string|null,
  device_id: Uint8Array,   // 16 bytes
  now:       number,       // milliseconds, validated like every other timestamp
  shares?:   number[]|null, // a split's pane widths; absent or null clears them
  local?:    boolean       // the address stays on this device (§3, addTab)
) -> void
```

`setContent` writes the **whole content group** — name, url, icon, a split's
shares and the `local` mark — under one
`content_at`/`content_by`, and like `rename` it leaves `placement` and
`lifecycle` byte-identical. It is what a host needs to follow a tab as the user
navigates it: a node whose url is frozen at the moment the tab opened describes
a page the tab has left.

**The group is the unit, so a content write is a read-modify-write, and that is
the host's obligation.** Merge replaces a fact group entire (spec §5.3) — there
is no field-level merging anywhere in `sval-core` — so `setContent` overwrites
every field of the group, including the ones the caller was not thinking about.
Send the name the document currently holds alongside the new url, or the write
clobbers a rename the user made here or on another device. The API names the
group rather than a field precisely so this is visible at the call site: a
`setUrl` would have implied a guarantee the engine does not offer.

`rename` remains the right call when only the name is changing — it reads the
node's current url, icon and shares and goes through `setContent`, so the two
cannot drift.

A tab's `content.name` is its page's title. The name a user gives a tab is
`appearance.label`, written with `setLabel(id, label, deviceId, now)`, where
`null` clears it. It stamps only the appearance group and keeps the colour,
emoji and transparency, and `setAppearance` keeps the label, so following a tab as it navigates
never clobbers its label (decision 2210).

`shares` is a split's pane widths: one percentage per pane, in pane order,
each above 0, summing to 100 (within 0.1, for rounding). It is stored as
`content.shares`, and absent means equal widths. A host writes the whole list
when the user lets go of a divider. It is refused with `invalid_argument` on a
node that is not a split and when its length is not the split's number of
tab panes. An act that changes a split's panes leaves its shares as they
were, so a host that reads a list whose length is not the pane count draws
equal widths, and writes a new list, or none, in the same batch as the act.

`touch(id, deviceId, now)` stamps `touched_at`/`touched_by` on a node and
nothing else (decision 0106): work was done inside it. It holds no value, so
every fact group stays byte-identical and no edit made elsewhere is lost to it.
A peer that deleted the node without seeing the stamp loses its delete (spec
§5.4). It throws `no_such_node` for an unknown id.

```
SvalDocument.setAppearance(
  id:           string,              // a node already in the document
  color:        string|object|null,  // a token, a custom colour, or null to clear it
  emoji:        string|null,         // null clears it
  transparency: number|null,         // 0..1, a workspace's only; null is solid
  device_id:    Uint8Array,          // 16 bytes
  now:          number,              // milliseconds, validated like every other timestamp
) -> void
```

In a batch the operation is `{ kind: "setAppearance", id, color, emoji,
transparency }`, with the same values.

`setAppearance` writes the **whole appearance group** (colour, emoji and
transparency) under one `appearance_at`/`appearance_by`, leaving `content`,
`placement` and `lifecycle` byte-identical, exactly as `setContent` leaves
`placement` and `lifecycle` untouched. `null` for any field clears it. The
group is the unit, so a field the caller leaves out is cleared too: the same
read-modify-write obligation `setContent` places on a host.

**`color` is validated here, at this boundary, and not in the engine**
(decision 0057). It is one of:

- a token, on any node: `red`, `orange`, `yellow`, `green`, `cyan`, `blue`,
  `purple`, `pink`, `gray` or `black`, Sval's presets
  (`SvalPanelModel.COLOR_TOKENS`).
- on a workspace, a custom colour `{h, c, l, mode}`: OKLCH hue `0 <= h <
  360`, chroma `0 <= c <= 0.4`, lightness `0 <= l <= 1`, and `mode`, `"dark"`
  or `"light"`, the appearance it was picked in.
- on a group, a custom colour `{h, c}`, in the same ranges. The window sets a
  group's lightness.

A custom colour has exactly those keys. Its numbers are stored as decimals
(`200` is stored as `200.0`). `transparency` is a number from 0 to 1, taken
only on a workspace. Anything else, a `NaN` included, is refused with
`bad_color`. `null` (clearing the colour) is always accepted. This validation
is why an invalid colour never reaches the synced document: it would be a
rendering bug on every device that later reads it, so this is the one place
that refuses it.

`emoji` is passed through unvalidated and unmodified. An emoji is a grapheme
cluster, not a single character — a flag is two regional-indicator code
points, a family or skin-toned figure is several scalar values joined by
zero-width joiners — and this boundary never slices, truncates or otherwise
inspects it; whatever string the host sends round-trips byte-for-byte.

This is a consequence of the same fact as §2, not an unrelated API choice:
`wasm32-unknown-unknown` has no ambient wall clock (`std::time::SystemTime`
panics there) and no ambient UUID source of its own. A boundary that minted
either internally would have to reach for the same host-provided primitives
this document already asks for, just hidden one layer down where a host
could not audit or pin them. Making the host supply both explicitly is also
what makes `sval-core`'s own tests deterministic (a fixed id, a fixed
timestamp) without needing to fake a clock.

Concretely:

- **Ids** are node ids (`NodeId`, a UUID) passed as strings, e.g. from
  `crypto.randomUUID()`. Any string that fails `Uuid::parse_str` is rejected
  with an `Err`, not a panic. A node id that does not name a node already in
  the document (an unknown `parent` to `addTab`/`addGroup`, an unknown `id`
  to `remove`/`rename`/`setContent`/`moveNode`, an unknown `newParent` to
  `moveNode`) is
  also rejected with an `Err` — see §5.
- **The device id** is the same 16 bytes passed to `sync`, and the same value
  the host uses for its own file name. Every mutator that stamps a fact group
  takes it, because a group records *who* last wrote it as well as when, and
  that attribution is what lets another device tell "I have already seen this
  fact" from "I have never heard of it" (spec §5.4). It must be **stable for
  the lifetime of the device**: generate it once, persist it, pass the same
  bytes every time. A device that changes its id abandons every watermark its
  peers hold for the old one, which is not a data-loss risk — unattributed and
  unknown writers both count as news, so nothing is deleted — but it does mean
  that device's earlier writes can never again be recognised as already seen,
  so deletions of those nodes stop propagating. Any length other than 16 bytes
  is rejected with an `Err`.
- **Timestamps** are milliseconds since the Unix epoch, passed as a JS
  `number` (an `f64` on the Rust side, validated then cast to `u64`).
  **Accepted range is `0` to `Number.MAX_SAFE_INTEGER` (`2^53 - 1`), and the
  value must be finite.** `Date.now()` is always in this range. A
  non-finite value (`NaN` — which is what `undefined` coerces to at the
  call site — or `Infinity`) or a negative value is rejected with an `Err`
  rather than silently coerced: `NaN as u64` and a negative value both
  saturate to `0` under Rust's `as` cast with no error, which would stamp
  the edit at the earliest possible time and lose every future
  last-writer-wins comparison it should have won — indistinguishable from
  the edit never having happened. `Infinity` saturates to `u64::MAX`
  instead, permanently pinning the node so no later edit, on any device,
  can ever win against it. Spec §5.3 also asks hosts to coarsen this
  reading for Spectre mitigation where the platform requires it (e.g.
  reduced-precision timers in some embedding contexts) — that coarsening,
  if any, happens on the host side before the value ever reaches this
  boundary.
- **Timestamps are accepted as-is.** `sval-core` does not correct a clock
  reading. The host does: every `now` it passes is corrected time, the wall
  clock minus the difference a time server measured, from one clock that
  only moves forward (decision 1714, spec §5.3). In the browser that clock is
  `SvalClock.sys.mjs`.

### A batch: many changes as one

`applyBatch(opsJson, deviceId, now)` applies several changes as one act, such
as making a group of two tabs: all of them, or none. `opsJson` is a JSON array
of operations, each an object named by `kind` and spelled as the mutator above
takes it, in camelCase, without the device id or the time: every operation in
the batch is stamped with the batch's `deviceId` and `now`.

```
[
  { "kind": "addGroup", "parent": "<workspace>", "name": "G", "id": "<new id>" },
  { "kind": "moveNode", "id": "<tab>", "newParent": "<new id>", "before": null, "after": null }
]
```

The kinds are `addWorkspace`, `addAgentWorkspace`, `setIsolation`, `addGroup`,
`addSplit`, `addTab`, `moveNode`, `rename`, `setContent`, `setAppearance`, `setLabel`, `touch`,
`setSetting`, `addFavorite` (its kind as `favoriteKind`), `setPinScope`,
`movePinsToRoot`,
`removeKeepingChildren`, `addVisit`, `setVisitTitle`, `touchShard`,
`setAutoArchive`, `markUsed` and `remove`. An add
names its own id, so a later operation can name the node an earlier one added.
A batch never holds a batch.

The operations apply in order. If any is refused, the document is left exactly
as it was, every stamp and watermark included, and the call throws that
operation's own error (§8): a host keeps no copy to put back. A malformed batch
throws `invalid_argument` before anything is applied.

## 4. The document key

`Key` is 32 raw bytes (`Key::to_bytes`/`Key::from_bytes`), passed as a
`Uint8Array` (a `&[u8]` on the Rust side) to `syncPrefix` and
`SvalDocument::sync`. Where those 32 bytes come from — a passphrase-derived
key, a platform keychain, a key exchanged between the user's own devices —
is entirely the host's concern; `sval-core` only ever sees the raw key
material for the duration of one call and never persists it itself. A
wrong-length key is rejected with an `Err` (`Error::InvalidKeyLength`),
never a panic.

## 5. The device id

`deviceId` is exactly 16 raw bytes, passed as a `Uint8Array` to
`SvalDocument::sync` **and to every mutator that stamps a fact group** —
`addWorkspace`, `addAgentWorkspace`, `addGroup`, `addTab`, `rename`, `setContent`, `setAppearance`, `setLabel`, `setIsolation`, `touch`, `setSetting`, `moveNode`, `setAutoArchive`, `markUsed`, `archiveIdle`, `archiveNow`, `restore` — because each group
records which device last wrote it (§3, spec §5.4). It is this device's identity
within `sval-core`'s one-file-per-device storage layout (`sval/ws/<hashed>/<device-id-hex>.json`)
— **the host generates it once, on first run, and persists it locally for
the lifetime of that installation.** Two devices must never share one: the
entire point of the one-file-per-device layout (spec §6.2) is that two
devices never write the same path, which is what keeps a cloud sync
client's same-file-race resolution (keeping both writes as a "conflicted
copy") structurally unable to happen for workspace data. A device id is not
secret and does not need to be unguessable, only unique to this
installation — 16 bytes from the same `crypto.getRandomValues` used
elsewhere is sufficient. A wrong-length device id is rejected with an `Err`
(never a panic): 15 or 17 bytes cannot be a `deviceId`, only exactly 16.

**The id lives exactly as long as the device's own document.** A host whose
own document starts empty again (the user left the folder, the app's data
was deleted, the app was installed again) takes a new id, even where the old
one could still be read, as from an iOS Keychain that survives deleting the
app. An empty document written under the old id vouches for every fact that
id wrote: each node it made is then not news to the device, so it reads as
deleted here, and the next file the device writes deletes it on every peer.

Pass the **same** bytes to the mutators and to `sync`. They are not two
identities: a group attributed to one id while the file is written under another
means no peer can match the two up, so those groups are read as news forever and
deletions of them stop propagating.

## 6. Calling `sync`

```
syncPrefix(key_bytes: Uint8Array, workspace: string) -> string
```

Returns the directory (relative to the host's storage root; see spec §6.1
for what "root" means) the host must enumerate before calling `sync`,
without a trailing `/`.

```
isDeviceFile(key_bytes: Uint8Array, workspace: string, path: string) -> boolean
```

Whether `path` is a device's file directly in that directory, the only kind
of file `sync` opens. A device file that will not open is a peer this key
cannot read, and is reported; anything else is a cloud client's or the
operating system's, and is not.

```
devicePath(key_bytes: Uint8Array, workspace: string, device_id: Uint8Array) -> string
```

Returns this device's own file within that directory. A host that must tell
"my own file is missing" (first run) from "my own file is there but cannot be
read" (stop, and write nothing) uses this rather than rebuilding the name.

```
SvalDocument.sync(
  key_bytes:    Uint8Array,   // 32 bytes
  device_id:    Uint8Array,   // 16 bytes
  workspace:    string,
  paths:        string[],     // paths[i] names files[i]
  files:        Uint8Array[],
  now:          number,       // milliseconds, validated like every other timestamp (§3)
  archiveRetention?: number, // milliseconds; the Archive's document only (§10)
  shared?:      boolean,      // true for the shared folder's files
  clampFrom?:   number,       // when the first time reading arrived; one pass per document
) -> SyncOutcome
```

`paths` and `files` must be the same length, or the call is rejected with an
`Err` before anything is touched. Every entry is one sealed (encrypted) file
exactly as `list()` returned it in step 2 of §1 — this method does the
decrypting, merging, repairing and re-encrypting; the host does not decode
anything itself.

`now` is this write's timestamp, the host's corrected time (§3), in the same
milliseconds as every other timestamp this crate takes. It is stamped into the file this
call may produce as `writtenAt`, together with `writtenBy` (the device id)
and `seen[device]`, which together are the version vector spec §5.4 uses to
tell a deleted node from one a peer has never seen. It is stamped **only
when there is something to write**: a sync that changes nothing rewrites
nothing, which is what keeps an idle device from generating cloud writes
(spec §6.5).

`now` is validated exactly as every other timestamp is (§3): non-finite and
out-of-range values are rejected rather than trusted. A silently-wrong value
is destructive in a way that is easy to miss — a value near
`Number.MAX_SAFE_INTEGER` tells every peer this device has already
incorporated everything they will ever write, which suppresses every node
they have and this one does not, while a silent `0` leaves this device
unable to convince any peer of a deletion.

**The tree has no purge parameter and no retention window.** Closing a tab
deletes the node outright (spec §5.4); recovering a tab the user closed is
Firefox's own recently-closed list, which is local and already exists. The one
retention window is the Archive's, a document of its own (§10, decision
0136): `archiveRetention` is passed for that document and no other. `remove(id)` is
the call. It deletes the node and everything beneath it, so deleting a group
or a workspace with its contents is the same one call.
`removeKeepingChildren(id, deviceId, now)` deletes a container and keeps its
contents: its children move to its parent, in their order, at the place it
held, stamped as moves, and then it is removed. A node with no parent (a
workspace) is refused with `no_parent`, and the document is left unchanged.

**A pass is over this device's profile copy or over the shared folder**
(`shared`), and the two treat local nodes (§3, `addTab`) apart. A profile
pass reads and writes every node. A shared pass sets this document's local
nodes aside, merges every file without them, and puts them back before
expiry and repair, so a file that lacks one never deletes it and one holding
the same id never replaces it. The file it writes holds no local node, and
it compares that file against the one stored to decide whether to write, so
an edit to a local node alone writes nothing there. Either pass drops the
`local` mark from every node it reads from a file other than this device's
own profile copy, so such a node merges as a synced one.

`SyncOutcome` has three JS-visible getters:

- `reportJson: string` — the sync report as JSON; see §7 for its shape.
- `writePath: string | undefined` — present only when there is something to
  persist.
- `writeBytes: Uint8Array | undefined` — the exact bytes to write at
  `writePath`, atomically (§1, step 4).

Both `writePath` and `writeBytes` are `undefined` together, or present
together; there is no case where only one is set.

## 7. The sync report

`reportJson` parses to an object with exactly these fields — the names are
pinned by a test (`wasm::tests::sync_report_field_names_are_the_contracts_promise`)
specifically so a rename here is caught rather than silently breaking every
host reading the old name:

| field | type | meaning |
|---|---|---|
| `merged` | `number` | how many files (including this device's own, if present) decrypted, parsed, and were merged in |
| `errors` | `FileProblem[]` | one entry per file that failed to decrypt or parse — something is actually wrong with that specific file |
| `schemaTooNew` | `FileProblem[]` | one entry per file whose schema, or sealed-format version, is newer than this build supports (spec: refused rather than guessed at) — distinct from `errors` so a host can word "this peer is ahead of you, update your app" differently from "this file is corrupt" |
| `refusedWrite` | `boolean` | this device's own file exists but could not be read, so the pass left it alone and wrote nothing; the device publishes nothing until it is readable |
| `repairedIds` | `string[]` | node ids `tree::repair_unreachable_ancestry` reparented during this sync, so a host can tell a user why something moved rather than have it happen silently |
| `changedIds` | `string[]` | node ids of any kind this pass added or changed: present after it, and absent or different before it. The pass starts from the document holding the host's own mutations, so these are what the merge and repair brought, for a host to write into its own store (store-mirror spec §3) |
| `removedIds` | `string[]` | node ids the document held before this pass and no longer does, because another device deleted them |
| `ownWatermark` | `number` | this device's own watermark once the pass is done (`seen[device]`, `0` for none): a host keeps its next stamps above it, unless it is more than a minute past its corrected time (decision 1714) |
| `harmedByClock` | `string[]` | hex ids of the devices whose file was written more than ten minutes after `now` and whose merge replaced a value this device held with a fact stamped after `now`, or brought back a node this device's own file holds and its document had closed, so a host can warn that the device's clock is set ahead. Everything in such a file is merged (decision 1714) |

A `FileProblem` is `{ path, own, reason }`: the file's engine-relative path,
whether it is this device's own file, and a reason worded for a person. Branch
on `own` and the list an entry is in, never on `reason`'s text.

A file is accounted for in exactly one of `merged`, `errors`, or
`schemaTooNew` — never more than one, never zero. A single bad file never
aborts the whole call; every other file in `paths`/`files` is still
processed.

## 8. Errors, uniformly

Every exported function and method either succeeds or throws a JS `Error`
whose `message` is for people and whose `code` property says what failed —
**never a panic, for any input the host controls.** Branch on `code`; the
message may be reworded. The codes:

| `code` | meaning |
|---|---|
| `invalid_argument` | an argument no call could accept: a bad id or device-id length, an out-of-range timestamp, mismatched `paths`/`files` |
| `no_such_node` | the node named is not in the document |
| `no_such_parent` | the parent named is not in the document |
| `not_a_pin` | `setPinScope` on a node that is not under the pins root |
| `not_a_visit` | `setVisitTitle` on a node that is not a visit |
| `id_in_use` | an `add*` call with an id a node already has |
| `parent_is_a_tab` | a move or an add under a tab, which is a leaf |
| `would_cycle` | a move under the node itself or one of its descendants |
| `no_parent` | `removeKeepingChildren` on a node with no parent to move its contents to |
| `only_tabs_in_a_split` | a move or an add of anything but a tab into a split |
| `split_is_full` | a move or an add of a fifth tab into a split |
| `split_outside_a_place` | a split moved or added anywhere but a workspace or a group |
| `invalid_key_length` | a key that is not 32 bytes |
| `json` | JSON that does not parse as the expected shape |
| `schema_too_new` | a document or sealed file from a newer build |
| `bad_pairing_code` | a well-formed pairing file this code does not open |
| `malformed_pairing_file` | bytes that are not a pairing file |
| `encryption_failed`, `decryption_failed` | the cipher failed, or the key or data is wrong |
| `not_utf8` | a file that opened under the key holds bytes that are not UTF-8 text |
| `invalid_challenge`, `invalid_state`, `invalid_response` | a Kagi Privacy Pass challenge, client state or issuer answer this client cannot use (§12) |
| `no_entropy` | a call that draws entropy (`sync`, `generatePairingCode`, `sealPairing`, `kagiTokenRequest`) found no working `crypto.getRandomValues` (§2) |
| `io`, `not_found`, `poisoned` | storage failures; the wasm build does no I/O of its own, so it does not produce these |
| `internal_error` | a bug in the engine that did not panic |

An `invalid_argument` error also carries a `reason` property, which names the
check that refused the argument. Branch on it, as on `code`, rather than on
the message. Every other code carries no `reason`. The reasons:

| `reason` | refused |
|---|---|
| `timestamp_not_finite`, `timestamp_out_of_range` | a timestamp that is not a finite number, or one outside `0..=Number.MAX_SAFE_INTEGER` (§3) |
| `bad_node_id`, `bad_device_id` | an id that is not a UUID, or a device id that is not 16 bytes |
| `empty_agent_label` | an agent label that is empty once trimmed |
| `bad_color` | a colour that is neither a token nor a custom colour the node takes, or a transparency out of range or off a workspace |
| `not_a_workspace` | a call only a workspace takes, on another node |
| `bad_shard_name` | a history shard name not of the form `history-YYYY-Www` |
| `empty_setting_key`, `setting_not_json` | a setting with no key, or a value that is not JSON |
| `bad_favorite_kind`, `bad_favorite_guid` | a Favorites node kind other than favorite, folder or separator, or a guid that is not twelve URL-safe characters |
| `bad_sweep`, `bad_archived_tabs`, `bad_batch` | JSON that is not an idle-tab sweep, a list of archived tabs, or a batch of operations |
| `visit_without_url` | a visit with an empty URL |
| `shares_not_on_a_split`, `shares_count_mismatch`, `share_not_positive`, `shares_not_hundred` | split shares on a node that is not a split, one share per pane missing or extra, a share that is not a positive number, or shares that do not sum to 100 |
| `local_without_url` | a `local` mark on a write with no address |
| `ttl_not_finite`, `expiry_out_of_range` | a pairing seal's `ttlMs` that is not finite, or one whose expiry passes `Number.MAX_SAFE_INTEGER` |
| `paths_files_mismatch`, `file_not_bytes` | `sync`'s `paths` and `files` of different lengths, or a file that is not a `Uint8Array` |
| `bad_auto_archive_choice`, `not_a_tab`, `not_archivable`, `agent_workspace`, `not_an_entry`, `wrong_id_count` | an idle-tab archive call the Archive refuses (§10) |
| `no_tokens_requested` | a Kagi Privacy Pass token request for zero tokens (§12) |

This holds for a
malformed key or device id length, an invalid UUID string, a `paths`/`files`
length mismatch, an out-of-range timestamp (§3), and a node id that does not
name a node the document actually contains: `remove`, `rename`, `setContent`,
`setAppearance` and `moveNode` on an unknown id, and `addTab`/`addGroup` under an unknown
parent, all return an `Err` rather than silently doing nothing or creating
an orphaned node that reappears somewhere unexpected once repair runs. A
host should treat any rejection from a `SvalDocument` method as recoverable —
log it, surface it to the user, retry — never as a signal that the module
is unusable.

### What an actual panic means, and why it's still worth avoiding

None of the above is what happens if this module panics anyway (a bug in
`sval-core` itself, not a host mistake). `wasm32` code traps rather than
unwinds on a panic, and Firefox surfaces that trap to its JS caller as a
catchable `RuntimeError` — **it does not take down the browser process**,
and chrome outside this module is unaffected. What is lost is this module
*instance*: its linear memory is left in whatever state the panic occurred
in, so no further call into it is well-defined, and the in-memory
`SvalDocument` the host was holding is gone — recoverable only by
instantiating a fresh module and calling `loadJson` again from the last
persisted state. Call the exported `init()` function once, before any other
call, to install a panic hook that prints the panic's file, line and
message to the host's console — without it, a panic surfaces only as
`RuntimeError: unreachable executed` with no further information. `init()`
does not make a panic recoverable; it only makes one diagnosable.

## 9. Pairing: sealing a document key under a short code

Four free functions (not `SvalDocument` methods — pairing seals a key, not a
document) let a second device pick up a document key by typing a
twelve-character code read off the first, per spec §6.7:

```
generatePairingCode() -> string
sealPairing(key_bytes: Uint8Array, code: string, now: number, ttl_ms: number) -> Uint8Array
openPairing(bytes: Uint8Array, code: string) -> Uint8Array
pairingExpiresAt(bytes: Uint8Array) -> number
```

- **`generatePairingCode()`** returns a fresh code already grouped for
  display: three groups of four characters separated by dashes (14
  characters total, e.g. `"K7Q4-8MTZ-3RJW"`). Draws entropy through
  `crypto::random_bytes` (§2) — reachable, and likely to be the *first* call a
  host makes that needs `crypto.getRandomValues`, since pairing is normally
  how a second device gets a key before either has anything to sync.
- **`sealPairing`** encrypts `key_bytes` (32 bytes) so only `code` opens it,
  until `now + ttl_ms`. `code` is used exactly as given — a host must
  normalize user-entered text (case, dashes, whitespace) itself before
  calling this; `generatePairingCode`'s own output needs no further
  normalization. `now` is validated exactly as every other timestamp is
  (§3). `ttl_ms` must also be finite and must keep `now + ttl_ms` within
  `0..=Number.MAX_SAFE_INTEGER` — an out-of-range `ttl_ms` is rejected
  rather than silently saturated, since a saturated expiry would produce a
  file `pairingExpiresAt` could read back only as a value `parse_timestamp`
  itself refuses. Also draws entropy, for a fresh salt and nonce.
- **`openPairing`** recovers the 32-byte document key from a file `sealPairing`
  produced, given the code it was sealed under. Rejects with code
  `bad_pairing_code` for a wrong (but well-formed) code, and
  `malformed_pairing_file` for a file that is not well-formed at all (§8).
  Draws no entropy and works even without `crypto.getRandomValues`.
- **`pairingExpiresAt`** reads a file's expiry without needing the code, so a
  host can tell a code is stale before ever asking the user to type it.
  The value is unauthenticated until the file opens, so a host treats an
  expiry more than 24 hours after now as stale too (spec §6.7).
  Draws no entropy.

Argon2id at 64 MiB / t=2 / p=1 is the whole security argument for a
twelve-character code (`src/pairing.rs`'s module doc); measured under a
release `wasm32-unknown-unknown` build, one `openPairing` call costs roughly
55–65 ms on ordinary hardware, whether the code is right or wrong — well
under any budget a UI needs to worry about.

## 10. The narrow JSON surface

`SvalDocument` exposes `toJson`/`loadJson`/`exportJson` and the `sync` report
described in §7, rather than exposing `Document`'s Rust type graph through
`wasm_bindgen` attributes. This is deliberate: maintaining a second type
system in bindgen attributes that mirrors `src/types.rs` is one more thing
to keep in sync with the first, for no benefit to a consumer that is
JavaScript either way. A host parses the JSON it needs and otherwise treats
`SvalDocument` as opaque.

A node's `kind` is `"workspace"`, `"group"`, `"tab"`, `"split"`, `"setting"`,
`"favorite"`, `"folder"`, `"separator"`, `"visit"`, `"shard"`, `"archived"`, or a name
this build does not know, written by a newer one (spec §5.5). A setting lives
only in the `settings` document and is never drawn. A host shows no row for an
unknown kind or for anything beneath it, never treats one as a tab, and leaves
it in place. The engine carries it through merge and repair untouched.

A split's tab children are its panes, left to right. A merge can leave a
split holding one tab, or more than four. A host draws one tab as an ordinary
tab, and more than four in chunks of four in order, a single tab left over
drawn as an ordinary tab (split-view spec §5.1). The engine leaves both
shapes as they are: the next act on the split writes them back to shape.

### Settings

`setSetting(key, valueJson, deviceId, now)` sets one setting in a document the
host syncs under the name `settings` (settings-sync spec). `valueJson` is JSON
text; `null` or an absent argument resets the setting to its default, which
syncs as a change. An empty key throws. `settings()` returns
`{ key: value | null }` for every setting the document holds; a key absent from
it was never set. The host chooses the keys; the engine derives each node's id
from its key, so every platform agrees on it.
`settingId(key)` answers that id, so a host can match a node a pass reports
in `changedIds` or `removedIds` to the setting it holds.

### Favorites

A host keeps Favorites in a document named `favorites`, the only copy it
holds (favorites-native spec §3.1). Places holds none.

- `favoriteId(guid)` is the node id of the favorite whose guid is `guid`: a
  UUIDv5, so every device derives the same id. The host mints a guid once,
  when the favorite is made, as twelve characters of `A–Z a–z 0–9 - _`;
  anything else throws.
- `addFavorite(kind, guid, parent?, before?, after?, name, url?, deviceId,
  now, local?)` adds a `favorite`, `folder` or `separator` at `favoriteId(guid)` and
  returns that id. A root (`toolbar_____`, `menu________`, `unfiled_____`
  and the pins root `pins________`) is a folder with no `parent`, written
  the first time a profile has none. `before` and `after` are the siblings it goes between,
  as in `moveNode`; with neither, it goes last. Adding a deleted favorite's
  guid again at a later `now`, as Undo does, is news to every peer.
- `setContent` renames a favorite or changes its URL; the guid is kept.
  `moveNode` moves it.
- `setPinScope(id, scope?, deviceId, now)` limits a pin, a node under the
  pins root, to the workspaces whose node ids `scope` lists, or shows it in
  every workspace for null or an empty list (pins spec §7). It stamps only
  the lifecycle group, and throws `not_a_pin` for any other node.
- `movePinsToRoot`, in a batch, moves every node marked `pinned` into the
  pins root in `homeOrder` order and clears both marks (pins-root spec §8).
  A node marked inside a marked folder stays there, and the row gets a copy
  at a guid every device derives alike.
- `remove(id)` deletes a node and everything beneath it: a folder's delete.
- `favorites()` returns every favorite, folder and separator as
  `[{ id, kind, guid, parent, order, name, url, pinned,
  pinScope, contentAt, placementAt, added, local }]`, `pinScope` a sorted list of
  workspace ids or null, ordered by parent and then by `order` among
  siblings. The two times say when the name and URL, and the place in the
  tree, were last written.

Two devices' Favorites meeting for the first time keep both devices'
favorites and folders, same-named or not. Repair files a stranded favorite
under Favorites, never under a workspace.

### History

A host syncs history in one document per ISO week, named `history-YYYY-Www`,
and a document named `history-index` that lists them (history-sync spec).

- `visitId(deviceId, url, visitedAt)` is the node id of the visit a device
  made to a page at a moment: a UUIDv5, so every device derives the same id.
- `addVisit(url, title, transition, visitedAt, workspace, deviceId, now)`
  adds the visit this device made, in workspace `workspace` or in none when
  it is null (decision 1287), and returns its id. A visit already in the
  document is left as it is. An empty URL throws.
- `setVisitTitle(id, title, deviceId, now)` changes a visit's title. It
  writes nothing when the title is the same, and throws `not_a_visit` for a
  node that is not a visit.
- `visits()` returns every visit in the document as `[{ id, url, title,
  visitedAt, transition, device, workspace }]`, oldest first. `device` is the
  hex id of the device that made it, and `workspace` the id of the workspace
  it was made in, or null.
- `remove(id)` deletes a visit, on every device once it syncs.
- `touchShard(name, deviceId, now)`, on the `history-index` document, records
  that this device wrote to week `name`. A name that is not
  `history-YYYY-Www` throws. `shards()` returns `[{ name, changedAt }]`,
  newest week first. `changedAt` is when any device last wrote to that week.

Visits and shards have no parent and are never repaired.

### The Archive

A host syncs the Archive in a document named `archive` (idle-tab archive
spec, decision 0136). Its entries are nodes of kind `"archived"`, with no
parent, never repaired, and never tabs. The sweep and a restore are called on
the tree's `SvalDocument` and take the Archive's `SvalDocument` as an argument,
which must be a different object.

- `markUsed(id, deviceId, now)` records that tab `id` was selected. It
  touches the tab, and for a pane its split and every pane, when the tab's
  touch is an hour old or more, and answers whether it did. A tab only.
- `setAutoArchive(id, choice, deviceId, now)` sets a workspace's own choice,
  one of `"12h"`, `"24h"`, `"7d"`, `"30d"` and `"never"`, or clears it with
  `null`. It stamps only the lifecycle group. A host reads it as
  `lifecycle.auto_archive`, absent meaning the global choice. A node that is
  not a workspace, an agent's workspace and an unknown choice throw
  `invalid_argument`.
- `archiveIdle(archive, sweepJson, deviceId, now)` is the sweep.
  `sweepJson` is `{ default, lastActive: { tabId: ms }, exempt: [id] }`:
  the global choice, this device's `lastActive` (decision 0024), and the tabs
  the host's live checks exempt. It answers `{ tabs, entries }`: the tabs it
  removed from the tree, and the entries it added. Both documents change, or
  neither. **The host persists the Archive before the tree** (spec §6.3).
- `archiveNow(archive, id, deviceId, now)` archives tab `id` at once,
  whatever its workspace's choice and whether it is in use (launcher spec
  §4). A pane takes its split with it. It answers and persists as
  `archiveIdle` does. A tab in a group, a split holding anything but tabs
  and anything that is not a tab throw `invalid_argument`, an agent's tab
  too, and a missing node `no_such_node`.
- `importArchived(entriesJson, deviceId, now)`, on the Archive, adds an
  entry for each tab another browser archived (idle-tab archive spec §7.6).
  `entriesJson` is `[{ tab, title, url, workspace, workspaceName, closedAt
  }]`: `tab` is an id the host mints, which no tree holds, and `closedAt` is
  when the other browser archived it, counted as now when it is later. It
  answers the entries' ids. A tab whose entry the Archive holds, or that the
  list names twice, throws `id_in_use`, and an unknown field
  `invalid_argument`; either adds nothing. The host persists the Archive
  before it holds the result, as for `archiveIdle`.
- `archived(now)`, on the Archive, returns `[{ id, url, title, icon,
  workspace, workspaceName, closedAt, device, restored, split, pane,
  restoreIds, local }]`, newest first. `closedAt` is no later than `now` (decision
  0135). `split` and `pane` are a pane's split id and place, null for a tab.
- `restore(archive, entry, current, ids, deviceId, now)` restores `entry`
  as a new tab, or with the rest of its split as a new split, in its
  workspace or, with that gone, in `current`. `ids` are the new nodes' ids:
  the split's first when there is one, then the tabs in pane order, as many
  as the entry's `restoreIds`. It answers `{ tabs, split, workspace }` and
  marks each entry restored. Both documents change, or neither. A wrong
  number of ids or an id the tree holds throws `invalid_argument` or
  `id_in_use`, an unknown entry `invalid_argument`, and a missing `current`
  `no_such_parent`.
- `sync(..., now, archiveRetention)` on the Archive drops every entry
  closed at least `archiveRetention` milliseconds before `now`, after the
  merge and before the write decision, so an entry this device has expired
  is never published or listed again. Expired ids are in `removedIds`.

## 11. Which engine this is: `engineVersion()`

`engineVersion()` returns which engine code the module was built from, so a
host can say which engine code produced a sync it is reporting on. It needs no
prior call, not even `init()`, and cannot throw.

The value is one of:

- the 40-character git tree id of `engine/`, for a build of a commit;
- that id with `-dirty` appended, for a build with uncommitted changes in
  `engine/`;
- `unknown`, for a build that did not say, such as a plain `cargo build`.

It is fixed at compile time from the `SVAL_ENGINE_TREE` environment variable
(`src/lib.rs`, `ENGINE_VERSION`), which Sval's `scripts/build-core-wasm.sh`
sets. A tree id is the same in every commit whose engine is the same, and
`git log -t --find-object=<id> -- engine` lists the commits that carry it. It
names code, not anything a person browsed, so a host may log it.

## 12. Kagi Privacy Pass: `kagiTokenRequest` and `kagiTokenFinalize`

The client half of Kagi's Privacy Pass issuance (Kagi Privacy Pass spec). The
host makes the two requests to Kagi; the engine does the cryptography, and
keeps nothing between calls.

1. The host GETs `https://kagi.com/pp/wwwa` with
   `X-Kagi-PrivacyPass-Client: true`, and passes the response's
   `WWW-Authenticate` value to `kagiTokenRequest(wwwAuthenticate, count)`. It
   returns an object with `body` and `state`, both strings, or throws
   `invalid_challenge` unless the value holds exactly one batched ristretto255
   challenge (token type `0xF91A`) with a valid key.
2. The host POSTs `body` to `https://kagi.com/pp/gettokens`, and passes the
   response text with `state` to `kagiTokenFinalize(state, response)`. It
   returns the tokens as an array of strings, each the value that goes in
   `Authorization: PrivateToken token="…"`. An answer for fewer tokens than
   were asked yields that many. It throws `invalid_state` for a state
   `kagiTokenRequest` did not produce, and `invalid_response` for an answer
   that does not decode or verify.

`state` holds the blinding scalars, which link the tokens to the issuance
request, so the host keeps it in memory for the one round trip and never
stores or logs it. A token is a credential, and is never logged either.
