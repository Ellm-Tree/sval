# 0043. Whether the tree reached the folder is answered by looking at the folder

**Status:** Accepted on 2026-10-07.

## Context

Adoption swaps the document key and publishes this device's workspaces into the
other document. Inferring whether the tree reached the folder from whether a
pass wrote bytes, or from whether control reached a line, is wrong both ways:
it can refuse every retry permanently, or tell a user nothing changed while
their workspaces are already on the other device.

## Decision

Adoption publishes before it persists, so a crash before the last step leaves
the device as it was. Whether the tree reached the folder is answered by
reading the folder. Where Sval cannot tell, adoption reports `unchanged`,
with a reason saying it could not tell: "it did not work, and the code can be
used again" is true either way.

## Consequences

Pairing says one of three things to the user: it worked; it did not and nothing
changed; the workspaces published but the key did not save here.
