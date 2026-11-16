# Acceptance: two browsers, one folder, one workspace

This is the test of Sval's reason to exist: **two browsers on one machine,
pointed at one folder, converge.** A workspace made in one appears in the
other; a tab closed in one disappears from the other.

It is a manual procedure because the things it proves are things only a person
can see — that the other window updates, that the list reads correctly, that
it happens fast enough to feel like one browser. The parts that can run
unattended are automated in
`chrome/browser/components/sval/test/browser/browser_sval_two_devices.js`
(two engines, two device ids, one folder, one profile) and in
`chrome/browser/components/sval/test/xpcshell/test_sval_sync.js`. Those guard the
behaviour; this walks it.

---

## Step 0: two devices have to share one key

**Read this first; the rest of the procedure is impossible without it.**

Sval generates its document key per profile and keeps it in that profile's own
login store (`SvalIdentity`). Two profiles therefore hold two different keys, and
two keys do not merely fail to decrypt — the key is hashed into the directory
name (`syncPrefix`), so each device enumerates a directory the other never
writes to. Two browsers in one folder with two keys are not two devices in
disagreement; they are two strangers.

Pairing is how the key travels (spec §6.7). A is asked for a code; B is given
one; the code opens a sealed copy of A's key that A left in the shared folder,
and B re-keys onto it without losing the workspaces it already had.

```sh
cd /path/to/sval

A=$PWD/build/acceptance/profile-a
B=$PWD/build/acceptance/profile-b
FOLDER=$PWD/build/acceptance/folder
mkdir -p "$FOLDER"
```

The order matters. **Both browsers must already be pointed at `$FOLDER`** before
either can pair: the code is carried through that folder, not over a network, so
a device still saving to its own profile directory has nowhere to put an offer
and nowhere to find one. The page says so rather than appearing to work.

1. `SVAL_DEV_PROFILE=$A ./scripts/run.sh`. Open the app menu's
   **Settings** and choose Sval's **Sync and devices** category.
   Under **Sync**, press **Choose folder…** and pick `$FOLDER`.
2. `SVAL_DEV_PROFILE=$B ./scripts/run.sh`, and do the same in B. B now has its own
   workspace under its own key, in the same folder — this is the case pairing has
   to survive, not a clean slate.
3. On **A**, in **Sync and devices**, press **Sync with another device**,
   choose **This device shows a code**, and press **Show code**. Write down the twelve characters,
   shown in three groups of four like `K7Q4-8MTZ-3RJW` — and leave that tab
   open.
4. On **B**, in **Sync and devices**, press **Sync with another device**,
   choose **The other device shows a code**, press **Next**, type A's code and press **Join**. Case does not
   matter and the dashes are optional.

**Expect:** B says *"Joined. Your devices are syncing."* B's panel shows A's
workspace **and** the one B made in step 2. A's page says the code was used; the offer file is gone from the folder, because the device
that adopted the key withdrew it.

**Expect on disk: two hashed directories under `$FOLDER/sval/ws/`, and one of
them holds two files.** The key names the directory — `syncPrefix` is a hash of
it — so B published under its own key the moment it chose the folder in step 2,
and adoption republishes B under A's hash without deleting anything. The
directory B wrote under its old key stays where it is, unreadable ciphertext
nobody now holds a key for. It is litter, not a fault.

**The count of directories therefore proves nothing. The check that does is
that one directory holds a file from each device**, because that is only
possible if both are writing the same document under the same key.

```sh
ls -d "$FOLDER"/sval/ws/*/ | while read -r d; do echo "$(ls "$d" | wc -l) $d"; done
ls "$FOLDER/sval/pair" 2>/dev/null                        # nothing claimable
```

One directory must report **2**. If every directory reports 1, the key did not
travel and nothing else in this procedure will work. Do not grep those files for
a workspace name to check anything: they are AES-GCM ciphertext, so the string
is absent whatever the document says.

**Three things worth checking while you are here**, because they are what the
design is for and none of them is visible from the happy path:

- **A wrong code.** Type `ABCD-EFGH-JKMN` in B before doing step 4 properly. It
  must say the code *did not work* — and must say something quite different, about
  still looking, if A has not pressed **Show code** yet. A code typed before the
  offer has synced is the normal case on a real cloud folder.
- **A badly-shaped code.** Type eleven characters, or one containing `I`. The
  refusal must be instant: nothing should be read from the folder and no Argon2
  work should run.
- **Closing A's tab.** The offer file under `$FOLDER/sval/pair/` must disappear
  with it.

---

## Step 1: a workspace with two tabs in A appears in B

Both browsers are paired and pointed at `$FOLDER` from Step 0, so there is
nothing to copy and nothing to configure here.

1. In **A**: the workspace it already has needs no name — rename it with **F2**
   if you want one. Open two tabs in it.
2. In **B**: press **Sync now**.

**Expect:** B does *not* ask for a workspace name — it joins the one already in
the folder. B's panel shows A's workspace, collapsed. Expand it (click the
twisty, or Right arrow) and A's tabs are inside it.

**Expect on disk:** unchanged from Step 0 — the same shared directory still
holding one file per device. A tab is a node in the same document, so opening
tabs adds nothing to the folder's shape.

```sh
ls -d "$FOLDER"/sval/ws/*/ | while read -r d; do echo "$(ls "$d" | wc -l) $d"; done
```

---

## Step 2: rename in A, delete the same node in B

This is the scenario that forced the three-fact data model, so it is the one
that matters most.

1. Both browsers open, both showing the same tree.
2. In **A**: select a tab row, press **F2**, rename it, accept. (A syncs
   itself after a rename.)
3. In **B**, *without pressing Sync now first*: select the same row and press
   **Delete**.
4. In **A**: press **Sync now**.

**Expect:** the node is present on both, carrying A's new name. B's delete lost.
This is deliberate and is not a bug: an edit never loses to a stale absence,
while a delete can lose to a concurrent edit (spec §5.4). B's absence of the
node is only evidence about writes B has a watermark for, and B had none for a
rename published after its last pass. Recovering the opposite would require
remembering deletions, which is the tombstone this design removes.

**The other order is the other outcome.** If B presses **Sync now** first — so
it holds the rename — and *then* deletes, the node goes everywhere and the
rename does not bring it back. Both orders are asserted in
`browser_sval_two_devices.js`; run the first here, because it is the one that
surprises people.

---

## Step 3: a move made while B is closed

1. In **A**: make two groups (**New group** twice). A new group is created
   inside whatever is selected, so the second one usually lands inside the
   first — press **Alt+Left** on it to outdent it to the workspace.
2. In **A**: move a tab into the first group (**Alt+Down** / **Alt+Up** to
   reorder, **Alt+Right** to indent under the group above). Both browsers sync.
3. Quit **B**.
4. In **A**: move that tab out of the first group and into the second.
5. Start **B** again.

**Expect:** B's tree has the tab inside the second group as soon as it comes up,
with no button pressed — the panel syncs before it does anything else at
startup. The group will be collapsed, so expand it to see the tab.

---

## Step 4: kill A mid-write

1. Both browsers open.
2. In **A**, produce a long burst of writes. Renaming repeatedly is the
   cheapest: each rename publishes a file. Renaming by hand cannot produce
   much pressure, so this is the step most worth scripting rather than
   clicking.
3. `kill -9` A's parent process while the burst runs.

**Expect:** no `.tmp` file left in the folder, A's file at full length, and B's
next sync reporting `errors: []` and showing a *complete* document — the last
rename that finished, never a partial one. The write goes to `<file>.tmp` and is
renamed over the target (`IOUtils.write`'s `tmpPath`), so a reader sees the old
file or the new one.

```sh
find "$FOLDER" -name '*.tmp'          # nothing
ls -l "$FOLDER/sval/ws"/*/             # every file at full length
```

**Then prove the check is not vacuous.** An empty `errors` list means nothing
unless a damaged file would have shown up in it. Plant one:

```sh
# The shared directory is the one holding a file from each device; B's
# abandoned one from before it paired holds one file and is not this.
DIR=$(ls -d "$FOLDER"/sval/ws/*/ | while read -r d; do
  [ "$(ls "$d" | wc -l)" -eq 2 ] && echo "$d"
done)
head -c 2600 "$DIR"/<a-device-file>.json > "$DIR"/00000000000000000000000000000099.json
```

Press **Sync now** in B. It must say *"A file in your sync folder is damaged and
was skipped. Everything else synced."* Delete the planted file and sync again to
get back to a clean run.

---

## Step 5: a loose tab and a group side by side

A workspace's children are one ordered list mixing tabs and groups by fractional
index. Nothing sorts by kind.

1. In **A**: with a group and some loose tabs under the workspace, press
   **Alt+Up** on the group until it sits between two tabs.
2. Press **Sync now** in A, then in B.

**Expect:** both panels draw the same single list, with the group between the
two tabs, at the same indent level as them.

---

## What only a person can check

Everything above can be confirmed from the tree. These cannot:

- **Does it look right?** Row height, indent, the twisty, the focus ring, the
  loose tab reading as a sibling of the group rather than as a mistake.
- **Does the other window visibly update**, and does the list not jump or lose
  the row you were looking at when it does.
- **Does it feel fast?** A sync pass over a small tree measured 2–3 ms, so the
  answer should be "instant", but nobody has watched it with a big tree.
- **The panel on the right** (`placement`), and the panel against a real
  window-manager layout.
- **The folder picker** as a dialog: wording, focus, what Escape does.
