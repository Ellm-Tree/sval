# 1143. Messages go where the user acts

**Status:** Accepted on 2026-10-21. Specified in 2026-10-21-messages-design.md,
§1.

## Context

Sval's messages are many: sync state, sync faults, an import's result, a
pairing's outcome, Firefox's update and extension notices and the
private-window notice. Put in one area of the workspace panel, they share it
in several visual treatments, and a sync pass every few seconds wipes whatever
is not a sync report. A user can't tell a dropped network share from a full
disk, and the one fault that loses work looks like the rest.

## Decision

- The footer holds one sync indicator: an icon with a variant per state, a
  label only when the state needs one, a button only when the user must act.
  The most severe state shows. With no sync folder chosen, the row is absent.
- A folder that is unreachable shows the moon dimmed with the last-synced
  time, "Last synced 2 hours ago", once the outage is more than a blip
  (decision 0032). The time while healthy is
  the icon's tooltip. Offline is a state of the indicator.
- A problem that fixes itself says nothing. A file from another device that
  can't be read goes to the log.
- This device's own copy failing to save or open is the one critical fault.
  It interrupts with a dialog, and only it does.
- Sval's update notices live in a notices button in the header, present only
  while a notice exists.
- Extension notices are messages at the top of the extensions panel, with a
  badge on the extensions button; an install Sval refuses is answered in a
  doorhanger on that button.
- The result of something the user did stays in the dialog or page they did
  it in: the workspace edit dialog, the import dialog, Settings › Sync and
  devices. The action is Set Up Sync Again, and it lives only there.
- A message is a short situation and one call to action, with no internals.
  When Sval knows why something failed, it says why.

## Consequences

- The footer holds no message other than the sync indicator.
- The shared-folder helper's reason reaches the panel, so the indicator can
  tell an unreachable folder from a missing one, a refused one and one that is
  too large.
- The critical dialog's Send Report… opens the Send Feedback form, which
  posts to `feedback.sval.app`
  ([1199](1199-sval-s-one-server-receives-only-the-reports-a-user-sends.md)).
