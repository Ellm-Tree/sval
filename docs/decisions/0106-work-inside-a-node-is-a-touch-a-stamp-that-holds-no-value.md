# 0106. Work inside a node is a touch, a stamp that holds no value

**Status:** Accepted on 2026-10-15.

## Context

Closing a window deletes its workspace when nobody touched it
([0101](0101-closing-a-window-deletes-its-workspace-if-nobody-touched-it.md)). Each
device judges that from its own document. Another device can show the same
untouched workspace while offline and browse in it. Its tabs are facts about
the tabs, not edits to the workspace, so when the first device closes its
window, the delete wins and repair moves the tabs to another workspace
(spec §5.2).

For a delete to lose, the workspace itself has to carry a write the deleting
device never saw ([0017](0017-the-bias-is-toward-keeping-data.md)). Each of the four fact groups holds a value, and a
write replaces its whole group. Stamping one of them would rewrite a name,
isolation, colour or emoji that another device had changed and this one had
not seen yet. That loses the user's edit, which is what 0017 exists to
prevent. Bringing a deleted container back whenever something new sits under
it fails too: it reverses §5.2 for every explicit delete of a group or
workspace, and the case needs no such reach.

## Decision

A node carries a touch stamp, `touched_at` and `touched_by`, which holds no
value. A host stamps it with `touch(id, deviceId, now)` when work inside the
node should count as an edit to it. Sval stamps a workspace when work in it
first takes it from untouched to touched.

The absence rule judges the stamp exactly as it judges a fact group (spec
§5.4). An unwritten stamp is skipped, so a node nobody touched stays droppable. In a merge, the later stamp wins and a tie goes to the
writer. No fact group moves when a node is touched.

## Consequences

- A workspace a peer deleted without seeing the touch comes back with the work
  in it, and with every fact group as the deleting peer last saw it.
- A peer that had seen the touch deleted the workspace knowing of it, and its
  delete propagates.
