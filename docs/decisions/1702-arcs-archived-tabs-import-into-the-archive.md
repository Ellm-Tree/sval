# 1702. Arc's archived tabs import into the Archive

**Status:** Accepted on 2026-11-01. Specified in
2026-10-19-idle-tab-archive-design.md, §7.6.

## Context

Arc archives tabs on a timer and by hand, and keeps them in
`StorableArchiveItems.json` beside its sidebar. Arc stops working on
2026-12-22, and its users lose whatever its own import paths leave behind.
Sval's Archive (decision 0136) holds archived tabs, lists them in
History › Archived tabs, and restores them. Its entries are made only by the
sweep and by Archive now, from a tab in the tree.

## Decision

- The Arc import brings each archived tab Arc holds into the Archive, as an
  entry of its own.
- An entry keeps Arc's archive time as its closed time, so the retention
  period counts from when Arc archived it, and an entry older than the period
  is dropped at the next pass, as any entry is.
- An entry whose Space the import brings names that Space's new workspace,
  so a restore puts it back there. An entry whose Space Arc has deleted
  names a workspace no tree holds, so a restore puts it in the current
  workspace, as for any entry whose workspace is gone. An entry whose Space
  the user chose not to import is left out.
- The engine adds the entries with `add_imported`, on the Archive alone. Each
  tab gets an id the host mints, which no tree ever held, and the entry's id
  derives from it as every entry's does.
- An import during first run hands the entries over once the Archive opens,
  past first run.

## Consequences

An imported entry has no neighbours and no split, so it restores at the end
of its workspace as a single tab. A quit between an import during first run
and the Archive opening loses the archived tabs; the first run runs again on
the next launch, and so does its import.
